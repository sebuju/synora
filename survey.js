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
  se3Identity, quatFromRvec, quatRotate, quatMul, quatConj,
} = require('./public/pose-math.js');

// Observation gates. err is mean corner reprojection error in px — the best
// single-number proxy for a bad detection (blur, oblique view, tiny tag).
const OBS_MAX_ERR_PX = 3;
const OBS_MAX_DIST_M = 10;
const ANCHOR_MAX_ERR_PX = 2;     // the origin deserves a clean look
const ANCHOR_MAX_DIST_M = 4;
const GOOD_MAX_ERR_PX = 2;       // gates for quality:'good'
const GOOD_MAX_DIST_M = 6;

// Candidate promotion: enough estimates, agreeing with their own median.
const CANDIDATE_RING = 50;
const PROMOTE_MIN_ESTIMATES = 8;
const OUTLIER_POS_M = 0.25;
const OUTLIER_ANGLE_DEG = 15;

// Refinement: slow running average for known tags re-observed from a camera
// pose derived from *other* tags (excluding the tag itself keeps the update
// from feeding back into its own estimate).
const REFINE_ALPHA = 0.02;

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
// How far a keyframe's own fix may sit from the client's live track before the
// keyframe is refused. The track is good to centimetres while tags are in
// view, so the budget is really just the motion between the last pose message
// and the keyframe — hence a small base plus an allowance for actual speed. A
// mirror flip's displacement grows with viewing obliquity: near zero seen head
// on (where it also does no harm) and metres seen at an angle.
const LOCATE_MAX_DISAGREE_M = 0.3;
const LOCATE_SPEED_ALLOWANCE_S = 0.25;
const JUMP_HISTORY_TTL_MS = 1500;
const JUMP_CONFIRM_SAMPLES = 3;

