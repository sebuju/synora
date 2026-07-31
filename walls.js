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
  // evidence is weighted by 1/(1+(jitterMm/soft)²) and only genuinely bad
  // poses are rejected outright. The knee sits at 60, well above the ~20 mm
  // that ordinary walking measures: a knee at 25 cut walking evidence to 0.6
  // and left most touched cells short of the promotion threshold (measured:
  // 792 of 3137 promoted; 1685 at 60, leaks 0 on every dataset — the hard cap
  // plus the report gates carry the safety, the knee only shades the 60-100
  // band).
  maxJitterMm: 100,
  softJitterMm: 60,
  // No jitter measurement yet (the window needs ~1 s of fixes, and founding
  // precedes it) is not the same as a bad one: those reports carry the
  // weight of a mediocre-but-usable pose instead of being rejected — in a
  // short test session the warm-up was most of the session, and over half
  // of the good reports carved nothing at all.
  noJitterW: 0.4,
  // Per-ray evidence quality — scored, not gated (explicit user decision:
  // gather evidence and weight it by how good it was; hard cuts remain only
  // for geometric impossibility and poisoned inputs). Each factor is ~1 for
  // a good sighting and decays past its soft point — the value where the old
  // hard gate used to sit, so what was once barely-accepted now carves at
  // half strength and what was barely-rejected carves faintly instead of
  // being thrown away. The soft points mirror the survey's own thresholds
  // (GOOD_MAX_ERR_PX, GOOD_MAX_DIST_M, SURVEY_MIN_PX). px absent scores 1,
  // same rule as surveyGrade: old clients did not measure it.
  // Soft points sit at genuinely-marginal values, not at typical ones: a
  // 45 px tag at 3.5 m is an ordinary ranged sighting and must score near 1,
  // or every mid-room cell needs four viewpoints and a sight line visibly
  // carves only its near-tag half.
  errSoftPx: 2,
  distSoftM: 8,
  pxSoft: 25,
  // Viewing angle against the *mapped* normal, signed: full weight past
  // cosSoft, ramping down toward the graze. Below cosMin the ray is nearly
  // parallel to the wall it claims to see — geometry, not quality — and a
  // negative cosine means the camera is behind the wall: both hard rejects.
  cosSoft: 0.25,
  cosMin: 0.05,
  // Ray shape. A near-vertical ray (tag right overhead) projects to a noisy
  // dot; a tiny horizontal run carves nothing worth the risk.
  minHorizM: 0.3,
  maxSlope: 1.0,             // |Δy| per metre of horizontal run, i.e. ≤45°
  // The sight carve's near end is not a point: the camera position is known
  // only to the pose uncertainty, and the device itself has width — the
  // union of plausible sight cones over that envelope is a trapezoid. A
  // point apex starves the cells nearest the phone (the thin wobbling tip
  // splits its evidence across different cells every frame while the tag end
  // hits the same wide fixed cells), which measured as views 3 / unpromoted
  // at arm's length against views 20 / saturated at the tag.
  apexHalfM: 0.08,
  // The last stretch before the tag is left uncarved so pose noise erodes
  // this margin, never the wall itself. One cell plus change: at 0.2 this
  // left a permanent uncarved strip in front of every tag that nothing could
  // ever clear — and worse, corner closure's free-path check threaded along
  // that shielded strip, extending walls past carved space on both sides.
  standoffM: 0.08,
  // Log-odds increments (positive = occupied). First sighting from a new
  // viewpoint carries the full step; repeats from the same spot are worth
  // almost nothing — a wall stared at from the sofa is one measurement
  // repeated, not many (the old mapping.js lesson).
  // Tuned so ONE sweep of the room carves what was seen: two fresh-viewpoint
  // sightings at ordinary walking quality (jitter ~0.9 × ray score ~0.7 ≈
  // 0.63 each) must cross the promotion threshold (2 × 1.0 × 0.63 ≈ 1.26 >
  // 0.7 with headroom for weaker rays), or a single pass leaves most of the
  // swept area unknown and the map only fills in on the third lap.
  lMiss: -1.0,
  lMissRepeat: -0.1,
  lHit: 0.85,
  lHitRepeat: 0.1,
  lMin: -4,
  lMax: 3,
  // Promotion with hysteresis, so a cell does not flicker at the threshold.
  freeOn: -0.7,
  // A single viewpoint may also promote, but only on sustained evidence — a
  // couple of seconds of steady observation, not one frame. The systematic
  // error minViews guards against would have to survive mapSafe, quality,
  // jitter and reprojection for that whole stretch; holding the phone on a
  // tag and carving nothing was the worse failure.
  freeOnSingle: -2.5,
  freeOff: -0.4,
  occOn: 1.5,
  occOff: 0.5,
  minViews: 2,               // distinct viewpoints before a cell may go free
  // Viewpoint identity: position cell plus a coarse facing sector. The
  // systematic error the diversity gate guards against (a mirrored or
  // misaligned fix) varies with where the camera is AND which way it looks,
  // so standing in one spot panning across the room is honestly several
  // viewpoints — requiring a position change made a one-sweep survey
  // structurally impossible from any single vantage.
  viewCellM: 0.4,
  viewSectors: 8,            // 45° facing bins
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
  // at a corner, so their segments are extended to the line intersection.
  // Walls close by policy — a room outline with dangling ends is worth less
  // than one that commits (explicit user decision), so the extension bound is
  // generous and an extension may span up to closeThroughM of carved-free
  // path: that is a doorway being crossed by the wall's own plane, and the
  // floor layer still shows the passage. It may NOT cross more than that —
  // past a doorway's width it would be drawing a wall through the middle of
  // walked space — and never through a third wall.
  cornerMaxExtendM: 3.0,
  cornerMinAngleDeg: 30,
  closeThroughM: 1.0,
  // Manhattan snap: a wall within this of the anchor wall's 90° grid is
  // rotated onto it before corners are closed, so near-right angles render
  // as right angles. Asserted walls pivot about their tag centroid — the
  // tags stay on their wall — inferred walls about their midpoint.
  cornerSnapDeg: 5,
  // A tagless nub poking a few cells past a corner or through another wall is
  // extent noise and gets pulled back; anything longer could be a real wall
  // continuing past a T-junction, which only the opening test may cut.
  cornerTrimM: 0.35,
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
  // Unknown pockets fully enclosed by free space fill in as free: a pocket is
  // single-viewpoint speckle or a wedge shadow, and the systematic error the
  // viewpoint gate fears would have poisoned the surrounding cells too. Only
  // small ones, and never one containing an occupied cell — a pillar casts a
  // large shadow and its own cells are hits, both of which refuse the fill.
  islandFillCells: 40,
  // Tagless walls inferred from the carve boundary: a straight, long, dense,
  // strictly one-sided edge of the free region, parallel or perpendicular to
  // a known tag wall, is a wall even though nobody taped a tag to it. Gated
  // hard because a mere exploration frontier must not read as a wall — a
  // frontier is ragged and two-sided-ish, a wall edge is straight and one
  // sided. Emitted with `inferred: true` and rendered dashed.
  inferMinLenM: 0.8,   // a walk along a wall leaves ~0.9 m straight stretches
  inferVTolM: 0.1,     // how much the silhouette may wander and still be flat
  inferRowFillFrac: 0.7,        // fraction of rows in the span that must exist
  inferMaxParallelDistM: 0.35,  // dedupe distance against asserted walls
  // Grouping gap for wall rendering, wider than the survey's CLIP_PLANE_M: a
  // refined tag can sit 10-20 cm off its wall-mates' plane before the clip
  // re-captures it, and two tags that far apart but SAME-facing are one wall
  // drawn twice, not two walls. Opposite-facing tags never merge whatever the
  // gap — that is a partition's two faces.
  wallGroupGapM: 0.25,
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
      else if (c.L <= C.freeOnSingle) c.state = 1;
    }
  }

  // Rasterise the triangle (x0,z0)-a-b onto the grid: every cell whose centre
  // is inside and not already touched this report takes a MISS. One carve per
  // cell per report — overlapping wedges near the camera must not count one
  // observation twice.
  function carveTriangle(x0, z0, a, b, full, repeat, vpKey, touched, clips) {
    const minX = Math.min(x0, a[0], b[0]);
    const maxX = Math.max(x0, a[0], b[0]);
    const minZ = Math.min(z0, a[1], b[1]);
    const maxZ = Math.max(z0, a[1], b[1]);
    for (let ix = Math.floor(minX / C.cellM); ix <= Math.floor(maxX / C.cellM); ix++) {
      for (let iz = Math.floor(minZ / C.cellM); iz <= Math.floor(maxZ / C.cellM); iz++) {
        if (touched.has(cellKey(ix, iz))) continue;
        const cx = (ix + 0.5) * C.cellM;
        const cz = (iz + 0.5) * C.cellM;
        if (clips && clips.some((c) => {
          const dx = cx - c.px;
          const dz = cz - c.pz;
          return dx * dx + dz * dz < 1.44 && dx * c.nx + dz * c.nz < 0;
        })) continue;
        // Same-sign test against all three edges = inside the triangle.
        const s1 = (a[0] - x0) * (cz - z0) - (a[1] - z0) * (cx - x0);
        const s2 = (b[0] - a[0]) * (cz - a[1]) - (b[1] - a[1]) * (cx - a[0]);
        const s3 = (x0 - b[0]) * (cz - b[1]) - (z0 - b[1]) * (cx - b[0]);
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) {
          bump(ix, iz, full, repeat, vpKey, touched);
        }
      }
    }
  }

  // Wall planes near enough to veto carving: every mapped wall tag's plane,
  // effective within 1.2 m of its tag. A carve cell behind one of these is a
  // wall being carved through — the widened apex and the wedge side edges
  // both managed it near corners before this was checked per cell. The
  // radius limit keeps a genuine walk through a doorway (well away from the
  // tag along the same plane) carvable.
  function wallPlanes() {
    const planes = [];
    for (const m of tags.values()) {
      const n = quatRotate(m.q, [0, 0, 1]);
      const nh = Math.hypot(n[0], n[2]);
      if (nh < 0.7) continue;
      planes.push({ px: m.p[0], pz: m.p[2], nx: n[0] / nh, nz: n[2] / nh });
    }
    return planes;
  }

  // Pull a point toward the camera by the standoff, so no carve reaches the
  // wall band the tag sits in.
  function pullToCamera(x0, z0, x, z) {
    const dx = x - x0;
    const dz = z - z0;
    const len = Math.hypot(dx, dz);
    const k = Math.max(0, len - C.standoffM) / (len || 1);
    return [x0 + dx * k, z0 + dz * k];
  }

  // The sight carve. A decoded tag was seen *whole*, so the provably clear
  // region is not a line — it is the cone from the camera to the tag's full
  // width. Carved as the triangle from the camera to the tag's two extreme
  // corners (the pair subtending the widest bearing), at full evidence:
  // exactly as attested as the centre ray, unlike the reduced-weight frustum
  // wedges between tags.
  function carveSightWedge(cam, m, scale, vpKey, touched, clips) {
    const x0 = cam[0];
    const z0 = cam[2];
    const cdx = m.p[0] - x0;
    const cdz = m.p[2] - z0;
    if (Math.hypot(cdx, cdz) <= C.standoffM) return;
    const h = tagSizeM / 2;
    let left = null;
    let right = null;
    let lv = Infinity;
    let rv = -Infinity;
    for (const [sx, sy] of [[h, h], [h, -h], [-h, h], [-h, -h]]) {
      const c = quatRotate(m.q, [sx, sy, 0]);
      const px = m.p[0] + c[0];
      const pz = m.p[2] + c[2];
      const cross = (px - x0) * cdz - (pz - z0) * cdx;
      if (cross < lv) {
        lv = cross;
        left = [px, pz];
      }
      if (cross > rv) {
        rv = cross;
        right = [px, pz];
      }
    }
    const L = pullToCamera(x0, z0, left[0], left[1]);
    const R = pullToCamera(x0, z0, right[0], right[1]);
    // Widen the apex to the pose-uncertainty envelope, perpendicular to the
    // centre ray, and cover the trapezoid as two triangles (the per-report
    // touched set keeps the shared edge from double-counting).
    const clen = Math.hypot(cdx, cdz);
    const px = -cdz / clen * C.apexHalfM;
    const pz = cdx / clen * C.apexHalfM;
    const A1 = [x0 + px, z0 + pz];
    const A2 = [x0 - px, z0 - pz];
    const full = C.lMiss * scale;
    const repeat = C.lMissRepeat * scale;
    carveTriangle(A1[0], A1[1], L, R, full, repeat, vpKey, touched, clips);
    carveTriangle(A1[0], A1[1], R, A2, full, repeat, vpKey, touched, clips);
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
      if (j && !j.stale) {
        // A measured-bad pose is the one case still rejected outright.
        if (j.jitterMm > C.maxJitterMm) return reject(stats.reports, 'jitterOver'), false;
        weight = 1 / (1 + (j.jitterMm / C.softJitterMm) ** 2);
      } else {
        // Null or stale: no measurement, not a clean one — scored down, not
        // thrown away.
        weight = C.noJitterW;
      }
    }
    stats.reports.accepted++;

    const scale = (entry.kind === 'pose' ? C.tagonlyScale : 1) * weight;
    const cam = room.pose.p;
    // One frame = one facing (the camera's own forward, not per-tag bearing),
    // so a single multi-tag frame is still exactly one viewpoint.
    const fwd = quatRotate(room.pose.q, [0, 0, 1]);
    const sector = Math.round(
      (Math.atan2(fwd[0], fwd[2]) + Math.PI) / (2 * Math.PI / C.viewSectors)) % C.viewSectors;
    const vpKey = cellKey(
      Math.round(cam[0] / C.viewCellM), Math.round(cam[2] / C.viewCellM))
      * C.viewSectors + sector;
    // Cells that took direct ray evidence this report, so the frustum pass
    // below cannot hand the same cell the same observation twice.
    const touched = new Set();
    // The camera is somewhere, and that somewhere is not inside a wall.
    bump(Math.floor(cam[0] / C.cellM), Math.floor(cam[2] / C.cellM),
      C.lMiss * scale, C.lMissRepeat * scale, vpKey, touched);

    const rays = [];   // accepted endpoints + weights for the frustum pass
    for (const t of msg.tags || []) {
      stats.rays.total++;
      const m = tags.get(t.id);
      if (!m) { reject(stats.rays, 'unmapped'); continue; }
      const dist = Math.hypot(t.tvec[0], t.tvec[1], t.tvec[2]);
      // Viewing angle in the *room* frame against the mapped normal — signed,
      // because "behind the wall the tag is on" is a pose error, not a view.
      const v = [cam[0] - m.p[0], cam[1] - m.p[1], cam[2] - m.p[2]];
      const d3 = Math.hypot(v[0], v[1], v[2]);
      if (!(d3 > 1e-6)) { reject(stats.rays, 'shape'); continue; }
      const n = quatRotate(m.q, [0, 0, 1]);
      const cos = (v[0] * n[0] + v[1] * n[1] + v[2] * n[2]) / d3;
      if (cos < 0) { reject(stats.rays, 'behind'); continue; }
      if (cos < C.cosMin) { reject(stats.rays, 'grazing'); continue; }
      const horiz = Math.hypot(v[0], v[2]);
      if (horiz < C.minHorizM || Math.abs(v[1]) > C.maxSlope * horiz) {
        reject(stats.rays, 'shape');
        continue;
      }
      // The quality score: how much this sighting's evidence is worth.
      const rayW = (1 / (1 + (t.err / C.errSoftPx) ** 2))
        * (1 / (1 + (dist / C.distSoftM) ** 2))
        * (t.px != null ? 1 / (1 + (C.pxSoft / t.px) ** 2) : 1)
        * Math.min(1, cos / C.cosSoft);
      stats.rays.accepted++;
      stats.rays.wSum = (stats.rays.wSum || 0) + rayW;
      rays.push({ m, x: m.p[0], z: m.p[2], w: rayW });
    }
    // Carve strongest ray first: the per-report dedupe is first-writer-wins,
    // so where two wedges overlap, order decides which sighting's weight the
    // shared cells get — and it must be the best one, not whichever tag
    // happened to come first in the message.
    rays.sort((a, b) => b.w - a.w);
    const clips = wallPlanes();
    for (const r of rays) {
      carveSightWedge(cam, r.m, scale * r.w, vpKey, touched, clips);
      // The far end is the wall the tag is mounted on. Not added to
      // `touched`: the frustum must not carve the wall cell, and it cannot —
      // the wedge corners are pulled a standoff short of the tags.
      bump(Math.floor(r.x / C.cellM), Math.floor(r.z / C.cellM),
        C.lHit * scale * r.w, C.lHitRepeat * scale * r.w, vpKey);
    }
    if (rays.length >= 2 && C.frustumScale > 0 && !frustumVps.has(vpKey)) {
      frustumVps.add(vpKey);
      carveFrustum(cam, rays, scale, vpKey, touched, clips);
    }
    if (file) scheduleSave();
    return true;   // the camera cell took evidence even if every ray failed
  }

  // Wedges between pairs of accepted rays from one viewpoint. Each wedge
  // corner is pulled a standoff toward the camera, so like the rays the
  // frustum never carves the wall band the tags sit in.
  function carveFrustum(cam, rays, scale, vpKey, touched, clips) {
    const maxCos = Math.cos(C.frustumMaxDeg * Math.PI / 180);
    const x0 = cam[0];
    const z0 = cam[2];
    const pulled = rays.map(({ x, z, w }) => {
      const dx = x - x0;
      const dz = z - z0;
      const len = Math.hypot(dx, dz);
      const k = Math.max(0, len - C.standoffM) / (len || 1);
      return { x: x0 + dx * k, z: z0 + dz * k, ux: dx / (len || 1), uz: dz / (len || 1), w };
    });
    for (let i = 0; i < pulled.length; i++) {
      for (let k = i + 1; k < pulled.length; k++) {
        const a = pulled[i];
        const b = pulled[k];
        if (a.ux * b.ux + a.uz * b.uz < maxCos) continue;   // wedge too wide
        // A wedge is only as trustworthy as the weaker of the two sightings
        // that bound it.
        const w = C.frustumScale * Math.min(a.w, b.w);
        carveTriangle(x0, z0, [a.x, a.z], [b.x, b.z],
          C.lMiss * scale * w, C.lMissRepeat * scale * w, vpKey, touched, clips);
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
        // Signed: same-facing only. See wallGroupGapM.
        if (cos >= CLIP_PARALLEL_COS && Math.abs(d) <= C.wallGroupGapM) union(a.id, b.id);
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

  // Tagless walls inferred from the carve silhouette. A wall with no tag on
  // it still shapes the free region: sweep each Manhattan orientation (rooms
  // are square to their tagged walls far more often than a free orientation
  // fit on a ragged edge is right) and take, per along-wall row, the extreme
  // free cell on each side. A stretch where that extreme holds steady is a
  // wall; a frontier wanders and breaks the run. One-sided by construction —
  // the extreme has nothing carved beyond it, and interior raggedness (the
  // scalloped edge a walk-and-pan leaves) never touches the silhouette.
  function inferWalls(freeSet, asserted) {
    if (!asserted.length || !freeSet.size) return [];
    const dirs = [];
    for (const s of asserted) {
      const dx = s.b[0] - s.a[0];
      const dz = s.b[1] - s.a[1];
      const L = Math.hypot(dx, dz);
      if (L < 0.5) continue;
      for (const d of [[dx / L, dz / L], [-dz / L, dx / L]]) {
        if (!dirs.some((e) => Math.abs(e[0] * d[1] - e[1] * d[0]) < Math.sin(10 * Math.PI / 180))) {
          dirs.push(d);
        }
      }
    }
    const pts = [];
    for (const key of freeSet) {
      const ix = Math.floor(key / GRID_SIDE) - GRID_HALF;
      const iz = (key % GRID_SIDE) - GRID_HALF;
      pts.push([(ix + 0.5) * C.cellM, (iz + 0.5) * C.cellM]);
    }
    const out = [];
    for (const d of dirs) {
      const n = [-d[1], d[0]];
      // sBin -> extreme v on each side of the free region.
      const vMax = new Map();
      const vMin = new Map();
      for (const p of pts) {
        const sBin = Math.round((p[0] * d[0] + p[1] * d[1]) / C.cellM);
        const v = p[0] * n[0] + p[1] * n[1];
        if (!vMax.has(sBin) || v > vMax.get(sBin)) vMax.set(sBin, v);
        if (!vMin.has(sBin) || v < vMin.get(sBin)) vMin.set(sBin, v);
      }
      for (const [rows, outSign] of [[vMax, 1], [vMin, -1]]) {
        const sBins = [...rows.keys()].sort((a, b) => a - b);
        const gapBins = C.wallGapM / C.cellM;
        let run = null;
        const flush = () => {
          if (!run) return;
          const len = (run.hi - run.lo) * C.cellM;
          const span = run.hi - run.lo + 1;
          if (len >= C.inferMinLenM && run.n / span >= C.inferRowFillFrac) {
            const v = run.vSum / run.n + outSign * C.cellM / 2;
            const lo = run.lo * C.cellM - C.cellM / 2;
            const hi = run.hi * C.cellM + C.cellM / 2;
            const mid = [
              (lo + hi) / 2 * d[0] + v * n[0],
              (lo + hi) / 2 * d[1] + v * n[1],
            ];
            // Against asserted walls AND already-emitted inferred ones — the
            // silhouette of a walk trail can put two parallel edges a cell
            // apart, and the second is an echo of the first, not a wall.
            const dup = [...asserted, ...out].some((s) => {
              const sx = s.b[0] - s.a[0];
              const sz = s.b[1] - s.a[1];
              const sl = Math.hypot(sx, sz) || 1;
              if (Math.abs((sx * d[1] - sz * d[0]) / sl) > Math.sin(15 * Math.PI / 180)) return false;
              const t = Math.max(0, Math.min(1,
                ((mid[0] - s.a[0]) * sx + (mid[1] - s.a[1]) * sz) / (sl * sl)));
              return Math.hypot(mid[0] - (s.a[0] + t * sx), mid[1] - (s.a[1] + t * sz))
                < C.inferMaxParallelDistM;
            });
            if (!dup) {
              out.push({
                a: [lo * d[0] + v * n[0], lo * d[1] + v * n[1]],
                b: [hi * d[0] + v * n[0], hi * d[1] + v * n[1]],
                y0: Math.min(...asserted.map((s) => s.y0)),
                y1: Math.max(...asserted.map((s) => s.y1)),
                ids: [],
                inferred: true,
              });
            }
          }
          run = null;
        };
        for (const sBin of sBins) {
          const v = rows.get(sBin);
          if (run && sBin - run.hi <= gapBins && Math.abs(v - run.vSum / run.n) <= C.inferVTolM) {
            run.hi = sBin;
            run.n++;
            run.vSum += v;
          } else {
            flush();
            run = { lo: sBin, hi: sBin, n: 1, vSum: v };
          }
        }
        flush();
      }
    }
    return out;
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
    rectifyWalls(walls);
    walls.push(...inferWalls(freeSet, walls));
    trimCrossings(walls);
    closeCorners(walls);
    dropEchoes(walls);
    forceClose(walls);
    return walls;
  }

  // Corner extension can stretch a short silhouette echo (the walk trail's
  // inner step) into a full-length twin of the wall beside it. An inferred
  // wall that lies entirely along a longer wall's line, within grouping
  // distance, is that wall seen twice — drop it before the outline closes
  // around both.
  function dropEchoes(walls) {
    const minSin = Math.sin(15 * Math.PI / 180);
    for (let i = walls.length - 1; i >= 0; i--) {
      const s = walls[i];
      if (!s.inferred) continue;
      const l = segLen(s);
      if (!l) {
        walls.splice(i, 1);
        continue;
      }
      const d = [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l];
      const echo = walls.some((o, j) => {
        if (j === i) return false;
        const ol = segLen(o);
        if (ol < l * 0.9) return false;
        const od = [(o.b[0] - o.a[0]) / ol, (o.b[1] - o.a[1]) / ol];
        if (Math.abs(d[0] * od[1] - d[1] * od[0]) > minSin) return false;
        const near = (p) => {
          const t = (p[0] - o.a[0]) * od[0] + (p[1] - o.a[1]) * od[1];
          if (t < -0.3 || t > ol + 0.3) return false;
          return Math.hypot(p[0] - (o.a[0] + od[0] * t), p[1] - (o.a[1] + od[1] * t))
            <= C.inferMaxParallelDistM;
        };
        return near(s.a) && near(s.b);
      });
      if (echo) walls.splice(i, 1);
    }
  }

  // The outline must close — an open end means the room leaks to infinity,
  // and a committed best guess beats an honest dangle (explicit user
  // decision; the floor layer still shows what was actually attested). After
  // the evidence-driven corner pass, every endpoint not resting on another
  // wall extends to its best remaining meeting point: the nearest forward
  // intersection with another wall's line, preferring ones near that wall's
  // actual span. Ends with no angled partner at all (parallel-only worlds)
  // are bridged straight to the nearest other open end.
  function forceClose(walls) {
    const tol = 0.08;
    const distToSeg = (p, s) => {
      const sx = s.b[0] - s.a[0];
      const sz = s.b[1] - s.a[1];
      const l2 = sx * sx + sz * sz;
      if (!l2) return Math.hypot(p[0] - s.a[0], p[1] - s.a[1]);
      const t = Math.max(0, Math.min(1,
        ((p[0] - s.a[0]) * sx + (p[1] - s.a[1]) * sz) / l2));
      return Math.hypot(p[0] - (s.a[0] + t * sx), p[1] - (s.a[1] + t * sz));
    };
    const isClosed = (p, self) => walls.some((s) => s !== self && distToSeg(p, s) <= tol);
    const minSin = Math.sin(15 * Math.PI / 180);
    // Bridges run only when a full pass of extensions and grows has nothing
    // left — a bridge consumes two open ends, and taken eagerly it steals an
    // end whose clean close (another wall growing to meet it) was one pass
    // away. That is exactly how a diagonal got drawn across the room.
    let guard = walls.length * 8;
    const pass = (allowBridge) => {
      let changed = false;
      for (const seg of walls) {
        const len = segLen(seg);
        if (!len) continue;
        const d = [(seg.b[0] - seg.a[0]) / len, (seg.b[1] - seg.a[1]) / len];
        for (const end of ['a', 'b']) {
          const p = seg[end];
          if (isClosed(p, seg)) continue;
          const dir = end === 'b' ? d : [-d[0], -d[1]];
          let best = null;
          for (const other of walls) {
            if (other === seg) continue;
            const ol = segLen(other);
            if (!ol) continue;
            const od = [(other.b[0] - other.a[0]) / ol, (other.b[1] - other.a[1]) / ol];
            const cross = dir[0] * od[1] - dir[1] * od[0];
            if (Math.abs(cross) < minSin) continue;
            // Where this end's own line meets the other's line, ahead of it.
            const ex = other.a[0] - p[0];
            const ez = other.a[1] - p[1];
            const t = (ex * od[1] - ez * od[0]) / cross;
            // Below tol is no progress — the end already sits on this line;
            // the on-line case below handles that by growing the other wall.
            if (t < tol || t > 20) continue;
            const P = [p[0] + t * dir[0], p[1] + t * dir[1]];
            // Never through carved space — a wall drawn across more than a
            // doorway of provably-free cells is the one guess worse than an
            // open end.
            if (pathFreeM(p, P) > C.closeThroughM) continue;
            // Landing near the other's actual span beats a distant meeting of
            // infinite lines; overshoot past its ends is scored, not banned.
            const to = (P[0] - other.a[0]) * od[0] + (P[1] - other.a[1]) * od[1];
            const overshoot = Math.max(0, -to, to - ol);
            const score = t + 2 * overshoot;
            if (!best || score < best.score) best = { p: P, score };
          }
          if (best) {
            seg[end] = best.p;
            seg.ext = { ...(seg.ext || {}), [end]: Math.round(
              Math.hypot(best.p[0] - p[0], best.p[1] - p[1]) * 100) / 100 };
            changed = true;
            continue;
          }
          // The end already lies on another wall's line, beyond its span —
          // the natural close is that wall growing to meet it (a T-junction
          // or shared corner), not this end going anywhere.
          let grown = false;
          for (const other of walls) {
            if (other === seg) continue;
            const ol = segLen(other);
            if (!ol) continue;
            const od = [(other.b[0] - other.a[0]) / ol, (other.b[1] - other.a[1]) / ol];
            const t = (p[0] - other.a[0]) * od[0] + (p[1] - other.a[1]) * od[1];
            const perp = Math.hypot(
              p[0] - (other.a[0] + od[0] * t), p[1] - (other.a[1] + od[1] * t));
            if (perp > tol * 2) continue;
            if (t >= -tol && t <= ol + tol) continue;   // already covered
            const P = [other.a[0] + od[0] * t, other.a[1] + od[1] * t];
            if (t < 0) other.a = P;
            else other.b = P;
            grown = true;
            break;
          }
          if (grown) {
            changed = true;
            continue;
          }
          if (allowBridge) {
            // Last resort: connect to another open end — straight if the
            // straight line is clean, else an axis elbow along one of the
            // two walls' own directions. Every leg respects the same
            // carved-space limit; if no route is clean, the end stays open.
            const opens = [];
            for (const other of walls) {
              if (other === seg) continue;
              for (const oe of ['a', 'b']) {
                if (isClosed(other[oe], other)) continue;
                const q = other[oe];
                const dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
                if (dist > 0.01) opens.push({ q, other, oe, dist });
              }
            }
            opens.sort((x, y) => x.dist - y.dist);
            const connector = (a, b) => ({
              a: [...a], b: [...b], y0: seg.y0, y1: seg.y1, ids: [], inferred: true,
            });
            let done = false;
            for (const { q, other, oe } of opens) {
              if (pathFreeM(p, q) <= C.closeThroughM) {
                walls.push(connector(p, q));
                done = true;
                break;
              }
              const ol = segLen(other);
              const odr = ol
                ? [(other.b[0] - other.a[0]) / ol, (other.b[1] - other.a[1]) / ol]
                : null;
              const qdir = odr ? (oe === 'b' ? odr : [-odr[0], -odr[1]]) : null;
              for (const [o, dd, r] of [[p, dir, q], qdir ? [q, qdir, p] : null].filter(Boolean)) {
                const t = (r[0] - o[0]) * dd[0] + (r[1] - o[1]) * dd[1];
                if (t <= tol) continue;
                const corner = [o[0] + dd[0] * t, o[1] + dd[1] * t];
                if (pathFreeM(o, corner) > C.closeThroughM
                  || pathFreeM(corner, r) > C.closeThroughM) continue;
                walls.push(connector(o, corner), connector(corner, r));
                done = true;
                break;
              }
              if (done) break;
            }
            if (done) changed = true;
          }
        }
      }
      return changed;
    };
    while (guard-- > 0) {
      if (pass(false)) continue;
      if (!pass(true)) break;
    }
  }

  // Snap near-right angles to right angles. Reference is the anchor tag's
  // wall — the room datum — and every wall within cornerSnapDeg of its 90°
  // grid is rotated exactly onto it. Runs before inference and cornering, so
  // inferred walls are born on the rectified grid and corners meet at true
  // right angles instead of 88.6°.
  function rectifyWalls(walls) {
    if (walls.length < 2) return;
    const ref = walls.find((w) => w.ids.includes(anchorId))
      || walls.reduce((a, b) => (segLen(b) > segLen(a) ? b : a));
    const refAng = Math.atan2(ref.b[1] - ref.a[1], ref.b[0] - ref.a[0]);
    const snap = C.cornerSnapDeg * Math.PI / 180;
    for (const w of walls) {
      if (w === ref) continue;
      const ang = Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]) - refAng;
      const dev = ang - Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
      if (Math.abs(dev) > snap || Math.abs(dev) < 1e-6) continue;
      const members = w.ids.map((id) => tags.get(id)).filter(Boolean);
      const pivot = members.length
        ? [
          members.reduce((s, m) => s + m.p[0], 0) / members.length,
          members.reduce((s, m) => s + m.p[2], 0) / members.length,
        ]
        : [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
      const c = Math.cos(-dev);
      const s = Math.sin(-dev);
      for (const end of ['a', 'b']) {
        const dx = w[end][0] - pivot[0];
        const dz = w[end][1] - pivot[1];
        w[end] = [pivot[0] + dx * c - dz * s, pivot[1] + dx * s + dz * c];
      }
    }
  }

  function segLen(w) {
    return Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
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

  // Metres of carved-free space the straight path between two points crosses.
  // Corner closure tolerates up to a doorway's width of it and no more.
  // Reads raw cell state on purpose: through-the-doorway cells are usually
  // below the island threshold, and they are the evidence here. Samples a
  // band (±1.5 cells), not the line: the line itself can thread an uncarved
  // seam — a wall plane's standoff strip — while the space either side of it
  // is provably open, and that is exactly a wall being drawn through a room.
  function pathFreeM(a, b) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) return 0;
    const nx = -(b[1] - a[1]) / len;
    const nz = (b[0] - a[0]) / len;
    const side = C.cellM * 1.5;
    const step = C.cellM / 2;
    const steps = Math.max(1, Math.ceil(len / step));
    let free = 0;
    for (let i = 1; i < steps; i++) {
      const x = a[0] + (b[0] - a[0]) * (i / steps);
      const z = a[1] + (b[1] - a[1]) * (i / steps);
      if (stateAt(x, z) === 1
        || stateAt(x + nx * side, z + nz * side) === 1
        || stateAt(x - nx * side, z - nz * side) === 1) free += step;
    }
    return free;
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
    // Enclosed unknown pockets fill in as free — see islandFillCells. BFS
    // from each unknown cell bordering the kept set; a pocket that stays
    // small, touches no occupied cell, and is walled in by free cells on
    // every side is speckle, not structure. The frontier outside the carved
    // region blows past the size cap immediately and is left alone (its
    // cells are marked visited so each seed pays the cap at most once).
    const visited = new Set();
    const fill = [];
    for (const key of [...kept]) {
      const ix = Math.floor(key / GRID_SIDE) - GRID_HALF;
      const iz = (key % GRID_SIDE) - GRID_HALF;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const seed = cellKey(ix + dx, iz + dz);
        if (kept.has(seed) || visited.has(seed)) continue;
        const comp = [seed];
        visited.add(seed);
        let ok = cells.get(seed)?.state !== 2;
        for (let i = 0; i < comp.length && ok; i++) {
          const k = comp[i];
          const kx = Math.floor(k / GRID_SIDE) - GRID_HALF;
          const kz = (k % GRID_SIDE) - GRID_HALF;
          for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = cellKey(kx + ddx, kz + ddz);
            if (kept.has(nk) || visited.has(nk)) continue;
            visited.add(nk);
            comp.push(nk);
            if (cells.get(nk)?.state === 2) ok = false;
            if (comp.length > C.islandFillCells) ok = false;
          }
        }
        if (ok && comp.length <= C.islandFillCells) fill.push(...comp);
      }
    }
    for (const k of fill) kept.add(k);
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
        // corner, approached from opposite sides. An inferred wall has no
        // tags; its whole run is attested, so it only ever extends.
        const need = (t, len, tagTs) => {
          if (t < 0) return { end: 'a', ext: -t };
          if (t > len) return { end: 'b', ext: t - len };
          if (tagTs.length && tagTs.every((tt) => tt < t) && len - t <= C.cornerTrimM) {
            return { end: 'b', ext: 0 };
          }
          if (tagTs.length && tagTs.every((tt) => tt > t) && t <= C.cornerTrimM) {
            return { end: 'a', ext: 0 };
          }
          return { end: null, ext: 0 };
        };
        const n1 = need(t1, l1, tagTsOf(s1, s1.a, d1));
        const n2 = need(t2, l2, tagTsOf(s2, s2.a, d2));
        if (n1.ext > C.cornerMaxExtendM || n2.ext > C.cornerMaxExtendM) continue;
        if (!n1.end && !n2.end) continue;   // they already meet
        // An end's extension may span a doorway's worth of carved-free path
        // (walls close by policy) but no more, and never a third wall.
        // Blocked per end, not per pair: the partner pulling its overhang
        // back to the shared line is still right even when this side cannot
        // reach the corner.
        const pathBlocked = (seg, n) => {
          const from = n.end === 'a' ? seg.a : seg.b;
          if (pathFreeM(from, P) > C.closeThroughM) return true;
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
      const state = L >= C.occOn ? 2
        : ((L <= C.freeOn && views >= C.minViews) || L <= C.freeOnSingle ? 1 : 0);
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
      rays: {
        ...stats.rays,
        rej: { ...stats.rays.rej },
        meanW: stats.rays.accepted
          ? Math.round((stats.rays.wSum || 0) / stats.rays.accepted * 100) / 100
          : null,
      },
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
    // Raw cell state for offline diagnosis (replay tooling only — the live
    // paths never read it).
    debugCellAt(x, z) {
      const c = cells.get(cellKey(Math.floor(x / C.cellM), Math.floor(z / C.cellM)));
      return c ? { L: c.L, views: c.views, state: c.state } : null;
    },
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
