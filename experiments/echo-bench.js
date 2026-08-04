'use strict';

/*
 * experiments/echo-bench.js — audio-lab's echo detector, against known answers.
 *
 * `node experiments/echo-bench.js`
 *
 * The offline half has echo-geom.js's self-test and replay-echo.js --synth. The
 * detector had neither, and it is where a subtle bug would actually live: the
 * segment carry, and the variant attribution.
 *
 * Both are worth stating, because neither is obvious from the code.
 *
 * The CARRY. Valid correlation outputs run [0, hop) — about 261 ms — while the
 * echo window is roughly 35 ms. A direct arrival landing near the end of a
 * segment has its echoes in the NEXT one. echoScan defers every arrival by
 * exactly one segment so the whole window is always in hand; get the index
 * arithmetic wrong by the L-1 carry and the echoes come back displaced by
 * thousands of samples, which reads as a room several metres too big.
 *
 * The VARIANT. All three sub-emissions are the same chirp, so the matched
 * filter cannot tell them apart and they are attributed by arrival index
 * instead. Mislabel them and the stereo delta — the entire discriminator — is
 * computed between the wrong pair of speakers.
 *
 * This loads the real audio-lab.js under browser stubs. Nothing is
 * reimplemented; a bug here is a bug in the page.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------------------
// Browser stubs. Only what the page touches before and during capture.

const journal = [];
// A 2D context that does nothing except hand back real ImageData — the
// spectrogram writes into it every capture block, so it cannot be a no-op.
const noopCtx = new Proxy({}, {
  get: (t, k) => {
    if (k === 'canvas') return {};
    if (k === 'createImageData') {
      return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
    }
    if (k === 'getImageData') {
      return (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
    }
    return () => {};
  },
  set: () => true,
});
const fakeEl = () => new Proxy({
  value: '', textContent: '', className: '', disabled: false,
  clientWidth: 300, clientHeight: 100, width: 300, height: 100,
  style: {}, classList: { toggle: () => {}, add: () => {}, remove: () => {} },
  getContext: () => noopCtx,
  addEventListener: () => {},
}, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });

const els = new Map();
const sandbox = {
  console,
  performance: { now: () => Date.now() },
  Date,
  Math,
  JSON,
  Float32Array,
  Float64Array,
  Uint8Array,
  Uint8ClampedArray,
  Array,
  Object,
  Number,
  String,
  Set,
  Map,
  Promise,
  isFinite,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: () => 0,
  navigator: { userAgent: 'bench', mediaDevices: {} },
  window: { devicePixelRatio: 1 },
  document: {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, fakeEl());
      return els.get(id);
    },
    createElement: () => fakeEl(),
  },
  // common.js's exports, stubbed to the shape the page uses.
  connectSignaling: () => ({ send: (m) => { if (m.type === 'audio-log') journal.push(m.entry); } }),
  createClockSync: () => ({
    synced: false, handle: () => false, start: () => {}, now: () => 0, uncertaintyMs: 0,
  }),
  setStatus: () => {},
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const ctx = vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f });
load('fft.js');
load('audio-lab.js');

// The page's top-level `let`/`const` bindings live in the context's lexical
// scope, not on the sandbox object, so they are reached by evaluating in the
// context rather than by property access. Function declarations do land on the
// global object, but going through the same door for everything keeps the bench
// from depending on which is which.
const G = (expr) => vm.runInContext(expr, ctx);

// ---------------------------------------------------------------------------
// Synthetic capture

const SR = 48000;
const F0 = 8000;
const F1 = 16000;
const DUR_MS = 80;

// The page's own chirp synthesis, so the template and the signal cannot drift.
const chirp = G('buildChirp')(SR, { f0: F0, f1: F1, durMs: DUR_MS });

// Build a capture track: for each variant, a direct arrival at a known offset
// plus echoes at known delays behind it.
function buildTrack(totalLen, events) {
  const track = new Float32Array(totalLen);
  for (const { at, amp } of events) {
    const a = Math.round(at);
    for (let i = 0; i < chirp.length && a + i < totalLen; i++) track[a + i] += chirp[i] * amp;
  }
  // A little noise, or the median sigma floor is degenerate and every SNR is
  // the clamp rather than a measurement.
  let s = 12345;
  for (let i = 0; i < totalLen; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    track[i] += ((s / 4294967296) - 0.5) * 0.002;
  }
  return track;
}

function feed(track) {
  const BLK = 2048;
  for (let off = 0; off + BLK <= track.length; off += BLK) {
    G('onCaptureBlock')({ startFrame: off, samples: track.subarray(off, off + BLK) });
  }
}

// ---------------------------------------------------------------------------

let fails = 0;
const ok = (cond, what, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${extra ? `  ${extra}` : ''}`);
  if (!cond) fails++;
};

function run(name, { directAt, echoesM, variants }) {
  journal.length = 0;
  G("mode = 'echo'; running = true");
  G('echo').declared = true;
  G('echo').sp = 1;
  G('echo').seq = 1;
  G('echo').first = null;
  G('echo').triplet = {};
  G('resetFilterState')();
  G(`lastEmit = {f0:${F0},f1:${F1},durMs:${DUR_MS}}`);
  Object.assign(G('params'), { f0: F0, f1: F1, durMs: DUR_MS, threshDb: 18 });
  G('echoCfg').echoThreshDb = 8;
  G('echoCfg').maxRangeM = 6;

  const stepS = (G('echoCfg').variantMs / 1000) * SR;
  const events = [];
  const expect = [];
  for (let v = 0; v < variants; v++) {
    const base = directAt + v * stepS;
    events.push({ at: base, amp: 1.0 });
    for (const m of echoesM) {
      // One-way metres -> round-trip delay behind the direct arrival.
      const d = ((2 * m - G('echoCfg').spkMicM) / 343) * SR;
      events.push({ at: base + d, amp: 0.10 });
      expect.push({ v, dSamp: d });
    }
  }
  const track = buildTrack(directAt + variants * stepS + 4 * SR, events);
  feed(track);

  console.log(`\n${name}`);
  const got = journal.filter((e) => e.kind === 'echo');
  ok(got.length === variants, `${variants} variant(s) measured`, `got ${got.length}`);
  const order = G('ECHO_VARIANTS');
  for (let v = 0; v < Math.min(variants, got.length); v++) {
    ok(got[v].variant === order[v], `variant ${v} labelled ${order[v]}`, `got ${got[v].variant}`);
  }
  // Every planted echo must come back at its planted delay.
  let worst = 0;
  let found = 0;
  for (const e of expect.filter((x) => x.v < got.length)) {
    const peaks = got[e.v].peaks.map((p) => p[0]);
    const near = peaks.reduce((b, p) => (Math.abs(p - e.dSamp) < Math.abs(b - e.dSamp) ? p : b), 1e9);
    const err = Math.abs(near - e.dSamp);
    if (err < 12) { found++; worst = Math.max(worst, err); }
  }
  ok(found === expect.filter((x) => x.v < got.length).length,
    `all ${expect.filter((x) => x.v < got.length).length} planted echoes recovered`,
    `found ${found}, worst ${worst.toFixed(1)} samples (${(worst / SR * 343 / 2 * 1000).toFixed(0)} mm)`);
  return got;
}

console.log('audio-lab echo detector — known-answer bench');

// One triplet, echoes at 1.0 / 2.0 / 3.4 m one-way.
run('plain triplet, direct arrival mid-segment', {
  directAt: 5000, echoesM: [1.0, 2.0, 3.4], variants: 3,
});

// The carry. hop = FFT_N - L + 1; put the direct arrival a few hundred samples
// short of a segment boundary so its entire echo tail is in the next segment.
// Before the deferral this silently truncated the window.
const L = Math.min(G('MAX_TEMPLATE') ?? 8192, Math.round((DUR_MS / 1000) * SR));
const HOP = 16384 - L + 1;
run('direct arrival 300 samples before a segment boundary (the carry)', {
  directAt: HOP - 300, echoesM: [1.0, 2.0, 3.4], variants: 1,
});
run('direct arrival 40 samples before a segment boundary (the carry, worse)', {
  directAt: 2 * HOP - 40, echoesM: [1.5, 3.0], variants: 1,
});

// The stereo delta itself: plant a floor at +d_sep between the two single
// channels and check the page recovers the sign and the magnitude.
console.log('\nstereo delta end to end');
{
  journal.length = 0;
  G("mode = 'echo'; running = true");
  G('echo').declared = true;
  G('echo').first = null;
  G('echo').triplet = {};
  G('echo').topChannel = null;
  G('resetFilterState')();
  G(`lastEmit = {f0:${F0},f1:${F1},durMs:${DUR_MS}}`);
  Object.assign(G('params'), { f0: F0, f1: F1, durMs: DUR_MS, threshDb: 18 });

  const cfg = G('echoCfg');
  cfg.dSepM = 0.14; cfg.micOffM = -0.07; cfg.heightM = 1.05; cfg.ceilM = 2.5;
  cfg.spkMicM = 0.10; cfg.echoThreshDb = 8; cfg.maxRangeM = 6;
  // Declared through the page's own journal call, so the emitted file carries
  // exactly the entry a real session would and replay-echo.js can be pointed
  // straight at it.
  G('logEv')('echo-standpoint', { sp: 1, ...cfg, topChannel: null, f0: F0, f1: F1, durMs: DUR_MS });

  // Air at the page's declared temperature, because that constant is now the
  // only speed the page ranges with — planting the room at a different one
  // would make every classification tolerance measure the temperature error
  // rather than the stereo split this block exists to test.
  const cTrue = 331.3 + 0.606 * cfg.tempC;
  const stepS = (cfg.variantMs / 1000) * SR;
  const dly = (pathM) => ((pathM - cfg.spkMicM) / cTrue) * SR;

  // Order is [both, l, r]; make L the top speaker.
  const hm = cfg.heightM + cfg.micOffM;
  const paths = (spkOff) => {
    const hs = cfg.heightM + spkOff;
    return { floor: hs + hm, ceil: 2 * cfg.ceilM - hs - hm, wall: Math.hypot(4.0, hs - hm) };
  };
  const top = paths(+cfg.dSepM / 2);
  const bot = paths(-cfg.dSepM / 2);
  const perVariant = [
    [top.floor, top.ceil, top.wall, bot.floor, bot.ceil, bot.wall], // both fires both
    [top.floor, top.ceil, top.wall],                                // l = top
    [bot.floor, bot.ceil, bot.wall],                                // r = bottom
  ];
  const events = [];
  perVariant.forEach((ps, v) => {
    const base = 6000 + v * stepS;
    events.push({ at: base, amp: 1.0 });
    for (const p of ps) events.push({ at: base + dly(p), amp: 0.12 });
  });
  feed(buildTrack(6000 + 3 * stepS + 4 * SR, events));

  const verdict = journal.filter((e) => e.kind === 'echo-verdict').pop();
  ok(!!verdict, 'a verdict was reached');
  if (verdict) {
    ok(verdict.topChannel === 'l', 'top speaker identified as L from the sign alone',
      `got ${verdict.topChannel}`);
    const cls = Object.fromEntries(verdict.classes.map((c) => [c[0], c]));
    ok(!!cls.floor, 'floor classified from the delta alone',
      cls.floor ? `delta ${cls.floor[2].toFixed(4)} (+d_sep = +${cfg.dSepM})` : '');
    ok(!!cls.ceiling, 'ceiling classified from the delta alone',
      cls.ceiling ? `delta ${cls.ceiling[2].toFixed(4)} (-d_sep = -${cfg.dSepM})` : '');
    ok(cls.floor && cls.floor[2] > 0, 'floor delta is POSITIVE');
    ok(cls.ceiling && cls.ceiling[2] < 0, 'ceiling delta is NEGATIVE');
    ok(!!cls.vertical, 'the 2 m wall classified vertical',
      cls.vertical ? `delta ${cls.vertical[2].toFixed(4)} ~ 0` : '');
    // The solve no longer feeds the ranging — it is the check that the floor
    // and the ceiling were the arrivals the classifier says they were, so what
    // matters is that it lands on the true speed, not that anything used it.
    ok(Math.abs(verdict.cSolvedMps - cTrue) < 4,
      `sound speed solved back to ${cTrue.toFixed(2)}`,
      `got ${verdict.cSolvedMps} via ${verdict.cSolvedFrom}`);
    ok(Math.abs(verdict.cMps - cTrue) < 4 && verdict.cFrom === 'model',
      'the ranging used the temperature model, not the solve',
      `used ${verdict.cMps} via ${verdict.cFrom}`);
  }
}

// journalAudio (server.js:680) drops any line over 8192 bytes with a bare
// `return` — no log, no error, the entry simply never appears. The echo-trace
// entry is the one close enough to matter, so its size is a test rather than an
// arithmetic argument.
console.log('\njournal entry sizes vs the 8192-byte silent drop');
{
  const sizes = new Map();
  for (const e of journal) {
    // deviceId and serverAt are added server-side; charge them here too.
    const n = JSON.stringify({ ...e, deviceId: 'phone-000', serverAt: 1.7e12 }).length;
    const prev = sizes.get(e.kind) || { n: 0, max: 0 };
    sizes.set(e.kind, { n: prev.n + 1, max: Math.max(prev.max, n) });
  }
  let worst = 0;
  for (const [kind, s] of [...sizes].sort((a, b) => b[1].max - a[1].max)) {
    console.log(`  ${kind.padEnd(16)} n ${String(s.n).padStart(4)}  largest ${String(s.max).padStart(5)} B`);
    worst = Math.max(worst, s.max);
  }
  ok(worst < 8192, 'every entry is under the drop threshold', `worst ${worst} B`);
  ok(sizes.has('echo-trace'), 'envelopes are journaled at all');
}

// The contract between the two halves: replay-echo.js has to be able to read
// what audio-lab.js actually writes. Both sides were tested against their own
// idea of the schema; this writes a real journal from the real page code so the
// offline tool can be pointed at it.
//
//   node experiments/echo-bench.js --emit-journal /tmp/bench.jsonl
//   node experiments/replay-echo.js /tmp/bench.jsonl --grid grid.json
const emitTo = process.argv.indexOf('--emit-journal');
if (emitTo > 0 && process.argv[emitTo + 1]) {
  const out = process.argv[emitTo + 1];
  const lines = [JSON.stringify({ kind: 'meta', at: 0 })]
    .concat(journal.map((e) => JSON.stringify({ ...e, deviceId: 'bench', serverAt: 0 })));
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`\n${journal.length} entries written to ${out}`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall good');
process.exit(fails ? 1 : 0);
