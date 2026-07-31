'use strict';

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const muteBtn = document.getElementById('muteBtn');

// clientId -> { pc, tile, video, label, camBtn }
const devices = new Map();
// clientId -> the state the server reports for it. Separate from `devices`
// because the two answer different questions: `devices` is "is there a video
// feed", the roster is "is there a client at all". An XR client only ever
// appears in the roster, and a client whose peer connection has not come up yet
// appears there first.
const roster = new Map();
// clientId -> { at, ms } while that client's ARCore tracking is down. Kept
// separately from `devices` because an XR client never opens a peer connection
// and so never gets a device entry at all — the state has to survive without
// one, or the clients most likely to lose tracking are the ones that cannot
// report it.
const trackingLost = new Map();
// The client re-sends every second while it is lost; three missed in a row is a
// client that stopped reporting rather than one that is still stuck.
const LOST_STALE_MS = 3500;
let soundOn = false;
let vcamAvailable = false;
let vcamClientId = null;
// Room-frame marker map, as surveyed by the server. Null until it arrives.
let markerMap = null;

const signaling = connectSignaling('viewer', {
  onOpen() {
    clockSync.start();
    updateStatus();
  },
  onClose() {
    setStatus('signaling lost, reconnecting…');
    // Everything known about the clients came over this socket; none of it
    // survives it. The server re-sends the roster on reconnect.
    roster.clear();
    poses.clear();
    trackingLost.clear();
    for (const id of [...devices.keys()]) removeDevice(id);
    refreshClientsPanel();
  },
  async onMessage(msg) {
    if (clockSync.handle(msg)) return;
    if (msg.type === 'rtp-map') {
      const dev = devices.get(msg.clientId);
      if (dev) {
        updateRtpMap(dev, { rtp: msg.rtp, serverTime: msg.serverTime });
        if (msg.unc !== undefined) dev.clockUnc = msg.unc;
      }
      return;
    }
    if (msg.type === 'pose') {
      updatePoseLabel(msg.clientId, msg);
      return;
    }
    // A client whose ARCore tracking dropped stops sending poses entirely, so
    // without this it simply fades out of the roster and the room views as if
    // it had been unplugged. It is still there and still connected; it just
    // cannot see. Saying so is the difference between a diagnosable state and
    // a client that "randomly disappears".
    if (msg.type === 'client-tracking') {
      trackingLost.set(msg.clientId, msg.lost ? { at: performance.now(), ms: msg.ms } : null);
      if (!msg.lost) trackingLost.delete(msg.clientId);
      return;
    }
    if (msg.type === 'client-list') {
      roster.clear();
      for (const c of msg.clients) roster.set(c.clientId, c);
      updateStatus();
      updateLabels();
      refreshClientsPanel();
      return;
    }
    if (msg.type === 'marker-map') {
      markerMap = msg;
      roomViewList.forEach((v) => v.setMarkerMap(msg));
      return;
    }
    // Carved free space and wall segments. Optional chaining because only the
    // 2D views render them — the 3D scene opts out by not having the setter.
    if (msg.type === 'floor') {
      roomViewList.forEach((v) => v.setFloor?.(msg));
      return;
    }
    if (msg.type === 'walls') {
      roomViewList.forEach((v) => v.setWalls?.(msg.walls));
      return;
    }
    if (msg.type === 'offer') {
      await acceptOffer(msg.clientId, msg.description);
    } else if (msg.type === 'ice') {
      const dev = devices.get(msg.clientId);
      try {
        await dev?.pc.addIceCandidate(msg.candidate);
      } catch {
        // Stale candidate from a previous connection — ignore.
      }
    } else if (msg.type === 'client-gone') {
      trackingLost.delete(msg.clientId);
      poses.delete(msg.clientId);
      // Not folded into removeDevice: a client with no tile has no device entry
      // to remove, and an XR client never has one — it would have left its dot
      // sitting in the room views forever.
      roomViewList.forEach((v) => v.removeClient(msg.clientId));
      removeDevice(msg.clientId);
    } else if (msg.type === 'vcam-state') {
      if (msg.available !== undefined) vcamAvailable = msg.available;
      vcamClientId = msg.clientId;
      for (const [id, d] of devices) updateCamBtn(id, d);
    }
  },
});

