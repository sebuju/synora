'use strict';

// The landmark map: natural image features, triangulated from tag-derived
// camera poses, used to keep a client localized after it walks out of tag view.
//
// Scope, because it is narrower than it looks and the narrowness is measured:
//
//   - **Within one tracking session only.** Correspondence comes from optical
//     flow on the client, which is free and reliable while a feature stays in
//     frame and means nothing once it does not. Re-identifying an anchor in a
//     *later* session was measured and failed outright: 0 usable fixes, with
//     ORB matching a median of 4 descriptors even when all 12 map anchors were
//     geometrically in shot. Nothing here is written to disk, restored, or
//     expected to survive a tracker reset. Do not build toward it.
//   - **Not a replacement for tags.** An anchor can only be *created* where a
//     tag supplied the camera pose. Tags remain the datum and the only metric
//     source, and information flows tags -> landmarks, one way, always.
//   - **Not object detection.** There is no model and no class list. The
//     failure was never the object class, it was using an object's silhouette
//     centre, which moves with viewpoint; a corner tracker only ever produces
//     real image features and the split-arc test throws out the rest.
//
// All the geometry is in public/landmark-math.js, shared with the offline probe
// page so that what is measured there is what runs here.

const path = require('path');
const {
  undistort, qualifyTrack, clusterAnchors, dist3, MIN_OBS,
} = require('./public/landmark-math.js');
const { se3FromRvecTvec, se3Invert } = require('./public/pose-math.js');

// Observations kept per track. The split-arc test wants the arc, not every
// sighting along it, and an unbounded ring would grow without limit on a track
// that never dies.
const OBS_RING = 60;
// Re-running qualification on every single sighting is pure waste — a track
// that failed at n sightings does not pass at n+1 — so it is attempted on a
// stride once the minimum is reached.
const QUALIFY_EVERY = 4;

// The sharp cliff, and the single most important number here. Measured:
//
//   anchors   median position   median orientation
//   4-5       1781 mm           56.63 deg
//   15-24       17 mm            0.34 deg
//   25+         36 mm            0.82 deg
//
// This does not degrade gracefully. Landmarks are bearing-only points and tend
// to be near-coplanar (one wall), which is the weak PnP configuration, and the
// 56 deg is that flip. Below the threshold the honest output is nothing at all:
// a missing pose falls back on predictPose and is recoverable, a confidently
// wrong one poisons every consumer downstream. There is no per-point mirror
// ambiguity to resolve either — a point carries no orientation, so nothing
// analogous to pickSolutions exists — which makes this count gate the whole of
// the mitigation.
//
// Do not loosen it to make the feature fire more often.
const MIN_ANCHORS_FOR_FIX = 15;

const RANSAC_ITERS = 500;
const RANSAC_PX = 5;
const RANSAC_CONF = 0.99;

// opencv.js, loaded only if a landmark solve is actually wanted. Three things
// make this less trivial than a require:
//
//   1. The export is a *thenable*, not a promise. `require(...).then(f)` works;
//      `.catch` on it is not a function, and that mistake looks exactly like a
//      hang at startup. (Measured on the vendored build: it loads in Node in
//      ~140 ms and solvePnPRansac runs in ~5 ms. It does not hang.)
//   2. Loading it installs a `process.on('unhandledRejection', abort)` and an
//      uncaughtException handler. This server installs neither, so leaving them
//      would quietly change how it dies. The delta is stripped below.
//   3. public/vendor/ is gitignored and optional. Its absence must leave the
//      feature inert, not throw — the same posture the client already takes.
let cv = null;
let cvLoading = null;
let cvFailed = false;

