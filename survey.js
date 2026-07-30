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
  quatAngleDeg, quatMean, quatNudge, se3FromRvecTvec, se3Compose, se3Invert,
  se3Identity, quatFromRvec, quatRotate, quatMul, quatConj, transformPoint,
} = require('./public/pose-math.js');

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
// A knocked tag is not noise, and the slow average is the wrong tool for it:
// correcting 40 cm at REFINE_ALPHA takes ~200 sightings, and for all of them
// the tag is wrong and dragging its neighbours through the shared camera fix
// (measured: 4 cm of pull on an adjacent tag). Past this much disagreement,
// held for this many consecutive sightings, the tag is not drifting — it moved.
// Drop it back to a candidate and let it re-promote from scratch, which takes
// PROMOTE_MIN_ESTIMATES sightings instead.
const RESEED_DISAGREE_M = 0.25;
const RESEED_STREAK = 12;
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

function createSurvey({ file, markerSizeM, log }) {
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
      markers.set(Number(id), { pose: { p: m.p, q: m.q }, nObs: m.nObs || 0 });
    }
    if (markers.size) log(`Marker map loaded: ${markers.size} tags, anchor ${anchorId}`);
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
          id, { p: m.pose.p, q: m.pose.q, nObs: m.nObs },
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
  // clientId -> the session id whose camera model was already logged, so the
  // 10 Hz pose path logs it once per session rather than on every report.
  const loggedIntrinsics = new Map();
  let lastSeenLog = 0;
  // How long after a confirming tag sighting the alignment is still good
  // enough to survey new tags against.
  const ALIGN_FRESH_MS = 2000;

  function alignAlpha(moved) {
    const t = Math.min(1, moved / XR_ALIGN_MOTION_FULL_M);
    return XR_ALIGN_ALPHA_MIN + (XR_ALIGN_ALPHA_MAX - XR_ALIGN_ALPHA_MIN) * t;
  }

  // Path length, not displacement from the last correction: a walk out and back
  // leaves ARCore drifted by roughly what it travelled, not by nothing.
  function accrueMotion(A, xrT) {
    if (A.lastXr) {
      const d = Math.hypot(
        xrT.p[0] - A.lastXr.p[0], xrT.p[1] - A.lastXr.p[1], xrT.p[2] - A.lastXr.p[2])
        + XR_ALIGN_ROT_M_PER_DEG * quatAngleDeg(A.lastXr.q, xrT.q);
      if (d > XR_ALIGN_MOTION_DEADBAND_M) A.moved += d;
    }
    A.lastXr = xrT;
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

  function tryPromote(id) {
    const ring = candidates.get(id);
    if (ring.length < PROMOTE_MIN_ESTIMATES) return false;
    // Agreement with the component-wise median throws out estimates from bad
    // camera fixes without needing to know which fix was bad.
    const med = {
      p: [0, 1, 2].map((k) => median(ring.map((e) => e.p[k]))),
      q: quatMean(ring.map((e) => e.q)),
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

    const p = [0, 1, 2].map((k) =>
      inliers.reduce((a, e) => a + e.p[k], 0) / inliers.length);
    markers.set(id, { pose: { p, q: quatMean(inliers.map((e) => e.q)) }, nObs: inliers.length });
    candidates.delete(id);
    clearStreaks(id);
    log(`Marker ${id} surveyed at ${fmtP(p)} ` +
      `(${inliers.length}/${ring.length} estimates)`);
    scheduleSave();
    return true;
  }

  // Adopting the room origin. Both client kinds need it and neither can do
  // anything at all before it has happened.
  let anchorRejectAt = 0;

  function bootstrapAnchor(obs) {
    if (anchorId !== null) return false;
    const seed = obs.find((o) => o.err <= ANCHOR_MAX_ERR_PX && o.dist <= ANCHOR_MAX_DIST_M &&
      surveyGrade(o));
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
    markers.set(seed.id, { pose: se3Identity(), nObs: 1 });
    log(`Marker ${seed.id} anchored as room origin`);
    scheduleSave();
    return true;
  }

  // Every unknown tag seen from a solid fix contributes one room-pose estimate;
  // enough consistent estimates promote it into the map.
  // `needKnownTag` is what separates the two client kinds. Without ARCore the
  // camera pose is only trustworthy while a mapped tag is in frame, so an
  // unknown tag may only be surveyed alongside a known one. An XR client knows
  // where it is continuously, so requiring a second tag in the same frame just
  // makes the tag you are standing next to unsurveyable — which is exactly
  // what it did.
  function maintainSurvey(pose, obs, needKnownTag = true, clientId = undefined) {
    const known = obs.filter((o) => markers.has(o.id));
    if (needKnownTag) {
      const strong = known.filter((o) => o.err <= GOOD_MAX_ERR_PX && o.dist <= GOOD_MAX_DIST_M);
      if (!strong.length) return false;
    }
    let changed = false;

    // Extend: every unknown tag seen from a solid fix contributes one estimate.
    for (const o of obs) {
      if (markers.has(o.id)) continue;
      // The estimate is this tag's own camera-frame pose composed with the fix,
      // so a tag too small to solve produces a bad estimate however good the
      // fix was. Recording it only buries the good estimates in noise.
      if (!surveyGrade(o)) continue;
      const est = se3Compose(pose, o.camTag);
      let ring = candidates.get(o.id);
      if (!ring) candidates.set(o.id, (ring = []));
      ring.push(est);
      if (ring.length > CANDIDATE_RING) ring.shift();
      if (tryPromote(o.id)) changed = true;
    }

    // Refine: nudge a known tag using a camera fix from the *other* tags only,
    // so the update cannot feed back into its own estimate. The anchor is the
    // datum and never moves.
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
          x.id !== o.id && markers.has(x.id) && surveyGrade(x));
        const fix = others.length ? fuseCameraPose(others) : null;
        if (!fix) continue;
        const est = se3Compose(fix, o.camTag);
        const m = markers.get(o.id);
        const off = Math.hypot(
          est.p[0] - m.pose.p[0], est.p[1] - m.pose.p[1], est.p[2] - m.pose.p[2]);

        // Persistent, large disagreement is a tag that was moved, not one that
        // is drifting. Averaging towards it would be slow and would drag the
        // neighbours the whole way; forgetting it re-promotes it in
        // PROMOTE_MIN_ESTIMATES sightings from where it actually is now.
        if (off > RESEED_DISAGREE_M) {
          // ...but only when the fix that disagrees is a second opinion rather
          // than a single other tag, which says nothing about which of the two
          // is wrong (REFINE_MIN_OTHERS).
          if (others.length < REFINE_MIN_OTHERS) continue;
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
          continue;
        }
        clearStreak(clientId, o.id);

        for (let k = 0; k < 3; k++) {
          m.pose.p[k] += (est.p[k] - m.pose.p[k]) * REFINE_ALPHA;
        }
        m.pose.q = quatNudge(m.pose.q, est.q, REFINE_ALPHA);
        m.nObs++;
        scheduleSave();
      }
    }
    return changed;
  }

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
      out.push({ id: t.id, sols, ...sols[0] });
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
      const target = others.length ? fuseCameraPose(others) : ref;
      if (!target) continue;
      let best = null;
      for (const s of o.sols) {
        const cam = se3Compose(markers.get(o.id).pose, se3Invert(s.camTag));
        const score = poseDisagree(cam, target);
        if (!best || score < best.score) best = { s, score };
      }
      o.camTag = best.s.camTag;
      o.err = best.s.err;
      o.dist = best.s.dist;
      o.px = best.s.px;
    }
  }

  return {
    load,
    predictPose,

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
      forgetJitter();
      reseedStreak.clear();
      log(`Marker size ${(was * 1000).toFixed(0)} mm -> ${(m * 1000).toFixed(0)} mm `
        + '— survey reset, every tag must be re-observed');
      scheduleSave();
      return true;
    },

    // One XR pose report: the camera's pose in the session frame, plus any
    // tags visible in that same frame. Returns the room-frame pose.
    alignXr(clientId, xr, tags, sessionId = null, intrinsics = null) {
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
        forgetJitter(clientId);
        prev = undefined;
        log(`Client ${clientId} started a new XR session — alignment dropped`);
      }
      // Accrued on every report, tags or none: a client that walks the length of
      // the room seeing nothing and only then sights a tag has to arrive at that
      // sighting with the motion it actually made, or the correction it needs
      // most is the one given the smallest gain.
      if (prev) accrueMotion(prev, xrT);
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
      let mapChanged = bootstrapAnchor(obs);
      const known = obs.filter((o) => markers.has(o.id));
      // ARCore's own pose, mapped through the current alignment, is a far
      // better mirror reference than anything the tag path can produce on its
      // own — it knows where the camera is without consulting the tag at all.
      const ref = prev ? se3Compose(prev.T, xrT) : null;
      pickSolutions(known, ref);
      const camRoom = known.length ? fuseCameraPose(known, ref) : null;

      // A tag in this frame only counts as confirming the alignment if its fix
      // was actually folded in. One thrown away by the jump gate says the
      // opposite, and reporting that as 'good' is how a wrong room frame looks
      // healthy on the dashboard.
      let confirmed = false;
      let alpha = null;      // the gain actually spent, for the steadiness log
      if (camRoom) {
        const est = se3Compose(camRoom, se3Invert(xrT));
        if (!prev) {
          xrAlign.set(clientId, {
            T: est, sid: sessionId, nObs: 1, at: Date.now(), rej: null,
            lastXr: xrT, moved: 0,
          });
          log(`Client ${clientId} XR frame aligned to the room — `
            + `${known.length} tag(s) [${known.map((o) => o.id).join(', ')}], `
            + `worst ${Math.max(...known.map((o) => o.err)).toFixed(2)} px `
            + `at ${Math.max(...known.map((o) => o.dist)).toFixed(2)} m`);
          confirmed = true;
        } else {
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
              xrAlign.set(clientId, {
                T: est, sid: sessionId, nObs: 1, at: Date.now(), rej: null,
                lastXr: xrT, moved: 0,
              });
              confirmed = true;
            }
          }
        }
      }

      const A = xrAlign.get(clientId);
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
      const jitter = A && roomPose
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
      const extPose = camRoom || (alignFresh ? roomPose : null);
      if (extPose && maintainSurvey(extPose, obs, false, clientId)) mapChanged = true;
      if (!A) return { pose: null, quality: 'unaligned', mapChanged };
      return {
        pose: roomPose,
        mapChanged,
        // 'good' means a tag confirmed this frame; 'tracked' means ARCore is
        // carrying it and the alignment is as old as the last sighting.
        quality: confirmed ? 'good' : 'tracked',
        alignedObs: A.nObs,
        jitter,
      };
    },

    // One pose message from a client. Returns the enrichment for the viewer:
    // { pose, quality, mapChanged }. pose is the camera's room-frame pose or
    // null; mapChanged says the marker map gained/moved a tag.
    handlePose(msg, clientId) {
      let mapChanged = false;
      const obs = buildObs(msg.tags);

      // Bootstrap: adopt the first clean look at any tag as the room origin.
      // Shared with the XR path — this was a second inline copy of the same
      // gate, which is how one of them can end up with a quality check the
      // other does not have.
      if (bootstrapAnchor(obs)) mapChanged = true;

      const known = obs.filter((o) => markers.has(o.id));
      const prev = clientId !== undefined ? lastFix.get(clientId) : undefined;
      const prevFresh = prev && Date.now() - prev.at < JUMP_HISTORY_TTL_MS;
      pickSolutions(known, prevFresh ? prev.pose : null);
      let pose = fuseCameraPose(known);
      let smoothed = pose;

      // Ambiguity-flip gate: hold the previous fix instead of teleporting,
      // and keep the rejected sample away from survey extension/refinement.
      // pickSolutions makes flips rare; this stays as the backstop for a
      // frame whose wrong solution was the only one to pass the gates.
      if (pose && clientId !== undefined) {
        const now = Date.now();
        if (prevFresh) {
          const jump = Math.hypot(
            pose.p[0] - prev.pose.p[0],
            pose.p[1] - prev.pose.p[1],
            pose.p[2] - prev.pose.p[2]);
          if (jump > JUMP_REJECT_M && ++prev.rejectStreak < JUMP_CONFIRM_SAMPLES) {
            // prev.at deliberately not refreshed: an old enough history
            // expires and stops vetoing.
            return { pose: prev.pose, quality: 'weak', mapChanged };
          }
        }
        lastFix.set(clientId, { pose, at: now, rejectStreak: 0 });
        // Only what is reported gets smoothed. Survey extension and
        // refinement below keep the raw fix on purpose: feeding the filter's
        // output back into the map that produced it would let the two agree
        // with each other instead of with the room.
        smoothed = smooth(clientId, pose, now);
      }

      // No tags in view: carry the pose on the track's own velocity rather
      // than going dark. Good for well under a second — it is dead reckoning
      // with no drift correction, so it is reported as such and never used to
      // extend the survey.
      if (!pose && clientId !== undefined) {
        const guess = predictPose(clientId);
        if (guess) return { pose: guess, quality: 'dead', mapChanged };
      }

      if (pose) {
        const strong = known.filter(
          (o) => o.err <= GOOD_MAX_ERR_PX && o.dist <= GOOD_MAX_DIST_M);
        if (maintainSurvey(pose, obs, true, clientId)) mapChanged = true;

        return {
          pose: smoothed,
          quality: strong.length ? 'good' : 'weak',
          mapChanged,
        };
      }

      return { pose: null, quality: 'unlocalized', mapChanged };
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
        })),
      };
    },
  };
}

module.exports = { createSurvey };
