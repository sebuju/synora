'use strict';

// Floor plan from surface evidence, not from painted voxels.
//
// The voxel grid answers "was anything ever here", which is the wrong question
// for a floor plan: at 6-20% depth error every surface lands several cells off,
// so fitting lines to occupied cells fits lines to the error. This module keeps
// the evidence instead of the paint. Every accepted surface point votes into a
// 2D cell with its normal direction, hundreds of keyframes vote into the same
// cells, and the geometry is fitted at the end — so the noise averages out
// before anything is fitted, rather than being frozen into occupancy first.
//
// Two priors do the heavy lifting, and both are about buildings rather than
// about depth maps:
// - Walls are vertical, so their normals lie in the floor plane. A point whose
//   normal tilts toward the ceiling is furniture, floor or clutter.
// - Rooms are mostly rectilinear. The dominant wall direction is measured once
//   over all the evidence (folded mod 90°, so perpendicular walls reinforce the
//   same estimate instead of splitting it) and walls are extracted along it and
//   its perpendicular. Anything genuinely off-axis is picked up afterwards by a
//   general fit over whatever the axes did not explain.

const CELL_M = 0.05;             // evidence cell, finer than the voxel grid
const CELL_BITS = 12;            // ±2048 cells ≈ ±102 m
const CELL_OFF = 1 << (CELL_BITS - 1);

// A wall point's normal is horizontal. 0.4 allows for the normal noise a
// monocular depth map produces on a real wall without letting the floor in.
const WALL_NORMAL_MAX_Y = 0.4;
const FLOOR_NORMAL_MIN_Y = 0.85;
// Band above the floor that counts as wall. Below it is furniture and skirting,
// above it is the ceiling slope and light fittings.
const BAND_LOW_M = 0.4;
const BAND_HIGH_M = 2.2;
const FLOOR_DEFAULT_M = -1.2;    // until floor points say otherwise

// A cell needs corroboration, not a single frame's opinion. ARCore hands over
// a whole depth grid every second, so votes are cheap and this costs coverage
// only at the edges of where you actually walked.
const MIN_CELL_VOTES = 8;
// ...and from at least this many distinct places. A wall you walked past is
// evidence; a wall you stared at from the sofa is one measurement repeated.
const MIN_CELL_VIEWS = 2;
const LINE_BIN_M = 0.05;         // perpendicular histogram resolution
const LINE_SLAB_M = 0.12;        // cells this close to a line belong to it
const LINE_MIN_SEPARATION_M = 0.3;
const LINE_PEAK_FRAC = 0.25;     // of the strongest peak, to be a wall at all
const NORMAL_MATCH_DEG = 30;     // cell normal vs the line's own normal
const RUN_GAP_M = 0.45;
const RUN_MIN_LEN_M = 0.8;
const RUN_MIN_DENSITY = 6;       // cells per metre along the segment
const MAX_SEGMENTS = 40;

const packCell = (ix, iz) => ((ix + CELL_OFF) << CELL_BITS) | (iz + CELL_OFF);

