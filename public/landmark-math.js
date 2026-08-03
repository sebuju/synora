'use strict';

// Landmark geometry, shared by the offline probe page and the server's landmark
// map (loaded as a plain script in one, require()d by the other — hence the
// module.exports tail, the same arrangement pose-math.js uses).
//
// A *landmark* is one image feature followed by optical flow across frames and
// triangulated from the camera poses the tags supplied. What lives here is the
// part that decides whether such a track describes a fixed point in the room at
// all — which is the whole difficulty, and is not what it first appears to be.
//
// An observation is { u, v, K, pose }: the pixel the feature was seen at, the
// camera model of the frame it was seen in, and the room-frame camera pose at
// that moment. It carries its own K rather than looking one up, because the
// server receives the model over the wire per message and the client is free to
// change resolution mid-session.

// pose-math.js is a plain script in the browser (so its functions are globals)
// and a module on the server. Resolving it through one object rather than bare
// names keeps this file loadable both ways without a top-level `let` that would
// collide with the global of the same name.
const LM_PM = typeof require === 'function' ? require('./pose-math.js') : globalThis;

// Two landmarks closer than this are one physical feature seen under two ids, so
// a raw count overstates how many the room actually gained.
const CLUSTER_M = 0.05;
// Below this the split-arc test is noise-dominated and says nothing.
const MIN_OBS = 12;
// How much of an arc a track must be seen through before it can be judged.
//
// This was 60, on a measurement of the split-arc test *in isolation*: at a 59
// deg arc a genuinely fixed point showed 6.7 mm of noise-driven split gap and at
// 16 deg it showed 62.9 mm, so below 60 deg that test alone cannot call it
// either way. That is still true, and it is no longer the whole story — the
// forward-backward check on the client now removes the drifting tracks upstream
// (measured: 8.8% of tracks described a fixed point before it, 97% after), the
// solve's RANSAC trims what still gets through, and a wrong landmark is dropped by
// the staleness gate. The arc gate was carrying a load that has since been taken
// off it.
//
// So it was swept end to end — landmarks built from half a recorded walk, camera
// localized from the other half with the tag pose withheld — across five
// sessions:
//
//   session   60 deg                    40 deg                    30 deg
//   16:35     124 · 184/245 · 47 mm     149 · 195/245 · 31 mm     184 · 203/245 · 32 mm
//   16:51      65 · 151/256 · 36 mm     123 · 151/256 · 35 mm     160 · 224/256 · 42 mm
//   18:22      33 ·  81/111 · 65 mm      90 ·  81/111 · 41 mm     105 ·  81/111 · 38 mm
//   19:24      86 ·  56/267 · 31 mm     113 ·  57/267 · 58 mm     152 ·  57/267 · 45 mm
//   23:28      21 ·  60/468 · 28 mm      55 · 106/468 · 29 mm      90 · 114/468 · 26 mm
//
// Landmark supply rises 1.3-2.7x, coverage rises or holds on every session, and
// the median error is a wash — it moves both ways by ~15 mm, which is inside the
// session-to-session spread. Supply is what is actually scarce: MIN_LANDMARKS_FOR
// _FIX is a cliff at 15, and the 23:28 walk had *21* landmarks at 60 deg, so a
// third of its map going missing was the difference between localizing 60 frames
// and 106.
//
// The honest cost is the tail: worst-case position grew on three of the five
// (151 -> 371, 369 -> 467, 334 -> 369 mm) while shrinking on the others. 40 deg
// rather than 30 because that is where supply is bought without pushing further
// into a tail nothing downstream measures for us.
//
// In walking terms this is the difference that matters to whoever is holding the
// phone: at 2 m, 60 deg is a 2.0 m sidestep and 40 deg is 1.37 m.
//
// Swept again (02/08/26) 40 vs 20, four sessions, after the guidance work made
// clear the arc demand is what keeps the feature from firing at all on a
// normal walk:
//
//   session   40 deg                     20 deg
//   23:28      55 · 106/468 · 28 mm ·  371   125 · 114/468 · 26 mm · 247
//   19:24     113 ·  60/267 · 59 mm ·  382   159 ·  60/267 · 47 mm · 263
//   16:51     123 · 156/256 · 35 mm ·  165   177 · 229/256 · 36 mm · 249
//   00:50      32 ·   0/144 ·  —    ·   —     41 ·   0/144 ·  —    ·  —
//
// Supply rises 28-127%, coverage rises or holds everywhere (156 -> 229 on
// 16:51 is the count cliff being cleared), medians are a wash, and the worst
// case moves both ways within the session spread. At 20 deg the split-arc test
// itself is near its noise floor (a fixed point showed 62.9 mm of split at 16
// deg), so below here the discrimination is genuinely the forward-backward
// check + the RANSAC + the staleness gate — which is what the end-to-end
// holdout above says they can carry. 20 deg at 2 m is a 0.70 m sidestep:
// walking past something starts to qualify, which is the whole point.
const MIN_ARC_DEG = 20;
// The gap at the widest window must be this many times smaller than at the
// narrowest. Measured separation: genuine points collapse ~35x, viewpoint-
// dependent ones ~1.9x.
const SPLIT_COLLAPSE = 5;
// A gap already this small has converged, whatever the ratio says. The ratio
// exists to tell noise-driven disagreement from a viewpoint-correlated bias,
// and below a couple of millimetres there is nothing left to tell apart:
// measured, genuine points land at 0.4-1.8 mm at the widest window while the
// failure mode sits at 33 mm. Without this a *perfect* point fails, because the
// test becomes 0 < 0/5 — which is how a noise-free synthetic check first caught
// it, and which a low-noise track can approach in the room.
const SPLIT_FLOOR_MM = 2;
// Deliberately loose. A real landmark sat at 2.3-7.0 px and a bad one at 27.9 px
// and worse (up to 1422 px); this gate only rules out "no 3D point fits these
// observations at all", the split-arc trend does the actual discriminating.
const MAX_RMS_PX = 10;

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Brown-Conrady inverse: pixel as measured -> pixel as an ideal pinhole camera
// would have put it. Everything downstream then works in one undistorted space,
// so reprojection errors stay comparable to the tag pipeline's.
//
// This is hand-rolled because cv.undistortPoints is not bound in the vendored
// opencv.js build — the same class of gap as the already-known missing
// solvePnPGeneric and cornerSubPix. It matters more than it looks: the measured
// calibration of a real client displaces the frame corner by ~14 px, and that
// error is *viewpoint-correlated*, which is precisely the signature the
// split-arc test exists to reject. Left uncorrected it would not announce
// itself, it would quietly cost landmarks near the frame edge.
//
// Returns the input unchanged when there is no distortion to remove, which is
// also the offline probe's case: its intrinsics are fitted as a pure pinhole.
function undistort(u, v, K) {
  const d = K.dist;
  if (!d || !(d[0] || d[1] || d[2] || d[3] || d[4])) return [u, v];
  const [k1, k2, p1, p2, k3] = d;
  const x0 = (u - K.cx) / K.fx;
  const y0 = (v - K.cy) / K.fy;
  let x = x0;
  let y = y0;
  // Fixed-point iteration; five passes is well past convergence at the
  // distortion magnitudes a phone camera produces.
  for (let i = 0; i < 5; i++) {
    const r2 = x * x + y * y;
    const radial = 1 / (1 + r2 * (k1 + r2 * (k2 + r2 * k3)));
    const dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
    const dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
    x = (x0 - dx) * radial;
    y = (y0 - dy) * radial;
  }
  return [K.fx * x + K.cx, K.fy * y + K.cy];
}

