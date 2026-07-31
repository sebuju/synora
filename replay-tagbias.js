'use strict';

// Is a tag's own PnP solution biased by the geometry it was seen from?
//
//   node replay-tagbias.js recordings/<stamp>_clientN.pose.jsonl [more ...]
//     [--min-frames 50] [--per-journal]
//
// Both tests here are **map-free**: they read the journal's raw rvec/tvec and
// ARCore poses and consult neither markers.json, nor the alignment, nor the
// pose filter. That is the whole point — the effect being chased is that a
// promoted tag's stored orientation ends each session 1.0-3.6 deg (7.5 worst)
// from where that session started, consistently within the session, and any
// test that touches the map inherits the error it is supposed to be measuring.
//
//  A. SESSION-FRAME STABILITY. A tag is fixed in the room and ARCore's session
//     frame is fixed too, so S = xr * camTag must be constant across a session.
//     Whatever it is not is the tag's own solve plus ARCore's drift. Reported
//     as spread about the session medoid, and — the actual question — as the
//     trend of that orientation against viewing angle and against distance. A
//     tag whose solved orientation swings degrees as you walk around it is a
//     biased solve, and the swing is directly comparable to the 1.0-3.6 deg.
//  B. PAIR RIGIDITY. For a frame with two tags, camTag_A * inv(camTag_B) is a
//     property of the room alone — no ARCore in it at all. This is what says
//     whether A is measuring the tag or measuring ARCore drift; the two have to
//     agree before either is believed.
//
// Frames carrying a second PnP branch (`alt`) are skipped outright rather than
// disambiguated: the mirror is a different question, already measured
// (replay-survey.js --refine puts wrong-branch picks at 0-1%), and 67 of 74
// journals carry no `alt` at all, so nothing is lost by refusing them.

const fs = require('fs');
const path = require('path');
const {
  quatAngleDeg, quatConj, quatFromRvec, quatMedian, quatMul, quatRotate,
  mirrorRvecGuesses, se3Compose, se3FromRvecTvec, se3Invert,
} = require('./public/pose-math.js');

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node replay-tagbias.js <journal.pose.jsonl> [more ...]\n'
    + '  [--min-frames N] [--per-journal]');
  process.exit(1);
}

const journals = [];
const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (key === 'per-journal') {
      flags[key] = true;
    } else {
      if (i + 1 >= argv.length) usage(`missing value for --${key}`);
      flags[key] = Number(argv[++i]);
      if (!Number.isFinite(flags[key])) usage(`bad number for --${key}`);
    }
  } else {
    journals.push(a);
  }
}
if (!journals.length) usage();

// Below this a session's medoid is not a statistic, and the angle/distance
// trends have nothing to regress against.
const MIN_FRAMES = flags['min-frames'] ?? 50;
// Viewing angle bands, in degrees off the tag's normal. The survey drops
// anything past ~81 deg outright (OBS_MIN_COS_ANGLE) so the top band is the
// worst geometry it accepts, not an outlier class.
const ANGLE_BANDS = [0, 20, 35, 50, 65, 82];
const DIST_BANDS = [0, 1.5, 2.5, 4, 6, 100];
// Apparent tag side in pixels (meanSidePx, shipped on every journal tag record).
// The two planar solutions are separated only by the perspective foreshortening
// across the target, so this is the axis along which a *bigger tag* would help —
// and unlike anything non-planar, marker size is already a supported setting.
const PX_BANDS = [0, 60, 100, 160, 260, 100000];
// The survey's own per-solution admission gates (OBS_MAX_ERR_PX,
// OBS_MAX_DIST_M, OBS_MIN_COS_ANGLE in survey.js). Applied here too, or this
// measures sightings the survey would never have acted on.
const MAX_ERR_PX = 3;
const MAX_DIST_M = 10;
const MIN_COS = 0.15;

function pct(sorted, f) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
}

function fmtDeg(vals) {
  if (!vals.length) return 'none';
  const s = [...vals].sort((a, b) => a - b);
  return `p50 ${pct(s, 0.5).toFixed(2)} p90 ${pct(s, 0.9).toFixed(2)} `
    + `max ${s[s.length - 1].toFixed(2)}`;
}

