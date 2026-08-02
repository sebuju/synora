'use strict';

// Shared by the calibration page and the client's pose pipeline: on-demand
// OpenCV loading, camera intrinsics persistence, and the marker/board
// definitions both sides must agree on.

// Room tags and the calibration board use different dictionary families on
// purpose: a calibration board lying around in shot must never be readable as
// a room tag, and vice versa.
const ROOM_DICT = 'DICT_4X4_50';
const ROOM_TAG_COUNT = 16;
// Physical tag edge (black border included), as a *default* only. The live
// value is the server's POSE_CONFIG.markerSizeM, settable from the markers
// page and served by /api/pose-config, and that is the number PnP solves
// against — so anything that draws a tag reads it from there rather than from
// here, or every distance measured from that tag scales by the mismatch. This
// constant existed as the one true size and /digital drew from it while the
// server had been reconfigured to 142 mm: a 5.6% scale error on every screen
// tag, visible nowhere.
const ROOM_TAG_MM = 150;

// A tag's four corners in its own frame, ArUco order TL,TR,BR,BL; marker frame
// x right, y up, z out of the wall. One definition, because two sides solve
// against it: the client's PnP object points (detect-core.js) and the server's
// joint multi-tag solve (survey.js, which require()s this file — hence the
// module.exports tail below). A layout that drifted between them would not
// fail, it would bias every joint residual silently.
function markerCornersM(sizeM) {
  const s = sizeM / 2;
  return [[-s, s, 0], [s, s, 0], [s, -s, 0], [-s, -s, 0]];
}

const BOARD_DICT = 'DICT_5X5_100';
const BOARD_SQUARES_X = 7;
const BOARD_SQUARES_Y = 10;
const BOARD_SQUARE_M = 0.026;   // 26 mm squares -> 182x260 mm, fits A4 portrait
const BOARD_MARKER_M = 0.019;

// Fallback when a device has never been calibrated: a typical client main
// camera is ~66 degrees horizontal FOV. Good to maybe 5%, which the viewer is
// told about via calibrated:false. "Horizontal" means across the sensor's long
// axis, i.e. the frame's long edge — see the guess in intrinsicsFor.
const DEFAULT_HFOV_DEG = 66;

// How far two aspect ratios may differ and still be treated as the same sensor
// crop. 1% covers 854x480 vs 16:9 (0.08% out) and nothing else in the ladder.
const ASPECT_TOL = 0.01;

// opencv.js is ~10 MB, so it is only pulled when something actually needs CV.
// The build is single-file (wasm inlined) and announces readiness differently
// across versions — some resolve a promise, some fire onRuntimeInitialized —
// so both are handled.
let cvLoadPromise = null;

function settleOpenCv(mod, resolve, reject) {
  if (typeof mod?.then === 'function') {
    mod.then((ready) => {
      // Old emscripten makes the Module itself thenable, and its `then`
      // re-invokes with the Module — resolving a promise with it makes
      // promise adoption recurse forever (the page pegs a core and every
      // `await loadOpenCv()` hangs). Strip it before it can be awaited.
      delete ready.then;
      self.cv = ready;
      resolve(ready);
    });
  } else if (mod?.Mat) {
    resolve(mod);
  } else if (mod) {
    mod.onRuntimeInitialized = () => resolve(mod);
  } else {
    reject(new Error('opencv.js loaded but defined no cv global'));
  }
}

// Works on a page and inside a worker: the pose pipeline runs detection off the
// main thread, and that thread has no document to append a script tag to.
function loadOpenCv() {
  cvLoadPromise ??= new Promise((resolve, reject) => {
    if (typeof importScripts === 'function') {
      try {
        importScripts('/vendor/opencv.js');
      } catch {
        reject(new Error('failed to load /vendor/opencv.js'));
        return;
      }
      settleOpenCv(self.cv, resolve, reject);
      return;
    }
    const script = document.createElement('script');
    script.src = '/vendor/opencv.js';
    script.onerror = () => reject(new Error('failed to load /vendor/opencv.js'));
    script.onload = () => settleOpenCv(self.cv, resolve, reject);
    document.head.append(script);
  });
  return cvLoadPromise;
}

