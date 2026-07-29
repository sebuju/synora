'use strict';

// Tag detection, off the main thread.
//
// Detection is the one expensive thing the client does per frame, and on the
// main thread it stalls everything that shares it: the encoded-frame transform
// that publishes RTP/capture-time pairings, the recorder, the UI. Here it runs
// against raw camera frames delivered by a MediaStreamTrackProcessor, so the
// page thread only ever sees the small result message.
//
// It also means opencv.js (~10 MB, and a wasm compile) is loaded here instead
// of on the page. The page loads it only if this path is unavailable and the
// fallback in pose.js has to take over.

importScripts('/cv-common.js', '/detect-core.js');

const core = createDetectCore();

let vfSource = null;
let canvasSource = null;
// Camera frames are YUV, whose luma plane is the grayscale image already. A
// frame that turns out to be anything else goes through a canvas from then on.
let planeReadable = true;

let mainTimeOrigin = 0;
let poseRateMs = 100;
let enabled = true;
let paused = false;

let generation = 0;
let lastDetect = 0;
let intrinsicsAsked = '';

// The page's performance.now() timeline. Both contexts measure their origin
// against the same wall clock, so the difference of the two origins converts
// between them — and clock sync on the page is expressed in its own timeline.
function pageNow() {
  return performance.timeOrigin + performance.now() - mainTimeOrigin;
}

const source = {
  async luma(frame, rect) {
    if (planeReadable) {
      try {
        const got = await vfSource.luma(frame, rect);
        if (got) return got;
      } catch {
        // A rejected copyTo would reject for every later frame too, so this
        // decides the source once rather than failing silently forever.
      }
      planeReadable = false;
      vfSource.dispose();
    }
    return canvasSource.luma(frame, rect);
  },
};

async function onFrame(frame) {
  if (!enabled || paused || !core.ready) return;
  const now = performance.now();
  if (now - lastDetect < core.intervalMs(poseRateMs, now)) return;
  lastDetect = now;

  const fw = frame.codedWidth || frame.displayWidth;
  const fh = frame.codedHeight || frame.displayHeight;
  if (!fw || !fh) return;
  if (!core.hasIntrinsics(fw, fh)) {
    // Intrinsics live in localStorage, which only the page can read.
    const key = `${fw}x${fh}`;
    if (intrinsicsAsked !== key) {
      intrinsicsAsked = key;
      postMessage({ type: 'need-intrinsics', w: fw, h: fh });
    }
    return;
  }

  const at = pageNow();
  const result = await core.detect(source, frame, fw, fh, now);
  if (!result) return;
  postMessage({
    type: 'pose',
    at,
    w: fw,
    h: fh,
    calibrated: result.calibrated,
    tags: result.tags,
    mode: result.mode,
    retried: !!result.retried,
    idle: result.idle,
    scanned: result.scanned,
    timing: result.timing,
  });
}

// Frames keep being read and closed even while detection is off: the track
// processor drops what is not read, but leaving the stream unread entirely is
// what makes it back up.
async function consume(readable, gen) {
  const reader = readable.getReader();
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    if (chunk.done) break;
    const frame = chunk.value;
    if (gen !== generation) {
      frame.close();
      break;
    }
    try {
      await onFrame(frame);
    } catch {
      // A single bad frame (mid-switch, zero-size) must not kill the loop.
    }
    frame.close();
  }
  try {
    await reader.cancel();
  } catch {
    // Already errored or closed by the track ending.
  }
}

onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    mainTimeOrigin = msg.timeOrigin;
    poseRateMs = msg.poseRateMs ?? poseRateMs;
    core.setMarkerSize(msg.markerSizeM);
    try {
      await core.ensureReady();
    } catch (err) {
      postMessage({ type: 'fatal', message: err.message });
      return;
    }
    vfSource = createVideoFrameLumaSource(core.cv);
    canvasSource = createCanvasLumaSource(core.cv);
    postMessage({ type: 'ready' });
  } else if (msg.type === 'track') {
    // A new track is a new picture: the crop from the old one means nothing.
    generation++;
    core.resetScan();
    intrinsicsAsked = '';
    consume(msg.readable, generation);
  } else if (msg.type === 'intrinsics') {
    if (!core.ready) {
      intrinsicsAsked = '';   // ask again once there is something to store it in
      return;
    }
    core.setIntrinsics(msg.w, msg.h, msg.intr);
  } else if (msg.type === 'reset-intrinsics') {
    intrinsicsAsked = '';
    core.clearIntrinsics();
    core.resetScan();
  } else if (msg.type === 'config') {
    if (msg.poseRateMs) poseRateMs = msg.poseRateMs;
    if (msg.markerSizeM) core.setMarkerSize(msg.markerSizeM);
  } else if (msg.type === 'enabled') {
    enabled = msg.on;
    if (msg.on) core.resetScan();
  } else if (msg.type === 'paused') {
    // A paused client has its tracks disabled, so the frames still arriving are
    // black — detecting on them is pure waste.
    paused = msg.paused;
    if (!msg.paused) core.resetScan();
  }
};
