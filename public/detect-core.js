'use strict';

// The tag detection engine, shared by the pose worker and the main-thread
// fallback that runs where the worker path is unavailable. It owns the OpenCV
// objects and the scan strategy; it knows nothing about sockets, the marker
// map, or where its pixels came from.
//
// Three things make this fast enough to run on a 4K preview:
//
//   1. Pixels arrive as luma only (see the sources in cv-common.js). The old
//      path drew the frame to a canvas, read back 33 MB of RGBA per frame,
//      copied that into the wasm heap and converted it to gray — four passes
//      over eight megapixels to produce one.
//   2. Once tags have been seen, only a crop around them is scanned. A frame
//      that saw tags almost certainly sees them a few pixels away, so the
//      whole-frame sweep is the exception rather than the rule.
//   3. The full sweep uses ArUco3, which searches candidates on a downscaled
//      copy and refines corners against the full-resolution image — on frames
//      large enough for that to be a saving rather than a range limit (see
//      ARUCO3_MIN_LONG_EDGE).
//
// None of it costs pose accuracy: every corner is still refined at native
// resolution, and crop coordinates are mapped back to full-frame pixels before
// anything solves a pose, so the rest of the pipeline only ever sees one
// coordinate space.

// Region-of-interest scanning. The margin has to cover how far the tags moved
// since the last scan, so it tracks the measured motion instead of guessing —
// a pan that outruns it only makes one scan come up empty, and an empty crop
// scan retries the full frame immediately.
const ROI_MARGIN_MIN_PX = 64;
const ROI_MARGIN_SIZE_FRAC = 0.6;
const ROI_MARGIN_MOTION = 2.5;
// Past this the crop is no cheaper than the frame, and the full sweep also
// picks up tags that entered the view.
const ROI_MAX_AREA_FRAC = 0.45;
// New tags can only turn up in a full sweep, so one is forced this often even
// while the crop keeps working.
const FULL_SCAN_MS = 700;

// With nothing in view there is no crop to scan, so every pass sweeps the whole
// frame — the most expensive thing here — and finds nothing. After a while of
// that, back the rate off: acquisition then costs up to IDLE_SCAN_MS instead of
// the configured interval, and the first sighting snaps straight back to full
// rate. A client pointed at a blank wall is the common case, not the rare one.
const IDLE_AFTER_MS = 1500;
const IDLE_SCAN_MS = 350;

