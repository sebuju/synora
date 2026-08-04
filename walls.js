'use strict';

const fs = require('fs');
const path = require('path');
const {
  quatRotate, tagPlaneAgreement, CLIP_PLANE_M, CLIP_PARALLEL_COS,
  se3Invert, transformPoint,
} = require('./public/pose-math.js');

// Free-space carving from tag sightings. Every accepted camera→tag ray proves
// the line of sight was empty — the camera decoded the tag through it — and
// that the tag's wall is at the far end. That is the entire evidence model:
// no depth, no assumption that unseen space is empty. Unknown stays unknown;
// the output only ever claims "attested free".
//
// The depth exclusion is measured, not inherited: past 3 m ARCore's depth is
// 0.9-1.7 m out (.claude/rules/depth.md), which is the removed mapping
// pipeline's failure on a newer source, and a wall is exactly the far-range
// claim that error lands on. Landmark rays are the one route by which
// anything depth-derived could reach this grid and they ship inert
// (landmarkScale 0); even switched on they carve line of sight only and their
// far end asserts nothing.
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
  // Landmark rays (room.landmarkRays on a landmark-confirmed 'tracked' frame):
  // camera → inlier landmark, free space along the line of sight only — the
  // far end asserts nothing (a landmark may be the corner of a chair), so no
  // occupancy bump, no wall plane, no sight record, no frustum. Ships at 0 =
  // inert; turned on by a replay sweep against a kitchen walk, never by
  // argument (wall evidence is as permanent as markers.json).
  landmarkScale: 0,
  // Half-width of a landmark ray's wedge at its far end. A point has no
  // corners to subtend, so the wedge is the ray widened to one grid cell.
  landmarkHalfM: 0.06,
  // Stage-4 scoping of leaks(): a tagged wall whose far side holds at least
  // this many distinct landmark-ray endpoint cells has a legitimately surveyed
  // far side, and behind-cells there are no longer wrong by construction.
  landmarkFarsideMin: 3,
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
  // The carve veto (see wallPlanes): how far a mapped tag's plane reaches,
  // and how far behind a plane a point must be to count as having crossed it.
  // vetoCrossM is matched to wallGroupGapM deliberately — a tag that far off
  // its wall-mates' plane is still the same wall, so solve noise must not let
  // wall-mates waive each other's veto.
  vetoRadiusM: 1.2,
  vetoCrossM: 0.25,
  // Negative evidence: a mapped tag that should be comfortably in frame but
  // was not detected deposits weak occupancy along the camera→tag ray. Where
  // on the ray the obstruction sits is unknowable from one sighting, so the
  // evidence lives in a separate per-cell accumulator (Ln) that can never
  // touch L/state — "deduced" is a third read-time class, not a promotion
  // path, and a cell later carved free suppresses it automatically. XR only:
  // the frustum test needs the per-frame intrinsics and the pose trust needs
  // the jitter measurement, and the tag-only path ships neither.
  negScale: 1,             // master switch; 0 disables the whole pass
  // Stricter than the positive path on purpose: there jitter null/stale is
  // scored down (noJitterW) because a tag still confirmed the very frame.
  // Here nothing confirms the frame — the claim rests on the pose alone, so
  // the jitter measurement must exist, be fresh, and be small.
  negMaxJitterMm: 60,
  // A zero-tag frame is a guaranteed full-frame sweep (the detector retries
  // full-frame when a crop comes up empty) but nothing cross-checked the
  // pose this frame; a 'good' frame missing one expected tag has a confirmed
  // pose but only scanned-rect coverage. Both are real evidence, the
  // tag-less kind carries less.
  negTrackedScale: 0.5,
  // "Should have been detected" gates — all stricter than the positive
  // path's soft points, because a marginal sighting failing to decode is
  // ordinary, and only a comfortable one failing means something was in the
  // way.
  negMinZM: 0.3,           // camera-frame depth floor for the projection test
  negEdgeFrac: 0.12,       // frame-border inset: edge detections are
                           // unreliable, so edge non-detections prove nothing
  negMinPx: 70,            // expected px = fx·tagSize/z, well above pxSoft
  negMaxDistM: 4.5,        // vs distSoftM 8
  negMinCos: 0.35,         // vs cosSoft 0.25 — glancing tags legitimately fail
  negCamClearM: 0.3,       // the user's own hand/body hugs the camera
  // Ln increments. occOn-equivalent here is dedOn: one viewpoint staring at
  // a blocked tag must never promote on its own (lBlocked · lnMax repeats
  // from one spot still sits below dedOn · negMinViews), only crossing rays
  // from distinct viewpoints concentrate enough.
  lBlocked: 0.3,
  lBlockedRepeat: 0.03,
  lnMax: 4,
  dedOn: 1.0,              // Ln at which an unknown cell renders deduced
  negMinViews: 3,          // distinct viewpoints before deduced may show
  // Enclosed never-visited pockets: bigger than the free-fill limit
  // (islandFillCells — speckle and wedge shadows) but still furniture-sized
  // read as deduced obstructions; bigger than this is unexplored world.
  dedMaxCells: 1200,       // ≈ 4.3 m² at 6 cm cells
};

const GRID_HALF = 2048;
const GRID_SIDE = GRID_HALF * 2;
const WALLS_VERSION = 3;
const SAVE_DEBOUNCE_MS = 10000;

