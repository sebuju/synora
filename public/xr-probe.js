'use strict';

// WebXR probe: asks this device what it will actually grant, then measures the
// only thing that matters for using it as a pose source — how far its tracking
// drifts when you walk a loop and come back.
//
// It answers a question no spec sheet does. ARCore's depth is computed from
// motion stereo on the ordinary camera, so it does not need a depth sensor,
// and world tracking needs even less; whether a given phone grants
// camera-access alongside it is a per-device, per-Chrome-version fact. This
// page reports what was granted rather than what should be.
//
// Two things an AR session needs that are easy to miss, and both look like the
// same symptom (a black screen that does nothing):
// - A WebGL base layer. The compositor draws the camera passthrough *behind*
//   the session's layer; with no layer there is nothing to composite into and
//   the frame loop runs against a session that never presents.
// - A way to interact that does not assume dom-overlay was granted. It is
//   optional, and when it is refused the page's DOM is not shown over the
//   session at all, so any button on it is unreachable. Screen taps arrive as
//   `select` events regardless, so those drive the measurement and the full
//   report is printed to the page after the session exits.
//
// Nothing here touches the rest of Synora. It is a measurement, not a feature.

const report = document.getElementById('report');
const live = document.getElementById('live');
const startBtn = document.getElementById('startBtn');
const overlay = document.getElementById('overlay');
const overlayText = document.getElementById('overlayText');
const markBtn = document.getElementById('markBtn');
const endBtn = document.getElementById('endBtn');

// Everything worth having, all optional: a device that refuses one should
// still start a session so the rest can be measured.
const OPTIONAL = ['camera-access', 'depth-sensing', 'anchors', 'hit-test', 'dom-overlay', 'light-estimation'];

let session = null;
let refSpace = null;
let gl = null;
let origin = null;         // marked pose, for the loop-closure measurement
let maxDist = 0;
let lastDist = 0;
let depthNote = 'not granted';
let frames = 0;
let lost = 0;
let granted = [];
let refused = [];
let spaceKind = '';

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

function esc(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

async function probe() {
  if (!navigator.xr) {
    report.innerHTML = '<span class="no">navigator.xr missing.</span>\n' +
      'This browser has no WebXR at all. On Android that means Chrome is old ' +
      'or this is not Chrome; on iOS, Safari has no immersive-ar and there is ' +
      'no way around it.';
    setStatus('no WebXR');
    return;
  }
  let ar = false;
  try {
    ar = await navigator.xr.isSessionSupported('immersive-ar');
  } catch (err) {
    report.textContent = `isSessionSupported threw: ${err.message}`;
    return;
  }
  report.innerHTML = ar
    ? '<span class="yes">✔ immersive-ar supported</span>\nARCore is present and this device is on its list.'
    : '<span class="no">✘ immersive-ar unsupported</span>\nEither not ARCore-certified, or ' +
      '"Google Play Services for AR" is not installed — that is usually all that is missing.';
  startBtn.disabled = !ar;
  setStatus(ar ? 'ready' : 'immersive-ar unsupported');
  if (ar) {
    report.innerHTML += '\n\nIn the session: <b>tap the screen</b> to mark your starting point, ' +
      'walk a loop around the room, come back to the same spot, then exit with the system ' +
      'back gesture. The reading you want is printed here afterwards.';
  }
}

async function start() {
  // The base layer has to exist before the first frame or the session presents
  // nothing — a black screen, which is what this looked like without it.
  const canvas = document.createElement('canvas');
  gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: false });
  if (!gl) {
    live.textContent = 'no WebGL context — cannot present an AR session';
    return;
  }

  const init = {
    optionalFeatures: OPTIONAL,
    // Ask for both usages and both formats: whatever comes back is reported
    // rather than assumed.
    depthSensing: {
      usagePreference: ['cpu-optimized', 'gpu-optimized'],
      dataFormatPreference: ['luminance-alpha', 'float32'],
    },
    domOverlay: { root: overlay },
  };
  try {
    session = await navigator.xr.requestSession('immersive-ar', init);
  } catch (err) {
    live.textContent = `session refused: ${err.message}`;
    return;
  }

  granted = OPTIONAL.filter((f) => session.enabledFeatures?.includes(f));
  refused = OPTIONAL.filter((f) => !granted.includes(f));

  try {
    await gl.makeXRCompatible();
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  } catch (err) {
    live.textContent = `could not attach a render layer: ${err.message}`;
    await session.end();
    return;
  }

  // local-floor puts the origin on the detected floor, which is the frame a
  // room map would want. Fall back to local if the device will not give it.
  try {
    refSpace = await session.requestReferenceSpace('local-floor');
    spaceKind = 'local-floor';
  } catch {
    refSpace = await session.requestReferenceSpace('local');
    spaceKind = 'local';
  }

  frames = 0;
  lost = 0;
  origin = null;
  maxDist = 0;
  lastDist = 0;
  depthNote = 'not granted';

  overlay.classList.add('on');
  // A tap reaches us whether or not dom-overlay was granted, so the whole
  // measurement is driveable without any visible UI.
  session.addEventListener('select', markOrigin);
  session.addEventListener('end', onEnd);
  session.requestAnimationFrame(onFrame);
  setStatus('session running — tap to mark, walk a loop, then exit');
}