function ensureCv(log) {
  if (cv || cvFailed || cvLoading) return cv;
  const before = {
    rej: process.listeners('unhandledRejection').slice(),
    exc: process.listeners('uncaughtException').slice(),
  };
  const strip = () => {
    for (const l of process.listeners('unhandledRejection')) {
      if (!before.rej.includes(l)) process.removeListener('unhandledRejection', l);
    }
    for (const l of process.listeners('uncaughtException')) {
      if (!before.exc.includes(l)) process.removeListener('uncaughtException', l);
    }
  };
  try {
    const mod = require(path.join(__dirname, 'public', 'vendor', 'opencv.js'));
    strip();
    // The module must never be *adopted* as a promise value — only had its own
    // `then` called. Emscripten's thenable resolves with the Module itself, so
    // `Promise.resolve(mod)` (or resolving anything with it) hands the promise
    // machinery a thenable that resolves to a thenable that resolves to itself,
    // and it spins forever. Measured: a clean hang, no error, no output. That
    // is almost certainly the "opencv.js hangs in Node" this project recorded.
    cvLoading = new Promise((done) => {
      mod.then(() => {
        strip();
        cv = mod;
        cvLoading = null;
        log('Landmarks: opencv.js loaded');
        done();
      });
    });
  } catch (err) {
    cvFailed = true;
    strip();
    log(`Landmarks disabled: ${err.message} (run npm run fetch-vendor)`);
  }
  return null;
}