const clockSync = createClockSync(signaling);

// The one place the webcam assignment is sent from: a tile's button and the
// client drawer's both target the same single server-side state, and null is
// how it is cleared.
function setVcam(clientId) {
  signaling.send({ type: 'vcam', clientId });
}

// The tile caption is where a feed is actually identified, so it carries the
// device's name once there is one — the client number stays because it is the
// prefix on that client's recording filenames.
function tileLabel(clientId) {
  const name = roster.get(clientId)?.name;
  const dev = devices.get(clientId);
  const state = dev?.pc && dev.pc.connectionState !== 'connected'
    ? ` — ${dev.pc.connectionState}` : '';
  return `${name ? `${name} · client${clientId}` : `Client ${clientId}`}${state}`;
}

function updateLabels() {
  for (const [id, dev] of devices) dev.label.textContent = tileLabel(id);
}

function updateCamBtn(clientId, dev) {
  dev.camBtn.style.display = vcamAvailable ? '' : 'none';
  dev.camBtn.textContent = clientId === vcamClientId ? 'Webcam ✓' : 'Webcam';
  dev.camBtn.classList.toggle('active', clientId === vcamClientId);
}

// Camera-frame readout on the tile: which tags this client sees and how far
// the nearest one is. Goes stale quickly — a client that stops reporting
// (disabled, backgrounded) must not keep showing a distance.
const POSE_LABEL_TTL_MS = 2000;

// The room views' uncertainty ring: where this client probably is, and how
// tightly, as the server measured it over its recent fixes. Both halves have
// the phone's own motion divided out (ARCore knows it exactly), so the ring
// describes the fix and not the walk — it does not swell just because the
// client is moving, and its centre does not trail a window behind them. The
// ring is the distribution, the dot is a single draw from it, and tying the
// ring to the dot made the steadier of the two inherit the jitter of the
// noisier.
// Only the XR path reports any of this (it needs the phone's own pose to
// separate real motion from fix noise), so anything else gets radius 0 and
// draws no ring rather than inventing one.
function uncertaintyOf(msg) {
  const j = msg.room?.jitter;
  return { r: (j?.jitterMm ?? 0) / 1000, p: j?.centre ?? null };
}

// clientId -> { msg, at } for the newest pose, whether or not that client has a
// tile. A client with no tile is not a client with no position: the XR client
// positions and maps without streaming, so it never opens a peer connection and
// never gets a device entry — and it is the one whose position matters most.
const poses = new Map();

function updatePoseLabel(clientId, msg) {
  poses.set(clientId, { msg, at: performance.now() });
  const tags = msg.tags || [];
  if (msg.room?.pose) {
    const seen = tags.map((t) => t.id);
    roomViewList.forEach((v) =>
      v.updateClient(clientId, msg.room.pose, seen, uncertaintyOf(msg)));
  }
  // Only the per-tile label below needs a tile to live on.
  const dev = devices.get(clientId);
  if (!dev) return;
  clearTimeout(dev.poseLabelTimer);
  if (tags.length) {
    const ids = tags.map((t) => t.id).join(',');
    const room = msg.room?.pose
      ? ` · [${msg.room.pose.p.map((v) => v.toFixed(2)).join(', ')}] ${msg.room.quality}`
      : '';
    // Same wording as the client's own overlay, and coloured for the same
    // reason: a derived camera model makes every position on this tile
    // unverified, which "uncalibrated" alone did not say.
    const model = describeCameraModel(msg);
    dev.poseLabel.textContent =
      `tags ${ids}${room}${model.level === 'ok' ? '' : ` · ${model.text}`}`;
    dev.poseLabel.classList.toggle('bad', model.level === 'bad');
    dev.poseLabel.classList.toggle('warn', model.level === 'warn');
  } else {
    dev.poseLabel.textContent = 'no tags';
    dev.poseLabel.classList.remove('bad', 'warn');
  }
  dev.poseLabelTimer = setTimeout(() => {
    dev.poseLabel.textContent = '';
  }, POSE_LABEL_TTL_MS);
}

