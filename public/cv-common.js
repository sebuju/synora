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
// Intrinsics persistence. Keyed by lens and resolution, not device identity:
// the same client has independent front/back cameras, and fx/fy/cx/cy are
// resolution-dependent. Same try/catch shape as loadClientId.
//
// A stored record is { fx, fy, cx, cy, dist[5], w, h, rms, savedAtMs,
// orientAngle }. `orientAngle` is the display rotation the views were captured
// at; it may be absent on records written before it was recorded, which is why
// orientIntrinsics has an approximate path. The key format is unchanged for the
// same reason — devices must not lose their calibration.
function intrinsicsKey(facing, w, h) {
  return `streamer-intrinsics:${facing}:${w}x${h}`;
}

function saveIntrinsics(facing, data) {
  try {
    localStorage.setItem(intrinsicsKey(facing, data.w, data.h), JSON.stringify(data));
  } catch {
    // Storage unavailable — calibration just does not survive a reload.
  }
}

function loadStoredIntrinsics(facing, w, h) {
  try {
    const raw = localStorage.getItem(intrinsicsKey(facing, w, h));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
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
  const prefix = `streamer-intrinsics:${facing}:`;
  let best = null;
  let stored = 0;
  try {
    stored = localStorage.length;
  } catch {
    stored = 0;
  }
  for (let i = 0; i < stored; i++) {
    let cand = null;
    try {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      cand = JSON.parse(localStorage.getItem(key));
    } catch {
      // One unparseable entry must not discard every other candidate.
      continue;
    }
    if (!validIntrinsics(cand)) continue;
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
  // Subpixel corner refinement is most of the pose accuracy at range.
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

// Draws through a 2D canvas: the universal path, and the only one available
// when the frame cannot be reached as a VideoFrame. drawImage crops on the GPU,
// so getImageData only ever reads back the crop.
function createCanvasLumaSource(cv) {
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
    // `rect` in source pixels, omitted for the whole frame. Returns the Mat and
    // the rectangle actually read (rounded out), or null if the source has no
    // frame yet. The Mat is owned here and valid until the next call.
    luma(image, rect) {
      const fw = image.videoWidth ?? image.displayWidth ?? image.width;
      const fh = image.videoHeight ?? image.displayHeight ?? image.height;
      if (!fw || !fh) return null;
      const r = rect ? evenRect(rect, fw, fh) : { x: 0, y: 0, w: fw, h: fh };
      ensure(r.w, r.h);
      ctx.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      rgba.data.set(ctx.getImageData(0, 0, r.w, r.h).data);
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      return { mat: gray, rect: r };
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
