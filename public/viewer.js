'use strict';

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const muteBtn = document.getElementById('muteBtn');

// phoneId -> { pc, tile, video, label, camBtn }
const devices = new Map();
let soundOn = false;
let vcamAvailable = false;
let vcamPhoneId = null;

const signaling = connectSignaling('viewer', {
  onOpen() {
    clockSync.start();
    updateStatus();
  },
  onClose() {
    setStatus('signaling lost, reconnecting…');
    for (const id of [...devices.keys()]) removeDevice(id);
  },
  async onMessage(msg) {
    if (clockSync.handle(msg)) return;
    if (msg.type === 'rtp-map') {
      const dev = devices.get(msg.phoneId);
      if (dev) updateRtpMap(dev, { rtp: msg.rtp, serverTime: msg.serverTime });
      return;
    }
    if (msg.type === 'offer') {
      await acceptOffer(msg.phoneId, msg.description);
    } else if (msg.type === 'ice') {
      const dev = devices.get(msg.phoneId);
      try {
        await dev?.pc.addIceCandidate(msg.candidate);
      } catch {
        // Stale candidate from a previous connection — ignore.
      }
    } else if (msg.type === 'phone-gone') {
      removeDevice(msg.phoneId);
    } else if (msg.type === 'vcam-state') {
      if (msg.available !== undefined) vcamAvailable = msg.available;
      vcamPhoneId = msg.phoneId;
      for (const [id, d] of devices) updateCamBtn(id, d);
    }
  },
});

const clockSync = createClockSync(signaling);

function updateCamBtn(phoneId, dev) {
  dev.camBtn.style.display = vcamAvailable ? '' : 'none';
  dev.camBtn.textContent = phoneId === vcamPhoneId ? 'Webcam ✓' : 'Webcam';
  dev.camBtn.classList.toggle('active', phoneId === vcamPhoneId);
}

function updateStatus() {
  const n = devices.size;
  setStatus(n === 0 ? 'no devices' : `${n} device${n === 1 ? '' : 's'} live`);
  empty.style.display = n === 0 ? '' : 'none';
}

function ensureDevice(phoneId) {
  let dev = devices.get(phoneId);
  if (dev) return dev;

  const tile = document.createElement('div');
  tile.className = 'tile';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = !soundOn;
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `Phone ${phoneId}`;
  const camBtn = document.createElement('button');
  camBtn.className = 'cam-btn';
  camBtn.onclick = (ev) => {
    ev.stopPropagation();
    signaling.send({ type: 'vcam', phoneId: phoneId === vcamPhoneId ? null : phoneId });
  };
  tile.append(video, label, camBtn);
  // Click a tile to enlarge it; click again to go back to the grid.
  tile.onclick = () => {
    const zoomed = tile.classList.contains('zoom');
    for (const d of devices.values()) d.tile.classList.remove('zoom');
    if (!zoomed) tile.classList.add('zoom');
  };
  grid.append(tile);

  dev = {
    pc: null, tile, video, label, camBtn,
    frames: [], lastFrame: null, latency: null, capturing: false, rtpMap: null,
  };
  devices.set(phoneId, dev);
  updateCamBtn(phoneId, dev);
  updateStatus();
  return dev;
}

function removeDevice(phoneId) {
  const dev = devices.get(phoneId);
  if (!dev) return;
  dev.pc?.close();
  dev.tile.remove();
  dropFrames(dev);
  devices.delete(phoneId);
  updateStatus();
}

async function acceptOffer(phoneId, description) {
  const dev = ensureDevice(phoneId);
  dev.pc?.close();
  dev.pc = new RTCPeerConnection(RTC_CONFIG);
  dev.pc.ontrack = (ev) => {
    dev.video.srcObject = ev.streams[0];
  };
  dev.pc.onicecandidate = (ev) => {
    if (ev.candidate) signaling.send({ type: 'ice', phoneId, candidate: ev.candidate });
  };
  dev.pc.onconnectionstatechange = () => {
    if (!dev.pc) return;
    dev.label.textContent =
      dev.pc.connectionState === 'connected'
        ? `Phone ${phoneId}`
        : `Phone ${phoneId} — ${dev.pc.connectionState}`;
  };
  await dev.pc.setRemoteDescription(description);
  const answer = await dev.pc.createAnswer();
  await dev.pc.setLocalDescription(answer);
  signaling.send({ type: 'answer', phoneId, description: dev.pc.localDescription });
  startFrameCapture(phoneId, dev);
}