// ---------------------------------------------------------------------------
// Intrinsics store. Keyed by lens and resolution within a device: the same
// client has independent front/back cameras, and fx/fy/cx/cy are
// resolution-dependent.
//
// These live on the server now, under the device's id, and this is the page's
// in-memory copy of them. They used to live in localStorage, where a cleared
// site data or a switch of browser destroyed fifteen careful ChArUco captures
// and nothing said so — the client simply started reporting a derived model, or
// an outright FOV guess, and every distance in the room went with it.
//
// A record is { fx, fy, cx, cy, dist[5], w, h, rms, savedAtMs, orientAngle }.
// `orientAngle` is the display rotation the views were captured at; it may be
// absent on records written before it was recorded, which is why
// orientIntrinsics has an approximate path. The key format is deliberately
// unchanged from the localStorage one, so a lifted record and a fresh one are
// the same thing.
//
// Lookups are synchronous, because that is what the detection path needs, so
// nothing may be fetched here — initIntrinsics fills the store once, before any
// camera opens. In the detection worker (which imports this file but never the
// identity module) the store stays empty by design: intrinsics reach the worker
// from the page, which is the only context that can resolve them.
const intrinsicsStore = new Map();

function intrinsicsKey(facing, w, h) {
  return `streamer-intrinsics:${facing}:${w}x${h}`;
}

// Calibrations left in localStorage by a build from before the store moved.
// Read once, lifted to the server, and then irrelevant — but never deleted:
// nothing is gained by removing them, and they are the only copy if the lift
// fails.
function localIntrinsicsRecords() {
  const out = {};
  let n = 0;
  try {
    n = localStorage.length;
  } catch {
    return out;
  }
  for (let i = 0; i < n; i++) {
    try {
      const key = localStorage.key(i);
      if (!key?.startsWith('streamer-intrinsics:')) continue;
      out[key] = JSON.parse(localStorage.getItem(key));
    } catch {
      // One unparseable entry must not lose the rest.
    }
  }
  return out;
}

// Fill the store for a resolved device, and lift anything this browser still
// holds locally that the server has not got. Must complete before a camera
// opens — a frame that arrives first is solved with a guessed camera model.
// `apiJson` comes from common.js, which every page using this also loads.
async function initIntrinsics(device) {
  intrinsicsStore.clear();
  for (const [key, rec] of Object.entries(device.intrinsics || {})) {
    intrinsicsStore.set(key, rec);
  }
  const missing = Object.fromEntries(Object.entries(localIntrinsicsRecords())
    .filter(([key, rec]) => validIntrinsics(rec) && !intrinsicsStore.has(key)));
  if (!Object.keys(missing).length) return;
  const res = await apiJson('/api/device/intrinsics', {
    deviceId: device.id, intrinsics: missing,
  });
  if (!res?.ok) return;
  for (const [key, rec] of Object.entries(missing)) intrinsicsStore.set(key, rec);
}

// Write-through: the page keeps working from the store immediately, and the
// server is told. Returns whether it was persisted — a calibration that only
// reached the store dies with the tab, and /calibrate says so rather than
// claiming a save.
async function saveIntrinsics(facing, data) {
  const key = intrinsicsKey(facing, data.w, data.h);
  intrinsicsStore.set(key, data);
  const res = await apiJson('/api/device/intrinsics', {
    deviceId: storedDeviceId('client'), intrinsics: { [key]: data },
  });
  return !!res?.ok;
}

// Every stored calibration for a lens, newest first. The calibration page lists
// these so an uncovered resolution or orientation is visible before it silently
// becomes a derived model on the client.
function listIntrinsics(facing) {
  const prefix = `streamer-intrinsics:${facing}:`;
  return [...intrinsicsStore.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, rec]) => rec)
    .filter(validIntrinsics)
    .sort((a, b) => (b.savedAtMs || 0) - (a.savedAtMs || 0));
}

// The display rotation the browser reports now. Android rotates the camera
// track with the display, so this is also the frame's rotation relative to the
// sensor — and the difference between it and the angle a calibration was
// captured at is the only thing that makes a turned calibration recoverable
// rather than guessed. Absent in a worker (no `screen`), which is why only the
// page ever resolves intrinsics.
function displayAngle() {
  if (typeof screen === 'undefined') return null;
  const a = screen.orientation?.angle;
  return Number.isFinite(a) ? ((a % 360) + 360) % 360 : null;
}

