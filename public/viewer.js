'use strict';

const grid = document.getElementById('grid');
const muteBtn = document.getElementById('muteBtn');
// The two halves of the dashboard below the header, held because both are
// disabled wholesale when another dashboard takes the viewer slot.
const stageEl = document.getElementById('stage');
const drawerEl = document.getElementById('drawer');

// clientId -> { pc, tile, video, label, camBtn, ghost }
// `devices` means "is there a tile", not "is there a video feed" — a client
// that went away keeps its entry, marked `ghost: <reason>`, holding its last
// frame dimmed rather than being torn out (see ghostDevice). Anything that
// means *live* has to check `!dev.ghost` too, not just `devices.has(id)`.
const devices = new Map();
// clientId -> the state the server reports for it. Separate from `devices`
// because the two answer different questions: `devices` is "is there a tile",
// the roster is "is there a client at all". An XR client only ever appears in
// the roster, and a client whose peer connection has not come up yet appears
// there first. Also what tells a ghost with nothing left to reconnect to (not
// in the roster) from one still connected under a stopped stream.
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
// Another dashboard took the single viewer slot. Held because the reason a
// socket closed is not visible from the close itself, and reconnecting is
// exactly the wrong response here: it would take the slot straight back off
// whoever just claimed it, forever.
let displaced = false;

