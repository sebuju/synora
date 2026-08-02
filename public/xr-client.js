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
const blankBtn = document.getElementById('blankBtn');
const mapCanvas = document.getElementById('mapCanvas');
const camCanvas = document.getElementById('camCanvas');
const overlayRot = document.getElementById('overlayRot');
const overlayBtns = document.getElementById('overlayBtns');
const exitBtn = document.getElementById('exitBtn');
const mapBtn = document.getElementById('mapBtn');
const transparentBtn = document.getElementById('transparentBtn');
const headingBtn = document.getElementById('headingBtn');

// There are no devtools on a phone, and a script that throws while wiring
// itself up leaves a page that looks completely normal and does nothing — the
// buttons after the throw simply never get their handlers. Put where the probe
// result goes, so it is on screen the moment the session is left.
window.addEventListener('error', (ev) => {
  report.textContent =
    `error: ${ev.message} (${(ev.filename || '').split('/').pop()}:${ev.lineno})`;
});

const POSE_INTERVAL_MS = 100;      // how often detection is *attempted*
// How often this client reports where it is, which is no longer the same thing.
//
// Detection costs 300 ms a frame on this phone (tag scan plus feature tracking),
// so tying the report to it dropped the report rate to 3/s — measured, against
// 6.4/s before feature tracking existed. Two things broke that nobody connected
// to it at the time:
//
//   - The room views ease toward the last reported pose, so at 3/s the client's
//     dot moves in visible steps. The animation was never the problem; its input
//     was.
//   - `trackJitter` needs 8 samples inside a 1500 ms window — 5.3/s — so the
//     steadiness measurement simply stopped existing (93% of good frames carried
//     one at 6.4/s, 5% at 3/s). That is what shut the landmark gate for three
//     whole sessions (see the note on landmarkGate).
//
// ARCore has a pose every single frame, and the *carry* report costs nothing to
// produce: no camera read, no scan, no tracking. So the report runs on its own
// clock and detection results ride on whichever report they are ready for.
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
let viewerSpace = null;
let gl = null;
let binding = null;
let core = null;
// The server's declared printed marker size, held until the detector exists.
let markerSizeM = 0.15;
let lumaSource = null;
// Landmark feature tracking on the on-page fallback only; on the worker path
// the tracker lives over there with the detector.
let pageTracker = null;
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
let frames = 0;
let lastTags = [];
let lastTrack = null;
// Set when the worker reports the tracker shut itself off. Sticky for the
// session: it does not get a second chance, so neither should the message.
let trackFailed = null;
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
device.then((d) => {
  const label = document.getElementById('clientLabel');
  label.textContent = d.name || 'unnamed device';
  wireDeviceChip(label, 'client');
});

const signaling = connectSignaling('client', {
  onOpen() {
    clockSync.start();
    sendClientState();
  },
  onMessage(msg) {
    if (clockSync.handle(msg)) return;
    // The room as the server has it — survey, carved floor, walls — for the map
    // below. Only sent while this client says it is drawing one.
    if (roomFeed.handle(msg)) return;
    if (msg.type === 'room-pose') {
      roomPose = msg;
      if (msg.pose) lastFix = msg.pose;
      // Where to walk next, drawn on the map this page is already carrying
      // around the room. Null clears it — "nothing worth saying" is the common
      // answer and must not leave the last instruction standing.
      mapView.setGuide(msg.guide || null);
      // The map's rotation comes from the same fix the overlay reports, so the
      // two can never disagree about which way this phone is pointing.
      applyHeading();
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
    } else if (msg.type === 'pose-config') {
      // Remembered, not just forwarded. pose-config arrives on connect; the
      // detector does not exist until the user starts the XR session, so
      // `core?.` dropped the size on the floor and the detector kept its 0.15
      // default for the whole session. A 142 mm tag solved as 150 mm reports
      // every distance 5.6% long, and nothing anywhere says so — the room is
      // just uniformly too big.
      if (msg.markerSizeM > 0) markerSizeM = msg.markerSizeM;
      core?.setMarkerSize(markerSizeM);
      detectWorker?.postMessage({ type: 'config', markerSizeM });
    }
  },
}, device.then((d) => d.id));
const clockSync = createClockSync(signaling);

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