// A camera model for the same image rotated clockwise by `deg` (90/180/270).
//
// This is a rotation, not a transpose: swapping cx/cy alone describes a
// *mirrored* camera, because a 90° rotation reflects one axis as well
// (cx' = h - cy). That mirror was the bug — it biases the principal point by
// twice its true offset from centre, which is a bearing bias applied to every
// tag at once, so the whole map appeared to move when the device was turned.
//
// Radial distortion (k1,k2,k3) is rotation-invariant. The tangential pair
// rotates: substituting (x,y) -> (-y,x) into OpenCV's model gives
// (p1,p2) -> (p2,-p1) for 90° CW, its inverse for 270°, and a sign flip on
// both for 180°.
function rotateIntrinsics(c, deg) {
  const [k1, k2, p1, p2, k3] = c.dist;
  // Anything that is not a quarter turn is not a frame this code can describe;
  // returning the model untouched beats silently answering as if it were 270.
  if (deg !== 90 && deg !== 180 && deg !== 270) {
    return { ...c, dist: c.dist.slice(0, 5) };
  }
  if (deg === 180) {
    return {
      fx: c.fx, fy: c.fy, cx: c.w - c.cx, cy: c.h - c.cy,
      dist: [k1, k2, -p1, -p2, k3],
      w: c.w, h: c.h, rms: c.rms,
    };
  }
  if (deg === 90) {
    return {
      fx: c.fy, fy: c.fx, cx: c.h - c.cy, cy: c.cx,
      dist: [k1, k2, p2, -p1, k3],
      w: c.h, h: c.w, rms: c.rms,
    };
  }
  return {
    fx: c.fy, fy: c.fx, cx: c.cy, cy: c.w - c.cx,
    dist: [k1, k2, -p2, p1, k3],
    w: c.h, h: c.w, rms: c.rms,
  };
}

// A quarter turn whose direction is not known — a calibration saved before the
// display angle was recorded. Transposing the focal pair is safe (fx and fy
// agree to well under 1% on a square-pixel sensor), but mirroring the
// principal point the wrong way is worse than not mirroring it, so it is
// dropped to the frame centre: a bounded error instead of a confident bias in
// an unknown direction. Recalibrating once records the angle and this stops
// being reachable.
function transposeIntrinsicsApprox(c) {
  const [k1, k2, , , k3] = c.dist;
  return {
    fx: c.fy, fy: c.fx, cx: c.h / 2, cy: c.w / 2,
    // The tangential pair cannot be rotated without the direction either, and
    // it is the one part of the model whose sign matters more than its size.
    dist: [k1, k2, 0, 0, k3],
    w: c.h, h: c.w, rms: c.rms,
  };
}

function validIntrinsics(c) {
  return !!c && Array.isArray(c.dist) && c.dist.length >= 5
    && [c.w, c.h, c.fx, c.fy, c.cx, c.cy].every((v) => Number.isFinite(v))
    && c.w > 0 && c.h > 0 && c.fx > 0 && c.fy > 0;
}

// Bring a stored model into the orientation of a w x h frame. The mirror
// direction is only known when the stored angle and the current one differ by a
// quarter turn that agrees with the two frame shapes; anything else is the
// approximation above.
function orientIntrinsics(cand, w, h, nowAngle) {
  const turned = (cand.h > cand.w) !== (h > w);
  const delta = Number.isFinite(nowAngle) && Number.isFinite(cand.orientAngle)
    ? (((nowAngle - cand.orientAngle) % 360) + 360) % 360
    : null;
  if (delta !== null && (delta === 90 || delta === 270) === turned) {
    if (delta === 0) return { model: cand, source: 'exact' };
    return { model: rotateIntrinsics(cand, delta), source: 'rotated' };
  }
  if (!turned) return { model: cand, source: 'exact' };
  return { model: transposeIntrinsicsApprox(cand), source: 'rotated-approx' };
}

