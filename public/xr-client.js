'use strict';

// XR client: camera pose from ARCore, corrected by room tags.
//
// The trade against /client, in one line: ARCore tracks the camera between tag
// sightings, so tags become an anchor rather than a continuous requirement — at
// the cost of a smaller camera image than /client's 4K, because `camera-access`
// hands over a GPU texture at ARCore's own resolution. This page does not stream
// video at all; it is a positioning client.
//
// Two frames of reference are in play and must not be confused:
// - the XR frame, whose origin is wherever the session started. Arbitrary, but
//   ARCore tracks the camera in it continuously.
// - the room frame, defined by the anchor tag and persistent across sessions.
// The client reports poses in the XR frame plus whatever tags it can see, and
// the server works out the transform between the two. All room-frame math
// stays on the server, exactly as it does for the ordinary client — this page
// still knows nothing about the marker map.

const report = document.getElementById('report');
const startBtn = document.getElementById('startBtn');
const overlay = document.getElementById('overlay');
const overlayText = document.getElementById('overlayText');
// The chip's text, which is a child of it rather than the element itself: the
// chip also holds the glyph it folds down to, and writing the report straight
// into the container would delete that glyph on the first update.
const overlayTextBody = document.getElementById('overlayTextBody');
const btnToast = document.getElementById('btnToast');
const blankBtn = document.getElementById('blankBtn');
const streamBtn = document.getElementById('streamBtn');
const mapCanvas = document.getElementById('mapCanvas');
const camCanvas = document.getElementById('camCanvas');
const overlayRot = document.getElementById('overlayRot');
const overlayBtns = document.getElementById('overlayBtns');
const exitBtn = document.getElementById('exitBtn');
const mapBtn = document.getElementById('mapBtn');
const transparentBtn = document.getElementById('transparentBtn');
const headingBtn = document.getElementById('headingBtn');
const fitBtn = document.getElementById('fitBtn');
const reportBtn = document.getElementById('reportBtn');

// There are no devtools on a phone, and a script that throws while wiring
// itself up leaves a page that looks completely normal and does nothing — the
// buttons after the throw simply never get their handlers. Put where the probe
// result goes, so it is on screen the moment the session is left.
window.addEventListener('error', (ev) => {
  report.textContent =
    `error: ${ev.message} (${(ev.filename || '').split('/').pop()}:${ev.lineno})`;
});

// How often detection is *attempted*. The server's, not this page's: it is a
// room-wide setting (see settings.js) and every client has to be paced by the
// same one, or a survey's convergence depends on which phone walked it. The
// value here is only what stands until the first pose-config arrives.
let poseRateMs = 100;
// How often this client reports where it is, which is no longer the same thing.
//
// Tag detection costs a frame far more than a report does, so tying the report
// to it dropped the report rate to 3/s — measured. Two things broke that nobody
// connected to it at the time:
//
//   - The room views ease toward the last reported pose, so at 3/s the client's
//     dot moves in visible steps. The animation was never the problem; its input
//     was.
//   - `trackJitter` needs 8 samples inside a 1500 ms window — 5.3/s — so the
//     steadiness measurement simply stopped existing.
//
// ARCore has a pose every single frame, and the *carry* report costs nothing to
// produce: no camera read, no scan. So the report runs on its own clock and
// detection results ride on whichever report they are ready for.
const CARRY_INTERVAL_MS = 100;

let session = null;
// Identifies this ARCore session to the server. Its frame's origin is wherever
// the session started, so an alignment learned in one session means nothing in
// the next — and the server cannot tell the two apart from the poses alone,
// since a reconnect keeps the same clientId and ARCore's origin is not
// reported. Minted here because this is the only place that knows a session
// began.
let sessionId = null;
let refSpace = null;
// Which reference space was actually granted, as a string, for the report.
// 'local-floor' puts the session's y=0 on the floor and 'local' puts it at the
// start pose — a metre and a half apart, and nothing downstream could tell
// which it had been given. Measured over the existing corpus the camera's
// session y sits around 0.25 m, which is the start-pose answer, so this is not
// a hypothetical: anything wanting a floor has to know which it got.
let refSpaceKind = null;
let viewerSpace = null;
let gl = null;
let binding = null;
let core = null;
// The server's declared printed marker size, held until the detector exists.
let markerSizeM = 0.15;
let lumaSource = null;
let readCanvas = null;
let readCtx = null;
let pixels = null;
let lastPose = 0;
// When anything was last reported, by either path. Detection reports reset it,
// so a carry only goes out when a detection has not just covered it.
let lastReport = 0;
// The camera model of the most recent frame that was actually read. A carry
// report describes the same camera — it just has nothing new to say about what
// is in front of it — and the server keys the stored model on the size.
let lastIntr = null;
// The freshest ARCore pose the frame loop has seen, in CV convention. A
// detection report is built from the pose of the frame it *read*, which by the
// time it is sent is 300 ms old — a third of a second of walking. This is what
// goes alongside it so the dashboard can draw where the phone is rather than
// where it was.
let lastXrNow = null;
let lastTags = [];
// Video out, off by default — see setStreaming. `streamOn` is what was asked
// for and outlives a session; the rest exists only while frames are flowing.
let streamOn = false;
let camStream = null;
let camTrack = null;
let mediaW = 0;
let mediaH = 0;
let mediaStarted = false;
// Sticky for the session: a browser that cannot drive a
// canvas stream frame by frame does not get a second chance, and silence would
// look exactly like a feature nobody switched on.
let streamFailed = null;
// WebXR features the session actually granted (session.enabledFeatures),
// reported in client-state as reconnaissance: 'plane-detection' or 'anchors'
// being available would hand chunks of the custom CV over to ARCore.
let xrFeatures = null;
let roomPose = null;
// The last room fix that actually was one. `roomPose` is whatever the last
// report said, null pose included; this is what the map is turned and centred
// by, so a moment without a fix holds the view where it was rather than
// flinging it back to north-up and to the middle of the room and out again.
// The dot going stale on the map is what says the fix was lost.
let lastFix = null;
let busy = false;
// What ARCore actually handed over, reported rather than assumed: the camera
// image size is the device's choice, not this page's, and every range figure
// for tag detection is derived from it and from fx.
let camInfo = null;
// ARCore tracking loss. Held here rather than derived per frame because the
// thing worth knowing is how long it has lasted, and a frame on its own cannot
// say. Re-sent on a timer so the viewer can tell "still lost" from "gone".
let trackingLostSince = 0;
let lastLostPing = 0;
const LOST_PING_MS = 1000;

// Same device identity as /client on this phone — same browser, same stored id
// — so this page registers the same way. It stores nothing of its own: the
// server keeps XR reports out of the device's settings, since this page has no
// mic, no recorder and no resolution and would otherwise overwrite what the
// capture client on the same phone actually uses.
const device = resolveDevice('client');
const deviceIdReady = device.then((d) => d.id);
device.then((d) => {
  const label = document.getElementById('clientLabel');
  label.textContent = d.name || 'unnamed device';
  wireDeviceChip(label, 'client');
});

