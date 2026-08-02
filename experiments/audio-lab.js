'use strict';

/*
 * /audio-lab — acoustic ranging feasibility rig.
 *
 * One phone chirps, another listens; both run the identical capture + matched
 * filter path, so the chirper hearing (or not hearing) itself is measured the
 * same way as the listener hearing it across the room. The three questions
 * this page exists to answer, before any ranging code is written:
 *
 *  1. Does `echoCancellation: false` actually stick — or does the platform
 *     delete our own chirp from our own mic (which kills round-trip ranging)?
 *  2. How high can the chirp band be pushed before speaker/mic rolloff kills
 *     the correlation SNR?
 *  3. What does SNR look like at room distances, and how sharp is the
 *     correlation peak (multipath shows up as trailing echoes)?
 *
 * Everything measured is drawn, and everything drawn is journaled to the
 * server (`audio-log` → recordings/<stamp>_audiolab.jsonl), so a session can
 * be read afterwards without the phones in hand.
 */

// ---------------------------------------------------------------------------
// Parameters. The chirper broadcasts these with every emission (chirp-params
// via the server), so a listener's matched filter always correlates against
// the chirp actually in the air — the sweep changes them every few seconds.
// Band default from the measured two-phone session: ≥16 kHz is inaudible to
// the user and still lands at ~45 dB cross-device SNR up to ~22 kHz.
const params = {
  f0: 16500,
  f1: 21500,
  durMs: 80,
  intervalMs: 1000,
  gainDb: -12,      // playback gain, log-mapped slider
  threshDb: 18,     // detection threshold over the σ noise floor
};

const sweepCfg = {
  startHz: 8000,
  topHz: 22000,
  bandHz: 2000,
  stepHz: 1000,
  perStep: 5,
};

let mode = 'listen';          // 'chirp' | 'listen'
let running = false;
let sweepRun = null;          // abort flag object while a sweep is running

// Template length is bounded by the matched filter's FFT (half of FFT_N), so
// the duration control is capped to keep L under it at any sample rate.
const FFT_N = 16384;
const MAX_TEMPLATE = FFT_N / 2;

// ---------------------------------------------------------------------------
// Server link: clock sync for cross-device timestamps, chirp-params relay,
// and the measurement journal. The role is not a client role — this page must
// never look like a capture device to the server (it has no camera, and its
// "settings" would overwrite the real client's on the same phone).
let signaling = null;

function logEv(kind, data) {
  if (!signaling) return;
  signaling.send({
    type: 'audio-log',
    entry: {
      kind,
      at: Date.now(),
      perf: performance.now(),
      server: clockSync.synced ? clockSync.now() : null,
      clockUncMs: clockSync.synced ? clockSync.uncertaintyMs : null,
      mode,
      ...data,
    },
  });
}

signaling = connectSignaling('audio-lab', {
  onMessage(msg) {
    if (clockSync.handle(msg)) return;
    if (msg.type === 'chirp-params' && mode === 'listen') {
      // Follow the chirper. Only in listen mode: a chirper's template belongs
      // to its own chirp, not to another chirper's. The chirper broadcasts
      // with every emission, so an unchanged set is dropped here — the first
      // session journaled 676 param-change events, nearly all this echo.
      const same = msg.f0 === params.f0 && msg.f1 === params.f1
        && msg.durMs === params.durMs && msg.intervalMs === params.intervalMs;
      if (same) return;
      params.f0 = msg.f0;
      params.f1 = msg.f1;
      params.durMs = msg.durMs;
      params.intervalMs = msg.intervalMs;
      reflectParams();
      followEl.textContent = `following chirper: ${fmtBand(msg.f0, msg.f1)}, ${msg.durMs} ms`;
      logEv('param-change', { source: 'remote', ...currentChirpParams() });
      return;
    }
    if (msg.type === 'range-round' && mode === 'range' && !range.initiator) {
      // Arm for the announced round and adopt the initiator's band, so both
      // sides' templates describe the same pair of chirps.
      range.armedRound = { round: msg.round, at: performance.now() };
      if (msg.f0 !== params.f0 || msg.f1 !== params.f1 || msg.durMs !== params.durMs) {
        params.f0 = msg.f0;
        params.f1 = msg.f1;
        params.durMs = msg.durMs;
        reflectParams();
        logEv('param-change', { source: 'range-round', ...currentChirpParams() });
      }
      return;
    }
    if (msg.type === 'range-report' && mode === 'range') {
      range.peer.set(msg.round, msg);
      tryComputeRange(msg.round);
    }
  },
  onOpen() {
    clockSync.start();
    setStatus('connected');
  },
  onClose() {
    setStatus('server gone — reconnecting');
  },
});

const clockSync = createClockSync(signaling);

function currentChirpParams() {
  return { f0: params.f0, f1: params.f1, durMs: params.durMs, intervalMs: params.intervalMs };
}

// ---------------------------------------------------------------------------
// Audio path.
let ctx = null;
let micStream = null;
let workletNode = null;
let sampleRate = 48000;
let chirpTimer = null;

async function startAudio() {
  const requested = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };
  micStream = await navigator.mediaDevices.getUserMedia({ audio: requested });
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  sampleRate = ctx.sampleRate;
  await ctx.audioWorklet.addModule('/experiments/audio-lab-worklet.js');

  const src = ctx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(ctx, 'capture', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
  });
  src.connect(workletNode);
  // A worklet with nothing downstream may not be pulled at all; route it to
  // the destination through zero gain so it runs without feeding back.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  workletNode.connect(mute).connect(ctx.destination);
  workletNode.port.onmessage = (ev) => onCaptureBlock(ev.data);

  // The applied-vs-requested gap IS the echo-cancellation answer, so both go
  // in the journal verbatim.
  const applied = micStream.getAudioTracks()[0].getSettings();
  logEv('session-start', {
    ua: navigator.userAgent,
    sampleRate,
    baseLatency: ctx.baseLatency ?? null,
    requested,
    applied,
  });
  constraintsEl.textContent =
    `sampleRate ${sampleRate} · AEC ${fmtOnOff(applied.echoCancellation)}`
    + ` · NS ${fmtOnOff(applied.noiseSuppression)} · AGC ${fmtOnOff(applied.autoGainControl)}`;
  constraintsEl.className = applied.echoCancellation === false ? 'good' : 'bad';
}