// Unit ray from the camera towards the feature, in room coordinates.
function rayOf(o) {
  const d = [(o.u - o.K.cx) / o.K.fx, (o.v - o.K.cy) / o.K.fy, 1];
  const r = LM_PM.quatRotate(o.pose.q, d);
  const n = Math.hypot(r[0], r[1], r[2]);
  return [r[0] / n, r[1] / n, r[2] / n];
}

function solve3(A, b) {
  const M = [[...A[0], b[0]], [...A[1], b[1]], [...A[2], b[2]]];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

// Point minimising the summed squared perpendicular distance to a set of rays.
function triangulate(obs) {
  if (obs.length < 2) return null;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (const o of obs) {
    const d = rayOf(o);
    const C = o.pose.p;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const m = (i === j ? 1 : 0) - d[i] * d[j];
        A[i][j] += m;
        b[i] += m * C[j];
      }
    }
  }
  return solve3(A, b);
}

function reproject(P, o) {
  const c = LM_PM.transformPoint(LM_PM.se3Invert(o.pose), P);
  if (!(c[2] > 1e-6)) return null;
  return [o.K.fx * c[0] / c[2] + o.K.cx, o.K.fy * c[1] / c[2] + o.K.cy];
}

// Where the camera sat around the point, in the room's horizontal plane. The
// arc this spans is what makes a viewpoint-correlated bias visible at all.
function azimuthOf(P, o) {
  return Math.atan2(o.pose.p[0] - P[0], o.pose.p[2] - P[2]) * 180 / Math.PI;
}

