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

// Feature tracking (see createFeatureTracker). Every one of these is applied in
// *tracking* pixels — the downscaled image — which is the one space the tracker
// works in; only the points it returns are back in full-frame pixels.
//
// Tracking runs downscaled where detection deliberately does not: a rescaled
// frame is a rescaled camera model and tag corners are refined at native
// resolution on purpose, but a tracked feature is only ever a correspondence.
//
// This was briefly dropped to 560 on the theory that a smaller image would both
// cost less and turn the same physical motion into fewer tracking pixels, so
// fewer frames would exceed what optical flow can follow. The theory did not
// survive measurement: on matched windows of the same walk, retention was
// identical (97% median, 98% on frames under 50 px of motion) at both widths.
// It bought nothing, so it stays where it was — corner positions are localized
// in tracking pixels and their full-frame error scales with the reciprocal, so
// the wider image is the more precise one at equal retention.
const TRACK_WIDTH = 720;
const TRACK_MAX_CORNERS = 300;
const TRACK_QUALITY = 0.01;      // Shi-Tomasi default; not independently tuned
const TRACK_MIN_DIST = 24;
const TRACK_RESEED_EVERY = 5;
// A tag's own corners are the strongest features in the frame and are already
// in the marker map, so tracking them would inflate the anchor count with
// points the survey has anyway.
const TRACK_TAG_MASK_PAD = 24;
const TRACK_LK_WIN = 21;
// A point on the frame edge is half-visible and drifts; drop it rather than
// carry a corner that is really the picture ending.
const TRACK_EDGE_PX = 2;
// Forward-backward round-trip tolerance — see follow(). Proportional to how far
// the point actually moved, with a floor and a ceiling.
//
// A flat sub-pixel tolerance is wrong here, and measurably so. At this cadence a
// walking phone carries a feature 50-150 px between frames, and the round trip
// then misses by more than a pixel from interpolation and the aperture problem
// alone, with no drift involved at all. A flat 1 px threshold therefore does not
// select against drift, it selects against *motion* — measured on a real
// session, the surviving tracks had a median camera baseline of 5.9 cm over
// 6.7 s, i.e. only the near-stationary ones lived, and a stationary track can
// never accumulate the viewing arc a landmark is qualified on.
//
// Scaling with displacement keeps the test where it belongs: a point that
// barely moved must come back almost exactly, one that swept across the frame
// is allowed a few percent of that sweep.
const TRACK_FB_MIN_PX = 1;
const TRACK_FB_FRAC = 0.04;
const TRACK_FB_CAP_PX = 4;
// Pyramid levels for the flow. Raised from 3 with the same measurement in mind:
// three levels resolve about 21 * 2^3 px of displacement, which a walking phone
// exceeds, and a track that outruns the pyramid is lost exactly when it was
// about to become useful.
const TRACK_LK_LEVELS = 4;
// A predicted point further outside the picture than this is not carried into
// the flow: the seed would be a guess about pixels that do not exist, and the
// point's previous position is the better of two bad starts. Sized on the
// search window, since a seed that far out has no overlap with the image left
// to lock onto anyway.
const TRACK_WARP_SLACK_PX = TRACK_LK_WIN;
// OpenCV's own default. Named only because passing the flags argument means
// passing this one too — the binding takes them positionally.
const LK_MIN_EIG = 1e-4;

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
    objPts?.delete();
    // The corner layout is shared with the server's joint solve — see
    // markerCornersM in cv-common.js.
    objPts = cv.matFromArray(4, 3, cv.CV_32F, markerCornersM(markerSizeM).flat());
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
      // scanned: null, not the requested rect — the grab failed, so nothing
      // was actually looked at, and a coverage claim here would let a blank
      // frame read as "no tag where one should be" downstream.
      return {
        tags: [], boxes: [], mode, w: fw, h: fh, scanned: null,
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

// Lucas-Kanade feature tracking, alongside the tag detector and deliberately
// independent of it: it is the new thing here and must not be able to break
// detection, so it owns its own pixels, its own OpenCV objects and its own
// failure. A caller that drops it loses landmarks and nothing else.
//
// What it produces is *correspondence*, not geometry: the same image feature
// followed across frames under a per-session id. It does not triangulate, does
// not know the marker map, and does not know where anything is in the room —
// that all stays on the server, as it does for tags.
//
// Two things it cannot do, both discovered rather than assumed:
//
//   - It cannot track on the luma the detector grabbed. Once tags are in view
//     that Mat is only a crop of the frame (see ROI scanning above), so
//     consecutive calls would be comparing different regions of the picture.
//   - It cannot even share the detector's luma *source*. The VideoFrame source
//     caches its backing Mat keyed on format and size, so alternating a
//     full-frame grab with a crop grab through one source deletes and
//     reallocates in the wasm heap every single cycle.
//
// So it takes its own source, which the caller builds with a maxWidth of
// TRACK_WIDTH — the downscale then happens inside drawImage on the GPU rather
// than as a full-resolution readback followed by a resize.
function createFeatureTracker(cv, source, opts = {}) {
  const maxCorners = opts.maxCorners ?? TRACK_MAX_CORNERS;
  const quality = opts.quality ?? TRACK_QUALITY;
  const minDist = opts.minDist ?? TRACK_MIN_DIST;
  const reseedEvery = opts.reseedEvery ?? TRACK_RESEED_EVERY;
  const maskPad = opts.maskPad ?? TRACK_TAG_MASK_PAD;

  const winSize = new cv.Size(opts.winSize ?? TRACK_LK_WIN, opts.winSize ?? TRACK_LK_WIN);
  const criteria = new cv.TermCriteria(
    cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01);

  let prevGray = null;   // owned here: the source's Mat is overwritten next call
  let mask = null;
  let live = [];         // [{ id, u, v }] in tracking pixels
  let nextId = 0;
  // Ids mean nothing across a reset — the picture changed, so the point that
  // was id 7 is gone and a new id 7 would be somewhere else entirely. The
  // server fuses observations by id, so it has to be told; it drops everything
  // for a client whose generation moved. Getting this wrong does not lose a
  // landmark, it *invents* one, by averaging two different physical points.
  let generation = 1;
  let cycles = 0;
  // Per-call diagnostics — see follow(). `moved` is the median inter-frame
  // displacement in tracking pixels, which is the number that decides whether
  // optical flow can work at this cadence at all.
  let drops = { status: 0, edge: 0, fb: 0 };
  let movedSum = 0;
  let movedN = 0;
  // How far the rotation prediction said the points would move, against `moved`
  // below, which is how far they actually did. The two being close is what says
  // the seed is doing its job; a large `moved` with a near-zero `pred` says the
  // camera pose is not reaching here at all, which is otherwise invisible.
  let predSum = 0;
  let predN = 0;
  // The camera orientation and model of the frame prevGray came from. Kept here
  // rather than handed in per call because the prediction has to relate *the
  // frame the tracker last kept* to this one, and the caller does not know which
  // one that was — a frame the detector skipped would silently make the caller's
  // idea of "previous" a frame older than the pixels being tracked from.
  let prevView = null;

  // The picture changed underneath us (camera switch, resume, new track), so
  // every id in flight now means something else. `nextId` deliberately keeps
  // climbing: a reused id spanning a reset is the one mistake here that does
  // not lose a landmark but invents one.
  function reset() {
    prevGray?.delete();
    prevGray = null;
    prevView = null;
    live = [];
    cycles = 0;
    generation++;
  }

  // Written straight into the Mat's data rather than through cv.rectangle: the
  // fill is trivial and this must not depend on another binding in a build that
  // has already been caught missing three.
  function buildMask(w, h, boxes, scale) {
    if (!mask || mask.cols !== w || mask.rows !== h) {
      mask?.delete();
      mask = new cv.Mat(h, w, cv.CV_8UC1);
    }
    mask.data.fill(255);
    for (const b of boxes) {
      const x0 = Math.max(0, Math.floor(b.x * scale - maskPad));
      const y0 = Math.max(0, Math.floor(b.y * scale - maskPad));
      const x1 = Math.min(w - 1, Math.ceil((b.x + b.w) * scale + maskPad));
      const y1 = Math.min(h - 1, Math.ceil((b.y + b.h) * scale + maskPad));
      for (let y = y0; y <= y1; y++) mask.data.fill(0, y * w + x0, y * w + x1 + 1);
    }
    return mask;
  }

  // The rotation prediction, expressed in the pixels the tracker actually works
  // in. The camera model the caller supplies describes the *full frame* — the
  // same convention every intrinsic in this codebase follows — while the points
  // live in the downscaled grab, so the homography is conjugated by the grab's
  // own scale and offset rather than the camera model being rescaled. A rescaled
  // camera model would be a second description of the camera, and the one thing
  // this file is careful about is that exactly one coordinate space leaves it.
  //
  // Null whenever anything is missing: no view from the caller, no view stored
  // for the previous frame, or a model that cannot be inverted. Prediction is an
  // optimisation, never a requirement — /client has no rotation source at all
  // and tracks perfectly well without one.
  function warpFor(prev, cur, grabbed) {
    if (!prev || !cur) return null;
    const H = rotationWarp(prev.q, cur.q, cur.K);
    if (!H) return null;
    const s = grabbed.scale ?? 1;
    const x = grabbed.rect?.x ?? 0;
    const y = grabbed.rect?.y ?? 0;
    // S: full-frame -> tracking pixels. Sinv the other way.
    const S = [s, 0, -x * s, 0, s, -y * s, 0, 0, 1];
    const Sinv = [1 / s, 0, x, 0, 1 / s, y, 0, 0, 1];
    return matMul3(S, matMul3(H, Sinv));
  }

  function pointsMat(list) {
    const flat = new Float32Array(list.length * 2);
    for (let i = 0; i < list.length; i++) {
      flat[i * 2] = list[i].u;
      flat[i * 2 + 1] = list[i].v;
    }
    return cv.matFromArray(list.length, 1, cv.CV_32FC2, flat);
  }

  // Follow the live set into this frame, and check the answer by tracking it
  // straight back again.
  //
  // The backward pass is not optional polish, it is what makes a track mean
  // anything. Lucas-Kanade always returns a position and reports `status = 1`
  // for it; on a repeating texture, a soft edge or an occlusion boundary that
  // position slides a little each frame, and after a few seconds the track sits
  // on different content entirely while still looking perfectly healthy.
  // Nothing downstream can see it happen — triangulation just quietly stops
  // describing a fixed point.
  //
  // Measured on a real room session before this existed: of 3447 tracks with
  // enough sightings to judge, 304 (8.8%) reproduced a single 3D point; the
  // rest reprojected at hundreds to tens of thousands of pixels. Their viewing
  // arcs looked *wide*, which was the tell — a triangulation with no answer
  // lands the point next to the camera, and the bearing to something a few
  // centimetres away swings through most of a circle as the phone moves.
  //
  // Tracking back and requiring the round trip to return to where it started is
  // the standard cure and the only one that costs no accuracy: a point that
  // drifted forward does not come back.
  // Where the live set is expected to land this frame, from the camera rotation
  // alone (see rotationWarp). Returns the seed positions in tracking pixels, or
  // null when there is nothing to predict from.
  //
  // This is the answer to the churn ceiling, and the ceiling is the thing that
  // decides whether a track ever lives long enough to be triangulated: measured,
  // retention is 97% below 50 px of inter-frame motion and collapses to ~20%
  // above 100 px, and those frames are ~15% of a normal walk. What LK is being
  // asked to do on them is find a displacement larger than its pyramid resolves,
  // starting from the assumption that the point did not move — and rotation is
  // most of that displacement, which the phone already knows and was not being
  // told.
  function predictInto(p1, Ht, w, h) {
    let sum = 0;
    let n = 0;
    for (let k = 0; k < live.length; k++) {
      const q = applyWarp(Ht, live[k].u, live[k].v);
      // Outside the picture by more than the search window: the prediction is
      // about pixels that are not there, so start from where the point was and
      // let the flow (and the edge test) decide.
      const usable = q && Number.isFinite(q[0]) && Number.isFinite(q[1])
        && q[0] > -TRACK_WARP_SLACK_PX && q[1] > -TRACK_WARP_SLACK_PX
        && q[0] < w + TRACK_WARP_SLACK_PX && q[1] < h + TRACK_WARP_SLACK_PX;
      const u = usable ? q[0] : live[k].u;
      const v = usable ? q[1] : live[k].v;
      p1.data32F[k * 2] = u;
      p1.data32F[k * 2 + 1] = v;
      if (usable) {
        sum += Math.hypot(u - live[k].u, v - live[k].v);
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  function follow(gray, w, h, Ht) {
    const p0 = pointsMat(live);
    const p1 = Ht ? pointsMat(live) : new cv.Mat();
    const pBack = new cv.Mat();
    const st = new cv.Mat();
    const stBack = new cv.Mat();
    const errM = new cv.Mat();
    const errBack = new cv.Mat();
    try {
      const levels = opts.levels ?? TRACK_LK_LEVELS;
      if (Ht) {
        predSum += predictInto(p1, Ht, w, h) * live.length;
        predN += live.length;
      }
      cv.calcOpticalFlowPyrLK(prevGray, gray, p0, p1, st, errM, winSize, levels,
        criteria, Ht ? cv.OPTFLOW_USE_INITIAL_FLOW : 0, LK_MIN_EIG);
      // The backward pass is deliberately *not* seeded, even though the seed for
      // it is sitting right there in `live`. Starting it at the answer it is
      // supposed to find independently is starting it at zero error: it would
      // return that seed and every track would pass the round trip, which is the
      // one check keeping drifted tracks out of the map.
      cv.calcOpticalFlowPyrLK(gray, prevGray, p1, pBack, stBack, errBack,
        winSize, levels, criteria);
      // Why points are lost, not just how many. A track set can churn itself to
      // nothing three entirely different ways — the flow gives up, the point
      // leaves the frame, or the round trip disagrees — and they call for
      // opposite fixes, so guessing between them is worse than useless.
      const kept = [];
      for (let k = 0; k < live.length; k++) {
        if (!st.data[k] || !stBack.data[k]) { drops.status++; continue; }
        const u = p1.data32F[k * 2];
        const v = p1.data32F[k * 2 + 1];
        if (!(u > TRACK_EDGE_PX && v > TRACK_EDGE_PX
          && u < w - TRACK_EDGE_PX && v < h - TRACK_EDGE_PX)) { drops.edge++; continue; }
        // Where the round trip landed against where it set off, judged against
        // how far the point moved getting there.
        const fb = Math.hypot(pBack.data32F[k * 2] - live[k].u,
          pBack.data32F[k * 2 + 1] - live[k].v);
        const moved = Math.hypot(u - live[k].u, v - live[k].v);
        const tol = Math.min(TRACK_FB_CAP_PX,
          Math.max(TRACK_FB_MIN_PX, moved * TRACK_FB_FRAC));
        movedSum += moved;
        movedN++;
        if (!(fb <= tol)) { drops.fb++; continue; }
        kept.push({ id: live[k].id, u, v });
      }
      live = kept;
    } finally {
      p0.delete();
      p1.delete();
      pBack.delete();
      st.delete();
      stBack.delete();
      errM.delete();
      errBack.delete();
    }
  }

  // Tracks die constantly — occlusion, leaving frame, drift — so without a
  // top-up the set decays to nothing within seconds of starting.
  //
  // `maxCorners` is a ceiling on the *live set*, not on what one top-up adds.
  // Asking goodFeaturesToTrack for the full count and appending all of it grows
  // the set past the cap — measured at 401 live points against a cap of 300,
  // and every one of them is paid for again in the next LK pass and in every
  // pose message.
  function reseed(gray, boxes, scale) {
    const room = maxCorners - live.length;
    if (room <= 0) return;
    const found = new cv.Mat();
    try {
      cv.goodFeaturesToTrack(gray, found, room, quality, minDist,
        buildMask(gray.cols, gray.rows, boxes, scale), 3, false, 0.04);
      for (let k = 0; k < found.rows && live.length < maxCorners; k++) {
        const u = found.data32F[k * 2];
        const v = found.data32F[k * 2 + 1];
        // Do not stack a second track on a point already being followed: two
        // ids on one feature is one measurement counted twice.
        let near = false;
        for (const p of live) {
          if (Math.hypot(p.u - u, p.v - v) < minDist) { near = true; break; }
        }
        if (!near) live.push({ id: nextId++, u, v });
      }
    } finally {
      found.delete();
    }
  }

  return {
    // `frame` is whatever the source understands; `boxes` are the tag bounding
    // boxes of this frame in full-frame pixels, straight off the detection
    // result. Returns points in full-frame pixels — the same discipline the
    // ROI scan applies to tag corners, so only one coordinate space ever leaves
    // this file — or null if the frame could not be read.
    //
    // `view` is optional: `{ q, K }`, the camera's orientation for this frame in
    // whatever frame the caller is consistent about, and the full-frame camera
    // model. Given one, the flow is seeded with where rotation alone says each
    // point went (see warpFor); without one it starts from where the point was,
    // which is what /client does — it has no rotation source.
    async track(frame, boxes = [], view = null) {
      const t0 = performance.now();
      const grabbed = await source.luma(frame, null);
      if (!grabbed) return null;
      const gray = grabbed.mat;
      const scale = grabbed.scale ?? 1;
      const w = gray.cols;
      const h = gray.rows;

      if (prevGray && (prevGray.cols !== w || prevGray.rows !== h)) {
        // A resolution switch without a reset: the old points describe a
        // different picture, so start over rather than follow them into it.
        reset();
      }
      drops = { status: 0, edge: 0, fb: 0 };
      movedSum = 0;
      movedN = 0;
      predSum = 0;
      predN = 0;
      const before = live.length;
      if (prevGray && live.length) {
        follow(gray, w, h, warpFor(prevView, view, grabbed));
      }
      const followed = live.length;
      if (cycles % reseedEvery === 0 || live.length < maxCorners / 3) {
        reseed(gray, boxes, scale);
      }
      cycles++;

      prevGray?.delete();
      prevGray = gray.clone();
      prevView = view;

      return {
        gen: generation,
        ms: performance.now() - t0,
        // What happened to the set this cycle: how many were carried in, how
        // many survived, why the rest did not, and how far they moved. Churn is
        // the thing that decides whether a track ever lives long enough to be
        // triangulated, and none of it is visible from the point list alone.
        churn: {
          in: before,
          kept: followed,
          seeded: live.length - followed,
          ...drops,
          moved: movedN ? Math.round(movedSum / movedN) : 0,
          pred: predN ? Math.round(predSum / predN) : null,
        },
        points: live.map((p) => ({
          id: p.id,
          u: p.u / scale + grabbed.rect.x,
          v: p.v / scale + grabbed.rect.y,
        })),
      };
    },

    reset,

    get generation() {
      return generation;
    },

    dispose() {
      prevGray?.delete();
      mask?.delete();
      prevGray = null;
      mask = null;
      live = [];
    },
  };
}
