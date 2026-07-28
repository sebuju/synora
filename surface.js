'use strict';

// Turning a grid of camera-frame depth points into room-frame evidence.
//
// Two producers feed this and they must not drift apart: the depth model in
// depth-worker.js, and ARCore's own depth map arriving from an XR client. Both
// hand over the same thing — a lattice of camera-frame points, some invalid —
// so the judging of which points are honest, the normals, the voxel keys and
// the free-space carving all live here once.

const { quatRotate } = require('./public/pose-math.js');

const KEY_OFFSET = 512;           // voxel keys pack three 10-bit indices
// Relative depth jump across one lattice step. Depth discontinuities are where
// both producers lie: the interpolated ramp between a foreground object and the
// wall behind it is not a surface, it is a smear through empty space.
const EDGE_REL = 0.08;
// Two normals from opposite neighbour pairs must agree. Glancing incidence is
// deliberately not a rejection criterion — a depth error on an edge-on surface
// slides the point along the surface where it does no harm, while a face-on
// surface takes the whole error into its position. It is the estimated normal
// that glancing views wreck, which is what this catches.
const NORMAL_AGREE = 0.7;
// Stop short of the surface by more than the depth noise, or honest surfaces
// get carved along with the junk.
const CARVE_MARGIN_M = 0.3;
// Two frames taken from the same spot are one observation repeated, not two
// observations agreeing. Quantising the camera position gives each frame a
// viewpoint identity, so the grid can tell corroboration from repetition.
const VIEWPOINT_CELL_M = 0.4;

function unitCross(ax, ay, az, bx, by, bz) {
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  return len > 1e-9 ? [nx / len, ny / len, nz / len] : null;
}

// cx/cy/cz: camera-frame coordinates on a gw x gh lattice, ok: validity mask.
// pose: the camera's room-frame transform { p, q }.
function integrateGrid({ cx, cy, cz, ok, gw, gh, pose, voxelSizeM }) {
  const voxels = new Set();
  const dilated = new Set();
  const surfacePts = [];
  const surf = [];
  const inv = 1 / voxelSizeM;
  let considered = 0;
  let keptEdge = 0;
  let kept = 0;

  for (let j = 1; j < gh - 1; j++) {
    for (let i = 1; i < gw - 1; i++) {
      const g = j * gw + i;
      if (!ok[g]) continue;
      considered++;
      const gr = g + 1;
      const gl = g - 1;
      const gd = g + gw;
      const gu = g - gw;
      if (!ok[gr] || !ok[gl] || !ok[gd] || !ok[gu]) continue;
      const z = cz[g];
      if (Math.abs(cz[gr] - z) / z > EDGE_REL) continue;
      if (Math.abs(cz[gl] - z) / z > EDGE_REL) continue;
      if (Math.abs(cz[gd] - z) / z > EDGE_REL) continue;
      if (Math.abs(cz[gu] - z) / z > EDGE_REL) continue;
      keptEdge++;

      const n1 = unitCross(
        cx[gr] - cx[g], cy[gr] - cy[g], cz[gr] - cz[g],
        cx[gd] - cx[g], cy[gd] - cy[g], cz[gd] - cz[g]);
      const n2 = unitCross(
        cx[g] - cx[gl], cy[g] - cy[gl], cz[g] - cz[gl],
        cx[g] - cx[gu], cy[g] - cy[gu], cz[g] - cz[gu]);
      if (!n1 || !n2) continue;
      if (Math.abs(n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) < NORMAL_AGREE) continue;

      const r = quatRotate(pose.q, [cx[g], cy[g], cz[g]]);
      const px = r[0] + pose.p[0];
      const py = r[1] + pose.p[1];
      const pz = r[2] + pose.p[2];
      const vx = Math.floor(px * inv) + KEY_OFFSET;
      const vy = Math.floor(py * inv) + KEY_OFFSET;
      const vz = Math.floor(pz * inv) + KEY_OFFSET;
      if (vx < 1 || vx >= 1023 || vy < 1 || vy >= 1023 || vz < 1 || vz >= 1023) continue;
      // Face neighbours are a weaker vote, not a hit: depth wobbles by several
      // voxels between frames, so without the dilation two frames rarely agree
      // on a cell — but counting the shell as a hit is what makes every
      // surface three voxels thick.
      const key = (vx << 20) | (vy << 10) | vz;
      voxels.add(key);
      dilated.add(key + (1 << 20));
      dilated.add(key - (1 << 20));
      dilated.add(key + (1 << 10));
      dilated.add(key - (1 << 10));
      dilated.add(key + 1);
      dilated.add(key - 1);
      surfacePts.push(px, py, pz);
      const rn = quatRotate(pose.q, n1);
      surf.push(px, py, pz, rn[0], rn[1], rn[2]);
      kept++;
    }
  }

  // Free space: every voxel a ray crossed on its way to a surface was observed
  // to be empty. This is what dismisses geometry a bad frame hallucinated once
  // later frames see through it.
  const empties = new Set();
  const cam = pose.p;
  const step = voxelSizeM / 2;
  for (let i = 0; i < surfacePts.length; i += 9) {
    const dx = surfacePts[i] - cam[0];
    const dy = surfacePts[i + 1] - cam[1];
    const dz = surfacePts[i + 2] - cam[2];
    const len = Math.hypot(dx, dy, dz);
    if (len <= CARVE_MARGIN_M) continue;
    const stop = len - CARVE_MARGIN_M;
    for (let t = step; t < stop; t += step) {
      const s = t / len;
      const vx = Math.floor((cam[0] + dx * s) * inv) + KEY_OFFSET;
      const vy = Math.floor((cam[1] + dy * s) * inv) + KEY_OFFSET;
      const vz = Math.floor((cam[2] + dz * s) * inv) + KEY_OFFSET;
      if (vx < 0 || vx >= 1024 || vy < 0 || vy >= 1024 || vz < 0 || vz >= 1024) continue;
      const key = (vx << 20) | (vy << 10) | vz;
      if (!voxels.has(key) && !dilated.has(key)) empties.add(key);
    }
  }

  for (const key of voxels) dilated.delete(key);
  const q = (v) => Math.round(v / VIEWPOINT_CELL_M) + 512;
  return {
    viewpoint: (q(pose.p[0]) << 20) | (q(pose.p[1]) << 10) | q(pose.p[2]),
    voxels: Int32Array.from(voxels),
    dilated: Int32Array.from(dilated),
    empties: Int32Array.from(empties),
    surf: Float32Array.from(surf),
    considered,
    keptEdge,
    kept,
  };
}

module.exports = { integrateGrid, KEY_OFFSET };
