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

function loadOpenCv() {
  cvLoadPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/opencv.js';
    script.onerror = () => reject(new Error('failed to load /vendor/opencv.js'));
    script.onload = () => {
      const mod = window.cv;
      if (typeof mod?.then === 'function') {
        mod.then((ready) => {
          // Old emscripten makes the Module itself thenable, and its `then`
          // re-invokes with the Module — resolving a promise with it makes
          // promise adoption recurse forever (the page pegs a core and every
          // `await loadOpenCv()` hangs). Strip it before it can be awaited.
          delete ready.then;
          window.cv = ready;
          resolve(ready);
        });
      } else if (mod?.Mat) {
        resolve(mod);
      } else if (mod) {
        mod.onRuntimeInitialized = () => resolve(mod);
      } else {
        reject(new Error('opencv.js loaded but defined no cv global'));
      }
    };
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
function makeRoomDetector(cv) {
  const dict = cv.getPredefinedDictionary(cv[ROOM_DICT]);
  const params = new cv.aruco_DetectorParameters();
  // Subpixel corner refinement is most of the pose accuracy at range.
  params.cornerRefinementMethod = cv.CORNER_REFINE_SUBPIX;
  // ArUco3 mode: candidate search happens on a downscaled image, corners are
  // still refined at full resolution — several times faster at 1080p on a
  // client, which is where this runs per frame.
  params.useAruco3Detection = true;
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
// Pulls grayscale frames out of a <video> for detection. The canvas and Mats
// are reused across frames — allocating per frame at 6 Hz leaks wasm heap
// long before GC notices.
function createFrameGrabber(cv) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let rgba = null;
  let gray = null;

  return {
    // The canvas always holds the most recently grabbed frame — keyframe
    // capture reuses it instead of drawing the video a second time.
    canvas,
    // Returns a gray Mat owned by the grabber, valid until the next grab().
    // Optional target size downscales while drawing — detection above ~1080p
    // buys little corner accuracy and the getImageData copy alone gets huge.
    grab(video, tw, th) {
      const w = tw || video.videoWidth;
      const h = th || video.videoHeight;
      if (!w || !h) return null;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        rgba?.delete();
        gray?.delete();
        rgba = new cv.Mat(h, w, cv.CV_8UC4);
        gray = new cv.Mat(h, w, cv.CV_8UC1);
      }
      ctx.drawImage(video, 0, 0, w, h);
      rgba.data.set(ctx.getImageData(0, 0, w, h).data);
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      return gray;
    },
    dispose() {
      rgba?.delete();
      gray?.delete();
      rgba = gray = null;
    },
  };
}
