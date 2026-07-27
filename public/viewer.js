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
    updateStatus();
  },
  onClose() {
    setStatus('signaling lost, reconnecting…');
    for (const id of [...devices.keys()]) removeDevice(id);
  },
  async onMessage(msg) {
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

  dev = { pc: null, tile, video, label, camBtn };
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
}

// ---------------------------------------------------------------------------
// Combined view: composite every live feed onto one canvas — a single video
// surface tiling all devices, drawn each frame.
const combined = document.getElementById('combined');
const combinedBtn = document.getElementById('combinedBtn');
const ctx = combined.getContext('2d');
let combinedActive = false;

function drawCombined() {
  if (!combinedActive) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, combined.width, combined.height);
  const feeds = [...devices.entries()].filter(([, d]) => d.video.videoWidth > 0);
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
      // Aspect-fit the feed inside its cell.
      const scale = Math.min(cw / d.video.videoWidth, ch / d.video.videoHeight);
      const w = d.video.videoWidth * scale;
      const h = d.video.videoHeight * scale;
      ctx.drawImage(d.video, cx + (cw - w) / 2, cy + (ch - h) / 2, w, h);
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
  grid.style.display = combinedActive ? 'none' : '';
  combined.style.display = combinedActive ? 'block' : '';
  if (combinedActive) drawCombined();
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
