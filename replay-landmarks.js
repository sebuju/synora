'use strict';

// Replay recorded pose journals through the landmark module, so landmark supply
// and localization accuracy are measured instead of argued.
//
//   node replay-landmarks.js recordings/<stamp>_clientN.pose.jsonl [more ...]
//     [--min-obs 12] [--min-arc 60] [--min-landmarks 15] [--stride 2]
//
// Unlike the walls replay this needs no markers.json and no pixels: a journal
// line already carries the tracked points, the camera model and the pose the
// survey produced from the tags, which is everything the landmark map consumes.
// Journals recorded before the client published `points` simply report zero.
//
// The headline is the **holdout**: landmarks are built from one share of the
// reports and the camera is then localized from the other share with the tag
// pose withheld, so no landmark is ever tested against a frame that helped create
// it. Position and orientation error are against the tag-derived pose recorded
// on that same line — the best reference available, and the one the product
// would have used.

const { parseArgs, numFlag, readJournals } = require('./replay-common.js');
const {
  createLandmarks, landmarkGate, foundingDepth,
  MIN_LANDMARKS_FOR_FIX, LANDMARK_MAX_JITTER_MM,
} = require('./landmarks.js');
const { quatAngleDeg } = require('./public/pose-math.js');
const { dist3 } = require('./public/landmark-math.js');

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node replay-landmarks.js <journal.pose.jsonl> [more ...]\n'
    + '  [--gate live|any] [--min-landmarks N] [--stride N]\n'
    + '  [--min-obs N] [--min-arc DEG] [--collapse X] [--max-rms X]\n'
    + '  [--reassoc-px X] [--reassoc-margin X]\n'
    + '  [--voxel-min-n N] [--voxel-min-views N] [--voxel-cluster-m X]\n'
    + '  [--stale-px X] [--stale-streak N] [--group-m X] [--quiet 1]');
  process.exit(1);
}

const { positional: journals, flags } = parseArgs(process.argv.slice(2), { usage });
if (!journals.length) usage();
const num = (key, dflt) => numFlag(flags, key, dflt, usage);