function createFloorplan() {
  // key -> { w, s4, c4, s2, c2, yLo, yHi }
  // s4/c4 accumulate the normal azimuth folded mod 90° (the Manhattan
  // estimate); s2/c2 fold it mod 180°, which is the cell's own wall direction
  // — a wall and its opposite face are the same wall.
  const cells = new Map();
  let floorY = FLOOR_DEFAULT_M;
  let floorVotes = 0;
  let floorSum = 0;

  function addPoints(surf, viewpoint) {
    if (!surf || !surf.length) return 0;
    let added = 0;
    for (let i = 0; i < surf.length; i += 6) {
      const y = surf[i + 1];
      const ny = surf[i + 4];
      // Floor estimate rides along: horizontal surfaces low in the room are
      // the floor, and the whole height band is defined relative to it. An
      // anchor tag hung at eye height puts room y = 0 nowhere near the ground.
      if (Math.abs(ny) >= FLOOR_NORMAL_MIN_Y) {
        floorSum += y;
        floorVotes++;
        if (floorVotes >= 200) {
          // Running mean of the lowest horizontal surfaces, not of all of
          // them — desks and worktops are horizontal too.
          floorY = Math.min(floorY, floorSum / floorVotes);
          floorSum = 0;
          floorVotes = 0;
        }
      }
      if (Math.abs(ny) > WALL_NORMAL_MAX_Y) continue;
      const h = y - floorY;
      if (h < BAND_LOW_M || h > BAND_HIGH_M) continue;
      const nx = surf[i + 3];
      const nz = surf[i + 5];
      const mag = Math.hypot(nx, nz);
      if (mag < 1e-3) continue;

      const x = surf[i];
      const z = surf[i + 2];
      const ix = Math.floor(x / CELL_M);
      const iz = Math.floor(z / CELL_M);
      if (ix < -CELL_OFF || ix >= CELL_OFF || iz < -CELL_OFF || iz >= CELL_OFF) continue;
      const key = packCell(ix, iz);
      let c = cells.get(key);
      if (!c) cells.set(key, c = { w: 0, s4: 0, c4: 0, s2: 0, c2: 0, yLo: y, yHi: y, vp: 0, views: 0 });
      // Same discipline as the voxel grid: a wall seen a hundred times from
      // one spot has been seen once. Only a new viewpoint adds confidence.
      if (viewpoint !== undefined && c.vp !== viewpoint) {
        c.vp = viewpoint;
        c.views++;
      }
      const a = Math.atan2(nz / mag, nx / mag);
      c.w++;
      c.s4 += Math.sin(4 * a);
      c.c4 += Math.cos(4 * a);
      c.s2 += Math.sin(2 * a);
      c.c2 += Math.cos(2 * a);
      if (y < c.yLo) c.yLo = y;
      if (y > c.yHi) c.yHi = y;
      added++;
    }
    return added;
  }

  // Cells worth fitting, with their averaged normal direction. Averaging the
  // doubled angle is what makes a normal and its opposite the same answer.
  function strongCells() {
    const out = [];
    for (const [key, c] of cells) {
      if (c.w < MIN_CELL_VOTES || c.views < MIN_CELL_VIEWS) continue;
      const ix = (key >> CELL_BITS) - CELL_OFF;
      const iz = (key & ((1 << CELL_BITS) - 1)) - CELL_OFF;
      out.push({
        x: (ix + 0.5) * CELL_M,
        z: (iz + 0.5) * CELL_M,
        w: c.w,
        normal: 0.5 * Math.atan2(c.s2, c.c2),
        s4: c.s4,
        c4: c.c4,
        yLo: c.yLo,
        yHi: c.yHi,
        used: false,
      });
    }
    return out;
  }

  // Peaks of a weighted 1D histogram, strongest first, kept apart so one wall
  // cannot be reported as three.
  function findPeaks(values, weights) {
    if (!values.length) return [];
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const n = Math.max(1, Math.ceil((hi - lo) / LINE_BIN_M) + 1);
    const bins = new Float64Array(n);
    for (let i = 0; i < values.length; i++) {
      bins[Math.round((values[i] - lo) / LINE_BIN_M)] += weights[i];
    }
    // One bin of smoothing: a wall two cells thick otherwise splits in two.
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      sm[i] = (bins[i - 1] || 0) * 0.5 + bins[i] + (bins[i + 1] || 0) * 0.5;
    }
    let best = 0;
    for (const v of sm) if (v > best) best = v;
    const floor = best * LINE_PEAK_FRAC;
    const cand = [];
    for (let i = 0; i < n; i++) {
      if (sm[i] < floor) continue;
      if (sm[i] < (sm[i - 1] || 0) || sm[i] < (sm[i + 1] || 0)) continue;
      cand.push({ t: lo + i * LINE_BIN_M, v: sm[i] });
    }
    cand.sort((a, b) => b.v - a.v);
    const peaks = [];
    for (const c of cand) {
      if (peaks.some((p) => Math.abs(p - c.t) < LINE_MIN_SEPARATION_M)) continue;
      peaks.push(c.t);
    }
    return peaks;
  }

  // Cells along one candidate line, split into the runs that are actual walls.
  function segmentsOnLine(pool, ux, uz, offset, out) {
    const px = -uz;
    const pz = ux;
    const lineNormal = Math.atan2(pz, px);
    const cosLimit = Math.cos(NORMAL_MATCH_DEG * Math.PI / 180);
    const on = [];
    for (const c of pool) {
      if (c.used) continue;
      if (Math.abs(c.x * px + c.z * pz - offset) > LINE_SLAB_M) continue;
      // The cell's normal must be the line's normal, or this is a wall
      // crossing rather than a wall.
      const d = Math.cos(2 * (c.normal - lineNormal));
      if (d < 2 * cosLimit * cosLimit - 1) continue;
      on.push({ c, s: c.x * ux + c.z * uz });
    }
    if (on.length < 3) return;
    on.sort((a, b) => a.s - b.s);
    let run = [on[0]];
    const flush = () => {
      if (run.length < 3) return;
      const len = run[run.length - 1].s - run[0].s;
      if (len < RUN_MIN_LEN_M || run.length / len < RUN_MIN_DENSITY) return;
      const yLo = run.map((e) => e.c.yLo).sort((a, b) => a - b);
      const yHi = run.map((e) => e.c.yHi).sort((a, b) => a - b);
      const rnd = (v) => Math.round(v * 100) / 100;
      // Percentile ends, not the outermost cell: the noise that smears a wall
      // sideways smears it lengthwise too, and min/max reports the smear as
      // wall. Costs a few cm of a real wall's length, saves a quarter metre of
      // invented wall at each end.
      const ss = run.map((e) => e.s);
      const s0 = ss[Math.floor(ss.length * 0.01)];
      const s1 = ss[Math.min(ss.length - 1, Math.ceil(ss.length * 0.99))];
      out.push({
        a: [rnd(ux * s0 + px * offset), rnd(uz * s0 + pz * offset)],
        b: [rnd(ux * s1 + px * offset), rnd(uz * s1 + pz * offset)],
        y0: rnd(yLo[Math.floor(yLo.length * 0.2)]),
        y1: rnd(yHi[Math.floor(yHi.length * 0.8)]),
        cols: run.length,
      });
      for (const e of run) e.c.used = true;
    };
    for (let i = 1; i < on.length; i++) {
      if (on[i].s - on[i - 1].s > RUN_GAP_M) {
        flush();
        run = [on[i]];
      } else {
        run.push(on[i]);
      }
    }
    flush();
  }

  function extract() {
    const pool = strongCells();
    if (pool.length < 8) return [];

    // Dominant direction over everything at once. Folding by 4 makes a wall and
    // the wall perpendicular to it vote for the same answer, so a rectangular
    // room reinforces one estimate instead of splitting into two.
    let s4 = 0;
    let c4 = 0;
    for (const c of pool) {
      s4 += c.s4;
      c4 += c.c4;
    }
    const theta = 0.25 * Math.atan2(s4, c4);

    const out = [];
    for (const axis of [theta, theta + Math.PI / 2]) {
      const ux = Math.cos(axis);
      const uz = Math.sin(axis);
      const px = -uz;
      const pz = ux;
      // Only cells whose normal agrees with this axis get a vote in its
      // histogram, or the perpendicular walls pile into every bin.
      const lineNormal = Math.atan2(pz, px);
      const cosLimit = Math.cos(NORMAL_MATCH_DEG * Math.PI / 180);
      const ts = [];
      const ws = [];
      for (const c of pool) {
        if (Math.cos(2 * (c.normal - lineNormal)) < 2 * cosLimit * cosLimit - 1) continue;
        ts.push(c.x * px + c.z * pz);
        ws.push(c.w);
      }
      for (const t of findPeaks(ts, ws)) {
        if (out.length >= MAX_SEGMENTS) break;
        segmentsOnLine(pool, ux, uz, t, out);
      }
    }
    return { segments: out, pool, theta };
  }

  return {
    addPoints,

    // One pass: the rectilinear walls, plus the evidence they could not
    // explain so the caller can fit genuinely off-axis walls over it. Both
    // come from the same extraction because `used` is per-run state — asking
    // for them separately would fit the room twice and disagree with itself.
    fit() {
      const res = extract();
      if (!res.segments) return { segments: [], leftovers: [], theta: 0 };
      return {
        segments: res.segments,
        leftovers: res.pool.filter((c) => !c.used),
        theta: res.theta,
      };
    },

    stats() {
      return { cells: cells.size, floorY: Math.round(floorY * 100) / 100 };
    },

    clear() {
      cells.clear();
      floorY = FLOOR_DEFAULT_M;
      floorVotes = 0;
      floorSum = 0;
    },
  };
}

module.exports = { createFloorplan };
