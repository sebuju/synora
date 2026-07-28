'use strict';

// ChArUco camera calibration. Captured views are kept as cloned corner/id
// Mats; calibration builds object points directly from corner ids (the
// board's chessboard grid is known geometry) — the matchImagePoints binding
// in this opencv.js build rejects the charuco corner layout, and the manual
// route was verified to recover ground-truth intrinsics synthetically.

const calVideo = document.getElementById('calVideo');
const overlay = document.getElementById('overlay');
const facingSelect = document.getElementById('facingSelect');
const calResSelect = document.getElementById('calResSelect');
const captureBtn = document.getElementById('captureBtn');
const calibrateBtn = document.getElementById('calibrateBtn');
const saveBtn = document.getElementById('saveBtn');
const clearBtn = document.getElementById('clearBtn');
const printBtn = document.getElementById('printBtn');
const viewCount = document.getElementById('viewCount');
const coverageEl = document.getElementById('coverage');
const result = document.getElementById('result');

const CAL_RESOLUTIONS = { '720p': { width: 1280, height: 720 }, '1080p': { width: 1920, height: 1080 } };
const MIN_CORNERS_PER_VIEW = 8;
const TARGET_VIEWS = 15;
const DETECT_INTERVAL_MS = 250;

let cv = null;
let board = null;
let detector = null;
let grabber = null;
let stream = null;
// Latest live detection, cloned in on every tick; capture just adopts it.
let lastCorners = null;
let lastIds = null;
// Captured views: { corners: Mat, ids: Mat, w, h }
const views = [];
let calib = null;   // last calibration result, pending save

const coverageCells = [];
for (let i = 0; i < 9; i++) {
  const cell = document.createElement('div');
  coverageEl.append(cell);
  coverageCells.push(cell);
}

function setResult(text) {
  result.textContent = text;
}

async function startCalCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  const res = CAL_RESOLUTIONS[calResSelect.value];
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facingSelect.value },
      width: { ideal: res.width },
      height: { ideal: res.height },
    },
  });
  calVideo.srcObject = stream;
}

// Switching lens or resolution invalidates every captured view.
function resetViews() {
  for (const v of views) {
    v.corners.delete();
    v.ids.delete();
  }
  views.length = 0;
  calib = null;
  saveBtn.disabled = true;
  calibrateBtn.disabled = true;
  viewCount.textContent = '0 views';
  coverageCells.forEach((c) => c.classList.remove('hit'));
}

function markCoverage(cornersMat, w, h) {
  const data = cornersMat.data32F;
  for (let i = 0; i < cornersMat.rows; i++) {
    const col = Math.min(2, Math.floor((data[i * 2] / w) * 3));
    const row = Math.min(2, Math.floor((data[i * 2 + 1] / h) * 3));
    coverageCells[row * 3 + col].classList.add('hit');
  }
}