// Best available intrinsics for a lens at a given frame size. Every stored
// calibration for the lens is a candidate: each is turned into the requested
// orientation, candidates whose aspect ratio does not match are dropped, and
// the one needing the least rescaling wins. An exact-resolution match falls out
// of that as scale 1.
//
// Callers get three provenance fields rather than one boolean, because "exact
// ChArUco fit at this resolution" and "transposed and scaled 2x from another
// one" were previously indistinguishable — and the derived tiers are the ones
// that go wrong:
//   source  'exact' | 'rotated' | 'rotated-approx' | 'guess'
//   scale   1 unless the model was rescaled from another resolution
//   from    '<WxH>' the calibration it came from, null when nothing was derived
// `calibrated` stays `source !== 'guess'` so the wire format and the dashboard
// keep their existing meaning.
function intrinsicsFor(facing, w, h) {
  const nowAngle = displayAngle();
  let best = null;
  for (const cand of listIntrinsics(facing)) {
    const from = `${cand.w}x${cand.h}`;
    const { model, source } = orientIntrinsics(cand, w, h, nowAngle);
    // A different aspect ratio is a different sensor crop, so a different field
    // of view — scaling across it is not a rescale of anything, and the FOV
    // guess is the honest answer instead.
    if (Math.abs((model.w / model.h) / (w / h) - 1) > ASPECT_TOL) continue;
    // Least extrapolation wins, symmetric in up- and downscaling.
    const cost = Math.abs(Math.log(w / model.w));
    if (!best || cost < best.cost) best = { cost, model, source, from };
  }

  if (best) {
    const { model, source } = best;
    const sx = w / model.w;
    const sy = h / model.h;
    const derived = source !== 'exact' || sx !== 1;
    return {
      fx: model.fx * sx, fy: model.fy * sy, cx: model.cx * sx, cy: model.cy * sy,
      // Distortion coefficients are dimensionless in normalized coordinates,
      // so a rescale leaves them alone.
      dist: model.dist.slice(0, 5),
      w,
      h,
      // rms measured the calibration this came from, not this model. Carrying
      // it onto a derived one reads as a quality claim about numbers it never
      // saw.
      rms: derived ? null : (model.rms ?? null),
      source,
      scale: sx,
      from: derived ? best.from : null,
      calibrated: true,
    };
  }

  // Never calibrated. The 66° figure is a *horizontal* FOV, spanning the
  // sensor's long axis; applying it to the frame width instead made the same
  // lens 1.78x shorter in portrait than in landscape at 4K, which put every
  // tag 1.78x too close — an orientation-dependent error in the one place that
  // is supposed to be a device-independent guess.
  const f = (Math.max(w, h) / 2) / Math.tan((DEFAULT_HFOV_DEG / 2) * Math.PI / 180);
  return {
    fx: f, fy: f, cx: w / 2, cy: h / 2, dist: [0, 0, 0, 0, 0],
    w, h, rms: null, source: 'guess', scale: 1, from: null, calibrated: false,
  };
}

// ---------------------------------------------------------------------------
// Factories for the CV objects both pages build. Callers own the returned
// objects (embind: every one must eventually be .delete()d).
// Two detector profiles, because the pose pipeline runs two different scans.
// A `full` scan sweeps the whole frame for tags that could be anywhere and any
// size; a `roi` scan re-finds tags already known to sit inside a small crop.
const DETECT_PROFILES = {
  // ArUco3 searches candidates on a downscaled copy of the image and then
  // refines the corners against the full-resolution one, so it costs pose
  // accuracy nothing. The downscale factor OpenCV derives is
  //   32 / (32 + longEdge * minMarkerLengthRatioOriginalImg)
  // which with the default ratio of 0 is exactly 1 — i.e. setting
  // useAruco3Detection alone (as this did before) changes nothing at all. The
  // ratio is the setting that matters. 0.015 scans 4K at ~0.36 (an 8x area
  // cut) while still accepting a 58 px marker, about 7.5 m out for a 150 mm
  // tag on a 66-degree lens.
  full: {
    useAruco3Detection: true,
    minSideLengthCanonicalImg: 32,
    minMarkerLengthRatioOriginalImg: 0.015,
  },
  // The crop is already small, so downscaling it further would only cost
  // corner quality. Two adaptive-threshold passes rather than the default
  // three: a crop is one patch of scene under one lighting, and a miss costs
  // only the immediate full-frame retry the caller does anyway.
  roi: {
    useAruco3Detection: false,
    adaptiveThreshWinSizeMin: 9,
    adaptiveThreshWinSizeMax: 25,
    adaptiveThreshWinSizeStep: 16,
  },
};

