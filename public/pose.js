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
  let publish = null;    // where an observation goes; default is signaling.send

  let enabled = false;
  let paused = false;
  let config = { markerSizeM: 0.15, poseRateMs: 150 };
  let facing = 'environment';

  // Detection rate, over the same rolling-window meter /xr-client uses (see
  // common.js) — so a phone delivering 3 detections a second against a 100 ms
  // ask is no longer indistinguishable on the dashboard from one delivering
  // 10. Rolls once per detection rather than once per frame: there is no
  // continuous frame loop here to roll on, on either path (the worker awaits
  // each frame in turn, the fallback is driven by requestVideoFrameCallback
  // gated the same way). `fps` and `blocked` are absent — a slow detect delays
  // the next one rather than costing a distinct dropped frame, and the whole
  // deficit already shows up as detHz falling behind targetMs.
  let lastTargetMs = config.poseRateMs;
  const detectMeter = createCostMeter({
    windowMs: 5000,
    shape: (win) => ({
      detHz: win.rate('dets'),
      detMs: win.mean('dets'),
      // The interval actually being enforced (idle backoff widens it — see
      // detect-core.js intervalMs) alongside the raw ask, so a client backed
      // off looking at a blank wall reads as "idle rate", not "behind".
      targetMs: lastTargetMs,
      askedMs: config.poseRateMs,
    }),
  });

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
    const K = intrinsicsAt(res.w, res.h);
    lastTargetMs = res.targetMs ?? config.poseRateMs;
    detectMeter.roll(performance.now());
    detectMeter.bump('dets', res.timing.total);
    // One observation message, two askers. /client sends it as `pose` and the
    // server surveys, journals and rosters off it; /audio-lab sends the same
    // fields as `locate` and the server only answers where that is. The seam is
    // here rather than a second detect loop on the other page: the camera, the
    // worker, the intrinsics ladder and the cost meter are the expensive parts
    // and there must be exactly one of them.
    (publish || ((m) => signaling.send(m)))({
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
      // The camera model. Tag poses are solved on this side, but the server
      // needs one too — for the survey's joint multi-tag PnP — and it has no
      // access to this client's stored calibration.
      //
      // Sent on every message, unconditionally. Tracking when it changed would
      // be false economy at six numbers, a mid-session resolution switch is
      // normal, and a stale camera model biases everything it touches in
      // silence. It was briefly conditional, and the cost of that was the joint
      // PnP quietly never running.
      intr: K && { fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy, dist: K.dist },
      // What the detection loop is costing, for the drawer card and the
      // journal — see /xr-client's identical field for why this rides the
      // pose message rather than client-state.
      cost: detectMeter.report(),
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

  async function fallbackDetect(now, targetMs) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    if (!core.hasIntrinsics(w, h)) core.setIntrinsics(w, h, intrinsicsAt(w, h));
    const res = await core.detect(canvasSource, video, w, h, now);
    if (!res) return;
    publishPose({ ...res, at: now, targetMs });
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
      // The interval is read once core is known ready, or `intervalMs` runs on
      // a core that does not exist yet.
      if (core?.ready && !busy && !paused) {
        const targetMs = core.intervalMs(config.poseRateMs, now);
        if (now - lastDetect >= targetMs) {
          lastDetect = now;
          busy = true;
          try {
            await fallbackDetect(now, targetMs);
          } catch {
            // A single bad frame (mid-switch, zero-size) must not kill the loop.
          } finally {
            busy = false;
          }
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
      publish = opts.publish || null;
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