function rms(P, obs) {
  let sum = 0;
  let n = 0;
  for (const o of obs) {
    const q = reproject(P, o);
    if (!q) continue;
    sum += (q[0] - o.u) ** 2 + (q[1] - o.v) ** 2;
    n++;
  }
  return n ? Math.sqrt(sum / n) : NaN;
}

// Azimuths are angles on a circle, so sorting them raw splits any arc that
// happens to straddle ±180° into two clumps at opposite ends of the list — and
// every window and half-split below would then be nonsense. Cut the circle at
// the widest gap between observations instead, which is where the arc actually
// ends, and unwrap from there.
function unwrapAzimuths(obs, P) {
  const rows = obs.map((o) => ({ o, az: azimuthOf(P, o) })).sort((a, b) => a.az - b.az);
  let cut = 0;
  let widest = -1;
  for (let i = 0; i < rows.length; i++) {
    const next = rows[(i + 1) % rows.length];
    const gap = i === rows.length - 1
      ? next.az + 360 - rows[i].az
      : next.az - rows[i].az;
    if (gap > widest) { widest = gap; cut = (i + 1) % rows.length; }
  }
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[(cut + i) % rows.length];
    const az = out.length && r.az < out[0].az ? r.az + 360 : r.az;
    out.push({ o: r.o, az });
  }
  return out;
}

// Triangulate each half of the viewing arc separately and compare. A point that
// really is fixed gives the same answer from both halves; a silhouette centroid
// does not, and the gap is roughly the object's depth. Reported against arc
// width, because the *trend* is the signal — see qualifyTrack.
function splitArc(obs, P) {
  const rows = unwrapAzimuths(obs, P);
  const az0 = rows[0].az;
  const az1 = rows[rows.length - 1].az;
  const span = az1 - az0;
  const mid = (rows[0].az + rows[rows.length - 1].az) / 2;
  const out = [];
  for (const width of [20, 40, 60, 80, 120, 180, 360]) {
    const win = rows.filter((r) => Math.abs(r.az - mid) <= width / 2);
    if (win.length < 4) continue;
    const half = Math.floor(win.length / 2);
    const a = triangulate(win.slice(0, half).map((r) => r.o));
    const b = triangulate(win.slice(win.length - half).map((r) => r.o));
    if (!a || !b) continue;
    const actual = win[win.length - 1].az - win[0].az;
    out.push({ width: Math.round(Math.min(width, actual)), n: win.length, gap: dist3(a, b) * 1000 });
    if (width >= span) break;
  }
  return { span, rows: out };
}