// `track N pts` is this phone's own tracker; `anchors`/`arc` are the server's
// map, which arrives on room-pose. Either half can be missing — the tracker
// before the first frame, the server state before the first report — and the
// line says only what it actually knows.
function landmarkLine() {
  // Both of these used to be an empty string, which is the one thing this line
  // must never be: a tracker that shut itself off and a tracker that was never
  // asked to run look identical when the answer is silence.
  if (trackFailed) return `landmarks OFF — ${trackFailed}\n`;
  if (!lastTrack && !roomPose?.landmarks) return 'landmarks — no tracker output yet\n';
  const lm = roomPose?.landmarks;
  // Two lines, because this is a phone: what the tracker is doing, then what
  // survived and what the room has made of it.
  const c = lastTrack?.churn;
  const first = [];
  if (lastTrack) first.push(`track ${lastTrack.n}pts ${Math.round(lastTrack.ms)}ms`);
  // Churn, when there is any: how many of the previous set survived this frame
  // and how far they moved. A track has to live a second or two to be worth
  // anything, and when it does not, this is the only thing on the phone that
  // says so.
  // `pred` beside `moved` is how the rotation seed is read: the two tracking
  // close together says the flow was started next to the answer, a large `moved`
  // against a near-zero `pred` says the camera orientation is not reaching the
  // tracker at all — which is silent otherwise, since an unseeded flow is not an
  // error, only a worse one.
  if (c?.in) {
    first.push(`kept ${c.kept}/${c.in} · moved ${c.moved}px`
      + (c.pred == null ? '' : `/pred ${c.pred}`));
  }

  const second = [];
  // Which stage is killing them — the flow giving up, points leaving frame, or
  // the round-trip check. They call for opposite fixes, so the split matters
  // more than the total.
  if (c?.in) second.push(`drop lk${c.status} edge${c.edge} fb${c.fb}`);
  if (lm) {
    second.push(`${lm.anchors} anchor${lm.anchors === 1 ? '' : 's'}`);
    // Against the threshold while it matters, on its own once it does not: a
    // target already met is not information.
    second.push(lm.anchors ? `arc ${lm.arc}°` : `arc ${lm.arc}/${ROOM_LANDMARK_ARC_DEG}°`);
  }
  return [first.join(' · '), second.join(' · '), guideLine()]
    .filter(Boolean).join('\n') + '\n';
}

// The instruction, in words, beside the same instruction drawn on the map. Both
// because they answer different questions: the map says *where*, the line says
// *what* and how far off it is — and the map is off in `off` mode, where this
// line is the only thing left.
//
// Written as something to do, not as a state to interpret. "22/60°" is a
// readout; "walk around it" is an instruction, and this page is read by someone
// walking a room, usually at arm's length and moving.
function guideLine() {
  const g = roomPose?.guide;
  if (!g) return '';
  const what = `${g.n} corner${g.n === 1 ? '' : 's'} at ${g.dist} m`;
  if (g.mode === 'closer') return `→ get closer: ${what}`;
  if (g.mode === 'arc') return `→ walk around it: ${what}, ${g.need}° more`;
  return `→ keep it in view: ${what}, ${g.span}° seen`;
}

function chipDue(now) {
  if (now - chipAt < CHIP_INTERVAL_MS) return false;
  chipAt = now;
  return true;
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
  overlayText.textContent = text;
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
// On here where the dashboard has it off by default. This is the page being
// carried around the room, and the candidates are the only thing that says
// *where* to orbit next — on the dashboard they are a diagnostic, here they are
// the instruction. No button: the phone's overlay is already at its limit, and
// there is nothing to decide.
mapView.setLayer('candidates', true);

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
  transparentBtn.classList.toggle('on', mapMode !== 'off');
  headingBtn.classList.toggle('on', mapMode !== 'off');
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
  // Distance from the quarter turn currently in force, wrapped to ±180.
  const off = Math.abs(((deg - screenRotDeg + 540) % 360) - 180);
  if (off < ROT_FLIP_DEG) return;
  const snapped = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
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
// floor plan on a wall.
let headingUp = false;

function applyHeading() {
  // Null is off, and only off: the hold through a dropout is `lastFix`, kept
  // here where "the last fix I had" is already known.
  mapView.setHeadingUp(
    headingUp && lastFix ? quatRotate(lastFix.q, [0, 0, 1]) : null,
    headingUp && lastFix ? lastFix.p : null);
}

function setHeading(on) {
  headingUp = on;
  headingBtn.classList.toggle('active', headingUp);
  applyHeading();
}

function setTransparent(on) {
  transparent = on;
  transparentBtn.classList.toggle('active', transparent);
  mapView.setLayer('backdrop', !transparent);
  mapView.setLayer('pairs', !transparent);
  updateCamInset();
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

function setStatus(text) {
  document.getElementById('status').textContent = text;
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
  return readCanvas;
}

async function start() {
  const canvas = document.createElement('canvas');
  gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true });
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: ['camera-access', 'anchors', 'dom-overlay', 'hit-test'],
      domOverlay: { root: overlay },
    });
  } catch (err) {
    report.textContent = `session refused: ${err.message}`;
    return;
  }
  sessionId = crypto.randomUUID();
  trackReset = true;
  await gl.makeXRCompatible();
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  binding = new XRWebGLBinding(session, gl);
  refSpace = await session.requestReferenceSpace('local-floor')
    .catch(() => session.requestReferenceSpace('local'));
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