function drawOverlay(cornersMat) {
  const ctx = overlay.getContext('2d');
  overlay.width = calVideo.videoWidth;
  overlay.height = calVideo.videoHeight;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!cornersMat) return;
  ctx.fillStyle = '#4caf50';
  const data = cornersMat.data32F;
  for (let i = 0; i < cornersMat.rows; i++) {
    ctx.beginPath();
    ctx.arc(data[i * 2], data[i * 2 + 1], 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function detectTick() {
  if (!cv || !calVideo.videoWidth) return;
  const gray = grabber.grab(calVideo);
  if (!gray) return;
  const chC = new cv.Mat();
  const chI = new cv.Mat();
  const mkC = new cv.MatVector();
  const mkI = new cv.Mat();
  try {
    detector.detectBoard(gray, chC, chI, mkC, mkI);
    const n = chI.rows;
    if (n >= MIN_CORNERS_PER_VIEW) {
      lastCorners?.delete();
      lastIds?.delete();
      lastCorners = chC.clone();
      lastIds = chI.clone();
      captureBtn.disabled = false;
      setStatus(`board: ${n} corners — capture enabled`);
    } else {
      captureBtn.disabled = true;
      setStatus(n > 0 ? `board: only ${n} corners — get closer` : 'board not visible');
    }
    drawOverlay(n > 0 ? chC : null);
  } catch (err) {
    // Surfacing this beats a silently dead capture button; embind sometimes
    // throws raw numbers, hence the String fallback.
    setStatus(`detection error: ${err?.message || String(err)}`);
  } finally {
    chC.delete();
    chI.delete();
    mkC.delete();
    mkI.delete();
  }
}

captureBtn.onclick = () => {
  if (!lastCorners) return;
  // Acknowledge the tap — on a client it is easy to doubt anything happened.
  captureBtn.classList.add('active');
  setTimeout(() => captureBtn.classList.remove('active'), 300);
  const w = calVideo.videoWidth;
  const h = calVideo.videoHeight;
  // Mixed-size views would calibrate against the wrong image size silently.
  if (views.length && (views[0].w !== w || views[0].h !== h)) resetViews();
  views.push({ corners: lastCorners.clone(), ids: lastIds.clone(), w, h });
  markCoverage(lastCorners, w, h);
  viewCount.textContent = `${views.length} views`;
  calibrateBtn.disabled = views.length < 6;
  if (views.length >= TARGET_VIEWS) setResult('Enough views — hit Calibrate.');
};

calibrateBtn.onclick = () => {
  const { w, h } = views[0];
  const objAll = new cv.MatVector();
  const imgAll = new cv.MatVector();
  const K = new cv.Mat();
  const dist = new cv.Mat();
  const rvecs = new cv.MatVector();
  const tvecs = new cv.MatVector();
  const stdI = new cv.Mat();
  const stdE = new cv.Mat();
  const perView = new cv.Mat();
  setStatus('calibrating…');
  try {
    const cols = BOARD_SQUARES_X - 1;
    for (const v of views) {
      const n = v.ids.rows;
      const objArr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const k = v.ids.data32S[i];
        objArr[i * 3] = ((k % cols) + 1) * BOARD_SQUARE_M;
        objArr[i * 3 + 1] = (Math.floor(k / cols) + 1) * BOARD_SQUARE_M;
      }
      const obj = cv.matFromArray(n, 3, cv.CV_32F, objArr);
      objAll.push_back(obj);
      imgAll.push_back(v.corners);
      obj.delete();
    }
    const rms = cv.calibrateCameraExtended(
      objAll, imgAll, new cv.Size(w, h), K, dist, rvecs, tvecs, stdI, stdE, perView);
    const k = [...K.data64F];
    calib = {
      fx: k[0], fy: k[4], cx: k[2], cy: k[5],
      dist: [...dist.data64F].slice(0, 5),
      w, h, rms, savedAtMs: null,
    };
    saveBtn.disabled = false;
    const worst = Math.max(...Array.from({ length: perView.rows }, (_, i) => perView.data64F[i]));
    setResult(
      `RMS ${rms.toFixed(2)} px (worst view ${worst.toFixed(2)} px)` +
      `\nfx ${calib.fx.toFixed(1)}  fy ${calib.fy.toFixed(1)}  cx ${calib.cx.toFixed(1)}  cy ${calib.cy.toFixed(1)} @ ${w}x${h}` +
      `\n${rms < 1 ? 'Good — save it.' : 'High RMS: recapture with a flatter board / steadier hands.'}`);
    setStatus('calibrated');
  } catch (err) {
    setResult(`calibration failed: ${err.message || err}`);
    setStatus('calibration failed');
  } finally {
    objAll.delete();
    imgAll.delete();
    K.delete();
    dist.delete();
    rvecs.delete();
    tvecs.delete();
    stdI.delete();
    stdE.delete();
    perView.delete();
  }
};

saveBtn.onclick = () => {
  if (!calib) return;
  saveIntrinsics(facingSelect.value, { ...calib, savedAtMs: Date.now() });
  setResult(
    `Saved for ${facingSelect.value} @ ${calib.w}x${calib.h} (RMS ${calib.rms.toFixed(2)} px).` +
    '\nThe client page picks this up automatically. Calibrate the other lens too if you use it.');
};

clearBtn.onclick = () => {
  resetViews();
  setResult('Captures cleared.');
};

printBtn.onclick = () => print();

// Board on this screen, for a client to film when there is no printer. Click
// anywhere on it to come back.
const showBoardBtn = document.getElementById('showBoardBtn');
showBoardBtn.onclick = () => document.body.classList.add('show-board');
document.getElementById('boardPrint').onclick = () =>
  document.body.classList.remove('show-board');

facingSelect.onchange = calResSelect.onchange = async () => {
  resetViews();
  try {
    await startCalCamera();
  } catch (err) {
    setStatus(`camera error: ${err.message}`);
  }
};

(async () => {
  try {
    cv = await loadOpenCv();
  } catch (err) {
    setStatus(err.message);
    return;
  }
  board = makeCharucoBoard(cv);
  detector = makeCharucoDetector(cv, board);
  grabber = createFrameGrabber(cv);

  // Render the printable board once: 182x260 mm at ~300 dpi.
  const boardImg = new cv.Mat();
  board.generateImage(new cv.Size(2150, 3071), boardImg, 0, 1);
  cv.imshow(document.getElementById('boardCanvas'), boardImg);
  boardImg.delete();

  try {
    await startCalCamera();
  } catch (err) {
    setStatus(`camera error: ${err.message}`);
    return;
  }
  setStatus('point the camera at the board');
  setInterval(detectTick, DETECT_INTERVAL_MS);
})();
