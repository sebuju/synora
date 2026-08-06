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
const objBtn = document.getElementById('objBtn');
const transparentBtn = document.getElementById('transparentBtn');
const headingBtn = document.getElementById('headingBtn');
const fitBtn = document.getElementById('fitBtn');
const reportBtn = document.getElementById('reportBtn');
const objList = document.getElementById('objList');
const objLines = document.getElementById('objLines');

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
// The server's declared printed marker size, held until the detector exists.
let markerSizeM = 0.15;
let readCanvas = null;
let readCtx = null;
let pixels = null;
// Object frames. All four are the server's to set (pose-config); the page only
// remembers them. Off by default and meant to stay off unless the object map is
// being worked on — pose accuracy outranks it, same standing as the video out.
let objFramesOn = false;
let objFrameMs = 500;
let objFrameLongEdge = 640;
let objFrameQuality = 0.6;
let objFrameDepth = true;
let objCanvas = null;
let objCtx = null;
let lastObjFrame = 0;
// Frame counter and the session it counts within: `fseq` is only unique inside
// one session, so the pair is what joins a picture to the pose taken from the
// same camera read. Reset with the session.
let objSeq = 0;
let objSeqSession = null;
// Which session id the *current* frames socket has been told about — a fact
// about that socket, not about this page, and that distinction is the bug this
// separation exists to stop. The server keeps the session id on the socket
// (`ws.frameSid`), so a frames socket that reconnects mid-session comes back
// knowing nothing; the page, remembering only "I have announced this session",
// never said it again. Every later frame then joined on `null:fseq` against
// poses keyed by a real session id, so nothing matched and not one object was
// ever positioned — silently, for the whole rest of the session. It survived
// only until the page was reloaded, which is what made a reload look like the
// cure. Cleared on every open of the frames socket, below.
let objSessionAnnounced = null;
// One encode in flight at a time. `toBlob` is asynchronous and its cost is off
// this thread, but queueing a second one behind a slow first would build a
// backlog of pictures nobody can join to anything by the time they arrive.
let objEncoding = false;
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
// Half the angle the lens covers, for the map's "what am I looking at" test.
// The *wider* of the two image axes, deliberately: which of them runs
// horizontally in the room depends on how the phone is being held, and this page
// does not track that for the map. Erring wide names an object beside the one
// being looked at; erring narrow hides the object being looked at, which is the
// failure that matters. Zero until a frame has arrived, and zero is no gaze.
let camHalfFovRad = 0;
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
      // Pairs this fix with the session pose that produced it, which is the
      // whole of the room<-session transform the object readout projects
      // through. Done on arrival rather than on a timer: the pair has to be the
      // same instant or the transform is a fit to two different moments.
      //
      // **The raw fix, not the one shown.** `msg.pose` carries the display
      // easing — a decaying offset at the camera that exists so the dot does not
      // jump — while the object map is built from the raw pose on the server. A
      // transform fitted to the eased one puts every projected object out by
      // whatever correction is still being absorbed, which is nothing between
      // tag corrections and 200 mm just after one: the box beside the clock
      // rather than around it, coming and going with no pattern on screen. The
      // fallback is the tag-only path, which does not ease and sends no
      // `rawPose`.
      updateRoomAlignment(msg.rawPose || msg.pose);
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
    } else if (msg.type === 'obj-shape') {
      // The outlines this PC fitted in one of this phone's own frames, and the
      // pose they imply.
      //
      // **Stale by construction.** It describes a frame that left here a third
      // of a second ago, in a view that has since moved — which is exactly why
      // it is drawn in its own colour and labelled, and why the projected map
      // shape beside it is *not* drawn from this. One of the two is a claim
      // about the room and the other is a claim about a moment that has passed,
      // and they must never be mistaken for each other.
      lastShapeMsg = { ...msg, at: performance.now() };
    } else if (msg.type === 'pose-config') {
      // Remembered, not just forwarded. pose-config can arrive before the
      // detector exists, and forwarding it to a detector that is not there yet
      // dropped the size on the floor and left the 0.15 default standing for
      // the whole session. A 142 mm tag solved as 150 mm reports every distance
      // 5.6% long, and nothing anywhere says so — the room is just uniformly
      // too big. `ensureDetectWorker` sends the remembered pair in its `init`.
      if (msg.markerSizeM > 0) markerSizeM = msg.markerSizeM;
      if (msg.poseRateMs > 0) poseRateMs = msg.poseRateMs;
      detectWorker?.postMessage({ type: 'config', markerSizeM, poseRateMs });
      // Remembered for the same reason as the two above: this arrives on
      // connect, and the session it configures may not exist for minutes.
      if (typeof msg.objFramesEnabled === 'boolean') objFramesOn = msg.objFramesEnabled;
      if (msg.objFrameRateMs > 0) objFrameMs = msg.objFrameRateMs;
      if (msg.objFrameLongEdge > 0) objFrameLongEdge = msg.objFrameLongEdge;
      if (msg.objFrameQuality > 0) objFrameQuality = msg.objFrameQuality;
      if (typeof msg.objFrameDepth === 'boolean') objFrameDepth = msg.objFrameDepth;
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

// Object frames, on a third socket. Not signaling — a 40 KB JPEG queued at the
// wrong instant delays every pose behind it, which is the whole reason the bulk
// socket exists. Not bulk either — binary there means a recorder chunk
// unconditionally, and a WebM stream promises nothing about its first bytes, so
// the two could only be told apart by guessing. Send-only, like bulk.
const frames = connectSignaling('client-frames', {
  // A new socket has never been told which session these pictures belong to,
  // whether this is the first open or a reconnect halfway through a walk. Only
  // the announcement is retracted: `objSeq` keeps counting, because fseq
  // numbers pictures within a *session* and a counter restarted here would give
  // two different pictures the same `sid:fseq` key — and the server's pose ring
  // would then hand a new detection an older frame's pose.
  onOpen() {
    objSessionAnnounced = null;
  },
}, deviceIdReady);

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
    // The object-frame channel's own cost, on the same window as everything
    // else it competes with. Split into the two things it actually does — the
    // flip-and-decimate on this thread, and the JPEG encode — because they have
    // different fixes if either turns out to be the expensive one, and because
    // the whole claim that this channel is affordable has to come out of the
    // journal rather than off a screen nobody is watching while walking.
    objHz: win.rate('objf'),
    objMs: win.mean('objf', 1),
    jpegMs: win.mean('jpeg', 1),
    // Where detection is running, and why it is not on the worker when it is
    // not. This page had no way to say either, which is how a session spent
    // detecting on the render thread at half the frame rate looked, in the
    // journal and on the server, exactly like a phone that was merely slow.
    det: detectWorkerReady ? 'worker' : 'off',
    detWhy: detectWorkerWhy,
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

// The last `obj-shape` push from the PC: what the detector found in one of this
// phone's own frames — every box, plus the outlines fitted inside the ones that
// had a shape to fit — and the camera pose they imply. Off unless the debug
// setting is on, and empty is the resting state.
let lastShapeMsg = null;
// How long a pushed outline is worth drawing. It already describes a frame a
// third of a second old, and past a second it is describing a different part of
// the room — at which point drawing it is worse than drawing nothing.
const SHAPE_DEBUG_MS = 1000;

// What a shape-derived fix says, against the pose the survey reported for the
// same frame.
//
// **A readout, never a correction.** Nothing on this page moves because of it:
// it is a second opinion published beside the first, and the disagreement
// between them is the product — the same show-both discipline `objects.js`'s own
// localization follows.
function shapeLine() {
  const m = lastShapeMsg;
  if (!m || performance.now() - m.at > SHAPE_DEBUG_MS * 4) return '';
  // **The refusal names its own test.** "No fix" was as far as this could see,
  // and this line is read while standing in front of the object that was
  // refused — which is the only place the difference between "the map holds two
  // of these and cannot tell them apart" and "the two mirror solutions were
  // equally good" can actually be acted on.
  if (!m.fix) {
    return m.outlines?.length
      ? `\nshape ${m.outlines.length} · no fix${m.why ? ` · ${m.why}` : ''}` : '';
  }
  const f = m.fix;
  // Where the survey has nothing, the fix's own room position is the whole of
  // what there is to show — and that is the case this exists for, not a
  // degraded one. Where the survey does have an answer, the offset between them
  // is the product and the position is not news.
  const head = f.dPosM === null || f.dPosM === undefined
    ? `at ${f.p[0].toFixed(2)} ${f.p[2].toFixed(2)}`
    : `off ${f.dPosM.toFixed(2)} m ${(f.dYawDeg ?? 0).toFixed(1)} deg`;
  return `\nshape ${f.cls} · ${head} · ${f.by}`
    + (f.rivals > 1 ? ` · ${f.rivals} rivals` : '');
}

// Video out, on its own line only while it is on or has failed — the state that
// matters is "this session is also encoding", and a page not streaming should
// not spend a line saying so.
// The detector, on its own line only when something is wrong with it. Detection
// is the whole point of this page, so a session running without it must not be
// silent — and the previous silence was worse than silence, because the page
// carried on detecting on its own thread and only the frame rate said so.
function detectorLine() {
  if (detectWorkerReady) return '';
  if (detectWorkerSpent()) return `\nDETECTOR OFF — ${detectWorkerWhy ?? 'unavailable'}`;
  return `\ndetector starting…${detectWorkerWhy ? ` (${detectWorkerWhy})` : ''}`;
}

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
// The object list overlays this map and already names everything in view, with
// room for a distance and a confidence beside the name. A second copy of those
// names printed on the marks themselves is the same text twice on the smallest
// screen this project draws to — so here the marks are the map and the list is
// the legend. The dashboard keeps its labels: there the map is the only place
// its objects are named.
mapView.setLayer('object-labels', false);
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
  // Which objects get named on the map: the ones in front of the camera. Same
  // fix and same axis as the turn above, but handed over unnegated — `setGaze`
  // wants the direction the lens points and `setHeadingUp` wants the turn that
  // puts it up the screen, which are not the same vector. Set unconditionally,
  // too: heading-up is a switch about how the map is drawn, and where the phone
  // is pointing is true either way. The half angle is the camera's own, out of
  // the intrinsics the detector already derived, so the map narrows to what the
  // lens actually covers rather than to a number picked to look right. No frame
  // yet means no intrinsics, and no gaze — every object is named until one
  // arrives.
  mapView.setGaze(
    lastFix ? quatRotate(lastFix.q, [0, 0, 1]) : null,
    lastFix ? lastFix.p : null,
    camHalfFovRad);
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

// Switching it off drops the rows rather than hiding them, which
// `updateObjectList` already does for anything that leaves view — a hidden SVG
// holding stale lines is a thing to get wrong later, and the rows cost nothing
// to make again when they are next in view.
function setObjects(on) {
  objOn = on;
  objBtn.classList.toggle('active', on);
  // The server only sends the object map to a client that says it is drawing
  // one, so the switch has to reach it — the same way the map mode does.
  sendClientState();
}

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
    // The object readout wants the object map and nothing else — not the walls
    // grid, not the marker map, none of the rest of the room feed. Reported
    // separately from `map` for exactly that reason: it was tied to the map
    // being on, which made a page with its own Objects button sit there drawing
    // nothing until an unrelated control was also switched on. Same rule as
    // `map` above: what is actually being drawn, not what is wanted.
    objects: session ? objOn : false,
    // What was asked for, not whether frames are flowing — `session` already
    // says whether anything can be flowing at all.
    stream: streamOn,
    // Reported outside a session too, which is the whole point: the cost meter
    // carries this while a session runs, and a page sitting on the 2D screen
    // unable to start one is exactly when nobody can see what it is waiting
    // for. 'worker' when it is up, otherwise why not.
    detector: detectWorkerReady ? 'worker' : (detectWorkerWhy || 'starting'),
    // Whether the button can be pressed at all, and what is holding it. A page
    // that answers the socket but refuses every tap looks identical to a frozen
    // one from the outside, and this is the difference.
    // `session` is in it deliberately: a page that believes it is mid-session
    // when it is not reports the same "cannot start" as a page waiting on its
    // detector, and telling those apart from the server is the whole point.
    canStart: !starting && !session && xrSupported && detectWorkerReady,
    // Holding a session that is not delivering frames. Reported rather than only
    // repaired, so the log records that it happened at all — the repair below
    // is silent by design and this failure has been invisible for weeks.
    stalled: !!session && lastXrFrameAt > 0
      && performance.now() - lastXrFrameAt > XR_FRAME_STALL_MS,
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

// --- the object readout ---
//
// The map inset answers "where are the objects in the room". It cannot answer
// "which of the things in front of me is which", because a plan view of a room
// and a view of a room are different pictures. This is that second question: the
// mapped objects the camera is actually pointing at, named, with a line from
// each name to where it is.
//
// **It draws the map, not the detector.** The detections themselves are made on
// the PC and arrive there hundreds of milliseconds after the frame they came
// from; a line drawn to one of those would point at where the object was, in a
// view that has since moved. A mapped object has a room position, this page
// knows where it is in the room every frame, so the line is current by
// construction — and what it shows is what the experiment is actually
// accumulating, which is the thing worth looking at while walking.

// The room frame and the session frame are both gravity-aligned, so what sits
// between them is a yaw and a translation — four numbers, the same four
// `objects.js` solves for server-side. Recovered here from a pair this page
// already has: the session pose it sent, and the room pose that came back for
// it.
// On by default: the readout is the whole reason this page shows objects at
// all, and a room with nothing mapped in front of the camera already draws
// nothing. Off is for when the labels are in the way of looking at the room —
// which, with a detector that mislabels as freely as this one still does, is a
// real thing to want.
let objOn = true;
// How stale a mapped object's last sighting may be and still be drawn.
//
// **This is what "only what is being detected" means, and it is why nothing is
// ray-traced against the walls.** An object behind a wall is not being detected
// — that is the whole content of the claim — so the evidence for hiding it is
// its own `lastSeenAtMs`, not a geometric guess about what the wall grid thinks
// is in the way. Recency is exact where an occlusion test would be approximate,
// costs nothing, and covers every other reason a mapped thing is not really
// there: moved, removed, or never was.
//
// Wide enough to survive the object push's own second of debounce plus the
// detector's ~300 ms; narrow enough that turning away from a chair drops it
// within a step.
const OBJ_FRESH_MS = 2500;
let roomFromSession = null;
// The session pose that was sent with the last report, waiting for its room
// pose to arrive. Paired by order rather than by a key: one report is in flight
// at a time (`busy`), so the room pose that comes back is this one's.
let pendingXr = null;

function updateRoomAlignment(room) {
  const xr = pendingXr;
  pendingXr = null;
  // One implementation, in pose-math.js, shared with the server's shape readout
  // and with replay-objects.js's ground truth. Three copies of a yaw convention
  // is three chances to get its sign wrong in a way nothing downstream can see.
  // This page reads `se3` off it rather than the yaw — see `roomToSession`.
  const a = sessionAlignment(xr, room);
  if (a) roomFromSession = a;
}

// A room point in the session's own reference-space coordinates. Positions are
// never converted to the CV convention (only orientations are, in `cvPose`), so
// this comes straight back out in the frame `view.transform.position` speaks.
//
// **The measured transform, not its yaw.** The room frame's gravity is the anchor
// tag's, and on the map this was found with it stands 5.8 degrees off ARCore's —
// so a yaw-only inverse is the true one with a tilt about the camera left in it.
// That error is nothing at the eye and everything at range: 77 mm at 1.5 m, and
// it is what put the object box beside the clock rather than around it while the
// camera-relative outline beside it landed correctly. See `sessionAlignment`.
function roomToSession(p) {
  if (!roomFromSession) return null;
  return transformPoint(se3Invert(roomFromSession.se3), p);
}

// A point in the reference space, to a pixel on the overlay — through the view's
// own projection matrix rather than through the camera intrinsics. The
// passthrough the user is looking at is composited from *this* projection, so
// this is the one transform that cannot disagree with what is on screen; the
// camera image has its own field of view and would put every line slightly off.
function toViewSpace(pSess, view) {
  const q = view.transform.orientation;
  const o = view.transform.position;
  // WebXR view space: x right, y up, -z forward.
  return quatRotate(quatConj([q.x, q.y, q.z, q.w]),
    [pSess[0] - o.x, pSess[1] - o.y, pSess[2] - o.z]);
}

function projectView(v, P) {
  const cw = P[3] * v[0] + P[7] * v[1] + P[11] * v[2] + P[15];
  if (!(cw > 0)) return null;           // behind the eye: not a place on screen
  const cx = P[0] * v[0] + P[4] * v[1] + P[8] * v[2] + P[12];
  const cy = P[1] * v[0] + P[5] * v[1] + P[9] * v[2] + P[13];
  return { x: (cx / cw * 0.5 + 0.5), y: (1 - (cy / cw * 0.5 + 0.5)) };
}

// Viewport fractions to `#overlayRot`'s own pixels.
//
// The projection above lands in the *unturned* viewport, and the list lives
// inside the box that CSS has turned by `screenRotDeg` — so a line drawn from
// one to the other has to cross that turn. Done here, once, rather than by
// taking the rotation off the box: the box is turned so the whole readout stands
// up with the phone, which is the entire reason it is readable.
//
// Both sizes come off `#overlayRot` itself rather than off the viewport, so the
// two ends of a line cannot be measured against two slightly different ideas of
// how big the screen is: the turned box already *is* the coordinate space the
// SVG draws in, and at a quarter turn its width is the viewport's height.
function viewportToOverlay(f) {
  const q = ((Math.round(screenRotDeg / 90) % 4) + 4) % 4;
  const rw = overlayRot.clientWidth;
  const rh = overlayRot.clientHeight;
  const vw = (q % 2) ? rh : rw;
  const vh = (q % 2) ? rw : rh;
  const dx = f.x * vw - vw / 2;
  const dy = f.y * vh - vh / 2;
  // The inverse of the CSS turn: rotate(90deg) draws a local offset (a,b) at
  // screen offset (-b,a), so a screen offset comes back as (dy,-dx), re-centred
  // on the turned box.
  if (!q) return { x: dx + rw / 2, y: dy + rh / 2 };
  if (q === 1) return { x: dy + rw / 2, y: -dx + rh / 2 };
  if (q === 2) return { x: -dx + rw / 2, y: -dy + rh / 2 };
  return { x: -dy + rw / 2, y: dx + rh / 2 };
}

// A stable colour per object id, so a row and its mark on the map are the same
// thing and three chairs are three colours. The golden angle rather than a
// palette: there is no fixed number of objects to size one for.
function objColour(id) {
  return `hsl(${(id * 137.508) % 360}, 85%, 62%)`;
}

// What a row says about an object beyond its name. Two different confidences,
// and they are worth keeping apart because they fail in different ways:
//
// - **The detector's**, `conf` — the median score over the sightings that
//   explain this position. This is the one that answers "is this really a
//   speaker", and with a detector that calls a potted plant one it is the most
//   useful number on the row. A well-triangulated object with a mediocre score
//   is a confidently-placed mislabel, which is exactly the failure the map
//   cannot see by itself.
// - **The map's**, said in words rather than numbers: `mapped` against `cand`
//   is whether the position has been committed to, `weak` is an object standing
//   on the depth prior or on too little parallax to localize against. The
//   sighting count says how close a candidate is.
function objStatus(o) {
  if (!o.promoted) return `cand ${o.nObs}`;
  if (!o.usable) return `mapped ${o.nObs} · weak`;
  return `mapped ${o.nObs}`;
}

// A score is easier to act on as a colour than as two digits read at arm's
// length while walking. The bands are the detector's own operating range rather
// than round numbers: `DEFAULT_SCORE_MIN` is 0.35, so anything near it only
// just survived the threshold, and 0.45 is where the replay sweep put the knee
// between fragments and anchors.
function confClass(conf) {
  if (conf === null || conf === undefined) return '';
  if (conf < 0.45) return 'low';
  if (conf < 0.6) return 'mid';
  return '';
}

// The object's own extent, projected — eight corners of a box `r` across and
// `h` tall about its position, reduced to the rectangle they cover on screen.
//
// `w` and `h` are the object's measured extents in the room, median over the
// sightings that had them in frame. **Not `r`**, which is the 90th percentile
// of how far the bearings' closest approaches scatter — a few centimetres for a
// well-seen object, so a box built from it came out a tall thin sliver whatever
// the object was.
//
// A bearing-only map measures nothing along the view direction, so `w` stands
// for both horizontal axes. Honest for a chair, wrong for a wall, and the
// reason it is a width rather than a depth.
//
// The rectangle is what the map *claims* the thing occupies, so drawing it over
// the real object is the most direct check of that claim anywhere in this
// project: a box beside the chair rather than on it says the map is wrong, with
// no number having to say so first.
//
// Returned as null when the box is wholly behind the eye or wholly off screen,
// which is also the in-view test — an object is in view when its extent is,
// not when its centre point happens to fall inside the frame.
function projectExtent(o, view) {
  const pSess = roomToSession(o.p);
  if (!pSess) return null;
  // The scatter is the fallback, and only that: an object with no measured
  // extent yet has been seen from too few angles to have one, and a small box
  // is the honest way to say so.
  const hw = Math.max(0.02, (o.w || (o.r || 0.3) * 2) / 2);
  const hh = Math.max(0.02, (o.h || o.w || 0.3) / 2);
  const v = toViewSpace(pSess, view);

  // **A billboard, not a solid box.** `w` and `h` were measured as the
  // *apparent silhouette* — how wide and tall the detector's box was, scaled to
  // metres at that range — so drawing them as an apparent silhouette is exactly
  // what they mean. Drawing them as a room-axis box asserted a depth that a
  // bearing-only map has never measured, and then took the screen bounds of the
  // whole thing: the near face projects larger than the far one, so the
  // rectangle came out inflated by about (d+r)/(d-r) — 44% on a 0.6 m object at
  // 1.7 m, which is exactly how much bigger than the clock it looked.
  //
  // Upright in the room and turned to face the camera, rather than square to
  // the view: the height was measured along world-vertical, so the box that
  // shows it has to stand the same way. The session frame is gravity-aligned,
  // so world up in view space is one rotation away.
  const upV = quatRotate(
    quatConj([view.transform.orientation.x, view.transform.orientation.y,
      view.transform.orientation.z, view.transform.orientation.w]), [0, 1, 0]);
  // Right-hand side of the billboard: perpendicular to both the view direction
  // and world up. Degenerate only when looking straight up or down a vertical
  // object's own axis, where view-space x is the honest fallback.
  let rx = upV[1] * v[2] - upV[2] * v[1];
  let ry = upV[2] * v[0] - upV[0] * v[2];
  let rz = upV[0] * v[1] - upV[1] * v[0];
  const rn = Math.hypot(rx, ry, rz);
  if (rn < 1e-6) { rx = 1; ry = 0; rz = 0; } else { rx /= rn; ry /= rn; rz /= rn; }

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let seen = 0;
  for (let i = 0; i < 4; i++) {
    const sx = (i & 1) ? hw : -hw;
    const sy = (i & 2) ? hh : -hh;
    const c = projectView([
      v[0] + rx * sx + upV[0] * sy,
      v[1] + ry * sx + upV[1] * sy,
      v[2] + rz * sx + upV[2] * sy,
    ], view.projectionMatrix);
    // A billboard straddling the eye plane keeps the corners that are in front;
    // one with none of them is behind the phone and is not in view at all.
    if (!c) continue;
    seen++;
    const at = viewportToOverlay(c);
    if (at.x < x0) x0 = at.x;
    if (at.x > x1) x1 = at.x;
    if (at.y < y0) y0 = at.y;
    if (at.y > y1) y1 = at.y;
  }
  if (!seen) return null;
  const rw = overlayRot.clientWidth;
  const rh = overlayRot.clientHeight;
  // Off the edge of the screen entirely: nothing to name and nothing to point
  // at. Tested against the rectangle rather than the centre, so a wardrobe
  // filling the view still counts as in view when its middle is off frame.
  if (x1 < 0 || y1 < 0 || x0 > rw || y0 > rh) return null;
  return { x0, y0, x1, y1 };
}

// A pixel of the camera image, to a point on the overlay.
//
// The outline was fitted in the camera image, which has its own field of view;
// the passthrough on screen is composited from `view.projectionMatrix`. So the
// pixel is turned into a *ray* through the camera model and that ray is
// projected — which is exact for direction, and a perspective projection sends
// every point on a ray to the same place, so no range is needed and none is
// invented. The offset between the camera's optical centre and the view origin
// is ignored: it is millimetres, against an overlay that is already describing a
// frame a third of a second old.
function projectCameraPixel(u, v, intr, view) {
  const d = [(u - intr.cx) / intr.fx, (v - intr.cy) / intr.fy, 1];
  // CV axes (x right, y down, z forward) to WebXR view axes (x right, y up,
  // -z forward) — the same conversion `cvPose` makes for orientations.
  const c = projectView([d[0], -d[1], -d[2]], view.projectionMatrix);
  return c ? viewportToOverlay(c) : null;
}

// What the detector found, drawn where it found it — for the objects the list
// beside it is naming, and no others.
//
// **This is the only overlay on this page that cannot be in the wrong place.**
// The box and the outline arrive in the pixels of a frame this phone sent, and
// `projectCameraPixel` puts a frame pixel back on the screen through the camera
// model that produced it — so the drawing is right whatever the map believes.
// It costs the one thing it cannot avoid: the round trip. The frame left ~300 ms
// ago and the view has moved since, so everything here lags a moving camera and
// is exact for a still one. That is a fair trade and the map's version of the
// same picture was not: it is current every frame and lands beside the object,
// because a position triangulated from bearings is a claim about the room and
// this is a claim about the image.
//
// The outline keeps its own pale dashed stroke rather than the class colour —
// the box says *what*, the outline says what shape was fitted inside it, and one
// of the two being able to fail on its own is the point of drawing both.
const SHAPE_DEBUG_COLOUR = '#e8e8e8';
// Under the label text, so a box edge never runs through its own name.
const DET_LABEL_PAD = 3;
let shapeDebugEls = null;

function drawShapeDebug(view) {
  const m = lastShapeMsg;
  const live = m && lastIntr && performance.now() - m.at <= SHAPE_DEBUG_MS
    && m.w > 0 && (m.outlines?.length || m.boxes?.length);
  if (!shapeDebugEls) {
    if (!live) return;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    objLines.append(g);
    shapeDebugEls = { g, polys: [], boxes: [] };
  }
  if (!live) { shapeDebugEls.g.style.display = 'none'; return; }
  shapeDebugEls.g.style.display = '';
  // The outline is in the small frame's pixels and the camera model describes
  // the big one; a plain decimation relates them, which is the same relation
  // every bearing in the map already stands on.
  const s = lastIntr.w / m.w;
  const rings = [];
  for (const o of m.outlines || []) {
    const pts = [];
    if (o.kind === 'ellipse') {
      const c = Math.cos(o.theta);
      const sn = Math.sin(o.theta);
      for (let i = 0; i < 32; i++) {
        const t = (i / 32) * 2 * Math.PI;
        const x = o.rx * Math.cos(t);
        const y = o.ry * Math.sin(t);
        pts.push([(o.cx + x * c - y * sn) * s, (o.cy + x * sn + y * c) * s]);
      }
    } else if (o.kind === 'quad') {
      for (const p of o.pts) pts.push([p[0] * s, p[1] * s]);
    } else continue;
    const at = pts.map((p) => projectCameraPixel(p[0], p[1], lastIntr, view)).filter(Boolean);
    if (at.length >= 3) rings.push(at);
  }
  // Four corners projected one at a time, not two corners and a rectangle: the
  // overlay is turned by whatever quarter turn the phone is held at, and a
  // rectangle built from a projected min and max would be the axis-aligned
  // bounding box of the turned box rather than the box.
  const quads = [];
  for (const d of m.boxes || []) {
    // **The same objects the list is showing, and nothing else.** A detection
    // the map refused has no id and never gets here; one the map took but this
    // page is not listing — no position yet, out of view when the list was
    // built, or stale — is dropped here. The list answers what is being seen and
    // the box says where it is on screen; two different answers to that would be
    // the readout contradicting itself in the same glance.
    if (!objRows.has(d.id)) continue;
    const [x0, y0, x1, y1] = d.box;
    const at = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
      .map((p) => projectCameraPixel(p[0] * s, p[1] * s, lastIntr, view));
    if (at.some((p) => !p)) continue;      // a corner behind the eye: no box to draw
    quads.push({ at, d });
  }
  while (shapeDebugEls.polys.length < rings.length) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    el.setAttribute('stroke', SHAPE_DEBUG_COLOUR);
    el.setAttribute('stroke-width', '1');
    el.setAttribute('stroke-dasharray', '2 3');
    el.setAttribute('fill', 'none');
    shapeDebugEls.g.append(el);
    shapeDebugEls.polys.push(el);
  }
  while (shapeDebugEls.boxes.length < quads.length) {
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('stroke-width', '2');
    poly.setAttribute('fill', 'none');
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('font-size', '13');
    text.setAttribute('font-weight', '600');
    // Outlined in the page's own dark, because this is drawn over passthrough:
    // a lit wall and a white wall are both backgrounds this text has to survive.
    text.setAttribute('stroke', '#000');
    text.setAttribute('stroke-width', '3');
    text.setAttribute('paint-order', 'stroke');
    shapeDebugEls.g.append(poly, text);
    shapeDebugEls.boxes.push({ poly, text });
  }
  shapeDebugEls.polys.forEach((el, i) => {
    if (i >= rings.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.setAttribute('points',
      rings[i].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
  });
  shapeDebugEls.boxes.forEach((el, i) => {
    if (i >= quads.length) {
      el.poly.style.display = 'none';
      el.text.style.display = 'none';
      return;
    }
    const { at, d } = quads[i];
    // The object's own colour, which is the colour of its dot in the list — the
    // only thing tying a box on the room to a row beside it, now that neither
    // draws a leader to the other. Per object and not per class on purpose: two
    // chairs are two rows and have to be two boxes.
    const colour = objColour(d.id);
    el.poly.style.display = '';
    el.poly.setAttribute('stroke', colour);
    el.poly.setAttribute('points',
      at.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    // Off the corner nearest the top left of the *screen*, which is a different
    // corner of the box at every quarter turn — the text is upright in the
    // overlay's own space and has to be anchored in that space too.
    const lx = Math.min(...at.map((p) => p.x));
    const ly = Math.min(...at.map((p) => p.y));
    const label = `${String(d.cls).toUpperCase()} ${Math.round((d.score || 0) * 100)}%`;
    el.text.style.display = '';
    el.text.setAttribute('fill', colour);
    el.text.setAttribute('x', lx.toFixed(1));
    // Above the box, or inside its top edge when there is no room above — a
    // label off the top of the screen is a label that is not there.
    el.text.setAttribute('y', (ly > 16 ? ly - DET_LABEL_PAD : ly + 14).toFixed(1));
    if (el.text.textContent !== label) el.text.textContent = label;
  });
}

// Elements are made once per object and kept: a row and the text inside it.
// Every frame writes attributes and nothing else — text is compared before it is
// written, and the rows are only moved in the DOM when their order actually
// changes. Rebuilding this list at 60 Hz would be throwing away layout the
// browser had just done, sixty times a second, on the one thread this page
// cannot afford to spend.
//
// **Nothing here is drawn over the room any more.** The box and the shape this
// list used to draw around each object were the *map's* claim about where the
// thing is — a position triangulated from bearings over many frames, projected
// back out. Measured against the detector's own box in the frame it came from,
// the best-conditioned object on a real walk sat 87 mm out at 1.6 m, and a
// duplicate fragment of the same clock sat half a metre away with one
// observation behind it. A box beside the thing it names is worse than no box:
// it reads as the recogniser having missed, when the recogniser was right and
// the map is what is uncertain. What survives is the list, which says what is
// being seen without claiming to know exactly where, and `drawShapeDebug`,
// which draws the outline in the frame's own pixels and therefore lands on the
// object every time.
const objRows = new Map();      // id -> { row, dot, name, stat, conf }
// The order the rows are currently in, so a stable list costs no DOM writes at
// all. Standing still is the normal case and it should be free.
let objOrder = '';

function updateObjectList(view) {
  const objs = objOn ? roomFeed.getObjects()?.objects : null;
  const seen = new Set();
  if (objs && roomFromSession && overlayRot.clientWidth) {
    // Mapped objects first, then candidates; **within each group, most
    // confident first**.
    //
    // The two groups are not the same kind of claim and the list should not mix
    // them: a promoted object is what the map would localize against, a
    // candidate is a position it has not committed to. Inside a group the
    // detector's own confidence orders them, because with this mislabel rate
    // that is the question actually being asked of the list — range is a fact
    // about the room and says nothing about whether the label is right.
    // Distance still breaks a tie, so two equally-scored things read near-first.
    // Server time, which is what `lastSeenAtMs` is stamped in. Unsynced, the
    // freshness test cannot be asked and everything in view is drawn — the old
    // behaviour, rather than an empty readout with no way to tell why.
    const serverNow = clockSync.synced ? clockSync.at(performance.now()) : null;
    const here = [];
    for (const o of objs) {
      // Only what is actually being detected right now. An object the detector
      // has stopped reporting is one the camera cannot see — through a wall,
      // round a corner, or because it is no longer there.
      if (serverNow !== null && (!o.lastSeenAtMs || serverNow - o.lastSeenAtMs > OBJ_FRESH_MS)) {
        continue;
      }
      // In view means the object's *extent* is on screen, not its centre point —
      // a wardrobe filling the view is in view when its middle is off frame.
      // The projection is only ever asked this question now; nothing is drawn
      // from the answer.
      if (!projectExtent(o, view)) continue;
      const d = Math.hypot(
        o.p[0] - (roomPose?.pose?.p?.[0] ?? 0),
        o.p[2] - (roomPose?.pose?.p?.[2] ?? 0));
      here.push({ o, d });
    }
    here.sort((a, b) => (b.o.promoted ? 1 : 0) - (a.o.promoted ? 1 : 0)
      || (b.o.conf ?? 0) - (a.o.conf ?? 0)
      || a.d - b.d);
    for (const item of here) {
      seen.add(item.o.id);
      let r = objRows.get(item.o.id);
      if (!r) {
        r = { row: document.createElement('div') };
        r.row.className = 'obj';
        r.dot = document.createElement('span');
        r.dot.className = 'dot';
        r.name = document.createElement('span');
        r.name.className = 'name';
        r.stat = document.createElement('span');
        r.stat.className = 'stat';
        r.conf = document.createElement('span');
        r.conf.className = 'conf';
        r.row.append(r.dot, r.name, r.stat, r.conf);
        objRows.set(item.o.id, r);
        objList.append(r.row);
      }
      // The dot is what ties a row to its mark on the map now that neither the
      // row nor the mark carries a leader to the other.
      r.dot.style.background = objColour(item.o.id);
      r.row.classList.toggle('cand', !item.o.promoted);
      const label = `${item.o.cls} ${item.d.toFixed(1)}m`;
      if (r.name.textContent !== label) r.name.textContent = label;
      const stat = objStatus(item.o);
      if (r.stat.textContent !== stat) r.stat.textContent = stat;
      // Per cent, not a fraction: this is read at arm's length while walking,
      // and "44%" is a thing anyone parses at a glance where "0.44" is two
      // digits and a decision about what scale they are on.
      const conf = item.o.conf ? `${Math.round(item.o.conf * 100)}%` : '';
      if (r.conf.textContent !== conf) r.conf.textContent = conf;
      r.conf.className = `conf ${confClass(item.o.conf)}`;
    }
    // Reordered only when the order changed. `append` on an element already in
    // the list moves it — which is how the rows are sorted without being
    // rebuilt — but a move is a layout mutation, and doing one per row per
    // frame would dirty layout the browser had just settled.
    const order = here.map((item) => item.o.id).join(',');
    if (order !== objOrder) {
      objOrder = order;
      for (const item of here) objList.append(objRows.get(item.o.id).row);
    }
  }
  // Rows for objects no longer in view go.
  for (const [id, r] of objRows) {
    if (seen.has(id)) continue;
    r.row.remove();
    objRows.delete(id);
    objOrder = '';        // the kept order no longer describes the list
  }
  // **Last, and not first.** The boxes are drawn only for the objects this list
  // is showing, so the list has to have been settled for this frame before they
  // can be filtered against it — drawn first, every box would be answering to
  // the previous frame's rows.
  drawShapeDebug(view);
}

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
  xrSupported = ar;
  updateStartBtn();
}

// The 2D page is the only surface anyone reads *before* deciding to start a
// session. Silent while the session owns the screen — `detectorLine` has it
// there.
let xrSupported = false;

// The button is the whole answer to "is this page ready", so it must not be
// offering a session this page cannot run. With no detector there is nothing to
// fall back to (see ensureDetectWorker), so a session started without one is a
// walk that records no tags — and the only sign used to be a line of status
// text nobody should have to watch for. It lights up by itself when the
// detector comes up.
function updateStartBtn() {
  // Asserted here rather than only where the session ends, because this runs on
  // every path that could have left it wrong — probe, detector up or down,
  // resume, start, end. `#overlay` is `position: fixed; inset: 0`, so shown
  // without a session it is a full-screen layer over the 2D page. With the map
  // off it holds no button row, and the text chip can be tucked off-screen, so
  // what is left is transparent, empty, and swallows every tap on the page
  // underneath. From the outside that is indistinguishable from a frozen tab —
  // the sockets keep answering, the roster keeps updating, and nothing on the
  // screen reacts.
  if (!session) overlay.classList.remove('on');
  startBtn.disabled = starting || !xrSupported || !detectWorkerReady;
  startBtn.textContent = detectWorkerReady || !xrSupported
    ? 'Start XR session' : 'Start XR session — detector not up';
  if (session) return;
  if (!xrSupported) setStatus('unsupported');
  else if (detectWorkerReady) setStatus('ready');
  else setStatus(detectWorkerWhy ? `${detectWorkerWhy} — retrying` : 'detector starting…');
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

// The same bytes small, for the object detector on the PC.
//
// Deliberately *not* pixelsToCanvas followed by a downscale: on the ordinary
// path (inset off, video out off) nothing else on this page touches these
// pixels after the read, and paying a full-frame flip and raster to then throw
// nine tenths of it away is the kind of cost that ends features here — the
// optical-flow tracker ran 178-206 ms a frame and took the phone from 6.4
// detections a second to 2.6.
//
// So the flip and the decimation happen in the same walk, and the walk is over
// the *output*: at factor 3 that is 287x640 rather than 860x1920. The 2x2
// average is what keeps it from aliasing into a mess a detector cannot read,
// and is four reads per output pixel rather than factor squared — a full box
// filter would read every input pixel and cost more than the flip it replaces.
//
// Tag detection is untouched by any of this and still runs at native
// resolution: a tag corner needs sub-pixel accuracy, a bounding box needs about
// one percent of the frame. Different requirement, different picture.
function pixelsToSmallCanvas(w, h, factor) {
  const t0 = performance.now();
  const ow = Math.max(1, Math.floor(w / factor));
  const oh = Math.max(1, Math.floor(h / factor));
  ensureObjCanvas(ow, oh);
  const img = objCtx.createImageData(ow, oh);
  const out = img.data;
  const row = w * 4;
  for (let oy = 0; oy < oh; oy++) {
    // GL hands the image over bottom-up, so output row 0 is input row h-1.
    // Flipping here costs nothing: the walk had to pick a source row anyway.
    const sy = h - 1 - oy * factor;
    const sy2 = sy > 0 ? sy - 1 : sy;
    const r0 = sy * row;
    const r1 = sy2 * row;
    let o = oy * ow * 4;
    for (let ox = 0; ox < ow; ox++) {
      const sx = ox * factor;
      const sx2 = sx + 1 < w ? sx + 1 : sx;
      const a = r0 + sx * 4;
      const b = r0 + sx2 * 4;
      const c = r1 + sx * 4;
      const d = r1 + sx2 * 4;
      out[o] = (pixels[a] + pixels[b] + pixels[c] + pixels[d]) >> 2;
      out[o + 1] = (pixels[a + 1] + pixels[b + 1] + pixels[c + 1] + pixels[d + 1]) >> 2;
      out[o + 2] = (pixels[a + 2] + pixels[b + 2] + pixels[c + 2] + pixels[d + 2]) >> 2;
      out[o + 3] = 255;
      o += 4;
    }
  }
  objCtx.putImageData(img, 0, 0);
  costMeter.bump('objf', performance.now() - t0);
  return objCanvas;
}

function ensureObjCanvas(ow, oh) {
  if (!objCanvas) {
    objCanvas = document.createElement('canvas');
    objCtx = objCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (objCanvas.width !== ow || objCanvas.height !== oh) {
    objCanvas.width = ow;
    objCanvas.height = oh;
  }
}

// When another consumer already paid for the full flip, the small picture is
// one drawImage off the canvas it produced — the UA's own downscale, which
// beats anything this file could write in JS.
function shrinkFlipped(image, w, h, factor) {
  const t0 = performance.now();
  const ow = Math.max(1, Math.floor(w / factor));
  const oh = Math.max(1, Math.floor(h / factor));
  ensureObjCanvas(ow, oh);
  objCtx.drawImage(image, 0, 0, ow, oh);
  costMeter.bump('objf', performance.now() - t0);
  return objCanvas;
}

// A frame is droppable by design, so a socket with a backlog drops rather than
// buffers: a picture that arrives late is worth nothing (its pose is long gone)
// and a queue of them would go on being late forever.
const OBJ_FRAME_MAX_BUFFERED = 512 * 1024;

// Produce and ship one object frame if one is due, and return the `fseq` the
// pose report for this same camera read should carry. Null when nothing was
// sent, which is most detections — the channel runs at its own much slower
// clock because an object stays where it is.
//
// The returned `fseq` is a claim about which picture *belongs* to this pose,
// not a promise one arrived: the encode is asynchronous and drops on a
// backlogged socket. The join is one-directional and tolerates that — a frame
// with no pose is unusable and a pose with no frame is just a pose.
function maybeSendObjectFrame(image, w, h, t, depthSnap) {
  if (!objFramesOn || !session) return null;
  const now = performance.now();
  if (now - lastObjFrame < objFrameMs) return null;
  // Still encoding the last one: skip without resetting the clock, so the next
  // frame is due immediately rather than a whole interval later.
  if (objEncoding) return null;
  lastObjFrame = now;
  // Whole-number decimation only — the walk in pixelsToSmallCanvas steps by
  // integers and a fractional factor would need interpolation it deliberately
  // does not do. So the real size is usually a little under what was asked for.
  const factor = Math.max(1, Math.round(Math.max(w, h) / objFrameLongEdge));
  const canvas = image
    ? shrinkFlipped(image, w, h, factor)
    : pixelsToSmallCanvas(w, h, factor);
  // One log per XR session, and the session id travels with the pictures: fseq
  // is only unique within a session, so a log that could not name its own would
  // be unjoinable to any pose.
  // Two separate questions, and conflating them is what broke the join: is this
  // a new session (so the counter restarts), and has *this socket* been told
  // which session it is carrying (so it must be announced again).
  if (objSeqSession !== sessionId) {
    objSeqSession = sessionId;
    objSeq = 0;
  }
  if (objSessionAnnounced !== sessionId) {
    objSessionAnnounced = sessionId;
    frames.send({
      type: 'frames-begin', sid: sessionId, w: canvas.width, h: canvas.height,
    });
  }
  const fseq = ++objSeq;
  // The depth map rides along because the boxes it would be sampled at do not
  // exist yet — they are produced on the PC, long after the XRFrame that owned
  // this map has died. It roughly doubles the record; that is the price of
  // depth being available to the object map at all, and it is a setting so the
  // cost can be measured with it and without it.
  const depth = objFrameDepth ? depthSnap : null;
  sendObjectFrame(canvas, fseq, t, depth,
    (factor > 1 ? FRAME_FLAG_DOWNSCALED : 0)
    | (image ? FRAME_FLAG_REUSED_FLIP : 0)
    | (depth ? FRAME_FLAG_DEPTH : 0));
  return fseq;
}

function sendObjectFrame(canvas, fseq, t, depth, flags) {
  // One encode in flight. The encode itself is off this thread; queueing a
  // second behind a slow first is what would build the backlog.
  if (objEncoding) return;
  objEncoding = true;
  const t0 = performance.now();
  const w = canvas.width;
  const h = canvas.height;
  // Serialized now rather than in the callback: the snapshot is this frame's,
  // and holding it across an await for the encoder to finish is how it would
  // end up describing a different moment than the picture beside it.
  const depthBytes = depth ? encodeDepthSection(depth) : null;
  // Which way up the picture was taken, read at send time for the same reason
  // the depth snapshot is serialized above: it belongs to this frame. The
  // picture shares the view's orientation, so the turn that stands this page's
  // own overlay back up stands the photograph up too — and it is the only place
  // in the system that knows, because gravity is ARCore's to report and the
  // layout is orientation-locked so the browser never sees the device turn.
  //
  // Descriptive only: nothing is rotated here or anywhere the detector, the
  // boxes or the bearings can see it. The image files on the PC are the only
  // consumer.
  canvas.toBlob((blob) => {
    objEncoding = false;
    if (!blob) return;
    costMeter.bump('jpeg', performance.now() - t0);
    if (frames.bufferedAmount > OBJ_FRAME_MAX_BUFFERED) return;
    const header = encodeFrameHeader({ w, h, fseq, t, flags, roll: screenRotDeg });
    frames.sendBinary(new Blob(depthBytes ? [header, depthBytes, blob] : [header, blob]));
  }, 'image/jpeg', objFrameQuality);
}

// One context for the page, not one per session. Every `start()` used to mint
// a canvas and a WebGL context and abandon the previous pair — including the
// `session refused` path below, which made a context and threw it away without
// ever having a session — and nothing was ever released. A browser caps how
// many live contexts a page may hold.
// A context per session, which is how this worked for months. It was briefly
// one per page, to fix the fact that every `start()` mints a canvas and a
// context and abandons the pair. Both cures were worse: reuse hands the next
// session a context still bound to an ended session's XRWebGLLayer, and an
// explicit `loseContext()` drops a live GPU context at the exact moment the UA
// is tearing down an immersive session — measured, and neither is a leak worth
// paying for. The abandoned context is left to the collector, as before.
function ensureGl() {
  if (gl) return gl;
  const canvas = document.createElement('canvas');
  gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true });
  // The one failure on this page that is genuinely unrecoverable in place, and
  // the one most likely to be behind a page that stops answering mid-session:
  // the GPU process dropping the context takes the session's framebuffer with
  // it, and every later frame reads a dead handle. Said out loud, because the
  // page's own screen is behind an overlay nobody can read at that moment.
  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    reportFailure('WebGL context lost');
    gl = null;
    endSession();
  });
  return gl;
}