// quatMedian is O(n^2); a session contributes thousands of frames per tag and
// only the location of the cluster is wanted, so the input is thinned to a
// bounded, evenly spaced subset.
const MEDOID_SAMPLE = 800;

function medoidOf(quats) {
  const stride = Math.ceil(quats.length / MEDOID_SAMPLE);
  const s = stride > 1 ? quats.filter((_, i) => i % stride === 0) : quats;
  return quatMedian(s, 20);
}

function bandOf(bands, v) {
  for (let i = 0; i < bands.length - 1; i++) {
    if (v >= bands[i] && v < bands[i + 1]) return i;
  }
  return bands.length - 2;
}

// The same viewing-angle cosine buildObs computes (survey.js): the angle
// between the tag's normal and the line of sight, 1 being straight on.
function viewCos(rvec, tvec) {
  const dist = Math.hypot(tvec[0], tvec[1], tvec[2]);
  if (!(dist > 1e-6)) return { cos: 1, dist: 0 };
  const n = quatRotate(quatFromRvec(rvec), [0, 0, 1]);
  const cos = Math.abs(n[0] * tvec[0] + n[1] * tvec[1] + n[2] * tvec[2]) / dist;
  return { cos, dist };
}

// Two things the first cut of this script got wrong, both of which manufacture
// exactly the trend it is looking for:
//
//  - **Orientations may only be compared within one session.** S = xr * camTag
//    lives in ARCore's session frame, which is a different frame in every
//    journal and again after every session restart. Pooling the quaternions
//    across journals and taking a medoid is meaningless. So a band's offset is
//    worked out *inside* one session against that session's own head-on band,
//    and only those angles are pooled.
//  - **The mirror has to be excluded, because its magnitude grows with the very
//    variable being bucketed on.** A planar mirror is a reflection about the
//    line of sight: it vanishes head-on and reaches ~2x the viewing angle at
//    the oblique end. Left in, the flipped cluster captures the medoid of the
//    oblique bands and the result reads as a smooth bias that is really a flip
//    rate. Flips are a separate, already-measured question, so a session's
//    sightings past OUTLIER of its own medoid are dropped here and counted.
const INLIER_DEG = 20;
const BAND_MIN = 30;

// The per-band offsets one session's sightings of one thing imply, measured
// against that session's most head-on populated band. Returns null when the
// session has no band with enough inliers to anchor against.
// Quarter, half and three-quarter turns about the tag's own +z normal.
const SPINS = [90, 180, 270].map((d) => {
  const h = d * Math.PI / 360;
  return [0, 0, Math.sin(h), Math.cos(h)];
});

