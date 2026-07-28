'use strict';

// Depth inference worker: decodes a keyframe JPEG, runs Depth Anything V2,
// converts the output to metric depth using the tags visible in the very
// same frame, backprojects through the keyframe's room pose, and returns the
// touched voxel keys. Runs in a worker_thread so a ~0.5 s CPU inference never
// blocks the signaling loop.
//
// Two model flavors (workerData.metric):
// - metric (preferred): output is metres directly; the tags only correct a
//   residual global scale, so one tag per frame is enough.
// - relative: output is inverse depth up to scale AND shift (pred ≈ a/z + b).
//   Two tags at clearly different depths solve (a, b) exactly; a single tag
//   only fits a, consuming the caller's learned shift estimate.

const { parentPort, workerData } = require('worker_threads');
const ort = require('onnxruntime-node');
const jpeg = require('jpeg-js');
const { quatRotate } = require('./public/pose-math.js');

const SIZE = 518;               // model input, square
// Backprojection stride over the depth map. 2 keeps ~4x the surface samples
// of the old 4: voxel evidence gets dense enough that walls fill in from far
// fewer keyframes. Backprojection is cheap next to the inference; the carve
// loop below subsamples to stay bounded.
const STRIDE = 2;
const MIN_Z_M = 0.2;
const MAX_Z_M = 10;
// Voxel keys pack three 10-bit signed-ish indices; ±512 cells covers ±38 m
// at 7.5 cm — beyond any room.
const KEY_OFFSET = 512;

// ImageNet normalization, per Depth Anything's preprocessing.
const NORM_MEAN = [0.485, 0.456, 0.406];
const NORM_STD = [0.229, 0.224, 0.225];

let sessionPromise = ort.InferenceSession.create(workerData.modelPath, {
  // All cores fight the main thread otherwise; inference latency is not the
  // bottleneck at 1 fps keyframes.
  intraOpNumThreads: Math.max(1, require('os').cpus().length - 2),
});

// Bilinear resize + normalize straight into CHW float32.
function preprocess(rgba, w, h) {
  const out = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let y = 0; y < SIZE; y++) {
    const sy = (y + 0.5) * h / SIZE - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < SIZE; x++) {
      const sx = (x + 0.5) * w / SIZE - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * w + x0) * 4;
      const i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const v =
          (rgba[i00 + c] * (1 - fx) + rgba[i01 + c] * fx) * (1 - fy) +
          (rgba[i10 + c] * (1 - fx) + rgba[i11 + c] * fx) * fy;
        out[c * plane + y * SIZE + x] = (v / 255 - NORM_MEAN[c]) / NORM_STD[c];
      }
    }
  }
  return out;
}

// Median predicted value in a patch around a (frame-pixel) point.
function samplePred(pred, u, v, w, h) {
  const cx = Math.round(u * SIZE / w);
  const cy = Math.round(v * SIZE / h);
  const vals = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) vals.push(pred[y * SIZE + x]);
    }
  }
  vals.sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length / 2)] : null;
}

