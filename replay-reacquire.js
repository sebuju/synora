'use strict';

// The re-acquire test: at the moment the tags come back, was the landmark
// solve's pose closer to the room than the ARCore carry it would have
// replaced?
//
// This is the arbiter `.plans/landmark-takeover-trust.md` §3 exists for. The
// takeover is the only place a landmark solve overrules ARCore, and every
// number behind it so far — disagreement medians, takeover counts, step jitter
// — measures the solve against the carry, which cannot say which of the two is
// right. The tags can.
//
// It lives beside `replay-landmarks.js --pipeline live` rather than inside it:
// that loop already re-derives every solve under sweepable gates and is the
// only thing that can produce a solve pose on a frame that never took over,
// which is where the sample size is. It hands frames here; the geometry,
// the reference and the verdict are this file's business.
//
// ## Why the obvious construction is wrong
//
// §3 said: propagate both candidates from the takeover frame T to the next
// `good` frame G through ARCore's own session-frame delta, and compare against
// the tag fix at G.
//
// The propagation half is exact. `room.pose` is `se3Compose(A.T, msg.xr)`
// (survey.js) and `A.T` is frozen on tag-less frames, so carrying a pose
// forward through `xr_T⁻¹ ∘ xr_G` is an identity, not an approximation —
// `identity` below asserts it at 0.00 mm and voids the journal if it drifts.
//
// The reference half is circular. `room.pose` on a `good` frame is *not* the
// tag fix: the alignment is an EMA nudge at gain 0.02-0.25 (`alignAlpha`), so
// one good frame after a tag-less stretch the reference still sits ~75% of the
// way back at the carry — at the null hypothesis. Measured over 17 takeovers
// with a fixed population, the carry "wins" 14/17 at the first good frame and
// the count reverses by the twentieth. The unfiltered tag fix (`camRoom`) is
// never journalled, and recomputing it needs `markers.json`, which has moved
// up to 151 mm since these walks — the size of the effect.
//
// So the reference is the **converged alignment**: follow A forward through the
// good run until it stops moving, and use where it settled. Journal-only, no
// map, and self-validating — the plateau is the evidence that the EMA has
// converged. A run the phone stood still through can plateau falsely (alpha
// floors at 0.02 when nothing moves) and is refused rather than counted.

const fs = require('fs');
const { se3Compose, se3Invert, quatAngleDeg, quatRotate } = require('./public/pose-math.js');
// The live coach (`landmarks.walkCue`) asks the walker for exactly the run this
// scores, so the two read the same constants rather than each carrying its own
// copy — a cue that says "done" on a run this then refuses is worse than none.
const {
  REACQUIRE_MIN_GOOD, REACQUIRE_MIN_RUN_M, REACQUIRE_RUN_BREAK_MS,
} = require('./landmarks.js');

const KMAX = 25;                 // how far the convergence table looks
const LOOK_M = 2;                // lever arm for the pointing-error column
const LADDER = [15, 20, 25, 30, 40, 60];
const MIN_LADDER = LADDER[0];

const pct = (arr, p) => (arr.length
  ? arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] : NaN);
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// The exact one-sided binomial tail at p=0.5, in the direction observed. Log
// space because n stays small but the coefficients do not.
function signTest(wins, n) {
  if (!n) return 1;
  const k = wins * 2 >= n ? wins : n - wins;
  let lc = 0;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) sum += Math.exp(lc - n * Math.LN2);
    lc += Math.log(n - i) - Math.log(i + 1);
  }
  return Math.min(1, sum);
}

// Where the camera thinks it is looking, LOOK_M ahead. Orientation error only
// becomes a number a person can weigh at a room-scale lever arm — 7.8° at 3.3 m
// is 450 mm of implied position (.claude/rules/room-positioning.md).
function lookAt(pose) {
  const v = quatRotate(pose.q, [0, 0, -LOOK_M]);
  return [pose.p[0] + v[0], pose.p[1] + v[1], pose.p[2] + v[2]];
}