function createLandmarks({ log = () => {} } = {}) {
  // clientId -> { gen, tracks: Map(trackId -> obs[]), anchors: Map(trackId -> {P,n,span,err}) }
  const clients = new Map();
  const stats = { observed: 0, qualified: 0, solved: 0, refused: 0, rej: {} };

  const bump = (why) => { stats.rej[why] = (stats.rej[why] ?? 0) + 1; };

  function stateFor(clientId, gen) {
    let s = clients.get(clientId);
    if (!s) {
      s = { gen, tracks: new Map(), anchors: new Map() };
      clients.set(clientId, s);
    }
    // Track ids only mean anything within one tracker generation. A reset the
    // server does not hear about is the worst failure mode available here: it
    // does not lose a landmark, it invents one, by fusing observations of two
    // different physical points under one id.
    if (s.gen !== gen) {
      log(`Landmarks: client ${clientId} tracker generation ${s.gen} -> ${gen}, `
        + `dropping ${s.anchors.size} anchor(s)`);
      s.gen = gen;
      s.tracks.clear();
      s.anchors.clear();
    }
    return s;
  }

  function modelOf(intr) {
    if (!intr || !(intr.fx > 0) || !(intr.fy > 0)) return null;
    return {
      fx: intr.fx, fy: intr.fy, cx: intr.cx, cy: intr.cy, dist: intr.dist ?? null,
    };
  }

  return {
    // Called only where a tag-derived camera pose exists — an anchor can be
    // created nowhere else. `camPose` must be the *raw* fix, never a smoothed
    // one: feeding a filter's output into the map that produced it makes the
    // two agree with each other instead of with the room, which is the same
    // reason the tag survey extends and refines on the raw fix.
    observe(clientId, points, gen, camPose, intr) {
      if (!points?.length || !camPose || gen == null) return 0;
      const K = modelOf(intr);
      if (!K) { bump('no-intrinsics'); return 0; }
      const s = stateFor(clientId, gen);
      let added = 0;

      for (const p of points) {
        if (s.anchors.has(p.id)) continue;   // nothing revalidates a qualified anchor
        let obs = s.tracks.get(p.id);
        if (!obs) { obs = []; s.tracks.set(p.id, obs); }
        // Undistort here, once, so everything downstream — triangulation,
        // reprojection, the solve — works in one ideal-pinhole space.
        const [u, v] = undistort(p.u, p.v, K);
        obs.push({ u, v, K, pose: camPose });
        if (obs.length > OBS_RING) obs.shift();
        stats.observed++;

        if (obs.length < MIN_OBS || (obs.length - MIN_OBS) % QUALIFY_EVERY !== 0) continue;
        const j = qualifyTrack(obs);
        if (!j.ok) { bump(j.reason); continue; }
        s.anchors.set(p.id, { P: j.P, n: j.n, span: j.span, err: j.err });
        stats.qualified++;
        added++;
      }
      return added;
    },

    // Called only where no usable tag observation exists. Returns the camera's
    // room pose, or null — and null is the common, correct answer.
    solve(clientId, points, gen, intr) {
      if (!points?.length || gen == null) return null;
      const K = modelOf(intr);
      if (!K) return null;
      const s = clients.get(clientId);
      if (!s || s.gen !== gen) return null;
      if (s.anchors.size < MIN_ANCHORS_FOR_FIX) return null;

      const objs = [];
      const imgs = [];
      for (const p of points) {
        const a = s.anchors.get(p.id);
        if (!a) continue;
        const [u, v] = undistort(p.u, p.v, K);
        objs.push(a.P[0], a.P[1], a.P[2]);
        imgs.push(u, v);
      }
      const n = imgs.length / 2;
      if (n < MIN_ANCHORS_FOR_FIX) {
        stats.refused++;
        return null;
      }
      if (!ensureCv(log)) return null;

      // Already undistorted, so the solve is told the camera is ideal.
      const objMat = cv.matFromArray(n, 3, cv.CV_64F, objs);
      const imgMat = cv.matFromArray(n, 2, cv.CV_64F, imgs);
      const KM = cv.matFromArray(3, 3, cv.CV_64F, [K.fx, 0, K.cx, 0, K.fy, K.cy, 0, 0, 1]);
      const D = cv.matFromArray(1, 5, cv.CV_64F, [0, 0, 0, 0, 0]);
      const rvec = new cv.Mat();
      const tvec = new cv.Mat();
      const inl = new cv.Mat();
      try {
        const ok = cv.solvePnPRansac(objMat, imgMat, KM, D, rvec, tvec, false,
          RANSAC_ITERS, RANSAC_PX, RANSAC_CONF, inl, cv.SOLVEPNP_ITERATIVE);
        if (!ok) { stats.refused++; return null; }
        // solvePnP gives room -> camera; the camera's own room pose is its
        // inverse.
        const pose = se3Invert(se3FromRvecTvec([...rvec.data64F], [...tvec.data64F]));
        if (!pose.p.every(Number.isFinite)) { stats.refused++; return null; }
        stats.solved++;
        return { pose, n, inliers: inl.rows };
      } catch {
        stats.refused++;
        return null;
      } finally {
        objMat.delete();
        imgMat.delete();
        KM.delete();
        D.delete();
        rvec.delete();
        tvec.delete();
        inl.delete();
      }
    },

    // Distinct anchors, not raw tracks: several tracks routinely sit on one
    // physical feature and a raw count overstates what the room actually has.
    count(clientId) {
      const s = clients.get(clientId);
      if (!s) return 0;
      return clusterAnchors([...s.anchors.values()]).length;
    },

    // For the viewer. Deliberately the merged set, for the same reason.
    forClient(clientId) {
      const s = clients.get(clientId);
      if (!s) return [];
      return clusterAnchors([...s.anchors.values()]).map((c) => ({
        p: c[0].P, n: c[0].n, span: Math.round(c[0].span), merged: c.length,
      }));
    },

    // A client disconnected, the marker size changed (every anchor is in the
    // old metric scale), or the anchor went (the room frame is redefined).
    reset(clientId) {
      if (clientId === undefined) clients.clear();
      else clients.delete(clientId);
    },

    stats() {
      return {
        ...stats,
        clients: [...clients.entries()].map(([id, s]) => ({
          clientId: id, gen: s.gen, tracks: s.tracks.size, anchors: s.anchors.size,
        })),
      };
    },

    // Replay needs this to answer "would it have solved with fewer anchors" —
    // the count gate is the thing most worth testing and the hardest to reach
    // from outside.
    _anchorsFor(clientId) {
      return clients.get(clientId)?.anchors ?? new Map();
    },
  };
}

module.exports = {
  createLandmarks, MIN_ANCHORS_FOR_FIX, OBS_RING, QUALIFY_EVERY, dist3,
  // The live path tolerates the first few solves returning null while the wasm
  // compiles; a replay wants to wait for it rather than silently measure zero.
  loadCv(log = () => {}) {
    ensureCv(log);
    // Resolves with nothing on purpose: see ensureCv — handing the emscripten
    // Module to the promise machinery hangs it.
    return cvLoading ?? Promise.resolve();
  },
};