function createWalls({ file, log, markerSizeM, opts } = {}) {
  const C = { ...DEFAULTS, ...(opts || {}) };
  const vetoR2 = C.vetoRadiusM ** 2;
  // How many distinct viewpoints must have looked through a spot before a wall
  // is cut there. Follows minViews — the same viewpoint-diversity bar that
  // promotes a cell to free — and exists as its own name only so a replay can
  // disable the cut without also changing what carving counts as free.
  const sightMinViews = C.sightMinViews ?? C.minViews;
  // key -> { L, views, vp, state, Ln, nviews, nvp } — log-odds, distinct-
  // viewpoint count, last viewpoint key (single slot), 0 unknown / 1 free /
  // 2 occupied; then the negative-evidence twin: blocked-ray log-odds (≥ 0)
  // with its own viewpoint pair. Separate slots, not shared — a positive and
  // a negative bump in one frame must not clobber each other's freshness
  // test, and Ln must never leak into the free/occ hysteresis.
  const cells = new Map();
  // `${viewpoint cell}:${tag id}` -> { ax, az, bx, bz, vp } — one proven line
  // of sight per viewpoint per tag. A decoded tag means the straight line to
  // it was empty, so no wall may ever be drawn across one. Deduped by the
  // existing viewpoint quantisation (viewCellM): that only bounds how many
  // lines are kept, it never decides whether a wall is cut.
  const sights = new Map();
  // Distinct cells holding an accepted landmark-ray endpoint. A tagged wall
  // these fall behind (within its bracket) has a legitimately surveyed far
  // side, which is what scopes leaks() — behind-cells there stop being wrong
  // by construction the day the room past the wall is actually walked.
  // Persisted with the grid: the claim is as durable as the carves it earned.
  const landmarkEnds = new Set();
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
    // Landmark rays keep their own books — they arrive on frames the report
    // gates above reject (quality 'tracked'), so folding them into rays would
    // make both counts unreadable.
    landmarkRays: { total: 0, accepted: 0, rej: {}, wSum: 0 },
    // Negative evidence keeps its own books: reports = frames considered for
    // the pass, tags = expected-but-missing tag tests within accepted frames.
    neg: {
      reports: { total: 0, accepted: 0, rej: {} },
      tags: { total: 0, deposited: 0, rej: {}, wSum: 0 },
    },
    // Veto plane-tests offered to a wedge vs. waived by the sight-line rule —
    // the only cheap window into a decision taken per cell.
    veto: { planes: 0, waived: 0 },
  };
  function reject(bucket, reason) {
    bucket.rej[reason] = (bucket.rej[reason] || 0) + 1;
  }

  function cellKey(ix, iz) {
    return (ix + GRID_HALF) * GRID_SIDE + (iz + GRID_HALF);
  }

  function newCell() {
    return { L: 0, views: 0, vp: -1, state: 0, Ln: 0, nviews: 0, nvp: -1 };
  }

  function bump(ix, iz, full, repeat, vpKey, touched) {
    if (ix < -GRID_HALF || ix >= GRID_HALF || iz < -GRID_HALF || iz >= GRID_HALF) return;
    const key = cellKey(ix, iz);
    if (touched) touched.add(key);
    let c = cells.get(key);
    if (!c) cells.set(key, c = newCell());
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

  // The negative twin of bump: accumulates blocked-ray evidence in Ln and
  // nothing else — L, views and state are structurally out of reach, so
  // negative evidence can never carve, un-carve, or promote a measured cell.
  // Shares the per-report touched set as a *reader*: a cell that took
  // positive evidence this frame provably had clear line of sight, and a
  // blocked ray claiming it in the same frame would contradict it.
  function bumpNeg(ix, iz, full, repeat, vpKey, touched) {
    if (ix < -GRID_HALF || ix >= GRID_HALF || iz < -GRID_HALF || iz >= GRID_HALF) return;
    const key = cellKey(ix, iz);
    if (touched.has(key)) return;
    touched.add(key);
    let c = cells.get(key);
    if (!c) cells.set(key, c = newCell());
    const fresh = c.nvp !== vpKey;
    if (fresh) {
      c.nvp = vpKey;
      c.nviews++;
    }
    c.Ln = Math.min(C.lnMax, c.Ln + (fresh ? full : repeat));
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
          if ((cx - c.px) ** 2 + (cz - c.pz) ** 2 >= vetoR2) return false;
          const s = planeAlong(c, cx, cz);
          return s >= c.sLo && s <= c.sHi && planeFront(c, cx, cz) < 0;
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
  // effective within vetoRadiusM of its tag. A carve cell behind one of these
  // is a wall being carved through — the widened apex and the wedge side edges
  // both managed it near corners before this was checked per cell.
  //
  // The radius is an assumption about how far the wall runs, and it is the
  // weakest evidence in the module: a tag beside a doorway asserts wall right
  // across the opening. So a plane may only veto a wedge that never crossed
  // it (see the camClips/r.clips filter in handleReport) — a sighting through
  // the plane, or a camera standing behind it, is direct evidence the wall
  // does not extend there, and the whole module rests on a sighting proving
  // its own line of sight. Measured: tag 5 sits 1.18 m behind tag 3's plane
  // through an opening, and its entire front band fell inside tag 3's disc,
  // leaving ~1.3 m² of alcove permanently unknown.
  //
  // What the sighting does *not* outrank is the stretch its own plane group's
  // tags *bracket*: a tag at each end is wall attested at both ends, which is
  // the same evidence leaks() is built on, and no sighting may punch through
  // it. `crossed` is the plane narrowed to exactly that interval (a lone tag
  // keeps its own footprint, extended half a cell so a centre-sampled cell
  // cannot straddle out of it).
  //
  // Both halves were measured. Waiving the footprint let rays grazing past
  // tag 3 toward tag 5 carve 10-16 cm into the wall behind it (2 leak cells).
  // Waiving the bracket was far worse: sightings of tag 0 taken from behind
  // the [2 6] wall carved a 1.0 x 1.1 m hole through its middle, 123 leak
  // cells over 58 journals. The doorway past the end tag is outside the
  // bracket and still opens, which is the whole point — that is where the
  // sight line to tag 4 crosses.
  function wallPlanes() {
    if (!planeGroups) planeGroups = groupPlanes();
    const planes = [];
    const foot = tagSizeM / 2 + C.cellM / 2;
    for (const group of planeGroups) {
      for (const m of group) {
        const n = quatRotate(m.q, [0, 0, 1]);
        const nh = Math.hypot(n[0], n[2]);
        if (nh < 0.7) continue;
        const p = {
          px: m.p[0], pz: m.p[2], nx: n[0] / nh, nz: n[2] / nh,
          sLo: -Infinity, sHi: Infinity,
        };
        let lo = -foot;
        let hi = foot;
        for (const o of group) {
          const s = planeAlong(p, o.p[0], o.p[2]);
          lo = Math.min(lo, s - foot);
          hi = Math.max(hi, s + foot);
        }
        p.crossed = { ...p, sLo: lo, sHi: hi };
        // An empty interval: the plane is present in the list (indices stay
        // aligned with wallPlanes' order) but can never match a cell.
        p.none = { ...p, sLo: 1, sHi: -1 };
        planes.push(p);
      }
    }
    return planes;
  }

  // Signed distance of (x, z) in front of a veto plane; negative is behind it.
  function planeFront(c, x, z) {
    return (x - c.px) * c.nx + (z - c.pz) * c.nz;
  }

  // Offset of (x, z) along the plane from the tag it was built from.
  function planeAlong(c, x, z) {
    return (z - c.pz) * c.nx - (x - c.px) * c.nz;
  }

  // How much of a plane a wedge has to answer to, from which side of it the
  // wedge's ends are. Both ends behind: the whole wedge is on the far side and
  // cannot cross the wall at all (the apex widens perpendicular to the ray, so
  // it cannot reach back across vetoCrossM) — the plane is irrelevant, and
  // insisting otherwise would make the far side of a tagged wall permanently
  // uncarvable, which is wrong the day that room gets surveyed too. One end
  // each side: the wedge does cross, and the sighting proves a hole — but not
  // through the stretch the group's own tags bracket. Both in front: the
  // original case, full reach.
  function clipFor(c, camBehind, tagBehind) {
    if (camBehind && tagBehind) return c.none;
    return camBehind || tagBehind ? c.crossed : c;
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

  // A decoded tag proves the straight line to it was empty. That is the same
  // fact the carve is built on, kept in its geometric form rather than
  // rasterised, because the question it answers at emit time is geometric: did
  // this wall cross a line somebody looked along? A cell test cannot answer it
  // — a wall legitimately borders the free cells in front of it, and the
  // drawn line runs through that boundary row. Pulled a standoff short at the
  // tag end (the same pull the wedge takes), so a line never reaches the wall
  // its own tag is mounted on.
  function recordSight(vpCell, cam, m) {
    const key = `${vpCell}:${m.id}`;
    if (sights.has(key)) return;
    const end = pullToCamera(cam[0], cam[2], m.p[0], m.p[2]);
    sights.set(key, { ax: cam[0], az: cam[2], bx: end[0], bz: end[1], vp: vpCell, id: m.id });
  }

  // A line must not be allowed to cut the wall its own tag is mounted on. It
  // approaches that wall by definition, and at a shallow angle it clips the
  // segment a few centimetres from its own endpoint — which shredded real
  // walls into 0.01-0.12 m confetti. It says nothing about that wall's extent;
  // about every *other* wall it is exactly the evidence wanted.
  //
  // Asked geometrically, not by tag id, so it also covers an inferred segment
  // lying along a tagged plane (ids: [], and shredded just the same). Same
  // question and same threshold as the plane grouping: is this tag on this
  // wall?
  function sightCutsOwn(s, seg) {
    const len = segLen(seg);
    if (!len) return false;
    const nx = -(seg.b[1] - seg.a[1]) / len;
    const nz = (seg.b[0] - seg.a[0]) / len;
    return Math.abs((s.bx - seg.a[0]) * nx + (s.bz - seg.a[1]) * nz) <= C.wallGroupGapM;
  }

  // Bins along a segment that a viewpoint quorum looked through — the doorway,
  // measured rather than tolerated. Binned at the grid's own cellM and cut at
  // sightMinViews distinct viewpoints; both are the module's existing units.
  // Shared by the clip and by the metric that audits it, so the number can
  // never be reporting a different rule than the one that ran.
  function sightCutBins(seg) {
    const len = segLen(seg);
    const cut = new Map();
    if (!len) return cut;
    for (const s of sights.values()) {
      if (sightCutsOwn(s, seg)) continue;
      const hit = segIntersect(seg.a, seg.b, [s.ax, s.az], [s.bx, s.bz]);
      if (!hit || !(hit.t1 > 0 && hit.t1 < 1 && hit.t2 > 0 && hit.t2 < 1)) continue;
      const bin = Math.floor(hit.t1 * len / C.cellM);
      let vps = cut.get(bin);
      if (!vps) cut.set(bin, vps = new Set());
      vps.add(s.vp);
    }
    return cut;
  }

  // Distinct viewpoints whose line of sight properly crosses p--q. Counted by
  // viewpoint, not by line: staring from one spot must never be able to cut a
  // wall, exactly as one viewpoint cannot promote a cell to free. Strict
  // inequalities — a line ending on a wall is a wall being seen, not a wall
  // being seen through.
  function sightCrossings(p, q, seg) {
    const minX = Math.min(p[0], q[0]);
    const maxX = Math.max(p[0], q[0]);
    const minZ = Math.min(p[1], q[1]);
    const maxZ = Math.max(p[1], q[1]);
    const vps = new Set();
    for (const s of sights.values()) {
      if (vps.has(s.vp) || (seg && sightCutsOwn(s, seg))) continue;
      if (Math.max(s.ax, s.bx) < minX || Math.min(s.ax, s.bx) > maxX) continue;
      if (Math.max(s.az, s.bz) < minZ || Math.min(s.az, s.bz) > maxZ) continue;
      const hit = segIntersect(p, q, [s.ax, s.az], [s.bx, s.bz]);
      if (hit && hit.t1 > 0 && hit.t1 < 1 && hit.t2 > 0 && hit.t2 < 1) vps.add(s.vp);
    }
    return vps.size;
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

  // The jitter score of an xr-pose report — one implementation for the tag
  // path and the landmark-ray path, or the two silently drift apart. Null
  // means rejected outright (a measured-bad pose); null-or-stale jitter is no
  // measurement, not a clean one, and is scored down instead of thrown away.
  function jitterWeight(entry) {
    if (entry.kind !== 'xr-pose') return 1;
    const j = entry.room.jitter;
    if (j && !j.stale) {
      if (j.jitterMm > C.maxJitterMm) return null;
      return 1 / (1 + (j.jitterMm / C.softJitterMm) ** 2);
    }
    return C.noJitterW;
  }

  // The landmark-ray carve: free space along camera → inlier landmark, and
  // nothing else. The far end asserts nothing — a landmark may be the corner
  // of a chair — so unlike a tag ray there is no occupancy bump, no wall
  // plane, no recorded sight and no frustum; the one thing the endpoint does
  // is scope leaks() via landmarkEnds. Weight mirrors rayW minus the plane
  // terms (a point has no normal and no apparent size): the solve's
  // reprojection residual stands in for the tag's corner error, distance
  // softens the same way. The wall-plane veto is consumed identically —
  // that is what lets a doorway ray cross the [2 6] plane outside the tag
  // bracket while the bracket stays inviolable — but landmark rays never
  // contribute a plane of their own.
  function carveLandmarkRays(entry, cam, vpKey, touched) {
    const w = jitterWeight(entry);
    if (w === null) return 0;
    // XR-only by the caller's gate, so no tagonlyScale term.
    const scale = C.landmarkScale * w;
    // The pose earned mapSafe, so the camera cell is evidence here too.
    bump(Math.floor(cam[0] / C.cellM), Math.floor(cam[2] / C.cellM),
      C.lMiss * scale, C.lMissRepeat * scale, vpKey, touched);
    const rays = [];
    for (const l of entry.room.landmarkRays) {
      stats.landmarkRays.total++;
      const p = l.p;
      if (!Array.isArray(p) || p.length !== 3) { reject(stats.landmarkRays, 'shape'); continue; }
      const v = [cam[0] - p[0], cam[1] - p[1], cam[2] - p[2]];
      const horiz = Math.hypot(v[0], v[2]);
      // Same conditioning gates as a tag ray: a near-vertical ray projects to
      // top-down noise. No cos gates — a point has no plane to face.
      if (horiz < C.minHorizM || Math.abs(v[1]) > C.maxSlope * horiz) {
        reject(stats.landmarkRays, 'shape');
        continue;
      }
      const dist = Math.hypot(v[0], v[1], v[2]);
      const rayW = (1 / (1 + ((l.res ?? 0) / C.errSoftPx) ** 2))
        * (1 / (1 + (dist / C.distSoftM) ** 2));
      stats.landmarkRays.accepted++;
      stats.landmarkRays.wSum += rayW;
      rays.push({ p, w: rayW });
    }
    // Strongest first: the per-report dedupe is first-writer-wins, same as
    // the tag rays.
    rays.sort((a, b) => b.w - a.w);
    const clips = wallPlanes();
    const camBehind = clips.map((c) => planeFront(c, cam[0], cam[2]) < -C.vetoCrossM);
    for (const r of rays) {
      const behind = clips.map((c) => planeFront(c, r.p[0], r.p[2]) < -C.vetoCrossM);
      const rc = clips.map((c, i) => clipFor(c, camBehind[i], behind[i]));
      carveLandmarkRay(cam, r.p, scale * r.w, vpKey, touched, rc);
      const ix = Math.floor(r.p[0] / C.cellM);
      const iz = Math.floor(r.p[2] / C.cellM);
      if (ix >= -GRID_HALF && ix < GRID_HALF && iz >= -GRID_HALF && iz < GRID_HALF) {
        landmarkEnds.add(cellKey(ix, iz));
      }
    }
    return rays.length;
  }

  // A point has no corners to subtend a wedge, so the ray is widened to a
  // fixed landmarkHalfM at the far end — pulled the same standoff short of
  // the point, with the same apex widening, covered by the same generic
  // carveTriangle pair.
  function carveLandmarkRay(cam, p, scale, vpKey, touched, clips) {
    const x0 = cam[0];
    const z0 = cam[2];
    if (Math.hypot(p[0] - x0, p[2] - z0) <= C.standoffM) return;
    const [ex, ez] = pullToCamera(x0, z0, p[0], p[2]);
    const dx = ex - x0;
    const dz = ez - z0;
    const len = Math.hypot(dx, dz);
    if (!(len > 1e-6)) return;
    const nx = -dz / len;
    const nz = dx / len;
    const L = [ex + nx * C.landmarkHalfM, ez + nz * C.landmarkHalfM];
    const R = [ex - nx * C.landmarkHalfM, ez - nz * C.landmarkHalfM];
    const A1 = [x0 + nx * C.apexHalfM, z0 + nz * C.apexHalfM];
    const A2 = [x0 - nx * C.apexHalfM, z0 - nz * C.apexHalfM];
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
    const cam = room.pose.p;
    // One frame = one facing (the camera's own forward, not per-tag bearing),
    // so a single multi-tag frame is still exactly one viewpoint.
    const fwd = quatRotate(room.pose.q, [0, 0, 1]);
    const sector = Math.round(
      (Math.atan2(fwd[0], fwd[2]) + Math.PI) / (2 * Math.PI / C.viewSectors)) % C.viewSectors;
    const vpCell = cellKey(
      Math.round(cam[0] / C.viewCellM), Math.round(cam[2] / C.viewCellM));
    const vpKey = vpCell * C.viewSectors + sector;
    if (room.quality !== 'good') {
      reject(stats.reports, 'quality');
      // One touched set shared between the landmark carve and the negative
      // pass: a cell a landmark ray just proved clear must not take a
      // blocked-ray deposit in the same frame — the same rule the wedge carve
      // applies below.
      const touched = new Set();
      let carved = 0;
      // Landmark rays arrive only on 'tracked' frames — by construction: the
      // cross-check that produces them runs where no tag confirmed — so their
      // branch lives inside the quality reject. Gated on the confirmation's
      // own outcome (safeVia) rather than mapSafe alone, so an alignFresh
      // 'tracked' frame with stale landmarkRays cannot exist (the server
      // builds the rays and the flag together).
      if (C.landmarkScale > 0 && entry.kind === 'xr-pose'
        && room.mapSafe === true && room.safeVia === 'landmark'
        && Array.isArray(room.landmarkRays) && room.landmarkRays.length
        && msg.source !== 'guess') {
        carved = carveLandmarkRays(entry, cam, vpKey, touched);
      }
      // A tag-less 'tracked' frame is the one non-'good' report the negative
      // pass wants: the detector provably swept the whole frame and found
      // nothing, exactly the "looking straight at where the tag should be"
      // case. negativePass carries its own, stricter gates.
      const deposits = negativePass(entry, cam, vpKey, touched);
      if ((carved || deposits) && file) scheduleSave();
      return carved > 0 || deposits > 0;
    }
    if (msg.source === 'guess') return reject(stats.reports, 'guess'), false;
    const weight = jitterWeight(entry);
    if (weight === null) return reject(stats.reports, 'jitterOver'), false;
    stats.reports.accepted++;

    const scale = (entry.kind === 'pose' ? C.tagonlyScale : 1) * weight;
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
      // The line of sight is proven from here on: the tag decoded, and the
      // camera is on the room side of its plane. The gates below are about
      // whether the *wedge* is well conditioned — a grazing or steep sighting
      // makes a poor carve but is no less proof that nothing stood in the way,
      // and a wall may not be drawn through it either. Measured on 60
      // journals: recording only past these gates left 23 walls standing in
      // lines somebody had looked along.
      recordSight(vpCell, cam, m);
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
    // A plane keeps its assumed reach only against a wedge that never crossed
    // it — see clipFor.
    const camBehind = clips.map((c) => planeFront(c, cam[0], cam[2]) < -C.vetoCrossM);
    stats.veto.planes += clips.length * (rays.length || 1);
    for (const r of rays) {
      r.behind = clips.map((c) => planeFront(c, r.x, r.z) < -C.vetoCrossM);
      r.clips = clips.map((c, i) => clipFor(c, camBehind[i], r.behind[i]));
      stats.veto.waived += r.clips.reduce((n, c, i) => n + (c === clips[i] ? 0 : 1), 0);
      carveSightWedge(cam, r.m, scale * r.w, vpKey, touched, r.clips);
      // The far end is the wall the tag is mounted on. Not added to
      // `touched`: the frustum must not carve the wall cell, and it cannot —
      // the wedge corners are pulled a standoff short of the tags.
      bump(Math.floor(r.x / C.cellM), Math.floor(r.z / C.cellM),
        C.lHit * scale * r.w, C.lHitRepeat * scale * r.w, vpKey);
    }
    if (rays.length >= 2 && C.frustumScale > 0 && !frustumVps.has(vpKey)) {
      frustumVps.add(vpKey);
      carveFrustum(cam, rays, scale, vpKey, touched, clips, camBehind);
    }
    // Negative evidence last, sharing `touched` as a reader: every cell the
    // wedges just carved provably had clear line of sight this frame, and a
    // blocked ray must not claim it in the same breath.
    negativePass(entry, cam, vpKey, touched);
    if (file) scheduleSave();
    return true;   // the camera cell took evidence even if every ray failed
  }

  // Expected-but-undetected tags. A mapped tag squarely inside the frame,
  // inside the region the detector actually scanned, facing the camera, near
  // and large — and still not decoded — means something stood in the line of
  // sight. Where on the ray is unknowable from one sighting, so weak Ln
  // evidence is spread along it and only rays crossing from distinct
  // viewpoints concentrate past dedOn (tomography, not measurement).
  //
  // Gated harder than the positive path on purpose. Positive evidence rides
  // on a decoded tag — the proof is in the message. This pass's claim rests
  // entirely on the pose being right, so: strict mapSafe (never the legacy
  // fallback), jitter present + fresh + small, and only 'good' frames or
  // tag-less 'tracked' ones — a tag-bearing frame that failed to reach
  // 'good' is exactly the suspicious case. The 'tracked' acceptance is
  // bounded without any clock: mapSafe on a tag-less frame is alignFresh
  // (≤ 2 s since a tag confirmed the alignment) and non-stale jitter
  // tightens that to ~1.5 s, so sustained blind staring stops contributing
  // on its own — and past the first frames it would be same-viewpoint
  // repeat evidence anyway.
  function negativePass(entry, cam, vpKey, touched) {
    const { msg, room } = entry;
    if (!(C.negScale > 0) || entry.kind !== 'xr-pose') return 0;
    const K = msg.intrinsics;
    const b = stats.neg.reports;
    b.total++;
    if (!K) return reject(b, 'noIntrinsics'), 0;
    if (room.mapSafe !== true) return reject(b, 'mapSafe'), 0;
    if (msg.source === 'guess') return reject(b, 'guess'), 0;
    const zeroTag = !(msg.tags || []).length;
    if (room.quality !== 'good' && !(zeroTag && room.quality === 'tracked')) {
      return reject(b, 'quality'), 0;
    }
    const j = room.jitter;
    if (!j || j.stale) return reject(b, j ? 'jitterStale' : 'jitterNull'), 0;
    if (j.jitterMm > C.negMaxJitterMm) return reject(b, 'jitterOver'), 0;
    // Coverage: "not detected" only means something about the region the
    // detector looked at. scanned === null is a failed frame grab shipped by
    // newer clients — nothing was scanned at all. An absent field is an old
    // journal: a zero-tag result is still a guaranteed full-frame sweep (an
    // empty crop retries the whole frame within the pass), but a partial
    // detection was usually an ROI scan that never looked where the missing
    // tag is, and without the rect there is nothing to test against.
    let scanned = msg.scanned;
    if (scanned === null) return reject(b, 'grabFail'), 0;
    if (!scanned) {
      if (!zeroTag) return reject(b, 'roiUnknown'), 0;
      scanned = { x: 0, y: 0, w: K.w, h: K.h };
    }
    b.accepted++;
    const negW = C.negScale * (zeroTag ? C.negTrackedScale : 1)
      / (1 + (j.jitterMm / C.softJitterMm) ** 2);
    const inv = se3Invert(room.pose);
    const seen = new Set((msg.tags || []).map((t) => t.id));
    const edgeX = C.negEdgeFrac * K.w;
    const edgeY = C.negEdgeFrac * K.h;
    const tb = stats.neg.tags;
    let deposits = 0;
    for (const m of tags.values()) {
      if (seen.has(m.id)) continue;
      tb.total++;
      const c = transformPoint(inv, m.p);
      if (c[2] < C.negMinZM) { reject(tb, 'behindCam'); continue; }
      const u = K.fx * c[0] / c[2] + K.cx;
      const v = K.fy * c[1] / c[2] + K.cy;
      if (u < edgeX || u > K.w - edgeX || v < edgeY || v > K.h - edgeY) {
        reject(tb, 'offFrame');
        continue;
      }
      // The whole tag must sit inside the scanned region, or the detector
      // never had a chance at it.
      const half = K.fx * tagSizeM / c[2] / 2;
      if (u - half < scanned.x || u + half > scanned.x + scanned.w
        || v - half < scanned.y || v + half > scanned.y + scanned.h) {
        reject(tb, 'offScan');
        continue;
      }
      // Room-frame gates, same convention as the positive rays but stricter
      // values: only a tag that should have been a comfortable detection may
      // read as blocked.
      const rv = [cam[0] - m.p[0], cam[1] - m.p[1], cam[2] - m.p[2]];
      const d3 = Math.hypot(rv[0], rv[1], rv[2]);
      if (!(d3 > 1e-6)) { reject(tb, 'shape'); continue; }
      const n = quatRotate(m.q, [0, 0, 1]);
      const cos = (rv[0] * n[0] + rv[1] * n[1] + rv[2] * n[2]) / d3;
      if (cos < C.negMinCos) { reject(tb, 'facing'); continue; }
      if (d3 > C.negMaxDistM) { reject(tb, 'far'); continue; }
      if (2 * half < C.negMinPx) { reject(tb, 'small'); continue; }
      const horiz = Math.hypot(rv[0], rv[2]);
      if (horiz < C.minHorizM || Math.abs(rv[1]) > C.maxSlope * horiz
        || horiz - C.standoffM <= C.negCamClearM) {
        reject(tb, 'shape');
        continue;
      }
      // Walk the ray excluding the near-camera clearance and the wall
      // standoff band — pose noise must erode margins, never deposit inside
      // the wall band, same rule as the carve.
      const ux = -rv[0] / horiz;
      const uz = -rv[2] / horiz;
      for (let s = C.negCamClearM; s <= horiz - C.standoffM; s += C.cellM / 2) {
        bumpNeg(Math.floor((cam[0] + ux * s) / C.cellM),
          Math.floor((cam[2] + uz * s) / C.cellM),
          C.lBlocked * negW, C.lBlockedRepeat * negW, vpKey, touched);
      }
      tb.deposited++;
      tb.wSum += negW;
      deposits++;
    }
    return deposits;
  }

  // Wedges between pairs of accepted rays from one viewpoint. Each wedge
  // corner is pulled a standoff toward the camera, so like the rays the
  // frustum never carves the wall band the tags sit in.
  function carveFrustum(cam, rays, scale, vpKey, touched, clips, camBehind) {
    const maxCos = Math.cos(C.frustumMaxDeg * Math.PI / 180);
    const x0 = cam[0];
    const z0 = cam[2];
    const pulled = rays.map(({ x, z, w, behind }) => {
      const dx = x - x0;
      const dz = z - z0;
      const len = Math.hypot(dx, dz);
      const k = Math.max(0, len - C.standoffM) / (len || 1);
      return {
        x: x0 + dx * k, z: z0 + dz * k,
        ux: dx / (len || 1), uz: dz / (len || 1), w, behind,
      };
    });
    for (let i = 0; i < pulled.length; i++) {
      for (let k = i + 1; k < pulled.length; k++) {
        const a = pulled[i];
        const b = pulled[k];
        if (a.ux * b.ux + a.uz * b.uz < maxCos) continue;   // wedge too wide
        // A wedge is only as trustworthy as the weaker of the two sightings
        // that bound it.
        const w = C.frustumScale * Math.min(a.w, b.w);
        // The wedge spans between two sightings, so it is classified by all
        // three of its ends together, not by combining the two rays' verdicts:
        // one tag in front and one behind still means the span crosses.
        const pairClips = clips.map((cp, ci) => {
          const cb = camBehind[ci];
          const ab = a.behind[ci];
          const bb = b.behind[ci];
          if (cb && ab && bb) return cp.none;      // wholly on the far side
          if (cb || ab || bb) return cp.crossed;   // spans the plane
          return cp;
        });
        carveTriangle(x0, z0, [a.x, a.z], [b.x, b.z],
          C.lMiss * scale * w, C.lMissRepeat * scale * w, vpKey, touched, pairClips);
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
        const gapBins = C.wallGapM / C.cellM;
        let run = null;
        const flush = () => {
          if (!run) return;
          const len = (run.hi - run.lo) * C.cellM;
          const span = run.hi - run.lo + 1;
          // Flatness is a property of the run, not of each row against the
          // rows before it. The silhouette scatters about a straight wall by
          // roughly inferVTolM, so a per-row tolerance test rejects about a
          // third of the rows of a perfectly straight wall and shreds it into
          // sub-inferMinLenM pieces that are then all discarded. Measured on
          // one room: a 3.8 m wall gave 62 rows spanning 0.42 m about their
          // median (MAD 0.09 m) and emitted nothing at all. Median and MAD
          // rather than mean and spread, for the same reason quatMedian
          // replaced quatMean — a doorway or an alcove inside the run must
          // not drag the line, and a few rows of it must not veto the wall.
          const vs = [...run.vs].sort((a, b) => a - b);
          const line = vs[vs.length >> 1];
          const devs = vs.map((x) => Math.abs(x - line)).sort((a, b) => a - b);
          const mad = devs[devs.length >> 1];
          if (len >= C.inferMinLenM && vs.length / span >= C.inferRowFillFrac
            && mad <= C.inferVTolM) {
            const v = line + outSign * C.cellM / 2;
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
        // Segment in v before segmenting along the wall. One wall's silhouette
        // is a tight cluster of extremes; a different wall, or the room simply
        // opening out, sits far away in v. Walk order cannot make this split —
        // the scatter about a single straight wall routinely steps further
        // than any tolerance small enough to also separate two walls, so an
        // excursion-breaking rule either shreds the wall (measured: 0.18 m
        // steps against a 0.10 m tolerance) or swallows the room (measured:
        // one run over corridor and far end together, MAD 0.12 vs 0.09 for
        // the corridor alone). Single-link at inferMaxParallelDistM — the
        // module's existing statement of "two parallel edges this close are
        // one wall", used here for the same judgement.
        const byV = [...rows.entries()].sort((a, b) => a[1] - b[1]);
        const clusters = [];
        for (const e of byV) {
          const last = clusters[clusters.length - 1];
          if (last && e[1] - last[last.length - 1][1] <= C.inferMaxParallelDistM) last.push(e);
          else clusters.push([e]);
        }
        for (const cluster of clusters) {
          const vOf = new Map(cluster);
          // Along-wall contiguity only. A row whose extreme falls short is
          // missing coverage, not disagreement — the walk did not get close
          // there — and the run's own dispersion, above, is what tells short
          // coverage from a genuinely uneven edge.
          for (const sBin of [...vOf.keys()].sort((a, b) => a - b)) {
            if (run && sBin - run.hi <= gapBins) {
              run.hi = sBin;
              run.vs.push(vOf.get(sBin));
            } else {
              flush();
              run = { lo: sBin, hi: sBin, vs: [vOf.get(sBin)] };
            }
          }
          flush();
        }
      }
    }
    return out;
  }

  // What the carve says about one plane: which along-wall bins are attested by
  // free space in front of it, and which are contradicted by free space behind
  // it. Shared by the wall extents and by the extent audit, so the metric can
  // never be measuring a different rule than the one that ran.
  //
  // Free space in front of the plane attests the wall — unless there is also
  // free space *behind* the plane at the same along-wall position. Front and
  // behind both walkable is not a wall, it is an opening somebody walked
  // through (a doorway, or where the room simply continues), and chaining the
  // extent across it is how a wall got drawn across a doorway and clean
  // through the far side of an L-shaped room. Front attestation reads the
  // island-filtered set; behind evidence reads raw cells — the
  // through-a-doorway blob is small by nature and must not be filtered out of
  // the one place it is the signal.
  function planeEvidence(frame, freeSet) {
    const { sOf, frontOf } = frame;
    const frontBins = new Set();
    const behind = new Map();
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
        const e = behind.get(bin) || { n: 0, depth: 0 };
        e.n++;
        e.depth = Math.max(e.depth, -front);
        behind.set(bin, e);
      }
    }
    // Behind-cells are sparse — few rays reach through an opening — so testing
    // front bins against them one-for-one leaves pinholes that stitch the wall
    // back across the doorway. Cluster the behind bins into opening intervals
    // first (same gap rule as the extents), then excise every front bin inside
    // one. A cluster below openingMinCells is noise, not an opening — that is
    // this reader's own island gate.
    const clusters = [];
    const gapBins = C.wallGapM / C.cellM;
    for (const bin of [...behind.keys()].sort((a, b) => a - b)) {
      const e = behind.get(bin);
      const last = clusters[clusters.length - 1];
      if (last && bin - last.hi <= gapBins) {
        last.hi = bin;
        last.n += e.n;
        last.depth = Math.max(last.depth, e.depth);
      } else {
        clusters.push({ lo: bin, hi: bin, n: e.n, depth: e.depth });
      }
    }
    // Depth, not just cell count. A doorway is space you can walk *through*,
    // so its evidence reaches the far end of the band; pose noise bleeding a
    // few centimetres across the very wall the rays were carved up to is a
    // sliver hugging the plane. Counting cells cannot tell them apart — a
    // sliver one row deep spanning 0.72 m still has 27 cells and excised half
    // a wall, while the genuine openings beside it reached 0.594 m and
    // 0.596 m of the 0.60 m band against that sliver's 0.215 m. The threshold
    // is half the band rather than a constant of its own, so it stays tied to
    // the depth actually looked at.
    const minDepth = (C.wallNearM + C.wallFarM) / 2;
    const enough = clusters.filter((o) => o.n >= C.openingMinCells);
    return {
      frontBins,
      openings: enough.filter((o) => o.depth >= minDepth),
      shallow: enough.filter((o) => o.depth < minDepth),
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
      const { px, pz, d2, sOf } = frame;
      const intervals = [];
      const half = tagSizeM / 2;
      for (const m of group) {
        const s = sOf(m.p[0], m.p[2]);
        intervals.push({ lo: s - half, hi: s + half, tag: m.id });
      }
      const { frontBins, openings: realOpenings } = planeEvidence(frame, freeSet);
      for (const bin of frontBins) {
        // ±1 tolerance: at a doorframe the behind-cells stop one cell short of
        // where the wall starts, and a one-cell sliver of phantom wall in the
        // opening is worse than one cell shaved off the frame.
        if (realOpenings.some((o) => bin >= o.lo - 1 && bin <= o.hi + 1)) continue;
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
    // Last, so nothing any earlier pass produced escapes it. The extension
    // gates refuse to *start* across a sight line; this is what cuts a run
    // that already spans one — an attested body across a doorway, which no
    // start gate can reach.
    return clipToSight(walls);
  }

  // Cut every segment where it crosses a proven line of sight. The doorway is
  // not judged by how wide a gap is tolerable — it is the set of wall cells
  // somebody looked through, so crossings are binned at the grid's own cellM
  // and a bin is cut once minViews distinct viewpoints crossed it. Both are
  // the module's existing units; there is no tolerance constant here, and that
  // is the point: a threshold is what let this wall come back every time the
  // doorway happened to carve narrower than it.
  function clipToSight(walls) {
    const out = [];
    for (const seg of walls) {
      const len = segLen(seg);
      if (!len) continue;
      const cut = new Set();
      for (const [bin, vps] of sightCutBins(seg)) {
        if (vps.size >= sightMinViews) cut.add(bin);
      }
      if (!cut.size) { out.push(seg); continue; }
      const d = [(seg.b[0] - seg.a[0]) / len, (seg.b[1] - seg.a[1]) / len];
      const nBins = Math.ceil(len / C.cellM);
      let start = null;
      for (let i = 0; i <= nBins; i++) {
        const blocked = i === nBins || cut.has(i);
        if (!blocked && start === null) start = i;
        if (blocked && start !== null) {
          const t0 = start * C.cellM;
          const t1 = Math.min(len, i * C.cellM);
          // A piece shorter than one tag is not a wall. Cutting leaves such
          // slivers wherever two doorways sit a cell apart, and they render as
          // specks with all the authority of a measured wall.
          if (t1 - t0 >= tagSizeM) {
            out.push({
              ...seg,
              a: [seg.a[0] + d[0] * t0, seg.a[1] + d[1] * t0],
              b: [seg.a[0] + d[0] * t1, seg.a[1] + d[1] * t1],
            });
          }
          start = null;
        }
      }
    }
    return out;
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
            // Above the wall's own length, the close would be more inference
            // than wall — same bound as closeCorners, and for the same reason:
            // pathFreeM below objects to carved space, and a runaway close
            // travels where nothing was ever carved, so it sails through.
            if (t < tol || t > Math.min(20, attestedLen(seg))) continue;
            const P = [p[0] + t * dir[0], p[1] + t * dir[1]];
            // Never through carved space — a wall drawn across more than a
            // doorway of provably-free cells is the one guess worse than an
            // open end.
            if (sightCrossings(p, P, seg) >= sightMinViews) continue;
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
            addExt(seg, end, Math.hypot(best.p[0] - p[0], best.p[1] - p[1]));
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
            if (Math.max(-t, t - ol) > attestedLen(other)) continue;   // same bound
            const P = [other.a[0] + od[0] * t, other.a[1] + od[1] * t];
            // Recorded like any other extension — a wall grown to meet someone
            // else's dangling end is just as much inference as one that went
            // looking, and it was the one mover that reported nothing at all.
            if (t < 0) {
              addExt(other, 'a', -t);
              other.a = P;
            } else {
              addExt(other, 'b', t - ol);
              other.b = P;
            }
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
              const seen = (a, b) => sightCrossings(a, b, seg) >= sightMinViews;
              if (!seen(p, q) && pathFreeM(p, q) <= C.closeThroughM) {
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
                if (seen(o, corner) || seen(corner, r)) continue;
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

  // How much of an end is inference rather than attested extent. Accumulated,
  // not overwritten: three passes may move the same end (corner close, then
  // forced close, then a T-junction grow), and a plain assignment reported
  // only the last of them — a wall extended 1.22 m in total announced 0.10 m.
  // The audit exists to make over-extension visible, so it must not itself
  // under-report it.
  function addExt(seg, end, metres) {
    if (!(metres > 0)) return;
    const prev = (seg.ext && seg.ext[end]) || 0;
    seg.ext = { ...(seg.ext || {}), [end]: Math.round((prev + metres) * 100) / 100 };
  }

  // The part of a segment the carve actually attests. This, not the current
  // length, is what bounds every extension: closing runs in repeated passes,
  // so a bound against the live length ratchets — each extension enlarges the
  // budget for the next one and a stub can walk across the room in steps.
  function attestedLen(seg) {
    return segLen(seg) - ((seg.ext && seg.ext.a) || 0) - ((seg.ext && seg.ext.b) || 0);
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
    return computeRegions().kept;
  }

  // The island filter and the enclosed-pocket sweep in one walk, because they
  // read the same connectivity. `kept` is the free floor every reader agrees
  // on; `dedIslands` are the never-visited pockets: fully enclosed by kept
  // free space, too big to be the speckle/wedge-shadow fill (islandFillCells)
  // or containing a measured-occupied cell (a pillar and its shadow), yet
  // still furniture-sized (dedMaxCells). Pure read-time derivation — walking
  // through the area later carves it free and the island simply vanishes.
  // Full enclosure is structural, not tested for: a pocket with any path to
  // the unexplored world grows past dedMaxCells via the frontier and drops
  // out. That also bounds the class to mid-room obstacles — a pocket behind
  // wall-adjacent furniture drains through the never-carved wall standoff
  // band and never completes; those walls are the blocked-ray pass's job.
  function computeRegions() {
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
    // Kept verbatim — including its early aborts, whose partial visited
    // marking is order-dependent — so the free floor every existing reader
    // sees is bit-identical to before; the deduced sweep below is a second
    // pass on purpose, not a widening of this one.
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
    // Deduced sweep: the pockets the fill refused — too big for speckle or
    // containing a measured-occupied cell — enumerated fully this time, up
    // to the furniture bound. Fresh visited set: the fill's early aborts
    // leave its marking incomplete mid-pocket, and reusing it would shred a
    // pocket into fragments along an order-dependent seam.
    const seen2 = new Set();
    const dedIslands = new Set();
    for (const key of [...kept]) {
      const ix = Math.floor(key / GRID_SIDE) - GRID_HALF;
      const iz = (key % GRID_SIDE) - GRID_HALF;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const seed = cellKey(ix + dx, iz + dz);
        if (kept.has(seed) || seen2.has(seed)) continue;
        const comp = [seed];
        seen2.add(seed);
        let open = false;
        let occContact = cells.get(seed)?.state === 2;
        for (let i = 0; i < comp.length && !open; i++) {
          const k = comp[i];
          const kx = Math.floor(k / GRID_SIDE) - GRID_HALF;
          const kz = (k % GRID_SIDE) - GRID_HALF;
          for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = cellKey(kx + ddx, kz + ddz);
            if (kept.has(nk) || seen2.has(nk)) continue;
            seen2.add(nk);
            comp.push(nk);
            if (cells.get(nk)?.state === 2) occContact = true;
            if (comp.length > C.dedMaxCells) open = true;
          }
        }
        if (open) continue;
        if (occContact || comp.length > C.islandFillCells) {
          for (const k of comp) if (cells.get(k)?.state !== 2) dedIslands.add(k);
        }
      }
    }
    return { kept, dedIslands };
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
          // Never across a line somebody looked along. clipToSight would cut
          // the result anyway; refusing here leaves the end honestly open
          // instead of reaching a corner and being chopped back to a stub.
          if (sightCrossings(from, P, seg) >= sightMinViews) return true;
          if (pathFreeM(from, P) > C.closeThroughM) return true;
          return walls.some((other) => {
            if (other === walls[i] || other === walls[k]) return false;
            const hit = segIntersect(from, P, other.a, other.b);
            return !!hit && hit.t1 > 0 && hit.t1 < 1 && hit.t2 > 0 && hit.t2 < 1;
          });
        };
        for (const [idx, seg, n] of [[i, walls[i], n1], [k, walls[k], n2]]) {
          if (!n.end || pathBlocked(seg, n)) continue;
          // Inference may not exceed the evidence it is built on. cornerMaxExtendM
          // is an absolute ceiling and says nothing about whether *this* wall has
          // earned a 3 m extension; a 1 m stub reaching 2.8 m into space nobody
          // observed is a guess about a wall that was never seen to be there.
          // pathFreeM cannot catch it either — it counts carved-free cells, and
          // a runaway extension goes precisely where nothing was ever carved, so
          // absence of evidence reads to it as absence of objection. Measured: a
          // wall attested over 0.96 m was extended 2.83 m to span the room.
          if (n.ext > attestedLen(seg)) continue;
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
        addExt(w, 'a', best[i].a.ext);
      }
      if (best[i].b) {
        w.b = best[i].b.p;
        addExt(w, 'b', best[i].b.ext);
      }
    }
  }

  // Free cells *behind* a wall within its tag-attested span. Tags are mounted
  // on walls, so free space behind a tag's plane is wrong by construction —
  // this is the headline number for whether the gates keep bad poses out.
  // Counted only within the segment's along-wall extent: beyond a wall's end
  // (a divider, a doorway wall) free space past the plane's infinite
  // extension is legitimate.
  function countBehindPlanes(cellSet) {
    if (!planeGroups) planeGroups = groupPlanes();
    const out = [];
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
      const behind = (key) => {
        const ix = Math.floor(key / GRID_SIDE) - GRID_HALF;
        const iz = (key % GRID_SIDE) - GRID_HALF;
        const cx = (ix + 0.5) * C.cellM;
        const cz = (iz + 0.5) * C.cellM;
        if (frontOf(cx, cz) > -C.cellM) return false;
        const s = sOf(cx, cz);
        return s >= lo && s <= hi;
      };
      let count = 0;
      for (const key of cellSet) if (behind(key)) count++;
      // "Wrong by construction" assumes the far side of a tagged wall is
      // never surveyed, and that assumption expires the day it is (CLAUDE.md
      // called this before landmark rays existed). Enough distinct
      // landmark-ray endpoints behind this plane, inside the same bracket,
      // is that day for this group — its count is reported but excluded from
      // the headline, never silently.
      let far = 0;
      for (const key of landmarkEnds) if (behind(key)) far++;
      out.push({
        ids: group.map((m) => m.id).sort((a, b) => a - b),
        count,
        farSide: far >= C.landmarkFarsideMin,
      });
    }
    return out;
  }

  function leaksDetail() {
    return countBehindPlanes(liveFree());
  }

  function leaks() {
    return leaksDetail().reduce((n, g) => n + (g.farSide ? 0 : g.count), 0);
  }

  // Same wrong-by-construction test over the deduced class: an inferred
  // obstruction behind a tag's wall is a pose error that slipped every
  // negative gate — the headline for whether those gates hold, the way
  // leaks() is for the positive ones. Inherits the far-side scoping through
  // the shared countBehindPlanes: a deduced blob in a legitimately surveyed
  // kitchen is equally not "wrong by construction".
  function deducedLeaksDetail() {
    return countBehindPlanes(new Set(deducedKeys()));
  }

  function deducedLeaks() {
    return deducedLeaksDetail().reduce((n, g) => n + (g.farSide ? 0 : g.count), 0);
  }

  // The deduced class: blocked-ray accumulations past the promotion bar plus
  // the enclosed never-visited islands. Read-time only — nothing is stored,
  // so free carves and map edits revise it for free.
  function deducedKeys(regions = computeRegions()) {
    const out = [];
    for (const [key, c] of cells) {
      if (c.state === 0 && c.Ln >= C.dedOn && c.nviews >= C.negMinViews
        && !regions.kept.has(key) && !regions.dedIslands.has(key)) {
        out.push(key);
      }
    }
    out.push(...regions.dedIslands);
    return out;
  }

  // The converse of leaks, and the reason it needed one: leaks only counts
  // behind-cells inside a wall's *emitted* span, so a wall eaten too short is
  // invisible to it — the span shrank precisely to exclude the evidence. This
  // reports, per plane, how much front-attested wall the openings removed, and
  // how much of that was removed by behind-evidence too shallow to be a
  // doorway. Measured before the depth gate: one wall attested over 6.96 m
  // emitted 2.28 m, 0.72 m of it excised by a sliver 0.215 m deep.
  function extentAudit() {
    if (!planeGroups) planeGroups = groupPlanes();
    const freeSet = liveFree();
    const out = [];
    for (const group of planeGroups) {
      const frame = planeFrameOf(group);
      if (!frame) continue;
      const { frontBins, openings, shallow } = planeEvidence(frame, freeSet);
      if (!frontBins.size) continue;
      const bins = [...frontBins].sort((a, b) => a - b);
      const inAny = (list, bin) => list.some((o) => bin >= o.lo - 1 && bin <= o.hi + 1);
      const kept = bins.filter((b) => !inAny(openings, b));
      out.push({
        ids: group.map((m) => m.id).sort((a, b) => a - b),
        attestedM: Math.round((bins[bins.length - 1] - bins[0] + 1) * C.cellM * 100) / 100,
        keptM: Math.round(kept.length * C.cellM * 100) / 100,
        openM: Math.round((bins.length - kept.length) * C.cellM * 100) / 100,
        shallowM: Math.round(
          bins.filter((b) => inAny(shallow, b)).length * C.cellM * 100) / 100,
      });
    }
    return out;
  }

  function getFloor() {
    const regions = computeRegions();
    const freeSet = regions.kept;
    const free = [];
    const occ = [];
    const deduced = [];
    for (const [key, c] of cells) {
      if (c.state === 2) {
        occ.push(Math.floor(key / GRID_SIDE) - GRID_HALF, (key % GRID_SIDE) - GRID_HALF);
      } else if (c.state === 1 && freeSet.has(key)) {
        free.push(Math.floor(key / GRID_SIDE) - GRID_HALF, (key % GRID_SIDE) - GRID_HALF);
      }
    }
    for (const key of deducedKeys(regions)) {
      deduced.push(Math.floor(key / GRID_SIDE) - GRID_HALF, (key % GRID_SIDE) - GRID_HALF);
    }
    return { cellM: C.cellM, free, occ, deduced };
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
          Math.round(c.Ln * 1000) / 1000,
          c.nviews,
        ]),
        // The proven lines of sight. Persisted with the grid because they are
        // the same evidence: dropping them would let every doorway re-close on
        // restart and stay closed until it happened to be looked through
        // again, which is the exact symptom this feature exists to end.
        sights: [...sights].map(([key, s]) => [
          key,
          Math.round(s.ax * 1000) / 1000, Math.round(s.az * 1000) / 1000,
          Math.round(s.bx * 1000) / 1000, Math.round(s.bz * 1000) / 1000,
          s.vp,
        ]),
        // Landmark-ray endpoint cells, as [ix, iz] like the cells above. An
        // optional key rather than a version bump: an old build ignores it,
        // and nothing structural changed for one.
        landmarkEnds: [...landmarkEnds].map((key) => [
          Math.floor(key / GRID_SIDE) - GRID_HALF,
          (key % GRID_SIDE) - GRID_HALF,
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
    // v1 files predate the negative-evidence columns and load with Ln = 0, v2
    // predates the sight lines and loads with none (doorways re-close until
    // looked through again — the pre-feature behaviour, not something worse);
    // anything newer than this code may mean the columns something else.
    if (raw.version > WALLS_VERSION) {
      log(`Ignoring ${path.basename(file)}: version ${raw.version}, ` +
        `this build writes ${WALLS_VERSION}`);
      return;
    }
    for (const [key, ax, az, bx, bz, vp] of raw.sights || []) {
      sights.set(key, { ax, az, bx, bz, vp });
    }
    for (const [ix, iz] of raw.landmarkEnds || []) {
      landmarkEnds.add(cellKey(ix, iz));
    }
    for (const [ix, iz, L, views, Ln = 0, nviews = 0] of raw.cells || []) {
      // Viewpoint identity does not survive a restart (vp = -1), which only
      // under-counts: an already-promoted cell keeps its state, an unpromoted
      // one needs a genuinely new sighting anyway. State is re-derived without
      // hysteresis — thresholds only.
      const state = L >= C.occOn ? 2
        : ((L <= C.freeOn && views >= C.minViews) || L <= C.freeOnSingle ? 1 : 0);
      cells.set(cellKey(ix, iz), { L, views, vp: -1, state, Ln, nviews, nvp: -1 });
    }
    if (cells.size) {
      const floor = getFloor();
      log(`Walls grid loaded: ${cells.size} cells, `
        + `${floor.free.length / 2} free / ${floor.occ.length / 2} occupied`);
    }
  }

  function reset() {
    cells.clear();
    sights.clear();
    landmarkEnds.clear();
    planeGroups = null;
    frustumVps.clear();
    for (const k of Object.keys(stats.reports.rej)) delete stats.reports.rej[k];
    for (const k of Object.keys(stats.rays.rej)) delete stats.rays.rej[k];
    for (const k of Object.keys(stats.landmarkRays.rej)) delete stats.landmarkRays.rej[k];
    for (const k of Object.keys(stats.neg.reports.rej)) delete stats.neg.reports.rej[k];
    for (const k of Object.keys(stats.neg.tags.rej)) delete stats.neg.tags.rej[k];
    stats.reports.total = stats.reports.accepted = 0;
    stats.rays.total = stats.rays.accepted = 0;
    stats.landmarkRays.total = stats.landmarkRays.accepted = 0;
    stats.landmarkRays.wSum = 0;
    stats.neg.reports.total = stats.neg.reports.accepted = 0;
    stats.neg.tags.total = stats.neg.tags.deposited = 0;
    stats.neg.tags.wSum = 0;
    stats.veto.planes = stats.veto.waived = 0;
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
      landmarkRays: {
        ...stats.landmarkRays,
        rej: { ...stats.landmarkRays.rej },
        meanW: stats.landmarkRays.accepted
          ? Math.round(stats.landmarkRays.wSum / stats.landmarkRays.accepted * 100) / 100
          : null,
      },
      neg: {
        reports: { ...stats.neg.reports, rej: { ...stats.neg.reports.rej } },
        tags: {
          ...stats.neg.tags,
          rej: { ...stats.neg.tags.rej },
          meanW: stats.neg.tags.deposited
            ? Math.round(stats.neg.tags.wSum / stats.neg.tags.deposited * 100) / 100
            : null,
        },
      },
      veto: { ...stats.veto },
      cells: cells.size,
      free: freeCells,
      occ: floor.occ.length / 2,
      deduced: (floor.deduced || []).length / 2,
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
      return c ? { L: c.L, views: c.views, state: c.state, Ln: c.Ln, nviews: c.nviews } : null;
    },
    getFloor,
    getWalls,
    // The regression number this feature exists for: proven lines of sight an
    // emitted wall is drawn across. Wrong by construction, and the reason the
    // bug kept coming back — leaks() catches walls drawn too wide and
    // extentAudit() catches walls eaten too narrow, but neither can see a wall
    // standing in open space. Must be 0.
    sightBlocks() {
      const segs = getWalls();
      // Measured against the rule as enforced, or the number means nothing:
      // a crossing only cuts a wall once sightMinViews distinct viewpoints
      // agree, so a lone grazing line is not a violation. Reported separately
      // rather than hidden — a rising `grazed` is how a systematically wrong
      // pose would announce itself before it ever reached the cut threshold.
      let blocked = 0;
      let grazed = 0;
      for (const g of segs) {
        const len = segLen(g);
        if (!len) continue;
        for (const [, vps] of sightCutBins(g)) {
          if (vps.size >= sightMinViews) blocked += vps.size;
          else grazed += vps.size;
        }
      }
      return { blocked, grazed, total: sights.size };
    },
    leaks,
    leaksDetail,
    deducedLeaks,
    deducedLeaksDetail,
    extentAudit,
    stats: statsOf,
    reset,
    setMarkerSize(m) {
      tagSizeM = m;
      reset();
    },
  };
}

module.exports = { createWalls, DEFAULTS };