// A pose and the session pose it was measured at, as the room←session
// alignment they imply. Every candidate in this file is compared as an
// alignment: it is the quantity that is actually in dispute, and it removes
// the need to propagate the reference anywhere.
const alignOf = (pose, xr) => se3Compose(pose, se3Invert(xr));
const atFrame = (A, xr) => se3Compose(A, xr);

function createReacquire(opts = {}) {
  const refMinGood = opts.refMinGood ?? REACQUIRE_MIN_GOOD;
  const plateauM = (opts.plateauMm ?? 15) / 1000;
  const minRunMotionM = opts.minRunMotionM ?? REACQUIRE_MIN_RUN_M;
  // The alignment is frozen for the *whole* tag-less stretch, so the delta
  // identity holds however long the stretch is — the window is not a validity
  // bound, it is a noise bound. What a long gap costs is dilution: ARCore drift
  // accrued after T is in the carry's error at G and no solve at T could have
  // known about it, and it lands on both candidates alike. Measured on
  // 161712, a solve sits a median 8.9 s from the next tag confirmation, so a
  // four-second window scored 2 boundaries out of 17 and answered nothing.
  // Wide by default, bucketed by gap, and the buckets are where the reading is.
  const maxGapMs = opts.maxGapMs ?? 20000;
  const refMaxMs = opts.refMaxMs ?? 10000;
  const runBreakMs = opts.runBreakMs ?? REACQUIRE_RUN_BREAK_MS;
  const identityTolMm = opts.identityTolMm ?? 1;
  const confirmRms = opts.confirmRms;
  const gateInliers = opts.gateInliers;
  const allSolves = !!opts.allSolves;

  // One compact record per journal entry. Buffered rather than streamed: the
  // reference lies *after* the event and the convergence table needs the whole
  // run, so a one-pass state machine would be a lookahead buffer wearing a
  // disguise. ~200 bytes an entry, against journals of a few thousand.
  const frames = [];

  return {
    // Called from the live pipeline for every entry it processed, with the
    // pre-check pose (the ARCore carry — what check() compares against) and
    // check()'s own return.
    frame({ file, line, entry, carry }) {
      const msg = entry.msg;
      const room = entry.room;
      if (!msg?.xr || !carry) return;
      frames.push({
        file,
        line,
        at: entry.at,
        sid: msg.sid ?? null,
        q: room.quality,
        xr: msg.xr,
        xrNow: msg.xrNow ?? null,
        // On a tag-less frame this is the carry; on a `good` frame it is the
        // alignment as the tags have nudged it so far. Same expression either
        // way, which is the point — both are A ∘ xr.
        pose: carry,
        fix: null,
        inliers: 0,
        rms: 0,
        dp: 0,
        deg: 0,
        agrees: false,
        quar: room.quarantined === true,
        took: false,
      });
    },

    // check()'s answer for the frame just noted. Two calls rather than one
    // because the live pipeline's gated `continue` sits between them — a
    // depth-0 founding frame never reaches check(), and it is exactly the
    // `good` frame the reference is taken from.
    solve(r) {
      const f = frames[frames.length - 1];
      if (!f || !r?.fix) return;
      f.fix = r.fix.pose;
      f.inliers = r.fix.inliers;
      f.rms = r.fix.rms;
      f.dp = r.dp;
      f.deg = r.deg;
      f.agrees = !!r.agrees;
      f.took = !!r.took;
    },

    report({ tracePath = null, inlierSweep = false } = {}) {
      return run(frames, {
        refMinGood,
        plateauM,
        minRunMotionM,
        maxGapMs,
        refMaxMs,
        runBreakMs,
        identityTolMm,
        confirmRms,
        gateInliers,
        allSolves,
        tracePath,
        inlierSweep,
      });
    },
  };
}