function stopAudio() {
  if (chirpTimer) { clearInterval(chirpTimer); chirpTimer = null; }
  if (sweepRun) sweepRun.abort = true;
  workletNode?.port.close();
  micStream?.getTracks().forEach((t) => t.stop());
  ctx?.close();
  ctx = null; micStream = null; workletNode = null;
  resetFilterState();
}

function fmtOnOff(v) {
  return v === undefined ? '?' : v ? 'ON' : 'off';
}

// ---------------------------------------------------------------------------
// Chirp synthesis: linear FM sweep f0→f1 over durMs, Hann-windowed so the
// edges don't splatter energy across the band, unit peak.
function buildChirp(sr, p) {
  const n = Math.min(MAX_TEMPLATE, Math.round((p.durMs / 1000) * sr));
  const out = new Float32Array(n);
  const f0 = p.f0;
  const rate = (p.f1 - p.f0) / (2 * (n / sr));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    out[i] = w * Math.sin(2 * Math.PI * (f0 * t + rate * t * t));
  }
  return out;
}

let emitSeq = 0;
let lastEmitPerf = 0;

// Play one chirp with the page's volume setting. Shared by the chirp-mode
// timer and both sides of a ranging exchange.
function playChirp(p) {
  if (!ctx) return;
  const data = buildChirp(sampleRate, p);
  const buf = ctx.createBuffer(1, data.length, sampleRate);
  buf.copyToChannel(data, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = Math.pow(10, params.gainDb / 20);
  src.connect(g).connect(ctx.destination);
  src.start();
}

function emitChirp() {
  if (!ctx) return;
  lastEmitPerf = performance.now();
  lastEmit = currentChirpParams();
  playChirp(lastEmit);
  emitSeq++;
  const seq = emitSeq;
  signaling.send({ type: 'chirp-params', ...currentChirpParams() });
  logEv('chirp-emitted', { seq, ...currentChirpParams(), gainDb: params.gainDb, ctxTime: ctx.currentTime });

  // Self-heard verdict: a detection landing within the direct-path window
  // after this emission. Judged per chirp, and the absence is journaled too —
  // silence is the AEC failure mode this page exists to catch.
  const windowMs = selfWindowMs();
  setTimeout(() => {
    const hit = detections.find((d) => d.self && d.seq === seq);
    if (!hit) logEv('self-heard', { seq, ok: false });
    selfHeardEl.textContent = hit
      ? `self-heard ✓ ${hit.snrDb.toFixed(1)} dB`
      : 'self-heard ✗ (AEC eating our own chirp?)';
    selfHeardEl.className = hit ? 'good' : 'bad';
  }, windowMs + 150);
}

// How long after an emission a detection still counts as hearing ourselves.
// Not the acoustic path (that is ~2 ms): OS output+input latency plus the
// overlap-save hop (up to 261 ms of audio before a position is evaluated)
// put real self-detections ~300-500 ms after the emit call — measured, the
// old durMs+400 window misclassified 126 of them as "heard" and logged the
// chirps as missed. Capped at one interval so it can never claim the next
// chirp.
function selfWindowMs() {
  return Math.min(params.intervalMs, params.durMs + 900);
}

// ---------------------------------------------------------------------------
// Matched filter: FFT overlap-save cross-correlation against the chirp
// template. Valid correlation outputs advance hop = FFT_N - L + 1 samples per
// segment with an L-1 sample carry between segments, so every start position
// is evaluated exactly once and peak indices are absolute sample counts.
// The filter retunes only when the chirps it should match actually changed —
// and on the chirper, only at the next emission. Rebuilding eagerly lost real
// chirps two ways on the first measured session: a slider drag mid-flight
// re-templated a chirp already in the air, and the per-emission chirp-params
// broadcast made the listener reset its correlation carry every second,
// opening an ~80 ms dead window right where the chirp was about to land.
// A set rather than one template because ranging needs both directions at
// once: the exchange is an up-chirp answered by a down-chirp, and both sides
// listen for both (their own through the self-loop, the other's over the air).
let templates = [];           // [{label, p, key, re, im, len, lastDetAbs}]
let filterKey = '';
let lastEmit = null;          // params of the chirp most recently emitted

function chirpKey(p) {
  return `${p.f0}|${p.f1}|${p.durMs}|${sampleRate}`;
}

function wantedTemplates() {
  if (mode === 'range') {
    const p = currentChirpParams();
    return [
      { label: 'up', p },
      { label: 'down', p: { ...p, f0: p.f1, f1: p.f0 } },
    ];
  }
  const p = (mode === 'chirp' && lastEmit) ? lastEmit : currentChirpParams();
  return [{ label: 'chirp', p }];
}
let carry = null;             // last L-1 samples of the previous segment
let pending = [];             // Float32Array blocks from the worklet, in order
let pendingLen = 0;
let pendingStartAbs = 0;      // absolute index of pending[0][0]

const segRe = new Float64Array(FFT_N);
const segIm = new Float64Array(FFT_N);
const outRe = new Float64Array(FFT_N);
const outIm = new Float64Array(FFT_N);

function rebuildTemplates(want) {
  templates = want.map(({ label, p }) => {
    const t = buildChirp(sampleRate, p);
    const re = new Float64Array(FFT_N);
    const im = new Float64Array(FFT_N);
    let energy = 0;
    for (let i = 0; i < t.length; i++) energy += t[i] * t[i];
    // Unit-energy template: correlation amplitude means the same thing at
    // every duration, so the σ-floor clamp below has a fixed scale.
    const norm = 1 / Math.sqrt(energy || 1);
    for (let i = 0; i < t.length; i++) re[i] = t[i] * norm;
    fftInPlace(re, im, false);
    return { label, p, key: chirpKey(p), re, im, len: t.length, lastDetAbs: -1e15 };
  });
  filterKey = templates.map((t) => `${t.label}:${t.key}`).join('~');
  // A new template set means a new correlation meaning and possibly a new
  // length; the carry is sized L-1, so it cannot survive a length change.
  carry = null;
}

function resetFilterState() {
  carry = null;
  pending = [];
  pendingLen = 0;
  pendingStartAbs = 0;
  templates = [];
  filterKey = '';
  lastEmit = null;
}

function onCaptureBlock({ startFrame, samples }) {
  if (!running) return;
  if (pending.length === 0) pendingStartAbs = startFrame;
  pending.push(samples);
  pendingLen += samples.length;
  feedWaveform(samples);
  feedSpectrogram(samples);

  // What the filter should match: in listen mode the current (possibly
  // remotely-updated) params, in chirp mode the chirp actually emitted last
  // (so a slider drag never re-templates a chirp still in the air), in range
  // mode both directions of the exchange.
  const want = wantedTemplates();
  const wantKey = want.map((w) => `${w.label}:${chirpKey(w.p)}`).join('~');
  if (filterKey !== wantKey) rebuildTemplates(want);
  const L = Math.max(...templates.map((t) => t.len));
  const hop = FFT_N - L + 1;
  while (pendingLen >= hop) {
    // Assemble one segment: L-1 samples of history (zeros on the very first
    // pass — they stand for the silence before capture began), then hop new.
    const hadCarry = !!carry;
    segRe.fill(0);
    segIm.fill(0);
    if (carry) segRe.set(carry, 0);
    let dst = L - 1;
    let need = hop;
    let consumed = 0;
    for (const block of pending) {
      const n = Math.min(need, block.length);
      for (let i = 0; i < n; i++) segRe[dst + i] = block[i];
      dst += n; need -= n; consumed += n;
      if (need === 0) break;
    }
    // Drop the consumed samples, keeping partial blocks intact.
    let toDrop = consumed;
    while (toDrop > 0 && pending.length) {
      if (pending[0].length <= toDrop) {
        toDrop -= pending[0].length;
        pendingLen -= pending[0].length;
        pending.shift();
      } else {
        pending[0] = pending[0].subarray(toDrop);
        pendingLen -= toDrop;
        toDrop = 0;
      }
    }
    // The segment's first sample sits L-1 before the first new one, whether
    // that history was real (carry) or the pre-capture zeros.
    const segStartAbs = pendingStartAbs - (L - 1);
    pendingStartAbs += consumed;
    if (!carry) carry = new Float32Array(L - 1);
    for (let i = 0; i < L - 1; i++) carry[i] = segRe[hop + i];

    // Without real history the correlations that start inside the zero region
    // are half-template garbage — skip them once.
    correlateSegment(segStartAbs, hadCarry ? 0 : L - 1, hop);
  }
}

const corrMag = new Float64Array(FFT_N);

function correlateSegment(segStartAbs, firstValid, hop) {
  // Forward FFT once; each template then costs one spectral multiply and one
  // inverse — X · conj(T) is circular correlation whose first hop outputs
  // never wrap, which is the whole overlap-save trick.
  fftInPlace(segRe, segIm, false);
  let liveBest = 0;
  const cands = [];
  for (const tm of templates) {
    for (let i = 0; i < FFT_N; i++) {
      const xr = segRe[i]; const xi = segIm[i];
      outRe[i] = xr * tm.re[i] + xi * tm.im[i];
      outIm[i] = xi * tm.re[i] - xr * tm.im[i];
    }
    fftInPlace(outRe, outIm, true);
    for (let i = 0; i < hop; i++) corrMag[i] = Math.abs(outRe[i]);

    // Robust floor: the median of |corr| converted to a σ estimate
    // (median = 0.6745σ for Gaussian noise). Peak-vs-median alone is not a
    // usable statistic — the max of ~12k noise samples sits ~15 dB over the
    // median by pure order statistics, measured exactly that in simulation —
    // while peak-vs-σ puts noise at ~13 dB and a real chirp at 30+. Clamped:
    // a digitally-silent block has a near-zero median, and dividing by it
    // printed 200 dB "SNR" in the first session's journal. The template is
    // unit-energy, so full scale is O(1) and 1e-6 is far under any real
    // room's floor.
    const floor = Math.max(medianOfStride(corrMag, hop, 16) / 0.6745, 1e-6);

    let best = 0;
    let bestIdx = -1;
    for (let i = firstValid; i < hop; i++) {
      if (corrMag[i] > best) { best = corrMag[i]; bestIdx = i; }
    }
    if (bestIdx < 0) continue;
    const snrDb = 20 * Math.log10(best / floor);
    if (snrDb > liveBest) liveBest = snrDb;
    if (snrDb < params.threshDb) continue;

    // First-arrival refinement: indoors the strongest path is not always the
    // direct one, and a reflection can only ever be *later* — so the honest
    // peak is the earliest strong one. The search stays OUTSIDE the
    // correlation mainlobe (~sampleRate/bandwidth wide): inside it the
    // envelope ripples across 0.5·best and a naive walk-back landed ~9
    // samples early on a clean simulated chirp.
    const bw = Math.max(500, Math.abs(tm.p.f1 - tm.p.f0));
    const lobe = Math.round((1.5 * sampleRate) / bw) + 3;
    let pick = bestIdx;
    const back = Math.round(0.005 * sampleRate);
    for (let i = Math.max(firstValid, bestIdx - back, 1); i < bestIdx - lobe; i++) {
      if (corrMag[i] >= best * 0.5 && corrMag[i] >= corrMag[i - 1] && corrMag[i] >= corrMag[i + 1]) {
        pick = i;
        break;
      }
    }
    // Sub-sample peak via parabolic fit on the two neighbours (skipped at
    // segment edges, where a neighbour was not computed this pass).
    let frac = 0;
    if (pick > 0 && pick < hop - 1) {
      const a = corrMag[pick - 1]; const b = corrMag[pick]; const c = corrMag[pick + 1];
      const denom = a - 2 * b + c;
      if (denom < 0) frac = 0.5 * (a - c) / denom;
    }
    cands.push({
      tm, pick, frac, best, snrDb,
      floorDb: 20 * Math.log10(floor),
      trace: snapshotCorrTrace(pick, hop),
    });
  }
  liveSnrDb = liveBest;

  // Cross-template suppression. An up-chirp lights the down template too:
  // reversed linear chirps only reject each other by ~1/√(TB) (~26 dB at
  // 5 kHz × 80 ms), while a self-loop chirp sits 60+ dB over the floor — so
  // the cross-talk peak clears any usable threshold. Measured in simulation:
  // the initiator's own up fired a phantom "down" whose re-arm then swallowed
  // the real reply. Two labels claiming the same instant is physically one
  // chirp; the stronger correlation is the one it actually was.
  cands.sort((a, b) => b.best - a.best);
  const accepted = [];
  for (const c of cands) {
    if (accepted.some((a) => Math.abs(a.pick - c.pick) < a.tm.len)) continue;
    accepted.push(c);
  }
  const rearm = Math.round((params.intervalMs / 2 / 1000) * sampleRate);
  for (const c of accepted) {
    const absIdx = segStartAbs + c.pick;
    if (absIdx - c.tm.lastDetAbs < rearm) continue;
    c.tm.lastDetAbs = absIdx;
    corrTrace = c.trace;
    onDetection(c.tm.label, absIdx, c.frac, c.snrDb, c.floorDb);
  }
}

function medianOfStride(arr, len, stride) {
  const pick = [];
  for (let i = 0; i < len; i += stride) pick.push(arr[i]);
  pick.sort((a, b) => a - b);
  return pick[pick.length >> 1];
}

// ---------------------------------------------------------------------------
// Detections: the record every chart and the journal draw from.
const detections = [];
let liveSnrDb = 0;
let detCount = 0;

function onDetection(label, absIdx, frac, snrDb, floorDb) {
  detCount++;
  const perfNow = performance.now();
  // A detection inside the self window after our own emission is ourselves —
  // see selfWindowMs for why the window is as wide as it is.
  const self = mode === 'chirp' && perfNow - lastEmitPerf < selfWindowMs();
  const det = {
    t: perfNow,
    label,
    snrDb,
    floorDb,
    self,
    seq: self ? emitSeq : null,
    band: [params.f0, params.f1],
    abs: absIdx + frac,
  };
  detections.push(det);
  if (detections.length > 2000) detections.splice(0, 1000);
  if (sweepRun) sweepRun.collected.push(det);
  // Ranging chirps are all in one band; keeping them out of the sweep chart
  // stops a ranging session from drowning the sweep's answer.
  if (mode !== 'range') recordSweepSample(det);
  logEv('detection', {
    label,
    snrDb: +snrDb.toFixed(2),
    floorDb: +floorDb.toFixed(2),
    sample: absIdx,
    frac: +frac.toFixed(3),
    self,
    seq: det.seq,
    ...currentChirpParams(),
  });
  if (self) logEv('self-heard', { seq: det.seq, ok: true, snrDb: +snrDb.toFixed(2) });
  if (mode === 'range') rangeOnDetection(label, absIdx + frac, snrDb);
  bigSnrEl.textContent = `${snrDb.toFixed(1)} dB`;
  detCountEl.textContent = `${detCount} detection${detCount === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Sweep: step the band upward, N chirps per step, journal each step. The
// listener needs no sweep state at all — it follows chirp-params and its
// per-band chart fills in on its own.
async function runSweep() {
  if (mode !== 'chirp' || !running) return;
  const run = { abort: false, collected: [] };
  sweepRun = run;
  sweepBtn.textContent = 'Stop sweep';
  const sr2 = sampleRate / 2 - 500;
  const saved = currentChirpParams();
  for (let f0 = sweepCfg.startHz; f0 + sweepCfg.bandHz <= Math.min(sweepCfg.topHz, sr2); f0 += sweepCfg.stepHz) {
    if (run.abort) break;
    params.f0 = f0;
    params.f1 = f0 + sweepCfg.bandHz;
    reflectParams();
    logEv('sweep-step', { ...currentChirpParams(), perStep: sweepCfg.perStep });
    for (let i = 0; i < sweepCfg.perStep && !run.abort; i++) {
      emitChirp();
      await sleep(params.intervalMs);
    }
    // Let the tail of the last chirp land before the band moves on.
    await sleep(300);
  }
  params.f0 = saved.f0;
  params.f1 = saved.f1;
  reflectParams();
  logEv('sweep-done', { detections: run.collected.length });
  sweepRun = null;
  sweepBtn.textContent = 'Start sweep';
}

function sleep(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}

// Per-band SNR record for the sweep chart, fed by every detection (sweep or
// not) so manual band exploration draws the same picture.
const bandStats = new Map();   // centerHz -> number[]

function recordSweepSample(det) {
  const center = Math.round((det.band[0] + det.band[1]) / 2);
  if (!bandStats.has(center)) bandStats.set(center, []);
  const list = bandStats.get(center);
  list.push(det.snrDb);
  if (list.length > 200) list.shift();
}

// ---------------------------------------------------------------------------
// Ranging (BeepBeep, Peng et al. 2007). One round: the initiator plays an
// up-chirp; the responder hears it and, after a fixed reply delay, plays a
// down-chirp. Each side records BOTH chirps through its own mic and measures
// the interval between them in its own sample clock:
//
//   interval_init = t(down arrives)   - t(own up, self-loop)
//   interval_resp = t(own down, self) - t(up arrives)
//   d = c/2 · (interval_init - interval_resp) + spk↔mic bias
//
// Every unknown that plagues one-way time-of-flight cancels in the
// subtraction: network clock offset, OS audio output latency, the reply
// delay, scheduling jitter. What remains is each device counting its own ADC
// samples — 1 sample at 48 kHz = 7 mm of sound travel. The spk↔mic constant
// (each device hears itself over a few cm of chassis) survives as an additive
// bias, entered below and worth calibrating once against a tape measure.
const RANGE_REPLY_DELAY_MS = 250;
const SOUND_MPS = 343;        // ~20 °C; 0.6 m/s per °C if it ever matters

const range = {
  initiator: false,
  round: 0,
  cur: null,                  // the round in flight on this device
  replyAt: 0,                 // responder rate limit
  armedRound: null,           // responder: round id announced over the WS
  mine: new Map(),            // round -> own report
  peer: new Map(),            // round -> other side's report
  results: [],                // {t, m}
  biasM: 0.10,
  timer: null,
};

function startRounds() {
  if (range.timer) return;
  // 2 s floor: a reply detected late (hop latency + OS audio can put it
  // ~1 s after the up) must land while its round is still the current one —
  // measured at 1.5 s, stragglers paired with the next round and produced
  // ±70 m results with an interval difference of exactly one reply delay.
  const period = Math.max(2000, params.intervalMs);
  range.timer = setInterval(() => {
    if (!running || mode !== 'range') return;
    if (range.cur && !(range.cur.t1 != null && range.cur.t2 != null)) {
      logEv('range-miss', { round: range.cur.round, hadUp: range.cur.t1 != null });
    }
    range.round++;
    range.cur = { round: range.round, t1: null, t2: null };
    // Announced before the sound exists: the responder needs the round id and
    // the band, and the message beats the chirp to it by hundreds of ms.
    signaling.send({ type: 'range-round', round: range.round, ...currentChirpParams() });
    playChirp(currentChirpParams());
    logEv('range-emit', { round: range.round, dir: 'up', ...currentChirpParams() });
  }, period);
}

function stopRounds() {
  if (range.timer) clearInterval(range.timer);
  range.timer = null;
  range.cur = null;
}

function rangeOnDetection(label, absSample, snrDb) {
  if (range.initiator) {
    const cur = range.cur;
    if (!cur) return;
    if (label === 'up' && cur.t1 == null) {
      // Our own up-chirp through the self-loop. The responder never emits an
      // up, so on this device the label alone identifies it.
      cur.t1 = absSample;
    } else if (label === 'down' && cur.t1 != null && cur.t2 == null) {
      // The reply cannot arrive before the responder's fixed delay has
      // passed; anything earlier is cross-talk that slipped the suppression.
      const minGap = (RANGE_REPLY_DELAY_MS / 2 / 1000) * sampleRate;
      if (absSample - cur.t1 < minGap) return;
      cur.t2 = absSample;
      finishReport('init', cur.round, cur.t1, cur.t2, snrDb);
    }
    return;
  }
  // Responder. Any up-chirp is the initiator's; reply once per round.
  if (label === 'up') {
    const now = performance.now();
    if (now - range.replyAt < 1200) return;
    range.replyAt = now;
    const armed = range.armedRound && now - range.armedRound.at < 2500
      ? range.armedRound.round : null;
    range.cur = { round: armed, t1: absSample, t2: null, emitted: false };
    // The delay's exact value cancels in the math; it exists so our down does
    // not overlap the tail and echoes of the up still in the room.
    setTimeout(() => {
      if (!running || mode !== 'range' || !range.cur) return;
      const p = currentChirpParams();
      playChirp({ ...p, f0: p.f1, f1: p.f0 });
      range.cur.emitted = true;
      logEv('range-emit', { round: armed, dir: 'down' });
    }, RANGE_REPLY_DELAY_MS);
  } else if (label === 'down' && range.cur && range.cur.emitted && range.cur.t2 == null) {
    // Our own down through the self-loop.
    range.cur.t2 = absSample;
    finishReport('resp', range.cur.round, range.cur.t1, range.cur.t2, snrDb);
  }
}

function finishReport(role, round, t1, t2, snrDb) {
  if (round == null) return;
  const rep = { type: 'range-report', role, round, t1, t2, sr: sampleRate };
  signaling.send(rep);
  logEv('range-report', { role, round, t1, t2, sr: sampleRate, snrDb: +snrDb.toFixed(1) });
  range.mine.set(round, rep);
  tryComputeRange(round);
}

function tryComputeRange(round) {
  const init = range.initiator ? range.mine.get(round) : range.peer.get(round);
  const resp = range.initiator ? range.peer.get(round) : range.mine.get(round);
  if (!init || !resp) return;
  const iInit = (init.t2 - init.t1) / init.sr;
  const iResp = (resp.t2 - resp.t1) / resp.sr;
  const d = (SOUND_MPS / 2) * (iInit - iResp) + range.biasM;
  // Physics gate: the interval difference IS the two-way flight time, so it
  // must sit in [0, ~70 ms] (0–12 m) — small negative allowed for the spk↔mic
  // bias. A mispaired round (a straggling reply claimed by the wrong round)
  // shows up as ~±one reply delay and implied ±70 m; a bare distance cap let
  // one at 47 m through, the flight-time bound cannot.
  const dtMs = (iInit - iResp) * 1000;
  const plausible = dtMs > -5 && dtMs < 70;
  logEv('range', {
    round,
    m: +d.toFixed(4),
    iInitMs: +(iInit * 1000).toFixed(3),
    iRespMs: +(iResp * 1000).toFixed(3),
    plausible,
  });
  if (!plausible) return;
  range.results.push({ t: performance.now(), m: d });
  if (range.results.length > 400) range.results.splice(0, 200);
  distEl.textContent = `${d.toFixed(2)} m`;
  const last = range.results.slice(-10).map((r) => r.m).sort((x, y) => x - y);
  distMedEl.textContent = `median(10): ${last[last.length >> 1].toFixed(2)} m`;
}

// ---------------------------------------------------------------------------
// Charts. All canvas 2D, palette validated against this page's surface
// (#1c1c1c): series blue #3987e5 (heard), orange #d95926 (self), sequential
// blue ramp for the spectrogram. Text stays in ink colors, never series hues.
const COL = {
  surface: '#1c1c1c',
  grid: '#2c2c2a',
  axis: '#383835',
  muted: '#898781',
  ink: '#eee',
  heard: '#3987e5',
  self: '#d95926',
};

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = COL.surface;
  c.fillRect(0, 0, w, h);
  return [c, w, h];
}

function gridLines(c, w, h, rows) {
  c.strokeStyle = COL.grid;
  c.lineWidth = 1;
  for (let i = 1; i < rows; i++) {
    const y = (h * i) / rows;
    c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
  }
}

// --- waveform: last 100 ms, min/max envelope per pixel column.
const WAVE_LEN = () => Math.round(sampleRate / 10);
let wave = new Float32Array(4800);
let wavePos = 0;

function feedWaveform(samples) {
  const n = WAVE_LEN();
  if (wave.length !== n) { wave = new Float32Array(n); wavePos = 0; }
  for (let i = 0; i < samples.length; i++) {
    wave[wavePos] = samples[i];
    wavePos = (wavePos + 1) % n;
  }
}

function drawWaveform() {
  const [c, w, h] = setupCanvas(waveCv);
  gridLines(c, w, h, 2);
  c.strokeStyle = COL.heard;
  c.lineWidth = 1;
  const n = wave.length;
  c.beginPath();
  for (let x = 0; x < w; x++) {
    const a = Math.floor((x / w) * n);
    const b = Math.floor(((x + 1) / w) * n);
    let lo = 1; let hi = -1;
    for (let i = a; i < b && i < n; i++) {
      const v = wave[(wavePos + i) % n];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi < lo) continue;
    c.moveTo(x + 0.5, h / 2 - hi * (h / 2 - 2));
    c.lineTo(x + 0.5, h / 2 - lo * (h / 2 - 2) + 0.5);
  }
  c.stroke();
  label(c, 'mic · last 100 ms', 6, 12);
}

// --- spectrogram: scrolling, FFT of each 2048-sample worklet block through
// the same FFT the matched filter uses — it shows exactly what the filter
// sees, AnalyserNode would not.
const SPEC_FFT = 2048;
const SPEC_H = 256;
const specBack = document.createElement('canvas');
specBack.width = 512;
specBack.height = SPEC_H;
const specCtx = specBack.getContext('2d');
specCtx.fillStyle = COL.surface;
specCtx.fillRect(0, 0, specBack.width, SPEC_H);
const specWin = new Float64Array(SPEC_FFT);
for (let i = 0; i < SPEC_FFT; i++) specWin[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (SPEC_FFT - 1)));
const specRe = new Float64Array(SPEC_FFT);
const specIm = new Float64Array(SPEC_FFT);
const specCol = specCtx.createImageData(1, SPEC_H);
// Sequential single-hue ramp, dark surface → bright blue (near-zero recedes).
const SPEC_LUT = buildSpectroLut();

function buildSpectroLut() {
  const stops = [
    [0.0, 0x1c, 0x1c, 0x1c],
    [0.35, 0x10, 0x42, 0x81],
    [0.65, 0x39, 0x87, 0xe5],
    [0.85, 0x9e, 0xc5, 0xf4],
    [1.0, 0xcd, 0xe2, 0xfb],
  ];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k];
    const [t1, r1, g1, b1] = stops[k + 1];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    lut[i * 3] = Math.round(r0 + (r1 - r0) * f);
    lut[i * 3 + 1] = Math.round(g0 + (g1 - g0) * f);
    lut[i * 3 + 2] = Math.round(b0 + (b1 - b0) * f);
  }
  return lut;
}

function feedSpectrogram(samples) {
  if (samples.length !== SPEC_FFT) return;
  for (let i = 0; i < SPEC_FFT; i++) {
    specRe[i] = samples[i] * specWin[i];
    specIm[i] = 0;
  }
  fftInPlace(specRe, specIm, false);
  // Scroll one column left, paint the new one at the right edge.
  specCtx.drawImage(specBack, 1, 0, specBack.width - 1, SPEC_H, 0, 0, specBack.width - 1, SPEC_H);
  const half = SPEC_FFT / 2;
  const d = specCol.data;
  for (let y = 0; y < SPEC_H; y++) {
    // y=0 is the top = highest frequency.
    const bin = Math.floor(((SPEC_H - 1 - y) / SPEC_H) * half);
    const mag = Math.hypot(specRe[bin], specIm[bin]) / SPEC_FFT;
    const db = 20 * Math.log10(mag + 1e-9);
    const t = Math.min(1, Math.max(0, (db + 90) / 60));   // -90..-30 dB window
    const idx = Math.round(t * 255) * 3;
    d[y * 4] = SPEC_LUT[idx];
    d[y * 4 + 1] = SPEC_LUT[idx + 1];
    d[y * 4 + 2] = SPEC_LUT[idx + 2];
    d[y * 4 + 3] = 255;
  }
  specCtx.putImageData(specCol, specBack.width - 1, 0);
}

function drawSpectrogram() {
  const [c, w, h] = setupCanvas(specCv);
  c.imageSmoothingEnabled = false;
  c.drawImage(specBack, 0, 0, w, h);
  // Frequency scale and the current chirp band, so "is the stripe where the
  // band is" can be read straight off.
  const nyq = sampleRate / 2;
  c.fillStyle = COL.muted;
  c.font = '11px system-ui, sans-serif';
  for (const f of [5000, 10000, 15000, 20000]) {
    if (f >= nyq) continue;
    const y = h - (f / nyq) * h;
    c.fillText(`${f / 1000}k`, 4, y - 2);
    c.strokeStyle = COL.grid;
    c.beginPath(); c.moveTo(28, y); c.lineTo(w, y); c.stroke();
  }
  for (const f of [params.f0, params.f1]) {
    const y = h - (f / nyq) * h;
    c.strokeStyle = COL.self;
    c.beginPath(); c.moveTo(w - 14, y); c.lineTo(w, y); c.stroke();
  }
  label(c, 'spectrogram · band marks at chirp f0/f1', 34, 12);
}

// --- correlation trace: ±20 ms of |corr| around the last detection.
// Snapshotted inside correlateSegment while corrMag still belongs to the
// right template, committed only for detections that survive suppression.
let corrTrace = null;

function snapshotCorrTrace(segIdx, hop) {
  const halfWin = Math.round(0.02 * sampleRate);
  const a = Math.max(0, segIdx - halfWin);
  const b = Math.min(hop, segIdx + halfWin);
  const out = new Float32Array(b - a);
  let peak = 1e-12;
  for (let i = a; i < b; i++) peak = Math.max(peak, corrMag[i]);
  for (let i = a; i < b; i++) out[i - a] = corrMag[i] / peak;
  return { data: out, peakAt: segIdx - a };
}

function drawCorrTrace() {
  const [c, w, h] = setupCanvas(corrCv);
  gridLines(c, w, h, 2);
  if (!corrTrace) {
    label(c, 'correlation · waiting for a detection', 6, 12);
    return;
  }
  const { data, peakAt } = corrTrace;
  c.strokeStyle = COL.heard;
  c.lineWidth = 2;
  c.beginPath();
  for (let x = 0; x < w; x++) {
    const i = Math.floor((x / w) * data.length);
    const y = h - 3 - data[i] * (h - 16);
    if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.stroke();
  const px = (peakAt / data.length) * w;
  c.strokeStyle = COL.muted;
  c.setLineDash([3, 3]);
  c.beginPath(); c.moveTo(px, 12); c.lineTo(px, h); c.stroke();
  c.setLineDash([]);
  label(c, 'correlation · ±20 ms around last peak (echoes trail right)', 6, 12);
}

// --- SNR timeline: last 60 s of detections, heard vs self.
function drawSnrTimeline() {
  const [c, w, h] = setupCanvas(snrCv);
  const now = performance.now();
  const SPAN = 60000;
  const MAXDB = 60;
  gridLines(c, w, h, 3);
  c.fillStyle = COL.muted;
  c.font = '11px system-ui, sans-serif';
  const yOfDb = (db) => h - 2 - (db / MAXDB) * (h - 16);
  c.fillText('40', 4, yOfDb(40) + 4);
  c.fillText('20', 4, yOfDb(20) + 4);
  // Threshold line: everything above it is a detection by definition.
  const ty = h - 2 - (params.threshDb / MAXDB) * (h - 16);
  c.strokeStyle = COL.axis;
  c.setLineDash([4, 4]);
  c.beginPath(); c.moveTo(0, ty); c.lineTo(w, ty); c.stroke();
  c.setLineDash([]);
  for (const d of detections) {
    const age = now - d.t;
    if (age > SPAN) continue;
    const x = w - (age / SPAN) * w;
    const y = h - 2 - (Math.min(MAXDB, d.snrDb) / MAXDB) * (h - 16);
    c.fillStyle = d.self ? COL.self : COL.heard;
    c.beginPath(); c.arc(x, y, 3, 0, 2 * Math.PI); c.fill();
  }
  // Legend: two series on one chart, so identity must not be color-alone in
  // position — dot + text label each.
  legendDot(c, w - 150, 12, COL.heard, 'heard');
  legendDot(c, w - 90, 12, COL.self, 'self');
  label(c, 'detection SNR · last 60 s', 6, 12);
}

// --- sweep chart: per-band SNR, dots + median, the "how high can it go"
// answer as a picture.
function drawSweepChart() {
  const [c, w, h] = setupCanvas(sweepCv);
  gridLines(c, w, h, 3);
  const centers = [...bandStats.keys()].sort((a, b) => a - b);
  if (!centers.length) {
    label(c, 'per-band SNR · run a sweep (or chirp around) to fill this in', 6, 12);
    return;
  }
  const fMin = Math.min(...centers) - sweepCfg.stepHz;
  const fMax = Math.max(...centers) + sweepCfg.stepHz;
  const MAXDB = 60;
  const xOf = (f) => ((f - fMin) / (fMax - fMin)) * (w - 30) + 24;
  const yOf = (db) => h - 14 - (Math.min(MAXDB, Math.max(0, db)) / MAXDB) * (h - 30);
  c.font = '11px system-ui, sans-serif';
  const medians = [];
  for (const f of centers) {
    const list = [...bandStats.get(f)].sort((a, b) => a - b);
    const med = list[list.length >> 1];
    medians.push([f, med]);
    c.fillStyle = COL.heard;
    c.globalAlpha = 0.35;
    for (const db of list) {
      c.beginPath(); c.arc(xOf(f), yOf(db), 2.5, 0, 2 * Math.PI); c.fill();
    }
    c.globalAlpha = 1;
  }
  c.strokeStyle = COL.heard;
  c.lineWidth = 2;
  c.beginPath();
  medians.forEach(([f, db], i) => {
    if (i === 0) c.moveTo(xOf(f), yOf(db)); else c.lineTo(xOf(f), yOf(db));
  });
  c.stroke();
  for (const [f, db] of medians) {
    c.fillStyle = COL.heard;
    c.beginPath(); c.arc(xOf(f), yOf(db), 4, 0, 2 * Math.PI); c.fill();
    c.fillStyle = COL.ink;
    c.fillText(db.toFixed(0), xOf(f) - 6, yOf(db) - 8);
  }
  c.fillStyle = COL.muted;
  for (const f of centers) {
    c.fillText(`${(f / 1000).toFixed(0)}k`, xOf(f) - 8, h - 2);
  }
  label(c, 'SNR by band centre (dots = chirps, line = median dB)', 6, 12);
}

// --- distance: every plausible round of the last two minutes.
function drawRangeChart() {
  const [c, w, h] = setupCanvas(rangeCv);
  gridLines(c, w, h, 3);
  const now = performance.now();
  const SPAN = 120000;
  const pts = range.results.filter((r) => now - r.t <= SPAN);
  if (!pts.length) {
    label(c, 'distance · press “Initiate rounds” on one device, the other replies', 6, 12);
    return;
  }
  const maxM = Math.max(0.5, ...pts.map((p) => p.m)) * 1.25;
  const yOf = (m) => h - 4 - (m / maxM) * (h - 20);
  c.font = '11px system-ui, sans-serif';
  c.fillStyle = COL.muted;
  for (const m of [maxM * 0.75, maxM * 0.375]) c.fillText(`${m.toFixed(1)} m`, 4, yOf(m) + 4);
  const med = [...pts.slice(-10).map((p) => p.m)].sort((a, b) => a - b);
  const medV = med[med.length >> 1];
  c.strokeStyle = COL.axis;
  c.setLineDash([4, 4]);
  c.beginPath(); c.moveTo(0, yOf(medV)); c.lineTo(w, yOf(medV)); c.stroke();
  c.setLineDash([]);
  c.fillStyle = COL.heard;
  for (const p of pts) {
    const x = w - ((now - p.t) / SPAN) * w;
    c.beginPath(); c.arc(x, yOf(p.m), 3, 0, 2 * Math.PI); c.fill();
  }
  c.fillStyle = COL.ink;
  c.fillText(`${medV.toFixed(2)} m`, w - 60, yOf(medV) - 6);
  label(c, 'distance per round · dashed = median of last 10', 6, 12);
}

function label(c, text, x, y) {
  c.fillStyle = COL.muted;
  c.font = '11px system-ui, sans-serif';
  c.fillText(text, x, y);
}

function legendDot(c, x, y, color, text) {
  c.fillStyle = color;
  c.beginPath(); c.arc(x, y - 3, 4, 0, 2 * Math.PI); c.fill();
  c.fillStyle = COL.ink;
  c.font = '11px system-ui, sans-serif';
  c.fillText(text, x + 8, y);
}

function frame() {
  // Drawn whether or not audio runs — an idle page with dead-black boxes
  // reads as broken, and the redraw is a rounding error at these sizes.
  drawWaveform();
  drawSpectrogram();
  drawCorrTrace();
  drawSnrTimeline();
  drawSweepChart();
  drawRangeChart();
  if (running) liveSnrEl.textContent = `${liveSnrDb.toFixed(1)} dB`;
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// UI wiring.
const $ = (id) => document.getElementById(id);
const waveCv = $('waveCv');
const specCv = $('specCv');
const corrCv = $('corrCv');
const snrCv = $('snrCv');
const sweepCv = $('sweepCv');
const bigSnrEl = $('bigSnr');
const liveSnrEl = $('liveSnr');
const selfHeardEl = $('selfHeard');
const detCountEl = $('detCount');
const constraintsEl = $('constraints');
const followEl = $('follow');
const startBtn = $('startBtn');
const sweepBtn = $('sweepBtn');
const modeChirpBtn = $('modeChirp');
const modeListenBtn = $('modeListen');
const modeRangeBtn = $('modeRange');
const rangeGoBtn = $('rangeGoBtn');
const rangeCv = $('rangeCv');
const distEl = $('dist');
const distMedEl = $('distMed');

function fmtBand(f0, f1) {
  return `${(f0 / 1000).toFixed(1)}–${(f1 / 1000).toFixed(1)} kHz`;
}

const controls = [
  ['f0', 'f0', 1000, (v) => `${(v / 1000).toFixed(1)} kHz`],
  ['f1', 'f1', 1000, (v) => `${(v / 1000).toFixed(1)} kHz`],
  ['durMs', 'dur', 1, (v) => `${v} ms`],
  ['intervalMs', 'interval', 1, (v) => `${v} ms`],
  ['gainDb', 'gain', 1, (v) => `${v} dB`],
  ['threshDb', 'thresh', 1, (v) => `${v} dB`],
];

function reflectParams() {
  for (const [key, id, , fmt] of controls) {
    $(id).value = params[key];
    $(`${id}Val`).textContent = fmt(params[key]);
  }
  for (const [key, id] of [['startHz', 'swStart'], ['topHz', 'swTop'], ['bandHz', 'swBand'], ['stepHz', 'swStep'], ['perStep', 'swPer']]) {
    $(id).value = sweepCfg[key];
  }
  $('rangeBias').value = range.biasM;
}

for (const [key, id, , fmt] of controls) {
  $(id).addEventListener('input', () => {
    params[key] = Number($(id).value);
    $(`${id}Val`).textContent = fmt(params[key]);
    // f0 above f1 is a down-chirp; allowed on purpose (a future emitter-id
    // scheme uses exactly that), but the band must stay under Nyquist. The
    // filter picks the change up on its own (chirpKey mismatch) — in chirp
    // mode only at the next emission, so nothing in flight is lost.
    logEv('param-change', { source: 'local', ...currentChirpParams(), gainDb: params.gainDb, threshDb: params.threshDb });
  });
}
for (const [key, id] of [['startHz', 'swStart'], ['topHz', 'swTop'], ['bandHz', 'swBand'], ['stepHz', 'swStep'], ['perStep', 'swPer']]) {
  $(id).addEventListener('input', () => { sweepCfg[key] = Number($(id).value); });
}

function setMode(m) {
  mode = m;
  modeChirpBtn.classList.toggle('active', m === 'chirp');
  modeListenBtn.classList.toggle('active', m === 'listen');
  modeRangeBtn.classList.toggle('active', m === 'range');
  sweepBtn.disabled = m !== 'chirp' || !running;
  rangeGoBtn.disabled = m !== 'range' || !running;
  followEl.textContent = m === 'listen' ? 'listen mode — follows the chirper’s parameters'
    : m === 'range' ? 'range mode — responds to rounds automatically' : '';
  if (chirpTimer) { clearInterval(chirpTimer); chirpTimer = null; }
  if (m === 'chirp' && running) armChirpTimer();
  if (m !== 'range') {
    stopRounds();
    range.initiator = false;
    rangeGoBtn.textContent = 'Initiate rounds';
  }
  logEv('param-change', { source: 'mode', mode: m, ...currentChirpParams() });
}

function armChirpTimer() {
  if (chirpTimer) clearInterval(chirpTimer);
  chirpTimer = setInterval(() => {
    if (!sweepRun) emitChirp();
  }, params.intervalMs);
}

modeChirpBtn.addEventListener('click', () => setMode('chirp'));
modeListenBtn.addEventListener('click', () => setMode('listen'));
modeRangeBtn.addEventListener('click', () => setMode('range'));

// Whoever presses this drives the rounds; every other range-mode device
// responds. Both sides journal, both sides compute the same distance.
rangeGoBtn.addEventListener('click', () => {
  range.initiator = !range.initiator;
  rangeGoBtn.textContent = range.initiator ? 'Stop rounds' : 'Initiate rounds';
  if (range.initiator) startRounds(); else stopRounds();
  logEv('range-rounds', { on: range.initiator });
});

$('rangeBias').addEventListener('input', () => {
  range.biasM = Number($('rangeBias').value) || 0;
  logEv('param-change', { source: 'range-bias', biasM: range.biasM });
});

startBtn.addEventListener('click', async () => {
  if (running) {
    running = false;
    stopAudio();
    stopRounds();
    range.initiator = false;
    rangeGoBtn.textContent = 'Initiate rounds';
    rangeGoBtn.disabled = true;
    startBtn.textContent = 'Start';
    sweepBtn.disabled = true;
    setStatus('stopped');
    logEv('session-stop', {});
    return;
  }
  startBtn.disabled = true;
  try {
    await startAudio();
    running = true;
    startBtn.textContent = 'Stop';
    sweepBtn.disabled = mode !== 'chirp';
    rangeGoBtn.disabled = mode !== 'range';
    if (mode === 'chirp') armChirpTimer();
    setStatus(`running · ${sampleRate} Hz`);
  } catch (err) {
    setStatus(`audio failed: ${err.message}`);
    logEv('session-error', { error: String(err && err.message) });
  }
  startBtn.disabled = false;
});

sweepBtn.addEventListener('click', () => {
  if (sweepRun) {
    sweepRun.abort = true;
  } else {
    runSweep();
  }
});

$('clearBtn').addEventListener('click', () => {
  detections.length = 0;
  bandStats.clear();
  corrTrace = null;
  detCount = 0;
  detCountEl.textContent = '0 detections';
  bigSnrEl.textContent = '—';
});

reflectParams();
setMode('listen');
setStatus('idle — press Start');
requestAnimationFrame(frame);
