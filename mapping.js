'use strict';

// Room mapping: consumes posed keyframes, feeds the depth worker, and owns
// the voxel occupancy grid. A voxel becomes occupied once two different
// keyframes have hit it — one monocular depth map hallucinating a surface
// should not paint the room.

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const VOXEL_SIZE_M = 0.075;
const KEY_OFFSET = 512;          // must match depth-worker.js packing
// First hit shows immediately — with the metric model and the per-frame
// calibration guards, a keyframe that got this far is trustworthy, and
// waiting for a second corroborating frame made the map feel dead. Carving
// still removes what later frames see through.
const OCCUPIED_AT_HITS = 1;
// A voxel seen through (free-space votes from ray carving) far more often
// than it is hit is a depth hallucination, not a surface — dismiss it.
const MISS_TOLERANCE = 4;        // occupied while misses <= hits * this
const DELTA_FLUSH_MS = 500;
const SNAPSHOT_CHUNK = 5000;

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
const WALL_MIN_LEN_M = 0.6;
const WALL_MIN_COLS = 6;
const WALL_MAX_COUNT = 16;
const WALL_TRIALS = 48;
const WALL_RECOMPUTE_MS = 1500;

function unpack(key) {
  return [
    (((key >> 20) & 0x3ff) - KEY_OFFSET + 0.5) * VOXEL_SIZE_M,
    (((key >> 10) & 0x3ff) - KEY_OFFSET + 0.5) * VOXEL_SIZE_M,
    ((key & 0x3ff) - KEY_OFFSET + 0.5) * VOXEL_SIZE_M,
  ].map((v) => Math.round(v * 1000) / 1000);
}

