'use strict';

// Depth calibration sweep, run from the device that will do the mapping.
//
// The page is deliberately a client: same deviceId, same signaling and bulk
// sockets, same pose pipeline. It just does no WebRTC and no recording. That
// matters because the thing being calibrated is *this* camera at *this*
// keyframe size, and the only way to measure it is through the very path the
// keyframes will later take.
//
// The work is walking: each keyframe with a tag in it contributes one
// (true distance, model output) pair, and the server pools them across frames.
// A single tag carried from 1 m to 4 m sweeps the same axis that two tags at
// different depths would inside one frame — which is why one tag on a wall is
// enough here and never enough there.

const preview = document.getElementById('preview');
const resSelect = document.getElementById('resSelect');
const switchBtn = document.getElementById('switchBtn');
const sweepBtn = document.getElementById('sweepBtn');
const freezeBtn = document.getElementById('freezeBtn');
const clearBtn = document.getElementById('clearBtn');
const unfreezeBtn = document.getElementById('unfreezeBtn');
const plot = document.getElementById('plot');
const readout = document.getElementById('readout');

const RESOLUTIONS = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '4K': { width: 3840, height: 2160 },
};

let facing = 'environment';
let stream = null;
let sweeping = false;
let lastState = null;

const signaling = connectSignaling('client', {
  onOpen() {
    setStatus('connected');
    clockSync.start();
    // The server cancels any sweep when a client connects, so a page that is
    // mid-sweep has to say so again — that is also what makes a plain /client
    // connection reliably end one.
    if (sweeping) sendCal({ action: 'start' });
    else sendCal({ action: 'state' });
  },
  onClose() {
    setStatus('signaling lost, reconnecting…');
  },
  onMessage(msg) {
    if (clockSync.handle(msg)) return;
    if (msg.type === 'pose-config') {
      posePipeline.setConfig(msg);
    } else if (msg.type === 'room-pose') {
      posePipeline.setRoomPose(msg);
    } else if (msg.type === 'depth-cal-state') {
      lastState = msg;
      sweeping = msg.calibrating;
      render();
    } else if (msg.type === 'depth-cal-error') {
      setStatus(`cannot freeze: ${msg.reason}`);
    }
  },
});

const clockSync = createClockSync(signaling);
// Keyframes ride the bulk socket exactly as they do while streaming.
const bulk = connectSignaling('client-bulk', {}, loadDeviceId('client'));

function sendCal(msg) {
  signaling.send({ type: 'depth-cal', ...msg });
}

async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  const res = RESOLUTIONS[resSelect.value];
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: res.width },
      height: { ideal: res.height },
    },
  });
  preview.srcObject = stream;
  posePipeline.onCameraChanged(facing);
}

// ---------------------------------------------------------------------------
// Readout and scatter.

function fmtFit(f) {
  return `a=${f.a.toFixed(4)}  b=${f.b.toFixed(4)}`;
}

function render() {
  const s = lastState;
  sweepBtn.textContent = sweeping ? 'Stop sweep' : 'Start sweep';
  sweepBtn.classList.toggle('active', sweeping);
  if (!s) {
    readout.textContent = 'waiting for the server';
    return;
  }
  const lines = [];
  lines.push(s.key ? `camera: ${s.key}` : 'camera: no keyframe seen yet — is a tag in view?');
  lines.push(`samples: ${s.samples}`);
  if (s.fit) {
    lines.push(`live fit: ${fmtFit(s.fit)}  ·  ${s.fit.inliers} agree  ·  ` +
      `${s.fit.zMin.toFixed(2)}–${s.fit.zMax.toFixed(2)} m  ·  ` +
      `residual ${(s.fit.rms * 100).toFixed(1)}%`);
  }
  lines.push(s.blockers.length ? `cannot freeze: ${s.blockers.join('; ')}` : 'ready to freeze');
  lines.push(s.frozen
    ? `frozen: ${fmtFit(s.frozen)}  ·  residual ${(s.frozen.rms * 100).toFixed(1)}%  ·  ${s.frozen.at}`
    : 'frozen: none — mapping ignores this camera until you freeze one');
  // Rotating the phone changes the keyframe size, which is a different camera
  // as far as the calibration is concerned. Showing the other frozen ones is
  // what makes "landscape maps nothing" visible instead of mysterious.
  if (s.others?.length) {
    lines.push(`also calibrated: ${s.others.map((o) => o.key.split('|')[1]).join(', ')}`);
  }
  readout.textContent = lines.join('\n');
  drawPlot(s);
}

