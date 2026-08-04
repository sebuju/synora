'use strict';

// The landmark map: natural image features, triangulated from tag-derived
// camera poses, used to keep a client localized after it walks out of tag view.
//
// Scope, because it is narrower than it looks and the narrowness is measured:
//
//   - **Within one tracking session only.** Correspondence comes from optical
//     flow on the client, which is free and reliable while a feature stays in
//     frame and means nothing once it does not. Re-identifying an landmark in a
//     *later* session was measured and failed outright: 0 usable fixes, with
//     ORB matching a median of 4 descriptors even when all 12 map landmarks were
//     geometrically in shot. Nothing here is written to disk, restored, or
//     expected to survive a tracker reset. Do not build toward it.
//   - **Not a replacement for tags.** An landmark can only be *created* where a
//     tag supplied the camera pose. Tags remain the datum and the only metric
//     source, and information flows tags -> landmarks, one way, always.
//   - **Not object detection.** There is no model and no class list. The
//     failure was never the object class, it was using an object's silhouette
//     centre, which moves with viewpoint; a corner tracker only ever produces
//     real image features and the split-arc test throws out the rest.
//
// All the geometry is in public/landmark-math.js, shared with the offline probe
// page so that what is measured there is what runs here. Nothing on this side
// needs OpenCV: the solve is a RANSAC around pose-math.js's solvePose, the same
// refiner the survey's joint multi-tag PnP runs on, so the server keeps exactly
// one PnP implementation and no 10 MB wasm dependency.

const {
  undistort, reproject, qualifyTrack, clusterLandmarks, solveLandmarkPose,
  dist3, MIN_OBS, MAX_RMS_PX, MIN_ARC_DEG,
} = require('./public/landmark-math.js');
const { quatAngleDeg, transformPoint, se3Invert } = require('./public/pose-math.js');

// Observations kept per track. The split-arc test wants the arc, not every
// sighting along it, and an unbounded ring would grow without limit on a track
// that never dies.
//
// So when it fills, it is *thinned* — every second observation is dropped —
// rather than having its oldest shifted off. A FIFO ring keeps the last N
// sightings, which is a sliding window over the walk, and the arc it spans is
// whatever the camera covered in the last N reports and nothing more. Measured
// on a 90-report orbit sweeping 72 deg: the ring held the most recent 60 of
// them, capping the visible span at 48 deg against a 60 deg gate, and 24
// genuinely fixed features produced 2 landmarks. Thinning keeps the whole arc at
// half the density, which is what the test actually reads.
const OBS_RING = 60;
// Re-running qualification on every single sighting is pure waste — a track
// that failed at n sightings does not pass at n+1 — so it is attempted on a
// stride once the minimum is reached.
const QUALIFY_EVERY = 4;

// The sharp cliff, and the single most important number here. Measured:
//
//   landmarks   median position   median orientation
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
//
// It is applied twice: to the landmarks that matched, and again to the ones that
// survive the solver's outlier rejection. Matching 16 and agreeing with 11 is
// eleven landmarks' worth of support however it is counted, and 11 is inside the
// range the measurement above has nothing to say about.
const MIN_LANDMARKS_FOR_FIX = 15;

// Re-association: how close an landmark's projection has to land to a tracked
// point before that point is taken to *be* it, and how much closer than the
// runner-up. An landmark is a 3D point and the pose is known to a few centimetres,
// so a genuine match lands within a few pixels; the margin is what stops two
// nearby features being swapped, which would be a wrong landmark rather than a
// missing one. Same discipline as adopting a device fingerprint: a unique strong
// winner or nothing.
// Swept against a recorded room session. Coverage barely moves across the range
// — it is the worst case that responds, which is the number that matters here,
// because the failure mode of a wrong adoption is a confident pose in the wrong
// place rather than a missing one:
//
//   px    localized   median   p90    worst
//   2     220/264      41 mm   178     422 mm
//   3     219/264      39 mm   158     316 mm     <-
//   4     220/264      44 mm   148     522 mm
//   6     217/264      45 mm   155     682 mm
//
// 3 px keeps the worst case at what it was before re-association existed (301
// mm) while raising coverage from 176/264 to 219/264. The margin never binds at
// any of these — genuinely ambiguous pairs are rare — so it stays as the cheap
// guard for the case that is rare rather than absent.
const REASSOC_PX = 3;
const REASSOC_MARGIN = 2.5;
// The solve path's own adoption radius. 3 px assumes the projecting pose is
// tag-derived; the cross-check's seed is the ARCore-carried pose, whose drift
// is the very thing being measured — measured on a real walk, in-view
// landmarks reprojected ~26 px off through it, so at 3 px the solve adopted
// nothing and the cross-check went 0-for-553. At 12 px, 68 of those frames
// had >=15 landmarks in range (110 at 24 px; the rest genuinely look away
// from the landmark region). The uniqueness margin and the RANSAC are what
// keep a looser radius honest; swept by replay via --solve-reassoc-px.
const SOLVE_REASSOC_PX = 12;
// Aliases outlive the tracks that made them, harmlessly but not for free. Track
// ids climb monotonically within a generation, so the stale ones are simply the
// low ones.
const ALIAS_CAP = 4000;

// How far apart two candidate features may be and still be one thing worth
// walking towards (`guide`). The value is inherited: it was tuned on the drawer's
// region cards, which are gone — landmarks were founded by arc only when that
// measurement was taken, and consensus and depth founding since raised supply
// about twentyfold, so a fixed radius produced a card per 13 landmarks and the
// drawer became unreadable. Nothing has measured it for *guidance*, which is now
// its only consumer; it survives because a guidance cluster wants the same thing
// the cards wanted — a knot of corners on one piece of furniture, not a wall's
// worth of them.
const GUIDE_CLUSTER_M = 0.6;

// Landmark staleness. Nothing revalidated a qualified landmark: if the thing it was
// a corner of is moved — a chair, a door, a laptop lid — the landmark keeps
// asserting a point the room no longer contains, and the only symptom is a fix
// that is quietly a few centimetres wrong. The survey has `RESEED_DISAGREE_M`
// for exactly this on tags, and the argument carries over unchanged.
//
// The evidence is a reprojection residual taken on a frame where the *tags*
// supplied the pose, so it is independent of the landmarks themselves — the same
// reason the survey refines a tag from a leave-one-out fix rather than from the
// fix the tag helped make. A residual measured against a landmark-derived pose
// would be the landmark grading its own homework.
//
// Streak, not a single frame, and the same shape the survey uses: one bad
// sighting is an optical-flow track sliding, a run of them is the feature not
// being where the map says. A dropped landmark is not lost work — its track is
// still live, so it starts accumulating observations again on the very next
// report and re-qualifies from where the feature actually is.
//
// The alias goes with it. On a persistent disagreement one of two things is
// wrong — the landmark moved, or this track is not looking at it — and nothing
// available here can say which, so neither is kept.
// The threshold is where it is because it was swept, and the first setting
// tried was wrong in the direction that matters. Residual distributions differ
// by session far more than expected — one recorded walk sits at 32/32/23/8/2/2%
// across 0-2/2-4/4-8/8-16/16-32/>32 px, another at 7/22/47/21/2/0% — so a gate
// inside the second session's bulk drops honest landmarks. At 12 px it dropped 17
// of 133 there and made the holdout *worse* (worst-case position 316 -> 491 mm),
// which is the whole failure this feature could have introduced.
//
// Swept on that session (landmarks / holdout / median / worst):
//
//   off      133  219/264  39 mm  316 mm
//   12 px    123  217/264  43 mm  491 mm   <- drops honest landmarks
//   16 px    132  220/264  42 mm  300 mm
//   20 px    133  219/264  39 mm  318 mm   <-
//   24 px    133  220/264  44 mm  334 mm
//
// 20 px is the first setting whose effect on every recorded session is inside
// the run-to-run noise, which is what it has to be: on a room where nothing
// moved this must be invisible. Three other sessions drop nothing at all at it.
//
// It is not a loose gate in the units that matter. At 4 m — the far end of the
// useful range — 20 px is 89 mm of displacement, at 2 m it is 44 mm, and the
// thing this exists to catch is furniture, which moves in decimetres.
//
// Sensitivity, on a synthetic orbit of 40 features at ~4 m with one displaced:
// a 400 mm move is caught in 5 sightings (the streak itself — the first
// disagreement is immediate), 100 mm in 15, 50 mm not at all at that range,
// which is the gate doing what the paragraph above says it does. In every case
// the dropped landmark re-qualifies at its new position on the next pass, and
// false drops stay at zero up to 8x the observation noise (2.4 px), so this is
// not living off the noise floor.
const STALE_PX = 20;
const STALE_STREAK = 5;

// Which reports may found an landmark. Here rather than in server.js because the
// replay tool has to ask the *same* function: it did not, and the divergence
// cost three sessions. The tool tested `quality === 'good' && mapSafe && pose`
// while the server also demanded a fresh jitter figure, so the replay reported a
// working feature — 133, 63 and 46 landmarks on three walks — while the live
// server built zero on every one of them.
//
// Landmarks are only worth founding on a pose the survey itself would stand behind
// — the same statement walls.js makes before carving, and for the same reason: a
// wrong landmark is as durable as the session and nothing downstream can tell it
// from a right one. The gates are deliberately not shared code with walls: that
// module *scores* jitter into a weight and has a whole second path for tag-less
// frames, where this needs one yes/no.
//
// **Absence of a jitter measurement is not a bad measurement**, and treating it
// as one is what shut the feature off. The old gate refused an `xr-pose` with no
// jitter figure, on the stated assumption that one is always available there. It
// is not, and the reason is this feature's own cost:
//
//   - `trackJitter` needs 8 samples inside a 1500 ms window: a report rate above
//     5.3/s.
//   - Feature tracking roughly halves the report rate. Measured across recorded
//     walks: 6.38/s with tracking effectively off against 4.19, 4.29 and 3.06/s
//     with it on — and the share of `good` frames carrying a jitter figure falls
//     with it, 93% -> 35% -> 37% -> 5%.
//   - So the gate refused 344, 390 and 216 otherwise-good reports on those three
//     sessions, admitted 146, 122 and 6, and built nothing at all.
//
// A jitter figure that *is* present and bad is still evidence and still refuses.
// What no longer refuses is its absence. What remains is what the tag-only path
// has always relied on — the survey's own `mapSafe` quarantine plus `quality ===
// 'good'` — with the split-arc qualification behind it to throw out the rest.
const LANDMARK_MAX_JITTER_MM = 25;