const signaling = connectSignaling('client', {
  onOpen() {
    clockSync.start();
    tx.socketOpened();
    // The server tracks a recording per socket, so a new socket needs a fresh
    // recorder — its first chunk carries the WebM header.
    if (mediaStarted) tx.startRecorder();
    sendClientState();
  },
  onClose() {
    tx.socketClosed();
  },
  onPong(msg) {
    tx.handlePong(msg);
  },
  onMessage(msg) {
    if (clockSync.handle(msg)) return;
    // The peer connection and the recorder, shared with /client.
    if (tx.handleMessage(msg)) return;
    // The room as the server has it — survey, carved floor, walls — for the map
    // below. Only sent while this client says it is drawing one.
    if (roomFeed.handle(msg)) return;
    if (msg.type === 'room-pose') {
      roomPose = msg;
      if (msg.pose) lastFix = msg.pose;
      // Which of the dots on the map is this phone. Only the server knows — the
      // clientId is its own numbering — and the near fit has to be able to ask
      // what *this* client is looking at rather than guess from the geometry.
      if (msg.clientId !== undefined) mapView.setSelfClient(msg.clientId);
      // The map's rotation comes from the same fix the overlay reports, so the
      // two can never disagree about which way this phone is pointing.
      applyMapView();
    }
    else if (msg.type === 'pose') {
      // Every localized client's dot, this one included: the server sends the
      // same slim report for all of them, so the phone's own position arrives
      // by the same path as everybody else's.
      roomFeed.applyPose(msg.clientId, msg);
    } else if (msg.type === 'client-gone') {
      roomFeed.removeClient(msg.clientId);
    } else if (msg.type === 'control') {
      // The dashboard drives every client through one message shape. This page
      // has no mic, no recorder and no resolution to change, and its tag
      // detection is the whole point, so blanking and the map are all it
      // answers to.
      if (msg.action === 'blank') blank.set(!!msg.value);
      else if (msg.action === 'map') setMapMode(msg.value);
      // Wanted state, never a toggle — the dashboard's view is up to a second
      // old, and a toggle raced against a stale view lands inverted.
      else if (msg.action === 'stream') setStreaming(!!msg.value);
      // Cut the current recording and open the next one, when there is one.
      else if (msg.action === 'record') { if (mediaStarted) tx.startRecorder(); }
    } else if (msg.type === 'pose-config') {
      // Remembered, not just forwarded. pose-config arrives on connect; the
      // detector does not exist until the user starts the XR session, so
      // `core?.` dropped the size on the floor and the detector kept its 0.15
      // default for the whole session. A 142 mm tag solved as 150 mm reports
      // every distance 5.6% long, and nothing anywhere says so — the room is
      // just uniformly too big.
      if (msg.markerSizeM > 0) markerSizeM = msg.markerSizeM;
      if (msg.poseRateMs > 0) poseRateMs = msg.poseRateMs;
      core?.setMarkerSize(markerSizeM);
      detectWorker?.postMessage({ type: 'config', markerSizeM, poseRateMs });
    }
  },
}, deviceIdReady);
const clockSync = createClockSync(signaling);

// Recorder chunks, on their own socket so half a megabyte of WebM a second
// cannot queue ahead of this page's pose reports. Same deviceId as the socket
// above, so the server maps both to the same client. Opened whether or not
// streaming is ever switched on — it costs one idle socket, and a socket opened
// at the moment the first chunk is ready would have the chunk waiting on it.
const bulk = connectSignaling('client-bulk', {}, deviceIdReady);

// This page's video source is not a camera: it is the canvas the detector's own
// readback is flipped into, driven one frame at a time (publishFrame). So the
// stream runs at the detection rate, and with streaming off nothing here runs
// at all.
const tx = createMediaTx({
  signaling,
  bulk,
  clockSync,
  getStream: () => camStream,
  onStatus: setStatus,
  // Only if there is something to offer: a dashboard appearing while this page
  // has no frames would otherwise offer a track that has never produced one.
  onViewerReady: () => { if (mediaStarted) tx.startCall(); },
  onCallFailed: () => setTimeout(() => { if (mediaStarted) tx.startCall(); }, 1000),
});

// Blanking the display while the session keeps tracking. Mounted on the DOM
// overlay root rather than the body: in an immersive-AR session that subtree is
// the only thing the UA composites over the camera passthrough, so black put
// anywhere else never reaches the screen.
const blank = createBlankScreen(overlay, (on) => {
  blankBtn.classList.toggle('active', on);
  sendClientState();
});

// The room map, on the phone that is surveying the room. Same renderer the
// dashboard draws its top view with, fed the same server messages — the point
// is not to have a second map but to have that one map here as well, so the
// survey can be read while walking it instead of from across the room.
//
// Drawn from the XR session's frame loop while a session is running: the page's
// own requestAnimationFrame is not guaranteed to be serviced inside an
// immersive session, and a map that silently stops updating is worse than none.
//
// Stepped well below the session's frame rate: tag detection is what this page
// is for and it is already the expensive thing in the frame, while the map is a
// readout of a survey that moves slowly. The easing in map2d works from the
// elapsed time, so a coarser step slows nothing down, it only draws it less
// often.
const MAP_FRAME_MS = 16;

// The stats chip was rewritten on every frame of the session. Touching the DOM
// inside a domOverlay makes the UA re-rasterise and re-composite that layer
// into the XR frame, and the layer now holds a full-screen canvas — so a text
// line changing at 60 Hz was paying for the map's pixels 60 times a second,
// whatever rate the map itself was drawn at. Nothing on it is worth reading
// faster than this.
const CHIP_INTERVAL_MS = 200;
let chipAt = 0;


function chipDue(now) {
  if (now - chipAt < CHIP_INTERVAL_MS) return false;
  chipAt = now;
  return true;
}

// What this page costs, which is the one thing about it that cannot be watched:
// the session owns the screen, so the figures are read afterwards out of the
// pose journal and the chip is only for the moment someone is holding the
// phone. Rates, not totals — a running frame count says the loop is alive,
// which a rate says too, and only a rate says whether something took the loop
// away.
//
// The window itself is `createCostMeter` (common.js), shared with `/client`'s
// detection meter — this shape function is what makes its output the same
// keys and rounding the chip and every existing journal already read.
const costMeter = createCostMeter({
  windowMs: 5000,
  shape: (win) => ({
    fps: win.rate('frames'),
    detHz: win.rate('dets'),
    detMs: win.mean('dets'),
    flipMs: win.mean('flips', 1),
    // What handing that same picture to the encoder costs on this thread. The
    // encode itself is off it; this is only the frame being taken.
    txMs: win.mean('tx', 1),
    // Detections that came due and were dropped because the previous one was
    // still out. This is the gap between the rate asked for and the rate
    // delivered — the number that moves first when anything new is added to
    // the frame.
    blocked: win.count('blocked'),
    // The interval this loop actually gates on and the one it was asked for —
    // equal here (this path has no idle backoff), but the dashboard reads both
    // off one shape, so XR carries the pair too rather than being a special
    // case.
    targetMs: poseRateMs,
    askedMs: poseRateMs,
  }),
});

function costFrame(now) {
  costMeter.roll(now);
  costMeter.bump('frames');
}

// The same object on the chip and on every report, so the journal can never
// disagree with what the screen said.
function costReport() {
  return costMeter.report();
}

function costLine() {
  const c = costReport();
  if (!c) return '';
  return ` · ${c.fps}f/s · det ${c.detHz}/s`
    + (c.detMs === null ? '' : ` ${c.detMs}ms`)
    + (c.blocked ? ` · ${c.blocked} late` : '');
}

// Video out, on its own line only while it is on or has failed — the state that
// matters is "this session is also encoding", and a page not streaming should
// not spend a line saying so.
function streamLine() {
  if (streamFailed) return `\nstream OFF — ${streamFailed}`;
  if (!streamOn) return '';
  if (!mediaStarted) return '\nstream starting…';
  const c = costReport();
  return `\nstream ${mediaW}x${mediaH} · rec`
    + (c?.txMs === null || c?.txMs === undefined ? '' : ` · ${c.txMs}ms`);
}

