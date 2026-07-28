'use strict';

// Shared by the calibration page and the client's pose pipeline: on-demand
// OpenCV loading, camera intrinsics persistence, and the marker/board
// definitions both sides must agree on.

// Room tags and the calibration board use different dictionary families on
// purpose: a calibration board lying around in shot must never be readable as
// a room tag, and vice versa.
const ROOM_DICT = 'DICT_4X4_50';
const ROOM_TAG_COUNT = 16;
// Physical tag edge (black border included). Printed and on-screen tags must
// both hit this exactly — it must agree with the server's POSE_CONFIG, or
// every distance in the room scales by the mismatch.
const ROOM_TAG_MM = 150;

const BOARD_DICT = 'DICT_5X5_100';
const BOARD_SQUARES_X = 7;
const BOARD_SQUARES_Y = 10;
const BOARD_SQUARE_M = 0.026;   // 26 mm squares -> 182x260 mm, fits A4 portrait
const BOARD_MARKER_M = 0.019;

// Fallback when a device has never been calibrated: a typical client main
// camera is ~66 degrees horizontal FOV. Good to maybe 5%, which the viewer is
// told about via calibrated:false.
const DEFAULT_HFOV_DEG = 66;

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

// A calibration rotated 90° (portrait <-> landscape): the axes swap, so
// fx/fy and cx/cy trade places. Radial distortion (k1,k2,k3) is
// rotation-invariant; the tangential pair (p1,p2) swaps — its sign depends
// on rotation direction, but at client-lens magnitudes (~1e-4) the
// approximation is far below calibration noise.
function rotateIntrinsics(c) {
  const d = c.dist;
  return {
    fx: c.fy, fy: c.fx, cx: c.cy, cy: c.cx,
    dist: [d[0], d[1], d[3], d[2], d[4]],
    w: c.h, h: c.w, rms: c.rms,
  };
}

// Best available intrinsics for a lens at a given resolution: exact match,
// else the same calibration rotated 90° (device turned), else any stored
// calibration of the lens — rotated if that matches the requested
// orientation — scaled linearly (fx/fy/cx/cy scale with pixel pitch;
// distortion coefficients are dimensionless), else the FOV guess.
// `calibrated` tells consumers which of those they got.
function intrinsicsFor(facing, w, h) {
  const exact = loadStoredIntrinsics(facing, w, h);
  if (exact) return { ...exact, calibrated: true };
  const rotated = loadStoredIntrinsics(facing, h, w);
  if (rotated) return { ...rotateIntrinsics(rotated), calibrated: true };

  let best = null;
  try {
    const prefix = `streamer-intrinsics:${facing}:`;
    const portraitWanted = h > w;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      let cand = JSON.parse(localStorage.getItem(key));
      // Match the requested orientation before scaling — scaling across a
      // rotation is exactly the ~40% focal error this branch exists to avoid.
      if ((cand.h > cand.w) !== portraitWanted) cand = rotateIntrinsics(cand);
      if (!best || Math.abs(cand.w - w) < Math.abs(best.w - w)) best = cand;
    }
  } catch {
    best = null;
  }
  if (best) {
    const s = w / best.w;
    return {
      fx: best.fx * s, fy: best.fy * s, cx: best.cx * s, cy: best.cy * s,
      dist: best.dist, w, h, rms: best.rms, calibrated: true,
    };
  }

  const fx = (w / 2) / Math.tan((DEFAULT_HFOV_DEG / 2) * Math.PI / 180);
  return { fx, fy: fx, cx: w / 2, cy: h / 2, dist: [0, 0, 0, 0, 0], w, h, rms: null, calibrated: false };
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

function makeRoomDetector(cv, profile = 'full') {
  const dict = cv.getPredefinedDictionary(cv[ROOM_DICT]);
  const params = new cv.aruco_DetectorParameters();
  // Subpixel corner refinement is most of the pose accuracy at range.
  params.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX;
  for (const [key, value] of Object.entries(DETECT_PROFILES[profile])) {
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
