'use strict';

const fs = require('fs');
const path = require('path');
const {
  quatRotate, tagPlaneAgreement, CLIP_PLANE_M, CLIP_PARALLEL_COS,
} = require('./public/pose-math.js');

// Free-space carving from tag sightings. Every accepted camera→tag ray proves
// the line of sight was empty — the camera decoded the tag through it — and
// that the tag's wall is at the far end. That is the entire evidence model:
// no depth (the removed mapping pipeline showed the available depth error puts
// walls metres out), no assumption that unseen space is empty. Unknown stays
// unknown; the output only ever claims "attested free".
//
// The grid is as permanent as markers.json, so evidence is gated the way the
// survey gates map growth, not the way the viewer gates display: a report must
// be mapSafe (the survey's own founding/mirror/slip quarantine, exported for
// exactly this) and 'good' (a tag confirmed the fix this very frame). The
// design centre is that a wrong pose must not carve — a missing metre of floor
// fills in on the next walk-through, a carved-through wall is a lie that
// persists.
//
// This module is deliberately clock-free: log-odds accumulation has no TTLs,
// so unlike survey.js there is no Date.now() to drive from a journal during
// replay. The only timer is the save debounce, armed only when a file was
// given — the replay CLI passes none and exports the grid explicitly.

const DEFAULTS = {
  cellM: 0.06,               // grid resolution; ±2048 cells ≈ ±123 m
  // Report gate. jitterMm is the measured alignment sigma with the phone's own
  // motion divided out (survey.js trackJitter), so both figures hold while
  // walking. jitter === null is the absence of a measurement, not a clean one
  // — those reports are rejected, which costs the first ~1.5 s of each
  // alignment window. A hard threshold at the useful level threw away 40% of
  // an ordinary session (measured), so the gate is a soft knee instead:
  // evidence is weighted by 1/(1+(jitterMm/soft)²) — full weight at the ~5 mm
  // at-rest median, half at the knee — and only genuinely bad poses are
  // rejected outright.
  maxJitterMm: 100,
  softJitterMm: 25,
  // Per-ray gates. err/dist/px mirror the survey's own 'good'/survey-grade
  // thresholds (GOOD_MAX_ERR_PX, GOOD_MAX_DIST_M, SURVEY_MIN_PX) — a sighting
  // the survey would not build on has no business carving. px absent passes,
  // same rule as surveyGrade: old clients did not measure it.
  maxErrPx: 2,
  maxDistM: 6,
  minPx: 40,
  // Viewing angle against the *mapped* normal, signed: the camera must be in
  // front of a wall-mounted tag, and a negative cosine means the pose or the
  // map is wrong, not that the wall is transparent. Stricter than the
  // survey's OBS_MIN_COS (0.15) because a glancing ray carves a sliver
  // skimming along the wall — exactly the free-space claim most likely wrong.
  minCos: 0.25,
  // Ray shape. A near-vertical ray (tag right overhead) projects to a noisy
  // dot; a tiny horizontal run carves nothing worth the risk.
  minHorizM: 0.3,
  maxSlope: 1.0,             // |Δy| per metre of horizontal run, i.e. ≤45°
  // The last stretch before the tag is left uncarved so pose noise erodes
  // this margin, never the wall itself.
  standoffM: 0.2,
  // Log-odds increments (positive = occupied). First sighting from a new
  // viewpoint carries the full step; repeats from the same spot are worth
  // almost nothing — a wall stared at from the sofa is one measurement
  // repeated, not many (the old mapping.js lesson).
  lMiss: -0.4,
  lMissRepeat: -0.05,
  lHit: 0.85,
  lHitRepeat: 0.1,
  lMin: -4,
  lMax: 3,
  // Promotion with hysteresis, so a cell does not flicker at the threshold.
  freeOn: -1.0,
  freeOff: -0.4,
  occOn: 1.5,
  occOff: 0.5,
  minViews: 2,               // distinct viewpoints before a cell may go free
  viewCellM: 0.4,            // viewpoint identity quantisation
  // Tag-only (/client) fixes have no ARCore cross-check and no measured
  // jitter behind them; their evidence counts at half weight.
  tagonlyScale: 0.5,
  // Frustum carving: the wedge between two accepted rays of one frame. Not
  // provably empty the way a ray is — a pillar could stand between two tags
  // and occlude neither — so it carries a fraction of ray evidence and only
  // narrow wedges qualify (a wide one sweeps half the room). Run once per
  // viewpoint cell: repeat evidence from one spot is worth almost nothing
  // and the triangle rasterisation is the expensive part.
  frustumScale: 0.3,
  frustumMaxDeg: 50,
  // Wall extent: a free cell attests a wall plane only from just in front of
  // it (not the standoff band, which is never carved) out to arm's reach.
  wallNearM: 0.05,
  wallFarM: 0.6,
  wallGapM: 0.5,             // merge extent intervals across gaps up to this
  // Corner closure: two walls meeting at a real angle almost certainly meet
  // at a corner, so their segments are extended to the line intersection —
  // but only a bounded distance past what carving attested, and never into a
  // spot that was carved free (a corner cannot be where somebody walked).
  cornerMaxExtendM: 1.5,
  cornerMinAngleDeg: 30,
  // A tagless nub poking a few cells past a corner or through another wall is
  // extent noise and gets pulled back; anything longer could be a real wall
  // continuing past a T-junction, which only the opening test may cut.
  cornerTrimM: 0.25,
  // Free-cell blobs disconnected from everything else (8-connected) and
  // smaller than this are dropped from the floor, the extents and the leak
  // metric: a handful of cells with no walkable connection to the rest of the
  // room is a bad pose's footprint, not a place. The log-odds underneath
  // stays — an island that grows until it connects was real after all and
  // simply reappears. Deliberately NOT applied to opening detection or corner
  // blocking: the free cells behind a wall are always a small near-island
  // (few rays reach through a doorway), and filtering them there silently
  // un-detects the doorway. Those readers use raw cells with their own gate:
  openingMinCells: 4,
  islandMinCells: 12,
};

