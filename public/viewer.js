'use strict';

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const fullscreenBtn = document.getElementById('fullscreenBtn');
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
const sceneCanvas = document.getElementById('scene');
const map2dCanvas = document.getElementById('map2d');
const mapSideCanvas = document.getElementById('mapSide');
const maps2d = document.getElementById('maps2d');
const roomViews = document.getElementById('roomViews');
const backdrop = document.getElementById('backdrop');
const syncLabel = document.getElementById('syncLabel');
const ctx = combined.getContext('2d');
let combinedActive = true;   // starts as the pip over the room views
const sceneView = createSceneView(sceneCanvas);
// Double-clicking a tag in the top view forgets it — the escape hatch for
// tags that are gone from the room (e.g. one that was shown on a screen).
// Forgetting the anchor resets the whole survey.
const forgetMarker = (id) => signaling.send({ type: 'marker-remove', id });
const map2dView = createMap2dView(map2dCanvas, 'top', { onMarkerDblClick: forgetMarker });
const mapSideView = createMap2dView(mapSideCanvas, 'side', { onMarkerDblClick: forgetMarker });
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
  if (!combinedActive) return;
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

// Overlay views above the tile grid: the combined canvas and/or the room
// views (3D scene and 2D floor plan — independently toggleable, side by side
// when both are on). Combined alongside a room view shrinks into a floating
// pip in the top-left. The grid keeps rendering underneath behind the opaque
// backdrop.
let show3d = true;
let show2d = true;      // top-down floor plan
let showSide = false;   // side elevation (height)

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
const clientsBtn = document.getElementById('clientsBtn');
const clientsPanel = createClientsPanel(document.getElementById('clients'), {
  onControl: (clientId, action, value) =>
    signaling.send({ type: 'control', clientId, action, value }),
  onVcam: (clientId, on) => setVcam(on ? clientId : null),
  onRename: (clientId, name) => signaling.send({ type: 'device-rename', clientId, name }),
});
let showClients = false;

function refreshClientsPanel() {
  if (!showClients) return;
  clientsPanel.update(clientIds().map(clientInfo));
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
  clientsBtn.classList.toggle('on', showClients);
  clientsPanel.setActive(showClients);
  // Both live in the top-right; the compact readout steps aside for the drawer.
  roomViews.classList.toggle('with-panel', showClients);
  refreshClientsPanel();
  backdrop.style.display = combinedActive || room ? 'block' : '';
  combined.style.display = combinedActive ? 'block' : '';
  combined.classList.toggle('pip', combinedActive && room);
  roomViews.classList.toggle('active', room);
  sceneCanvas.classList.toggle('active', show3d);
  maps2d.classList.toggle('active', show2d || showSide);
  map2dCanvas.classList.toggle('active', show2d);
  mapSideCanvas.classList.toggle('active', showSide);
  sceneView.setActive(show3d);
  map2dView.setActive(show2d);
  mapSideView.setActive(showSide);
  if (combinedActive) drawCombined();
  else {
    syncLabel.textContent = '';
    syncErrPeak = 0;
    for (const dev of devices.values()) dropFrames(dev);
  }
}

combinedBtn.onclick = () => {
  combinedActive = !combinedActive;
  refreshViews();
};
sceneBtn.onclick = () => {
  show3d = !show3d;
  refreshViews();
};
map2dBtn.onclick = () => {
  show2d = !show2d;
  refreshViews();
};
sideBtn.onclick = () => {
  showSide = !showSide;
  refreshViews();
};
clientsBtn.onclick = () => {
  showClients = !showClients;
  refreshViews();
};


// Fullscreen the active view. Overlays (combined, room views, pip) all live
// inside <main>, so fullscreening it keeps whatever combination is showing.
fullscreenBtn.onclick = () => {
  const overlayActive = combinedActive || show3d || show2d || showSide;
  (overlayActive ? document.querySelector('main') : grid).requestFullscreen?.();
};

muteBtn.onclick = () => {
  soundOn = !soundOn;
  muteBtn.classList.toggle('on', soundOn);
  for (const dev of devices.values()) dev.video.muted = !soundOn;
};

// Room views start on — must run after every const above is initialized.
refreshViews();
