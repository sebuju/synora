'use strict';

// Replay recorded pose journals through the survey module, so localization
// quality is measured instead of argued: how far the reported pose moves
// between consecutive reports, how far it sits from the pose the tags alone
// imply, and what that costs in availability.
//
//   node replay-survey.js recordings/<stamp>_clientN.pose.jsonl [more ...]
//     [--markers markers.json] [--step-m 0.30] [--step-m-per-s 3.0]
//     [--step-max-dt 0.6] [--step-cap-m 1.0] [--step-recover 3]
//     [--refine-noise-scale 1] [--joint-pnp 1] [--joint-min-offplane-m 0.03]
//     [--adopt-chain 1] [--anchored-refine 1]
//     [--perturb id:deg[:m]] [--log] [--per-journal] [--refine]
//
// The journal lines are fed to survey.alignXr / survey.handlePose with the
// exact arguments server.js passes, so a replay exercises the real code path.
// `--step-m 999 --step-max-dt 1e9 --step-cap-m 1e9` reproduces the module as it
// stood before the step detector, which is how a before/after pair is taken
// without touching the repo. All three are needed and each disables a different
// arm: --step-m the distance gate, --step-max-dt the gap trip that fires when no
// step can be measured at all, and --step-cap-m the ceiling on the allowance,
// which is a `min` and would otherwise override a huge --step-m on its own.
//
// Three things a replay must get right, all learned the hard way:
//
//  - Date.now() is driven from each entry's `at`. Every window and TTL in
//    survey.js is wall-clock, and against the real clock they all span the
//    whole run — the jitter window in particular silently becomes "since the
//    session started" and reports a session-wide spread as rest jitter.
//  - markers.json is copied to a scratch file per journal and *that* is what
//    createSurvey is handed. The survey writes its map back to the file it was
//    given, and the live server rewrites markers.json mid-session, so a replay
//    must neither read a moving map nor write to the real one.
//  - The map is the *final* one for every journal, while the live run saw it
//    being built. Same asymmetry replay-walls.js accepts, and the same rule
//    follows: replays are for relative comparisons, so compare two runs over
//    the same journals rather than reading one run's numbers as truth.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSurvey } = require('./survey.js');
const {
  quatAngleDeg, quatMedian, quatMul, quatNormalize, quatRotate,
} = require('./public/pose-math.js');

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node replay-survey.js <journal.pose.jsonl> [more ...]\n'
    + '  [--markers markers.json] [--step-m X] [--step-m-per-s X]\n'
    + '  [--step-max-dt X] [--step-cap-m X] [--step-recover N]\n'
    + '  [--refine-noise-scale X] [--joint-pnp 0|1] [--joint-min-offplane-m X]\n'
    + '  [--adopt-chain 0|1] [--anchored-refine 0|1]\n'
    + '  [--perturb id:deg[:m]] [--log] [--per-journal] [--refine]');
  process.exit(1);
}

const journals = [];
const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (key === 'log' || key === 'per-journal' || key === 'refine') {
      flags[key] = true;
    } else {
      if (i + 1 >= argv.length) usage(`missing value for --${key}`);
      flags[key] = argv[++i];
    }
  } else {
    journals.push(a);
  }
}
if (!journals.length) usage();

const markersFile = flags.markers || path.join(__dirname, 'markers.json');
let rawMap;
try {
  rawMap = JSON.parse(fs.readFileSync(markersFile, 'utf8'));
} catch (err) {
  usage(`cannot read ${markersFile}: ${err.message}`);
}
const markerSizeM = rawMap.markerSizeM;

