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

const fs = require('fs');
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
    + '  [--pipeline live [--trace out.csv]]\n'
    + '  [--min-obs N] [--min-arc DEG] [--collapse X] [--max-rms X]\n'
    + '  [--reassoc-px X] [--reassoc-margin X] [--trim-px X] [--confirm-rms X]\n'
    + '  [--jump-m X] [--jump-deg X]  (Infinity disables the mirror tripwire)\n'
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
  if (flags['trim-px'] !== undefined) liveOpts.trimPx = num('trim-px');
  if (flags['confirm-rms'] !== undefined) liveOpts.confirmRms = num('confirm-rms');
  if (flags['jump-m'] !== undefined) liveOpts.jumpM = num('jump-m');
  if (flags['jump-deg'] !== undefined) liveOpts.jumpDeg = num('jump-deg');
  if (flags['solve-reassoc-px'] !== undefined) liveOpts.solveReassocPx = num('solve-reassoc-px');
  if (flags['voxel-min-n'] !== undefined) liveOpts.voxelMinN = num('voxel-min-n');
  if (flags['voxel-min-views'] !== undefined) liveOpts.voxelMinViews = num('voxel-min-views');
  if (flags['voxel-cluster-m'] !== undefined) liveOpts.voxelClusterM = num('voxel-cluster-m');
  if (flags['consensus-adopt-px'] !== undefined) liveOpts.consensusAdoptPx = num('consensus-adopt-px');
  if (flags['landmark-max-depth'] !== undefined) {
    liveOpts.landmarkMaxDepth = num('landmark-max-depth');
  }
  if (flags['takeover-min-inliers'] !== undefined) {
    liveOpts.takeoverMinInliers = num('takeover-min-inliers');
  }
  const maxFoundDepth = num('max-found-depth', 1);
  // --trace: one row per cross-check-eligible frame, recording where the solve
  // path's count died (.plans/landmark-lock.md §3). The module hands over a row
  // from inside solve(), which is before the agreement figures exist, so the
  // row is buffered here and finished with check()'s own answer — landmarks.js
  // stays unaware of CSVs and of what the caller does with the numbers.
  const tracePath = flags.trace;
  const traceRows = [];
  let pending = null;
  const lm = createLandmarks({
    log: (m) => { if (!quiet) console.log(m); },
    opts: liveOpts,
    trace: tracePath ? (row) => { pending = row; } : null,
  });
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
  // Takeovers separately from every cross-check: a takeover is the only place
  // a landmark solve *replaces* the reported pose, so its disagreement tail is
  // the risk figure any loosening of the gates has to be read against — a
  // takeover past ~0.5 m would be a wrong strong solve, not caught drift
  // (.plans/landmark-lock.md §7).
  const tookDp = [];
  // The jitter metric, and the one the person holding the phone actually sees:
  // how far the *reported* pose moves between consecutive tag-less frames,
  // against how far ARCore's own carry moved. A correction that is measured
  // and thrown away shows up here and nowhere else — the takeover counts and
  // the disagreement medians all looked healthy while the dot sawtoothed 235
  // mm a frame against a 13 mm carry.
  const stepRep = [];
  const stepCar = [];
  const stepTook = [];
  const stepQuiet = [];
  let prevTook = false;
  let prevRep = null;
  let prevCar = null;
  let prevAt = 0;
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
      lmFix: room.lmFix ?? null, lmCarry: room.lmCarry ?? null,
    };
    delete room.lmCheck;
    delete room.safeVia;
    delete room.landmarkRays;
    delete room.lmFix;
    // `lmCarry` marked a frame corrected by the carry fix that was built and
    // reverted on 03/08 (see the note in landmarks.js). Nothing writes it now;
    // it is stripped so the journals recorded while it was live still replay
    // against the raw carry rather than against a corrected pose.
    delete room.lmCarry;
    if (room.carried) {
      room.pose = room.carried;
      delete room.carried;
    }
    if (was.safeVia === 'landmark') room.mapSafe = false;
    if (entry.kind === 'xr-pose' && entry.msg.gen != null) {
      lm.noteDepth(0, entry.msg.gen, entry.msg.tags);
    }
    // --max-found-depth 0 refuses founding on the alignFresh *carry* and keeps
    // only tag-confirmed frames. That is the experiment the 03/08 carry-fix
    // reversal left open: a map founded under carried poses inherits their
    // drift as a frame offset, and this is what tests it — the holdout has
    // always built this way and localizes to 23-31 mm, while the live
    // depth-1 map disagrees with the tags by 65-95 mm at re-acquire.
    const rawFound = foundingDepth(entry);
    const found = rawFound !== null && rawFound > maxFoundDepth ? null : rawFound;
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
    pending = null;
    // maintainLandmarks returns before check() on a report with no tracked
    // points, applying only the carry correction. Mirrored exactly, or the
    // replay reports a different product on the majority of tag-less frames.
    const r = lm.check(0, entry);
    if (tracePath && pending) {
      const b = (v) => (v ? 1 : 0);
      traceRows.push({
        line: lines,
        ...pending,
        dpMm: r ? Math.round(r.dp * 1000) : '',
        deg: r ? Math.round(r.deg * 10) / 10 : '',
        agrees: r ? b(r.agrees) : '',
        confirmed: r ? b(r.confirmed) : '',
        took: r ? b(r.took) : '',
        rescued: r && room.safeVia === 'landmark' ? 1 : 0,
      });
      pending = null;
    }
    // After check(), so `room.pose` is what the client would have been shown.
    if (room.quality === 'tracked' && room.pose) {
      const car = room.carried ?? room.pose;
      const dt = (entry.at - prevAt) / 1000;
      if (prevRep && dt > 0 && dt < 0.4) {
        const sr = dist3(room.pose.p, prevRep.p) * 1000;
        stepRep.push(sr);
        stepCar.push(dist3(car.p, prevCar.p) * 1000);
        // Split on whether a takeover is involved: a correction that persists
        // shows up precisely as these two converging, and an aggregate median
        // hides it — most tag-less frames carry no solve at all and step like
        // ARCore whatever the takeover does.
        if (room.lmFix || prevTook) stepTook.push(sr); else stepQuiet.push(sr);
      }
      prevTook = !!room.lmFix;
      prevRep = room.pose;
      prevCar = car;
      prevAt = entry.at;
    } else {
      prevRep = null;
    }
    if (r) {
      solved++;
      dp.push(r.dp * 1000);
      deg.push(r.deg);
      if (r.agrees) agreed++;
      if (r.confirmed) confirmed++;
      if (r.took) { took++; tookDp.push(r.dp * 1000); }
      if (room.safeVia === 'landmark') rescued++;
    }
    const now = JSON.stringify({
      c: room.lmCheck, s: room.safeVia, r: room.landmarkRays, f: room.lmFix ?? null,
      y: room.lmCarry ?? null });
    const then = JSON.stringify({ c: was.lmCheck, s: was.safeVia, r: was.rays, f: was.lmFix,
      y: was.lmCarry });
    // "Did this frame produce landmark output at all" is the classifier, and a
    // carry correction counts: it is written on frames that never solved, so
    // keying on lmCheck alone would file every one of them as a mismatch and
    // bury the ones that are.
    const hadAny = was.lmCheck || was.lmCarry;
    const hasAny = room.lmCheck || room.lmCarry;
    if (now === then) { if (hadAny || hasAny) parity.match++; }
    else if (!hadAny && hasAny) parity.replayOnly++;
    else if (hadAny && !hasAny) parity.journalOnly++;
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
    + `pose taken over ${took}`
    + (tookDp.length ? ` (takeover shift median ${pct(tookDp, 0.5).toFixed(0)} mm, `
      + `worst ${Math.max(...tookDp).toFixed(0)} mm)` : ''));
  if (stepRep.length) {
    console.log(`  reported pose step, tag-less frames  median `
      + `${pct(stepRep, 0.5).toFixed(0)} mm, p90 ${pct(stepRep, 0.9).toFixed(0)}, `
      + `worst ${Math.max(...stepRep).toFixed(0)}`);
    console.log(`  ARCore carry step, same frames       median `
      + `${pct(stepCar, 0.5).toFixed(0)} mm, p90 ${pct(stepCar, 0.9).toFixed(0)}, `
      + `worst ${Math.max(...stepCar).toFixed(0)}`);
    if (stepTook.length) {
      console.log(`    on/next to a takeover (${stepTook.length}) median `
        + `${pct(stepTook, 0.5).toFixed(0)} mm, p90 ${pct(stepTook, 0.9).toFixed(0)}`
        + `  ·  quiet frames (${stepQuiet.length}) median ${pct(stepQuiet, 0.5).toFixed(0)} mm`);
    }
  }
  const st = lm.stats();
  if (st.jumped) {
    // Not a footnote: a non-zero count here means the gates as set are
    // producing mirrored solves, and the tripwire is the only thing between
    // one of them and a takeover reporting the room's reflection.
    console.log(`  solves refused as mirror jumps    ${st.jumped}`);
  }
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
  if (tracePath) {
    // A fixed column list, not the union of whatever keys the rows happen to
    // carry: an early-exit row has no `matched*` and a solved one has no
    // `why`, and a CSV whose columns move with the data cannot be diffed
    // between two runs — which is the only thing this file is for.
    const cols = ['line', 'seq', 'outcome', 'seedSrc', 'sinceSolve', 'pts',
      'seedPairs', 'seedShiftMm',
      'shiftPairs', 'shiftPxU', 'shiftPxV', 'scatterPx',
      'refined', 'inView', 'near', 'nearFree', 'blockedByCoarse', 'bestPxP50',
      'aliasTotal', 'aliasLive', 'aliasLiveRefined', 'aliasAgeP50', 'aliasDied',
      'adoptedTight', 'matchedTight', 'adoptedWide', 'matchedWide',
      'why', 'inliers', 'n', 'rms', 'jumpMm', 'jumpDeg',
      'lateralM', 'depthM', 'nearM', 'depthRatio',
      'dpMm', 'deg', 'agrees', 'confirmed', 'took', 'rescued'];
    const out = [cols.join(',')];
    for (const row of traceRows) out.push(cols.map((c) => row[c] ?? '').join(','));
    fs.writeFileSync(tracePath, `${out.join('\n')}\n`);
    console.log(`trace: ${traceRows.length} row(s) written to ${tracePath}`);
    // The map the trace was measured against, beside it: a per-frame row can
    // say projections miss by 25 px but not *which* landmarks are missing, and
    // provenance (`src` — arc, depth, or a refined consensus point) is the
    // difference between "tighten the refinement gate" and "the whole
    // consensus branch is the wrong grade". `err` is the rms the position was
    // accepted at, which is the gate a fix would move.
    const lcols = ['id', 'src', 'coarse', 'depth', 'err', 'n', 'span', 'checks', 'bad',
      'group', 'missN', 'missP50'];
    const lout = [lcols.join(',')];
    for (const [id, a] of lm._landmarksFor(0)) {
      const miss = (a.traceMiss ?? []).slice().sort((x, y) => x - y);
      lout.push([id, a.src ?? '', a.coarse ? 1 : 0, a.depth ?? 0,
        a.err === null || a.err === undefined ? '' : Math.round(a.err * 100) / 100,
        a.n ?? '', Math.round(a.span ?? 0), a.checks ?? 0, a.bad ?? 0, a.group ?? '',
        miss.length,
        miss.length ? Math.round(miss[miss.length >> 1] * 10) / 10 : ''].join(','));
    }
    const lpath = tracePath.replace(/(\.csv)?$/, '.landmarks.csv');
    fs.writeFileSync(lpath, `${lout.join('\n')}\n`);
    console.log(`trace: ${lout.length - 1} landmark(s) written to ${lpath}`);
  }
  // The one measurement of landmark *position* with the correspondence not in
  // doubt: taken through a tag-derived pose, on the track the landmark is
  // already aliased to. Every solve-time distance is a nearest-point distance
  // and cannot tell a landmark that is 20 px wrong from one paired with the
  // wrong corner; this can, and it is what says whether the refinement gates
  // are the thing to move.
  if (st.checked) {
    const bands = ['0-2', '2-4', '4-8', '8-16', '16-32', '>32'];
    console.log(`  refined-landmark residuals under tag poses (${st.checked}): `
      + st.resid.map((v, i) => `${bands[i]} ${(100 * v / st.checked).toFixed(1)}%`).join('  '));
  }
  console.log(`parity vs journal: match ${parity.match}, mismatch ${parity.mismatch}, `
    + `replay-only ${parity.replayOnly}, journal-only ${parity.journalOnly}`);
  if (firstMismatch) {
    console.log(`first mismatch at entry ${firstMismatch.line}:`);
    console.log(`  journal: ${firstMismatch.then}`);
    console.log(`  replay:  ${firstMismatch.now}`);
  }
  process.exit(parity.mismatch ? 1 : 0);
}

