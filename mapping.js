'use strict';

// Room mapping: consumes posed keyframes, feeds the depth worker, and owns
// the voxel occupancy grid.

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { createFloorplan } = require('./floorplan.js');
const { integrateGrid } = require('./surface.js');

const VOXEL_SIZE_M = 0.075;
const KEY_OFFSET = 512;          // must match depth-worker.js packing

// Occupancy is log-odds, not hit/miss counters. Counters were one-way: a cell
// that a single bad keyframe painted needed several times as many clean
// see-throughs to lose again, so the map only ever grew and a bad minute was
// permanent. Log-odds saturates in both directions, so evidence stays
// reversible and a surface that later frames disagree with fades on its own.
// A hit only confirms a cell when it comes from somewhere new. Standing still
// and staring at noise otherwise accumulates evidence exactly as if you had
// walked around it — the single biggest way false geometry becomes solid. A
// repeat from the same viewpoint still counts for something (it keeps a real
// surface from decaying while you stand there) but cannot promote on its own.
const L_HIT = 0.9;               // a depth sample from a viewpoint not seen before
const L_HIT_REPEAT = 0.15;       // the same cell from the same viewpoint again
const L_NEAR = 0.25;             // face neighbor of one — a vote, not a hit
const L_MISS = -0.45;            // a ray passed through on its way to a surface
const L_MIN = -3;
const L_MAX = 4;
// Hysteresis: without it a cell hovering at the threshold flickers into every
// delta flush, and the wall fit downstream chases the flicker.
const L_OCCUPY = 1.8;            // 2 direct hits, or 1 hit and 4 shell votes
const L_RELEASE = 0.5;
const DELTA_FLUSH_MS = 500;
const SNAPSHOT_CHUNK = 5000;
// Below the floor with nothing to show, a cell is just carved air — forget it
// rather than carry a key per cubic decimetre of the room forever.
const FORGET_BELOW = L_MIN + 0.01;

// --- Wall layer ------------------------------------------------------------
// The map's real subject is the room shell, not the furniture in it. A column
// of occupied voxels with wall-like vertical extent is a wall sample; RANSAC
// over the floor plan fits line segments through those columns, and the
// segments stream to the viewer as their own layer. Furniture rarely spans
// the height gate, so it stays in the raw voxels and out of the walls.
const WALL_MIN_HEIGHT_M = 1.0;   // vertical span before a column reads as wall
const WALL_FILL_MIN = 0.45;      // occupied fraction of that span
const WALL_INLIER_M = 0.12;      // point-to-line distance counted as on-wall
const WALL_GAP_M = 0.5;          // split a fitted line into walls at gaps
// These now gate only the off-axis leftover pass over 5 cm evidence cells, not
// 7.5 cm voxel columns: a real wall gives ~20 cells per metre there, so the
// bar can be well above what the rectilinear pass already handles.
const WALL_MIN_LEN_M = 1.2;
const WALL_MIN_COLS = 12;
const WALL_MAX_COUNT = 16;
const WALL_TRIALS = 120;
const WALL_RECOMPUTE_MS = 1500;
// Columns per metre along the segment. A wall is a solid row of columns; a
// line drawn through scattered clutter is not, however many points it grazes.
// At 7.5 cm cells a filled wall gives ~13/m, so this only rejects the sparse.
const WALL_MIN_DENSITY = 8;
// A wall is thicker than one column of voxels — dilation, depth wobble and a
// drifting depth scale all smear it across a few layers. Clearing only the
// fitted columns leaves the neighbouring layer in the pool, and the next
// iteration dutifully fits a second wall 10 cm behind the first. Buildings do
// not have those, so the slab around an accepted segment goes with it, and
// any collinear pair that survives anyway is merged afterwards.
const WALL_SLAB_M = 0.25;
const WALL_MERGE_ANGLE_DEG = 12;
// Candidate pairs are drawn from the same neighborhood. Sampling globally
// makes room-crossing diagonals as likely as real walls, and a diagonal that
// wins takes its inliers out of the pool — shredding the walls it crossed.
const WALL_PAIR_MAX_M = 3;