// The delta identity, and its control. Carrying one tracked frame's pose
// forward through the session-frame delta must reproduce the next frame's pose
// exactly, because the alignment cannot have moved without a tag. If it does
// not, every number below it is meaningless — a slipped session frame, an
// alignment re-acquire mid-stretch, or a composition-order bug in this file.
// The same test through `msg.xrNow` must come out *worse*: xrNow is where the
// phone is now, room.pose was built from where it was when the tags were seen,
// and a control that does not fail proves the test is not reading anything.
function identity(frames) {
  const viaXr = [];
  const viaNow = [];
  const ctlXr = [];
  // The control needs a *pair of detection frames*: `xrNow` rides only a frame
  // that ran the detector, and most tag-less frames are synthesized carries
  // with no such field. Pairing them across the carries in between is sound as
  // long as no `good` frame intervened — that is the only thing that moves the
  // alignment, and it is what `lastDet` is reset by.
  let lastDet = null;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a.file === b.file && a.sid === b.sid
      && b.q === 'tracked' && (a.q === 'tracked' || a.q === 'good')) {
      viaXr.push(d3(atFrame(alignOf(a.pose, a.xr), b.xr).p, b.pose.p) * 1000);
    }
    if (b.q === 'good') { lastDet = null; continue; }
    if (!b.xrNow) continue;
    if (lastDet && lastDet.file === b.file && lastDet.sid === b.sid && b.q === 'tracked') {
      viaNow.push(d3(atFrame(alignOf(lastDet.pose, lastDet.xrNow), b.xrNow).p, b.pose.p) * 1000);
      ctlXr.push(d3(atFrame(alignOf(lastDet.pose, lastDet.xr), b.xr).p, b.pose.p) * 1000);
    }
    lastDet = b;
  }
  return { viaXr, viaNow, ctlXr };
}

// Score one candidate solve against a settled reference alignment.
function score(T, G1, Aref) {
  const Acar = alignOf(T.pose, T.xr);
  const Atok = alignOf(T.fix, T.xr);
  const pc = atFrame(Acar, G1.xr);
  const pt = atFrame(Atok, G1.xr);
  const pr = atFrame(Aref, G1.xr);
  const e = [pc.p[0] - pr.p[0], pc.p[1] - pr.p[1], pc.p[2] - pr.p[2]];
  const d = [pt.p[0] - pc.p[0], pt.p[1] - pc.p[1], pt.p[2] - pc.p[2]];
  const ne = Math.hypot(...e);
  const nd = Math.hypot(...d);
  // Signed, and named for what it means: +1 is the takeover moving straight
  // toward the reference along the axis the tags say the carry is wrong on.
  // It recovers the power a win/loss count throws away — at n≈20 the count is
  // nearly uninformative and this is not. The algebra behind the threshold
  // printed beside it: |e+d| < |e| iff corr > |d| / (2|e|).
  const corr = ne && nd ? -(d[0] * e[0] + d[1] * e[1] + d[2] * e[2]) / (ne * nd) : 0;
  return {
    carryMm: ne * 1000,
    tookMm: d3(pt.p, pr.p) * 1000,
    carryDeg: quatAngleDeg(pc.q, pr.q),
    tookDeg: quatAngleDeg(pt.q, pr.q),
    carryLook: d3(lookAt(pc), lookAt(pr)) * 1000,
    tookLook: d3(lookAt(pt), lookAt(pr)) * 1000,
    shiftMm: nd * 1000,
    corr,
    eCarry: e,
    eTook: [pt.p[0] - pr.p[0], pt.p[1] - pr.p[1], pt.p[2] - pr.p[2]],
  };
}

