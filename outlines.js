'use strict';

// Object outlines — reading the shape instead of the box.
//
// A printed tag gives a full pose from **one** observation because it is four
// known coplanar corners at a known metric size: eight free numbers, which is
// what position and orientation together cost. A detector's bounding box carries
// four, and they are the wrong four — the box is axis-aligned in image space by
// construction, so the perspective distortion PnP solves orientation from has
// already been discarded, and its corners are not physical points at all (on a
// round clock they are four tangent points that slide around the rim as the
// camera moves).
//
// An outline restores the eight. A fitted ellipse is a conic (5 parameters) and
// a fitted quad is four free points (8), and both are attached to the *same
// physical boundary* from every viewpoint. That is the whole idea: a mapped
// object of known shape becomes something a single frame can be solved against,
// where three triangulated bearings were needed before.
//
// ## What lives here
//
// Two halves, deliberately in one file because they are one subject and the
// second is meaningless without the first:
//
// - **Fitting** — `fitOutline`, over already-decoded pixels inside the
//   detector's own box. Never on the phone: the phone's job is to hand over the
//   frame, and the removed optical-flow tracker is the measured precedent for
//   what happens when it does more (178-206 ms/frame, 6.38 detections a second
//   down to 2.6).
// - **Geometry** — what an outline means in metres: `circlePoseFromConic` for a
//   circle of known radius, `quadPlaneFromCorners` for a rectangle's plane, and
//   the mirror partner every planar solve carries.
//
// ## The search window is the detector's box
//
// That is the whole reason this is cheap. The expensive part of finding a shape
// in an image is knowing where to look, and the detector has already answered
// it. Everything below runs over a padded crop of one box.
//
// ## Nothing here decides anything
//
// A failed fit is a detection with no outline, never a bad outline. Every gate
// below refuses rather than degrades, for the same reason `objects.js` refuses a
// position with no parallax behind it: a shape measured wrong is worse than no
// shape, because everything downstream would treat it as the ruler.

// --- constants ---
//
// Named in the plan and load-bearing for the reasons given beside each. The
// numbers are starting points that `replay-objects.js --outlines` is meant to
// replace; what is *not* negotiable is that each one exists.
const DEFAULTS = {
  // Smallest box side worth fitting at all. At 3 m in a 287x640 frame a 0.62 m
  // clock is about 91 px and a 0.086 m switch plate is about 13 — so this is
  // what decides which classes are even eligible, and it decides it on the
  // apparent size rather than on the class.
  outlineMinPx: 24,
  // How far outside the box to look. The detector's box is tight against the
  // silhouette and a boundary pixel is *on* the edge of it, so a crop taken at
  // the box exactly puts the thing being measured on the frame border where the
  // gradient operator has no support.
  outlinePadFrac: 0.12,
  // Fit residual in pixels, above which the outline is refused. The direct
  // analogue of the 1 px rms gate the joint-PnP work already uses (recorded as
  // load-bearing and not to be re-tuned) — and deliberately looser than it,
  // because that gate was measured on tag corners decoded from a native-
  // resolution frame and this runs on a 287x640 JPEG at quality 0.8.
  outlineFitRms: 1.6,
  // The fitted outline must fill a sane fraction of the detector's own box, on
  // both axes. A small ellipse inside a big box is an edge chain on the object's
  // texture — a clock's inner bezel, a picture's mount — and not its boundary.
  outlineCoverFrac: 0.55,
  // And must not spill far outside it. A "shape" much larger than the box is
  // furniture behind the object, found because the padding reached it.
  outlineCoverMax: 1.25,

  // **The degeneracy.** A circle viewed head-on projects to a near-circle, and
  // the plane normal recovered from a near-circular ellipse swings wildly on
  // small fit errors — the two mirror solutions converge on each other, so the
  // pair carries no information about which way the plane faces. Below this the
  // normal is *not* recovered and the fit is position-only.
  //
  // Recorded on every outline rather than applied here: the fit is perfectly
  // good, it is the *orientation* read off it that is not, and refusing the fit
  // would also throw away the radius, which is fine head-on.
  ellipseMinEccentricity: 0.25,
  // The same conditioning problem for a quad, stated as the angle between
  // opposite sides. A near-parallelogram projection carries almost no
  // orientation signal: the vanishing point runs off to infinity and a small
  // error in a side's direction swings the recovered normal by roughly
  // `f * epsilon / L` radians — at f=1326 px, a 91 px side and half a degree of
  // side-angle error, that is 8 degrees of normal. 3 degrees of convergence over
  // a 91 px side is about 4.8 px of taper, which is above the noise this fitter
  // works at and below anything a person would call obviously skewed.
  quadMinSkewDeg: 3,

  // --- the edge set ---
  // Gradient magnitude quantile inside the crop, above which a pixel is an edge
  // candidate. A quantile rather than an absolute threshold because exposure is
  // not controlled: the same clock against a bright window and a dim wall gives
  // magnitudes an order of magnitude apart, and a fixed bar would find every
  // edge in one and none in the other.
  edgeQuantile: 0.85,
  // Below this there is nothing to fit and the answer is no outline, not a
  // desperate one. Five points determine a conic exactly, so anything near that
  // is a fit with no evidence left over to check itself with.
  edgeMinPts: 40,
  // Cost ceiling. Deterministic stride, never a random sample — a replay that
  // cannot reproduce its own answer is useless for comparing two runs, which is
  // the same reason `robustSeed` in objects.js strides its pairs.
  edgeMaxPts: 2400,

  // --- consensus ---
  // Least squares cannot pick its own inliers: one bad edge chain drags a conic
  // right off the boundary, and the refit then rejects the good points. Measured
  // by objects.js on the same failure with rays (one wrong ray pulled a position
  // 1.87 m off, after which the outlier gate kept the wrong one). So consensus
  // first, least squares only to refine.
  ransacIters: 240,
  ransacTolPx: 1.6,
  // A minimal sample drawn from one small stretch of a boundary fits it
  // perfectly and says nothing, so a sample has to span the box before it is
  // worth scoring at all.
  ransacMinSpreadFrac: 0.45,
};

