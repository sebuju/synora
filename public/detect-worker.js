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

// pose-math.js for the rotation maths the mirror-ambiguity solve needs: it is
// transform maths, so it belongs there rather than being copied in here.
importScripts('/pose-math.js', '/cv-common.js', '/detect-core.js');

const core = createDetectCore();

let vfSource = null;
let canvasSource = null;
// The XR client's feeder. Its camera is a GL texture read back on the page, so
// it arrives as raw RGBA rather than as a VideoFrame — same detector, same
// intrinsics, same everything downstream, just a different way in.
let rgbaSource = null;
// Camera frames are YUV, whose luma plane is the grayscale image already. A
// frame that turns out to be anything else goes through a canvas from then on.
let planeReadable = true;

// Feature tracking for landmarks. Built on the first frame that wants it.
// `trackFeatures` is not a setting — it is a latch that trackFrame drops if the
// tracker ever throws, so a broken tracker stops costing anything without
// taking tag detection down with it.
let tracker = null;
let trackerKind = '';
let trackFeatures = true;

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

  const tracked = await trackFrame('frame', frame, result.boxes);

  postMessage({
    type: 'pose',
    at,
    w: fw,
    h: fh,
    calibrated: result.calibrated,
    source: result.source,
    scale: result.scale,
    from: result.from,
    tags: result.tags,
    mode: result.mode,
    retried: !!result.retried,
    idle: result.idle,
    scanned: result.scanned,
    timing: result.timing,
    points: wirePoints(tracked),
    // Track ids only mean anything within one generation — see the tracker.
    gen: tracked?.gen,
    trackMs: tracked?.ms,
    churn: tracked?.churn,
  });
}

// Feature tracking, for whichever way frames arrive. Both capture pages want
// the same thing out of it, so neither gets its own copy — the only difference
// is how a frame becomes pixels, and that is the luma source.
//
// The tracker cannot share the detector's source: on an ROI scan the detector's
// Mat is a crop of the frame, and following points between crops of different
// regions is meaningless. Its own source at TRACK_WIDTH is also what keeps this
// cheap.
//
// Wrapped because it must never be able to cost a pose report: a tracker that
// throws loses landmarks, not tags, and it does not get a second chance.
async function trackFrame(kind, frame, boxes, view) {
  if (!trackFeatures || !core.ready) return null;
  try {
    if (!tracker || trackerKind !== kind) {
      tracker?.dispose();
      trackerKind = kind;
      // On the XR path the tracker shares the detector's source. That source
      // keeps its fill keyed on the pixel buffer and its grays per size, so the
      // second call in a frame skips the 6.6 MB copy and the flip entirely and
      // neither consumer reallocates — measured, doing that work twice was most
      // of a 117 ms median tracker cost, and the cost was what let the camera
      // move far enough between frames to break the tracking it was paying for.
      //
      // The canvas path keeps its own: there the "copy" is a GPU blit that
      // already downscales, so there is nothing to share and a shared one would
      // only fight over the canvas size.
      tracker = createFeatureTracker(core.cv, kind === 'rgba'
        ? trackerViewOf(rgbaSource)
        : createCanvasLumaSource(core.cv, { maxWidth: TRACK_WIDTH }));
    }
    return await tracker.track(frame, boxes ?? [], view ?? null);
  } catch (err) {
    trackFeatures = false;
    tracker?.dispose();
    tracker = null;
    // With the reason. There are no devtools on a phone, and "landmarks stopped"
    // without a message is a whole session spent guessing which of several
    // things went wrong — as one already was.
    postMessage({ type: 'track-failed', message: err?.message || String(err) });
    return null;
  }
}

// The tracker's view of a shared luma source: the same pixels, asked for at the
// tracking width. Only the size differs, so only the size is overridden.
function trackerViewOf(shared) {
  return { luma: (image, rect) => shared.luma(image, rect, { maxWidth: TRACK_WIDTH }) };
}

// Rounded as tag corners are: the sub-centipixel digits are noise, and there
// are two orders of magnitude more of these numbers than of those.
function wirePoints(tracked) {
  return tracked?.points.map((p) => ({
    id: p.id,
    u: Math.round(p.u * 100) / 100,
    v: Math.round(p.v * 100) / 100,
  }));
}

// The XR client's frames arrive one at a time, already paced by the page (it
// only reads the camera back when it is ready for another detection), so there
// is no stream to consume and no interval to enforce here. The buffer is handed
// back with the result whatever happens: it is the page's only one, and losing
// it strands the feeder for good.
async function onRgbaFrame(msg) {
  const buf = msg.buf;
  const reply = { type: 'xr-result', seq: msg.seq, buf };
  const done = () => postMessage(reply, [buf]);
  if (!core.ready) return done();
  const { w, h } = msg;
  if (msg.intr) core.setIntrinsics(w, h, msg.intr);
  if (!core.hasIntrinsics(w, h)) return done();
  // A new XR session is a new picture, and the page is the only side that knows
  // one started. An id carried across it would fuse two different physical
  // features into one landmark, which is worse than losing both.
  if (msg.reset) tracker?.reset();
  try {
    const image = { data: new Uint8Array(buf), w, h, flipY: !!msg.flipY };
    const result = await core.detect(rgbaSource, image, w, h, performance.now());
    if (result) {
      reply.tags = result.tags;
      reply.mode = result.mode;
      reply.scanned = result.scanned;
      reply.grab = result.grab;
      reply.detect = result.detect;
      reply.solve = result.solve;
      // ARCore's orientation for this frame, when the page had one: the flow is
      // seeded from the rotation between frames rather than from "it did not
      // move", which is where a walking phone loses most of its tracks.
      // `track: false` is the page's landmark toggle — the tracker is the
      // expensive half of this frame, and off means genuinely not run, not
      // run-and-discarded. Tags are unaffected.
      const tracked = msg.track === false ? null
        : await trackFrame('rgba', image, result.boxes,
          msg.view ? { q: msg.view.q, K: msg.intr } : null);
      reply.points = wirePoints(tracked);
      reply.gen = tracked?.gen;
      reply.trackMs = tracked?.ms;
      reply.churn = tracked?.churn;
    }
  } catch (err) {
    reply.error = err.message;
  }
  return done();
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
    rgbaSource = createRgbaLumaSource(core.cv);
    postMessage({ type: 'ready' });
  } else if (msg.type === 'xr-frame') {
    await onRgbaFrame(msg);
  } else if (msg.type === 'track') {
    // A new track is a new picture: the crop from the old one means nothing,
    // and neither does any point being followed through it.
    generation++;
    core.resetScan();
    tracker?.reset();
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
    tracker?.reset();
  } else if (msg.type === 'config') {
    if (msg.poseRateMs) poseRateMs = msg.poseRateMs;
    if (msg.markerSizeM) core.setMarkerSize(msg.markerSizeM);
  } else if (msg.type === 'enabled') {
    enabled = msg.on;
    if (msg.on) {
      core.resetScan();
      tracker?.reset();
    }
  } else if (msg.type === 'paused') {
    // A paused client has its tracks disabled, so the frames still arriving are
    // black — detecting on them is pure waste, and following a point into a
    // black frame is worse than waste.
    paused = msg.paused;
    if (!msg.paused) {
      core.resetScan();
      tracker?.reset();
    }
  }
};