// Every re-acquire boundary in the journals: a `good` frame with a tag-less
// stretch behind it, the solves that stretch produced, and the good run in
// front of it that the reference is taken from.
function boundaries(frames, o) {
  const out = [];
  const refused = {
    windowed: 0, sid: 0, quality: 0, noPlateau: 0, stationary: 0, noSolve: 0,
  };
  let i = 1;
  while (i < frames.length) {
    const G1 = frames[i];
    const prev = frames[i - 1];
    if (G1.q !== 'good' || prev.q !== 'tracked'
      || prev.file !== G1.file || prev.sid !== G1.sid) { i++; continue; }

    // Backwards: the tag-less stretch this boundary ends.
    const stretch = [];
    let broke = null;
    for (let j = i - 1; j >= 0; j--) {
      const f = frames[j];
      if (f.file !== G1.file || f.sid !== G1.sid) { broke = 'sid'; break; }
      if (f.q === 'good') break;
      // 'slipping', 'dead', 'unaligned' say the session frame or the alignment
      // is not what the identity above assumes; 'landmark' is worse — there
      // room.pose is itself a landmark solve, not A ∘ xr.
      if (f.q !== 'tracked') { broke = 'quality'; break; }
      // Truncation, not refusal: most tag-less stretches are longer than the
      // window, and a solve three seconds before the tags came back is exactly
      // the case the test is about. Refusing the whole boundary here threw
      // away the stretches with the most solves in them.
      if (G1.at - f.at > o.maxGapMs) { broke = 'window'; break; }
      stretch.push(f);
    }
    stretch.reverse();

    // Forwards: the good run. A tracked frame inside it is ordinary — a frame
    // whose tags were not folded in — and does not end the run, but a stretch
    // of them does: past `runBreakMs` with no tag confirming the alignment, the
    // tag is out of view and the run is over. Without that bound the scan walks
    // straight through the next tag-less stretch and swallows the boundary at
    // the far end of it.
    const goods = [];
    let k = i;
    let lastGoodAt = G1.at;
    for (; k < frames.length; k++) {
      const f = frames[k];
      if (f.file !== G1.file || f.sid !== G1.sid) break;
      if (f.q !== 'good' && f.q !== 'tracked') break;
      if (f.at - G1.at > o.refMaxMs || f.at - lastGoodAt > o.runBreakMs) break;
      if (f.q === 'good') { goods.push(f); lastGoodAt = f.at; }
      if (goods.length >= KMAX) { k++; break; }
    }
    // Past this boundary's own good run, so one stretch cannot be counted
    // twice through two of its own frames.
    i = Math.max(i + 1, k);

    // A break of any kind bounds the stretch; only the reasons that say the
    // *pose plumbing* is not what the delta identity assumes disqualify the
    // boundary outright, because a solve before one of those cannot be
    // propagated across it.
    if (broke === 'sid') { refused.sid++; continue; }
    if (broke === 'quality') { refused.quality++; continue; }
    if (broke === 'window') refused.windowed++;
    const solves = stretch.filter((f) => f.fix);
    if (!solves.length) { refused.noSolve++; continue; }

    // The alignment through the run, and how far the phone moved carrying it:
    // alignAlpha is driven by path length, so a run walked converges in a
    // handful of frames where a run stood still barely converges at all — and
    // a stationary run's flat A is a false plateau, not a settled one.
    const As = goods.map((g) => alignOf(g.pose, g.xr));
    let motion = 0;
    for (let m = 1; m < goods.length; m++) motion += d3(goods[m].xr.p, goods[m - 1].xr.p);
    let refK = -1;
    for (let m = o.refMinGood - 1; m < As.length; m++) {
      if (d3(As[m].p, As[m - 3].p) < o.plateauM) { refK = m; break; }
    }
    if (refK < 0) { refused.noPlateau++; continue; }
    if (motion < o.minRunMotionM) { refused.stationary++; continue; }

    out.push({ G1, stretch, solves, goods, As, refK, motion });
  }
  return { out, refused };
}

// One event per boundary: the last solve that would have been on screen when
// the tags came back. Consecutive solves in one stretch are the same solve
// walking forward — check() chains the seed — so pooling them as independent
// samples inflates every count by about fivefold.
function pick(b, gate, confirmRms) {
  const usable = b.solves.filter((s) => (gate === null
    ? true
    : s.inliers >= gate && !s.agrees && !s.quar
      && (confirmRms === undefined || s.rms <= confirmRms)));
  return usable.length ? usable[usable.length - 1] : null;
}

