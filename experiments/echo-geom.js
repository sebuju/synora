'use strict';

/*
 * experiments/echo-geom.js — the geometry behind the acoustic wall check.
 *
 * Node only; the page never loads this. /audio-lab measures arrival delays and
 * journals them raw, and every metre of interpretation happens here, offline,
 * against a grid built by replay-walls.js. That split is deliberate: a live
 * prediction loop could bias what the detector goes looking for, and the same
 * discipline is why walls tuning is measured by replay rather than argued.
 *
 * Two ideas carry the whole module.
 *
 * 1. A monostatic echo has no heading. Speaker and mic sit centimetres apart on
 *    one phone, so image-source geometry returns a flat surface at 2*d_perp
 *    whichever way the phone points. Facing changes only which surfaces are
 *    loud. So a standpoint is a point and a height, never a pose — which
 *    deletes the operator's facing estimate, the shakiest declared input there
 *    would have been.
 *
 * 2. A portrait phone's speakers are vertically separated (~0.14 m), and that
 *    separation identifies the surface. Firing each channel alone:
 *
 *      floor     path = h_s + h_m            ->  delta = +d_sep
 *      ceiling   path = 2H - h_s - h_m       ->  delta = -d_sep
 *      wall      path = hypot(2d, h_s - h_m) ->  delta ~ 0  (<= d_sep^2/4d)
 *
 *    The mic height cancels exactly in the floor and ceiling differences, so
 *    delta is pure speaker geometry — a device constant, independent of how the
 *    phone is held. And it is a *delay* test, not an amplitude one: the earpiece
 *    fires forward through a slit rather than upward, so any argument from which
 *    channel sounds louder would be fragile, while path length cannot care about
 *    directivity. 14 cm of separation against 2.1 cm of resolution puts floor,
 *    ceiling and wall in three bins that do not touch.
 *
 * Everything here is pure. `node experiments/echo-geom.js` runs the self-test.
 */

// ---------------------------------------------------------------------------
// Copied helpers.
//
// Deliberate experiment-scoped duplication: this is a test rig, and the
// alternative — extracting a shared primitive — would mean editing pose-math.js
// and walls.js, which this work is scoped out of. Each block names its original
// so a reader knows where the real one lives.

// Copied from public/pose-math.js:135. Rotate a vector by a quaternion.
function quatRotate(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + y * tz - z * ty,
    v[1] + w * ty + z * tx - x * tz,
    v[2] + w * tz + x * ty - y * tx,
  ];
}

// Copied from public/pose-math.js:319. Parametric intersection of two 2D
// segments; null when parallel. Callers test 0<t<1 on both for a *proper*
// crossing — an endpoint brush is two walls meeting, not an occlusion.
function segIntersect2D(a1, b1, a2, b2) {
  const d1 = [b1[0] - a1[0], b1[1] - a1[1]];
  const d2 = [b2[0] - a2[0], b2[1] - a2[1]];
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  if (!cross) return null;
  const ex = a2[0] - a1[0];
  const ez = a2[1] - a1[1];
  return {
    t1: (ex * d2[1] - ez * d2[0]) / cross,
    t2: (ex * d1[1] - ez * d1[0]) / cross,
  };
}

// Copied from replay-depth.js:50-58, so this report and the depth report read
// identically — the same phrasing means the same thing in both.
const pct = (arr, p) => (arr.length
  ? arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] : NaN);

function stat(errsM) {
  if (!errsM.length) return 'n 0';
  const abs = errsM.map((e) => Math.abs(e) * 1000);
  const signed = errsM.map((e) => e * 1000);
  return `n ${errsM.length}  |err| median ${pct(abs, 0.5).toFixed(0)} mm, `
    + `p90 ${pct(abs, 0.9).toFixed(0)} mm, worst ${Math.max(...abs).toFixed(0)} mm  `
    + `bias ${pct(signed, 0.5).toFixed(0)} mm`;
}