function onFrame(t, frame) {
  session.requestAnimationFrame(onFrame);
  frames++;
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
    if (blindView && !busy && now - lastPose >= POSE_INTERVAL_MS) {
      lastPose = now;
      busy = true;
      // No second argument: no world pose exists, and that is what switches the
      // report to the tag-only message.
      detectAndReport(blindView, null, viewportOf(layer, blindView))
        .finally(() => { busy = false; });
    }
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
  // hazard — one at a time, on its own schedule.
  if (!busy && now - lastPose >= POSE_INTERVAL_MS) {
    lastPose = now;
    busy = true;
    // The viewport is the display the projection matrix was built for; it only
    // matters as the thing the camera image's aspect gets compared against.
    detectAndReport(view, pose, viewportOf(layer, view)).finally(() => { busy = false; });
  }
  // Between detections: where ARCore says the camera is, and nothing else.
  sendCarry(pose, now);

  // Five short lines, in the order they are read while walking a room: where,
  // what the camera is, what it sees, where that puts you, how steady it is.
  // Plus landmarks, which is the one line that is a *task* rather than a
  // readout — see landmarkLine.
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
    // Landmarks, both halves on one line: what this phone is tracking right now
    // (its own cost, which nothing else can see) and what the server has made of
    // it (the map, which this phone cannot see).
    //
    // The arc is the number worth walking to. Anchors qualify on how wide a
    // viewing arc a feature has been seen through, which is the one thing the
    // person holding the phone controls — so it is shown against the threshold
    // it has to beat, and it is the difference between knowing to orbit a spot
    // and concluding the feature is broken.
    + landmarkLine()
    + (roomPose?.pose
      ? `room ${roomPose.pose.p.map((v) => v.toFixed(2)).join(' ')} · ${roomPose.quality}`
      : 'room —')
    // Steadiness, both halves side by side. The first is ARCore's own movement
    // over the window; the second is how far the tag fix wandered underneath
    // it, with that movement divided out, so the two are independent — walking
    // moves the first and should leave the second alone. The second is the
    // fix's own noise and the number the viewer's uncertainty circle is sized
    // from. Frame count rides along as the proof the loop is still running.
    + (roomPose?.jitter
      ? `\nsteady ${roomPose.jitter.movedMm}/${roomPose.jitter.jitterMm} mm`
      : '\nsteady —')
    + ` · ${frames}f`);
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
// Set when a session starts, cleared on the frame that carries it to the
// worker: a new session is a new picture, and the tracker's ids have to stop
// meaning what they meant in the last one.
let trackReset = false;

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
    // The tracker's own source, at its own width — see createFeatureTracker for
    // why it cannot share the detector's. Built here so the fallback collects
    // what the worker path collects; a landmark map that depended on which
    // thread happened to be detecting would be untraceable.
    pageTracker = createFeatureTracker(core.cv,
      createCanvasLumaSource(core.cv, { maxWidth: TRACK_WIDTH }));
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
    if (msg.type === 'track-failed') {
      // Landmarks are gone for this session; detection is not, so the worker
      // stays exactly where it is. Recorded rather than only announced: the
      // status line is behind the immersive session, so the one place this can
      // actually be read is the overlay — and a tracker that shuts itself off
      // used to show up as a line quietly missing, which is indistinguishable
      // from a line that was never enabled.
      trackFailed = msg.message || 'tracker error';
      setStatus(`feature tracking failed; landmarks off (${trackFailed})`);
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
    poseRateMs: POSE_INTERVAL_MS,
  });
  return detectWorker;
}