function events(bounds, gate, o) {
  const rows = [];
  for (const b of bounds) {
    const Aref = b.As[b.refK];
    const cands = o.allSolves
      ? b.solves.filter((s) => (gate === null || (s.inliers >= gate && !s.agrees && !s.quar
        && (o.confirmRms === undefined || s.rms <= o.confirmRms))))
      : [pick(b, gate, o.confirmRms)].filter(Boolean);
    for (const T of cands) {
      rows.push({
        b,
        T,
        gapMs: b.G1.at - T.at,
        gapM: (() => {
          let m = 0;
          const idx = b.stretch.indexOf(T);
          for (let j = idx + 1; j < b.stretch.length; j++) {
            m += d3(b.stretch[j].xr.p, b.stretch[j - 1].xr.p);
          }
          return m + (b.stretch.length ? d3(b.G1.xr.p, b.stretch[b.stretch.length - 1].xr.p) : 0);
        })(),
        ...score(T, b.G1, Aref),
      });
    }
  }
  return rows;
}

function statRow(rows) {
  if (!rows.length) return null;
  const won = rows.filter((r) => r.tookMm < r.carryMm).length;
  const paired = rows.map((r) => r.tookMm - r.carryMm);
  return {
    n: rows.length,
    carry: pct(rows.map((r) => r.carryMm), 0.5),
    took: pct(rows.map((r) => r.tookMm), 0.5),
    won,
    dPos: pct(paired, 0.5),
    carryDeg: pct(rows.map((r) => r.carryDeg), 0.5),
    tookDeg: pct(rows.map((r) => r.tookDeg), 0.5),
    carryLook: pct(rows.map((r) => r.carryLook), 0.5),
    tookLook: pct(rows.map((r) => r.tookLook), 0.5),
    corr: pct(rows.map((r) => r.corr), 0.5),
    shift: pct(rows.map((r) => r.shiftMm), 0.5),
    p: signTest(won, rows.length),
  };
}

const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');

const signed = (v, d = 0) => (Number.isFinite(v) && v > 0 ? `+${fmt(v, d)}` : fmt(v, d));

function printRow(label, s) {
  if (!s) { console.log(`  ${label.padEnd(11)}     —`); return; }
  console.log(`  ${label.padEnd(11)}${String(s.n).padStart(4)}`
    + `${fmt(s.carry).padStart(9)}${fmt(s.took).padStart(8)}`
    + `${`${s.won}/${s.n}`.padStart(8)}${signed(s.dPos).padStart(8)}`
    + `${`${fmt(s.carryDeg, 1)}/${fmt(s.tookDeg, 1)}`.padStart(11)}`
    + `${`${fmt(s.carryLook)}/${fmt(s.tookLook)}`.padStart(12)}`
    + `${signed(s.corr, 2).padStart(7)}${fmt(s.shift).padStart(7)}`);
}

function header() {
  console.log('  bucket        n   |carry|  |took|     won  d(pos)     degC/T'
    + '   look2m C/T   corr  shift');
}

// Journal names are the whole timestamp and the bucket column is not that wide;
// the day and the minute are what anyone reading this actually matches against
// the rest of the record.
const shortName = (f) => f.replace(/^.*[\\/]/, '').replace(/^\d{4}-/, '')
  .replace(/_client\d+\.pose\.jsonl$/, '').replace(/(\d{4})\d{2}$/, '$1');