// ---------------------------------------------------------------------------
// Shape tripwires.
//
// The copies above bind to two schemas neither of which this file owns. If the
// wall segment shape or getFloor()'s flat-array convention changes upstream,
// nothing here throws — the tool would cheerfully report zero matches and read
// as "the map is fine". These refuse loudly instead, the way walls.js refuses a
// grid whose cell size does not match its own.

function assertGridShape(grid, where = 'grid') {
  if (!grid || typeof grid !== 'object') throw new Error(`${where}: not an object`);
  if (!Array.isArray(grid.walls)) throw new Error(`${where}: expected .walls array`);
  const seg = grid.walls[0];
  if (seg && !(Array.isArray(seg.a) && seg.a.length === 2 && Array.isArray(seg.b) && 'ids' in seg)) {
    throw new Error(`${where}: wall segment shape changed — expected `
      + `{a:[x,z], b:[x,z], ids:[...], inferred?, ext?}, got ${JSON.stringify(seg).slice(0, 160)}`);
  }
  const f = grid.floor;
  if (!f || !Number.isFinite(f.cellM)) throw new Error(`${where}: expected .floor.cellM`);
  if (!Array.isArray(f.free) || f.free.length % 2) {
    throw new Error(`${where}: .floor.free must be a flat [ix,iz,...] array of even length`);
  }
  return grid;
}

function assertMarkerShape(map, where = 'markers') {
  if (!map || !Array.isArray(map.markers)) throw new Error(`${where}: expected .markers array`);
  for (const m of map.markers) {
    if (!Array.isArray(m.p) || m.p.length !== 3 || !Array.isArray(m.q) || m.q.length !== 4) {
      throw new Error(`${where}: marker ${m.id} shape changed — expected p[3] and q[4]`);
    }
  }
  return map;
}

// markers.json is object-keyed; this is the array shape everything downstream
// wants. Copied from replay-walls.js:64-72 (minus clippedTo, which is live-only
// state this file has no use for).
function normaliseMarkers(rawMap) {
  return assertMarkerShape({
    anchorId: rawMap.anchorId,
    sizeM: rawMap.markerSizeM,
    markers: Object.entries(rawMap.markers || {}).map(([id, m]) => ({
      id: Number(id), p: m.p, q: m.q,
      hops: Number.isFinite(m.hops) ? m.hops : null,
    })),
  });
}

// ---------------------------------------------------------------------------
// Standpoint

// Where the operator stood, from a tag they stood a measured offset from.
//
// The tag's outward normal is quatRotate(q,[0,0,1]) — the same expression, and
// the same 0.7 horizontality test, that walls.js:610-614 uses to build a plane
// from a tag. A tag lying on a table is not a standpoint reference, and this
// refuses it rather than projecting an offset onto a degenerate direction.
function standpointOf(decl, markers) {
  const tag = markers.markers.find((m) => m.id === Number(decl.tagId));
  if (!tag) return { ok: false, reason: `tag ${decl.tagId} not in markers.json` };
  const n = quatRotate(tag.q, [0, 0, 1]);
  const nh = Math.hypot(n[0], n[2]);
  if (nh < 0.7) {
    return { ok: false, reason: `tag ${decl.tagId} normal is not horizontal (${nh.toFixed(2)})` };
  }
  // Out of the wall into the room, and along it. ArUco's +Z leaves the marker
  // face toward whoever is looking at it, so +out is where the operator is.
  const nx = n[0] / nh;
  const nz = n[2] / nh;
  const out = Number(decl.outM) || 0;
  const along = Number(decl.alongM) || 0;
  return {
    ok: true,
    tag,
    P: [tag.p[0] + nx * out - nz * along, tag.p[2] + nz * out + nx * along],
    y: Number(decl.heightM),
  };
}

// ---------------------------------------------------------------------------
// Wall prediction

function perpFoot(P, seg) {
  const ax = seg.a[0];
  const az = seg.a[1];
  const dx = seg.b[0] - ax;
  const dz = seg.b[1] - az;
  const len2 = dx * dx + dz * dz;
  if (!(len2 > 1e-12)) return null;
  const t = ((P[0] - ax) * dx + (P[1] - az) * dz) / len2;
  const F = [ax + t * dx, az + t * dz];
  return { F, t, dPerp: Math.hypot(P[0] - F[0], P[1] - F[1]), lenM: Math.sqrt(len2) };
}

