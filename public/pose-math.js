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

// Do two wall-tag poses assert one plane? Tags use the markers.html convention
// (+z out of the wall into the room), so a pose's rotated z axis is its wall
// normal. Lives here because two consumers need the identical predicate: the
// survey's coplanar clip and the walls module's plane grouping — a threshold
// that drifted between them would let a tag be "on the wall" for one and not
// the other.
//
// Returns { cos, d, on }: the SIGNED normal agreement, the signed out-of-plane
// offset of `a` from `b`'s plane measured along `b`'s normal, and that normal
// `on` itself so the caller can move a point onto the plane without
// recomputing it. cos is signed because the sign is information: negative
// means the tags face opposite ways — the two sides of a partition, never one
// wall. Callers that genuinely do not care (the survey clip treats a
// back-to-back pair as one plane assertion) take the absolute value
// themselves.
const CLIP_PLANE_M = 0.05;
const CLIP_PARALLEL_COS = Math.cos(10 * Math.PI / 180);
function tagPlaneAgreement(a, b) {
  const n = quatRotate(a.q, [0, 0, 1]);
  const on = quatRotate(b.q, [0, 0, 1]);
  const cos = n[0] * on[0] + n[1] * on[1] + n[2] * on[2];
  const d = (a.p[0] - b.p[0]) * on[0]
    + (a.p[1] - b.p[1]) * on[1]
    + (a.p[2] - b.p[2]) * on[2];
  return { cos, d, on };
}

function transformPoint(t, v) {
  const r = quatRotate(t.q, v);
  return [r[0] + t.p[0], r[1] + t.p[1], r[2] + t.p[2]];
}