// The overlay is the only diagnostic surface this page has, and it can only be
// read by holding the phone — which is the one thing you cannot do while
// walking the room it is describing. So every update is also reported to the
// server, which appends it to a file: what the phone showed, when, without
// anyone having to be looking at it.
//
// One helper because there are two places that write the overlay (the
// tracking-lost line and the full report), and a second copy of the reporting
// would silently cover only one of them — which would be the wrong one, since
// the lost case is the one nobody is watching.
const OVERLAY_REPORT_MS = 1000;
// -Infinity, not 0: the first overlay is the one worth having — it is what the
// screen said before anyone could pick the phone up, and a session that fails
// on startup never gets a second one.
let lastOverlayReport = -Infinity;

function setOverlay(text) {
  overlayTextBody.textContent = text;
  // Reported far more slowly than it is drawn: the overlay refreshes five times
  // a second and nothing in it changes meaningfully that fast.
  const now = performance.now();
  if (now - lastOverlayReport < OVERLAY_REPORT_MS) return;
  lastOverlayReport = now;
  signaling.send({ type: 'client-overlay', text });
}
let mapFrameAt = 0;
const mapRaf = (cb) => {
  const step = (t) => {
    if (session && t - mapFrameAt < MAP_FRAME_MS) {
      session.requestAnimationFrame(step);
      return;
    }
    mapFrameAt = t;
    cb(t);
  };
  if (session) session.requestAnimationFrame(step);
  else requestAnimationFrame(step);
};
// The backing store is capped well under this screen's own resolution: the map
// is a full-screen layer the compositor lifts over the camera passthrough on
// every frame, so its bytes are paid twice, and at DPR 3 that is ~10 MB a frame
// on a phone already spending its budget on native-resolution tag detection.
// A quarter of the pixels, and the map is line work and flat cells rather than
// anything that shows the difference.
const MAP_MAX_PX = 1.2e6;
const mapView = createMap2dView(mapCanvas, 'top', { raf: mapRaf, maxPixels: MAP_MAX_PX });
const roomFeed = createRoomFeed([mapView]);
// off -> the AR passthrough alone, as before; split -> map over the lower half;
// full -> map over the passthrough entirely. One button cycles them.
//
// Full by default, and with `transparent` below that is the whole screen showing
// the room over the passthrough rather than instead of it — the reason this
// page draws a map at all. It is a preference, not a state: it survives a
// session ending, and only the *subscription* follows what can actually be
// drawn (see sendClientState).
const MAP_MODES = ['off', 'split', 'full'];
let mapMode = 'full';

// The camera at a tenth of the size, for the mode where the map covers the
// passthrough. The passthrough itself cannot be scaled — it is composited by
// the UA behind the whole overlay and nothing in the page can touch it — but
// the detector reads the camera image back on every detection frame anyway, so
// this costs one drawImage on a canvas that already exists. It is the
// detector's own view, which is the honest thing to show: if it is dark, or
// stale, or looking somewhere else, that is why no tags are being found.
const CAM_PREVIEW_PX = 180;   // backing store; CSS decides the drawn size
const camCtx = camCanvas.getContext('2d');

// Shown only where the passthrough is genuinely hidden: full screen *and* not
// transparent. In split mode the real thing is on screen above the map, and
// with the backdrop off the map is see-through and the passthrough is already
// the background — a small copy of it in the corner is then just clutter over
// itself. Both toggles feed this, so neither can decide it alone.
function updateCamInset() {
  camCanvas.classList.toggle('on', mapMode === 'full' && !transparent);
}

// The overlay's rotation is cancelled here, not inherited. The map is a drawing
// with an absolute up and has to be turned the right way up when the phone is
// held sideways; the camera image is a window on the room and is already fixed
// to the device, which is why passthrough looks right at any roll. Letting it
// ride the container's rotation turns it *away* from the room. Done in the
// pixels rather than in CSS so the element's box keeps the shape of what is in
// it — a rotated box would overflow its corner and take its own sizing with it.
function drawCamPreview(image) {
  const w = CAM_PREVIEW_PX;
  const h = Math.max(1, Math.round(image.height * (w / image.width)));
  const swap = screenRotDeg === 90 || screenRotDeg === 270;
  const cw = swap ? h : w;
  const ch = swap ? w : h;
  if (camCanvas.width !== cw || camCanvas.height !== ch) {
    camCanvas.width = cw;
    camCanvas.height = ch;
  }
  camCtx.setTransform(1, 0, 0, 1, 0, 0);
  camCtx.clearRect(0, 0, cw, ch);
  camCtx.translate(cw / 2, ch / 2);
  camCtx.rotate(-screenRotDeg * Math.PI / 180);
  camCtx.drawImage(image, -w / 2, -h / 2, w, h);
  camCtx.setTransform(1, 0, 0, 1, 0, 0);
}

// The map's axis gizmo is pinned to the bottom left corner of the canvas, and
// both of those edges are covered by something at one rotation or another. The
// canvas is inside the turned box, so a corner of it is a different corner of
// the phone at every quarter turn — which is why moving the close box in CSS
// did nothing for the gizmo: one is positioned in the page, the other is
// painted inside the canvas, and neither can see the other.
//
// Bottom: the button row, upright. The buttons are over the map (they are the
// only way out of a full-screen one), so the gizmo has to start above them.
// Measured rather than declared — the row's height moves with the labels the map
// itself brings in and with the gesture bar's inset. Turned sideways the buttons
// are a column down the right-hand edge and the bottom of the canvas is clear
// again, so it goes back to nothing.
//
// Left: the status bar, at rot90 only. Android draws it along the phone's
// physical top edge however the page is turned, and that edge is this box's left
// at rot90 — the same strip the close box had to be pushed clear of, so its own
// offset is what the gizmo clears too rather than a second copy of the number.
// At rot270 the physical top is the box's right-hand edge and the gizmo's corner
// is nowhere near it. rot180 (phone upside down) puts the status bar along the
// bottom, where the button row's own inset already covers it.
//
// `offsetTop`/`offsetLeft` rather than client rects: the container carries the
// screen rotation and a rect would come back turned with it.
function updateMapInset() {
  const sideways = screenRotDeg === 90 || screenRotDeg === 270;
  mapView.setChromeInset({
    bottom: sideways || !overlayBtns.offsetHeight
      ? 0
      : overlayRot.clientHeight - overlayBtns.offsetTop,
    left: screenRotDeg === 90 ? exitBtn.offsetLeft : 0,
  });
}

// The one setter. The button and the dashboard's `control` both land here, so
// the two cannot mean different things, and it is also what subscribes: the
// server sends the room only to a client that reports it is drawing one.
function setMapMode(mode) {
  mapMode = MAP_MODES.includes(mode) ? mode : 'off';
  mapCanvas.classList.toggle('split', mapMode === 'split');
  mapCanvas.classList.toggle('full', mapMode === 'full');
  updateCamInset();
  mapBtn.classList.toggle('active', mapMode !== 'off');
  // Which of the row's buttons exist at all — the three that only act on a map.
  overlayBtns.classList.toggle('mapOn', mapMode !== 'off');
  // After the visibility toggles above, since they are what changes the row.
  updateMapInset();
  // Stopped when it is off screen: it runs a frame loop of its own, and the
  // detector on this page is already the expensive thing in the session.
  // Only ever drawn inside a session: outside one the overlay is not composited
  // at all, and a view left running there would spin a frame loop against a
  // canvas with no size.
  mapView.setActive(mapMode !== 'off' && !!session);
  sendClientState();
}