// `pose` is the camera's pose in the XR session frame, or null when ARCore has
// no world track. Null is not an error: it selects the tag-only report, the
// same message /client sends, which the server localizes from the marker map
// with no XR frame involved.
async function detectAndReport(view, pose, viewport) {
  const camera = view.camera;
  if (!camera) return;
  const tex = binding.getCameraImage?.(camera);
  if (!tex) return;
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
    pose, intr, w: camera.width, h: camera.height,
    t: clockSync.synced ? clockSync.at(performance.now()) : null,
  };
  // The camera's orientation this frame, for the feature tracker's flow seed.
  // Session-frame and CV-axis, which is the frame the intrinsics describe; only
  // the rotation *between* two frames is used, so the frame it is expressed in
  // cancels as long as it is the same one both times. Null when ARCore has no
  // world track — then there is nothing to predict from and the tracker starts
  // each point from where it was.
  const camView = pose ? { q: cvPose(pose.transform).q } : null;
  // The inset is the only reason the page ever looks at these pixels again, and
  // it costs a full-frame flip and raster, so it is done only when it is on.
  if (camCanvas.classList.contains('on')) {
    drawCamPreview(pixelsToCanvas(camera.width, camera.height));
  }

  const worker = ensureDetectWorker();
  if (worker) {
    // Transferred, not copied: six megabytes a frame is the whole reason this
    // moved off the page. The buffer comes back with the result — see below.
    const buf = pixels.buffer;
    pixels = null;
    meta.seq = ++detectSeq;
    worker.postMessage({
      type: 'xr-frame', seq: meta.seq, buf,
      w: meta.w, h: meta.h, flipY: true, intr, view: camView, reset: trackReset,
    }, [buf]);
    trackReset = false;
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
  const image = pixelsToCanvas(meta.w, meta.h);
  const res = await core.detect(lumaSource, image, meta.w, meta.h, performance.now());
  if (!res) return;
  if (pageTracker) {
    if (trackReset) {
      pageTracker.reset();
      trackReset = false;
    }
    try {
      const tracked = await pageTracker.track(image, res.boxes,
        camView ? { q: camView.q, K: intr } : null);
      res.points = tracked?.points.map((p) => ({
        id: p.id,
        u: Math.round(p.u * 100) / 100,
        v: Math.round(p.v * 100) / 100,
      }));
      res.gen = tracked?.gen;
      res.trackMs = tracked?.ms;
    } catch {
      // Landmarks are gone; tags are not.
      pageTracker.dispose();
      pageTracker = null;
      setStatus('feature tracking failed; landmarks off');
    }
  }
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
// treats a tag-less `xr-pose` as ARCore carrying the fix (`quality: 'tracked'`),
// and `maintainLandmarks` returns immediately on a report with no points.
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
  // A detection report covers this tick, so no carry follows it — the two
  // together are what make the rate steady rather than lumpy.
  lastReport = performance.now();
  lastIntr = meta.intr;
  lastTags = res.tags || [];
  lastTrack = res.points
    ? { n: res.points.length, ms: res.trackMs ?? 0, churn: res.churn ?? null }
    : null;
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
    // Tracked features, when landmark collection is on. `intrinsics` above is
    // already the camera model the server needs to turn one into a bearing, so
    // unlike /client this path has nothing extra to send for it.
    points: res.points,
    gen: res.gen,
    // Journalled with the report, so churn is measurable after the fact rather
    // than only while someone is watching the phone.
    churn: res.churn,
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
blankBtn.onclick = () => blank.toggle();
mapBtn.onclick = () =>
  setMapMode(MAP_MODES[(MAP_MODES.indexOf(mapMode) + 1) % MAP_MODES.length]);
transparentBtn.onclick = () => setTransparent(!transparent);
// Tap the chip to fold it to one line, tap again for the rest. `pointerdown`
// rather than `click`: it is the one event a finger, a mouse and a stylus all
// raise exactly once, where touchstart plus the synthesized click that follows
// it would toggle twice per tap. preventDefault stops that synthesized click
// and the text selection a press-and-hold would otherwise start. The state is
// the class on the element — nothing else on the page reads it.
overlayText.addEventListener(
  window.PointerEvent ? 'pointerdown' : 'touchstart',
  (ev) => {
    ev.preventDefault();
    overlayText.classList.toggle('collapsed');
  });
// The Android navigation bar comes and goes under the session; the overlay is
// sized in dvh and its safe-area inset follows, so the strip the buttons cover
// is not the same one it was.
window.addEventListener('resize', updateMapInset);
headingBtn.onclick = () => setHeading(!headingUp);
setHeading(headingUp);
// Both defaults applied once at load, so the buttons and the renderer start out
// agreeing with the variables above.
setTransparent(transparent);
setMapMode(mapMode);
probe();