// ArUco3 always costs acquisition range; big frames simply have range to
// spare, so it is a trade to make per resolution rather than a constant.
// Candidate search and decoding both run on the downscaled copy (OpenCV
// resizes `grey` in place before `_detectInitialCandidates`), so the floor
// that matters — roughly 20 px of marker side for a 4x4 dictionary, an
// empirical limit rather than a parameter — applies there. In original pixels
// that floor is 20/scale, which is why it moves with the frame: the ratio
// declares the smallest marker as a *fraction of the long edge*, not as a
// pixel count. Wanting a constant 20 px original at every resolution is
// wanting scale = 1, i.e. no ArUco3 at all. A tag that never surfaces in a
// full sweep never starts the ROI track either, so the range it takes is not
// recoverable elsewhere. On a 150 mm tag and a 66-degree lens the trade runs:
//   3840  7.9 m with, ~22 m without   8 MP sweep    keep it
//   1920  5.8 m with, ~11 m without   2 MP sweep    not worth it
//   1280  4.6 m with, ~7.4 m without  1 MP sweep    not worth it
//    640  2.8 m with, ~3.7 m without  0.3 MP sweep  not worth it
// Only the 4K sweep is expensive enough to buy speed with range it can spare;
// this threshold sits just under it. The 640 px frame is what WebXR's
// camera-access hands over, and it has the least range to give away.
const ARUCO3_MIN_LONG_EDGE = 2560;

function makeRoomDetector(cv, profile = 'full', longEdge = Infinity) {
  const dict = cv.getPredefinedDictionary(cv[ROOM_DICT]);
  const params = new cv.aruco_DetectorParameters();
  // Subpixel corner refinement is most of the pose accuracy at range — but
  // ArUco3 does its own, and while it is on this assignment is inert. Measured
  // on 4K frames: with useAruco3Detection set, CORNER_REFINE_NONE, _SUBPIX and
  // _APRILTAG return bit-identical corners and cornerRefinementWinSize changes
  // nothing, while cornerRefinementMaxIterations still moves them 1.4 px mean.
  // So the refinement above the ArUco3 downscale is real (that is the "costs
  // pose accuracy nothing" claim on DETECT_PROFILES.full), the iteration count
  // is the only knob that reaches it, and tuning a window size at 4K measures
  // nothing. The line still bites on the roi profile and below
  // ARUCO3_MIN_LONG_EDGE, which is why it stays.
  //
  // CORNER_REFINE_APRILTAG was measured and rejected. It genuinely produces the
  // best corners — 4K with ArUco3 off, 124 frames: 0.127 px median reprojection
  // against 0.240 for subpix and 0.359 unrefined, inter-tag distance MAD 8.2 mm
  // against 11.6 — but only reachable by turning ArUco3 off, at 370 ms/frame
  // against 28 for the profile as it stands. At 1080p, where the method does
  // apply, three sessions gave no consistent accuracy win for 2.6-3.6x the CPU.
  params.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX;
  const settings = { ...DETECT_PROFILES[profile] };
  if (settings.useAruco3Detection && longEdge < ARUCO3_MIN_LONG_EDGE) {
    // Drop the companion settings too: with ArUco3 off OpenCV ignores them,
    // and leaving them applied would suggest they still gate something.
    settings.useAruco3Detection = false;
    delete settings.minSideLengthCanonicalImg;
    delete settings.minMarkerLengthRatioOriginalImg;
  }
  for (const [key, value] of Object.entries(settings)) {
    // opencv.js builds differ in which detector parameters they expose, and an
    // unknown name would land as a plain JS property — silently ignored by the
    // wasm side, which is exactly the failure mode that hid the ArUco3 ratio.
    if (!(key in params)) {
      console.warn(`opencv.js build exposes no aruco parameter "${key}"`);
      continue;
    }
    params[key] = value;
  }
  return new cv.aruco_ArucoDetector(dict, params, new cv.aruco_RefineParameters(10, 3, true));
}