// The page's last words. Sent rather than only logged, because a phone's
// console is not reachable from where this is being read, and the failures
// worth catching here are the ones immediately before it goes quiet.
function reportFailure(what) {
  setStatus(what);
  try {
    signaling.send({ type: 'client-error', what });
  } catch { /* the socket is the thing that just died, most likely */ }
}

// What a tap actually lands on. The page has twice now been reported dead to
// every touch while this end of it was demonstrably running — sockets answering,
// main thread alive — and from here there is no way to tell "the taps never
// arrive" from "they arrive and something invisible is on top of them". This
// says which, and if it is the second, it names the element.
//
// Capture on window, so it fires whatever is on top and whatever stops
// propagation further down. Throttled, because it reports over the network.
let tapReportAt = 0;
window.addEventListener('pointerdown', (ev) => {
  const now = performance.now();
  if (now - tapReportAt < 250) return;
  tapReportAt = now;
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const name = el
    ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`
      + `${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`
    : 'nothing';
  reportFailure(`tap at ${Math.round(ev.clientX)},${Math.round(ev.clientY)} hit ${name}`
    + ` · overlay ${overlay.classList.contains('on') ? 'ON' : 'off'}`
    + ` · session ${session ? 'held' : 'none'} · btn ${startBtn.disabled ? 'disabled' : 'enabled'}`);
}, true);

// And the synthesised one. A `click` is dispatched after the pointer sequence
// that produced it, which on the exit control means after the overlay has
// already been taken down — so it hit-tests against a completely different
// page from the one the finger touched. Reported separately from the tap above
// precisely so the two targets can be compared.
window.addEventListener('click', (ev) => {
  const el = ev.target;
  reportFailure(`click landed on ${el?.tagName?.toLowerCase() || '?'}`
    + `${el?.id ? `#${el.id}` : ''} · session ${session ? 'held' : 'none'}`);
}, true);

window.addEventListener('error', (ev) => {
  reportFailure(`error: ${ev.message} @ ${ev.filename || '?'}:${ev.lineno || 0}`);
});
window.addEventListener('unhandledrejection', (ev) => {
  reportFailure(`unhandled rejection: ${ev.reason?.message ?? ev.reason}`);
});

// `start()` is a button handler and requesting a session takes a visible
// moment, during which the button is still there and still live. Two overlapping
// starts would leave the second's session running against the first's
// framebuffer and reference spaces.
let starting = false;
// Long enough for a permission prompt and ARCore's own startup, short enough
// that a hang is a message rather than a dead page.
const START_TIMEOUT_MS = 30000;
// When the session loop last ran. A live session delivers frames continuously,
// so this going stale while the page is in the foreground is the one honest
// answer to "is the session the page thinks it has actually still there".
let lastXrFrameAt = 0;
// Generous: an immersive session delivers ~30-60 frames a second, so a second
// of silence is already far outside normal. The margin is for the moment right
// after unlocking, when the UA has resumed the page but may not have resumed
// the session's frame loop yet.
const XR_FRAME_STALL_MS = 2500;
// When the last session finished tearing down, and how long after that a new
// one is refused. See `start`.
let endedAt = -Infinity;
const START_COOLDOWN_MS = 1500;
// The stall check, running for as long as a session is held. It used to run
// only when the page became visible again, which covers the phone being locked
// and nothing else — and the way this actually fails is a session that dies
// while the page is in the foreground the whole time, with nobody to notice
// because the only thing watching was an event that never fires.
let stallTimer = 0;

async function start() {
  if (starting || session || !detectWorkerReady) return;
  // A session asked for while the last one is still being taken down is born
  // dead: it reports a camera model and then never delivers a frame, and the
  // page is left holding it — overlay up, every tap swallowed. The exit control
  // is a `pointerup`, and the compatibility `click` the UA synthesises after it
  // is dispatched once the overlay has already gone, so it hit-tests against
  // the 2D page underneath and can land on this button. A second real tap in
  // the same moment does the same thing.
  if (performance.now() - endedAt < START_COOLDOWN_MS) {
    setStatus('give the last session a moment to close');
    return;
  }
  starting = true;
  updateStartBtn();
  try {
    // Bounded, because `starting` disables the button and a promise that never
    // settles would disable it for the life of the page — a page that looks
    // alive, answers nothing, and can only be escaped by opening a new tab.
    // `requestSession` is the one call here that can hang rather than reject:
    // it is waiting on ARCore, and ARCore left in a bad state by a previous
    // session is exactly the case this page keeps meeting.
    await Promise.race([
      startSession(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('timed out')), START_TIMEOUT_MS)),
    ]);
  } catch (err) {
    report.textContent = `could not start: ${err.message}`;
    setStatus(`start failed: ${err.message}`);
  } finally {
    starting = false;
    updateStartBtn();
  }
}

async function startSession() {
  ensureGl();
  // A session is a fresh chance for the detector: the failures that put it on
  // this page are LAN fetches at a bad moment, so exiting AR and going back in
  // retries rather than needing the page reloaded.
  detectWorkerTries = 0;
  detectWorkerNextTry = 0;
  ensureDetectWorker();
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

  overlay.classList.add('on');
  // Nothing in the overlay has a layout box until it is displayed, so the
  // measurement taken at load was of a hidden element and read zero.
  updateMapInset();
  session.addEventListener('end', endSession);


  // Now that there is a session to draw in, the standing map preference takes
  // effect — this is what starts the view and subscribes to the room.
  setMapMode(mapMode);
  lastXrFrameAt = performance.now();
  session.requestAnimationFrame(onFrame);
  startStallWatch();
  setStatus('session running');
  sendClientState();
}

// A session is only real while it is delivering frames. Nothing else the page
// can see distinguishes a live session from one that was born dead or died in
// place — XRSession has no property that admits either — so the frame loop is
// the signal, and this is what reads it. Without it the page sits holding a
// dead session with the overlay up, and since `#overlay` covers the whole
// viewport and `start()` refuses while a session is held, every tap on the page
// goes nowhere. That is the state that has been read as a frozen tab.
function startStallWatch() {
  clearInterval(stallTimer);
  stallTimer = setInterval(() => {
    if (!session) {
      clearInterval(stallTimer);
      stallTimer = 0;
      return;
    }
    if (performance.now() - lastXrFrameAt < XR_FRAME_STALL_MS) return;
    reportFailure('session stopped delivering frames — closing it');
    session.end?.().catch(() => {});
    endSession();
  }, 1000);
}

// The session teardown, by name and callable twice.
//
// It used to exist only as the `end` listener, which made the event the single
// source of truth about whether a session was over. It is not one: lock the
// phone during or just after a session and the event can simply never arrive.
// The page is then left believing it still has a session it does not have —
// and that state is indistinguishable, from the outside, from a frozen tab.
// `#overlay` keeps its `on` class, so a transparent full-screen layer sits over
// the 2D page and swallows every tap; `updateStartBtn` skips its own overlay
// assertion because it can see a session; and `start()` returns early for the
// same reason, so even a tap that landed would do nothing. Meanwhile the
// sockets keep answering and the roster keeps updating, which is why the server
// saw a perfectly healthy client the whole time.
//
// Idempotent, because both the event and the watchdog below may reach it.
function endSession() {
  if (!session && !overlay.classList.contains('on')) return;
  clearInterval(stallTimer);
  stallTimer = 0;
  overlay.classList.remove('on');
  setStatus('session ended');
  session = null;
  sessionId = null;
  camInfo = null;
  // With it, the gaze: the next session gets its own camera and its own
  // intrinsics, and a stale half angle would narrow the map's naming against a
  // lens that is no longer the one in use.
  camHalfFovRad = 0;
  refSpaceKind = null;
  // All three belong to the session that ended and are meaningless without
  // it. Left standing they are stale handles that only look usable, and the
  // camera-image binding in particular is what a stray frame would read.
  binding = null;
  refSpace = null;
  viewerSpace = null;
  // The context goes with them: the next session builds its own.
  gl = null;
  // A session that ends while ARCore is lost used to leave this standing, and
  // the next session's first good pose then reported a loss measured across
  // the gap between the two sessions — however long the phone sat in a pocket.
  trackingLostSince = 0;
  lastLostPing = 0;
  // `fseq` counts within a session and the next one gets a new log, so the
  // counter and the announcement both belong to the session that ended. Left
  // standing, the next session's frames would be numbered from here and land
  // in a log named after a walk that is over.
  objSessionAnnounced = null;
  objSeqSession = null;
  objSeq = 0;
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
  // Back on the 2D page: the button and the status line are the surface
  // again, and the detector may have gone down during the session.
  updateStartBtn();
  scheduleIdleDetectRetry();
  endedAt = performance.now();
  reloadAfterSession();
}

// The page does not survive its own session, so it does not try to.
//
// This is a workaround for the UA and it is written down as one. Measured: after
// an immersive-AR session with a DOM overlay ends, the tab intermittently stops
// delivering pointer events to the page — permanently, while the page itself
// keeps running. A capture-phase listener on window reported every tap up to
// the one on the exit control and then nothing at all, with the document in a
// correct state throughout: no session, overlay hidden, the button enabled and
// hit-testable. Detaching and re-attaching the overlay root does not clear it,
// and nothing else a document can do reaches it. A second mode exists where the
// main thread stops outright.
//
// So every session gets a fresh document. That is the only lever left, and it
// is what was being done by hand anyway — the difference is that the page now
// does it at the moment the session ends, rather than after however long it
// takes to notice the tab is dead. It costs the detector's warm-up, which the
// button already gates on and says out loud.
//
// A page that never ran a session never reloads, so there is no loop.
const RELOAD_GRACE_MS = 500;
const RELOAD_DRAIN_MAX_MS = 4000;
let reloading = false;

function reloadAfterSession() {
  if (reloading) return;
  reloading = true;
  setStatus('session closed — reloading the page');
  const deadline = performance.now() + RELOAD_DRAIN_MAX_MS;
  // Not immediately: the recorder's last chunk arrives asynchronously after
  // `stop()`, the final client-state and any journalled overlay text are still
  // queued, and object frames may still be in the socket's buffer. Reloading
  // through that throws away the end of the walk. Bounded, because a socket
  // that is not draining is a socket that never will be, and this must never be
  // the reason the page stays where it is.
  const tick = () => {
    const queued = signaling.bufferedAmount + bulk.bufferedAmount + frames.bufferedAmount;
    if (queued > 0 && performance.now() < deadline) {
      setTimeout(tick, 100);
      return;
    }
    location.reload();
  };
  setTimeout(tick, RELOAD_GRACE_MS);
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
  // Counted only when a detection was actually dispatched. A frame that bailed
  // — no camera image yet, or no detector to send it to — used to be counted as
  // one anyway, which reads in the journal as a healthy 4/s taking 0 ms. The
  // one number that says whether this page is doing its job must not be able to
  // say yes while nothing is happening.
  detectAndReport(frame, view, pose, viewportOf(layer, view)).then((ran) => {
    if (ran) costMeter.bump('dets', performance.now() - now);
  }).finally(() => {
    busy = false;
  });
}

function onFrame(t, frame) {
  // The teardown can now free the context, so a callback already queued when it
  // ran would dereference both of these. A frame belonging to a session that is
  // over has nothing to draw and nothing to draw it with.
  if (!session || !gl) return;
  session.requestAnimationFrame(onFrame);
  lastXrFrameAt = performance.now();
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
  // Every frame, not on the chip's schedule: a leader line pointing at a chair
  // is only a claim about that chair while it is still pointing at it, and at
  // the chip's rate it would swing behind every turn of the head. The work is a
  // handful of vector multiplies and two SVG attribute writes per visible
  // object, against a list that is empty in most of the room.
  updateObjectList(view);

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
    + detectorLine()
    + shapeLine()
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
let detectSeq = 0;
let detectPending = null;
// Why the worker is not carrying detection, or null while it is. A string
// rather than a boolean because the four ways this fails are four different
// problems and the page used to report none of them: it fell back to detecting
// on its own thread, halved the frame rate, and said nothing. Measured over the
// walk corpus that is a session at 12 fps instead of 24 with the detection load
// identical — the missing main-thread time *is* the detector — and it lasted
// until the page was reloaded, because the old flag was one-way.
let detectWorkerWhy = null;
// Constructed is not ready. `new Worker` returns before its script has been
// fetched and long before opencv.js has been compiled inside it, and a worker
// in that state answers every frame by handing the buffer straight back. So
// everything that means "can this page detect" reads this, not the handle:
// the button, the overlay line, and the `det` the journal records.
let detectWorkerReady = false;
// Bounded, and re-armed at every session start. Every route below is a fetch
// over the LAN (the worker script, then ~10 MB of opencv.js) at the moment
// ARCore is spinning up and the radio has just woken, which is transient in
// exactly the way a permanent verdict is not.
const DETECT_WORKER_TRIES = 3;
const DETECT_WORKER_RETRY_MS = 5000;
// Long: this covers a ~10 MB fetch plus a wasm compile on a phone that is also
// starting ARCore. Short enough and a slow-but-fine start would be killed and
// retried, which is the same cost again.
const DETECT_WORKER_READY_MS = 20000;
let detectWorkerTries = 0;
let detectWorkerNextTry = 0;
let detectWorkerReadyTimer = 0;

function failDetectWorker(why) {
  clearTimeout(detectWorkerReadyTimer);
  detectWorkerReadyTimer = 0;
  detectWorker?.terminate();
  detectWorker = null;
  detectWorkerReady = false;
  detectWorkerWhy = why;
  detectWorkerNextTry = performance.now() + DETECT_WORKER_RETRY_MS;
  // Whoever is waiting on the frame in flight is released, or `busy` never
  // clears and detection stops for good — the exact failure this guards.
  const pending = detectPending;
  detectPending = null;
  pending?.done?.();
  updateStartBtn();
  scheduleIdleDetectRetry();
}

// Outside a session the attempt budget is not the point. It exists because a
// retry during a session competes with the render loop for the thread that is
// already in trouble; sitting on the 2D page there is nothing to compete with,
// and what failed was a fetch over the LAN — which comes back. So the page
// keeps trying, slowly, forever, and the button enables itself when it works.
// Without this the button gating above would be a dead end: `start()` is what
// re-arms the budget, and a disabled button cannot be pressed to re-arm it.
const DETECT_WORKER_IDLE_RETRY_MS = 10000;
let detectWorkerIdleTimer = 0;

function scheduleIdleDetectRetry() {
  if (detectWorkerIdleTimer || session || detectWorker) return;   // a warming worker is not a failed one
  detectWorkerIdleTimer = setTimeout(() => {
    detectWorkerIdleTimer = 0;
    if (session || detectWorker) return;
    detectWorkerTries = 0;
    detectWorkerNextTry = 0;
    // A construction that succeeds is not readiness: the script fetch and the
    // wasm compile are still ahead, and whichever way that lands comes back
    // through `ready` or `failDetectWorker`. Only an attempt that could not
    // even start one needs re-arming from here.
    if (!ensureDetectWorker()) scheduleIdleDetectRetry();
  }, DETECT_WORKER_IDLE_RETRY_MS);
}

// Retries this session are spent. There is deliberately no on-page fallback
// here, unlike /client: this page's main thread *is* the XR render loop, and
// running opencv on it costs half the frame rate for the whole session. The
// precedent is the browser without `requestFrame` — refuse, and say why, on
// the one surface this page has. Re-armed by the next `start()`, so exiting AR
// and going back in retries the worker rather than needing a reload.
function detectWorkerSpent() {
  return !detectWorkerReady && detectWorkerTries >= DETECT_WORKER_TRIES;
}

function ensureDetectWorker() {
  if (detectWorker) return detectWorker;
  if (detectWorkerTries >= DETECT_WORKER_TRIES) return null;
  // Spacing the attempts matters as much as bounding them: `ensureDetectWorker`
  // is on the per-detection path, so back-to-back retries would re-fetch and
  // re-compile opencv.js several times a second on the thread that is already
  // in trouble.
  const now = performance.now();
  if (now < detectWorkerNextTry) return null;
  detectWorkerTries++;
  detectWorkerNextTry = now + DETECT_WORKER_RETRY_MS;
  if (typeof Worker !== 'function') {
    detectWorkerTries = DETECT_WORKER_TRIES;
    detectWorkerWhy = 'no Worker in this browser';
    return null;
  }
  try {
    detectWorker = new Worker('/detect-worker.js');
  } catch (err) {
    detectWorkerWhy = `worker refused: ${err.message}`;
    return null;
  }
  // Fires when the worker's own script (or one of its importScripts) fails to
  // load — which is a LAN fetch, and `no-store` on this app's source means it
  // is a fresh one every session.
  detectWorker.onerror = () => failDetectWorker('worker script failed to load');
  detectWorker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'fatal') {
      failDetectWorker(msg.message ? `detector: ${msg.message}` : 'detector failed');
      return;
    }
    if (msg.type === 'ready') {
      // Constructing a Worker proves nothing: the script fetch and the wasm
      // compile are both still ahead of it. This is the first moment the worker
      // can actually detect, so it is the only honest place to say the page is
      // not carrying it.
      clearTimeout(detectWorkerReadyTimer);
      detectWorkerReadyTimer = 0;
      detectWorkerReady = true;
      detectWorkerWhy = null;
      detectWorkerTries = 0;
      updateStartBtn();
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
  // A fetch that hangs rather than erroring has no event, and the page would
  // sit forever holding a worker that will never answer — indistinguishable
  // from one that is merely slow to compile, which is why the wait is long.
  detectWorkerReadyTimer = setTimeout(
    () => failDetectWorker('detector did not come up'), DETECT_WORKER_READY_MS);
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
  if (!camera) return false;
  const tex = binding?.getCameraImage?.(camera);
  if (!tex) return false;
  // Asked for here rather than at the dispatch below, because with no detector
  // there may be nothing at all that wants these pixels — and reading them back
  // is six megabytes off the GPU. Everything downstream of the readback is for
  // the detector, the inset, the video out or the object frames; if none of
  // them is on, the cheapest correct thing is to not read the frame.
  ensureDetectWorker();
  const worker = detectWorkerReady ? detectWorker : null;
  const insetOn = camCanvas.classList.contains('on');
  const wantMedia = streamOn && !!session;
  if (!worker && !insetOn && !wantMedia && !objFramesOn) return false;
  // Before the first await: the XRFrame is only valid inside the frame
  // callback, and everything below this line may yield.
  const depthSnap = grabDepth(frame, view);
  if (!readCameraPixels(tex, camera.width, camera.height)) return false;

  const intr = intrinsicsFromProjection(
    view.projectionMatrix, camera.width, camera.height, viewport);
  // The camera image size is ARCore's choice, not this page's, so the roster
  // only learns it once a frame has actually arrived.
  const sizeChanged = !camInfo || camInfo.w !== camera.width || camInfo.h !== camera.height;
  camInfo = { w: camera.width, h: camera.height, fx: intr.fx };
  camHalfFovRad = Math.max(Math.atan2(camera.width / 2, intr.fx),
    Math.atan2(camera.height / 2, intr.fy));
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
  // once, for whichever of them is on, and not at all when neither is.
  const image = insetOn || wantMedia
    ? pixelsToCanvas(camera.width, camera.height) : null;
  if (insetOn) drawCamPreview(image);
  if (wantMedia) publishFrame(image, camera.width, camera.height);
  meta.fseq = maybeSendObjectFrame(
    image, camera.width, camera.height, meta.t, depthSnap);

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
      meta.done = () => resolve(true);
      detectPending = meta;
    });
  }
  // No worker, and no on-page detector to fall back to — see
  // detectWorkerSpent. The frame is dropped; `detectorLine` is what says so.
  return false;
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
    // How far out the clock sync could be, the same field and the same
    // expression `/client` sends (pose.js). It rides the pose message rather
    // than client-state for the same reason `cost` does — it describes *this*
    // report — and it is here because a claim was made that splitting the
    // frames onto a third socket protects pose latency, and without this field
    // on this page there was no way to measure it.
    unc: clockSync.synced ? Math.round(clockSync.uncertaintyMs * 10) / 10 : null,
    // The join key for the object frame taken from this same camera read, and
    // which reference space the session actually got. Both are additive and
    // nothing in the survey, the walls grid or the XR alignment reads either —
    // old journals replay bit-identically, which is the standing gate here.
    fseq: meta.fseq ?? null,
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
  // The pose this report will be solved from, kept for the room fix that comes
  // back against it. `xr` and not `xrNow`: the server's room pose describes the
  // instant the tags were seen, so pairing it with where the phone is *now*
  // would fold a third of a second of walking into the transform.
  pendingXr = meta.pose ? cvPose(meta.pose.transform) : null;
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
wireIconBtn(objBtn, () => setObjects(!objOn), () => `Objects ${onOff(objOn)}`);
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
setObjects(objOn);
setMapMode(mapMode);
probe();
// Built at load, not at the first `start()`. The worker's script and the ~10 MB
// of opencv.js behind it are LAN fetches followed by a wasm compile, and asking
// for all of that at the moment ARCore is spinning up is both the slowest
// moment to ask and the likeliest one to fail. Here the page is idle, the radio
// is settled, and by the time anyone taps start the detector is already up.
ensureDetectWorker();

// Coming back to a page Android froze. Everything time-based stopped while it
// was away: the sockets are very likely dead (common.js probes them on this
// same event) and the detector may have been torn down with nothing running to
// notice. What is left on screen is whatever was true minutes ago — and a stale
// "ready" on a page that is not ready is exactly what makes someone give up on
// the tab and open a fresh one, which then arrives at the server as a
// displacement with a dead page still holding the id.
//
// `pageshow` as well as `visibilitychange`: a bfcache restore brings the page
// back with all its state intact and none of its connections, and fires only
// the former.
function onResume() {
  if (document.visibilityState !== 'visible') return;
  // With no session the overlay must not be displayed. It is `position: fixed;
  // inset: 0` over the whole page, so if a session ever ends without its `end`
  // handler reaching the class — the page killed mid-session, a UA that drops
  // the event — what is left is a full-screen layer with nothing in it,
  // swallowing every tap on the page underneath. Cheap to assert, and the
  // symptom it prevents is indistinguishable from a frozen page.
  if (!session) overlay.classList.remove('on');
  // And the case the assertion above cannot reach: the page still holds a
  // session object. Locking the phone can end the session without the `end`
  // event ever arriving, and there is no property on XRSession that admits it —
  // so the test is behavioural. A live session delivers frames; one that is
  // gone delivers nothing. Checked after a delay rather than now, because at
  // this instant the UA has only just resumed the page and the frame loop is
  // entitled to a moment to catch up.
  // Re-armed rather than checked separately here: `startStallWatch` is the one
  // place that decides whether a held session is real, and a hidden page has
  // its timers throttled to something like a minute, so the interval needs
  // restarting at full rate rather than a second copy of its test.
  if (session) startStallWatch();
  updateStartBtn();
  if (detectWorker) return;
  // Not "wait out the retry interval": that wait was armed before the freeze,
  // and whatever is left of it was measured against a clock nobody was reading.
  clearTimeout(detectWorkerIdleTimer);
  detectWorkerIdleTimer = 0;
  detectWorkerTries = 0;
  detectWorkerNextTry = 0;
  if (!ensureDetectWorker()) scheduleIdleDetectRetry();
}
document.addEventListener('visibilitychange', onResume);
window.addEventListener('pageshow', onResume);
