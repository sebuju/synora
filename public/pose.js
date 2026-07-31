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
  let bulk = null;       // bulk-upload socket — recorder chunks
  let clockSync = null;
  let onState = null;    // notifies client.js so it can report client-state

  let enabled = false;
  let paused = false;
  let config = { markerSizeM: 0.15, poseRateMs: 150 };
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
  let tracker = null;
  let armed = false;
  let busy = false;
  let lastDetect = 0;

  // Landmark feature tracking, off unless asked for. It is switched here rather
  // than through the server's pose config because it is a measurement build's
  // toggle, not a room setting: it costs CPU on the client and a few KB per
  // message on the signaling socket, and nothing consumes it yet.
  const trackFeatures = (() => {
    const q = new URLSearchParams(location.search).get('landmarks');
    if (q !== null) {
      try {
        localStorage.setItem('streamer-landmarks', q === '1' || q === 'true' ? '1' : '0');
      } catch {
        // Private mode; the query parameter still governs this load.
      }
      return q === '1' || q === 'true';
    }
    try {
      return localStorage.getItem('streamer-landmarks') === '1';
    } catch {
      return false;
    }
  })();
  let lastTracked = null;


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
    // Undefined rather than null when tracking is off: JSON.stringify drops an
    // undefined field entirely, so a client without landmarks publishes the
    // byte-identical message it published before this existed.
    const K = res.points ? intrinsicsAt(res.w, res.h) : undefined;
    signaling.send({
      type: 'pose',
      t: clockSync.synced ? clockSync.at(res.at) : null,
      w: res.w,
      h: res.h,
      calibrated: res.calibrated,
      // Which tier of the intrinsics ladder solved this. The server gates
      // survey maintenance on it, and the dashboard names it.
      source: res.source,
      scale: res.scale,
      from: res.from,
      unc: clockSync.synced ? Math.round(clockSync.uncertaintyMs * 10) / 10 : null,
      tags: res.tags,
      points: res.points,
      gen: res.gen,
      // The camera model, for the landmark solver: tag poses are solved here,
      // but a landmark is only a pixel until the server has a K to turn it into
      // a bearing, and the server has no access to this client's calibration.
      // Sent on every message rather than tracked for changes — it is four
      // numbers and a coefficient vector, a mid-session resolution switch is
      // normal, and a stale camera model biases every landmark silently.
      intr: K ? {
        fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy, dist: K.dist,
      } : undefined,
    });
    updateStats(res);
  }

  // On-screen diagnostics — makes "why is nothing happening" answerable from
  // the client alone, and "why is it slow" answerable without a profiler: the
  // timing breakdown separates getting the pixels from searching them.
  //
  // The camera-model line is a DOM node rather than part of the text blob so it
  // can be coloured: a guessed or derived model is the one state where every
  // other number on the overlay is quietly wrong, and it was previously a
  // lowercase word in the same green as the rest.
  function updateStats(res) {
    if (!statsEl) return;
    const t = res.timing;
    const scan = res.mode === 'roi'
      ? `roi ${Math.round(res.scanned.w)}x${Math.round(res.scanned.h)}`
      : `full${res.retried ? ' (roi missed)' : ''}${res.idle ? ', idle rate' : ''}`;
    const model = describeCameraModel(res);
    const modelEl = document.createElement('span');
    if (model.level !== 'ok') modelEl.className = model.level;
    modelEl.textContent = `${res.w}x${res.h} · ${model.long}`;
    const lines = [
      // The clock shares the model's line while that line is two words, and
      // takes its own once the model has a sentence to explain itself.
      `${model.level === 'ok' ? ' · ' : '\n'}`
      + `clock ${clockSync.synced ? `±${clockSync.uncertaintyMs.toFixed(0)} ms` : 'unsynced'}`,
      `${scan} · ${Math.round(t.total)} ms ` +
      `(grab ${Math.round(t.grab)} · find ${Math.round(t.detect)} · pnp ${Math.round(t.solve)})` +
      (worker ? '' : ' · on-page'),
    ];
    // Feature tracking is new per-cycle cost on the one path this project
    // deliberately spends CPU on, so it is as visible as the rest of it.
    if (res.points) {
      lines.push(`track ${res.points.length} pts · ${Math.round(res.trackMs ?? 0)} ms`);
    }
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
    statsEl.replaceChildren(modelEl, document.createTextNode(lines.join('\n')));
  }

  // -------------------------------------------------------------------------
  // Worker path.

  function handleWorkerMessage(msg) {
    if (msg.type === 'pose') {
      publishPose(msg);
    } else if (msg.type === 'need-intrinsics') {
      worker?.postMessage({
        type: 'intrinsics', w: msg.w, h: msg.h, intr: intrinsicsAt(msg.w, msg.h),
      });
    } else if (msg.type === 'track-failed') {
      // Landmarks are gone for this session; detection is not, so the worker
      // stays exactly where it is.
      setStatus('feature tracking failed; landmarks off');
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
      trackFeatures,
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
      // The tracker's own source, at its own width — see createFeatureTracker
      // for why it cannot share the detector's.
      if (trackFeatures) {
        tracker ??= createFeatureTracker(core.cv,
          createCanvasLumaSource(core.cv, { maxWidth: TRACK_WIDTH }));
      }
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
    // The same tracking the worker does, so the two paths cannot silently
    // differ in what they collect — and the same containment: a tracker that
    // throws costs landmarks, never the pose report.
    let tracked = null;
    if (tracker) {
      try {
        tracked = await tracker.track(video, res.boxes);
      } catch {
        tracker.dispose();
        tracker = null;
        setStatus('feature tracking failed; landmarks off');
      }
    }
    publishPose({
      ...res,
      at: now,
      points: tracked?.points.map((p) => ({
        id: p.id,
        u: Math.round(p.u * 100) / 100,
        v: Math.round(p.v * 100) / 100,
      })),
      gen: tracked?.gen,
      trackMs: tracked?.ms,
    });
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
    // A paused client has its tracks disabled, so every frame is black — and a
    // point followed into a black frame and out the other side is a point that
    // has silently changed what it means.
    setPaused(on) {
      paused = on;
      if (!on) tracker?.reset();
      worker?.postMessage({ type: 'paused', paused: on });
    },
    // Called after startCamera(): new track, maybe new lens or resolution.
    onCameraChanged(newFacing) {
      facing = newFacing;
      intrW = 0;         // force intrinsics re-read at the next frame
      intr = null;
      core?.clearIntrinsics();
      core?.resetScan();
      // New lens or new size: every point in flight describes a picture that no
      // longer exists, and an id carried across that would fuse two different
      // physical features into one landmark.
      tracker?.reset();
      worker?.postMessage({ type: 'reset-intrinsics' });
      if (!enabled) return;
      if (worker) feedWorker();
      else armLoop();
    },
  };
})();