// Everything that is not the room itself, off: the dark backing, the 1 m grid
// it carries, and the dashed tag-to-tag legs with their distance labels. What
// is left is tags, walls, the carved floor and the client dots over the camera
// passthrough, so the map reads as a HUD on the room rather than as a picture
// beside it. The legs are a measurement to check a survey against a tape — the
// dashboard's job, not something to read while walking a room.
let transparent = true;

// Which way is down, asked of ARCore rather than of the browser. The phone's
// orientation lock is deliberate and stays on, so the layout is portrait
// however the device is held and `screen.orientation` never changes — but the
// session's reference space is gravity-aligned, so world up expressed in view
// coordinates says exactly how far the screen has been rolled. The overlay is
// then turned the other way, which is the whole of it: nothing downstream knows.
//
// Snapped to quarter turns with a wide boundary, because this is a layout and
// it must not creep: a phone held at 50° is still being held upright.
const ROT_FLIP_DEG = 55;    // how far past a quarter turn before it changes
const ROT_FLAT_MIN = 0.35;  // screen-plane component of up below which it is flat
let screenRotDeg = 0;

function updateScreenRotation(orientation) {
  // World up in view space: +x is screen right and +y screen up, so its two
  // in-plane components are the roll and nothing else.
  const up = quatRotate(
    quatConj([orientation.x, orientation.y, orientation.z, orientation.w]),
    [0, 1, 0]);
  // Screen near horizontal — reading a roll off what is left is reading noise,
  // and a map that spins while the phone is laid flat is worse than a stale one.
  if (Math.hypot(up[0], up[1]) < ROT_FLAT_MIN) return;
  const deg = Math.atan2(up[0], up[1]) * 180 / Math.PI;
  const snapped = snapQuarterTurn(deg, screenRotDeg, ROT_FLIP_DEG);
  if (snapped === screenRotDeg) return;
  screenRotDeg = snapped;
  for (const r of [90, 180, 270]) overlay.classList.toggle(`rot${r}`, snapped === r);
  // The buttons move to the other edge with the turn, so what the gizmo has to
  // clear changes with it.
  updateMapInset();
}

// Heading up: the map turns *and slides* under the client marker, which holds
// still, rather than the marker turning and wandering over a map that never
// moves. Both halves come off the same fix, so the map is centred on the phone
// and turned about the point the phone is at — the room really does move under
// it. The direction is the camera's own forward in the room frame — the same +z
// convention every camera pose in this project uses — and the renderer works out
// which way that has to be turned for this projection. Off, the map keeps the
// room's own orientation and its own bounds, which is the view that matches a
// floor plan on a wall. On by default: this map is read while walking the room,
// where "which way am I facing" is the question being asked of it.
let headingUp = true;

// Close in on where the phone is standing instead of holding the whole survey
// in view. Off is the map this page has always drawn — everything surveyed, at
// whatever scale that takes, which at room scale puts the tags being looked at
// within a few pixels of each other. On, the view follows the pose and reaches
// only as far as this client's own business: the tags it can see and the walk it
// has been given. On by default, for the same reason heading-up is: this map is
// read while walking the room, and at room scale the whole-survey fit puts the
// tags being looked at within a few pixels of each other.
let nearFit = true;

// Both halves of "what is the view built around" come off the same fix, and the
// renderer takes them in one call, so this is the only place either is set.
function applyMapView() {
  // The turn is heading's alone; the centre is wanted by either of them, so a
  // fit that follows the pose does not also have to turn the room to get it.
  // Null is off, and only off: the hold through a dropout is `lastFix`, kept
  // here where "the last fix I had" is already known.
  mapView.setHeadingUp(
    headingUp && lastFix ? quatRotate(lastFix.q, [0, 0, 1]) : null,
    (headingUp || nearFit) && lastFix ? lastFix.p : null);
}

function setHeading(on) {
  headingUp = on;
  headingBtn.classList.toggle('active', headingUp);
  applyMapView();
}

// The diagnostic chip, on screen or slid off it. On by default: it is the only
// surface this page has, and a session that fails on startup has to say so
// without anyone having pressed anything first.
let reportOn = true;

function setReport(on) {
  reportOn = on;
  overlayText.classList.toggle('away', !reportOn);
  reportBtn.classList.toggle('active', reportOn);
}

function setNearFit(on) {
  nearFit = on;
  fitBtn.classList.toggle('active', nearFit);
  mapView.setNearFit(nearFit);
  applyMapView();
}

function setTransparent(on) {
  transparent = on;
  transparentBtn.classList.toggle('active', transparent);
  mapView.setLayer('backdrop', !transparent);
  mapView.setLayer('pairs', !transparent);
  updateCamInset();
}

// ---------------------------------------------------------------------------
// Video out. The camera on this page is a GL texture the detector reads back
// every detection frame; the stream is that same readback, flipped into the
// canvas it was already being flipped into, published one frame at a time. So
// the stream costs a draw and an encode and never a second look at the camera —
// and it runs at the detection rate, which on this phone is single figures.
//
// Off by default and session-scoped in effect: pose accuracy outranks the
// picture here, so this is a thing to switch on when someone wants to see what
// the phone sees, not a thing to leave running.
function setStreaming(on) {
  streamOn = on;
  streamBtn.classList.toggle('active', on);
  // Starting is the next detection frame's job — there is no frame to hand a
  // fresh track right now, and a recorder built against a track that has never
  // produced one has no size to configure itself from.
  if (!on) stopMedia();
  sendClientState();
}

// Returns false when this browser cannot drive a canvas stream frame by frame.
// A timer-driven captureStream is not an acceptable fallback: it would encode
// the same picture 30 times a second between detections, which is the one cost
// this page cannot afford.
function startMedia(canvas, w, h) {
  try {
    camStream = canvas.captureStream(0);
    camTrack = camStream.getVideoTracks()[0];
  } catch (err) {
    camStream = null;
    camTrack = null;
    streamFailed = err.message || 'captureStream failed';
  }
  if (camTrack && typeof camTrack.requestFrame !== 'function') {
    camStream = null;
    camTrack = null;
    streamFailed = 'no requestFrame';
  }
  if (!camStream) {
    // Rolled back before it is reported, so the dashboard never shows a switch
    // that is on against a page that refused.
    setStreaming(false);
    setStatus(`streaming unavailable: ${streamFailed}`);
    return false;
  }
  mediaW = w;
  mediaH = h;
  return true;
}

function stopMedia() {
  tx.stopRecorder();
  tx.stopCall();
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
  camTrack = null;
  mediaStarted = false;
  mediaW = 0;
  mediaH = 0;
}

// One frame of the stream, from the image the detector is about to look at.
function publishFrame(canvas, w, h) {
  // The encoder and the recorder are both bound to the frame size, so ARCore
  // handing back a different one is a new file and a new offer, not a resize.
  if (camStream && (w !== mediaW || h !== mediaH)) stopMedia();
  if (!camStream && !startMedia(canvas, w, h)) return;
  const t0 = performance.now();
  camTrack.requestFrame();
  costMeter.bump('tx', performance.now() - t0);
  if (mediaStarted) return;
  // Only now that a frame exists does the rest have something to describe.
  mediaStarted = true;
  tx.startRecorder();
  if (tx.viewerWaiting) tx.startCall();
}

// The dashboard's roster is built from what each client reports about itself.
// This page has far fewer knobs than /client and says so, rather than reporting
// defaults for controls it does not have.
function sendClientState() {
  signaling.send({
    type: 'client-state',
    kind: 'xr',
    res: 'xr',
    capture: camInfo ? { w: camInfo.w, h: camInfo.h } : null,
    mic: false,
    pose: true,
    session: !!session,
    blank: blank.on,
    // What is actually being drawn, not what is wanted: the mode is a
    // preference that outlives a session, and the server should not be sending
    // the room to a page with no overlay to draw it in.
    map: session ? mapMode : 'off',
    // What was asked for, not whether frames are flowing — `session` already
    // says whether anything can be flowing at all.
    stream: streamOn,
    xrFeatures,
  });
}