function makeCharucoBoard(cv) {
  const dict = cv.getPredefinedDictionary(cv[BOARD_DICT]);
  return new cv.aruco_CharucoBoard(
    new cv.Size(BOARD_SQUARES_X, BOARD_SQUARES_Y),
    BOARD_SQUARE_M, BOARD_MARKER_M, dict, new cv.Mat());
}

function makeCharucoDetector(cv, board) {
  return new cv.aruco_CharucoDetector(
    board, new cv.aruco_CharucoParameters(),
    new cv.aruco_DetectorParameters(), new cv.aruco_RefineParameters(10, 3, true));
}

// ---------------------------------------------------------------------------
// Luma sources. Detection reads nothing but brightness, so anything that hands
// the detector RGBA is paying 4x the memory traffic plus a colour conversion
// for pixels it throws away. Both sources below produce an 8-bit gray Mat for
// a rectangle of the current frame; the rectangle is what makes a
// region-of-interest scan cheap, since the crop happens before the readback.
//
// Mats and canvases are reused across frames — allocating per frame churns the
// wasm heap far faster than GC notices.

// Chroma planes are subsampled, so a crop of a YUV frame has to land on even
// coordinates or the plane geometry stops lining up. Rounding out (never in)
// keeps the caller's region fully covered.
function evenRect(rect, fw, fh) {
  const maxX = fw & ~1;
  const maxY = fh & ~1;
  const x0 = Math.min(Math.max(0, Math.floor(rect.x) & ~1), Math.max(0, maxX - 2));
  const y0 = Math.min(Math.max(0, Math.floor(rect.y) & ~1), Math.max(0, maxY - 2));
  const x1 = Math.min(maxX, (Math.ceil(rect.x + rect.w) + 1) & ~1);
  const y1 = Math.min(maxY, (Math.ceil(rect.y + rect.h) + 1) & ~1);
  return { x: x0, y: y0, w: Math.max(2, x1 - x0), h: Math.max(2, y1 - y0) };
}