// Fold segments that describe the same piece of wall into one. Two fits can
// still land on the same plane from different neighborhoods, and a room with
// two parallel walls a handful of centimetres apart is not a room.
function mergeWallSegments(segs) {
  const dirOf = (s) => {
    const dx = s.b[0] - s.a[0];
    const dz = s.b[1] - s.a[1];
    const len = Math.hypot(dx, dz) || 1;
    return [dx / len, dz / len, len];
  };
  const cosLimit = Math.cos(WALL_MERGE_ANGLE_DEG * Math.PI / 180);
  // Longest first: the long segment sets the plane, short ones fold into it.
  const order = segs.slice().sort((p, q) => dirOf(q)[2] - dirOf(p)[2]);
  const merged = [];
  for (const s of order) {
    const [sx, sz] = dirOf(s);
    const host = merged.find((m) => {
      const [mx, mz] = dirOf(m);
      if (Math.abs(mx * sx + mz * sz) < cosLimit) return false;   // antiparallel counts
      // Both endpoints inside the host's slab, and the projections must meet.
      const ts = [];
      for (const pt of [s.a, s.b]) {
        const dx = pt[0] - m.a[0];
        const dz = pt[1] - m.a[1];
        if (Math.abs(dx * mz - dz * mx) > WALL_SLAB_M) return false;
        ts.push(dx * mx + dz * mz);
      }
      const mLen = dirOf(m)[2];
      return Math.min(...ts) <= mLen + WALL_GAP_M && Math.max(...ts) >= -WALL_GAP_M;
    });
    if (!host) {
      merged.push({ ...s, a: [...s.a], b: [...s.b] });
      continue;
    }
    // Extend the host along its own direction and average the heights by how
    // many columns each side actually saw.
    const [mx, mz, mLen] = dirOf(host);
    let lo = 0;
    let hi = mLen;
    for (const pt of [s.a, s.b]) {
      const t = (pt[0] - host.a[0]) * mx + (pt[1] - host.a[1]) * mz;
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    const w = host.cols + s.cols;
    const rnd = (v) => Math.round(v * 100) / 100;
    const ax = host.a[0];
    const az = host.a[1];
    host.a = [rnd(ax + mx * lo), rnd(az + mz * lo)];
    host.b = [rnd(ax + mx * hi), rnd(az + mz * hi)];
    host.y0 = rnd((host.y0 * host.cols + s.y0 * s.cols) / w);
    host.y1 = rnd((host.y1 * host.cols + s.y1 * s.cols) / w);
    host.cols = w;
  }
  return merged;
}

function unpack(key) {
  return [
    (((key >> 20) & 0x3ff) - KEY_OFFSET + 0.5) * VOXEL_SIZE_M,
    (((key >> 10) & 0x3ff) - KEY_OFFSET + 0.5) * VOXEL_SIZE_M,
    ((key & 0x3ff) - KEY_OFFSET + 0.5) * VOXEL_SIZE_M,
  ].map((v) => Math.round(v * 1000) / 1000);
}

function createMapping({
  modelPath, metric, survey, depthCal, log, onDelta, onSnapshot, onWalls, onCalState,
}) {
  let worker = null;
  let busy = false;
  let nextId = 1;
  let inFlight = null;             // the job the worker is chewing on
  // One pending keyframe per client: a slow inference drops stale frames
  // rather than queueing them.
  const pending = new Map();

  // Surface evidence for the floor plan. Separate from the voxel grid on
  // purpose: the voxels are what the room looked like, this is what the walls
  // are, and only one of the two is worth fitting geometry to.
  const floorplan = createFloorplan();

  const logOdds = new Map();       // packed key -> accumulated log-odds
  const seenFrom = new Map();      // packed key -> viewpoint id that last hit it
  const occupied = new Set();      // packed keys shown to the viewer
  let deltaAdded = [];
  let deltaRemoved = [];
  let deltaTimer = null;
  let inferCount = 0;
  // Debug view: the viewer can ask to see only the voxels of the last N
  // keyframes (raw hits, no threshold) instead of the accumulated map.
  const RECENT_CAP = 10;
  const recent = [];               // [{ voxels: Int32Array }]
  let viewMode = 'all';            // 'none' | 'all' | 1..RECENT_CAP
  let walls = [];
  let wallsJson = '[]';
  let wallTimer = null;

  const enabled = fs.existsSync(modelPath);
  if (enabled) {
    worker = new Worker(path.join(__dirname, 'depth-worker.js'), {
      workerData: { modelPath, metric: !!metric },
    });
    worker.on('message', onWorkerDone);
    worker.on('error', (err) => log(`Depth worker died: ${err.message}`));
    log(`Mapping: ${metric ? 'metric' : 'relative'} depth model (${path.basename(modelPath)})`);
  }

  function scheduleFlush() {
    if (viewMode !== 'all') return;   // latest-N mode pushes full snapshots
    if (deltaTimer || (!deltaAdded.length && !deltaRemoved.length)) return;
    deltaTimer = setTimeout(() => {
      deltaTimer = null;
      const added = deltaAdded;
      const removed = deltaRemoved;
      deltaAdded = [];
      deltaRemoved = [];
      onDelta({ voxelSizeM: VOXEL_SIZE_M, added: added.map(unpack), removed: removed.map(unpack) });
    }, DELTA_FLUSH_MS);
  }

  // Wall extraction runs debounced off occupancy changes — a full pass over
  // `occupied` plus the RANSAC is a few ms at room-scale voxel counts, far
  // too cheap to bother doing incrementally.
  function scheduleWalls() {
    if (wallTimer || !onWalls) return;
    wallTimer = setTimeout(() => {
      wallTimer = null;
      walls = extractWalls();
      const json = JSON.stringify(walls);
      if (json !== wallsJson) {
        wallsJson = json;
        onWalls(walls);
      }
    }, WALL_RECOMPUTE_MS);
  }

  // The rectilinear structure comes from the surface-evidence grid; this pass
  // only handles what the room's own axes could not explain. Fitting the
  // occupancy grid was the old route and it fitted the depth error, not the
  // room — occupancy is several cells wide wherever the depth is a few percent
  // off, which is everywhere.
  function extractWalls() {
    const { segments, leftovers } = floorplan.fit();
    const pts = leftovers.map((c) => ({
      x: c.x, z: c.z, y0: c.yLo, y1: c.yHi,
    }));

    // Inliers of a line, ordered along it and split at gaps: a wall is one
    // unbroken run, so this is also the unit everything downstream scores.
    function runsAlong(points, ox, oz, ux, uz) {
      const seq = points
        .filter((p) => Math.abs((p.x - ox) * uz - (p.z - oz) * ux) <= WALL_INLIER_M)
        .map((p) => ({ p, t: (p.x - ox) * ux + (p.z - oz) * uz }))
        .sort((a, b) => a.t - b.t);
      const runs = [];
      let run = null;
      for (const e of seq) {
        if (run && e.t - run[run.length - 1].t <= WALL_GAP_M) run.push(e);
        else runs.push(run = [e]);
      }
      return runs;
    }

    // Runs are scored, never raw inlier counts. Counting every point an
    // infinite line touches is what let a diagonal through the middle of the
    // room outscore an actual wall.
    const runScore = (r) => {
      if (r.length < WALL_MIN_COLS) return 0;
      const span = r[r.length - 1].t - r[0].t;
      if (span < WALL_MIN_LEN_M || r.length / span < WALL_MIN_DENSITY) return 0;
      return r.length;
    };
    const bestRun = (runs) => runs.reduce(
      (b, r) => (runScore(r) > runScore(b || []) ? r : b), null);

    const out = [];
    const rnd = (v) => Math.round(v * 100) / 100;
    let pool = pts;
    while (pool.length >= WALL_MIN_COLS && out.length < WALL_MAX_COUNT) {
      let best = null;
      for (let t = 0; t < WALL_TRIALS; t++) {
        const p1 = pool[(Math.random() * pool.length) | 0];
        const p2 = pool[(Math.random() * pool.length) | 0];
        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const len = Math.hypot(dx, dz);
        if (len < WALL_MIN_LEN_M / 2 || len > WALL_PAIR_MAX_M) continue;
        const r = bestRun(runsAlong(pool, p1.x, p1.z, dx / len, dz / len));
        if (r && runScore(r) > runScore(best || [])) best = r;
      }
      if (!best) break;

      // Total-least-squares refit over the winning run only, then re-collect
      // along the refined line: the seed pair sets the direction from two
      // noisy columns, and every column of the run has a say in correcting it.
      const mx = best.reduce((a, e) => a + e.p.x, 0) / best.length;
      const mz = best.reduce((a, e) => a + e.p.z, 0) / best.length;
      let sxx = 0;
      let szz = 0;
      let sxz = 0;
      for (const e of best) {
        sxx += (e.p.x - mx) ** 2;
        szz += (e.p.z - mz) ** 2;
        sxz += (e.p.x - mx) * (e.p.z - mz);
      }
      const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
      const ux = Math.cos(theta);
      const uz = Math.sin(theta);
      const refined = bestRun(runsAlong(pool, mx, mz, ux, uz)) || best;

      const t0 = refined[0].t;
      const t1 = refined[refined.length - 1].t;
      if (runScore(refined)) {
        // Percentile ends vertically: one noisy column must not stretch the
        // wall to its own height.
        const y0s = refined.map((e) => e.p.y0).sort((a, b) => a - b);
        const y1s = refined.map((e) => e.p.y1).sort((a, b) => a - b);
        out.push({
          a: [rnd(mx + ux * t0), rnd(mz + uz * t0)],
          b: [rnd(mx + ux * t1), rnd(mz + uz * t1)],
          y0: rnd(y0s[Math.floor(y0s.length * 0.2)]),
          y1: rnd(y1s[Math.floor(y1s.length * 0.8)]),
          cols: refined.length,
        });
      }
      // The accepted segment's slab leaves the pool — its own columns plus the
      // layers smeared either side of it, which would otherwise come back as a
      // parallel wall a few centimetres away. Only within the segment's own
      // extent, though: the old pass dropped everything on the infinite line
      // and shredded whatever walls crossed it. Progress is guaranteed, since
      // the run's own columns are always inside the slab.
      pool = pool.filter((p) => {
        const t = (p.x - mx) * ux + (p.z - mz) * uz;
        const d = Math.abs((p.x - mx) * uz - (p.z - mz) * ux);
        return !(d <= WALL_SLAB_M && t >= t0 - WALL_GAP_M && t <= t1 + WALL_GAP_M);
      });
    }
    return mergeWallSegments(segments.concat(out));
  }

  let rejectCount = 0;

  // A thin survey is the failure that looks like a depth failure. With one
  // tag in the map every keyframe is posed by a single planar PnP — mirror
  // ambiguity, no second tag to check it against, and the whole cloud swings
  // with that tag's angular error. A single tag also cannot observe the depth
  // model's shift, so its calibration is stuck on a bare scale correction.
  // The map is never better than the survey under it; say so.
  const MIN_HEALTHY_MARKERS = 3;
  const SPARSE_WARN_MS = 60000;
  let lastSparseWarn = 0;

  function warnSparseSurvey() {
    const n = survey.getMarkerMap().markers.length;
    if (n >= MIN_HEALTHY_MARKERS) return;
    const now = Date.now();
    if (now - lastSparseWarn < SPARSE_WARN_MS) return;
    lastSparseWarn = now;
    log(`Mapping: the marker map has ${n} tag${n === 1 ? '' : 's'}. Poses and depth ` +
      'scale are both unchecked below three — put up more printed tags, on ' +
      'more than one wall, and let the survey promote them.');
  }

  // Same throttle, different failure: the camera has never been swept, so
  // there is no honest way to turn its depth map into metres.
  const UNCALIBRATED_WARN_MS = 30000;
  const lastUncalWarn = new Map();

  let mirrorDrops = 0;

  function warnMirror(clientId, jump) {
    if (++mirrorDrops % 10 === 1) {
      log(`Mapping: keyframe from client ${clientId} refused — its tag fix is ` +
        `${jump.toFixed(2)} m from the live track (mirrored PnP solution). ` +
        `${mirrorDrops} total.`);
    }
  }

  function warnUncalibrated(key) {
    const now = Date.now();
    if (now - (lastUncalWarn.get(key) || 0) < UNCALIBRATED_WARN_MS) return;
    lastUncalWarn.set(key, now);
    log(`Mapping: no depth calibration for ${key} — keyframes ignored. ` +
      'Open /depth-calibrate on that device and sweep a tag from near to far.');
  }

  function onWorkerDone(res) {
    busy = false;
    const job = inFlight;
    inFlight = null;
    if (res.error) {
      log(`Depth inference failed: ${res.error}`);
    } else if (res.sampled) {
      // Calibration sweep: the frame's only product is its tag samples.
      depthCal.addSamples(job.key, res.samples);
      onCalState?.(job.clientId, job.deviceId);
    } else if (res.rejected) {
      // Refusing a keyframe we cannot place honestly beats painting garbage;
      // logged sparsely so a systematic problem is visible without spam.
      if (++rejectCount % 10 === 1) {
        log(`Mapping: keyframe rejected (${res.rejected}) — ${rejectCount} total.`);
      }
    } else {
      const changed = integrate(res.clientId, res);
      const fp = floorplan.stats();
      // The tag residual is the calibration's report card in live use: it
      // should sit near the residual the sweep froze at.
      log(`Mapping: client ${res.clientId} keyframe #${inferCount} -> ` +
        `${res.voxels.length} hits, ${changed} changed, ${occupied.size} occupied, ` +
        `tags off ${(res.residual * 100).toFixed(0)}%, ` +
        `kept ${Math.round(100 * res.kept / Math.max(1, res.considered))}% ` +
        `(edges ${Math.round(100 * res.keptEdge / Math.max(1, res.considered))}%), ` +
        `plan ${fp.cells} cells, floor ${fp.floorY} m`);
    }
    // Serve whichever client has the freshest waiting keyframe.
    const next = pending.entries().next().value;
    if (next) {
      pending.delete(next[0]);
      dispatch(next[1]);
    }
  }

  // Fold one frame's surfaces into the map, whatever produced them: the depth
  // model's keyframes and an XR client's ARCore depth arrive here identically.
  function integrate(clientId, res) {
    let changed = 0;
    const bump = (key, delta) => {
      const l = Math.min(L_MAX, Math.max(L_MIN, (logOdds.get(key) || 0) + delta));
      const was = occupied.has(key);
      // Hysteresis band: outside it the state follows the evidence, inside it
      // the cell keeps whatever it already was.
      if (!was && l >= L_OCCUPY) {
        occupied.add(key);
        deltaAdded.push(key);
        changed++;
      } else if (was && l < L_RELEASE) {
        occupied.delete(key);
        deltaRemoved.push(key);
        changed++;
      }
      if (l <= FORGET_BELOW && !occupied.has(key)) {
        logOdds.delete(key);
        seenFrom.delete(key);
      }
      else logOdds.set(key, l);
    };
    floorplan.addPoints(res.surf, res.viewpoint);
    for (const key of res.voxels) {
      const fresh = seenFrom.get(key) !== res.viewpoint;
      seenFrom.set(key, res.viewpoint);
      bump(key, fresh ? L_HIT : L_HIT_REPEAT);
    }
    for (const key of res.dilated || []) bump(key, L_NEAR);
    for (const key of res.empties || []) bump(key, L_MISS);

    recent.push({ voxels: res.voxels });
    if (recent.length > RECENT_CAP) recent.shift();
    inferCount++;
    if (changed) scheduleFlush();
    // Walls follow the evidence, which every accepted frame adds to — even one
    // that changed no voxel at all.
    scheduleWalls();
    if (viewMode !== 'all') onSnapshot?.(snapshotParts());
    return changed;
  }

  function dispatch(job) {
    busy = true;
    inFlight = job;
    worker.postMessage(job, [job.jpeg.buffer]);
  }

  return {
    enabled,

    // A KFR1 keyframe from a client. header: { t, w, h, intrinsics, tags }.
    handleKeyframe(clientId, deviceId, header, jpegBuf) {
      if (!enabled) return;
      const key = depthCal.keyFor(deviceId, header.w, header.h);
      depthCal.noteKey(deviceId, key);
      const sweeping = depthCal.isCalibrating(deviceId);
      if (!sweeping && viewMode === 'none') return;
      // The sweep needs the depth model and the tags, nothing else: no room
      // pose, no map, and it runs whether or not the viewer is watching.
      const fit = sweeping ? null : depthCal.frozen(key);
      let pose = null;
      if (!sweeping) {
        if (!fit) {
          warnUncalibrated(key);
          return;                // refusing beats inventing a scale per frame
        }
        warnSparseSurvey();
        const fix = survey.locate(header.tags, clientId);
        pose = fix.pose;
        if (!pose) {
          // A fix the client's own live track disagrees with is usually the
          // mirrored PnP solution, and painting it puts the frame's whole
          // cloud on the far side of the wall it was looking at.
          if (fix.jump !== undefined) warnMirror(clientId, fix.jump);
          return;
        }
      }
      const job = {
        id: nextId++,
        clientId,
        deviceId,
        key,
        mode: sweeping ? 'sample' : 'map',
        fit,
        jpeg: jpegBuf,
        w: header.w,
        h: header.h,
        intrinsics: header.intrinsics,
        pose,
        tags: header.tags,
        voxelSizeM: VOXEL_SIZE_M,
      };
      if (busy) pending.set(clientId, job);   // newer frame replaces older
      else dispatch(job);
    },

    // A depth frame from an XR client: ARCore's own depth, already unprojected
    // to camera-frame points, so none of the model, the calibration or the
    // upright rotation applies. Everything downstream of the points is shared
    // with the model path.
    handleXrFrame(clientId, header, points) {
      if (!enabled && !onWalls) return;
      const pose = survey.xrPoseOf(clientId, header.xr);
      if (!pose) return;              // not aligned to the room yet
      const { gw, gh } = header;
      const n = gw * gh;
      const cx = new Float32Array(n);
      const cy = new Float32Array(n);
      const cz = new Float32Array(n);
      const ok = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const x = points[i * 3];
        if (Number.isNaN(x)) continue;
        cx[i] = x;
        cy[i] = points[i * 3 + 1];
        cz[i] = points[i * 3 + 2];
        ok[i] = 1;
      }
      const res = integrateGrid({ cx, cy, cz, ok, gw, gh, pose, voxelSizeM: VOXEL_SIZE_M });
      const changed = integrate(clientId, res);
      const fp = floorplan.stats();
      log(`Mapping: client ${clientId} XR depth #${inferCount} -> ` +
        `${res.voxels.length} hits, ${changed} changed, ${occupied.size} occupied, ` +
        `kept ${Math.round(100 * res.kept / Math.max(1, res.considered))}%, ` +
        `plan ${fp.cells} cells, floor ${fp.floorY} m`);
    },

    snapshotParts,

    getWalls() {
      return walls;
    },

    // Switch between the accumulated map, a latest-N-keyframes debug view,
    // and off entirely; returns the snapshot for the new view.
    setViewMode(mode) {
      viewMode = mode === 'all' || mode === 'none' ? mode
        : Math.max(1, Math.min(RECENT_CAP, Number(mode) || 1));
      return snapshotParts();
    },

    // Mapping wants keyframes at all — lets the server tell clients to stop
    // producing them (JPEG encode costs the client real CPU every second).
    isActive() {
      return enabled && viewMode !== 'none';
    },

    // Drop the whole voxel map (keeps per-client depth-shift estimates —
    // those describe the clients, not the room).
    clear() {
      logOdds.clear();
      seenFrom.clear();
      occupied.clear();
      floorplan.clear();
      recent.length = 0;
      deltaAdded = [];
      deltaRemoved = [];
      clearTimeout(wallTimer);
      wallTimer = null;
      walls = [];
      wallsJson = '[]';
      onWalls?.([]);
      log('Voxel map cleared');
      return snapshotParts();
    },
  };

  // Full map for a fresh viewer (or after a view change), chunked. Which keys
  // depends on the active view mode.
  function snapshotParts() {
    let keys;
    if (viewMode === 'none') {
      keys = [];
    } else if (viewMode === 'all') {
      keys = [...occupied];
    } else {
      const union = new Set();
      for (const kf of recent.slice(-viewMode)) {
        for (const k of kf.voxels) union.add(k);
      }
      keys = [...union];
    }
    const parts = Math.max(1, Math.ceil(keys.length / SNAPSHOT_CHUNK));
    const out = [];
    for (let i = 0; i < parts; i++) {
      out.push({
        type: 'map-snapshot',
        voxelSizeM: VOXEL_SIZE_M,
        part: i + 1,
        parts,
        voxels: keys.slice(i * SNAPSHOT_CHUNK, (i + 1) * SNAPSHOT_CHUNK).map(unpack),
      });
    }
    return out;
  }
}

module.exports = { createMapping, mergeWallSegments };