// WebXR view space is +x right, +y UP, -z forward. Every other camera pose in
// this project is OpenCV — +x right, +y down, +z forward — including the tag
// poses PnP produces from this very camera image. The two differ by a half turn
// about x, applied on the right (R_room_cv = R_room_view · R_x(180)).
//
// Confirmed on the device by cycling the candidates and watching which way the
// top view turned, not derived: several distinct mistakes here — wrong flip
// axis, a mirrored camera readback, multiplying on the wrong side — all show up
// identically as a heading that runs backwards, so the reasoning cannot pick
// between them and the phone can. Converting here keeps exactly one convention
// leaving this file.
const XR_TO_CV = [1, 0, 0, 0];   // quaternion (x, y, z, w) for R_x(180 deg)

function cvPose(transform) {
  const p = transform.position;
  const q = transform.orientation;
  return {
    p: [p.x, p.y, p.z],
    q: quatMul([q.x, q.y, q.z, q.w], XR_TO_CV),
  };
}

async function probe() {
  if (!navigator.xr) {
    report.innerHTML = '<span class="no">no WebXR in this browser.</span>';
    return;
  }
  const ar = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  report.innerHTML = ar
    ? '<span class="yes">✔ immersive-ar available</span>\n' +
      'Start the session, then walk the room. Point at a tag now and then — that is ' +
      'what ties ARCore\'s frame to the room frame and corrects its drift.'
    : '<span class="no">✘ immersive-ar unavailable</span>';
  startBtn.disabled = !ar;
  setStatus(ar ? 'ready' : 'unsupported');
}

// Camera intrinsics from the view's projection matrix, in the camera image's
// own pixels. WebXR gives a projection, not a camera model; for ARCore the
// camera image shares the view frustum, so the two are the same optics sampled
// at a different resolution.
// The frame size travels with the model: a principal point means nothing
// without the image it is a point in, and "is cx near w/2" is the one check
// that says whether this derivation held. proj[8]/proj[9] are the frustum's
// skew, which for a camera image should be ~0 — anything else is the *display*
// frustum leaking in (ARCore skews it when the camera image aspect does not
// match the screen), and a skew of 0.2 is 10% of the width of pointing error
// that PnP will quietly absorb as tag orientation.
function intrinsicsFromProjection(proj, w, h, viewport) {
  return {
    fx: proj[0] * w / 2,
    fy: proj[5] * h / 2,
    cx: w * (1 - proj[8]) / 2,
    cy: h * (1 + proj[9]) / 2,
    dist: [0, 0, 0, 0, 0],   // ARCore hands back an undistorted image
    w,
    h,
    // Not a ChArUco fit and not the FOV guess either: a derivation from the
    // frustum ARCore is already rendering with, at the camera image's own
    // resolution. It never goes through the stored-calibration ladder, so it has
    // no rotated or rescaled tier to be in.
    source: 'xr',
    scale: 1,
    from: null,
    calibrated: true,
    // The derivation's own inputs travel with it. cx/cy alone cannot be
    // checked: a principal point 10% off centre is either a real lens or this
    // projection describing the display rather than the camera, and only
    // proj[8]/proj[9] and the two aspect ratios can tell those apart.
    proj: [...proj].map((v) => Math.round(v * 1e6) / 1e6),
    viewport: viewport ? [viewport.width, viewport.height] : null,
  };
}

// The camera image arrives as a GL texture; ArUco needs pixels. This is the one
// part that cannot leave the page — readPixels needs the GL context the session
// renders with — so it is kept to exactly that: the read, into a buffer that is
// then handed to the worker whole.
//
// Bottom-up, as GL produces it. The flip into top-down image coordinates is the
// consumer's job now: the worker does it while copying into the Mat it was
// going to copy into anyway, and the on-page fallback does it below.
function readCameraPixels(tex, w, h) {
  if (!pixels || pixels.length !== w * h * 4) pixels = new Uint8Array(w * h * 4);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  if (complete) gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  return complete;
}

// The same bytes as an image the right way up, for the on-page detector and for
// the camera inset. Only called when one of those actually needs it — on the
// worker path with the inset off, nothing on the page ever touches these pixels
// again after the read above.
function pixelsToCanvas(w, h) {
  // Timed here rather than at the call sites: this is the page's own per-frame
  // cost for looking at the picture at all, and it has more than one consumer.
  const t0 = performance.now();
  if (!readCanvas) {
    readCanvas = document.createElement('canvas');
    readCtx = readCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (readCanvas.width !== w || readCanvas.height !== h) {
    readCanvas.width = w;
    readCanvas.height = h;
  }
  const img = readCtx.createImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    img.data.set(pixels.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  }
  readCtx.putImageData(img, 0, 0);
  costMeter.bump('flips', performance.now() - t0);
  return readCanvas;
}

async function start() {
  const canvas = document.createElement('canvas');
  gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true });
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      // 'plane-detection' and 'depth-sensing' ride along: everything here is
      // optional, so asking costs nothing on a device without them, and every
      // path downstream works without depth. Sampling depth at the tags, whose
      // distance the solver already knows, is the measurement that readmitted
      // it. Nothing in the product reads it today; the samples are journalled
      // so the measurement stays available to whatever asks for it next.
      optionalFeatures: ['camera-access', 'anchors', 'dom-overlay', 'hit-test',
        'plane-detection', 'depth-sensing'],
      depthSensing: {
        usagePreference: ['cpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'float32'],
      },
      domOverlay: { root: overlay },
    });
  } catch (err) {
    report.textContent = `session refused: ${err.message}`;
    return;
  }
  // What was actually granted, not what was asked for. The accessor is newish;
  // null means "this browser cannot say", which is itself worth reporting.
  xrFeatures = session.enabledFeatures ? [...session.enabledFeatures] : null;
  console.log('XR session features:', xrFeatures ?? 'unreported');
  sessionId = crypto.randomUUID();
  await gl.makeXRCompatible();
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  binding = new XRWebGLBinding(session, gl);
  refSpaceKind = 'local-floor';
  refSpace = await session.requestReferenceSpace('local-floor')
    .catch(() => {
      refSpaceKind = 'local';
      return session.requestReferenceSpace('local');
    });
  // 'local'/'local-floor' are world-locked: locating the viewer in them is
  // exactly what ARCore stops being able to do when tracking drops, which is
  // why getViewerPose returns null. The 'viewer' space is defined relative to
  // the device itself, so a pose in it needs no world tracking at all — and a
  // pose is only wanted here for the views it carries, since the camera image
  // and the projection matrix hang off XRView, not off knowing where the room
  // is. Tags do not need ARCore: they are an independent, absolute fix, and
  // /client localizes from them alone with no XR session anywhere.
  viewerSpace = await session.requestReferenceSpace('viewer').catch(() => null);

  // With the worker up, opencv.js is never loaded on this page at all — ~10 MB
  // and a wasm compile that only the detector needs, and the detector is over
  // there. ensureCore() below pulls it in if the worker path ever falls away.
  if (!ensureDetectWorker()) await ensureCore();

  overlay.classList.add('on');
  // Nothing in the overlay has a layout box until it is displayed, so the
  // measurement taken at load was of a hidden element and read zero.
  updateMapInset();
  session.addEventListener('end', () => {
    overlay.classList.remove('on');
    setStatus('session ended');
    session = null;
    sessionId = null;
    camInfo = null;
    refSpaceKind = null;
    // The cost window belongs to the session that was measured; carried over,
    // the next session's first reports would describe the last one's.
    costMeter.reset();
    // No more frames are coming, and a canvas track that stops being fed keeps
    // its last one — the dashboard would hold a tile that looks live for as
    // long as the page stayed open. `streamOn` survives: it is a standing
    // preference like the map mode, and the next session resumes on its first
    // detection frame.
    stopMedia();
    // Nothing is being blanked once the overlay is gone, and a client that
    // still claimed to be blank would be reporting a screen that is not. The
    // map is re-applied rather than turned off: the mode is the user's standing
    // preference and the next session should open the way this one closed, but
    // with no session it draws nothing and asks the server for nothing.
    blank.set(false);
    setMapMode(mapMode);
    sendClientState();
  });
  // Now that there is a session to draw in, the standing map preference takes
  // effect — this is what starts the view and subscribes to the room.
  setMapMode(mapMode);
  session.requestAnimationFrame(onFrame);
  setStatus('session running');
  sendClientState();
}