const GRID_HALF = 2048;
const GRID_SIDE = GRID_HALF * 2;
const WALLS_VERSION = 1;
const SAVE_DEBOUNCE_MS = 10000;

function createWalls({ file, log, markerSizeM, opts } = {}) {
  const C = { ...DEFAULTS, ...(opts || {}) };
  // key -> { L, views, vp, state } — log-odds, distinct-viewpoint count, last
  // viewpoint key (single slot), 0 unknown / 1 free / 2 occupied.
  const cells = new Map();
  // id -> { id, p, q, hops, clippedTo } from the survey's map; walls never
  // touch a raw tvec — the mapped position is the endpoint, or nothing is.
  const tags = new Map();
  let anchorId = null;
  let tagSizeM = markerSizeM;
  let planeGroups = null;    // recomputed lazily after setMarkerMap
  let saveTimer = null;
  let warnedLegacy = false;
  // Viewpoint cells whose frustum wedges were already carved — once each;
  // repeat wedges from one spot are one measurement re-counted.
  const frustumVps = new Set();

  const stats = {
    reports: { total: 0, accepted: 0, rej: {} },
    rays: { total: 0, accepted: 0, rej: {} },
  };
  function reject(bucket, reason) {
    bucket.rej[reason] = (bucket.rej[reason] || 0) + 1;
  }

  function cellKey(ix, iz) {
    return (ix + GRID_HALF) * GRID_SIDE + (iz + GRID_HALF);
  }

  function bump(ix, iz, full, repeat, vpKey, touched) {
    if (ix < -GRID_HALF || ix >= GRID_HALF || iz < -GRID_HALF || iz >= GRID_HALF) return;
    const key = cellKey(ix, iz);
    if (touched) touched.add(key);
    let c = cells.get(key);
    if (!c) cells.set(key, c = { L: 0, views: 0, vp: -1, state: 0 });
    const fresh = c.vp !== vpKey;
    if (fresh) {
      c.vp = vpKey;
      c.views++;
    }
    c.L = Math.min(C.lMax, Math.max(C.lMin, c.L + (fresh ? full : repeat)));
    // Demote first, then promote — a cell crossing the whole range in one
    // update settles on the side the evidence now says.
    if (c.state === 1 && c.L > C.freeOff) c.state = 0;
    if (c.state === 2 && c.L < C.occOff) c.state = 0;
    if (c.state === 0) {
      if (c.L >= C.occOn) c.state = 2;
      else if (c.L <= C.freeOn && c.views >= C.minViews) c.state = 1;
    }
  }

  // 2D DDA (Amanatides–Woo) over the x-z plane from the camera toward the
  // tag, stopping `standoffM` short. Every traversed cell takes a MISS.
  function carveRay(x0, z0, x1, z1, scale, vpKey, touched) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const travel = len - C.standoffM;
    if (travel <= 0) return;   // camera inside the standoff — nothing provable
    const ux = dx / len;
    const uz = dz / len;
    let ix = Math.floor(x0 / C.cellM);
    let iz = Math.floor(z0 / C.cellM);
    const stepX = ux > 0 ? 1 : -1;
    const stepZ = uz > 0 ? 1 : -1;
    const tDeltaX = ux !== 0 ? Math.abs(C.cellM / ux) : Infinity;
    const tDeltaZ = uz !== 0 ? Math.abs(C.cellM / uz) : Infinity;
    let tMaxX = ux !== 0 ? ((ix + (ux > 0 ? 1 : 0)) * C.cellM - x0) / ux : Infinity;
    let tMaxZ = uz !== 0 ? ((iz + (uz > 0 ? 1 : 0)) * C.cellM - z0) / uz : Infinity;
    let t = 0;
    while (t <= travel) {
      bump(ix, iz, C.lMiss * scale, C.lMissRepeat * scale, vpKey, touched);
      if (tMaxX < tMaxZ) {
        t = tMaxX;
        tMaxX += tDeltaX;
        ix += stepX;
      } else {
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        iz += stepZ;
      }
    }
  }

  // One journal-shaped report: { kind, at, msg, room, mapChanged }. This is
  // the exact object the server writes to *.pose.jsonl, so the replay CLI
  // feeds parsed lines straight through the very code the live path runs.
  function handleReport(entry) {
    if (!entry || (entry.kind !== 'xr-pose' && entry.kind !== 'pose')) return false;
    const { msg, room } = entry;
    stats.reports.total++;
    if (!room || !room.pose) return reject(stats.reports, 'noPose'), false;
    // Journals written before mapSafe existed lack the flag; quality alone is
    // the best stand-in and the gap is announced, not papered over.
    if (room.mapSafe === undefined) {
      if (!warnedLegacy) {
        warnedLegacy = true;
        log('walls: reports carry no mapSafe (pre-flag journal?) — '
          + 'falling back to quality alone, founding/slip quarantine unavailable');
      }
    } else if (room.mapSafe !== true) {
      return reject(stats.reports, 'mapSafe'), false;
    }
    if (room.quality !== 'good') return reject(stats.reports, 'quality'), false;
    if (msg.source === 'guess') return reject(stats.reports, 'guess'), false;
    let weight = 1;
    if (entry.kind === 'xr-pose') {
      const j = room.jitter;
      if (!j) return reject(stats.reports, 'jitterNull'), false;
      if (j.stale) return reject(stats.reports, 'jitterStale'), false;
      if (j.jitterMm > C.maxJitterMm) return reject(stats.reports, 'jitterOver'), false;
      weight = 1 / (1 + (j.jitterMm / C.softJitterMm) ** 2);
    }
    stats.reports.accepted++;

    const scale = (entry.kind === 'pose' ? C.tagonlyScale : 1) * weight;
    const cam = room.pose.p;
    const vpKey = cellKey(
      Math.round(cam[0] / C.viewCellM), Math.round(cam[2] / C.viewCellM));
    // Cells that took direct ray evidence this report, so the frustum pass
    // below cannot hand the same cell the same observation twice.
    const touched = new Set();
    // The camera is somewhere, and that somewhere is not inside a wall.
    bump(Math.floor(cam[0] / C.cellM), Math.floor(cam[2] / C.cellM),
      C.lMiss * scale, C.lMissRepeat * scale, vpKey, touched);

    const rays = [];   // accepted endpoints for the frustum pass
    for (const t of msg.tags || []) {
      stats.rays.total++;
      const m = tags.get(t.id);
      if (!m) { reject(stats.rays, 'unmapped'); continue; }
      if (!(t.err <= C.maxErrPx)) { reject(stats.rays, 'err'); continue; }
      const dist = Math.hypot(t.tvec[0], t.tvec[1], t.tvec[2]);
      if (!(dist <= C.maxDistM)) { reject(stats.rays, 'dist'); continue; }
      if (t.px != null && t.px < C.minPx) { reject(stats.rays, 'px'); continue; }
      // Viewing angle in the *room* frame against the mapped normal — signed,
      // because "behind the wall the tag is on" is a pose error, not a view.
      const v = [cam[0] - m.p[0], cam[1] - m.p[1], cam[2] - m.p[2]];
      const d3 = Math.hypot(v[0], v[1], v[2]);
      if (!(d3 > 1e-6)) { reject(stats.rays, 'shape'); continue; }
      const n = quatRotate(m.q, [0, 0, 1]);
      const cos = (v[0] * n[0] + v[1] * n[1] + v[2] * n[2]) / d3;
      if (cos < 0) { reject(stats.rays, 'behind'); continue; }
      if (cos < C.minCos) { reject(stats.rays, 'cos'); continue; }
      const horiz = Math.hypot(v[0], v[2]);
      if (horiz < C.minHorizM || Math.abs(v[1]) > C.maxSlope * horiz) {
        reject(stats.rays, 'shape');
        continue;
      }
      stats.rays.accepted++;
      carveRay(cam[0], cam[2], m.p[0], m.p[2], scale, vpKey, touched);
      // The far end is the wall the tag is mounted on. Not added to
      // `touched`: the frustum must not carve the wall cell, and it cannot —
      // the wedge corners are pulled a standoff short of the tags.
      bump(Math.floor(m.p[0] / C.cellM), Math.floor(m.p[2] / C.cellM),
        C.lHit * scale, C.lHitRepeat * scale, vpKey);
      rays.push([m.p[0], m.p[2]]);
    }
    if (rays.length >= 2 && C.frustumScale > 0 && !frustumVps.has(vpKey)) {
      frustumVps.add(vpKey);
      carveFrustum(cam, rays, scale, vpKey, touched);
    }
    if (file) scheduleSave();
    return true;   // the camera cell took evidence even if every ray failed
  }

  // Wedges between pairs of accepted rays from one viewpoint. Each wedge
  // corner is pulled a standoff toward the camera, so like the rays the
  // frustum never carves the wall band the tags sit in.
  function carveFrustum(cam, rays, scale, vpKey, touched) {
    const maxCos = Math.cos(C.frustumMaxDeg * Math.PI / 180);
    const full = C.lMiss * scale * C.frustumScale;
    const repeat = C.lMissRepeat * scale * C.frustumScale;
    const x0 = cam[0];
    const z0 = cam[2];
    const pulled = rays.map(([x, z]) => {
      const dx = x - x0;
      const dz = z - z0;
      const len = Math.hypot(dx, dz);
      const k = Math.max(0, len - C.standoffM) / (len || 1);
      return { x: x0 + dx * k, z: z0 + dz * k, ux: dx / (len || 1), uz: dz / (len || 1) };
    });
    for (let i = 0; i < pulled.length; i++) {
      for (let k = i + 1; k < pulled.length; k++) {
        const a = pulled[i];
        const b = pulled[k];
        if (a.ux * b.ux + a.uz * b.uz < maxCos) continue;   // wedge too wide
        const minX = Math.min(x0, a.x, b.x);
        const maxX = Math.max(x0, a.x, b.x);
        const minZ = Math.min(z0, a.z, b.z);
        const maxZ = Math.max(z0, a.z, b.z);
        for (let ix = Math.floor(minX / C.cellM); ix <= Math.floor(maxX / C.cellM); ix++) {
          for (let iz = Math.floor(minZ / C.cellM); iz <= Math.floor(maxZ / C.cellM); iz++) {
            if (touched.has(cellKey(ix, iz))) continue;
            const cx = (ix + 0.5) * C.cellM;
            const cz = (iz + 0.5) * C.cellM;
            // Same-sign test against all three edges = inside the triangle.
            const s1 = (a.x - x0) * (cz - z0) - (a.z - z0) * (cx - x0);
            const s2 = (b.x - a.x) * (cz - a.z) - (b.z - a.z) * (cx - a.x);
            const s3 = (x0 - b.x) * (cz - b.z) - (z0 - b.z) * (cx - b.x);
            if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) {
              bump(ix, iz, full, repeat, vpKey, touched);
            }
          }
        }
      }
    }
  }

  function setMarkerMap(map) {
    tags.clear();
    anchorId = map ? map.anchorId : null;
    for (const m of (map && map.markers) || []) {
      tags.set(m.id, {
        id: m.id, p: m.p, q: m.q,
        hops: m.hops, clippedTo: m.clippedTo ?? null,
      });
    }
    planeGroups = null;
  }

  // Same semantics as the survey's datumDepth: the anchor is the datum
  // whatever its record says, an unknown chain sits at the back.
  function depthOf(m) {
    if (m.id === anchorId) return 0;
    return Number.isFinite(m.hops) ? m.hops : Infinity;
  }

  // Union-find over tags that assert one plane: the survey's own clippedTo
  // links, plus the identical predicate for pairs the clip rule deliberately
  // skips (equal-depth, unknown-chain — still one wall).
  function groupPlanes() {
    const ids = [...tags.keys()];
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (a) => {
      while (parent.get(a) !== a) {
        parent.set(a, parent.get(parent.get(a)));
        a = parent.get(a);
      }
      return a;
    };
    const union = (a, b) => parent.set(find(a), find(b));
    for (const m of tags.values()) {
      if (m.clippedTo != null && tags.has(m.clippedTo)) union(m.id, m.clippedTo);
    }
    for (let i = 0; i < ids.length; i++) {
      for (let k = i + 1; k < ids.length; k++) {
        const a = tags.get(ids[i]);
        const b = tags.get(ids[k]);
        const { cos, d } = tagPlaneAgreement(a, b);
        if (cos >= CLIP_PARALLEL_COS && Math.abs(d) <= CLIP_PLANE_M) union(a.id, b.id);
      }
    }
    const groups = new Map();
    for (const id of ids) {
      const root = find(id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(tags.get(id));
    }
    return [...groups.values()];
  }

  // The 2D frame of a coplanar group's wall: origin at the reference tag
  // (lowest datum depth — its plane is what the others were clipped onto),
  // `front` positive into the room, `s` along the wall. Null when the normal
  // is not horizontal enough to be a wall — a tag pointing mostly up or down
  // is on a table or a ceiling.
  function planeFrameOf(group) {
    const ref = group.reduce((a, b) => (depthOf(b) < depthOf(a) ? b : a));
    const n3 = quatRotate(ref.q, [0, 0, 1]);
    const nh = Math.hypot(n3[0], n3[2]);
    if (nh < 0.7) return null;
    const n2 = [n3[0] / nh, n3[2] / nh];         // into the room
    const d2 = [-n2[1], n2[0]];                  // along the wall
    const px = ref.p[0];
    const pz = ref.p[2];
    return {
      px, pz, d2,
      sOf: (x, z) => (x - px) * d2[0] + (z - pz) * d2[1],
      frontOf: (x, z) => (x - px) * n2[0] + (z - pz) * n2[1],
    };
  }

  // Wall segments: one plane per coplanar tag group, extent grown exactly as
  // far as carved free space in front of it attests — never a speculative
  // full-room wall. Interval endpoints in the plane's in-wall direction.
  function getWalls() {
    if (!planeGroups) planeGroups = groupPlanes();
    const freeSet = liveFree();
    const walls = [];
    for (const group of planeGroups) {
      const frame = planeFrameOf(group);
      if (!frame) continue;
      const { px, pz, d2, sOf, frontOf } = frame;
      const intervals = [];
      const half = tagSizeM / 2;
      for (const m of group) {
        const s = sOf(m.p[0], m.p[2]);
        intervals.push({ lo: s - half, hi: s + half, tag: m.id });
      }
      // Free space in front of the plane attests the wall — unless there is
      // also free space *behind* the plane at the same along-wall position.
      // Front and behind both walkable is not a wall, it is an opening
      // somebody walked through (a doorway, or where the room simply
      // continues), and chaining the extent across it is how a wall got drawn
      // across a doorway and clean through the far side of an L-shaped room.
      // Front attestation reads the island-filtered set; behind evidence
      // reads raw cells — the through-a-doorway blob is small by nature and
      // must not be filtered out of the one place it is the signal.
      const frontBins = new Set();
      const behindCount = new Map();
      for (const [key, c] of cells) {
        if (c.state !== 1) continue;
        const ix = Math.floor(key / GRID_SIDE) - GRID_HALF;
        const iz = (key % GRID_SIDE) - GRID_HALF;
        const cx = (ix + 0.5) * C.cellM;
        const cz = (iz + 0.5) * C.cellM;
        const front = frontOf(cx, cz);
        const bin = Math.round(sOf(cx, cz) / C.cellM);
        if (front >= C.wallNearM && front <= C.wallFarM) {
          if (freeSet.has(key)) frontBins.add(bin);
        } else if (front <= -C.wallNearM && front >= -C.wallFarM) {
          behindCount.set(bin, (behindCount.get(bin) || 0) + 1);
        }
      }
      // Behind-cells are sparse — few rays reach through an opening — so
      // testing front bins against them one-for-one leaves pinholes that
      // stitch the wall back across the doorway. Cluster the behind bins into
      // opening intervals first (same gap rule as the extents), then excise
      // every front bin inside one. A cluster below openingMinCells is noise,
      // not an opening — that is this reader's own island gate.
      const openings = [];
      const gapBins = C.wallGapM / C.cellM;
      for (const bin of [...behindCount.keys()].sort((a, b) => a - b)) {
        const last = openings[openings.length - 1];
        if (last && bin - last[1] <= gapBins) {
          last[1] = bin;
          last[2] += behindCount.get(bin);
        } else {
          openings.push([bin, bin, behindCount.get(bin)]);
        }
      }
      const realOpenings = openings.filter(([, , n]) => n >= C.openingMinCells);
      for (const bin of frontBins) {
        // ±1 tolerance: at a doorframe the behind-cells stop one cell short of
        // where the wall starts, and a one-cell sliver of phantom wall in the
        // opening is worse than one cell shaved off the frame.
        if (realOpenings.some(([lo, hi]) => bin >= lo - 1 && bin <= hi + 1)) continue;
        const s = bin * C.cellM;
        intervals.push({ lo: s - C.cellM / 2, hi: s + C.cellM / 2, tag: null });
      }
      intervals.sort((a, b) => a.lo - b.lo);
      let run = null;
      const runs = [];
      for (const iv of intervals) {
        if (run && iv.lo - run.hi <= C.wallGapM) {
          run.hi = Math.max(run.hi, iv.hi);
          if (iv.tag != null) run.tags.push(iv.tag);
        } else {
          run = { lo: iv.lo, hi: iv.hi, tags: iv.tag != null ? [iv.tag] : [] };
          runs.push(run);
        }
      }
      const ys = group.map((m) => m.p[1]);
      // y extents are cosmetic — there is no measured floor or ceiling in the
      // system, only tags at roughly eye height.
      const y0 = Math.min(...ys) - 0.5;
      const y1 = Math.max(...ys) + 0.5;
      for (const r of runs) {
        if (!r.tags.length) continue;   // free space near the plane's infinite
                                        // extension, away from any tag — not
                                        // attested to be this wall
        walls.push({
          a: [px + d2[0] * r.lo, pz + d2[1] * r.lo],
          b: [px + d2[0] * r.hi, pz + d2[1] * r.hi],
          y0, y1, ids: r.tags,
        });
      }
    }
    trimCrossings(walls);
    closeCorners(walls);
    return walls;
  }

  // Intersection of two segments in fractional units of each: t1/t2 in [0,1]
  // means within the segment. Null for parallels.
  function segIntersect(a1, b1, a2, b2) {
    const d1 = [b1[0] - a1[0], b1[1] - a1[1]];
    const d2 = [b2[0] - a2[0], b2[1] - a2[1]];
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    if (!cross) return null;
    const ex = a2[0] - a1[0];
    const ez = a2[1] - a1[1];
    const t1 = (ex * d2[1] - ez * d2[0]) / cross;
    const t2 = (ex * d1[1] - ez * d1[0]) / cross;
    return { t1, t2, p: [a1[0] + t1 * d1[0], a1[1] + t1 * d1[1]] };
  }

  // Two asserted walls cannot pass through each other. Where segments
  // properly cross, the side that carries no tag is extent inference (free
  // cells chained along the plane), and the other wall standing there is the
  // stronger claim — cut the tagless side at the crossing.
  function trimCrossings(walls) {
    const trimSide = (seg, t, p) => {
      const dx = seg.b[0] - seg.a[0];
      const dz = seg.b[1] - seg.a[1];
      const len2 = dx * dx + dz * dz;
      if (!len2) return;
      const tagTs = seg.ids
        .map((id) => tags.get(id))
        .filter(Boolean)
        .map((m) => ((m.p[0] - seg.a[0]) * dx + (m.p[2] - seg.a[1]) * dz) / len2);
      if (!tagTs.length) return;
      const len = Math.sqrt(len2);
      // Only short pokes are cut. A long tagless run past the crossing is
      // attested wall — a T-junction continuation — and cutting it on the
      // strength of another wall standing there throws away real extent.
      if (tagTs.every((tt) => tt < t) && (1 - t) * len <= C.cornerTrimM) seg.b = p;
      else if (tagTs.every((tt) => tt > t) && t * len <= C.cornerTrimM) seg.a = p;
      // Tags on both sides of the crossing: leave it — the crossing itself is
      // then evidence of something odd, and cutting either side hides a tag.
    };
    for (let i = 0; i < walls.length; i++) {
      for (let k = i + 1; k < walls.length; k++) {
        const s1 = walls[i];
        const s2 = walls[k];
        const m1 = C.cellM / (Math.hypot(s1.b[0] - s1.a[0], s1.b[1] - s1.a[1]) || 1);
        const m2 = C.cellM / (Math.hypot(s2.b[0] - s2.a[0], s2.b[1] - s2.a[1]) || 1);
        const hit = segIntersect(s1.a, s1.b, s2.a, s2.b);
        if (!hit) continue;
        if (hit.t1 <= m1 || hit.t1 >= 1 - m1 || hit.t2 <= m2 || hit.t2 >= 1 - m2) continue;
        trimSide(s1, hit.t1, hit.p);
        trimSide(s2, hit.t2, hit.p);
      }
    }
  }

  // Is any cell on the straight path between two points carved free? Used to
  // keep corner inference from bridging across an opening somebody walked
  // through — the wall the extension would draw is disproved by the cells
  // under it. Reads raw cell state on purpose: through-the-doorway cells are
  // usually below the island threshold, and they are the evidence here.
  function pathCrossesFree(a, b) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(len / (C.cellM / 2)));
    for (let i = 1; i < steps; i++) {
      const x = a[0] + (b[0] - a[0]) * (i / steps);
      const z = a[1] + (b[1] - a[1]) * (i / steps);
      if (stateAt(x, z) === 1) return true;
    }
    return false;
  }

  function stateAt(x, z) {
    const c = cells.get(cellKey(Math.floor(x / C.cellM), Math.floor(z / C.cellM)));
    return c ? c.state : 0;
  }

  // Free cells that survive the island filter: 8-connected components below
  // islandMinCells are suppressed from every reader (floor, walls, leaks) in
  // one place, so no consumer sees a different room than another.
  function liveFree() {
    const free = new Set();
    for (const [key, c] of cells) {
      if (c.state === 1) free.add(key);
    }
    const seen = new Set();
    const kept = new Set();
    for (const start of free) {
      if (seen.has(start)) continue;
      const comp = [start];
      seen.add(start);
      for (let i = 0; i < comp.length; i++) {
        const key = comp[i];
        const ix = Math.floor(key / GRID_SIDE) - GRID_HALF;
        const iz = (key % GRID_SIDE) - GRID_HALF;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (!dx && !dz) continue;
            const nk = cellKey(ix + dx, iz + dz);
            if (free.has(nk) && !seen.has(nk)) {
              seen.add(nk);
              comp.push(nk);
            }
          }
        }
      }
      if (comp.length >= C.islandMinCells) for (const k of comp) kept.add(k);
    }
    return kept;
  }

  // Extend pairs of wall segments to their line intersection. Two walls
  // meeting at a real angle almost certainly meet at a corner; carving alone
  // cannot attest the last stretch (nobody stands in a corner looking along
  // the wall), so this is the one place a bounded geometric prior fills in.
  // Bounded three ways: the extension is capped, the walls must be genuinely
  // angled (near-parallel "intersections" land at infinity), and the corner
  // must not sit in space that was carved free.
  function closeCorners(walls) {
    const minSin = Math.sin(C.cornerMinAngleDeg * Math.PI / 180);
    const best = walls.map(() => ({ a: null, b: null }));
    for (let i = 0; i < walls.length; i++) {
      for (let k = i + 1; k < walls.length; k++) {
        const s1 = walls[i];
        const s2 = walls[k];
        const l1 = Math.hypot(s1.b[0] - s1.a[0], s1.b[1] - s1.a[1]);
        const l2 = Math.hypot(s2.b[0] - s2.a[0], s2.b[1] - s2.a[1]);
        if (!l1 || !l2) continue;
        const d1 = [(s1.b[0] - s1.a[0]) / l1, (s1.b[1] - s1.a[1]) / l1];
        const d2 = [(s2.b[0] - s2.a[0]) / l2, (s2.b[1] - s2.a[1]) / l2];
        const cross = d1[0] * d2[1] - d1[1] * d2[0];
        if (Math.abs(cross) < minSin) continue;
        const ex = s2.a[0] - s1.a[0];
        const ez = s2.a[1] - s1.a[1];
        const t1 = (ex * d2[1] - ez * d2[0]) / cross;
        const t2 = (ex * d1[1] - ez * d1[0]) / cross;
        const P = [s1.a[0] + t1 * d1[0], s1.a[1] + t1 * d1[1]];
        const tagTsOf = (seg, a, d) => seg.ids
          .map((id) => tags.get(id))
          .filter(Boolean)
          .map((m) => (m.p[0] - a[0]) * d[0] + (m.p[2] - a[1]) * d[1]);
        // An end short of the intersection extends to it; an end a short
        // tagless overhang *past* it pulls back to it — both are the same
        // corner, approached from opposite sides.
        const need = (t, len, tagTs) => {
          if (t < 0) return { end: 'a', ext: -t };
          if (t > len) return { end: 'b', ext: t - len };
          if (tagTs.every((tt) => tt < t) && len - t <= C.cornerTrimM) {
            return { end: 'b', ext: 0 };
          }
          if (tagTs.every((tt) => tt > t) && t <= C.cornerTrimM) {
            return { end: 'a', ext: 0 };
          }
          return { end: null, ext: 0 };
        };
        const n1 = need(t1, l1, tagTsOf(s1, s1.a, d1));
        const n2 = need(t2, l2, tagTsOf(s2, s2.a, d2));
        if (n1.ext > C.cornerMaxExtendM || n2.ext > C.cornerMaxExtendM) continue;
        if (!n1.end && !n2.end) continue;   // they already meet
        if (stateAt(P[0], P[1]) === 1) continue;
        // An end's extension must not pass through a third wall on the way to
        // its corner, nor over cells carved free — a doorway somebody walked
        // through disproves the wall the extension would draw across it.
        // Blocked per end, not per pair: the partner pulling its overhang
        // back to the shared line is still right even when this side cannot
        // reach the corner.
        const pathBlocked = (seg, n) => {
          const from = n.end === 'a' ? seg.a : seg.b;
          if (pathCrossesFree(from, P)) return true;
          return walls.some((other) => {
            if (other === walls[i] || other === walls[k]) return false;
            const hit = segIntersect(from, P, other.a, other.b);
            return !!hit && hit.t1 > 0 && hit.t1 < 1 && hit.t2 > 0 && hit.t2 < 1;
          });
        };
        for (const [idx, seg, n] of [[i, walls[i], n1], [k, walls[k], n2]]) {
          if (!n.end || pathBlocked(seg, n)) continue;
          if (!best[idx][n.end] || n.ext < best[idx][n.end].ext) {
            best[idx][n.end] = { ext: n.ext, p: P };
          }
        }
      }
    }
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      // ext records how much of each end is corner inference rather than
      // attested extent — the replay prints it, the renderer need not care.
      if (best[i].a) {
        w.a = best[i].a.p;
        w.ext = { ...(w.ext || {}), a: Math.round(best[i].a.ext * 100) / 100 };
      }
      if (best[i].b) {
        w.b = best[i].b.p;
        w.ext = { ...(w.ext || {}), b: Math.round(best[i].b.ext * 100) / 100 };
      }
    }
  }

  // Free cells *behind* a wall within its tag-attested span. Tags are mounted
  // on walls, so free space behind a tag's plane is wrong by construction —
  // this is the headline number for whether the gates keep bad poses out.
  // Counted only within the segment's along-wall extent: beyond a wall's end
  // (a divider, a doorway wall) free space past the plane's infinite
  // extension is legitimate.
  function leaks() {
    if (!planeGroups) planeGroups = groupPlanes();
    const freeSet = liveFree();
    let count = 0;
    for (const group of planeGroups) {
      const frame = planeFrameOf(group);
      if (!frame) continue;
      const { sOf, frontOf } = frame;
      const half = tagSizeM / 2;
      let lo = Infinity;
      let hi = -Infinity;
      for (const m of group) {
        const s = sOf(m.p[0], m.p[2]);
        lo = Math.min(lo, s - half);
        hi = Math.max(hi, s + half);
      }
      for (const key of freeSet) {
        const ix = Math.floor(key / GRID_SIDE) - GRID_HALF;
        const iz = (key % GRID_SIDE) - GRID_HALF;
        const cx = (ix + 0.5) * C.cellM;
        const cz = (iz + 0.5) * C.cellM;
        if (frontOf(cx, cz) > -C.cellM) continue;
        const s = sOf(cx, cz);
        if (s >= lo && s <= hi) count++;
      }
    }
    return count;
  }

  function getFloor() {
    const freeSet = liveFree();
    const free = [];
    const occ = [];
    for (const [key, c] of cells) {
      if (c.state === 2) {
        occ.push(Math.floor(key / GRID_SIDE) - GRID_HALF, (key % GRID_SIDE) - GRID_HALF);
      } else if (c.state === 1 && freeSet.has(key)) {
        free.push(Math.floor(key / GRID_SIDE) - GRID_HALF, (key % GRID_SIDE) - GRID_HALF);
      }
    }
    return { cellM: C.cellM, free, occ };
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const out = {
        version: WALLS_VERSION,
        markerSizeM: tagSizeM,
        cellM: C.cellM,
        updatedAtMs: Date.now(),
        cells: [...cells].map(([key, c]) => [
          Math.floor(key / GRID_SIDE) - GRID_HALF,
          (key % GRID_SIDE) - GRID_HALF,
          Math.round(c.L * 1000) / 1000,
          c.views,
        ]),
      };
      // Atomic replace, same reason as the marker map: a crash mid-write must
      // not eat the grid.
      const tmp = `${file}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(out));
        fs.renameSync(tmp, file);
      } catch (err) {
        log(`Walls save failed: ${err.message}`);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function load() {
    if (!file) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;   // no grid yet — normal on first run
    }
    if (raw.markerSizeM !== tagSizeM) {
      log(`Ignoring ${path.basename(file)}: it was carved with ` +
        `${raw.markerSizeM} m markers, config says ${tagSizeM} m`);
      return;
    }
    if (raw.cellM !== C.cellM) {
      log(`Ignoring ${path.basename(file)}: cell size ${raw.cellM} m, ` +
        `expected ${C.cellM} m`);
      return;
    }
    for (const [ix, iz, L, views] of raw.cells || []) {
      // Viewpoint identity does not survive a restart (vp = -1), which only
      // under-counts: an already-promoted cell keeps its state, an unpromoted
      // one needs a genuinely new sighting anyway. State is re-derived without
      // hysteresis — thresholds only.
      const state = L >= C.occOn ? 2 : (L <= C.freeOn && views >= C.minViews ? 1 : 0);
      cells.set(cellKey(ix, iz), { L, views, vp: -1, state });
    }
    if (cells.size) {
      const floor = getFloor();
      log(`Walls grid loaded: ${cells.size} cells, `
        + `${floor.free.length / 2} free / ${floor.occ.length / 2} occupied`);
    }
  }

  function reset() {
    cells.clear();
    planeGroups = null;
    frustumVps.clear();
    for (const k of Object.keys(stats.reports.rej)) delete stats.reports.rej[k];
    for (const k of Object.keys(stats.rays.rej)) delete stats.rays.rej[k];
    stats.reports.total = stats.reports.accepted = 0;
    stats.rays.total = stats.rays.accepted = 0;
    if (file) scheduleSave();
  }

  function statsOf() {
    const floor = getFloor();
    const freeCells = floor.free.length / 2;
    return {
      reports: { ...stats.reports, rej: { ...stats.reports.rej } },
      rays: { ...stats.rays, rej: { ...stats.rays.rej } },
      cells: cells.size,
      free: freeCells,
      occ: floor.occ.length / 2,
      freeM2: Math.round(freeCells * C.cellM * C.cellM * 100) / 100,
    };
  }

  return {
    load,
    setMarkerMap,
    handleReport,
    getFloor,
    getWalls,
    leaks,
    stats: statsOf,
    reset,
    setMarkerSize(m) {
      tagSizeM = m;
      reset();
    },
  };
}

module.exports = { createWalls, DEFAULTS };
