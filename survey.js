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
  se3Identity,
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
    const weights = obs.map((o) =>
      1 / (Math.max(o.dist * o.dist, 1) * (0.5 + o.err) ** 2));
    const wsum = weights.reduce((a, b) => a + b, 0);
    const p = [0, 0, 0];
    for (let i = 0; i < poses.length; i++) {
      for (let k = 0; k < 3; k++) p[k] += poses[i].p[k] * (weights[i] / wsum);
    }
    return { p, q: quatMean(poses.map((x) => x.q), weights) };
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

  function buildObs(tags) {
    const out = [];
    for (const t of tags || []) {
      // A tag may carry two PnP solutions (planar mirror ambiguity). Both
      // are kept while they pass the gates; pickSolutions decides later with
      // room-frame context this side has and the client does not.
      const sols = [t, ...(t.alt ? [t.alt] : [])]
        .map((s) => ({
          err: s.err,
          dist: Math.hypot(s.tvec[0], s.tvec[1], s.tvec[2]),
          camTag: se3FromRvecTvec(s.rvec, s.tvec),
        }))
        .filter((s) => s.err <= OBS_MAX_ERR_PX && s.dist <= OBS_MAX_DIST_M);
      if (!sols.length) continue;
      out.push({ id: t.id, sols, ...sols[0] });
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

    // Room-frame camera pose for a set of tag observations, no side effects —
    // used to pose keyframes independently of the live survey stream.
    locate(tags) {
      const known = buildObs(tags).filter((o) => markers.has(o.id));
      pickSolutions(known, null);
      return { pose: fuseCameraPose(known), tagObs: known };
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
          pose,
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