// Both detection sites go through here: the `busy` handshake, the schedule and
// the cost of a detection are one thing, and the tracking-lost branch below had
// its own copy of the first two before there was a third.
function startDetection(frame, view, pose, layer, now) {
  if (busy) {
    // Due, and dropped because the previous one had not come back.
    if (now - lastPose >= poseRateMs) costMeter.bump('blocked');
    return;
  }
  if (now - lastPose < poseRateMs) return;
  lastPose = now;
  busy = true;
  // Taken past the schedule check, not before it: this asks the layer for a
  // viewport, and the frame that is not going to detect has no use for one.
  detectAndReport(frame, view, pose, viewportOf(layer, view)).finally(() => {
    busy = false;
    costMeter.bump('dets', performance.now() - now);
  });
}

function onFrame(t, frame) {
  session.requestAnimationFrame(onFrame);
  costFrame(t);
  const layer = session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // ARCore not tracking costs the room-frame *carry* between sightings, and
  // nothing else. A tag in view is still an absolute fix, so detection keeps
  // running off the device-relative 'viewer' space and the client falls back to
  // reporting exactly what /client reports: tags, no XR pose, localized on the
  // server from the marker map alone. Losing the inertial track is precisely
  // when the tags matter most; stopping detection there had it backwards.
  const pose = frame.getViewerPose(refSpace);
  const now = performance.now();
  if (!pose) {
    if (!trackingLostSince) {
      trackingLostSince = now;
      lastLostPing = 0;
    }
    const lostMs = Math.round(now - trackingLostSince);
    // On entry, then once a second: the viewer needs to keep hearing this to
    // know the client is still there and still lost rather than gone.
    if (!lastLostPing || now - lastLostPing >= LOST_PING_MS) {
      lastLostPing = now;
      signaling.send({ type: 'xr-tracking', lost: true, ms: lostMs });
    }
    const blind = viewerSpace && frame.getViewerPose(viewerSpace);
    const blindView = blind && blind.views[0];
    // Null pose: no world pose exists, and that is what switches the report to
    // the tag-only message.
    if (blindView) startDetection(frame, blindView, null, layer, now);
    // Two lines: how long, and whether anything can still be read. `no cam`
    // is the difference that matters — with a camera image the tags still fix
    // the position outright, without one nothing can be detected at all.
    if (chipDue(now)) {
      setOverlay(
        `LOST ${(lostMs / 1000).toFixed(1)}s${blindView ? '' : ' · no cam'}\n`
        + `tags ${lastTags.length ? lastTags.map((x) => x.id).join(' ') : 'none'}`);
    }
    return;
  }
  if (trackingLostSince) {
    signaling.send({
      type: 'xr-tracking', lost: false, ms: Math.round(now - trackingLostSince),
    });
    trackingLostSince = 0;
  }
  const view = pose.views[0];
  lastXrNow = cvPose(pose.transform);
  updateScreenRotation(pose.transform.orientation);
  // Detection is far too expensive for every frame, and is a re-entrant
  // hazard — one at a time, on its own schedule (startDetection).
  // The viewport is the display the projection matrix was built for; it only
  // matters as the thing the camera image's aspect gets compared against.
  startDetection(frame, view, pose, layer, now);
  // Between detections: where ARCore says the camera is, and nothing else.
  sendCarry(pose, now);

  // Five short lines, in the order they are read while walking a room: where,
  // what the camera is, what it sees, where that puts you, how steady it is.
  // Every field here is one that cannot be read anywhere else on the phone —
  // the explanations that used to sit beside them are in this file's comments,
  // which is where a sentence belongs.
  if (!chipDue(now)) return;
  const p = pose.transform.position;
  setOverlay(
    `xr ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}`
    // The step before tracking is lost outright: ARCore still has an
    // orientation but is guessing the position. Poses taken here are worth
    // little and it is the warning that the next frame may have none at all.
    + `${pose.emulatedPosition ? ' · emulated' : ''}\n`
    // The size the detector is actually solving with, not the one the server
    // meant to send — the gap between those two is silent everywhere else.
    + (camInfo ? `cam ${camInfo.w}x${camInfo.h} fx ${camInfo.fx.toFixed(0)}` : 'cam —')
    + ` · tag ${(markerSizeM * 1000).toFixed(0)} mm\n`
    // Reprojection error and distance per tag: the server's gates are in
    // pixels and this camera is ~640x480, so a fix the 4K client would have
    // accepted can be discarded here — which looks like the tag not existing.
    + `tags ${lastTags.length
      ? lastTags.map((x) => `${x.id}@${x.err.toFixed(1)}px/`
        + `${Math.hypot(x.tvec[0], x.tvec[1], x.tvec[2]).toFixed(1)}m`).join(' ')
      : 'none'}\n`
    + (roomPose?.pose
      ? `room ${roomPose.pose.p.map((v) => v.toFixed(2)).join(' ')} · ${roomPose.quality}`
      : 'room —')
    // Steadiness, both halves side by side. The first is ARCore's own movement
    // over the window; the second is how far the tag fix wandered underneath
    // it, with that movement divided out, so the two are independent — walking
    // moves the first and should leave the second alone. The second is the
    // fix's own noise and the number the viewer's uncertainty circle is sized
    // from. What the loop cost rides along after it — see costLine.
    + (roomPose?.jitter
      ? `\nsteady ${roomPose.jitter.movedMm}/${roomPose.jitter.jitterMm} mm`
      : '\nsteady —')
    + costLine()
    + streamLine());
}

// A view from the 'viewer' space is not part of the render state's view list,
// so asking for its viewport can throw or come back null. The viewport is only
// ever a diagnostic (the camera aspect is compared against it), so it is
// optional by design and must never take the frame down with it.
function viewportOf(layer, view) {
  try {
    return layer.getViewport(view) || null;
  } catch {
    return null;
  }
}

// Detection off the page. It was inline here from the start, because unlike
// /client there is no MediaStreamTrack to hand a worker — the camera is a GL
// texture only this thread can read. That read is ~30 ms; the scan behind it
// was ~150, and all of it fell on the thread also running the XR frame loop,
// the DOM overlay and the map, which is why both were slow.
//
// The same worker and the same detector /client uses, fed the bytes instead of
// a frame. It stays optional in the same way: anything that goes wrong here
// falls back to detecting on the page rather than leaving the page unable to
// see tags at all.
let detectWorker = null;
let detectWorkerFailed = false;
let detectSeq = 0;
let detectPending = null;

