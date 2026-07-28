'use strict';

// Depth calibration: the two numbers that turn this depth model's output into
// metres for one camera at one keyframe resolution.
//
//     y = A·(1/z) + B      y = pred (relative model) | 1/pred (metric model)
//
// Why this is a separate, deliberate step rather than something each keyframe
// works out for itself: (A, B) is a property of the camera's field of view,
// the model, and our preprocessing — a constant. Refitting it per keyframe
// estimated that constant from one tag pixel every frame, and the estimate
// wandered by more than a third with what the camera happened to be looking
// at. A map that is uniformly a few percent wrong is usable; a map whose scale
// moves between frames can never agree with itself, however close any single
// frame is. So it is measured once, deliberately, and frozen.
//
// A single tag is enough to *fit* both numbers here, which it never is within
// one frame: samples pool across frames, so walking a tag from 1 m to 4 m
// sweeps the same axis that two tags at different depths would. That pooling
// assumes (A, B) really is constant — which is exactly what freezing claims —
// so the fit reports its residuals and the page shows them. Residuals that
// will not come down mean the constant does not exist for this camera, and no
// amount of freezing would have saved the map.

const fs = require('fs');
const path = require('path');

const VERSION = 1;
// A calibration measures the depth model *as fed by this pipeline*. Change how
// frames reach the model — the letterbox, the upright rotation, the input size
// — and the numbers it produced describe a pipeline that no longer exists, so
// every frozen fit has to be thrown away. Bump this whenever anything in
// depth-worker's preprocessing changes. Getting this wrong is silent and
// expensive: a stale fit keeps being applied and every surface lands metres
// out while the sweep's own residual still reads fine.
//   1 - squash to 518x518, no rotation
//   2 - aspect-preserving letterbox, rotated upright by the measured roll
const PREP_EPOCH = 2;
const MAX_SAMPLES = 800;         // per key; oldest fall off
const INLIER_REL = 0.12;         // relative depth error still counted as a fit
const MIN_SPREAD_X = 0.1;        // 1/m between a RANSAC pair, ~1 m vs 2 m
const TRIALS = 300;
const PLOT_POINTS = 300;         // samples shipped to the page for the scatter

// Freeze gates. Anything looser produces a calibration that looks confident on
// a handful of samples taken from one spot.
const FREEZE_MIN_INLIERS = 40;
const FREEZE_MIN_RANGE_RATIO = 2.5;   // farthest / nearest tag distance
const FREEZE_MIN_INLIER_FRAC = 0.6;
const FREEZE_MAX_RMS = 0.15;

function lsq(samples) {
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const s of samples) {
    sx += s.x; sy += s.y; sxx += s.x * s.x; sxy += s.x * s.y;
  }
  const n = samples.length;
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const a = (n * sxy - sx * sy) / denom;
  return { a, b: (sy - a * sx) / n };
}

// Depth the calibration implies for a sample, and how far that is from the
// tag's true distance. Everything is scored in relative depth error because
// that is the error the map actually suffers — a residual in the model's own
// units means nothing at the far end.
function relErr(s, a, b) {
  const inv = (s.y - b) / a;
  if (!(inv > 0)) return Infinity;
  return Math.abs(1 / inv - s.z) / s.z;
}

function robustFit(samples) {
  if (samples.length < 4) return null;
  let bestIn = null;
  for (let t = 0; t < TRIALS; t++) {
    const s1 = samples[(Math.random() * samples.length) | 0];
    const s2 = samples[(Math.random() * samples.length) | 0];
    if (Math.abs(s1.x - s2.x) < MIN_SPREAD_X) continue;
    const a = (s1.y - s2.y) / (s1.x - s2.x);
    if (!(a > 0)) continue;
    const b = s1.y - a * s1.x;
    const inl = samples.filter((s) => relErr(s, a, b) <= INLIER_REL);
    if (!bestIn || inl.length > bestIn.length) bestIn = inl;
  }
  if (!bestIn || bestIn.length < 4) return null;

  // Least squares over the inliers, then re-collect once: the seed pair fixes
  // the line from two noisy samples, and every inlier deserves a say.
  let fit = lsq(bestIn);
  if (!fit || !(fit.a > 0)) return null;
  let inliers = samples.filter((s) => relErr(s, fit.a, fit.b) <= INLIER_REL);
  if (inliers.length >= 4) {
    const refit = lsq(inliers);
    if (refit && refit.a > 0) {
      fit = refit;
      inliers = samples.filter((s) => relErr(s, fit.a, fit.b) <= INLIER_REL);
    }
  }
  if (inliers.length < 4) return null;

  let sq = 0;
  let zMin = Infinity;
  let zMax = 0;
  for (const s of inliers) {
    const e = relErr(s, fit.a, fit.b);
    sq += e * e;
    if (s.z < zMin) zMin = s.z;
    if (s.z > zMax) zMax = s.z;
  }
  return {
    a: fit.a,
    b: fit.b,
    rms: Math.sqrt(sq / inliers.length),
    inliers: inliers.length,
    total: samples.length,
    zMin,
    zMax,
  };
}