// Class names are compared on a normalized key, never as written: two
// vocabularies are in play and they spell the same thing differently — COCO's
// `pottedplant` against Objects365's `Potted Plant`, `tvmonitor` against
// `Monitor/TV`. Lives here rather than in `objects.js` because both that module
// and the offline detector need it and only one of them may own it.
function normClass(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Which fit a class gets, and the fit has to agree — a class with no known
// shape gets neither, and nothing is ever forced.
//
// **This one table is not per vocabulary**, and that is a deliberate departure
// from the allow-list beside it. An allow-list written across both vocabularies
// would claim classes the running model cannot produce, and the map would then
// read "this room has no cabinets" when what happened is "this model has no
// cabinet". A shape table cannot make that mistake: it is only ever consulted
// with a class the detector has *just produced*, so an entry no model can emit
// is inert rather than misleading. Both spellings collapse to one key anyway.
//
// `door` and `windowpane` are here and no fixed vocabulary can name them —
// `object-detector.js` also drives an open-vocabulary head, which can.
const SHAPE_BY_CLASS = new Map(Object.entries({
  // Round, and the reason this idea started: a clock is a circle of known
  // radius on a wall, which is a tag that was already in the room.
  clock: 'ellipse',
  wallclock: 'ellipse',

  // Flat and rectangular — a face that dominates the silhouette from every
  // angle it is seen at. `Cabinet/shelf` is the marginal one and is kept: its
  // front is a rectangle even when its contents are not, and it is one of the
  // most immovable things in any room.
  pictureframe: 'quad',
  monitortv: 'quad',
  tvmonitor: 'quad',
  tv: 'quad',
  cabinetshelf: 'quad',
  refrigerator: 'quad',
  microwave: 'quad',
  oven: 'quad',
  dishwasher: 'quad',
  washingmachinedryingmachine: 'quad',
  door: 'quad',
  windowpane: 'quad',
  window: 'quad',
}));

function shapeFor(cls) {
  return SHAPE_BY_CLASS.get(normClass(cls)) || null;
}

// --- small linear algebra ---

function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function norm3(a) { return Math.hypot(a[0], a[1], a[2]); }
function unit3(a) { const n = norm3(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }
function scale3(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }

// Reflect `v` about the line through the origin along `axis`.
//
// `2nn^T - I`, which is already a proper rotation — the *same* construction
// `mirrorRvecGuesses` in `pose-math.js` uses to build a planar tag's mirror
// partner, and for the same reason: the ambiguity of a planar solve is a
// reflection about the **line of sight**, not about the plane perpendicular to
// it. Reflecting in the perpendicular plane turns the surface to face away from
// the camera and lands ~180 degrees off, which is recorded there as the bug the
// first attempt made.
function mirrorAboutAxis(v, axis) {
  const a = unit3(axis);
  const k = 2 * dot3(v, a);
  return [k * a[0] - v[0], k * a[1] - v[1], k * a[2] - v[2]];
}

// Eigenvalues *and* eigenvectors of a symmetric 3x3, smallest eigenvalue first,
// the matrix given row-major as 9 numbers.
//
// Closed form (Smith's trigonometric method) rather than an iteration, because
// this runs per detection and the matrix is tiny. The vectors come from the
// nullspace of (A - lambda I), taken as the largest cross product of two of its
// rows; a repeated eigenvalue leaves that nullspace two-dimensional, so the
// degenerate pair is completed by orthogonalizing against the vector that *is*
// well determined rather than by trusting a cross product of near-parallel rows.
//
// The degenerate case is not hypothetical here: it is a circle viewed exactly
// head-on, which is the very configuration `ellipseMinEccentricity` exists for.
function symEig3(A) {
  const p1 = A[1] * A[1] + A[2] * A[2] + A[5] * A[5];
  const tr = A[0] + A[4] + A[8];
  let values;
  if (p1 === 0) {
    values = [A[0], A[4], A[8]].sort((a, b) => a - b);
  } else {
    const q = tr / 3;
    const p2 = (A[0] - q) ** 2 + (A[4] - q) ** 2 + (A[8] - q) ** 2 + 2 * p1;
    const p = Math.sqrt(p2 / 6);
    const B = A.map((v, i) => (v - (i % 4 === 0 ? q : 0)) / p);
    const detB = B[0] * (B[4] * B[8] - B[5] * B[7])
      - B[1] * (B[3] * B[8] - B[5] * B[6])
      + B[2] * (B[3] * B[7] - B[4] * B[6]);
    const r = Math.max(-1, Math.min(1, detB / 2));
    const phi = Math.acos(r) / 3;
    const e1 = q + 2 * p * Math.cos(phi);
    const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI / 3));
    values = [e3, 3 * q - e1 - e3, e1];
  }
  const vectors = values.map((lam) => nullVector3(A, lam));
  // Which eigenvalue is furthest from the other two is the one whose vector can
  // be trusted when two of them coincide; the remaining pair is then any
  // orthonormal basis of the plane perpendicular to it.
  const gaps = [
    Math.min(Math.abs(values[0] - values[1]), Math.abs(values[0] - values[2])),
    Math.min(Math.abs(values[1] - values[0]), Math.abs(values[1] - values[2])),
    Math.min(Math.abs(values[2] - values[0]), Math.abs(values[2] - values[1])),
  ];
  const span = Math.max(1e-12, Math.abs(values[2] - values[0]));
  const lone = gaps.indexOf(Math.max(...gaps));
  for (let i = 0; i < 3; i++) {
    if (i === lone) continue;
    if (gaps[i] / span > 1e-4) continue;
    // Degenerate with its partner: rebuild the pair from the lone vector.
    const seed = Math.abs(vectors[lone][0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const a = unit3(cross3(vectors[lone], seed));
    const b = unit3(cross3(vectors[lone], a));
    const other = [0, 1, 2].find((k) => k !== lone && k !== i);
    vectors[i] = a;
    vectors[other] = b;
    break;
  }
  return { values, vectors };
}

// A unit vector in the nullspace of (A - lambda I), by the largest cross product
// of two of its rows.
function nullVector3(A, lam) {
  const M = [
    [A[0] - lam, A[1], A[2]],
    [A[3], A[4] - lam, A[5]],
    [A[6], A[7], A[8] - lam],
  ];
  let best = null;
  let bestN = 0;
  for (const [i, j] of [[0, 1], [1, 2], [0, 2]]) {
    const c = cross3(M[i], M[j]);
    const n = norm3(c);
    if (n > bestN) { bestN = n; best = c; }
  }
  if (!best || bestN < 1e-12) return [0, 0, 1];
  return scale3(best, 1 / bestN);
}

// Dense linear solve, partial pivoting, `A` row-major n x n. Returns null on a
// singular system rather than NaNs — a degenerate minimal sample is the normal
// case inside a consensus loop and must cost a retry, not a poisoned fit.
function solveN(A, b, n) {
  const M = A.slice();
  const x = b.slice();
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[piv * n + c])) piv = r;
    if (Math.abs(M[piv * n + c]) < 1e-12) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) {
        const t = M[c * n + k]; M[c * n + k] = M[piv * n + k]; M[piv * n + k] = t;
      }
      const t = x[c]; x[c] = x[piv]; x[piv] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