// Connected and streaming are different counts, and reporting only the second
// made a room full of XR clients read as "no devices": they position without
// ever opening a peer connection.
function updateStatus() {
  const streaming = devices.size;
  const total = Math.max(streaming, roster.size);
  setStatus(total === 0
    ? 'no clients'
    : `${total} client${total === 1 ? '' : 's'} · ${streaming} streaming`);
  empty.style.display = streaming === 0 ? '' : 'none';
}

function ensureDevice(clientId) {
  let dev = devices.get(clientId);
  if (dev) return dev;

  const tile = document.createElement('div');
  tile.className = 'tile';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = !soundOn;
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = tileLabel(clientId);
  const camBtn = document.createElement('button');
  camBtn.className = 'cam-btn';
  camBtn.onclick = (ev) => {
    ev.stopPropagation();
    setVcam(clientId === vcamClientId ? null : clientId);
  };
  const poseLabel = document.createElement('div');
  poseLabel.className = 'pose-label';
  tile.append(video, label, poseLabel, camBtn);
  // Click a tile to enlarge it; click again to go back to the grid.
  tile.onclick = () => {
    const zoomed = tile.classList.contains('zoom');
    for (const d of devices.values()) d.tile.classList.remove('zoom');
    if (!zoomed) tile.classList.add('zoom');
  };
  grid.append(tile);

  dev = {
    pc: null, tile, video, label, camBtn, poseLabel,
    frames: [], lastFrame: null, latency: null, capturing: false,
    rtpMap: null, rtpSamples: [], clockUnc: null,
    poseLabelTimer: null,
  };
  devices.set(clientId, dev);
  updateCamBtn(clientId, dev);
  updateStatus();
  return dev;
}

function removeDevice(clientId) {
  const dev = devices.get(clientId);
  if (!dev) return;
  dev.pc?.close();
  clearTimeout(dev.poseLabelTimer);
  roomViewList.forEach((v) => v.removeClient(clientId));
  dev.tile.remove();
  dropFrames(dev);
  devices.delete(clientId);
  updateStatus();
}

async function acceptOffer(clientId, description) {
  const dev = ensureDevice(clientId);
  dev.pc?.close();
  // A client keeps its id across reloads, so a device can be handed a second
  // connection. Its RTP clock, buffered frames and pose all belong to the old
  // one.
  dev.rtpMap = null;
  dev.rtpSamples = [];
  dev.latency = null;
  poses.delete(clientId);
  clearTimeout(dev.poseLabelTimer);
  dev.poseLabel.textContent = '';
  dropFrames(dev);
  dev.pc = new RTCPeerConnection(RTC_CONFIG);
  dev.pc.ontrack = (ev) => {
    dev.video.srcObject = ev.streams[0];
  };
  dev.pc.onicecandidate = (ev) => {
    if (ev.candidate) signaling.send({ type: 'ice', clientId, candidate: ev.candidate });
  };
  dev.pc.onconnectionstatechange = () => {
    if (!dev.pc) return;
    dev.label.textContent = tileLabel(clientId);
  };
  await dev.pc.setRemoteDescription(description);
  const answer = await dev.pc.createAnswer();
  await dev.pc.setLocalDescription(answer);
  signaling.send({ type: 'answer', clientId, description: dev.pc.localDescription });
  startFrameCapture(clientId, dev);
}