function sessionBands(qs, offDeg, mir = null, px = null, errPx = null) {
  const med = medoidOf(qs);
  const errOut = [];
  const errCtrl = [];
  const bands = ANGLE_BANDS.slice(0, -1).map(() => []);
  let flipped = 0;
  // Is an outlier the mirror, or just a bad solve? Reflect it about its own
  // line of sight and see where it lands. `ctrl` is the same question asked of
  // the sightings that already agree, and it is what makes the answer mean
  // anything: mirroring those must move them *away*, or the transform is
  // pulling everything toward the medoid and the test is circular.
  const out = { before: [], after: [] };
  const ctrl = { before: [], after: [] };
  // ...and the other thing an outlier can be. A quarter turn about the tag's
  // own normal is not a pose ambiguity at all — it is the detector handing back
  // the corners in the wrong rotation, which ArUco's decoded id is supposed to
  // make impossible. Worth asking because the residual outliers sit at 58-90
  // deg, which is the size of an in-plane quarter or half turn and not the size
  // of a mirror at the angles those tags are seen from. Applied on the right,
  // because the tag frame is the rightmost factor in S = xr * camTag.
  const spin = { out: [], ctrl: [] };
  const byPx = PX_BANDS.slice(0, -1).map(() => ({ n: 0, bad: 0 }));
  for (let i = 0; i < qs.length; i++) {
    const before = quatAngleDeg(qs[i], med);
    const bad = before > INLIER_DEG;
    if (px && px[i] != null) {
      const b = byPx[bandOf(PX_BANDS, px[i])];
      b.n++;
      if (bad) b.bad++;
    }
    if (mir) {
      const after = Math.min(...mir[i].map((q) => quatAngleDeg(q, med)));
      (bad ? out : ctrl).before.push(before);
      (bad ? out : ctrl).after.push(after);
      spin[bad ? 'out' : 'ctrl'].push(Math.min(...SPINS.map(
        (s) => quatAngleDeg(quatMul(qs[i], s), med))));
      // Does the solve know it is wrong? A wrong branch or a wrong corner
      // rotation fits its own corners beautifully; bad corners do not. This is
      // the cheapest discriminator in the file and needs no transform at all.
      (bad ? errOut : errCtrl).push(errPx[i]);
    }
    if (bad) { flipped++; continue; }
    bands[bandOf(ANGLE_BANDS, offDeg[i])].push(qs[i]);
  }
  const meds = bands.map((b) => (b.length >= BAND_MIN ? medoidOf(b) : null));
  const baseIdx = meds.findIndex((q) => q);
  if (baseIdx < 0) return null;
  return {
    flipped,
    out,
    ctrl,
    spin,
    errOut,
    errCtrl,
    byPx,
    kept: qs.length - flipped,
    resid: bands.flatMap((b, i) => b.map((q) => quatAngleDeg(q, meds[i] || med))),
    offsets: meds.map((q, i) => (q ? {
      band: i, deg: quatAngleDeg(q, meds[baseIdx]), n: bands[i].length,
      // The same offset as a rotation vector in the baseline band's own frame,
      // which is the question the magnitude cannot answer: a systematic camera
      // model error rotates every session the same way and averages to itself,
      // while conditioning noise points somewhere new each time and averages
      // to nothing. |mean| vs mean|.| separates them.
      rv: rotVec(meds[baseIdx], q),
    } : null)).filter(Boolean),
    baseIdx,
  };
}

// Axis-angle (deg) of the rotation taking `from` to `to`, expressed in `from`'s
// own frame so samples from different sessions are comparable.
function rotVec(from, to) {
  const d = quatMul(quatConj(from), to);
  const w = Math.min(1, Math.max(-1, d[3] < 0 ? -d[3] : d[3]));
  const s = d[3] < 0 ? -1 : 1;
  const sin = Math.sqrt(Math.max(0, 1 - w * w));
  const ang = 2 * Math.acos(w) * 180 / Math.PI;
  if (sin < 1e-9) return [0, 0, 0];
  return [s * d[0] / sin * ang, s * d[1] / sin * ang, s * d[2] / sin * ang];
}

function newAcc() {
  return {
    resid: [],
    byBand: ANGLE_BANDS.slice(0, -1).map(() => []),
    byDist: DIST_BANDS.slice(0, -1).map(() => []),
    rv: [],
    out: { before: [], after: [] },
    ctrl: { before: [], after: [] },
    spin: { out: [], ctrl: [] },
    errOut: [],
    errCtrl: [],
    byPx: PX_BANDS.slice(0, -1).map(() => ({ n: 0, bad: 0 })),
    n: 0,
    flipped: 0,
    sessions: 0,
  };
}

function absorb(acc, s) {
  acc.sessions++;
  acc.n += s.kept;
  acc.flipped += s.flipped;
  acc.resid.push(...s.resid);
  // Only bands other than this session's own baseline carry information about
  // a trend; the baseline is 0 by construction and would drag every p50 down.
  for (const o of s.offsets) {
    if (o.band !== s.baseIdx) {
      acc.byBand[o.band].push(o.deg);
      acc.rv.push(o.rv);
    }
  }
  if (s.out) {
    for (const k of ['before', 'after']) {
      acc.out[k].push(...s.out[k]);
      acc.ctrl[k].push(...s.ctrl[k]);
    }
    acc.spin.out.push(...s.spin.out);
    acc.spin.ctrl.push(...s.spin.ctrl);
    acc.errOut.push(...s.errOut);
    acc.errCtrl.push(...s.errCtrl);
    s.byPx.forEach((b, i) => { acc.byPx[i].n += b.n; acc.byPx[i].bad += b.bad; });
  }
}