// A deterministic sampler. Not `Math.random`: the same corpus has to produce the
// same outlines on every run or a replay cannot be used to compare two
// versions of this file, which is the only way anything here gets judged.
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// --- the edge set ---

// Edge candidates inside a crop of an already-decoded RGBA image.
//
// Sobel magnitude, thresholded at a quantile of the crop's own distribution and
// thinned by non-maximum suppression along the gradient direction. The thinning
// is not cosmetic: without it a strong boundary is three or four pixels wide and
// a least-squares conic fits the middle of that band differently depending on
// which side has more of it, which is a bias and not noise.
//
// Points come back in **frame pixels**, not crop pixels, so nothing downstream
// has to remember the offset.
function edgePoints(img, x0, y0, x1, y1, opts = {}) {
  const O = { ...DEFAULTS, ...opts };
  const W = img.width;
  const H = img.height;
  const cx0 = Math.max(1, Math.floor(x0));
  const cy0 = Math.max(1, Math.floor(y0));
  const cx1 = Math.min(W - 1, Math.ceil(x1));
  const cy1 = Math.min(H - 1, Math.ceil(y1));
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;
  if (cw < 3 || ch < 3) return [];

  // Luma over the crop plus a one-pixel apron, so the Sobel window has support
  // at the crop's own edge instead of folding the border in.
  const lw = cw + 2;
  const lh = ch + 2;
  const lum = new Float32Array(lw * lh);
  for (let y = 0; y < lh; y++) {
    const sy = Math.min(H - 1, Math.max(0, cy0 - 1 + y));
    for (let x = 0; x < lw; x++) {
      const sx = Math.min(W - 1, Math.max(0, cx0 - 1 + x));
      const o = (sy * W + sx) * 4;
      // Rec. 601 luma. The detector sees RGB and this sees one channel of it;
      // the only thing that matters is that a boundary in colour is a boundary
      // here too, which a green-weighted mix gets and a plain average does not.
      lum[y * lw + x] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
    }
  }

  const gx = new Float32Array(cw * ch);
  const gy = new Float32Array(cw * ch);
  const mag = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const p = (y + 1) * lw + (x + 1);
      const a = lum[p - lw - 1]; const b = lum[p - lw]; const c = lum[p - lw + 1];
      const d = lum[p - 1]; const f = lum[p + 1];
      const g = lum[p + lw - 1]; const h = lum[p + lw]; const i = lum[p + lw + 1];
      const sx = (c + 2 * f + i) - (a + 2 * d + g);
      const sy = (g + 2 * h + i) - (a + 2 * b + c);
      const k = y * cw + x;
      gx[k] = sx;
      gy[k] = sy;
      mag[k] = Math.hypot(sx, sy);
    }
  }

  // The threshold is a quantile of this crop's own magnitudes. Taken from a
  // strided sample rather than a full sort: the answer is a threshold, and a
  // threshold does not need every pixel to agree on it.
  const sample = [];
  const stride = Math.max(1, Math.floor((cw * ch) / 4000));
  for (let k = 0; k < mag.length; k += stride) sample.push(mag[k]);
  sample.sort((a, b) => a - b);
  const thr = sample[Math.min(sample.length - 1,
    Math.floor(sample.length * O.edgeQuantile))] || 0;

  const pts = [];
  for (let y = 1; y < ch - 1; y++) {
    for (let x = 1; x < cw - 1; x++) {
      const k = y * cw + x;
      const m = mag[k];
      if (m <= thr || m <= 0) continue;
      // Non-maximum suppression along the gradient, quantised to the four
      // directions a pixel grid actually has.
      const ax = Math.abs(gx[k]);
      const ay = Math.abs(gy[k]);
      let d1;
      let d2;
      if (ax > 2.414 * ay) { d1 = k - 1; d2 = k + 1; }
      else if (ay > 2.414 * ax) { d1 = k - cw; d2 = k + cw; }
      else if ((gx[k] > 0) === (gy[k] > 0)) { d1 = k - cw - 1; d2 = k + cw + 1; }
      else { d1 = k - cw + 1; d2 = k + cw - 1; }
      if (mag[d1] > m || mag[d2] > m) continue;
      pts.push({ x: cx0 + x + 0.5, y: cy0 + y + 0.5, gx: gx[k], gy: gy[k], m });
    }
  }
  if (pts.length <= O.edgeMaxPts) return pts;
  // Thinned by a stride over the list, not by keeping the strongest: the
  // strongest points of a picture frame are all on the one side that happens to
  // be against a bright wall, and a fit taken from them is a fit to one edge.
  const keep = [];
  const step = pts.length / O.edgeMaxPts;
  for (let i = 0; i < O.edgeMaxPts; i++) keep.push(pts[Math.floor(i * step)]);
  return keep;
}

// --- conics ---

