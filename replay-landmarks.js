'use strict';

// Replay recorded pose journals through the landmark module, so anchor supply
// and localization accuracy are measured instead of argued.
//
//   node replay-landmarks.js recordings/<stamp>_clientN.pose.jsonl [more ...]
//     [--min-obs 12] [--min-arc 60] [--min-anchors 15] [--stride 2]
//
// Unlike the walls replay this needs no markers.json and no pixels: a journal
// line already carries the tracked points, the camera model and the pose the
// survey produced from the tags, which is everything the landmark map consumes.
// Journals recorded before the client published `points` simply report zero.
//
// The headline is the **holdout**: anchors are built from one share of the
// reports and the camera is then localized from the other share with the tag
// pose withheld, so no anchor is ever tested against a frame that helped create
// it. Position and orientation error are against the tag-derived pose recorded
// on that same line — the best reference available, and the one the product
// would have used.

const { parseArgs, numFlag, readJournals } = require('./replay-common.js');
const {
  createLandmarks, landmarkGate, MIN_ANCHORS_FOR_FIX, LANDMARK_MAX_JITTER_MM,
} = require('./landmarks.js');
const { quatAngleDeg } = require('./public/pose-math.js');
const { dist3 } = require('./public/landmark-math.js');

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node replay-landmarks.js <journal.pose.jsonl> [more ...]\n'
    + '  [--gate live|any] [--min-anchors N] [--stride N]\n'
    + '  [--min-obs N] [--min-arc DEG] [--collapse X] [--max-rms X]\n'
    + '  [--reassoc-px X] [--reassoc-margin X]\n'
    + '  [--stale-px X] [--stale-streak N] [--group-m X] [--quiet 1]');
  process.exit(1);
}

const { positional: journals, flags } = parseArgs(process.argv.slice(2), { usage });
if (!journals.length) usage();
const num = (key, dflt) => numFlag(flags, key, dflt, usage);

// Every Nth report is held out for localization; the rest build the map.
const stride = num('stride', 2);
const minAnchors = num('min-anchors', MIN_ANCHORS_FOR_FIX);
// Which admission gate to replay. `live` is the server's own (see below) and is
// the default, because a replay that measures a looser gate than the product
// runs is worse than no replay. `any` is the old behaviour, kept because it
// answers a different and still useful question: what the data would support if
// admission were not the binding constraint.
const gate = flags.gate ?? 'live';
if (gate !== 'live' && gate !== 'any') usage(`--gate must be live or any, not ${gate}`);