// Does this track describe a fixed 3D point? Returns { ok, P, ... } and, when
// it does not, the `reason` — the histogram of those is how a session is
// diagnosed offline.
//
// The load-bearing part is that the split-arc gap is judged by how much it
// *collapses* as the arc widens, not against a threshold. The obvious
// implementation is the wrong one: a narrow window holds few observations, so
// tracking noise dominates it and a perfectly real point scores badly there.
// Measured, at a narrow window a genuine point gave 62.9 mm and a
// viewpoint-dependent one 63.4 mm — indistinguishable. Widening the arc
// averages the noise down (1.8 mm) while a viewpoint-correlated bias survives
// untouched (33.1 mm). Any single-window threshold conflates the two; the trend
// separates them by 18x.
function qualifyTrack(obs, opts = {}) {
  const minObs = opts.minObs ?? MIN_OBS;
  const minArcDeg = opts.minArcDeg ?? MIN_ARC_DEG;
  const splitCollapse = opts.splitCollapse ?? SPLIT_COLLAPSE;
  const splitFloorMm = opts.splitFloorMm ?? SPLIT_FLOOR_MM;
  const maxRmsPx = opts.maxRmsPx ?? MAX_RMS_PX;

  if (obs.length < minObs) return { ok: false, reason: 'few-obs' };
  const P = triangulate(obs);
  if (!P || !P.every(Number.isFinite)) return { ok: false, reason: 'no-triangulation' };
  const sa = splitArc(obs, P);
  if (!sa.rows.length) return { ok: false, reason: 'no-windows' };
  // Computed before the narrow-arc exit, not after it. Every rejection that has
  // a point at all now reports how well that point explains the track, because
  // the callers that *display* candidates use `err` to tell an estimate from a
  // triangulation that landed beside the camera — and without it here, every
  // narrow-arc candidate looked unusable and was dropped. That silently limited
  // both the candidate layer and the walk guidance to tracks already past the
  // arc gate, which are exactly the ones neither has anything to say about.
  const err = rms(P, obs);

  // The narrow-arc rejection carries its estimate, unlike the ones above it:
  // this is *the* case the candidate view and the walk guidance read, since a
  // candidate that has not qualified is almost always one that has not been
  // walked around far enough yet.
  if (sa.span < minArcDeg) {
    return { ok: false, reason: 'narrow-arc', P, n: obs.length, err, span: sa.span };
  }

  const first = sa.rows[0];
  const last = sa.rows[sa.rows.length - 1];
  const out = {
    P, n: obs.length, span: sa.span, err,
    first: first.gap, last: last.gap, ok: false,
  };
  if (!(err < maxRmsPx)) return { ...out, reason: 'rms' };
  if (!(last.gap < first.gap / splitCollapse || last.gap < splitFloorMm)) {
    return { ...out, reason: 'no-collapse' };
  }
  return { ...out, ok: true, reason: null };
}

