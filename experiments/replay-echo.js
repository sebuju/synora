'use strict';

/*
 * replay-echo.js — the acoustic wall check, read off a journal.
 *
 * walls.js has no external accuracy metric. Every number replay-walls.js prints
 * measures the grid against itself: cells behind a tag plane are wrong by
 * construction, a wall crossing a proven sight line is wrong by construction.
 * All internal consistency. Nothing there answers "is that wall actually 2.4 m
 * away". This is the same move replay-depth.js made for depth — an independent
 * ruler pointed at the same geometry.
 *
 * The ruler is sound. At 8-16 kHz a matched-filter chirp separates two arrivals
 * 2.1 cm apart and locates an isolated one to 1-2 cm, against walls.js's 0.06 m
 * cell — three to six times sharper than the thing it is checking, which is the
 * whole reason this is worth doing.
 *
 * Usage:
 *   node experiments/replay-echo.js recordings/*_audiolab.jsonl --grid grid.json
 *   node experiments/replay-echo.js --synth        (no files, no phone)
 *
 * The grid comes from `replay-walls.js --out grid.json`. That is deliberate:
 * it is the *emitted* segment set from the real getWalls() path, including
 * inferWalls/closeCorners/clipToSight, none of which could be reconstructed
 * from walls.json without re-implementing several hundred lines that would then
 * drift silently. It also forces the comparison to name a reproducible grid
 * built against a frozen markers.json, which is the discipline walls.md already
 * demands of anyone comparing two replays.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs, numFlag, readJournals } = require('../replay-common.js');
const G = require('./echo-geom.js');

function usage(msg) {
  if (msg) console.error(`\n${msg}\n`);
  console.error('usage: node experiments/replay-echo.js <recordings/*_audiolab.jsonl> [options]\n'
    + '  --grid grid.json     emitted walls + floor, from `replay-walls.js --out`\n'
    + '  --grid-only          skip segments; compare against the carved free frontier alone\n'
    + '  --markers FILE       default markers.json beside the repo root\n'
    + '  --synth              forward-model a room and a session, run the whole\n'
    + '                       pipeline against it, and check the residuals. No files.\n'
    + '  --synth-noise-m 0.01 per-arrival noise in the synthetic session; 0 makes the\n'
    + '                       whole pipeline exact, which is how a bias is told from scatter\n'
    + '  --synth-n 40         synthetic triplets\n'
    + '  --synth-c-true 343.4 true sound speed in the synthetic room, against a\n'
    + '                       declared 20 C. Use it to price a wrong temperature:\n'
    + '                       346 is 0.75% and 30 mm at 4 m\n'
    + '  --temp-c 20          room temperature; c = 331.3 + 0.606*T is the ONLY\n'
    + '                       sound speed applied. The echo solves are a check on\n'
    + '                       the arrival identification, never an input\n'
    + '  --spk-mic-m 0.10     speaker-to-mic chassis path (the direct arrival is NOT\n'
    + '                       zero range; dropping this biases every path by 10 cm)\n'
    + '  --d-sep-m 0.14       speaker separation; overrides the journal\n'
    + '  --d-sep-tol-m        classification window, default d_sep/3\n'
    + '  --tol-m 0.10         match window, measured minus predicted\n'
    + '  --max-range-m 6      ignore arrivals past this\n'
    + '  --min-snr-db 8       ignore peaks under this over the noise floor\n'
    + '  --out-m --along-m --height-m --ceil-m\n'
    + '                       override the journal\'s declared standpoint. For a\n'
    + '                       mistyped tape measurement — the arrivals are the same\n'
    + '                       sound whichever point they are compared against\n'
    + '  --variant l|r|both|all   restrict the residual report to one emission\n'
    + '  --sp N               restrict to one standpoint\n'
    + '  --csv out.csv        every matched arrival, one row each');
  process.exit(1);
}

const { positional: journals, flags } = parseArgs(process.argv.slice(2), {
  booleans: ['synth', 'grid-only', 'ascii'], usage,
});

// The temperature IS the sound speed now, so where it comes from has to be one
// rule rather than two: an explicit --temp-c overrides, otherwise the operator's
// declared value wins, otherwise 20 C. Before this the solve read the journal's
// 25 C while the header printed the flag's 20 C and claimed it was the only one
// applied — a 5 C lie, 55 mm at 3 m, in the line that exists to prevent exactly
// that kind of confusion.
const cfgTempC = numFlag(flags, 'temp-c', 20, usage);
const tempExplicit = flags['temp-c'] !== undefined;
const tempFor = (decl) => (tempExplicit ? cfgTempC : (decl?.tempC ?? cfgTempC));
const cfgSpkMic = numFlag(flags, 'spk-mic-m', 0.10, usage);
const cfgTol = numFlag(flags, 'tol-m', 0.10, usage);
const cfgMaxRange = numFlag(flags, 'max-range-m', 6, usage);
const cfgMinSnr = numFlag(flags, 'min-snr-db', 8, usage);
// The offline re-selection, in one place. The page journals permissively so
// these can be swept over a recorded session instead of costing a new walk —
// which only holds if every read below applies the same selection, the
// diffuse-field test included.
const sel = {
  relDb: flags['rel-db'] !== undefined ? numFlag(flags, 'rel-db', 45, usage) : null,
  promDb: flags['prom-db'] !== undefined ? numFlag(flags, 'prom-db', 3, usage) : null,
};
function selectPeaks(m) {
  return (m.peaks || []).filter(([, snrDb, promDb]) => {
    if (snrDb < cfgMinSnr) return false;
    if (sel.relDb != null && m.directSnrDb - snrDb > sel.relDb) return false;
    if (sel.promDb != null && promDb != null && promDb < sel.promDb) return false;
    return true;
  });
}
const wantVariant = flags.variant || 'all';
const wantSp = flags.sp !== undefined ? String(flags.sp) : null;

// ---------------------------------------------------------------------------
// Inputs

// Both copies below bind to schemas this file does not own. assertGridShape and
// assertMarkerShape (echo-geom.js) are the tripwires: without them a changed
// upstream shape produces a beautiful report about nothing.
function loadGrid() {
  if (flags['grid-only']) return { walls: [], floor: null, source: 'grid-only' };
  if (!flags.grid) {
    usage('need --grid grid.json (from `node replay-walls.js ... --out grid.json`), '
      + 'or --grid-only, or --synth');
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(flags.grid, 'utf8'));
  } catch (err) {
    usage(`cannot read ${flags.grid}: ${err.message}`);
  }
  G.assertGridShape(raw, flags.grid);
  if (!raw.floor.free.length) {
    // walls.load() logs and ignores a marker-size mismatch rather than
    // refusing, so an empty grid is a real and quiet outcome. Refuse it here or
    // the report reads as "no walls disagreed with anything".
    console.error(`${flags.grid}: floor.free is empty — the grid carved nothing. `
      + 'Check the marker size and the journals that built it.');
    process.exit(2);
  }
  return { walls: raw.walls, floor: raw.floor, source: flags.grid };
}

function loadMarkers() {
  const file = flags.markers || path.join(__dirname, '..', 'markers.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    usage(`cannot read ${file}: ${err.message}`);
  }
  return { map: G.normaliseMarkers(raw), source: file };
}

// ---------------------------------------------------------------------------
// Journal

// A session is standpoint declarations plus measurements. Measurements group by
// (standpoint, emission sequence) into a triplet — left, right, both — because
// the three sub-emissions rode one stereo buffer and are one measurement of one
// moment. Anything that splits them splits the stereo comparison too.
function readSession(files) {
  const standpoints = new Map();
  const triplets = new Map();
  const rejects = new Map();
  const missing = new Map();      // variant -> times it never came back
  const snrByVariant = new Map(); // variant -> direct-arrival SNRs
  const gates = { n: 0, raw: 0, amp: 0, prom: 0, capped: 0 };
  const allPeaks = [];
  let entries = 0;
  let incomplete = 0;
  let traces = 0;
  let lastAt = 0;

  const spKey = (e) => `${e.deviceId || 'dev'}#${e.sp ?? 0}`;

  for (const { entry } of readJournals(files)) {
    entries++;
    if (entry.at > lastAt) lastAt = entry.at;
    if (entry.kind === 'echo-standpoint') {
      standpoints.set(spKey(entry), entry);
    } else if (entry.kind === 'echo-verdict') {
      // The pose AT THIS TRIPLET, when the page was localizing itself. Read
      // per triplet rather than per standpoint because that is the whole point
      // of leaving the camera on: a standpoint declaration is one moment, and a
      // phone that gets nudged an hour into a session declares nothing about
      // it. Measured on the first such session: the last triplet's fix sits
      // 1.6 m from the first, which the standpoint record alone called steady.
      //
      // A verdict can also arrive before the first fix (camera still opening),
      // so this is per-triplet or nothing — never backfilled from a neighbour.
      const key = `${spKey(entry)}@${entry.seq}`;
      if (!triplets.has(key)) triplets.set(key, { sp: spKey(entry), seq: entry.seq, byVariant: {} });
      if (entry.pose) triplets.get(key).pose = entry.pose;
    } else if (entry.kind === 'echo') {
      const key = `${spKey(entry)}@${entry.seq}`;
      if (!triplets.has(key)) triplets.set(key, { sp: spKey(entry), seq: entry.seq, byVariant: {} });
      triplets.get(key).byVariant[entry.variant] = entry;
      if (!snrByVariant.has(entry.variant)) snrByVariant.set(entry.variant, []);
      snrByVariant.get(entry.variant).push(entry.directSnrDb);
      if (entry.gate) {
        gates.n++;
        gates.raw += entry.gate.raw || 0;
        gates.amp += entry.gate.amp || 0;
        gates.prom += entry.gate.prom || 0;
        if (entry.gate.capped) gates.capped++;
      }
      // directSnrDb rides along because the offline --rel-db selection is
      // relative to it, and without it the diffuse-field test below could only
      // ever read the capture-time gating back.
      allPeaks.push({
        seq: entry.seq, variant: entry.variant, sr: entry.sr,
        peaks: entry.peaks, directSnrDb: entry.directSnrDb,
      });
    } else if (entry.kind === 'echo-reject') {
      rejects.set(entry.reason, (rejects.get(entry.reason) || 0) + 1);
    } else if (entry.kind === 'echo-incomplete') {
      // A variant that never came back. The predicted failure of this design is
      // the earpiece being 10-20 dB down at 8-16 kHz, so this is the number
      // that confirms or kills it — and it only exists because the page counts
      // the miss instead of dropping it.
      incomplete++;
      for (const v of entry.missing || []) missing.set(v, (missing.get(v) || 0) + 1);
    } else if (entry.kind === 'echo-trace') {
      traces++;
    }
  }
  return {
    standpoints, triplets, rejects, missing, snrByVariant,
    gates, allPeaks, incomplete, traces, entries, lastAt,
  };
}

// ---------------------------------------------------------------------------
// One triplet

// Which channel is the top speaker is a device and rotation property, not a
// constant — Android may swap L/R on rotation, and no API reports it. The
// journal carries it once the operator has confirmed it. When it has not, the
// sign test IS the calibration: try both mappings and keep the one that
// produces a floor and a ceiling, since only the correct mapping can.
function orient(byVariant, topChannel) {
  if (topChannel === 'l') return { top: byVariant.l, bottom: byVariant.r, from: 'journal' };
  if (topChannel === 'r') return { top: byVariant.r, bottom: byVariant.l, from: 'journal' };
  return null;
}

function peaksOf(entry, c, spkMicM, minSnr, maxRangeM, sel = {}) {
  if (!entry) return [];
  const out = [];
  for (const [dSamp, snrDb, promDb] of entry.peaks || []) {
    if (snrDb < minSnr) continue;
    // Re-selection, offline. The page journals permissively on purpose, so
    // these can be swept over a recorded session instead of costing a new walk.
    if (sel.relDb != null && entry.directSnrDb - snrDb > sel.relDb) continue;
    if (sel.promDb != null && promDb != null && promDb < sel.promDb) continue;
    const pathM = G.toPathM(dSamp, entry.sr, c, spkMicM);
    if (pathM > 2 * maxRangeM) continue;
    out.push({ dSamp, snrDb, pathM, sr: entry.sr, variant: entry.variant });
  }
  return out.sort((a, b) => a.pathM - b.pathM);
}

// The floor and the ceiling are the SHORTEST arrivals of their class, and that
// is not a heuristic — a wall+floor bounce is hypot(2d, h_s+h_m), which is
// never shorter than the h_s+h_m it contains. It has to be enforced, because
// the second-order bounces do not sit at delta 0: measured on the synthetic
// room, a wall+ceiling off a 1.5 m wall has delta -0.097, close enough to
// -d_sep to be classified `ceiling` outright. Taking the first such pair fed
// the solve a 4.27 m path where the real ceiling was 3.04 m and put the sound
// speed 70 m/s low. Physics settles it where the classifier cannot.
function pickCalib(pairs) {
  const shortest = (cls) => pairs
    .filter((p) => p.cls === cls)
    .reduce((best, p) => (!best || p.pathM < best.pathM ? p : best), null);
  return { floor: shortest('floor'), ceiling: shortest('ceiling') };
}

// Delays of the identified calibration surfaces, in samples, for the sound
// speed solve. Raw samples on purpose: resolving c from something computed with
// an assumed c is circular.
function calibDelays(pairs) {
  const { floor: f, ceiling: c } = pickCalib(pairs);
  return {
    floor: f ? f.bottom.dSamp : null,
    ceil: c ? c.bottom.dSamp : null,
    floorTop: f ? f.top.dSamp : null,
    floorBot: f ? f.bottom.dSamp : null,
    ceilTop: c ? c.top.dSamp : null,
    ceilBot: c ? c.bottom.dSamp : null,
  };
}

function solveTriplet(tri, decl, cfg) {
  const dSep = cfg.dSepM;
  // The one sound speed every path here is measured with. Air is
  // 331.3 + 0.606*T and nothing else, so the whole indoor range 18-26 C spans
  // 1.4% — 10 mm on a 3 m path, against a 60 mm grid cell. The solves below
  // used to feed back into this and could not: a misidentified second bounce
  // returned 188 m/s on a real session and rescaled every path by 0.55x.
  const model = 331.3 + 0.606 * cfg.tempC;

  const attempt = (topChannel, c) => {
    const o = orient(tri.byVariant, topChannel);
    if (!o || !o.top || !o.bottom) return null;
    const pt = peaksOf(o.top, c, cfg.spkMicM, cfg.minSnrDb, cfg.maxRangeM, cfg.sel);
    const pb = peaksOf(o.bottom, c, cfg.spkMicM, cfg.minSnrDb, cfg.maxRangeM, cfg.sel);
    if (!pt.length || !pb.length) return null;
    const paired = G.pairChannels(pt, pb, { dSepM: dSep, dSepTolM: cfg.dSepTolM });
    return { topChannel, paired, peaksTop: pt, peaksBottom: pb };
  };

  let best = null;
  const mappings = decl.topChannel ? [decl.topChannel] : ['l', 'r'];
  for (const m of mappings) {
    const a = attempt(m, model);
    if (!a) continue;
    // Only the correct mapping can produce a floor (delta +d_sep) AND a ceiling
    // (delta -d_sep); the wrong one turns both into the other and produces
    // neither in the right place. Score by how many calibration surfaces landed.
    const score = a.paired.pairs.filter((p) => p.cls === 'floor' || p.cls === 'ceiling').length;
    if (!best || score > best.score) best = { ...a, score, mappingFrom: decl.topChannel ? 'journal' : 'inferred' };
  }
  if (!best) return { ok: false, reason: 'no paired channels' };

  const d = calibDelays(best.paired.pairs);
  const speeds = G.soundSpeeds(d, {
    sr: best.peaksTop[0].sr, ceilM: decl.ceilM, spkMicM: cfg.spkMicM, dSepM: dSep, tempC: cfg.tempC,
  });
  // Kept as a check on the ARRIVAL IDENTIFICATION, not as a measurement of the
  // air: floor+ceiling and d_sep/dt are both exact given the right two peaks,
  // so a solve far from the model says the floor or the ceiling was misread.
  // Reported, never used.
  const c = model;
  const cFrom = 'model';
  const final = best;
  const both = peaksOf(tri.byVariant.both, c, cfg.spkMicM, cfg.minSnrDb, cfg.maxRangeM, cfg.sel);

  // The phone height was declared, never trusted. Now it is measurable: the
  // floor path is h_s + h_m, so the bottom-speaker floor echo gives it back.
  const calib = pickCalib(final.paired.pairs);
  const hEstM = calib.floor ? calib.floor.bottom.pathM / 2 : null;

  return {
    ok: true,
    c,
    cFrom,
    speeds,
    calib,
    topChannel: final.topChannel,
    mappingFrom: best.mappingFrom,
    paired: final.paired,
    peaks: { top: final.peaksTop, bottom: final.peaksBottom, both },
    hEstM,
  };
}

// ---------------------------------------------------------------------------
// Report helpers

function histogram(values, binM, label) {
  if (!values.length) return;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const nBins = Math.max(1, Math.min(40, Math.ceil((hi - lo) / binM) || 1));
  const bins = new Array(nBins).fill(0);
  for (const v of values) {
    bins[Math.min(nBins - 1, Math.floor(((v - lo) / (hi - lo || 1)) * nBins))]++;
  }
  const peak = Math.max(...bins);
  console.log(`\n${label} (${(binM * 1000).toFixed(0)} mm bins):`);
  for (let i = 0; i < nBins; i++) {
    const at = lo + ((i + 0.5) * (hi - lo)) / nBins;
    const bar = '#'.repeat(Math.round((bins[i] / peak) * 46));
    console.log(`  ${at >= 0 ? ' ' : ''}${at.toFixed(3)} |${bar}${bins[i] ? ` ${bins[i]}` : ''}`);
  }
}

// Least squares through the origin plus intercept: residual = a + b*d. A slope
// is a markers.json printed-marker-size error — a real, previously
// unfalsifiable failure mode that this measurement gets for free. The intercept
// is the spk-mic bias.
function fitScale(rows) {
  if (rows.length < 3) return null;
  const n = rows.length;
  const sx = rows.reduce((a, r) => a + r.d, 0);
  const sy = rows.reduce((a, r) => a + r.resid, 0);
  const sxx = rows.reduce((a, r) => a + r.d * r.d, 0);
  const sxy = rows.reduce((a, r) => a + r.d * r.resid, 0);
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / den;
  return { a: (sy - b * sx) / n, b };
}

// ---------------------------------------------------------------------------
// Synthetic session
//
// Forward-models a room, a standpoint and a session at a known sound speed,
// then feeds the result through the identical pipeline. Everything the real
// path does is exercised except the microphone, so the journal schema is proven
// sufficient BEFORE it is baked into a recorded session — which is the only
// ordering in which that can be found out cheaply.

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function synthRoom() {
  // A 4.0 x 5.0 m room, walls at x=-2/+2 and z=-2.5/+2.5. Tagged on three
  // sides; the fourth is `inferred`, so the report has both provenances and the
  // non-circular class is actually exercised.
  const walls = [
    { a: [2, -2.5], b: [2, 2.5], ids: [0], inferred: false },
    { a: [-2, -2.5], b: [-2, 2.5], ids: [1], inferred: false },
    { a: [-2, 2.5], b: [2, 2.5], ids: [2], inferred: false },
    { a: [-2, -2.5], b: [2, -2.5], ids: [], inferred: true, ext: { a: 0.4, b: 0 } },
  ];
  const cellM = 0.06;
  const free = [];
  for (let ix = Math.ceil(-2 / cellM); ix < 2 / cellM; ix++) {
    for (let iz = Math.ceil(-2.5 / cellM); iz < 2.5 / cellM; iz++) free.push(ix, iz);
  }
  // Tag 0 on the x=+2 wall, normal pointing back into the room (-x). A
  // quaternion of 90 degrees about +y sends [0,0,1] to [1,0,0]; we want [-1,0,0],
  // so rotate -90 about y.
  const s = Math.sin(-Math.PI / 4);
  const c = Math.cos(-Math.PI / 4);
  // Already in the normalised shape normaliseMarkers() would produce, so `sizeM`
  // rather than markers.json's `markerSizeM`.
  const markers = {
    anchorId: 0,
    sizeM: 0.15,
    markers: [{ id: 0, p: [2, 1.4, 0], q: [0, s, 0, c], hops: 0 }],
  };
  return { grid: { walls, floor: { cellM, free }, source: 'synthetic' }, markers };
}

function synthSession(room, opts) {
  // Air at the declared 20 C, so the pipeline test is exact and a residual is a
  // pipeline error rather than a restatement of the constant. --synth-c-true is
  // how the cost of a wrong temperature is measured instead of argued: 346
  // against a declared 20 C is 0.75%, which is 30 mm at 4 m.
  const cTrue = opts.cTrue ?? 331.3 + 0.606 * 20;
  const sr = 48000;
  const dSep = 0.14;
  const micOff = -dSep / 2;
  const spkMic = 0.10;
  const y = 1.05;
  const H = 2.5;
  const rnd = lcg(20260804);
  const noise = () => (rnd() - 0.5) * 2 * (opts.noiseM ?? 0.01);

  const decl = {
    kind: 'echo-standpoint',
    sp: 0,
    declared: true,
    deviceId: 'synth',
    tagId: 0,
    outM: 1.5,
    // Off-centre on purpose: a standpoint equidistant from three walls makes
    // every one of them arrive at the same instant, and a test that cannot tell
    // its own surfaces apart proves nothing about a matcher that has to.
    alongM: 0.8,
    heightM: y,
    ceilM: H,
    tempC: 20,
    spkMicM: spkMic,
    dSepM: dSep,
    micOffM: micOff,
    topChannel: 'l',
    maxRangeM: 6,
    mount: 'synthetic',
  };

  const sp = G.standpointOf(decl, room.markers);
  if (!sp.ok) throw new Error(`synthetic standpoint failed: ${sp.reason}`);
  const preds = room.grid.walls
    .map((w) => G.predictWall(sp.P, w, room.grid.walls, {}))
    .filter(Boolean);

  const lines = [decl];
  for (let seq = 1; seq <= (opts.n ?? 40); seq++) {
    // Drop the top-speaker variant on one triplet in eight, standing in for the
    // earpiece being 10-20 dB down in this band. The report has to survive it
    // and say so, rather than quietly measuring fewer surfaces.
    const dropTop = (opts.weakEarpiece ?? true) && seq % 8 === 0;
    if (dropTop) {
      lines.push({
        kind: 'echo-incomplete', sp: 0, deviceId: 'synth', seq,
        heard: ['both', 'r'], missing: ['l'], snrDb: [48, 44],
      });
    }
    for (const [variant, off] of [['l', +dSep / 2], ['r', -dSep / 2], ['both', 0]]) {
      if (dropTop && variant === 'l') continue;
      const comb = G.combForSpeaker(sp.P, y, preds, { ceilM: H, micOffM: micOff, dSepM: dSep }, off);
      const peaks = comb
        .filter((e) => e.kind !== 'edge' && e.pathM < 12)
        .map((e) => {
          const pathM = e.pathM + noise();
          return [((pathM - spkMic) / cTrue) * sr, 24 - pathM];
        })
        .filter(([, snr]) => snr > 8);
      lines.push({
        kind: 'echo', sp: 0, deviceId: 'synth', seq, sr, variant,
        directAbs: seq * 100000, directSnrDb: 52, floorDb: -40,
        peaks: peaks.map(([d, s]) => [Math.round(d * 1000) / 1000, Math.round(s * 10) / 10]),
      });
    }
  }
  return { lines, cTrue, dSep, spkMic, y, H, sp, preds };
}

// ---------------------------------------------------------------------------
// Main

const room = flags.synth ? synthRoom() : null;
const grid = room ? room.grid : loadGrid();
const markers = room ? { map: room.markers, source: 'synthetic' } : loadMarkers();
const synth = room ? synthSession(room, {
  n: numFlag(flags, 'synth-n', 40, usage),
  noiseM: numFlag(flags, 'synth-noise-m', 0.01, usage),
  cTrue: flags['synth-c-true'] !== undefined
    ? numFlag(flags, 'synth-c-true', 343.42, usage) : undefined,
}) : null;

if (!flags.synth && !journals.length) usage('no journals given');

let session;
if (synth) {
  const st = new Map();
  const tri = new Map();
  const missing = new Map();
  const snrByVariant = new Map();
  let incomplete = 0;
  for (const e of synth.lines) {
    if (e.kind === 'echo-standpoint') { st.set('synth#0', e); continue; }
    if (e.kind === 'echo-incomplete') {
      incomplete++;
      for (const v of e.missing) missing.set(v, (missing.get(v) || 0) + 1);
      continue;
    }
    const k = `synth#0@${e.seq}`;
    if (!tri.has(k)) tri.set(k, { sp: 'synth#0', seq: e.seq, byVariant: {} });
    tri.get(k).byVariant[e.variant] = e;
    if (!snrByVariant.has(e.variant)) snrByVariant.set(e.variant, []);
    snrByVariant.get(e.variant).push(e.directSnrDb);
  }
  session = {
    standpoints: st, triplets: tri, rejects: new Map(),
    missing, snrByVariant, incomplete, traces: 0,
    entries: synth.lines.length, lastAt: 0,
  };
} else {
  session = readSession(journals);
}

// The temperature the whole-session reads use. A journal with standpoints at
// different temperatures is an operator moving between rooms, and the per-
// triplet solve already follows each declaration — this is only for the lines
// that summarise the session as one thing.
const declsList = [...session.standpoints.values()];
const reportTempC = tempFor(declsList.find((d) => d.declared) || declsList[0]);

console.log(`\n${flags.synth ? 'SYNTHETIC session' : `${journals.length} journal(s)`}, `
  + `${session.entries} entries — ${session.standpoints.size} standpoint(s), `
  + `${session.triplets.size} triplet(s)`);
console.log(`grid: ${grid.source}, ${grid.walls.length} segment(s)`
  + (grid.floor ? `, ${grid.floor.free.length / 2} free cells` : ' (grid-only)'));
console.log(`markers: ${markers.source}, ${markers.map.markers.length} tag(s), `
  + `${markers.map.sizeM} m — anchor ${markers.map.anchorId}`);

// Gate on measurements, never on standpoints: a session with no declared
// standpoint still carries a full stereo verdict, and refusing to read it was
// how a 120 s session with 47 emissions and 143 detected arrivals came back
// saying nothing at all.
if (!session.triplets.size) {
  console.log('\nNo `echo` entries in this journal.');
  if (session.rejects.size) {
    console.log(`Every measurement was rejected: ${[...session.rejects]
      .map(([r, n]) => `${r} ${n}`).join(', ')}`);
  }
  console.log('Either the journal predates echo mode, or nothing was ever measured.');
  process.exit(0);
}

// Accumulators
const rows = [];
const speedsAll = { ceiling: [], split: [], model: [] };
const hChecks = [];
const dSepRecovered = [];
const confusion = new Map();
const clsTally = new Map();
const bySeg = new Map();
const missedAll = [];
const spSource = new Map();
const levelWarn = [];
const spTrack = [];
let unexplained = 0;
let frontierViolations = 0;
let triplets = 0;
let skipped = 0;
let undeclared = 0;

// A journal with no standpoint at all is still worth everything except the wall
// geometry — the stereo classification needs only d_sep and the sound speed
// needs only the ceiling. Falling back to defaults here rather than skipping is
// the difference between reading such a session and throwing it away.
const DEFAULT_DECL = {
  sp: 0, declared: false, tagId: null, outM: 0, alongM: 0,
  heightM: 1.0, ceilM: 2.5, dSepM: 0.14, micOffM: -0.07, tempC: 20, spkMicM: 0.10,
};

// A mistyped standpoint is otherwise a whole session thrown away: the tape
// measurement lives in the operator's head, the journal recorded 7 m where 1 m
// was meant, and every wall prediction is then made from a point outside the
// room. The measurement itself is untouched by which point it is compared
// against, so a corrected re-read costs nothing and needs no second walk.
const OVERRIDES = ['out-m', 'along-m', 'height-m', 'ceil-m'];
const overrides = {};
for (const k of OVERRIDES) {
  if (flags[k] !== undefined) overrides[k] = numFlag(flags, k, 0, usage);
}
const applyOverrides = (decl) => (Object.keys(overrides).length ? {
  ...decl,
  outM: overrides['out-m'] ?? decl.outM,
  alongM: overrides['along-m'] ?? decl.alongM,
  heightM: overrides['height-m'] ?? decl.heightM,
  ceilM: overrides['ceil-m'] ?? decl.ceilM,
} : decl);
if (Object.keys(overrides).length) {
  console.log(`\nstandpoint OVERRIDDEN: ${Object.entries(overrides)
    .map(([k, v]) => `--${k} ${v}`).join(' ')}`);
  console.log('  The journal\'s own declaration is not what this report compares against.');
}

for (const tri of session.triplets.values()) {
  const decl = applyOverrides(session.standpoints.get(tri.sp) || DEFAULT_DECL);
  if (wantSp !== null && String(decl.sp) !== wantSp) continue;

  const dSep = numFlag(flags, 'd-sep-m', decl.dSepM ?? 0.14, usage);
  const cfg = {
    dSepM: dSep,
    dSepTolM: numFlag(flags, 'd-sep-tol-m', dSep / 3, usage),
    spkMicM: flags['spk-mic-m'] !== undefined ? cfgSpkMic : (decl.spkMicM ?? cfgSpkMic),
    tempC: tempFor(decl),
    minSnrDb: cfgMinSnr,
    maxRangeM: cfgMaxRange,
    sel,
  };

  const sol = solveTriplet(tri, decl, cfg);
  if (!sol.ok) { skipped++; continue; }
  triplets++;

  for (const k of ['ceiling', 'split', 'model']) if (sol.speeds[k]) speedsAll[k].push(sol.speeds[k]);
  // What the floor echo measures is (h_speaker + h_mic)/2, not the phone
  // centre — so the declared height has to be brought to the same reference
  // before the difference means anything. Against the centre it reads a clean
  // -70 mm on a phone with the mic and the bottom speaker both half a
  // separation down, which is geometry, not an operator error.
  if (sol.hEstM != null) {
    const micOff = decl.micOffM ?? -dSep / 2;
    hChecks.push(sol.hEstM - (decl.heightM + (-dSep / 2 + micOff) / 2));
  }
  // Only the two identified calibration surfaces, never every pair the
  // classifier labelled — a second-order bounce misread as a ceiling would drag
  // the recovered separation short, which is exactly what it did (109 mm
  // against a true 140) before pickCalib existed.
  const rec = G.recoverDSep([sol.calib.floor, sol.calib.ceiling].filter(Boolean));
  if (rec) dSepRecovered.push(...rec.mags);

  // The headline claim — that a portrait phone's two speakers tell a floor from
  // a ceiling — is answered here, ABOVE the geometry gate, because it needs no
  // map, no tag chain and no declared standpoint. Only d_sep.
  for (const p of sol.paired.pairs) clsTally.set(p.cls, (clsTally.get(p.cls) || 0) + 1);

  // Where the phone was. Two sources, and the solved one wins when it exists:
  // /audio-lab can now ask the server to localize it against the marker map
  // (`solved`, room-frame), which removes the tape measure and with it the
  // failure that a mistyped 7-for-1 puts the standpoint five metres outside the
  // room with every prediction silently empty.
  //
  // Only x and z are taken from it. Room y is the vertical axis — standpointOf
  // depends on that when it demands horizontal tag normals — but the room frame
  // is the anchor tag's own frame and which way +y points is established
  // nowhere, so a height read off p[1] could be upside down. The declared
  // height stays the height until that sign is measured rather than assumed.
  // This triplet's own fix first, the standpoint's median second, the tape
  // last. An explicit override beats all three — it exists precisely for the
  // case where the recorded answer is the wrong one.
  const livePose = tri.pose ?? decl.solved ?? null;
  const solved = Object.keys(overrides).length ? null : livePose?.p;
  if (livePose?.absUdotG != null) levelWarn.push(livePose.absUdotG);
  if (solved) spTrack.push(solved);
  const sp = solved
    ? { ok: true, P: [solved[0], solved[2]], y: Number(decl.heightM), from: 'solved' }
    : (decl.declared && decl.tagId != null)
      ? { ...G.standpointOf(decl, markers.map), from: 'taped' }
      : { ok: false, reason: 'no declared standpoint' };
  if (!sp.ok) { undeclared++; continue; }
  spSource.set(sp.from, (spSource.get(sp.from) || 0) + 1);

  const preds = grid.walls.map((w) => G.predictWall(sp.P, w, grid.walls, {})).filter(Boolean);
  const combCfg = { ceilM: decl.ceilM, micOffM: decl.micOffM ?? -dSep / 2, dSepM: dSep };

  // Classification confusion: the measured verdict from delta alone, against
  // what the map says should be there. This is the direct answer to "can a
  // portrait phone's two speakers tell a floor from a ceiling".
  for (const pair of sol.paired.pairs) {
    const comb = G.combForSpeaker(sp.P, decl.heightM, preds, combCfg, 0);
    let bestKind = 'unexplained';
    let bestErr = cfgTol;
    for (const e of comb) {
      const err = Math.abs(pair.pathM - e.pathM);
      if (err < bestErr) { bestErr = err; bestKind = e.kind; }
    }
    const key = `${bestKind}|${pair.cls}`;
    confusion.set(key, (confusion.get(key) || 0) + 1);
  }

  // Residuals, per emission variant, each against its own comb — a prediction
  // must always be compared to the variant it belongs to, or the speaker offset
  // leaks straight into the number.
  const variants = [
    ['top', sol.peaks.top], ['bottom', sol.peaks.bottom], ['both', sol.peaks.both],
  ];
  for (const [chan, pk] of variants) {
    if (!pk.length) continue;
    if (wantVariant !== 'all') {
      const asked = wantVariant === 'both' ? 'both'
        : (wantVariant === sol.topChannel ? 'top' : 'bottom');
      if (chan !== asked) continue;
    }
    const comb = G.predictComb(sp.P, decl.heightM, preds, combCfg, chan);
    const m = G.matchComb(pk, comb, { tolM: cfgTol });
    unexplained += m.unexplained.length;
    for (const mm of m.matched) {
      const p = mm.pred;
      const cls = p.kind === 'wall' && p.inExtension ? 'in extension'
        : p.kind === 'wall' ? `${p.provenance} wall`
          : p.kind;
      rows.push({ cls, kind: p.kind, d: p.dPerp ?? p.pathM / 2, resid: mm.residM, chan, seg: p.seg });
      if (p.seg) {
        const id = p.seg.inferred ? `inferred (${p.seg.a[0].toFixed(2)},${p.seg.a[1].toFixed(2)})`
          : `tags [${p.seg.ids.join(' ')}]`;
        if (!bySeg.has(id)) bySeg.set(id, []);
        bySeg.get(id).push(mm.residM);
      }
    }
    for (const mi of m.missed) if (mi.kind === 'wall') missedAll.push(mi);
  }

  // The one test that needs no segments and no tag chain: nothing may echo from
  // nearer than the carved free space claims, in any direction.
  //
  // Only arrivals the stereo delta calls `vertical` may be asked this. The
  // frontier is a horizontal claim, and a floor bounce has no horizontal
  // component at all — comparing the two flagged every triplet in the
  // synthetic room, where the nearest arrival is always the floor at half the
  // phone's height. The classifier is what makes the test askable.
  if (grid.floor) {
    const vert = sol.paired.pairs.filter((p) => p.cls === 'vertical');
    if (vert.length) {
      const fr = G.freeFrontier(sp.P, grid.floor, { maxRangeM: cfgMaxRange });
      const nearestEcho = Math.min(...vert.map((p) => p.pathM / 2));
      if (nearestEcho < fr.nearestM - cfgTol) frontierViolations++;
    }
  }
}

// ---------------------------------------------------------------------------
// Output

const med = (a) => (a.length ? G.pct(a, 0.5) : NaN);
console.log(`\ntriplets used ${triplets}, skipped ${skipped}`);
if (spSource.size) {
  console.log(`standpoint from: ${[...spSource].map(([k, n]) => `${k} ${n}`).join(', ')}`
    + (spSource.has('solved') ? '  (localized against the marker map)' : '  (tape measure)'));
}
// Did the phone stay put. A standpoint is an assumption every residual below
// rests on, and until the camera was on there was no way to check it at all —
// a nudge halfway through simply made every wall look wrong by however far it
// moved. Reported against the median, in the horizontal plane the walls live in.
if (spTrack.length > 2) {
  const ax = (i) => {
    const v = spTrack.map((p) => p[i]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const cx = ax(0);
  const cz = ax(2);
  const d = spTrack.map((p) => Math.hypot(p[0] - cx, p[2] - cz)).sort((a, b) => a - b);
  const p50 = d[Math.floor(d.length * 0.5)] * 1000;
  const p90 = d[Math.floor(d.length * 0.9)] * 1000;
  const worst = d[d.length - 1] * 1000;
  console.log(`standpoint moved: median ${p50.toFixed(0)} mm, p90 ${p90.toFixed(0)} mm, `
    + `worst ${worst.toFixed(0)} mm over ${spTrack.length} triplet(s)`
    + (worst > 200
      ? '\n  ** the phone did not stay put (or a solve flipped). Each triplet is\n'
        + '     compared against its OWN fix, so this is survivable — but a residual\n'
        + '     is only as good as the fix it was measured from. **'
      : ''));
}
// The stereo split is d_sep*(u.g); level, there is no split to read. Said here
// rather than left to be inferred from a nonsense sound speed three days later,
// which is how the first flat-on-a-chair-back session was actually diagnosed.
if (levelWarn.length) {
  const g = med(levelWarn);
  console.log(`  speaker axis |u·g| median ${g.toFixed(2)}`
    + (g < 0.3
      ? ' — TOO LEVEL. The floor/ceiling split does not exist at this attitude;\n'
        + '    every floor/ceiling classification below is noise. Stand the phone up.'
      : ' — upright enough for the floor/ceiling split'));
}
if (session.rejects.size) {
  console.log(`measurements rejected: ${[...session.rejects].map(([r, n]) => `${r} ${n}`).join(', ')}`);
}

// Which speaker was actually heard, and how loudly. The whole stereo
// discriminator rests on the earpiece returning something at 8-16 kHz, and it
// is built for speech — so this is the section that says whether the design
// works on this hardware, before any residual is worth reading.
if (session.snrByVariant?.size) {
  console.log('\nper emission variant (this is where a weak earpiece shows up):');
  for (const [v, snrs] of [...session.snrByVariant].sort()) {
    const miss = session.missing.get(v) || 0;
    console.log(`  ${v.padEnd(6)} heard ${String(snrs.length).padStart(4)}x, `
      + `missed ${String(miss).padStart(3)}x  direct SNR median ${med(snrs).toFixed(1)} dB `
      + `(p10 ${G.pct(snrs, 0.1).toFixed(1)})`);
  }
  if (session.incomplete) {
    console.log(`  ${session.incomplete} incomplete triplet(s) — a variant that never came back`);
    console.log('  A single channel consistently missing is a speaker too quiet in this');
    console.log('  band, not a bad session: floor and ceiling are the nearest and loudest');
    console.log('  surfaces there are, so classification can survive what walls cannot.');
  }
}
if (session.traces) console.log(`envelopes journaled: ${session.traces}`);

// Which gate actually bound. Without this the 04/08 session looked like a room
// full of surfaces when it was a saturated cap over a reverb tail.
if (session.gates?.n) {
  const g = session.gates;
  console.log('\npeak gates (per measurement, in order):');
  console.log(`  local maxima found      ${(g.raw / g.n).toFixed(1)}`);
  console.log(`  survived amplitude      ${(g.amp / g.n).toFixed(1)}`
    + `   (over the noise floor AND within reach of the direct arrival)`);
  console.log(`  survived prominence     ${(g.prom / g.n).toFixed(1)}`
    + `   (stands above its own neighbourhood)`);
  if (g.capped) {
    console.log(`  CAP BOUND on ${g.capped}/${g.n} measurements — the peak list was truncated.`);
    console.log('  A saturated cap means the gates are not selecting; what survives is an');
    console.log('  arbitrary 24 of a reverberant tail, and nothing downstream is meaningful.');
  }
  // The three numbers above are the CAPTURE-time gating, read back off the
  // journal's own counters. --rel-db/--prom-db cannot move them, so a sweep
  // that only printed those looked frozen while the residual underneath was
  // changing — the offline selection has to be counted separately or the line
  // the plan says to read first is answering about the wrong gate.
  if (sel.relDb != null || sel.promDb != null) {
    const kept = session.allPeaks.reduce((n, m) => n + selectPeaks(m).length, 0);
    console.log(`  survived offline gate   ${(kept / session.allPeaks.length).toFixed(1)}`
      + `   (--rel-db ${sel.relDb ?? 'off'}, --prom-db ${sel.promDb ?? 'off'})`);
  }
}

// Are the arrivals repeatable, or is this a diffuse field?
//
// The test that matters, and the one that is easy to skip: peaks scattered
// uniformly will land near ANY chosen distance at a rate set purely by their
// density. Measured on the 04/08 session, the observed hit rate was 63% where
// chance was 61% — the apparent clusters were sampling noise. A surface is only
// real if it beats this.
if (session.allPeaks?.length) {
  const bothOnly = session.allPeaks
    .filter((p) => p.variant === 'both' && selectPeaks(p).length);
  if (bothOnly.length >= 8) {
    const c = 331.3 + 0.606 * reportTempC;
    const ow = (dSamp, sr) => ((c * dSamp) / sr + cfgSpkMic) / 2;
    const dists = bothOnly.map((m) => selectPeaks(m).map((p) => ow(p[0], m.sr))
      .filter((x) => x > 0.3 && x < cfgMaxRange));
    const flat = dists.flat();
    if (flat.length > 20) {
      const span = Math.max(...flat) - Math.min(...flat);
      const perMeas = flat.length / bothOnly.length;
      const win = 0.16;
      const chance = 100 * (1 - Math.exp(-(perMeas * win) / span));
      let obs = 0;
      let k = 0;
      for (let t = 1.0; t <= Math.min(3.6, cfgMaxRange - 0.2); t += 0.05) {
        obs += dists.filter((ds) => ds.some((x) => Math.abs(x - t) < win / 2)).length / bothOnly.length;
        k++;
      }
      const observed = (100 * obs) / k;
      console.log('\nrepeatability vs chance (the diffuse-field test):');
      console.log(`  ${perMeas.toFixed(1)} arrivals/measurement over ${span.toFixed(2)} m`);
      console.log(`  a peak lands within 8 cm of an arbitrary distance: `
        + `observed ${observed.toFixed(0)}%, chance ${chance.toFixed(0)}%`);
      console.log(observed > chance * 1.5
        ? '  Above chance — there are repeatable surfaces here.'
        : '  AT CHANCE. No surface is being detected repeatably; these peaks are a\n'
          + '  diffuse reverberant field and any cluster in the histogram is noise.');
    }
  }
}

// Every path above was measured at the temperature model. The two solves are
// printed underneath it as a check on the arrival identification — both are
// exact given the right two peaks, so a solve far from the model means the
// floor or the ceiling was misread. Neither is ever used to range anything.
const cModel = 331.3 + 0.606 * reportTempC;
console.log(`\nsound speed used: ${cModel.toFixed(1)} m/s `
  + `(temperature model at ${reportTempC} C${tempExplicit ? ", --temp-c" : ", declared"} — the only one applied)`);
const solveLine = (key, label) => {
  if (!speedsAll[key].length) return;
  const m = med(speedsAll[key]);
  const off = (m - cModel) / cModel;
  console.log(`  ${label}  n ${String(speedsAll[key].length).padStart(3)}  median ${m.toFixed(1)} m/s`
    + `  ${off >= 0 ? '+' : ''}${(off * 100).toFixed(1)}%`
    + (Math.abs(off) > 0.05 ? '  ** arrival identification suspect **' : '  ok'));
};
solveLine('ceiling', 'ceiling check (floor+ceiling sum, height cancels)');
solveLine('split', 'split check   (d_sep/dt, no room measurement)    ');
if (hChecks.length) {
  console.log(`  phone height cross-check: declared vs solved, `
    + `median ${(med(hChecks) * 1000).toFixed(0)} mm off`);
}
if (dSepRecovered.length) {
  console.log(`  d_sep recovered from the deltas: ${(med(dSepRecovered) * 1000).toFixed(1)} mm `
    + `over ${dSepRecovered.length} triplet(s)`);
}

// The headline claim, answered with no map at all: does a portrait phone's pair
// of speakers tell a floor from a ceiling? This needs d_sep and nothing else —
// no segments, no tag chain, no declared standpoint — so it is printed before
// anything that does, and it stays readable in a session where the operator
// never set a standpoint.
console.log('\nsurface classification from the stereo delta alone');
{
  const tot = [...clsTally.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${tot} paired arrival(s), no map involved:`);
  for (const cl of ['floor', 'ceiling', 'vertical', 'ambiguous']) {
    const n = clsTally.get(cl) || 0;
    console.log(`    ${cl.padEnd(10)} ${String(n).padStart(5)}`
      + (tot ? `  ${((100 * n) / tot).toFixed(0)}%` : ''));
  }
  if (tot && !clsTally.get('floor') && !clsTally.get('ceiling')) {
    console.log('  NO floor and NO ceiling. Either the device is mono, the OS summed the');
    console.log('  channels, or d_sep is wrong. Nothing downstream is worth reading until');
    console.log('  this block has a floor and a ceiling in it.');
  }
}

console.log('\n  against the map:');
console.log('  (rows: what the map predicts is there. columns: what the sign of');
console.log('   top-minus-bottom says it is. No declared heights are used.)');
const clsCols = ['floor', 'ceiling', 'vertical', 'ambiguous'];
const kinds = [...new Set([...confusion.keys()].map((k) => k.split('|')[0]))];
if (!kinds.length) {
  console.log('  nothing paired — mono device, or the channels were summed.');
} else {
  console.log(`  ${'predicted'.padEnd(16)}${clsCols.map((c) => c.padStart(11)).join('')}`);
  for (const k of kinds) {
    const cells = clsCols.map((c) => String(confusion.get(`${k}|${c}`) || 0).padStart(11));
    console.log(`  ${k.padEnd(16)}${cells.join('')}`);
  }
  console.log('  note: wall+floor and wall+ceiling carry an intermediate, distance-dependent');
  console.log('  delta that GROWS toward +-d_sep as the wall gets closer, so near walls put');
  console.log('  them in the floor/ceiling columns. Expected, and harmless: the calibration');
  console.log('  takes the shortest arrival of each class, which a second-order bounce can');
  console.log('  never be. Read those cells as second-order, not as a broken classifier.');
}

console.log('\nresidual (measured path minus predicted, metres):');
const order = ['tagged wall', 'inferred wall', 'in extension', 'floor', 'ceiling',
  'wall+floor', 'wall+ceiling', 'edge'];
for (const cls of order) {
  const sel = rows.filter((r) => r.cls === cls);
  if (sel.length) console.log(`  ${cls.padEnd(15)}${G.stat(sel.map((r) => r.resid))}`);
}

const bands = [[0, 1], [1, 2], [2, 3], [3, 5], [5, 99]];
const wallRows = rows.filter((r) => r.kind === 'wall');
if (wallRows.length) {
  console.log('\nby predicted distance (walls only):');
  for (const [lo, hi] of bands) {
    const sel = wallRows.filter((r) => r.d >= lo && r.d < hi);
    if (sel.length) console.log(`  ${`${lo}-${hi} m`.padEnd(15)}${G.stat(sel.map((r) => r.resid))}`);
  }
  const fit = fitScale(wallRows.filter((r) => r.cls === 'tagged wall'));
  if (fit) {
    console.log(`\nscale fit over tagged walls: residual = ${(fit.a * 1000).toFixed(0)} mm `
      + `+ (${(fit.b * 100).toFixed(2)} %)*d`);
    console.log('  a slope here is a markers.json printed-marker-size error; the');
    console.log('  intercept is the speaker-to-mic path. Both are free second measurements.');
  }
}

const wallPreds = rows.filter((r) => r.kind === 'wall').length;
console.log(`\nrecall: ${wallPreds} predicted wall arrival(s) had energy within `
  + `${(cfgTol * 1000).toFixed(0)} mm; ${missedAll.length} did not`);
if (missedAll.length) {
  const occ = missedAll.filter((m) => m.occluded).length;
  const inf = missedAll.filter((m) => m.provenance === 'inferred').length;
  console.log(`  of the misses: ${occ} occluded by another segment, ${inf} inferred`);
}
console.log(`unexplained peaks: ${unexplained}`);
console.log('  NOT evidence against the map. A chair, a person, a curtain and the');
console.log('  operator\'s own hand are indistinguishable from one standpoint.');
if (grid.floor) {
  console.log(`  of which arriving nearer than the carved free frontier: ${frontierViolations}`);
  console.log('  (that one IS a violation — free space carved where something solid');
  console.log('   stands, which leaks() structurally cannot see. Should be 0.)');
}

if (bySeg.size) {
  console.log('\nper segment:');
  for (const [id, rs] of [...bySeg].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${id.padEnd(34)} n ${String(rs.length).padStart(4)}  `
      + `median ${(med(rs) * 1000 >= 0 ? '+' : '')}${(med(rs) * 1000).toFixed(0)} mm`);
  }
}

histogram(rows.filter((r) => r.kind === 'wall').map((r) => r.resid), 0.01, 'wall residual');

if (flags.csv) {
  const out = ['cls,kind,variant,d_m,resid_m']
    .concat(rows.map((r) => `${r.cls},${r.kind},${r.chan},${r.d.toFixed(4)},${r.resid.toFixed(4)}`));
  fs.writeFileSync(flags.csv, `${out.join('\n')}\n`);
  console.log(`\n${rows.length} row(s) written to ${flags.csv}`);
}

// The synthetic run is a test, so it has a verdict rather than just a report.
if (flags.synth) {
  console.log('\n--- synthetic verdict ---');
  let bad = 0;
  const check = (cond, what) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
    if (!cond) bad++;
  };
  const cErr = Math.abs(med(speedsAll.ceiling) - synth.cTrue);
  check(cErr < 0.5, `ceiling solve recovers c: ${med(speedsAll.ceiling).toFixed(2)} `
    + `vs ${synth.cTrue} (${(cErr * 1000).toFixed(0)} mm/s)`);
  check(Math.abs(med(dSepRecovered) - synth.dSep) < 0.005,
    `d_sep recovered: ${(med(dSepRecovered) * 1000).toFixed(1)} mm vs ${synth.dSep * 1000}`);
  const tagged = rows.filter((r) => r.cls === 'tagged wall').map((r) => r.resid);
  check(tagged.length > 0 && Math.abs(med(tagged)) < 0.02,
    `tagged-wall residual median ${(med(tagged) * 1000).toFixed(1)} mm inside the 10 mm noise`);
  const nFloor = confusion.get(`floor|floor`) || 0;
  const nCeil = confusion.get(`ceiling|ceiling`) || 0;
  check(nFloor > 0, `floor classified as floor from delta alone (${nFloor})`);
  check(nCeil > 0, `ceiling classified as ceiling from delta alone (${nCeil})`);
  check(frontierViolations === 0, `no free-frontier violations (${frontierViolations})`);
  console.log(bad ? `\n${bad} FAILURE(S)` : '\nsynthetic pipeline good');
  process.exit(bad ? 1 : 0);
}