// The landmark solve as a cross-check on the ARCore-carried pose (stage 1 of
// the carving plan, .plans/landmark-carving.md). On a tag-less 'tracked' frame
// the solve runs against the landmark map — which is a frozen record of the
// room frame as the tags defined it — and agreement with the carried pose
// within these bounds is genuine cross-validation: the two share no
// measurement. They live here, not in server.js, for the same reason
// landmarkGate does: replay-landmarks.js must test the same numbers or it
// measures a different product (that divergence cost three sessions once).
//
// Placeholders until the first instrumented walk: the disagreement
// distribution between a landmark solve and the carried pose has never been
// measured (the solve never ran on this path), and LANDMARK_AGREE_M cannot be
// chosen before it is. Swept by replay against `lmCheck` journal lines.
const LANDMARK_AGREE_M = 0.10;
const LANDMARK_AGREE_DEG = 5;
// The takeover's own inlier bar, well above MIN_LANDMARKS_FOR_FIX.
//
// A takeover is the only place a landmark solve *overrules* ARCore, so it is
// the only place that needs a bar above "the solve is usable at all". Measured
// across 205 solves on four walks (.plans/landmark-lock.md §3f), the inlier
// count is the *only* property that predicts a solve's disagreement with the
// carry in every walk — Spearman -0.52, -0.48, -0.08, -0.74. Everything
// geometric that looked promising pooled turned out to be sorting walks rather
// than solves and changed sign between them: the inlier set's lateral extent
// (+0.07 / -0.42 / -0.17 / -0.80), its depth spread along the view axis
// (+0.33 / -0.22 / -0.37 / -0.10), the ratio of the two (flat, -0.012 pooled),
// the distance to the nearest inlier (-0.11 / +0.64 / +0.30 / +0.65).
//
// At 30 the walk that jittered worst keeps 12 takeovers of 72 and the
// survivors' median disagreement halves, 228 -> 126 mm. Rescue, confirmation
// and carve rays are deliberately left at MIN_LANDMARKS_FOR_FIX: those turn on
// *agreement*, where a solve that matches the carry is corroboration and does
// not need to be trusted on its own.
//
// What this is not: proof that the surviving takeovers are more *accurate*.
// Fewer, smaller disagreements is partly tautological — a solve nearer the
// carry is nearer the thing it is measured against. The arbiter is the tag: at
// a re-acquire, does the taken-over pose sit closer to the tag fix than the
// carry does? That is the test that reverted the carry correction (94 mm
// against 65 mm) and it is the one to run on the next walk.
const LANDMARK_TAKEOVER_MIN_INLIERS = 30;
// The solve's own quality bar for confirmation, on top of agreement: TRIM_PX
// inliers with an rms at the trim ceiling are a fit on the edge of its own
// outlier gate.
//
// It therefore *tracks* TRIM_PX and is not an independent number — moved 5 ->
// 8 with it. Left behind, it silently throws away everything the looser trim
// buys: measured, a trim of 10 against a confirmation ceiling of 5 produced 52
// solves and **six** confirmations on one journal, i.e. solves that can never
// rescue mapSafe, never carry landmark rays, and never take over the pose.
const LANDMARK_CONFIRM_RMS_PX = 8;
// Whether an agreeing solve may rescue mapSafe (stage 2). The cross-check and
// its journal line run regardless — this only gates the consequence, so the
// measurement stage can ship with the behaviour off.
const LANDMARK_RESCUE = true;
// How many consecutive failed cross-checks may pass before the solve stops
// seeding from its own last answer and falls back to the carried pose.
// Chaining is what the holdout always measured ("the seed is chained
// deliberately") and the live path never did — it re-seeded every frame from
// the drifted carry, so one successful solve did not help the next frame
// find its matches. Measured on the corner walk (00:53 03/08): 18 isolated
// solves in 447 eligible frames, each one re-losing the lock its
// predecessor had established.
const SOLVE_CHAIN_MAX = 10;
// Chained founding (stage 5): landmarks founded under a landmark-confirmed
// pose carry depth = 1 + the deepest landmark that confirmed it, and founding
// is refused past this cap. Raised 0 → 1 on the stage-1/2 measurements the
// plan demanded (22:40 02/08/26 walk: 13 solves, 11 confirmed, rescue
// firing, median disagreement 86 mm): without it the map can never extend
// past the 2 s alignFresh band from a tag glance — measured on the kitchen
// walk, refined landmarks reached 15-in-view on under half the tag-less
// frames and the deep frames had nothing to match at all. The half-tolerance
// gates on the chained branch in check() are the compounding-drift defence.
const LANDMARK_MAX_DEPTH = 1;

// A carry correction was built here and **reverted on measurement** — the note
// stays because the reasoning that justified it is a trap worth marking.
//
// The takeover replaces one frame's reported pose and keeps nothing, so on the
// 16:17 03/08 walk it fired 72 times in 72 isolated runs, the reported pose
// stepping 235 mm between frames where ARCore's carry stepped 13 mm. The
// offsets looked like real drift: mean 205 mm against 73 mm of scatter, and
// two takeovers three seconds apart agreeing to 49 mm while measuring 228 mm.
// So the correction was kept and applied to later tag-less frames, and the
// saw-tooth duly went (235 -> 55 mm).
//
// **Consistency is not evidence of drift.** A systematic offset between the
// landmark map's frame and the tag frame is exactly as consistent, and the
// only measurement that separates them is against the tags themselves. At a
// tag re-acquire, taken over 129 boundaries: the corrected pose sat **94 mm**
// from the tag fix and the *raw ARCore carry* sat **65 mm** from it. The
// correction moved the reported pose away from the only datum in the room.
//
// The suspected cause is founding depth. Most founding runs on alignFresh
// *carried* poses (332 of 416 fed frames on that walk, LANDMARK_MAX_DEPTH 1),
// which bakes the carry's own drift into the map's coordinates, so a solve
// against that map answers in the drifted frame rather than the room's. The
// holdout, which builds only from tag-confirmed frames, localizes to 23-31 mm
// — the same map founded the other way does not have the offset.
//
// Do not re-add a correction until a solve is shown to agree with the tags
// better than the carry does. That is the measurement, and it is one line of
// replay away.

// A solve may *correct* the pose it started from. It may not replace it.
//
// The mirror flip is what this exists for, and it is the same failure
// MIN_LANDMARKS_FOR_FIX guards: landmarks are bearing-only points that tend to
// be near-coplanar, which is the weak PnP configuration, and there is no
// per-point ambiguity to resolve because a point carries no orientation. The
// seeded refinement is supposed to make the flip unreachable — a local refiner
// converges to the basin it started next to — but with enough slightly-wrong
// correspondences admitted it can walk out of that basin, and then it reports
// a confident pose in the mirrored one.
//
// Measured (.plans/landmark-lock.md §3b): at TRIM_PX 6 and above the 01:20
// holdout's worst case goes 219 mm / 3.59° -> 2701 mm / 96.04°. The
// discriminator is *orientation*, not distance: legitimate drift catches on
// every recorded journal top out at 7.6° and 906 mm, so 20° sits 2.6x above
// the worst honest correction and 5x below the flip, while position separates
// only 3x and does the lesser share of the work.
//
// It lives in check(), against **this frame's carried pose**, and not in
// solve() against solve's own seed. That was tried and is wrong: solve()'s
// seed is only temporally adjacent when the caller's frames are — the holdout
// strides its frames and chains through refusals, so its seed is metres away
// by construction and every honest solve read as a jump (0 of 52 localized).
// check() already computes exactly the right comparison for its own agreement
// test: `dp` and `deg` against the ARCore pose for that very frame. The mirror
// is not a subtle disagreement, it is 2.7 m and 96° of one.
//
// A jumped fix is not merely refused, it is kept out of the chain: solve() has
// already made it `lastPose`, and a flipped answer left there re-seeds every
// later frame into the mirrored basin.
//
// Inert on every recorded journal at today's gates: it is a tripwire for the
// looser trim the sweep wants, not a change to what solves now.
const SOLVE_JUMP_M = 1.5;
const SOLVE_JUMP_DEG = 20;

// ARCore's depth map as a *prior*, self-measured against the tags. This is
// the depth ban's demand made continuous: every detected tag carries both a
// depth sample (t.d) and a solver-grade truth for the same pixel (tvec[2]),
// so the session measures its own depth source as it runs and the hybrid
// qualification below only exists while that measurement holds. Measured on
// the first instrumented walk (02/08/26, 103 sightings at 2-3 m): raw median
// error 106 mm dominated by a systematic short-read (bias −96 mm, drifting
// −129 → −81 across the walk — hence a live bias, not a constant), residual
// after bias removal 70 mm median. That is *prior* grade: enough to say
// where a point roughly is and that it is a fixed point, not enough to be
// its coordinates — which is why the hybrid keeps triangulation for the
// final position and hands depth only the split-arc test's discrimination
// job. With discrimination no longer resting on the arc, the arc only has to
// condition a seeded triangulation, and 5° (one sidestep) does that where
// the split test needed 20°.
const DEPTH_TRUST_RING = 50;
const DEPTH_TRUST_MIN_N = 10;
// The calibration is a *scale*, not an offset: measured across two walks the
// short-read grows with distance (−63 mm at 1-2 m, −147 at 2-3, −248 at 3-5;
// k = median(d/z) 0.953 and 0.963), and an additive bias fitted to one range
// over-corrects the other. The residual after scale removal still grows with
// z (44 → 64 → 110 mm across 1-5 m), so the trust gate and every tolerance
// downstream are *relative* to distance, never a fixed millimetre figure.
//
// Two thresholds, not one: sessions sit *on* the line and flap. Measured on
// the 00:27 03/08 walk, the residual crossed a single 6% gate repeatedly
// (5.2 → 6.2 → 5.7 → 6.7 → 5.9 → 6.1%), and every flap-off shut founding
// down mid-walk — the map lost supply not because depth was bad but because
// the verdict would not sit still. Trust is earned below REL and kept until
// REL_OFF; the band is the same shape as GUIDE_NEAR_LEAVE_M and for the
// same reason.
const DEPTH_TRUST_REL = 0.06;
const DEPTH_TRUST_REL_OFF = 0.08;
// Depth-backed sightings before hybrid qualification is attempted, and how
// many distinct 0.15 m camera cells they must span: a fore/background depth
// mixture at a corner cannot stay consistent across moving viewpoints, which
// is what stands in for the split test's discrimination.
const DEPTH_EST_MIN = 5;
const DEPTH_MIN_VIEWS = 2;
const DEPTH_VIEW_CELL_M = 0.15;
// Medoid consistency of the depth estimates and how close the refining
// triangulation must land to their median — disagreement past these is the
// mixture case, refused rather than averaged. Relative to the point's
// distance (the measured noise scales with z), with floors for near range.
const DEPTH_EST_TOL_M = 0.06;
const DEPTH_EST_TOL_REL = 0.06;
const DEPTH_AGREE_M = 0.25;
const DEPTH_AGREE_REL = 0.12;
const DEPTH_HYBRID_MIN_ARC_DEG = 5;

// Landmarks from spatial consensus, with no track identity at all
// (.plans/depth-consensus-landmarks.md). The hybrid qualification above still
// rides on a track surviving to DEPTH_EST_MIN sightings, and track survival —
// not the gates — is the measured supply bottleneck: on one instrumented walk
// 14,616 optical-flow tracks were born and 70 lived to five sightings (the
// gates then passed 17 of those 70). Walking kills tracks, and walking is what
// the founding procedure requires; standing still keeps tracks alive and fails
// the viewpoint gate instead. So the assumption dropped here is that a
// landmark needs a surviving track to be founded. With trusted depth every
// point sighting is an independent 3D measurement (±5%·z), and estimates from
// *different* tracks landing in the same small volume across viewpoints are
// the same physical feature announcing itself — the survey's own tryPromote
// pattern applied to depth points. Track identity is already irrelevant to
// *use*: reassociate adopts whatever fresh track sits on a landmark's
// projection, with no memory of which track founded it.
//
// The voxel is deliberately coarser than CLUSTER_M: it has to catch one
// feature's ±5%·z noise ball (10-15 cm at room range), not distinguish two
// features. A feature may straddle a voxel boundary, so promotion reads the
// 3×3×3 neighbourhood — the quantisation must not halve a feature out of
// existence.
const VOXEL_M = 0.12;
// Stricter than the hybrid's DEPTH_MIN_VIEWS 2: there is no rms or
// triangulation cross-check behind a consensus landmark, so viewpoint spread
// is the whole mixture defence. A fore/background depth mixture at a
// silhouette cannot stay consistent as the viewpoint moves.
const VOXEL_MIN_N = 6;
const VOXEL_MIN_VIEWS = 3;
// Session state, not a map: a voxel untouched this many reports is noise from
// a part of the walk that never confirmed, and the cap bounds the whole
// accumulator. The clock is the report counter — the module stays clock-free
// and replays deterministically.
const VOXEL_TTL_REPORTS = 300;
const VOXEL_CAP = 4096;
// Per-voxel sample ring. Votes and viewpoint cells count every deposit; the
// stored estimates are what the promotion median and spread are read from,
// and past this many they are thinned (every second kept) rather than
// shifted, same argument as OBS_RING.
const VOXEL_PTS_RING = 24;