// One segment's verdict from one standpoint. The classification matters more
// than the number: an inferred wall and a corner extension are the parts of the
// map with no tag behind them, and they are exactly where an independent ruler
// is worth having.
function predictWall(P, seg, others, cfg = {}) {
  const foot = perpFoot(P, seg);
  if (!foot) return null;
  const { F, t, dPerp, lenM } = foot;
  const slack = (cfg.edgeSlackM ?? 0.02) / lenM;
  const specular = t >= -slack && t <= 1 + slack;

  // Outside the segment there is no specular reflection at all — what comes
  // back is edge diffraction off the nearest end, tens of dB down. Emitted so
  // the matcher can explain a peak with it, never counted in the headline.
  const nearest = t < 0 ? seg.a : seg.b;
  const dEff = specular ? dPerp : Math.hypot(P[0] - nearest[0], P[1] - nearest[1]);

  let occluded = false;
  for (const o of others) {
    if (o === seg) continue;
    const hit = segIntersect2D(P, specular ? F : nearest, o.a, o.b);
    if (hit && hit.t1 > 1e-6 && hit.t1 < 1 - 1e-6 && hit.t2 > 1e-6 && hit.t2 < 1 - 1e-6) {
      occluded = true;
      break;
    }
  }

  // The corner-closure extensions (walls.md: "inference may not exceed
  // evidence") are the least-attested geometry walls.js emits. A foot landing
  // inside one is the single most valuable measurement this whole exercise can
  // take, so it is flagged rather than folded into `inferred`.
  const alongA = t * lenM;
  const inExtension = !!(seg.ext && specular
    && ((seg.ext.a > 0 && alongA < seg.ext.a) || (seg.ext.b > 0 && lenM - alongA < seg.ext.b)));

  return {
    seg,
    dPerp: dEff,
    t,
    specular,
    occluded,
    inExtension,
    provenance: seg.inferred ? 'inferred' : 'tagged',
  };
}

// ---------------------------------------------------------------------------
// The predicted comb
//
// Every surface returns more than one arrival, and the extra ones are not
// noise — they are geometry, and they sit exactly where a naive reader would
// mistake them for extra walls. A wall at 3 m with the phone at 1.2 m in a
// 2.5 m room returns 6.00 m (wall), 6.46 m (wall+floor) and 6.54 m
// (wall+ceiling): 46 and 54 cm apart, far beyond the 2.1 cm resolution, and
// trivially read as walls at 3.23 m and 3.27 m. Predicting them is not
// optional; without it the matcher mis-assigns and the residual is noise.
//
// `spkOff` and `micOff` are heights relative to the declared phone height, so
// the caller expresses "top speaker" as +d_sep/2 and the primary mic at the
// bottom edge as -d_sep/2. Everything is TOTAL PATH LENGTH, never one-way:
// only a flat vertical wall has a meaningful "distance", and mixing the two
// conventions is how a factor of 2 gets lost.
function combForSpeaker(P, y, walls, cfg, spkOff) {
  const H = cfg.ceilM;
  const micOff = cfg.micOffM ?? 0;
  const hs = y + spkOff;
  const hm = y + micOff;
  const dv = hs - hm;
  const out = [];

  // Floor and ceiling. These are the calibration surfaces and the only ones
  // whose delta identifies them outright.
  if (hs > 0 && hm > 0) out.push({ kind: 'floor', pathM: hs + hm, spkOff });
  if (Number.isFinite(H) && H > hs && H > hm) {
    out.push({ kind: 'ceiling', pathM: 2 * H - hs - hm, spkOff });
  }

  for (const w of walls) {
    if (!(w.dPerp > 0)) continue;
    const twice = 2 * w.dPerp;
    const base = {
      spkOff, seg: w.seg, dPerp: w.dPerp, specular: w.specular,
      occluded: w.occluded, inExtension: w.inExtension, provenance: w.provenance,
    };
    out.push({ ...base, kind: w.specular ? 'wall' : 'edge', pathM: Math.hypot(twice, dv) });
    if (!w.specular) continue;
    // Second-order: the wall image reflected again in floor or ceiling. Same
    // horizontal displacement, vertical leg folded about the surface.
    if (hs > 0 && hm > 0) {
      out.push({ ...base, kind: 'wall+floor', pathM: Math.hypot(twice, hs + hm) });
    }
    if (Number.isFinite(H) && H > hs && H > hm) {
      out.push({ ...base, kind: 'wall+ceiling', pathM: Math.hypot(twice, 2 * H - hs - hm) });
    }
  }
  return out;
}