// Fit an ellipse to points, by the ellipse-specific constraint (Fitzgibbon's
// direct least squares, in Halir and Flusser's decomposition — which reduces the
// 6x6 generalized eigenproblem to a 3x3 one).
//
// **Ellipse-specific matters here.** The plain algebraic fit will happily return
// a hyperbola for a noisy arc, and a consensus loop that has to throw those away
// wastes most of its samples on the very configurations that need them: a
// boundary seen obliquely, which is the case the whole feature is for.
//
// Points are normalized (centred, scaled) before the fit and the *geometry* is
// denormalized afterwards rather than the conic — an isotropic scale and a
// translation move the centre and the axes and leave the angle alone, so there
// is nothing to get wrong.
function fitEllipse(pts) {
  const n = pts.length;
  if (n < 5) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n;
  my /= n;
  let s = 0;
  for (const p of pts) s += Math.hypot(p.x - mx, p.y - my);
  s = (s / n) || 1;
  const inv = 1 / s;

  // S1 = D1'D1, S2 = D1'D2, S3 = D2'D2 with D1 = [x^2, xy, y^2], D2 = [x, y, 1].
  const S1 = new Float64Array(9);
  const S2 = new Float64Array(9);
  const S3 = new Float64Array(9);
  for (const p of pts) {
    const x = (p.x - mx) * inv;
    const y = (p.y - my) * inv;
    const d1 = [x * x, x * y, y * y];
    const d2 = [x, y, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        S1[i * 3 + j] += d1[i] * d1[j];
        S2[i * 3 + j] += d1[i] * d2[j];
        S3[i * 3 + j] += d2[i] * d2[j];
      }
    }
  }
  // T = -S3^-1 S2', column by column. Column c of S2' is *row* c of S2.
  const T = new Float64Array(9);
  for (let c = 0; c < 3; c++) {
    const rhs = [-S2[c * 3], -S2[c * 3 + 1], -S2[c * 3 + 2]];
    const col = solveN(Array.from(S3), rhs, 3);
    if (!col) return null;
    T[c] = col[0];
    T[3 + c] = col[1];
    T[6 + c] = col[2];
  }
  // M = S1 + S2 T, premultiplied by C1^-1 = [[0,0,1/2],[0,-1,0],[1/2,0,0]].
  const M = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let v = S1[i * 3 + j];
      for (let k = 0; k < 3; k++) v += S2[i * 3 + k] * T[k * 3 + j];
      M[i * 3 + j] = v;
    }
  }
  const Mp = [
    M[6] / 2, M[7] / 2, M[8] / 2,
    -M[3], -M[4], -M[5],
    M[0] / 2, M[1] / 2, M[2] / 2,
  ];
  // The eigenvector of Mp satisfying 4ac - b^2 > 0 is the ellipse.
  const a1 = ellipseEigen(Mp);
  if (!a1) return null;
  const a2 = [
    T[0] * a1[0] + T[1] * a1[1] + T[2] * a1[2],
    T[3] * a1[0] + T[4] * a1[1] + T[5] * a1[2],
    T[6] * a1[0] + T[7] * a1[1] + T[8] * a1[2],
  ];
  const geo = conicToEllipse([a1[0], a1[1], a1[2], a2[0], a2[1], a2[2]]);
  if (!geo) return null;
  return {
    cx: geo.cx * s + mx,
    cy: geo.cy * s + my,
    rx: geo.rx * s,
    ry: geo.ry * s,
    theta: geo.theta,
  };
}

// The eigenvector of a general 3x3 whose conic is an ellipse. Real eigenvalues
// come from the characteristic cubic (trigonometric form, which is the stable
// one when all three roots are real); each candidate's nullspace is then tested
// against the ellipse constraint.
function ellipseEigen(M) {
  const tr = M[0] + M[4] + M[8];
  const m2 = (M[0] * M[4] - M[1] * M[3])
    + (M[0] * M[8] - M[2] * M[6])
    + (M[4] * M[8] - M[5] * M[7]);
  const det = M[0] * (M[4] * M[8] - M[5] * M[7])
    - M[1] * (M[3] * M[8] - M[5] * M[6])
    + M[2] * (M[3] * M[7] - M[4] * M[6]);
  // lambda^3 - tr lambda^2 + m2 lambda - det = 0, shifted to the depressed form
  // t^3 + p t + q with lambda = t + tr/3.
  const p = m2 - (tr * tr) / 3;
  const q = (-2 * tr * tr * tr) / 27 + (tr * m2) / 3 - det;
  const roots = [];
  const r = p < 0 ? 2 * Math.sqrt(-p / 3) : 0;
  const arg = r > 1e-14 ? (3 * q) / (p * r) : NaN;
  // The trigonometric branch whenever all three roots are real, tested on its
  // own argument rather than on the discriminant. The discriminant of a
  // *repeated* root is zero and comes out of floating point either side of it —
  // and a repeated root is not the exotic case here, it is what exact points on
  // an ellipse produce. Taking Cardano's single-real-root branch there returns a
  // number that is not a root at all, and the fit then silently finds no
  // ellipse.
  if (Number.isFinite(arg) && Math.abs(arg) <= 1 + 1e-6) {
    const phi = Math.acos(Math.max(-1, Math.min(1, arg))) / 3;
    for (let k = 0; k < 3; k++) {
      roots.push(tr / 3 + r * Math.cos(phi - (2 * Math.PI * k) / 3));
    }
  } else if (Math.abs(p) < 1e-14) {
    roots.push(tr / 3 + Math.cbrt(-q));
  } else {
    const disc = (q * q) / 4 + (p * p * p) / 27;
    const sq = Math.sqrt(Math.max(0, disc));
    roots.push(tr / 3 + Math.cbrt(-q / 2 + sq) + Math.cbrt(-q / 2 - sq));
  }
  for (const lam of roots) {
    if (!Number.isFinite(lam)) continue;
    const v = nullVector3(M, lam);
    if (4 * v[0] * v[2] - v[1] * v[1] > 0) return v;
  }
  return null;
}

