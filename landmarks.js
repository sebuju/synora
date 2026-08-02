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
// page so that what is measured there is what runs here. Nothing on this side
// needs OpenCV: the solve is a RANSAC around pose-math.js's solvePose, the same
// refiner the survey's joint multi-tag PnP runs on, so the server keeps exactly
// one PnP implementation and no 10 MB wasm dependency.

const {
  undistort, reproject, qualifyTrack, clusterAnchors, solveLandmarkPose,
  azimuthOf, dist3, MIN_OBS, MAX_RMS_PX, MIN_ARC_DEG,
} = require('./public/landmark-math.js');

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
// genuinely fixed features produced 2 anchors. Thinning keeps the whole arc at
// half the density, which is what the test actually reads.
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
//
// It is applied twice: to the anchors that matched, and again to the ones that
// survive the solver's outlier rejection. Matching 16 and agreeing with 11 is
// eleven anchors' worth of support however it is counted, and 11 is inside the
// range the measurement above has nothing to say about.
const MIN_ANCHORS_FOR_FIX = 15;

// Re-association: how close an anchor's projection has to land to a tracked
// point before that point is taken to *be* it, and how much closer than the
// runner-up. An anchor is a 3D point and the pose is known to a few centimetres,
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
// Aliases outlive the tracks that made them, harmlessly but not for free. Track
// ids climb monotonically within a generation, so the stale ones are simply the
// low ones.
const ALIAS_CAP = 4000;

// Anchors are individually meaningless — a corner of something, no identity, no
// extent — and a list of 133 of them says nothing a person can act on. Grouped
// by proximity they become the thing that was actually surveyed: the region of
// the room whose features are being tracked. That is what the drawer shows
// beside the tags, and the comparison is the point — a tag is one printed
// square whose pose is known to millimetres, a group is a cloud of corners on
// whatever furniture happens to be there.
//
// Membership is decided once, when an anchor qualifies, against the groups that
// exist at that moment. Re-clustering the whole set on every push would be
// tidier and would renumber the cards under the reader's hand every second.
//
// The radius is chosen on the *card* count, not the region count — singletons
// collapse into one note, so those are already free. Measured on two recorded
// walks (124 and 65 anchors):
//
//   radius   cards        group sizes
//   0.35 m   11 / 10      42/27/19/18/12/9/8/6/3/3/2  ·  19/13/7/6/5/4/4/3/2/2
//   0.60 m    7 /  5      64/46/15/13/6/3/3           ·  23/19/15/6/4      <-
//   0.90 m    3 /  4      105/27/18                   ·  25/23/15/4
//   1.60 m    2 /  2      132/18                      ·  38/29
//
// 0.35 m produced a drawer of eleven cards nobody reads. Past 0.6 m the greedy
// centroid growth starts chaining — at 0.9 m one group holds 105 of 124 anchors,
// i.e. most of the room in a single card, which is the failure mode that matters
// here: a region is supposed to name a *place*, and one that spans the room
// names nothing. 0.6 m halves the cards and keeps the largest group under half
// the map.
const GROUP_M = 0.6;

// Anchor staleness. Nothing revalidated a qualified anchor: if the thing it was
// a corner of is moved — a chair, a door, a laptop lid — the anchor keeps
// asserting a point the room no longer contains, and the only symptom is a fix
// that is quietly a few centimetres wrong. The survey has `RESEED_DISAGREE_M`
// for exactly this on tags, and the argument carries over unchanged.
//
// The evidence is a reprojection residual taken on a frame where the *tags*
// supplied the pose, so it is independent of the anchors themselves — the same
// reason the survey refines a tag from a leave-one-out fix rather than from the
// fix the tag helped make. A residual measured against a landmark-derived pose
// would be the anchor grading its own homework.
//
// Streak, not a single frame, and the same shape the survey uses: one bad
// sighting is an optical-flow track sliding, a run of them is the feature not
// being where the map says. A dropped anchor is not lost work — its track is
// still live, so it starts accumulating observations again on the very next
// report and re-qualifies from where the feature actually is.
//
// The alias goes with it. On a persistent disagreement one of two things is
// wrong — the anchor moved, or this track is not looking at it — and nothing
// available here can say which, so neither is kept.
// The threshold is where it is because it was swept, and the first setting
// tried was wrong in the direction that matters. Residual distributions differ
// by session far more than expected — one recorded walk sits at 32/32/23/8/2/2%
// across 0-2/2-4/4-8/8-16/16-32/>32 px, another at 7/22/47/21/2/0% — so a gate
// inside the second session's bulk drops honest anchors. At 12 px it dropped 17
// of 133 there and made the holdout *worse* (worst-case position 316 -> 491 mm),
// which is the whole failure this feature could have introduced.
//
// Swept on that session (anchors / holdout / median / worst):
//
//   off      133  219/264  39 mm  316 mm
//   12 px    123  217/264  43 mm  491 mm   <- drops honest anchors
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
// the dropped anchor re-qualifies at its new position on the next pass, and
// false drops stay at zero up to 8x the observation noise (2.4 px), so this is
// not living off the noise floor.
const STALE_PX = 20;
const STALE_STREAK = 5;

