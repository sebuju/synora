'use strict';

// Client-side marker pose pipeline: watches the camera, detects room tags,
// solves each tag's camera-frame pose, and publishes the observations. All
// room-frame math happens on the server — this side deliberately knows nothing
// about the marker map.
//
// The detection itself lives in detect-core.js and runs in detect-worker.js,
// fed straight from the camera track. This file is the part that has to stay on
// the page: the sockets, the clock, localStorage-backed intrinsics, and the
// stats overlay.
//
// Where a worker cannot be fed camera frames (no MediaStreamTrackProcessor),
// the same core runs here instead, driven by requestVideoFrameCallback on the
// preview element. The callback chain belongs to the element, not the stream,
// so it survives srcObject swaps (camera switch, recovery) on its own;
// re-arming is still idempotent because backgrounding can end it silently.

const posePipeline = (() => {
  let video = null;
  let signaling = null;
  let bulk = null;       // bulk-upload socket — keyframes must not delay poses
  let clockSync = null;
  let onState = null;    // notifies client.js so it can report client-state

  let enabled = false;
  let paused = false;
  let config = { markerSizeM: 0.15, poseRateMs: 150, keyframeMs: 1000 };
  let facing = 'environment';

  // Intrinsics are read from localStorage, so the page owns them whichever
  // thread does the detecting. They always describe the full frame — crops
  // offset corners, they never rescale the camera model.
  let intr = null;
  let intrW = 0;
  let intrH = 0;

  let worker = null;
  let workerFailed = false;
  let fedTrack = null;

  // Main-thread fallback only.
  let core = null;
  let coreStarting = null;
  let canvasSource = null;
  let armed = false;
  let busy = false;
  let lastDetect = 0;
  let lastKeyframe = 0;

  // Keyframes ride the bulk socket, which the recorder keeps busy at ~500 KB/s
  // — demanding an empty buffer starves them entirely. A modest backlog is fine
  // (nothing latency-critical sits behind them there); the cap only stops a
  // link that cannot keep up from accumulating an unbounded queue of stale
  // frames.
  const KEYFRAME_MAX_BUFFERED = 1.5 * 1024 * 1024;
  let keyframesAllowed = true;

  const statsEl = document.getElementById('poseStats');
  let roomPose = null;   // echoed back by the server; the map lives there

  function intrinsicsAt(w, h) {
    if (!intr || intrW !== w || intrH !== h) {
      intr = intrinsicsFor(facing, w, h);
      intrW = w;
      intrH = h;
    }
    return intr;
  }

  function currentTrack() {
    return video?.srcObject?.getVideoTracks?.()[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Results, from whichever thread produced them.

  function publishPose(res) {
    signaling.send({
      type: 'pose',
      t: clockSync.synced ? clockSync.at(res.at) : null,
      w: res.w,
      h: res.h,
      calibrated: res.calibrated,
      unc: clockSync.synced ? Math.round(clockSync.uncertaintyMs * 10) / 10 : null,
      tags: res.tags,
    });
    updateStats(res);
    updateKeyframePermission();
  }

  // Binary envelope: 'KFR1' | uint32 LE header length | JSON header | JPEG.
  // Rides the same socket as recording chunks; the magic is what keeps the
  // server from appending it to the recording.
  function sendKeyframe(kf) {
    const cam = intrinsicsAt(kf.w, kf.h);
    const header = new TextEncoder().encode(JSON.stringify({
      t: clockSync.synced ? clockSync.at(kf.at) : null,
      w: kf.kw,
      h: kf.kh,
      // Intrinsics scale with pixel pitch; tag poses are metric and do not.
      intrinsics: {
        fx: cam.fx * kf.scale, fy: cam.fy * kf.scale,
        cx: cam.cx * kf.scale, cy: cam.cy * kf.scale,
        dist: cam.dist,
      },
      tags: kf.tags,
    }));
    const head = new Uint8Array(8);
    head[0] = 0x4b; head[1] = 0x46; head[2] = 0x52; head[3] = 0x31;   // KFR1
    new DataView(head.buffer).setUint32(4, header.length, true);
    bulk.sendBinary(new Blob([head, header, kf.bytes]));
  }

  function updateKeyframePermission() {
    const allowed = bulk.bufferedAmount < KEYFRAME_MAX_BUFFERED;
    if (allowed === keyframesAllowed) return;
    keyframesAllowed = allowed;
    worker?.postMessage({ type: 'keyframes', allowed });
  }

  // On-screen diagnostics — makes "why is nothing happening" answerable from
  // the client alone, and "why is it slow" answerable without a profiler: the
  // timing breakdown separates getting the pixels from searching them.
  function updateStats(res) {
    if (!statsEl) return;
    const t = res.timing;
    const scan = res.mode === 'roi'
      ? `roi ${Math.round(res.scanned.w)}x${Math.round(res.scanned.h)}`
      : `full${res.retried ? ' (roi missed)' : ''}${res.idle ? ', idle rate' : ''}`;
    const lines = [
      `${res.w}x${res.h} · ${res.calibrated ? 'calibrated' : 'UNCALIBRATED'} · ` +
      `clock ${clockSync.synced ? `±${clockSync.uncertaintyMs.toFixed(0)} ms` : 'unsynced'}`,
      `${scan} · ${Math.round(t.total)} ms ` +
      `(grab ${Math.round(t.grab)} · find ${Math.round(t.detect)} · pnp ${Math.round(t.solve)})` +
      (worker ? '' : ' · on-page'),
    ];
    lines.push(roomPose?.pose
      ? `room: ${roomPose.pose.p.map((v) => v.toFixed(2)).join(', ')} · ${roomPose.quality}`
      : 'room: unlocalized');
    for (const tag of res.tags) {
      // Viewing angle off the tag's normal: 0° is straight on, past ~60° the
      // pose degrades — same number the dashboard's 3D view colors.
      const n = quatRotate(quatFromRvec(tag.rvec), [0, 0, 1]);
      const d = Math.hypot(...tag.tvec);
      const cosA = d > 1e-6
        ? -(n[0] * tag.tvec[0] + n[1] * tag.tvec[1] + n[2] * tag.tvec[2]) / d
        : 1;
      const ang = Math.acos(Math.min(1, Math.max(-1, cosA))) * 180 / Math.PI;
      lines.push(
        `tag ${tag.id}: ${d.toFixed(2)} m · ${Math.round(ang)}° · err ${tag.err.toFixed(1)} px`);
    }
    if (!res.tags.length) lines.push('no tags in view');
    statsEl.textContent = lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Worker path.

  function handleWorkerMessage(msg) {
    if (msg.type === 'pose') {
      publishPose(msg);
    } else if (msg.type === 'keyframe') {
      sendKeyframe(msg);
    } else if (msg.type === 'need-intrinsics') {
      worker?.postMessage({
        type: 'intrinsics', w: msg.w, h: msg.h, intr: intrinsicsAt(msg.w, msg.h),
      });
    } else if (msg.type === 'fatal') {
      failWorker();
    }
  }

  // Anything that goes wrong in the worker costs detection entirely, so it is
  // never left broken: the page picks the work up itself instead.
  function failWorker() {
    worker?.terminate();
    worker = null;
    workerFailed = true;
    fedTrack = null;
    if (enabled) {
      startFallback().catch((err) => setStatus(`marker tracking failed: ${err.message}`));
    }
  }

  function ensureWorker() {
    if (worker || workerFailed) return worker;
    // Without a track processor the worker has no way to see camera frames, and
    // shipping them through the page would cost more than it saves.
    if (typeof Worker !== 'function' || typeof MediaStreamTrackProcessor !== 'function') {
      workerFailed = true;
      return null;
    }
    try {
      worker = new Worker('/detect-worker.js');
    } catch {
      workerFailed = true;
      return null;
    }
    worker.onerror = () => failWorker();
    worker.onmessage = (ev) => handleWorkerMessage(ev.data);
    worker.postMessage({
      type: 'init',
      timeOrigin: performance.timeOrigin,
      markerSizeM: config.markerSizeM,
      poseRateMs: config.poseRateMs,
      keyframeMs: config.keyframeMs,
    });
    return worker;
  }

  function feedWorker() {
    const track = currentTrack();
    if (!worker || !track || track === fedTrack) return;
    let processor;
    try {
      processor = new MediaStreamTrackProcessor({ track });
    } catch {
      failWorker();
      return;
    }
    fedTrack = track;
    worker.postMessage({ type: 'track', readable: processor.readable }, [processor.readable]);
  }

  // -------------------------------------------------------------------------
  // Main-thread fallback: the same core, fed from the preview element.

  function startFallback() {
    coreStarting ??= (async () => {
      core ??= createDetectCore();
      await core.ensureReady();
      canvasSource ??= createCanvasLumaSource(core.cv);
      core.setMarkerSize(config.markerSizeM);
    })().finally(() => {
      coreStarting = null;
    });
    return coreStarting.then(armLoop);
  }

  async function fallbackDetect(now) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    if (!core.hasIntrinsics(w, h)) core.setIntrinsics(w, h, intrinsicsAt(w, h));
    const res = await core.detect(canvasSource, video, w, h, now);
    if (!res) return;
    publishPose({ ...res, at: now });

    if (!res.tags.length || !keyframesAllowed || config.keyframeMs <= 0) return;
    if (now - lastKeyframe < config.keyframeMs) return;
    lastKeyframe = now;
    const kf = await core.encodeKeyframe(video, w, h);
    if (kf) sendKeyframe({ ...kf, at: now, tags: res.tags, w, h });
  }

  function armLoop() {
    if (armed || worker || !video.requestVideoFrameCallback) return;
    armed = true;
    const onFrame = async () => {
      if (!enabled || worker) {
        armed = false;   // chain parks; setEnabled re-arms
        return;
      }
      const now = performance.now();
      // `busy` matters here in a way it did not when detection was synchronous:
      // a detect that outruns the frame interval must not be started twice.
      if (core?.ready && !busy && !paused
        && now - lastDetect >= core.intervalMs(config.poseRateMs, now)) {
        lastDetect = now;
        busy = true;
        try {
          await fallbackDetect(now);
        } catch {
          // A single bad frame (mid-switch, zero-size) must not kill the loop.
        } finally {
          busy = false;
        }
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  return {
    init(opts) {
      video = opts.video;
      signaling = opts.signaling;
      bulk = opts.bulk;
      clockSync = opts.clockSync;
      onState = opts.onState;
    },
    setRoomPose(msg) {
      roomPose = msg;
    },
    setConfig(cfg) {
      if (cfg.markerSizeM) config.markerSizeM = cfg.markerSizeM;
      if (cfg.poseRateMs) config.poseRateMs = cfg.poseRateMs;
      // 0 is meaningful: mapping is off, stop producing keyframes.
      if (cfg.keyframeMs !== undefined) config.keyframeMs = cfg.keyframeMs;
      core?.setMarkerSize(config.markerSizeM);
      worker?.postMessage({ type: 'config', ...config });
    },
    async setEnabled(on) {
      enabled = on;
      onState?.();
      if (!on) {
        if (statsEl) statsEl.textContent = '';
        worker?.postMessage({ type: 'enabled', on: false });
        return;
      }
      if (ensureWorker()) {
        worker.postMessage({ type: 'enabled', on: true });
        feedWorker();
        return;
      }
      await startFallback();
    },
    get enabled() {
      return enabled;
    },
    // A paused client has its tracks disabled, so every frame is black.
    setPaused(on) {
      paused = on;
      worker?.postMessage({ type: 'paused', paused: on });
    },
    // Called after startCamera(): new track, maybe new lens or resolution.
    onCameraChanged(newFacing) {
      facing = newFacing;
      intrW = 0;         // force intrinsics re-read at the next frame
      intr = null;
      core?.clearIntrinsics();
      core?.resetScan();
      worker?.postMessage({ type: 'reset-intrinsics' });
      if (!enabled) return;
      if (worker) feedWorker();
      else armLoop();
    },
  };
})();
