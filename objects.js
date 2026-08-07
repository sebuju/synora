'use strict';

// The object map: labelled things in the room, positioned by triangulating the
// bearings a neural detector produced from known camera poses.
//
// ## Why this is not the landmark feature again
//
// Landmarks were removed on 04/08/26 after measuring that they never gave a
// pose where tags could not be seen. The reason was structural: a landmark
// carried **no appearance** and took its identity from optical-flow continuity,
// so re-finding one needed the pose guess you did not have, and cross-session
// re-identification measured 0 usable fixes.
//
// The geometry here is the same geometry that feature had — bearing-only
// triangulation over a parallax arc — and that half was never what failed. What
// is different is identity: a detection carries a **class label**, produced from
// one image with no prior, by a network trained for exactly that invariance. So
// the question this module exists to answer is not "does triangulation work"
// (it does) but "is a class label plus an arrangement enough to know *which*
// chair". `replay-objects.js` is where that is measured, and metric (d) — the
// separation between same-class instances against their own scatter — is the
// number that decides it.
//
// ## What it may touch
//
// Nothing. `objects.js` is written to by the frame pipeline and read by the
// viewer, and it writes to no other module: not `maintainSurvey`, not
// `walls.handleReport`, not the XR alignment, not `mapSafe`, not the reported
// room pose. Object detections never ride the pose message either — they arrive
// on their own socket and are joined by `fseq` — so contamination of the marker
// map is structurally unreachable rather than gated, which is the standard
// `walls.js` sets for evidence that cannot be taken back.

const fs = require('fs');
const { quatRotate, quatConj } = require('./public/pose-math.js');
const {
  normClass, shapeFor, symEig3, mirrorAboutAxis, ellipseToConic,
  circlePoseFromConic, quadPlaneFromCorners, quadCornersOnPlane, quadSizeOnPlane,
  quadTrialCorners, quadPoseFromSize, rayFor, DEFAULTS: OUTLINE_DEFAULTS,
} = require('./outlines.js');

const SAVE_DEBOUNCE_MS = 10000;
const FILE_VERSION = 1;

const DEFAULTS = {
  // --- association ---
  // How far off a mapped object's predicted bearing a detection may be and
  // still be called the same thing. An angle rather than a distance: the whole
  // measurement here is angular, and a metric gate would be tight across the
  // room and useless at arm's length.
  assocMaxDeg: 6,
  // Bootstrap: how a candidate with no position yet decides that a new bearing
  // is the same thing it is already accumulating. Deliberately far looser than
  // the arc gate that governs *trusting* a position — two degrees is nowhere
  // near enough parallax to believe a range, but it is enough to ask "could
  // these two lines be looking at one object", which is all this decides.
  bootstrapMinArcDeg: 2,
  bootstrapMaxRangeM: 12,
  // Only applied when both bearings have a trustworthy elevation. Without it
  // the plan-view test would merge a picture on the wall with the sofa under
  // it; with it applied to clipped boxes it would reject the very sightings the
  // rank-1 path exists to keep.
  bootstrapMaxDyM: 0.8,

  // --- triangulation ---
  // Rays this close to parallel carry no range information at all. The parallax
  // arc gate is the single most load-bearing constant in the module: without it
  // two views from one doorway "triangulate" to a confident wrong distance.
  // Measured synthetically: with *exact* bearings even 1.3 degrees of parallax
  // recovers the point perfectly, so the solver's own conditioning will not
  // catch this — the gate is the only thing that does.
  minArcDeg: 8,
  // How well a box centre points, in pixels of the full camera image. This is
  // not detector jitter alone: it is dominated by the silhouette wandering
  // across the object as the camera moves, which is why it is set well above
  // any reasonable estimate of box noise. It sets the *units* of a ray's weight
  // and therefore how a bearing trades off against a depth sample.
  bearingSigmaPx: 12,
  // Floor on a ray's perpendicular uncertainty, so a detection at arm's length
  // cannot claim millimetre bearing accuracy.
  bearingFloorM: 0.02,
  // Perpendicular distance past which a ray is not explaining this object.
  outlierM: 0.45,
  // Range softening on a ray's weight. A box across the room subtends few
  // pixels and its centre is worth proportionally less.
  distSoftM: 4,
  ringMax: 120,
  // How many of an entry's rays are written to the map file.
  //
  // **The evidence is persisted now, and that is a reversal.** It used to be
  // session-only, on the reasoning that the file is a map and not a journal —
  // but the consequence was an entry that came back from disk holding no
  // geometry at all, and every rule in this module that judges an entry judges
  // its rays. It could not be merged (the merge re-derives a position from the
  // union and re-checks it, which needs rays on both sides), so two entries for
  // one physical object could never be reconciled across a restart and the
  // duplicates were permanent by construction. A reload should change what the
  // map has been shown, not which rules it is subject to.
  //
  // A bounded sample rather than the ring: what a merge, an arc and an inlier
  // fraction all need is *viewpoint spread*, so the sample is taken across
  // distinct viewpoint cells first and only then filled in with the most recent
  // — the tail of a walk is frequently one standpoint, which is the one shape of
  // evidence that answers nothing.
  //
  // **The whole ring**, so the file is a lossless copy of what memory holds and
  // a reloaded entry is not a lossy version of a live one. The sampler below it
  // still governs if this is set lower than `ringMax`, and the argument for
  // *how* to sample stands — spread beats recency, measured: on a ring of 90
  // sightings from one standpoint plus 30 across five others it holds all six
  // cells at a cap of eight where a plain tail holds two.
  //
  // It was 12, to keep the file small enough to open and read. That traded the
  // one property this whole file exists for — being able to overturn a
  // conclusion later — against a convenience, and the convenience was already
  // lost: the map passed 200 kB on entry count alone. The binding cost is not
  // disk, it is that `save` stringifies and writes **synchronously** on the
  // server's event loop, so the number to watch is milliseconds per save, not
  // megabytes on disk. Measured at this ring size: see the note on `ringMax`.
  persistRays: 120,
  // The same treatment for the *outline* evidence. `shape` is the aggregate and
  // the per-sighting candidates are what produced it, so a reloaded object with
  // a stored normal and no observations behind it could not revise that normal
  // until five fresh outline sightings from two standpoints arrived — which is
  // long enough for a wrong one to survive restart after restart. Sampled by
  // the same viewpoint-spread rule and for the same reason: the mirror is
  // resolved across standpoints, so a tail from one standpoint resolves nothing.
  persistShapeObs: 60,
  // The silhouette rings behind `h` and `w`. These carry no viewpoint of their
  // own, and their statistic is an order statistic (a p80), so the sample is
  // taken evenly across the ring rather than off the end: a tail would be the
  // last standpoint's worth and would move the quantile it is meant to preserve.
  // Without this, one clipped box sets `h`, the answer persists, and the ring
  // that would outvote it comes back empty on every load — which is exactly how
  // a 2.70 m refrigerator becomes permanent.
  persistExtents: 120,

  // --- what was seen with what ---
  // How many co-visibility partners an entry keeps. A frame that sees a chair,
  // a table and tag 3 is evidence that those three are near each other and face
  // the same way, and that is the *arrangement* half of this experiment's whole
  // question — whether a class label plus an arrangement can tell one chair from
  // another. Nothing reads it yet, exactly like the appearance vector on a ray:
  // it is recorded because it cannot be recovered later, and it is judged in
  // replay before anything is allowed to depend on it.
  //
  // Forty is above this room's whole map (26 objects and 7 tags) so nothing is
  // dropped here; the cap is a floor under the pathological case, where a
  // detector that names everything turns each entry's record into a copy of the
  // map.
  seenWithMax: 40,

  // --- stale: expected in frame, and not there ---
  // An object that should be visible and is not is the only evidence this map
  // will ever get that something has been taken away. Nothing else can produce
  // it: a removed object simply stops being sighted, which is indistinguishable
  // from one nobody has walked past.
  //
  // The geometry is `makeScorer`'s negative-evidence test with the hypothesis
  // taken out — here the room pose is known, so "should have been in frame" is a
  // projection rather than a guess. What is different is the *bar*, because the
  // consequence is different: there it tips a score between two hypotheses, here
  // it removes something from the map.
  //
  // **Every guard below exists because the naive version convicts everything.**
  // A detector at this recall misses a chair it can see on most frames; a fridge
  // behind a counter is invisible from half the room; a frame that returned
  // nothing at all says something about the exposure and nothing about the room.
  // So: only frames that detected *something* count, only objects comfortably in
  // frame and in range count, a single sighting resets the whole streak, and the
  // streak has to span several standpoints before it convicts.
  stale: true,
  // **Evidence, in nats, not a count of frames.**
  //
  // Counting frames says every look is worth the same, and they are not. A clock
  // detected on 1280 of 1289 chances, one metre away, dead centre and facing the
  // camera, going undetected once is strong evidence. The same clock at 4.5 m at
  // the edge of frame is worth nothing, and an object this detector names on 3%
  // of its chances is worth nothing whatever it does. Measured on this room, per
  // object recall runs from 0.03 to 0.99 — a factor of thirty — and one global
  // run length was being applied across all of it.
  //
  // So each frame contributes `-log(1 - p)`, where `p` is the chance of a
  // detection *had the object been there* — see `seeChance`. A frame that could
  // not have produced a detection anyway contributes nothing at all rather than
  // counting against the object.
  //
  // The old bar was 80 consecutive frames, about 20 s of continuous looking, and
  // the corpus said it was the first value with no false convictions — because
  // the longest run an object was missed and then seen again was 78. That is not
  // a decision about the room, it is the recall of the worst-detected object in
  // it. At p=0.95 this bar is reached in about 5 s of looking; at p=0.2 it takes
  // minutes, which is correct, because at p=0.2 nothing else was ever known.
  // Four, with the sustained run below. Swept on the corpus against 122
  // labelled episodes: evidence alone tops out at 15 nats and cannot reach zero
  // false convictions at any bar; the run alone needed 80 frames to get there.
  // Together, 4 nats over 40 frames from 3 standpoints convicts 20 episodes with
  // none of them wrong, against the old rule's 18 at twice the looking.
  staleEvidence: 4,
  // And it has to have been *sustained*. The evidence says the looks were worth
  // something; this says they were not scattered across a session. An object
  // hidden from a few standpoints on separate visits accumulates evidence
  // slowly and legitimately, and it is the unbroken run that tells that apart
  // from an object that has actually gone.
  staleStreak: 40,
  // Below this many nats a frame carries nothing worth compounding, and a long
  // series of near-worthless looks should not add up to a verdict. Guards the
  // failure the counter had: evidence accumulating from frames that never had a
  // chance of a detection.
  staleMinFrameEvidence: 0.05,
  // How small the object may look and still be expected. Apparent pixels across,
  // from the size the map holds and the range. A clock at 4.8 m is a few pixels
  // and its absence says nothing about the room.
  staleMinPx: 20,
  // Prior counts on the recall estimate, so a brand-new entry starts at even
  // odds instead of at whatever its first frame happened to do. The estimate
  // also excludes the current unbroken miss run: a streak in progress must not
  // drag the recall down and immunise the object against its own evidence.
  staleRecallPrior: 1,
  // Clamped, so one perfectly-detected object cannot convict itself in a single
  // frame and one badly-detected one still accumulates something.
  staleRecallMin: 0.02,
  staleRecallMax: 0.95,
  // From this many distinct viewpoint cells. Occlusion is standpoint-correlated
  // — a shelf behind a counter is invisible from half the room and obvious from
  // the other half — so this stays even with `lineOfSight` wired, as the floor
  // under the case where the walls grid has not been carved there yet.
  //
  // Measured, it did almost nothing under the old counter: at a streak of 80 it
  // convicted 18 episodes at one cell and 18 at three. It was protecting a
  // regime the rule never operated in.
  staleMinCells: 3,
  // Near enough that not seeing it means something. Beyond this the detector's
  // own reach, not the room, is what decides.
  staleMaxRangeM: 5,
  // How far inside the frame it has to project. The edge is where a detection is
  // clipped and refused anyway, so an object there is not expected.
  staleInsetFrac: 0.2,
  // Nothing that close is a sighting; it is the phone's own hand.
  staleMinDepthM: 0.5,

  // --- the depth prior ---
  // Measured against the tag solver's own distances, a depth-grade position is
  // worth about 5% of z (5-10 cm at room range), degrading to 0.9-1.7 m past 3 m
  // where the bias *is* the error. The prior's weight is 1/sigma^2 with sigma from that curve,
  // so it collapses on its own out where depth stops meaning anything, rather
  // than being switched off by a gate that would have to be tuned.
  depthRelSigma: 0.05,
  depthFloorSigma: 0.05,
  // Past this range the measured error stops being a scale and becomes the
  // whole reading, so the prior is refused outright rather than down-weighted.
  depthMaxM: 3.5,
  // A prior contributing more than this share of the solution means the object
  // is standing on depth rather than on parallax. Kept, rendered, and excluded
  // from localization — see `priorFrac`.
  priorFracMax: 0.35,

  // --- promotion ---
  // Was 8, chosen by analogy with the survey's `PROMOTE_MIN_ESTIMATES` and
  // never measured here — a tag is a very different thing from a sofa glimpsed
  // while turning. Swept over the Objects365 corpus (8 walks, 2063 frames):
  // 3 -> 19 promoted, 4 -> 18, 6 -> 15, 8 -> 13, 10 and 12 -> 13. Across the
  // whole sweep metric (d) reported **zero** ambiguous same-class pairs and the
  // worst separation ratio never moved off 12.4, so the higher bar was not
  // defending against anything this room can show.
  //
  // 6 rather than 3: the sweep says what the bar does not cost, not what it
  // does not protect against — the other gates (arc, viewpoint cells, two
  // sessions, inlier fraction) are what actually refuse a bad position, and
  // three sightings leaves them very little to work with.
  minSightings: 6,
  // Three distinct viewpoint cells is depth.md's own figure for the mixture
  // defence, and it is the same thing being defended against here: a
  // fore/background confusion at a silhouette cannot stay consistent as the
  // camera moves, and nothing else catches it.
  minViewCells: 3,
  // The bar landmarks failed outright. An object that has only ever been seen
  // in one session has not demonstrated the one property this whole experiment
  // rests on — that it can be re-found tomorrow.
  // **1, and it was 2.** The 2 was there to make an object demonstrate the one
  // property the landmark feature failed outright — that it can be re-found in
  // a later session, where landmarks measured 0 usable cross-session fixes.
  //
  // That reasoning assumed a session boundary means a return visit. In the
  // field it does not: this page runs behind an immersive session on a phone
  // being carried around a room, and a new session there means the program
  // crashed or the battery went. The gate was counting *failures*, not visits,
  // and an object seen for a minute from a dozen viewpoints was refused for the
  // want of an accident.
  //
  // Nothing about position quality rested on it. What refuses a bad position is
  // the parallax arc, the viewpoint-cell spread, the inlier fraction and the
  // sighting count — all four still apply. The cross-session property has not
  // stopped mattering and has not stopped being measured: `replay-objects.js`
  // metric (b) reports how many promoted objects were seen in two or more
  // sessions, which is the landmark comparison, and it is a statistic to read
  // rather than a bar that delays the map in front of the person walking it.
  minSessions: 1,
  minInlierFrac: 0.6,
  // Viewpoint cell size, matching walls.js's own `minViews` quantisation.
  viewCellM: 0.4,

  // --- printed tags are not objects ---
  // A tag is a black square on a white sheet taped to a wall, which is a
  // perfectly good picture as far as a detector is concerned: measured, they
  // come back as `Picture/Frame` and `Monitor/TV`, and `Picture/Frame` was one
  // of the promoted anchors. That is not a mislabelled object, it is a thing
  // that should carry no label at all — and it is the worst possible thing to
  // map, because the survey already knows exactly where every one of them is
  // and a duplicate of it in the object map is a second opinion made of the
  // same evidence.
  //
  // A detection is refused when it is *explained by* a tag: most of the tag's
  // own footprint falls inside the box, and the box is not much bigger than the
  // tag. Both halves are needed. Containment alone would throw away the cabinet
  // a tag happens to be stuck to; size alone would throw away anything small.
  tagInsideFrac: 0.7,
  // A 150 mm tag centred on A4 covers about 2.8x its own area, so 4 leaves room
  // for the margin and for the tag being seen at an angle without reaching the
  // furniture behind it.
  tagBoxAreaMax: 4,

  // --- reconciling two entries of one thing ---
  // How many standard deviations of each side's own position error the merge bar
  // opens by. `outlierM` stays as the floor, so two well-measured entries are
  // judged exactly as before; what changes is that a fragment which does not
  // know where it is gets judged against what it actually claims.
  //
  // A flat bar asks "are these two points close". The question is "could these
  // two be the same point", and the difference between those is each side's own
  // error — which ranges over two orders of magnitude in this room, from 7 mm on
  // a clock circled 85 times to 1.44 m on one standing on a single depth reading
  // at 1.4 degrees of arc.
  //
  // Three, from the pairs it has to reach and the pairs it must not. The plant
  // fragments `#152`/`#301` sit 0.599 m apart at sigmas of 0.018 and 0.067 m,
  // which needs 2.3; the clocks `#136`/`#180` sit 0.739 m apart at 0.007 and
  // 0.033 m and must *not* merge, because at those errors they are genuinely
  // different points and calling them one would invent an agreement neither
  // claims. Three clears the first and stays far below the second.
  mergeSigmaK: 3,
  // And a ceiling, because the scaling has a failure mode at the top end: an
  // entry with a 1.44 m sigma has no position worth the name, and left unbounded
  // it merges with whatever of its class it meets first across three metres of
  // room. Ignorance is not evidence of sameness. Beyond this the honest answer
  // is that the entry has to be measured, not matched.
  mergeMaxM: 1,
  // **Cross-class merging, and the only evidence that can decide it.**
  //
  // Two entries with different class names are one physical object when the
  // detector drew *the same box* for both. Not when they are close — a cluttered
  // room puts 259 cross-class pairs within the position bar — and not when they
  // are seen together, because `dedupe` suppresses per class on purpose, so one
  // thing wearing two labels emits two boxes every frame and looks exactly like
  // two things standing together.
  //
  // Measured on the first walk that recorded overlap, the regimes are far apart
  // and need no careful threshold: one box twice scores 0.985, genuinely nested
  // objects score 0.15-0.19 with containment near 1, and everything else scores
  // 0.000. Half sits in the gap with room on both sides.
  mergeIouMin: 0.5,
  // Over at least this many frames where both were claimed by a detection. One
  // frame of agreement is one frame of the detector being confused the same way
  // twice, which is the failure mode, not the evidence.
  mergeIouFrames: 3,

  // --- shape ---
  // How many sightings with an outline, over how many viewpoint cells, before
  // an object has a shape at all. The cell bar is the same one the position
  // needs and is there for the same reason: **a shape measured from one
  // standpoint is a shape that has not been checked**. One viewpoint cannot tell
  // a plane tilted toward the camera from the mirror of that tilt, which is the
  // one thing the whole aggregation exists to resolve.
  shapeMinObs: 5,
  shapeMinCells: 2,
  shapeRingMax: 60,
  // How far the per-sighting normals may scatter about their own consensus
  // before the aggregate is refused. Not a tolerance on the geometry — a
  // tolerance on the *disagreement*, which is what says the mirror was resolved
  // rather than averaged over. Two hypotheses that both fit inside this would
  // mean the observations carry no preference at all.
  shapeNormalTolDeg: 22,
  // How much tighter the winning hypothesis has to be than the mirror it beat
  // before the answer is one normal rather than two. The tolerance above is a
  // bar on the winner alone and a coin flip passes it — see `resolveNormal`.
  // Below the margin there are two answers and the honest output is none, which
  // is `shapeElevMarginDeg`'s rule moved from where the shape is used to where
  // it is made.
  //
  // Swept on the corpus against `replay-objects.js`'s (o2b) hold-out — refit the
  // normal with one standpoint removed and see whether the answer lands nearer
  // the branch it rejected. Seven entries carry a resolvable normal; the two
  // that flip have margins of 1.1 and 1.7 deg and one of them is a television
  // pitched 38 deg at the ceiling. Every normal with 3 deg or more of margin is
  // stable under hold-out and physically plausible. So 2: it costs 83 of 653
  // shape fixes and buys the map not asserting a plane it never resolved.
  //
  // 3 is measurably worse rather than merely stricter — it also takes
  // `Refrigerator #88`, whose margin rounds to 3.0, whose elevation is 2.8 deg
  // and which flips on none of its five standpoints.
  shapeBranchMarginDeg: 2,
  // The frame's own scale has to be isotropic for an outline to survive the trip
  // from the small frame to camera pixels: an ellipse under an anisotropic scale
  // is a different ellipse and its axes are no longer the object's. The object
  // frame is a plain decimation so this holds by construction; the check is here
  // because "by construction" has to be enforced somewhere or it is an
  // assumption.
  shapeMaxAnisotropy: 0.02,

  // --- the single-object fix ---
  // A recovered plane normal whose elevation differs from the map's stored one
  // by more than this is not the same surface. **Yaw cannot change an
  // elevation**, which is exactly why it is the discriminator: the mirror
  // partner of a solution differs from it in elevation, and the yaw that would
  // hide the difference does not exist.
  shapeElevTolDeg: 20,
  // How much better the winner has to be than its mirror before the answer is
  // one solution rather than two. Below it there are two answers and the honest
  // output is none — the same rule `localize`'s `ambiguityMargin` follows.
  shapeElevMarginDeg: 8,
  // A stored normal flatter than this has no azimuth worth speaking of — a table
  // top points at the ceiling from every direction — so it cannot fix a yaw and
  // the solve is refused rather than run on noise.
  shapeMinHorizNormal: 0.35,
  // The last-resort tie-break is the carried ARCore alignment, and it may only
  // be consulted when the two candidates are further apart than the carry's own
  // measured error. Measured over the corpus, the worst carry error anywhere was
  // 0.370 m, so below that separation the carry cannot tell them apart and using
  // it would be a coin flip wearing a measurement's clothes.
  shapeCarryMinSepM: 0.4,
  // How far the winning candidate may sit from where the carried alignment says
  // the camera is and still be called *supported* by it. Same 1.5 m as the
  // false-fix bar, deliberately: a fix further than that from the truth is
  // counted as false, so a candidate further than that from the carry is not the
  // one the carry is pointing at either — it is two wrong answers and the honest
  // output is none.
  shapeCarryMaxM: 1.5,
  // How far back the *other* things in the room count as evidence for which of
  // two same-class instances is being looked at.
  //
  // This is the discriminator that needs no room pose at all, which is what
  // makes it the only one that reaches the case this feature exists for. A
  // kitchen has a microwave, an oven and a cluttered counter; a living room does
  // not — so "which clock am I looking at" is answered by what else has been in
  // frame, and **ARCore's session poses stay consistent with each other even
  // when the room alignment is lost**, so a detection from a few seconds ago at
  // a known session pose is still perfectly good evidence.
  //
  // 8 s matches `alignWindowMs` and for the same reason: long enough to
  // accumulate what is in the room while walking, short enough that a moved
  // object ages out rather than being believed forever. The vertical field of
  // view is 36 degrees held landscape, so a clock on the wall and the clutter
  // under it are rarely in one frame — a window is not a refinement here, it is
  // the whole mechanism.
  shapeSeenWindowMs: 8000,
  shapeSeenMax: 24,
  // How decisively the supported hypothesis has to beat the other, in units of
  // matched objects minus missing ones. Its own constant rather than a reuse of
  // `ambiguityMargin`: that one is a margin between two *poses* found by the
  // same search, this is a margin between two hypotheses scored by different
  // evidence, and tying them together would make one sweep move both.
  shapeSupportMargin: 1.0,
  // **Off, and measured before being switched off.** The idea is a good one and
  // it is the only rival tie-break that needs no room pose, which makes it the
  // only one that could ever reach the case this feature exists for: a kitchen
  // has a microwave, an oven and a cluttered counter, a living room does not, so
  // what else has been in frame says which room the camera is in.
  //
  // It fails on this room's *map*, not on the reasoning. Metric (d) reports 7
  // `Speaker`, 7 `Cabinet/shelf` and 6 `Refrigerator` instances, so a hypothesis
  // placed almost anywhere finds something to match and the score separates
  // badly. Swept over the corpus (margin -> total false fixes / this path's own
  // false rate): 1 -> 26.7% / 38.6%, 2 -> 18.6% / 36.3%, 3 -> 9.7% / 14.3%,
  // 5 -> 7.8% / 2.6% on 38 fixes, off -> 7.7%. It is only safe once it has
  // shrunk to nothing, and it never moves the number it was built for — fixes on
  // frames the survey could not localize at all stay at **0 of 44** at every
  // setting.
  //
  // Same ending and same standing as the slip veto: the code stays, the replay
  // can sweep it (`--shape-support`), and nothing calls it live. It is the same
  // machinery `localize` uses, and `localize` has never produced a usable fix in
  // this room either — 3 fixes, 2 of them false.
  shapeSupport: false,

  // --- merging ---
  // How many processed detections between reconciliation passes. A **counter,
  // not a timer**: a replay that cannot reproduce its own answer cannot be used
  // to compare two runs, and wall-clock would make the pass land somewhere
  // different every time. The pass is O(n^2) over positioned entries, which is
  // why it is not run per detection.
  mergeEveryN: 200,

  // --- movement ---
  // Furniture moves; tags are not supposed to. Same shape as survey.js's
  // knocked-tag reseed and for the same reason: a slow EMA is right for drift
  // and wrong for something that was picked up and put down elsewhere.
  reseedDisagreeM: 0.6,
  reseedStreak: 10,

  // --- localization ---
  // How far a bearing may sit from a mapped object and still be called a match.
  // Wider than the association gate: association is refining a position that
  // already exists, localization is testing a pose hypothesis that may be
  // metres out before it converges.
  localizeTolDeg: 8,
  // Two correspondences determine the pose exactly, so three is the first
  // number that is also a check on itself.
  localizeMinInliers: 3,
  // What an expected-but-absent object costs. Under one, negative evidence
  // could never overturn a hypothesis that matched one extra box by luck.
  negWeight: 1.0,
  negMaxRangeM: 6,
  negInsetFrac: 0.15,
  // Two hypotheses this far apart are different answers rather than the same
  // answer found twice.
  ambiguityM: 0.5,
  // How much better the winner must be than a materially different runner-up.
  // Below this the constellation is ambiguous and the honest output is nothing.
  ambiguityMargin: 1.0,

  // --- alignment correction (the with-a-prior path) ---
  // Association tolerance against the prior. Tighter than localizeTolDeg
  // because there *is* a prior: a bearing that misses a mapped object by more
  // than this is telling us the association is wrong, not that the alignment
  // drifted that far.
  alignAssocDeg: 5,
  // How long a correspondence stays useful. Long enough to accumulate spread
  // while walking, short enough that a moved object or a slipped session ages
  // out rather than being averaged in forever.
  alignWindowMs: 8000,
  alignWindowMax: 48,
  // Two determine the four unknowns exactly; three is the first that checks
  // itself.
  alignMinObs: 3,
  // Bearings from one spot are one measurement repeated — the same thing
  // walls.js's minViews guards against.
  alignMinCells: 2,
  // A correspondence the converged fit cannot explain was a wrong association.
  alignRejectDeg: 6,
  // If the whole window cannot be explained this well, do not publish a
  // correction at all.
  alignMaxRmsDeg: 3.0,

  // --- the slip veto (contradiction, not correction) ---
  // Association capture radius for the veto, deliberately *wider* than
  // `alignAssocDeg`. The correction path reads a bearing missing by more than 5
  // degrees as a wrong association, which is exactly the reading this path must
  // not take: here that miss is the evidence. The detectable band is therefore
  // [`vetoDeg`, `vetoAssocDeg`] — a slip gross enough to push every bearing
  // past the outer edge associates with nothing at all and is counted as an
  // orphan rather than vetoed, which is reported and not silently a pass.
  vetoAssocDeg: 25,
  // Disagreement past which one correspondence is evidence rather than noise.
  // Well above what a good alignment produces: `bearingSigmaPx` is about half a
  // degree at this focal length, and a decimetre of object position error at
  // 2 m is about 3 — so this is several times the honest residual, and above
  // `alignRejectDeg` so a correspondence the corrector would merely have culled
  // does not become a vote here.
  vetoDeg: 10,
  // A same-class runner-up this close to the winner means the correspondence is
  // a guess between two instances. `conf` is measured not to separate correct
  // labels from incorrect ones, so a wrong correspondence cannot be filtered by
  // confidence — this margin and the quorum are what carry that weight, and a
  // single-class room is the adversarial case for both.
  vetoMarginDeg: 8,
  vetoWindowMs: 8000,
  vetoWindowMax: 96,
  // The quorum. Three disagreeing correspondences, from at least two distinct
  // viewpoint cells (bearings from one spot are one measurement taken twice,
  // the same thing `alignMinCells` and walls.js's `minViews` guard against),
  // over at least two distinct *objects* — a single object that has been moved
  // is the most likely thing in this room to disagree honestly, and furniture
  // moves.
  vetoMinObs: 3,
  vetoMinCells: 2,
  vetoMinObjects: 2,
  // How consistent the disagreement must be in direction, as a circular spread
  // of the signed azimuth errors. A yaw error turns every bearing the same way;
  // a translation error does not, its sign depending on where each object sits
  // relative to the motion — so this cannot be tightened toward zero without
  // refusing the case it is most needed for. 180 disables it.
  vetoDirSpreadDeg: 90,
};