// The solve's seed correction, and the piece that finally closes the kitchen
// loop. The carried pose drifts (measured 0.25 m deep in the kitchen), which
// reprojects even px-grade landmarks 50-150 px away from their points — no
// adoption radius survives that honestly, and matching is what the solve
// needs before it can measure the very drift that broke the matching. Depth
// breaks the circle: back-projecting the frame's points through the drifted
// seed puts them in room 3D where the drift is a near-rigid offset measured
// in *metres*, and pairing against the landmark cloud at that scale is easy.
// The component-wise median of the pair deltas is the correction — robust,
// no fitted rotation (the PnP refinement recovers rotation once matching
// works; the translation is what moves reprojections back into radius).
// Coarse landmarks are welcome in the pairing — at this grade they are as
// good as the depth they came from — and the correction only ever adjusts
// the *seed*: the solve still measures, and reports, its own answer.
const SEED_PAIR_M = 0.3;
const SEED_PAIR_MIN = 12;
const SEED_SHIFT_MAX_M = 1.0;

// A consensus landmark is born *coarse*: its position is depth-grade, ±5%·z
// (5-10 cm at room range), which is enough to exist and to anchor a carve
// ray but not to support the solve — measured on the first kitchen walk,
// 639 landmarks and 0 of 556 tag-less frames solved, because reprojections
// scattered 25-60 px from the tracked points (incoherently: the shared-shift
// component was 9 px, so this is per-landmark position noise, not seed
// drift). The pipeline that fixes it is below: adopt a track onto the coarse
// landmark at a radius its own noise actually fits inside, accumulate that
// track's sightings under founding-grade poses, and upgrade the position by
// the same seeded triangulation the hybrid qualification runs — after which
// the landmark is px-grade and the solve may count it. Until then the solve
// must not: RANSAC against 8 cm noise either rejects them (wasted match) or
// fits them (poisoned pose).
const CONSENSUS_ADOPT_PX = 24;
// The refinement observation ring, thinned like OBS_RING — the triangulation
// wants the arc, not the density.
const ROBS_RING = 40;

function landmarkGate(entry) {
  const { msg, room } = entry;
  if (!room?.pose || room.mapSafe !== true) return false;
  if (room.quality !== 'good' || msg.source === 'guess') return false;
  const j = room.jitter;
  if (entry.kind === 'xr-pose' && j && !j.stale && j.jitterMm > LANDMARK_MAX_JITTER_MM) {
    return false;
  }
  return true;
}

// Which reports may found landmarks, and at what provenance depth. Null =
// none; 0 = a tag confirmed this very frame (landmarkGate, the original
// rule); 1 = ARCore carrying the pose inside the survey's own alignFresh
// window (mapSafe true on a 'tracked' frame).
//
// Depth 1 exists because "found only where a tag is in frame" is not merely
// restrictive but geometrically impossible in the room this feature is for:
// tags 2/6 face *out* of the kitchen with a wall between them and it, so no
// camera can ever hold a tag and a kitchen feature in one frame. The carried
// pose within ALIGN_FRESH_MS is the same pose walls.js accepts as permanent
// carve evidence — glance at a tag, swing to the doorway, and the two seconds
// of tag-anchored carry are the founding window. The jitter and source gates
// apply unchanged; mapSafe must be the survey's own (a landmark-rescued frame
// founds through the chained branch in check(), against LANDMARK_MAX_DEPTH,
// not here — landmarks must not bootstrap deeper landmarks by this path).
function foundingDepth(entry) {
  if (landmarkGate(entry)) return 0;
  const { msg, room } = entry;
  if (entry.kind !== 'xr-pose' || !room?.pose) return null;
  if (room.quality !== 'tracked' || room.mapSafe !== true) return null;
  if (room.safeVia === 'landmark' || msg.source === 'guess') return null;
  const j = room.jitter;
  if (j && !j.stale && j.jitterMm > LANDMARK_MAX_JITTER_MM) return null;
  return 1;
}

// Guidance: which feature the person holding the phone should work on next, and
// what to do about it.
//
// This exists because the honest state of the feature is unreadable from its
// own outputs. Landmarks accumulate only from *orbiting* motion, normal walking
// reaches 3-9 deg of arc against the gate, and the two failures — "nothing
// worth looking at here" and "you are walking past everything" — look identical
// from an empty landmark cloud. A count cannot say either; a direction can.
//
// The arc is subtended *at the feature*, which is the part that is not obvious
// and drives every number below: one metre of sidestep is 53 deg at 1 m away
// and 14 deg at 4 m. So distance is not a tie-breaker here, it is the first
// question — past a couple of metres the useful instruction is "get closer",
// and only then "walk around it".
const GUIDE_NEAR_M = 2.5;
// ...and the distance at which it stops saying so. A single threshold flips the
// instruction back and forth as someone walks the boundary — measured on a
// recorded walk, the same target alternated 'closer' and 'dwell' repeatedly
// while the distance hovered around 2.5 m.
const GUIDE_NEAR_LEAVE_M = 2.2;
// Below this a cluster is one or two corners of nothing in particular. Sending
// someone across a room for it is worse than saying nothing.
const GUIDE_MIN_MEMBERS = 3;
// Past this it is not this walk's problem.
const GUIDE_MAX_M = 6;
// The target must not change under the reader's feet. A guide that re-picks at
// 10 Hz is not guidance, it is a flicker — so the standing target is kept until
// something is clearly better, not merely better.
const GUIDE_STICKY = 1.35;