const opts = {};
if (flags['step-m'] !== undefined) opts.stepM = Number(flags['step-m']);
if (flags['step-m-per-s'] !== undefined) opts.stepMPerS = Number(flags['step-m-per-s']);
if (flags['step-max-dt'] !== undefined) opts.stepMaxDtS = Number(flags['step-max-dt']);
if (flags['step-cap-m'] !== undefined) opts.stepCapM = Number(flags['step-cap-m']);
if (flags['step-recover'] !== undefined) opts.stepRecoverFixes = Number(flags['step-recover']);
// `--refine-noise-scale 0` reproduces the module as it stood before the refine
// step was scaled by the innovation against the sighting's own noise: the scale
// becomes 1 for everything. Same trick as the --step-m triple above.
if (flags['refine-noise-scale'] !== undefined) {
  opts.refineNoiseScale = Number(flags['refine-noise-scale']);
}
// `--joint-pnp 0` reproduces the module as it stood before the joint multi-tag
// solve: every call falls straight through to fuseCameraPose.
if (flags['joint-pnp'] !== undefined) opts.jointPnp = Number(flags['joint-pnp']);
// `--adopt-chain 0 --anchored-refine 0` reproduces the module as it stood before
// the refinement-cycle fix. Both default on and both are separately switchable,
// because they are independent: adoption fills a founding chain that was never
// recorded, the gate refuses a fix with no witness nearer the datum, and a
// before/after that moved both at once cannot say which one did the work.
if (flags['adopt-chain'] !== undefined) opts.adoptChain = Number(flags['adopt-chain']);
if (flags['anchored-refine'] !== undefined) {
  opts.anchoredRefine = Number(flags['anchored-refine']);
}
if (flags['joint-min-offplane-m'] !== undefined) {
  opts.jointMinOffplaneM = Number(flags['joint-min-offplane-m']);
}
for (const [k, v] of Object.entries(opts)) {
  if (!Number.isFinite(v)) usage(`bad number for ${k}`);
}

// --perturb <id>:<deg>[:<m>] — move a tag in the map the replay starts from, so
// the drift columns read as *recovery* rather than drift. Refinement's whole
// defence against a tag someone actually turned is that it heals rather than
// being dropped, and this is the only way to ask recorded data whether it does.
let perturb = null;
if (flags.perturb !== undefined) {
  const [id, deg, m] = String(flags.perturb).split(':');
  perturb = { id: Number(id), deg: Number(deg), m: m === undefined ? 0 : Number(m) };
  if (!Number.isInteger(perturb.id) || !Number.isFinite(perturb.deg)
    || !Number.isFinite(perturb.m)) usage('--perturb wants <id>:<deg>[:<m>]');
}

// Applied to the loaded map, not to the file: the survey rewrites what it was
// given, and a perturbed scratch file that later gets saved over is a map whose
// provenance nobody can reconstruct. Rotation about the tag's own up axis and a
// translation along its own normal — a knock, not an arbitrary reshuffle.
function applyPerturb(survey) {
  if (!perturb) return;
  const t = survey.getMarkerMap().markers.find((x) => x.id === perturb.id);
  if (!t) {
    console.error(`--perturb: tag ${perturb.id} is not in the map`);
    return;
  }
  const half = perturb.deg * Math.PI / 360;
  const spin = [0, Math.sin(half), 0, Math.cos(half)];
  const n = quatRotate(t.q, [0, 0, 1]);
  // getMarkerMap hands out the live arrays, so this writes through to the map
  // the replay is about to exercise.
  const q = quatNormalize(quatMul(spin, t.q));
  for (let k = 0; k < 4; k++) t.q[k] = q[k];
  for (let k = 0; k < 3; k++) t.p[k] += n[k] * perturb.m;
  // ...and check that it did, because a silent no-op here reads as "the tag
  // never moved, so nothing needed healing" — the exact opposite of the answer.
  const after = survey.getMarkerMap().markers.find((x) => x.id === perturb.id);
  if (quatAngleDeg(after.q, q) > 1e-6) {
    console.error('--perturb did not take: getMarkerMap no longer hands out the '
      + 'live pose arrays');
    process.exit(1);
  }
  // DRIFT is measured against the *unperturbed* markers.json either way, so
  // under --perturb it reads as the error still outstanding: it starts at the
  // perturbation and a healthy refine walks it back toward zero.
  console.log(`perturbed tag ${perturb.id} by ${perturb.deg} deg`
    + `${perturb.m ? ` and ${perturb.m} m` : ''} — drift below is what is left`);
}

const scratch = path.join(os.tmpdir(), `synora-replay-survey-${process.pid}.json`);