// `normClass` lives in `outlines.js` and is imported above. Class names are
// compared on a normalized key, never as written: two vocabularies are in play
// and they spell the same thing differently — COCO's `pottedplant` against
// Objects365's `Potted Plant` — and an allow-list that missed on case would
// report an empty room rather than a missing entry. It is also what lets a map
// survive a detector swap: an object stored as `refrigerator` and one detected
// as `Refrigerator` are the same key, so the existing `objects.json` keeps
// working. Where the two vocabularies genuinely disagree (`tvmonitor` against
// `Monitor/TV`) they stay different objects, which is honest — nothing here can
// know they were meant to be one.

// Classes worth mapping, one list per vocabulary. Two rules, both stated rather
// than implied: a thing must be plausibly immovable at room-furniture scale,
// and it must not be a person.
//
// `person` is excluded unconditionally and is not a tuning choice — a person is
// a moving object with a class label, and would deposit a confident, well-
// triangulated position in the middle of the room wherever somebody stood
// still. `walls.js` already documents the same hazard for its own grid.
//
// **Kept apart rather than merged into one list.** A merged list would allow
// classes the running model cannot produce, and the map would then read "this
// room has no cabinets" when what happened is "this model has no cabinet".
// Which list is in force comes from the detector's own declared names, not from
// a flag — see `setVocabulary`.
//
// Either list is a starting point that metric (d) is meant to replace: which
// classes this room actually carries, at what separation, is a measurement and
// not a preference.
// Each list is the vocabulary's own, and the exclusions below are stated per
// vocabulary in that vocabulary's spelling rather than as one global set of
// names. The reasoning is about the *thing*, so it usually applies to both — but
// only one of them can name a `Storage box`, and a rule written in names the
// running model cannot produce is a rule that silently does nothing.
const COCO_CLASSES = [
  'refrigerator', 'oven', 'microwave', 'sink', 'toilet', 'tvmonitor', 'tv',
  'sofa', 'couch', 'bed', 'diningtable', 'dining table', 'chair', 'bench',
  'pottedplant', 'potted plant', 'clock', 'bookshelf',
  // `vase` and `book` were here and are gone, for the reason the O365 list
  // states below: both move, and a thing that moves deposits a confident
  // position wherever it last sat. Under COCO they produced three `book`
  // anchors that were almost certainly one shelf.
];

// Objects365, spelled as the model declares them. The point of the swap is the
// second half of this list: cabinets, pictures, lamps, radiators, desks and
// nightstands are among the most immovable things in any room and COCO cannot
// name one of them. Objects365 has no Door, Window or Curtain either — checked
// against the extracted name list rather than hoped for.
//
// **`Mirror` is excluded, and the reason is geometric rather than statistical.**
// A mirror shows the room *behind* the camera. Every bearing to something seen
// in one points at the mirror, and those bearings are consistent with each
// other from every viewpoint — so they triangulate cleanly to a confident
// position for an object that is not there, somewhere behind the wall the
// mirror hangs on. Every gate in this module passes it: the arc is real, the
// inlier fraction is 1.00, the residual is small. It is the same hazard
// `person` is excluded for — a well-triangulated position for a thing that must
// not be mapped — arriving through optics instead of through motion, and it
// needs no measurement from this room to make the case.
//
// What this does *not* fix: objects seen reflected *in* a mirror are still
// detected as themselves and still mapped. The detector does not know it is
// looking at a reflection, and nothing here can tell it.
const O365_CLASSES = [
  'Refrigerator', 'Oven', 'Microwave', 'Sink', 'Toilet', 'Monitor/TV',
  'Couch', 'Bed', 'Dining Table', 'Chair', 'Bench', 'Potted Plant', 'Clock',
  'Cabinet/shelf', 'Picture/Frame', 'Lamp', 'Desk', 'Coffee Table',
  'Side Table', 'Radiator', 'Nightstand', 'Air Conditioner',
  'Dishwasher', 'Washing Machine/Drying Machine', 'Bathtub', 'Fan',
  'Speaker', 'Piano',
];

// Six classes were on the list and are not any more. Each is excluded for what
// the class *is*, in any room — the same standing as `person` and `Mirror`, and
// deliberately not the standing of "this room has no couch", which would be
// overfitting the allow-list to one room's furniture.
//
// - `Storage box` — a box for keeping things in, which is to say a thing that
//   gets moved. Worst ratio in the map: **1 anchor against 10 fragments**.
// - `Vase`, `Book`, `Stool` — all move. `Book` moves constantly and was a COCO
//   holdover; `Stool` is seating.
// - `Trash bin Can` — moved weekly.
// - `Carpet` — a floor plane seen at grazing incidence. Its silhouette centre is
//   whatever fraction of it happens to be in frame, and the floor is normally
//   out of frame entirely (measured: the nearest floor point in a landscape
//   frame is 3.1-5.8 m away). Bearing triangulation has nothing to converge on.
//   Structural, not a preference.
//
// Measured over the corpus: **107 -> 86 entries, 15 -> 14 anchors** — the one
// lost being the `Storage box`, which is the point.
//
// Held rather than dropped, and the reason recorded so it is not re-argued:
// `Lamp` is the single biggest source of fragments (9, no anchors), but floor
// and wall lamps genuinely are immovable and only a table lamp is not — a label
// cannot tell them apart, and the bloom argument (a lit lamp having an unstable
// silhouette) is plausible and **unmeasured**. Dropping it costs a real anchor
// for an argument with no number behind it. `Fan` is the same shape of case.
const O365_DROPPED = [
  'Carpet', 'Storage box', 'Trash bin Can', 'Vase', 'Book', 'Stool',
];

const VOCABULARIES = { coco: COCO_CLASSES, o365: O365_CLASSES };

// Every class any vocabulary in this system can name. The test for "nothing
// will ever bring this entry back" — and the seam between the two situations
// `applyClassRule` used to file under one verdict.
//
// A class the *running* model cannot name may be one the other model can, and
// that is what quarantine is for: the swap is reversible and so is the verdict.
// A class in **neither** list is a different fact. It is on a drop list
// (`O365_DROPPED` — `Book`, `Stool`, `Storage box` and the rest, held out
// because they move or because they are not objects), or it is a name from a
// vocabulary this map no longer has. No model that can be loaded restores it,
// so quarantining it is filing evidence in a cabinet with no door: it stays on
// the wire's exclusion list, in the drawer, and in the stale rule's arithmetic
// for the lifetime of the map, waiting for a restore that cannot arrive.
const EVERY_CLASS_KEY = new Set(
  Object.values(VOCABULARIES).flat().map(normClass));

// Why a detection started a new entry instead of joining one, ordered by how
// far the attempt got. Reported as the furthest any candidate reached, because
// "nothing of this class exists yet" and "one pair crossed but the elevations
// disagreed" call for completely different work.
// Why a frame produced no single-object fix, ordered by how far the attempt
// got. Reported as the furthest any detection reached, because "nothing of this
// class carries a shape" and "two mapped instances disagreed" call for
// completely different work.
const SHAPE_WHY = [
  'noOutline',        // no outline in this frame at all
  'anisotropic',      // the frame is not a plain decimation of the camera image
  'isTag',            // the outline is a printed tag, refused on the way out
  'noShapedObject',   // nothing of this class in the map carries a shape
  'flatNormal',       // the mapped normal points at the ceiling — no azimuth in it
  'noSolution',       // the outline gave no pose at all
  'flatSolution',     // every recovered normal was too flat to fix a yaw
  'elevation',        // the best solution is not the surface the map says this is
  'mirror',           // two mirror solutions, neither preferred — refused, not guessed
  'rivals',           // two mapped instances of the class disagreed about the camera
  'unsupported',      // one unchallenged candidate, and the carry says it is elsewhere
];

const ASSOC_REASONS = [
  'noClassMatch',   // nothing of this class in the map at all — a genuinely new thing
  'bearingMiss',    // positioned entries of this class exist; the bearing missed all of them
  'noPair',         // candidates exist but hold no ray to pair against
  'updown',         // the bearing has no azimuth to work with
  'parallel',       // no pair had enough parallax to cross
  'behind',         // the lines cross, but behind one of the cameras
  'range',          // they cross too far away to be one object
  'elevation',      // they cross in plan view, at incompatible heights
];
const ASSOC_RANK = Object.fromEntries(ASSOC_REASONS.map((r, i) => [r, i]));

// --- small linear algebra, local because it is not shared ---

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { return Math.hypot(a[0], a[1], a[2]); }
function unit(a) { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }
function addv(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function quatMulLocal(a, b) {
  const [x1, y1, z1, w1] = a;
  const [x2, y2, z2, w2] = b;
  return [
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ];
}
function yawQuat(yaw) { return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]; }

// Symmetric 3x3 solve by Gauss-Jordan with partial pivoting. Returns null on a
// singular system, which is what a set of rays with no parallax produces — the
// caller must treat that as "not yet triangulated", never as the origin.
function solve3(A, b) {
  const m = [[A[0], A[1], A[2], b[0]], [A[3], A[4], A[5], b[1]], [A[6], A[7], A[8], b[2]]];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    const d = m[c][c];
    for (let k = c; k < 4; k++) m[c][k] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c];
      if (!f) continue;
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

// Perpendicular distance from a point to a ray, and how far along the ray the
// closest approach sits. Negative `t` means the point is behind the camera,
// which is never a valid explanation of a detection.
function rayDistance(origin, dir, p) {
  const w = sub(p, origin);
  const t = dot(w, dir);
  const proj = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  return { t, d: norm(sub(p, proj)) };
}

// How far a point sits from what a ray actually claims. For a full bearing that
// is the perpendicular distance to the line; for a planar ray it is the
// distance to the vertical plane, because the elevation of that box is not
// evidence and must not be scored as if it were.
function rayResidual(r, p) {
  if (!r.planar) return rayDistance(r.o, r.dir, p);
  const w = sub(p, r.o);
  // `t` is still asked along the full bearing: behind the camera is not a worse
  // explanation of a detection, it is not an explanation.
  return { t: dot(w, r.dir), d: Math.abs(dot(w, r.n)) };
}

// Which frame edges a box ran off, expressed in world axes rather than image
// axes.
//
// The phone is held landscape 98% of the time on the measured walks, which puts
// the image's short 36-degree axis along world *up*. So "clipped left/right" in
// image coordinates usually means "clipped top/bottom" in the room, and the two
// have completely different consequences: a box cut off above and below still
// points in the right direction horizontally, while one cut off at the sides
// does not.
//
// Taken from the camera's own orientation rather than from the roll readout, so
// it is right at 45 degrees as well as at 0 and 90.
// Which image axis world-up runs along, from the camera's own orientation.
//
// Room-up expressed in the camera's CV frame; the image axes are x right and y
// down, so the image-space direction of world-up is just the x,y part. Held
// landscape — 98% of measured frames — this is **true**, and that is the whole
// reason it has to be asked rather than assumed: in landscape the image's y
// extent is the object's width in the room, not its height.
function upAlongImageX(camQ) {
  const up = quatRotate(quatConjLocal(camQ), [0, 1, 0]);
  return Math.abs(up[0]) >= Math.abs(up[1]);
}

function worldClipAxes(clip, camQ) {
  if (!clip) return { h: false, v: false };
  const alongImageX = upAlongImageX(camQ);
  const lr = !!(clip & (CLIP_LEFT | CLIP_RIGHT));
  const tb = !!(clip & (CLIP_TOP | CLIP_BOTTOM));
  // If world-up runs along the image x axis, the left/right edges are the ones
  // that cut the object vertically in the room.
  return alongImageX ? { v: lr, h: tb } : { v: tb, h: lr };
}

function quatConjLocal(q) { return [-q[0], -q[1], -q[2], q[3]]; }

const CLIP_LEFT = 1 << 0;
const CLIP_RIGHT = 1 << 1;
const CLIP_TOP = 1 << 2;
const CLIP_BOTTOM = 1 << 3;

// The eigenvalues of a symmetric 3x3, smallest first. One implementation, in
// `outlines.js`, because the conic solve there needs the eigen*vectors* of the
// same kind of matrix and two closed forms of the same decomposition would
// drift apart with nothing to notice.
function symEigenvalues(A) { return symEig3(A).values; }

// The weighted least-squares intersection of a bundle of rays, plus an optional
// weak prior pulling toward a point depth measured directly.
//
// Each ray contributes the squared perpendicular distance from the solution to
// the line, whose normal-equation block is the projector (I - dd^T), scaled by
// 1/sigma^2 for that ray's perpendicular uncertainty. The prior contributes
// w*I. Both go into one 3x3 system, which is the whole reason the prior does
// not need a handoff: it is one more term, it is outvoted as rays accumulate,
// and there is no moment at which the estimate switches source and jumps.
//
// **`priorFrac` is taken against the worst-constrained direction, not against
// the total weight**, and that distinction is the whole measurement. A bearing
// carries no information at all along its own axis — (I - dd^T) is singular in
// that direction — so a bundle of near-parallel rays can have an enormous total
// weight while leaving range entirely to the prior. Comparing the prior to the
// *sum* of ray weights reports such an object as well-triangulated; comparing
// it to the smallest eigenvalue of the ray information matrix reports it as
// what it is. Measured on the first synthetic pass, the sum-based version
// showed 79% prior at sixteen rays spanning 84 degrees of arc — a number that
// was describing the units mismatch rather than the geometry.
function triangulate(rays, prior) {
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b = [0, 0, 0];
  let wSum = 0;
  for (const r of rays) {
    const w = r.w;
    // A **planar** ray is a box that ran off the frame vertically in world
    // terms — the object continues above or below the view, so the box centre
    // is pulled vertically by an unknown amount and its elevation means
    // nothing, while its azimuth is untouched. It therefore contributes what it
    // actually knows: "the object lies on this vertical plane through the
    // camera", a rank-1 term rather than the rank-2 term a full bearing gives.
    //
    // This is where the recovered supply comes from. Measured on the first real
    // walks: 36.5% of all detections are clipped only on the world-vertical
    // axis, and refusing them threw away almost every sighting of exactly the
    // immovable furniture the map wants — refrigerator 0 clean of 24, microwave
    // 1 of 38, oven 3 of 56.
    const p = r.planar
      ? [r.n[0] * r.n[0], r.n[0] * r.n[1], r.n[0] * r.n[2],
        r.n[1] * r.n[0], r.n[1] * r.n[1], r.n[1] * r.n[2],
        r.n[2] * r.n[0], r.n[2] * r.n[1], r.n[2] * r.n[2]]
      : (() => {
        const [dx, dy, dz] = r.dir;
        return [
          1 - dx * dx, -dx * dy, -dx * dz,
          -dy * dx, 1 - dy * dy, -dy * dz,
          -dz * dx, -dz * dy, 1 - dz * dz,
        ];
      })();
    for (let i = 0; i < 9; i++) A[i] += w * p[i];
    for (let i = 0; i < 3; i++) {
      b[i] += w * (p[i * 3] * r.o[0] + p[i * 3 + 1] * r.o[1] + p[i * 3 + 2] * r.o[2]);
    }
    wSum += w;
  }
  // How well the rays alone pin down their worst direction, before the prior is
  // added. This is what the prior is competing with.
  const rayLambdaMin = rays.length ? Math.max(0, symEigenvalues(A)[0]) : 0;
  // The same thing restricted to the horizontal plane.
  //
  // A bundle of planar rays carries **no** vertical information by
  // construction, so the 3x3 minimum is exactly zero however much parallax
  // there is, and `priorFrac` came out 100% for objects that were in fact very
  // well triangulated: measured on a real walk, a refrigerator with 56 degrees
  // of arc and 11 mm residuals reported the prior as doing all the work. It was
  // describing the height, which nothing had measured, rather than the position
  // — and it was the number excluding that object from being used.
  //
  // When the height is derived rather than measured, the honest comparison is
  // against the plane the position actually lives in.
  const tr2 = A[0] + A[8];
  const det2 = A[0] * A[8] - A[2] * A[6];
  const disc2 = Math.max(0, tr2 * tr2 / 4 - det2);
  const rayLambdaMinH = rays.length ? Math.max(0, tr2 / 2 - Math.sqrt(disc2)) : 0;
  let priorW = 0;
  if (prior) {
    priorW = prior.w;
    A[0] += priorW; A[4] += priorW; A[8] += priorW;
    for (let i = 0; i < 3; i++) b[i] += priorW * prior.p[i];
  }
  let p = solve3(A, b);
  // A bundle of nothing but planar rays constrains x and z and says nothing at
  // all about height, so the full 3x3 is singular or nearly so. That is not a
  // failure — it is the honest state of the evidence — and the horizontal
  // position is still perfectly well determined. Solve the horizontal
  // sub-system and take the height from where the bearings actually pass at
  // that horizontal distance, which is a derived number rather than a measured
  // one and is flagged as such.
  let heightDerived = false;
  if (!p) {
    const h = solve3(
      [A[0], 0, A[2], 0, 1, 0, A[6], 0, A[8]],
      [b[0], 0, b[2]],
    );
    if (!h) return null;
    const ys = [];
    for (const r of rays) {
      const dh = Math.hypot(r.dir[0], r.dir[2]);
      if (dh < 1e-6) continue;
      const t = Math.hypot(h[0] - r.o[0], h[2] - r.o[2]) / dh;
      if (t > 0) ys.push(r.o[1] + r.dir[1] * t);
    }
    if (!ys.length) return null;
    p = [h[0], median(ys), h[2]];
    heightDerived = true;
  }
  // Judged against the subspace the rays actually constrain.
  //
  // Tested by ratio rather than by whether the solve fell over: adding a depth
  // prior makes the 3x3 invertible again, so an all-planar bundle takes the
  // ordinary path and its vertical eigenvalue stays ~0 while the horizontal one
  // is large. That is what made a well-triangulated refrigerator report 100%
  // prior. `verticalBlind` says the rays say nothing about height, which is a
  // fact about the evidence and not about which branch the code took.
  const verticalBlind = rayLambdaMin < 0.01 * rayLambdaMinH;
  const against = (heightDerived || verticalBlind) ? rayLambdaMinH : rayLambdaMin;
  return {
    p,
    priorFrac: priorW > 0 ? priorW / (priorW + against) : 0,
    rayLambdaMin: against,
    heightDerived: heightDerived || verticalBlind,
    wSum,
  };
}