// ---------------------------------------------------------------------------
// Combined view: composite every live feed onto one canvas — a single video
// surface tiling all devices, drawn each frame.
const combined = document.getElementById('combined');
const combinedBtn = document.getElementById('combinedBtn');
const backdrop = document.getElementById('backdrop');
const syncLabel = document.getElementById('syncLabel');
const ctx = combined.getContext('2d');
let combinedActive = false;

// --- Frame synchronisation -------------------------------------------------
// Phones deliver frames with different end-to-end latency, so a naive
// composite mixes moments that were captured milliseconds apart. Each phone
// publishes pairings of RTP timestamp and capture time on the shared server
// clock; every frame carries its RTP timestamp, so its capture instant follows
// from the 90 kHz RTP clock. Feeds are then held back to match the slowest one.
const SYNC_BUFFER_MAX = 20;    // frames held per device
// Cushion of roughly two frames. It buys the latency needed for a frame
// captured just after the presentation instant to have arrived, so the nearest
// frame can be picked from either side of it; a shorter cushion leaves only
// already-past frames to choose from and the error grows to a full frame.
const SYNC_MARGIN_MS = 70;
let syncTargetLatency = 0;
let syncSupported = false;

// Pairings are stamped when a frame is encoded, so each carries the encode
// delay of that particular frame on top of the capture instant. Encode delay
// is always positive, so the sample implying the earliest capture is the
// truest one — the same reasoning that makes the lowest-RTT clock probe win.
const RTP_MAP_RELAX_MS = 0.3;  // per sample, so slow clock drift is tracked

function updateRtpMap(dev, sample) {
  if (!dev.rtpMap) {
    dev.rtpMap = sample;
    return;
  }
  const predicted = dev.rtpMap.serverTime + rtpDeltaMs(sample.rtp, dev.rtpMap.rtp);
  if (sample.serverTime <= predicted + RTP_MAP_RELAX_MS) dev.rtpMap = sample;
}

// Capture instant of a frame, on the server clock — null until the owning
// phone has published a pairing.
function captureTimeOf(dev, rtpTimestamp) {
  if (!dev.rtpMap || !clockSync.synced) return null;
  return dev.rtpMap.serverTime + rtpDeltaMs(rtpTimestamp, dev.rtpMap.rtp);
}

function startFrameCapture(phoneId, dev) {
  if (!dev.video.requestVideoFrameCallback || dev.capturing) return;
  dev.capturing = true;
  dev.frames = [];
  dev.latency = null;

  const onFrame = (now, meta) => {
    if (!devices.has(phoneId)) {
      dev.capturing = false;
      return;
    }
    const captureTime = captureTimeOf(dev, meta.rtpTimestamp);
    if (captureTime !== null) {
      const latency = clockSync.now() - captureTime;
      // Track latency with a slow decay so a single late frame can't yank the
      // whole composite backwards.
      dev.latency = dev.latency === null ? latency : Math.max(latency, dev.latency * 0.98);
      if (combinedActive) bufferFrame(dev, captureTime);
    } else {
      dev.latency = null;
    }
    dev.video.requestVideoFrameCallback(onFrame);
  };
  dev.video.requestVideoFrameCallback(onFrame);
}

function bufferFrame(dev, captureTime) {
  if (dev.video.videoWidth === 0) return;
  createImageBitmap(dev.video).then((bitmap) => {
    if (!dev.frames) {
      bitmap.close();
      return;
    }
    dev.frames.push({ bitmap, captureTime });
    while (dev.frames.length > SYNC_BUFFER_MAX) dev.frames.shift().bitmap.close();
    if (dev.lastFrame && !dev.frames.includes(dev.lastFrame)) dev.lastFrame = dev.frames[0];
  }).catch(() => {});
}