// ---------------------------------------------------------------------------
// Two metrics, both computed from the module's own output.
//
// A third — where the tags alone put the camera, from the marker map and this
// frame's raw corners, consulting neither the alignment nor the filter — is
// buildable and is not built here yet. The attempt that was made scored every
// combination of the tags' mirror branches by cluster tightness and demanded
// the winner beat the runner-up by 2x + 5 cm, on the grounds that coplanar tags
// share their mirror (two tags on one wall flip together and their flipped
// solutions cluster as tightly as the true ones, so tightness alone decides
// nothing). It rejected every frame, and the reason was a fault in the test,
// not a property of the room: in 88.1% of frames with two or more mapped tags
// *no* tag has a second solution at all, so all branch combinations collapse to
// the same points, best equals runner-up, and the margin test threw out frames
// that were never ambiguous in the first place. Of the 2721 frames that are
// genuinely ambiguous the margin is decisive on 33.8%. So the reference is
// available on roughly 21k of 22.8k multi-tag frames — the margin test just has
// to be skipped when there is nothing to choose between.
//
//  1. STEP — how far the reported pose moves between consecutive reports. This
//     is the complaint itself, needs no reference, and is what a viewer draws.
//  2. UNSAFE — reports carrying mapSafe true within JUMP_BLAST_MS of a step
//     over JUMP_M. mapSafe is the flag that lets walls.js write permanent grid
//     evidence, so this counts the evidence taken from a pose that is provably
//     discontinuous either side of it. It cannot say the pose was wrong, only
//     that nothing in the system was in a position to claim it was right.
//  3. REFINE (--refine) — what the refine half of maintainSurvey is doing to
//     tags already in the map. Four figures per tag, from the onRefine tap plus
//     a before/after of the map itself:
//
//     - INLIER: the share of the accepted estimate stream that agrees with its
//       own medoid within OUTLIER_ANGLE_DEG — tryPromote's own inlier test,
//       applied to the stream refinement averages without it, needing no ground
//       truth. Read it as spread, *not* as an argument for a robust estimator:
//       it was 0.87-0.96 here and switching the nudge target to the median of a
//       25-sample ring changed per-session drift by nothing. What decides that
//       question is whether the outliers are lopsided, and they are not — the
//       angle between quatMean and quatMedian of a session's stream is
//       0.21-1.16 deg at the median. See the note in survey.js's refine loop.
//     - UNANCH: sightings that agreed with the map but had no witness nearer
//       the datum than the tag under test, so they checked it without moving
//       it. Read it beside DRIFT: a tag that stopped drifting because it
//       converged and one that stopped because nothing was allowed to correct
//       it draw the same flat trace, and this is what separates them.
//     - DRIFT: how far the stored pose actually travelled over one session, in
//       mm and degrees. The literal reading of "known-good tags self-heal too
//       easily", and the only one taken from the module's output rather than
//       from its internals.
//     - MIRROR: of the sightings where the tag had two PnP branches, the share
//       where the branch pickSolutions rejected would have agreed with the
//       stored orientation better, by more than MIRROR_MARGIN_DEG. A lower
//       bound and biased toward the status quo — the reference is the stored
//       pose, which refine itself drags — but it is the same reference the
//       existing wrong-branch figures use, and no better one exists offline.
//     - AMBIG: how much of the refine stream has two branches at all, i.e. how
//       much of it pickSolutions even gets a vote on. A low share means the
//       mirror cannot be the whole story regardless of what MIRROR says.
const JUMP_M = 0.3;
const JUMP_BLAST_MS = 1500;

// survey.js's OUTLIER_ANGLE_DEG, which is the point of the comparison — this
// harness must judge the stream by the same tolerance tryPromote does.
const OUTLIER_ANGLE_DEG = 15;
// Big enough that ordinary solve noise cannot make the loser look better; well
// under the tens of degrees a mirror branch differs by.
const MIRROR_MARGIN_DEG = 5;

// ---------------------------------------------------------------------------

function pct(sorted, f) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
}

function fmtDist(vals) {
  if (!vals.length) return 'none';
  const s = [...vals].sort((a, b) => a - b);
  return `p50 ${pct(s, 0.5).toFixed(3)} p90 ${pct(s, 0.9).toFixed(3)} `
    + `p99 ${pct(s, 0.99).toFixed(3)} max ${s[s.length - 1].toFixed(3)}`;
}

function newTagStats() {
  return {
    nudges: 0, disagrees: 0, unanchored: 0, nowitness: 0, ambig: 0, mirror: 0,
    dq: [], qs: [], inlier: [], driftMm: [], driftDeg: [], finals: [],
  };
}