// Camera pose from matched landmarks, by seeded refinement with the outliers
// trimmed off. Returns { p, q, rms, inliers, n } or null.
//
// Why this shape rather than a RANSAC. A landmark solve only ever happens
// *just after* the client had a pose — that is the whole feature: the tags go
// out of view and this carries on from where they left off — so a seed within a
// frame or two of the answer is always available, and each solve seeds the
// next. That changes what the solver has to do:
//
//   - It does not have to find the basin, only to stay in it. Landmarks are
//     bearing-only and tend towards one wall, which is the weak PnP
//     configuration; a seedless solve on 4-5 of them was measured at 1781 mm
//     and 56.63 deg, and the 56 deg is the mirror flip. A seeded refinement
//     cannot flip: it converges to the local minimum it started next to.
//   - It does have to reject outliers, which tags did not need — corner
//     detections are gated hard upstream, but an optical-flow track drifts onto
//     its neighbour, slides along an edge, or lands on something that moved,
//     and nothing upstream can see that.
//
// So: a RANSAC, with solvePose standing in for the minimal solver a RANSAC
// normally needs. That substitution is only sound *because* of the seed —
// solvePose is a local refiner and cannot find a basin on its own, but started
// next to the answer and given a handful of correspondences it converges to a
// usable hypothesis, which is all a RANSAC round asks of it.
//
// Fitting the whole set first and trimming what disagrees does not work here,
// and the failure is worth recording: the first fit is dragged by the very
// outliers it is meant to expose, so the residuals it is trimmed on are already
// corrupted. Measured against cv.solvePnPRansac at 16 landmarks with 15% of
// tracks displaced, trim-from-a-full-fit gave a median of 69 mm where the
// RANSAC gave 1 mm.
//
// Iteration count is small because the seed makes every hypothesis a good one:
// at 30% contamination and 6-point subsets, a clean subset turns up in ~12% of
// draws, so ~40 rounds is already well past 99% confidence.
// The outlier gate, and the number the whole landmark lock turned out to hang
// on. 5 -> 8 on measurement (.plans/landmark-lock.md §3a-3c), because at 5 it
// was rejecting *correct* landmarks rather than mismatches:
//
//   - 100% of failed landmark solves failed here — the RANSAC always found a
//     hypothesis, matched 17-30 landmarks, and the trim left 9-11 against a
//     15-landmark count gate. `no-hypothesis` never occurred, on any journal.
//   - Residuals taken through a *tag-derived* pose on the track a landmark is
//     already aliased to — no nearest-point pairing in them, so a position
//     error cannot hide behind a mismatch — put **45-55% of correctly
//     corresponded landmarks past 5 px**. That is exactly the observed inlier
//     ratio (56% on solved frames, 29% on failed).
//   - No founding property predicts which landmarks miss: Spearman of
//     per-landmark miss against arc, refinement rms, sighting count and
//     provenance depth is flat (|rho| <= 0.31, mostly < 0.1) on all three
//     journals. So this could not be fixed by founding harder.
//
// Measured effect, live pipeline, count gate unchanged at 15: solves 12 -> 32,
// 15 -> 42, 14 -> 18, 13 -> 78 across four journals, with confirmations and
// mapSafe rescues rising with them.
//
// Two things hold it here. Past 8 the takeover tail reopens — trim 10 gives a
// 664 mm takeover on one journal and 906 mm on another, past the 0.5 m line
// the plan draws — and loosening the trim lets a near-coplanar cloud walk into
// the mirrored basin, which is what SOLVE_JUMP_DEG in landmarks.js exists to
// catch (it must be in place before this number moves; it was measured
// catching exactly one flip at this setting).
const TRIM_PX = 8;
const RANSAC_ROUNDS = 48;
const RANSAC_SUBSET = 6;
// Hypotheses only need to be close enough to count inliers with; the winner is
// refined properly afterwards. A full refine per hypothesis is most of the cost
// of this function for none of the accuracy.
const HYPOTHESIS_ITER = 15;