const SAVE_DEBOUNCE_MS = 10000;
const MAP_VERSION = 1;

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
  function fuseCameraPose(obs) {
    if (!obs.length) return null;
    const poses = obs.map((o) => se3Compose(markers.get(o.id).pose, se3Invert(o.camTag)));
    // Squared cosine on top of distance and reprojection error: at 60 deg a
    // tag counts a quarter of what it would head on, which is about how its
    // pose error actually grows.
    const weights = obs.map((o) =>
      (o.cos * o.cos) / (Math.max(o.dist * o.dist, 1) * (0.5 + o.err) ** 2));
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
  const xrAlign = new Map();       // clientId -> { T, nObs, at }
  // A fresh alignment jumping this far is a bad tag fix, not drift.
  const XR_ALIGN_JUMP_M = 1.0;
  const XR_ALIGN_ALPHA = 0.25;
  // How long after a confirming tag sighting the alignment is still good
  // enough to survey new tags against.
  const ALIGN_FRESH_MS = 2000;

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

    const p = [0, 1, 2].map((k) =>
      inliers.reduce((a, e) => a + e.p[k], 0) / inliers.length);
    markers.set(id, { pose: { p, q: quatMean(inliers.map((e) => e.q)) }, nObs: inliers.length });
    candidates.delete(id);
    log(`Marker ${id} surveyed at [${p.map((v) => v.toFixed(2)).join(', ')}] ` +
      `(${inliers.length}/${ring.length} estimates)`);
    scheduleSave();
    return true;
  }

  // Adopting the room origin. Both client kinds need it and neither can do
  // anything at all before it has happened.
  let anchorRejectAt = 0;

  function bootstrapAnchor(obs) {
    if (anchorId !== null) return false;
    const seed = obs.find((o) => o.err <= ANCHOR_MAX_ERR_PX && o.dist <= ANCHOR_MAX_DIST_M);
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
  function extendSurvey(pose, obs, needKnownTag = true) {
    if (needKnownTag) {
      const known = obs.filter((o) => markers.has(o.id));
      const strong = known.filter((o) => o.err <= GOOD_MAX_ERR_PX && o.dist <= GOOD_MAX_DIST_M);
      if (!strong.length) return false;
    }
    let changed = false;
    for (const o of obs) {
      if (markers.has(o.id)) continue;
      const est = se3Compose(pose, o.camTag);
      let ring = candidates.get(o.id);
      if (!ring) candidates.set(o.id, (ring = []));
      ring.push(est);
      if (ring.length > CANDIDATE_RING) ring.shift();
      if (tryPromote(o.id)) changed = true;
    }
    return changed;
  }

  let dropLogAt = 0;

  function buildObs(tags) {
    const out = [];
    const dropped = [];
    for (const t of tags || []) {
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
          return { err: s.err, dist, cos, camTag: se3FromRvecTvec(s.rvec, s.tvec) };
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
    }
  }

  return {
    load,
    predictPose,

    // One XR pose report: the camera's pose in the session frame, plus any
    // tags visible in that same frame. Returns the room-frame pose.
    alignXr(clientId, xr, tags) {
      const xrT = { p: xr.p, q: xr.q };
      const prev = xrAlign.get(clientId);
      const obs = buildObs(tags);
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
      const camRoom = known.length ? fuseCameraPose(known) : null;

      if (camRoom) {
        const est = se3Compose(camRoom, se3Invert(xrT));
        if (!prev) {
          xrAlign.set(clientId, { T: est, nObs: 1, at: Date.now() });
          log(`Client ${clientId} XR frame aligned to the room`);
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
            for (let k = 0; k < 3; k++) {
              prev.T.p[k] += (est.p[k] - prev.T.p[k]) * XR_ALIGN_ALPHA;
            }
            prev.T.q = quatNudge(prev.T.q, est.q, XR_ALIGN_ALPHA);
            prev.nObs++;
            prev.at = Date.now();
          }
        }
      }

      const A = xrAlign.get(clientId);
      if (!A) return { pose: null, quality: 'unaligned', mapChanged };
      const roomPose = se3Compose(A.T, xrT);
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
      const alignFresh = Date.now() - A.at < ALIGN_FRESH_MS;
      const extPose = camRoom || (alignFresh ? roomPose : null);
      if (extPose && extendSurvey(extPose, obs, false)) mapChanged = true;
      return {
        pose: roomPose,
        mapChanged,
        // 'good' means a tag confirmed this frame; 'tracked' means ARCore is
        // carrying it and the alignment is as old as the last sighting.
        quality: camRoom ? 'good' : 'tracked',
        alignedObs: A.nObs,
      };
    },

    // The room pose for an XR keyframe, without touching the alignment.
    xrPoseOf(clientId, xr) {
      const A = xrAlign.get(clientId);
      return A ? se3Compose(A.T, { p: xr.p, q: xr.q }) : null;
    },

    // Room-frame camera pose for a set of tag observations, no side effects —
    // used to pose keyframes independently of the live survey stream.
    locate(tags, clientId) {
      const known = buildObs(tags).filter((o) => markers.has(o.id));
      // The client's live track is the reference the mirror ambiguity needs.
      // Without it a single-tag keyframe can be posed by the flipped IPPE
      // solution — not a nudge, the other side of the tag plane — and the
      // whole cloud lands behind the wall it was looking at. handlePose has
      // had a jump gate against this all along; keyframes, which are what
      // actually place every depth point, had nothing.
      const ref = clientId !== undefined ? predictPose(clientId) : null;
      pickSolutions(known, ref);
      const pose = fuseCameraPose(known);
      if (pose && ref) {
        const jump = Math.hypot(
          pose.p[0] - ref.p[0], pose.p[1] - ref.p[1], pose.p[2] - ref.p[2]);
        // A keyframe is refused rather than held: unlike the live pose there
        // is nothing useful to substitute, and painting a frame posed by a
        // fix the live track disagrees with is the failure being fixed.
        const allowed = LOCATE_MAX_DISAGREE_M +
          (ref.speed || 0) * LOCATE_SPEED_ALLOWANCE_S;
        if (jump > allowed) return { pose: null, tagObs: known, jump };
      }
      return { pose, tagObs: known };
    },

    // One pose message from a client. Returns the enrichment for the viewer:
    // { pose, quality, mapChanged }. pose is the camera's room-frame pose or
    // null; mapChanged says the marker map gained/moved a tag.
    handlePose(msg, clientId) {
      let mapChanged = false;
      const obs = buildObs(msg.tags);

      // Bootstrap: adopt the first clean look at any tag as the room origin.
      if (anchorId === null) {
        const seed = obs.find((o) => o.err <= ANCHOR_MAX_ERR_PX && o.dist <= ANCHOR_MAX_DIST_M);
        if (seed) {
          anchorId = seed.id;
          markers.set(seed.id, { pose: se3Identity(), nObs: 1 });
          log(`Marker ${seed.id} anchored as room origin`);
          mapChanged = true;
          scheduleSave();
        }
      }

      const known = obs.filter((o) => markers.has(o.id));
      const unknown = obs.filter((o) => !markers.has(o.id));
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
      // extend the survey or to place a keyframe.
      if (!pose && clientId !== undefined) {
        const guess = predictPose(clientId);
        if (guess) return { pose: guess, quality: 'dead', mapChanged };
      }

      if (pose) {
        const strong = known.filter((o) => o.err <= GOOD_MAX_ERR_PX && o.dist <= GOOD_MAX_DIST_M);

        // Extend: every unknown tag seen from a solid fix contributes one
        // room-pose estimate.
        if (strong.length) {
          for (const o of unknown) {
            const est = se3Compose(pose, o.camTag);
            let ring = candidates.get(o.id);
            if (!ring) candidates.set(o.id, (ring = []));
            ring.push(est);
            if (ring.length > CANDIDATE_RING) ring.shift();
            if (tryPromote(o.id)) mapChanged = true;
          }
        }

        // Refine: nudge a known tag using a camera fix computed from the
        // other tags only. The anchor is the datum and never moves.
        if (known.length >= 2) {
          for (const o of known) {
            if (o.id === anchorId) continue;
            const others = known.filter((x) => x.id !== o.id);
            const fix = fuseCameraPose(others);
            if (!fix) continue;
            const est = se3Compose(fix, o.camTag);
            const m = markers.get(o.id);
            for (let k = 0; k < 3; k++) {
              m.pose.p[k] += (est.p[k] - m.pose.p[k]) * REFINE_ALPHA;
            }
            m.pose.q = quatNudge(m.pose.q, est.q, REFINE_ALPHA);
            m.nObs++;
            scheduleSave();
          }
        }

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
        // Otherwise an XR client keeps mapping against the deleted frame:
        // still "aligned", still painting, with nothing left to correct it.
        xrAlign.clear();
        log('Survey reset (anchor tag removed)');
      } else if (markers.has(id)) {
        markers.delete(id);
        candidates.delete(id);
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