function run(frames, o) {
  const id = identity(frames);
  const worst = id.viaXr.length ? Math.max(...id.viaXr) : 0;
  console.log('\n=== re-acquire test: the landmark solve against the carry it would replace ===');
  console.log(`  self-test  delta identity via msg.xr   ${id.viaXr.length} pairs, `
    + `p50 ${fmt(pct(id.viaXr, 0.5), 2)} mm, worst ${fmt(worst, 2)} mm`
    + `   ${worst <= o.identityTolMm ? 'OK' : 'FAILED'}`);
  console.log(`             control via msg.xrNow       ${id.viaNow.length} pairs, `
    + `p50 ${fmt(pct(id.viaNow, 0.5), 2)} mm against ${fmt(pct(id.ctlXr, 0.5), 2)} mm`
    + ' via msg.xr on the same pairs  (must be worse — it is the wrong field)');
  if (worst > o.identityTolMm) {
    console.log('  The session-frame delta does not reproduce the carry, so nothing below it');
    console.log('  can be read. Either a journal is from a different pose plumbing, or the');
    console.log('  alignment moved on a frame this tool believes is tag-less.');
    return { ok: false };
  }

  const { out: bounds, refused } = boundaries(frames, o);
  const gate = o.gateInliers;
  const rows = events(bounds, gate, o);

  // Two invariants, both exact, both cheap. The alignment round-trip is the
  // composition-order test the identity above cannot give — every candidate in
  // this file is turned into an alignment and back, and getting that backwards
  // would produce plausible numbers that mean nothing.
  //
  // Note what is deliberately *not* asserted: that the takeover's shift at the
  // reference frame equals the `dp` check() measured at T. It does not. The
  // candidates are composed on the right, and two poses differing in rotation
  // separate further with the lever arm — 5° over a metre is 90 mm. Only
  // left-composition preserves the distance.
  let bad = 0;
  for (const f of frames) {
    if (d3(atFrame(alignOf(f.pose, f.xr), f.xr).p, f.pose.p) > 1e-5) bad++;
  }
  let algBad = 0;
  for (const r of rows) {
    // |e + d| < |e|  iff  corr > |d| / 2|e|. Algebra, not a second measurement:
    // if the win count and the direction statistic ever disagree, one of them
    // is being computed from the wrong vector.
    if ((r.tookMm < r.carryMm) !== (r.corr > r.shiftMm / (2 * r.carryMm))) algBad++;
  }
  console.log(`             alignment round-trip        ${bad} of ${frames.length} frames fail`
    + `;  win vs direction  ${algBad} of ${rows.length} disagree`);

  console.log(`\n  population  re-acquire boundaries scored        ${bounds.length}`);
  console.log(`              refused: no solve in the stretch    ${refused.noSolve}`
    + `, no plateau ${refused.noPlateau}, stationary run ${refused.stationary}`);
  console.log(`                       session change ${refused.sid}`
    + `, slipping/dead/landmark ${refused.quality}`
    + `;  stretches truncated to the window ${refused.windowed}`);
  console.log(`              events at inliers >= ${gate}`.padEnd(46) + `${rows.length}`
    + (o.allSolves ? '  (every solve — NOT independent)' : '  (one per stretch)'));

  if (bounds.length) {
    const kk = [1, 4, 8, 12, 17, 25].filter((k) => k <= KMAX);
    const deep = bounds.filter((b) => b.As.length >= Math.max(...kk));
    console.log(`\n  reference convergence — |A_k − A_T| through the good run `
      + `(n=${deep.length} runs reaching ${Math.max(...kk)} good frames)`);
    if (deep.length) {
      const line = kk.map((k) => {
        const v = pct(deep.map((b) => d3(b.As[k - 1].p, b.stretch.length
          ? alignOf(b.stretch[b.stretch.length - 1].pose,
            b.stretch[b.stretch.length - 1].xr).p
          : b.As[0].p)), 0.5) * 1000;
        return `k=${k} ${fmt(v)}`;
      }).join('   ');
      console.log(`    ${line} mm`);
      console.log('    k=1 is the artefact this tool exists to avoid: the alignment EMA is'
        + ' 0.02-0.25 per good frame,');
      console.log('    so at the first good frame the reference is still most of the way back'
        + ' at the carry.');
    }
    console.log(`    reference taken at good frame `
      + `${fmt(pct(bounds.map((b) => b.refK + 1), 0.5))} (median), `
      + `run motion ${fmt(pct(bounds.map((b) => b.motion), 0.5) * 1000)} mm (median)`);
  }

  console.log(`\n  === at the converged reference ===`);
  header();
  if (o.inlierSweep) {
    printRow('any solve', statRow(events(bounds, null, o)));
    for (const g of LADDER) printRow(`>=${g}`, statRow(events(bounds, g, o)));
  } else {
    printRow(`>=${gate}`, statRow(statRow(rows) ? rows : []));
  }
  console.log('    d(pos) is the PAIRED median of |took| − |carry|; negative = the solve is closer');
  console.log('    corr is the solve\'s direction against the carry\'s error: +1 straight toward');
  console.log('    the reference, −1 away.  shift is the solve\'s own move — it bounds any');
  console.log('    improvement it could possibly make.');

  if (rows.length) {
    const bucket = (label, sel) => {
      const s = statRow(rows.filter(sel));
      if (s) printRow(label, s);
    };
    console.log('\n  by the solve\'s own disagreement at T');
    header();
    bucket('0-150mm', (r) => r.T.dp * 1000 < 150);
    bucket('150-300', (r) => r.T.dp * 1000 >= 150 && r.T.dp * 1000 < 300);
    bucket('>300', (r) => r.T.dp * 1000 >= 300);
    // Drift accrued after the solve is in the carry's error and could not have
    // been corrected by it, so the near buckets are the powerful ones and a
    // difference that only appears in the far ones is dilution, not signal.
    console.log('\n  by the gap from the solve to the re-acquire');
    header();
    bucket('0-2s', (r) => r.gapMs < 2000);
    bucket('2-5s', (r) => r.gapMs >= 2000 && r.gapMs < 5000);
    bucket('5-10s', (r) => r.gapMs >= 5000 && r.gapMs < 10000);
    bucket('>10s', (r) => r.gapMs >= 10000);
    console.log('\n  by journal');
    header();
    for (const f of [...new Set(rows.map((r) => r.T.file))]) {
      bucket(shortName(f), (r) => r.T.file === f);
    }
  }

  verdict(rows, o, gate);

  if (o.tracePath) writeTrace(rows, bounds, o.tracePath);
  return { ok: true };
}

