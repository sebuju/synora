'use strict';

// Phone-side marker pose pipeline: watches the preview video, detects room
// tags, solves each tag's camera-frame pose, and publishes the observations.
// All room-frame math happens on the server — this side deliberately knows
// nothing about the marker map.
//
// The detection loop rides requestVideoFrameCallback on the preview element.
// The callback chain belongs to the element, not the stream, so it survives
// srcObject swaps (camera switch, recovery) on its own; re-arming is still
// idempotent because backgrounding can end the chain silently.

const posePipeline = (() => {
  // cv objects live for the page's lifetime once created; per-frame Mats are
  // the ones that leak wasm heap if not deleted, so they are created once and
  // reused, and temporaries are deleted in finally blocks.
  let video = null;
  let signaling = null;
  let bulk = null;       // bulk-upload socket — keyframes must not delay poses
  let clockSync = null;
  let onState = null;      // notifies phone.js so it can report client-state

  let enabled = false;
  let config = { markerSizeM: 0.15, poseRateMs: 150, keyframeMs: 1000 };
  let facing = 'environment';
  let lastKeyframe = 0;
  let keyframeBusy = false;

  let cv = null;
  let loading = false;
  let detector = null;
  let grabber = null;
  let corners = null;
  let ids = null;
  let rejected = null;
  let objPts = null;
  let KMat = null;
  let distMat = null;
  let rvec = null;
  let tvec = null;
  let projected = null;

  let genericPnP = false;
  let intr = null;
  let intrW = 0;
  let intrH = 0;
  let armed = false;
  let lastDetect = 0;
  let lastMarkerSize = 0;
  const statsEl = document.getElementById('poseStats');
  let roomPose = null;   // echoed back by the server; the map lives there

  function buildObjPoints() {
    const s = config.markerSizeM / 2;
    objPts?.delete();
    // ArUco corner order TL,TR,BR,BL; marker frame x right, y up, z out.
    objPts = cv.matFromArray(4, 3, cv.CV_32F, [
      -s, s, 0, s, s, 0, s, -s, 0, -s, -s, 0,
    ]);
    lastMarkerSize = config.markerSizeM;
  }

  function refreshIntrinsics(w, h) {
    intr = intrinsicsFor(facing, w, h);
    intrW = w;
    intrH = h;
    KMat?.delete();
    distMat?.delete();
    KMat = cv.matFromArray(3, 3, cv.CV_64F, [
      intr.fx, 0, intr.cx, 0, intr.fy, intr.cy, 0, 0, 1,
    ]);
    distMat = cv.matFromArray(1, 5, cv.CV_64F, intr.dist);
  }

  function meanReprojErr(cornerMat, r, t) {
    cv.projectPoints(objPts, r, t, KMat, distMat, projected);
    const det = cornerMat.data32F;
    const prj = projected.data32F;
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      sum += Math.hypot(det[i * 2] - prj[i * 2], det[i * 2 + 1] - prj[i * 2 + 1]);
    }
    return sum / 4;
  }

  // Planar single-tag PnP (IPPE) has a two-fold mirror ambiguity, and the
  // wrong pick teleports the camera. When the build exposes solvePnPGeneric,
  // both solutions are returned (best reprojection first) so the server —
  // which knows the marker map and the phone's recent pose — can pick the
  // consistent one instead of this side guessing blind.
  function solveTag(cornerMat) {
    if (genericPnP) {
      const rvecs = new cv.MatVector();
      const tvecs = new cv.MatVector();
      try {
        const n = cv.solvePnPGeneric(objPts, cornerMat, KMat, distMat,
          rvecs, tvecs, false, cv.SOLVEPNP_IPPE_SQUARE);
        const sols = [];
        for (let i = 0; i < n && i < 2; i++) {
          const r = rvecs.get(i);
          const t = tvecs.get(i);
          try {
            sols.push({
              rvec: [...r.data64F],
              tvec: [...t.data64F],
              err: meanReprojErr(cornerMat, r, t),
            });
          } finally {
            r.delete();
            t.delete();
          }
        }
        if (sols.length) return sols.sort((a, b) => a.err - b.err);
      } catch {
        genericPnP = false;   // binding missing/incompatible in this build
      } finally {
        rvecs.delete();
        tvecs.delete();
      }
    }
    const ok = cv.solvePnP(objPts, cornerMat, KMat, distMat, rvec, tvec,
      false, cv.SOLVEPNP_IPPE_SQUARE);
    if (!ok) return null;
    return [{
      rvec: [...rvec.data64F],
      tvec: [...tvec.data64F],
      err: meanReprojErr(cornerMat, rvec, tvec),
    }];
  }

  const roundSol = (s) => ({
    rvec: s.rvec.map((v) => Math.round(v * 1e5) / 1e5),
    tvec: s.tvec.map((v) => Math.round(v * 1e4) / 1e4),
    err: Math.round(s.err * 100) / 100,
  });

  // Detection runs at native resolution — tag corner accuracy (and with it
  // every room-frame pose and the map built on them) scales with pixels on
  // the tag, and pose beats streaming here. Detect cost grows with area;
  // the overlay's "detect N ms" shows what the phone is paying. The cap only
  // guards pathological sources. Intrinsics come from intrinsicsFor at the
  // detection size, which rescales a stored calibration linearly.
  const DETECT_MAX_DIM = 4096;

  function detectFrame() {
    const t0 = performance.now();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const ds = Math.min(1, DETECT_MAX_DIM / Math.max(vw, vh));
    const w = Math.round(vw * ds);
    const h = Math.round(vh * ds);
    if (w !== intrW || h !== intrH) refreshIntrinsics(w, h);
    if (config.markerSizeM !== lastMarkerSize) buildObjPoints();

    const gray = grabber.grab(video, ds < 1 ? w : 0, ds < 1 ? h : 0);
    if (!gray) return;
    detector.detectMarkers(gray, corners, ids, rejected);

    const tags = [];
    for (let i = 0; i < ids.rows; i++) {
      const id = ids.data32S[i];
      if (id >= ROOM_TAG_COUNT) continue;
      const cornerMat = corners.get(i);
      try {
        const sols = solveTag(cornerMat);
        if (!sols) continue;
        const tag = { id, ...roundSol(sols[0]) };
        // The runner-up only matters while it is plausible — a clearly worse
        // reprojection is not an ambiguity worth the bytes.
        if (sols[1] && sols[1].err < 8) tag.alt = roundSol(sols[1]);
        tags.push(tag);
      } finally {
        cornerMat.delete();
      }
    }

    signaling.send({
      type: 'pose',
      t: clockSync.synced ? clockSync.now() : null,
      w, h,
      calibrated: intr.calibrated,
      unc: clockSync.synced ? Math.round(clockSync.uncertaintyMs * 10) / 10 : null,
      tags,
    });

    // Keyframes feed the server's room mapping. Only frames that see a tag
    // are worth sending — the server can pose those exactly, from the tags in
    // this very frame.
    // Keyframes ride the bulk socket, which the recorder keeps busy at
    // ~500 KB/s — demanding an empty buffer starves them entirely. A modest
    // backlog is fine (nothing latency-critical sits behind them there);
    // the cap only stops a link that cannot keep up from accumulating an
    // unbounded queue of stale frames.
    const now = performance.now();
    if (config.keyframeMs > 0 && tags.length && !keyframeBusy &&
      bulk.bufferedAmount < KEYFRAME_MAX_BUFFERED &&
      now - lastKeyframe >= config.keyframeMs) {
      lastKeyframe = now;
      sendKeyframe(tags, w, h);
    }

    updateStats(tags, vw, vh, w, h, now - t0);
  }

  // On-screen diagnostics — makes "why is nothing happening" answerable from
  // the phone alone.
  function updateStats(tags, vw, vh, w, h, detectMs) {
    if (!statsEl) return;
    const size = w < vw ? `${vw}x${vh} (detect ${w}x${h})` : `${w}x${h}`;
    const lines = [
      `${size} · ${intr.calibrated ? 'calibrated' : 'UNCALIBRATED'} · ` +
      `detect ${Math.round(detectMs)} ms · ` +
      `clock ${clockSync.synced ? `±${clockSync.uncertaintyMs.toFixed(0)} ms` : 'unsynced'}`,
    ];
    lines.push(roomPose?.pose
      ? `room: ${roomPose.pose.p.map((v) => v.toFixed(2)).join(', ')} · ${roomPose.quality}`
      : 'room: unlocalized');
    for (const t of tags) {
      // Viewing angle off the tag's normal: 0° is straight on, past ~60° the
      // pose degrades — same number the dashboard's 3D view colors.
      const n = quatRotate(quatFromRvec(t.rvec), [0, 0, 1]);
      const d = Math.hypot(...t.tvec);
      const cosA = d > 1e-6
        ? -(n[0] * t.tvec[0] + n[1] * t.tvec[1] + n[2] * t.tvec[2]) / d
        : 1;
      const ang = Math.acos(Math.min(1, Math.max(-1, cosA))) * 180 / Math.PI;
      lines.push(
        `tag ${t.id}: ${d.toFixed(2)} m · ${Math.round(ang)}° · err ${t.err.toFixed(1)} px`);
    }
    if (!tags.length) lines.push('no tags in view');
    statsEl.textContent = lines.join('\n');
  }

  // Binary envelope: 'KFR1' | uint32 LE header length | JSON header | JPEG.
  // Rides the same socket as recording chunks; the magic is what keeps the
  // server from appending it to the recording. The image is downscaled to
  // just above the depth model's input size — a full-res JPEG is 3-5x the
  // bytes for zero extra information, and those bytes delay pose messages.
  const KEYFRAME_MAX_W = 672;
  // ~2-3 s of recorder output; see the gate in detectFrame.
  const KEYFRAME_MAX_BUFFERED = 1.5 * 1024 * 1024;
  let kfCanvas = null;
  let kfCtx = null;

  function sendKeyframe(tags, w, h) {
    keyframeBusy = true;
    const s = Math.min(1, KEYFRAME_MAX_W / w);
    const kw = Math.round(w * s);
    const kh = Math.round(h * s);
    if (!kfCanvas) {
      kfCanvas = document.createElement('canvas');
      kfCtx = kfCanvas.getContext('2d');
    }
    if (kfCanvas.width !== kw || kfCanvas.height !== kh) {
      kfCanvas.width = kw;
      kfCanvas.height = kh;
    }
    kfCtx.drawImage(grabber.canvas, 0, 0, kw, kh);
    kfCanvas.toBlob((jpeg) => {
      keyframeBusy = false;
      if (!jpeg) return;
      const header = new TextEncoder().encode(JSON.stringify({
        t: clockSync.synced ? clockSync.now() : null,
        w: kw,
        h: kh,
        // Intrinsics scale with pixel pitch; tag poses are metric and do not.
        intrinsics: {
          fx: intr.fx * s, fy: intr.fy * s, cx: intr.cx * s, cy: intr.cy * s,
          dist: intr.dist,
        },
        tags,
      }));
      const head = new Uint8Array(8);
      head[0] = 0x4b; head[1] = 0x46; head[2] = 0x52; head[3] = 0x31;   // KFR1
      new DataView(head.buffer).setUint32(4, header.length, true);
      bulk.sendBinary(new Blob([head, header, jpeg]));
    }, 'image/jpeg', 0.8);
  }

  function armLoop() {
    if (armed || !video.requestVideoFrameCallback) return;
    armed = true;
    const onFrame = () => {
      if (!enabled || !cv) {
        armed = false;   // chain parks; setEnabled re-arms
        return;
      }
      const now = performance.now();
      if (now - lastDetect >= config.poseRateMs) {
        lastDetect = now;
        try {
          detectFrame();
        } catch {
          // A single bad frame (mid-switch, zero-size) must not kill the loop.
        }
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  async function ensureCv() {
    if (cv || loading) return;
    loading = true;
    try {
      cv = await loadOpenCv();
      genericPnP = typeof cv.solvePnPGeneric === 'function';
      detector = makeRoomDetector(cv);
      grabber = createFrameGrabber(cv);
      corners = new cv.MatVector();
      ids = new cv.Mat();
      rejected = new cv.MatVector();
      rvec = new cv.Mat();
      tvec = new cv.Mat();
      projected = new cv.Mat();
      buildObjPoints();
    } finally {
      loading = false;
    }
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
    },
    async setEnabled(on) {
      enabled = on;
      onState?.();
      if (!on && statsEl) statsEl.textContent = '';
      if (on) {
        await ensureCv();
        // Intrinsics may be stale if the user calibrated while pose was off.
        intrW = 0;
        armLoop();
      }
    },
    get enabled() {
      return enabled;
    },
    // Called after startCamera(): new track, maybe new lens or resolution.
    onCameraChanged(newFacing) {
      facing = newFacing;
      intrW = 0;         // force intrinsics re-read at next frame
      if (enabled && cv) armLoop();
    },
  };
})();