// The solve path's own account of itself, for replay only (`--trace`). The
// lock's failure is a *dynamics* problem — supply is there, the solve is not —
// and no counter that survives a whole session can distinguish "few points
// were aliased when the frame arrived", "adoption could not claim them" and
// "the solver threw them out". Those are three different fixes, so the trace
// records the count at each step of one frame's arithmetic rather than the
// total at the end.
//
// Absent a `trace` callback nothing here computes, allocates or writes: the
// probe is the one expensive part (it projects the whole refined map a second
// time) and the live path must never pay for it.
function createLandmarks({ log = () => {}, opts = {}, trace = null } = {}) {
  // Tunable so replay can sweep them against a recorded session rather than
  // having them argued: the trade is coverage against the chance of adopting
  // the wrong feature, and only a real room can say where it sits.
  const reassocPx = opts.reassocPx ?? REASSOC_PX;
  const reassocMargin = opts.reassocMargin ?? REASSOC_MARGIN;
  const solveReassocPx = opts.solveReassocPx ?? SOLVE_REASSOC_PX;
  const stalePx = opts.stalePx ?? STALE_PX;
  const staleStreak = opts.staleStreak ?? STALE_STREAK;
  const guideClusterM = opts.guideClusterM ?? GUIDE_CLUSTER_M;
  // The consensus gates, swept the same way: supply against ghosts, and only
  // a recorded walk can say where the trade sits.
  const voxelMinN = opts.voxelMinN ?? VOXEL_MIN_N;
  const voxelMinViews = opts.voxelMinViews ?? VOXEL_MIN_VIEWS;
  const consensusAdoptPx = opts.consensusAdoptPx ?? CONSENSUS_ADOPT_PX;
  // The count gate itself. replay-landmarks advertised --min-landmarks and
  // never wired it — a sweep of the single most consequential number in the
  // module silently measured the default every time.
  const minLandmarks = opts.minLandmarks ?? MIN_LANDMARKS_FOR_FIX;
  // The RANSAC's outlier gate, and the confirmation gate that shadows it.
  // Swept together *and* separately on purpose: raising the trim without
  // raising the confirmation ceiling buys solves that can never be confirmed
  // (an inlier set admitted at 10 px has an rms past a 5 px confirm bar), and
  // raising both at once measures two things with one number. The trace
  // measured why this is the knob: 45-55% of *correctly corresponded* refined
  // landmarks already reproject past 5 px under a tag-derived pose, so the
  // trim is rejecting real landmarks, not mismatches (.plans/landmark-lock.md
  // §3a).
  const trimPx = opts.trimPx ?? null;
  const confirmRms = opts.confirmRms ?? LANDMARK_CONFIRM_RMS_PX;
  // Swept, and disableable (Infinity), so the sweep can measure what the gate
  // is worth rather than assuming it.
  // The chained-founding cap, swept for the same question as --max-found-depth:
  // whether founding under anything but a tag-confirmed pose is what puts the
  // landmark map in a frame of its own.
  const landmarkMaxDepth = opts.landmarkMaxDepth ?? LANDMARK_MAX_DEPTH;
  const takeoverMinInliers = opts.takeoverMinInliers ?? LANDMARK_TAKEOVER_MIN_INLIERS;
  const jumpM = opts.jumpM ?? SOLVE_JUMP_M;
  const jumpDeg = opts.jumpDeg ?? SOLVE_JUMP_DEG;
  // The mint-block radius around an existing landmark is one voxel, not
  // CLUSTER_M: 5 cm is smaller than the quantisation itself, so at the depth
  // noise a consensus estimate of a feature an existing landmark already
  // marks routinely lands 5-12 cm away and minted a duplicate beside it —
  // and near-duplicate projections kill each other's reassociation under the
  // uniqueness margin. Swept on both instrumented walks: at CLUSTER_M the
  // 17:49 walk's only cross-check solve disappeared (0 of 1); at VOXEL_M
  // both walks kept every solve (3 and 1) with supply still 568/214.
  const voxelClusterM = opts.voxelClusterM ?? VOXEL_M;
  // The qualification gates themselves, so a replay can sweep the thing the
  // whole feature turns on. They were advertised by replay-landmarks.js and
  // never wired to anything, which meant the one question the tool exists to
  // answer — is 60 deg of arc really necessary — could not be asked of it.
  const qualifyOpts = {};
  if (opts.minObs !== undefined) qualifyOpts.minObs = opts.minObs;
  if (opts.minArcDeg !== undefined) qualifyOpts.minArcDeg = opts.minArcDeg;
  if (opts.splitCollapse !== undefined) qualifyOpts.splitCollapse = opts.splitCollapse;
  if (opts.maxRmsPx !== undefined) qualifyOpts.maxRmsPx = opts.maxRmsPx;
  // clientId -> {
  //   gen,
  //   tracks:  Map(trackId  -> { obs, est }),  candidates, not yet landmarks.
  //            `est` is the last qualification attempt's point and arc, kept
  //            only so the maps can show what is being worked on — see
  //            `candidates`. Nothing in the solve reads it.
  //   landmarks: Map(landmarkId -> {P,n,span,err}),
  //   alias:   Map(trackId  -> landmarkId),  which track is currently looking at it
  // }
  //
  // The landmark id is deliberately *not* the track id it was born from. An
  // optical-flow track is a few seconds of correspondence and nothing more —
  // measured, the set turns over almost completely across a fast pan — so
  // addressing a landmark by the track that discovered it makes the whole map
  // unusable within seconds of collecting it, which is exactly what happened:
  // 133 good landmarks and a solve that could match fewer than 15 of them.
  //
  // The landmark is a fixed 3D point, so it can be found again: project it through
  // the current pose and see which freshly seeded corner is sitting on it. That
  // is what `reassociate` does, and it turns the map from "usable while its
  // tracks live" into "usable while it is being looked at".
  const clients = new Map();
  // `bestSpan` is the single most useful number here and the reason the others
  // are not enough. Landmarks need orbiting motion — a walk *past* something gives
  // a narrow effective baseline however long it is looked at — and when nothing
  // qualifies, "no landmarks" is indistinguishable from "broken" without knowing
  // how wide an arc the room has actually been seen through. Measured on real
  // recorded sessions: median per-feature arc 3.5-8.9 deg against the gate,
  // i.e. normal walking never gets close, and that is the behaviour to surface
  // rather than a bug to hunt.
  const stats = {
    observed: 0, qualified: 0, qualifiedDepth: 0, qualifiedConsensus: 0,
    solved: 0, refused: 0,
    // Solves thrown out by the jump gate. The number that says whether a
    // looser trim is buying mirrors: it should be 0 at today's gates and
    // non-zero exactly where the holdout's worst case blows up.
    jumped: 0,
    // Consensus landmarks dropped by the staleness gate early in their life —
    // the ghost tripwire from the plan: a depth mixture that slipped past the
    // viewpoint gate does not survive reprojection against tag-derived poses
    // for long, so a high early-death rate means VOXEL_MIN_VIEWS is too loose.
    consensusEarly: 0,
    // Coarse consensus landmarks upgraded to triangulation grade — the
    // number that decides whether the kitchen can ever solve.
    refinedConsensus: 0,
    reassociated: 0, rej: {},
    // Landmarks dropped for disagreeing with the tags, and the distribution of the
    // residual that decides it. The histogram is the tuning surface: the gate is
    // only honest if the bulk of a healthy session sits well below it, and
    // that is not something to assume — an landmark's own qualification RMS runs
    // 2.3-7.0 px, but a residual is measured through a *later* pose and carries
    // that pose's error too.
    dropped: 0, resid: [0, 0, 0, 0, 0, 0], checked: 0,
  };
  const RESID_EDGES = [2, 4, 8, 16, 32];

  const bump = (why) => { stats.rej[why] = (stats.rej[why] ?? 0) + 1; };

  function stateFor(clientId, gen) {
    let s = clients.get(clientId);
    if (!s) {
      s = {
        gen, tracks: new Map(), landmarks: new Map(), alias: new Map(),
        bestSpan: 0, nextLandmark: 1,
        depthErrs: [], depthTrustedWas: false,
        voxels: new Map(), reportSeq: 0, sinceSolve: Infinity,
        // Trace-only. `reportSeq` cannot serve as the trace clock: it is bumped
        // by consensusObserve, which runs on founding frames and never on the
        // tag-less ones the trace is about, so it stands still across exactly
        // the stretch being measured. `aliasBorn` dates each adoption so alias
        // age is readable, `traceLive` is last traced frame's aliased points so
        // deaths are countable.
        traceSeq: 0, aliasBorn: new Map(), traceLive: new Set(),
      };
      clients.set(clientId, s);
    }
    // Track ids only mean anything within one tracker generation. A reset the
    // server does not hear about is the worst failure mode available here: it
    // does not lose a landmark, it invents one, by fusing observations of two
    // different physical points under one id.
    if (s.gen !== gen) {
      log(`Landmarks: client ${clientId} tracker generation ${s.gen} -> ${gen}, `
        + `dropping ${s.landmarks.size} landmark(s)`);
      s.gen = gen;
      s.tracks.clear();
      s.landmarks.clear();
      s.alias.clear();
      s.lastPose = null;
      s.bestSpan = 0;
      s.liveNow = 0;
      s.guide = null;
      // A new session re-measures its own depth: the bias is per-session
      // state as much as the tracks are.
      s.depthErrs = [];
      s.depthTrustedWas = false;
      // The consensus accumulator was built from the old generation's poses.
      s.voxels.clear();
      s.reportSeq = 0;
      s.sinceSolve = Infinity;
      s.traceSeq = 0;
      s.aliasBorn.clear();
      s.traceLive.clear();
    }
    return s;
  }

  // The depth trust verdict for one client-session: sample count, the live
  // scale (median d/z vs the tags), and the relative residual after removing
  // it. Recomputed per ask — the ring is 50 pairs. Hysteresis rides on
  // `depthTrustedWas`, which only noteDepth writes, so every caller inside
  // one report sees one verdict and replays stay deterministic.
  function depthState(s) {
    const n = s.depthErrs.length;
    if (n < DEPTH_TRUST_MIN_N) return { n, trusted: false, k: 1, residRel: null };
    const ks = s.depthErrs.map((e) => e.d / e.z).sort((a, b) => a - b);
    const k = ks[n >> 1];
    const rel = s.depthErrs.map((e) => Math.abs(e.d / k - e.z) / e.z).sort((a, b) => a - b);
    const residRel = rel[n >> 1];
    const bar = s.depthTrustedWas ? DEPTH_TRUST_REL_OFF : DEPTH_TRUST_REL;
    return { n, trusted: residRel <= bar, k, residRel };
  }

  // The hybrid qualification: depth answers "is this a fixed 3D point" (the
  // split-arc test's job), triangulation answers "where exactly" (its
  // measured 26-50 mm grade), and the arc only has to condition the latter —
  // 5° instead of 20°. Null when depth is untrusted, the estimates are
  // inconsistent, or the refined triangulation walks away from them.
  function depthQualify(s, obs, opts) {
    const ds = depthState(s);
    if (!ds.trusted) return null;
    const dObs = obs.filter((o) => o.d != null);
    if (dObs.length < DEPTH_EST_MIN) return null;
    const cells = new Set();
    const est = dObs.map((o) => {
      const dc = o.d / ds.k;
      cells.add(`${Math.round(o.pose.p[0] / DEPTH_VIEW_CELL_M)}:`
        + `${Math.round(o.pose.p[2] / DEPTH_VIEW_CELL_M)}`);
      return transformPoint(o.pose, [
        (o.u - o.K.cx) / o.K.fx * dc,
        (o.v - o.K.cy) / o.K.fy * dc,
        dc,
      ]);
    });
    if (cells.size < DEPTH_MIN_VIEWS) return null;
    const med = [0, 1, 2].map((k) =>
      est.map((e) => e[k]).sort((a, b) => a - b)[est.length >> 1]);
    const devs = est.map((e) => dist3(e, med)).sort((a, b) => a - b);
    // Tolerances scale with the point's distance, like the measured noise.
    const zMed = dObs.map((o) => o.d / ds.k).sort((a, b) => a - b)[dObs.length >> 1];
    if (devs[devs.length >> 1] > Math.max(DEPTH_EST_TOL_M, DEPTH_EST_TOL_REL * zMed)) {
      return null;
    }
    // splitFloorMm: Infinity disables exactly the no-collapse gate — depth
    // consistency across viewpoints just did that gate's job. The rms gate
    // stays: a triangulation that cannot explain its own pixels is refused
    // whatever depth says.
    const j = qualifyTrack(obs, {
      ...opts,
      minObs: Math.min(opts.minObs ?? MIN_OBS, DEPTH_EST_MIN),
      minArcDeg: DEPTH_HYBRID_MIN_ARC_DEG,
      splitFloorMm: Infinity,
    });
    if (!j.ok) return null;
    if (dist3(j.P, med) > Math.max(DEPTH_AGREE_M, DEPTH_AGREE_REL * zMed)) return null;
    return j;
  }

  // ±1024 cells of 0.12 m is ±122 m of room, packed into one exact integer so
  // the accumulator keys on a number rather than a string built per point per
  // report.
  const voxelKey = (ix, iy, iz) => ((ix + 1024) * 2048 + (iy + 1024)) * 2048 + (iz + 1024);

  // One promotion attempt, centred on a voxel that took a deposit this report
  // — thresholds are only ever crossed by a deposit, and a deposit into a
  // neighbour runs this for that neighbour, so nothing is missed by scanning
  // only what was touched. Reads the 3×3×3 neighbourhood whole (see VOXEL_M:
  // a straddled feature must not be halved out of existence) and clears it
  // whole on promotion.
  function promoteVoxel(s, v) {
    let n = 0;
    let depth = 0;
    const cells = new Set();
    const est = [];
    const keys = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = voxelKey(v.ix + dx, v.iy + dy, v.iz + dz);
          const nb = s.voxels.get(key);
          if (!nb) continue;
          keys.push(key);
          n += nb.n;
          for (const c of nb.cells) cells.add(c);
          for (const e of nb.pts) est.push(e);
          if (nb.depth > depth) depth = nb.depth;
        }
      }
    }
    if (n < voxelMinN || cells.size < voxelMinViews) return 0;
    const med = [0, 1, 2].map((k) =>
      est.map((e) => e[k]).sort((a, b) => a - b)[est.length >> 1]);
    // Same relative consistency discipline as the hybrid: the measured depth
    // noise scales with distance, so a fixed millimetre tolerance would refuse
    // everything far and admit mixtures near.
    const zMed = est.map((e) => e[3]).sort((a, b) => a - b)[est.length >> 1];
    const devs = est.map((e) => dist3(e, med)).sort((a, b) => a - b);
    if (devs[devs.length >> 1] > Math.max(DEPTH_EST_TOL_M, DEPTH_EST_TOL_REL * zMed)) {
      return 0;
    }
    // Consensus at an existing landmark's position is re-observation of it,
    // not a new feature — and if the landmark is wrong there, the staleness
    // path owns that, not a duplicate.
    for (const a of s.landmarks.values()) {
      if (dist3(a.P, med) < voxelClusterM) return 0;
    }
    const j = { P: med, n, span: 0 };
    const landmarkId = s.nextLandmark++;
    // No alias: nothing is looking at it yet by construction — the tracks
    // that fed it may all be dead, which is the point. reassociate adopts a
    // fresh track onto it the next time its projection has one, exactly as
    // for any landmark whose founding track died. Born coarse — see
    // CONSENSUS_ADOPT_PX: the position is depth-grade until the refinement
    // path has re-triangulated it, and the solve must not count it before.
    s.landmarks.set(landmarkId, {
      P: med, n, span: 0, err: null,
      depth, src: 'consensus', coarse: true, robs: [],
    });
    for (const key of keys) s.voxels.delete(key);
    stats.qualified++;
    stats.qualifiedConsensus++;
    return 1;
  }

  // The consensus path: every depth-bearing point sighting deposited into a
  // quantised room-position accumulator, promotion where deposits from spread
  // viewpoints agree. Runs only while the session's own depth measurement
  // holds (depthState.trusted) — this is the depth ban's gate, same as the
  // hybrid's. The report counter is the decay clock: per-report, never
  // wall-clock, so replays are deterministic.
  function consensusObserve(s, pts, camPose, K, foundDepth) {
    const seq = ++s.reportSeq;
    let added = 0;
    const ds = depthState(s);
    if (ds.trusted) {
      const cell = `${Math.round(camPose.p[0] / DEPTH_VIEW_CELL_M)}:`
        + `${Math.round(camPose.p[2] / DEPTH_VIEW_CELL_M)}`;
      const touched = [];
      for (const p of pts) {
        if (p.d == null) continue;
        const dc = p.d / ds.k;
        const P = transformPoint(camPose, [
          (p.u - K.cx) / K.fx * dc,
          (p.v - K.cy) / K.fy * dc,
          dc,
        ]);
        const ix = Math.floor(P[0] / VOXEL_M);
        const iy = Math.floor(P[1] / VOXEL_M);
        const iz = Math.floor(P[2] / VOXEL_M);
        if (Math.abs(ix) >= 1024 || Math.abs(iy) >= 1024 || Math.abs(iz) >= 1024) continue;
        const key = voxelKey(ix, iy, iz);
        let v = s.voxels.get(key);
        if (!v) {
          v = { ix, iy, iz, n: 0, cells: new Set(), pts: [], depth: 0, lastAt: 0 };
          s.voxels.set(key, v);
        }
        // One vote per voxel per report: a frame's two hundred points must
        // not confirm each other — consensus is across frames and viewpoints.
        if (v.lastAt === seq) continue;
        v.lastAt = seq;
        v.n++;
        v.cells.add(cell);
        if (foundDepth > v.depth) v.depth = foundDepth;
        v.pts.push([P[0], P[1], P[2], dc]);
        if (v.pts.length > VOXEL_PTS_RING) {
          let w = 0;
          for (let i = 0; i < v.pts.length; i += 2) v.pts[w++] = v.pts[i];
          v.pts.length = w;
        }
        touched.push(v);
      }
      for (const v of touched) {
        // An earlier promotion this report may have cleared this voxel as a
        // neighbour of the promoted one.
        if (s.voxels.get(voxelKey(v.ix, v.iy, v.iz)) === v) added += promoteVoxel(s, v);
      }
    }
    // Decay, on the report clock. The TTL sweep is strided — it walks the
    // whole map — and the cap eviction runs only when the cap is actually
    // breached.
    if (seq % 64 === 0) {
      for (const [key, v] of s.voxels) {
        if (seq - v.lastAt > VOXEL_TTL_REPORTS) s.voxels.delete(key);
      }
    }
    if (s.voxels.size > VOXEL_CAP) {
      const byAge = [...s.voxels.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
      for (const [key] of byAge.slice(0, byAge.length - VOXEL_CAP)) s.voxels.delete(key);
    }
    return added;
  }

  // The 3D seed correction described at SEED_PAIR_M. Returns a corrected
  // pose, or the seed unchanged when depth is untrusted, the frame carries
  // too little depth, or the pairing is too thin to say anything.
  // `out`, when given (trace only), records what the correction had to work
  // with: the seed is the first thing on the path from a drifted carry to a
  // px match, and a pairing too thin to move it leaves every radius
  // downstream aiming at the wrong place.
  function depthSeedCorrect(s, pts, K, seed, out = null) {
    const ds = depthState(s);
    if (out) { out.seedPairs = 0; out.seedShiftMm = 0; }
    if (!ds.trusted) return seed;
    const deltas = [];
    for (const p of pts) {
      if (p.d == null) continue;
      const dc = p.d / ds.k;
      const P = transformPoint(seed, [
        (p.u - K.cx) / K.fx * dc,
        (p.v - K.cy) / K.fy * dc,
        dc,
      ]);
      let best = null;
      let bestD = SEED_PAIR_M;
      for (const a of s.landmarks.values()) {
        const d = dist3(a.P, P);
        if (d < bestD) { bestD = d; best = a; }
      }
      if (best) deltas.push([best.P[0] - P[0], best.P[1] - P[1], best.P[2] - P[2]]);
    }
    if (out) out.seedPairs = deltas.length;
    if (deltas.length < SEED_PAIR_MIN) return seed;
    const shift = [0, 1, 2].map((k) =>
      deltas.map((d) => d[k]).sort((a, b) => a - b)[deltas.length >> 1]);
    // A correction the size of the room is not drift, it is a wrong pairing.
    if (Math.hypot(...shift) > SEED_SHIFT_MAX_M) return seed;
    if (out) out.seedShiftMm = Math.round(Math.hypot(...shift) * 1000);
    return { p: seed.p.map((v, k) => v + shift[k]), q: seed.q };
  }

  function modelOf(intr) {
    if (!intr || !(intr.fx > 0) || !(intr.fy > 0)) return null;
    return {
      fx: intr.fx, fy: intr.fy, cx: intr.cx, cy: intr.cy, dist: intr.dist ?? null,
    };
  }

  // Take an landmark back out of the map, with everything that referred to it.
  function dropLandmark(s, landmarkId) {
    const a = s.landmarks.get(landmarkId);
    if (!a) return;
    // The ghost tripwire: a consensus landmark that dies young to the
    // staleness gate was very likely never a fixed point at all (a depth
    // mixture at a silhouette), and the rate of these is the number that
    // decides whether VOXEL_MIN_VIEWS is doing its job.
    if (a.src === 'consensus' && (a.checks ?? 0) < 50) stats.consensusEarly++;
    s.landmarks.delete(landmarkId);
    for (const [trackId, id] of s.alias) if (id === landmarkId) s.alias.delete(trackId);
    stats.dropped++;
    // Rare enough to say out loud every time, and worth saying: the map lost a
    // point it had qualified, which on a session where nothing was touched
    // means the re-association is putting tracks on the wrong landmarks.
    log(`Landmarks: landmark ${landmarkId} disagreed with the tags for `
      + `${staleStreak} sightings — dropped (${s.landmarks.size} left)`);
  }

  // Does the landmark still explain what the track is looking at? Called only
  // under a tag-derived pose — see the note on STALE_PX.
  function checkLandmark(s, landmarkId, p, pose, K) {
    const a = s.landmarks.get(landmarkId);
    if (!a) return;
    const q = reproject(a.P, { K, pose });
    // Behind the camera: the landmark is not being looked at, whatever the track
    // is doing. That is an absence of evidence, not evidence against it.
    if (!q) return;
    const d = Math.hypot(p.u - q[0], p.v - q[1]);
    stats.checked++;
    a.checks = (a.checks ?? 0) + 1;
    let b = 0;
    while (b < RESID_EDGES.length && d > RESID_EDGES[b]) b++;
    stats.resid[b]++;
    if (d <= stalePx) { a.bad = 0; return; }
    a.bad = (a.bad ?? 0) + 1;
    if (a.bad >= staleStreak) dropLandmark(s, landmarkId);
  }

  // The upgrade path for a coarse consensus landmark: the adopted track's
  // sightings under founding-grade poses accumulate here, and the same seeded
  // triangulation the hybrid qualification runs replaces the depth-grade
  // position with a px-grade one. The staleness check deliberately does not
  // run while coarse — the reprojection residual against a ±8 cm position is
  // dominated by that position's own error and would drop honest landmarks
  // in five sightings of being looked at.
  //
  // The agreement gate is the wrong-adoption guard reassociate's margin
  // cannot be at the wide radius: a track sitting on a *different* feature
  // triangulates to that feature, lands outside the depth tolerance of the
  // stored position, and a streak of that drops the landmark rather than
  // moving it onto the wrong thing. Within the tolerance, replacing the
  // position IS the refinement.
  function refineLandmark(s, landmarkId, a, p, pose, K) {
    a.robs.push({ u: p.u, v: p.v, K, pose, d: p.d });
    if (a.robs.length > ROBS_RING) {
      let w = 0;
      for (let i = 0; i < a.robs.length; i += 2) a.robs[w++] = a.robs[i];
      a.robs.length = w;
    }
    if (a.robs.length < DEPTH_EST_MIN
      || (a.robs.length - DEPTH_EST_MIN) % QUALIFY_EVERY !== 0) return;
    const j = qualifyTrack(a.robs, {
      ...qualifyOpts,
      minObs: DEPTH_EST_MIN,
      minArcDeg: DEPTH_HYBRID_MIN_ARC_DEG,
      splitFloorMm: Infinity,
    });
    if (!j.ok) return;
    const z = dist3(pose.p, a.P);
    if (dist3(j.P, a.P) > Math.max(DEPTH_AGREE_M, DEPTH_AGREE_REL * z)) {
      a.bad = (a.bad ?? 0) + 1;
      if (a.bad >= staleStreak) dropLandmark(s, landmarkId);
      return;
    }
    a.bad = 0;
    a.P = j.P;
    a.n = j.n;
    a.span = j.span;
    a.err = j.err;
    a.coarse = false;
    delete a.robs;
    stats.refinedConsensus++;
  }

  // Hand landmarks that no track is currently following to whichever fresh point
  // is sitting on them. `pts` are already undistorted, so this works in the one
  // space everything else here does.
  //
  // Only landmarks with no live alias are offered, and only points with no alias
  // are candidates, so nothing is stolen from a track that is still doing its
  // job. The uniqueness margin is the whole safety argument: a wrong adoption
  // does not lose a landmark, it silently moves one.
  function reassociate(s, pts, pose, K, adoptPx = reassocPx) {
    if (!s.landmarks.size || !pose) return 0;
    const taken = new Set();
    for (const p of pts) {
      const a = s.alias.get(p.id);
      if (a !== undefined) taken.add(a);
    }
    const free = pts.filter((p) => !s.alias.has(p.id));
    if (!free.length) return 0;

    let added = 0;
    // Solve-grade landmarks pick first, coarse ones take the leftovers: an
    // adopted point is off the market, and the coarse cloud outnumbers the
    // refined set several-to-one with a wider radius — in insertion order it
    // was adopting the very points the solve needed. Measured on the corner
    // walk (01:20 03/08): 65 of 128 tag-less frames had fifteen refined
    // landmarks within adoption range and the solve fired on 12. The sort is
    // stable, so order stays deterministic within each grade.
    const byGrade = [...s.landmarks]
      .sort((x, y) => (x[1].coarse ? 1 : 0) - (y[1].coarse ? 1 : 0));
    for (const [landmarkId, a] of byGrade) {
      if (taken.has(landmarkId)) continue;
      const q = reproject(a.P, { K, pose });
      if (!q) continue;
      // A coarse consensus landmark's own position noise is tens of pixels,
      // so the tight radius can never catch one — it gets the radius its
      // grade actually needs, and the refinement guard (not this margin) is
      // what keeps a wrong adoption from moving it.
      const radius = a.coarse ? Math.max(adoptPx, consensusAdoptPx) : adoptPx;
      let best = null;
      let bestD = Infinity;
      let secondD = Infinity;
      for (const p of free) {
        if (s.alias.has(p.id)) continue;   // adopted earlier in this same pass
        const d = Math.hypot(p.u - q[0], p.v - q[1]);
        if (d < bestD) { secondD = bestD; bestD = d; best = p; }
        else if (d < secondD) secondD = d;
      }
      // Close enough, and clearly closer than anything else it could be.
      if (!best || bestD > radius || secondD < bestD * reassocMargin) continue;
      s.alias.set(best.id, landmarkId);
      if (trace) s.aliasBorn.set(best.id, s.traceSeq);
      taken.add(landmarkId);
      added++;
    }
    if (added) stats.reassociated += added;

    if (s.alias.size > ALIAS_CAP) {
      const ids = [...s.alias.keys()].sort((x, y) => x - y);
      for (const id of ids.slice(0, ids.length - ALIAS_CAP)) {
        s.alias.delete(id);
        if (trace) s.aliasBorn.delete(id);
      }
    }
    return added;
  }

  // What one frame looked like at the instant its solve began, stated in the
  // terms the four hypotheses are (.plans/landmark-lock.md §4). Reads state
  // and writes none of the product's: if running the probe moved a single
  // count downstream it would have stopped measuring the thing that ships.
  //
  // Called *before* this frame's reassociate — so the alias figures are what
  // the frame arrived carrying, which is the churn question — and *after* the
  // seed correction, so the projections are the ones adoption will really use.
  const median = (xs) => (xs.length
    ? xs.slice().sort((a, b) => a - b)[xs.length >> 1] : null);

  // How far a projection may miss and still be paired for the shift/scatter
  // decomposition below. Wider than any adoption radius on purpose: the
  // question is what the miss *is*, so a window that only admits near misses
  // would answer it by assumption.
  const SHIFT_WINDOW_PX = 60;

  function traceProbe(s, pts, pose, K, intr) {
    const r = {
      refined: 0, inView: 0, near: 0, nearFree: 0, blockedByCoarse: 0, bestPxP50: '',
      aliasTotal: s.alias.size, aliasLive: 0, aliasLiveRefined: 0,
      aliasAgeP50: '', aliasDied: 0,
      shiftPairs: 0, shiftPxU: '', shiftPxV: '', scatterPx: '',
    };
    // In *frame*, not merely in front of the camera: reproject only refuses
    // points behind it, and a landmark projecting 3000 px off the edge is not
    // supply by any reading.
    const w = intr?.w ?? null;
    const h = intr?.h ?? null;
    const live = new Set();
    const ages = [];
    // The same set reassociate builds: a landmark some point in this frame is
    // already looking at is not on offer, and a point already aliased is not a
    // candidate.
    const taken = new Set();
    for (const p of pts) {
      const id = s.alias.get(p.id);
      if (id === undefined) continue;
      taken.add(id);
      live.add(p.id);
      r.aliasLive++;
      const a = s.landmarks.get(id);
      if (a && !a.coarse) r.aliasLiveRefined++;
      const born = s.aliasBorn.get(p.id);
      if (born !== undefined) ages.push(s.traceSeq - born);
    }
    for (const id of s.traceLive) if (!live.has(id)) r.aliasDied++;
    s.traceLive = live;
    const bests = [];
    const offs = [];
    for (const [landmarkId, a] of s.landmarks) {
      if (a.coarse) continue;
      r.refined++;
      const q = reproject(a.P, { K, pose });
      if (!q) continue;
      if (w !== null && (q[0] < 0 || q[0] > w || q[1] < 0 || q[1] > h)) continue;
      r.inView++;
      let bestD = Infinity;
      let best = null;
      let freeD = Infinity;
      for (const p of pts) {
        const d = Math.hypot(p.u - q[0], p.v - q[1]);
        if (d < bestD) { bestD = d; best = p; }
        if (d < freeD && !s.alias.has(p.id)) freeD = d;
      }
      if (!best) continue;
      bests.push(bestD);
      // Per landmark, so the miss can be correlated against how it was
      // founded (arc, count, rms) — a per-frame median can say projections
      // miss by 20 px but not which landmarks miss, and the gate to move is
      // whichever founding property predicts it.
      if (a.traceMiss) a.traceMiss.push(bestD); else a.traceMiss = [bestD];
      if (bestD <= SHIFT_WINDOW_PX) offs.push([best.u - q[0], best.v - q[1]]);
      if (bestD > solveReassocPx) continue;
      r.near++;
      if (!taken.has(landmarkId) && freeD <= solveReassocPx) r.nearFree++;
      // H2: the point this landmark would claim is already spoken for by a
      // *coarse* one. The priority ordering cannot undo that — it orders one
      // pass, and an alias formed on an earlier frame is never revisited.
      const on = s.alias.get(best.id);
      const held = on === undefined ? null : s.landmarks.get(on);
      if (held?.coarse) r.blockedByCoarse++;
    }
    // The decomposition the whole H3-vs-seed question turns on, and the one
    // thing a distance median cannot say: a *rigid* offset shared by every
    // landmark in frame is the seed still being wrong (rotation especially —
    // depthSeedCorrect only ever moves translation), while scatter about that
    // offset is the landmarks' own position error. Same argument, and the same
    // arithmetic, as the 9 px shared-shift measurement that established coarse
    // landmarks were noisy rather than mis-seeded.
    if (offs.length) {
      const mu = median(offs.map((o) => o[0]));
      const mv = median(offs.map((o) => o[1]));
      r.shiftPairs = offs.length;
      r.shiftPxU = Math.round(mu * 10) / 10;
      r.shiftPxV = Math.round(mv * 10) / 10;
      const sc = median(offs.map((o) => Math.hypot(o[0] - mu, o[1] - mv)));
      r.scatterPx = Math.round(sc * 10) / 10;
    }
    const bp = median(bests);
    if (bp !== null) r.bestPxP50 = Math.round(bp * 10) / 10;
    const ap = median(ages);
    if (ap !== null) r.aliasAgeP50 = ap;
    return r;
  }

  // How the inlier set is arranged in space, which the count gate says nothing
  // about. Fifteen landmarks spread over two walls and fifteen on one patch of
  // one wall are the same number and not the same measurement: a single
  // near-coplanar cluster cannot constrain the camera along its own view
  // direction, which is exactly the geometry `.plans/depth-consensus-
  // landmarks.md` refused the few-pair depth fix over.
  //
  // Reported in the *camera's* frame, because that is where the weakness
  // lives: `depthM` is the spread along the view axis — small means one wall,
  // and it is the number a spread gate would test — while `lateralM` is the
  // spread across the frame, which is large even for the degenerate case.
  // Trace only.
  function spreadOf(seen, pose) {
    if (!seen.length) return null;
    const inv = se3Invert(pose);
    let x0 = Infinity; let x1 = -Infinity;
    let y0 = Infinity; let y1 = -Infinity;
    let z0 = Infinity; let z1 = -Infinity;
    for (const l of seen) {
      const c = transformPoint(inv, l.P);
      if (c[0] < x0) x0 = c[0];
      if (c[0] > x1) x1 = c[0];
      if (c[1] < y0) y0 = c[1];
      if (c[1] > y1) y1 = c[1];
      if (c[2] < z0) z0 = c[2];
      if (c[2] > z1) z1 = c[2];
    }
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      lateralM: r2(Math.hypot(x1 - x0, y1 - y0)),
      depthM: r2(z1 - z0),
      nearM: r2(z0),
      // The ratio the gate would most likely be written on: a wall seen
      // head-on has depth spread near zero however wide it is.
      depthRatio: r2((z1 - z0) / Math.max(Math.hypot(x1 - x0, y1 - y0), 0.01)),
    };
  }

  return {
    // The live depth measurement: every detected tag carries both a depth
    // sample (t.d) and the solver's truth for the same pixel (tvec[2]), so
    // the trust verdict and the live bias accumulate from ordinary tag
    // sightings with no ritual attached. Called for every xr-pose report
    // that carries tags, before any founding decision — trust must be able
    // to build on frames that found nothing.
    noteDepth(clientId, gen, tags) {
      if (gen == null || !tags?.length) return;
      const s = stateFor(clientId, gen);
      let took = false;
      for (const t of tags) {
        if (t.d == null || !Array.isArray(t.tvec) || !(t.tvec[2] > 0.3)) continue;
        s.depthErrs.push({ d: t.d, z: t.tvec[2] });
        if (s.depthErrs.length > DEPTH_TRUST_RING) s.depthErrs.shift();
        took = true;
      }
      if (!took) return;
      const ds = depthState(s);
      if (ds.trusted !== s.depthTrustedWas) {
        s.depthTrustedWas = ds.trusted;
        // The runtime verdict the depth ban asks for, out loud — especially
        // its loss, which silently demotes founding back to bearing-only.
        log(`Landmarks: client ${clientId} depth ${ds.trusted ? 'TRUSTED' : 'NOT trusted'}`
          + ` — scale ${ds.k.toFixed(3)}, residual ±${(ds.residRel * 100).toFixed(1)}%`
          + ` over ${ds.n} tag sample(s)`);
      }
    },

    // Called only where a tag-derived camera pose exists — an landmark can be
    // created nowhere else. `camPose` must be the *raw* fix, never a smoothed
    // one: feeding a filter's output into the map that produced it makes the
    // two agree with each other instead of with the room, which is the same
    // reason the tag survey extends and refines on the raw fix.
    // `foundDepth` is the chain depth of the pose the landmarks are founded
    // under: 0 for a tag-confirmed pose, 1 + the deepest confirming landmark
    // for a landmark-confirmed one (stage 5, off at LANDMARK_MAX_DEPTH 0).
    observe(clientId, points, gen, camPose, intr, foundDepth = 0) {
      if (!points?.length || !camPose || gen == null) return 0;
      const K = modelOf(intr);
      if (!K) { bump('no-intrinsics'); return 0; }
      const s = stateFor(clientId, gen);
      // The seed for the first landmark solve after the tags go out of view.
      // Kept here rather than asked of the caller because this is the only
      // place that knows it is still current, and each later solve then seeds
      // the next.
      s.lastPose = camPose;
      let added = 0;

      // Undistorted once, up front: the ring wants it, and so does the
      // re-association below, which would otherwise redo it per candidate pair.
      const pts = points.map((p) => {
        const [u, v] = undistort(p.u, p.v, K);
        return { id: p.id, u, v, d: p.d ?? null };
      });
      // With a tag-derived pose in hand this is the best chance there is to
      // recognise landmarks again, so it happens here rather than only when they
      // are needed.
      reassociate(s, pts, camPose, K);
      // The consensus path sees every depth-bearing sighting, aliased or not
      // — track identity is exactly what it does not consume. Promotions land
      // before the per-track loop, so a consensus landmark is adoptable from
      // the next report on (this report's reassociate already ran).
      added += consensusObserve(s, pts, camPose, K, foundDepth);

      // How many solve-grade landmarks this frame's points are actually on. The
      // aliases outlive their tracks by design (ALIAS_CAP prunes them by age,
      // not by death), so the size of the alias map is a session total and says
      // nothing about now — it reached 696 on a walk holding 764 landmarks.
      // Counted per frame here and at the solve, which is where the number is
      // consumed: against MIN_LANDMARKS_FOR_FIX it is the whole answer to
      // whether this client could localize off landmarks at this instant.
      let liveNow = 0;
      for (const p of pts) {
        // A track already looking at an landmark does not accumulate a second
        // candidate — but the sighting is not thrown away either: with a
        // tag-derived pose in hand it is the one chance to ask whether the
        // landmark is still where the map says — or, for a coarse consensus
        // landmark, the one chance to refine it to a position worth asking
        // that question of.
        const on = s.alias.get(p.id);
        if (on !== undefined) {
          const al = s.landmarks.get(on);
          if (al?.coarse) refineLandmark(s, on, al, p, camPose, K);
          else { checkLandmark(s, on, p, camPose, K); if (al) liveNow++; }
          continue;
        }
        let t = s.tracks.get(p.id);
        if (!t) { t = { obs: [], est: null }; s.tracks.set(p.id, t); }
        const obs = t.obs;
        const { u, v } = p;
        obs.push({ u, v, K, pose: camPose, d: p.d });
        if (obs.length > OBS_RING) {
          // Thin, do not shift: keeping the arc matters, keeping the most
          // recent sightings does not. In place, and keeping every even index,
          // which holds both ends of the arc — the write index never overtakes
          // the read index.
          let w = 0;
          for (let i = 0; i < obs.length; i += 2) obs[w++] = obs[i];
          obs.length = w;
        }
        stats.observed++;

        // The stride is anchored on whatever minimum is in force, or a swept
        // `minObs` would change which sightings are even attempted as well as
        // what passes, and the sweep would measure two things at once. The
        // hybrid path keeps its own stride on its own (smaller) minimum for
        // the same reason — and so the split-arc attempts stay on exactly the
        // sighting counts they have always run at, which is what keeps old
        // journals replaying bit-identically.
        const minObs = qualifyOpts.minObs ?? MIN_OBS;
        const splitDue = obs.length >= minObs
          && (obs.length - minObs) % QUALIFY_EVERY === 0;
        const hybridDue = obs.length >= DEPTH_EST_MIN
          && (obs.length - DEPTH_EST_MIN) % QUALIFY_EVERY === 0;
        if (!splitDue && !hybridDue) continue;
        const j = splitDue ? qualifyTrack(obs, qualifyOpts) : null;
        if (j) {
          // Only from a track a single 3D point can actually explain. A
          // triangulation with no answer lands the point beside the camera, and
          // the bearing to something a few centimetres away sweeps most of a
          // circle as the phone moves — so the *worst* tracks report the widest
          // arcs. Unfiltered, one of them pinned this readout at 234 deg for a
          // whole session while nothing qualified, which is exactly backwards
          // from what it is for.
          if (Number.isFinite(j.err) && j.err < MAX_RMS_PX && j.span > s.bestSpan) {
            s.bestSpan = j.span;
          }
          // What this track currently looks like, kept for the candidate view
          // (see `candidates`). Same gate as bestSpan above and for the same
          // reason: a triangulation with no answer puts the point next to the
          // camera, and plotting those would fill the map with a cloud that
          // follows whoever is holding the phone. Cleared when it fails, so a
          // track that stops resolving stops being shown rather than freezing
          // where it last was.
          t.est = j.P && Number.isFinite(j.err) && j.err < MAX_RMS_PX
            ? { P: j.P, span: j.span, err: j.err }
            : null;
        }
        let q = j?.ok ? j : null;
        let viaDepth = false;
        if (!q && hybridDue) {
          q = depthQualify(s, obs, qualifyOpts);
          viaDepth = !!q;
        }
        if (!q) {
          if (j && !j.ok) bump(j.reason);
          continue;
        }
        // Promoted: it gets an identity of its own, and the track that found it
        // becomes merely the first thing to be looking at it. The observations
        // are dropped: a landmark is checked by reprojection from then on (see
        // checkLandmark), never re-triangulated, and holding sixty sightings each
        // for hundreds of landmarks is memory for nothing. `src` is provenance
        // for replay and diagnostics only — downstream a landmark is a landmark.
        const landmarkId = s.nextLandmark++;
        s.landmarks.set(landmarkId, {
          P: q.P, n: q.n, span: q.span, err: q.err,
          depth: foundDepth, src: viaDepth ? 'depth' : 'arc',
        });
        s.alias.set(p.id, landmarkId);
        if (trace) s.aliasBorn.set(p.id, s.traceSeq);
        s.tracks.delete(p.id);
        stats.qualified++;
        if (viaDepth) stats.qualifiedDepth++;
        // A landmark founded this frame is one the camera is looking at by
        // definition — the track that founded it is still on it.
        liveNow++;
        added++;
      }
      s.liveNow = liveNow;
      return added;
    },

    // Called only where no usable tag observation exists. Returns the camera's
    // room pose, or null — and null is the common, correct answer.
    //
    // `seed` is the caller's best current guess (the smoothed or predicted
    // pose); without one this falls back on the last pose it saw for this
    // client, tag-derived or its own. A seed is required, not an optimisation:
    // the solver is a seeded refinement, which is what keeps it out of the
    // mirrored basin that a seedless solve on near-coplanar bearing-only points
    // falls into.
    // `note` is trace-only: what the *caller* knows and this does not (which
    // seed it handed over, how long since the last solve), merged into the row.
    solve(clientId, points, gen, intr, seed = null, note = null) {
      if (!points?.length || gen == null) return null;
      const K = modelOf(intr);
      if (!K) return null;
      const s = clients.get(clientId);
      if (!s || s.gen !== gen) return null;
      // The row is emitted on every exit below, the early ones included, so a
      // trace has one line per eligible frame — a CSV whose denominator was
      // silently the solve *attempts* would answer the wrong question.
      const row = trace ? { seq: s.traceSeq++, pts: points.length, ...(note ?? {}) } : null;
      const emit = (outcome, extra) => { if (row) trace({ ...row, ...extra, outcome }); };
      if (s.landmarks.size < minLandmarks) { emit('no-map'); return null; }
      const carried = seed ?? s.lastPose;
      if (!carried) { stats.refused++; emit('no-seed'); return null; }

      // Undistorted here as at observe, so one convention holds across the
      // whole module and the solver is told the camera is ideal. Depth rides
      // along for the seed correction below.
      const pts = points.map((p) => {
        const [u, v] = undistort(p.u, p.v, K);
        return { id: p.id, u, v, d: p.d ?? null };
      });
      // The carried seed may have drifted past any adoption radius — measure
      // and remove the bulk of the drift in 3D before asking for px matches.
      const from = depthSeedCorrect(s, pts, K, carried, row);
      // The probe reads the frame as it arrived — before the reassociate below
      // changes it.
      if (row) Object.assign(row, traceProbe(s, pts, from, K, intr));
      // Recognise what can be recognised from the seed *before* solving, which
      // is what makes a long tag-less stretch survivable: without it the
      // matchable set only ever shrinks as tracks die.
      const adoptedTight = reassociate(s, pts, from, K);

      const match = () => {
        const objs = [];
        const imgs = [];
        const metas = [];
        for (const p of pts) {
          const landmarkId = s.alias.get(p.id);
          const a = s.landmarks.get(landmarkId);
          // Coarse consensus landmarks are excluded from the fit outright:
          // ±5%·z position noise either wastes the match as a RANSAC outlier
          // or poisons the pose as an inlier. Their aliases still form here
          // — solve-time adoption is how a kitchen landmark gets a track to
          // refine from at the next founding-grade frame.
          if (!a || a.coarse) continue;
          objs.push(a.P);
          imgs.push([p.u, p.v]);
          metas.push({ id: landmarkId, a });
        }
        return { objs, imgs, metas };
      };
      let { objs, imgs, metas } = match();
      if (row) {
        row.adoptedTight = adoptedTight;
        row.matchedTight = objs.length;
        row.adoptedWide = 0;
        row.matchedWide = objs.length;
      }
      // Escalation, not replacement: 3 px assumes the projecting pose is tag-
      // accurate, and a carried pose whose drift is the very thing being
      // measured reprojects in-view landmarks ~26 px off — at 3 px the
      // cross-check adopted nothing and went 0-for-553 on a real walk. The
      // wider radius runs only when the tight one came up short, so the
      // holdout behaviour the sweeps were measured at is untouched wherever
      // 3 px suffices (replacing it outright cost that journal 106 → 88
      // localized frames). The uniqueness margin and the RANSAC are what keep
      // the wide pass honest; swept via --solve-reassoc-px.
      if (objs.length < minLandmarks && solveReassocPx > reassocPx) {
        const adoptedWide = reassociate(s, pts, from, K, solveReassocPx);
        ({ objs, imgs, metas } = match());
        if (row) { row.adoptedWide = adoptedWide; row.matchedWide = objs.length; }
      }
      // The matched set *is* the live count on this path, and it is the honest
      // one to report even when it is short of the gate: "8 live of 15" is why
      // the solve refused, and the dashboard has no other way to see it. Set
      // before the refusal, or a client that never localizes reads as one that
      // is looking at nothing.
      s.liveNow = objs.length;
      if (objs.length < minLandmarks) {
        stats.refused++;
        emit('refused');
        return null;
      }

      // `onReject` costs nothing when untraced and is the only way to tell a
      // solve the trim ate from one that never found a hypothesis — H4's two
      // halves have different fixes.
      const sol = solveLandmarkPose(objs, imgs,
        { fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy }, from,
        {
          minPoints: minLandmarks,
          ...(trimPx === null ? {} : { trimPx }),
          onReject: row ? (d) => Object.assign(row, d) : undefined,
        });
      if (!sol || !sol.p.every(Number.isFinite)) {
        stats.refused++;
        emit('failed');
        return null;
      }
      const pose = { p: sol.p, q: sol.q };
      s.lastPose = pose;
      stats.solved++;
      // And again from the answer, which is better than the seed was: the next
      // report starts with more of the map already found.
      reassociate(s, pts, pose, K);
      // The landmarks that actually supported the fit, with each one's residual
      // under it. Inlier membership is the statement "this landmark was seen
      // this frame", which is what a carve ray hangs on — a landmark merely
      // projected into the frame proves nothing about the line of sight.
      const seen = (sol.inlierIdx ?? []).map((i, k) => ({
        id: metas[i].id, P: metas[i].a.P, res: sol.inlierRes?.[k] ?? 0,
      }));
      const maxDepth = seen.reduce((d, l) => {
        const a = s.landmarks.get(l.id);
        return Math.max(d, a?.depth ?? 0);
      }, 0);
      emit('solved', {
        inliers: sol.inliers, n: sol.n, rms: Math.round(sol.rms * 100) / 100,
        ...(row ? spreadOf(seen, pose) : null),
      });
      return { pose, n: sol.n, inliers: sol.inliers, rms: sol.rms, seen, maxDepth };
    },

    // The cross-check on a tag-less ARCore-carried frame (stage 1/2 of the
    // carving plan): solve against the landmark map — a frozen record of the
    // room frame as the tags defined it, no ARCore in it — and compare with
    // the carried pose. Mutates entry.room exactly the way maintainLandmarks
    // always has (before the journal and the walls carve), and lives here
    // rather than in server.js for the landmarkGate reason: replay-landmarks
    // must replay the identical decision or it measures a different product.
    //
    // On agreement past every gate the report earns mapSafe (`safeVia:
    // 'landmark'`, journalled so a replay can tell the sources apart) and
    // carries `landmarkRays` — the inlier landmarks, seen this frame, whose
    // lines of sight the walls module may carve. Disagreement is not neutral:
    // it is evidence ARCore has drifted, and it must never extend mapSafe.
    //
    // The survey's own quarantine (room.quarantined: founding, unresolved
    // mirror, slip) vetoes absolutely — those say the *room frame* is in
    // doubt, and the landmarks were founded against that very frame, so they
    // would confirm its flip.
    check(clientId, entry) {
      const { msg, room } = entry;
      if (entry.kind !== 'xr-pose' || !room?.pose || room.quality !== 'tracked') return null;
      const s = clients.get(clientId);
      if (!msg.points?.length || msg.gen == null) return null;
      // The ARCore carry: the cross-check's comparison reference, and what a
      // replay re-derives from when a takeover has replaced the reported pose.
      const carried = room.pose;
      // Chained seed: while solves keep landing, each one seeds the next —
      // re-seeding from the carried pose every frame handed the matcher the
      // very drift the previous solve had just measured away. The carry is
      // still the comparison reference below, only the *seed* chains. The seed
      // is the *corrected* carry where there is one, which is the same
      // argument the chain itself rests on: a seed nearer the truth adopts
      // more. It cannot flatter the agreement test, which uses `carried`.
      const chain = s && s.gen === msg.gen && s.sinceSolve <= SOLVE_CHAIN_MAX;
      const fix = this.solve(clientId, msg.points, msg.gen,
        msg.intr ?? msg.intrinsics, chain ? null : room.pose,
        // Trace only: which seed this frame got, and how long the lock has
        // been gone. Read here because sinceSolve is updated on the next line.
        trace && s ? {
          seedSrc: chain ? 'chain' : 'carry',
          sinceSolve: Number.isFinite(s.sinceSolve) ? s.sinceSolve : -1,
        } : null);
      const live = s && s.gen === msg.gen;
      // A frame that did not solve, and a frame whose solve was thrown out as
      // a mirror, are the same thing to the chain — so the counter is only
      // reset once the fix has survived the tripwire below.
      if (!fix) {
        if (live) s.sinceSolve += 1;
        return null;
      }
      const dp = dist3(fix.pose.p, carried.p);
      const deg = quatAngleDeg(fix.pose.q, carried.q);
      // The mirror tripwire (SOLVE_JUMP_M / _DEG). Refused before anything is
      // journalled, and rolled out of the chain: solve() has already written
      // this pose to `lastPose`, so leaving it there would re-seed every later
      // frame from the reflection.
      if (dp > jumpM || deg > jumpDeg) {
        stats.jumped++;
        if (live) {
          s.lastPose = room.pose;
          s.sinceSolve += 1;
        }
        log(`Landmarks: client ${clientId} solve refused as a mirror jump — `
          + `${Math.round(dp * 1000)} mm, ${deg.toFixed(1)}° from the carried pose`);
        return null;
      }
      if (live) s.sinceSolve = 0;
      // Journalled whether or not it changes anything: this line is the
      // measurement LANDMARK_AGREE_M is chosen from, and the replay's parity
      // check reads it back.
      room.lmCheck = {
        dpMm: Math.round(dp * 1000), deg: Math.round(deg * 10) / 10,
        inliers: fix.inliers, rms: Math.round(fix.rms * 100) / 100,
      };
      const agrees = dp <= LANDMARK_AGREE_M && deg <= LANDMARK_AGREE_DEG;
      const confirmed = agrees && room.quarantined !== true
        && fix.inliers >= minLandmarks
        && fix.rms <= confirmRms;
      if (confirmed && LANDMARK_RESCUE && room.mapSafe !== true) {
        room.mapSafe = true;
        room.safeVia = 'landmark';
      }
      let chained = false;
      if (confirmed && room.mapSafe === true) {
        // The rays walls.js may carve free space along. The far end of such a
        // ray asserts nothing — a landmark may be the corner of a chair — so
        // only the line of sight is evidence, and inlier membership is what
        // says the landmark was seen this frame rather than merely projected
        // into it.
        room.landmarkRays = fix.seen.map((l) => ({
          id: l.id,
          p: l.P.map((v) => Math.round(v * 1000) / 1000),
          res: Math.round(l.res * 10) / 10,
        }));
        // Chained founding (stage 5, off at LANDMARK_MAX_DEPTH 0): a
        // landmark-confirmed pose may found deeper landmarks, under the
        // solve's own pose — never the ARCore-carried one; information still
        // flows tags → landmarks → deeper landmarks one way — and only past
        // *half* the agreement thresholds, because each generation compounds
        // the risk of landmarks agreeing with a drift they were founded
        // during.
        const depth = 1 + (fix.maxDepth ?? 0);
        if (depth <= landmarkMaxDepth
          && dp <= LANDMARK_AGREE_M / 2 && deg <= LANDMARK_AGREE_DEG / 2
          && fix.rms <= confirmRms / 2) {
          this.observe(clientId, msg.points, msg.gen, fix.pose,
            msg.intr ?? msg.intrinsics, depth);
          chained = true;
        }
      }
      // The takeover: a solve past the full quality bar that *disagrees* is
      // the drift caught in the act — measured on the corner walk, 7 of 18
      // solves found 100+ mm of it and the pipeline logged them and reported
      // the drifted pose anyway. The reported pose becomes the solve's; the
      // carried one is kept on the entry (`carried`) so replays re-derive
      // from what ARCore actually said. mapSafe is deliberately untouched —
      // where the dot is drawn and what evidence may be carved are different
      // bars, and disagreement still refuses the carve. Quarantine vetoes:
      // the landmarks were founded in the very room frame quarantine says is
      // in doubt.
      // `strong` is the bar for *overruling* ARCore, and it is deliberately
      // higher than the bar for a usable solve: LANDMARK_TAKEOVER_MIN_INLIERS,
      // not minLandmarks. The count is the only property that predicted a
      // solve's disagreement in every walk measured, and this is the one place
      // a solve is trusted alone rather than as corroboration.
      const strong = room.quarantined !== true
        && fix.inliers >= takeoverMinInliers
        && fix.rms <= confirmRms;
      let took = false;
      if (strong && !agrees) {
        room.carried = carried;
        room.pose = fix.pose;
        room.lmFix = true;
        took = true;
      }
      return { fix, dp, deg, agrees, confirmed, chained, took };
    },

    // Distinct landmarks, not raw tracks: several tracks routinely sit on one
    // physical feature and a raw count overstates what the room actually has.
    count(clientId) {
      const s = clients.get(clientId);
      if (!s) return 0;
      return clusterLandmarks([...s.landmarks.values()]).length;
    },

    // What a client needs to be told about its own landmark state, for the
    // on-phone overlay. `bestSpan` is the actionable one: landmarks need a wide
    // viewing arc, that is the thing the person holding the phone controls, and
    // it is the difference between "walk differently" and "this is broken".
    summary(clientId) {
      const s = clients.get(clientId);
      if (!s) return null;
      const ds = depthState(s);
      return {
        landmarks: clusterLandmarks([...s.landmarks.values()]).length,
        // The ones the solve may actually count — arc, hybrid and refined
        // consensus. The difference between this and `landmarks` is the
        // coarse backlog still waiting to be looked at.
        solid: clusterLandmarks(
          [...s.landmarks.values()].filter((a) => !a.coarse)).length,
        candidates: s.tracks.size,
        arc: Math.round(s.bestSpan),
        // The depth verdict, for the phone chip: warming (too few samples),
        // trusted ±N %, or refused ±N % — the difference between "walk a
        // step and glance" and "orbit like before".
        depth: {
          n: ds.n,
          trusted: ds.trusted,
          residPct: ds.residRel === null ? null : Math.round(ds.residRel * 1000) / 10,
          k: Math.round(ds.k * 1000) / 1000,
        },
      };
    },

    // What the dashboard needs beside the cloud it is already being sent. The
    // cloud says where the landmarks are and says nothing about whether they can
    // be used: `live` is how many of them a track is sitting on right now, and
    // against MIN_LANDMARKS_FOR_FIX that is the whole answer to "can this client
    // localize off landmarks at all". The rest of the pipeline's state is on the
    // phone (`summary`) and in the log, neither of which the person at the
    // dashboard is looking at.
    //
    // The drawer used to render the landmark clouds as *regions* — proximity
    // groups, one card each. That is gone: the grouping radius was tuned when a
    // walk produced ~100 landmarks, consensus and depth founding raised that to
    // over 2000, and the card count is linear in supply with no cap, so the last
    // run buried the tag cards under 58 of them.
    viewerState(clientId) {
      const s = clients.get(clientId);
      if (!s) return null;
      const ds = depthState(s);
      return {
        // Counted per frame as the reports come in, not from the alias map:
        // aliases are pruned by age rather than by death, so their count is a
        // session total (696 on a walk holding 764 landmarks) and would read as
        // "the camera can see nearly everything" from anywhere in the room.
        live: s.liveNow ?? 0,
        // Depth trust decides which founding path is running — and, since
        // `guide` falls silent once depth is trusted, whether the phone is
        // being told anything at all. Arc is deliberately not here: measured
        // on this room's journals it founds nothing (0 of 862 qualifications),
        // so a progress bar against it describes a path nobody is on.
        depth: {
          trusted: ds.trusted,
          residPct: ds.residRel === null ? null : Math.round(ds.residRel * 1000) / 10,
        },
      };
    },

    // The tracks that are not landmarks yet, with the arc each has been seen
    // through so far. This is the answer to "nothing is qualifying, is it
    // broken?" — the one question the landmark cloud cannot answer, because it is
    // empty in both the working case and the broken one.
    //
    // What it shows is where the room's *candidate* features are and how far
    // each has got towards the arc gate, which is the thing the person holding
    // the phone controls: a wall of candidates all stuck at 8° is a walk to
    // change, and no candidates at all is something else entirely. Measured on
    // real sessions, normal walking reaches 3-9° against a 60° gate, so the
    // stuck case is the *usual* one and deserves to be visible.
    //
    // Merged like the landmarks are, and sorted widest-arc first so the survivor
    // of each cluster is the best-seen member rather than an arbitrary one.
    candidates(clientId) {
      const s = clients.get(clientId);
      if (!s) return [];
      const est = [];
      for (const t of s.tracks.values()) if (t.est) est.push(t.est);
      est.sort((a, b) => b.span - a.span);
      return clusterLandmarks(est).map((c) => ({
        p: c[0].P.map((v) => Math.round(v * 1000) / 1000),
        span: Math.round(c[0].span),
      }));
    },

    // What to tell the person holding the phone to do next, given where they
    // are standing. Null when there is nothing worth saying — which is the
    // right answer far more often than not, and saying nothing is better than
    // sending someone after two corners of a doorframe.
    //
    // `blocked(a, b)`, when given, answers "does the straight line between
    // these two floor points cross an emitted wall" — injected by server.js,
    // because this module deliberately knows nothing about walls. A target the
    // camera cannot see past a wall is a target in another room: unfiltered,
    // the guidance scored candidates on straight-line distance alone and
    // asked for walks through the [2 6] wall.
    //
    // Returns { p, n, span, need, dist, mode } in room coordinates and degrees:
    //   mode 'closer' — too far for the arc to be worth walking; approach first.
    //   mode 'arc'    — the covered arc is `need` degrees short of the gate.
    //   mode 'dwell'  — wide enough already; keep it in view for more sightings.
    //
    // Which *way* round to walk is deliberately not answered. The phone drew
    // that as a swept arrow and it is gone: the walk it asked for is
    // self-defeating (see the depth exit below), and the direction pick was
    // noise whenever the camera stood opposite the covered arc, which needed a
    // hysteresis band of its own to stop the arrowhead flipping frame to frame.
    guide(clientId, camPose, { blocked } = {}) {
      const s = clients.get(clientId);
      if (!s || !camPose) return null;
      // With trusted depth the whole premise of the instruction is gone: the
      // split-arc gate is no longer how landmarks are founded (measured on
      // the first consensus walks — 0 by arc, all by depth and consensus),
      // and the walk it asks for is self-defeating anyway: walking the arc
      // kills the very tracks it is meant to ripen, the cluster re-seeds in
      // place, the sticky target re-picks it, and the same orbit is demanded
      // forever. Depth founding needs only the walking the person is already
      // doing; the depth chip says so. Say nothing.
      if (depthState(s).trusted) return null;
      const est = [];
      for (const t of s.tracks.values()) if (t.est) est.push(t.est);
      if (!est.length) return null;
      // Widest arc first, so each cluster's representative is its best-seen
      // member — the one whose progress the gate will actually be decided on,
      // since qualification is per track and not per cluster.
      est.sort((a, b) => b.span - a.span);

      const C = camPose.p;
      const losBlocked = (P) => !!blocked && blocked([C[0], C[2]], [P[0], P[2]]);
      let best = null;
      for (const c of clusterLandmarks(est, guideClusterM)) {
        if (c.length < GUIDE_MIN_MEMBERS) continue;
        const head = c[0];
        const P = head.P;
        const dist = dist3(C, P);
        if (!(dist < GUIDE_MAX_M)) continue;
        if (losBlocked(P)) continue;
        // More corners, further along, and nearer: nearer twice over, because
        // it is both less walking to get there and more arc per step once
        // there. Progress saturates at the gate — a track already past 60 deg
        // is not more promising for being further past it.
        const progress = Math.min(1, head.span / MIN_ARC_DEG);
        const score = c.length * (0.3 + progress) / (1 + dist);
        if (!best || score > best.score) best = { score, P, n: c.length, head, dist };
      }
      if (!best) return null;

      // Stickiness: keep the standing target unless the new pick is clearly
      // better. Without this the pick changes with every push as clusters trade
      // places by a hair, and an instruction that moves cannot be followed.
      // The wall test applies to the held target too — stickiness must not pin
      // a target the user has since put a wall between themselves and.
      const prev = s.guide;
      if (prev) {
        const still = clusterLandmarks(est, guideClusterM)
          .map((c) => c[0])
          .find((h) => dist3(h.P, prev.P) < guideClusterM);
        if (still && still !== best.head) {
          const held = dist3(C, still.P);
          if (held < GUIDE_MAX_M && !losBlocked(still.P)
            && best.score < prev.score * GUIDE_STICKY) {
            best = { score: prev.score, P: still.P, n: prev.n, head: still, dist: held };
          }
        }
      }
      const wasFar = s.guide?.far ?? false;
      const far = best.dist > (wasFar ? GUIDE_NEAR_LEAVE_M : GUIDE_NEAR_M);
      s.guide = { P: best.P, score: best.score, n: best.n, far };

      const { P, head } = best;
      const need = Math.max(0, Math.ceil(MIN_ARC_DEG - head.span));
      const out = {
        p: P.map((v) => Math.round(v * 1000) / 1000),
        n: best.n,
        span: Math.round(head.span),
        need,
        dist: Math.round(best.dist * 100) / 100,
      };
      if (far) return { ...out, mode: 'closer' };
      // Wide enough already and still not a landmark: what it is short of is
      // *observations*, not viewpoints — the split-arc gap has to collapse, and
      // that happens as noise averages down with more sightings of the same
      // arc. Measured on real walks, this is the common case by a wide margin:
      // a track that survives the twelve sightings it takes to be judged at all
      // has usually swept 70-85 deg getting there, so "walk around it" would be
      // an instruction to do what has already been done.
      if (!need) return { ...out, mode: 'dwell' };
      return { ...out, mode: 'arc' };
    },

    // For the viewer. Deliberately the merged set, for the same reason.
    // `solid` is the grade split the maps draw: a coarse consensus landmark
    // is a depth-grade guess the solve may not count yet, and showing the two
    // identically is why a working feature looked like nothing was happening.
    forClient(clientId) {
      const s = clients.get(clientId);
      if (!s) return [];
      return clusterLandmarks([...s.landmarks.values()]).map((c) => ({
        p: c[0].P, n: c[0].n, span: Math.round(c[0].span), merged: c.length,
        solid: c.some((a) => !a.coarse),
      }));
    },

    // A client disconnected, the marker size changed (every landmark is in the
    // old metric scale), or the anchor tag went (the room frame is redefined).
    reset(clientId) {
      if (clientId === undefined) clients.clear();
      else clients.delete(clientId);
    },

    stats() {
      return {
        ...stats,
        clients: [...clients.entries()].map(([id, s]) => ({
          clientId: id, gen: s.gen, tracks: s.tracks.size, landmarks: s.landmarks.size,
          bestSpan: s.bestSpan,
        })),
      };
    },

    // Replay needs this to answer "would it have solved with fewer landmarks" —
    // the count gate is the thing most worth testing and the hardest to reach
    // from outside.
    _landmarksFor(clientId) {
      return clients.get(clientId)?.landmarks ?? new Map();
    },

    // Same purpose: which track is on which landmark, so replay probes can
    // measure what a correspondence-based fix would have had to work with.
    _aliasFor(clientId) {
      return clients.get(clientId)?.alias ?? new Map();
    },
  };
}

module.exports = {
  createLandmarks, landmarkGate, foundingDepth,
  MIN_LANDMARKS_FOR_FIX, LANDMARK_MAX_JITTER_MM,
  LANDMARK_AGREE_M, LANDMARK_AGREE_DEG, LANDMARK_CONFIRM_RMS_PX,
  LANDMARK_TAKEOVER_MIN_INLIERS,
  LANDMARK_RESCUE, LANDMARK_MAX_DEPTH,
  OBS_RING, QUALIFY_EVERY, dist3,
};