// --pipeline live: replay the server's own maintainLandmarks flow line by line
// — landmarkGate → observe, else the tag-less cross-check via landmarks.check()
// — and diff what check() writes onto each entry against what the live server
// journalled there. The parity counter is the fidelity contract: replay-walls
// consumes journalled landmarkRays unchanged, and this is the tool that proves
// the production side reproducible. On journals recorded before the
// cross-check existed every derived line counts as replay-only, which is the
// expected answer, not a failure — it shows what that walk would have done.
if (flags.pipeline !== undefined && flags.pipeline !== 'live') {
  usage(`--pipeline must be live, not ${flags.pipeline}`);
}
if (flags.pipeline === 'live') {
  const quiet = flags.quiet !== undefined;
  const liveOpts = {};
  if (flags['min-landmarks'] !== undefined) liveOpts.minLandmarks = num('min-landmarks');
  if (flags['solve-reassoc-px'] !== undefined) liveOpts.solveReassocPx = num('solve-reassoc-px');
  if (flags['voxel-min-n'] !== undefined) liveOpts.voxelMinN = num('voxel-min-n');
  if (flags['voxel-min-views'] !== undefined) liveOpts.voxelMinViews = num('voxel-min-views');
  if (flags['voxel-cluster-m'] !== undefined) liveOpts.voxelClusterM = num('voxel-cluster-m');
  if (flags['consensus-adopt-px'] !== undefined) liveOpts.consensusAdoptPx = num('consensus-adopt-px');
  const lm = createLandmarks({ log: (m) => { if (!quiet) console.log(m); }, opts: liveOpts });
  let lines = 0;
  let fed = 0;
  let fedCarried = 0;
  let eligible = 0;
  let solved = 0;
  let agreed = 0;
  let confirmed = 0;
  let rescued = 0;
  let took = 0;
  const dp = [];
  const deg = [];
  const parity = { match: 0, mismatch: 0, replayOnly: 0, journalOnly: 0 };
  let firstMismatch = null;
  for (const { entry } of readJournals(journals, { onError: usage })) {
    lines++;
    const room = entry.room;
    if (!room) continue;
    // What the live server journalled, lifted off the entry so check() derives
    // fresh — including the pre-rescue mapSafe, or the re-derived rescue would
    // be judged against its own outcome. A takeover frame journals the solve's
    // pose with the carried one preserved beside it; the carry goes back as
    // the input, exactly what the live check() started from.
    const was = {
      lmCheck: room.lmCheck, safeVia: room.safeVia, rays: room.landmarkRays,
      lmFix: room.lmFix ?? null,
    };
    delete room.lmCheck;
    delete room.safeVia;
    delete room.landmarkRays;
    delete room.lmFix;
    if (room.carried) {
      room.pose = room.carried;
      delete room.carried;
    }
    if (was.safeVia === 'landmark') room.mapSafe = false;
    if (entry.kind === 'xr-pose' && entry.msg.gen != null) {
      lm.noteDepth(0, entry.msg.gen, entry.msg.tags);
    }
    const found = foundingDepth(entry);
    if (found !== null) {
      lm.observe(0, entry.msg.points, entry.msg.gen ?? 0, room.pose,
        entry.msg.intr ?? entry.msg.intrinsics, found);
      fed++;
      if (found === 1) fedCarried++;
      // A depth-1 (alignFresh-carried) frame is also the cross-check's frame
      // — fall through, exactly as maintainLandmarks does.
      if (found === 0) continue;
    }
    if (entry.kind === 'xr-pose' && room.pose && room.quality === 'tracked'
      && entry.msg.points?.length && entry.msg.gen != null) eligible++;
    const r = lm.check(0, entry);
    if (r) {
      solved++;
      dp.push(r.dp * 1000);
      deg.push(r.deg);
      if (r.agrees) agreed++;
      if (r.confirmed) confirmed++;
      if (r.took) took++;
      if (room.safeVia === 'landmark') rescued++;
    }
    const now = JSON.stringify({
      c: room.lmCheck, s: room.safeVia, r: room.landmarkRays, f: room.lmFix ?? null });
    const then = JSON.stringify({ c: was.lmCheck, s: was.safeVia, r: was.rays, f: was.lmFix });
    if (now === then) { if (was.lmCheck || room.lmCheck) parity.match++; }
    else if (!was.lmCheck && room.lmCheck) parity.replayOnly++;
    else if (was.lmCheck && !room.lmCheck) parity.journalOnly++;
    else {
      parity.mismatch++;
      if (!firstMismatch) firstMismatch = { line: lines, then, now };
    }
  }
  const pct = (arr, p) => (arr.length
    ? arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] : NaN);
  console.log(`\n${journals.length} journal(s), ${lines} entries — live pipeline`);
  console.log(`  fed to the map                  ${fed}`
    + ` (${fedCarried} on the alignFresh carry)`);
  console.log(`  cross-check eligible (tracked)  ${eligible}`);
  console.log(`  solved                          ${solved}`);
  if (dp.length) {
    console.log(`  disagreement vs carried pose:   position median ${pct(dp, 0.5).toFixed(0)} mm, `
      + `p90 ${pct(dp, 0.9).toFixed(0)} mm, worst ${Math.max(...dp).toFixed(0)} mm`);
    console.log(`                                  orientation median ${pct(deg, 0.5).toFixed(2)}°, `
      + `p90 ${pct(deg, 0.9).toFixed(2)}°, worst ${Math.max(...deg).toFixed(2)}°`);
  }
  console.log(`  agreed ${agreed}, confirmed ${confirmed}, mapSafe rescued ${rescued}, `
    + `pose taken over ${took}`);
  const st = lm.stats();
  const dsum = lm.summary(0)?.depth;
  console.log(`  landmarks ${st.clients[0]?.landmarks ?? 0}`
    + ` (${st.qualified - st.qualifiedDepth - st.qualifiedConsensus} by arc, `
    + `${st.qualifiedDepth} by depth, ${st.qualifiedConsensus} by consensus`
    + `, ${st.refinedConsensus} refined to solve grade`
    + `${st.consensusEarly ? `, ${st.consensusEarly} consensus died young` : ''})`
    + (dsum && dsum.n
      ? ` — depth ${dsum.trusted ? 'trusted' : 'NOT trusted'}`
        + ` scale ${dsum.k}, ±${dsum.residPct ?? '—'}% over ${dsum.n}`
      : ' — no depth samples'));
  console.log(`parity vs journal: match ${parity.match}, mismatch ${parity.mismatch}, `
    + `replay-only ${parity.replayOnly}, journal-only ${parity.journalOnly}`);
  if (firstMismatch) {
    console.log(`first mismatch at entry ${firstMismatch.line}:`);
    console.log(`  journal: ${firstMismatch.then}`);
    console.log(`  replay:  ${firstMismatch.now}`);
  }
  process.exit(parity.mismatch ? 1 : 0);
}

// Every Nth report is held out for localization; the rest build the map.
const stride = num('stride', 2);
const minLandmarks = num('min-landmarks', MIN_LANDMARKS_FOR_FIX);
// Which admission gate to replay. `live` is the server's own (see below) and is
// the default, because a replay that measures a looser gate than the product
// runs is worse than no replay. `any` is the old behaviour, kept because it
// answers a different and still useful question: what the data would support if
// admission were not the binding constraint.
const gate = flags.gate ?? 'live';
if (gate !== 'live' && gate !== 'any') usage(`--gate must be live or any, not ${gate}`);