// Deterministic, so a replay of the same journal produces the same answer twice
// — the whole point of replay is comparing runs, and a solver that wandered
// between them would make every comparison noise. Seeded from the problem
// itself rather than from a clock for the same reason.
function lcg(seedInt) {
  let s = (seedInt >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function solveLandmarkPose(objPts, imgPts, K, seed, opts = {}) {
  const n = objPts.length;
  const minPoints = opts.minPoints ?? RANSAC_SUBSET;
  const trimPx = opts.trimPx ?? TRIM_PX;
  if (!seed || n < minPoints) return null;

  const residualsUnder = (pose) => objPts.map((X, i) => {
    const q = reproject(X, { K, pose });
    return q ? Math.hypot(q[0] - imgPts[i][0], q[1] - imgPts[i][1]) : Infinity;
  });
  const countIn = (res) => {
    let c = 0;
    for (const v of res) if (v <= trimPx) c++;
    return c;
  };

  // Seeded from the count and the first correspondence: same problem, same
  // draws.
  const rand = lcg(n * 7919 + Math.round((imgPts[0][0] + imgPts[0][1]) * 16));
  const subsetSize = Math.min(RANSAC_SUBSET, n);

  let bestPose = null;
  let bestCount = -1;
  let bestRms = Infinity;
  for (let round = 0; round < RANSAC_ROUNDS; round++) {
    // Partial Fisher-Yates over an index list: sampling with replacement would
    // hand solvePose a degenerate subset.
    const idx = objPts.map((_, i) => i);
    for (let k = 0; k < subsetSize; k++) {
      const j = k + Math.floor(rand() * (n - k));
      [idx[k], idx[j]] = [idx[j], idx[k]];
    }
    const pick = idx.slice(0, subsetSize);
    const sol = LM_PM.solvePose(pick.map((i) => objPts[i]), pick.map((i) => imgPts[i]),
      K, seed, { maxIter: HYPOTHESIS_ITER });
    if (!sol) continue;
    const res = residualsUnder(sol);
    const count = countIn(res);
    if (count > bestCount || (count === bestCount && sol.rms < bestRms)) {
      bestCount = count;
      bestRms = sol.rms;
      bestPose = sol;
    }
  }
  // Why a solve came back empty is invisible from the outside — null means
  // "no hypothesis" and "the trim ate the count" alike — and those are two
  // different failures with two different fixes. `onReject` is how the replay
  // trace tells them apart; nothing live passes one.
  if (!bestPose) { opts.onReject?.({ why: 'no-hypothesis', inliers: 0, n, rms: null }); return null; }

  // Local optimization: refit on everything the winning hypothesis agrees with,
  // which is what turns a minimal-subset fit into an accurate one.
  const res = residualsUnder(bestPose);
  const obj = [];
  const img = [];
  const inlierIdx = [];
  for (let i = 0; i < n; i++) {
    if (res[i] <= trimPx) { obj.push(objPts[i]); img.push(imgPts[i]); inlierIdx.push(i); }
  }
  if (obj.length < minPoints) {
    opts.onReject?.({ why: 'trimmed', inliers: obj.length, n, rms: bestPose.rms });
    return null;
  }
  const refined = LM_PM.solvePose(obj, img, K, bestPose) ?? bestPose;
  // Per-inlier residuals under the *refined* pose, not the hypothesis they were
  // selected by — the caller weights rays by them, and the hypothesis residuals
  // systematically flatter the subset that picked it.
  const finalRes = residualsUnder(refined);
  return {
    ...refined, inliers: obj.length, n,
    inlierIdx, inlierRes: inlierIdx.map((i) => finalRes[i]),
  };
}

// Several tracks routinely sit on one physical feature, so a raw count
// overstates the landmark supply. Greedy single-link at CLUSTER_M, taking the
// list in whatever order the caller ranked it.
function clusterLandmarks(list, m = CLUSTER_M) {
  const clusters = [];
  for (const j of list) {
    const hit = clusters.find((c) => dist3(c[0].P, j.P) < m);
    if (hit) hit.push(j); else clusters.push([j]);
  }
  return clusters;
}

if (typeof module !== 'undefined') {
  module.exports = {
    undistort, rayOf, solve3, triangulate, reproject, azimuthOf, rms, dist3,
    unwrapAzimuths, splitArc, qualifyTrack, clusterLandmarks, solveLandmarkPose,
    CLUSTER_M, MIN_OBS, MIN_ARC_DEG, SPLIT_COLLAPSE, SPLIT_FLOOR_MM, MAX_RMS_PX,
    TRIM_PX,
  };
}
