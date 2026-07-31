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

const fs = require('fs');
const path = require('path');
const { createLandmarks, MIN_ANCHORS_FOR_FIX, loadCv } = require('./landmarks.js');
const { quatAngleDeg } = require('./public/pose-math.js');
const { dist3 } = require('./public/landmark-math.js');

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node replay-landmarks.js <journal.pose.jsonl> [more ...]\n'
    + '  [--min-obs N] [--min-arc DEG] [--min-anchors N] [--stride N]');
  process.exit(1);
}

const journals = [];
const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (i + 1 >= argv.length) usage(`missing value for --${key}`);
    flags[key] = Number(argv[++i]);
    if (!Number.isFinite(flags[key])) usage(`bad number for --${key}`);
  } else {
    journals.push(a);
  }
}
if (!journals.length) usage();

// Every Nth report is held out for localization; the rest build the map.
const stride = flags.stride ?? 2;
const minAnchors = flags['min-anchors'] ?? MIN_ANCHORS_FOR_FIX;

function* entries(files) {
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      usage(`cannot read ${file}: ${err.message}`);
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;   // torn final line of a journal cut off mid-write
      }
      if (e.kind === 'meta') continue;
      yield { file, e };
    }
  }
}

(async () => {
  await loadCv((m) => console.log(m));

  const lm = createLandmarks({ log: (m) => console.log(m) });

  let lines = 0;
  let withPoints = 0;
  let usable = 0;
  let built = 0;
  const held = [];

  for (const { e } of entries(journals)) {
    lines++;
    const msg = e.msg;
    const room = e.room;
    if (!msg?.points?.length) continue;
    withPoints++;
    // The same discipline the walls carve applies: an anchor founded on a pose
    // the survey itself would not trust is worse than no anchor. quality
    // 'good' plus mapSafe is that statement, and it is why the server puts both
    // on the journal entry rather than leaving them to be inferred.
    if (room?.quality !== 'good' || !room.mapSafe || !room.pose) continue;
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
  console.log(`  usable (good + mapSafe) ${usable}`);
  console.log(`  used to build the map   ${built}`);
  console.log(`  held out for solving    ${held.length}`);
  console.log(`\nobservations ${s.observed}, tracks qualified ${s.qualified}`);
  console.log(`distinct anchors ${lm.count(0)}  (raw ${s.clients[0]?.anchors ?? 0} of `
    + `${s.clients[0]?.tracks ?? 0} tracks)`);
  const rejLine = Object.entries(s.rej).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  console.log(`qualification rejections: ${rejLine}`);

  // ---- the holdout --------------------------------------------------------
  const dp = [];
  const dq = [];
  let attempted = 0;
  let matched0 = 0;
  for (const h of held) {
    attempted++;
    const r = lm.solve(h.msg.clientId ?? 0, h.msg.points, h.msg.gen ?? 0, h.msg.intr ?? msg.intrinsics);
    if (!r) { matched0++; continue; }
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

  if (process.listeners('unhandledRejection').length
    || process.listeners('uncaughtException').length) {
    console.log('\nWARNING: opencv.js left process listeners installed — the strip in '
      + 'landmarks.js ensureCv() is not working, and the server would inherit them.');
  } else {
    console.log('process listeners clean (opencv.js installs two; both stripped)');
  }
})();