async function handle(msg) {
  const session = await sessionPromise;
  const { w, h, intrinsics, pose, tags, voxelSizeM, priorShift } = msg;
  const decoded = jpeg.decode(msg.jpeg, { useTArray: true, maxMemoryUsageInMB: 512 });

  const input = new ort.Tensor('float32', preprocess(decoded.data, decoded.width, decoded.height),
    [1, 3, SIZE, SIZE]);
  const results = await session.run({ [session.inputNames[0]]: input });
  const pred = results[session.outputNames[0]].data;

  // --- fit pred = a * (1/z) + b against the tags ---------------------------
  const samples = [];
  for (const t of tags) {
    const z = t.tvec[2];
    if (z < MIN_Z_M) continue;
    const u = intrinsics.fx * (t.tvec[0] / z) + intrinsics.cx;
    const v = intrinsics.fy * (t.tvec[1] / z) + intrinsics.cy;
    if (u < 0 || u >= w || v < 0 || v >= h) continue;
    const p = samplePred(pred, u, v, w, h);
    if (p !== null) samples.push({ zTrue: z, p });
  }
  const reject = (reason) => ({ voxels: new Int32Array(0), shift: null, rejected: reason });
  if (!samples.length) return reject('no usable tag samples');

  // --- turn model output into metres, calibrated by the tags ---------------
  let zOf;             // depth-map index -> metres (may return out-of-range)
  let shiftOut = null; // learned shift to report (relative model only)
  if (workerData.metric) {
    // Output is already metres; tags correct the residual global scale. A
    // correction far from 1 means the tags and the model disagree badly —
    // trust neither.
    const ratios = samples
      .map((s) => s.zTrue / Math.max(0.05, s.p))
      .sort((x, y) => x - y);
    const scale = ratios[Math.floor(ratios.length / 2)];
    if (!(scale > 0.5 && scale < 2)) return reject('metric scale correction out of range');
    zOf = (i) => pred[i] * scale;
  } else {
    // Two-point fits are only trustworthy when the tags actually differ in
    // depth — near-equal depths make the slope explode and warp the map.
    const MIN_INV_SPREAD = 0.12;   // ~tags at 2 m and 3.2 m, or better
    let a;
    let b;
    let solidFit = false;
    if (samples.length >= 2) {
      const invs = samples.map((s) => 1 / s.zTrue);
      if (Math.max(...invs) - Math.min(...invs) >= MIN_INV_SPREAD) {
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const s of samples) {
          const inv = 1 / s.zTrue;
          sx += inv; sy += s.p; sxx += inv * inv; sxy += inv * s.p;
        }
        const n = samples.length;
        a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
        b = (sy - a * sx) / n;
        solidFit = true;
      }
    }
    if (!solidFit) {
      // Single tag (or degenerate pair): the shift cannot be observed in
      // this frame. Without a learned one there is no honest way to scale
      // the map — a guessed shift is where garbage geometry comes from.
      if (priorShift === null || priorShift === undefined) {
        return reject('single-tag frame with no learned shift');
      }
      b = priorShift;
      a = samples.reduce((acc, s) => acc + (s.p - b) * s.zTrue, 0) / samples.length;
    }
    if (!(a > 0)) return reject('non-positive scale');
    zOf = (i) => {
      const invZ = (pred[i] - b) / a;
      return invZ > 0 ? 1 / invZ : Infinity;
    };
    // The caller's shift estimate must only learn from frames that actually
    // observed the shift; single-tag frames just consumed it.
    if (solidFit) shiftOut = b;
  }

  // Whatever the flavor, the calibration must describe the map it will be
  // applied to: most of the scene should land at plausible indoor depths.
  let valid = 0;
  let total = 0;
  for (let i = 0; i < pred.length; i += 97) {
    total++;
    const z = zOf(i);
    if (z > MIN_Z_M && z < MAX_Z_M) valid++;
  }
  if (valid / total < 0.3) return reject('calibration places most of the frame out of range');

  // --- backproject into voxel keys ----------------------------------------
  const voxels = new Set();
  const surfacePts = [];
  const inv = 1 / voxelSizeM;
  for (let y = 0; y < SIZE; y += STRIDE) {
    for (let x = 0; x < SIZE; x += STRIDE) {
      const z = zOf(y * SIZE + x);
      if (!(z > MIN_Z_M && z < MAX_Z_M)) continue;
      // Depth pixel -> frame pixel -> camera ray.
      const u = (x + 0.5) * w / SIZE;
      const v = (y + 0.5) * h / SIZE;
      const cxm = ((u - intrinsics.cx) / intrinsics.fx) * z;
      const cym = ((v - intrinsics.cy) / intrinsics.fy) * z;
      const r = quatRotate(pose.q, [cxm, cym, z]);
      const px = r[0] + pose.p[0];
      const py = r[1] + pose.p[1];
      const pz = r[2] + pose.p[2];
      const vx = Math.floor(px * inv) + KEY_OFFSET;
      const vy = Math.floor(py * inv) + KEY_OFFSET;
      const vz = Math.floor(pz * inv) + KEY_OFFSET;
      if (vx < 1 || vx >= 1023 || vy < 1 || vy >= 1023 || vz < 1 || vz >= 1023) continue;
      // Register the hit into the voxel and its face neighbors: monocular
      // depth wobbles by several voxels between keyframes, so without the
      // dilation two frames almost never agree on the exact cell and the
      // occupancy threshold starves the accumulated map.
      const key = (vx << 20) | (vy << 10) | vz;
      voxels.add(key);
      voxels.add(key + (1 << 20));
      voxels.add(key - (1 << 20));
      voxels.add(key + (1 << 10));
      voxels.add(key - (1 << 10));
      voxels.add(key + 1);
      voxels.add(key - 1);
      surfacePts.push(px, py, pz);
    }
  }

  // Free-space evidence: every voxel a ray crosses on its way to the surface
  // was observed to be empty air. The occupancy grid uses these as votes
  // against — it is what dismisses blobs hallucinated by a bad depth frame
  // once later frames see through that space. Stop well short of the surface:
  // the margin must exceed the depth noise (±10% of range, several voxels) or
  // honest surfaces get carved along with the junk.
  const CARVE_MARGIN_M = 0.3;
  const empties = new Set();
  const cam = pose.p;
  // Every third surface point: carving is the costliest loop after the
  // inference itself, and free-space votes accumulate across frames anyway —
  // at STRIDE 2 this still casts more rays than the old full pass did.
  for (let i = 0; i < surfacePts.length; i += 9) {
    const dx = surfacePts[i] - cam[0];
    const dy = surfacePts[i + 1] - cam[1];
    const dz = surfacePts[i + 2] - cam[2];
    const len = Math.hypot(dx, dy, dz);
    if (len <= CARVE_MARGIN_M) continue;
    const stop = len - CARVE_MARGIN_M;
    // March in half-voxel steps — simpler than exact grid traversal and the
    // double-visits dedupe through the Set anyway.
    const step = voxelSizeM / 2;
    for (let t = step; t < stop; t += step) {
      const s = t / len;
      const vx = Math.floor((cam[0] + dx * s) * inv) + KEY_OFFSET;
      const vy = Math.floor((cam[1] + dy * s) * inv) + KEY_OFFSET;
      const vz = Math.floor((cam[2] + dz * s) * inv) + KEY_OFFSET;
      if (vx < 0 || vx >= 1024 || vy < 0 || vy >= 1024 || vz < 0 || vz >= 1024) continue;
      const key = (vx << 20) | (vy << 10) | vz;
      if (!voxels.has(key)) empties.add(key);
    }
  }

  const arr = Int32Array.from(voxels);
  const emptyArr = Int32Array.from(empties);
  return { voxels: arr, empties: emptyArr, shift: shiftOut };
}

parentPort.on('message', (msg) => {
  handle(msg)
    .then((res) => {
      const transfers = [res.voxels.buffer];
      if (res.empties?.buffer && res.empties.buffer !== res.voxels.buffer) {
        transfers.push(res.empties.buffer);
      }
      parentPort.postMessage({ id: msg.id, clientId: msg.clientId, ...res }, transfers);
    })
    .catch((err) => {
      parentPort.postMessage({ id: msg.id, clientId: msg.clientId, error: err.message });
    });
});