// The comb for one emission variant. 'both' fires both speakers, so it returns
// both combs — a doublet per surface, which is what the recording will show.
function predictComb(P, y, walls, cfg, channel = 'both') {
  const half = (cfg.dSepM ?? 0) / 2;
  const offs = channel === 'top' ? [half]
    : channel === 'bottom' ? [-half]
      : [half, -half];
  return offs.flatMap((o) => combForSpeaker(P, y, walls, cfg, o));
}

// ---------------------------------------------------------------------------
// The stereo discriminator

// Signed path difference, top speaker minus bottom, against the known speaker
// separation. No map, no declared heights, no assumption about which physical
// speaker the OS calls "left" — pure arithmetic on two measured delays.
function classifySurface(pathTop, pathBottom, dSepM, tolM) {
  const tol = tolM ?? dSepM / 3;
  if (!(tol < dSepM / 2)) {
    // At d_sep/2 the three acceptance windows touch and the verdict stops
    // meaning anything. Refuse rather than return a confident wrong label.
    throw new Error(`classifySurface: tol ${tol} must be under dSep/2 (${dSepM / 2})`);
  }
  const delta = pathTop - pathBottom;
  if (Math.abs(delta - dSepM) < tol) return { cls: 'floor', delta };
  if (Math.abs(delta + dSepM) < tol) return { cls: 'ceiling', delta };
  if (Math.abs(delta) < tol) return { cls: 'vertical', delta };
  return { cls: 'ambiguous', delta };
}

// Pair one channel's arrivals against the other's, so each surface yields one
// record. Greedy by ascending |delta|: two walls 5 cm apart could in principle
// cross-pair, but a true pair's |delta| (~0 for a wall, exactly d_sep for floor
// or ceiling) is always smaller than the accidental one, so smallest-first
// resolves them correctly. Unpaired peaks are kept, not dropped — a surface one
// speaker can see and the other cannot is real information about the phone's
// own body shadowing it.
function pairChannels(peaksTop, peaksBottom, cfg) {
  const dSep = cfg.dSepM;
  const maxDelta = dSep * (cfg.pairSlack ?? 1.5);
  const cands = [];
  for (let i = 0; i < peaksTop.length; i++) {
    for (let j = 0; j < peaksBottom.length; j++) {
      const delta = peaksTop[i].pathM - peaksBottom[j].pathM;
      if (Math.abs(delta) <= maxDelta) cands.push({ i, j, ad: Math.abs(delta) });
    }
  }
  cands.sort((a, b) => a.ad - b.ad);
  const usedT = new Set();
  const usedB = new Set();
  const pairs = [];
  for (const c of cands) {
    if (usedT.has(c.i) || usedB.has(c.j)) continue;
    usedT.add(c.i);
    usedB.add(c.j);
    const top = peaksTop[c.i];
    const bottom = peaksBottom[c.j];
    const { cls, delta } = classifySurface(top.pathM, bottom.pathM, dSep, cfg.dSepTolM);
    pairs.push({ top, bottom, delta, cls, pathM: (top.pathM + bottom.pathM) / 2 });
  }
  return {
    pairs,
    loneTop: peaksTop.filter((_, i) => !usedT.has(i)),
    loneBottom: peaksBottom.filter((_, j) => !usedB.has(j)),
  };
}