// ---------------------------------------------------------------------------
// Combined view: composite every live feed onto one canvas — a single video
// surface tiling all devices, drawn each frame.
const combined = document.getElementById('combined');
const combinedBtn = document.getElementById('combinedBtn');
const sceneBtn = document.getElementById('sceneBtn');
const map2dBtn = document.getElementById('map2dBtn');
const sideBtn = document.getElementById('sideBtn');
const poseBtn = document.getElementById('poseBtn');
const wallsBtn = document.getElementById('wallsBtn');
const clearTagsBtn = document.getElementById('clearTagsBtn');
const clearCarveBtn = document.getElementById('clearCarveBtn');

// Actions, not toggles. Clearing the survey forgets the anchor — the whole
// room frame — so it asks; the carve grid rebuilds in one sweep and does not.
clearTagsBtn.onclick = () => {
  if (confirm('Reset the whole survey? Every tag, including the anchor, is forgotten.')) {
    signaling.send({ type: 'survey-clear' });
  }
};
clearCarveBtn.onclick = () => signaling.send({ type: 'walls-clear' });
const sceneCanvas = document.getElementById('scene');
const map2dCanvas = document.getElementById('map2d');
const mapSideCanvas = document.getElementById('mapSide');
const maps2d = document.getElementById('maps2d');
const roomViews = document.getElementById('roomViews');
const backdrop = document.getElementById('backdrop');
const syncLabel = document.getElementById('syncLabel');
const ctx = combined.getContext('2d');
let combinedActive = true;   // shown at the top of the drawer
// The composite is *in* the drawer, and its toggle is too, so a closed drawer
// is as good as cams off: nothing is on screen and nothing can reach the button
// to say so. Compositing is the expensive path — per-frame bitmaps held per
// device — so a closed drawer must stop it rather than paint into a hidden
// canvas forever.
const camsVisible = () => combinedActive && showDrawer;
const sceneView = createSceneView(sceneCanvas);
// Double-clicking a tag in the top view forgets it — the escape hatch for
// tags that are gone from the room (e.g. one that was shown on a screen).
// Forgetting the anchor resets the whole survey.
const forgetMarker = (id) => signaling.send({ type: 'marker-remove', id });
// Which tag the pointer is on, wherever it is: a card in the drawer, a bar in
// the top view, the same tag's bar in the elevation. Held here because it is
// the one thing every one of those has to agree about — each of them reports
// what its own pointer is over and is told what to draw, so there is no way for
// two of them to end up highlighting different tags.
let hoveredTag = null;
function setHoveredTag(id) {
  if (id === hoveredTag) return;
  hoveredTag = id;
  roomViewList.forEach((v) => v.setHoveredMarker?.(id));
  clientsPanel.setHoveredTag(id);
}
const mapOpts = { onMarkerDblClick: forgetMarker, onMarkerHover: setHoveredTag };
const map2dView = createMap2dView(map2dCanvas, 'top', mapOpts);
const mapSideView = createMap2dView(mapSideCanvas, 'side', mapOpts);
// All room views consume identical updates.
const roomViewList = [sceneView, map2dView, mapSideView];

// --- Frame synchronisation -------------------------------------------------
// Clients deliver frames with different end-to-end latency, so a naive
// composite mixes moments that were captured milliseconds apart. Each client
// publishes pairings of RTP timestamp and capture time on the shared server
// clock; every frame carries its RTP timestamp, so its capture instant follows
// from the 90 kHz RTP clock. Feeds are then held back to match the slowest one.
const SYNC_BUFFER_MAX = 20;    // frames held per device
// Cushion of roughly two frames. It buys the latency needed for a frame
// captured just after the presentation instant to have arrived, so the nearest
// frame can be picked from either side of it; a shorter cushion leaves only
// already-past frames to choose from and the error grows to a full frame.
const SYNC_MARGIN_MS = 70;
// History kept behind the presentation instant, so a feed can still be pulled
// backwards when another one stalls. Bounded by SYNC_BUFFER_MAX either way.
const FRAME_KEEP_BACK_MS = 250;
let syncTargetLatency = 0;
let syncSupported = false;