// Stated by the tool, not left to the reader — the whole record this measurement
// belongs to (.plans/landmark-lock.md §3d-3e) is a sequence of readings that
// were consistent and wrong, and a number a reader has to interpret is where
// that happens.
function verdict(rows, o, gate) {
  const s = statRow(rows);
  console.log('\nVERDICT');
  if (!s) { console.log('  no events — nothing to answer with.'); return; }
  const perJournal = [...new Set(rows.map((r) => r.T.file))]
    .map((f) => statRow(rows.filter((r) => r.T.file === f)))
    .filter((x) => x && x.n >= 3);
  const agreeing = perJournal.filter((x) => Math.sign(x.dPos) === Math.sign(s.dPos)).length;
  const journals = new Set(rows.map((r) => r.T.file)).size;
  const thin = [];
  if (perJournal.length < 3) {
    thin.push(`${perJournal.length} of ${journals} journal(s) contribute >=3 events`);
  }
  if (s.n < 15) thin.push(`n=${s.n} after the per-stretch collapse`);
  if (agreeing < 3 && perJournal.length >= 3) thin.push('journals disagree in sign');
  if (s.shift < s.carry / 2) {
    thin.push(`the solve moves a median ${fmt(s.shift)} mm against a `
      + `${fmt(s.carry)} mm carry error — too small to see`);
  }
  const dir = s.dPos < 0 ? 'CLOSER to' : 'FURTHER from';
  console.log(`  At inliers >= ${gate}, the solve's pose is ${dir} the room than the carry:`);
  console.log(`  ${s.won} of ${s.n} events won (sign test p = ${s.p.toFixed(3)}), paired median `
    + `${s.dPos > 0 ? '+' : ''}${fmt(s.dPos)} mm,`);
  console.log(`  ${fmt(s.tookDeg - s.carryDeg, 1)}° of orientation, `
    + `${fmt(s.tookLook - s.carryLook)} mm at ${LOOK_M} m, direction ${fmt(s.corr, 2)}.`);
  if (thin.length) {
    console.log(`  UNDERPOWERED — ${thin.join('; ')}.`);
    // A solve sits a median 8.9 s from the next tag confirmation on the walks
    // recorded so far, so the shortage is of *boundaries with a solve behind
    // them*, not of solves. More journals of the same shape do not fix it.
    console.log(`  Remedy: ${gate > MIN_LADDER
      ? `--takeover-min-inliers ${MIN_LADDER} to recover the wide populations, then `
      : ''}a walk that crosses tag view repeatedly while landmarks are solving.`);
  } else if (s.dPos < 0 && s.p < 0.05 && s.corr > 0.3) {
    console.log('  WINS — the takeover is doing what it claims. Re-tune the gate on the ladder,'
      + ' and .plans/landmark-takeover-trust.md §4.1 unblocks the carry-correction revisit.');
  } else if (s.dPos > 0 && s.p < 0.05) {
    console.log('  LOSES — the takeover draws the dot further from the only datum in the room.'
      + ' §4.1 says it comes out; §6.2 is the capability that goes with it.');
  } else {
    console.log('  INCONCLUSIVE — the two candidates are not separated at this sample size.');
  }
}