// Where independent sessions leave a tag, relative to each other. This is the
// metric that can actually judge a refinement change, and drift cannot: drift
// is measured against markers.json, which the previous estimator produced, so a
// change that moves the map somewhere better scores *worse* on it. Sessions
// have independent geometry and independent bias, so the tighter they land
// together the less the map is at the mercy of which session ran last. It is
// also the metric detect-core.js's own twin-shipping decision was taken on.
function agreementOf(finals) {
  if (finals.length < 3) return null;
  const c = {
    p: [0, 1, 2].map((k) => median(finals.map((f) => f.p[k]))),
    q: quatMedian(finals.map((f) => f.q), 30),
  };
  const mm = finals.map((f) => 1000 * Math.hypot(
    f.p[0] - c.p[0], f.p[1] - c.p[1], f.p[2] - c.p[2]));
  const deg = finals.map((f) => quatAngleDeg(f.q, c.q));
  return { mm, deg, n: finals.length };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function tagStats(map, id) {
  let s = map.get(id);
  if (!s) map.set(id, s = newTagStats());
  return s;
}

// quatMedian is O(n^2) and a journal contributes thousands of estimates per
// tag, so the stream is thinned to a bounded, evenly spaced subset first. The
// figure is a share of a stationary stream; the sample size only has to be
// large enough to resolve it, and 1200 resolves a percent.
const INLIER_SAMPLE = 1200;

function inlierFrac(qs) {
  if (qs.length < 3) return NaN;
  const stride = Math.ceil(qs.length / INLIER_SAMPLE);
  const s = stride > 1 ? qs.filter((_, i) => i % stride === 0) : qs;
  const med = quatMedian(s, OUTLIER_ANGLE_DEG);
  return s.filter((q) => quatAngleDeg(q, med) <= OUTLIER_ANGLE_DEG).length / s.length;
}

// The map every journal starts from — each replay copies markers.json fresh
// (see the scratch note above), so this is the shared "before" for all of them.
const before = new Map(Object.entries(rawMap.markers || {})
  .map(([id, m]) => [Number(id), m]));

function refineTable(map, indent) {
  for (const id of [...map.keys()].sort((a, b) => a - b)) {
    const s = map.get(id);
    const dq = [...s.dq].sort((a, b) => a - b);
    const inl = s.inlier.filter(Number.isFinite);
    const cell = (vals, unit, dp) => (vals.length
      ? `p50 ${pct([...vals].sort((a, b) => a - b), 0.5).toFixed(dp)} `
        + `max ${Math.max(...vals).toFixed(dp)}${unit}`
      : 'none');
    console.log(`${indent}tag ${String(id).padStart(2)}`
      + `  nudges ${String(s.nudges).padStart(6)}`
      + `  rejects ${String(s.disagrees).padStart(5)}`
      + `  unanch ${String(s.unanchored).padStart(5)}`
      + `  nowit ${String(s.nowitness).padStart(6)}`
      + `  ambig ${s.nudges ? (100 * s.ambig / s.nudges).toFixed(0) : '--'}%`
      + `  mirror ${s.ambig ? (100 * s.mirror / s.ambig).toFixed(0) : '--'}%`
      + `  dq ${dq.length ? `p50 ${pct(dq, 0.5).toFixed(2)} p90 ${pct(dq, 0.9).toFixed(2)} `
        + `max ${dq[dq.length - 1].toFixed(2)}` : 'none'}deg`
      + `  inlier ${inl.length
        ? (inl.reduce((a, b) => a + b, 0) / inl.length).toFixed(3) : '  --'}`
      + `  drift ${cell(s.driftMm, 'mm', 0)} / ${cell(s.driftDeg, 'deg', 2)}`);
    const ag = agreementOf(s.finals);
    if (ag) {
      console.log(`${indent}       cross-session agreement over ${ag.n} sessions: `
        + `${cell(ag.mm, 'mm', 0)} / ${cell(ag.deg, 'deg', 2)}`
        + `  — worst ${Math.max(...ag.mm).toFixed(0)} mm, `
        + `${Math.max(...ag.deg).toFixed(2)} deg`);
    }
  }
}

const total = {
  reports: 0, steps: [], unsafe: 0, safeN: 0,
  trips: 0, slips: 0, reacq: 0, refound: 0, quality: {}, journals: 0, changed: [],
  refine: new Map(),
  joint: {
    joint: 0, fewTags: 0, noCorners: 0, noIntr: 0, coplanar: 0,
    noConverge: 0, rms: 0, ms: 0,
  },
};

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
  const meta = entries.find((e) => e.kind === 'meta');
  if (meta && meta.markerSizeM !== markerSizeM) {
    console.error(`skipping ${path.basename(file)}: recorded with `
      + `${meta.markerSizeM} m markers, map says ${markerSizeM} m`);
    continue;
  }
  const clientId = meta && meta.clientId != null ? meta.clientId : 1;
  const first = entries.find((e) => Number.isFinite(e.at));
  if (!first) continue;

  fs.copyFileSync(markersFile, scratch);
  let clock = first.at;
  const realNow = Date.now;
  Date.now = () => clock;

  const counts = { trips: 0, slips: 0, reacq: 0, refound: 0 };
  const jr = new Map();
  const survey = createSurvey({
    file: scratch,
    markerSizeM,
    opts,
    // Null unless asked for, so a plain run exercises exactly the module the
    // live server runs.
    onRefine: !flags.refine ? null : (ev) => {
      const s = tagStats(jr, ev.id);
      if (ev.verdict === 'disagree') {
        s.disagrees++;
        return;
      }
      // The two ways a sighting can check a tag without moving it: no witness
      // at all (every other tag in frame descends from this one), or witnesses
      // that all sit at this tag's own depth or further out. Counted apart from
      // nudges and from each other, because "the tag stopped drifting" and "the
      // tag stopped being refined" are the two readings of the same flat trace
      // and these are the only figures that tell them apart.
      if (ev.verdict === 'unanchored') {
        s.unanchored++;
        return;
      }
      if (ev.verdict === 'nowitness') {
        s.nowitness++;
        return;
      }
      s.nudges++;
      s.dq.push(ev.dq);
      s.qs.push(ev.estQ);
      if (ev.branches.length < 2) return;
      s.ambig++;
      if (ev.chosen < 0) return;   // camTag replaced rather than selected
      // The branch that was not taken, judged against the same stored pose the
      // taken one was judged against.
      const other = ev.branches[ev.chosen === 0 ? 1 : 0];
      if (ev.dq - other.dq > MIRROR_MARGIN_DEG) s.mirror++;
    },
    log: (m) => {
      if (/session frame (stepped|moved .* across)/.test(m)) counts.trips++;
      else if (m.includes('session frame is slipping')) counts.slips++;
      else if (m.includes('alignment re-acquired')) counts.reacq++;
      else if (m.includes('alignment re-founded')) counts.refound++;
      if (flags.log) console.log(`    ${m}`);
    },
  });
  survey.load();
  applyPerturb(survey);

  const j = { reports: 0, steps: [], unsafe: 0, safeN: 0, quality: {} };
  // (at, mapSafe) per report and the instants a jump landed, so the blast
  // radius can be applied after the run — a report is compromised by the jump
  // that follows it as much as by the one before.
  const seen = [];
  const jumps = [];
  let prev = null;
  let lastAt = null;

  for (const e of entries) {
    if (e.kind !== 'xr-pose' && e.kind !== 'pose') continue;
    clock = e.at;
    const msg = e.msg;
    const out = e.kind === 'xr-pose'
      ? survey.alignXr(clientId, msg.xr, msg.tags || [], msg.sid ?? null,
        msg.intrinsics, msg.source)
      : survey.handlePose(msg, clientId);
    j.reports++;

    const dtq = lastAt == null ? 0 : (e.at - lastAt) / 1000;
    lastAt = e.at;
    const q = out.quality || 'none';
    if (dtq > 0 && dtq < 1) j.quality[q] = (j.quality[q] || 0) + dtq;

    if (out.mapSafe) {
      j.safeN++;
      seen.push(e.at);
    }
    if (out.pose) {
      if (prev && e.at - prev.at < 600) {
        const d = Math.hypot(
          out.pose.p[0] - prev.p[0], out.pose.p[1] - prev.p[1], out.pose.p[2] - prev.p[2]);
        j.steps.push(d);
        if (d > JUMP_M) jumps.push(e.at);
      }
      prev = { p: out.pose.p, at: e.at };
    } else {
      prev = null;
    }
  }
  for (const at of seen) {
    if (jumps.some((t) => Math.abs(t - at) <= JUMP_BLAST_MS)) j.unsafe++;
  }

  Date.now = realNow;

  // Read the map from the module, not from the scratch file: scheduleSave is a
  // ten-second *real*-time debounce and a replay is finished long before it
  // fires, so the file on disk is still the pristine copy.
  if (flags.refine) {
    for (const m of survey.getMarkerMap().markers) {
      const b = before.get(m.id);
      if (!b) continue;
      const s = tagStats(jr, m.id);
      s.driftMm.push(1000 * Math.hypot(
        m.p[0] - b.p[0], m.p[1] - b.p[1], m.p[2] - b.p[2]));
      s.driftDeg.push(quatAngleDeg(m.q, b.q));
      // Copied, not referenced: getMarkerMap hands out the live pose arrays and
      // the next journal's survey would mutate them under the comparison.
      s.finals.push({ p: [...m.p], q: [...m.q] });
    }
    for (const [, s] of jr) s.inlier.push(inlierFrac(s.qs));
  }

  const name = path.basename(file);
  const touched = counts.trips || counts.slips || counts.reacq || counts.refound;
  if (flags['per-journal'] || touched) {
    console.log(`\n${name}  ${j.reports} reports`);
    console.log(`  reported-pose step   ${fmtDist(j.steps)}`
      + `  >0.3m ${j.steps.filter((d) => d > 0.3).length}`
      + `  >1m ${j.steps.filter((d) => d > 1).length}`);
    console.log(`  mapSafe reports      ${j.safeN}, of them beside a jump: ${j.unsafe}`);
    console.log(`  step trips ${counts.trips}  slip trips ${counts.slips}`
      + `  re-acquired ${counts.reacq}  re-founded ${counts.refound}`);
    console.log('  quality  ' + Object.entries(j.quality)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v.toFixed(1)}s`).join('  '));
    if (flags.refine) refineTable(jr, '  ');
  }

  for (const [id, s] of jr) {
    const t = tagStats(total.refine, id);
    t.nudges += s.nudges;
    t.disagrees += s.disagrees;
    t.unanchored += s.unanchored;
    t.nowitness += s.nowitness;
    t.ambig += s.ambig;
    t.mirror += s.mirror;
    t.dq.push(...s.dq);
    // Per-journal figures, kept as one sample each: drift is "what one session
    // did" and inlier is a share of that session's stream, so pooling the raw
    // estimates across journals would answer a different question.
    t.inlier.push(...s.inlier);
    t.driftMm.push(...s.driftMm);
    t.driftDeg.push(...s.driftDeg);
    t.finals.push(...s.finals);
  }

  const js = survey.jointStats();
  for (const k of Object.keys(total.joint)) total.joint[k] += js[k];

  total.journals++;
  total.reports += j.reports;
  total.steps.push(...j.steps);
  total.unsafe += j.unsafe;
  total.safeN += j.safeN;
  total.trips += counts.trips;
  total.slips += counts.slips;
  total.reacq += counts.reacq;
  total.refound += counts.refound;
  for (const [k, v] of Object.entries(j.quality)) {
    total.quality[k] = (total.quality[k] || 0) + v;
  }
  if (touched) total.changed.push(name);
}

try { fs.unlinkSync(scratch); } catch { /* never created */ }

console.log(`\n=== ${total.journals} journals, ${total.reports} reports ===`);
console.log(`reported-pose step   ${fmtDist(total.steps)}`
  + `  >0.3m ${total.steps.filter((d) => d > 0.3).length}/${total.steps.length}`
  + `  >1m ${total.steps.filter((d) => d > 1).length}`);
console.log(`mapSafe reports      ${total.safeN}, of them beside a jump: `
  + `${total.unsafe}`);
console.log(`step trips ${total.trips}  slip trips ${total.slips}`
  + `  re-acquired ${total.reacq}  re-founded ${total.refound}`);
console.log('quality  ' + Object.entries(total.quality)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${v.toFixed(0)}s`).join('  '));
console.log(`journals with any alignment event: ${total.changed.length}`);