function createMapping({ modelPath, metric, survey, log, onDelta, onSnapshot, onWalls }) {
  let worker = null;
  let busy = false;
  let nextId = 1;
  // One pending keyframe per client: a slow inference drops stale frames
  // rather than queueing them.
  const pending = new Map();
  const shiftByClient = new Map();  // per-client EMA of the fitted depth shift

  const hits = new Map();          // packed key -> surface hit count
  const misses = new Map();        // packed key -> seen-through count
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

  function extractWalls() {
    // Column statistics over the accumulated map.
    const cols = new Map();          // (vx<<10|vz) -> { minY, maxY, count }
    for (const key of occupied) {
      const vy = (key >> 10) & 0x3ff;
      const ck = ((key >> 20) & 0x3ff) << 10 | (key & 0x3ff);
      const c = cols.get(ck);
      if (!c) {
        cols.set(ck, { minY: vy, maxY: vy, count: 1 });
      } else {
        if (vy < c.minY) c.minY = vy;
        if (vy > c.maxY) c.maxY = vy;
        c.count++;
      }
    }
    const pts = [];
    const minSpanCells = WALL_MIN_HEIGHT_M / VOXEL_SIZE_M;
    for (const [ck, c] of cols) {
      const spanCells = c.maxY - c.minY + 1;
      if (spanCells < minSpanCells || c.count < spanCells * WALL_FILL_MIN) continue;
      pts.push({
        x: ((ck >> 10) - KEY_OFFSET + 0.5) * VOXEL_SIZE_M,
        z: ((ck & 0x3ff) - KEY_OFFSET + 0.5) * VOXEL_SIZE_M,
        y0: (c.minY - KEY_OFFSET) * VOXEL_SIZE_M,
        y1: (c.maxY - KEY_OFFSET + 1) * VOXEL_SIZE_M,
      });
    }

    const out = [];
    let pool = pts;
    while (pool.length >= WALL_MIN_COLS && out.length < WALL_MAX_COUNT) {
      // RANSAC: at these point counts the best of a few dozen random pairs
      // is reliably the dominant remaining wall.
      let best = null;
      for (let t = 0; t < WALL_TRIALS; t++) {
        const p1 = pool[(Math.random() * pool.length) | 0];
        const p2 = pool[(Math.random() * pool.length) | 0];
        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const len = Math.hypot(dx, dz);
        if (len < WALL_MIN_LEN_M / 2) continue;
        const ux = dx / len;
        const uz = dz / len;
        const inliers = pool.filter((p) =>
          Math.abs((p.x - p1.x) * uz - (p.z - p1.z) * ux) <= WALL_INLIER_M);
        if (!best || inliers.length > best.length) best = inliers;
      }
      if (!best || best.length < WALL_MIN_COLS) break;

      // Total-least-squares refit of the winning line: principal direction
      // of the inlier scatter.
      const mx = best.reduce((a, p) => a + p.x, 0) / best.length;
      const mz = best.reduce((a, p) => a + p.z, 0) / best.length;
      let sxx = 0;
      let szz = 0;
      let sxz = 0;
      for (const p of best) {
        sxx += (p.x - mx) ** 2;
        szz += (p.z - mz) ** 2;
        sxz += (p.x - mx) * (p.z - mz);
      }
      const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
      const ux = Math.cos(theta);
      const uz = Math.sin(theta);

      // Split along the line at gaps — one physical wall per run.
      const seq = best
        .map((p) => ({ p, t: (p.x - mx) * ux + (p.z - mz) * uz }))
        .sort((a, b) => a.t - b.t);
      const runs = [[]];
      for (const e of seq) {
        const run = runs[runs.length - 1];
        if (run.length && e.t - run[run.length - 1].t > WALL_GAP_M) runs.push([e]);
        else run.push(e);
      }
      const rnd = (v) => Math.round(v * 100) / 100;
      for (const r of runs) {
        if (r.length < WALL_MIN_COLS) continue;
        const t0 = r[0].t;
        const t1 = r[r.length - 1].t;
        if (t1 - t0 < WALL_MIN_LEN_M) continue;
        // Percentile ends vertically: one noisy column must not stretch the
        // wall to its own height.
        const y0s = r.map((e) => e.p.y0).sort((a, b) => a - b);
        const y1s = r.map((e) => e.p.y1).sort((a, b) => a - b);
        out.push({
          a: [rnd(mx + ux * t0), rnd(mz + uz * t0)],
          b: [rnd(mx + ux * t1), rnd(mz + uz * t1)],
          y0: rnd(y0s[Math.floor(y0s.length * 0.2)]),
          y1: rnd(y1s[Math.floor(y1s.length * 0.8)]),
          cols: r.length,
        });
      }
      // Everything on the line leaves the pool, kept run or not — a
      // too-short run must not be refound forever.
      const used = new Set(best);
      pool = pool.filter((p) => !used.has(p));
    }
    return out;
  }

  let rejectCount = 0;

  function onWorkerDone(res) {
    busy = false;
    if (res.error) {
      log(`Depth inference failed: ${res.error}`);
    } else if (res.rejected) {
      // Refusing a keyframe we cannot scale honestly beats painting garbage;
      // logged sparsely so a systematic problem is visible without spam.
      if (++rejectCount % 10 === 1) {
        log(`Mapping: keyframe rejected (${res.rejected}) — ${rejectCount} total. ` +
          'Two tags at clearly different distances in one view teach the scale.');
      }
    } else {
      if (res.shift !== null) {
        const prev = shiftByClient.get(res.clientId);
        shiftByClient.set(res.clientId, prev === undefined ? res.shift : prev * 0.8 + res.shift * 0.2);
      }
      for (const key of res.voxels) hits.set(key, (hits.get(key) || 0) + 1);
      const empties = res.empties || [];
      for (const key of empties) misses.set(key, (misses.get(key) || 0) + 1);

      // Re-evaluate every voxel this keyframe touched, in either direction —
      // hits can promote, accumulated see-throughs can dismiss.
      let changed = 0;
      const evaluate = (key) => {
        const h = hits.get(key) || 0;
        const m = misses.get(key) || 0;
        const occ = h >= OCCUPIED_AT_HITS && m <= h * MISS_TOLERANCE;
        if (occ && !occupied.has(key)) {
          occupied.add(key);
          deltaAdded.push(key);
          changed++;
        } else if (!occ && occupied.has(key)) {
          occupied.delete(key);
          deltaRemoved.push(key);
          changed++;
        }
      };
      for (const key of res.voxels) evaluate(key);
      for (const key of empties) evaluate(key);

      recent.push({ voxels: res.voxels });
      if (recent.length > RECENT_CAP) recent.shift();
      inferCount++;
      if (changed) {
        scheduleFlush();
        scheduleWalls();
      }
      if (viewMode !== 'all') onSnapshot?.(snapshotParts());
      log(`Mapping: client ${res.clientId} keyframe #${inferCount} -> ` +
        `${res.voxels.length} hits, ${changed} changed, ${occupied.size} occupied`);
    }
    // Serve whichever client has the freshest waiting keyframe.
    const next = pending.entries().next().value;
    if (next) {
      pending.delete(next[0]);
      dispatch(next[1]);
    }
  }

  function dispatch(job) {
    busy = true;
    worker.postMessage(job, [job.jpeg.buffer]);
  }

  return {
    enabled,

    // A KFR1 keyframe from a client. header: { t, w, h, intrinsics, tags }.
    handleKeyframe(clientId, header, jpegBuf) {
      if (!enabled || viewMode === 'none') return;
      const { pose } = survey.locate(header.tags);
      if (!pose) return;   // not localizable — depth would land nowhere
      const job = {
        id: nextId++,
        clientId,
        jpeg: jpegBuf,
        w: header.w,
        h: header.h,
        intrinsics: header.intrinsics,
        pose,
        tags: header.tags,
        voxelSizeM: VOXEL_SIZE_M,
        priorShift: shiftByClient.get(clientId) ?? null,
      };
      if (busy) pending.set(clientId, job);   // newer frame replaces older
      else dispatch(job);
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
      hits.clear();
      misses.clear();
      occupied.clear();
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

module.exports = { createMapping };