// The widest angle between any two contributing rays. This is the number that
// says whether a position was measured or guessed: below the gate the bundle is
// effectively one ray and the "solution" is wherever the prior and the noise
// happened to put it along it.
function arcDeg(rays) {
  let worst = 1;
  for (let i = 0; i < rays.length; i++) {
    for (let j = i + 1; j < rays.length; j++) {
      const c = dot(rays[i].dir, rays[j].dir);
      if (c < worst) worst = c;
    }
  }
  return Math.acos(Math.max(-1, Math.min(1, worst))) * 180 / Math.PI;
}

// The midpoint of the closest approach between two rays, or null when they are
// too near parallel for it to mean anything.
function pairPoint(a, b, minCos) {
  const d1 = a.dir;
  const d2 = b.dir;
  const c = dot(d1, d2);
  if (Math.abs(c) > minCos) return null;
  const w0 = sub(a.o, b.o);
  const den = 1 - c * c;
  const t1 = (c * dot(d2, w0) - dot(d1, w0)) / den;
  const t2 = (dot(d2, w0) - c * dot(d1, w0)) / den;
  if (t1 <= 0 || t2 <= 0) return null;   // behind one of the cameras
  return [
    (a.o[0] + d1[0] * t1 + b.o[0] + d2[0] * t2) / 2,
    (a.o[1] + d1[1] * t1 + b.o[1] + d2[1] * t2) / 2,
    (a.o[2] + d1[2] * t1 + b.o[2] + d2[2] * t2) / 2,
  ];
}

// Where two bearings meet in plan view, or null if they do not usefully meet.
//
// The bootstrap question — "could these two sightings be one object" — is asked
// horizontally, because horizontal is the part every ray knows. A vertically
// clipped box has a biased elevation, so in 3D two of them are skew lines that
// come nowhere near each other and would be judged different objects; their
// vertical planes still cross exactly where the object is. Measured: this is
// what kept `oven`, `refrigerator`, `tvmonitor` and `sofa` fragmenting into
// four or five one-sighting entries each after the first association fix.
// `note` is an optional out-object that records *which* test refused. Nothing
// in the solver reads it — it exists because the promotion funnel could say
// "blocked on sightings" without being able to say whether the pair had no
// parallax, crossed behind a camera, or was never asked. A count per reason
// turns the next round of association work from inference into a table.
function pairPointHoriz(a, b, minSin, note) {
  const ax = a.dir[0];
  const az = a.dir[2];
  const bx = b.dir[0];
  const bz = b.dir[2];
  const na = Math.hypot(ax, az);
  const nb = Math.hypot(bx, bz);
  if (na < 1e-6 || nb < 1e-6) {
    if (note) note.why = 'updown';              // pointing straight up or down
    return null;
  }
  const adx = ax / na;
  const adz = az / na;
  const bdx = bx / nb;
  const bdz = bz / nb;
  const cross = adx * bdz - adz * bdx;
  if (Math.abs(cross) < minSin) {
    if (note) note.why = 'parallel';            // no crossing point in plan view
    return null;
  }
  const dx = b.o[0] - a.o[0];
  const dz = b.o[2] - a.o[2];
  const t = (dx * bdz - dz * bdx) / cross;
  const u = (dx * adz - dz * adx) / cross;
  // Behind either camera is not a meeting, it is two lines extended backwards.
  if (t <= 0.05 || u <= 0.05) {
    if (note) note.why = 'behind';
    return null;
  }
  return { p: [a.o[0] + adx * t, a.o[1], a.o[2] + adz * t], t, u };
}

// A robust starting point, by minimal-sample consensus over ray pairs.
//
// Least squares cannot pick its own inliers: measured on a synthetic bundle,
// one ray pointing somewhere else entirely pulled the fit 1.87 m off the truth,
// after which the outlier gate rejected the four *good* rays and kept the bad
// one. So the inlier set is chosen by consensus first and only then refined —
// two rays are the minimal sample for a position, exactly as two
// correspondences are for a heading.
//
// Deterministic: pairs are walked with a fixed stride rather than sampled at
// random, because a replay that cannot reproduce its own answer cannot be used
// to compare two runs.
function robustSeed(rays, outlierM, minArcDeg, maxPairs = 400) {
  if (rays.length < 2) return null;
  const minCos = Math.cos(minArcDeg * Math.PI / 180);
  const minSin = Math.sin(minArcDeg * Math.PI / 180);
  const n = rays.length;
  const total = (n * (n - 1)) / 2;
  const stride = Math.max(1, Math.floor(total / maxPairs));
  let best = null;
  let bestScore = -1;
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++, k++) {
      if (k % stride) continue;
      // Same reasoning as the bootstrap: a pair involving a vertically clipped
      // box has no usable elevation, so it is intersected in plan view and its
      // height taken from whichever ray of the pair still has one. Without
      // this an object that is *always* clipped — a fridge is, in 24 of 24
      // sightings — can never seed a position and so can never be mapped at
      // all, however many times it is seen.
      const anyPlanar = rays[i].planar || rays[j].planar;
      let p;
      if (anyPlanar) {
        const h = pairPointHoriz(rays[i], rays[j], minSin);
        if (!h) continue;
        p = h.p;
        const full = !rays[i].planar ? { r: rays[i], t: h.t } : (!rays[j].planar ? { r: rays[j], t: h.u } : null);
        if (full) {
          const dh = Math.hypot(full.r.dir[0], full.r.dir[2]);
          if (dh > 1e-6) p = [p[0], full.r.o[1] + full.r.dir[1] * (full.t / dh), p[2]];
        }
      } else {
        p = pairPoint(rays[i], rays[j], minCos);
      }
      if (!p) continue;
      let score = 0;
      for (const r of rays) {
        const { t, d } = rayResidual(r, p);
        if (t > 0 && d <= outlierM) score++;
      }
      if (score > bestScore) { bestScore = score; best = p; }
    }
  }
  return best;
}

// --- localization: the constellation matcher ---
//
// The room frame is gravity-aligned to about 2 degrees (measured over the
// existing 200-journal corpus: session-up in room coordinates is
// (-0.016, 0.999, 0.003), spread median 1.99 deg). So the unknown transform
// from a gravity-aligned camera frame to the room is a **yaw and a
// translation** — four numbers, not six.
//
// Each bearing correspondence supplies two constraints, so **two
// correspondences determine the pose exactly**. That is what makes the search
// tractable and, more importantly, deterministic: with two-correspondence
// minimal samples the RANSAC is an exhaustive walk over C(n,2) rather than a
// random draw, and a replay that cannot reproduce its own answer cannot be used
// to compare two runs.
//
// Solving one minimal sample, in closed form. With O_i the mapped positions,
// b_i the gravity-frame bearings and C the camera:
//
//     O_i - C = lambda_i * R * b_i,  lambda_i > 0
//     O_2 - O_1 = R * (lambda_2 b_2 - lambda_1 b_1)
//
// R is a yaw, so it preserves the vertical component and the horizontal
// magnitude of whatever it turns. Writing V = O_2 - O_1 that is two equations
// in the two unknown ranges — one linear, one quadratic — and R falls out
// afterwards as the rotation taking one horizontal vector onto another.
function yawFromPair(b1, b2, O1, O2) {
  const V = sub(O2, O1);
  const Vh2 = V[0] * V[0] + V[2] * V[2];
  const out = [];
  // Vertical: l2*b2y - l1*b1y = Vy. Solved for whichever coefficient is
  // larger, so a bearing that happens to be horizontal does not divide by zero.
  const useL2 = Math.abs(b2[1]) >= Math.abs(b1[1]);
  if (Math.max(Math.abs(b1[1]), Math.abs(b2[1])) < 1e-6) return out;
  // Horizontal magnitude gives the quadratic. Substituting the linear relation
  // leaves a quadratic in the free range.
  for (const sign of [1, -1]) {
    // Parameterize by the free lambda and solve numerically-stably: build the
    // quadratic A*l^2 + B*l + C = 0 for the free variable.
    let A; let B; let Cq;
    if (useL2) {
      // l2 = (Vy + l1*b1y) / b2y
      const k = b1[1] / b2[1];
      const m = V[1] / b2[1];
      // u = l2*b2 - l1*b1 with l2 = k*l1 + m
      // u_x = l1*(k*b2x - b1x) + m*b2x ; u_z likewise
      const px = k * b2[0] - b1[0];
      const qx = m * b2[0];
      const pz = k * b2[2] - b1[2];
      const qz = m * b2[2];
      A = px * px + pz * pz;
      B = 2 * (px * qx + pz * qz);
      Cq = qx * qx + qz * qz - Vh2;
    } else {
      // l1 = (l2*b2y - Vy) / b1y
      const k = b2[1] / b1[1];
      const m = -V[1] / b1[1];
      const px = b2[0] - k * b1[0];
      const qx = -m * b1[0];
      const pz = b2[2] - k * b1[2];
      const qz = -m * b1[2];
      A = px * px + pz * pz;
      B = 2 * (px * qx + pz * qz);
      Cq = qx * qx + qz * qz - Vh2;
    }
    if (Math.abs(A) < 1e-12) break;
    const disc = B * B - 4 * A * Cq;
    if (disc < 0) break;
    const root = (-B + sign * Math.sqrt(disc)) / (2 * A);
    let l1; let l2;
    if (useL2) { l1 = root; l2 = (V[1] + l1 * b1[1]) / b2[1]; } else { l2 = root; l1 = (l2 * b2[1] - V[1]) / b1[1]; }
    // Behind the camera is not a worse fit, it is not a fit.
    if (!(l1 > 0.05 && l2 > 0.05)) continue;
    const ux = l2 * b2[0] - l1 * b1[0];
    const uz = l2 * b2[2] - l1 * b1[2];
    const uh = Math.hypot(ux, uz);
    if (uh < 1e-6) continue;
    // The yaw taking u's horizontal part onto V's.
    const yaw = Math.atan2(V[0], V[2]) - Math.atan2(ux, uz);
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const rb1 = [cs * b1[0] + sn * b1[2], b1[1], -sn * b1[0] + cs * b1[2]];
    const C = [O1[0] - l1 * rb1[0], O1[1] - l1 * rb1[1], O1[2] - l1 * rb1[2]];
    out.push({ yaw, C });
    if (disc === 0) break;
  }
  return out;
}

function yawRotate(yaw, v) {
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  return [cs * v[0] + sn * v[2], v[1], -sn * v[0] + cs * v[2]];
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

// Module level rather than inside the factory, so `replay-objects.js` can ask
// the same question of the same code — how many outlines were fitted to a
// printed tag rather than to furniture is a number about this rule, and a
// second implementation of it would be a number about something else.
//
// Where the frame's tags sit in the *submitted frame's* pixels, as axis-
// aligned boxes. The pose message reports corners in full camera-image
// pixels; the object frame is a plain decimation of that image, so one
// uniform scale relates them — the same relation `bearing()` relies on.
function tagBoxes(tags, camW, camH, frameW, frameH) {
  if (!tags?.length || !camW || !camH) return [];
  const sx = frameW / camW;
  const sy = frameH / camH;
  const out = [];
  for (const t of tags) {
    const c = t.corners;
    if (!c || c.length < 8) continue;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      const x = c[i] * sx;
      const y = c[i + 1] * sy;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 > x0 && y1 > y0) out.push([x0, y0, x1, y1]);
  }
  return out;
}

// A sample of a ring that has no viewpoint on it — the silhouette extents.
// Evenly spaced across the whole ring and always including the newest, because
// what is read back off these is a *quantile*: `h` is the p80 of `heights`, and
// a tail sample would hand that quantile the last standpoint's worth of the
// walk, which is the one part of a ring that is not representative of it.
function sampleSpread(xs, cap) {
  if (xs.length <= cap) return xs;
  const out = [];
  const step = (xs.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i++) out.push(xs[Math.round(i * step)]);
  return out;
}

