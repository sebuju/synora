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
const mapBtn = document.getElementById('mapBtn');
const minimalBtn = document.getElementById('minimalBtn');
const headingBtn = document.getElementById('headingBtn');

// There are no devtools on a phone, and a script that throws while wiring
// itself up leaves a page that looks completely normal and does nothing — the
// buttons after the throw simply never get their handlers. Put where the probe
// result goes, so it is on screen the moment the session is left.
window.addEventListener('error', (ev) => {
  report.textContent =
    `error: ${ev.message} (${(ev.filename || '').split('/').pop()}:${ev.lineno})`;
});

const POSE_INTERVAL_MS = 100;      // tag detection + pose report

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
let readCanvas = null;
let readCtx = null;
let pixels = null;
let lastPose = 0;
let frames = 0;
let lastTags = [];
let roomPose = null;
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

function chipDue(now) {
  if (now - chipAt < CHIP_INTERVAL_MS) return false;
  chipAt = now;
  return true;
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
// Full by default, and with `minimal` below that is the whole screen showing
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
// minimal. In split mode the real thing is on screen above the map, and with
// the backdrop off the map is transparent and the passthrough is already the
// background — a small copy of it in the corner is then just clutter over
// itself. Both toggles feed this, so neither can decide it alone.
function updateCamInset() {
  camCanvas.classList.toggle('on', mapMode === 'full' && !minimal);
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

// The one setter. The button and the dashboard's `control` both land here, so
// the two cannot mean different things, and it is also what subscribes: the
// server sends the room only to a client that reports it is drawing one.
function setMapMode(mode) {
  mapMode = MAP_MODES.includes(mode) ? mode : 'off';
  mapCanvas.classList.toggle('split', mapMode === 'split');
  mapCanvas.classList.toggle('full', mapMode === 'full');
  updateCamInset();
  mapBtn.classList.toggle('active', mapMode !== 'off');
  minimalBtn.classList.toggle('on', mapMode !== 'off');
  headingBtn.classList.toggle('on', mapMode !== 'off');
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
let minimal = true;

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
}

// Heading up: the map turns and the client marker holds still, rather than the
// marker turning on a map that never moves. The direction is the camera's own
// forward in the room frame — the same +z convention every camera pose in this
// project uses — and the renderer works out which way that has to be turned for
// this projection. Off, the map keeps the room's own orientation, which is the
// one that matches a floor plan on a wall.
let headingUp = false;

function applyHeading() {
  mapView.setHeadingUp(headingUp && roomPose?.pose
    ? quatRotate(roomPose.pose.q, [0, 0, 1])
    : null);
}

function setHeading(on) {
  headingUp = on;
  headingBtn.classList.toggle('active', headingUp);
  applyHeading();
}

function setMinimal(on) {
  minimal = on;
  minimalBtn.classList.toggle('active', minimal);
  mapView.setLayer('backdrop', !minimal);
  mapView.setLayer('pairs', !minimal);
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
      overlayText.textContent =
        `LOST ${(lostMs / 1000).toFixed(1)}s${blindView ? '' : ' · no cam'}\n`
        + `tags ${lastTags.length ? lastTags.map((x) => x.id).join(' ') : 'none'}`;
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

  // Five short lines, in the order they are read while walking a room: where,
  // what the camera is, what it sees, where that puts you, how steady it is.
  // Every field here is one that cannot be read anywhere else on the phone —
  // the explanations that used to sit beside them are in this file's comments,
  // which is where a sentence belongs.
  if (!chipDue(now)) return;
  const p = pose.transform.position;
  overlayText.textContent =
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
    // from. Frame count rides along as the proof the loop is still running.
    + (roomPose?.jitter
      ? `\nsteady ${roomPose.jitter.movedMm}/${roomPose.jitter.jitterMm} mm`
      : '\nsteady —')
    + ` · ${frames}f`;
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
      w: meta.w, h: meta.h, flipY: true, intr,
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
  const image = pixelsToCanvas(meta.w, meta.h);
  const res = await core.detect(lumaSource, image, meta.w, meta.h, performance.now());
  reportDetection(meta, res);
}

// Both paths end here: the detector's result plus what the page knew when the
// frame was taken. One report, one place, whichever thread did the work.
function reportDetection(meta, res) {
  if (!res) return;
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
  };
  // With a world pose the server can tie ARCore's frame to the room and carry
  // the position between sightings; without one it gets the observations on
  // their own and solves them like any other client. The two message types are
  // separate server state, so flipping between them mid-session costs nothing —
  // the XR alignment is keyed by session id and picks up where it left off.
  signaling.send(meta.pose
    ? {
      type: 'xr-pose', sid: sessionId, xr: cvPose(meta.pose.transform),
      source: 'xr', ...common,
    }
    : { type: 'pose', calibrated: true, source: 'xr', ...common });
}

startBtn.onclick = start;
blankBtn.onclick = () => blank.toggle();
mapBtn.onclick = () =>
  setMapMode(MAP_MODES[(MAP_MODES.indexOf(mapMode) + 1) % MAP_MODES.length]);
minimalBtn.onclick = () => setMinimal(!minimal);
headingBtn.onclick = () => setHeading(!headingUp);
setHeading(headingUp);
// Both defaults applied once at load, so the buttons and the renderer start out
// agreeing with the variables above.
setMinimal(minimal);
setMapMode(mapMode);
probe();