// Conic (A,B,C,D,E,F) for Ax^2+Bxy+Cy^2+Dx+Ey+F to centre, semi-axes and the
// major axis's angle. Null when it is not a real ellipse.
function conicToEllipse(k) {
  const [A, B, C, D, E, F] = k;
  const den = B * B - 4 * A * C;
  if (!(den < 0)) return null;                 // not an ellipse
  const cx = (2 * C * D - B * E) / den;
  const cy = (2 * A * E - B * D) / den;
  const num = 2 * (A * E * E + C * D * D + F * B * B - B * D * E - 4 * A * C * F);
  const rootTerm = Math.sqrt((A - C) * (A - C) + B * B);
  const ra = -Math.sqrt(Math.max(0, num * ((A + C) + rootTerm))) / den;
  const rb = -Math.sqrt(Math.max(0, num * ((A + C) - rootTerm))) / den;
  if (!(ra > 0) || !(rb > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  // `0.5 * atan2(B, A - C)` is the direction of the quadratic form's *larger*
  // eigenvalue, and a larger eigenvalue is a **shorter** axis — so it points
  // along the minor one and the major axis is a right angle away. Got wrong
  // first time and caught by the round trip, which is the only reason to have
  // one: the centre and both axes came back exact while every recovered plane
  // normal was tens of degrees out.
  const theta = 0.5 * Math.atan2(B, A - C) + Math.PI / 2;
  // `ra` takes the +root and is therefore never shorter than `rb`.
  return { cx, cy, rx: ra, ry: rb, theta };
}

// The conic of an ellipse, as (A,B,C,D,E,F). The inverse of `conicToEllipse`,
// and what the pose recovery below actually consumes — a centre and two axes is
// how a person reads an ellipse, a conic is how the geometry does.
function ellipseToConic(e) {
  const c = Math.cos(e.theta);
  const s = Math.sin(e.theta);
  const a2 = e.rx * e.rx;
  const b2 = e.ry * e.ry;
  const A = (c * c) / a2 + (s * s) / b2;
  const B = 2 * c * s * (1 / a2 - 1 / b2);
  const C = (s * s) / a2 + (c * c) / b2;
  // Translate: substitute (x - cx), (y - cy).
  const D = -(2 * A * e.cx + B * e.cy);
  const E = -(B * e.cx + 2 * C * e.cy);
  const F = A * e.cx * e.cx + B * e.cx * e.cy + C * e.cy * e.cy - 1;
  return [A, B, C, D, E, F];
}

// First-order geometric distance from a point to a conic (Sampson). The
// algebraic residual alone is not a distance at all — it scales with the conic's
// own arbitrary normalization and with where on the ellipse the point is — and
// a tolerance in pixels is the only kind that can be stated or compared.
function conicDist(k, x, y) {
  const [A, B, C, D, E, F] = k;
  const q = A * x * x + B * x * y + C * y * y + D * x + E * y + F;
  const gx = 2 * A * x + B * y + D;
  const gy = B * x + 2 * C * y + E;
  const g = Math.hypot(gx, gy);
  return g < 1e-12 ? Infinity : Math.abs(q) / g;
}

// --- lines ---

// Total-least-squares line through points, as a unit normal and offset:
// n . p = c, with |n| = 1. Not a y = mx + b fit — a vertical picture-frame edge
// is exactly the case that has no slope.
function fitLine(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // Smaller eigenvector of the 2x2 scatter is the normal.
  const t = (sxx + syy) / 2;
  const d = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy));
  const lam = t - d;
  let nx = sxy;
  let ny = lam - sxx;
  if (Math.hypot(nx, ny) < 1e-9) { nx = lam - syy; ny = sxy; }
  const ln = Math.hypot(nx, ny);
  if (ln < 1e-9) return null;
  nx /= ln;
  ny /= ln;
  return { nx, ny, c: nx * mx + ny * my };
}

function lineDist(l, x, y) { return Math.abs(l.nx * x + l.ny * y - l.c); }

function lineIntersect(a, b) {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;      // parallel: no corner
  return [
    (a.c * b.ny - a.ny * b.c) / det,
    (a.nx * b.c - a.c * b.nx) / det,
  ];
}

// --- the fits ---

// A quadrilateral from four dominant edges near the box's own sides.
//
// The search is per side and the gradient direction is part of it: a left or
// right edge is a vertical line, whose gradient is horizontal, and admitting the
// other kind is how a shelf running behind a picture becomes its top edge. Each
// side gets its own consensus line, and the corners are the four pairwise
// intersections — never the box's corners, which is the whole point.
function fitQuadIn(pts, box, opts) {
  const O = { ...DEFAULTS, ...opts };
  const bw = box[2] - box[0];
  const bh = box[3] - box[1];
  const bandW = bw * 0.35;
  const bandH = bh * 0.35;
  const rand = lcg(pts.length * 2654435761);

  // left, right (vertical edges), top, bottom (horizontal edges)
  const sides = [
    { key: 'left', vertical: true, near: (p) => p.x - box[0] < bandW },
    { key: 'right', vertical: true, near: (p) => box[2] - p.x < bandW },
    { key: 'top', vertical: false, near: (p) => p.y - box[1] < bandH },
    { key: 'bottom', vertical: false, near: (p) => box[3] - p.y < bandH },
  ];
  const lines = {};
  let inlierTotal = 0;
  let residSum = 0;
  for (const s of sides) {
    const band = pts.filter((p) => s.near(p)
      && (s.vertical ? Math.abs(p.gx) > Math.abs(p.gy) : Math.abs(p.gy) > Math.abs(p.gx)));
    const span = s.vertical ? bh : bw;
    const minInliers = Math.max(8, Math.round(span * 0.2));
    if (band.length < minInliers) return null;
    let best = null;
    let bestN = 0;
    for (let it = 0; it < O.ransacIters; it++) {
      const a = band[Math.floor(rand() * band.length)];
      const b = band[Math.floor(rand() * band.length)];
      if (a === b) continue;
      // A sample from one short stretch fits it perfectly and says nothing
      // about the side; the pair has to reach along the edge to be worth
      // scoring.
      const sep = s.vertical ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x);
      if (sep < span * O.ransacMinSpreadFrac) continue;
      const l = fitLine([a, b]);
      if (!l) continue;
      // The line has to actually run along this side. Without this a strong
      // diagonal inside the band (a cable, a shadow) wins on inlier count and
      // takes the corner with it.
      if (s.vertical ? Math.abs(l.ny) > 0.6 : Math.abs(l.nx) > 0.6) continue;
      let cnt = 0;
      for (const p of band) if (lineDist(l, p.x, p.y) <= O.ransacTolPx) cnt++;
      if (cnt > bestN) { bestN = cnt; best = l; }
    }
    if (!best || bestN < minInliers) return null;
    const inl = band.filter((p) => lineDist(best, p.x, p.y) <= O.ransacTolPx);
    const ref = fitLine(inl) || best;
    let sum = 0;
    for (const p of inl) sum += lineDist(ref, p.x, p.y) ** 2;
    inlierTotal += inl.length;
    residSum += sum;
    lines[s.key] = ref;
  }

  const tl = lineIntersect(lines.left, lines.top);
  const tr = lineIntersect(lines.right, lines.top);
  const br = lineIntersect(lines.right, lines.bottom);
  const bl = lineIntersect(lines.left, lines.bottom);
  if (!tl || !tr || !br || !bl) return null;
  const corners = [tl, tr, br, bl];
  if (!convexQuad(corners)) return null;
  return {
    corners,
    rms: Math.sqrt(residSum / Math.max(1, inlierTotal)),
    n: inlierTotal,
  };
}

