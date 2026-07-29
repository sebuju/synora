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

const signaling = connectSignaling('client', {
  onOpen() {
    clockSync.start();
    signaling.send({ type: 'client-state', res: 'xr', mic: false, pose: true });
  },
  onMessage(msg) {
    if (clockSync.handle(msg)) return;
    if (msg.type === 'room-pose') roomPose = msg;
    else if (msg.type === 'pose-config') {
      // Remembered, not just forwarded. pose-config arrives on connect; the
      // detector does not exist until the user starts the XR session, so
      // `core?.` dropped the size on the floor and the detector kept its 0.15
      // default for the whole session. A 142 mm tag solved as 150 mm reports
      // every distance 5.6% long, and nothing anywhere says so — the room is
      // just uniformly too big.
      if (msg.markerSizeM > 0) markerSizeM = msg.markerSizeM;
      core?.setMarkerSize(markerSizeM);
    }
  },
});
const clockSync = createClockSync(signaling);

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
function intrinsicsFromProjection(proj, w, h) {
  return {
    fx: proj[0] * w / 2,
    fy: proj[5] * h / 2,
    cx: w * (1 - proj[8]) / 2,
    cy: h * (1 + proj[9]) / 2,
    dist: [0, 0, 0, 0, 0],   // ARCore hands back an undistorted image
  };
}

// The camera image arrives as a GL texture; ArUco needs pixels. Read it back
// and flip vertically on the way — GL reads bottom-up and every corner
// downstream is measured in top-down image coordinates.
function readCameraImage(tex, w, h) {
  if (!readCanvas) {
    readCanvas = document.createElement('canvas');
    readCtx = readCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (readCanvas.width !== w || readCanvas.height !== h) {
    readCanvas.width = w;
    readCanvas.height = h;
    pixels = new Uint8Array(w * h * 4);
  }
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  if (complete) gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  if (!complete) return null;

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

  core = createDetectCore();
  await core.ensureReady();
  core.setMarkerSize(markerSizeM);
  lumaSource = createCanvasLumaSource(core.cv);

  overlay.classList.add('on');
  session.addEventListener('end', () => {
    overlay.classList.remove('on');
    setStatus('session ended');
    session = null;
    sessionId = null;
    camInfo = null;
  });
  session.requestAnimationFrame(onFrame);
  setStatus('session running');
}

function onFrame(t, frame) {
  session.requestAnimationFrame(onFrame);
  frames++;
  const layer = session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const pose = frame.getViewerPose(refSpace);
  if (!pose) {
    overlayText.textContent = 'tracking lost';
    return;
  }
  const view = pose.views[0];
  const now = performance.now();
  // Detection is far too expensive for every frame, and is a re-entrant
  // hazard — one at a time, on its own schedule.
  if (!busy && now - lastPose >= POSE_INTERVAL_MS) {
    lastPose = now;
    busy = true;
    detectAndReport(view, pose).finally(() => { busy = false; });
  }

  const p = pose.transform.position;
  overlayText.textContent =
    `xr ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}\n` +
    (camInfo ? `cam ${camInfo.w}x${camInfo.h} fx ${camInfo.fx.toFixed(0)}\n` : 'cam: no image yet\n') +
    // The size the detector is actually solving with, not the one the server
    // meant to send — the gap between those two is silent everywhere else.
    `tag ${(markerSizeM * 1000).toFixed(0)} mm\n` +
    // Reprojection error and distance per tag: the server's gates are in
    // pixels and this camera is ~640x480, so a fix the 4K client would have
    // accepted can be discarded here — which looks like the tag not existing.
    `tags ${lastTags.length
      ? lastTags.map((x) => `${x.id}@${x.err.toFixed(1)}px/`
        + `${Math.hypot(x.tvec[0], x.tvec[1], x.tvec[2]).toFixed(1)}m`).join(' ')
      : 'none'}\n` +
    (roomPose?.pose
      ? `room ${roomPose.pose.p.map((v) => v.toFixed(2)).join(' ')} · ${roomPose.quality}`
      : 'room: not aligned yet — show it a known tag') +
    // Steadiness, both halves side by side. "phone" is ARCore's own movement
    // over the window, "pose" is how far the reported room pose wandered over
    // the same one. Bolt the phone down and phone should read ~0; whatever
    // pose reads then is the fix's own noise, and the number any uncertainty
    // circle in the viewer should be sized from.
    (roomPose?.jitter
      ? `\nsteady: phone ${roomPose.jitter.movedMm} mm · pose ${roomPose.jitter.jitterMm} mm`
      : '\nsteady: measuring…') +
    `\n${frames} frames`;
}

async function detectAndReport(view, pose) {
  const camera = view.camera;
  if (!camera) return;
  const tex = binding.getCameraImage?.(camera);
  if (!tex) return;
  const image = readCameraImage(tex, camera.width, camera.height);
  if (!image) return;

  const intr = intrinsicsFromProjection(view.projectionMatrix, camera.width, camera.height);
  camInfo = { w: camera.width, h: camera.height, fx: intr.fx };
  if (!core.hasIntrinsics(camera.width, camera.height)) {
    core.setIntrinsics(camera.width, camera.height, intr);
  }
  const res = await core.detect(lumaSource, image, camera.width, camera.height, performance.now());
  lastTags = res.tags;
  signaling.send({
    type: 'xr-pose',
    t: clockSync.synced ? clockSync.at(performance.now()) : null,
    sid: sessionId,
    xr: cvPose(pose.transform),
    w: camera.width,
    h: camera.height,
    intrinsics: intr,
    tags: res.tags,
  });
}

startBtn.onclick = start;
probe();