// Which reports may found an anchor. Here rather than in server.js because the
// replay tool has to ask the *same* function: it did not, and the divergence
// cost three sessions. The tool tested `quality === 'good' && mapSafe && pose`
// while the server also demanded a fresh jitter figure, so the replay reported a
// working feature — 133, 63 and 46 anchors on three walks — while the live
// server built zero on every one of them.
//
// Anchors are only worth founding on a pose the survey itself would stand behind
// — the same statement walls.js makes before carving, and for the same reason: a
// wrong anchor is as durable as the session and nothing downstream can tell it
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

// Guidance: which feature the person holding the phone should work on next, and
// what to do about it.
//
// This exists because the honest state of the feature is unreadable from its
// own outputs. Anchors accumulate only from *orbiting* motion, normal walking
// reaches 3-9 deg of arc against the gate, and the two failures — "nothing
// worth looking at here" and "you are walking past everything" — look identical
// from an empty anchor cloud. A count cannot say either; a direction can.
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
// Asked for slightly more than the arithmetic says. The interval is measured
// about the *estimated* point, which is a few centimetres off the real one and
// only re-measured every few sightings, so an instruction for exactly the
// missing degrees lands just short — measured on a synthetic walk, following a
// 40 deg instruction to the letter took the span from 20 to 56 of the 60
// needed, and the guide then had to ask for 5 deg more. Overshooting once beats
// a second instruction that reads like the first one failed.
const GUIDE_OVERSHOOT_DEG = 8;

const norm180 = (d) => {
  let a = (d + 180) % 360;
  if (a < 0) a += 360;
  return a - 180;
};