// Coverage of the joint multi-tag solve — the number the whole change stands
// or falls on. `tried` is the calls that saw two or more mapped tags; if the
// joint share of those is small the feature is moot, and this line is what
// says so instead of leaving it assumed.
{
  const jn = total.joint;
  const tried = jn.joint + jn.coplanar + jn.noCorners + jn.noIntr
    + jn.noConverge + jn.rms;
  if (tried || jn.fewTags) {
    console.log(`joint PnP  taken ${jn.joint}/${tried} multi-tag calls`
      + (tried ? ` (${(100 * jn.joint / tried).toFixed(0)}%)` : '')
      + `  fallback: coplanar ${jn.coplanar}, no-corners ${jn.noCorners}, `
      + `no-intr ${jn.noIntr}, no-converge ${jn.noConverge}, rms ${jn.rms}`
      + `  under-2-tag calls ${jn.fewTags}  solver ${(jn.ms / 1000).toFixed(1)} s`);
  }
}

if (flags.refine) {
  console.log('\nrefine — per tag, pooled over journals'
    + ` (inlier/drift are per-journal samples, ${total.journals} of each):`);
  refineTable(total.refine, '  ');
  console.log('  mirror share is a lower bound: the reference is the tag\'s own'
    + ' stored orientation, which refine itself drags toward whatever it is fed.');
}

// The save debounce is armed by any map change and would hold the process open
// for SAVE_DEBOUNCE_MS with nothing left to do.
process.exit(0);