// Plotted against 1/distance, because that is the axis the calibration is a
// straight line in — a curve here would mean the two numbers cannot describe
// this camera, and that is worth being able to see.
function drawPlot(s) {
  const ctx = plot.getContext('2d');
  const W = plot.width;
  const H = plot.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  const pad = { l: 54, r: 12, t: 12, b: 30 };
  const pts = s.points || [];
  if (!pts.length) {
    ctx.fillStyle = '#666';
    ctx.font = '16px ui-monospace, monospace';
    ctx.fillText('no samples yet', pad.l, H / 2);
    return;
  }

  const xs = pts.map((p) => 1 / p.z);
  const ys = pts.map((p) => p.y);
  const xMin = 0;
  const xMax = Math.max(...xs) * 1.1;
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  const padY = (yMax - yMin) * 0.1 || 0.1;
  yMin -= padY;
  yMax += padY;
  const sx = (x) => pad.l + (x - xMin) / (xMax - xMin || 1) * (W - pad.l - pad.r);
  const sy = (y) => H - pad.b - (y - yMin) / (yMax - yMin || 1) * (H - pad.t - pad.b);

  // Distance ticks: the axis is 1/z, the labels are metres.
  ctx.strokeStyle = '#2a2a2a';
  ctx.fillStyle = '#777';
  ctx.font = '14px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (const z of [0.5, 0.75, 1, 1.5, 2, 3, 5, 8]) {
    const x = sx(1 / z);
    if (x < pad.l || x > W - pad.r) continue;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, H - pad.b);
    ctx.stroke();
    ctx.fillText(`${z} m`, x - 14, H - 10);
  }

  const line = (fit, color, dashed) => {
    if (!fit) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dashed ? [6, 5] : []);
    ctx.beginPath();
    ctx.moveTo(sx(xMin), sy(fit.a * xMin + fit.b));
    ctx.lineTo(sx(xMax), sy(fit.a * xMax + fit.b));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  line(s.frozen, '#6a8fc8', true);
  line(s.fit, '#2e8b47', false);

  for (const p of pts) {
    ctx.fillStyle = p.in ? '#4fbf6f' : '#c86a6a';
    ctx.beginPath();
    ctx.arc(sx(1 / p.z), sy(p.y), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------

sweepBtn.onclick = () => {
  sweeping = !sweeping;
  sendCal({ action: sweeping ? 'start' : 'stop' });
  render();
};
freezeBtn.onclick = () => sendCal({ action: 'freeze' });
clearBtn.onclick = () => sendCal({ action: 'clear' });
unfreezeBtn.onclick = () => sendCal({ action: 'unfreeze' });

switchBtn.onclick = async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  try {
    await startCamera();
  } catch (err) {
    setStatus(`camera switch failed: ${err.message}`);
  }
};

resSelect.onchange = async () => {
  try {
    await startCamera();
  } catch (err) {
    setStatus(`resolution change failed: ${err.message}`);
  }
  // Keyframe size is part of the calibration's identity, so the samples
  // already collected belong to the resolution that produced them. The server
  // pools per key, so nothing is lost — it just starts a different pool.
  sendCal({ action: 'state' });
};

(async () => {
  posePipeline.init({ video: preview, signaling, bulk, clockSync });
  try {
    await posePipeline.setEnabled(true);
  } catch (err) {
    setStatus(`marker tracking failed: ${err.message}`);
    return;
  }
  try {
    await startCamera();
  } catch (err) {
    setStatus(`camera failed: ${err.message}`);
    return;
  }
  setStatus('point at a tag, then start the sweep');
  render();
})();