function freezeBlockers(fit, pool) {
  if (!fit) {
    // No fit at all almost always means one thing — the samples are all from
    // one spot, so there is no slope to measure. Say that, with the numbers,
    // rather than "not enough samples" while the count climbs past a hundred.
    if (!pool || pool.length < 4) return [`${pool ? pool.length : 0} samples so far`];
    let zMin = Infinity;
    let zMax = 0;
    for (const s of pool) {
      if (s.z < zMin) zMin = s.z;
      if (s.z > zMax) zMax = s.z;
    }
    return [`${pool.length} samples, all between ${zMin.toFixed(2)} and ` +
      `${zMax.toFixed(2)} m — walk the tag closer and further, the fit needs ` +
      `a ${FREEZE_MIN_RANGE_RATIO}x range`];
  }
  const out = [];
  if (fit.inliers < FREEZE_MIN_INLIERS) {
    out.push(`${fit.inliers}/${FREEZE_MIN_INLIERS} usable samples`);
  }
  if (fit.zMax / fit.zMin < FREEZE_MIN_RANGE_RATIO) {
    out.push(`distance range ${(fit.zMax / fit.zMin).toFixed(1)}x, ` +
      `need ${FREEZE_MIN_RANGE_RATIO}x — walk closer and further`);
  }
  if (fit.inliers / fit.total < FREEZE_MIN_INLIER_FRAC) {
    out.push(`only ${Math.round(100 * fit.inliers / fit.total)}% of samples agree`);
  }
  if (fit.rms > FREEZE_MAX_RMS) {
    out.push(`residual ${(fit.rms * 100).toFixed(1)}%, need under ` +
      `${FREEZE_MAX_RMS * 100}%`);
  }
  return out;
}