// Speaker separation read back out of the data. The floor and ceiling deltas
// are +d_sep and -d_sep by construction, so their magnitudes are two
// independent measurements of it. A stable recovered value that disagrees with
// the ruler figure is the better number of the two.
// Returns the raw magnitudes, NOT a summary. A triplet contributes at most two
// (one floor, one ceiling), and pct(arr, 0.5) on two elements is sorted[0] —
// the minimum, not the median. Summarising per triplet and then pooling those
// summaries therefore biases the answer low by ~0.56 sigma of the arrival
// noise, which on the synthetic session read 134.2 mm against a true 140.0.
// The caller pools the magnitudes and takes one median over all of them.
function recoverDSep(pairs) {
  const mags = pairs
    .filter((p) => p && (p.cls === 'floor' || p.cls === 'ceiling'))
    .map((p) => Math.abs(p.delta));
  return mags.length ? { n: mags.length, mags } : null;
}

// ---------------------------------------------------------------------------
// Sound speed
//
// Three estimates, returned side by side rather than collapsed to one. They
// disagree in informative ways: the ceiling solve is the sharpest but needs a
// tape, the split solve needs nothing about the room at all, and the
// temperature model is what is left when a carpeted floor eats the first echo.

// Takes RAW SAMPLE DELAYS, not metres — resolving c from something that was
// computed with an assumed c is circular. `d*` are delays relative to the
// self-heard direct arrival; `sr` the capture rate.
function soundSpeeds(d, cfg) {
  const out = { ceiling: null, split: null, model: 331.3 + 0.606 * (cfg.tempC ?? 20) };
  const sr = cfg.sr;
  const spkMic = cfg.spkMicM ?? 0;

  // For ANY one speaker, floorPath + ceilPath = (h_s+h_m) + (2H-h_s-h_m) = 2H
  // exactly — both the phone height and the speaker offset cancel outright.
  // That is why this is the primary solve: H is tape-measurable once and
  // permanent, while the operator's height above the floor is the shaky number,
  // and here it never enters at all. Same channel for both echoes, or the
  // cancellation is not exact.
  if (Number.isFinite(cfg.ceilM) && d.floor != null && d.ceil != null) {
    const sum = d.floor + d.ceil;
    if (sum > 0) out.ceiling = ((2 * cfg.ceilM - 2 * spkMic) * sr) / sum;
  }

  // The floor delta is d_sep/c and nothing else; the ceiling delta is its
  // negative. Needs no room measurement at all, so it survives a room with no
  // usable ceiling return — and it is the only estimate here that is
  // independent of both declared heights.
  const est = [];
  if (d.floorTop != null && d.floorBot != null && d.floorTop > d.floorBot) {
    est.push((cfg.dSepM * sr) / (d.floorTop - d.floorBot));
  }
  if (d.ceilTop != null && d.ceilBot != null && d.ceilBot > d.ceilTop) {
    est.push((cfg.dSepM * sr) / (d.ceilBot - d.ceilTop));
  }
  if (est.length) out.split = est.reduce((a, b) => a + b, 0) / est.length;
  return out;
}