const signaling = connectSignaling('viewer', {
  onOpen() {
    clockSync.start();
    updateStatus();
  },
  onClose() {
    setStatus(displaced
      ? 'another dashboard took over — reload this page to take it back'
      : 'signaling lost, reconnecting…');
    // Everything known about the clients came over this socket; none of it
    // survives it. The server re-sends the roster on reconnect.
    roster.clear();
    poses.clear();
    trackingLost.clear();
    for (const id of [...devices.keys()]) ghostDevice(id, 'no server');
    refreshClientsPanel();
  },
  async onMessage(msg) {
    // Arrives just before the server closes this socket. Closing it from here
    // is what stops the reconnect — connectSignaling's close() is the only way
    // to tell it a close was expected.
    if (msg.type === 'viewer-taken') {
      displaced = true;
      // Everything still on screen — the survey, the walls, the tag cards — is
      // now a photograph of the room rather than a view of it, and nothing will
      // ever update it again. Greyed so it cannot be read as live; the status
      // line alone was one line against a full-colour dashboard.
      document.body.classList.add('displaced');
      // And inert, not merely grey: every control in there talks over a socket
      // that is gone, so a click would be silently swallowed — forgetting a tag
      // or pausing a client would look like it had worked. `inert` rather than
      // pointer-events, because it takes the keyboard too. The header stays
      // live: the view toggles are local, and the status line in it is what
      // says how to get the dashboard back.
      stageEl.inert = true;
      drawerEl.inert = true;
      signaling.close();
      return;
    }
    if (clockSync.handle(msg)) return;
    // Everything that describes the room — the survey, the carved floor, the
    // walls — goes straight to the renderers through the shared feed.
    if (roomFeed.handle(msg)) return;
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
    // The answer to the open tag card's own request. Straight through: which
    // card is open, and whether this is still the tag it asked about, is the
    // panel's to know.
    if (msg.type === 'tag-history') {
      clientsPanel.setTagHistory(msg);
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
    // The whole settings state, every time: the server sends it on connect, on
    // any change from anywhere (the /markers page sets the same tag size), and
    // as the answer to this dashboard's own attempt. One message shape rather
    // than a push and a separate reply, or the form would have two ways to
    // learn the same thing and could show a different one from each.
    if (msg.type === 'settings') {
      updateSettings(msg);
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
    if (msg.type === 'offer') {
      await acceptOffer(msg.clientId, msg.description);
    } else if (msg.type === 'ice') {
      const dev = devices.get(msg.clientId);
      try {
        await dev?.pc.addIceCandidate(msg.candidate);
      } catch {
        // Stale candidate from a previous connection — ignore.
      }
    } else if (msg.type === 'stream-stopped') {
      // The client is still here, it has just stopped sending video (the XR
      // client's Stream switch). Its roster entry, its dot and its pose are all
      // still current — only the tile ghosts, captioned so a frozen picture
      // does not read as a client that stopped moving.
      ghostDevice(msg.clientId, 'stream off');
    } else if (msg.type === 'client-gone') {
      trackingLost.delete(msg.clientId);
      poses.delete(msg.clientId);
      // Not folded into ghostDevice: a client with no tile has no device entry
      // to ghost, and an XR client never has one — it would have left its dot
      // sitting in the room views forever.
      roomFeed.removeClient(msg.clientId);
      ghostDevice(msg.clientId, 'offline');
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
  // A ghost's peer connection is closed on purpose, so its connectionState
  // ("closed") is not news — the ghost note below the label already says what
  // happened and covers this suffix's whole job.
  const state = dev && !dev.ghost && dev.pc && dev.pc.connectionState !== 'connected'
    ? ` — ${dev.pc.connectionState}` : '';
  return `${name ? `${name} · client${clientId}` : `Client ${clientId}`}${state}`;
}

function updateLabels() {
  for (const [id, dev] of devices) dev.label.textContent = tileLabel(id);
}

function updateCamBtn(clientId, dev) {
  // No webcam assignment for a ghost — there is no video behind it to feed.
  dev.camBtn.style.display = !dev.ghost && vcamAvailable ? '' : 'none';
  dev.camBtn.textContent = clientId === vcamClientId ? 'Webcam ✓' : 'Webcam';
  dev.camBtn.classList.toggle('active', clientId === vcamClientId);
}

// How this client went away and how long ago — the load-bearing part of a
// ghost tile, per the note above `devices`: a frozen picture with nothing
// saying why is indistinguishable from a client that only stopped moving.
// `GHOST_TEXT`/`ghostNote` (common.js) are shared with clients-panel.js, so
// the tile and the drawer card can never disagree about the same client.
function updateGhostNote(dev) {
  dev.ghostNoteEl.textContent = dev.ghost ? ghostNote(dev.ghost, dev.ghostAt) : '';
}

// The note's age has to keep counting, so every ghost is re-stamped on the
// same tick that already redraws the drawer (refreshClientsPanel) — no
// second timer for one more piece of text.
function tickGhostNotes() {
  for (const dev of devices.values()) if (dev.ghost) updateGhostNote(dev);
}

// Camera-frame readout on the tile: which tags this client sees and how far
// the nearest one is. Goes stale quickly — a client that stops reporting
// (disabled, backgrounded) must not keep showing a distance.
const POSE_LABEL_TTL_MS = 2000;

// clientId -> { msg, at, det, detAt, check, checkAt } for the newest pose,
// whether or not that client has a tile. A client with no tile is not a
// client with no position: the XR client positions and maps without
// streaming, so it never opens a peer connection and never gets a device
// entry — and it is the one whose position matters most.
//
// `det`/`detAt` are the pose latched through lastDetection (common.js): the
// newest message with an actual detection behind it, held across carry
// reports, so every reader of "what tags are in view" agrees with the map's
// sight lines instead of blinking on the carry interleave.
const poses = new Map();

function updatePoseLabel(clientId, msg) {
  const prev = poses.get(clientId);
  const now = performance.now();
  const det = lastDetection(prev?.det, msg);
  const detAt = det ? (det === prev?.det ? prev.detAt : now) : null;
  poses.set(clientId, { msg, at: now, det, detAt });
  roomFeed.applyPose(clientId, msg);
  // Only the per-tile label below needs a tile to live on.
  const dev = devices.get(clientId);
  if (!dev) return;
  const roll = Number(msg.room?.roll) || 0;
  if (dev.appliedRoll !== roll) {
    dev.appliedRoll = roll;
    dev.wrap.classList.toggle('rot90', roll === 90);
    dev.wrap.classList.toggle('rot180', roll === 180);
    dev.wrap.classList.toggle('rot270', roll === 270);
    // A quarter turn swaps which way round the picture ends up, so the tile
    // holding the old shape would letterbox the corrected feed inside it.
    updateFeedShape(dev);
  }
  clearTimeout(dev.poseLabelTimer);
  // A client sending only carries (nothing detecting, not just nothing in
  // view) must not hold a stale tag list on its tile forever.
  const tags = detAt !== null && now - detAt < POSE_LABEL_TTL_MS ? (det.tags || []) : [];
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
// ever opening a peer connection. `devices.size` alone no longer means
// streaming — it counts ghosts too — so the two are told apart explicitly.
function updateStatus() {
  let streaming = 0;
  for (const dev of devices.values()) if (!dev.ghost) streaming++;
  // devices.size in the mix as well as roster.size: a client removed from the
  // roster (client-gone) still sits on screen as a ghost until someone
  // dismisses it, and the header should count what is visible, not just what
  // the server currently lists.
  const total = Math.max(streaming, roster.size, devices.size);
  setStatus(total === 0
    ? 'no clients'
    : `${total} client${total === 1 ? '' : 's'} · ${streaming} streaming`);
}

function ensureDevice(clientId) {
  let dev = devices.get(clientId);
  if (dev) {
    // The same client, back before its ghost was dismissed — the same shape as
    // scene.js's `ph.dead = false`: revive what is already on screen rather
    // than build a second copy of it.
    if (dev.ghost) {
      dev.ghost = null;
      dev.ghostAt = null;
      dev.tile.classList.remove('ghost');
      dev.ghostNoteEl.textContent = '';
      updateCamBtn(clientId, dev);
    }
    return dev;
  }

  const tile = document.createElement('div');
  tile.className = 'tile';
  const wrap = document.createElement('div');
  wrap.className = 'vwrap';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = !soundOn;
  wrap.append(video);
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = tileLabel(clientId);
  const ghostNoteEl = document.createElement('div');
  ghostNoteEl.className = 'ghost-note';
  const camBtn = document.createElement('button');
  camBtn.className = 'cam-btn';
  camBtn.onclick = (ev) => {
    ev.stopPropagation();
    setVcam(clientId === vcamClientId ? null : clientId);
  };
  const poseLabel = document.createElement('div');
  poseLabel.className = 'pose-label';
  // Meaningful only once the tile has ghosted — CSS reveals it on hover of
  // `.tile.ghost` alone. A live tile's remove would take the feed away with no
  // way to ask for it back, which is not what a corner button should do.
  const rmBtn = document.createElement('button');
  rmBtn.type = 'button';
  rmBtn.className = 'icon-btn mini rm danger';
  rmBtn.title = `Remove client ${clientId} from this dashboard`;
  rmBtn.setAttribute('aria-label', `Remove client ${clientId} from this dashboard`);
  rmBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M4 7h16"/><path d="M9.5 4h5"/>'
    + '<path d="M6.5 7l.9 12.1A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.9L17.5 7"/></svg>';
  // The tile's own click toggles zoom (below) — the same guard camBtn already
  // needs, for the same reason.
  rmBtn.addEventListener('click', (ev) => ev.stopPropagation());
  confirmButton(rmBtn, () => forgetClient(clientId), {
    armedTitle: `Click again to drop client ${clientId} from this dashboard — its video will `
      + 'not come back until it reconnects',
  });
  tile.append(wrap, label, poseLabel, ghostNoteEl, camBtn, rmBtn);
  // Click a tile to enlarge it; click again to go back to the grid.
  tile.onclick = () => {
    const zoomed = tile.classList.contains('zoom');
    for (const d of devices.values()) d.tile.classList.remove('zoom');
    if (!zoomed) tile.classList.add('zoom');
  };
  grid.append(tile);

  dev = {
    pc: null, tile, wrap, video, label, camBtn, poseLabel, ghostNoteEl, rmBtn,
    frames: [], lastFrame: null, latency: null, capturing: false,
    rtpMap: null, rtpSamples: [], clockUnc: null,
    poseLabelTimer: null, appliedRoll: 0, ghost: null, ghostAt: null,
  };
  devices.set(clientId, dev);
  // `resize` as well as `loadedmetadata`: a client that changes capture
  // resolution keeps the same track, and the tile would hold the shape of the
  // size it started with.
  video.addEventListener('loadedmetadata', () => updateFeedShape(dev));
  video.addEventListener('resize', () => updateFeedShape(dev));
  updateCamBtn(clientId, dev);
  updateStatus();
  return dev;
}

// The tile's own shape, from the feed's — see .tile in style.css for why the
// tile has to be told rather than sized by what is in it. Called from both
// things that can change the answer: the frame size, and whether a quarter
// turn is being taken out of it.
function updateFeedShape(dev) {
  const vw = dev.video.videoWidth;
  const vh = dev.video.videoHeight;
  // No frame yet: leave the fallback ratio standing rather than writing a
  // 0/0 nobody can render.
  if (!vw || !vh) return;
  const rotated = dev.appliedRoll === 90 || dev.appliedRoll === 270;
  dev.tile.style.setProperty('--feed-ar', rotated ? `${vh} / ${vw}` : `${vw} / ${vh}`);
}

// Tears down everything the tile actively costs — the peer connection, the
// buffered frames, the per-tag distance readout — but leaves the tile itself
// in the grid, dimmed and captioned with why. See the `devices` comment above:
// after this, the entry is still "there is a tile", just not "there is a
// video feed". Called again on an already-ghosted device (a stopped stream
// followed by a disconnect) it just overwrites the reason with the truer one.
function ghostDevice(clientId, reason) {
  const dev = devices.get(clientId);
  if (!dev) return;
  dev.pc?.close();
  clearTimeout(dev.poseLabelTimer);
  // A frozen "1.8 m to tag 4" is a live readout that has stopped being true.
  dev.poseLabel.textContent = '';
  dropFrames(dev);
  dev.capturing = false;
  roomFeed.removeClient(clientId);
  dev.tile.classList.remove('zoom');
  dev.tile.classList.add('ghost');
  dev.ghost = reason;
  dev.ghostAt = Date.now();
  updateGhostNote(dev);
  updateCamBtn(clientId, dev);
  updateLabels();
  updateStatus();
}

// Removal as a deliberate act, not a consequence of anything the server says —
// once a client only ever ghosts, this is the only way anything leaves the
// dashboard. Drops every piece of local state for the id; the server and the
// client itself are untouched, so a still-connected client's card is back
// within a second (the next roster push) even though its tile is not — the
// armed title on the button that calls this says so.
function forgetClient(clientId) {
  const dev = devices.get(clientId);
  if (dev) {
    dev.pc?.close();
    clearTimeout(dev.poseLabelTimer);
    dropFrames(dev);
    dev.tile.remove();
    devices.delete(clientId);
  }
  poses.delete(clientId);
  trackingLost.delete(clientId);
  roomFeed.removeClient(clientId);
  updateStatus();
  refreshClientsPanel();
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
const frontBtn = document.getElementById('frontBtn');
const poseBtn = document.getElementById('poseBtn');
const wallsBtn = document.getElementById('wallsBtn');
const clearTagsBtn = document.getElementById('clearTagsBtn');
const clearCarveBtn = document.getElementById('clearCarveBtn');

// Actions, not toggles, and both forget something no undo brings back, so both
// arm on the first click and act on the second — the same two-click gesture as
// the per-tag remove in the drawer, from the same primitive.
confirmButton(clearTagsBtn, () => signaling.send({ type: 'survey-clear' }), {
  armedTitle: 'Click again to forget every tag, the anchor included — the whole room frame',
});
confirmButton(clearCarveBtn, () => signaling.send({ type: 'walls-clear' }), {
  armedTitle: 'Click again to wipe the carved free space and walls',
});
const sceneCanvas = document.getElementById('scene');
const map2dCanvas = document.getElementById('map2d');
const mapSideCanvas = document.getElementById('mapSide');
const mapFrontCanvas = document.getElementById('mapFront');
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
// The escape hatch for tags that are gone from the room (e.g. one that was
// shown on a screen). Driven from the drawer card's own remove button, not from
// the room views: the gesture there was a double-click on the tag, sharing one
// gesture with the view reset on a target a few pixels across.
// Forgetting the anchor resets the whole survey.
const forgetMarker = (id) => signaling.send({ type: 'marker-remove', id });
// What the pointer is on, wherever it is: a card in the drawer, a bar or a
// client dot in the top view, the same entity in the elevation. One value of
// shape { kind: 'tag' | 'client', id } — not one per kind, or two hovers could
// be lit at once. `id` identifies exactly one thing on screen.
// Held here because it is the one thing every
// surface has to agree about — each of them reports what its own pointer is
// over and is told what to draw, so there is no way for two of them to end up
// highlighting different things.
let hovered = null;
function setHovered(h) {
  const key = h ? `${h.kind}:${h.id}` : '';
  if (key === (hovered ? `${hovered.kind}:${hovered.id}` : '')) return;
  hovered = h;
  roomViewList.forEach((v) => v.setHovered?.(h));
  clientsPanel.setHovered(h);
}
// Which tag's card is open in the drawer, for the same reason the hover is held
// here: the three map views all draw that tag's distances and none of them can
// see the drawer.
function setOpenedTag(id) {
  roomViewList.forEach((v) => v.setFocusMarker?.(id));
}
// The tag-to-tag legs are the open card's own. Every tag drawing its nearest
// neighbour at once is a leg and two labels per tag across the room, which
// buries the map — and a distance is looked at when a particular tag is the
// question.
const mapOpts = { onHover: setHovered, pairsFocusOnly: true };
const map2dView = createMap2dView(map2dCanvas, 'top', mapOpts);
// The two elevations are the same view from a quarter turn apart: 'side' keeps
// x across the screen, 'front' keeps z. A tag seen edge-on in one is seen
// face-on in the other, so between them every wall in the room has a view that
// shows its height honestly.
const mapSideView = createMap2dView(mapSideCanvas, 'side', mapOpts);
const mapFrontView = createMap2dView(mapFrontCanvas, 'front', mapOpts);
// All room views consume identical updates.
const roomViewList = [sceneView, map2dView, mapSideView, mapFrontView];
// The room messages reach the views through here, the same way they reach the
// XR client's own map.
const roomFeed = createRoomFeed(roomViewList);

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
    // Either it left the grid entirely (forgetClient) or ghosted — its own
    // pc.close() should stop the track on its own, but this is the backstop
    // that keeps a frame that slips through from being buffered into a ghost's
    // (still-truthy, empty) frame list.
    if (!devices.has(clientId) || dev.ghost) {
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
  // A ghost keeps a nonzero videoWidth and a stale `latency` from before it
  // closed — left in, it would pin syncTargetLatency to a feed nobody is
  // sending and drag every live feed's presentation instant behind it.
  const feeds = [...devices.entries()].filter(([, d]) => !d.ghost && d.video.videoWidth > 0);

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
      const roll = Number(poses.get(id)?.msg?.room?.roll) || 0;
      const rotated = roll === 90 || roll === 270;
      // Aspect-fit the feed inside its cell, against its post-rotation shape.
      const scale = Math.min(cw / (rotated ? sh : sw), ch / (rotated ? sw : sh));
      const w = sw * scale;
      const h = sh * scale;
      if (roll) {
        ctx.save();
        ctx.translate(cx + cw / 2, cy + ch / 2);
        // Against the roll, not with it — the same inverse the tile's .vwrap
        // applies, for the reason spelled out beside it in style.css.
        ctx.rotate(-roll * Math.PI / 180);
        ctx.drawImage(source, -w / 2, -h / 2, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(source, cx + (cw - w) / 2, cy + (ch - h) / 2, w, h);
      }
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
let showSide = false;   // elevation across x (height)
let showFront = false;  // elevation across z (height), the other quarter turn
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
    live: !!dev && !dev.ghost,
    // Not in the roster at all: the drawer's own controls have nobody to talk
    // to (client-gone already dropped the roster entry), unlike a ghosted-but-
    // still-connected client whose stream merely stopped.
    present: roster.has(id),
    ghost: dev?.ghost ?? null,
    ghostAt: dev?.ghostAt ?? null,
    poseMsg: pose?.msg ?? null,
    poseAge: pose ? performance.now() - pose.at : null,
    // The pose latched through lastDetection (common.js): what tags are
    // actually in view, held across the XR carry interleave so this agrees
    // with the map's sight lines instead of blinking on every carry report.
    // See the `poses` comment above.
    detMsg: pose?.det ?? null,
    detAge: pose?.detAt !== null && pose?.detAt !== undefined
      ? performance.now() - pose.detAt : null,
    // What the detection loop reported achieving (`cost`, from either capture
    // page's rolling-window meter) against what this server is currently
    // asking every client for — the drawer's own reading of "attempted, not
    // achieved". Coerced through Number.isFinite so a garbage or absent report
    // renders as no row rather than as NaN. Read off the latched detection,
    // not the newest message — a carry report has no `cost` at all.
    detect: pose?.det?.cost ? {
      detHz: Number.isFinite(pose.det.cost.detHz) ? pose.det.cost.detHz : null,
      detMs: Number.isFinite(pose.det.cost.detMs) ? pose.det.cost.detMs : null,
      targetMs: Number.isFinite(pose.det.cost.targetMs) ? pose.det.cost.targetMs : null,
      askedMs: Number.isFinite(pose.det.cost.askedMs) ? pose.det.cost.askedMs : null,
      blocked: Number.isFinite(pose.det.cost.blocked) ? pose.det.cost.blocked : null,
      serverAskedMs: Number.isFinite(settingsValues.poseRateMs) ? settingsValues.poseRateMs : null,
    } : null,
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
  // Ten times a second, so the rows are reused rather than rebuilt: a line torn
  // out and replaced under the pointer can never be selected, and the overlay
  // is exactly the readout someone copies a position out of.
  if (!show3d && !show2d && !showSide && !showFront) {
    syncTextRows(roomStats, []);
    return;
  }
  const infos = clientIds().map(clientInfo);
  const rows = [];
  // Tracking-lost clients first, and listed even when they have no tile and no
  // pose: this is the one state where the honest report is that there is no
  // position, rather than no client.
  for (const info of infos) {
    if (info.lostMs === null) continue;
    rows.push({
      color: '#e0603a',
      text: `P${info.id}  NO ARCORE TRACK ${(info.lostMs / 1000).toFixed(0)}s  `
        + '— position from tags only, nothing carried between sightings',
    });
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
    rows.push({
      color: info.poseAge > POSE_STALE_MS ? '#777' : roomClientColorCss(info.id),
      text: `P${info.id}  ${p.map((v) => v.toFixed(2)).join(', ')}`
        + `  yaw ${Math.round(yaw)}°  pitch ${Math.round(pitch)}°`
        // Tag count off the latched detection (see the `poses` comment
        // above), position and age off the pose itself — a carry report is
        // still a fresh position, just not a fresh look.
        + `  ${(info.detMsg?.tags || []).length} tags  ${fmtAge(info.poseAge)}`,
    });
  }
  syncTextRows(roomStats, rows);
}, 100);

// ---------------------------------------------------------------------------
// Client drawer: the same roster with the controls attached. Everything a
// client can do to itself is drivable from here; the client owns the behaviour
// and reports back what it actually did, so nothing here is optimistic.
const drawerBtn = document.getElementById('drawerBtn');
const clientsPanel = createClientsPanel(drawerEl, {
  onControl: (clientId, action, value) =>
    signaling.send({ type: 'control', clientId, action, value }),
  onVcam: (clientId, on) => setVcam(on ? clientId : null),
  onRename: (clientId, name) => signaling.send({ type: 'device-rename', clientId, name }),
  onHover: setHovered,
  onTagOpen: setOpenedTag,
  onTagRemove: forgetMarker,
  onClientRemove: forgetClient,
  // What a tag has been doing, asked for by the card that is open. The panel
  // decides when — it is the only thing that knows which card that is — and the
  // answer goes straight back to it.
  onTagHistory: (id) => signaling.send({ type: 'tag-history', id }),
});
// Open by default: the drawer is the only place that lists a client which has no
// tile, so starting closed hides exactly the clients worth knowing about.
let showDrawer = true;

function refreshClientsPanel() {
  if (!showDrawer) return;
  clientsPanel.update(clientIds().map(clientInfo), roomFeed.getMarkerMap());
}

// Recording byte counts and pose ages move on their own; the roster message
// only arrives when something changes. Ghost notes ride the same tick — see
// tickGhostNotes.
setInterval(() => {
  tickGhostNotes();
  refreshClientsPanel();
}, 400);

function refreshViews() {
  const room = show3d || show2d || showSide || showFront;
  combinedBtn.classList.toggle('on', combinedActive);
  sceneBtn.classList.toggle('on', show3d);
  map2dBtn.classList.toggle('on', show2d);
  sideBtn.classList.toggle('on', showSide);
  frontBtn.classList.toggle('on', showFront);
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
  maps2d.classList.toggle('active', show2d || showSide || showFront);
  map2dCanvas.classList.toggle('active', show2d);
  mapSideCanvas.classList.toggle('active', showSide);
  mapFrontCanvas.classList.toggle('active', showFront);
  sceneView.setActive(show3d);
  map2dView.setActive(show2d);
  mapSideView.setActive(showSide);
  mapFrontView.setActive(showFront);
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
  { key: 'front', btn: frontBtn, get: () => showFront, set: (v) => { showFront = v; } },
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

// ---------------------------------------------------------------------------
// Server settings. The form is generated from the schema the server sends, so
// nothing on this page names a setting: adding one to settings.js puts it in
// the drawer, with its label, bounds, units and help text, unaided.
//
// Nothing here is optimistic — a control renders what the server last said,
// never what it was asked for, the same rule every remote control in the panel
// below follows. A number field is the one exception the rule has to allow: it
// is being typed into, so it is left alone while it holds the focus.
const settingsCard = document.getElementById('settingsCard');
const settingsRows = document.getElementById('settingsRows');
const settingsStatus = document.getElementById('settingsStatus');
const tagSizeLabel = document.getElementById('tagSizeLabel');
const SETTING_STATUS_MS = 5000;
let settingsSpec = [];
let settingsValues = {};
let settingsStatusTimer = null;

// The wire and the settings file are always in the stored unit; only this page
// says millimetres. Rounded back through toPrecision on the way out because the
// scaling is binary floating point — 0.15 m renders as 150.00000000000003 mm
// otherwise, in the one field whose whole purpose is a measured number.
const settingShown = (spec, v) => Number((spec.scale ? v * spec.scale : v).toPrecision(12));
const settingStored = (spec, v) => (spec.scale ? v / spec.scale : v);

function sendSetting(key, value) {
  signaling.send({ type: 'settings-set', values: { [key]: value } });
}

function setSettingsStatus(text, bad = false) {
  clearTimeout(settingsStatusTimer);
  settingsStatus.textContent = text;
  settingsStatus.classList.toggle('bad', bad);
  // An outcome, not a state: left up it reads as a condition of the panel, and
  // "applied" still sitting there ten minutes later says nothing true.
  if (text) settingsStatusTimer = setTimeout(() => setSettingsStatus(''), SETTING_STATUS_MS);
}

function makeSettingRow(spec) {
  const root = document.createElement('div');
  root.className = 'setting';
  if (spec.help) root.title = spec.help;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = spec.label;
  root.append(label);
  const handle = { root, spec };

  if (spec.type === 'bool') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle';
    // The dot is the whole of the button, so the name has to come from
    // somewhere — the row's label is beside it on screen but not in the
    // accessibility tree of the control itself.
    btn.setAttribute('aria-label', spec.label);
    // The wanted state, never a flip of what is drawn: this button shows what
    // the server last reported, which a click of its own may already have
    // overtaken.
    btn.onclick = () => sendSetting(spec.key, !btn.classList.contains('on'));
    root.append(btn);
    handle.btn = btn;
    return handle;
  }

  const input = document.createElement('input');
  input.type = 'number';
  input.min = settingShown(spec, spec.min);
  input.max = settingShown(spec, spec.max);
  input.step = spec.step ?? 'any';
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = spec.unit || '';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.textContent = 'Set';
  const commit = () => sendSetting(spec.key, settingStored(spec, Number(input.value)));
  // A setting that throws work away arms on the first click and acts on the
  // second — the same two-click gesture as the wipes in the tool row above and
  // the per-tag remove below, from the same primitive. One gesture for "this
  // one is not undoable", wherever it turns up.
  if (spec.danger) {
    apply.classList.add('danger');
    confirmButton(apply, commit, { armedTitle: `Click again — ${spec.danger}` });
  } else {
    apply.onclick = commit;
  }
  // A number field is typed into and left. Without this the value sits in the
  // box looking every bit as applied as one that was.
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter') apply.click();
  };
  root.append(input, unit, apply);
  handle.input = input;
  return handle;
}

function paintSettingRow(handle, spec) {
  const v = settingsValues[spec.key];
  if (v === undefined) return;
  if (handle.btn) {
    handle.btn.classList.toggle('on', !!v);
    // No wording: a text toggle carries its state in the dot, and the row's
    // own label already says what is being switched. The dot plus an "on"
    // beside it is the same fact twice, and it is what pushed the dot off the
    // centre of the button.
    handle.btn.setAttribute('aria-pressed', v ? 'true' : 'false');
    return;
  }
  if (document.activeElement === handle.input) return;
  const shown = String(settingShown(spec, v));
  if (handle.input.value !== shown) handle.input.value = shown;
}

// The tag size in the header, because every distance this dashboard draws
// scales by it and a wrong one is invisible in all of them — the room simply
// comes out uniformly too big. Click to open the drawer it is set in.
function updateTagSizeLabel() {
  const spec = settingsSpec.find((s) => s.key === 'markerSizeM');
  const v = settingsValues.markerSizeM;
  tagSizeLabel.textContent = spec && v !== undefined
    ? `tag ${settingShown(spec, v)} ${spec.unit}`
    : '';
}

function updateSettings(msg) {
  if (msg.spec) settingsSpec = msg.spec;
  settingsValues = msg.values || {};
  syncKeyed(settingsRows, settingsSpec, {
    key: (spec) => spec.key,
    make: makeSettingRow,
    paint: paintSettingRow,
  });
  updateTagSizeLabel();
  if (msg.error) setSettingsStatus(msg.error, true);
  else if (msg.changed?.length) {
    setSettingsStatus(`applied: ${msg.changed
      .map((k) => settingsSpec.find((s) => s.key === k)?.label ?? k).join(', ')}`);
  }
}

const drawerToggle = viewToggles.find((t) => t.key === 'clients');
tagSizeLabel.onclick = () => {
  if (!drawerToggle.get()) {
    drawerToggle.set(true);
    saveViewState();
    refreshViews();
  }
  settingsCard.scrollIntoView({ block: 'nearest' });
};

muteBtn.onclick = () => {
  soundOn = !soundOn;
  muteBtn.classList.toggle('on', soundOn);
  for (const dev of devices.values()) dev.video.muted = !soundOn;
};

// Room views start on — must run after every const above is initialized.
refreshViews();
