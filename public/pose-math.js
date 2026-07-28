'use strict';

// Minimal rigid-transform toolbox shared by the browser pages and the server
// (loaded as a plain script in one, require()d by the other — hence the
// module.exports tail). A transform is { p: [x,y,z], q: [x,y,z,w] } meaning
// x_out = R(q) * x_in + p. No classes, no allocation tricks — the call rates
// here are tens per second, not per frame.

// Rodrigues rotation vector (what solvePnP emits) -> quaternion.
function quatFromRvec(rvec) {
  const angle = Math.hypot(rvec[0], rvec[1], rvec[2]);
  if (angle < 1e-12) return [0, 0, 0, 1];
  const s = Math.sin(angle / 2) / angle;
  return [rvec[0] * s, rvec[1] * s, rvec[2] * s, Math.cos(angle / 2)];
}

// Quaternion -> Rodrigues rotation vector (inverse of quatFromRvec).
function rvecFromQuat(q) {
  const n = Math.hypot(q[0], q[1], q[2]);
  if (n < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(n, Math.abs(q[3]));
  const sign = q[3] < 0 ? -1 : 1;
  return [q[0] / n * angle * sign, q[1] / n * angle * sign, q[2] / n * angle * sign];
}

function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function quatConj(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

function quatNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// Rotate vector v by quaternion q.
function quatRotate(q, v) {
  const [x, y, z, w] = q;
  // t = 2 * (q_vec x v); v' = v + w*t + q_vec x t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + y * tz - z * ty,
    v[1] + w * ty + z * tx - x * tz,
    v[2] + w * tz + x * ty - y * tx,
  ];
}

// Angular distance between two orientations, in degrees.
function quatAngleDeg(a, b) {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot))) * 180 / Math.PI;
}

// Weighted mean of quaternions that all sit near each other: sign-align to
// the first (q and -q are the same rotation, and averaging across the sign
// flip cancels instead of averaging), then normalized weighted sum. Not valid
// for widely spread rotations — fine here, outliers are rejected first.
function quatMean(quats, weights) {
  const ref = quats[0];
  const acc = [0, 0, 0, 0];
  for (let i = 0; i < quats.length; i++) {
    const q = quats[i];
    const w = weights ? weights[i] : 1;
    const sign = (q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3]) < 0 ? -w : w;
    for (let k = 0; k < 4; k++) acc[k] += q[k] * sign;
  }
  return quatNormalize(acc);
}

// Small-step interpolation toward a target orientation (sign-aligned nlerp:
// good for the tiny t used in refinement, no slerp needed).
function quatNudge(from, to, t) {
  const sign = (from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3]) < 0 ? -1 : 1;
  return quatNormalize([
    from[0] + (to[0] * sign - from[0]) * t,
    from[1] + (to[1] * sign - from[1]) * t,
    from[2] + (to[2] * sign - from[2]) * t,
    from[3] + (to[3] * sign - from[3]) * t,
  ]);
}

function se3FromRvecTvec(rvec, tvec) {
  return { p: [tvec[0], tvec[1], tvec[2]], q: quatFromRvec(rvec) };
}

// A then B applied outermost: x -> A(B(x)).
function se3Compose(a, b) {
  const p = quatRotate(a.q, b.p);
  return {
    p: [p[0] + a.p[0], p[1] + a.p[1], p[2] + a.p[2]],
    q: quatNormalize(quatMul(a.q, b.q)),
  };
}

function se3Invert(t) {
  const qi = quatConj(t.q);
  const p = quatRotate(qi, t.p);
  return { p: [-p[0], -p[1], -p[2]], q: qi };
}

function se3Identity() {
  return { p: [0, 0, 0], q: [0, 0, 0, 1] };
}

function transformPoint(t, v) {
  const r = quatRotate(t.q, v);
  return [r[0] + t.p[0], r[1] + t.p[1], r[2] + t.p[2]];
}

if (typeof module !== 'undefined') {
  module.exports = {
    quatFromRvec, rvecFromQuat, quatMul, quatConj, quatNormalize, quatRotate,
    quatAngleDeg, quatMean, quatNudge, se3FromRvecTvec, se3Compose, se3Invert,
    se3Identity, transformPoint,
  };
}