// Convex and wound the way it was built (top-left first, clockwise in image
// coordinates). A fit whose corners cross over is a bow tie, which happens when
// two opposite sides converge inside the box, and it is not a rectangle seen
// from anywhere.
function convexQuad(c) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    const d = c[(i + 2) % 4];
    const z = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (Math.abs(z) < 1e-9) return false;
    const s = z > 0 ? 1 : -1;
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// How far the quad is from a parallelogram, in degrees: the angle between each
// pair of opposite sides, taken as the larger of the two.
//
// This *is* the orientation signal. A parallelogram is what a rectangle projects
// to when its plane is parallel to the image plane, and it is also what one
// projects to when the camera is far away — in both cases the perspective that
// would say which way the plane faces has gone. See `quadMinSkewDeg`.
function quadSkewDeg(c) {
  const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const diff = (u, v) => {
    let d = Math.abs(u - v) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d;
  };
  const top = ang(c[0], c[1]);
  const bottom = ang(c[3], c[2]);
  const left = ang(c[0], c[3]);
  const right = ang(c[1], c[2]);
  return (Math.max(diff(top, bottom), diff(left, right)) * 180) / Math.PI;
}

// One detection's outline, or null.
//
// `img` is a decoded RGBA image (`{width, height, data}`) — the same object the
// detector accepts, so a caller that has already paid for the decode pays once.
// `det.box` is in that image's own pixels.
function fitOutline(img, det, opts = {}) {
  const O = { ...DEFAULTS, ...opts };
  const kind = shapeFor(det.cls);
  if (!kind) return null;
  // **A clipped box is not a boundary, it is a window.** `objects.js` already
  // refuses a horizontally clipped detection because its centre is not the
  // object's centre; an outline needs more than that — it needs the *whole*
  // silhouette, on every edge, because a shape is fitted to all of it at once
  // and a missing side is not a missing constraint but a wrong one.
  //
  // Measured on the first walk, before this test existed: a clock running off
  // the top-left corner fitted cleanly to the ring of numerals *inside* it and
  // passed every gate, because the cover fraction is judged against a box that
  // had been truncated to the same window. It is the exact failure
  // `outlineCoverFrac` is for, arriving from the one direction that gate cannot
  // see.
  if (det.clip === undefined ? det.clipped : det.clip) return null;
  const [bx0, by0, bx1, by1] = det.box;
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (!(bw > 0) || !(bh > 0)) return null;
  if (Math.min(bw, bh) < O.outlineMinPx) return null;
  const px = bw * O.outlinePadFrac;
  const py = bh * O.outlinePadFrac;
  const pts = edgePoints(img, bx0 - px, by0 - py, bx1 + px, by1 + py, O);
  if (pts.length < O.edgeMinPts) return null;
  const out = kind === 'ellipse'
    ? fitEllipseConsensus(pts, det.box, O)
    : fitQuadIn(pts, det.box, O);
  if (!out) return null;
  return kind === 'ellipse' ? acceptEllipse(out, det.box, O) : acceptQuad(out, det.box, O);
}

// Consensus over minimal samples, then least squares on the winners. Exactly the
// order `robustSeed` in objects.js uses and for the same measured reason:
// least squares cannot pick its own inliers, and starting from the all-points
// fit is what lets one bad edge chain throw out every good point.
function fitEllipseConsensus(pts, box, O) {
  const rand = lcg(pts.length * 2246822519);
  const diag = Math.hypot(box[2] - box[0], box[3] - box[1]);
  let best = null;
  let bestN = 0;
  const sample = new Array(5);
  for (let it = 0; it < O.ransacIters; it++) {
    let spread = 0;
    for (let i = 0; i < 5; i++) sample[i] = pts[Math.floor(rand() * pts.length)];
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        spread = Math.max(spread, Math.hypot(sample[i].x - sample[j].x, sample[i].y - sample[j].y));
      }
    }
    if (spread < diag * O.ransacMinSpreadFrac) continue;
    const e = fitEllipse(sample);
    if (!e) continue;
    const k = ellipseToConic(e);
    let cnt = 0;
    for (const p of pts) if (conicDist(k, p.x, p.y) <= O.ransacTolPx) cnt++;
    if (cnt > bestN) { bestN = cnt; best = e; }
  }
  if (!best || bestN < O.edgeMinPts / 2) return null;
  let e = best;
  // Two refinement passes. The first is fitted to the consensus set, the second
  // to what that fit itself explains — the same two-pass shape `resolveEntry`
  // uses, and for the same reason: the consensus set is a tolerance band, not
  // the boundary.
  for (let pass = 0; pass < 2; pass++) {
    const k = ellipseToConic(e);
    const inl = pts.filter((p) => conicDist(k, p.x, p.y) <= O.ransacTolPx);
    if (inl.length < 5) break;
    const next = fitEllipse(inl);
    if (!next) break;
    e = next;
  }
  const k = ellipseToConic(e);
  const inl = pts.filter((p) => conicDist(k, p.x, p.y) <= O.ransacTolPx);
  if (inl.length < O.edgeMinPts / 2) return null;
  let sum = 0;
  for (const p of inl) sum += conicDist(k, p.x, p.y) ** 2;
  return { ...e, rms: Math.sqrt(sum / inl.length), n: inl.length };
}

function acceptEllipse(e, box, O) {
  const c = Math.cos(e.theta);
  const s = Math.sin(e.theta);
  // The ellipse's own axis-aligned bounding box, which is what the detector's
  // box is comparable to.
  const halfW = Math.hypot(e.rx * c, e.ry * s);
  const halfH = Math.hypot(e.rx * s, e.ry * c);
  const bw = box[2] - box[0];
  const bh = box[3] - box[1];
  const coverW = (2 * halfW) / bw;
  const coverH = (2 * halfH) / bh;
  const why = [];
  if (e.rms > O.outlineFitRms) why.push('rms');
  if (coverW < O.outlineCoverFrac || coverH < O.outlineCoverFrac) why.push('small');
  if (coverW > O.outlineCoverMax || coverH > O.outlineCoverMax) why.push('big');
  if (e.cx < box[0] || e.cx > box[2] || e.cy < box[1] || e.cy > box[3]) why.push('offcentre');
  if (why.length) return null;
  const ratio = e.ry / e.rx;                    // rx is the major axis
  return {
    kind: 'ellipse',
    cx: r2(e.cx), cy: r2(e.cy), rx: r2(e.rx), ry: r2(e.ry),
    theta: Math.round(e.theta * 1e4) / 1e4,
    rms: Math.round(e.rms * 100) / 100,
    n: e.n,
    // The conditioning number for the *normal*, not for the fit. A circle seen
    // head-on projects to a circle and the two mirror solutions collapse onto
    // each other; the elongation is how far from that this view is.
    ecc: Math.round(Math.sqrt(Math.max(0, 1 - ratio * ratio)) * 1000) / 1000,
    cover: Math.round(Math.min(coverW, coverH) * 100) / 100,
  };
}