// ---------------------------------------------------------------------------
// Free-space frontier
//
// The one test here that needs no segments and no tag chain: march the carved
// free cells outward and ask how far the map claims you can see. No echo may
// arrive from nearer than that, in any direction. A violation is free space
// carved where something solid stands — and leaks() structurally cannot see it,
// because leaks() only counts cells behind a *tag* plane.
//
// Occupied cells are deliberately not the query target. The grid's substance is
// carved free space; occupancy is sparse ray-end bumps, and a march against occ
// alone would mostly find nothing and report a confident false absence.
function freeFrontier(P, floor, cfg = {}) {
  const cellM = floor.cellM;
  const half = 4096;
  const key = (ix, iz) => (ix + half) * (half * 2) + (iz + half);
  const free = new Set();
  for (let i = 0; i < floor.free.length; i += 2) free.add(key(floor.free[i], floor.free[i + 1]));

  const maxR = cfg.maxRangeM ?? 6;
  const step = cellM / 2;
  const steps = Math.ceil(maxR / step);
  const out = [];
  for (let deg = 0; deg < 360; deg++) {
    const rad = (deg * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uz = Math.sin(rad);
    let r = 0;
    for (let s = 1; s <= steps; s++) {
      const d = s * step;
      const ix = Math.floor((P[0] + ux * d) / cellM);
      const iz = Math.floor((P[1] + uz * d) / cellM);
      if (!free.has(key(ix, iz))) break;
      r = d;
    }
    out.push(r);
  }
  return { byDeg: out, nearestM: Math.min(...out) };
}

// ---------------------------------------------------------------------------
// Matching

// Nearest prediction wins, one peak per prediction, greedy by ascending
// residual. `missed` is a prediction with no energy behind it — the metric that
// means something, because a peak with no prediction is unattributable (a
// chair, a person, the operator's own hand) and must never be scored as
// evidence against the map.
function matchComb(peaks, comb, cfg) {
  const tol = cfg.tolM ?? 0.10;
  const cands = [];
  for (let i = 0; i < peaks.length; i++) {
    for (let j = 0; j < comb.length; j++) {
      const resid = peaks[i].pathM - comb[j].pathM;
      if (Math.abs(resid) <= tol) cands.push({ i, j, ar: Math.abs(resid), resid });
    }
  }
  cands.sort((a, b) => a.ar - b.ar);
  const usedP = new Set();
  const usedC = new Set();
  const matched = [];
  for (const c of cands) {
    if (usedP.has(c.i) || usedC.has(c.j)) continue;
    usedP.add(c.i);
    usedC.add(c.j);
    matched.push({ peak: peaks[c.i], pred: comb[c.j], residM: c.resid });
  }
  return {
    matched,
    missed: comb.filter((_, j) => !usedC.has(j)),
    unexplained: peaks.filter((_, i) => !usedP.has(i)),
  };
}

// ---------------------------------------------------------------------------
// Units
//
// Delays are journaled in samples relative to the self-heard direct arrival —
// never in metres, so `c` is a decision the offline tool can revisit. The
// direct arrival is the ~10 cm chassis path rather than zero range, and that
// term is not cosmetic: dropping it biases every path by 10 cm, which is larger
// than the effect being measured.
function toPathM(dSamp, sr, c, spkMicM) {
  return (c * dSamp) / sr + spkMicM;
}

// One-way perpendicular distance to a flat vertical wall, from total path.
// Only meaningful for a wall — floor and ceiling paths are not "twice" anything
// the caller wants back.
function wallDistM(pathM, dv = 0) {
  const sq = pathM * pathM - dv * dv;
  return sq > 0 ? Math.sqrt(sq) / 2 : pathM / 2;
}

module.exports = {
  quatRotate,
  segIntersect2D,
  pct,
  stat,
  assertGridShape,
  assertMarkerShape,
  normaliseMarkers,
  standpointOf,
  perpFoot,
  predictWall,
  combForSpeaker,
  predictComb,
  classifySurface,
  pairChannels,
  recoverDSep,
  soundSpeeds,
  freeFrontier,
  matchComb,
  toPathM,
  wallDistM,
};

// ---------------------------------------------------------------------------
// Self-test. Known answers only — every case here is one someone can check by
// hand, which is the point: this file is the ruler, and a ruler that was never
// held against anything is just an opinion.

if (require.main === module) {
  let fails = 0;
  const near = (a, b, tol, what) => {
    if (!(Math.abs(a - b) <= tol)) {
      console.error(`FAIL ${what}: ${a} vs ${b} (tol ${tol})`);
      fails++;
    } else {
      console.log(`  ok  ${what}  ${typeof a === 'number' ? a.toFixed(4) : a}`);
    }
  };
  const eq = (a, b, what) => {
    if (a !== b) {
      console.error(`FAIL ${what}: ${a} !== ${b}`);
      fails++;
    } else {
      console.log(`  ok  ${what}  ${a}`);
    }
  };

  console.log('perpFoot / predictWall');
  // Wall along z at x=2, standpoint at the origin: image source at x=4.
  const wall = { a: [2, -5], b: [2, 5], ids: [1] };
  const f = perpFoot([0, 0], wall);
  near(f.dPerp, 2, 1e-9, 'perpendicular distance 2.00 m');
  const pw = predictWall([0, 0], wall, [wall], {});
  eq(pw.specular, true, 'foot inside the segment is specular');
  eq(pw.provenance, 'tagged', 'a segment with ids is tagged provenance');
  const cb = combForSpeaker([0, 0], 1.2, [pw], { ceilM: 2.5, micOffM: 0 }, 0);
  near(cb.find((e) => e.kind === 'wall').pathM, 4, 1e-9, 'wall path 4.00 m');

  // A standpoint off the end of a finite wall has no specular reflection.
  const off = predictWall([0, 20], wall, [wall], {});
  eq(off.specular, false, 'foot beyond the segment is not specular');

  console.log('\nthe second-order comb');
  // The worked example from the header: 3 m wall, phone at 1.2 m, 2.5 m ceiling.
  const w3 = predictWall([0, 0], { a: [3, -5], b: [3, 5], ids: [2] }, [], {});
  const c3 = combForSpeaker([0, 0], 1.2, [w3], { ceilM: 2.5, micOffM: 0 }, 0);
  near(c3.find((e) => e.kind === 'wall').pathM, 6.0, 1e-9, 'wall 6.00 m');
  near(c3.find((e) => e.kind === 'wall+floor').pathM, 6.4622, 1e-3, 'wall+floor 6.46 m');
  near(c3.find((e) => e.kind === 'wall+ceiling').pathM, 6.5391, 1e-3, 'wall+ceiling 6.54 m');
  near(c3.find((e) => e.kind === 'floor').pathM, 2.4, 1e-9, 'floor 2.40 m');
  near(c3.find((e) => e.kind === 'ceiling').pathM, 2.6, 1e-9, 'ceiling 2.60 m');

  console.log('\nthe stereo split — the design\'s strongest claim');
  const dSep = 0.14;
  const cfg = { ceilM: 2.5, dSepM: dSep, micOffM: -dSep / 2 };
  const top = combForSpeaker([0, 0], 1.2, [w3], cfg, +dSep / 2);
  const bot = combForSpeaker([0, 0], 1.2, [w3], cfg, -dSep / 2);
  const kind = (arr, k) => arr.find((e) => e.kind === k).pathM;
  near(kind(top, 'floor') - kind(bot, 'floor'), +dSep, 1e-9, 'floor delta is +d_sep');
  near(kind(top, 'ceiling') - kind(bot, 'ceiling'), -dSep, 1e-9, 'ceiling delta is -d_sep');
  // The wall delta is bounded by d_sep^2/4d and is the reason the three
  // classification windows do not touch.
  near(kind(top, 'wall') - kind(bot, 'wall'), 0.0016, 5e-4, 'wall delta ~0 at 3 m');

  console.log('\nclassifySurface');
  eq(classifySurface(2.47, 2.33, dSep, dSep / 3).cls, 'floor', '+0.14 is floor');
  eq(classifySurface(2.53, 2.67, dSep, dSep / 3).cls, 'ceiling', '-0.14 is ceiling');
  eq(classifySurface(6.0016, 6.0, dSep, dSep / 3).cls, 'vertical', '~0 is vertical');
  eq(classifySurface(2.0, 1.93, dSep, dSep / 3).cls, 'ambiguous', 'half a d_sep is ambiguous');
  try {
    classifySurface(1, 1, dSep, dSep / 2);
    console.error('FAIL classifySurface accepted an overlapping tolerance');
    fails++;
  } catch {
    console.log('  ok  refuses a tolerance that makes the windows touch');
  }

  console.log('\npairChannels');
  const pk = (pathM) => ({ pathM });
  const paired = pairChannels(
    [pk(kind(top, 'floor')), pk(kind(top, 'ceiling')), pk(kind(top, 'wall'))],
    [pk(kind(bot, 'floor')), pk(kind(bot, 'ceiling')), pk(kind(bot, 'wall'))],
    { dSepM: dSep },
  );
  eq(paired.pairs.length, 3, 'three surfaces pair up');
  eq(paired.pairs.filter((p) => p.cls === 'floor').length, 1, 'one floor');
  eq(paired.pairs.filter((p) => p.cls === 'ceiling').length, 1, 'one ceiling');
  eq(paired.pairs.filter((p) => p.cls === 'vertical').length, 1, 'one vertical');
  const rec = recoverDSep(paired.pairs);
  eq(rec.n, 2, 'd_sep magnitudes are returned raw, one per calibration surface');
  near(pct(rec.mags, 0.5), dSep, 1e-9, 'd_sep recovered from the deltas');
  // pct on two elements is the minimum, not the median — the reason recoverDSep
  // must not summarise before the caller has pooled every triplet's magnitudes.
  near(pct([0.10, 0.20], 0.5), 0.10, 1e-12, 'pct(n=2) is the lower element, by design');

  console.log('\nsoundSpeeds — solved back out of synthetic delays');
  // Forward-model a room at a known c, then check both solves recover it.
  const cTrue = 346.0;
  const sr = 48000;
  const spkMic = 0.10;
  const y = 1.2;
  const H = 2.5;
  const dly = (pathM) => ((pathM - spkMic) / cTrue) * sr;
  // Bottom speaker (mic co-located at the bottom edge) and top speaker.
  const hmB = y - dSep / 2;
  const hsT = y + dSep / 2;
  const ss = soundSpeeds({
    floor: dly(hmB + hmB), ceil: dly(2 * H - hmB - hmB),
    floorTop: dly(hsT + hmB), floorBot: dly(hmB + hmB),
    ceilTop: dly(2 * H - hsT - hmB), ceilBot: dly(2 * H - hmB - hmB),
  }, { sr, ceilM: H, spkMicM: spkMic, dSepM: dSep, tempC: 20 });
  near(ss.ceiling, cTrue, 1e-6, 'ceiling solve recovers c exactly');
  near(ss.split, cTrue, 1e-6, 'split solve recovers c with no room measurement');
  near(ss.model, 343.42, 1e-2, 'temperature model at 20 C');

  console.log('\nmatchComb');
  const mm = matchComb([pk(6.01), pk(2.40), pk(4.44)], c3, { tolM: 0.1 });
  eq(mm.matched.length, 2, 'two of three peaks explained');
  eq(mm.unexplained.length, 1, 'the invented peak stays unexplained');
  near(mm.matched.find((m) => m.pred.kind === 'wall').residM, 0.01, 1e-9, 'wall residual +10 mm');

  console.log('\nfreeFrontier');
  // A 2 m x 2 m carved box centred on the origin, 0.06 m cells.
  const free = [];
  for (let ix = -16; ix < 16; ix++) for (let iz = -16; iz < 16; iz++) free.push(ix, iz);
  const fr = freeFrontier([0, 0], { cellM: 0.06, free }, { maxRangeM: 6 });
  near(fr.nearestM, 0.93, 0.06, 'frontier of a 0.96 m half-box');

  console.log('\nshape tripwires');
  try {
    assertGridShape({ walls: [{ a: 2, b: 3 }], floor: { cellM: 0.06, free: [] } });
    console.error('FAIL assertGridShape accepted a changed segment shape');
    fails++;
  } catch {
    console.log('  ok  refuses a changed wall segment shape');
  }
  try {
    assertGridShape({ walls: [], floor: { cellM: 0.06, free: [1] } });
    console.error('FAIL assertGridShape accepted an odd-length free array');
    fails++;
  } catch {
    console.log('  ok  refuses an odd-length floor.free');
  }

  console.log(fails ? `\n${fails} FAILURE(S)` : '\nall good');
  process.exit(fails ? 1 : 0);
}