function failDetectWorker() {
  detectWorker?.terminate();
  detectWorker = null;
  detectWorkerFailed = true;
  // Whoever is waiting on the frame in flight is released, or `busy` never
  // clears and detection stops for good — the exact failure this guards.
  const pending = detectPending;
  detectPending = null;
  pending?.done?.();
}

// The on-page detector, built only if it is actually going to be used. Awaited
// by the fallback path, which is the only caller once the worker is up.
let corePromise = null;

function ensureCore() {
  corePromise ??= (async () => {
    core = createDetectCore();
    await core.ensureReady();
    core.setMarkerSize(markerSizeM);
    lumaSource = createCanvasLumaSource(core.cv);
    return core;
  })().catch((err) => {
    setStatus(`detector failed: ${err.message}`);
    corePromise = null;
    return null;
  });
  return corePromise;
}

function ensureDetectWorker() {
  if (detectWorker || detectWorkerFailed) return detectWorker;
  if (typeof Worker !== 'function') {
    detectWorkerFailed = true;
    return null;
  }
  try {
    detectWorker = new Worker('/detect-worker.js');
  } catch {
    detectWorkerFailed = true;
    return null;
  }
  detectWorker.onerror = () => failDetectWorker();
  detectWorker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'fatal') {
      failDetectWorker();
      return;
    }
    if (msg.type !== 'xr-result') return;
    // The buffer is the page's only one and it was transferred away; take it
    // back before anything can return early, or the next frame allocates six
    // megabytes and this one leaks.
    if (msg.buf) pixels = new Uint8Array(msg.buf);
    const meta = detectPending;
    detectPending = null;
    if (!meta || meta.seq !== undefined && meta.seq !== msg.seq) return;
    if (!msg.error) reportDetection(meta, msg);
    meta.done?.();
  };
  detectWorker.postMessage({
    type: 'init',
    timeOrigin: performance.timeOrigin,
    markerSizeM,
    poseRateMs,
  });
  return detectWorker;
}

// A copy of this frame's CPU depth map, taken while the XRFrame is still
// valid — the XRDepthInformation object dies with the frame callback, but the
// points it will be sampled for come back from the worker long after. Inert
// bytes survive; ~38 KB at ARCore's usual 160x120, copied only while a
// detection is being dispatched (~4/s). These numbers reach the journal (so
// replay-depth.js can score them against the tags). Nothing here decides
// anything; the page just samples.
function grabDepth(frame, view) {
  if (!frame.getDepthInformation) return null;
  let di;
  try {
    di = frame.getDepthInformation(view);
  } catch {
    return null;
  }
  if (!di?.data) return null;
  const fmt = session?.depthDataFormat === 'float32' ? 'f32' : 'la';
  return {
    w: di.width,
    h: di.height,
    scale: di.rawValueToMeters,
    m: [...di.normDepthBufferFromNormView.matrix],
    data: fmt === 'f32' ? new Float32Array(di.data.slice(0)) : new Uint16Array(di.data.slice(0)),
  };
}

// Depth at a camera-image pixel, metres along the view z, or null.
//
// The lookup itself is `depthAtPixel` in frame-wire.js, because the server
// samples the same maps at box centres and two copies of this convention would
// be two chances to disagree about which way Y runs. This page keeps only the
// name it has always used.
const depthAt = depthAtPixel;

// `pose` is the camera's pose in the XR session frame, or null when ARCore has
// no world track. Null is not an error: it selects the tag-only report, the
// same message /client sends, which the server localizes from the marker map
// with no XR frame involved.
async function detectAndReport(frame, view, pose, viewport) {
  const camera = view.camera;
  if (!camera) return;
  const tex = binding.getCameraImage?.(camera);
  if (!tex) return;
  // Before the first await: the XRFrame is only valid inside the frame
  // callback, and everything below this line may yield.
  const depthSnap = grabDepth(frame, view);
  if (!readCameraPixels(tex, camera.width, camera.height)) return;

  const intr = intrinsicsFromProjection(
    view.projectionMatrix, camera.width, camera.height, viewport);
  // The camera image size is ARCore's choice, not this page's, so the roster
  // only learns it once a frame has actually arrived.
  const sizeChanged = !camInfo || camInfo.w !== camera.width || camInfo.h !== camera.height;
  camInfo = { w: camera.width, h: camera.height, fx: intr.fx };
  if (sizeChanged) sendClientState();
  // Everything the report needs that the detector does not: kept here while the
  // frame is away, because only one is ever in flight (`busy`).
  const meta = {
    pose, intr, w: camera.width, h: camera.height, depthSnap,
    t: clockSync.synced ? clockSync.at(performance.now()) : null,
  };
  // The camera's orientation this frame, for the feature tracker's flow seed.
  // Session-frame and CV-axis, which is the frame the intrinsics describe; only
  // the rotation *between* two frames is used, so the frame it is expressed in
  // cancels as long as it is the same one both times. Null when ARCore has no
  // world track — then there is nothing to predict from and the tracker starts
  // each point from where it was.
  const camView = pose ? { q: cvPose(pose.transform).q } : null;
  // The page looks at these pixels again for the inset and for the video
  // stream, and each costs a full-frame flip and raster — so the flip is done
  // once, for whichever of them is on, and not at all when neither is. The
  // on-page fallback below takes the same image rather than making a second.
  const insetOn = camCanvas.classList.contains('on');
  const wantMedia = streamOn && !!session;
  const image = insetOn || wantMedia
    ? pixelsToCanvas(camera.width, camera.height) : null;
  if (insetOn) drawCamPreview(image);
  if (wantMedia) publishFrame(image, camera.width, camera.height);

  const worker = ensureDetectWorker();
  if (worker) {
    // Transferred, not copied: six megabytes a frame is the whole reason this
    // moved off the page. The buffer comes back with the result — see below.
    const buf = pixels.buffer;
    pixels = null;
    meta.seq = ++detectSeq;
    worker.postMessage({
      type: 'xr-frame', seq: meta.seq, buf,
      w: meta.w, h: meta.h, flipY: true, intr, view: camView,
    }, [buf]);
    // The caller's `busy` guard is what keeps one frame in flight at a time, and
    // it releases on this promise — so it has to outlive the post and resolve
    // when the worker answers, not when the message is sent.
    return new Promise((resolve) => {
      meta.done = resolve;
      detectPending = meta;
    });
  }

  // On-page fallback: the same detector, the same source it always used, with
  // the flip this page used to do for everyone.
  if (!(await ensureCore())) return;
  if (!core.hasIntrinsics(meta.w, meta.h)) core.setIntrinsics(meta.w, meta.h, intr);
  const source = image ?? pixelsToCanvas(meta.w, meta.h);
  const res = await core.detect(lumaSource, source, meta.w, meta.h, performance.now());
  if (!res) return;
  reportDetection(meta, res);
}

// A report with no detection behind it: ARCore's pose, and an explicit statement
// that nothing was looked at.
//
// `scanned: null` is that statement, and it is load-bearing rather than tidy.
// The walls module reads it as a failed frame grab and refuses the report
// outright, which is exactly right here — a *missing* `scanned` means "an older
// client that always swept the whole frame", so an omitted field would let a
// carry frame be read as "the detector looked everywhere and saw no tags" and
// deposit negative evidence for tags that were never checked for. `tags: []`
// alone would not save it; the pair is what makes this safe.
//
// The rest of the pipeline needs no changes and gets none: the survey already
// treats a tag-less `xr-pose` as ARCore carrying the fix (`quality: 'tracked'`).