// Systematic or random: the length of the mean rotation vector against the mean
// of the lengths. Equal means every session's shift points the same way — a
// camera model error, correctable. Near zero against a large mean length means
// the shift is conditioning noise and there is nothing to correct.
function systematic(rv) {
  if (rv.length < 4) return null;
  const sum = [0, 0, 0];
  let mag = 0;
  for (const v of rv) {
    for (let k = 0; k < 3; k++) sum[k] += v[k];
    mag += Math.hypot(v[0], v[1], v[2]);
  }
  return {
    mean: Math.hypot(sum[0], sum[1], sum[2]) / rv.length,
    magMean: mag / rv.length,
    n: rv.length,
  };
}

function fmtBands(byBand) {
  return byBand.map((v, i) => `${ANGLE_BANDS[i]}-${ANGLE_BANDS[i + 1]} `
    + `${v.length ? `${pct([...v].sort((a, b) => a - b), 0.5).toFixed(2)}(${v.length})` : '--'}`)
    .join('  ');
}

const totalA = new Map();       // tag id -> { resid, band spreads, band trends }
const totalB = new Map();       // "a-b" -> [deg from that pair's medoid]
let journalsUsed = 0;
let framesSeen = 0;
let framesAlt = 0;
let markerSizeM = null;

for (const file of journals) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    usage(`cannot read ${file}: ${err.message}`);
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue;   // torn final line of a journal cut off mid-write
    }
  }

  // A journal recorded at a different marker size is a different survey of a
  // different room, and pooling the two says nothing about either. Same refusal
  // replay-survey.js and replay-walls.js make; this tool never had it. The
  // first journal seen sets the scale, since nothing here reads markers.json.
  const meta = entries.find((e) => e.kind === 'meta');
  if (meta && Number.isFinite(meta.markerSizeM)) {
    if (markerSizeM === null) markerSizeM = meta.markerSizeM;
    else if (meta.markerSizeM !== markerSizeM) {
      console.error(`skipping ${path.basename(file)}: recorded with `
        + `${meta.markerSizeM} m markers, the run is using ${markerSizeM} m`);
      continue;
    }
  }

  // Per journal, per tag: the session-frame poses and the geometry each was
  // seen from. Everything is scoped to one journal because ARCore's session
  // frame only exists within one session — and `sid` changes inside a journal
  // when the session restarts, so that splits it too.
  const perTag = new Map();     // `${sid}|${id}` -> { q: [], cos: [], dist: [] }
  const perPair = new Map();    // `${sid}|${a}-${b}` -> [q of relative pose]
  let used = 0;

  for (const e of entries) {
    if (e.kind !== 'xr-pose') continue;
    const msg = e.msg;
    if (!msg || !msg.xr || !(msg.tags || []).length) continue;
    // ARCore has to be tracking for the session frame to mean anything. The
    // journal already carries the survey's verdict; 'unaligned'/'slipping'/
    // 'dead' frames are exactly the ones where xr is not to be trusted.
    if (!e.room || e.room.quality !== 'good') continue;

    const seen = [];
    for (const t of msg.tags) {
      if (t.alt) { framesAlt++; continue; }
      const { cos, dist } = viewCos(t.rvec, t.tvec);
      if (!(t.err <= MAX_ERR_PX) || dist > MAX_DIST_M || cos < MIN_COS) continue;
      const camTag = se3FromRvecTvec(t.rvec, t.tvec);
      // What this sighting would have been had the planar solve landed in the
      // other basin, in the same session frame as the sighting itself. Both
      // guesses, because only reprojection error can say which of the two is
      // the real twin and that is not computable offline — the smaller angle to
      // the medoid is taken later, which is the generous reading and the right
      // one for a test asking whether the mirror *could* explain an outlier.
      const mir = mirrorRvecGuesses(t.rvec, t.tvec)
        .map((rv) => se3Compose(msg.xr, se3FromRvecTvec(rv, t.tvec)).q);
      seen.push({ id: t.id, camTag, cos, dist, mir, px: t.px ?? null, err: t.err });
    }
    if (!seen.length) continue;
    used++;
    framesSeen++;

    const sid = msg.sid ?? 'none';
    for (const s of seen) {
      const key = `${sid}|${s.id}`;
      let v = perTag.get(key);
      if (!v) {
        perTag.set(key, v = {
          id: s.id, q: [], off: [], dist: [], mir: [], px: [], err: [],
        });
      }
      v.mir.push(s.mir);
      v.px.push(s.px);
      v.err.push(s.err);
      // A: the tag's pose in ARCore's session frame. Constant if the tag is
      // fixed, ARCore is honest, and the solve is unbiased.
      v.q.push(se3Compose(msg.xr, s.camTag).q);
      v.off.push(Math.acos(Math.min(1, s.cos)) * 180 / Math.PI);
      v.dist.push(s.dist);
    }
    // B: every ordered pair in this frame, ARCore not involved.
    for (let i = 0; i < seen.length; i++) {
      for (let k = i + 1; k < seen.length; k++) {
        const [a, b] = seen[i].id < seen[k].id ? [seen[i], seen[k]] : [seen[k], seen[i]];
        const key = `${sid}|${a.id}-${b.id}`;
        let v = perPair.get(key);
        if (!v) perPair.set(key, v = { name: `${a.id}-${b.id}`, q: [], off: [] });
        v.q.push(se3Compose(a.camTag, se3Invert(b.camTag)).q);
        // Banded by the *worse* of the two viewing angles: the relative pose
        // carries both tags' error and the ill-conditioned one dominates it.
        v.off.push(Math.max(
          Math.acos(Math.min(1, a.cos)), Math.acos(Math.min(1, b.cos))) * 180 / Math.PI);
      }
    }
  }
  if (!used) continue;
  journalsUsed++;

  const name = path.basename(file);
  const rows = [];
  for (const v of perTag.values()) {
    if (v.q.length < MIN_FRAMES) continue;
    const s = sessionBands(v.q, v.off, v.mir, v.px, v.err);
    if (!s) continue;
    let acc = totalA.get(v.id);
    if (!acc) totalA.set(v.id, acc = newAcc());
    absorb(acc, s);
    // Distance is banded per sighting rather than per session because it is a
    // spread question, not a trend one — the trend that matters is the angle.
    const med = medoidOf(v.q);
    for (let i = 0; i < v.q.length; i++) {
      const d = quatAngleDeg(v.q[i], med);
      if (d <= INLIER_DEG) acc.byDist[bandOf(DIST_BANDS, v.dist[i])].push(d);
    }
    rows.push({ id: v.id, s });
  }
  for (const v of perPair.values()) {
    if (v.q.length < MIN_FRAMES) continue;
    const s = sessionBands(v.q, v.off);
    if (!s) continue;
    let acc = totalB.get(v.name);
    if (!acc) totalB.set(v.name, acc = newAcc());
    absorb(acc, s);
  }

  if (flags['per-journal']) {
    console.log(`\n${name}  ${used} frames`);
    for (const r of rows.sort((a, b) => a.id - b.id)) {
      console.log(`  tag ${String(r.id).padStart(2)}  kept ${r.s.kept}`
        + ` (${r.s.flipped} flipped)  band offsets `
        + r.s.offsets.map((o) => `${ANGLE_BANDS[o.band]}-${ANGLE_BANDS[o.band + 1]}`
          + `:${o.deg.toFixed(2)}`).join(' '));
    }
  }
}