(() => {
  const lmOpts = {};
  if (flags['reassoc-px'] !== undefined) lmOpts.reassocPx = num('reassoc-px');
  if (flags['reassoc-margin'] !== undefined) lmOpts.reassocMargin = num('reassoc-margin');
  if (flags['stale-px'] !== undefined) lmOpts.stalePx = num('stale-px');
  if (flags['stale-streak'] !== undefined) lmOpts.staleStreak = num('stale-streak');
  if (flags['group-m'] !== undefined) lmOpts.groupM = num('group-m');
  if (flags['min-obs'] !== undefined) lmOpts.minObs = num('min-obs');
  if (flags['min-arc'] !== undefined) lmOpts.minArcDeg = num('min-arc');
  if (flags['collapse'] !== undefined) lmOpts.splitCollapse = num('collapse');
  if (flags['max-rms'] !== undefined) lmOpts.maxRmsPx = num('max-rms');
  const quiet = flags.quiet !== undefined;
  const lm = createLandmarks({ log: (m) => { if (!quiet) console.log(m); }, opts: lmOpts });

  let lines = 0;
  let withPoints = 0;
  let usable = 0;
  let built = 0;
  let rejGuess = 0;
  let rejNoJitter = 0;
  let rejStaleJitter = 0;
  let rejJitter = 0;
  const held = [];

  for (const { entry } of readJournals(journals, { onError: usage })) {
    lines++;
    const msg = entry.msg;
    const room = entry.room;
    if (!msg?.points?.length) continue;
    withPoints++;
    // The same discipline the walls carve applies: an anchor founded on a pose
    // the survey itself would not trust is worse than no anchor. quality
    // 'good' plus mapSafe is that statement, and it is why the server puts both
    // on the journal entry rather than leaving them to be inferred.
    if (room?.quality !== 'good' || !room.mapSafe || !room.pose) continue;
    // The server's own function, not a paraphrase of it. This tool used to test
    // quality + mapSafe + pose and nothing else, while the server's gate also
    // demanded a fresh jitter measurement — so the tool reported a feature
    // working at 38 mm median error while the live server built zero anchors
    // for three sessions. It calls `landmarkGate` now, which is why that
    // function lives in landmarks.js rather than in server.js.
    if (gate === 'live' && !landmarkGate(entry)) {
      const j = room.jitter;
      if (msg.source === 'guess') rejGuess++;
      else if (!j) rejNoJitter++;
      else if (j.stale) rejStaleJitter++;
      else rejJitter++;
      continue;
    }
    usable++;

    if (usable % stride === 0) {
      // Held out: localize from landmarks alone and compare with the tags.
      held.push({ msg, truth: room.pose });
    } else {
      lm.observe(msg.clientId ?? 0, msg.points, msg.gen ?? 0, room.pose, msg.intr ?? msg.intrinsics);
      built++;
    }
  }

  const s = lm.stats();
  console.log(`\n${journals.length} journal(s), ${lines} entries`);
  console.log(`  with tracked points     ${withPoints}`);
  console.log(`  admitted (--gate ${gate})   ${usable}`);
  if (gate === 'live') {
    console.log(`  refused by the live gate: no jitter ${rejNoJitter}, `
      + `stale ${rejStaleJitter}, over ${LANDMARK_MAX_JITTER_MM} mm ${rejJitter}, `
      + `guess ${rejGuess}`);
  }
  console.log(`  used to build the map   ${built}`);
  console.log(`  held out for solving    ${held.length}`);
  console.log(`\nobservations ${s.observed}, tracks qualified ${s.qualified}`);
  console.log(`distinct anchors ${lm.count(0)}  (raw ${s.clients[0]?.anchors ?? 0} of `
    + `${s.clients[0]?.tracks ?? 0} tracks)`);
  const rejLine = Object.entries(s.rej).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  console.log(`qualification rejections: ${rejLine}`);

  // Staleness. The histogram is the part worth reading: the gate is only sound
  // if a healthy session's residuals sit well below it, so a `>32 px` column
  // with anything much in it means either the gate is in the wrong place or the
  // re-association is putting tracks on the wrong anchors.
  if (s.checked) {
    const bands = ['0-2', '2-4', '4-8', '8-16', '16-32', '>32'];
    const hist = s.resid.map((n, i) =>
      `${bands[i]} ${(100 * n / s.checked).toFixed(1)}%`).join('  ');
    console.log(`\nanchor residuals (${s.checked} checked): ${hist}`);
    console.log(`anchors dropped as stale: ${s.dropped}`);
  }

  // What the drawer would actually show. The card count is the number the
  // reader lives with, and it is not the region count: singletons collapse into
  // one note, so a grouping radius is judged on cards, not on groups.
  const groups = lm.groups(0);
  const cards = groups.filter((g) => g.n >= 2);
  const solo = groups.length - cards.length;
  const sizes = cards.map((g) => g.n).sort((a, b) => b - a);
  console.log(`\nregions ${groups.length} → ${cards.length} card(s)`
    + `${solo ? ` + 1 note for ${solo} singleton(s)` : ''}`
    + `, sizes ${sizes.join('/') || '—'}`);

  // ---- the holdout --------------------------------------------------------
  //
  // The seed is chained deliberately: the first solve starts from the last tag
  // pose and every later one starts from the previous solve, which is what the
  // live path does once the tags are gone. Letting the module fall back on its
  // own `lastPose` would quietly seed each solve from a *fresh* tag fix taken
  // one report earlier, and measure a situation that never occurs.
  const dp = [];
  const dq = [];
  let attempted = 0;
  let matched0 = 0;
  let chain = held[0]?.truth ?? null;
  for (const h of held) {
    attempted++;
    const r = lm.solve(h.msg.clientId ?? 0, h.msg.points, h.msg.gen ?? 0,
      h.msg.intr ?? h.msg.intrinsics, chain);
    if (!r) { matched0++; continue; }
    chain = r.pose;
    dp.push(dist3(r.pose.p, h.truth.p) * 1000);
    dq.push(quatAngleDeg(r.pose.q, h.truth.q));
  }
  const pct = (arr, p) => (arr.length
    ? arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] : NaN);
  console.log(`\nholdout: ${dp.length}/${attempted} frames localized from landmarks alone`
    + ` (${matched0} refused — fewer than ${minAnchors} anchors matched)`);
  if (dp.length) {
    console.log(`  position    median ${pct(dp, 0.5).toFixed(0)} mm, `
      + `p90 ${pct(dp, 0.9).toFixed(0)} mm, worst ${Math.max(...dp).toFixed(0)} mm`);
    console.log(`  orientation median ${pct(dq, 0.5).toFixed(2)} deg, `
      + `p90 ${pct(dq, 0.9).toFixed(2)} deg, worst ${Math.max(...dq).toFixed(2)} deg`);
  } else {
    console.log('  Nothing localized. Either the session never orbited anything (a');
    console.log('  walk-through yields no anchors at all — that is the measured');
    console.log('  behaviour, not a bug) or it holds no journal lines with points.');
  }

  // The gate is the one thing most worth checking and the hardest to reach from
  // outside, so it is checked directly: below the threshold the module must
  // return nothing rather than the metre-scale, tens-of-degrees-wrong pose that
  // a handful of near-coplanar bearing-only points produces.
  console.log(`\ncount gate: refusing below ${MIN_ANCHORS_FOR_FIX} anchors`
    + ` — ${s.refused} solve(s) refused after matching, ${matched0} before`);
})();