// Raw RGBA bytes, as glReadPixels hands them over: the XR client's camera
// arrives as a GL texture, so there is no VideoFrame to take a luma plane from
// and no point drawing it through a canvas only to read it straight back. The
// "image" here is `{ data, w, h, flipY }`.
//
// flipY is the GL convention — readPixels returns bottom-up and every corner
// downstream is measured top-down — and it is done during the copy into the
// Mat rather than as a second pass over the image.
//
// Only the requested rectangle is converted: on an ROI scan that is a small
// crop of a 1920-row frame, and colour conversion over the whole frame to throw
// most of it away was the largest avoidable cost on this path.
// `maxWidth` caps the width of the Mat returned, as on the canvas source and
// for the same consumer: the feature tracker wants a small image and nothing
// else. Here the downscale is a cv.resize after conversion rather than a free
// GPU blit, because these pixels never touch a canvas — still far cheaper than
// tracking at native resolution, and the tracker is the only caller that asks.
// One source serves both consumers on this path — the detector, which wants a
// crop at native resolution, and the feature tracker, which wants the whole
// frame small. It has to, and the measurement is why: the RGBA copy is 6.6 MB
// with a row-by-row flip, and doing it twice per frame put the tracker at a
// median of 117 ms on a real phone, which dropped the effective rate to 3-5 Hz,
// which let the camera move 100+ px between frames, which is exactly where
// optical flow stops holding on. The duplicated copy was paying for its own
// failure.
//
// So the fill is keyed on the pixel buffer: the second call in a frame passes
// the same Uint8Array and skips straight to conversion. Grays are cached per
// requested size rather than in one slot, because the two consumers ask for
// different sizes and a single slot would reallocate on every call — which was
// the original reason for giving them separate sources.
function createRgbaLumaSource(cv, { maxWidth = 0 } = {}) {
  let rgba = null;
  let rw = 0;
  let rh = 0;
  let filledFrom = null;   // the pixel buffer already copied in
  // One slot per *role* rather than a cache keyed by size. A size-keyed cache
  // with any eviction policy can throw away a Mat the current call is still
  // about to write into — which is exactly what happened: the tracker fetched
  // its output buffer, then fetching the full-frame intermediate evicted it,
  // and the resize wrote into freed memory. The tracker caught the throw, shut
  // itself off for the session, and the only symptom was a line quietly missing
  // from the overlay.
  //
  // Three slots is all this needs, and none of them can collide: the detector
  // asks at native size, the tracker asks scaled, and the intermediate belongs
  // to the scaled path alone.
  let grayNative = null;   // unscaled returns (the detector's crop or full frame)
  let grayFull = null;     // full-frame intermediate, scaled path only
  let graySmall = null;    // scaled returns (the tracker)

  function sized(mat, w, h) {
    if (mat && mat.cols === w && mat.rows === h) return mat;
    mat?.delete();
    return new cv.Mat(h, w, cv.CV_8UC1);
  }

  return {
    // `opts.maxWidth` overrides the instance default, so one source can serve a
    // detector that wants native resolution and a tracker that wants a small
    // image, in the same frame, without copying the pixels twice.
    luma(image, rect, opts = {}) {
      const cap = opts.maxWidth ?? maxWidth;
      const { data, w: fw, h: fh, flipY } = image;
      if (!fw || !fh || !data) return null;
      if (rw !== fw || rh !== fh) {
        rgba?.delete();
        rgba = new cv.Mat(fh, fw, cv.CV_8UC4);
        rw = fw;
        rh = fh;
        filledFrom = null;
      }
      if (filledFrom !== data) {
        const row = fw * 4;
        if (flipY) {
          for (let y = 0; y < fh; y++) {
            rgba.data.set(data.subarray((fh - 1 - y) * row, (fh - y) * row), y * row);
          }
        } else {
          rgba.data.set(data);
        }
        filledFrom = data;
      }
      const r = rect ? evenRect(rect, fw, fh) : { x: 0, y: 0, w: fw, h: fh };
      const whole = r.x === 0 && r.y === 0 && r.w === fw && r.h === fh;
      const scaled = cap && r.w > cap;
      // Convert straight into the size that is wanted: a downscaling caller had
      // been converting the whole frame and then shrinking it, which is the
      // expensive half of the work done at full resolution for nothing.
      const dw = scaled ? cap : r.w;
      const dh = scaled ? Math.max(1, Math.round(r.h * (dw / r.w))) : r.h;
      const src = whole ? rgba : rgba.roi(new cv.Rect(r.x, r.y, r.w, r.h));
      let gray;
      if (scaled) {
        // Convert first, shrink second — and it is worth saying why, because the
        // other order looks cheaper and is not. Shrinking in colour means
        // INTER_AREA averaging four channels at full resolution; converting
        // first throws three of them away before any of that work happens.
        // Measured on an 860x1920 frame down to 720: 26.7 ms the colour-first
        // way against 9.3 ms this way.
        grayFull = sized(grayFull, r.w, r.h);
        graySmall = sized(graySmall, dw, dh);
        gray = graySmall;
        cv.cvtColor(src, grayFull, cv.COLOR_RGBA2GRAY);
        // INTER_AREA rather than INTER_LINEAR (4.8 ms) on purpose: this is a
        // downscale of nearly 2x and linear sampling aliases, which puts noise
        // straight into the corners the tracker is about to follow.
        cv.resize(grayFull, gray, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
      } else {
        grayNative = sized(grayNative, dw, dh);
        gray = grayNative;
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      }
      if (!whole) src.delete();
      return { mat: gray, rect: r, scale: dw / r.w };
    },
    dispose() {
      rgba?.delete();
      grayNative?.delete();
      grayFull?.delete();
      graySmall?.delete();
      rgba = grayNative = grayFull = graySmall = null;
      rw = rh = 0;
      filledFrom = null;
    },
  };
}

// Draws through a 2D canvas: the universal path, and the only one available
// when the frame cannot be reached as a VideoFrame. drawImage crops on the GPU,
// so getImageData only ever reads back the crop.
//
// `maxWidth` caps the width actually read back, and drawImage does the
// downscale on the GPU during the same blit. Detection never uses it — a
// rescaled frame is a rescaled camera model, and corners are refined at native
// resolution on purpose — but the feature tracker wants a small image and
// nothing else, and asking for it here is far cheaper than reading back a 4K
// luma plane only to shrink it in the wasm heap.
function createCanvasLumaSource(cv, { maxWidth = 0 } = {}) {
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(2, 2)
    : document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let rgba = null;
  let gray = null;

  function ensure(w, h) {
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    rgba?.delete();
    gray?.delete();
    rgba = new cv.Mat(h, w, cv.CV_8UC4);
    gray = new cv.Mat(h, w, cv.CV_8UC1);
  }

  return {
    // `rect` in source pixels, omitted for the whole frame. Returns the Mat, the
    // rectangle actually read (rounded out) and the factor the Mat is scaled by
    // against that rectangle, or null if the source has no frame yet. The Mat is
    // owned here and valid until the next call.
    luma(image, rect) {
      const fw = image.videoWidth ?? image.displayWidth ?? image.width;
      const fh = image.videoHeight ?? image.displayHeight ?? image.height;
      if (!fw || !fh) return null;
      const r = rect ? evenRect(rect, fw, fh) : { x: 0, y: 0, w: fw, h: fh };
      const dw = maxWidth && r.w > maxWidth ? maxWidth : r.w;
      const dh = dw === r.w ? r.h : Math.max(1, Math.round(r.h * (dw / r.w)));
      ensure(dw, dh);
      ctx.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, dw, dh);
      rgba.data.set(ctx.getImageData(0, 0, dw, dh).data);
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      return { mat: gray, rect: r, scale: dw / r.w };
    },
    dispose() {
      rgba?.delete();
      gray?.delete();
      rgba = gray = null;
    },
  };
}