// The buffer owns every bitmap; lastFrame only points at its head.
function dropFrames(dev) {
  dev.frames?.forEach((f) => f.bitmap.close());
  dev.frames = [];
  dev.lastFrame = null;
}

// Pick the frame each feed should be showing right now: the one captured
// closest to the shared presentation instant. Picking the nearest frame rather
// than the newest already-due one halves the alignment error, since the
// nearest may sit just after the instant rather than up to a frame before it.
function dueFrame(dev, now) {
  const frames = dev.frames;
  if (!frames?.length) return dev.lastFrame;
  const target = now - syncTargetLatency;

  let bestIdx = 0;
  let bestErr = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const err = Math.abs(frames[i].captureTime - target);
    if (err > bestErr) break;   // capture times ascend: past the nearest one
    bestErr = err;
    bestIdx = i;
  }

  for (let i = 0; i < bestIdx; i++) frames[i].bitmap.close();
  frames.splice(0, bestIdx);
  dev.lastFrame = frames[0];
  return dev.lastFrame;
}

function drawCombined() {
  if (!combinedActive) return;
  const now = clockSync.now();
  const feeds = [...devices.entries()].filter(([, d]) => d.video.videoWidth > 0);

  const latencies = feeds.map(([, d]) => d.latency).filter((l) => l !== null);
  syncSupported = latencies.length === feeds.length && feeds.length > 0;
  if (syncSupported) {
    syncTargetLatency = Math.max(...latencies) + SYNC_MARGIN_MS;
    const spread = Math.round(Math.max(...latencies) - Math.min(...latencies));
    syncLabel.textContent = `sync ±${spread} ms`;
  } else {
    feeds.forEach(([, d]) => dropFrames(d));
    syncLabel.textContent = feeds.length ? 'sync unavailable' : '';
  }

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, combined.width, combined.height);
  const n = feeds.length;
  if (n > 0) {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cw = combined.width / cols;
    const ch = combined.height / rows;
    ctx.font = '24px system-ui, sans-serif';
    feeds.forEach(([id, d], i) => {
      const cx = (i % cols) * cw;
      const cy = Math.floor(i / cols) * ch;
      // Synced feeds draw a buffered frame; otherwise fall back to live video.
      const frame = syncSupported ? dueFrame(d, now) : null;
      const source = frame ? frame.bitmap : d.video;
      const sw = frame ? frame.bitmap.width : d.video.videoWidth;
      const sh = frame ? frame.bitmap.height : d.video.videoHeight;
      // Aspect-fit the feed inside its cell.
      const scale = Math.min(cw / sw, ch / sh);
      const w = sw * scale;
      const h = sh * scale;
      ctx.drawImage(source, cx + (cw - w) / 2, cy + (ch - h) / 2, w, h);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(cx + 12, cy + ch - 46, 110, 34);
      ctx.fillStyle = '#eee';
      ctx.fillText(`Phone ${id}`, cx + 20, cy + ch - 22);
    });
  }
  requestAnimationFrame(drawCombined);
}

combinedBtn.onclick = () => {
  combinedActive = !combinedActive;
  combinedBtn.textContent = `Combined: ${combinedActive ? 'on' : 'off'}`;
  backdrop.style.display = combinedActive ? 'block' : '';
  combined.style.display = combinedActive ? 'block' : '';
  if (combinedActive) {
    drawCombined();
  } else {
    syncLabel.textContent = '';
    for (const dev of devices.values()) dropFrames(dev);
  }
};

// Fullscreen the active view: the combined canvas, or the tile grid.
fullscreenBtn.onclick = () => {
  (combinedActive ? combined : grid).requestFullscreen?.();
};

muteBtn.onclick = () => {
  soundOn = !soundOn;
  muteBtn.textContent = `Sound: ${soundOn ? 'on' : 'off'}`;
  for (const dev of devices.values()) dev.video.muted = !soundOn;
};