// A fixed column list, not the union of whatever the rows carry, so two runs
// diff. The two error vectors are what make it genuinely re-cuttable: every
// scalar above is a function of them, and a per-axis question becomes a sort
// rather than a change to this file.
function writeTrace(rows, bounds, path) {
  const cols = ['file', 'line', 'at', 'sid', 'inliers', 'rms', 'dpMm', 'degAtT', 'quarantined',
    'took', 'agrees', 'solvesInStretch', 'refK', 'goods', 'runMotionM', 'gapMs', 'gapM',
    'carryMm', 'tookMm', 'carryDeg', 'tookDeg', 'carryLook2m', 'tookLook2m', 'shiftMm', 'corr',
    'eCarryX', 'eCarryY', 'eCarryZ', 'eTookX', 'eTookY', 'eTookZ'];
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const out = [cols.join(',')];
  for (const r of rows) {
    const row = {
      file: r.T.file, line: r.T.line, at: r.T.at, sid: r.T.sid,
      inliers: r.T.inliers, rms: r3(r.T.rms), dpMm: Math.round(r.T.dp * 1000),
      degAtT: r3(r.T.deg), quarantined: r.T.quar ? 1 : 0, took: r.T.took ? 1 : 0,
      agrees: r.T.agrees ? 1 : 0, solvesInStretch: r.b.solves.length,
      refK: r.b.refK + 1, goods: r.b.goods.length, runMotionM: r3(r.b.motion),
      gapMs: r.gapMs, gapM: r3(r.gapM),
      carryMm: Math.round(r.carryMm), tookMm: Math.round(r.tookMm),
      carryDeg: r3(r.carryDeg), tookDeg: r3(r.tookDeg),
      carryLook2m: Math.round(r.carryLook), tookLook2m: Math.round(r.tookLook),
      shiftMm: Math.round(r.shiftMm), corr: r3(r.corr),
      eCarryX: r3(r.eCarry[0]), eCarryY: r3(r.eCarry[1]), eCarryZ: r3(r.eCarry[2]),
      eTookX: r3(r.eTook[0]), eTookY: r3(r.eTook[1]), eTookZ: r3(r.eTook[2]),
    };
    out.push(cols.map((c) => row[c] ?? '').join(','));
  }
  fs.writeFileSync(path, `${out.join('\n')}\n`);
  console.log(`\ntrace: ${rows.length} event(s) written to ${path}`);

  // The convergence claim beside the events it decides, so the reference choice
  // can be re-examined without re-running: the same boundary at every k.
  const scols = ['file', 'line', 'k', 'carryMm', 'tookMm', 'dAMm'];
  const sout = [scols.join(',')];
  for (const b of bounds) {
    const T = b.solves[b.solves.length - 1];
    const A0 = alignOf(T.pose, T.xr);
    for (let k = 0; k < b.As.length; k++) {
      const s = score(T, b.G1, b.As[k]);
      sout.push([T.file, T.line, k + 1, Math.round(s.carryMm), Math.round(s.tookMm),
        Math.round(d3(b.As[k].p, A0.p) * 1000)].join(','));
    }
  }
  const spath = path.replace(/(\.csv)?$/, '.refsweep.csv');
  fs.writeFileSync(spath, `${sout.join('\n')}\n`);
  console.log(`trace: ${sout.length - 1} reference row(s) written to ${spath}`);
}

module.exports = { createReacquire };