// Plane 0 of every YUV format *is* the grayscale image, so a camera frame needs
// no conversion at all — copying the luma plane is the whole job. A tightly
// packed layout with luma first puts the Y plane at offset 0 with a stride
// equal to the crop width, which is exactly a cv.Mat's own layout.
// Anything not listed here (an RGBA-backed frame) is left to the canvas source.
function planeLayout(format, w, h) {
  const cw = w >> 1;
  const ch = h >> 1;
  const planes = [{ offset: 0, stride: w }];
  let bytes = w * h;
  const add = (stride, rows) => {
    planes.push({ offset: bytes, stride });
    bytes += stride * rows;
  };
  switch (format) {
    case 'I420': add(cw, ch); add(cw, ch); break;
    case 'I420A': add(cw, ch); add(cw, ch); add(w, h); break;
    case 'I422': add(cw, h); add(cw, h); break;
    case 'I444': add(w, h); add(w, h); break;
    case 'NV12': add(w, ch); break;
    default: return null;
  }
  return { planes, bytes };
}

// Reads straight out of a VideoFrame. This is the fast path: no drawImage, no
// getImageData allocation, no RGBA round trip and no colour conversion —
// copyTo writes the luma plane directly into the wasm heap the detector reads
// from. Returns null for a frame it cannot read this way, so the caller can
// fall back to the canvas source (which takes a VideoFrame just as happily).
function createVideoFrameLumaSource(cv) {
  let buf = null;     // backing Mat, rows sized to hold every plane
  let gray = null;    // header over its first w*h bytes
  let key = '';

  return {
    // Async because VideoFrame.copyTo is. Nothing may allocate in the wasm heap
    // while that is in flight: a heap growth detaches the view copyTo is
    // writing into, so every Mat needed is sized before the await.
    async luma(frame, rect) {
      const fw = frame.codedWidth;
      const fh = frame.codedHeight;
      if (!fw || !fh) return null;
      const r = rect ? evenRect(rect, fw, fh) : { x: 0, y: 0, w: fw, h: fh };
      const layout = planeLayout(frame.format, r.w, r.h);
      if (!layout) return null;

      const want = `${frame.format}:${r.w}x${r.h}`;
      if (key !== want) {
        gray?.delete();
        buf?.delete();
        buf = new cv.Mat(Math.ceil(layout.bytes / r.w), r.w, cv.CV_8UC1);
        gray = buf.roi(new cv.Rect(0, 0, r.w, r.h));
        key = want;
      }
      await frame.copyTo(buf.data, {
        rect: { x: r.x, y: r.y, width: r.w, height: r.h },
        layout: layout.planes,
      });
      return { mat: gray, rect: r };
    },
    dispose() {
      gray?.delete();
      buf?.delete();
      gray = buf = null;
      key = '';
    },
  };
}

// Everything else in this file is browser-only; the corner layout is the one
// definition the server needs (see markerCornersM).
if (typeof module !== 'undefined') {
  module.exports = { markerCornersM };
}