function acceptQuad(q, box, O) {
  const bw = box[2] - box[0];
  const bh = box[3] - box[1];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of q.corners) {
    x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]);
    y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
  }
  const coverW = (x1 - x0) / bw;
  const coverH = (y1 - y0) / bh;
  if (q.rms > O.outlineFitRms) return null;
  if (coverW < O.outlineCoverFrac || coverH < O.outlineCoverFrac) return null;
  if (coverW > O.outlineCoverMax || coverH > O.outlineCoverMax) return null;
  return {
    kind: 'quad',
    pts: q.corners.map((c) => [r2(c[0]), r2(c[1])]),
    rms: Math.round(q.rms * 100) / 100,
    n: q.n,
    // The orientation conditioning, the quad's analogue of `ecc`.
    skewDeg: Math.round(quadSkewDeg(q.corners) * 100) / 100,
    cover: Math.round(Math.min(coverW, coverH) * 100) / 100,
  };
}

function r2(v) { return Math.round(v * 100) / 100; }

// Every eligible detection in one frame, outline attached in place.
//
// Returns how many were attempted and how many produced one — metric (o1) — with
// the clipped ones counted apart rather than folded into the failures. A clipped
// detection was never a candidate, and counting it as one would report a fitter
// that fails half the time when what happened is that half the objects were
// half out of frame. In landscape the world-vertical field of view is 36
// degrees, so that is the normal case here and not a footnote.
function fitOutlines(img, dets, opts = {}) {
  let tried = 0;
  let got = 0;
  let clipped = 0;
  for (const det of dets || []) {
    if (!shapeFor(det.cls)) continue;
    if (det.clip === undefined ? det.clipped : det.clip) { clipped++; continue; }
    tried++;
    const o = fitOutline(img, det, opts);
    if (o) { det.outline = o; got++; }
  }
  return { tried, got, clipped };
}

// --- geometry: what an outline means in metres ---
//
// Everything below works in the camera frame with CV axes — x right, y down,
// z forward — which is the frame `objects.js`'s own `bearing()` produces and
// `pose.q` rotates into the room. Points are in **full camera-image pixels**:
// an outline is fitted in the small frame the phone sent and the caller scales
// it, exactly as `bearing()` does, because the intrinsics describe the big one.

// The pose of a circle of known radius, from its projected conic. Two solutions,
// always — this is the same two-fold ambiguity a planar tag has, arriving
// through a different door.
//
// The cone through the camera centre containing the ellipse is `Q = K' M K` for
// the image conic `M`; its eigen-decomposition puts one axis along the cone's
// own axis of symmetry, and the circle's plane is recovered from how far the
// other two eigenvalues have been pulled apart. A head-on circle pulls them
// apart not at all, which is why the answer is unstable there and why
// `ellipseMinEccentricity` exists.
//
// Returns `[{ c, n }, { c, n }]` — centre and unit plane normal in camera
// coordinates, normal facing the camera — or null.
function circlePoseFromConic(conic, K, radiusM) {
  if (!(radiusM > 0) || !K?.fx) return null;
  const [A, B, C, D, E, F] = conic;
  // M as a symmetric matrix in pixel coordinates.
  const M = [A, B / 2, D / 2, B / 2, C, E / 2, D / 2, E / 2, F];
  const Kmat = [K.fx, 0, K.cx, 0, K.fy, K.cy, 0, 0, 1];
  // Q = K' M K.
  const KM = mul3(transpose3(Kmat), M);
  let Q = mul3(KM, Kmat);
  // Normalize so two eigenvalues are positive and one negative.
  const eig0 = symEig3(Q);
  const pos = eig0.values.filter((v) => v > 0).length;
  if (pos === 1) Q = Q.map((v) => -v);
  const { values, vectors } = symEig3(Q);
  // Order: lam1, lam2 same sign with |lam1| >= |lam2|, lam3 the odd one out.
  const idx = [0, 1, 2];
  const negIdx = idx.filter((i) => values[i] < 0);
  const posIdx = idx.filter((i) => values[i] > 0);
  if (negIdx.length !== 1 || posIdx.length !== 2) return null;
  posIdx.sort((a, b) => Math.abs(values[b]) - Math.abs(values[a]));
  const i1 = posIdx[0];
  const i2 = posIdx[1];
  const i3 = negIdx[0];
  const l1 = values[i1];
  const l2 = values[i2];
  const l3 = values[i3];
  if (!(l1 - l3)) return null;
  // Right-handed basis, or the recovered normal comes back mirrored.
  const e1 = vectors[i1];
  const e2 = vectors[i2];
  let e3 = vectors[i3];
  if (dot3(cross3(e1, e2), e3) < 0) e3 = scale3(e3, -1);
  const V = (v) => [
    e1[0] * v[0] + e2[0] * v[1] + e3[0] * v[2],
    e1[1] * v[0] + e2[1] * v[1] + e3[1] * v[2],
    e1[2] * v[0] + e2[2] * v[1] + e3[2] * v[2],
  ];
  const g = Math.sqrt((l2 - l3) / (l1 - l3));
  const h = Math.sqrt((l1 - l2) / (l1 - l3));
  const z0 = (radiusM * l2) / Math.sqrt(-l1 * l3);
  const out = [];
  for (const s1 of [1, -1]) {
    for (const s2 of [1, -1]) {
      for (const s3 of [1, -1]) {
        const n = unit3(V([s2 * h, 0, -s1 * g]));
        const c = scale3(V([
          s2 * (l3 / l2) * h,
          0,
          -s1 * (l1 / l2) * g,
        ]), s3 * z0);
        // In front of the camera, and facing it. Together these cut the eight
        // sign combinations down to the two that are geometrically distinct —
        // and it is those two, not a tuning choice, that the caller has to
        // resolve.
        if (!(c[2] > 0)) continue;
        if (dot3(n, c) >= 0) continue;
        if (out.some((o) => norm3([o.c[0] - c[0], o.c[1] - c[1], o.c[2] - c[2]]) < 1e-6
          && dot3(o.n, n) > 1 - 1e-9)) continue;
        out.push({ c, n });
      }
    }
  }
  // Normally two. **One** is the exactly-head-on case, where the mirror partner
  // has converged onto its twin — the degeneracy `ellipseMinEccentricity`
  // exists for, arriving as a collapsed pair rather than as a bad answer.
  return out.length ? out : null;
}