// The trace measures the live cross-check's frame-to-frame dynamics, which the
// holdout does not have — it localizes a strided sample, so "how long has the
// lock been gone" has no meaning there. Refused rather than silently ignored.
if (flags.trace !== undefined) usage('--trace works only with --pipeline live');

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
  if (flags['trim-px'] !== undefined) lmOpts.trimPx = num('trim-px');
  if (flags['jump-m'] !== undefined) lmOpts.jumpM = num('jump-m');
  if (flags['jump-deg'] !== undefined) lmOpts.jumpDeg = num('jump-deg');
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
  let mirrored = 0;
  let chain = held[0]?.truth ?? null;
  for (const h of held) {
    attempted++;
    const r = lm.solve(h.msg.clientId ?? 0, h.msg.points, h.msg.gen ?? 0,
      h.msg.intr ?? h.msg.intrinsics, chain);
    if (!r) { matched0++; continue; }
    chain = r.pose;
    dp.push(dist3(r.pose.p, h.truth.p) * 1000);
    dq.push(quatAngleDeg(r.pose.q, h.truth.q));
    // The holdout calls solve() directly and so is deliberately *not* behind
    // the mirror tripwire — that lives in check(), which always has a
    // same-frame carried pose to judge against, and this does not (its seed is
    // the previous held frame, strided and possibly far away). So the flip
    // shows up here in the worst case, and is counted rather than left to be
    // discovered as an unexplained metre-scale number: this figure is the
    // *solver's* honesty, the live pipeline's is the product's.
    if (dq[dq.length - 1] > 45) mirrored++;
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
    if (mirrored) {
      console.log(`  ${mirrored} of ${dp.length} solve(s) past 45 deg — the mirror flip.`);
      console.log('  Expected here and not a regression: the holdout is the raw solver,');
      console.log('  with no same-frame carried pose to check a jump against. The live');
      console.log("  pipeline's tripwire (SOLVE_JUMP_DEG) refuses these; --pipeline live");
      console.log('  reports how many it caught.');
    }
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
  if (s.jumped) console.log(`mirror tripwire: ${s.jumped} solve(s) refused as jumps`);
})();