function flipPct(a) {
  const n = a.n + a.flipped;
  return n ? `${(100 * a.flipped / n).toFixed(0)}%` : '--';
}

console.log(`\n=== ${journalsUsed}/${journals.length} journals, ${framesSeen} frames`
  + `${framesAlt ? `, ${framesAlt} tag sighting(s) skipped for carrying a mirror branch` : ''} ===`);
console.log('band offsets are the median over sessions of how far that viewing-angle'
  + ' band\'s own medoid sits from the same session\'s most head-on band, in deg'
  + ` (sample count in brackets = sessions contributing). Sightings past ${INLIER_DEG}`
  + ' deg of their session medoid are dropped as mirror flips and counted separately.');

console.log('\nA. session-frame stability — xr * camTag, per tag');
for (const id of [...totalA.keys()].sort((a, b) => a - b)) {
  const a = totalA.get(id);
  console.log(`  tag ${String(id).padStart(2)}  ${String(a.sessions).padStart(3)} sessions`
    + `  n ${String(a.n).padStart(6)}  flipped ${flipPct(a).padStart(4)}`
    + `  within-band resid ${fmtDeg(a.resid)}`);
  console.log(`         band offset   ${fmtBands(a.byBand)}`);
  const sys = systematic(a.rv);
  if (sys) {
    console.log(`         direction     |mean shift| ${sys.mean.toFixed(2)} vs`
      + ` mean |shift| ${sys.magMean.toFixed(2)} deg over ${sys.n}`
      + ` — ${sys.mean / sys.magMean > 0.6 ? 'SYSTEMATIC' : 'random'}`);
  }
  const med = (v) => (v.length
    ? pct([...v].sort((x, y) => x - y), 0.5) : NaN);
  if (a.out.before.length) {
    const ob = med(a.out.before);
    const oa = med(a.out.after);
    const cb = med(a.ctrl.before);
    const ca = med(a.ctrl.after);
    console.log(`         mirror test   outliers ${ob.toFixed(1)} -> ${oa.toFixed(1)} deg`
      + ` (n ${a.out.before.length})`
      + `   control ${cb.toFixed(1)} -> ${ca.toFixed(1)} deg (n ${a.ctrl.before.length})`
      + `   ${oa < ob * 0.5 && ca > cb * 2 ? 'MIRROR-SHAPED' : 'not the mirror'}`);
    const so = med(a.spin.out);
    const sc = med(a.spin.ctrl);
    console.log(`         spin test     outliers ${ob.toFixed(1)} -> ${so.toFixed(1)} deg`
      + `   control ${cb.toFixed(1)} -> ${sc.toFixed(1)} deg`
      + `   ${so < ob * 0.5 && sc > cb * 2 ? 'IN-PLANE TURN' : 'not an in-plane turn'}`);
    console.log(`         reproj err    outliers p50 ${med(a.errOut).toFixed(2)} `
      + `p90 ${pct([...a.errOut].sort((x, y) => x - y), 0.9).toFixed(2)} px`
      + `   agreeing p50 ${med(a.errCtrl).toFixed(2)} `
      + `p90 ${pct([...a.errCtrl].sort((x, y) => x - y), 0.9).toFixed(2)} px`);
  }
  console.log(`         outlier by px ${a.byPx.map((b, i) =>
    `${PX_BANDS[i]}-${PX_BANDS[i + 1] > 9999 ? '' : PX_BANDS[i + 1]} `
    + `${b.n ? `${(100 * b.bad / b.n).toFixed(0)}%(${b.n})` : '--'}`).join('  ')}`);
  console.log(`         resid by dist ${a.byDist.map((v, i) =>
    `${DIST_BANDS[i]}-${DIST_BANDS[i + 1]}m ${v.length
      ? pct([...v].sort((x, y) => x - y), 0.5).toFixed(2) : '--'}`).join('  ')}`);
}

console.log('\nB. pair rigidity — camTag_a * inv(camTag_b), no ARCore in it at all');
for (const name of [...totalB.keys()].sort()) {
  const b = totalB.get(name);
  console.log(`  ${name.padStart(5)}  ${String(b.sessions).padStart(3)} sessions`
    + `  n ${String(b.n).padStart(6)}  flipped ${flipPct(b).padStart(4)}`
    + `  within-band resid ${fmtDeg(b.resid)}`);
  console.log(`         band offset   ${fmtBands(b.byBand)}`);
}
console.log('\nA trend in A with a flat B is ARCore moving, not the solve. A trend in'
  + ' B is the solve swinging with viewing geometry — a bias, which no weighting'
  + ' can remove.');
