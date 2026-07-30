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

// Rodrigues vector -> 3x3 rotation matrix, row-major. Needed because the planar
// mirror construction below is a reflection, and a reflection has no quaternion.
function matFromRvec(rvec) {
  const th = Math.hypot(rvec[0], rvec[1], rvec[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const x = rvec[0] / th;
  const y = rvec[1] / th;
  const z = rvec[2] / th;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

// Inverse of matFromRvec. The near-180° branch is load-bearing: a tag can be
// seen at any roll, the antisymmetric part of R vanishes at a half turn, and
// reading the axis off it alone returns noise exactly there.
function rvecFromMat(m) {
  const c = Math.min(1, Math.max(-1, (m[0] + m[4] + m[8] - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  if (th > Math.PI - 1e-6) {
    // The largest diagonal entry picks the best-conditioned column of R + I.
    const d = [m[0], m[4], m[8]];
    const i = d[0] >= d[1] && d[0] >= d[2] ? 0 : (d[1] >= d[2] ? 1 : 2);
    const col = [m[i], m[3 + i], m[6 + i]];
    col[i] += 1;
    const n = Math.hypot(col[0], col[1], col[2]);
    if (n < 1e-12) return [0, 0, 0];
    return [col[0] / n * th, col[1] / n * th, col[2] / n * th];
  }
  const k = th / (2 * Math.sin(th));
  return [(m[7] - m[5]) * k, (m[2] - m[6]) * k, (m[3] - m[1]) * k];
}

function matMul3(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return o;
}

// Starting guesses for the *other* pose of a planar target.
//
// A plane has two poses that project almost identically, and picking the wrong
// one teleports the implied camera. The two differ by tilting the plane the
// opposite way about the line of sight: if the normal leans away from the view
// ray by some angle, the twin leans by the same angle on the other side. So with
// v the unit direction to the target centre, the twin's normal is the first
// one's reflected **about the line v** — not about the plane perpendicular to
// it. Reflecting about that perpendicular plane instead flips the normal's sign
// along v, which turns the target to face away from the camera: a pose ~180°
// from the answer rather than the ambiguity, and every refine from it either
// dies at ~50 px reprojection error or slides back into the original solution.
//
// Reflection about the line v is `2vv^T - I`, whose eigenvalues are (+1,-1,-1) —
// determinant +1, so it is a proper rotation (the half turn about v) and needs
// no improper flip to fix up.
//
// It does also spin the target 180° in its own plane, which the projection does
// not want, so the in-plane half turn about the target normal is offered as the
// second guess. Only reprojection error can say which is right, so both are
// returned for the caller to refine and score.
//
// The centre stays on the same ray at nearly the same depth, so the first
// solution's translation is already a good starting point for the second.
function mirrorRvecGuesses(rvec, tvec) {
  const d = Math.hypot(tvec[0], tvec[1], tvec[2]);
  if (!(d > 1e-6)) return [];
  const v = [tvec[0] / d, tvec[1] / d, tvec[2] / d];
  const S = [
    2 * v[0] * v[0] - 1, 2 * v[0] * v[1], 2 * v[0] * v[2],
    2 * v[1] * v[0], 2 * v[1] * v[1] - 1, 2 * v[1] * v[2],
    2 * v[2] * v[0], 2 * v[2] * v[1], 2 * v[2] * v[2] - 1,
  ];
  const R = matMul3(S, matFromRvec(rvec));
  return [
    rvecFromMat(R),
    // R * diag(-1,-1,1): a half turn about the target's own normal.
    rvecFromMat([-R[0], -R[1], R[2], -R[3], -R[4], R[5], -R[6], -R[7], R[8]]),
  ];
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
// for widely spread rotations — callers that cannot guarantee that want
// quatMedian below.
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

// Robust centre of a set of orientations: the medoid (the member with the
// smallest total angular distance to the others), then a plain mean of just the
// members within `tolDeg` of it.
//
// This exists because quatMean has no breakdown point. A planar tag's PnP can
// return the mirrored solution, which is a ~40° orientation error, and a
// measured 12-27% of sightings did; averaging those in pulls the result degrees
// off, and a few degrees of tag orientation over a room-scale lever arm is tens
// of centimetres of implied camera position. The position half of the same
// computation was always a component-wise median and was measurably fine, so
// this is the orientation half catching up rather than a new idea.
//
// Measured against quatMean on a set contaminated with a tight second mode 40°
// away (which is what flips look like — they cluster, they do not scatter):
// identical at 0% contamination, 0.46° vs 9.66° at 27%, still 0.88° vs 16.2° at
// 45%. Past 50% it follows the flipped mode instead, as any robust estimator
// must: at that point the outliers are the majority and nothing local can tell.
//
// O(n^2) in the number of quaternions, which is bounded by the candidate ring.
function quatMedian(quats, tolDeg = 20) {
  if (quats.length <= 2) return quatMean(quats);
  let medoid = quats[0];
  let bestTotal = Infinity;
  for (const a of quats) {
    let total = 0;
    for (const b of quats) total += quatAngleDeg(a, b);
    if (total < bestTotal) {
      bestTotal = total;
      medoid = a;
    }
  }
  const inliers = quats.filter((q) => quatAngleDeg(q, medoid) <= tolDeg);
  // The medoid alone is already a valid answer; only average if averaging has
  // something to average.
  return inliers.length >= 2 ? quatMean(inliers) : medoid;
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

// The shortest rotation carrying unit vector `a` onto unit vector `b`. Shortest
// matters: this is used to correct an orientation that is already nearly right,
// and any other rotation with the same effect on `a` would spin the object about
// `b` as a side effect — for a marker that is its roll on the wall, which was
// measured and must survive.
function quatFromTo(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot > 0.999999) return [0, 0, 0, 1];
  const cross = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  // Exactly opposed: the rotation is a half turn and the axis is undetermined by
  // the pair, so any perpendicular will do. Cross with whichever basis vector is
  // least aligned with `a`, so the result is never near zero length.
  if (dot < -0.999999) {
    const alt = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const axis = [
      a[1] * alt[2] - a[2] * alt[1],
      a[2] * alt[0] - a[0] * alt[2],
      a[0] * alt[1] - a[1] * alt[0],
    ];
    return quatNormalize([axis[0], axis[1], axis[2], 0]);
  }
  return quatNormalize([cross[0], cross[1], cross[2], 1 + dot]);
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
    quatAngleDeg, quatMean, quatMedian, quatNudge, se3FromRvecTvec, se3Compose,
    se3Invert, se3Identity, transformPoint, quatFromTo,
    matFromRvec, rvecFromMat, matMul3, mirrorRvecGuesses,
  };
}