// Pairings are stamped when a frame is encoded, so each carries the encode
// delay of that particular frame on top of the capture instant, and the
// client's own clock error on top of that. Encode delay is always positive, so
// the sample implying the earliest capture is the truest one — the same
// reasoning that makes the lowest-RTT clock probe win.
//
// The catch is that a lower envelope taken over all of time never lets go of
// its winner: once the client's clock estimate moves, that one sample keeps a
// bias no later sample can outbid, and the feed sits wrong indefinitely. Only
// a recent window is considered, so the mapping reconverges on its own.
const RTP_MAP_WINDOW_MS = 20000;
const RTP_MAP_MAX_SAMPLES = 400;

function updateRtpMap(dev, sample) {
  const samples = dev.rtpSamples;
  samples.push(sample);
  while (samples.length > RTP_MAP_MAX_SAMPLES ||
    (samples.length && sample.serverTime - samples[0].serverTime > RTP_MAP_WINDOW_MS)) {
    samples.shift();
  }
  // Put the samples on a common footing — what each implies for the newest
  // frame's capture instant — and keep the earliest.
  let best = samples[0];
  let bestImplied = Infinity;
  for (const s of samples) {
    const implied = s.serverTime + rtpDeltaMs(sample.rtp, s.rtp);
    if (implied < bestImplied) {
      bestImplied = implied;
      best = s;
    }
  }
  dev.rtpMap = best;
}

// Capture instant of a frame, on the server clock — null until the owning
// client has published a pairing.
function captureTimeOf(dev, rtpTimestamp) {
  if (!dev.rtpMap || !clockSync.synced) return null;
  return dev.rtpMap.serverTime + rtpDeltaMs(rtpTimestamp, dev.rtpMap.rtp);
}