(() => {
  const lmOpts = { minLandmarks };
  if (flags['reassoc-px'] !== undefined) lmOpts.reassocPx = num('reassoc-px');
  if (flags['solve-reassoc-px'] !== undefined) lmOpts.solveReassocPx = num('solve-reassoc-px');
  if (flags['reassoc-margin'] !== undefined) lmOpts.reassocMargin = num('reassoc-margin');
  if (flags['stale-px'] !== undefined) lmOpts.stalePx = num('stale-px');
  if (flags['stale-streak'] !== undefined) lmOpts.staleStreak = num('stale-streak');
  if (flags['group-m'] !== undefined) lmOpts.groupM = num('group-m');
  if (flags['voxel-min-n'] !== undefined) lmOpts.voxelMinN = num('voxel-min-n');
  if (flags['voxel-min-views'] !== undefined) lmOpts.voxelMinViews = num('voxel-min-views');
  if (flags['voxel-cluster-m'] !== undefined) lmOpts.voxelClusterM = num('voxel-cluster-m');
  if (flags['consensus-adopt-px'] !== undefined) lmOpts.consensusAdoptPx = num('consensus-adopt-px');
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
    // The map-building share must measure depth trust the way the live path
    // does, or the holdout builds from a different map than production would.
    if (entry.kind === 'xr-pose' && msg?.gen != null) lm.noteDepth(0, msg.gen, msg.tags);
    if (!msg?.points?.length) continue;
    withPoints++;
    // The same discipline the walls carve applies: an landmark founded on a pose
    // the survey itself would not trust is worse than no landmark. quality
    // 'good' plus mapSafe is that statement, and it is why the server puts both
    // on the journal entry rather than leaving them to be inferred.
    if (room?.quality !== 'good' || !room.mapSafe || !room.pose) continue;
    // The server's own function, not a paraphrase of it. This tool used to test
    // quality + mapSafe + pose and nothing else, while the server's gate also
    // demanded a fresh jitter measurement — so the tool reported a feature
    // working at 38 mm median error while the live server built zero landmarks
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
  console.log(`\nobservations ${s.observed}, tracks qualified ${s.qualified}`
    + ` (${s.qualified - s.qualifiedDepth - s.qualifiedConsensus} by arc, `
    + `${s.qualifiedDepth} by depth, ${s.qualifiedConsensus} by consensus)`);
  if (s.qualifiedConsensus || s.consensusEarly) {
    console.log(`consensus landmarks died young (stale within 50 checks): ${s.consensusEarly}`);
  }
  console.log(`distinct landmarks ${lm.count(0)}  (raw ${s.clients[0]?.landmarks ?? 0} of `
    + `${s.clients[0]?.tracks ?? 0} tracks)`);
  const rejLine = Object.entries(s.rej).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  console.log(`qualification rejections: ${rejLine}`);

  // Staleness. The histogram is the part worth reading: the gate is only sound
  // if a healthy session's residuals sit well below it, so a `>32 px` column
  // with anything much in it means either the gate is in the wrong place or the
  // re-association is putting tracks on the wrong landmarks.
  if (s.checked) {
    const bands = ['0-2', '2-4', '4-8', '8-16', '16-32', '>32'];
    const hist = s.resid.map((n, i) =>
      `${bands[i]} ${(100 * n / s.checked).toFixed(1)}%`).join('  ');
    console.log(`\nlandmark residuals (${s.checked} checked): ${hist}`);
    console.log(`landmarks dropped as stale: ${s.dropped}`);
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
    + ` (${matched0} refused — fewer than ${minLandmarks} landmarks matched)`);
  if (dp.length) {
    console.log(`  position    median ${pct(dp, 0.5).toFixed(0)} mm, `
      + `p90 ${pct(dp, 0.9).toFixed(0)} mm, worst ${Math.max(...dp).toFixed(0)} mm`);
    console.log(`  orientation median ${pct(dq, 0.5).toFixed(2)} deg, `
      + `p90 ${pct(dq, 0.9).toFixed(2)} deg, worst ${Math.max(...dq).toFixed(2)} deg`);
  } else {
    console.log('  Nothing localized. Either the session never orbited anything (a');
    console.log('  walk-through yields no landmarks at all — that is the measured');
    console.log('  behaviour, not a bug) or it holds no journal lines with points.');
  }

  // The gate is the one thing most worth checking and the hardest to reach from
  // outside, so it is checked directly: below the threshold the module must
  // return nothing rather than the metre-scale, tens-of-degrees-wrong pose that
  // a handful of near-coplanar bearing-only points produces.
  console.log(`\ncount gate: refusing below ${MIN_LANDMARKS_FOR_FIX} landmarks`
    + ` — ${s.refused} solve(s) refused after matching, ${matched0} before`);
})();