function createDetectCore() {
  let cv = null;
  let fullDetector = null;
  let fullDetectorEdge = 0;
  let roiDetector = null;
  let corners = null;
  let ids = null;
  let rejected = null;
  let objPts = null;
  let KMat = null;
  let distMat = null;
  let rvec = null;
  let tvec = null;
  let rvecAlt = null;
  let tvecAlt = null;
  let projected = null;
  let genericPnP = false;
  let refineLM = false;
  let skipRejected = true;

  let markerSizeM = 0.15;
  let builtSize = 0;
  let intr = null;
  let intrW = 0;
  let intrH = 0;

  // Scan state: the crop to try next, when the frame was last swept whole, and
  // enough history to size the margin and notice a tag dropping out.
  let roi = null;
  let lastFullScan = 0;
  let lastCenter = null;
  let lastCount = 0;
  let lastSighting = 0;


  function buildObjPoints() {
    const s = markerSizeM / 2;
    objPts?.delete();
    // ArUco corner order TL,TR,BR,BL; marker frame x right, y up, z out.
    objPts = cv.matFromArray(4, 3, cv.CV_32F, [
      -s, s, 0, s, s, 0, s, -s, 0, -s, -s, 0,
    ]);
    builtSize = markerSizeM;
  }

  // The full-sweep profile depends on the frame's long edge (ArUco3 gates
  // acquisition range by it), and the frame size is not known at load time —
  // it arrives with the first frame and changes on a resolution switch. The
  // ROI detector has no such dependency and is built once.
  function ensureFullDetector(longEdge) {
    if (fullDetector && fullDetectorEdge === longEdge) return;
    fullDetector?.delete();
    fullDetector = makeRoomDetector(cv, 'full', longEdge);
    fullDetectorEdge = longEdge;
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

  // Two rotations must differ by more than the noise floor before the second is
  // worth shipping as an ambiguity rather than as a duplicate.
  const ALT_MIN_ANGLE_DEG = 5;

  // Planar single-tag PnP (IPPE) has a two-fold mirror ambiguity, and the wrong
  // pick teleports the camera. Both solutions have to reach the server, which
  // knows the marker map and the client's recent pose and can pick the
  // consistent one; this side cannot.
  //
  // solvePnPGeneric would hand both over directly, but the vendored build does
  // not export it (the symbol is in the wasm, it is just not bound), so for a
  // long time only one solution ever shipped, `alt` was never set, and
  // pickSolutions short-circuited on every tag — the map was averaging whichever
  // branch solvePnP happened to return. Measured on a real session: 12% of
  // solves were the mirrored one, 27% for the worst tag, each a ~40 deg
  // orientation error carrying a reprojection error under 1.3 px, so no gate saw
  // them.
  //
  // The two solutions are the two local minima of the same reprojection error,
  // so the second is reachable without solvePnPGeneric: start from the mirrored
  // pose and let a local refine converge into that basin. That is what the
  // refine below does.
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
    const first = {
      rvec: [...rvec.data64F],
      tvec: [...tvec.data64F],
      err: meanReprojErr(cornerMat, rvec, tvec),
    };
    const second = solveMirror(cornerMat, first);
    const sols = second ? [first, second] : [first];
    return sols.sort((a, b) => a.err - b.err);
  }

  // Refine each mirrored starting guess and keep the better one, provided it
  // really is a different pose.
  //
  // Both guesses are always tried rather than stopping at the first that works:
  // the in-plane-flipped one wins the great majority of the time, but measured
  // over 3000 synthetic solves the other was the only viable second solution in
  // ~3% of them. Cost is two 4-point local refines, measured at 0.21 ms per tag
  // against 0.013 ms for the IPPE solve alone — a large multiple of a tiny
  // number, and about 4 ms of CPU per second at three tags and 7 Hz, against a
  // detection step that runs tens of ms at 4K.
  function solveMirror(cornerMat, first) {
    let best = null;
    for (const guess of mirrorRvecGuesses(first.rvec, first.tvec)) {
      rvecAlt.data64F.set(guess);
      tvecAlt.data64F.set(first.tvec);
      try {
        if (refineLM) {
          cv.solvePnPRefineLM(objPts, cornerMat, KMat, distMat, rvecAlt, tvecAlt);
        } else if (!cv.solvePnP(objPts, cornerMat, KMat, distMat, rvecAlt, tvecAlt,
          true, cv.SOLVEPNP_ITERATIVE)) {
          continue;
        }
      } catch {
        // A refine that will not run for one guess will not run for any of
        // them; give up on the ambiguity rather than on the tag.
        return null;
      }
      const cand = {
        rvec: [...rvecAlt.data64F],
        tvec: [...tvecAlt.data64F],
        err: meanReprojErr(cornerMat, rvecAlt, tvecAlt),
      };
      if (!Number.isFinite(cand.err)) continue;
      // Converged back into the first solution's basin: not an ambiguity.
      if (quatAngleDeg(quatFromRvec(cand.rvec), quatFromRvec(first.rvec))
        < ALT_MIN_ANGLE_DEG) continue;
      if (!best || cand.err < best.err) best = cand;
    }
    return best;
  }

  const roundSol = (s) => ({
    rvec: s.rvec.map((v) => Math.round(v * 1e5) / 1e5),
    tvec: s.tvec.map((v) => Math.round(v * 1e4) / 1e4),
    err: Math.round(s.err * 100) / 100,
  });

  // Corners come out of the detector in crop pixels; every consumer downstream
  // — PnP, the intrinsics, the server — works in full-frame pixels.
  function offsetCorners(cornerMat, ox, oy) {
    const d = cornerMat.data32F;
    for (let i = 0; i < d.length; i += 2) {
      d[i] += ox;
      d[i + 1] += oy;
    }
  }

  // Mean edge length of the detected quad, in full-frame pixels. This is the
  // measurement the server's survey gates on: how much tag there actually was
  // to fit a pose to. It deliberately comes from the corners rather than from
  // size/distance and the camera model — a wrong model is one of the things it
  // has to stay able to expose.
  function meanSidePx(cornerMat) {
    const d = cornerMat.data32F;
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      sum += Math.hypot(d[i * 2] - d[j * 2], d[i * 2 + 1] - d[j * 2 + 1]);
    }
    return sum / 4;
  }

  function bboxOf(cornerMat) {
    const d = cornerMat.data32F;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < d.length; i += 2) {
      x0 = Math.min(x0, d[i]);
      x1 = Math.max(x1, d[i]);
      y0 = Math.min(y0, d[i + 1]);
      y1 = Math.max(y1, d[i + 1]);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function unionOf(boxes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of boxes) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  async function scan(source, frame, rect, fw, fh) {
    const t0 = performance.now();
    const grabbed = await source.luma(frame, rect);
    const t1 = performance.now();
    const mode = rect ? 'roi' : 'full';
    const whole = { x: 0, y: 0, w: fw, h: fh };
    if (!grabbed) {
      return {
        tags: [], boxes: [], mode, w: fw, h: fh, scanned: rect ?? whole,
        grab: t1 - t0, detect: 0, solve: 0,
      };
    }

    const detector = rect ? roiDetector : fullDetector;
    // The rejected-candidate list is never read here, and asking for it makes
    // OpenCV allocate and copy out a Mat per discarded quad every frame. Not
    // every build binds the three-argument overload, so it is probed once.
    if (skipRejected) {
      try {
        detector.detectMarkers(grabbed.mat, corners, ids);
      } catch {
        skipRejected = false;
      }
    }
    if (!skipRejected) detector.detectMarkers(grabbed.mat, corners, ids, rejected);
    const t2 = performance.now();

    const { x: ox, y: oy } = grabbed.rect;
    const tags = [];
    const boxes = [];
    for (let i = 0; i < ids.rows; i++) {
      const id = ids.data32S[i];
      if (id >= ROOM_TAG_COUNT) continue;
      const cornerMat = corners.get(i);
      try {
        if (ox || oy) offsetCorners(cornerMat, ox, oy);
        const sols = solveTag(cornerMat);
        if (!sols) continue;
        boxes.push(bboxOf(cornerMat));
        // The corners are the measurement; rvec/tvec are one interpretation of
        // them under one camera model. Shipping them costs eight numbers and
        // means a recorded session can be re-solved against a different model
        // — which is the only way to ask "how much of this pose error is the
        // camera model" without going back to the room with the phone.
        const tag = {
          id,
          px: Math.round(meanSidePx(cornerMat)),
          corners: [...cornerMat.data32F].map((v) => Math.round(v * 100) / 100),
          ...roundSol(sols[0]),
        };
        // The runner-up ships only when solvePnPGeneric produced it. When that
        // binding is missing the second solution is *reconstructed* by refining
        // out of a mirrored guess (see solveTag), and that reconstruction does
        // not hold up: measured against map accuracy rather than against how
        // often the branches agree, shipping it makes the map worse at every
        // threshold tried, because a spurious solution is one the server can
        // pick. Six replayed sessions of one room, worst cross-session
        // disagreement per tag, averaged:
        //
        //   twins shipped    none   <1.2x err  <1.5x   <2x    <5x    all
        //   mean worst (m)   0.141  0.147      0.145   0.226  0.304  0.286
        //
        // There is no cut where it pays, so it is gated at the source rather
        // than filtered downstream. A real IPPE pair from solvePnPGeneric is a
        // different thing and still goes, which is also what makes this
        // self-repairing if the binding ever appears. Note the earlier
        // measurement that justified the reconstruction counted branch
        // agreement, a proxy — it moved the opposite way to the map itself, so
        // re-enable this only against a map measurement.
        if (genericPnP && sols[1] && sols[1].err < 8) tag.alt = roundSol(sols[1]);
        tags.push(tag);
      } finally {
        cornerMat.delete();
      }
    }
    const t3 = performance.now();
    return {
      tags, boxes, mode, w: fw, h: fh,
      scanned: grabbed.rect,
      grab: t1 - t0, detect: t2 - t1, solve: t3 - t2,
    };
  }

  function updateRoi(result, fw, fh, now) {
    if (result.mode === 'full') lastFullScan = now;
    if (!result.boxes.length) {
      roi = null;
      lastCenter = null;
      lastCount = 0;
      return;
    }
    const u = unionOf(result.boxes);
    const cx = u.x + u.w / 2;
    const cy = u.y + u.h / 2;
    const moved = lastCenter ? Math.hypot(cx - lastCenter[0], cy - lastCenter[1]) : 0;
    lastCenter = [cx, cy];
    const count = result.boxes.length;
    // A tag that stopped being seen may have left the crop rather than the
    // room — check the whole frame before trusting a crop drawn without it.
    if (count < lastCount) {
      lastCount = count;
      roi = null;
      return;
    }
    lastCount = count;
    const margin = Math.max(ROI_MARGIN_MIN_PX, ROI_MARGIN_SIZE_FRAC * Math.max(u.w, u.h))
      + ROI_MARGIN_MOTION * moved;
    const x0 = Math.max(0, u.x - margin);
    const y0 = Math.max(0, u.y - margin);
    const x1 = Math.min(fw, u.x + u.w + margin);
    const y1 = Math.min(fh, u.y + u.h + margin);
    const area = (x1 - x0) * (y1 - y0);
    roi = area > ROI_MAX_AREA_FRAC * fw * fh
      ? null
      : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  return {
    async ensureReady() {
      if (cv) return;
      cv = await loadOpenCv();
      genericPnP = typeof cv.solvePnPGeneric === 'function';
      // Preferred over solvePnP+SOLVEPNP_ITERATIVE for the mirror refine: it is
      // a pure local refinement of the pose it is handed, with no chance of
      // re-initializing away from the basin the guess was chosen to land in.
      refineLM = typeof cv.solvePnPRefineLM === 'function';
      roiDetector = makeRoomDetector(cv, 'roi');
      corners = new cv.MatVector();
      ids = new cv.Mat();
      rejected = new cv.MatVector();
      rvec = new cv.Mat();
      tvec = new cv.Mat();
      // The refine reads these as its starting guess and writes the result back,
      // so they must be allocated at a fixed 3x1 CV_64F rather than left for
      // solvePnP to size.
      rvecAlt = cv.matFromArray(3, 1, cv.CV_64F, [0, 0, 0]);
      tvecAlt = cv.matFromArray(3, 1, cv.CV_64F, [0, 0, 0]);
      projected = new cv.Mat();
      buildObjPoints();
    },

    get cv() {
      return cv;
    },

    get ready() {
      return !!cv;
    },

    setMarkerSize(m) {
      if (m > 0) markerSizeM = m;
    },

    // Intrinsics are read from localStorage, which a worker does not have, so
    // they are always handed in from the page. They describe the full frame:
    // crops never rescale them, they only offset corners.
    setIntrinsics(w, h, data) {
      intr = data;
      intrW = w;
      intrH = h;
      KMat?.delete();
      distMat?.delete();
      KMat = cv.matFromArray(3, 3, cv.CV_64F, [
        intr.fx, 0, intr.cx, 0, intr.fy, intr.cy, 0, 0, 1,
      ]);
      distMat = cv.matFromArray(1, 5, cv.CV_64F, intr.dist);
    },

    hasIntrinsics(w, h) {
      return !!intr && intrW === w && intrH === h;
    },

    // The lens can change without the frame size doing so (a camera switch), so
    // matching dimensions are not enough to keep trusting a camera model.
    clearIntrinsics() {
      intr = null;
      intrW = 0;
      intrH = 0;
    },

    get intrinsics() {
      return intr;
    },

    // Forces the next scan to sweep the whole frame — used when the picture
    // changed underneath us (camera switch, resume) and the crop is a lie.
    resetScan() {
      roi = null;
      lastCenter = null;
      lastCount = 0;
      lastFullScan = 0;
      lastSighting = 0;
    },

    // How long the caller should wait before the next scan. Its own configured
    // interval, unless nothing has been seen for long enough to be worth
    // slowing down for.
    intervalMs(base, now) {
      if (!lastSighting) return base;
      return now - lastSighting > IDLE_AFTER_MS ? Math.max(base, IDLE_SCAN_MS) : base;
    },

    // `frame` is whatever the source understands (a VideoFrame or a <video>).
    // Returns null when it cannot run yet; the caller must have supplied
    // intrinsics for this exact frame size first.
    async detect(source, frame, fw, fh, now) {
      if (!cv || !fw || !fh || !this.hasIntrinsics(fw, fh)) return null;
      ensureFullDetector(Math.max(fw, fh));
      if (markerSizeM !== builtSize) buildObjPoints();
      // Starting up counts as having just seen something: acquisition should be
      // as quick as it can be, the backoff is for a client that has been
      // looking at nothing for a while.
      if (!lastSighting) lastSighting = now;

      const useRoi = roi && now - lastFullScan < FULL_SCAN_MS;
      let result = await scan(source, frame, useRoi ? roi : null, fw, fh);
      if (useRoi && !result.tags.length) {
        // The crop went stale — one wasted scan, then look at everything.
        const full = await scan(source, frame, null, fw, fh);
        full.grab += result.grab;
        full.detect += result.detect;
        full.solve += result.solve;
        full.retried = true;
        result = full;
      }
      updateRoi(result, fw, fh, now);
      if (result.tags.length) lastSighting = now;
      result.idle = now - lastSighting > IDLE_AFTER_MS;
      result.calibrated = intr.calibrated;
      // Which tier of the intrinsics ladder this pose was solved with. A
      // rotated or rescaled model is not the same claim as an exact one, and
      // nothing downstream could tell them apart while `calibrated` was the
      // only field.
      result.source = intr.source;
      result.scale = intr.scale;
      result.from = intr.from;
      result.timing = {
        grab: result.grab,
        detect: result.detect,
        solve: result.solve,
        total: performance.now() - now,
      };
      return result;
    },

  };
}