function createDepthCal({ file, metric, log, fmtDateTime }) {
  const pools = new Map();          // key -> [sample]
  const frozenFits = new Map();     // key -> { a, b, rms, inliers, zMin, zMax, at }
  const calibrating = new Set();    // deviceIds sweeping right now
  const lastKey = new Map();        // deviceId -> the key its keyframes land in

  function save() {
    const entries = {};
    for (const [key, f] of frozenFits) entries[key] = f;
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, entries }, null, 1));
      fs.renameSync(tmp, file);
    } catch (err) {
      log(`Depth calibration save failed: ${err.message}`);
    }
  }

  function load() {
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== VERSION) {
        log(`Ignoring ${path.basename(file)}: written by another version`);
        return;
      }
      let stale = 0;
      for (const [key, f] of Object.entries(data.entries || {})) {
        if (!key.endsWith(`|p${PREP_EPOCH}`)) {
          stale++;
          continue;
        }
        frozenFits.set(key, f);
      }
      log(`Depth calibration loaded: ${frozenFits.size} camera(s)`);
      if (stale) {
        log(`Depth calibration: ${stale} stored fit(s) ignored — the depth ` +
          'preprocessing changed since they were measured. Sweep again at ' +
          '/depth-calibrate; mapping stays dark for those cameras until you do.');
      }
    } catch (err) {
      log(`Depth calibration load failed: ${err.message}`);
    }
  }

  // The model flavor is part of the identity: a fit measured against the
  // metric model's output means nothing applied to the relative one.
  function keyFor(deviceId, w, h) {
    return `${deviceId || 'anon'}|${w}x${h}|${metric ? 'metric' : 'relative'}|p${PREP_EPOCH}`;
  }

  function poolOf(key) {
    let pool = pools.get(key);
    if (!pool) pools.set(key, pool = []);
    return pool;
  }

  function fitFor(key) {
    const pool = pools.get(key);
    return pool ? robustFit(pool) : null;
  }

  return {
    load,
    keyFor,

    // The frozen calibration a keyframe must be painted with, or null — the
    // caller is expected to refuse rather than invent one.
    frozen(key) {
      const f = frozenFits.get(key);
      return f ? { a: f.a, b: f.b } : null;
    },

    isCalibrating(deviceId) {
      return calibrating.has(deviceId);
    },

    start(deviceId) {
      calibrating.add(deviceId);
      log(`Depth calibration started for device ${deviceId}`);
    },

    stop(deviceId) {
      calibrating.delete(deviceId);
    },

    // Every keyframe reports which key it landed in, so freeze and the page
    // both know which camera is being talked about without the page having to
    // work out its own keyframe size.
    noteKey(deviceId, key) {
      lastKey.set(deviceId, key);
    },

    addSamples(key, samples) {
      const pool = poolOf(key);
      for (const s of samples) pool.push(s);
      if (pool.length > MAX_SAMPLES) pool.splice(0, pool.length - MAX_SAMPLES);
    },

    clear(deviceId) {
      const key = lastKey.get(deviceId);
      if (key) pools.delete(key);
    },

    freeze(deviceId) {
      const key = lastKey.get(deviceId);
      if (!key) return { ok: false, reason: 'no keyframes seen from this device yet' };
      const fit = fitFor(key);
      const blockers = freezeBlockers(fit, pools.get(key));
      if (blockers.length) return { ok: false, reason: blockers.join('; ') };
      frozenFits.set(key, {
        a: fit.a,
        b: fit.b,
        rms: fit.rms,
        inliers: fit.inliers,
        zMin: fit.zMin,
        zMax: fit.zMax,
        at: Date.now(),
      });
      calibrating.delete(deviceId);
      save();
      log(`Depth calibration frozen for ${key}: a=${fit.a.toFixed(4)} ` +
        `b=${fit.b.toFixed(4)}, ${fit.inliers} samples over ` +
        `${fit.zMin.toFixed(2)}-${fit.zMax.toFixed(2)} m, residual ` +
        `${(fit.rms * 100).toFixed(1)}%`);
      return { ok: true };
    },

    unfreeze(deviceId) {
      const key = lastKey.get(deviceId);
      if (key && frozenFits.delete(key)) {
        save();
        log(`Depth calibration cleared for ${key}`);
      }
    },

    // Everything the page draws: the live fit, what still blocks freezing, and
    // the sample scatter itself — the scatter is the honest picture, the two
    // numbers are just its summary. `others` is what stops a rotated phone
    // from silently mapping nothing: a calibration is per orientation and per
    // resolution (they are different crops of the sensor, so different fields
    // of view), and the only way to know which ones exist is to be shown them.
    state(deviceId) {
      const key = lastKey.get(deviceId) || null;
      const others = [];
      for (const [k, f] of frozenFits) {
        if (!k.startsWith(`${deviceId || 'anon'}|`) || k === key) continue;
        others.push({ key: k, at: fmtDateTime(new Date(f.at)) });
      }
      const pool = key ? pools.get(key) || [] : [];
      const fit = key ? fitFor(key) : null;
      const frozen = key ? frozenFits.get(key) : null;
      const step = Math.max(1, Math.ceil(pool.length / PLOT_POINTS));
      const points = [];
      for (let i = 0; i < pool.length; i += step) {
        const s = pool[i];
        points.push({
          z: Math.round(s.z * 1000) / 1000,
          y: Math.round(s.y * 100000) / 100000,
          in: fit ? relErr(s, fit.a, fit.b) <= INLIER_REL : false,
        });
      }
      return {
        type: 'depth-cal-state',
        key,
        metric: !!metric,
        calibrating: calibrating.has(deviceId),
        samples: pool.length,
        fit: fit && {
          a: fit.a,
          b: fit.b,
          rms: fit.rms,
          inliers: fit.inliers,
          zMin: fit.zMin,
          zMax: fit.zMax,
        },
        blockers: freezeBlockers(fit, pool),
        frozen: frozen && {
          a: frozen.a,
          b: frozen.b,
          rms: frozen.rms,
          inliers: frozen.inliers,
          zMin: frozen.zMin,
          zMax: frozen.zMax,
          at: fmtDateTime(new Date(frozen.at)),
        },
        others,
        points,
      };
    },
  };
}

module.exports = { createDepthCal };