// Which of an entry's rays go in the file, at most `cap` of them, chosen for
// viewpoint spread. Round-robin over the distinct viewpoint cells, newest first
// within each: the first pass takes one ray per standpoint, so an entry seen
// from six places keeps all six before any of them gets a second. A plain tail
// of the ring would routinely be one standpoint's worth, which carries no arc
// and so cannot pass — or fail — any of the tests that read it back.
//
// Also used for the outline observations: they carry the same `cell` and `at`,
// and the mirror they resolve is resolved across standpoints, so the argument
// for spreading the sample is the same one.
function sampleRays(rays, cap) {
  if (rays.length <= cap) return rays;
  const byCell = new Map();
  for (let i = rays.length - 1; i >= 0; i--) {
    const k = rays[i].cell ?? '';
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(rays[i]);
  }
  const out = [];
  const lists = [...byCell.values()];
  for (let round = 0; out.length < cap; round++) {
    let took = 0;
    for (const list of lists) {
      if (round >= list.length) continue;
      out.push(list[round]);
      took++;
      if (out.length >= cap) break;
    }
    if (!took) break;
  }
  // Back into the order the ring holds them in: `mergeEntries` sorts by `at` and
  // the re-seed test reads the *last* ray as the newest one.
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

// A ray on its way to the file and back. Rounded on the way out for the reason
// everything else here is — this file is meant to be opened and read.
//
// `emb` is deliberately absent: it is a detector appearance vector, it is the
// largest thing on a ray by an order of magnitude, and nothing reads it yet
// (`replay-objects.js --dump-sightings` measures it off the journals, which is
// where the sightings actually live). `sid` is absent for a smaller reason —
// nothing reads it off a ray, and the sessions an entry was seen in are already
// written as their own list. `resid` is absent because it is derived: every
// path that reads it recomputes it against the current position first.
function rayOut(r) {
  const f3 = (v) => Math.round(v * 1000) / 1000;
  const f4 = (v) => Math.round(v * 10000) / 10000;
  return {
    o: r.o.map(f3),
    dir: r.dir.map(f4),
    w: f3(r.w),
    at: r.at ?? null,
    cell: r.cell ?? null,
    planar: !!r.planar,
    n: r.n ? r.n.map(f4) : null,
    score: r.score ?? null,
  };
}

function rayIn(r) {
  if (!Array.isArray(r?.o) || !Array.isArray(r?.dir)) return null;
  return {
    o: r.o,
    dir: r.dir,
    w: r.w ?? 1,
    resid: 0,
    at: r.at ?? null,
    cell: r.cell ?? null,
    sid: null,
    planar: !!r.planar,
    n: r.n ?? null,
    score: r.score ?? null,
    emb: null,
  };
}

// Would a point at `rel` — camera frame, +z out of the lens — have landed
// comfortably inside this frame, near enough to be worth seeing?
//
// One definition, because two callers ask it for opposite purposes and must not
// drift: the constellation scorer counts a mapped object it puts in frame that
// nothing claims *against a pose hypothesis*, and the stale rule counts the same
// thing against a *known* pose. The difference between them is what they do with
// the answer, and it should stay the only difference.
function wellInFrame(rel, K, camW, camH, { inset, maxRangeM, minDepthM = 0.5 }) {
  if (rel[2] <= minDepthM) return false;
  if (norm(rel) > maxRangeM) return false;
  const u = K.cx + K.fx * rel[0] / rel[2];
  const v = K.cy + K.fy * rel[1] / rel[2];
  return u > camW * inset && u < camW * (1 - inset)
    && v > camH * inset && v < camH * (1 - inset);
}

function angleDeg(a, b) {
  return (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
}

function meanDir(dirs) {
  let s = [0, 0, 0];
  for (const d of dirs) s = addv(s, d);
  return norm(s) < 1e-9 ? null : unit(s);
}

// Which way the surface faces, over a set of sightings — **and whether that
// question was answered at all**.
//
// Module scope and exported, because the decision has two readers now: the map
// that stores the answer, and `replay-objects.js`, which has to be able to show
// the losing hypothesis beside the winning one. A diagnostic that recomputes the
// rule it is diagnosing is a second implementation waiting to disagree.
//
// Every sighting carries two candidates — the plane and its mirror (see
// `shapeFromOutline`) — so the set is fitted twice, once seeded from each
// candidate of the first well-conditioned sighting, and each run to convergence
// over the whole set. The branch whose members agree with each other wins: the
// true one is consistent from everywhere and the mirror is not, so the
// disagreement *is* the measurement. Same argument as `pickSolutions` for tags
// and `robustSeed` for rays.
//
// **The winner also has to beat the loser**, which is the part this function
// exists for. `shapeNormalTolDeg` is a bar on the winner alone and a coin flip
// passes it: at five sightings from two standpoints the two branches land within
// a degree of each other and whichever is fractionally tighter takes the normal.
// Measured on the corpus that is where the wrong normals come from — a
// television pitched 44 degrees at the ceiling, a clock face 28 degrees into the
// floor, both at ~15 degree spread where every sane surface in the room sits
// under 10. The bar the constant's own comment describes ("two hypotheses that
// both fit inside this would mean the observations carry no preference at all")
// was never implemented. It is `shapeElevMarginDeg`'s rule, applied where the
// shape is *made* rather than where it is used.
//
// Returns the winner either way, with `why` naming the test it failed, so a
// caller can report a refusal as something other than an absence.
function resolveNormal(cond, O) {
  const nearest = (cands, ref) => {
    let best = null;
    for (const c of cands) if (!best || dot(c.n, ref) > dot(best.n, ref)) best = c;
    return best;
  };
  const branches = [];
  for (const h of [0, 1]) {
    const seed = cond[0].cands[h]?.n;
    if (!seed) continue;
    // One pass against the seed, then a second against what that produced: the
    // seed is one noisy sighting, and letting it fix the assignment for the
    // whole set would make the answer depend on which frame happened to be
    // first.
    let ref = seed;
    let picked = null;
    for (let pass = 0; pass < 2; pass++) {
      picked = cond.map((o) => nearest(o.cands, ref));
      const m = meanDir(picked.map((c) => c.n));
      if (!m) return null;
      ref = m;
    }
    branches.push({ spread: median(picked.map((c) => angleDeg(c.n, ref))) ?? 180, n: ref, picked });
  }
  if (!branches.length) return null;
  branches.sort((a, b) => a.spread - b.spread);
  const [win, alt] = branches;
  const out = {
    n: win.n,
    spread: win.spread,
    picked: win.picked,
    altN: alt ? alt.n : null,
    altSpread: alt ? alt.spread : null,
    // How much better the winner is than the mirror it beat, and how far apart
    // the two answers were in the first place.
    margin: alt ? alt.spread - win.spread : null,
    sepDeg: alt ? angleDeg(win.n, alt.n) : 0,
    why: null,
  };
  if (win.spread > O.shapeNormalTolDeg) { out.why = 'spread'; return out; }
  // The head-on degeneracy: both seeds converged onto the same branch, so there
  // are not two answers to be ambiguous between. Measured against the winner's
  // own scatter rather than a new constant — two hypotheses that differ by less
  // than the noise inside one of them are one hypothesis, and picking between
  // them costs nothing because there is nothing to pick.
  if (out.sepDeg <= win.spread) { out.why = null; return out; }
  if (alt && out.margin < O.shapeBranchMarginDeg) { out.why = 'margin'; return out; }
  return out;
}

// How much two detection boxes in one frame are the same box.
//
// The question cross-class identity turns on, and the one thing the map never
// kept. `dedupe` in `object-detector.js` suppresses duplicates **per class and
// deliberately** — a vase on a dining table overlaps it almost completely, and
// killing one across classes would delete a real object — so one physical thing
// wearing two labels emits two boxes every frame, and co-occurrence alone cannot
// tell that from two things standing together. Overlap can: the same box twice
// is one object named twice, two boxes are two objects.
//
// Containment as well as IoU, for the nested case the dedupe comment names: a
// small display on a fridge door scores a low IoU against the fridge and a
// containment of nearly one, and those are different answers, not the same
// answer measured badly.
//
// Measured on the first walk that recorded it, the three regimes separate
// cleanly and immediately:
//
//   Clock #258 / Fan #350      IoU 0.985, contain 1.000  — one box, two labels
//   Speaker #7 / Lamp #438     IoU 0.191, contain 1.000  — nested, two objects
//   everything else            IoU 0.000                 — apart
//
// **`Refrigerator #12` and `Monitor/TV #23` are two nested real objects and are
// not to be merged.** Confirmed by eye, and the map said so first: 0.112 m
// apart on the same plane to within 4 degrees, but 1.34 x 0.73 m against
// 0.27 x 0.18 m — a fridge and a small display on its front. It is the standing
// example of why co-visibility alone cannot answer this. They were seen in the
// same frame 66 times, which is exactly what one appliance labelled twice would
// also look like, because `dedupe` suppresses per class on purpose.
// Does this entry answer to this class name?
//
// An entry normally has one key, its own class. It gains more only by absorbing
// a cross-class duplicate — one physical object the detector named two ways —
// and then it answers to both, because both are true of it and the map has no
// business picking which of two correct names is the real one. Association,
// the shape fix and the sibling test all ask through here, so an alias is not a
// name that works in some places and not others.
function answersTo(e, key) {
  return e.key === key || (e.keys ? e.keys.includes(key) : false);
}

// Every name an entry answers to, primary first.
function allKeys(e) {
  return e.keys && e.keys.length ? e.keys : [e.key];
}

function boxOverlap(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return { iou: 0, contain: 0 };
  const aA = Math.max(1e-6, (a[2] - a[0]) * (a[3] - a[1]));
  const bA = Math.max(1e-6, (b[2] - b[0]) * (b[3] - b[1]));
  return { iou: inter / (aA + bA - inter), contain: inter / Math.min(aA, bA) };
}

function explainedByTag(box, boxes, insideFrac, areaMax) {
  const area = Math.max(1e-6, (box[2] - box[0]) * (box[3] - box[1]));
  for (const t of boxes) {
    const tArea = Math.max(1e-6, (t[2] - t[0]) * (t[3] - t[1]));
    const ix = Math.max(0, Math.min(box[2], t[2]) - Math.max(box[0], t[0]));
    const iy = Math.max(0, Math.min(box[3], t[3]) - Math.max(box[1], t[1]));
    if (ix * iy / tArea < insideFrac) continue;
    if (area / tArea > areaMax) continue;
    return true;
  }
  return false;
}

// `history` is optional and is `object-history.js` when present. Injected rather
// than built here: the replay tools drive this module over recorded journals and
// must not write a record of a room they are only re-reading, and the live
// server owns where its state files live. Absent, every call below is a no-op —
// which is also what makes the history impossible to depend on from in here.
function createObjects({
  file, log = () => {}, opts = {}, history = null,
} = {}) {
  const hist = history || { record() {}, event() {} };
  const O = { ...DEFAULTS, ...opts };
  let vocab = opts.vocab || 'coco';
  let classKeys = new Set();
  // Whether anything has actually declared a vocabulary, as opposed to the
  // default one standing in until a model loads. See `setVocabulary`.
  let vocabSettled = !!opts.vocab || !!opts.classes;

  // Which vocabulary's allow-list is in force. Called again when a detector
  // loads and declares one: the live map is built at startup, long before any
  // model is loaded, so this cannot be settled in the constructor.
  //
  // An explicit `opts.classes` overrides both lists — that is the replay's
  // `--class-allow`, which exists to answer "what would this map look like with
  // only these classes" and must not be second-guessed here.
  function setVocabulary(next) {
    // The constructor's own call does not count as a declaration. Until a
    // detector has loaded and said which vocabulary it produces, the list in
    // force is a default — `coco`, because something has to be — and judging the
    // map against it would quarantine every Objects365 class in the file for the
    // seconds it takes a model to load, hide them from the wire, and churn the
    // file on the way back. Nothing is ruled out until something has actually
    // declared what it can name.
    if (!vocabSettled && next) vocabSettled = true;
    vocab = next || 'coco';
    const list = opts.classes || VOCABULARIES[vocab] || COCO_CLASSES;
    classKeys = new Set(list.map(normClass));
    // Never negotiable, and deliberately applied after any caller-supplied
    // list: a person is a moving object with a class label.
    classKeys.delete('person');
    // The allow-list has always gated incoming detections and never the stored
    // map, so a class removed from it left its existing entries in place —
    // promoted, drawn, named, and unreachable by every rule in this module,
    // since no detection of that class is ever accepted again. Immortal and
    // immutable at once. The rule now applies to what is already there.
    applyClassRule();
  }

  // Whether this detection is one the map takes at all.
  function allows(cls) { return classKeys.has(normClass(cls)); }

  // Entries the map no longer stands on, and why.
  //
  // **Quarantined, not deleted.** An entry that is simply removed takes the
  // reason it was removed with it, and the question these rules will actually
  // raise is "what killed that, and was it right" — which cannot be asked of an
  // absence. A quarantined entry keeps its id, its evidence and its stamp; it
  // leaves the wire, the map, association, merging and localization, and it
  // stays in the file so the answer survives a restart.
  //
  // `class` is **reversible and re-evaluated on every vocabulary change**. The
  // two vocabularies genuinely disagree about some things — `tvmonitor` against
  // `Monitor/TV` are different keys on purpose — so under a strict "must be
  // nameable by the running model" rule a detector swap would otherwise destroy
  // real entries in one direction and could never bring them back. Quarantine
  // makes the swap survivable: what the running model cannot name steps out of
  // the map, and steps back in when a model that can name it is loaded.
  function quarantine(e, why, atMs) {
    if (e.gone) return false;
    e.gone = { why, atMs: atMs ?? Date.now() };
    log(`Object ${e.id} (${e.cls}) quarantined — ${why}`);
    hist.event(e.id, 'quarantined', { why, cls: e.cls });
    return true;
  }

  // Keep the strongest partners only. Weakest dropped rather than oldest: the
  // count *is* the strength of the claim, and a partner seen twice is noise
  // whenever there is a partner seen two hundred times competing for the room.
  function trimSeenWith(e) {
    const keys = Object.keys(e.seenWith);
    if (keys.length <= O.seenWithMax) return;
    keys.sort((a, b) => e.seenWith[b] - e.seenWith[a]);
    const next = {};
    for (const k of keys.slice(0, O.seenWithMax)) next[k] = e.seenWith[k];
    e.seenWith = next;
  }

  // Every entry the map is currently standing on. One definition, because
  // "which objects are there" is asked by the wire, the association pass, the
  // merge pass and the localizer, and a quarantine that only some of them
  // honoured would be a rule that fires in one place and not the next.
  function live() {
    return [...entries.values()].filter((e) => !e.gone);
  }

  // Re-run the class rule over the whole map. Called whenever the allow-list
  // changes, which is at construction and again the moment a detector declares
  // its own vocabulary — the live map is built at startup, long before any model
  // is loaded, so this cannot be settled once.
  function applyClassRule() {
    if (!vocabSettled) return { out: 0, back: 0, gone: 0 };
    let out = 0;
    let back = 0;
    let removed = 0;
    // A copy, because the unnameable branch deletes from the map it walks.
    for (const e of [...entries.values()]) {
      if (!allKeys(e).some((k) => classKeys.has(k))) {
        // No vocabulary can name it, so no vocabulary can bring it back —
        // see `EVERY_CLASS_KEY`. Deleted rather than quarantined, and said out
        // loud, because there is no undo and this log line is the only record
        // that the entry existed. The same rule the null-walk sweep follows.
        //
        // **Never under `opts.classes`.** That is the replay's `--class-allow`,
        // a question about what the map would look like with a narrower list,
        // and answering it by destroying everything outside that list would
        // make one experiment eat the map.
        if (!opts.classes && !allKeys(e).some((k) => EVERY_CLASS_KEY.has(k))) {
          log(`Object ${e.id} (${e.cls}) removed — no vocabulary names this class`);
          // On its own record first, so the history says why it ended rather
          // than simply stopping — the same reason a merge writes to both ids.
          hist.event(e.id, 'removed', { why: 'class', cls: e.cls, nObs: e.rays.length });
          forgetEntry(e);
          removed++;
        } else if (quarantine(e, 'class')) out++;
      } else if (e.gone?.why === 'class') {
        e.gone = null;
        back++;
        log(`Object ${e.id} (${e.cls}) is nameable again — back in the map`);
        hist.event(e.id, 'restored', { why: 'class', cls: e.cls });
      }
    }
    if (out || back || removed) {
      log(`Class rule: ${out} quarantined, ${back} restored, ${removed} removed (${vocab})`);
      scheduleSave();
    }
    return { out, back, gone: removed };
  }

  // Take an entry out of the map for good, leaving nothing pointing at it.
  //
  // Co-visibility is the part that does not clean itself up: every *other*
  // entry that counted this one holds an `o<id>` key, and an id that no longer
  // exists reads in the drawer as a partner that has stopped being seen rather
  // than one that was never really there. The merge pass re-points those keys
  // because a merge has somewhere to point them; a removal does not, so they
  // go.
  function forgetEntry(e) {
    const key = `o${e.id}`;
    for (const other of entries.values()) {
      if (other === e || !other.seenWith[key]) continue;
      delete other.seenWith[key];
    }
    entries.delete(e.id);
  }

  let entries = new Map();     // id -> entry (candidate or promoted)
  // Seeded only now that `entries` exists: the rule walks the map, and at
  // construction the map is empty — but the call has to come after the
  // declaration all the same, and putting it here says so rather than relying
  // on the reader noticing.
  //
  // Handed `opts.vocab` rather than `vocab`, which is the same thing except
  // when it is absent: undefined leaves the vocabulary *unsettled*, which is
  // the honest state before a model has loaded, where `vocab` has already
  // fallen back to the `coco` default and would declare it.
  setVocabulary(opts.vocab);
  let anchorId = null;
  let nextId = 1;
  let saveTimer = null;
  let dirty = false;
  // Detections processed since the last reconciliation pass, and what the
  // association funnel has been doing. Counters only — nothing reads these back
  // into a decision, which is what lets them be added to without changing any
  // behaviour a replay would notice.
  let sinceMerge = 0;
  const stats = {
    assoc: {}, merges: 0, mergeChecks: 0, observed: 0, tagSuppressed: 0,
    // Outlines that reached a positioned object and produced a measurement, and
    // shape fixes offered against ones refused. Diagnostic only.
    shapeObs: 0, shapeFix: 0, shapeRefused: 0, shapeTagRefused: 0, shapeWhy: {},
  };

  function scheduleSave() {
    if (!file) return;
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) save();
    }, SAVE_DEBOUNCE_MS);
  }

  function save() {
    dirty = false;
    // Who is going into the file, decided once, because the co-visibility table
    // below has to be written against the same set. See `writtenKeys`.
    const written = [...entries.values()]
      .filter((e) => e.p && (e.promoted || e.gone || e.rays.length >= 2));
    // **A partner the file does not contain is a ghost.** Co-visibility records
    // every entry a detection landed on, positioned or not, and the filter above
    // deliberately drops the unpositioned and the single-ray — so the file
    // referenced ids it could not hold, by construction rather than by accident.
    // Measured on this room before the fix: `o262` held by `#1`, `o264` by
    // `#214`, `o268` by `#258` and `#259`, none of them in the file, all
    // surviving every reload.
    //
    // Read back, that is worse than a missing count: an id nothing resolves
    // reads in the drawer as a partner that has stopped being seen, which is
    // exactly the distinction the record exists to make.
    //
    // Filtered here and not at the point of recording. In memory the fragment is
    // real and may yet be promoted, and the count with it; the file is where the
    // map is truncated, so it is where the arrangement is truncated to match.
    // Tag partners (`t<id>`) are left alone — they live in `markers.json`.
    const writtenKeys = new Set(written.map((e) => `o${e.id}`));
    const seenWithOut = (e) => Object.fromEntries(Object.entries(e.seenWith)
      .filter(([k]) => !k.startsWith('o') || writtenKeys.has(k)));
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const r4 = (v) => Math.round(v * 10000) / 10000;
    // One outline observation, as it goes to disk. A direction to three decimals
    // is a tenth of a degree, which is well under any bar that reads it.
    const shapeObsOut = (o) => ({
      kind: o.kind,
      cond: !!o.cond,
      cell: o.cell ?? null,
      at: o.at ?? null,
      cands: o.cands.map((c) => ({
        n: c.n.map(r3),
        ...(c.r === undefined ? {} : { r: r3(c.r) }),
        ...(c.w === undefined ? {} : { w: r3(c.w) }),
        ...(c.h === undefined ? {} : { h: r3(c.h) }),
      })),
    });
    const out = {
      version: FILE_VERSION,
      anchorId,
      updatedAtMs: Date.now(),
      // **Candidates are written too, not just promoted objects.**
      //
      // Promotion needs two sessions, and a candidate held only in memory could
      // never reach the second one: the process restarts between walks — under
      // `npm run dev` it restarts on every file change — and took every
      // candidate with it. Measured on this room: three promotions ever, all
      // inside one server run, with a map that finds objects on every walk.
      // What looked like a shy room was a counter being reset.
      //
      // A candidate with no position yet is not written: it is a bearing and a
      // label, it cannot be drawn, and persisting one would fill the file with
      // the fragments the merge pass exists to remove.
      // Quarantined entries are written too — that is the whole point of
      // quarantining rather than deleting. The reason has to survive a restart
      // or the map would simply re-learn the thing it just ruled out, and the
      // question "what killed that" would have a different answer every run.
      objects: written.map((e) => ({
        // Whether this one has cleared the bar. Absent in files written before
        // candidates were kept, where everything present had — hence the
        // `!== false` on the way back in rather than a version bump that would
        // throw away a map that is still perfectly good.
        promoted: !!e.promoted,
        // Rounded on the way out. This file is meant to be opened and read —
        // a position is worth millimetres at best and printing seventeen
        // significant figures of it only makes the real precision harder to
        // see.
        id: e.id,
        cls: e.cls,
        keys: e.keys && e.keys.length > 1 ? e.keys : null,
        p: e.p.map((v) => Math.round(v * 1000) / 1000),
        r: Math.round(e.r * 1000) / 1000,
        h: e.h,
        w: e.w ?? null,
        // The recovered outline: a metric radius or width/height, and the plane
        // normal in room coordinates. Absent in files written before it existed,
        // which read back as null and cost nothing.
        shape: e.shape ?? null,
        nObs: e.rays.length,
        arcDeg: e.arcDeg,
        priorFrac: e.priorFrac,
        // Persisted, so a reloaded object can say how sure the detector was
        // before this walk has produced a single new sighting of it.
        conf: e.conf ?? null,
        sessions: [...e.sessions],
        cells: e.cells.size,
        resid: e.resid === null ? null : Math.round(e.resid * 1000) / 1000,
        lastSeenAtMs: e.lastSeenAtMs,
        // Null for everything the map still stands on, which is nearly all of
        // it, so this costs one word per entry and says why for the rest.
        gone: e.gone ?? null,
        // The evidence, sampled for viewpoint spread. See `persistRays`: this is
        // what stops a reloaded entry from being a second class of thing that
        // the merge, the arc bar and the inlier fraction all have to be written
        // around.
        rays: sampleRays(e.rays, O.persistRays).map(rayOut),
        // **Everything the entry accumulated, not just what it concluded.**
        //
        // `p` and `rays` were the first instance of this and the rest followed
        // the same failure: a save wrote the answer, a load read it back as
        // fact, and the evidence a later walk would need to overturn it was
        // gone. So the map could accumulate beliefs and never revise them —
        // a wrong plane normal outliving every restart, one clipped box holding
        // `h` at 2.70 m with an empty ring behind it, the stale rule unable to
        // convict anything because its streak began again 1799 times.
        //
        // Rounded on the way out like everything else here: this file is meant
        // to be opened and read, and none of it is known past millimetres.
        shapeObs: sampleRays(e.shapeObs, O.persistShapeObs).map(shapeObsOut),
        heights: sampleSpread(e.heights, O.persistExtents).map(r3),
        widths: sampleSpread(e.widths, O.persistExtents).map(r3),
        // The depth prior itself, not only the fraction of the position it
        // accounts for. `priorFrac` was persisted while the prior behind it was
        // not, so a reloaded entry claimed a position 95% derived from a reading
        // that no longer existed anywhere — and the first new ray re-solved it
        // without that reading and moved it.
        prior: e.prior ? { p: e.prior.p.map(r4), w: e.prior.w } : null,
        // Not defaulted to a passing 1 on the way back in. An inlier fraction is
        // a measurement, and filling its gap with the value that clears the gate
        // is the same instinct that produced everything above.
        inlierFrac: e.inlierFrac,
        posLambdaMin: e.posLambdaMin ?? 0,
        // The re-seed streak: how many sightings running have disagreed with
        // where this sits. A restart is not agreement.
        streak: e.streak,
        bornWhy: e.bornWhy ?? null,
        heightDerived: !!e.heightDerived,
        seenWith: seenWithOut(e),
        overlapWith: Object.fromEntries(Object.entries(e.overlapWith)
          .filter(([k]) => writtenKeys.has(k))
          .map(([k, v]) => [k, { n: v.n, iou: r3(v.iou), contain: r3(v.contain) }])),
        hits: e.hits, misses: e.misses,
        // **The stale rule's live claim, and the reversal of its own comment.**
        // The streak used to be dropped on load, on the reasoning that it claims
        // one continuous stretch of looking and a restart is a gap in looking.
        // That is true and it does not follow: no frames accumulate while the
        // server is down, so nothing happened in the gap that the streak would
        // be lying about — and under `npm run dev`, which restarts on every file
        // change, a bar of 80 consecutive frames was simply never reachable.
        // Measured here: `Clock #180` carries 142 misses against 1 hit and has
        // never been convicted.
        missStreak: e.missStreak, missCells: [...e.missCells],
        evidence: Math.round((e.evidence || 0) * 100) / 100,
      })),
    };
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
      fs.renameSync(tmp, file);
    } catch (err) {
      log(`Could not save object map: ${err.message}`);
    }
  }

  // The record is of a room frame, not of a list of things — every position is
  // relative to the anchor tag. A file recorded against a different anchor is
  // discarded outright, the same rule `markers-history.json` and `walls.json`
  // both follow.
  function load(currentAnchorId) {
    anchorId = currentAnchorId ?? null;
    if (!file) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (raw.version !== FILE_VERSION) {
      log('Object map ignored: written by a different version');
      return;
    }
    if (raw.anchorId !== anchorId) {
      log(`Object map ignored: recorded against anchor ${raw.anchorId}, room anchor is ${anchorId}`);
      return;
    }
    // **A position with no evidence behind it does not come back.**
    //
    // The file used to store the answer and not the working: an entry written
    // before `persistRays` reloads as a `p` with an empty `rays` array, and rays
    // are not recoverable — they were never written, and a walk that would have
    // supplied new ones lands its detections on whichever entry the association
    // pass picks, which is the one that still has evidence. So such an entry is
    // frozen at whatever it was, forever, while every rule that would judge it
    // (the merge, the arc bar, the inlier fraction, the viewpoint cells) reads
    // an empty bundle and declines to speak.
    //
    // There is nothing to migrate *to*. The position was derived from rays that
    // no longer exist anywhere, and manufacturing a ray from it — a bearing from
    // some invented standpoint that happens to pass through the answer — would
    // be inventing evidence to satisfy a check, which is the one thing this
    // module must never do. So they are cut, by name, before they are entries.
    //
    // What it costs: an object that was measured once and has not been seen
    // since is forgotten, and has to be seen again to exist. That is the correct
    // price. It was already unable to merge, unable to refine, and unable to be
    // checked; keeping it was keeping a name and a coordinate, not a measurement.
    const stale = (raw.objects || []).filter((o) => !(o.rays || []).length);
    for (const o of stale) {
      log(`Object ${o.id} (${o.cls}) dropped on load — a position with no rays behind it`);
    }
    if (stale.length) {
      log(`Object map: ${stale.length} legacy entries dropped, written before the evidence was`);
      scheduleSave();
    }
    for (const o of (raw.objects || []).filter((x) => (x.rays || []).length)) {
      const rays = o.rays.map(rayIn).filter(Boolean);
      entries.set(o.id, {
        // The key is derived on load rather than stored, so a map written
        // before the two vocabularies existed comes back matchable against
        // either of them without a file version to migrate.
        id: o.id, cls: o.cls, key: normClass(o.cls),
        // Every other name this entry answers to, from a cross-class merge. Null
        // in every file written before that existed, which reads back as "just
        // its own class" — the state all of them were in.
        keys: Array.isArray(o.keys) && o.keys.length ? o.keys : null,
        p: o.p, r: o.r ?? 0.3,
        h: o.h ?? null, w: o.w ?? null,
        // The evidence comes back with the map — and an entry that carries none
        // never reaches here, having been cut above.
        //
        // What this deliberately does *not* do is re-solve the position: the
        // stored one was derived from these very rays, and re-deriving it on
        // load would only reproduce it more slowly. `resid` comes back zero and
        // is recomputed by the first path that reads it, which is how it works
        // in a live session too.
        //
        // `!== false`, so a file written before candidates were kept — where
        // everything in it had been promoted — still loads as promoted.
        rays, promoted: o.promoted !== false,
        // The shape and the sightings behind it, so the aggregate can be
        // re-derived rather than merely inherited. A file written before this
        // existed brings back the aggregate alone and is no worse off than it
        // was; anything written since can have its normal overturned by the
        // first walk that disagrees, which is the whole point.
        shape: o.shape ?? null,
        shapeObs: (o.shapeObs || []).filter((s) => s?.cands?.length)
          .map((s) => ({
            kind: s.kind,
            cond: !!s.cond,
            cell: s.cell ?? null,
            at: s.at ?? null,
            cands: s.cands,
          })),
        arcDeg: o.arcDeg ?? 0, priorFrac: o.priorFrac ?? 0,
        // The viewpoint cells come back off the rays rather than out of the
        // file, which stores only a count. Derived rather than stored so the two
        // cannot disagree: `minViewCells` asks how many standpoints the evidence
        // covers, and the evidence is right here. An entry whose ray sample was
        // capped comes back with the cells that sample covers and earns the rest
        // from this walk — the cap is chosen so that is rare, not so it never
        // happens.
        sessions: new Set(o.sessions || []),
        cells: new Set(rays.map((r) => r.cell).filter((c) => c !== null)),
        resid: o.resid ?? null, lastSeenAtMs: o.lastSeenAtMs ?? null,
        conf: o.conf ?? null,
        // The rings behind `h` and `w`, so a silhouette measured off one clipped
        // box can be outvoted by the walk that follows it instead of standing
        // for the life of the map.
        heights: (o.heights || []).filter((v) => v > 0),
        widths: (o.widths || []).filter((v) => v > 0),
        // A loaded entry is subject to every rule a live one is, so it has to
        // *be* the same shape — right down to the fields that only the merge
        // and the re-seed test read. Nothing here is defaulted to a value that
        // passes a gate: an absent `inlierFrac` in an old file loads as 0 and is
        // recomputed by the first ray, rather than loading as a 1 nothing
        // measured.
        streak: o.streak ?? 0,
        prior: o.prior?.p ? { p: o.prior.p, w: o.prior.w } : null,
        inlierFrac: o.inlierFrac ?? 0,
        posLambdaMin: o.posLambdaMin ?? 0,
        bornWhy: o.bornWhy ?? null,
        heightDerived: !!o.heightDerived,
        // The stale rule's claim survives the restart. It reads as one unbroken
        // stretch of looking and a restart is a gap in looking — but no frames
        // accumulate while the server is down, so the gap contains nothing the
        // streak would be misrepresenting. Dropping it meant a bar of 80
        // consecutive frames was unreachable under `npm run dev`, and the whole
        // rule became unfalsifiable by accident.
        missStreak: o.missStreak ?? 0,
        missCells: new Set(o.missCells || []),
        evidence: o.evidence ?? 0,
        hits: o.hits ?? 0, misses: o.misses ?? 0,
        // Persisted with the map rather than with the rays, and for the opposite
        // reason: a co-visibility count is not evidence about *this* walk, it is
        // the arrangement accumulating across all of them, and it is the one
        // thing here that only gets meaningful with age.
        seenWith: o.seenWith && typeof o.seenWith === 'object' ? { ...o.seenWith } : {},
        overlapWith: o.overlapWith && typeof o.overlapWith === 'object' ? { ...o.overlapWith } : {},
        // Absent in every file written before quarantine existed, which reads
        // back as "in the map" — the state everything in those files was in.
        //
        // A *class* verdict recorded while no model had declared a vocabulary is
        // not a verdict: the list behind it was the standing default, not
        // something that had said what it can name. Dropped on the way in for
        // the same reason `applyClassRule` refuses to run in that state — one
        // rule about when the class test has any authority, applied in both
        // directions. Every other reason survives; they are about evidence, not
        // about which model happens to be loaded.
        gone: (!vocabSettled && o.gone?.why === 'class') ? null : (o.gone ?? null),
      });
      // Derived on the way in for a file written before it was stored, so the
      // merge bar has a sigma to widen by on the first pass rather than after
      // the next sighting. Not a re-solve: the position stands exactly as
      // written, and this reads the conditioning of the rays that produced it.
      const e = entries.get(o.id);
      if (!e.posLambdaMin && e.rays.length) {
        const sol = triangulate(e.rays, e.prior?.w > 0 ? e.prior : null);
        e.posLambdaMin = sol?.rayLambdaMin || 0;
      }
      nextId = Math.max(nextId, o.id + 1);
    }
    // The class rule is re-run against whatever list is in force now, so a map
    // written under one vocabulary and loaded under another settles immediately
    // rather than on the next detector load.
    applyClassRule();
    // **A reload is when two walks' entries meet for the first time.** The merge
    // pass otherwise runs only on a detection counter, so a duplicate that
    // arrived across a restart — the case the whole ray-persistence change was
    // for — sat unreconciled until somebody walked past it again with a camera.
    // Nothing here is new evidence, so this can only find pairs that were
    // already mergeable on the evidence in the file.
    mergeEntries();
    const inMap = live();
    const promoted = inMap.filter((e) => e.promoted).length;
    const gone = entries.size - inMap.length;
    log(`Object map loaded: ${promoted} objects + ${inMap.length - promoted} candidates`
      + `${gone ? ` + ${gone} quarantined` : ''}, anchor ${anchorId}`);
  }

  function reset(newAnchorId) {
    entries = new Map();
    nextId = 1;
    anchorId = newAnchorId ?? null;
    scheduleSave();
  }

  function cellKey(p) {
    const q = O.viewCellM;
    return `${Math.round(p[0] / q)},${Math.round(p[2] / q)}`;
  }

  // Re-solve one entry from all the rays it currently holds, rejecting rays that
  // do not explain the result and re-solving without them. Two passes: the first
  // is contaminated by any outlier, the second is what the position is actually
  // taken from.
  function resolveEntry(e) {
    if (!e.rays.length) return;
    const prior = e.prior && e.prior.w > 0 ? e.prior : null;
    // Consensus first, least squares second. Starting from the all-rays fit is
    // what lets a single wrong association throw out every correct sighting.
    const seed = robustSeed(e.rays, O.outlierM, O.minArcDeg);
    // No pair with real parallax and no depth to stand on means there is no
    // position yet — not a position to be sceptical of. Without this, two
    // near-parallel rays solve to a confident point somewhere down the shared
    // line, and every later sighting is then associated against that fiction.
    if (!seed && !prior) return;
    let sol = seed ? { p: seed, priorFrac: 1, rayLambdaMin: 0 } : triangulate(e.rays, prior);
    if (!sol) return;
    for (let pass = 0; pass < 3; pass++) {
      const kept = [];
      for (const r of e.rays) {
        const { t, d } = rayResidual(r, sol.p);
        r.resid = d;
        // Behind the camera is not a worse explanation, it is not an
        // explanation — a detection is something the camera was looking at.
        if (t > 0 && d <= O.outlierM) kept.push(r);
      }
      if (kept.length < 2) break;
      const next = triangulate(kept, prior);
      if (!next) break;
      sol = next;
    }
    if (sol.rayLambdaMin === 0 && !prior) return;   // never converged off the seed
    const inliers = e.rays.filter((r) => r.resid <= O.outlierM);
    e.p = sol.p;
    // **How well this position is pinned down, in metres, along its worst axis.**
    //
    // `rayLambdaMin` is the smallest eigenvalue of the normal-equation matrix
    // the solve already forms, and every weight going into it is a 1/sigma^2 —
    // so the eigenvalue is in 1/m^2 and its inverse square root is the standard
    // deviation of the least-determined direction. For a well-circled object
    // that is a few centimetres in every direction; for two near-parallel
    // bearings it is the range, running away as 1/sin(arc); for a position
    // standing on one depth reading it is the depth sigma itself.
    //
    // Kept because `mergeEntries` needs it. A flat 0.45 m radius asks "are these
    // two points close" when the question is "could these two be the same
    // point", and those differ by whatever each side's own error happens to be.
    e.posLambdaMin = sol.rayLambdaMin || 0;
    e.heightDerived = !!sol.heightDerived;
    e.priorFrac = Math.round(sol.priorFrac * 1000) / 1000;
    e.arcDeg = Math.round(arcDeg(inliers.length >= 2 ? inliers : e.rays) * 10) / 10;
    e.inlierFrac = e.rays.length ? inliers.length / e.rays.length : 0;
    // The extent is the spread of the bearings' own closest approaches, which is
    // the silhouette bias made visible: a box centre points at the middle of
    // what is *visible* of an object, and that moves around its outline as the
    // camera circles it. Refinement shrinks the variance of this and never the
    // bias, so the extent is what carries it — see the note in the plan and
    // metric (c)'s within-cell versus across-cell split.
    e.r = Math.max(0.05, percentile(inliers.map((r) => r.resid), 0.9) ?? 0.3);
    e.resid = median(inliers.map((r) => r.resid));
    // How sure the detector was, over the sightings that actually explain this
    // position. Median for the same reason every other summary here is: one
    // frame that caught the thing perfectly should not speak for the rest, and
    // neither should one that barely saw it.
    const scores = inliers.map((r) => r.score).filter((s) => s !== null && s !== undefined);
    if (scores.length) e.conf = Math.round((median(scores) ?? 0) * 100) / 100;
    // **A high percentile, not a median, and this one is not symmetry-blind.**
    // Every other summary here takes a median because its error goes both ways.
    // An apparent extent's does not: a thing is at its largest seen square on,
    // and every oblique view foreshortens it. Half a metre of clock viewed at
    // 45 degrees measures 0.35 m and is not wrong about what it saw — so the
    // median over a walk is the size of a *typical* view, which is always
    // smaller than the object. The largest views are the honest ones, and p80
    // takes them without handing the answer to a single over-large box.
    //
    // Same reason `r` above is a p90 rather than a mean: these are one-sided
    // distributions and the summary has to know which side.
    if (e.heights.length) e.h = Math.round((percentile(e.heights, 0.8) ?? 0) * 100) / 100;
    // The across-view width, kept beside the height so a box drawn from the two
    // is the shape the thing actually is. A bearing-only map measures nothing
    // along the view direction, so this stands for both horizontal axes — which
    // is honest for a chair and wrong for a wall, and is why it is `w` rather
    // than a depth.
    if (e.widths.length) e.w = Math.round((percentile(e.widths, 0.8) ?? 0) * 100) / 100;
  }

  // --- shape ---
  //
  // An outline is fitted in the small frame the phone sent; the intrinsics
  // describe the full camera image. One isotropic scale relates them, exactly as
  // `bearing()` relies on — but an ellipse is not a point, and under an
  // *anisotropic* scale it becomes a different ellipse whose axes are no longer
  // the object's. So the scale is checked rather than assumed, and an outline
  // that cannot survive the trip is dropped instead of quietly reinterpreted.
  function outlineScale(camW, camH, frameW, frameH) {
    if (!camW || !camH || !frameW || !frameH) return null;
    const sx = camW / frameW;
    const sy = camH / frameH;
    if (!(Math.abs(sx / sy - 1) <= O.shapeMaxAnisotropy)) return null;
    return (sx + sy) / 2;
  }

  // What one outline says about this object's shape, in the **room frame**.
  //
  // Two candidates always, because every planar solve carries the mirror — the
  // same two-fold ambiguity planar PnP has for tags (see `pickSolutions` in
  // `survey.js`), arriving through a new door and handled the same way: both are kept
  // and consistency across viewpoints decides, never a coin flip inside one
  // frame.
  //
  // The range comes from the object's own triangulated position, so this
  // measures *shape* and nothing else — it never invents a distance, and it
  // cannot run before the object has a position.
  function shapeFromOutline(det, pose, K, s, objRoom) {
    const o = det.outline;
    if (!o) return null;
    const cam = pose.p;
    const rel = sub(objRoom, cam);
    const range = norm(rel);
    if (!(range > 0.2)) return null;
    if (o.kind === 'ellipse') {
      const conic = ellipseToConic({
        cx: o.cx * s, cy: o.cy * s, rx: o.rx * s, ry: o.ry * s, theta: o.theta,
      });
      // Solved for a unit radius and then scaled: the geometry is a similarity
      // in radius, so one solve answers every size and the object's own range is
      // what picks the one it actually is.
      const sols = circlePoseFromConic(conic, K, 1);
      if (!sols) return null;
      const cands = [];
      for (const sol of sols) {
        const k = range / norm(sol.c);
        if (!(k > 0) || !Number.isFinite(k)) continue;
        cands.push({ n: unit(quatRotate(pose.q, sol.n)), r: k });
      }
      if (!cands.length) return null;
      return {
        kind: 'ellipse',
        cands,
        // Whether this view is worth taking an *orientation* from. A circle seen
        // head-on projects to a circle and the two candidates collapse onto each
        // other; the fit is fine, the normal read off it is not.
        cond: (o.ecc ?? 0) >= OUTLINE_DEFAULTS.ellipseMinEccentricity,
      };
    }
    if (o.kind === 'quad') {
      const pts = o.pts.map((p) => [p[0] * s, p[1] * s]);
      const pl = quadPlaneFromCorners(pts, K);
      if (!pl) return null;
      // The object's position in camera coordinates: the plane the corner rays
      // are cut against, and the only thing the map contributes here.
      const pc = quatRotate(quatConjLocal(pose.q), rel);
      const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
      const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
      const axis = rayFor(cx, cy, K);
      const cands = [];
      for (const n of [pl.n, mirrorAboutAxis(pl.n, axis)]) {
        const c3 = quadCornersOnPlane(pts, K, n, pc);
        const sz = quadSizeOnPlane(c3);
        if (!sz || !(sz.w > 0.01) || !(sz.h > 0.01)) continue;
        // **Named by world axis, not by image axis.** The phone is held
        // landscape 98% of the time, so the quad's image-horizontal side is the
        // object's height in the room — the same correction the extents needed
        // and got, and the reason every `h` in the map used to be a width. Here
        // the corners are already in three dimensions, so the axes can be asked
        // which way they point instead of being inferred from the roll.
        const e1 = unit(quatRotate(pose.q, sub(c3[1], c3[0])));
        const e2 = unit(quatRotate(pose.q, sub(c3[3], c3[0])));
        const vertFirst = Math.abs(e1[1]) > Math.abs(e2[1]);
        cands.push({
          n: unit(quatRotate(pose.q, n)),
          w: vertFirst ? sz.h : sz.w,
          h: vertFirst ? sz.w : sz.h,
        });
      }
      if (!cands.length) return null;
      return {
        kind: 'quad',
        cands,
        // The quad's analogue of eccentricity: a near-parallelogram is what a
        // rectangle projects to when the perspective that would say which way it
        // faces has gone.
        cond: (o.skewDeg ?? 0) >= OUTLINE_DEFAULTS.quadMinSkewDeg,
      };
    }
    return null;
  }

  // The object's shape, aggregated over sightings — the mirror resolved by
  // `resolveNormal`, which is where the two hypotheses and the margin between
  // them live.
  //
  // **A refused normal is not a refused shape.** A circle's radius is the one
  // figure the mirror cannot touch, so an ellipse whose branch was not resolved
  // still measures how big the thing is and says only that it does not know
  // which way it faces. A quad's `w`/`h` come off the winning branch and cannot
  // outlive it, so there the honest output is no shape at all and the silhouette
  // extents stand on their own — which is what the map falls back to anyway.
  //
  // **Median, not the p80 the apparent extents take.** That p80 is there because
  // an apparent silhouette's error is one-sided — a thing is at its largest seen
  // square on and every oblique view foreshortens it. A rectified size has had
  // the foreshortening removed by the plane it was measured on, so its error
  // goes both ways again and a median is the honest summary.
  function resolveShape(e) {
    const obs = e.shapeObs;
    if (!obs || obs.length < O.shapeMinObs) return;
    if (new Set(obs.map((o) => o.cell)).size < O.shapeMinCells) return;
    const cond = obs.filter((o) => o.cond);
    if (cond.length < O.shapeMinObs) return;
    if (new Set(cond.map((o) => o.cell)).size < O.shapeMinCells) return;

    const best = resolveNormal(cond, O);
    if (!best) return;

    const kind = obs[obs.length - 1].kind;
    // A quad's `w`/`h` come off the winning branch and cannot outlive it, so a
    // refused quad is no shape at all — **including one that was accepted
    // earlier**. The aggregate is re-derived from the whole set on every
    // sighting, so leaving the last accepted answer standing would make the map
    // keep a plane the evidence has since stopped supporting.
    if (best.why && kind !== 'ellipse') { e.shape = null; return; }
    const shape = {
      kind,
      n: best.why ? null : best.n.map((v) => Math.round(v * 1000) / 1000),
      nSpreadDeg: best.why ? null : Math.round(best.spread * 10) / 10,
      // Which test the normal failed, kept on the shape rather than dropped:
      // "the mirror was not resolved" and "nothing has been measured yet" look
      // identical downstream, and only one of them is a fact about the object.
      ...(best.why ? { nWhy: best.why } : {}),
      obs: cond.length,
      cells: new Set(cond.map((o) => o.cell)).size,
    };
    if (kind === 'ellipse') {
      // Reflecting about the line of sight preserves the distance to the centre,
      // so both candidates of every sighting give the same radius. Taken over
      // *all* sightings rather than the well-conditioned ones, because head-on is
      // the best view a radius ever gets.
      const rs = obs.flatMap((o) => o.cands.map((c) => c.r)).filter((r) => r > 0);
      const r = median(rs);
      if (!(r > 0.01)) return;
      shape.r = Math.round(r * 1000) / 1000;
    } else {
      const w = median(best.picked.map((c) => c.w));
      const h = median(best.picked.map((c) => c.h));
      if (!(w > 0.01) || !(h > 0.01)) return;
      shape.w = Math.round(w * 1000) / 1000;
      shape.h = Math.round(h * 1000) / 1000;
    }
    e.shape = shape;
  }

  function tryPromote(e) {
    if (e.promoted) return false;
    if (e.rays.length < O.minSightings) return false;
    if (e.arcDeg < O.minArcDeg) return false;
    if (e.cells.size < O.minViewCells) return false;
    if (e.sessions.size < O.minSessions) return false;
    if (e.inlierFrac < O.minInlierFrac) return false;
    e.promoted = true;
    log(`Object ${e.id} promoted: ${e.cls} at `
      + `(${e.p.map((v) => v.toFixed(2)).join(', ')}) — ${e.rays.length} sightings, `
      + `arc ${e.arcDeg.toFixed(0)} deg, ${e.cells.size} cells, ${e.sessions.size} sessions, `
      + `prior ${(e.priorFrac * 100).toFixed(0)}%`);
    hist.event(e.id, 'promoted', {
      cls: e.cls,
      nObs: e.rays.length,
      arcDeg: Math.round(e.arcDeg),
      cells: e.cells.size,
      sessions: e.sessions.size,
    });
    scheduleSave();
    return true;
  }

  // How far apart two entries may sit and still be asked whether they are one
  // thing. `outlierM` is the floor and applies whole to a pair that both know
  // where they are; each side's own uncertainty widens it from there, up to
  // `mergeMaxM`. An entry that has not been solved at all reports no sigma and
  // gets the floor — unknown is not the same as large, and guessing large here
  // would be the ignorance-swallows-the-room failure the ceiling exists for.
  function posSigma(e) {
    return e.posLambdaMin > 0 ? 1 / Math.sqrt(e.posLambdaMin) : 0;
  }

  // Did the detector draw one box for both of these? Read from whichever side
  // recorded it — the pass is symmetric but the record is written per entry.
  function sameBox(a, b) {
    const x = a.overlapWith?.[`o${b.id}`];
    const y = b.overlapWith?.[`o${a.id}`];
    const r = (x?.n || 0) >= (y?.n || 0) ? x : y;
    return !!r && r.n >= O.mergeIouFrames && r.iou >= O.mergeIouMin;
  }

  function mergeBar(a, b) {
    return Math.min(O.mergeMaxM, O.outlierM + O.mergeSigmaK * (posSigma(a) + posSigma(b)));
  }

  // Did a detection this frame land on another entry that could be this same
  // physical object? Same class, within the merge bar — which is to say, close
  // enough that the reconciliation pass would ask whether they are one thing.
  // If so this frame says nothing about whether this entry's object is there.
  function seenBySibling(e, together) {
    for (const id of together) {
      const o = entries.get(id);
      if (!o || o === e || !o.p) continue;
      if (!allKeys(o).some((k) => answersTo(e, k))) continue;
      if (norm(sub(o.p, e.p)) <= mergeBar(e, o)) return true;
    }
    return false;
  }

  // The chance a detection would have named this object in this frame, if the
  // object were there. Nothing about whether it *was* named — that is the
  // measurement this multiplies against.
  //
  // Four things set it, and three of them are gates that zero it outright,
  // because "the detector could not have seen it" and "the detector did not see
  // it" are different facts and only one is about the room.
  function seeChance(e, rel, cam, K) {
    // 1. Facing. A television, a picture and a cabinet front are one-sided, and
    // for exactly the entries that carry a fitted normal the map knows which
    // side. Standing behind one and not detecting it is not evidence.
    if (e.shape?.n && dot(e.shape.n, unit(sub(cam, e.p))) <= 0) return 0;
    // 2. Line of sight, where something has been wired to answer it. Occlusion
    // is the failure this module cannot see on its own, and it is injected
    // rather than imported so `objects.js` still knows nothing about walls.
    if (O.lineOfSight && !O.lineOfSight(cam, e.p)) return 0;
    // 3. Apparent size. The map holds a width or a radius; at this range that is
    // a number of pixels, and below the detector's floor its absence says
    // nothing.
    const size = e.w || (e.r > 0.05 ? e.r * 2 : 0) || e.h || 0;
    if (size > 0 && (K.fx * size) / rel[2] < O.staleMinPx) return 0;
    // 4. This object's own established recall — the rate at which this detector
    // names this thing when it is in view. Excludes the run in progress: a
    // streak that dragged its own recall down would immunise the object against
    // the evidence the streak is producing.
    const a = O.staleRecallPrior;
    const seen = e.hits + a;
    const chances = e.hits + Math.max(0, e.misses - e.missStreak) + 2 * a;
    return Math.min(O.staleRecallMax, Math.max(O.staleRecallMin, seen / chances));
  }

  // Two entries that are the same physical thing, reconciled after the fact.
  //
  // Nothing else ever does this. Association decides once, at the moment a
  // detection arrives, on the evidence that existed then — and early on that
  // evidence is a single bearing, so one fridge can be filed as several
  // fridges before any of them has a position to be checked against. Measured
  // over five walks: 109 entries, 10 promoted, 58 of the rest holding two
  // sightings or fewer, and there is one fridge in the room.
  //
  // **Gated on the merged bundle passing the same bars a single object must**,
  // which is the whole difference between this and simply loosening
  // association. Loosening association is how two real chairs become one; this
  // asks whether one set of rays explains one point, and refuses when it does
  // not.
  //
  // Both entries must hold live rays. A map loaded from disk keeps its position
  // but not its evidence, so a merge involving one could not be judged at all —
  // it would be a position swap dressed up as a measurement.
  function mergeEntries() {
    // **A ray-less entry may be absorbed, but may never absorb.**
    //
    // `load` now cuts entries that carry no rays, so this is a guard and no
    // longer the cure. It was the cure: the filter here used to be
    // `e.p && e.rays.length`, which made an evidence-less entry invisible to this
    // pass in *both* directions — it could not absorb its duplicate and its
    // duplicate could not absorb it, so a fossil sat beside the live entry for
    // the same physical object forever, at any distance, however obviously the
    // same thing. Measured on this room: `pottedplant #2` (0 rays, last seen
    // 05/08) 0.258 m from `Potted Plant #149` (12 rays), one plant on the wall by
    // tags 0 and 1, well inside the 0.45 m bar, and permanent.
    //
    // Nothing is loosened. The pair still has to share a key, still has to fall
    // within `outlierM`, and the union of their rays still has to triangulate and
    // clear the arc and inlier bars below. A side with no rays contributes
    // nothing, so it can move no position and win no argument; it can only stop
    // existing.
    const list = live().filter((e) => e.p);
    let merged = 0;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!entries.has(a.id) || !entries.has(b.id)) continue;
        // Same name, or proven to be the same box wearing two names.
        const alias = !allKeys(a).some((k) => answersTo(b, k));
        if (alias && !sameBox(a, b)) continue;
        // Two entries with nothing behind either of them are not evidence that
        // they are one thing; they are two guesses. The union has to hold at
        // least one real sighting or there is nothing here to reconcile.
        if (!a.rays.length && !b.rays.length) continue;
        const apart = norm(sub(a.p, b.p));
        if (apart > mergeBar(a, b)) continue;
        stats.mergeChecks++;
        // The older id survives, so a promoted object that has already been
        // written to disk keeps its identity across the merge — **unless the
        // older one is the ray-less one**. Identity follows the evidence: an id
        // kept for its age, holding a position nothing on disk supports and a
        // history of nothing happening, is not the record worth continuing.
        const evidence = !a.rays.length !== !b.rays.length
          ? (a.rays.length ? a : b) : null;
        const keep = evidence || (a.id <= b.id ? a : b);
        const drop = keep === a ? b : a;
        const trial = {
          rays: [...keep.rays, ...drop.rays]
            .sort((x, y) => (x.at || 0) - (y.at || 0)).slice(-O.ringMax),
          prior: (keep.lastSeenAtMs || 0) >= (drop.lastSeenAtMs || 0)
            ? (keep.prior || drop.prior) : (drop.prior || keep.prior),
          heights: [...keep.heights, ...drop.heights].slice(-O.ringMax),
          widths: [...keep.widths, ...drop.widths].slice(-O.ringMax),
          // Two entries of one physical object saw one physical outline, so the
          // shape evidence merges the way the rays do. The aggregate is
          // re-derived from the union rather than picked from one side: the
          // mirror is resolved by consistency across viewpoints and a merge is
          // exactly a viewpoint set getting bigger.
          shapeObs: [...keep.shapeObs, ...drop.shapeObs]
            .sort((x, y) => (x.at || 0) - (y.at || 0)).slice(-O.shapeRingMax),
          shape: keep.shape || drop.shape,
          p: null, r: 0.3, h: null, w: null,
          arcDeg: 0, priorFrac: 1, inlierFrac: 0, resid: null,
        };
        resolveEntry(trial);
        resolveShape(trial);
        if (!trial.p) continue;
        if (trial.inlierFrac < O.minInlierFrac) continue;
        if (trial.arcDeg < O.minArcDeg) continue;
        Object.assign(keep, {
          rays: trial.rays, prior: trial.prior,
          heights: trial.heights, widths: trial.widths,
          shapeObs: trial.shapeObs, shape: trial.shape,
          p: trial.p, r: trial.r, h: trial.h, w: trial.w, arcDeg: trial.arcDeg,
          priorFrac: trial.priorFrac, inlierFrac: trial.inlierFrac,
          resid: trial.resid, heightDerived: trial.heightDerived,
          // A merge is not a disagreement, so the movement streak restarts
          // rather than carrying one entry's history of not matching the other.
          streak: 0,
          lastSeenAtMs: Math.max(keep.lastSeenAtMs || 0, drop.lastSeenAtMs || 0) || null,
          // Neither entry was demoted by evidence, and the merged bundle has
          // just passed the inlier and arc bars — so promotion survives, and
          // tryPromote below is still asked in case the merge is what finally
          // earns it.
          promoted: keep.promoted || drop.promoted,
        });
        // **The survivor answers to both names.** A cross-class merge has no
        // grounds to pick which of two correct labels is the real one — the
        // detector produced both for the same box, and a class label is this
        // map's whole identity mechanism, so throwing one away would lose the
        // ability to associate half the sightings of the thing that was just
        // proven to be one thing. `cls` stays the survivor's for display; the
        // keys are what association, the shape fix and the class rule ask.
        if (alias) {
          const names = [...new Set([...allKeys(keep), ...allKeys(drop)])];
          keep.keys = names;
          log(`Object ${keep.id} now answers to ${names.join(' + ')}`
            + ` — same box as ${drop.cls} #${drop.id}`);
          hist.event(keep.id, 'aliased', { cls: keep.cls, other: drop.cls, keys: names });
        }
        for (const c of drop.cells) keep.cells.add(c);
        for (const s of drop.sessions) keep.sessions.add(s);
        // The arrangement follows the object. Two entries of one physical thing
        // saw one physical room, so their partner counts add — and every *other*
        // entry that counted the absorbed one has to be re-pointed, or the map
        // would go on holding co-visibility with an id that no longer exists.
        // Left alone, the strongest evidence in the table would be the entries
        // the merge pass was busiest fixing.
        const dropKey = `o${drop.id}`;
        const keepKey = `o${keep.id}`;
        for (const [k, n] of Object.entries(drop.seenWith)) {
          if (k === keepKey) continue;    // the two of them seeing each other
          keep.seenWith[k] = (keep.seenWith[k] || 0) + n;
        }
        delete keep.seenWith[dropKey];
        for (const other of entries.values()) {
          if (other === drop || !other.seenWith[dropKey]) continue;
          if (other !== keep) {
            other.seenWith[keepKey] = (other.seenWith[keepKey] || 0) + other.seenWith[dropKey];
          }
          delete other.seenWith[dropKey];
          trimSeenWith(other);
        }
        trimSeenWith(keep);
        entries.delete(drop.id);
        merged++;
        log(`Object ${drop.id} merged into ${keep.id} (${keep.cls}) — `
          + `${keep.rays.length} sightings, arc ${keep.arcDeg.toFixed(0)} deg, `
          + `inlier ${keep.inlierFrac.toFixed(2)}`);
        // Recorded on **both** ids. The survivor's trace shows a step in its arc
        // and its sighting count that nothing else explains, and the absorbed
        // one's record would otherwise simply stop — which is the same shape as
        // an object nobody ever looked at again, and is the question this whole
        // record exists to tell apart.
        hist.event(keep.id, 'absorbed', {
          cls: keep.cls,
          other: drop.id,
          nObs: keep.rays.length,
          arcDeg: Math.round(keep.arcDeg),
          apartM: Math.round(apart * 100) / 100,
        });
        hist.event(drop.id, 'merged-away', { cls: drop.cls, into: keep.id });
        if (!keep.promoted) tryPromote(keep);
        if (keep === a) continue;
        break;    // `a` was the one dropped; nothing left to compare it against
      }
    }
    if (merged) { stats.merges += merged; scheduleSave(); }
    return merged;
  }

  // A detection's bearing, in the room frame.
  //
  // The box is in the coordinates of the small frame the phone sent; the
  // intrinsics describe the full camera image. The small frame is a plain
  // decimation of it, so one uniform scale relates them — there is no crop and
  // no letterbox to unpick, which is exactly why the producer decimates rather
  // than cropping.
  function bearing(det, K, camW, frameW, frameH, camH) {
    const sx = camW / frameW;
    const sy = camH / frameH;
    const u = ((det.box[0] + det.box[2]) / 2) * sx;
    const v = ((det.box[1] + det.box[3]) / 2) * sy;
    return unit([(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1]);
  }

  // One frame's worth of detections against the camera pose that produced them.
  function observe({ sid, at, pose, K, camW, camH, frameW, frameH, dets, tags }) {
    if (!pose?.p || !pose?.q || !K?.fx || !dets?.length) {
      return { changed: false, assigned: new Map() };
    }
    const cam = pose.p;
    const cell = cellKey(cam);
    const tagRects = tagBoxes(tags, camW, camH, frameW, frameH);
    const outScale = outlineScale(camW, camH, frameW, frameH);
    let changed = false;
    let saveNeeded = false;
    // Which entries this one frame's detections landed on. Collected rather than
    // paired off inside the loop: "seen together" is a fact about the frame, and
    // the frame is not finished until every detection in it has been associated.
    const together = new Set();
    // Which box each entry was claimed by this frame, for the overlap record
    // below. Only ever holds this frame's detections.
    const frameBox = new Map();
    // detection -> the entry id it was associated to. Only the ones that got
    // that far: a detection the allow-list, the tag test or the clip test
    // refused is simply absent, which is the answer to "why is that box not on
    // the map".
    const assigned = new Map();

    for (const det of dets) {
      // Refused before the allow-list, so the counter below is about the room
      // rather than about the tags in it.
      if (tagRects.length && explainedByTag(det.box, tagRects, O.tagInsideFrac, O.tagBoxAreaMax)) {
        stats.tagSuppressed++;
        continue;
      }
      if (!allows(det.cls)) continue;
      // Clipping is judged in world axes, not image axes. A box cut off at the
      // sides in the room has a horizontally biased bearing and is refused; one
      // cut off above and below still points the right way horizontally and is
      // kept as a vertical-plane constraint. `det.clip` is the per-edge mask;
      // an older detection file with only the boolean is treated as before.
      const axes = det.clip === undefined
        ? { h: !!det.clipped, v: false }
        : worldClipAxes(det.clip, pose.q);
      if (axes.h) continue;

      const dirCam = bearing(det, K, camW, frameW, frameH, camH);
      const dir = unit(quatRotate(pose.q, dirCam));
      // The horizontal normal to this bearing: the vertical plane the object
      // must lie on if all we can trust is its azimuth.
      const dh = Math.hypot(dir[0], dir[2]);
      if (axes.v && dh < 1e-6) continue;   // pointing straight up or down; no azimuth at all
      const nrm = axes.v ? [dir[2] / dh, 0, -dir[0] / dh] : null;

      const note = {};
      const match = associate(det, cam, dir, cell, axes.v, note);
      stats.observed++;
      if (!match) stats.assoc[note.why] = (stats.assoc[note.why] || 0) + 1;
      const e = match || newEntry(det, note.why);
      // There it is. A stale verdict is a claim about not having seen something,
      // and this is the one thing that can contradict it — so it does, at the
      // first sighting rather than after another accumulation. The streak starts
      // clean: what put it out was one continuous stretch of looking and not
      // finding, and that stretch has just ended.
      if (e.gone?.why === 'stale') {
        e.gone = null;
        e.missStreak = 0;
        e.missCells.clear();
        log(`Object ${e.id} (${e.cls}) seen again — back in the map`);
        hist.event(e.id, 'restored', { why: 'stale', cls: e.cls });
        saveNeeded = true;
      }

      // Weight in the same units as the depth prior — 1/sigma^2 on a position,
      // not a bare confidence — or the two are not comparable quantities and
      // `priorFrac` measures nothing. A bearing's perpendicular uncertainty is
      // the angular error times the range, so a box across the room is
      // automatically worth less without needing a separate distance softener.
      const range = e.p ? norm(sub(e.p, cam)) : (det.d ?? O.distSoftM);
      const sigmaPerp = Math.max(
        O.bearingFloorM, range * (O.bearingSigmaPx / K.fx)) / Math.sqrt(det.score || 0.5);
      const w = 1 / (sigmaPerp * sigmaPerp);
      // The detector's own score rides along. It already sets the ray's weight,
      // but it was thrown away after that and the map could not say how sure
      // the network had been about anything in it — which is the question with
      // a detector that calls a potted plant a speaker. Kept per ray rather
      // than averaged in place so it can be taken over the *inliers* only,
      // like every other summary of an object here.
      e.rays.push({
        o: cam, dir, w, resid: 0, at, cell, sid, planar: axes.v, n: nrm,
        score: det.score ?? null,
        // The detector's appearance vector for this sighting, where it produced
        // one. Rides along exactly as `score` does and for the same reason: it
        // is the only thing that could ever answer *which* shelf, and a map that
        // discards it cannot be asked the question later. Nothing reads it yet —
        // `replay-objects.js --dump-sightings` is where it is being measured.
        emb: det.emb ?? null,
      });
      if (e.rays.length > O.ringMax) e.rays.shift();
      e.cells.add(cell);
      e.sessions.add(sid ?? 'unknown');
      e.lastSeenAtMs = at;

      // The depth prior, folded in as a term rather than used as a seed. It is
      // refused outright past the range where the measured error stops being a
      // scale and becomes the whole reading (depth.md: 0.9-1.7 m past 3 m,
      // where the bias *is* the error).
      if (det.d != null && det.d <= O.depthMaxM) {
        const sigma = Math.max(O.depthFloorSigma, O.depthRelSigma * det.d);
        const pd = [cam[0] + dir[0] * det.d, cam[1] + dir[1] * det.d, cam[2] + dir[2] * det.d];
        // One prior, not one per sighting: many depth samples of the same
        // silhouette are not independent evidence, and letting them accumulate
        // would let depth outvote the parallax it is supposed to be subordinate
        // to. The freshest measurement inside the trusted range wins.
        e.prior = { p: pd, w: 1 / (sigma * sigma) };
      }

      // **This sighting proves the line to it was empty.** Handed out through an
      // injected hook, exactly like `lineOfSight` and for the symmetric reason:
      // the object map has never written to the walls grid and still imports
      // nothing from it, but a detection is the same class of evidence a decoded
      // tag is, and withholding it left the grid drawing walls across lines a
      // camera had demonstrably seen along. Measured before this existed: 48 of
      // 991 object rays ran through an emitted wall.
      //
      // Only once the entry has a position — a bearing with no range is not a
      // line, it is a direction.
      if (e.p && O.onSight) O.onSight(cam, e.p, e.id);

      // The per-sighting residual is the outlier test, the wrong-instance test
      // and the moved-object test at once — the role the leave-one-out fix
      // plays in survey.js's refine.
      if (e.p) {
        const { d } = rayResidual(e.rays[e.rays.length - 1], e.p);
        if (d > O.reseedDisagreeM) e.streak++;
        else e.streak = 0;
        if (e.streak >= O.reseedStreak) {
          // It moved. Not averaged toward the new place — the ray history
          // describes where it used to be, and keeping it would drag the
          // estimate across the room over hundreds of sightings while
          // disagreeing with every one of them.
          log(`Object ${e.id} (${e.cls}) moved — re-seeding from ${e.rays.length} sightings`);
          // The one event a position trace cannot be read for: a re-seed and a
          // nudge draw the same step, and they are the difference between "this
          // was picked up and put down" and "this is drifting".
          hist.event(e.id, 'moved', {
            cls: e.cls,
            dropped: e.rays.length,
            byM: Math.round(d * 100) / 100,
            wasPromoted: !!e.promoted,
          });
          e.rays = e.rays.slice(-1);
          e.cells = new Set([cell]);
          e.heights = [];
          e.widths = [];
          // A thing that was picked up and put down elsewhere is the same size
          // it always was, so the metric shape survives — but it is not
          // necessarily facing the same way any more, and the sightings behind
          // that normal all describe the old wall.
          e.shapeObs = [];
          if (e.shape) e.shape = { ...e.shape, n: null, nSpreadDeg: null, stale: true };
          e.prior = null;
          e.promoted = false;
          e.streak = 0;
        }
      }

      resolveEntry(e);

      // How big the thing is, once there is a range to scale its box by. Median
      // over sightings, for the same reason survey.js takes a median
      // everywhere: the contamination here is not symmetric.
      //
      // **In world axes, not image axes**, which is the same correction the
      // clipping rule needed and got, applied to the extents it forgot. The
      // phone is held landscape 98% of the time, and in landscape the image's
      // *y* extent is the object's width in the room and its *x* extent is the
      // height. Measured as-was, every `h` in the map was really a width, so a
      // box drawn from it came out the wrong shape — which is what made this
      // visible at all, the overlay being the first thing ever to draw one.
      if (e.p) {
        const rel = sub(e.p, cam);
        const dist = norm(rel);
        // **Depth along the optical axis, not range.** `pixels / f` is a
        // gradient in the image plane, so turning it into metres asks for the
        // distance *to that plane* — the z component — and not for how far away
        // the thing is. The two are the same only dead ahead: at the edge of
        // this camera's 72-degree long axis they differ by 1/cos(36 deg), a 24%
        // over-estimate of every extent, and objects near the frame edge is the
        // normal case for a phone being swept round a room.
        const distZ = dot(rel, unit(quatRotate(pose.q, [0, 0, 1])));
        // Angular extents along each image axis, turned into metres at this
        // depth. fx and fy go with x and y respectively; the frame-to-camera
        // scale likewise.
        const ex = ((det.box[2] - det.box[0]) * (camW / frameW) / K.fx) * distZ;
        const ey = ((det.box[3] - det.box[1]) * (camH / frameH) / K.fy) * distZ;
        const upX = upAlongImageX(pose.q);
        const vert = upX ? ex : ey;
        const horiz = upX ? ey : ex;
        // Behind the camera is not a range at all, and a thing in the phone's
        // own hand is not something this measures.
        if (dist > 0.2 && distZ > 0.2) {
          // The vertical extent only from a box whose *world*-vertical run is
          // actually in frame: a vertically clipped box's height is a fact
          // about the viewport. The horizontal one needs no such test —
          // horizontally clipped detections were refused outright above.
          if (!axes.v && vert > 0.01) {
            e.heights.push(vert);
            if (e.heights.length > O.ringMax) e.heights.shift();
          }
          if (horiz > 0.01) {
            e.widths.push(horiz);
            if (e.widths.length > O.ringMax) e.widths.shift();
          }
        }

        // And what its *outline* says, where the fitter produced one. This is
        // the same measurement one level up: `w`/`h` are how big the silhouette
        // looked, the shape is how big the thing is and which way it faces.
        //
        // Deliberately after the extents and after `resolveEntry`, because it
        // reads `e.p` — the shape is measured at the range the map already
        // believes, and never the other way round.
        if (det.outline && outScale) {
          const sh = shapeFromOutline(det, pose, K, outScale, e.p);
          if (sh) {
            stats.shapeObs++;
            e.shapeObs.push({ ...sh, cell, at });
            if (e.shapeObs.length > O.shapeRingMax) e.shapeObs.shift();
            // Both transitions are worth a line and a save, not only the first
            // one: a normal that goes away has to survive a restart or it was
            // not refused, it was merely hidden until the next load put the old
            // answer back.
            const had = !!e.shape;
            const hadNormal = !!e.shape?.n;
            resolveShape(e);
            if (had !== !!e.shape || hadNormal !== !!e.shape?.n) {
              if (!e.shape) {
                log(`Object ${e.id} (${e.cls}) shape withdrawn — the mirror stopped being resolved`);
                saveNeeded = true;
              } else {
                // The refused case is logged too, and says which test refused
                // it. "No normal" is a measurement about this object — the
                // mirror was not resolved from these standpoints — and reading
                // it off the absence of a log line is how it would go unnoticed.
                log(`Object ${e.id} (${e.cls}) shape: ${e.shape.kind === 'ellipse'
                  ? `r ${e.shape.r.toFixed(3)} m`
                  : `${e.shape.w.toFixed(3)} x ${e.shape.h.toFixed(3)} m`}`
                  + (e.shape.n
                    ? `, normal (${e.shape.n.map((v) => v.toFixed(2)).join(', ')})`
                      + ` +/- ${e.shape.nSpreadDeg} deg`
                    : `, no normal — ${e.shape.nWhy}`)
                  + ` over ${e.shape.obs} sightings, ${e.shape.cells} cells`);
                saveNeeded = true;
              }
            }
          }
        }
      }

      // Anything with a position is on the wire — candidates are drawn dimmed —
      // so anything with a position is also a reason to push. Reporting only
      // promotions meant the map stayed empty until an object cleared a
      // two-session bar, which is most of a walk spent looking at nothing.
      together.add(e.id);
      if (det.box) frameBox.set(e.id, det.box);
      // Which entry this detection ended up on. Keyed by the detection object
      // itself because the caller holds the same array — an index would have to
      // survive every `continue` above, and each of those is a detection the map
      // refused, which is exactly what this is here to be able to say.
      //
      // The one thing that can answer "is the box on screen the same object as
      // the row in the list": the box is a detection, the row is a map entry,
      // and only this loop ever knows which became which.
      assigned.set(det, e.id);
      const promoted = tryPromote(e) || e.promoted;
      if (e.p) changed = true;
      if (promoted) saveNeeded = true;
      // The trace, after everything this detection changed. Only once there is a
      // position: a bearing and a label cannot be plotted, and a record of an
      // entry that never got one would be a row of nulls. The store throttles,
      // so this is the *offer* of a sample rather than a sample — several
      // clients looking at one object do not multiply its record.
      if (e.p) {
        hist.record(e.id, {
          p: e.p,
          r: e.r,
          arcDeg: e.arcDeg,
          priorFrac: e.priorFrac,
          nObs: e.rays.length,
          cells: e.cells.size,
          conf: e.conf,
        });
      }
    }
    // What this frame saw at once.
    //
    // **Tags count as partners and objects do not count as tags.** A frame
    // holding a chair and tag 3 says the chair is near a *surveyed* position and
    // facing roughly the way that tag is facing, which is a far stronger fact
    // than the same chair beside another guess. Both go in the same table under
    // different key prefixes so the record is one thing rather than two, and the
    // reader can tell them apart without asking anything else.
    //
    // Every tag in frame counts, including ones no detection was suppressed by:
    // the question is what was *visible together*, not what interfered.
    if (together.size) {
      const partners = [
        ...[...together].map((id) => `o${id}`),
        ...(tags || []).map((t) => `t${t.id}`).filter((k) => k !== 'tundefined'),
      ];
      for (const id of together) {
        const e = entries.get(id);
        if (!e) continue;
        for (const k of partners) {
          // Not with itself. An object is in every frame it is in.
          if (k === `o${id}`) continue;
          e.seenWith[k] = (e.seenWith[k] || 0) + 1;
        }
        // And *how much the same box* the two claims were, where both were
        // claimed by a detection this frame. Kept as a running mean and a peak:
        // a pair that is one object scores high on nearly every frame, and a
        // pair that is two objects standing together scores a stable low number
        // however many frames they share. One sample of either looks the same.
        const mine = frameBox.get(id);
        if (mine) {
          for (const other of together) {
            if (other === id) continue;
            const theirs = frameBox.get(other);
            if (!theirs) continue;
            const { iou, contain } = boxOverlap(mine, theirs);
            const k = `o${other}`;
            const r = e.overlapWith[k] || (e.overlapWith[k] = { n: 0, iou: 0, contain: 0 });
            r.n++;
            r.iou += (iou - r.iou) / r.n;
            r.contain = Math.max(r.contain, contain);
          }
        }
        trimSeenWith(e);
      }
    }
    // Expected in frame, and not there.
    //
    // **Only on a frame that detected something.** A frame the model returned
    // nothing at all for is a fact about the exposure, the motion blur or the
    // model, and reading it as "the room is empty" would quarantine whatever the
    // phone happened to be pointing at while it was being picked up.
    if (O.stale && together.size) {
      const camQ = quatConjLocal(pose.q);
      for (const e of live()) {
        if (!e.p) continue;
        if (together.has(e.id)) {
          // Seen. The streak is not decremented, it is *dropped*: the question
          // this rule asks is "how long has it been looked at and not found",
          // and one sighting answers it completely.
          e.hits++;
          e.missStreak = 0;
          e.missCells.clear();
          e.evidence = 0;
          continue;
        }
        // **A sighting that landed on a sibling is not a miss here.** One plant
        // filed as four entries had every detection routed to one of them, and
        // the other three scored a miss in a frame where the plant was plainly
        // detected. Three of them were quarantined for not being where they
        // are. Anything of this class within merge reach of this entry holds the
        // same claim, so a detection landing there says the object is present.
        if (seenBySibling(e, together)) continue;
        const rel = quatRotate(camQ, sub(e.p, cam));
        if (!wellInFrame(rel, K, camW, camH, {
          inset: O.staleInsetFrac,
          maxRangeM: O.staleMaxRangeM,
          minDepthM: O.staleMinDepthM,
        })) continue;
        // What this frame was worth. Zero for a look that could not have
        // produced a detection anyway — too small, facing away, behind a wall —
        // and those frames are not counted as misses either, because they are
        // not evidence of anything.
        const p = seeChance(e, rel, cam, K);
        const gain = p > 0 ? -Math.log(1 - p) : 0;
        if (gain < O.staleMinFrameEvidence) continue;
        e.misses++;
        e.missStreak++;
        // **Once per standpoint, not once per frame.** Consecutive frames are
        // not independent looks: an object goes dark for a run because the
        // *viewpoint* is bad — an angle, a glare, a partial occlusion — and that
        // condition holds for the whole run. Scored per frame, one bad
        // standpoint was counted dozens of times: measured, `Clock #8` reached
        // 84 nats in 28 frames and was then seen again, and the rule was worse
        // than the counter it replaced at every bar.
        //
        // A standpoint is the unit at which a look is genuinely a new look, and
        // it is the same cell the old rule already tracked for its own reasons.
        const fresh = !e.missCells.has(cell);
        e.missCells.add(cell);
        if (!fresh) continue;
        e.evidence = (e.evidence || 0) + gain;
        if (e.evidence >= O.staleEvidence && e.missStreak >= O.staleStreak
          && e.missCells.size >= O.staleMinCells) {
          quarantine(e, 'stale');
          hist.event(e.id, 'stale', {
            cls: e.cls,
            evidence: Math.round(e.evidence * 10) / 10,
            missStreak: e.missStreak,
            cells: e.missCells.size,
            hits: e.hits,
            misses: e.misses,
          });
          saveNeeded = true;
        }
      }
    }
    // Reconciliation runs on a detection counter rather than per detection: the
    // pass is quadratic in positioned entries, and the fragments it is there to
    // find do not appear one per frame.
    sinceMerge += dets.length;
    if (sinceMerge >= O.mergeEveryN) {
      sinceMerge = 0;
      if (mergeEntries()) changed = true;
    }
    // The *file* is still promoted objects only, so it is not rewritten every
    // time a candidate twitches.
    if (saveNeeded) scheduleSave();
    return { changed, assigned };
  }

  // Which mapped thing, if any, this detection is. Class first — it is the only
  // cross-session, cross-viewpoint descriptor in the system, and the whole
  // reason this is not landmarks — then geometry to choose between the
  // instances that share it.
  function associate(det, cam, dir, cell, newPlanar, note) {
    const key = normClass(det.cls);
    let best = null;
    let bestCos = Math.cos(O.assocMaxDeg * Math.PI / 180);
    let sawClass = false;
    let sawPositioned = false;
    // Two passes, positioned entries first. A candidate that has not been
    // triangulated yet must never win against one that has: the bootstrap test
    // below is far weaker than a bearing check against a known position, and
    // letting it answer first means a well-established object loses sightings
    // to a fragment of itself that happens to be earlier in the map.
    for (const e of entries.values()) {
      // A *class* quarantine is not up for revisiting by a sighting: the running
      // model cannot name that class, so no detection of it arrives, and letting
      // one in sideways would be a verdict overturned by something that never
      // happens. A **stale** one is the opposite. It says "this should have been
      // visible and was not", and a bearing that lands on it is precisely the
      // evidence that it was wrong — refusing that would leave the map unable to
      // correct itself and quietly filing a second entry at the same spot.
      if (e.gone?.why === 'class' || !answersTo(e, key)) continue;
      sawClass = true;
      if (!e.p) continue;
      sawPositioned = true;
      const toObj = sub(e.p, cam);
      const dist = norm(toObj);
      if (dist < 1e-3) continue;
      const c = dot(dir, unit(toObj));
      if (c > bestCos) { bestCos = c; best = e; }
    }
    if (best) return best;
    // How far the best attempt got, kept as the most advanced test any pair
    // reached rather than the last one tried — "every pair was parallel" and
    // "one pair crossed but the elevations disagreed" are different problems
    // with different fixes.
    let rank = sawPositioned ? ASSOC_RANK.bearingMiss
      : (sawClass ? ASSOC_RANK.noPair : ASSOC_RANK.noClassMatch);
    const reach = (r) => { if (r > rank) rank = r; };
    for (const e of entries.values()) {
      if (e.gone?.why === 'class' || !answersTo(e, key)) continue;
      if (!e.p) {
        // Not yet triangulated, so there is no position to compare a bearing
        // against — but the rays it already holds are still geometry. Ask
        // whether this new bearing and an existing one could be looking at the
        // same thing: they must meet in front of both cameras, close enough to
        // be one object, and at a sane range.
        //
        // The previous rule required the new sighting to come from the *same*
        // 0.4 m viewpoint cell as the last one, which a walking camera leaves
        // in a single step. Measured on the first real walks: 56 of 76
        // unpromoted entries had two sightings or fewer — one physical object
        // filed 27 times as `book`, 10 as `oven`, 6 as `microwave`. Nothing
        // could ever accumulate the eight sightings promotion asks for, so the
        // map was sparse for a reason that had nothing to do with the room.
        const note = {};
        for (let i = e.rays.length - 1; i >= 0 && i >= e.rays.length - 12; i--) {
          const prev = e.rays[i];
          note.why = null;
          const meet = pairPointHoriz(prev, { o: cam, dir },
            Math.sin(O.bootstrapMinArcDeg * Math.PI / 180), note);
          if (!meet) { reach(ASSOC_RANK[note.why] ?? ASSOC_RANK.noPair); continue; }
          if (meet.t > O.bootstrapMaxRangeM || meet.u > O.bootstrapMaxRangeM) {
            reach(ASSOC_RANK.range);
            continue;
          }
          // When both bearings have a trustworthy elevation, check it too — the
          // horizontal test alone would happily merge a picture on the wall with
          // the sofa beneath it.
          if (!prev.planar && !newPlanar) {
            const yPrev = prev.o[1] + prev.dir[1] * (meet.t / Math.hypot(prev.dir[0], prev.dir[2]));
            const yNew = cam[1] + dir[1] * (meet.u / Math.hypot(dir[0], dir[2]));
            if (Math.abs(yPrev - yNew) > O.bootstrapMaxDyM) {
              reach(ASSOC_RANK.elevation);
              continue;
            }
          }
          return e;
        }
        // Same spot, same class, and no parallax yet to judge with: still the
        // most likely explanation.
        if (e.rays.length && e.rays[e.rays.length - 1].cell === cell) return e;
      }
    }
    if (note) note.why = ASSOC_REASONS[rank];
    return null;
  }

  function newEntry(det, why) {
    const e = {
      id: nextId++, cls: det.cls, key: normClass(det.cls), keys: null, p: null, r: 0.3, h: null, w: null,
      // Never born quarantined: `allows()` refused the detection long before
      // this, so anything that gets here is a class the map takes.
      gone: null,
      // What this has been seen in frame with, counted. `o<id>` for another
      // mapped object, `t<id>` for a surveyed tag — see the pass in `observe`.
      seenWith: {},
      // Box overlap with each of those partners — see `boxOverlap`. Recorded
      // because it cannot be recovered later, and read by nothing yet, exactly
      // like the count it sits beside.
      overlapWith: {},
      // The stale rule's own state. `missStreak`/`missCells` are the live claim
      // and are dropped whole by one sighting; `hits`/`misses` are the lifetime
      // tally and are what says whether the bar is set anywhere near right.
      missStreak: 0, missCells: new Set(), hits: 0, misses: 0,
      // Accumulated evidence that this is no longer there, in nats. See
      // `staleEvidence`.
      evidence: 0,
      rays: [], promoted: false, arcDeg: 0, priorFrac: 1, inlierFrac: 1,
      // Nothing solved yet, so no direction is determined at all — see
      // `resolveEntry`, which sets this, and `posSigma`, which reads a zero as
      // "unknown" rather than as "perfect".
      posLambdaMin: 0,
      sessions: new Set(), cells: new Set(), resid: null, lastSeenAtMs: null,
      streak: 0, heights: [], widths: [], prior: null, conf: null,
      // The measured *outline* of the thing, as opposed to the apparent
      // silhouette `w`/`h` record. Per-sighting candidates in `shapeObs`, the
      // aggregate in `shape` — see `resolveShape`.
      shapeObs: [], shape: null,
      // Why this became a new entry rather than joining an existing one. An
      // entry that never grows past two sightings is usually an association
      // that never found its way home, and this says which test sent it here.
      bornWhy: why || null,
    };
    entries.set(e.id, e);
    // The first thing in the record, and the one that dates everything after it.
    // `why` is the association test that sent this detection here rather than to
    // an existing entry — which is the whole of the answer when a fragment turns
    // out to be a duplicate of something already mapped.
    hist.event(e.id, 'born', { cls: e.cls, why: why || null });
    return e;
  }

  // The wire shape, promoted objects only. `priorFrac` and `arcDeg` ride along
  // deliberately: an object standing on depth rather than on parallax has to be
  // visibly different on the map from one that was actually triangulated.
  // Promoted objects *and* candidates that already have a position. The
  // candidates are drawn dimmed and are most of what there is to look at on a
  // first walk — promotion deliberately needs two sessions, and a map that
  // showed nothing at all until the second one would be untestable by the
  // person doing the walking.
  function getObjects() {
    return {
      anchorId,
      objects: live().filter((e) => e.p).map(wireObject),
      // **Quarantined entries ride in their own field, never in `objects`.**
      // Everything that draws the map reads `objects` and would put a ring and a
      // name on the floor for a thing the map has just ruled out — which is the
      // one claim quarantining exists to stop it making. But an entry that
      // vanished with no way to ask why is the failure this whole record was
      // built to answer, so it goes on the wire beside the map rather than
      // instead of it: the drawer lists these, the renderers never see them.
      quarantined: [...entries.values()].filter((e) => e.gone && e.p).map(wireObject),
    };
  }

  function wireObject(e) {
    return {
      promoted: !!e.promoted,
      id: e.id,
      cls: e.cls,
      p: e.p.map((v) => Math.round(v * 1000) / 1000),
      r: Math.round(e.r * 100) / 100,
      h: e.h,
      w: e.w ?? null,
      // The phone draws this instead of the billboard where it exists: a
      // circle projects to an ellipse and a rectangle to a quad, and both are
      // a far stronger claim about the object than a rectangle of apparent
      // extents.
      shape: e.shape ?? null,
      nObs: e.rays.length,
      arcDeg: e.arcDeg,
      priorFrac: e.priorFrac,
      conf: e.conf ?? null,
      cells: e.cells.size,
      sessions: e.sessions.size,
      resid: e.resid === null ? null : Math.round(e.resid * 1000) / 1000,
      planarOnly: !!e.heightDerived,
      // Whether this object is fit to be localized against at all.
      usable: e.priorFrac <= O.priorFracMax && e.arcDeg >= O.minArcDeg,
      lastSeenAtMs: e.lastSeenAtMs,
      // Null for everything in the map. One shape for both lists rather than
      // two builders: the quarantined card shows the same numbers as any other,
      // and it is only the reason that is extra.
      gone: e.gone ?? null,
      // How often it has been looked at and found, against how often it has been
      // looked at and not. The stale rule's whole case, and the only way to tell
      // a bar set right from one that has simply not fired yet.
      hits: e.hits,
      misses: e.misses,
      missStreak: e.missStreak,
      // The strongest partners only, and as pairs rather than as the whole
      // table: this rides on a push that goes out several times a second to
      // every room watcher, and the tail of a co-visibility count is a long list
      // of ones. The full table is in `objects.json` for whatever reads it next.
      seenWith: Object.entries(e.seenWith || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 8),
    };
  }

  // Everything, promoted or not, for the replay tools. The candidates are most
  // of the diagnostic value — an experiment that only ever showed its successes
  // could not say why the rest failed.
  function debugEntries() {
    return [...entries.values()].map((e) => ({
      id: e.id, cls: e.cls, key: e.key, keys: e.keys || null,
      p: e.p, r: e.r, h: e.h, w: e.w ?? null,
      shape: e.shape ?? null, shapeObs: e.shapeObs?.length ?? 0,
      promoted: e.promoted,
      nObs: e.rays.length, arcDeg: e.arcDeg, priorFrac: e.priorFrac, conf: e.conf ?? null,
      inlierFrac: e.inlierFrac, cells: e.cells.size, sessions: e.sessions.size,
      resid: e.resid, bornWhy: e.bornWhy ?? null, gone: e.gone ?? null,
    }));
  }

  // The association funnel's own counters. Diagnostic only — nothing reads them
  // back, so they can be extended without a replay noticing.
  function getStats() {
    return {
      ...stats, assoc: { ...stats.assoc }, shapeWhy: { ...stats.shapeWhy },
      vocab, classes: [...classKeys],
    };
  }

  // Where the camera is, from **one** object of known shape.
  //
  // This is the whole point of measuring outlines. `localize` needs three
  // mapped objects in view and gets them on 1.4% of tagless frames; a mapped
  // object whose shape is known is a virtual tag, and one of those is enough —
  // it carries the eight numbers a bounding box does not.
  //
  // Gravity is known to ~2 degrees, so the unknown is a yaw and a translation.
  // A shape gives both: the recovered plane normal against the map's stored one
  // gives the yaw, and the recovered centre in camera coordinates gives the
  // translation from the object's known room position.
  //
  // **It feeds nothing.** Not `maintainSurvey`, not `walls.handleReport`, not
  // the XR alignment, not `mapSafe`, not the reported room pose. It is a second
  // opinion published beside the survey's own, exactly as `localize` is, and the
  // bar for that ever changing is zero measured false fixes.
  //
  // ## Resolving the mirror, and never by coin flip
  //
  // Every planar solve returns two poses. In order:
  //
  // 1. **Gravity.** A solution whose plane elevation is not what the map says
  //    this object's is gets refused outright. Yaw is a rotation about the
  //    vertical and therefore cannot change an elevation, so this test is
  //    independent of the very quantity it is helping to solve — which is what
  //    makes it usable at all.
  // 2. **The margin.** If both survive, the winner must beat the runner-up by
  //    `shapeElevMarginDeg`. Otherwise there are two answers and the output is
  //    none, the same rule `localize`'s ambiguity margin follows.
  // 3. **The carried alignment**, last and only when the two candidates are
  //    further apart than the carry's own measured error — below that it cannot
  //    tell them apart and consulting it would be a guess with a number on it.
  // Why a frame produced no fix, ordered by how far the attempt got — the same
  // shape `associate`'s `bornWhy` has, and for the same reason. "No fix" was as
  // far as this could see, and a refusal that cannot name its own test is one
  // nobody can act on while standing in front of the object it refused.
  function poseFromShape({
    dets, K, camW, camH, frameW, frameH, qGravity, align, xr, tags, note,
    clientId, sid, at,
  } = {}) {
    const fail = (why) => {
      if (note && SHAPE_WHY.indexOf(why) > SHAPE_WHY.indexOf(note.why || SHAPE_WHY[0])) {
        note.why = why;
      }
      stats.shapeWhy[why] = (stats.shapeWhy[why] || 0) + 1;
      return null;
    };
    if (note) note.why = 'noOutline';
    if (!dets?.length || !K?.fx || !qGravity) return fail('noOutline');
    const s = outlineScale(camW, camH, frameW, frameH);
    if (!s) return fail('anisotropic');
    // **The tag trap, refused before anything is solved.** The best-conditioned
    // quad in this room is a printed ArUco tag — a hard-edged black square on
    // white paper — and any quad fitter locks onto one beautifully. Measured
    // over the corpus, 12.3% of every outline fitted is a tag.
    //
    // Solving a pose from one would work *brilliantly* and mean nothing: it
    // would re-derive the camera position from the tags the survey already
    // knows to millimetre grade, a second opinion built from the same evidence
    // and dressed up as an independent one. `observe` refuses them on the way
    // into the map for the same reason; this is the same refusal on the way
    // out, and it has to be here rather than in the fitter because the fitter
    // runs offline where there is no pose and therefore no tags.
    const tagRects = tagBoxes(tags, camW, camH, frameW, frameH);
    // Where the carried alignment says the camera is, for the last-resort
    // tie-break. Absent is normal and simply removes that step.
    const carried = align && xr?.p
      ? addv(yawRotate(align.yaw, xr.p), align.t)
      : null;
    // What has been in frame recently, for the tie-break that needs no room
    // pose. Recorded on every call, including the ones that go on to refuse:
    // the evidence is what the camera saw, not what the solver managed to do
    // with it.
    rememberSeen({ clientId, sid, at, xr, dets, K, camW, camH, frameW, frameH, qGravity });

    const fixes = [];
    for (const det of dets) {
      const o = det.outline;
      if (!o) continue;
      if (tagRects.length
        && explainedByTag(det.box, tagRects, O.tagInsideFrac, O.tagBoxAreaMax)) {
        stats.shapeTagRefused++;
        fail('isTag');
        continue;
      }
      const key = normClass(det.cls);
      // **The same bar `localize` holds its own candidates to.** An object may
      // be promoted and still have a position the map declines to commit to —
      // standing on the depth prior, or triangulated over too narrow an arc to
      // have a range at all. Solving a camera pose against one inherits that
      // error whole, and the object with the shape is very often exactly the
      // suspect one: the living-room clock here is promoted, carries a measured
      // radius, and has a **3.7 degree** parallax arc, which is no range
      // measurement at all. It was being used as a fix target while the 2D map
      // was correctly refusing to put a name on it.
      const targets = usableObjects().filter((e) => e.shape?.n
        && e.shape.kind === o.kind && answersTo(e, key));
      if (!targets.length) { fail('noShapedObject'); continue; }
      for (const e of targets) {
        const sn = e.shape.n;
        // A surface whose normal points at the ceiling has no azimuth, so there
        // is no yaw in it to recover. A table is a real object and this is not
        // a fix it can give.
        if (Math.hypot(sn[0], sn[2]) < O.shapeMinHorizNormal) { fail('flatNormal'); continue; }
        const sols = shapeSolutions(o, K, s, e.shape, qGravity);
        if (!sols?.length) { fail('noSolution'); continue; }
        // **Every solution is scored, and none is dropped before they are
        // compared.** Filtering by the elevation gate first and then treating a
        // lone survivor as unambiguous is the bug this shape exists to avoid: it
        // makes a *tighter* gate produce *more* accepted fixes, because killing
        // one candidate promotes the other past the margin test instead of
        // failing it. Measured, that is exactly what happened — 20 deg gave 318
        // fixes at 23.0% false and 5 deg gave 500 at 30.2%, the gate manufacturing
        // confidence as it was tightened.
        const cands = [];
        for (const sol of sols) {
          const ng = quatRotate(qGravity, sol.n);
          const cg = quatRotate(qGravity, sol.c);
          const hg = Math.hypot(ng[0], ng[2]);
          if (hg < O.shapeMinHorizNormal) continue;
          const elevDiff = Math.abs(
            (Math.asin(Math.max(-1, Math.min(1, ng[1])))
              - Math.asin(Math.max(-1, Math.min(1, sn[1])))) * 180 / Math.PI);
          // The yaw that carries the recovered normal's azimuth onto the stored
          // one, in closed form: two components, one rotation, no search.
          const a = [ng[0], ng[2]];
          const b = [sn[0] / Math.hypot(sn[0], sn[2]), sn[2] / Math.hypot(sn[0], sn[2])];
          const aa = a[0] * a[0] + a[1] * a[1];
          const yaw = Math.atan2((a[1] * b[0] - a[0] * b[1]) / aa,
            (a[0] * b[0] + a[1] * b[1]) / aa);
          cands.push({ p: sub(e.p, yawRotate(yaw, cg)), yaw, elevDiff });
        }
        if (!cands.length) { stats.shapeRefused++; fail('flatSolution'); continue; }
        cands.sort((x, y) => x.elevDiff - y.elevDiff);
        // 1. Gravity: the winner has to be a surface this object could be.
        if (cands[0].elevDiff > O.shapeElevTolDeg) {
          stats.shapeRefused++;
          fail('elevation');
          continue;
        }
        let by;
        if (cands.length === 1) {
          // Genuinely one solution — the head-on degeneracy, where the mirror
          // partner has converged onto its twin. There is nothing to be
          // ambiguous between.
          by = 'single';
        } else if (cands[1].elevDiff - cands[0].elevDiff >= O.shapeElevMarginDeg) {
          // 2. The map's stored normal, by margin. Note the runner-up is
          // compared even when it *failed* the gate above: that it failed is the
          // margin, and re-using the number rather than the verdict is what
          // keeps a tighter gate from turning an ambiguous frame into a
          // confident one.
          by = 'elevation';
        } else if (carried && norm(sub(cands[0].p, cands[1].p)) > O.shapeCarryMinSepM) {
          // 3. The carried alignment, last, and only where the two are further
          // apart than the carry's own measured error.
          const d0 = norm(sub(cands[0].p, carried));
          const d1 = norm(sub(cands[1].p, carried));
          if (d1 < d0) cands.reverse();
          by = 'carry';
        } else { stats.shapeRefused++; fail('mirror'); continue; }
        fixes.push({
          ...cands[0],
          id: e.id,
          cls: e.cls,
          kind: o.kind,
          // How many mapped objects of this class carried a shape this
          // detection could have been solved against. One means the class
          // picked the instance; more than one means it did not, and the
          // question stops being "which of two mirror solutions" and becomes
          // metric (d)'s question — whether a label plus an arrangement can
          // tell one shelf from another.
          rivals: targets.length,
          marginDeg: cands.length > 1
            ? Math.round((cands[1].elevDiff - cands[0].elevDiff) * 10) / 10 : null,
          by,
        });
      }
    }
    if (!fixes.length) return null;
    fixes.sort((a, b) => a.elevDiff - b.elevDiff);
    // Two shapes in view — or one detection matching two mapped instances of its
    // own class — that disagree about where the camera is are two answers, not
    // one answer found twice.
    //
    // **Two clocks in two rooms are the case this is really about**, and a class
    // label cannot separate them: the detection is the word "Clock" and an
    // ellipse, and a 0.51 m clock at 3.0 m projects to exactly the same ellipse
    // as a 0.39 m clock at 2.3 m. Both hypotheses explain the picture perfectly,
    // so the picture cannot choose — and the further apart the two objects are,
    // the *more* certain the disagreement, which is the opposite of helpful.
    //
    // What can choose is where the camera already was. The phone is tracking and
    // the alignment carried from the last tag fix says which room it is standing
    // in; one hypothesis is metres away through a wall. This is the plan's own
    // step 3 — the carried alignment as a tie-break of last resort, and only
    // where the candidates are further apart than the carry's own measured error
    // (worst anywhere over the corpus: 0.370 m) — applied to rival *objects* and
    // not only to the mirror pair, which is where it was first wired and where
    // it did nothing for this case.
    //
    // It is a **selection between discrete hypotheses metres apart**, never a
    // refinement: the carry contributes nothing to the answer's coordinates, and
    // where there is no carry the fix is still refused rather than guessed.
    let chosen = fixes[0];
    if (fixes.some((f) => norm(sub(chosen.p, f.p)) > O.ambiguityM)) {
      // **What else is in the room, first.** A hypothesis that puts the camera
      // in the kitchen predicts the microwave and the oven where they are; the
      // one that puts it in the living room predicts objects that are not there
      // and misses the ones that are. That is independent evidence about the
      // room rather than a prior about the camera, so it outranks the carry —
      // and unlike the carry it survives the survey having no answer at all,
      // which is the condition this whole feature was built for.
      const support = O.shapeSupport ? rivalSupport(fixes, K, camW, camH, xr) : null;
      if (support) {
        stats.shapeFix++;
        return {
          ...support.fix, by: 'support', supportQuality: support.margin,
          nFixes: fixes.length, yawDeg: (support.fix.yaw * 180) / Math.PI,
        };
      }
      if (!carried) { stats.shapeRefused++; return fail('rivals'); }
      const ranked = [...fixes].sort(
        (a, b) => norm(sub(a.p, carried)) - norm(sub(b.p, carried)));
      const d0 = norm(sub(ranked[0].p, carried));
      const d1 = norm(sub(ranked[1].p, carried));
      // Neither supported, or both equally: no answer. The runner-up has to be
      // further from the carry than the carry's own error, or this is a coin
      // flip wearing a measurement's clothes.
      if (d0 > O.shapeCarryMaxM || d1 - d0 < O.shapeCarryMinSepM) {
        stats.shapeRefused++;
        return fail('rivals');
      }
      chosen = { ...ranked[0], by: 'rival', rivalSepM: Math.round((d1 - d0) * 100) / 100 };
    } else if (carried && norm(sub(chosen.p, carried)) > O.shapeCarryMaxM) {
      // **An unchallenged hypothesis is not a checked one.** Everything above
      // fires only when two candidates disagree; a frame carrying one shaped
      // candidate walked straight out with nothing having tested it, and the
      // elevation gate it did pass is a test against the map's own stored
      // normal, not against the room.
      //
      // Measured, that is where the errors are. Refusing three normals moved 81
      // frames out of the contested path and into this one, and the false-fix
      // rate of the frames that moved went 6.0% to 33.4% — same code, sparser
      // map. The 2.8% headline was resting on the map being dense enough in
      // shaped objects that the carry cross-check below kept firing, which is
      // not a property of the fix and cannot be relied on as one.
      //
      // Same constant and same rule as the rival branch: agree with where the
      // phone already thinks it is, or say nothing. **No carry is not a
      // failure** — a frame the survey cannot answer is the condition this
      // whole feature exists for, and there the fix stands alone as before.
      stats.shapeRefused++;
      return fail('unsupported');
    }
    stats.shapeFix++;
    return { ...chosen, nFixes: fixes.length, yawDeg: (chosen.yaw * 180) / Math.PI };
  }

  // Recent frames, per client, for the constellation tie-break. Keyed by XR
  // session: the offsets below are differences of session positions, and two
  // sessions have different origins.
  const seenByClient = new Map();

  function rememberSeen({
    clientId, sid, at: t, xr, dets, K, camW, camH, frameW, frameH, qGravity,
  }) {
    if (clientId === undefined || !xr?.p || !qGravity || !t) return;
    let held = seenByClient.get(clientId);
    if (!held || held.sid !== sid) {
      held = { sid, items: [] };
      seenByClient.set(clientId, held);
    }
    held.items.push({ at: t, xrP: xr.p, qGravity, dets, K, camW, camH, frameW, frameH });
    while (held.items.length > O.shapeSeenMax) held.items.shift();
    while (held.items.length && t - held.items[0].at > O.shapeSeenWindowMs) held.items.shift();
  }

  // Which of two rival hypotheses the rest of the room supports.
  //
  // Every recent frame's detections are scored against each hypothesis through
  // the *same* scorer the from-scratch matcher uses — matched bearings count
  // for, mapped objects the hypothesis puts comfortably in frame that nothing
  // claims count against. A past frame's camera sits at a known offset in the
  // session frame, which is gravity-aligned and stays self-consistent whatever
  // the room alignment is doing.
  //
  // Returns nothing unless one hypothesis beats the other by `ambiguityMargin`
  // — the same bar `localize` holds its own runner-up to, and for the same
  // reason: a plausible impostor is exactly what gets believed.
  function rivalSupport(fixes, K, camW, camH, xr) {
    const held = xr?.p ? [...seenByClient.values()].find((h) => h.items.length) : null;
    if (!held) return null;
    const usable = usableObjects();
    if (usable.length < 2) return null;
    const now = held.items[held.items.length - 1];
    const obs = [];
    for (const it of held.items) {
      if (!it.K?.fx) continue;
      const origin = [
        it.xrP[0] - now.xrP[0], it.xrP[1] - now.xrP[1], it.xrP[2] - now.xrP[2],
      ];
      obs.push(...buildObs(it.dets, it.K, it.camW, it.camH, it.frameW, it.frameH,
        it.qGravity, usable, norm(origin) > 1e-6 ? origin : null));
    }
    if (obs.length < 2) return null;
    const score = makeScorer(obs, usable, K, camW, camH);
    const ranked = fixes
      .map((f) => ({ fix: f, s: score(f.yaw, f.p) }))
      .sort((a, b) => b.s.quality - a.s.quality || b.s.cosSum - a.s.cosSum);
    const margin = ranked[0].s.quality - ranked[1].s.quality;
    if (margin < O.shapeSupportMargin) return null;
    return { fix: ranked[0].fix, margin: Math.round(margin * 100) / 100 };
  }

  // The camera-frame poses one outline allows, given the object's stored metric
  // shape. Two of them, always — see the mirror note above.
  function shapeSolutions(o, K, s, shape, qGravity) {
    if (o.kind === 'ellipse') {
      if (!(shape.r > 0)) return null;
      const conic = ellipseToConic({
        cx: o.cx * s, cy: o.cy * s, rx: o.rx * s, ry: o.ry * s, theta: o.theta,
      });
      return circlePoseFromConic(conic, K, shape.r);
    }
    if (o.kind === 'quad') {
      if (!(shape.w > 0) || !(shape.h > 0)) return null;
      const pts = o.pts.map((p) => [p[0] * s, p[1] * s]);
      const pl = quadPlaneFromCorners(pts, K);
      if (!pl) return null;
      const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
      const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
      const axis = rayFor(cx, cy, K);
      const out = [];
      for (const n of [pl.n, mirrorAboutAxis(pl.n, axis)]) {
        const trial = quadTrialCorners(pts, K, n);
        if (!trial) continue;
        // Which image side is the object's height, asked of the trial's own 3D
        // edges rather than inferred from the roll. `shape.w`/`shape.h` are room
        // axes and the solver wants the top and left sides, and the phone is
        // held landscape 98% of the time so the two are usually swapped.
        const top = unit(quatRotate(qGravity, sub(trial[1], trial[0])));
        const left = unit(quatRotate(qGravity, sub(trial[3], trial[0])));
        const topIsVertical = Math.abs(top[1]) > Math.abs(left[1]);
        const pose = quadPoseFromSize(pts, K, n,
          topIsVertical ? shape.h : shape.w,
          topIsVertical ? shape.w : shape.h);
        if (pose) out.push({ c: pose.c, n: pose.n });
      }
      return out;
    }
    return null;
  }

  // Where the camera is, from objects alone.
  //
  // `qGravity` is the camera's orientation in a **gravity-aligned** frame with
  // CV axes — on /xr-client that is ARCore's own session frame, which is
  // gravity-aligned by definition. What is unknown is the yaw and translation
  // between that frame and the room, and that is what this solves.
  //
  // It feeds nothing. Not `maintainSurvey`, not `walls.handleReport`, not the
  // XR alignment, not the reported room pose, not `mapSafe`. It is a second
  // opinion published beside the survey's own, and the disagreement between
  // them is the product — the same show-both discipline the outside-in cube
  // plan chose, for the same reason.
  //
  // Departure from the plan, stated rather than buried: the refinement is a
  // 4-DOF alternation (yaw, then translation) instead of `solvePose`'s 6-DOF
  // Levenberg-Marquardt. `solvePose` would re-introduce pitch and roll as free
  // parameters, and with a handful of noisy bearings it will happily tilt the
  // camera to absorb bearing error — discarding the one constraint measured to
  // hold to 2 degrees. Fewer unknowns than measurements is the point.
  // Objects a hypothesis may be tested against: positioned, promoted, and not
  // standing on the depth prior or on too little parallax to be worth pointing
  // at.
  function usableObjects() {
    return live().filter((e) => e.promoted && e.p
      && e.priorFrac <= O.priorFracMax && e.arcDeg >= O.minArcDeg);
  }

  // Every (detection, mapped object) pair that shares a class, with the
  // detection's bearing in the gravity-aligned frame. The class is doing the
  // work a descriptor would: it is what makes the candidate set a couple of
  // dozen entries rather than every object against every object.
  //
  // `origin` is where the camera that made these detections sat, in the
  // gravity-aligned session frame, relative to the frame being solved for. Zero
  // for the current frame; non-zero for a frame from a few seconds ago, whose
  // detections are still perfectly good evidence because **ARCore's session
  // poses stay consistent with each other even when the room alignment is
  // lost** — which is exactly the condition this is most needed in.
  function buildObs(dets, K, camW, camH, frameW, frameH, qGravity, usable, origin) {
    const obs = [];
    for (const det of dets || []) {
      if (!allows(det.cls) || det.clipped) continue;
      const b = unit(quatRotate(qGravity, bearing(det, K, camW, frameW, frameH, camH)));
      const key = normClass(det.cls);
      const cands = usable.filter((e) => answersTo(e, key));
      if (cands.length) obs.push({ det, b, cands, o: origin || null });
    }
    return obs;
  }

  // How well one hypothesis — a yaw and a camera position — explains a set of
  // observations. One implementation, shared by the from-scratch matcher and by
  // the rival tie-break, because a second copy of "does this pose explain the
  // room" would be a second answer to the same question.
  function makeScorer(obs, usable, K, camW, camH) {
    const tolCos = Math.cos(O.localizeTolDeg * Math.PI / 180);
    return (yaw, C) => {
      const assigned = new Map();
      let inliers = 0;
      let cosSum = 0;
      for (const o of obs) {
        // Where the camera that saw this one was, under this hypothesis.
        const at = o.o ? addv(C, yawRotate(yaw, o.o)) : C;
        const d = yawRotate(yaw, o.b);
        let best = null;
        let bestCos = tolCos;
        for (const e of o.cands) {
          const rel = sub(e.p, at);
          const n = norm(rel);
          if (n < 1e-3) continue;
          const c = dot(d, unit(rel));
          if (c > bestCos) { bestCos = c; best = e; }
        }
        if (best && !assigned.has(best.id)) {
          assigned.set(best.id, o);
          inliers++;
          cosSum += bestCos;
        }
      }
      // Negative evidence: a mapped object that this hypothesis puts comfortably
      // in frame, near enough to be seen, and which no detection claims, counts
      // against. Without it a constellation turned 180 degrees can match a
      // couple of bearings by coincidence and nothing contradicts it — the same
      // idea as walls.js's negativePass, and the same reason.
      // Judged against the *current* frame only, deliberately: "you should have
      // seen this three seconds ago" is a claim about where the phone was
      // pointing then, and nothing here knows that.
      let missing = 0;
      for (const e of usable) {
        if (assigned.has(e.id)) continue;
        if (wellInFrame(yawRotate(-yaw, sub(e.p, C)), K, camW, camH,
          { inset: O.negInsetFrac, maxRangeM: O.negMaxRangeM })) missing++;
      }
      return { n: inliers, missing, quality: inliers - O.negWeight * missing, cosSum, assigned };
    };
  }

  function localize({ dets, K, camW, camH, frameW, frameH, qGravity } = {}) {
    if (!dets?.length || !K?.fx || !qGravity) return null;
    const usable = usableObjects();
    if (usable.length < 2) return null;
    const obs = buildObs(dets, K, camW, camH, frameW, frameH, qGravity, usable, null);
    if (obs.length < 2) return null;
    const score = makeScorer(obs, usable, K, camW, camH);

    // Exhaustive over minimal samples: two correspondences, different
    // detections and different objects. Deterministic by construction.
    let best = null;
    let second = null;
    for (let i = 0; i < obs.length; i++) {
      for (let j = i + 1; j < obs.length; j++) {
        for (const e1 of obs[i].cands) {
          for (const e2 of obs[j].cands) {
            if (e1.id === e2.id) continue;
            for (const hyp of yawFromPair(obs[i].b, obs[j].b, e1.p, e2.p)) {
              const s = score(hyp.yaw, hyp.C);
              if (s.n < 2) continue;
              const cand = { ...hyp, ...s };
              if (!best || cand.quality > best.quality
                || (cand.quality === best.quality && cand.cosSum > best.cosSum)) {
                // Only a *materially different* pose counts as the runner-up;
                // the same pose found twice from two samples is agreement, not
                // ambiguity.
                if (best && norm(sub(best.C, cand.C)) > O.ambiguityM) second = best;
                best = cand;
              } else if ((!second || cand.quality > second.quality)
                && norm(sub(best.C, cand.C)) > O.ambiguityM) {
                second = cand;
              }
            }
          }
        }
      }
    }
    if (!best || best.n < O.localizeMinInliers) return null;

    // Refinement, alternating: with yaw fixed the camera position is a linear
    // ray intersection (the same normal equations as triangulate, with the
    // objects as origins); with the position fixed the yaw is a circular mean
    // of the horizontal bearing errors.
    let { yaw, C } = best;
    let assigned = best.assigned;
    for (let it = 0; it < 4; it++) {
      const rays = [];
      for (const [id, o] of assigned) {
        const e = entries.get(id);
        rays.push({ o: e.p, dir: yawRotate(yaw, o.b), w: o.det.score || 0.5 });
      }
      if (rays.length < 2) break;
      const sol = triangulate(rays, null);
      if (sol) C = sol.p;
      let sx = 0;
      let sy = 0;
      for (const [id, o] of assigned) {
        const e = entries.get(id);
        const want = Math.atan2(e.p[0] - C[0], e.p[2] - C[2]);
        const have = Math.atan2(o.b[0], o.b[2]);
        sx += Math.cos(want - have);
        sy += Math.sin(want - have);
      }
      if (sx || sy) yaw = Math.atan2(sy, sx);
      const s = score(yaw, C);
      if (s.n < 2) break;
      assigned = s.assigned;
    }

    const final = score(yaw, C);
    if (final.n < O.localizeMinInliers) return null;
    // An ambiguous constellation must produce no fix at all. A confidently
    // wrong position is far worse than none: the survey's own fix is sitting
    // beside this one, and a plausible impostor is exactly what would get
    // believed.
    if (second && final.quality - second.quality < O.ambiguityMargin) return null;

    let sumDeg2 = 0;
    for (const [id, o] of final.assigned) {
      const e = entries.get(id);
      const c = Math.max(-1, Math.min(1, dot(yawRotate(yaw, o.b), unit(sub(e.p, C)))));
      const deg = Math.acos(c) * 180 / Math.PI;
      sumDeg2 += deg * deg;
    }
    return {
      p: C.map((v) => Math.round(v * 1000) / 1000),
      yaw: Math.round(yaw * 1e4) / 1e4,
      rmsDeg: Math.round(Math.sqrt(sumDeg2 / final.n) * 100) / 100,
      nInliers: final.n,
      missing: final.missing,
      ids: [...final.assigned.keys()],
      margin: second ? Math.round((final.quality - second.quality) * 100) / 100 : null,
    };
  }

  // --- alignment correction: one object at a time, with a prior ---
  //
  // The from-scratch matcher above needs three correspondences in one frame and
  // measured 1.4% of tagless frames on the first real walks. That is the wrong
  // question for this page. ARCore carries a pose continuously; what goes stale
  // between tag sightings is the **session-to-room alignment**, and that
  // alignment was established from tags earlier in the same session. Correcting
  // something already nearly right is a different problem from finding it cold.
  //
  // One bearing is two constraints on a four-unknown correction (yaw and a
  // translation), so a single object is useful — and frames with at least one
  // mappable object are 28.4% of tagless frames, not 1.4%. The correspondences
  // are accumulated across frames in the **session** frame, where ARCore's own
  // relative motion is exact, and one (yaw, t) is fitted to all of them.
  //
  // The honest limit, stated because it is exactly what killed landmarks: this
  // needs the prior. When ARCore has slipped there is no prior, association
  // becomes a guess, and this cannot help. The from-scratch matcher is the only
  // thing that could, and on the measured evidence it does not.
  const alignWindows = new Map();

  function trackAlignment({
    clientId, sid, at, xr, align, dets, K, camW, camH, frameW, frameH,
  } = {}) {
    if (!xr?.p || !xr?.q || !align || !dets?.length || !K?.fx) return null;
    const key = `${clientId}:${sid}`;
    let win = alignWindows.get(key);
    if (!win) { win = []; alignWindows.set(key, win); }
    // A session's alignment is its own; nothing carries across one.
    for (const k of alignWindows.keys()) if (k !== key && k.startsWith(`${clientId}:`)) alignWindows.delete(k);

    const usable = live().filter((e) => e.promoted && e.p
      && e.priorFrac <= O.priorFracMax);
    if (!usable.length) return null;

    // Where the prior says the camera is, and which way each detection points.
    const camRoom = addv(yawRotate(align.yaw, xr.p), align.t);
    const tolCos = Math.cos(O.alignAssocDeg * Math.PI / 180);
    for (const det of dets) {
      if (!allows(det.cls)) continue;
      const detKey = normClass(det.cls);
      const axes = det.clip === undefined
        ? { h: !!det.clipped, v: false }
        : worldClipAxes(det.clip, quatMulLocal(yawQuat(align.yaw), xr.q));
      if (axes.h) continue;
      // Session frame: the frame ARCore's motion is exact in, and the frame the
      // unknown transform maps *out* of.
      const bSess = unit(quatRotate(xr.q, bearing(det, K, camW, frameW, frameH, camH)));
      const dRoom = yawRotate(align.yaw, bSess);
      let best = null;
      let bestCos = tolCos;
      for (const e of usable) {
        if (!answersTo(e, detKey)) continue;
        const rel = sub(e.p, camRoom);
        const n = norm(rel);
        if (n < 1e-3) continue;
        const c = dot(dRoom, unit(rel));
        if (c > bestCos) { bestCos = c; best = e; }
      }
      // No association means no evidence. Deliberately not "nearest anyway":
      // the prior is what makes this safe, and a match it does not support is
      // the wrong-instance failure arriving through the front door.
      if (!best) continue;
      win.push({ camSess: xr.p, bSess, id: best.id, at, planar: axes.v });
    }
    while (win.length && (at - win[0].at > O.alignWindowMs || win.length > O.alignWindowMax)) win.shift();
    // Two correspondences determine the four unknowns exactly, so three is the
    // first count that also checks itself.
    if (win.length < O.alignMinObs) return null;
    // Spread matters more than count: ten bearings from one spot are one
    // measurement taken ten times, which is the same thing `minViews` guards
    // against in the walls grid.
    const cells = new Set(win.map((c) => cellKey(c.camSess)));
    if (cells.size < O.alignMinCells) return null;

    // Fit one (yaw, t) to the whole window, seeded at the prior. Same
    // alternation as localize's refinement: with yaw fixed the translation is a
    // linear ray intersection, with the translation fixed the yaw is a circular
    // mean.
    let yaw = align.yaw;
    let t = [...align.t];
    for (let it = 0; it < 6; it++) {
      const rays = [];
      for (const c of win) {
        const e = entries.get(c.id);
        if (!e?.p) continue;
        // Solving for the translation: the object minus the rotated camera
        // offset must lie along the rotated bearing.
        const o = sub(e.p, yawRotate(yaw, c.camSess));
        rays.push({ o, dir: yawRotate(yaw, c.bSess), w: 1, resid: 0 });
      }
      if (rays.length < 2) return null;
      // The rays here are "t lies on this line" constraints, which is the same
      // normal-equation shape triangulate already builds.
      const sol = triangulate(rays.map((r) => ({ ...r, o: r.o })), null);
      if (sol) t = sol.p;
      let sx = 0;
      let sy = 0;
      for (const c of win) {
        const e = entries.get(c.id);
        if (!e?.p) continue;
        const camR = addv(yawRotate(yaw, c.camSess), t);
        const want = Math.atan2(e.p[0] - camR[0], e.p[2] - camR[2]);
        const have = Math.atan2(c.bSess[0], c.bSess[2]);
        sx += Math.cos(want - have);
        sy += Math.sin(want - have);
      }
      if (sx || sy) yaw = Math.atan2(sy, sx);
    }

    // Score it, and drop what the fit does not explain — a wrong association
    // that survived the prior shows up here as a bearing nothing can satisfy.
    let sum2 = 0;
    let n = 0;
    for (let i = win.length - 1; i >= 0; i--) {
      const c = win[i];
      const e = entries.get(c.id);
      if (!e?.p) { win.splice(i, 1); continue; }
      const camR = addv(yawRotate(yaw, c.camSess), t);
      const d = yawRotate(yaw, c.bSess);
      const cs = Math.max(-1, Math.min(1, dot(d, unit(sub(e.p, camR)))));
      const deg = Math.acos(cs) * 180 / Math.PI;
      if (deg > O.alignRejectDeg) { win.splice(i, 1); continue; }
      sum2 += deg * deg;
      n++;
    }
    if (n < O.alignMinObs) return null;
    const rmsDeg = Math.sqrt(sum2 / n);
    if (rmsDeg > O.alignMaxRmsDeg) return null;

    let dy = (yaw - align.yaw) % (Math.PI * 2);
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    return {
      yaw, t: t.map((v) => Math.round(v * 1000) / 1000),
      n, cells: cells.size,
      rmsDeg: Math.round(rmsDeg * 100) / 100,
      dYawDeg: Math.round(dy * 180 / Math.PI * 100) / 100,
      dPosM: Math.round(norm(sub(t, align.t)) * 1000) / 1000,
      ids: [...new Set(win.map((c) => c.id))],
    };
  }

  // --- the slip veto ---
  //
  // One claim, one direction: **objects may say a carried alignment is wrong.
  // They may never say it is right.**
  //
  // `survey.js`'s slip detector is blind during a tagless run by construction —
  // `updateSlip` returns the standing verdict the instant a frame carries no
  // tag, because it is fed only by tag-solved fixes. So during an excursion
  // away from the tags there is no independent evidence of any kind, and
  // ARCore's measured 5 m/s VIO runaway (which never reports itself as "lost")
  // stays invisible until a tag comes back and the room jumps.
  //
  // That gap is the one thing this map has the supply for. Producing a *pose*
  // needs three correspondences and 0.0% of frames more than ten seconds into a
  // tagless run carry three. Saying "the room is not where you claim to be, by
  // metres" needs one or two and a tolerance the size of a sofa — and 42.6% of
  // those same frames carry at least one mapped object, 9.5% carry two.
  //
  // So this is not the corrector with a different threshold. The corrector
  // measured eight times worse than carrying at the median and dangerously
  // wrong one frame in ten, because it is competing with a good inertial
  // tracker (19 mm of median drift). A contradiction competes with nothing: it
  // only ever fires where carrying has already failed.
  //
  // It returns a *measurement* on every frame it can take one on, and a verdict
  // that is only ever true or absent. It produces no position, and its only
  // sanctioned consumer is a state the survey already has.
  const vetoWindows = new Map();

  function checkVeto({
    clientId, sid, at, xr, align, dets, K, camW, camH, frameW, frameH,
  } = {}) {
    if (!xr?.p || !xr?.q || !align || !K?.fx) return null;
    const key = `${clientId}:${sid}`;
    let st = vetoWindows.get(key);
    // Residuals are measured against one specific alignment. A refreshed
    // alignment — which is what a tag coming back into view produces — makes
    // every one of them a statement about a transform that is no longer being
    // carried, so the window starts again rather than averaging the two.
    const same = st && st.yaw === align.yaw
      && st.t[0] === align.t[0] && st.t[1] === align.t[1] && st.t[2] === align.t[2];
    if (!same) {
      st = { win: [], yaw: align.yaw, t: [...align.t] };
      vetoWindows.set(key, st);
    }
    // A session's alignment is its own; nothing carries across one.
    for (const k of vetoWindows.keys()) if (k !== key && k.startsWith(`${clientId}:`)) vetoWindows.delete(k);
    const win = st.win;

    // Promoted objects only, and only ones that are not standing on depth. A
    // candidate is a position the map has not committed to, and vetoing a good
    // alignment on one would be throwing away the better evidence.
    const usable = live().filter((e) => e.promoted && e.p
      && e.priorFrac <= O.priorFracMax);

    const camRoom = addv(yawRotate(align.yaw, xr.p), align.t);
    const camQRoom = quatMulLocal(yawQuat(align.yaw), xr.q);
    const cell = cellKey(xr.p);
    const assocCos = Math.cos(O.vetoAssocDeg * Math.PI / 180);
    const out = {
      // The correspondences taken *this frame*, and how far each missed. The
      // window's own statistics double-count, so this is the only honest input
      // to the question everything else here rests on: what disagreement does a
      // carry that is known to be fine actually produce.
      fresh: [],
      n: 0, orphans: 0, bad: 0, cells: 0, objects: 0,
      medDeg: null, worstDeg: null, dirSpreadDeg: null, veto: false, why: 'noEvidence',
    };
    if (!usable.length || !dets?.length) return out;

    for (const det of dets) {
      if (!allows(det.cls)) continue;
      const detKey = normClass(det.cls);
      const axes = det.clip === undefined
        ? { h: !!det.clipped, v: false }
        : worldClipAxes(det.clip, camQRoom);
      // A world-horizontally clipped box has an azimuth pulled inward by an
      // unknown amount, which is a bias and is exactly what this measures.
      if (axes.h) continue;
      const bSess = unit(quatRotate(xr.q, bearing(det, K, camW, frameW, frameH, camH)));
      const dRoom = yawRotate(align.yaw, bSess);
      let best = null;
      let bestCos = -2;
      let secondCos = -2;
      for (const e of usable) {
        if (!answersTo(e, detKey)) continue;
        const rel = sub(e.p, camRoom);
        const n = norm(rel);
        if (n < 1e-3) continue;
        const c = dot(dRoom, unit(rel));
        if (c > bestCos) { secondCos = bestCos; bestCos = c; best = e; }
        else if (c > secondCos) secondCos = c;
      }
      // Nothing of this class within the capture radius. Not evidence either
      // way: it is equally a mislabel, an unmapped instance, or a slip so gross
      // that every bearing has left the band. Counted, because that last case
      // is the one this design cannot see and the count is how the replay says
      // how often it happens.
      if (!best || bestCos < assocCos) { out.orphans++; continue; }
      // A materially close same-class runner-up means the correspondence is a
      // guess between two instances, and a guess is what a false veto is made
      // of. Refuse rather than pick.
      const bestDeg = Math.acos(Math.max(-1, Math.min(1, bestCos))) * 180 / Math.PI;
      if (secondCos > -2) {
        const secondDeg = Math.acos(Math.max(-1, Math.min(1, secondCos))) * 180 / Math.PI;
        if (secondDeg - bestDeg < O.vetoMarginDeg) continue;
      }
      // Signed azimuth error, in plan view: which way round the prediction sits
      // from the bearing. The magnitude decides whether this correspondence
      // disagrees; the sign is what makes a set of them one statement about the
      // frame rather than several about boxes.
      const rel = sub(best.p, camRoom);
      let dAz = Math.atan2(rel[0], rel[2]) - Math.atan2(dRoom[0], dRoom[2]);
      while (dAz > Math.PI) dAz -= Math.PI * 2;
      while (dAz < -Math.PI) dAz += Math.PI * 2;
      win.push({ at, cell, id: best.id, deg: bestDeg, az: dAz });
      out.fresh.push({ id: best.id, deg: bestDeg, rangeM: norm(rel) });
    }
    while (win.length && (at - win[0].at > O.vetoWindowMs || win.length > O.vetoWindowMax)) win.shift();

    out.n = win.length;
    if (!win.length) return out;
    const degs = win.map((c) => c.deg).sort((a, b) => a - b);
    out.medDeg = Math.round(degs[degs.length >> 1] * 100) / 100;
    out.worstDeg = Math.round(degs[degs.length - 1] * 100) / 100;

    // The quorum, over the disagreeing correspondences only.
    const badSet = win.filter((c) => c.deg > O.vetoDeg);
    out.bad = badSet.length;
    out.cells = new Set(badSet.map((c) => c.cell)).size;
    out.objects = new Set(badSet.map((c) => c.id)).size;
    if (badSet.length) {
      let sx = 0;
      let sy = 0;
      for (const c of badSet) { sx += Math.cos(c.az); sy += Math.sin(c.az); }
      const r = Math.hypot(sx, sy) / badSet.length;
      // Circular standard deviation. r near 1 is one consistent turn; r near 0
      // is a set of unrelated boxes disagreeing in unrelated directions.
      const sd = r > 1e-6 ? Math.sqrt(-2 * Math.log(Math.min(1, r))) * 180 / Math.PI : 180;
      out.dirSpreadDeg = Math.round(Math.min(180, sd) * 100) / 100;
    }

    if (out.bad < O.vetoMinObs) out.why = 'quorum';
    else if (out.cells < O.vetoMinCells) out.why = 'cells';
    else if (out.objects < O.vetoMinObjects) out.why = 'objects';
    else if (out.dirSpreadDeg > O.vetoDirSpreadDeg) out.why = 'direction';
    else { out.why = 'veto'; out.veto = true; }
    return out;
  }

  function resetAlignment(clientId) {
    for (const k of [...alignWindows.keys()]) {
      if (!clientId || k.startsWith(`${clientId}:`)) alignWindows.delete(k);
    }
    // Both are per-session state about one carried alignment; a caller that
    // resets one and not the other would leave residuals measured against a
    // transform nothing carries any more.
    for (const k of [...vetoWindows.keys()]) {
      if (!clientId || k.startsWith(`${clientId}:`)) vetoWindows.delete(k);
    }
  }

  return {
    load, reset, observe, localize, poseFromShape, trackAlignment, checkVeto,
    resetAlignment, getObjects, debugEntries, getStats, save,
    setVocabulary, allows, mergeEntries,
    opts: O,
    get vocab() { return vocab; },
    get size() { return entries.size; },
    entries: () => entries,
  };
}

module.exports = {
  createObjects, DEFAULTS,
  COCO_CLASSES, O365_CLASSES, O365_DROPPED, VOCABULARIES, ASSOC_REASONS, SHAPE_WHY, normClass,
  triangulate, arcDeg, rayDistance, rayResidual, worldClipAxes, yawQuat, addv, robustSeed, pairPoint, symEigenvalues,
  tagBoxes, explainedByTag, shapeFor, sampleRays, resolveNormal, angleDeg, boxOverlap,
  solve3, unit, sub, dot, norm,
};