// Camera pose from 3D-2D correspondences: Levenberg-damped Gauss-Newton over
// six parameters, minimising reprojection error in pixels. This exists because
// the server has no OpenCV and needs to solve PnP against the corners of
// *several* tags at once — a single planar tag has a two-fold pose ambiguity,
// but tags on different walls jointly do not, so one solve over all of them
// removes the degree of freedom instead of averaging over it.
//
// `objPts` are [x,y,z] points in the target frame (the room), `imgPts` the
// matching [u,v] pixels, `K` a camera model ({fx,fy,cx,cy,dist}), `seed` the
// {p,q} camera pose to start from. Returns { p, q, rms } — rms is the mean
// per-point reprojection distance in px — or null when the seed is unusable
// (a point behind the camera; that basin has no answer in it). Convergence is
// local by design: the caller escapes the wrong basin by seeding from every
// candidate pose it has, not by trusting one seed.
//
// Plain unweighted least squares: reprojection residuals are already in the
// units the corner noise lives in. Deliberately not fuseCameraPose's
// inverse-variance weights — those weight a tag's implied camera *position*,
// a different quantity.
function solvePose(objPts, imgPts, K, seed, { maxIter = 60 } = {}) {
  const n = objPts.length;
  if (n < 3 || imgPts.length !== n) return null;
  const kd = K.dist || [0, 0, 0, 0, 0];
  const hasDist = kd.some((v) => v);

  // Residuals of the pose (pp, qq): project each object point through the
  // inverse camera pose and the camera model, subtract the measured pixel.
  function residuals(pp, qq) {
    const r = new Float64Array(2 * n);
    const qi = quatConj(qq);
    for (let i = 0; i < n; i++) {
      const X = objPts[i];
      const c = quatRotate(qi, [X[0] - pp[0], X[1] - pp[1], X[2] - pp[2]]);
      if (!(c[2] > 1e-6)) return null;
      let x = c[0] / c[2];
      let y = c[1] / c[2];
      if (hasDist) {
        // Brown-Conrady forward model, same convention the corners were
        // measured under (the client detects on the distorted image).
        const [k1, k2, p1, p2, k3] = kd;
        const r2 = x * x + y * y;
        const rad = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
        const xd = x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
        const yd = y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
        x = xd;
        y = yd;
      }
      r[2 * i] = K.fx * x + K.cx - imgPts[i][0];
      r[2 * i + 1] = K.fy * y + K.cy - imgPts[i][1];
    }
    return r;
  }

  function costOf(r) {
    let s = 0;
    for (const v of r) s += v * v;
    return s;
  }

  // Gaussian elimination with partial pivoting, sized for the 6x6 normal
  // equations. Destroys its copies, returns null on a singular system.
  function solveLin(A, b) {
    const m = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < m; c++) {
      let piv = c;
      for (let r = c + 1; r < m; r++) {
        if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      }
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < m; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[m] / row[i]);
  }

  let p = [...seed.p];
  let q = quatNormalize([...seed.q]);
  let r0 = residuals(p, q);
  if (!r0) return null;
  let cost = costOf(r0);
  let lambda = 1e-3;
  // Finite-difference steps for the numeric Jacobian: a tenth of a millimetre
  // and ~0.006 deg — far below the solution's own noise, far above fp error.
  const EPS = 1e-4;

  for (let iter = 0; iter < maxIter; iter++) {
    // Jacobian of the residual against a local 6-dof perturbation: three of
    // translation, three of a rotation vector pre-multiplied onto q.
    const J = [];
    let dead = false;
    for (let k = 0; k < 6; k++) {
      let pp = p;
      let qq = q;
      if (k < 3) {
        pp = [...p];
        pp[k] += EPS;
      } else {
        const dr = [0, 0, 0];
        dr[k - 3] = EPS;
        qq = quatNormalize(quatMul(quatFromRvec(dr), q));
      }
      const rk = residuals(pp, qq);
      if (!rk) {
        dead = true;
        break;
      }
      const col = new Float64Array(2 * n);
      for (let i = 0; i < 2 * n; i++) col[i] = (rk[i] - r0[i]) / EPS;
      J.push(col);
    }
    if (dead) break;

    const A = [];
    const g = [];
    for (let a = 0; a < 6; a++) {
      A.push(new Array(6).fill(0));
      let s = 0;
      for (let i = 0; i < 2 * n; i++) s += J[a][i] * r0[i];
      g.push(s);
    }
    for (let a = 0; a < 6; a++) {
      for (let b = a; b < 6; b++) {
        let s = 0;
        for (let i = 0; i < 2 * n; i++) s += J[a][i] * J[b][i];
        A[a][b] = s;
        A[b][a] = s;
      }
    }

    // Marquardt damping on the diagonal (scale-free across the mixed
    // metre/radian units), raised until a step actually reduces the cost. The
    // ceiling has to be generous: a seed far from the answer with a tag close
    // to the camera gives a Gauss-Newton step that throws points behind the
    // camera, and only a heavily damped (near gradient-descent) step gets out
    // — measured, a cap of 8 doublings left such a seed exactly where it
    // started.
    let took = false;
    for (let t = 0; t < 24 && lambda < 1e12; t++) {
      const M = A.map((row, i) => {
        const out = [...row];
        out[i] += lambda * Math.max(row[i], 1e-9);
        return out;
      });
      const d = solveLin(M, g);
      if (!d) {
        lambda *= 4;
        continue;
      }
      const np = [p[0] - d[0], p[1] - d[1], p[2] - d[2]];
      const nq = quatNormalize(quatMul(quatFromRvec([-d[3], -d[4], -d[5]]), q));
      const nr = residuals(np, nq);
      const nc = nr ? costOf(nr) : Infinity;
      if (nc < cost) {
        const rel = (cost - nc) / (cost || 1);
        p = np;
        q = nq;
        r0 = nr;
        cost = nc;
        lambda = Math.max(lambda * 0.5, 1e-9);
        took = true;
        // Converged: the accepted step stopped buying anything.
        if (rel < 1e-9 || Math.hypot(d[0], d[1], d[2], d[3], d[4], d[5]) < 1e-8) {
          iter = maxIter;
        }
        break;
      }
      lambda *= 4;
    }
    if (!took) break;   // damping maxed out with no downhill step left
  }
  return { p, q, rms: Math.sqrt(cost / n) };
}

if (typeof module !== 'undefined') {
  module.exports = {
    quatFromRvec, rvecFromQuat, quatMul, quatConj, quatNormalize, quatRotate,
    quatAngleDeg, quatMean, quatMedian, quatNudge, se3FromRvecTvec, se3Compose,
    se3Invert, se3Identity, transformPoint, quatFromTo, solvePose,
    matFromRvec, rvecFromMat, matMul3, mirrorRvecGuesses,
    tagPlaneAgreement, CLIP_PLANE_M, CLIP_PARALLEL_COS,
  };
}
