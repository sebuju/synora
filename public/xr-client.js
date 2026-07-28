'use strict';

// XR client: pose and depth from ARCore instead of from a depth model.
//
// The trade against /client, in one line: ARCore measures what the depth model
// was guessing, and tracks the camera between tag sightings, so tags become an
// anchor rather than a continuous requirement — at the cost of a ~640x480
// camera image instead of 4K, because `camera-access` hands over a GPU texture
// at ARCore's own resolution. This page does not stream video at all; it is a
// positioning and mapping client.
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
const DEPTH_INTERVAL_MS = 1000;    // depth frame to the server
// The ARCore grid is 160x90 — small enough to use whole. Subsampling it also
// widened the angular gap between neighbours, which is what the normal and
// edge tests measure across, so it was making every surface look rougher than
// it is.
const DEPTH_STRIDE = 1;
// Motion stereo degrades sharply with range: the baseline a walking phone
// gives is centimetres, so a point at 8 m is barely constrained. Far junk is
// most of the noise in the map and none of the information.
const MAX_DEPTH_M = 4;

let session = null;
let refSpace = null;
let gl = null;
let binding = null;
let core = null;
let lumaSource = null;
let readCanvas = null;
let readCtx = null;
let pixels = null;
let lastPose = 0;
let lastDepth = 0;
let frames = 0;
let lastTags = [];
let roomPose = null;
let sentDepth = 0;
let busy = false;

const signaling = connectSignaling('client', {
  onOpen() {
    clockSync.start();
    signaling.send({ type: 'client-state', res: 'xr', mic: false, pose: true });
  },
  onMessage(msg) {
    if (clockSync.handle(msg)) return;
    if (msg.type === 'room-pose') roomPose = msg;
    else if (msg.type === 'pose-config') core?.setMarkerSize(msg.markerSizeM);
  },
});
const clockSync = createClockSync(signaling);
const bulk = connectSignaling('client-bulk', {}, loadDeviceId('client'));

// WebXR view space is +x right, +y UP, -z forward. Every other camera pose in
// this project is OpenCV — +x right, +y down, +z forward — including the tag
// poses PnP produces from this very camera image. The two differ by a half
// turn about x, and converting here means exactly one convention ever leaves
// this file: leaving it to the server would have the alignment silently absorb
// the flip and look correct only at the instant a tag is seen.
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
      optionalFeatures: ['camera-access', 'depth-sensing', 'anchors', 'dom-overlay', 'hit-test'],
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
  await gl.makeXRCompatible();
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  binding = new XRWebGLBinding(session, gl);
  refSpace = await session.requestReferenceSpace('local-floor')
    .catch(() => session.requestReferenceSpace('local'));

  core = createDetectCore();
  await core.ensureReady();
  lumaSource = createCanvasLumaSource(core.cv);

  overlay.classList.add('on');
  session.addEventListener('end', () => {
    overlay.classList.remove('on');
    setStatus('session ended');
    session = null;
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
  // Detection and depth are both far too expensive for every frame, and both
  // are re-entrant hazards — one at a time, on their own schedules.
  if (!busy && now - lastPose >= POSE_INTERVAL_MS) {
    lastPose = now;
    busy = true;
    detectAndReport(view, pose).finally(() => { busy = false; });
  }
  if (now - lastDepth >= DEPTH_INTERVAL_MS) {
    lastDepth = now;
    sendDepth(frame, view, pose);
  }

  const p = pose.transform.position;
  overlayText.textContent =
    `xr ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}\n` +
    // Reprojection error and distance per tag: the server's gates are in
    // pixels and this camera is ~640x480, so a fix the 4K client would have
    // accepted can be discarded here — which looks like the tag not existing.
    `tags ${lastTags.length
      ? lastTags.map((x) => `${x.id}@${x.err.toFixed(1)}px/`
        + `${Math.hypot(x.tvec[0], x.tvec[1], x.tvec[2]).toFixed(1)}m`).join(' ')
      : 'none'}\n` +
    (roomPose?.pose
      ? `room ${roomPose.pose.p.map((v) => v.toFixed(2)).join(' ')} · ${roomPose.quality}`
      : 'room: not aligned yet — show it a tag') +
    `\ndepth frames sent ${sentDepth} · ${frames} frames`;
}

async function detectAndReport(view, pose) {
  const camera = view.camera;
  if (!camera) return;
  const tex = binding.getCameraImage?.(camera);
  if (!tex) return;
  const image = readCameraImage(tex, camera.width, camera.height);
  if (!image) return;

  const intr = intrinsicsFromProjection(view.projectionMatrix, camera.width, camera.height);
  if (!core.hasIntrinsics(camera.width, camera.height)) {
    core.setIntrinsics(camera.width, camera.height, intr);
  }
  const res = await core.detect(lumaSource, image, camera.width, camera.height, performance.now());
  lastTags = res.tags;
  signaling.send({
    type: 'xr-pose',
    t: clockSync.synced ? clockSync.at(performance.now()) : null,
    xr: cvPose(pose.transform),
    w: camera.width,
    h: camera.height,
    intrinsics: intr,
    tags: res.tags,
  });
}

// Depth arrives as a small grid (160x90 on a OnePlus 9). Unprojecting here
// rather than shipping the raw buffer keeps the server out of WebXR's depth
// coordinate conventions, which are easy to get subtly wrong and produce a
// map that looks plausible and is wrong.
function sendDepth(frame, view, pose) {
  const d = frame.getDepthInformation?.(view);
  if (!d || bulk.bufferedAmount > 512 * 1024) return;
  const gw = Math.floor(d.width / DEPTH_STRIDE);
  const gh = Math.floor(d.height / DEPTH_STRIDE);
  const intr = intrinsicsFromProjection(view.projectionMatrix, d.width, d.height);
  const pts = new Float32Array(gw * gh * 3);
  let valid = 0;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const px = i * DEPTH_STRIDE;
      const py = j * DEPTH_STRIDE;
      let z = 0;
      try {
        z = d.getDepthInMeters((px + 0.5) / d.width, (py + 0.5) / d.height);
      } catch {
        z = 0;
      }
      const o = (j * gw + i) * 3;
      if (!(z > 0.1 && z < MAX_DEPTH_M)) {
        pts[o] = NaN;
        continue;
      }
      // Camera frame, OpenCV convention (x right, y down, z forward) — the
      // same one every tag pose and the server's backprojection already use.
      pts[o] = ((px + 0.5 - intr.cx) / intr.fx) * z;
      pts[o + 1] = ((py + 0.5 - intr.cy) / intr.fy) * z;
      pts[o + 2] = z;
      valid++;
    }
  }
  if (!valid) return;

  const header = new TextEncoder().encode(JSON.stringify({
    t: clockSync.synced ? clockSync.at(performance.now()) : null,
    gw,
    gh,
    xr: cvPose(pose.transform),
    tags: lastTags,
  }));
  const head = new Uint8Array(8);
  head[0] = 0x58; head[1] = 0x52; head[2] = 0x44; head[3] = 0x31;   // XRD1
  new DataView(head.buffer).setUint32(4, header.length, true);
  bulk.sendBinary(new Blob([head, header, pts.buffer]));
  sentDepth++;
}

startBtn.onclick = start;
probe();