function createLandmarks({ log = () => {}, opts = {} } = {}) {
  // Tunable so replay can sweep them against a recorded session rather than
  // having them argued: the trade is coverage against the chance of adopting
  // the wrong feature, and only a real room can say where it sits.
  const reassocPx = opts.reassocPx ?? REASSOC_PX;
  const reassocMargin = opts.reassocMargin ?? REASSOC_MARGIN;
  const stalePx = opts.stalePx ?? STALE_PX;
  const staleStreak = opts.staleStreak ?? STALE_STREAK;
  const groupM = opts.groupM ?? GROUP_M;
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
  //   tracks:  Map(trackId  -> { obs, est }),  candidates, not yet anchors.
  //            `est` is the last qualification attempt's point and arc, kept
  //            only so the maps can show what is being worked on — see
  //            `candidates`. Nothing in the solve reads it.
  //   anchors: Map(anchorId -> {P,n,span,err}),
  //   alias:   Map(trackId  -> anchorId),  which track is currently looking at it
  // }
  //
  // The anchor id is deliberately *not* the track id it was born from. An
  // optical-flow track is a few seconds of correspondence and nothing more —
  // measured, the set turns over almost completely across a fast pan — so
  // addressing a landmark by the track that discovered it makes the whole map
  // unusable within seconds of collecting it, which is exactly what happened:
  // 133 good anchors and a solve that could match fewer than 15 of them.
  //
  // The anchor is a fixed 3D point, so it can be found again: project it through
  // the current pose and see which freshly seeded corner is sitting on it. That
  // is what `reassociate` does, and it turns the map from "usable while its
  // tracks live" into "usable while it is being looked at".
  const clients = new Map();
  // `bestSpan` is the single most useful number here and the reason the others
  // are not enough. Anchors need orbiting motion — a walk *past* something gives
  // a narrow effective baseline however long it is looked at — and when nothing
  // qualifies, "no anchors" is indistinguishable from "broken" without knowing
  // how wide an arc the room has actually been seen through. Measured on real
  // recorded sessions: median per-feature arc 3.5-8.9 deg against the gate,
  // i.e. normal walking never gets close, and that is the behaviour to surface
  // rather than a bug to hunt.
  const stats = {
    observed: 0, qualified: 0, solved: 0, refused: 0, reassociated: 0, rej: {},
    // Anchors dropped for disagreeing with the tags, and the distribution of the
    // residual that decides it. The histogram is the tuning surface: the gate is
    // only honest if the bulk of a healthy session sits well below it, and
    // that is not something to assume — an anchor's own qualification RMS runs
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
        gen, tracks: new Map(), anchors: new Map(), alias: new Map(),
        groups: new Map(), bestSpan: 0, nextAnchor: 1, nextGroup: 1,
      };
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
      s.alias.clear();
      s.groups.clear();
      s.lastPose = null;
      s.bestSpan = 0;
      s.guide = null;
    }
    return s;
  }

  function modelOf(intr) {
    if (!intr || !(intr.fx > 0) || !(intr.fy > 0)) return null;
    return {
      fx: intr.fx, fy: intr.fy, cx: intr.cx, cy: intr.cy, dist: intr.dist ?? null,
    };
  }

  // Which region of the room this anchor belongs to — the nearest existing
  // group centroid within GROUP_M, or a new group. The centroid is a running
  // mean, so a group settles onto the middle of whatever it is sitting on as it
  // gains members.
  function groupFor(s, j) {
    let best = null;
    let bestD = groupM;
    for (const [id, g] of s.groups) {
      const d = dist3(g.p, j.P);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best === null) {
      best = s.nextGroup++;
      s.groups.set(best, { sum: [...j.P], n: 1, p: [...j.P], span: j.span });
      return best;
    }
    const g = s.groups.get(best);
    for (let k = 0; k < 3; k++) {
      g.sum[k] += j.P[k];
      g.p[k] = g.sum[k] / (g.n + 1);
    }
    g.n++;
    // The widest arc any one member was seen through: how well this region has
    // actually been looked at, which is what decides whether it grows.
    if (j.span > g.span) g.span = j.span;
    return best;
  }

  // Take an anchor back out of the map, with everything that referred to it.
  // The group keeps a running mean, so the member has to be subtracted from it
  // rather than merely uncounted, or the region drifts towards a point that is
  // no longer claimed to exist.
  function dropAnchor(s, anchorId) {
    const a = s.anchors.get(anchorId);
    if (!a) return;
    s.anchors.delete(anchorId);
    for (const [trackId, id] of s.alias) if (id === anchorId) s.alias.delete(trackId);
    const g = s.groups.get(a.group);
    if (g) {
      g.n--;
      if (g.n <= 0) {
        s.groups.delete(a.group);
      } else {
        for (let k = 0; k < 3; k++) {
          g.sum[k] -= a.P[k];
          g.p[k] = g.sum[k] / g.n;
        }
      }
    }
    stats.dropped++;
    // Rare enough to say out loud every time, and worth saying: the map lost a
    // point it had qualified, which on a session where nothing was touched
    // means the re-association is putting tracks on the wrong anchors.
    log(`Landmarks: anchor ${anchorId} disagreed with the tags for `
      + `${staleStreak} sightings — dropped (${s.anchors.size} left)`);
  }

  // Does the anchor still explain what the track is looking at? Called only
  // under a tag-derived pose — see the note on STALE_PX.
  function checkAnchor(s, anchorId, p, pose, K) {
    const a = s.anchors.get(anchorId);
    if (!a) return;
    const q = reproject(a.P, { K, pose });
    // Behind the camera: the anchor is not being looked at, whatever the track
    // is doing. That is an absence of evidence, not evidence against it.
    if (!q) return;
    const d = Math.hypot(p.u - q[0], p.v - q[1]);
    stats.checked++;
    let b = 0;
    while (b < RESID_EDGES.length && d > RESID_EDGES[b]) b++;
    stats.resid[b]++;
    if (d <= stalePx) { a.bad = 0; return; }
    a.bad = (a.bad ?? 0) + 1;
    if (a.bad >= staleStreak) dropAnchor(s, anchorId);
  }

  // Hand anchors that no track is currently following to whichever fresh point
  // is sitting on them. `pts` are already undistorted, so this works in the one
  // space everything else here does.
  //
  // Only anchors with no live alias are offered, and only points with no alias
  // are candidates, so nothing is stolen from a track that is still doing its
  // job. The uniqueness margin is the whole safety argument: a wrong adoption
  // does not lose a landmark, it silently moves one.
  function reassociate(s, pts, pose, K) {
    if (!s.anchors.size || !pose) return 0;
    const taken = new Set();
    for (const p of pts) {
      const a = s.alias.get(p.id);
      if (a !== undefined) taken.add(a);
    }
    const free = pts.filter((p) => !s.alias.has(p.id));
    if (!free.length) return 0;

    let added = 0;
    for (const [anchorId, a] of s.anchors) {
      if (taken.has(anchorId)) continue;
      const q = reproject(a.P, { K, pose });
      if (!q) continue;
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
      if (!best || bestD > reassocPx || secondD < bestD * reassocMargin) continue;
      s.alias.set(best.id, anchorId);
      taken.add(anchorId);
      added++;
    }
    if (added) stats.reassociated += added;

    if (s.alias.size > ALIAS_CAP) {
      const ids = [...s.alias.keys()].sort((x, y) => x - y);
      for (const id of ids.slice(0, ids.length - ALIAS_CAP)) s.alias.delete(id);
    }
    return added;
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
        return { id: p.id, u, v };
      });
      // With a tag-derived pose in hand this is the best chance there is to
      // recognise anchors again, so it happens here rather than only when they
      // are needed.
      reassociate(s, pts, camPose, K);

      for (const p of pts) {
        // A track already looking at an anchor does not accumulate a second
        // candidate — but the sighting is not thrown away either: with a
        // tag-derived pose in hand it is the one chance to ask whether the
        // anchor is still where the map says.
        const on = s.alias.get(p.id);
        if (on !== undefined) {
          checkAnchor(s, on, p, camPose, K);
          continue;
        }
        let t = s.tracks.get(p.id);
        if (!t) { t = { obs: [], est: null }; s.tracks.set(p.id, t); }
        const obs = t.obs;
        const { u, v } = p;
        obs.push({ u, v, K, pose: camPose });
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
        // what passes, and the sweep would measure two things at once.
        const minObs = qualifyOpts.minObs ?? MIN_OBS;
        if (obs.length < minObs || (obs.length - minObs) % QUALIFY_EVERY !== 0) continue;
        const j = qualifyTrack(obs, qualifyOpts);
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
        // What this track currently looks like, kept for the candidate view (see
        // `candidates`). Same gate as bestSpan above and for the same reason: a
        // triangulation with no answer puts the point next to the camera, and
        // plotting those would fill the map with a cloud that follows whoever is
        // holding the phone. Cleared when it fails, so a track that stops
        // resolving stops being shown rather than freezing where it last was.
        t.est = j.P && Number.isFinite(j.err) && j.err < MAX_RMS_PX
          ? { P: j.P, span: j.span, az0: j.az0, az1: j.az1, err: j.err }
          : null;
        if (!j.ok) { bump(j.reason); continue; }
        // Promoted: it gets an identity of its own, and the track that found it
        // becomes merely the first thing to be looking at it. The observations
        // are dropped: an anchor is checked by reprojection from then on (see
        // checkAnchor), never re-triangulated, and holding sixty sightings each
        // for hundreds of anchors is memory for nothing.
        const anchorId = s.nextAnchor++;
        s.anchors.set(anchorId, {
          P: j.P, n: j.n, span: j.span, err: j.err, group: groupFor(s, j),
        });
        s.alias.set(p.id, anchorId);
        s.tracks.delete(p.id);
        stats.qualified++;
        added++;
      }
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
    solve(clientId, points, gen, intr, seed = null) {
      if (!points?.length || gen == null) return null;
      const K = modelOf(intr);
      if (!K) return null;
      const s = clients.get(clientId);
      if (!s || s.gen !== gen) return null;
      if (s.anchors.size < MIN_ANCHORS_FOR_FIX) return null;
      const from = seed ?? s.lastPose;
      if (!from) { stats.refused++; return null; }

      // Undistorted here as at observe, so one convention holds across the
      // whole module and the solver is told the camera is ideal.
      const pts = points.map((p) => {
        const [u, v] = undistort(p.u, p.v, K);
        return { id: p.id, u, v };
      });
      // Recognise what can be recognised from the seed *before* solving, which
      // is what makes a long tag-less stretch survivable: without it the
      // matchable set only ever shrinks as tracks die.
      reassociate(s, pts, from, K);

      const objs = [];
      const imgs = [];
      for (const p of pts) {
        const a = s.anchors.get(s.alias.get(p.id));
        if (!a) continue;
        objs.push(a.P);
        imgs.push([p.u, p.v]);
      }
      if (objs.length < MIN_ANCHORS_FOR_FIX) {
        stats.refused++;
        return null;
      }

      const sol = solveLandmarkPose(objs, imgs,
        { fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy }, from,
        { minPoints: MIN_ANCHORS_FOR_FIX });
      if (!sol || !sol.p.every(Number.isFinite)) {
        stats.refused++;
        return null;
      }
      const pose = { p: sol.p, q: sol.q };
      s.lastPose = pose;
      stats.solved++;
      // And again from the answer, which is better than the seed was: the next
      // report starts with more of the map already found.
      reassociate(s, pts, pose, K);
      return { pose, n: sol.n, inliers: sol.inliers, rms: sol.rms };
    },

    // Distinct anchors, not raw tracks: several tracks routinely sit on one
    // physical feature and a raw count overstates what the room actually has.
    count(clientId) {
      const s = clients.get(clientId);
      if (!s) return 0;
      return clusterAnchors([...s.anchors.values()]).length;
    },

    // What a client needs to be told about its own landmark state, for the
    // on-phone overlay. `bestSpan` is the actionable one: anchors need a wide
    // viewing arc, that is the thing the person holding the phone controls, and
    // it is the difference between "walk differently" and "this is broken".
    summary(clientId) {
      const s = clients.get(clientId);
      if (!s) return null;
      return {
        anchors: clusterAnchors([...s.anchors.values()]).length,
        tracks: s.tracks.size,
        arc: Math.round(s.bestSpan),
      };
    },

    // The anchor clouds as regions, for the drawer to show beside the tags.
    // `live` is how many of the group's anchors a track is currently sitting on
    // — the difference between a region the map merely remembers and one it can
    // localize against right now, which is the whole distinction between a
    // landmark and a tag and should be visible as such.
    groups(clientId) {
      const s = clients.get(clientId);
      if (!s) return [];
      // Distinct anchors, not alias entries: a dead track leaves its alias
      // behind, and several tracks can have looked at one anchor over a
      // session, so counting entries reported more live anchors than exist.
      const seen = new Set();
      const live = new Map();
      for (const anchorId of s.alias.values()) {
        if (seen.has(anchorId)) continue;
        seen.add(anchorId);
        const a = s.anchors.get(anchorId);
        if (a) live.set(a.group, (live.get(a.group) ?? 0) + 1);
      }
      return [...s.groups]
        .map(([id, g]) => ({
          id,
          p: g.p.map((v) => Math.round(v * 1000) / 1000),
          n: g.n,
          live: live.get(id) ?? 0,
          span: Math.round(g.span),
        }))
        .sort((a, b) => b.n - a.n);
    },

    // The tracks that are not anchors yet, with the arc each has been seen
    // through so far. This is the answer to "nothing is qualifying, is it
    // broken?" — the one question the anchor cloud cannot answer, because it is
    // empty in both the working case and the broken one.
    //
    // What it shows is where the room's *candidate* features are and how far
    // each has got towards the arc gate, which is the thing the person holding
    // the phone controls: a wall of candidates all stuck at 8° is a walk to
    // change, and no candidates at all is something else entirely. Measured on
    // real sessions, normal walking reaches 3-9° against a 60° gate, so the
    // stuck case is the *usual* one and deserves to be visible.
    //
    // Merged like the anchors are, and sorted widest-arc first so the survivor
    // of each cluster is the best-seen member rather than an arbitrary one.
    candidates(clientId) {
      const s = clients.get(clientId);
      if (!s) return [];
      const est = [];
      for (const t of s.tracks.values()) if (t.est) est.push(t.est);
      est.sort((a, b) => b.span - a.span);
      return clusterAnchors(est).map((c) => ({
        p: c[0].P.map((v) => Math.round(v * 1000) / 1000),
        span: Math.round(c[0].span),
      }));
    },

    // What to tell the person holding the phone to do next, given where they
    // are standing. Null when there is nothing worth saying — which is the
    // right answer far more often than not, and saying nothing is better than
    // sending someone after two corners of a doorframe.
    //
    // Returns { p, n, span, need, dist, mode, radius, from, to } in room
    // coordinates and degrees:
    //   mode 'closer' — too far for the arc to be worth walking; approach first.
    //   mode 'arc'    — walk the ground from `from` to `to` around `p`, which is
    //                   an azimuth sweep at `radius` metres. `to` is past
    //                   whichever end of the covered arc the camera is nearest,
    //                   so the instruction always extends the arc rather than
    //                   re-walking ground already covered.
    guide(clientId, camPose) {
      const s = clients.get(clientId);
      if (!s || !camPose) return null;
      const est = [];
      for (const t of s.tracks.values()) if (t.est) est.push(t.est);
      if (!est.length) return null;
      // Widest arc first, so each cluster's representative is its best-seen
      // member — the one whose progress the gate will actually be decided on,
      // since qualification is per track and not per cluster.
      est.sort((a, b) => b.span - a.span);

      const C = camPose.p;
      let best = null;
      for (const c of clusterAnchors(est, groupM)) {
        if (c.length < GUIDE_MIN_MEMBERS) continue;
        const head = c[0];
        const P = head.P;
        const dist = dist3(C, P);
        if (!(dist < GUIDE_MAX_M)) continue;
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
      const prev = s.guide;
      if (prev) {
        const still = clusterAnchors(est, groupM)
          .map((c) => c[0])
          .find((h) => dist3(h.P, prev.P) < groupM);
        if (still && still !== best.head) {
          const held = dist3(C, still.P);
          if (held < GUIDE_MAX_M && best.score < prev.score * GUIDE_STICKY) {
            best = { score: prev.score, P: still.P, n: prev.n, head: still, dist: held };
          }
        }
      }
      const wasFar = s.guide?.far ?? false;
      const far = best.dist > (wasFar ? GUIDE_NEAR_LEAVE_M : GUIDE_NEAR_M);
      s.guide = { P: best.P, score: best.score, n: best.n, far };

      const { P, head } = best;
      const need = Math.max(0, Math.ceil(MIN_ARC_DEG - head.span));
      // Horizontal radius: the walk happens on the floor, and a feature above
      // head height would otherwise ask for an arc wider than the room.
      const radius = Math.hypot(C[0] - P[0], C[2] - P[2]);
      const out = {
        p: P.map((v) => Math.round(v * 1000) / 1000),
        // Where the camera was when this was worked out. The map draws the
        // instruction from here, and asking it to find "the dot that is me"
        // instead would mean telling the page its own clientId for this one
        // purpose — it has never needed to know it.
        at: C.map((v) => Math.round(v * 1000) / 1000),
        n: best.n,
        span: Math.round(head.span),
        need,
        dist: Math.round(best.dist * 100) / 100,
        radius: Math.round(radius * 100) / 100,
      };
      if (far) return { ...out, mode: 'closer' };
      // Wide enough already and still not an anchor: what it is short of is
      // *observations*, not viewpoints — the split-arc gap has to collapse, and
      // that happens as noise averages down with more sightings of the same
      // arc. Measured on real walks, this is the common case by a wide margin:
      // a track that survives the twelve sightings it takes to be judged at all
      // has usually swept 70-85 deg getting there, so "walk around it" would be
      // an instruction to do what has already been done.
      if (!need) return { ...out, mode: 'dwell' };

      // Which end of the covered arc the camera is standing at. Extending the
      // near end is the only instruction that adds arc; setting off from the far
      // end re-walks ground the track already has.
      const azNow = azimuthOf(P, { pose: camPose });
      const d0 = Math.abs(norm180(azNow - head.az0));
      const d1 = Math.abs(norm180(azNow - head.az1));
      const from = d1 <= d0 ? head.az1 : head.az0;
      const dir = d1 <= d0 ? 1 : -1;
      return {
        ...out,
        mode: 'arc',
        // From where they stand, through the end of what is covered, to where
        // the arc becomes wide enough. Drawn as one sweep because that is the
        // ground they have to cross, covered or not.
        from: Math.round(norm180(azNow) * 10) / 10,
        to: Math.round(norm180(from + dir * (need + GUIDE_OVERSHOOT_DEG)) * 10) / 10,
        dir,
      };
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
          bestSpan: s.bestSpan,
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
  createLandmarks, landmarkGate, MIN_ANCHORS_FOR_FIX, LANDMARK_MAX_JITTER_MM,
  OBS_RING, QUALIFY_EVERY, dist3,
};