function markOrigin() {
  origin = null;   // re-marked on the next frame, where a pose is available
  maxDist = 0;
}

function onFrame(t, frame) {
  session.requestAnimationFrame(onFrame);
  frames++;

  // Clear the layer to fully transparent: the camera passthrough is composited
  // behind it, so drawing nothing is what shows the room.
  const layer = session.renderState.baseLayer;
  if (layer) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  const pose = frame.getViewerPose(refSpace);
  if (!pose) {
    lost++;
    overlayText.textContent = `TRACKING LOST (${lost} of ${frames} frames)`;
    return;
  }
  const p = pose.transform.position;
  if (!origin) origin = { x: p.x, y: p.y, z: p.z };

  if (depthNote === 'not granted' || depthNote.startsWith('depth')) {
    try {
      const d = frame.getDepthInformation?.(pose.views[0]);
      if (d) {
        depthNote = `depth ${d.width}x${d.height}, centre ` +
          `${d.getDepthInMeters(0.5, 0.5).toFixed(2)} m`;
      }
    } catch (err) {
      depthNote = `depth threw: ${err.message}`;
    }
  }

  // Walk away and come back: the distance on return *is* the accumulated
  // drift, because the true distance is zero.
  lastDist = Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z);
  maxDist = Math.max(maxDist, lastDist);
  overlayText.textContent =
    `pos ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}\n` +
    `from mark ${lastDist.toFixed(3)} m (went out to ${maxDist.toFixed(2)} m)\n` +
    `${depthNote}\nlost ${lost}/${frames} frames`;
}

function onEnd() {
  overlay.classList.remove('on');
  setStatus('session ended');
  const drift = maxDist > 1
    ? `<b>returned ${lastDist.toFixed(3)} m from the mark</b> after walking out to ` +
      `${maxDist.toFixed(2)} m — that residual is the accumulated drift.`
    : `only moved ${maxDist.toFixed(2)} m from the mark, which is too little to ` +
      'say anything about drift — walk a real loop around the room.';
  live.innerHTML = [
    `<span class="yes">granted: ${esc(granted.join(', ')) || '(none reported)'}</span>`,
    `<span class="no">refused: ${esc(refused.join(', ')) || 'nothing'}</span>`,
    `reference space: ${spaceKind}`,
    `depth: ${esc(depthNote)}`,
    `tracking lost on ${lost} of ${frames} frames`,
    drift,
  ].join('\n');
  session = null;
}

startBtn.onclick = start;
markBtn.onclick = markOrigin;
endBtn.onclick = () => session?.end();

probe();
