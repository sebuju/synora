'use strict';

// Marker-map survey and client localization, all in the room frame.
//
// The map is built by co-visibility chaining: the first well-observed tag
// becomes the room origin; whenever a localized frame also sees an unknown
// tag, that sighting is an estimate of the unknown tag's room pose, and
// enough consistent estimates promote it into the map. No bundle adjustment —
// chained error stays comfortably inside the 30 cm target at room scale, and
// the slow refinement below keeps well-observed tags from drifting apart.

const fs = require('fs');
const path = require('path');
const {
  quatAngleDeg, quatMean, quatMedian, quatNudge, se3FromRvecTvec, se3Compose, se3Invert,
  se3Identity, quatFromRvec, quatRotate, quatMul, quatConj, transformPoint,
  quatNormalize, quatFromTo, tagPlaneAgreement, CLIP_PLANE_M, CLIP_PARALLEL_COS,
  solvePose,
} = require('./public/pose-math.js');
const { markerCornersM } = require('./public/cv-common.js');

// Observation gates. err is mean corner reprojection error in px — the best
// single-number proxy for a bad detection (blur, oblique view, tiny tag).
const OBS_MAX_ERR_PX = 3;
const OBS_MAX_DIST_M = 10;
// Apparent tag size in pixels — the gate none of the others can stand in for.
// Corner noise is roughly constant in pixels, so the angular error a small quad
// implies is large however clean its reprojection residual looks; distance and
// viewing angle do not see it either, because a small tag can be close and
// head-on and still be small (a 640 px camera-access frame at 3 m). Measured:
// marker 4 was surveyed entirely from 25-30 px sightings whose reprojection
// error sat at 0.3 px, and then put metres of error into every fix it joined.
// Such a tag may still contribute to a live fix, where distance weighting keeps
// it in its place — but it must not seed the map, contribute a promotion
// estimate, or be the reference another tag is refined against. Anything that
// outlives the frame needs a tag that was actually resolved.
const SURVEY_MIN_PX = 40;
const ANCHOR_MAX_ERR_PX = 2;     // the origin deserves a clean look
const ANCHOR_MAX_DIST_M = 4;
const GOOD_MAX_ERR_PX = 2;       // gates for quality:'good'
const GOOD_MAX_DIST_M = 6;

// Candidate promotion: enough estimates, agreeing with their own median.
const CANDIDATE_RING = 50;
const PROMOTE_MIN_ESTIMATES = 8;
const OUTLIER_POS_M = 0.25;
const OUTLIER_ANGLE_DEG = 15;
// ...and enough of them, as a share of what was offered. A count alone cannot
// tell eight good looks from forty bad ones of which eight happened to cluster:
// a noise cloud always has a densest 25 cm somewhere and the median gate finds
// it. Marker 4 was promoted twice on 8/40 and 8/37 — 20% agreement — and every
// fix it then took part in inherited its error.
const PROMOTE_MIN_INLIER_FRAC = 0.6;

// Refinement: slow running average for known tags re-observed from a camera
// pose derived from *other* tags (excluding the tag itself keeps the update
// from feeding back into its own estimate).
const REFINE_ALPHA = 0.02;
// How fast the "still wants to move" readout follows. Slower than the pose it
// describes, so the dashboard shows a trend rather than per-sighting noise.
const RESID_ALPHA = 0.05;
// A refinement is a map change, but this path runs at 10 Hz per client and each
// notification ships the whole map, so the viewer is told on a throttle.
const REFINE_PUSH_MS = 500;
// A knocked tag is not noise, and the slow average is the wrong tool for it:
// correcting 40 cm at REFINE_ALPHA takes ~200 sightings, and for all of them
// the tag is wrong and dragging its neighbours through the shared camera fix
// (measured: 4 cm of pull on an adjacent tag). Past this much disagreement,
// held for this many consecutive sightings, the tag is not drifting — it moved.
// Drop it back to a candidate and let it re-promote from scratch, which takes
// PROMOTE_MIN_ESTIMATES sightings instead.
const RESEED_DISAGREE_M = 0.25;
const RESEED_STREAK = 12;
// The orientation and position noise a sighting at 1 m carries, growing with
// distance. Measured with replay-tagbias.js, which reads the raw rvec/tvec and
// never touches the map: a tag's own solved orientation scatters 2.4 deg under
// 1.5 m and 6.1 deg at 4-6 m, i.e. error going as roughly d^0.9, taken as
// linear. The position figure is the same shape at the scale the map's own
// cross-session disagreement shows.
const REFINE_NOISE_DEG_PER_M = 1.3;
const REFINE_NOISE_M_PER_M = 0.02;
// A sighting is slowed, never silenced: below this it would take a permanent
// disagreement to move the tag at all, and a tag nothing can correct is worse
// than one corrected slowly.
const REFINE_MIN_ALPHA_SCALE = 0.1;
// A leave-one-out fix built from a single other tag is not a second opinion:
// the two tags disagree, and nothing in the comparison says which of them is
// wrong. Blaming the tag under test deleted whichever of the pair reached the
// streak first — measured, every spurious drop in a session happened with
// exactly two known tags in view. Below this many references the tag is still
// refined (a small disagreement is still information) but never accused.
const REFINE_MIN_OTHERS = 2;
// The streak counts looks, not frames. At the 10 Hz pose rate twelve
// consecutive reports is 1.2 s of a stationary client — one look, its error
// perfectly correlated across all twelve, which is precisely the case the
// streak is supposed to rule out. And a streak that never expires lets a
// disagreement from ten minutes ago combine with one now.
const RESEED_MIN_GAP_MS = 300;
const RESEED_STREAK_TTL_MS = 5000;
// Consensus weighting in fuseCameraPose. A tag whose implied camera position
// disagrees with the other tags' is either stale, knocked, or a mirror pick;
// distance and reprojection error do not see any of those. Soft, not a reject:
// with three tags the median is a weak statistic, and hard-dropping the odd one
// out would make the fix jump as tags enter and leave view.
const CONSENSUS_SOFT_M = 0.15;
const CONSENSUS_MIN_OBS = 3;

// Single-tag planar pose has a mirror-solution ambiguity; a wrong pick
// teleports the camera to the "opposite side" for a frame or two. A fix that
// jumps implausibly far from a fresh previous fix is held back unless it
// persists — walking moves a client ~0.3 m between poses, never a meter.
const JUMP_REJECT_M = 1.0;
// A tag seen far off its own normal is a badly conditioned planar PnP: the
// corners barely move as the pose rotates, so noise turns into pose error.
// Reprojection error does not catch it — a glancing tag can fit its own
// corners beautifully and still be metres out.
const OBS_MIN_COS_ANGLE = 0.15;   // ~81 deg off-normal, dropped outright
// ...but *within* that range the conditioning runs the other way, and the
// weighting used to have it backwards. A planar tag's two IPPE solutions
// coincide at normal incidence: head-on is the degenerate case, and tilting the
// tag is what separates them. Measured over 1446 paired sightings (a tag is
// fixed in the room, so between two reports its camera-frame pose must change
// by exactly ARCore's own rotation; whatever is left is the tag's own noise, and
// ARCore never consults a tag):
//
//   off-normal    0-40px      40-60px     60-90px    90-1000px
//   0-15 deg    3.80 (230)  2.26 (275)  1.95 (206)  1.04 (114)
//   45-90 deg        - (0)  0.08 (193)  0.47  (32)  0.14  (62)
//
// Same apparent size, 28x the orientation noise head-on at 40-60 px and 7x at
// 90+. Best fit is sigma ~ dist^0.94 * sin(off)^-1.03 (R2 0.46) — near enough
// to dist/sin, and since apparent size is itself fx*markerSize/dist the
// distance term already carries the size effect (fitting both is collinear and
// meaningless). Camera position error is that times the lever arm, dist, so
// inverse variance is sin^2 / dist^4. The old cos^2/dist^2 gave the one tag
// holding still to 0.1 deg 15% of the say and the two swinging 3-5 deg the
// other 85%.
//
// The floor keeps a lone head-on tag from being weighted to nothing — with one
// observation the weights normalize away, and this is a relative measure.
// Nothing above says anything about past 70 deg off-normal: there were no
// sightings out there, so OBS_MIN_COS_ANGLE stays where it is.
const SIN2_FLOOR = 0.02;
// Fused pose smoothing. The fix is recomputed from scratch every frame, so
// what the dashboard shows is the per-frame noise, not motion. Blending
// against a constant-velocity prediction removes that without adding lag: the
// gain rises with how far the measurement lands from the prediction, so
// standing still smooths hard and walking follows immediately.
// The gain compares the innovation against how noisy this client's fixes have
// actually been lately, rather than against a fixed metre figure: a 4K client
// two metres from three tags and a 720p one across the room do not share a
// noise scale, and a constant tuned for either is wrong for the other. At rest
// the innovation is pure noise and the gain sits near 1/(1+K); real motion
// leaves the noise band immediately and the gain goes to 1.
const POSE_GAIN_K = 4;
const POSE_MIN_GAIN = 0.08;
const POSE_MIN_DT_S = 0.02;       // two fixes in the same millisecond happen
const POSE_MAX_DT_MS = 1000;      // older than this, restart rather than blend
// How long a pose may be carried on velocity alone once the tags go away.
const POSE_EXTRAPOLATE_MS = 1200;
const JUMP_HISTORY_TTL_MS = 1500;
const JUMP_CONFIRM_SAMPLES = 3;

const SAVE_DEBOUNCE_MS = 10000;
const MAP_VERSION = 1;