function sendCarry(pose, now) {
  // Nothing has described this camera yet, so there is nothing to report it as.
  if (!lastIntr || !camInfo) return;
  if (now - lastReport < CARRY_INTERVAL_MS) return;
  lastReport = now;
  signaling.send({
    type: 'xr-pose',
    sid: sessionId,
    xr: cvPose(pose.transform),
    source: 'xr',
    carry: true,
    t: clockSync.synced ? clockSync.at(now) : null,
    w: camInfo.w,
    h: camInfo.h,
    intrinsics: lastIntr,
    tags: [],
    mode: null,
    scanned: null,
  });
}

// Both paths end here: the detector's result plus what the page knew when the
// frame was taken. One report, one place, whichever thread did the work.
function reportDetection(meta, res) {
  if (!res) return;
  // Depth samples ride the report where the geometry to check them against
  // already is: a tag's centre depth lands beside the tvec whose z is the
  // solved truth, a tracked point's beside the pixel it was tracked at.
  // Sampled here rather than at grab time because only the detector knows
  // where the tags and points are.
  if (meta.depthSnap) {
    for (const t of res.tags || []) {
      const cs = t.corners;
      if (cs?.length !== 8) continue;
      const d = depthAt(meta.depthSnap,
        (cs[0] + cs[2] + cs[4] + cs[6]) / 4,
        (cs[1] + cs[3] + cs[5] + cs[7]) / 4,
        meta.w, meta.h);
      if (d !== null) t.d = d;
    }
    for (const p of res.points || []) {
      const d = depthAt(meta.depthSnap, p.u, p.v, meta.w, meta.h);
      if (d !== null) p.d = d;
    }
    meta.depthSnap = null;
  }
  // A detection report covers this tick, so no carry follows it — the two
  // together are what make the rate steady rather than lumpy.
  lastReport = performance.now();
  lastIntr = meta.intr;
  lastTags = res.tags || [];
  const common = {
    t: meta.t,
    w: meta.w,
    h: meta.h,
    intrinsics: meta.intr,
    tags: lastTags,
    // What the detector actually looked at, for the server's negative
    // evidence ("this tag should have been in view and was not"): a
    // partial-detection frame is usually an ROI scan that never looked where
    // the missing tag is, and scanned === null is a failed grab that looked
    // at nothing.
    mode: res.mode,
    scanned: res.scanned,
    // Which reference space the session actually got. Additive, and nothing in
    // the survey, the walls grid or the XR alignment reads it — old journals
    // replay bit-identically, which is the standing gate here.
    refSpace: refSpaceKind,
    // What the loop is costing, for the same reason and read the same way: the
    // only surface this page has is behind an immersive session, so a claim
    // about what a feature costs here has to come out of the journal rather
    // than off a screen nobody could be looking at while it was walking.
    cost: costReport(),
  };
  // With a world pose the server can tie ARCore's frame to the room and carry
  // the position between sightings; without one it gets the observations on
  // their own and solves them like any other client. The two message types are
  // separate server state, so flipping between them mid-session costs nothing —
  // the XR alignment is keyed by session id and picks up where it left off.
  signaling.send(meta.pose
    ? {
      type: 'xr-pose', sid: sessionId, xr: cvPose(meta.pose.transform),
      // Where the tags were seen from, and where the phone is now. Detection
      // takes ~300 ms, so by the time this is sent `xr` describes a position a
      // third of a second down the walk — right for the tags, wrong for the
      // dot on the dashboard. See alignXr.
      xrNow: lastXrNow,
      source: 'xr', ...common,
    }
    : { type: 'pose', calibrated: true, source: 'xr', ...common });
}

startBtn.onclick = start;
// Nothing to tear down here: `end` is requested and the session's own end
// handler does the rest, which is also the path the system back gesture and a
// headset's own exit take. Doing it here as well would be a second teardown
// that could run in a different order than that one.
// `pointerup`, not `click`: a click needs the press and the release to land on
// the same element with next to no travel between them, and this is a small
// target on a phone being held up at arm's length — the hand moves, the release
// lands a few pixels off, and the tap is silently dropped. A touch pointer gets
// implicit capture on press, so its pointerup is delivered here however far the
// finger drifted. Not `pointerdown` like the chip: this one ends the session,
// and a press that turns out to be the start of a swipe should not.
// The guard is what that capture costs — the release is delivered here whether
// or not it happened over the button, so where it happened has to be asked.
exitBtn.addEventListener('pointerup', (ev) => {
  ev.preventDefault();
  const over = document.elementFromPoint(ev.clientX, ev.clientY);
  if (over === exitBtn) session?.end();
});
// The row is glyphs, so the name of the control only exists at the moment it is
// pressed — and what is wanted then is not the name on its own but what the
// press did, which for every one of these is a state. Long enough to read at
// arm's length while walking, short enough not to sit over the map afterwards.
const TOAST_MS = 1400;
let toastTimer = 0;
function flashLabel(text) {
  btnToast.firstElementChild.textContent = text;
  btnToast.classList.add('on');
  // Restarted, not queued: two presses in a row must show the second answer for
  // its full time rather than have the first one's timer take it away early.
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => btnToast.classList.remove('on'), TOAST_MS);
}
const onOff = (on) => (on ? 'on' : 'off');
// One description of an icon button here: press it, then say what it now is.
// The label is read *after* the action, so it reports the new state rather than
// the one being left — the same rule the dashboard's non-optimistic controls
// follow, for the same reason.
function wireIconBtn(btn, run, label) {
  btn.onclick = () => {
    run();
    flashLabel(label());
  };
}
wireIconBtn(blankBtn, () => blank.toggle(), () => `Blank ${onOff(blank.on)}`);
wireIconBtn(streamBtn, () => setStreaming(!streamOn), () => `Stream ${onOff(streamOn)}`);
wireIconBtn(mapBtn,
  () => setMapMode(MAP_MODES[(MAP_MODES.indexOf(mapMode) + 1) % MAP_MODES.length]),
  () => `Map ${mapMode}`);
wireIconBtn(transparentBtn, () => setTransparent(!transparent),
  () => `Backdrop ${onOff(!transparent)}`);
wireIconBtn(fitBtn, () => setNearFit(!nearFit), () => `Zoom ${nearFit ? 'near' : 'all'}`);
wireIconBtn(reportBtn, () => setReport(!reportOn), () => `Report ${onOff(reportOn)}`);
// Tap the chip to send it away; the row's own button is what brings it back.
// Not a toggle on the chip itself: five lines of diagnostics over the map is
// worth one tap to be rid of, but once gone there is nothing left on screen to
// aim at, and a small mark left behind to aim at is exactly what could not be
// hit inside the session. So the two halves live in different places, and the
// one that has to work when there is nothing to see is a button in the row.
//
// Both events, because folded down this stopped answering `pointerdown` and
// then stopped answering `click` in the same way and neither is trusted on its
// own here. Setting a state rather than toggling one is what makes that safe:
// a tap that raises both says "away" twice.
const sendReportAway = () => setReport(false);
overlayText.addEventListener('pointerdown', sendReportAway);
overlayText.addEventListener('click', sendReportAway);
// The Android navigation bar comes and goes under the session; the overlay is
// sized in dvh and its safe-area inset follows, so the strip the buttons cover
// is not the same one it was.
window.addEventListener('resize', updateMapInset);
wireIconBtn(headingBtn, () => setHeading(!headingUp), () => `Heading ${onOff(headingUp)}`);
setHeading(headingUp);
setNearFit(nearFit);
setReport(reportOn);
// Every default applied once at load, so the buttons and the renderer start out
// agreeing with the variables above.
setTransparent(transparent);
setMapMode(mapMode);
probe();
