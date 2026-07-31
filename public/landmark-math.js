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

// Two anchors closer than this are one physical feature seen under two ids, so
// a raw count overstates how many the room actually gained.
const CLUSTER_M = 0.05;
// Below this the split-arc test is noise-dominated and says nothing.
const MIN_OBS = 12;
// Measured floor, and not a round number chosen for looks: at a 59 deg arc a
// genuinely fixed point still showed 6.7 mm of noise-driven split gap, and at
// 16 deg it showed 62.9 mm. Below 60 deg no honest call is possible either way.
const MIN_ARC_DEG = 60;
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
// Deliberately loose. A real anchor sat at 2.3-7.0 px and a bad one at 27.9 px
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
// itself, it would quietly cost anchors near the frame edge.
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
  const span = rows[rows.length - 1].az - rows[0].az;
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
  if (sa.span < minArcDeg) return { ok: false, reason: 'narrow-arc', P, span: sa.span };

  const first = sa.rows[0];
  const last = sa.rows[sa.rows.length - 1];
  const err = rms(P, obs);
  const out = {
    P, n: obs.length, span: sa.span, err, first: first.gap, last: last.gap, ok: false,
  };
  if (!(err < maxRmsPx)) return { ...out, reason: 'rms' };
  if (!(last.gap < first.gap / splitCollapse || last.gap < splitFloorMm)) {
    return { ...out, reason: 'no-collapse' };
  }
  return { ...out, ok: true, reason: null };
}

// Several tracks routinely sit on one physical feature, so a raw count
// overstates the anchor supply. Greedy single-link at CLUSTER_M, taking the
// list in whatever order the caller ranked it.
function clusterAnchors(list, m = CLUSTER_M) {
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
    unwrapAzimuths, splitArc, qualifyTrack, clusterAnchors,
    CLUSTER_M, MIN_OBS, MIN_ARC_DEG, SPLIT_COLLAPSE, SPLIT_FLOOR_MM, MAX_RMS_PX,
  };
}