// Every room-frame position that reaches a log or a file goes through this.
// Two decimals is a centimetre, which is the resolution any of this is good to;
// more digits read as precision the fix does not have.
function fmtP(p) {
  return p ? `[${p.map((v) => v.toFixed(2)).join(', ')}]` : '[none]';
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Smallest eigenvalue of a symmetric 3x3 matrix given as [xx,xy,xz,yy,yz,zz]
// (the trigonometric closed form for symmetric 3x3). Used on the covariance of
// pooled tag corners: its square root is the RMS spread along the flattest
// axis, i.e. how far the point set is from being one plane.
function minEig3([a, b, c, d, e, f]) {
  const p1 = b * b + c * c + e * e;
  const q = (a + d + f) / 3;
  const p2 = (a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * p1;
  if (p2 < 1e-30) return q;
  const p = Math.sqrt(p2 / 6);
  const B = [(a - q) / p, b / p, c / p, (d - q) / p, e / p, (f - q) / p];
  const det = B[0] * (B[3] * B[5] - B[4] * B[4])
    - B[1] * (B[1] * B[5] - B[4] * B[2])
    + B[2] * (B[1] * B[4] - B[3] * B[2]);
  const phi = Math.acos(Math.min(1, Math.max(-1, det / 2))) / 3;
  return q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
}


// opts overrides the tuning constants a replay needs to sweep; everything else
// is fixed. Same contract as createWalls — a gate is tuned by measuring it over
// recorded journals, so it has to be settable from outside without editing the
// module the replay is supposed to be exercising.
// `onRefine` is an offline diagnostics tap, not a feature: refinement is the
// one map-changing path that leaves no trace anywhere — the journal records a
// single throttled `mapChanged` boolean and markers.json only ever holds the
// result — so nothing could say how far a tag's stored orientation actually
// travels in a session, or what the stream it is being averaged from looks
// like. Null on the live server, wired up by replay-survey.js.
function createSurvey({ file, markerSizeM, log, onRefine = null, opts = {} }) {
  let anchorId = null;
  const markers = new Map();      // id -> { pose: {p,q}, nObs }
  const candidates = new Map();   // id -> [{p,q}, ...] ring
  const lastFix = new Map();      // clientId -> { pose, at, rejectStreak }
  // clientId -> { p, q, v: [m/s], at } — the smoothed pose track. Separate
  // from lastFix, which is the raw fix the ambiguity gate compares against;
  // mixing the two would let the filter's own output veto new measurements.
  const track = new Map();
  // "clientId|id" -> { n, at }: consecutive *looks* that disagreed with the
  // stored pose. Keyed by client as well as tag because two clients standing in
  // different places disagree for different reasons, and pooling their counts
  // reaches the threshold without either of them having seen the tag move.
  const reseedStreak = new Map();
  // clientId -> recent { at, xr, room, ok } for the jitter measurement.
  const jitterHist = new Map();
  // clientId -> the last radius measured from a window that actually contained
  // a confirming sighting, held across stretches that contain none.
  const lastRadiusMm = new Map();
  let lastJitterLog = 0;
  let saveTimer = null;

  function load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;   // no map yet — normal on first run
    }
    if (raw.markerSizeM !== markerSizeM) {
      log(`Ignoring ${path.basename(file)}: it was surveyed with ` +
        `${raw.markerSizeM} m markers, config says ${markerSizeM} m`);
      return;
    }
    anchorId = raw.anchorId;
    for (const [id, m] of Object.entries(raw.markers || {})) {
      markers.set(Number(id), {
        pose: { p: m.p, q: m.q },
        nObs: m.nObs || 0,
        // Absent in maps written before provenance was recorded. Null depth
        // says "not known", which is what it is — inventing 1 would claim every
        // old tag sits next to the anchor.
        from: m.from || [],
        hops: Number.isFinite(m.hops) ? m.hops : null,
        verified: Number.isFinite(m.verified) ? m.verified : null,
        // Restored only when actually recorded: the resid EMAs seed themselves
        // on `=== undefined`, so a null here would arithmetic into the first
        // sighting instead of being replaced by it.
        ...(Number.isFinite(m.refinedAtMs) ? { refinedAtMs: m.refinedAtMs } : {}),
        ...(Number.isFinite(m.resid) ? { resid: m.resid } : {}),
        ...(Number.isFinite(m.residDeg) ? { residDeg: m.residDeg } : {}),
        ...(Number.isFinite(m.checkedAtMs) ? { checkedAtMs: m.checkedAtMs } : {}),
        ...(Number.isFinite(m.checkOff) ? { checkOff: m.checkOff } : {}),
      });
    }
    // The anchor is the datum by definition, whatever the file said.
    const anchor = markers.get(anchorId);
    if (anchor) anchor.hops = 0;
    // The plane constraint is asserted geometry, so it holds for a map read off
    // disk exactly as it does for one being built — otherwise a map saved before
    // the rule existed, or saved between a promotion and the next sighting,
    // keeps an offset the rule would have removed until something happens to
    // look at that tag again. Shallowest first, so a tag clips onto a reference
    // that has already been put on its own plane.
    const clipped = [...markers.keys()]
      .sort((a, b) => datumDepth(a, markers.get(a)) - datumDepth(b, markers.get(b)))
      .filter((id) => clipToPlane(id));
    if (markers.size) {
      log(`Marker map loaded: ${markers.size} tags, anchor ${anchorId}`
        + (clipped.length ? `, clipped ${clipped.join(' ')} onto their reference planes` : ''));
    }
  }

  // Jitter, measured rather than eyeballed. Two numbers over the same window:
  // how far the *phone* actually moved, taken from ARCore's own pose
  // (visual-inertial — it does not care what the tags say), and how much the
  // fix itself wandered underneath it. Phone still while the pose moves is the
  // whole question, and it cannot be answered by looking at either alone.
  // The second number is also the honest radius for a "probably here" marker:
  // drawing a point implies a precision the fix does not have.
  const JITTER_WINDOW_MS = 1500;
  const JITTER_MIN_SAMPLES = 8;

  function meanOf(pts) {
    return [0, 1, 2].map((k) => pts.reduce((a, p) => a + p[k], 0) / pts.length);
  }

  // RMS distance from the window's mean — the radius that contains the bulk of
  // the samples, not the worst one, which would report a single mirror flip as
  // the steady-state spread.
  function spreadOf(pts, m = meanOf(pts)) {
    let sum = 0;
    for (const p of pts) {
      sum += (p[0] - m[0]) ** 2 + (p[1] - m[1]) ** 2 + (p[2] - m[2]) ** 2;
    }
    return Math.sqrt(sum / pts.length);
  }

  // Both halves of the window are frame-dependent: the ARCore positions belong
  // to one XR session's origin, the room positions to one survey. Whenever
  // either frame is replaced the samples are not stale, they are meaningless —
  // and the residual is computed against the *current* alignment, so a window
  // straddling the change reports the distance between two coordinate systems
  // as jitter. The held radius is worse still: it survives with no window at
  // all to contradict it, so a number measured in a dead session gets drawn
  // around a client in a live one.
  function forgetJitter(clientId) {
    if (clientId === undefined) {
      jitterHist.clear();
      lastRadiusMm.clear();
    } else {
      jitterHist.delete(clientId);
      lastRadiusMm.delete(clientId);
    }
  }

  function trackJitter(clientId, xrP, roomP, T, confirmed) {
    const now = Date.now();
    let h = jitterHist.get(clientId);
    if (!h) jitterHist.set(clientId, h = []);
    h.push({ at: now, xr: xrP, room: roomP, ok: confirmed });
    while (h.length && now - h[0].at > JITTER_WINDOW_MS) h.shift();
    if (h.length < JITTER_MIN_SAMPLES) return null;
    const movedMm = Math.round(spreadOf(h.map((e) => e.xr)) * 1000);
    // With the phone's motion divided out, a window in which no tag corrected
    // the alignment has a residual of exactly zero — the alignment did not move
    // because nothing asked it to. That is not certainty, it is the absence of a
    // measurement, and reporting it as a radius would shrink the circle to
    // nothing precisely while walking between tags. Hold the last radius that
    // was actually measured, re-centred on where the client is now. Growing it
    // with distance would be better still, but the honest rate is not
    // recoverable from these journals: at a fresh sighting the disagreement with
    // the alignment is ~50 mm before the phone has moved at all, and that
    // tag-fix noise swamps the drift term in every path-length bin.
    if (!h.some((e) => e.ok)) {
      const last = lastRadiusMm.get(clientId);
      return last === undefined
        ? null
        : { movedMm, jitterMm: last, centre: roomP, n: h.length, stale: true };
    }
    // Each past sample re-expressed through the alignment as it stands *now*.
    // Every reported pose was T_then applied to that instant's ARCore position,
    // so the residual against T_now is the alignment's own wander with the
    // phone's motion divided out exactly — if T never changed it is identically
    // zero however far the phone walked. Taking the spread of the raw room
    // positions instead measured motion and noise added together, which is why
    // the "probably here" circle used to balloon the moment you started
    // walking, and why its centre — a plain mean of where you had been — sat
    // most of a window behind you.
    const residual = h.map((e) => {
      const at = transformPoint(T, e.xr);
      return [e.room[0] - at[0], e.room[1] - at[1], e.room[2] - at[2]];
    });
    const bias = meanOf(residual);
    // The newest residual is zero by construction, so this is the current pose
    // nudged by how the alignment has been sitting lately: still a statement
    // about now, not about the middle of the window.
    const centre = [0, 1, 2].map((k) => roomP[k] + bias[k]);
    const jitterMm = Math.round(spreadOf(residual, bias) * 1000);
    lastRadiusMm.set(clientId, jitterMm);
    return { movedMm, jitterMm, centre, n: h.length };
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const out = {
        version: MAP_VERSION,
        anchorId,
        markerSizeM,
        updatedAtMs: Date.now(),
        markers: Object.fromEntries([...markers].map(([id, m]) => [
          id, {
            p: m.pose.p, q: m.pose.q, nObs: m.nObs,
            from: m.from || [], hops: m.hops ?? null, verified: m.verified ?? null,
            // Refinement provenance, not geometry: without it every tag reads
            // "never refined" in the drawer after a restart, which is
            // indistinguishable from the never-corrected state it warns about.
            refinedAtMs: m.refinedAtMs ?? null,
            resid: m.resid ?? null, residDeg: m.residDeg ?? null,
            checkedAtMs: m.checkedAtMs ?? null, checkOff: m.checkOff ?? null,
          },
        ])),
      };
      // Atomic replace: a crash mid-write must not eat the map.
      const tmp = `${file}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
        fs.renameSync(tmp, file);
      } catch (err) {
        log(`Marker map save failed: ${err.message}`);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  // Camera room pose fused from a set of known-tag observations:
  // T_room_cam = T_room_tag ∘ inv(T_cam_tag), weighted toward close tags
  // (pose error grows roughly with distance squared) and toward clean
  // detections (reprojection error is the per-observation noise proxy).
  // `ref` is an independently-derived guess at where the camera is, used only
  // as the agreement referee below. Only the XR path has one worth passing:
  // ARCore's predicted pose owes nothing to this frame's tags. The tag-only
  // path's best candidate is its own previous fix, which does, so it passes
  // nothing rather than letting a bad frame vouch for the next one.
  function fuseCameraPose(obs, ref = null) {
    if (!obs.length) return null;
    const poses = obs.map((o) => se3Compose(markers.get(o.id).pose, se3Invert(o.camTag)));
    // Inverse variance of the camera position each tag implies: sin^2 of the
    // viewing angle over distance to the fourth, both measured rather than
    // assumed (see SIN2_FLOOR). Reprojection error stays as the per-observation
    // noise proxy it always was — it is blind to conditioning, not useless.
    const weights = obs.map((o) =>
      Math.max(SIN2_FLOOR, 1 - o.cos * o.cos)
      / (Math.max(o.dist ** 4, 1) * (0.5 + o.err) ** 2));
    // Agreement with the other tags, on top of geometry. Each tag implies a
    // camera position; a tag sitting somewhere the others say it is not gets
    // its say reduced for this frame only, so a stale map entry stops steering
    // the fix (and, through it, the refinement of every other tag) before
    // anything has corrected it.
    //
    // What the tags are judged against depends on how many there are. Three or
    // more and the median of what they each imply is a real statistic. Exactly
    // two and it is only their midpoint — it cannot say which of the pair is
    // the odd one out, so this check used to be skipped entirely there, and the
    // two-tag case ran on geometry alone: measured 7.8 mm of rest jitter
    // against 5.0 with a single tag and 4.1 with three, because the fix sits
    // between two disagreeing tags and slides as their angle and distance
    // weights shift. `ref` is the referee for that case.
    const mid = poses.length >= CONSENSUS_MIN_OBS
      ? [0, 1, 2].map((k) => median(poses.map((x) => x.p[k])))
      : (poses.length === 2 && ref ? ref.p : null);
    if (mid) {
      for (let i = 0; i < poses.length; i++) {
        const d = Math.hypot(
          poses[i].p[0] - mid[0], poses[i].p[1] - mid[1], poses[i].p[2] - mid[2]);
        weights[i] /= 1 + (d / CONSENSUS_SOFT_M) ** 2;
      }
    }
    const wsum = weights.reduce((a, b) => a + b, 0);
    const p = [0, 0, 0];
    for (let i = 0; i < poses.length; i++) {
      for (let k = 0; k < 3; k++) p[k] += poses[i].p[k] * (weights[i] / wsum);
    }
    return { p, q: quatMean(poses.map((x) => x.q), weights) };
  }

  // Joint multi-tag PnP: one solve over every visible mapped tag's corners at
  // once, replacing the fuse of per-tag poses when the geometry supports it.
  //
  // Why: measured over 84 journals, 10.6% of tag sightings are the wrong branch
  // of the planar two-fold ambiguity, they fit their own corners to under
  // 0.3 px (no reprojection gate can see them), and they come in runs (no
  // temporal filter can either). Every dilution was tried and measured short —
  // robust estimators are a no-op because the contamination is symmetric,
  // conditioning weights buy 9%. But the ambiguity is a property of a
  // *coplanar* point set: tags on different walls jointly have no mirror at
  // all, so a solve over all of them removes the degree of freedom rather than
  // averaging over it. `0` reproduces the module exactly as it stood.
  const JOINT_PNP = opts.jointPnp ?? 1;
  // Mean per-point reprojection distance the accepted solve must beat, and the
  // gate doing most of the protecting — measured, not guessed. At this tag size
  // even two tags on perpendicular walls are only ~5 cm from one plane, so the
  // wrong joint basin still fits their corners to 1.5-3 px; the true basin fits
  // under 1. Replayed over the three worst journals, joint-vs-fuse disagreement
  // by rms band: under 1 px, 227 solves, none past 0.5 m (mean 5 cm — the
  // honest difference between the two estimators); 1.5-3 px, 508 solves, 96%
  // past 0.5 m at a 1.6 m mean, i.e. the mirror wearing a plausible residual.
  // At 3 px this gate admitted every one of those, and the map-teleport showed
  // up as reported-pose jumps and alignment re-acquires (7 -> 46 across 109
  // journals). A solve past the gate falls back to the fuse, which is never
  // worse than today.
  const JOINT_MAX_RMS_PX = opts.jointMaxRmsPx ?? 1;
  // The load-bearing guard. RMS spread of the pooled room-frame corners along
  // the flattest axis: below this the set is effectively one plane, the joint
  // solve is *still* two-fold ambiguous, and accepting it would put the same
  // ambiguity in a new place with more confidence attached. Sized against the
  // two cases it must separate: tags taped to one wall sit ~1 cm off a common
  // plane (solve noise), while a 150 mm tag on a wall ~86 deg from another
  // wall's plane puts its corners ~5 cm out. An absolute figure, not the
  // smallest/largest spread ratio, because the ratio *shrinks* as tags on
  // different walls get further apart — the direction in which the geometry
  // actually gets stronger.
  const JOINT_MIN_OFFPLANE_M = opts.jointMinOffplaneM ?? 0.03;
  // Seeds are every visible tag's implied camera pose, for both of its PnP
  // branches — a single seed would stay in whichever basin it started in,
  // which is the whole failure this replaces. Bounded because this runs at
  // 10 Hz per client.
  const JOINT_MAX_SEEDS = 12;
  // Coverage accounting. If the joint path rarely runs the whole feature is
  // moot, and that has to be visible rather than assumed — every fallback
  // reason is counted and the split is logged (and read by replay-survey.js).
  const jointStats = {
    joint: 0, fewTags: 0, noCorners: 0, noIntr: 0, coplanar: 0,
    noConverge: 0, rms: 0, ms: 0,
  };
  let jointLogAt = 0;

  function maybeLogJoint() {
    const now = Date.now();
    if (now - jointLogAt < 60000) return;
    const tried = jointStats.joint + jointStats.coplanar + jointStats.noCorners
      + jointStats.noIntr + jointStats.noConverge + jointStats.rms;
    if (!tried) return;
    jointLogAt = now;
    log(`Joint PnP: ${jointStats.joint}/${tried} multi-tag solves took the joint `
      + `path (coplanar ${jointStats.coplanar}, no corners ${jointStats.noCorners}, `
      + `no camera model ${jointStats.noIntr}, no convergence ${jointStats.noConverge}, `
      + `rms ${jointStats.rms}); ${jointStats.fewTags} calls saw under two tags; `
      + `solver ${jointStats.ms.toFixed(0)} ms total`);
  }

  function jointSolve(known, K) {
    if (known.length < 2) {
      jointStats.fewTags++;
      return null;
    }
    if (!K || !Number.isFinite(K.fx)) {
      jointStats.noIntr++;
      return null;
    }
    const usable = known.filter((o) => o.corners);
    if (usable.length < 2) {
      jointStats.noCorners++;
      return null;
    }
    const cs = markerCornersM(markerSizeM);
    const obj = [];
    const img = [];
    for (const o of usable) {
      const mp = markers.get(o.id).pose;
      for (let i = 0; i < 4; i++) {
        obj.push(transformPoint(mp, cs[i]));
        img.push([o.corners[i * 2], o.corners[i * 2 + 1]]);
      }
    }
    const mean = [0, 1, 2].map((k) => obj.reduce((a, p) => a + p[k], 0) / obj.length);
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (const pt of obj) {
      const dx = pt[0] - mean[0];
      const dy = pt[1] - mean[1];
      const dz = pt[2] - mean[2];
      xx += dx * dx; xy += dx * dy; xz += dx * dz;
      yy += dy * dy; yz += dy * dz; zz += dz * dz;
    }
    const n = obj.length;
    const offPlane = Math.sqrt(Math.max(0,
      minEig3([xx / n, xy / n, xz / n, yy / n, yz / n, zz / n])));
    if (offPlane < JOINT_MIN_OFFPLANE_M) {
      jointStats.coplanar++;
      return null;
    }
    let best = null;
    let seeds = 0;
    for (const o of usable) {
      const mp = markers.get(o.id).pose;
      for (const s of o.sols) {
        if (seeds >= JOINT_MAX_SEEDS) break;
        seeds++;
        const sol = solvePose(obj, img, K, se3Compose(mp, se3Invert(s.camTag)));
        if (sol && (!best || sol.rms < best.rms)) best = sol;
      }
    }
    if (!best) {
      jointStats.noConverge++;
      return null;
    }
    if (best.rms > JOINT_MAX_RMS_PX) {
      jointStats.rms++;
      return null;
    }
    jointStats.joint++;
    return { p: best.p, q: best.q };
  }

  // Null whenever the joint solve is not available or not trustworthy, so
  // every caller keeps fuseCameraPose as the fallback:
  //   jointCameraPose(known, K) ?? fuseCameraPose(known, ...)
  function jointCameraPose(known, K) {
    if (!JOINT_PNP) return null;
    const t0 = performance.now();
    const out = jointSolve(known, K);
    jointStats.ms += performance.now() - t0;
    maybeLogJoint();
    return out;
  }

  // ARCore tracks the camera in its own session frame, whose origin is
  // wherever the session started. The tags define the room frame. This is the
  // transform between them: T_room_xr, learned the moment a tag is seen and
  // nudged whenever another one is. It is also the whole of the "tags as
  // anchors" idea — between sightings ARCore carries the pose and this
  // transform stays put; a sighting corrects the drift that accumulated.
  // clientId -> { T, sid, nObs, at, rej, lastXr, moved }. lastXr/moved are the
  // ARCore path length walked since the alignment was last corrected — see
  // alignAlpha.
  const xrAlign = new Map();
  // A fresh alignment jumping this far is a bad tag fix, not drift.
  const XR_ALIGN_JUMP_M = 1.0;
  // How fast the alignment chases a fresh fix. This used to be a constant 0.25,
  // which spent a quarter of its gain chasing tag noise while the phone sat on a
  // table: the alignment's only job is to track ARCore's drift, and drift
  // accrues with *motion*, not with time or with how many fixes arrived. Held
  // still, every difference between est and T is noise by construction, so the
  // gain drops to a crawl and the noise averages away instead of being drawn.
  // ALPHA_MIN is a floor, never zero — at ~10 fixes a second it is still a ~5 s
  // time constant, so an alignment that is genuinely wrong still converges
  // rather than freezing in place.
  //
  // Measured by replaying all ten XR pose journals (1189 windows where ARCore
  // says the phone was still, which it can say without consulting a tag):
  // rest jitter median 10.0 -> 5.4 mm and p90 75.9 -> 16.8 mm, steadier in 77%
  // of paired windows, with no alignment re-acquired and no change to which
  // tags were surveyed. The moving half is scored separately — where ARCore
  // says the phone is walking, the pose sits 0.2 mm behind the old behaviour at
  // the median and 27 mm at p10 — because "steadier while still" is trivially
  // won by an alignment that simply stops updating.
  //
  // A replay has to drive Date.now() from the journal, or every window and TTL
  // in here spans the whole run: the jitter window in particular quietly
  // becomes "since the session started" and reports a session-wide spread as
  // rest jitter.
  const XR_ALIGN_ALPHA_MIN = 0.02;
  const XR_ALIGN_ALPHA_MAX = 0.25;      // walking behaves exactly as before
  // Motion since the last correction that earns the full gain. This is per
  // correction, not per journey: the accumulator resets every time a fix lands,
  // so at ~10 fixes a second 3 cm is 0.3 m/s — start walking and the gain is
  // back to what it always was within a fix or two. Sized far larger (0.3 m,
  // reasoning about walks rather than about intervals) it starves the moving
  // case instead: 122 mm of p10 lag behind the old behaviour, against 27 mm
  // here.
  const XR_ALIGN_MOTION_FULL_M = 0.03;
  // ARCore's own pose noise is ~1 mm per sample; integrated at 10 Hz that is a
  // centimetre a second of motion that never happened, which would quietly hand
  // a motionless phone the full gain and undo the whole thing. Measured: with
  // no deadband the median rest jitter is 6.4 mm instead of 5.4.
  const XR_ALIGN_MOTION_DEADBAND_M = 0.003;
  // Rotating in place drifts the session frame too, so it counts as motion, at
  // 1 deg to 5 mm. Dropping the term (translation only) costs 91 mm of p10 lag
  // against 27 mm with it — a phone panning across a room is moving as far as
  // the alignment cares. Weighting it much harder buys a little more back and
  // spends it on the tail: 0.008 gives 21 mm of lag and a 20.5 mm p90 instead
  // of 16.8.
  const XR_ALIGN_ROT_M_PER_DEG = 0.005;
  // ...unless that many fixes in a row agree with each other and not with the
  // alignment, at which point the alignment is what is wrong. At ~10 poses a
  // second this is a second of consistent disagreement.
  const XR_ALIGN_MAX_REJECTS = 10;
  // The jump gate and the re-acquire escape both assume the session frame is
  // *stationary* and only the fix can be wrong. A diverging ARCore session
  // breaks that: VIO ran away at ~5 m/s for 20 s while the phone sat still
  // looking at three tags, tracking never reported lost, and every fix was
  // right about a frame that was in motion — the EMA lagged metres behind it
  // and each re-acquire was stale the moment it landed, so the reported pose
  // sawtoothed out to 25 m. The tell is the implied alignment itself:
  // est = camRoom ∘ xr⁻¹ is constant to within fix noise while ARCore is
  // healthy and travels coherently when it is not. Net displacement over a
  // window, not instantaneous speed — per-fix est speed is dominated by fix
  // noise (healthy sessions reach 7 m/s at p90), while net travel over 2 s
  // stays bounded. Replayed over all 39 journals: healthy sessions never
  // exceed 12 consecutive fixes past 1.5 m (and those runs sit around genuine
  // ARCore relocalizations, where distrusting the frame is right anyway); the
  // runaway session holds 85.
  const XR_SLIP_WINDOW_MS = 2000;
  const XR_SLIP_NET_M = 1.5;
  const XR_SLIP_MIN_FIXES = 20;
  // Recovery wants the est steady, not merely slower — a third of the trip
  // threshold, held for about a second of fixes. In the runaway journal this
  // re-founds ~3 s after ARCore relocalizes and holds still.
  const XR_SLIP_RECOVER_FIXES = 10;
  // ...and the other way the session frame stops describing the room: ARCore
  // relocalizes and *steps*. Measured on a real session, the phone sitting
  // still with two tags in view: xr jumped 1.333 m in one 200 ms report, held
  // there 1.2 s, then jumped back — flip-flopping between two relocalization
  // branches. Nothing caught it. The slip detector above wants coherent travel
  // over 20 fixes and a step is one sample that then holds still; the jump gate
  // rejected the fix correctly but its only escape is XR_ALIGN_MAX_REJECTS
  // agreeing rejects, which is exactly the 1.2 s the pose spent 1.3 m wrong;
  // and with no tag in frame nothing runs at all, so the walls grid could take
  // permanent evidence from a pose a metre out.
  //
  // The step is visible in xr alone — no tag needed, which is the point. Speed
  // alone does not separate it: a 40 mm step over a 12 ms report is 3.4 m/s of
  // pure noise, and healthy sessions reach 3 m/s at p99.9. Distance with a
  // speed allowance does. Over all 72 journals on disk (48736 steps) this trips
  // in 10 of them, 62 never; loosening to 0.25 + 2.5*dt reaches 13 journals and
  // 0.20 + 2.0*dt reaches 19, buying 19 fewer reported jumps for twice the
  // distrusted time — shallow either way, so the gate sits where it stops
  // touching healthy sessions at all.
  //
  // Measured by replay-survey.js over the same 72 journals, before against
  // after: reported-pose steps over a metre 51 -> 16, over 0.3 m 385 -> 351,
  // worst step 4.53 -> 3.85 m, and mapSafe reports sitting within 1.5 s of a
  // jump 3903 -> 3407. The session this was written for went from 11 jumps over
  // a metre to 1, and from 6 alignment re-acquires to 1. It costs 40 s of
  // distrusted frames across 2.4 hours of session, and 'good' time went
  // slightly up rather than down (6184 -> 6190 s), because the re-acquires it
  // replaces were themselves seconds of wrongness.
  //
  // What is left over a metre is not this: it is the /client tag-only path
  // recovering from dead reckoning, the reject escape correcting an alignment
  // that was founded wrong (the jump *is* the correction), and tag-fix noise
  // during the distrust window. Different faults, none of them a teleport.
  const XR_STEP_M = opts.stepM ?? 0.30;
  const XR_STEP_M_PER_S = opts.stepMPerS ?? 3.0;
  // Past this the gap itself hides however much real motion, so there is no
  // measurement to make — not a clean one. The alignment is stale after a gap
  // that long anyway (ALIGN_FRESH_MS) and the reject escape still covers it.
  const XR_STEP_MAX_DT_S = opts.stepMaxDtS ?? 0.6;
  // ...and the allowance is capped, because at the far end of the dt range it
  // grows to 2.1 m and stops being a statement about anything a phone can do.
  // A report is at most XR_STEP_MAX_DT_S apart, so this is 1.7 m/s sustained
  // over the longest interval the gate looks at and 3 m/s over a typical one.
  const XR_STEP_CAP_M = opts.stepCapM ?? 1.0;
  // A stepped frame is usually steady again immediately, so distrust need not
  // last as long as it does for a frame that is genuinely travelling. Three
  // fixes still refuses to re-found the alignment on a single PnP solve, and it
  // bounds how long tag-only reporting and mapSafe=false last.
  const XR_STEP_RECOVER_FIXES = opts.stepRecoverFixes ?? 3;
  // Refine step weighting. 0 reproduces the module as it stood before it
  // existed — the scale becomes 1 for every sighting — which is how the
  // before/after pair is taken without editing the file under test.
  //
  // A *plain* distance weight was tried first and is the wrong shape, which is
  // worth recording because it looks right and measures well on one metric.
  // Down-weighting a far sighting by (ref/d)^4 improved worst cross-session
  // disagreement from 3.43 to 1.76 deg over 84 journals — and destroyed the
  // one defence the map has against a tag somebody turned, because it throttles
  // a 30 deg correction exactly as hard as a 3 deg one. Measured by perturbing
  // a tag 30 deg and replaying: 23 of the 34 journals that see it healed it
  // under 10 deg before, 7 after. Backing the reference distance off to 4.5 m
  // restored healing and gave back nearly all of the gain (3.26 deg), i.e. the
  // knob only ever bought the trade it was tuned to.
  //
  // So the step is scaled by the innovation against the noise the sighting is
  // expected to carry, which is the same self-tuning-gain shape the reported
  // pose filter already uses: a disagreement large against the noise is signal
  // and takes a full step whatever the distance, one inside the noise takes
  // almost none. Distance enters through the noise estimate, where it belongs.
  //
  // There is no viewing-angle term. The fuse's sin^2 says head-on is the
  // degenerate case for the camera *position* a tag implies; for the tag's own
  // orientation the same measurement found no monotone effect at all
  // (band-to-band offsets 1.2-4.3 deg, no ordering), and importing it would
  // down-weight head-on sightings 25x on no evidence. A reprojection-error term
  // was tried alongside and measured as nothing (under 0.05 deg on every tag).
  const REFINE_NOISE_SCALE = opts.refineNoiseScale ?? 1;
  // How close two consecutive implied alignments have to sit to count as
  // agreeing. est is the alignment, not the camera, so it does not move with
  // the phone at all — the whole of this budget is fix noise, which runs to
  // ~50 mm at a fresh sighting (see the jitter note above). Generous against
  // that, and still a fifth of the smallest step that can trip the detector.
  const XR_STEP_AGREE_M = 0.25;
  // clientId -> the session id whose camera model was already logged, so the
  // 10 Hz pose path logs it once per session rather than on every report.
  const loggedIntrinsics = new Map();
  // clientId -> the camera-model provenance last logged for it. Logged on change
  // rather than once, because it changes mid-session: a resolution switch or a
  // camera switch re-resolves the model and can drop it to a derived tier.
  // Without this a map polluted by a client working from a guessed or rotated
  // model is undiagnosable after the fact — the map file records no such thing.
  const loggedModel = new Map();
  let lastSeenLog = 0;
  // How long after a confirming tag sighting the alignment is still good
  // enough to survey new tags against.
  const ALIGN_FRESH_MS = 2000;

  // Is the room frame level? The anchor is stored as se3Identity, so the room
  // frame *is* the anchor tag's own frame — room +y is whichever way that tag
  // was mounted. Everything two-dimensional downstream projects onto room xz
  // and calls the result a floor plan (`walls.js` carves its grid there,
  // `map2d.js` draws it), which is true only while the anchor hangs upright.
  // Nothing enforces that, the anchor is picked automatically as the first
  // clean tag, and the failure is silent: an anchor mounted a quarter turn
  // round on its own wall makes room y horizontal and turns the floor plan
  // into a vertical slice through the room, with every wall and every carved
  // cell wrong and nothing anywhere saying so.
  //
  // An aligned XR client can measure it for free. ARCore's session frame is
  // gravity-aligned, so room-frame up is the alignment applied to the session's
  // own +y. This only reports — squaring the 2D layers onto measured gravity
  // rather than onto the anchor is the real fix and a much larger change.
  //
  // Averaged before it accuses anyone: measured over 39032 good frames a single
  // frame's estimate sits 1.8 deg from its session's median at p50 and 5.5 deg
  // at p90, so one bad frame must not raise this and the threshold sits well
  // clear of the spread that remains after averaging.
  const GRAVITY_MIN_SAMPLES = 60;
  const GRAVITY_TILT_DEG = 10;
  // Keyed by the anchor because that is what it is a statement about. Every
  // path that resets the survey drops or replaces the anchor, so this
  // re-measures after a reset without having to be told about one.
  const gravity = { forAnchor: undefined, n: 0, sum: [0, 0, 0], logged: false };

  // Founding the alignment. With no alignment yet and one known tag in view,
  // pickSolutions has neither another tag nor a reference to resolve that tag's
  // mirror against, so it leaves the default branch standing — and that branch
  // founds the room<-session transform. Get it wrong and every later reference
  // is derived from it, so pickSolutions goes on agreeing with the flip and the
  // EMA never walks away from a start it cannot see is wrong. Measured over
  // four journals of one room, this put the far tags 0.8-1.9 m apart between
  // runs while the tag nearest the anchor agreed to 0.10 m.
  //
  // The branch is decided by which one implies a room<-session transform that
  // stays *put* while the camera moves: the true camera pose is rigid against
  // ARCore, and the mirror is a reflection about the line of sight, so it swings
  // as that line turns. Nothing here consults the tag map, which is the point —
  // at this moment the map is one tag and cannot arbitrate anything.
  //
  // clientId -> { sid, at, fromP, span, samples, lastEst }. Shared by
  // foundAlignment and watchBranch: a give-up founding keeps its ring here so
  // the branch test continues under the committed alignment instead of
  // starting over.
  const xrFound = new Map();
  const FOUND_MIN_CLUSTER = 6;     // agreeing candidates before a branch is taken
  const FOUND_MOVE_M = 0.5;       // baseline the two branches need to separate
  // poseDisagree units: metres plus 0.02 per degree, so this is ~10 cm and ~5°.
  const FOUND_TOL = 0.2;
  // Past this, found on the default branch and say so. Refusing forever is not
  // an option — a client held still has no baseline and would never localize,
  // and the honest failure is a loud one rather than a dead dashboard.
  const FOUND_MAX_MS = 6000;

  function alignAlpha(moved) {
    const t = Math.min(1, moved / XR_ALIGN_MOTION_FULL_M);
    return XR_ALIGN_ALPHA_MIN + (XR_ALIGN_ALPHA_MAX - XR_ALIGN_ALPHA_MIN) * t;
  }

  // Path length, not displacement from the last correction: a walk out and back
  // leaves ARCore drifted by roughly what it travelled, not by nothing.
  // Returns the step distance when the session frame jumped rather than moved
  // (see XR_STEP_M), else 0. Translation only: a relocalization rotates the
  // frame too, but a fast pan is ordinary and rolling rotation into the test
  // would trip on it. A step is not motion and must not be accrued — 1.3 m of
  // travel that never happened would pin alignAlpha at its maximum for the next
  // fix, spending the whole gain on chasing a frame that is about to jump back.
  function accrueMotion(A, xrT, at) {
    let jumped = null;
    if (A.lastXr) {
      const dp = Math.hypot(
        xrT.p[0] - A.lastXr.p[0], xrT.p[1] - A.lastXr.p[1], xrT.p[2] - A.lastXr.p[2]);
      const dt = A.lastAt ? (at - A.lastAt) / 1000 : null;
      if (!(dt > 0)) {
        // Nothing to compare against yet.
      } else if (dt > XR_STEP_MAX_DT_S) {
        // No step can be measured across a gap this long, and "not measurable"
        // is not "fine": the reports stop on the XR path precisely when ARCore
        // stops tracking, which is when it relocalizes. Measured over all 72
        // journals, gaps past XR_STEP_MAX_DT_S number 37 in 48874 reports (26
        // journals, median 3.1 s) and 20 of them span more than 0.3 m of
        // session-frame displacement — so distrusting the frame across one is
        // both rare and usually right. This was the hole that let the worst
        // remaining jump through: a 1.35 m relocalization arriving on the first
        // report after a 6.8 s tracking loss, reported as 'tracked' with
        // mapSafe true because no test could see it.
        jumped = { why: 'gap', d: dp, dt };
      } else if (dp > Math.min(XR_STEP_M + XR_STEP_M_PER_S * dt, XR_STEP_CAP_M)) {
        jumped = { why: 'step', d: dp, dt };
      }
      const d = dp + XR_ALIGN_ROT_M_PER_DEG * quatAngleDeg(A.lastXr.q, xrT.q);
      if (jumped) A.moved = 0;
      else if (d > XR_ALIGN_MOTION_DEADBAND_M) A.moved += d;
    }
    A.lastXr = xrT;
    A.lastAt = at;
    return jumped;
  }

  // The session frame stepped: stop trusting it now, without waiting for a tag
  // to prove it. Entering the same state the drift detector uses rather than a
  // parallel one, because everything downstream of "the frame is not to be
  // trusted" is already written — report the tag fix alone, dead-reckon when
  // there is no tag, and keep the frame out of the survey and the walls grid
  // until it settles. Tagged with why: recovery is much faster for a step,
  // which is usually steady again on the very next report.
  function tripStep(clientId, A, jumped) {
    const s = A.slip || (A.slip = { hist: [], n: 0, stable: 0, on: false });
    // Already distrusted for travelling: that is the stricter verdict and the
    // step is part of what it is describing. Leave it to recover its own way.
    if (s.on && s.why !== 'step') return;
    // Stepping again mid-recovery restarts it — the fixes that agreed so far
    // agreed about a frame that has since moved again.
    const again = s.on;
    s.on = true;
    s.why = 'step';
    s.n = 0;
    s.stable = 0;
    s.lastEst = null;
    if (!again) {
      log(`Client ${clientId} XR session frame ${jumped.why === 'gap'
        ? `moved ${jumped.d.toFixed(2)} m across a ${jumped.dt.toFixed(1)} s gap in `
          + 'reports, which nothing can vouch for'
        : `stepped ${jumped.d.toFixed(2)} m in one report — ARCore relocalized`}`
        + '; reporting tag fixes until it settles');
    }
  }

  // One gravity sample, from an alignment a tag has just confirmed. Says
  // nothing until it has enough of them, then says it once — this is a property
  // of the room, so repeating it every frame would be noise, and saying it only
  // when it is bad would leave silence meaning both "level" and "never
  // checked".
  function checkGravity(A) {
    if (gravity.forAnchor !== anchorId) {
      gravity.forAnchor = anchorId;
      gravity.n = 0;
      gravity.sum = [0, 0, 0];
      gravity.logged = false;
    }
    if (gravity.logged) return;
    const up = quatRotate(A.T.q, [0, 1, 0]);
    for (let k = 0; k < 3; k++) gravity.sum[k] += up[k];
    if (++gravity.n < GRAVITY_MIN_SAMPLES) return;
    const len = Math.hypot(gravity.sum[0], gravity.sum[1], gravity.sum[2]);
    if (!(len > 1e-6)) return;
    const tilt = Math.acos(Math.max(-1, Math.min(1, gravity.sum[1] / len)))
      * 180 / Math.PI;
    gravity.logged = true;
    if (tilt <= GRAVITY_TILT_DEG) {
      log(`Room frame is level — gravity sits ${tilt.toFixed(1)} deg off room +y `
        + `(anchor ${anchorId}, ${gravity.n} fixes)`);
      return;
    }
    log(`Room frame is TILTED ${tilt.toFixed(1)} deg off gravity — anchor `
      + `${anchorId} is not hanging upright, and the room frame is its frame. `
      + 'The floor plan and the carved walls grid are the room xz plane, so '
      + `both are skewed by that angle; at 90 deg they are a vertical slice `
      + 'through the room rather than a plan of it. Re-anchor on an upright tag '
      + '(remove the anchor in the viewer) to fix it — nothing downstream can '
      + 'detect this on its own.');
  }

  // Slip detection: is the session frame itself in motion under the alignment?
  // Fed every fix that produced a tag-solved camera pose; est is the alignment
  // that fix implies. Returns 'ok', 'slipping', or 'recovered' — the last one
  // means the alignment was just re-founded on this very fix, after the est
  // held still long enough to trust the frame again.
  function updateSlip(clientId, A, est, xrT) {
    const s = A.slip || (A.slip = { hist: [], n: 0, stable: 0, on: false });
    // No tag this frame: nothing to learn, and the verdict stands.
    if (!est) return s.on ? 'slipping' : 'ok';
    const now = Date.now();
    // A stepped frame recovers on consecutive agreeing fixes rather than on the
    // windowed test below. The window needs a reference a full XR_SLIP_WINDOW_MS
    // old, and every sample older than the step describes the frame the step
    // left — so a windowed recovery could not return before ~2 s whatever the
    // frame did, which is longer than the wrongness this was written to cut
    // short. Consecutive est agreement measures the same thing (has the implied
    // alignment stopped moving) without waiting for the window to refill.
    if (s.on && s.why === 'step') {
      const near = s.lastEst && Math.hypot(
        est.p[0] - s.lastEst[0], est.p[1] - s.lastEst[1],
        est.p[2] - s.lastEst[2]) <= XR_STEP_AGREE_M;
      s.stable = near ? s.stable + 1 : 0;
      s.lastEst = est.p;
      if (s.stable < XR_STEP_RECOVER_FIXES) return 'slipping';
      xrAlign.set(clientId, {
        T: est, sid: A.sid, nObs: 1, at: now, rej: null, lastXr: xrT, moved: 0,
        lastAt: A.lastAt,
        // The est history belongs to the frame that stepped away; against the
        // one now standing it is not stale, it is meaningless.
        slip: { hist: [], n: 0, stable: 0, on: false },
        // Doubt survives here for the same reason it does below: est was picked
        // against the alignment being replaced, so it inherits its mirror.
        unresolved: A.unresolved,
      });
      forgetJitter(clientId);
      log(`Client ${clientId} XR alignment re-founded after the frame stepped — `
        + `${XR_STEP_RECOVER_FIXES} agreeing fixes`);
      return 'recovered';
    }
    s.hist.push({ p: est.p, at: now });
    while (s.hist.length && s.hist[0].at < now - 2 * XR_SLIP_WINDOW_MS) s.hist.shift();
    // Newest sample at least a full window old. None (session just started,
    // or the tags were out of view long enough for the history to expire)
    // means no measurement, not a clean one.
    let ref = null;
    for (let i = s.hist.length - 1; i >= 0; i--) {
      if (now - s.hist[i].at >= XR_SLIP_WINDOW_MS) { ref = s.hist[i]; break; }
    }
    if (!ref) return s.on ? 'slipping' : 'ok';
    const d = Math.hypot(
      est.p[0] - ref.p[0], est.p[1] - ref.p[1], est.p[2] - ref.p[2]);
    if (!s.on) {
      s.n = d > XR_SLIP_NET_M ? s.n + 1 : 0;
      if (s.n < XR_SLIP_MIN_FIXES) return 'ok';
      s.on = true;
      s.why = 'drift';
      s.n = 0;
      s.stable = 0;
      log(`Client ${clientId} XR session frame is slipping — the alignment its `
        + `tags imply moved ${d.toFixed(1)} m in ${XR_SLIP_WINDOW_MS / 1000} s; `
        + 'reporting tag fixes until it settles');
      return 'slipping';
    }
    s.stable = d < XR_SLIP_NET_M / 3 ? s.stable + 1 : 0;
    if (s.stable < XR_SLIP_RECOVER_FIXES) return 'slipping';
    xrAlign.set(clientId, {
      T: est, sid: A.sid, nObs: 1, at: now, rej: null, lastXr: xrT, moved: 0,
      lastAt: A.lastAt,
      slip: { hist: s.hist, n: 0, stable: 0, on: false },
      // Doubt survives a slip recovery: est was picked against the slipping
      // alignment's own frame, so it inherits its unresolved mirror.
      unresolved: A.unresolved,
    });
    // The jitter window's ARCore half belongs to the frame that just slipped
    // away; against the new alignment it would read as spread.
    forgetJitter(clientId);
    log(`Client ${clientId} XR alignment re-founded — the slipping frame held `
      + `still for ${XR_SLIP_RECOVER_FIXES} fixes`);
    return 'recovered';
  }

  // Constant-velocity prediction of where a client is now, from its smoothed
  // track. Also what carries a pose across a brief tag dropout — the first
  // step toward tags being anchors rather than a continuous requirement.
  function predictPose(clientId, at = Date.now()) {
    const t = track.get(clientId);
    if (!t) return null;
    const dt = (at - t.at) / 1000;
    if (dt < 0 || dt * 1000 > POSE_EXTRAPOLATE_MS) return null;
    return {
      p: [t.p[0] + t.v[0] * dt, t.p[1] + t.v[1] * dt, t.p[2] + t.v[2] * dt],
      q: t.q,
      speed: Math.hypot(t.v[0], t.v[1], t.v[2]),
    };
  }

  // Blend a fresh fix into the track. The gain is what the measurement earns:
  // a fix landing within the noise of the prediction moves the track barely at
  // all, one landing far outside it is motion and is followed at once.
  function smooth(clientId, pose, at) {
    const prev = track.get(clientId);
    if (!prev || at - prev.at > POSE_MAX_DT_MS || at < prev.at) {
      track.set(clientId, { p: [...pose.p], q: pose.q, v: [0, 0, 0], at, nvar: 0 });
      return pose;
    }
    const dt = Math.max(POSE_MIN_DT_S, (at - prev.at) / 1000);
    const pred = [
      prev.p[0] + prev.v[0] * dt,
      prev.p[1] + prev.v[1] * dt,
      prev.p[2] + prev.v[2] * dt,
    ];
    const err = Math.hypot(pose.p[0] - pred[0], pose.p[1] - pred[1], pose.p[2] - pred[2]);
    const nvar = prev.nvar ? prev.nvar * 0.9 + err * err * 0.1 : err * err;
    const gain = Math.min(1, Math.max(POSE_MIN_GAIN,
      (err * err) / (err * err + POSE_GAIN_K * nvar)));
    const p = [0, 1, 2].map((k) => pred[k] + (pose.p[k] - pred[k]) * gain);
    const q = quatNudge(prev.q, pose.q, gain);
    // Velocity from the smoothed track, itself smoothed: differentiating a
    // noisy position at 7 Hz otherwise produces a velocity that is pure noise
    // and an extrapolation that flies off.
    const v = [0, 1, 2].map((k) => prev.v[k] * 0.7 + ((p[k] - prev.p[k]) / dt) * 0.3);
    track.set(clientId, { p, q, v, at, nvar });
    return { p, q };
  }

  // One reported tag fix: the ambiguity jump gate, then the smoother. Shared
  // by handlePose and the XR path's slip fallback, so a mirror flip is held
  // back the same way wherever a raw fix is what gets reported. held means
  // the returned pose is the previous fix standing in for a rejected one —
  // the caller must keep the rejected sample away from the survey.
  function reportFix(clientId, pose) {
    const now = Date.now();
    const prev = lastFix.get(clientId);
    if (prev && now - prev.at < JUMP_HISTORY_TTL_MS) {
      const jump = Math.hypot(
        pose.p[0] - prev.pose.p[0],
        pose.p[1] - prev.pose.p[1],
        pose.p[2] - prev.pose.p[2]);
      // prev.at deliberately not refreshed: an old enough history expires
      // and stops vetoing.
      if (jump > JUMP_REJECT_M && ++prev.rejectStreak < JUMP_CONFIRM_SAMPLES) {
        return { pose: prev.pose, held: true };
      }
    }
    lastFix.set(clientId, { pose, at: now, rejectStreak: 0 });
    // Only what is reported gets smoothed: the raw fix is what the gate above
    // compares against, and what the survey consumes.
    return { pose: smooth(clientId, pose, now), held: false };
  }

  // Disagreement bookkeeping. Returns the streak length after this sighting;
  // sightings closer together than RESEED_MIN_GAP_MS are the same look and do
  // not advance it, and a gap longer than the TTL starts over.
  function bumpStreak(clientId, id) {
    const key = `${clientId ?? 'anon'}|${id}`;
    const now = Date.now();
    const s = reseedStreak.get(key);
    if (!s || now - s.at > RESEED_STREAK_TTL_MS) {
      reseedStreak.set(key, { n: 1, at: now });
      return 1;
    }
    if (now - s.at < RESEED_MIN_GAP_MS) return s.n;
    s.n++;
    s.at = now;
    return s.n;
  }

  // Agreement clears only the observer's own streak; a drop clears every
  // client's, since the tag that was being accused no longer exists and its
  // replacement must be judged from scratch.
  function clearStreak(clientId, id) {
    reseedStreak.delete(`${clientId ?? 'anon'}|${id}`);
  }

  function clearStreaks(id) {
    for (const key of reseedStreak.keys()) {
      if (key.endsWith(`|${id}`)) reseedStreak.delete(key);
    }
  }

  // Good enough to change the map with, as opposed to good enough to look at.
  // A tag whose apparent size the client did not report (an older client, or
  // the pose path with no camera model to derive it from) is let through: the
  // gate is there to reject a measurement known to be small, not to reject
  // every measurement that cannot prove it was big.
  function surveyGrade(o) {
    return o.px == null || o.px >= SURVEY_MIN_PX;
  }

  let promoteLogAt = 0;

  // What a promotion was measured against, and how far that is from the datum.
  // Chain depth is the thing a position alone cannot say: a tag one hop from the
  // anchor carries the anchor's error once, a tag three hops out carries it
  // three times over plus everything picked up on the way, and the two look
  // identical in markers.json. Parents are ordered by how many of the inlier
  // estimates actually used them, so the tag that did most of the placing reads
  // first.
  function provenance(estimates) {
    const counts = new Map();
    for (const e of estimates) {
      for (const id of e.from || []) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const from = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    // One more hop than the shortest-chained parent. A parent from an older map
    // file has no depth recorded, and guessing one would invent a chain — those
    // are skipped, and a tag with no usable parent at all reports null rather
    // than claiming to be next to the anchor.
    const depths = from
      .map((id) => markers.get(id)?.hops)
      .filter((h) => Number.isFinite(h));
    return { from, hops: depths.length ? Math.min(...depths) + 1 : null };
  }

  function tryPromote(id) {
    const ring = candidates.get(id);
    if (ring.length < PROMOTE_MIN_ESTIMATES) return false;
    // Agreement with the component-wise median throws out estimates from bad
    // camera fixes without needing to know which fix was bad. Orientation gets
    // the same robust treatment as position: a mean reference cannot reject
    // outliers it has itself been pulled toward, which is how a minority of
    // mirror-flipped sightings used to set the stored orientation degrees off.
    const med = {
      p: [0, 1, 2].map((k) => median(ring.map((e) => e.p[k]))),
      q: quatMedian(ring.map((e) => e.q), OUTLIER_ANGLE_DEG),
    };
    const inliers = ring.filter((e) =>
      Math.hypot(e.p[0] - med.p[0], e.p[1] - med.p[1], e.p[2] - med.p[2]) <= OUTLIER_POS_M &&
      quatAngleDeg(e.q, med.q) <= OUTLIER_ANGLE_DEG);
    if (inliers.length < PROMOTE_MIN_ESTIMATES) return false;
    // Agreement as a share, not a count — see PROMOTE_MIN_INLIER_FRAC. The ring
    // is a rolling window, so a tag that starts being observed properly flushes
    // its old disagreeing estimates within CANDIDATE_RING sightings rather than
    // being locked out by them.
    if (inliers.length < ring.length * PROMOTE_MIN_INLIER_FRAC) {
      // Otherwise this is invisible: the roster keeps reporting the tag as
      // pending with an ever-growing estimate count and never explains why it
      // does not promote.
      if (Date.now() - promoteLogAt > 5000) {
        promoteLogAt = Date.now();
        log(`Marker ${id} not surveyed: only ${inliers.length}/${ring.length} estimates agree ` +
          `(need ${Math.round(PROMOTE_MIN_INLIER_FRAC * 100)}%) — its sightings disagree ` +
          'with each other, not just with the map');
      }
      return false;
    }

    // How many of the estimates came from a fix two known tags agreed on. A
    // one-tag fix cannot be checked against anything: its mirror is undetectable
    // in that frame and it inherits that tag's error whole.
    //
    // Recorded, not enforced. Refusing a tag until it had cross-checked fixes
    // cost the far half of a real room — tags 3 and 5 are never once in frame
    // with tag 0 or 1, so they simply never surveyed, and a map missing them is
    // worse than a map that has them and says how well they are attested. Two
    // coplanar tags would also have satisfied the rule without breaking the
    // ambiguity it exists to catch, so it promised more than it could deliver.
    const verified = inliers.filter((e) => (e.from?.length || 0) >= 2).length;

    const p = [0, 1, 2].map((k) =>
      inliers.reduce((a, e) => a + e.p[k], 0) / inliers.length);
    // Provenance from the *inliers* only: the estimates that were thrown out
    // did not place this tag, so the tags behind them did not either.
    const { from, hops } = provenance(inliers);
    markers.set(id, {
      pose: { p, q: quatMedian(inliers.map((e) => e.q), OUTLIER_ANGLE_DEG) },
      nObs: inliers.length,
      from,
      hops,
      verified,
    });
    candidates.delete(id);
    clearStreaks(id);
    const clipped = clipToPlane(id);
    log(`Marker ${id} surveyed at ${fmtP(markers.get(id).pose.p)} ` +
      `(${inliers.length}/${ring.length} estimates, `
      + `${from.length ? `via ${from.join(' ')}, ${hops} hop(s) from the anchor` : 'off ARCore alone'}`
      + `${clipped ? `, clipped ${markers.get(id).clippedMm} mm onto tag `
        + `${markers.get(id).clippedTo}'s plane` : ''})`);
    scheduleSave();
    return true;
  }

  // How the client's camera model was arrived at, on both pose paths. `guess`
  // is refused the map outright; the derived tiers are allowed but recorded,
  // since a rotated or rescaled model is the difference between a map that is
  // right and one that is consistently a couple of centimetres out.
  function logModelSource(clientId, msg) {
    const src = msg.source ?? (msg.calibrated === false ? 'guess' : 'unreported');
    const scale = Number.isFinite(msg.scale) && Math.abs(msg.scale - 1) > 1e-6
      ? ` scaled x${msg.scale.toFixed(2)}`
      : '';
    const desc = `${src}${scale}${msg.from ? ` from ${msg.from}` : ''}`
      + `${msg.w && msg.h ? ` at ${msg.w}x${msg.h}` : ''}`;
    if (loggedModel.get(clientId) === desc) return;
    loggedModel.set(clientId, desc);
    log(`Client ${clientId} camera model: ${desc}`
      + (src === 'guess'
        ? ' — refused the survey: a ~5% scale error would be permanent in markers.json'
        : ''));
  }

  // Adopting the room origin. Both client kinds need it and neither can do
  // anything at all before it has happened.
  let anchorRejectAt = 0;

  // `modelSource` gates this for the same reason maintainSurvey is gated, and it
  // matters most here: the anchor is the datum everything else is measured
  // against, and nothing ever detects that it is wrong. A client running on the
  // FOV guess must not be the one to define it.
  function bootstrapAnchor(obs, modelSource = undefined) {
    if (anchorId !== null) return false;
    if (modelSource === 'guess') return false;
    const clean = obs.filter((o) => o.err <= ANCHOR_MAX_ERR_PX && o.dist <= ANCHOR_MAX_DIST_M &&
      surveyGrade(o));
    // The anchor's orientation *is* the room frame, and nothing downstream ever
    // detects that the datum is wrong — so it must not be founded on a sighting
    // whose mirror is still plausible. A sighting with only one solution has no
    // ambiguity left to get wrong; prefer those, and fall back to an ambiguous
    // one only when nothing else is on offer rather than refusing to start.
    const seed = clean.find((o) => o.sols.length === 1) ?? clean[0];
    if (seed && seed.sols.length > 1) {
      log(`Marker ${seed.id} anchoring from an ambiguous sighting — its mirror `
        + `reprojects within ${(seed.sols[1].err - seed.sols[0].err).toFixed(2)} px. `
        + 'If the room frame comes out tilted, remove the anchor and re-seed it '
        + 'from a large, square-on tag.');
    }
    if (!seed) {
      // Without this an empty map is silent: tags are seen, rejected for being
      // a fraction over a gate, and the dashboard simply shows nothing with no
      // indication that anything was ever offered.
      const now = Date.now();
      if (obs.length && now - anchorRejectAt > 5000) {
        anchorRejectAt = now;
        log('No anchor yet — tags seen but none clean enough: ' +
          obs.map((o) => `${o.id} at ${o.dist.toFixed(1)} m, ${o.err.toFixed(1)} px`).join('; ') +
          ` (need under ${ANCHOR_MAX_ERR_PX} px and ${ANCHOR_MAX_DIST_M} m)`);
      }
      return false;
    }
    anchorId = seed.id;
    // The datum: measured against nothing, and zero hops from itself.
    markers.set(seed.id, { pose: se3Identity(), nObs: 1, from: [], hops: 0 });
    log(`Marker ${seed.id} anchored as room origin`);
    scheduleSave();
    return true;
  }

  // Of a tag's candidate PnP solutions, the room-pose estimate that agrees best
  // with the estimates already gathered for it. Position is deliberately not
  // part of the score: the mirror ambiguity is almost entirely an orientation
  // difference, and the two solutions' translations can be close enough that
  // including them just dilutes the signal.
  function bestAgreeingEstimate(o, pose, ring) {
    const ref = quatMedian(ring.map((e) => e.q), OUTLIER_ANGLE_DEG);
    let best = null;
    for (const s of o.sols) {
      const est = se3Compose(pose, s.camTag);
      const score = quatAngleDeg(est.q, ref);
      if (!best || score < best.score) best = { score, est };
    }
    return best.est;
  }

  // Every unknown tag seen from a solid fix contributes one room-pose estimate;
  // enough consistent estimates promote it into the map.
  // `needKnownTag` is what separates the two client kinds. Without ARCore the
  // camera pose is only trustworthy while a mapped tag is in frame, so an
  // unknown tag may only be surveyed alongside a known one. An XR client knows
  // where it is continuously, so requiring a second tag in the same frame just
  // makes the tag you are standing next to unsurveyable — which is exactly
  // what it did.
  //
  // `modelSource` is the client's camera-model provenance. A client running on
  // the FOV guess is out by ~5% in scale, and the map is the one thing here that
  // outlives the session: baking that into markers.json is permanent, while a
  // wrong live pose is gone next frame. So a guessed client is still localized
  // against the map, it just may not shape it. The gate lives here rather than
  // at the two call sites because splitting survey maintenance across the
  // /client and XR paths is how the refine half came to be missing on one of
  // them.
  //
  // One refine decision, reported to the diagnostics tap. Both terminal points
  // of the loop below report through here so a harness sees the rejected
  // sightings as well as the accepted ones — the rejects are half the answer to
  // "is this tag being pulled around".
  //
  // `branches` is the counterfactual: pickSolutions leaves o.sols intact, so
  // what the *other* mirror branch would have implied for this tag is still
  // recoverable here, and it is the only place in the pipeline where it is.
  // Composed only when the tap is present — this runs at 10 Hz per tag per
  // client on the live server, where it must cost nothing.
  function reportRefine(verdict, o, m, fix, est, off, dq, others) {
    if (!onRefine) return;
    onRefine({
      id: o.id,
      verdict,
      off,
      dq,
      dist: o.dist,
      err: o.err,
      cos: o.cos,
      px: o.px,
      others: others.map((x) => x.id),
      chosen: o.sols.findIndex((s) => s.camTag === o.camTag),
      branches: o.sols.map((s) => {
        const e = se3Compose(fix, s.camTag);
        return {
          off: Math.hypot(e.p[0] - m.pose.p[0], e.p[1] - m.pose.p[1],
            e.p[2] - m.pose.p[2]),
          dq: quatAngleDeg(m.pose.q, e.q),
        };
      }),
      estQ: [...est.q],
    });
  }

  // How much of a refine step a sighting has earned, in
  // [REFINE_MIN_ALPHA_SCALE, 1]. Every other consumer of an observation weights
  // it by how well conditioned it is; refinement applied a flat REFINE_ALPHA,
  // so a 6 m sighting moved the stored pose exactly as hard as a 1 m one while
  // carrying 2.5x the orientation scatter.
  //
  // d^2/(d^2 + sigma^2): a disagreement well outside the noise passes through
  // whole, one inside it is suppressed in proportion. Clamped at 1 rather than
  // normalised, so this can only ever slow refinement down — REFINE_ALPHA stays
  // the ceiling it always was. Position and orientation are asked separately
  // and the larger wins: a tag that is right where it should be but facing the
  // wrong way still has something to correct, and vice versa.
  function refineScale(o, off, dq) {
    if (!REFINE_NOISE_SCALE) return 1;
    const sp = REFINE_NOISE_M_PER_M * o.dist * REFINE_NOISE_SCALE;
    const sq = REFINE_NOISE_DEG_PER_M * o.dist * REFINE_NOISE_SCALE;
    const gain = Math.max(
      off * off / (off * off + sp * sp),
      dq * dq / (dq * dq + sq * sq));
    return Math.max(REFINE_MIN_ALPHA_SCALE, Math.min(1, gain));
  }

  function maintainSurvey(pose, obs, needKnownTag = true, clientId = undefined,
    modelSource = undefined, K = null) {
    if (modelSource === 'guess') return false;
    const known = obs.filter((o) => markers.has(o.id));
    if (needKnownTag) {
      const strong = known.filter((o) => o.err <= GOOD_MAX_ERR_PX && o.dist <= GOOD_MAX_DIST_M);
      if (!strong.length) return false;
    }
    let changed = false;
    let refined = false;

    // Extend: every unknown tag seen from a solid fix contributes one estimate.
    for (const o of obs) {
      if (markers.has(o.id)) continue;
      // The estimate is this tag's own camera-frame pose composed with the fix,
      // so a tag too small to solve produces a bad estimate however good the
      // fix was. Recording it only buries the good estimates in noise.
      if (!surveyGrade(o)) continue;
      let ring = candidates.get(o.id);
      if (!ring) candidates.set(o.id, (ring = []));
      // pickSolutions cannot help here: it resolves the mirror by asking where
      // the tag's *mapped* pose puts the camera, and this tag has no mapped pose
      // yet. Its own accumulated estimates are the reference instead — a tag on a
      // wall has one room pose, so the solution agreeing with the estimates
      // already collected is the one to record. Without this the extend path took
      // whichever branch reprojected marginally better and left tryPromote's
      // median to out-vote the flips, which works but wastes the ring on them.
      const est = ring.length >= 3
        ? bestAgreeingEstimate(o, pose, ring)
        : se3Compose(pose, o.camTag);
      // Which tags this estimate was measured against — the ones that fused
      // into the camera fix it was composed with. A tag's position is only ever
      // as good as its chain back to the anchor, and nothing else in the map
      // records how long that chain is or whose error it inherits. Empty means
      // the fix came from ARCore carrying the pose with no tag in view, which is
      // the weakest way a tag can enter the map.
      est.from = known.map((k) => k.id);
      ring.push(est);
      if (ring.length > CANDIDATE_RING) ring.shift();
      if (tryPromote(o.id)) changed = true;
    }

    // Refine: nudge a known tag using a camera fix from the *other* tags only,
    // so the update cannot feed back into its own estimate. The anchor is the
    // datum and never moves.
    //
    // "Other" has to mean other *sources*, not merely other ids. A tag surveyed
    // from this one inherited whatever error this one had, so it agrees by
    // construction and is no evidence at all — but it still votes, and it
    // outvotes the tags nearer the anchor that could actually correct the thing.
    // Measured: tag 3 was refined against its own descendant tag 5 in 385 of 696
    // frames against 267 from tag 2, and its stored orientation sat at the
    // equilibrium between the two — 10 deg out, and still 10 deg out after 639
    // sightings, which reads as "refinement is not working" when in fact it had
    // converged, on the wrong answer.
    if (known.length >= 2) {
      for (const o of known) {
        if (o.id === anchorId) continue;
        // A reseed below drops a tag out of the map mid-loop, and `known` was
        // snapshotted before that — so both the tag being refined and the tags
        // it is refined against have to be re-checked, or fusing reads a
        // marker that is no longer there.
        if (!markers.has(o.id)) continue;
        if (!surveyGrade(o)) continue;
        const others = known.filter((x) =>
          x.id !== o.id && markers.has(x.id) && surveyGrade(x) && !descendsFrom(x.id, o.id));
        // This fix is what the map itself is refined against, which is where
        // the per-session orientation bias was traced — the joint solve
        // matters most here.
        const fix = others.length
          ? (jointCameraPose(others, K) ?? fuseCameraPose(others))
          : null;
        if (!fix) continue;
        const est = se3Compose(fix, o.camTag);
        const m = markers.get(o.id);
        const off = Math.hypot(
          est.p[0] - m.pose.p[0], est.p[1] - m.pose.p[1], est.p[2] - m.pose.p[2]);
        // Computed here rather than beside the residual EMAs it feeds, because
        // the disagree gate below reports it too and a rejected sighting's
        // orientation is exactly as interesting as an accepted one's.
        const dq = quatAngleDeg(m.pose.q, est.q);
        // Recorded before the disagree gate, not after: a tag whose every
        // check lands too far to refine would otherwise be indistinguishable
        // on the dashboard from one never seen beside a known tag at all —
        // which is exactly how a deadlocked tag read as "needs another known
        // tag in the same frame" while sitting right next to the anchor.
        m.checkedAtMs = Date.now();
        m.checkOff = off;

        // Persistent, large disagreement is a tag that was moved, not one that
        // is drifting. Averaging towards it would be slow and would drag the
        // neighbours the whole way; forgetting it re-promotes it in
        // PROMOTE_MIN_ESTIMATES sightings from where it actually is now.
        if (off > RESEED_DISAGREE_M) {
          // ...but only when the fix that disagrees can actually be blamed on
          // this tag. Two peer tags disagreeing says nothing about which of
          // them is wrong (REFINE_MIN_OTHERS) — the anchor is the exception:
          // it is the datum, wrong by definition never, so a fix built on it
          // is a sufficient accuser even alone. Without this a two-tag map
          // deadlocks: the disagreement is too large to refine and there is
          // never a second witness to reseed, so a mis-promoted tag sits
          // wrong forever while being looked at right beside the anchor. The
          // streak below still filters the transient mirror flips a lone
          // anchor observation can produce.
          const anchorVouches = others.some((x) => x.id === anchorId);
          if (others.length < REFINE_MIN_OTHERS && !anchorVouches) continue;
          const n = bumpStreak(clientId, o.id);
          if (n >= RESEED_STREAK) {
            markers.delete(o.id);
            candidates.delete(o.id);
            clearStreaks(o.id);
            log(`Marker ${o.id} disagrees with the map by ${off.toFixed(2)} m over `
              + `${n} sightings — dropped, will re-survey where it is now`);
            changed = true;
            scheduleSave();
          }
          // Either way, do not average toward an estimate already judged wrong.
          // At REFINE_ALPHA a 1.4 m disagreement moves the tag ~3 cm per report,
          // ten times a second, toward the very estimate the streak is being
          // counted against: the tag is dragged off its real position, the
          // disagreement grows, and the drop becomes self-fulfilling. Measured
          // as an escalating 0.31 -> 0.39 -> 0.69 -> 1.43 m series on one tag
          // that had not moved at all.
          reportRefine('disagree', o, m, fix, est, off, dq, others);
          continue;
        }
        clearStreak(clientId, o.id);

        // What the tag still wants to move, before it is moved. This is the
        // "am I settled yet" number and the only honest answer to it: a tag
        // whose estimates keep landing 40 mm and 8 degrees away is healing, one
        // whose estimates land on it is done. Smoothed harder than the pose
        // itself so it reads as a trend rather than flickering per sighting.
        m.resid = m.resid === undefined ? off : m.resid + (off - m.resid) * RESID_ALPHA;
        m.residDeg = m.residDeg === undefined ? dq : m.residDeg + (dq - m.residDeg) * RESID_ALPHA;
        m.refinedAtMs = Date.now();
        // Every check that got this far could have disagreed and did not — that
        // is a cross-check, and it must count as one. `verified` used to be
        // computed once at promotion (estimates whose fix used two known tags,
        // i.e. three tags in one frame) and then frozen, so in a room that only
        // ever shows tag pairs every tag read "0 cross-checked" forever while
        // being checked ten times a second.
        m.verified = (m.verified ?? 0) + 1;

        // Before the nudge, not after: every figure reported here — off, dq and
        // both branches — is measured against the stored pose as it stood when
        // this sighting was judged, and the next two lines move it.
        reportRefine('nudge', o, m, fix, est, off, dq, others);

        // Shortened for a poorly conditioned sighting. The bias this is against
        // is not noise the average removes: measured, a session's whole stream
        // sits 1.0-3.6 deg (7.5 worst) from where the map started it, and the
        // direction is different every session, so the map converges on
        // whatever geometry that session happened to use. Weighting cannot
        // remove that — it dilutes it, by letting the geometries that scatter
        // least do most of the moving.
        const alpha = REFINE_ALPHA * refineScale(o, off, dq);

        // Toward this sighting, and a robust aggregator here was tried and
        // measured to buy nothing — do not reach for one again without new
        // evidence. The premise was that a plain EMA is a mean and a mean over
        // a contaminated stream converges on the contamination's equilibrium,
        // which is true only when the contamination is *asymmetric*. Measured
        // over 74 journals (replay-survey.js --refine, the onRefine tap above):
        // the angle between quatMean and quatMedian of a session's estimate
        // stream is 0.21-1.16 deg at the median and 5.05 worst, i.e. the
        // outliers cancel. Nudging toward the median of a 25-sample ring
        // instead moved per-session drift by nothing (worst tag 12.15 -> 13.05
        // deg, next 7.05 -> 7.42).
        //
        // What the drift actually is: each session's whole stream sits 1.0-3.6
        // deg (7.5 worst) from the pose the map started that session with, and
        // refinement converges on it correctly and fast — perturb a tag 30 deg
        // and it is back within 2.9 deg in 172 nudges, landing where the
        // unperturbed run lands. So sessions genuinely disagree about where a
        // tag points, and the fix is upstream in what fuseCameraPose is built
        // from, not in how these estimates are averaged.
        for (let k = 0; k < 3; k++) {
          m.pose.p[k] += (est.p[k] - m.pose.p[k]) * alpha;
        }
        m.pose.q = quatNudge(m.pose.q, est.q, alpha);
        // Re-applied after every nudge, not once at promotion: the nudge is what
        // keeps pushing the tag back off the plane, so a one-time clip would be
        // undone within seconds of the next sighting.
        clipToPlane(o.id);
        m.nObs++;
        refined = true;
        scheduleSave();
      }
    }
    // A refinement changes the map as surely as a promotion does, and none of it
    // reached the dashboard: `changed` was set only by promote and reseed, so a
    // tag healing ten degrees over ten minutes was invisible and refinement
    // looked like it was not running at all. Throttled because this path runs at
    // 10 Hz per client and every notification ships the whole map.
    if (refined && Date.now() - lastRefinePush > REFINE_PUSH_MS) {
      lastRefinePush = Date.now();
      changed = true;
    }
    return changed;
  }

  // Tags taped flat to one wall are coplanar in fact, and the survey has no way
  // to know it: each is solved independently and lands a centimetre or two off
  // the plane. That gap is not geometry, it is the accuracy floor of a single
  // planar solve — 13 mm across a 1.78 m separation is 0.42 deg of tag
  // orientation, which is inside the noise of an 88 px quad and inside what a
  // strip of tape or a slightly bowed print contributes. Refinement converges
  // onto it faithfully and can never remove it, because the estimates it is
  // averaging are themselves centred there.
  //
  // So it is asserted instead of measured: where two tags point the same way and
  // the gap is small enough to be that noise, the tag is pulled onto the other's
  // plane along the normal. Only the out-of-plane component moves; where the tag
  // sits *within* the wall is still entirely measured.
  //
  // Always onto the plane of the tag nearer the anchor, never the reverse. The
  // anchor is the datum and is exact by definition, and a rule without a
  // direction would let two tags take turns dragging each other.
  // (The plane predicate and its thresholds live in pose-math.js — the walls
  // module groups tags by the same test, and the two must not drift apart.)

  // Distance from the datum, for deciding which of two tags is the authority.
  // The anchor is always 0 whatever its record says — it *is* the datum. A tag
  // whose chain is unknown (promoted while ARCore carried the pose, so `from` is
  // empty and `hops` is null) sits at the back rather than being excluded: not
  // knowing how a tag got into the map is a reason to trust it less than the
  // others, not a reason to leave it off a wall it is plainly on. Gating the
  // clip on a finite `hops` is what silently disabled it for exactly the tag
  // that needed it.
  function datumDepth(id, m) {
    if (id === anchorId) return 0;
    return Number.isFinite(m.hops) ? m.hops : Infinity;
  }

  function clipToPlane(id) {
    const m = markers.get(id);
    if (!m || id === anchorId) return false;
    const depth = datumDepth(id, m);
    const n = quatRotate(m.pose.q, [0, 0, 1]);
    let best = null;
    for (const [otherId, other] of markers) {
      // Strictly nearer the datum: equal depth is two tags with the same claim
      // on being right, and clipping either onto the other is a coin flip. Two
      // unknown-chain tags are both Infinity, so they leave each other alone.
      if (otherId === id || datumDepth(otherId, other) >= depth) continue;
      const { cos, d, on } = tagPlaneAgreement(m.pose, other.pose);
      // Parallel either way — a back-to-back pair is still one plane claim
      // for the clip's purposes.
      if (Math.abs(cos) < CLIP_PARALLEL_COS) continue;
      if (Math.abs(d) > CLIP_PLANE_M) continue;
      const od = datumDepth(otherId, other);
      if (!best || od < best.depth || (od === best.depth && Math.abs(d) < Math.abs(best.d))) {
        best = { d, on, otherId, depth: od };
      }
    }
    if (!best) {
      if (m.clippedTo !== undefined) m.clippedTo = null;
      return false;
    }
    for (let k = 0; k < 3; k++) m.pose.p[k] -= best.d * best.on[k];

    // The same assertion applied to orientation. If the two tags really are on
    // one flat wall then their normals are the same vector, not merely a couple
    // of degrees apart, and the difference is the same planar-solve noise the
    // position clip removes — except here it is the more expensive error, since
    // a tag's orientation is a lever arm: the 0.42 deg that puts a tag 13 mm off
    // the wall at 1.78 m puts a camera 31 mm out at 4.3 m.
    //
    // Only the normal is snapped. Rotation *about* the normal is how the tag is
    // turned on the wall — that is measured, not assumed, and quatFromTo takes
    // the shortest arc precisely so it survives untouched.
    const target = n[0] * best.on[0] + n[1] * best.on[1] + n[2] * best.on[2] < 0
      ? [-best.on[0], -best.on[1], -best.on[2]]   // mounted the other way up
      : best.on;
    const tilt = quatFromTo(n, target);
    m.pose.q = quatNormalize(quatMul(tilt, m.pose.q));

    m.clippedTo = best.otherId;
    m.clippedMm = Math.round(Math.abs(best.d) * 1000);
    m.clippedDeg = Math.acos(Math.min(1, Math.abs(
      n[0] * target[0] + n[1] * target[1] + n[2] * target[2]))) * 180 / Math.PI;
    return true;
  }

  // Was `id` surveyed from `ancestorId`, directly or through any chain? Used to
  // keep a tag's own descendants from refining it — see the note above the
  // refine loop. A map written before provenance was recorded has no `from`, so
  // this answers false for everything and the old behaviour stands.
  function descendsFrom(id, ancestorId, seen = new Set()) {
    if (id === ancestorId) return true;
    // Provenance is a chain, not a tree — two tags can name each other once a
    // reseed re-promotes one of them from the other. Guarding the walk is what
    // stops that becoming a hang.
    if (seen.has(id)) return false;
    seen.add(id);
    const m = markers.get(id);
    return !!m && (m.from || []).some((parent) => descendsFrom(parent, ancestorId, seen));
  }

  // Throttle state for telling the viewer about refinements; see maintainSurvey.
  let lastRefinePush = 0;

  let dropLogAt = 0;

  // `fx` is only used to reconstruct an apparent tag size for a client that did
  // not measure one itself; a client that did is believed over the model, since
  // the whole point of the figure is to be independent of the camera model.
  function buildObs(tags, fx = null) {
    const out = [];
    const dropped = [];
    for (const t of tags || []) {
      const px = t.px ?? null;
      // A tag may carry two PnP solutions (planar mirror ambiguity). Both
      // are kept while they pass the gates; pickSolutions decides later with
      // room-frame context this side has and the client does not.
      const sols = [t, ...(t.alt ? [t.alt] : [])]
        .map((s) => {
          const dist = Math.hypot(s.tvec[0], s.tvec[1], s.tvec[2]);
          // Cosine of the viewing angle off the tag's normal: 1 is straight on.
          const n = quatRotate(quatFromRvec(s.rvec), [0, 0, 1]);
          const cos = dist > 1e-6
            ? Math.abs(n[0] * s.tvec[0] + n[1] * s.tvec[1] + n[2] * s.tvec[2]) / dist
            : 1;
          return {
            err: s.err,
            dist,
            cos,
            px: px ?? (fx ? markerSizeM * fx / dist : null),
            camTag: se3FromRvecTvec(s.rvec, s.tvec),
          };
        })
        .filter((s) => s.err <= OBS_MAX_ERR_PX && s.dist <= OBS_MAX_DIST_M &&
          s.cos >= OBS_MIN_COS_ANGLE);
      if (!sols.length) {
        // Every gate here is silent by design, which is fine until they reject
        // *everything* — then the map stays empty, the dashboard stays blank,
        // and nothing anywhere says a tag was ever offered.
        const d = Math.hypot(t.tvec[0], t.tvec[1], t.tvec[2]);
        dropped.push(`${t.id} at ${d.toFixed(1)} m, ${t.err.toFixed(1)} px`);
        continue;
      }
      // The raw corner measurement rides along for the joint multi-tag solve.
      // Both PnP branches are interpretations of these same eight numbers, so
      // they belong to the observation, not to a solution.
      const corners = Array.isArray(t.corners) && t.corners.length === 8
        ? t.corners
        : null;
      out.push({ id: t.id, sols, corners, ...sols[0] });
    }
    if (!out.length && dropped.length) {
      const now = Date.now();
      if (now - dropLogAt > 5000) {
        dropLogAt = now;
        log(`Every tag rejected: ${dropped.join('; ')} ` +
          `(limits: ${OBS_MAX_ERR_PX} px, ${OBS_MAX_DIST_M} m, ` +
          `${Math.round(Math.acos(OBS_MIN_COS_ANGLE) * 180 / Math.PI)} deg off-normal)`);
      }
    }
    return out;
  }

  // Position plus orientation disagreement, in metres (1° ≈ 2 cm at room
  // scale — enough to matter, not enough to drown the position term).
  function poseDisagree(a, b) {
    return Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) +
      quatAngleDeg(a.q, b.q) * 0.02;
  }

  // Resolve the mirror ambiguity per tag: the wrong solution teleports the
  // implied camera, so pick whichever agrees with the pose implied by the
  // *other* tags — or, alone, with the reference (the client's last fix).
  function pickSolutions(known, ref) {
    for (const o of known) {
      if (o.sols.length < 2) continue;
      const others = known.filter((x) => x !== o);
      const fused = others.length ? fuseCameraPose(others) : null;
      if (!fused && !ref) continue;
      // Both references when both exist, rather than the other tags alone. Tags
      // spread through the room do arbitrate each other, but tags on one wall
      // are a single planar target between them and carry the very ambiguity
      // being resolved: flip them together and they agree with each other just
      // as well. Measured on two tags 1.78 m apart on one wall — the implied
      // position of the second depended only on the *first* tag's branch, and
      // the wrong branch put it 0.28 m off the wall in half the frames, which
      // held its refined position at an equilibrium between the two.
      // ARCore never consults a tag, so it is the only thing in the frame that
      // can break that tie.
      let best = null;
      for (const s of o.sols) {
        const cam = se3Compose(markers.get(o.id).pose, se3Invert(s.camTag));
        const score = (fused ? poseDisagree(cam, fused) : 0)
          + (ref ? poseDisagree(cam, ref) : 0);
        if (!best || score < best.score) best = { s, score };
      }
      o.camTag = best.s.camTag;
      o.err = best.s.err;
      o.dist = best.s.dist;
      o.px = best.s.px;
    }
  }

  // The largest set of candidate transforms that agree with each other. Both
  // branches of a lone tag put a room<-session transform on the table every
  // frame; the true one names the same transform each time because the camera
  // really is rigid against ARCore, and the mirror — a reflection about the line
  // of sight — names a different one as that line turns. So the answer is
  // whichever value keeps being repeated, and this is the one place that is
  // worked out: founding the alignment and choosing a branch under an existing
  // one are the same question asked at two moments.
  function tightestCluster(samples, tol) {
    let best = null;
    for (const c of samples) {
      const n = samples.filter((x) => poseDisagree(x, c) <= tol).length;
      if (!best || n > best.n) best = { T: c, n };
    }
    return best;
  }

  // Which branch of a lone ambiguous tag the alignment is founded on. Returns
  // { T, resolved } to commit, or null while it is still undecided — see
  // xrFound for why this cannot be answered from one frame. `resolved: false`
  // means the deadline fired and the branch question is still open; the caller
  // must keep the alignment quarantined from the survey (watchBranch below)
  // until the same test eventually passes.
  const FOUND_MAX_SAMPLES = 60;

  // One frame's contribution to the branch test, shared between founding and
  // the post-founding watch — the same question asked at two moments. Every
  // PnP branch of the first known tag puts a candidate room<-session transform
  // on the table; pickSolutions leaves o.sols intact, so both branches are
  // sampled regardless of which one the fix used.
  function sampleBranches(cur, known, xrT) {
    cur.span = Math.max(cur.span, Math.hypot(
      xrT.p[0] - cur.fromP[0], xrT.p[1] - cur.fromP[1], xrT.p[2] - cur.fromP[2]));
    const mp = markers.get(known[0].id).pose;
    for (const s of known[0].sols) {
      const cam = se3Compose(mp, se3Invert(s.camTag));
      cur.samples.push(se3Compose(cam, se3Invert(xrT)));
    }
    // Bounded because this runs at 10 Hz and the clustering below is
    // quadratic; the newest frames also carry the most baseline behind them.
    if (cur.samples.length > FOUND_MAX_SAMPLES) {
      cur.samples.splice(0, cur.samples.length - FOUND_MAX_SAMPLES);
    }
  }

  // Both branches sit still while the camera does, so the baseline is what
  // makes this a test rather than a coin flip with extra steps.
  function decidedBranch(cur) {
    if (cur.span < FOUND_MOVE_M) return null;
    const best = tightestCluster(cur.samples, FOUND_TOL);
    return best && best.n >= FOUND_MIN_CLUSTER ? best : null;
  }

  // Called on every frame while there is no alignment, tags in view or not: a
  // client that anchors a tag and then walks away never sees it again, and a
  // deadline that only ticked on tagged frames would never fire — the client
  // would simply never localize. Measured: one replayed journal anchored tag 0,
  // lost sight of it, and finished the session with a one-tag map.
  function foundAlignment(clientId, sessionId, known, xrT, est) {
    const now = Date.now();
    // Two tags arbitrate each other and pickSolutions has already used them, so
    // `est` is as good as it is going to get and waiting would only cost a fix.
    if (known.length > 1) {
      xrFound.delete(clientId);
      return est ? { T: est, resolved: true } : null;
    }
    let cur = xrFound.get(clientId);
    if (cur && cur.sid !== sessionId) cur = undefined;
    // One tag defers even when this frame offered a single solution: the branch
    // is decided across frames, not within one, and the frame that founds an
    // alignment is routinely the frame whose mirror twin the detector did not
    // reconstruct. Measured — the worst of four replayed maps founded on a
    // single-solution sighting and came out pitched ~16 degrees.
    if (known.length === 1) {
      if (!cur) {
        cur = { sid: sessionId, at: now, fromP: xrT.p, span: 0, samples: [], lastEst: null };
        xrFound.set(clientId, cur);
      }
      cur.lastEst = est;
      sampleBranches(cur, known, xrT);
    }
    if (!cur) return null;   // nothing pending and nothing offered

    const best = decidedBranch(cur);
    if (best) {
      xrFound.delete(clientId);
      log(`Client ${clientId} XR alignment founded on the branch that held still`
        + ` — ${best.n}/${cur.samples.length} candidates agree over `
        + `${cur.span.toFixed(2)} m of camera motion`);
      return { T: best.T, resolved: true };
    }
    if (now - cur.at > FOUND_MAX_MS && cur.lastEst) {
      // Founded anyway — refusing forever would leave a client held still
      // unlocalized — but the sample ring is deliberately kept: the branch
      // question stays open and watchBranch keeps asking it under the
      // committed alignment. Being wrong past this point costs the map, not
      // a pose, and the map can wait.
      log(`Client ${clientId} XR alignment founded on an unresolved mirror after `
        + `${((now - cur.at) / 1000).toFixed(0)}s — ${cur.span.toFixed(2)} m of camera `
        + 'motion was not enough to tell the two branches apart. Look at the anchor '
        + 'tag from off to one side; nothing is surveyed against this frame until '
        + 'the branch is resolved.');
      return { T: cur.lastEst, resolved: false };
    }
    return null;
  }

  // The founding question, still open under a committed alignment. A give-up
  // founding accepted a possibly-mirrored transform so the client could
  // localize at all; this keeps running the same moving-baseline test — same
  // sample ring, no deadline — and either confirms the committed branch or
  // re-founds the alignment onto the branch that actually held still. Until
  // one of those happens the alignment stays quarantined from the survey
  // (A.unresolved gates extPose): a tag surveyed against a flipped frame
  // lands permanently wrong — measured 0.55 m off, promoted one second after
  // such a founding — while a wrong live pose is gone next frame.
  function watchBranch(clientId, sessionId, known, xrT, A) {
    let cur = xrFound.get(clientId);
    if (cur && cur.sid !== sessionId) {
      xrFound.delete(clientId);
      cur = undefined;
    }
    if (!known.length) return;
    if (!cur) {
      cur = {
        sid: sessionId, at: Date.now(), fromP: xrT.p, span: 0, samples: [], lastEst: null,
      };
      xrFound.set(clientId, cur);
    }
    sampleBranches(cur, known, xrT);
    const best = decidedBranch(cur);
    if (!best) return;
    xrFound.delete(clientId);
    A.unresolved = false;
    const dp = Math.hypot(
      best.T.p[0] - A.T.p[0], best.T.p[1] - A.T.p[1], best.T.p[2] - A.T.p[2]);
    if (poseDisagree(best.T, A.T) <= FOUND_TOL) {
      log(`Client ${clientId} XR alignment branch confirmed — ${best.n}/`
        + `${cur.samples.length} candidates agree over ${cur.span.toFixed(2)} m `
        + 'of camera motion; surveying against this frame enabled');
    } else {
      A.T = best.T;
      log(`Client ${clientId} XR alignment was founded on the wrong branch — `
        + `re-founded ${dp.toFixed(2)} m away (${best.n}/${cur.samples.length} `
        + `candidates over ${cur.span.toFixed(2)} m of motion)`);
    }
  }

  return {
    load,
    predictPose,

    // Coverage of the joint multi-tag solve, for the replay harness — if the
    // joint path rarely runs, the whole feature is moot and that must be a
    // number, not an assumption.
    jointStats() {
      return { ...jointStats };
    },

    markerSize() {
      return markerSizeM;
    },

    // The printed marker size is the room's only metric datum: every distance
    // the survey reports scales with it. Changing it therefore cannot keep the
    // map — those positions were measured in the old scale, and a mixture of
    // the two is worse than either. Same reset as pulling the anchor.
    setMarkerSize(m) {
      if (!(m > 0) || m === markerSizeM) return false;
      const was = markerSizeM;
      markerSizeM = m;
      anchorId = null;
      markers.clear();
      candidates.clear();
      lastFix.clear();
      track.clear();
      xrAlign.clear();
      xrFound.clear();
      forgetJitter();
      reseedStreak.clear();
      log(`Marker size ${(was * 1000).toFixed(0)} mm -> ${(m * 1000).toFixed(0)} mm `
        + '— survey reset, every tag must be re-observed');
      scheduleSave();
      return true;
    },

    // One XR pose report: the camera's pose in the session frame, plus any
    // tags visible in that same frame. Returns the room-frame pose.
    alignXr(clientId, xr, tags, sessionId = null, intrinsics = null,
      modelSource = undefined) {
      const xrT = { p: xr.p, q: xr.q };
      let prev = xrAlign.get(clientId);
      // An alignment describes one ARCore session's frame, whose origin is
      // wherever that session started. A new session picks a new one, so the
      // old transform is not stale — it is meaningless. It also cannot be
      // corrected into place: every new fix lands however far the two origins
      // happen to sit apart, the jump gate below reads that as a bad fix, and
      // the client keeps reporting a pose in a dead session's frame while
      // mapping paints through it. Keyed by clientId, which survives a
      // reconnect, so the socket closing is not the signal — the session id is.
      if (prev && prev.sid !== sessionId) {
        xrAlign.delete(clientId);
        xrFound.delete(clientId);
        forgetJitter(clientId);
        prev = undefined;
        log(`Client ${clientId} started a new XR session — alignment dropped`);
      }
      // Accrued on every report, tags or none: a client that walks the length of
      // the room seeing nothing and only then sights a tag has to arrive at that
      // sighting with the motion it actually made, or the correction it needs
      // most is the one given the smallest gain.
      // Before ref/pickSolutions below, not merely before updateSlip: on a
      // stepped frame se3Compose(prev.T, xrT) is the stepped pose, and handing
      // that to pickSolutions as the mirror reference resolves every tag's
      // ambiguity against a frame that is a metre out.
      if (prev) {
        const jumped = accrueMotion(prev, xrT, Date.now());
        if (jumped) tripStep(clientId, prev, jumped);
      }
      // The camera model, once per session. Every pose error that is not noise
      // is either this or the tag size, and both were being assumed rather than
      // observed. cx/cy far from the image centre, or fx != fy, means the
      // intrinsics do not describe the image the corners were measured in —
      // which biases orientation while leaving reprojection error small,
      // because PnP happily fits the model it is handed.
      if (intrinsics && loggedIntrinsics.get(clientId) !== sessionId) {
        loggedIntrinsics.set(clientId, sessionId);
        const { fx, fy, cx, cy, w, h } = intrinsics;
        // The principal point is only readable against the frame it indexes, so
        // the offset from the image centre is spelled out rather than left to be
        // worked out from two numbers on different lines. A real lens sits
        // within a percent or so of centre; several percent in one axis while
        // the other is exactly centred is not a lens at all, it is a projection
        // that describes something other than this image.
        const size = w && h ? `${w}x${h} ` : '';
        const off = w && h
          ? `, off centre by ${(cx - w / 2).toFixed(1)},${(cy - h / 2).toFixed(1)} px `
            + `(${(100 * (cx - w / 2) / w).toFixed(1)}%,${(100 * (cy - h / 2) / h).toFixed(1)}%)`
          : ' (frame size not reported — cannot say if that is the centre)';
        log(`Client ${clientId} camera model: ${size}fx ${fx.toFixed(1)} fy ${fy.toFixed(1)}`
          + ` (fy/fx ${(fy / fx).toFixed(4)}), principal point ${cx.toFixed(1)},${cy.toFixed(1)}`
          + off);
        // Where an off-centre principal point comes from, on the one path that
        // can answer it. A camera image's own frustum is centred; a skew means
        // the projection is the display's, and the aspect pair says why (the
        // camera image gets cropped or letterboxed to fill a screen of a
        // different shape, and the skew is that crop). Reported together
        // because either number alone is arguable and the pair is not.
        const { proj, viewport } = intrinsics;
        if (proj && w && h) {
          const va = viewport ? viewport[0] / viewport[1] : null;
          log(`Client ${clientId} projection: skew ${proj[8].toFixed(4)},${proj[9].toFixed(4)}`
            + ` (0,0 for a camera frustum), camera aspect ${(w / h).toFixed(3)}`
            + (va ? `, viewport ${viewport[0]}x${viewport[1]} aspect ${va.toFixed(3)}` : '')
            + (va && Math.abs(va - w / h) > 0.01
              ? ' — these differ, so this projection does not describe the camera image'
              : ''));
        }
      }
      const obs = buildObs(tags, intrinsics ? intrinsics.fx : null);
      // What the server actually received, as opposed to what was in shot. A
      // tag in frame but undecoded (small, far, oblique — 640 px camera-access
      // frames run out of range around 3.7 m) leaves no trace anywhere else,
      // and "the map only has one tag" looks identical whether the second tag
      // was never seen, was seen and rejected, or was seen and is still
      // gathering estimates. Throttled: this is a 10 Hz path.
      if (Date.now() - lastSeenLog > 3000) {
        lastSeenLog = Date.now();
        // Apparent tag size in pixels is what actually bounds a planar pose:
        // orientation error on a small quad is several degrees however clean
        // the reprojection residual looks, because PnP fits whatever model it
        // is handed. Reprojection error says the fit is self-consistent; this
        // says whether there was enough of a tag to fit.
        const seen = obs.map((o) => {
          const px = o.px == null ? '' : ` ${o.px.toFixed(0)}px`;
          return `${o.id}@${o.dist.toFixed(1)}m${px} ${o.err.toFixed(1)}err`;
        }).join(', ');
        const pend = [...candidates].map(([id, r]) => `${id}:${r.length}/${PROMOTE_MIN_ESTIMATES}`);
        log(`Client ${clientId} sees [${seen || 'nothing'}]`
          + `, known [${[...markers.keys()].join(' ')}]`
          + `, promoting [${pend.join(' ') || 'none'}]`);
      }
      // Without this an XR client can never start a survey, and once the map
      // is emptied it can never recover one either — it consumes markers but
      // had no way to create them.
      let mapChanged = bootstrapAnchor(obs, modelSource);
      const known = obs.filter((o) => markers.has(o.id));
      // ARCore's own pose, mapped through the current alignment, is a far
      // better mirror reference than anything the tag path can produce on its
      // own — it knows where the camera is without consulting the tag at all.
      // Unless the session frame is slipping: then prev.T ∘ xrT is exactly the
      // runaway pose, and the reference falls back to the client's fresh last
      // fix — the same reference the tag-only path uses.
      let ref = null;
      if (prev && prev.slip && prev.slip.on) {
        const lf = lastFix.get(clientId);
        if (lf && Date.now() - lf.at < JUMP_HISTORY_TTL_MS) ref = lf.pose;
      } else if (prev) {
        ref = se3Compose(prev.T, xrT);
      }
      pickSolutions(known, ref);
      // The joint solve first: with two or more mapped tags off one plane it
      // has no mirror ambiguity at all, where the fuse can only average over
      // whichever branches pickSolutions kept.
      const camRoom = known.length
        ? (jointCameraPose(known, intrinsics) ?? fuseCameraPose(known, ref))
        : null;

      // A tag in this frame only counts as confirming the alignment if its fix
      // was actually folded in. One thrown away by the jump gate says the
      // opposite, and reporting that as 'good' is how a wrong room frame looks
      // healthy on the dashboard.
      let confirmed = false;
      let alpha = null;      // the gain actually spent, for the steadiness log
      // Set while the founding branch is still undecided: camRoom exists but may
      // be the mirror, and nothing may be built on it yet.
      let founding = false;
      const est = camRoom ? se3Compose(camRoom, se3Invert(xrT)) : null;
      // 'recovered' means updateSlip just re-founded the alignment on this
      // very fix — which is a confirmation, and must not fall through to the
      // nudge (est against the brand-new T is a comparison with itself).
      const slipState = prev ? updateSlip(clientId, prev, est, xrT) : 'ok';
      const slipping = slipState === 'slipping';
      if (slipState === 'recovered') confirmed = true;
      if (!prev) {
        // Runs with or without a tag this frame — see foundAlignment.
        const found = foundAlignment(clientId, sessionId, known, xrT, est);
        if (!found) {
          founding = !!camRoom;
        } else {
          xrAlign.set(clientId, {
            T: found.T, sid: sessionId, nObs: 1, at: Date.now(), rej: null,
            lastXr: xrT, moved: 0, lastAt: Date.now(),
            unresolved: !found.resolved,
          });
          log(`Client ${clientId} XR frame aligned to the room — `
            + (known.length
              ? `${known.length} tag(s) [${known.map((o) => o.id).join(', ')}], `
                + `worst ${Math.max(...known.map((o) => o.err)).toFixed(2)} px `
                + `at ${Math.max(...known.map((o) => o.dist)).toFixed(2)} m`
              : 'on the last fix before the tag went out of view'));
          confirmed = true;
        }
      } else if (camRoom && slipState === 'ok') {
        // The nudge, the reject counter and the re-acquire all assume a
        // stationary session frame with only the fix able to be wrong; while
        // the frame slips, every fix would be blamed for the frame's motion.
        const jump = Math.hypot(
          est.p[0] - prev.T.p[0], est.p[1] - prev.T.p[1], est.p[2] - prev.T.p[2]);
        // A good tag fix moves the alignment by the drift since the last
        // sighting — centimetres. A metre means the fix is wrong, not that
        // ARCore lost a metre.
        //
        // This nudge was replaced once by a fit over a window of
        // correspondences, which averaged sighting noise down to ~4 mm but
        // could not recover from a bad *first* alignment: with no reference
        // to reject the mirrored PnP solution, sighting one poisoned the
        // window for its whole life and the room frame stayed wrong. The EMA
        // is noisier and always walks away from a bad start. Any future
        // attempt needs a way to decide the whole window is wrong and throw
        // it out, not just to average it better.
        if (jump <= XR_ALIGN_JUMP_M) {
          alpha = alignAlpha(prev.moved);
          for (let k = 0; k < 3; k++) {
            prev.T.p[k] += (est.p[k] - prev.T.p[k]) * alpha;
          }
          prev.T.q = quatNudge(prev.T.q, est.q, alpha);
          prev.moved = 0;
          prev.nObs++;
          prev.at = Date.now();
          prev.rej = null;
          confirmed = true;
        } else {
          // Rejected fixes that agree with each other are not noise: they are
          // the alignment being wrong in a fixed direction, which is what a
          // relocalization mid-session looks like (the session id catches a
          // new session, nothing catches ARCore moving its own origin under
          // one). Without an escape the gate is a permanent deadlock — it
          // refuses every correction precisely because the thing it is
          // protecting has already drifted out of reach.
          const r = prev.rej;
          const agrees = r && Math.hypot(
            est.p[0] - r.p[0], est.p[1] - r.p[1], est.p[2] - r.p[2]) <= XR_ALIGN_JUMP_M;
          prev.rej = { p: est.p, n: agrees ? r.n + 1 : 1 };
          if (prev.rej.n >= XR_ALIGN_MAX_REJECTS) {
            log(`Client ${clientId} XR alignment re-acquired — ` +
              `${prev.rej.n} consistent fixes disagreed with it by ` +
              `${jump.toFixed(2)} m`);
            // The jitter window straddles the swap otherwise: its ARCore half
            // was measured against the alignment just replaced, so the residual
            // against the new one reports the distance between two coordinate
            // systems as steadiness. walls.js gates permanent grid evidence on
            // that number. The slip recovery has always done this; this branch
            // replaces the alignment just as completely and did not.
            forgetJitter(clientId);
            xrAlign.set(clientId, {
              T: est, sid: sessionId, nObs: 1, at: Date.now(), rej: null,
              lastXr: xrT, moved: 0, lastAt: prev.lastAt,
              // Slip state describes the session frame, not this alignment
              // instance. A diverging frame forces a re-acquire about every
              // XR_ALIGN_MAX_REJECTS fixes, and dropping the history here
              // restarted the slip counter each time — the one failure the
              // detector exists for was the one that kept resetting it.
              slip: prev.slip,
              // Doubt survives a re-acquire too: est was picked against the
              // very alignment being replaced, so it inherits its mirror.
              unresolved: prev.unresolved,
            });
            confirmed = true;
          }
        }
      }

      const A = xrAlign.get(clientId);
      // Before roomPose is derived, so a re-found transform is used the same
      // frame it is decided. Not while slipping — the session frame is moving
      // under the samples, which is exactly the noise the cluster cannot vote
      // down.
      if (A && A.unresolved && !slipping) watchBranch(clientId, sessionId, known, xrT, A);
      // Same conditions the survey itself trusts: a tag confirmed the alignment
      // this frame, its branch is not still in doubt, and the session frame is
      // not moving under it. A mirrored or slipping alignment reports a
      // gravity direction as wrong as everything else derived from it, and this
      // one would accuse the anchor of the alignment's fault.
      if (A && confirmed && !A.unresolved && !slipping) checkGravity(A);
      const roomPose = A ? se3Compose(A.T, xrT) : null;
      // ARCore's pose is steadier than anything the tags alone produce, so a
      // survey grown from it is better, not worse — but only extend while a
      // tag actually confirms the alignment this frame.
      // Which pose an unknown tag is surveyed against decides how good its
      // position is. When a known tag is in this very frame, the camera pose
      // solved from it is tight tag-to-tag geometry with no tracking error in
      // it at all — always prefer that. ARCore's pose is the fallback for the
      // tag you are standing next to with nothing else in view, and it carries
      // the alignment error plus whatever drift has accumulated, so it is used
      // only when there is no alternative and only while a sighting is recent.
      //
      // Extension must not sit behind the alignment. It only needs a room-frame
      // camera pose and camRoom is one, solved from tags with no alignment in
      // it at all. Gating it on the alignment deadlocked a fresh map against
      // the two-tag seed rule: the anchor is the only known tag, the seed wants
      // two, and the code that would promote a second never ran.
      // While slipping the aligned pose is not a pose, so there is nothing
      // whose steadiness could honestly be measured.
      const jitter = A && roomPose && !slipping
        ? trackJitter(clientId, xrT.p, roomPose.p, A.T, confirmed)
        : null;
      if (jitter && Date.now() - lastJitterLog > 3000) {
        lastJitterLog = Date.now();
        // The position itself, not just how much it wandered: a spread figure
        // says a pose is unsteady but never says where it went, and "steady at
        // the wrong place" and "unsteady around the right one" are different
        // faults that the millimetre count alone cannot tell apart.
        // The gain rides along because a pose that got steadier and a deadband
        // that swallowed the motion look identical from the millimetre counts
        // alone — one is the schedule working, the other is it stuck shut.
        log(`Client ${clientId} steadiness: phone moved ${jitter.movedMm} mm, `
          + `fix wandered ${jitter.jitterMm} mm (rms over ${jitter.n} fixes / `
          + `${JITTER_WINDOW_MS / 1000}s, ${known.length} tags, gain `
          + `${alpha === null ? '—' : alpha.toFixed(2)}) at ${fmtP(roomPose.p)}`);
      }
      const alignFresh = A && Date.now() - A.at < ALIGN_FRESH_MS;
      // While slipping the fix is reported the way the tag-only path reports
      // one: gated against a mirror flip, smoothed, and kept away from the
      // survey when the gate held it back.
      const slipReport = slipping && camRoom ? reportFix(clientId, camRoom) : null;
      // Nothing is surveyed off an undecided branch. camRoom is available while
      // founding, and using it is exactly how tags end up placed against a
      // flipped frame — the failure this is here to prevent. A slipping
      // alignment is banned the same way: camRoom stays usable (no alignment
      // in it), the ARCore-carried fallback does not.
      // An alignment founded on an unresolved mirror is quarantined exactly
      // like founding itself: the room frame may be flipped, and even camRoom
      // is contaminated — pickSolutions resolved its mirror against this very
      // alignment. A tag surveyed here lands permanently wrong (measured:
      // 0.55 m off, promoted one second after such a founding) while a wrong
      // live pose is gone next frame, so localization keeps running and only
      // the survey waits for watchBranch.
      const extPose = founding || (A && A.unresolved) ? null
        : slipping ? (slipReport && !slipReport.held ? camRoom : null)
          : (camRoom || (alignFresh ? roomPose : null));
      if (extPose && maintainSurvey(extPose, obs, false, clientId, modelSource,
        intrinsics)) mapChanged = true;
      // Whether this report may become *permanent* state elsewhere (the walls
      // grid is as durable as markers.json). The survey's own quarantine —
      // founding, unresolved mirror, slip — is invisible outside this closure,
      // and quality alone cannot stand in for it: 'good' is reported while an
      // unresolved alignment is still being tested.
      const mapSafe = !!extPose;
      if (!A) return { pose: null, quality: 'unaligned', mapChanged, mapSafe };
      if (slipping) {
        if (slipReport) {
          return {
            pose: slipReport.pose, quality: 'slipping', mapChanged, mapSafe,
            alignedObs: A.nObs, jitter: null,
          };
        }
        // No tag this frame: dead-reckon on the reported track exactly like
        // the tag path — ARCore is the one thing that must not carry it here.
        const guess = predictPose(clientId);
        return {
          pose: guess, quality: guess ? 'dead' : 'slipping', mapChanged, mapSafe,
          alignedObs: A.nObs, jitter: null,
        };
      }
      return {
        pose: roomPose,
        mapChanged,
        // 'good' means a tag confirmed this frame; 'tracked' means ARCore is
        // carrying it and the alignment is as old as the last sighting.
        quality: confirmed ? 'good' : 'tracked',
        alignedObs: A.nObs,
        jitter,
        mapSafe,
      };
    },

    // One pose message from a client. Returns the enrichment for the viewer:
    // { pose, quality, mapChanged }. pose is the camera's room-frame pose or
    // null; mapChanged says the marker map gained/moved a tag.
    handlePose(msg, clientId) {
      let mapChanged = false;
      // Only this path resolves intrinsics through the stored-calibration ladder,
      // so only this one has a tier worth reporting. The XR path derives its
      // model from the projection matrix and logs that model in full below.
      logModelSource(clientId, msg);
      const obs = buildObs(msg.tags);

      // Bootstrap: adopt the first clean look at any tag as the room origin.
      // Shared with the XR path — this was a second inline copy of the same
      // gate, which is how one of them can end up with a quality check the
      // other does not have.
      if (bootstrapAnchor(obs, msg.source)) mapChanged = true;

      const known = obs.filter((o) => markers.has(o.id));
      const prev = clientId !== undefined ? lastFix.get(clientId) : undefined;
      const prevFresh = prev && Date.now() - prev.at < JUMP_HISTORY_TTL_MS;
      pickSolutions(known, prevFresh ? prev.pose : null);
      // msg.intr ships only while landmarks are on (pose.js), so the joint
      // path is conditional on this side — see the availability note there.
      let pose = jointCameraPose(known, msg.intr) ?? fuseCameraPose(known);
      let smoothed = pose;

      // Ambiguity-flip gate: hold the previous fix instead of teleporting,
      // and keep the rejected sample away from survey extension/refinement.
      // pickSolutions makes flips rare; this stays as the backstop for a
      // frame whose wrong solution was the only one to pass the gates.
      // Survey extension and refinement below keep the raw fix on purpose:
      // feeding the filter's output back into the map that produced it would
      // let the two agree with each other instead of with the room.
      if (pose && clientId !== undefined) {
        const r = reportFix(clientId, pose);
        if (r.held) return { pose: r.pose, quality: 'weak', mapChanged, mapSafe: false };
        smoothed = r.pose;
      }

      // No tags in view: carry the pose on the track's own velocity rather
      // than going dark. Good for well under a second — it is dead reckoning
      // with no drift correction, so it is reported as such and never used to
      // extend the survey.
      if (!pose && clientId !== undefined) {
        const guess = predictPose(clientId);
        if (guess) return { pose: guess, quality: 'dead', mapChanged, mapSafe: false };
      }

      if (pose) {
        const strong = known.filter(
          (o) => o.err <= GOOD_MAX_ERR_PX && o.dist <= GOOD_MAX_DIST_M);
        if (maintainSurvey(pose, obs, true, clientId, msg.source, msg.intr)) {
          mapChanged = true;
        }

        const quality = strong.length ? 'good' : 'weak';
        return {
          pose: smoothed,
          quality,
          mapChanged,
          // Same contract as alignXr's flag: may permanent state be built on
          // this report. This path has no founding/slip machinery; a guessed
          // camera model is its one silent poison.
          mapSafe: quality === 'good' && msg.source !== 'guess',
        };
      }

      return { pose: null, quality: 'unlocalized', mapChanged, mapSafe: false };
    },

    // Forget a tag — the escape hatch for tags that were never permanent
    // (one shown on a screen, since closed). Removing the anchor resets the
    // whole survey: every other pose is expressed relative to it.
    removeMarker(id) {
      if (id === anchorId) {
        anchorId = null;
        markers.clear();
        candidates.clear();
        lastFix.clear();
        reseedStreak.clear();
        // Otherwise an XR client keeps mapping against the deleted frame:
        // still "aligned", still painting, with nothing left to correct it.
        xrAlign.clear();
        xrFound.clear();
        forgetJitter();
        log('Survey reset (anchor tag removed)');
      } else if (markers.has(id)) {
        markers.delete(id);
        candidates.delete(id);
        clearStreaks(id);
        log(`Marker ${id} removed from the map`);
      } else {
        return;
      }
      scheduleSave();
    },

    getMarkerMap() {
      return {
        anchorId,
        sizeM: markerSizeM,
        markers: [...markers].map(([id, m]) => ({
          id, p: m.pose.p, q: m.pose.q, nObs: m.nObs,
          from: m.from || [], hops: m.hops ?? null, verified: m.verified ?? null,
          // Live refinement state. Not persisted — it describes what the tag is
          // doing now, and a figure reloaded from disk would claim a settledness
          // nothing has checked since.
          resid: m.resid ?? null, residDeg: m.residDeg ?? null,
          refinedAtMs: m.refinedAtMs ?? null,
          checkedAtMs: m.checkedAtMs ?? null, checkOff: m.checkOff ?? null,
          clippedTo: m.clippedTo ?? null, clippedMm: m.clippedMm ?? null,
          clippedDeg: m.clippedDeg ?? null,
        })),
      };
    },
  };
}

module.exports = { createSurvey };