function startFrameCapture(clientId, dev) {
  if (!dev.video.requestVideoFrameCallback || dev.capturing) return;
  dev.capturing = true;
  dev.frames = [];
  dev.latency = null;

  const onFrame = (now, meta) => {
    if (!devices.has(clientId)) {
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

// Buffered bitmaps are capped: the sync buffer holds SYNC_BUFFER_MAX frames
// per device and a full 4K bitmap pins ~30 MB of GPU memory — the composite
// never draws a tile anywhere near that size anyway.
const BITMAP_MAX_DIM = 1920;

function bufferFrame(dev, captureTime) {
  const vw = dev.video.videoWidth;
  const vh = dev.video.videoHeight;
  if (vw === 0) return;
  const s = Math.min(1, BITMAP_MAX_DIM / Math.max(vw, vh));
  const make = s < 1
    ? createImageBitmap(dev.video, {
      resizeWidth: Math.round(vw * s),
      resizeHeight: Math.round(vh * s),
    })
    : createImageBitmap(dev.video);
  make.then((bitmap) => {
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
function dueFrame(dev, target) {
  const frames = dev.frames;
  if (!frames?.length) return dev.lastFrame;

  let bestIdx = 0;
  let bestErr = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const err = Math.abs(frames[i].captureTime - target);
    if (err > bestErr) break;   // capture times ascend: past the nearest one
    bestErr = err;
    bestIdx = i;
  }
  const chosen = frames[bestIdx];

  // Keep a little history behind the presentation instant instead of dropping
  // everything already shown: a latency spike on any one feed drags the shared
  // instant backwards, and the feeds that had discarded those frames would
  // have nothing left to offer but their oldest one.
  let drop = 0;
  while (drop < bestIdx && frames[drop].captureTime < target - FRAME_KEEP_BACK_MS) drop++;
  for (let i = 0; i < drop; i++) frames[i].bitmap.close();
  frames.splice(0, drop);

  dev.lastFrame = chosen;
  return chosen;
}

// What the header reports is the alignment of the frames actually drawn: how
// far the worst of them sits from the shared presentation instant. The
// dashboard's own clock error shifts that instant for every feed at once, so
// it cancels here and this number cannot see it; the clients' clock error does
// not cancel, and is reported beside it rather than quietly left out.
let syncErrPeak = 0;
let syncLabelAt = 0;

function updateSyncLabel(feeds, latencies, worstErr) {
  // Peak-hold with a slow decay: a per-frame number changes far too fast to
  // read, and the peak is the honest one to quote.
  syncErrPeak = Math.max(worstErr, syncErrPeak * 0.99);
  if (performance.now() - syncLabelAt < 250) return;
  syncLabelAt = performance.now();
  if (!syncSupported) {
    syncLabel.textContent = feeds.length ? 'sync unavailable' : '';
    return;
  }
  const spread = Math.round(Math.max(...latencies) - Math.min(...latencies));
  const uncs = feeds.map(([, d]) => d.clockUnc).filter((u) => u !== null && isFinite(u));
  const clock = uncs.length ? ` · clock ±${Math.round(Math.max(...uncs))} ms` : '';
  syncLabel.textContent = `sync ±${Math.round(syncErrPeak)} ms · lag spread ${spread} ms${clock}`;
}

function drawCombined() {
  if (!camsVisible()) return;
  const now = clockSync.now();
  const feeds = [...devices.entries()].filter(([, d]) => d.video.videoWidth > 0);

  const latencies = feeds.map(([, d]) => d.latency).filter((l) => l !== null);
  syncSupported = latencies.length === feeds.length && feeds.length > 0;
  if (syncSupported) syncTargetLatency = Math.max(...latencies) + SYNC_MARGIN_MS;
  else feeds.forEach(([, d]) => dropFrames(d));
  const target = now - syncTargetLatency;
  let worstErr = 0;

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
      const frame = syncSupported ? dueFrame(d, target) : null;
      if (frame) worstErr = Math.max(worstErr, Math.abs(frame.captureTime - target));
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
      ctx.fillText(`Client ${id}`, cx + 20, cy + ch - 22);
    });
  }
  updateSyncLabel(feeds, latencies, worstErr);
  requestAnimationFrame(drawCombined);
}

// Room views above the tile grid: the 3D scene and the 2D projections,
// independently toggleable, splitting the pane across the window's longer
// dimension. The grid keeps rendering underneath behind the opaque backdrop.
// The combined canvas is not one of these — it lives in the drawer.
let show3d = true;
let show2d = true;      // top-down floor plan
let showSide = false;   // side elevation (height)
// Not a view of its own but how all of them draw a client: on, the reported
// pose with the uncertainty circle around it; off, only the circle, with the
// heading anchored on its centre.
let showPoseMarker = false;

// The carved free-space / walls layer in the room views. On by default: the
// layer only exists where evidence was accepted, so an empty room draws
// nothing rather than noise.
let showWalls = true;

// ---------------------------------------------------------------------------
// One description of a client, merged from everything that knows part of one:
// the server's roster (what it is and what it was told to do), the peer
// connection (video, latency, clock uncertainty), the tracking-loss reports and
// the newest pose. Two panels render this — the compact overlay over the room
// views and the control drawer — and neither assembles its own view of a
// client, or they would sooner or later disagree about one.
const POSE_STALE_MS = 2000;

function clientIds() {
  return [...new Set([...roster.keys(), ...devices.keys(), ...poses.keys()])]
    .sort((a, b) => a - b);
}

function clientInfo(id) {
  const dev = devices.get(id);
  const lost = trackingLost.get(id);
  // A client that leaves AR while its tracking is down never sends the recovery
  // message, so the state has to expire on its own or the roster keeps
  // reporting a client that is not there. The ping is once a second.
  if (lost && performance.now() - lost.at > LOST_STALE_MS) trackingLost.delete(id);
  const stillLost = trackingLost.get(id);
  const pose = poses.get(id);
  return {
    id,
    kind: 'client',
    ...(roster.get(id) || {}),
    vcamAvailable,
    live: !!dev,
    poseMsg: pose?.msg ?? null,
    poseAge: pose ? performance.now() - pose.at : null,
    latency: dev?.latency ?? null,
    clockUnc: dev?.clockUnc ?? null,
    lostMs: stillLost ? stillLost.ms + performance.now() - stillLost.at : null,
  };
}

// Client roster over the room views: who is where, facing which way, and how
// fresh the fix is. Yaw is the heading in the floor plane (0° = along room z,
// toward the room from the anchor wall), pitch positive looking up.
const roomStats = document.getElementById('roomStats');
setInterval(() => {
  if (!show3d && !show2d && !showSide) {
    roomStats.textContent = '';
    return;
  }
  const infos = clientIds().map(clientInfo);
  const rows = [];
  // Tracking-lost clients first, and listed even when they have no tile and no
  // pose: this is the one state where the honest report is that there is no
  // position, rather than no client.
  for (const info of infos) {
    if (info.lostMs === null) continue;
    const row = document.createElement('div');
    row.style.color = '#e0603a';
    row.textContent = `P${info.id}  NO ARCORE TRACK ${(info.lostMs / 1000).toFixed(0)}s  `
      + '— position from tags only, nothing carried between sightings';
    rows.push(row);
  }
  for (const info of infos) {
    const room = info.poseMsg?.room;
    // Not skipped while tracking is lost: the client still reports a tag-only
    // position, and the banner above already says where it is coming from.
    if (!room?.pose) continue;
    const p = room.pose.p;
    const f = quatRotate(room.pose.q, [0, 0, 1]);
    const yaw = Math.atan2(f[0], f[2]) * 180 / Math.PI;
    const pitch = Math.asin(Math.max(-1, Math.min(1, f[1]))) * 180 / Math.PI;
    const row = document.createElement('div');
    row.style.color = info.poseAge > POSE_STALE_MS ? '#777' : roomClientColorCss(info.id);
    row.textContent =
      `P${info.id}  ${p.map((v) => v.toFixed(2)).join(', ')}` +
      `  yaw ${Math.round(yaw)}°  pitch ${Math.round(pitch)}°` +
      `  ${(info.poseMsg.tags || []).length} tags  ${fmtAge(info.poseAge)}`;
    rows.push(row);
  }
  roomStats.replaceChildren(...rows);
}, 100);

// ---------------------------------------------------------------------------
// Client drawer: the same roster with the controls attached. Everything a
// client can do to itself is drivable from here; the client owns the behaviour
// and reports back what it actually did, so nothing here is optimistic.
const drawerBtn = document.getElementById('drawerBtn');
const clientsPanel = createClientsPanel(document.getElementById('drawer'), {
  onControl: (clientId, action, value) =>
    signaling.send({ type: 'control', clientId, action, value }),
  onVcam: (clientId, on) => setVcam(on ? clientId : null),
  onRename: (clientId, name) => signaling.send({ type: 'device-rename', clientId, name }),
  onTagHover: setHoveredTag,
});
// Open by default: the drawer is the only place that lists a client which has no
// tile, so starting closed hides exactly the clients worth knowing about.
let showDrawer = true;

function refreshClientsPanel() {
  if (!showDrawer) return;
  clientsPanel.update(clientIds().map(clientInfo), markerMap);
}

// Recording byte counts and pose ages move on their own; the roster message
// only arrives when something changes.
setInterval(refreshClientsPanel, 400);

function refreshViews() {
  const room = show3d || show2d || showSide;
  combinedBtn.classList.toggle('on', combinedActive);
  sceneBtn.classList.toggle('on', show3d);
  map2dBtn.classList.toggle('on', show2d);
  sideBtn.classList.toggle('on', showSide);
  drawerBtn.classList.toggle('on', showDrawer);
  poseBtn.classList.toggle('on', showPoseMarker);
  wallsBtn.classList.toggle('on', showWalls);
  roomViewList.forEach((v) => v.setShowPose(showPoseMarker));
  roomViewList.forEach((v) => v.setLayer?.('walls', showWalls));
  clientsPanel.setActive(showDrawer);
  refreshClientsPanel();
  // The backdrop hides the tile grid behind a full-bleed view. The combined
  // canvas is in the drawer now and covers nothing, so it no longer asks for
  // one — a 340px drawer blacking out the whole grid behind it was the old
  // pip's rule outliving the pip.
  backdrop.style.display = room ? 'block' : '';
  combined.style.display = combinedActive ? 'block' : '';
  roomViews.classList.toggle('active', room);
  sceneCanvas.classList.toggle('active', show3d);
  maps2d.classList.toggle('active', show2d || showSide);
  map2dCanvas.classList.toggle('active', show2d);
  mapSideCanvas.classList.toggle('active', showSide);
  sceneView.setActive(show3d);
  map2dView.setActive(show2d);
  mapSideView.setActive(showSide);
  if (camsVisible()) drawCombined();
  else {
    syncLabel.textContent = '';
    syncErrPeak = 0;
    for (const dev of devices.values()) dropFrames(dev);
  }
}

// Which views are open, remembered across reloads. One table rather than five
// near-identical handlers and five near-identical storage reads — that is five
// places for one of them to drift, and the dashboard is reloaded constantly
// while the layout someone wants is the same every time.
//
// One key holding one object, so a partial write cannot leave the set of
// toggles half in one state and half in another. The legacy `streamer-` prefix
// is kept deliberately; see the note on storage keys in CLAUDE.md.
const VIEW_STATE_KEY = 'streamer-viewer-views';

const viewToggles = [
  { key: 'cams', btn: combinedBtn, get: () => combinedActive, set: (v) => { combinedActive = v; } },
  { key: 'scene', btn: sceneBtn, get: () => show3d, set: (v) => { show3d = v; } },
  { key: 'top', btn: map2dBtn, get: () => show2d, set: (v) => { show2d = v; } },
  { key: 'side', btn: sideBtn, get: () => showSide, set: (v) => { showSide = v; } },
  { key: 'pose', btn: poseBtn, get: () => showPoseMarker, set: (v) => { showPoseMarker = v; } },
  { key: 'walls', btn: wallsBtn, get: () => showWalls, set: (v) => { showWalls = v; } },
  // Key stays 'clients' although the button no longer is: it names a stored
  // value, and renaming it would read every existing viewer's saved layout as
  // "not stored" and reopen the drawer on someone who closed it.
  { key: 'clients', btn: drawerBtn, get: () => showDrawer, set: (v) => { showDrawer = v; } },
];

function loadViewState() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(VIEW_STATE_KEY) || 'null');
  } catch {
    return;   // unreadable or unparseable: the defaults above stand
  }
  if (!saved) return;
  for (const t of viewToggles) {
    // Only keys actually stored, and only if they are booleans. A toggle added
    // after someone last saved must keep its own default rather than come back
    // as undefined and read as off.
    if (typeof saved[t.key] === 'boolean') t.set(saved[t.key]);
  }
}

function saveViewState() {
  try {
    localStorage.setItem(VIEW_STATE_KEY,
      JSON.stringify(Object.fromEntries(viewToggles.map((t) => [t.key, t.get()]))));
  } catch {
    // Private mode, or storage full. Which panels are open is not worth
    // breaking the click over.
  }
}

for (const t of viewToggles) {
  t.btn.onclick = () => {
    t.set(!t.get());
    saveViewState();
    refreshViews();
  };
}

loadViewState();


muteBtn.onclick = () => {
  soundOn = !soundOn;
  muteBtn.classList.toggle('on', soundOn);
  for (const dev of devices.values()) dev.video.muted = !soundOn;
};

// Room views start on — must run after every const above is initialized.
refreshViews();
