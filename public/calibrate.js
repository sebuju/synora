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
const storedEl = document.getElementById('stored');

// Labels are the familiar landscape names, but these are `ideal` constraints and
// a client hands back whatever it likes — commonly the portrait transpose. What
// is stored is always the size the track actually produced. 1440p and 4K are
// here because the client streams at 4K by default and a model calibrated at the
// streaming resolution beats one rescaled into it.
const CAL_RESOLUTIONS = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '4K': { width: 3840, height: 2160 },
};
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
// Display rotation when the first view of the current set was captured. Recorded
// so a later 90° turn can be un-rotated exactly: without it the principal point
// can only be transposed, which describes a mirrored camera. Taken at capture
// rather than at save because the two can be minutes and a rotation apart.
let calOrientAngle = null;

const coverageCells = [];
for (let i = 0; i < 9; i++) {
  const cell = document.createElement('div');
  coverageEl.append(cell);
  coverageCells.push(cell);
}

function setResult(text) {
  result.textContent = text;
}

// What is already stored for this lens, and whether each entry knows the
// orientation it was captured at. Without that list there is no way to tell
// from the page that a resolution or an orientation is still uncovered — and an
// uncovered one silently becomes a derived model on the client.
function showStored() {
  const rows = listIntrinsics(facingSelect.value).map((c) => {
    const shape = c.h > c.w ? 'portrait' : 'landscape';
    return `${c.w}x${c.h}  ${shape}  `
      + `rms ${Number.isFinite(c.rms) ? `${c.rms.toFixed(2)} px` : 'unknown'}  `
      + (Number.isFinite(c.orientAngle)
        ? `at ${c.orientAngle}°`
        : 'no orientation recorded — recalibrate to allow exact un-rotation');
  });
  rows.sort();
  // The requested size and the delivered one routinely differ: these are `ideal`
  // constraints, and a client commonly hands back the portrait transpose. The
  // delivered size is what gets stored and what the client will look up, so it
  // is the one worth showing.
  const want = CAL_RESOLUTIONS[calResSelect.value];
  const got = calVideo.videoWidth
    ? `${calVideo.videoWidth}x${calVideo.videoHeight}`
    : '—';
  const head = `capturing at ${got} (asked ${want.width}x${want.height})`
    + `${Number.isFinite(displayAngle()) ? `, display ${displayAngle()}°` : ''}`;
  storedEl.textContent = `${head}\n${rows.length
    ? `stored for this lens:\n${rows.join('\n')}`
    : 'no stored calibrations for this lens'}`;
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

// The delivered track size is only known once metadata lands, and it changes
// when the device is turned — both are worth reflecting in the stored list.
calVideo.addEventListener('loadedmetadata', showStored);
calVideo.addEventListener('resize', showStored);
if (typeof screen !== 'undefined') {
  screen.orientation?.addEventListener?.('change', showStored);
}

// Switching lens or resolution invalidates every captured view.
function resetViews() {
  for (const v of views) {
    v.corners.delete();
    v.ids.delete();
  }
  views.length = 0;
  calib = null;
  calOrientAngle = null;
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
  const grabbed = grabber.luma(calVideo);
  if (!grabbed) return;
  const gray = grabbed.mat;
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
  if (!views.length) calOrientAngle = displayAngle();
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
      w, h, rms, savedAtMs: null, orientAngle: calOrientAngle,
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

saveBtn.onclick = async () => {
  if (!calib) return;
  saveBtn.disabled = true;
  const stored = await saveIntrinsics(facingSelect.value, { ...calib, savedAtMs: Date.now() });
  showStored();
  if (!stored) {
    // The store took it, so this tab still works — but nothing else will ever
    // see it. Saying "saved" here would be the one lie that costs a calibration.
    saveBtn.disabled = false;
    setResult('NOT SAVED — the server did not accept the calibration.'
      + '\nIt is live in this tab only and will be lost on reload.'
      + '\nCheck the server is running, then save again.');
    setStatus('save failed');
    return;
  }
  const turned = calib.h > calib.w ? 'landscape' : 'portrait';
  setResult(
    `Saved for ${facingSelect.value} @ ${calib.w}x${calib.h} (RMS ${calib.rms.toFixed(2)} px).` +
    '\nThe client page picks this up automatically.' +
    `\n\nNow turn the client 90° to ${turned} and do it again. A calibration only` +
    '\ndescribes the orientation it was captured in; used in the other one it has to' +
    '\nbe rotated, and a rotated model is a derived model. Calibrate the other lens' +
    '\ntoo if you use it, and the resolution you actually stream at.');
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
  showStored();
  try {
    await startCalCamera();
  } catch (err) {
    setStatus(`camera error: ${err.message}`);
  }
};

(async () => {
  // A calibration belongs to a device, not to a browser: this page has to know
  // which device it is speaking for before it can list what is stored, and
  // certainly before it saves anything. The chip names it and opens the picker,
  // which is how a phone that has forgotten its id gets its calibrations back
  // instead of recapturing fifteen views.
  const device = await resolveDevice('client');
  await initIntrinsics(device);
  const label = document.getElementById('clientLabel');
  label.textContent = device.name || 'unnamed device';
  wireDeviceChip(label, 'client');
  showStored();

  try {
    cv = await loadOpenCv();
  } catch (err) {
    setStatus(err.message);
    return;
  }
  board = makeCharucoBoard(cv);
  detector = makeCharucoDetector(cv, board);
  grabber = createCanvasLumaSource(cv);

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