function transpose3(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
function mul3(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return o;
}

// A pixel to a unit ray in camera coordinates.
function rayFor(u, v, K) {
  return unit3([(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1]);
}

// The plane a projected rectangle lies on, from where its two pairs of opposite
// sides meet.
//
// Two parallel lines in the world meet at a vanishing point, and the direction
// from the camera to that point *is* the direction those lines run in. So the
// rectangle's two side directions come straight out of the image with no scale
// and no depth involved, and their cross product is the plane normal — a
// rectangle's sides being perpendicular is the whole of the prior knowledge
// used.
//
// Taken as the cross product of the two image *lines* rather than as a point,
// so the fronto-parallel case (where the vanishing point runs off to infinity)
// is an ordinary answer and not a division by zero. It is still the badly
// conditioned case — see `quadMinSkewDeg` — but the code does not have to
// notice, and the caller has a number to gate on instead of a special case to
// remember.
//
// Returns `{ n, d1, d2 }` in camera coordinates, `n` facing the camera.
function quadPlaneFromCorners(corners, K) {
  if (!corners || corners.length !== 4 || !K?.fx) return null;
  const [tl, tr, br, bl] = corners;
  // Homogeneous image lines through each side.
  const lineOf = (a, b) => cross3([a[0], a[1], 1], [b[0], b[1], 1]);
  const top = lineOf(tl, tr);
  const bottom = lineOf(bl, br);
  const left = lineOf(tl, bl);
  const right = lineOf(tr, br);
  // K^-1 applied to a homogeneous point, which stays valid for a point at
  // infinity — the whole reason the vanishing point is never divided out.
  const unproj = (p) => unit3([(p[0] - K.cx * p[2]) / K.fx, (p[1] - K.cy * p[2]) / K.fy, p[2]]);
  const d1 = unproj(cross3(top, bottom));
  const d2 = unproj(cross3(left, right));
  if (!Number.isFinite(d1[0]) || !Number.isFinite(d2[0])) return null;
  let n = cross3(d1, d2);
  const nn = norm3(n);
  if (nn < 1e-9) return null;                 // the two side directions collapsed
  n = scale3(n, 1 / nn);
  // Facing the camera: the visible side of a surface is the side whose normal
  // points back down the viewing ray.
  const centre = [
    (tl[0] + tr[0] + br[0] + bl[0]) / 4,
    (tl[1] + tr[1] + br[1] + bl[1]) / 4,
  ];
  const view = rayFor(centre[0], centre[1], K);
  if (dot3(n, view) > 0) n = scale3(n, -1);
  return { n, d1, d2 };
}

// Where four rays through a plane put the rectangle's corners, given the plane's
// normal and one point on it. Pure intersection — no fitting, no scale guess.
function quadCornersOnPlane(corners, K, n, pointOnPlane) {
  const d = dot3(n, pointOnPlane);
  const out = [];
  for (const c of corners) {
    const r = rayFor(c[0], c[1], K);
    const den = dot3(n, r);
    if (Math.abs(den) < 1e-9) return null;    // ray parallel to the plane
    const t = d / den;
    if (!(t > 0)) return null;                // behind the camera
    out.push(scale3(r, t));
  }
  return out;
}

// The metric size of a rectangle whose plane and range are both known. Opposite
// sides are averaged: they are the same physical edge measured twice, and their
// disagreement is the fit's own error rather than an asymmetry of the object.
function quadSizeOnPlane(corners3) {
  if (!corners3) return null;
  const [tl, tr, br, bl] = corners3;
  const len = (a, b) => norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  const w = (len(tl, tr) + len(bl, br)) / 2;
  const h = (len(tl, bl) + len(tr, br)) / 2;
  const centre = [
    (tl[0] + tr[0] + br[0] + bl[0]) / 4,
    (tl[1] + tr[1] + br[1] + bl[1]) / 4,
    (tl[2] + tr[2] + br[2] + bl[2]) / 4,
  ];
  return { w, h, centre };
}

// The pose of a rectangle of known metric size, from its four image corners and
// a plane normal. The one free parameter is range, and the apparent size fixes
// it: intersect the corner rays with the plane at unit range, measure what that
// rectangle would be, and scale.
//
// Returns `{ c, n, w, h }` — the rectangle's centre in camera coordinates.
// The quad's corners on a plane one metre down its own centre ray. A unit stick
// rather than a guess: the geometry is a similarity in range, so the *shape* of
// this trial is the shape at every range, and both the size solve below and the
// caller's decision about which side is world-vertical read it.
function quadTrialCorners(corners, K, n) {
  const cx = (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
  const cy = (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;
  return quadCornersOnPlane(corners, K, n, rayFor(cx, cy, K));
}

// `wM` and `hM` are the metric lengths of the **top** and **left** sides as the
// corners were handed in — image sides, not room axes. Which of them is the
// object's height is a fact about how the phone was held, and this function has
// no way to know it; `quadTrialCorners` is how a caller that does finds out.
function quadPoseFromSize(corners, K, n, wM, hM) {
  if (!(wM > 0) || !(hM > 0)) return null;
  const trial = quadTrialCorners(corners, K, n);
  const size = quadSizeOnPlane(trial);
  if (!size || !(size.w > 0) || !(size.h > 0)) return null;
  // Both axes vote, weighted equally: one may be foreshortened almost to
  // nothing, and the ratio of the two is exactly what the fit is worst at.
  const k = ((wM / size.w) + (hM / size.h)) / 2;
  return {
    c: scale3(size.centre, k),
    n,
    w: size.w * k,
    h: size.h * k,
  };
}

module.exports = {
  DEFAULTS,
  normClass,
  shapeFor,
  SHAPE_BY_CLASS,
  fitOutline,
  fitOutlines,
  edgePoints,
  fitEllipse,
  ellipseToConic,
  conicToEllipse,
  conicDist,
  symEig3,
  mirrorAboutAxis,
  circlePoseFromConic,
  quadPlaneFromCorners,
  quadCornersOnPlane,
  quadTrialCorners,
  quadSizeOnPlane,
  quadPoseFromSize,
  quadSkewDeg,
  rayFor,
  median,
};
