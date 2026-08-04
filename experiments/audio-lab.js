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

let mode = 'listen';          // 'chirp' | 'listen' | 'range' | 'beacon'
let running = false;
let sweepRun = null;          // abort flag object while a sweep is running

// Beacon (a device with speakers but no usable mic — a TV): emits the up-chirp
// from the LEFT speaker and the down-chirp from the RIGHT, offset by an exact
// sample count inside one stereo buffer. Same DAC clock, so the emission
// offset is perfect by construction — a listener subtracts it from the arrival
// difference and gets d_right − d_left with no clock sync and no mic on the
// beacon at all. With the speaker baseline known, that difference is a bearing.
const beaconCfg = {
  offsetMs: 250,              // L→R stagger; must dwarf the template length or
                              // the listener's cross-suppression eats one side
  baselineM: 1.0,             // speaker separation, entered per beacon device
};

// Listener side of a beacon: the last announcement and the pending up arrival.
const beacon = {
  params: null,               // {offsetMs, baselineM} as announced
  at: 0,                      // performance.now() of the announcement
  lastUp: null,               // sample time of the not-yet-paired up arrival
  results: [],                // {t, ddM, deg}
};

function beaconFresh() {
  return beacon.params && performance.now() - beacon.at < 5000;
}

// Echo: the phone chirps and listens to its own room. An external ruler for
// walls.js, which today has no accuracy metric that is not a check of the grid
// against itself.
//
// Two things make it work, and both are geometry rather than signal processing.
//
// A monostatic echo has no heading — speaker and mic are centimetres apart, so
// image-source geometry returns a flat surface at 2*d_perp whichever way the
// phone points. A standpoint is a point and a height, never a pose.
//
// And a phone in PORTRAIT has its speakers vertically separated, which
// identifies the surface outright. Firing each channel alone:
//
//   floor    path = h_s + h_m        ->  delta = +d_sep
//   ceiling  path = 2H - h_s - h_m   ->  delta = -d_sep
//   wall     path = hypot(2d, dv)    ->  delta ~ 0
//
// The mic height cancels exactly in the first two, so delta is pure speaker
// geometry — a device constant, not a function of how the phone is held. And it
// is a delay test: the earpiece fires forward through a slit rather than
// upward, so an argument from which channel sounds louder would be fragile,
// while path length cannot care about directivity.
//
// Band is 8-16 kHz here and nowhere else on this page. The 16.5-21.5 kHz
// default is inaudible and tuned for device-to-device SNR, which is the wrong
// end for echoes off surfaces: at 21 kHz the wavelength is 1.6 cm, comparable
// to wall texture, so real walls scatter instead of reflecting. 8-16 kHz is
// audible and worth it — lambda 2-4 cm, negligible air absorption, and 8 kHz of
// bandwidth separating two arrivals 2.1 cm apart.
//
// This page only measures. Every metre of interpretation is in
// experiments/replay-echo.js, offline, against a grid from replay-walls.js.
const echoCfg = {
  tagId: 0,
  outM: 1.5,                  // standpoint offset from the tag, along its normal
  alongM: 0,                  // and across it
  heightM: 1.00,
  ceilM: 2.50,
  dSepM: 0.14,                // speaker separation; a ruler down the phone
  micOffM: -0.07,             // mic height relative to phone centre (bottom edge)
  tempC: 20,
  spkMicM: 0.10,              // chassis path; the direct arrival is not zero range
  maxRangeM: 6,
  // Three gates, because the first one alone turned out to select nothing.
  //
  // Measured on the 04/08 session: peaks sat 29-51 dB over the NOISE FLOOR, so
  // an 8 dB floor gate passed everything and the 24-peak cap saturated on all
  // 28 measurements. Their SNR was also flat with delay out to 35 ms, which is
  // the signature of a diffuse reverberant field rather than discrete echoes.
  // Against a uniform null the hit rate for any given distance was 63% where
  // chance was 61% — nothing was being detected at all.
  // These are deliberately PERMISSIVE. The page's job is to record what came
  // back; deciding which arrivals count is replay-echo.js's, because a gate
  // applied before the journal cannot be loosened without walking the room
  // again — and this project's rule is that tuning is measured by replay rather
  // than argued. Tightened here only to keep the entry under the 8192-byte
  // silent drop.
  echoThreshDb: 8,            // over the noise floor; a floor, not a selector
  echoRelDb: 45,              // and within this of the DIRECT arrival
  promDb: 3,                  // and this far above its own neighbourhood, which
                              // is what separates an arrival from a plateau
  blindMs: 2.5,               // direct-path ringing masks roughly this much
  variantMs: 500,             // sub-emission stagger; must exceed RT60 (~0.4 s)
  periodMs: 2500,
  mount: '',
};

// ---------------------------------------------------------------------------
// Standpoint from tags.
//
// The taped tag/out/along/height above is the original way to say where the
// phone is, and it is the worst part of running this rig: it is slow, it is
// wrong when someone fat-fingers a 7 for a 1 (measured — one session declared a
// point five metres outside the room and every wall prediction came back
// empty), and it cannot say which way the phone is FACING at all. Orientation
// is not a nicety here: the stereo floor/ceiling split is d_sep*(u.g), so a
// phone lying flat on a chair back has no split to read, which is exactly how
// one session returned a 146 m/s "sound speed" and a 2.1 m height error.
//
// The room already knows where things are. This asks it.
//
// Two identities, deliberately. The camera and its calibration belong to the
// CLIENT device record — same phone, same browser, and the calibration was
// earned by fifteen ChArUco captures under that id — while the socket keeps the
// `audio-lab` role, because this page must not appear in the roster, must not
// take the client's slot, and must not write its settings. So: read the client
// device for intrinsics, talk to the server as a lab.
//
// The server answers `locate` from the map as it stands and changes nothing.
// See survey.locate(): no bootstrap, no extend, no refine. A rig parked in a
// chair for three minutes staring at one tag would otherwise pour a thousand
// near-identical observations into the survey and refine that tag against them.
const standpointPose = (() => {
  let on = false;
  let device = null;
  let stream = null;
  let seq = 0;
  // Recent fixes, kept as a window rather than a filter: a stationary rig can
  // afford to be told what the scatter is, and a smoothed pose whose steadiness
  // proves nothing was the failure mode on the survey side too.
  const fixes = [];
  const WINDOW = 40;
  let last = null;
  let err = '';

  const el = () => document.getElementById('echoPose');
  const video = () => document.getElementById('poseVideo');

  // Median per axis. Not a mean: an unresolved mirror puts a solve metres away
  // rather than centimetres, and one of those drags an average out of the room
  // while the median ignores it. 12-27% of planar solves are mirrored, so this
  // is a certainty over a long standpoint, not a precaution.
  function medianPose() {
    if (!fixes.length) return null;
    const axis = (i) => {
      const v = fixes.map((f) => f.p[i]).sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    const p = [axis(0), axis(1), axis(2)];
    // Orientation comes from the fix nearest that median position rather than
    // from an average of quaternions: quatMean is not robust (a mirrored solve
    // is 180 degrees out and drags the mean to a pose that is neither), and the
    // nearest fix is a real measured attitude rather than a synthesised one.
    let best = null;
    for (const f of fixes) {
      const d = Math.hypot(f.p[0] - p[0], f.p[1] - p[1], f.p[2] - p[2]);
      if (!best || d < best.d) best = { d, f };
    }
    const spread = fixes.map((f) => Math.hypot(
      f.p[0] - p[0], f.p[1] - p[1], f.p[2] - p[2])).sort((a, b) => a - b);
    return {
      p,
      q: best.f.q,
      n: fixes.length,
      spreadMm: Math.round(spread[Math.floor(spread.length * 0.5)] * 1000),
      spread90Mm: Math.round(spread[Math.floor(spread.length * 0.9)] * 1000),
    };
  }

  // How far off level the speaker axis is — the number the stereo split lives
  // or dies on, and one that has never been measurable on this page before.
  // +y in camera coordinates runs down the phone's long axis, which is the line
  // the two speakers sit on, so the rotated y axis of the pose IS the speaker
  // axis in the room frame.
  //
  // MAGNITUDE ONLY, and that is not laziness. The room frame is the anchor
  // tag's own frame (survey.js: "room +y is whichever way that tag was
  // mounted"), so room y is the vertical axis — standpointOf relies on exactly
  // that when it demands horizontal tag normals — but whether +y is up or down
  // is not established anywhere. |u.g| is sign-free and is the whole of the
  // gate: near 1 the floor and ceiling separate by the full d_sep, near 0 they
  // collapse and the classifier is reading noise. Only WHICH of the two is the
  // floor needs the sign, and that is decided offline against the map rather
  // than guessed here.
  function absUdotG(q) {
    if (!q || typeof quatRotate !== 'function') return null;
    const u = quatRotate(q, [0, 1, 0]);
    return +Math.abs(u[1]).toFixed(4);
  }

  function render() {
    const e = el();
    if (!e) return;
    if (!on) { e.textContent = ''; e.className = ''; return; }
    if (err) { e.textContent = `locate: ${err}`; e.className = 'bad'; return; }
    const m = medianPose();
    if (!m) { e.textContent = 'locate: looking for a mapped tag…'; e.className = ''; return; }
    const g = absUdotG(m.q);
    e.textContent = `locate: (${m.p[0].toFixed(2)}, ${m.p[1].toFixed(2)}, `
      + `${m.p[2].toFixed(2)}) · n ${m.n} · spread ${m.spreadMm} mm (p90 ${m.spread90Mm})`
      + (g === null ? '' : ` · |u·g| ${g.toFixed(2)}${g < 0.3 ? ' — TOO LEVEL, no floor/ceiling split' : ''}`)
      + (last?.nTags ? ` · ${last.nTags} tag(s)` : '');
    // A rig that cannot separate floor from ceiling should say so on the page
    // rather than in the residual three days later.
    e.className = (g !== null && Math.abs(g) < 0.3) ? 'bad' : 'good';
  }

  return {
    get on() { return on; },
    // What the journal and the standpoint declaration carry. null when the
    // camera is off or nothing has been solved — the taped fields stay the
    // answer in that case, and the reader can tell which it got.
    current() {
      const m = medianPose();
      if (!m) return null;
      return {
        p: m.p.map((v) => +v.toFixed(4)),
        q: m.q.map((v) => +v.toFixed(5)),
        n: m.n,
        spreadMm: m.spreadMm,
        spread90Mm: m.spread90Mm,
        absUdotG: absUdotG(m.q),
        nTags: last?.nTags ?? null,
        errPx: last?.errPx != null ? +last.errPx.toFixed(2) : null,
      };
    },
    onLocated(msg) {
      if (!on) return;
      if (!msg.pose) {
        err = msg.reason || 'no fix';
        render();
        return;
      }
      err = '';
      last = msg;
      fixes.push(msg.pose);
      if (fixes.length > WINDOW) fixes.shift();
      render();
    },
    async setEnabled(want) {
      if (want === on) return;
      if (!want) {
        on = false;
        posePipeline.setEnabled(false);
        for (const t of stream?.getTracks() || []) t.stop();
        stream = null;
        video().srcObject = null;
        fixes.length = 0;
        last = null;
        err = '';
        render();
        logEv('locate-off', {});
        return;
      }
      try {
        // The client's identity, for its calibration. hello() only reads.
        device ??= await resolveDevice('client');
        await initIntrinsics(device);
        // The calibrated resolution, asked for by name. A camera model measured
        // at 1080x1920 rescales to another size only by assuming the crop did
        // not change, and a standpoint solved on a guessed model is a standpoint
        // with an unknown error in it — the one thing this was meant to remove.
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1080 },
            height: { ideal: 1920 },
          },
        });
        video().srcObject = stream;
        await video().play().catch(() => {});
        posePipeline.init({
          video: video(),
          signaling,
          clockSync,
          // The seam: the same observation the client sends as `pose`, sent as
          // `locate` so the server reads the map instead of writing it.
          publish: (m) => signaling.send({ ...m, type: 'locate', seq: ++seq }),
        });
        // Asked for, never assumed. pose.js defaults to 0.15 m and this room is
        // printed at 0.142; a 5% scale error in the marker size is a 5% error
        // in every distance the solve returns, which would be a larger mistake
        // than the tape measure this replaces. /api/pose-config is the same
        // number the printing page and the server's own map agree on.
        const cfg = await fetch('/api/pose-config').then((r) => r.json());
        if (!cfg?.markerSizeM) throw new Error('server did not report markerSizeM');
        posePipeline.setConfig({
          markerSizeM: cfg.markerSizeM,
          // A parked rig does not need ten fixes a second, and the matched
          // filter on this phone does need the core. Slow enough to stay out of
          // the audio's way, fast enough that a 40-deep window fills in under a
          // minute.
          poseRateMs: 500,
        });
        posePipeline.onCameraChanged('environment');
        await posePipeline.setEnabled(true);
        on = true;
        err = '';
        logEv('locate-on', {
          deviceId: device.id, poseRateMs: 500, markerSizeM: cfg.markerSizeM,
        });
      } catch (e) {
        err = e.message || String(e);
        on = false;
        for (const t of stream?.getTracks() || []) t.stop();
        stream = null;
      }
      render();
    },
  };
})();

// The band echo mode forces, saved/restored around the mode switch exactly the
// way runSweep() does — the other four modes must keep their measured defaults.
// 3-7 kHz, chosen from measurement rather than from the argument that first put
// it at 8-16 kHz. Two constraints squeeze from opposite sides and the first
// session sat outside both:
//
//   lambda must be big enough that a real wall reflects rather than scatters.
//     At 8-16 kHz lambda is 2-4 cm, comparable to wall texture, and the room
//     came back as dense reverberation: the peak cap saturated every time.
//   c/2B must resolve the 14 cm speaker separation, or the stereo split cannot
//     be seen even where it exists. At 2-3 kHz (B = 1 kHz) resolution is 17 cm
//     — wider than the thing being measured.
//
// B = 4 kHz gives 4.3 cm resolution with lambda 5-11 cm. Audible, and the
// operator will hear it; that is the trade this mode already accepted.
const ECHO_BAND = { f0: 3000, f1: 7000, durMs: 80 };

// Emission order is BOTH first, and that is load-bearing. Variants are
// attributed by arrival index, and `both` is the loudest of the three, so it is
// the one that can be relied on to anchor the triplet. Anchoring on the earpiece
// instead would relabel the whole triplet on any emission where the weak
// speaker went unheard.
const ECHO_VARIANTS = ['both', 'l', 'r'];

const echo = {
  sp: 0,                      // standpoint counter; every measurement carries it
  declared: false,
  seq: 0,
  emitPerf: 0,
  emitFrame: 0,
  bestDirect: 0,              // loudest direct arrival this standpoint, for the
                              // self-calibrating amplitude gate
  // Detections are processed one segment late, so the whole echo window is
  // always in hand — see echoScan.
  buf: null,
  bufHop: 0,
  bufAbs: 0,
  deferred: null,
  first: null,                // {abs, seq} anchoring the current triplet
  triplet: {},                // variant -> {peaks, directAbs, ...}
  results: [],                // {t, cls, pathM, delta}
  hist: [],                   // one-way metres, for the standpoint histogram
  traces: {},                 // variant -> {mag, peakAt} for the envelope chart
  tracesLogged: 0,
  cSolvedMps: null,           // diagnostic only — never enters a path length
  cSolvedFrom: null,
  topChannel: null,
  hEstM: null,
  warn: '',
};

// The one sound speed anything is measured with. Air is 331.3 + 0.606*T and
// nothing else — pressure cancels, humidity is worth 0.3% at worst — so the
// whole indoor range 18-26 C spans 1.4%, which is 10 mm on a 3 m path against
// a 60 mm grid cell and a 50 mm target residual. A declared temperature is
// already better than the thing being checked.
function echoC() {
  return 331.3 + 0.606 * echoCfg.tempC;
}

// The floor+ceiling and d_sep/dt solves used to feed this back into the ranging
// and could not: a misidentified second bounce returned 188 m/s on a real
// session, which is not a sound speed at all, and it rescaled every path by
// 0.55x. They are kept because they are a good self-check of the arrival
// identification — a solve far from the model means the floor or the ceiling
// was misread, not that the air changed. Diagnostic, never an input.
const C_SOLVE_TOL = 0.05;

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
    if (msg.type === 'located') { standpointPose.onLocated(msg); return; }
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
      return;
    }
    if (msg.type === 'beacon-params' && mode === 'listen') {
      beacon.params = { offsetMs: msg.offsetMs, baselineM: msg.baselineM };
      beacon.at = performance.now();
      const changed = msg.f0 !== params.f0 || msg.f1 !== params.f1 || msg.durMs !== params.durMs;
      if (changed) {
        params.f0 = msg.f0;
        params.f1 = msg.f1;
        params.durMs = msg.durMs;
        reflectParams();
        logEv('param-change', { source: 'beacon', ...currentChirpParams() });
      }
      followEl.textContent = `following beacon: ${fmtBand(msg.f0, msg.f1)},`
        + ` L/R offset ${msg.offsetMs} ms, baseline ${msg.baselineM} m`;
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
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  sampleRate = ctx.sampleRate;

  // A beacon device (a TV) has no usable mic — getUserMedia would throw or
  // hang there, and a pure emitter needs none of the capture path.
  if (mode === 'beacon') {
    logEv('session-start', {
      ua: navigator.userAgent,
      sampleRate,
      baseLatency: ctx.baseLatency ?? null,
      beacon: true,
      maxChannels: ctx.destination.maxChannelCount,
    });
    // A mono output route collapses L and R into one speaker and the arrival
    // difference degenerates to the offset — visible here before wondering why.
    constraintsEl.textContent = `beacon · sampleRate ${sampleRate}`
      + ` · output channels ${ctx.destination.maxChannelCount}`;
    constraintsEl.className = ctx.destination.maxChannelCount >= 2 ? 'good' : 'bad';
    return;
  }

  const requested = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };
  micStream = await navigator.mediaDevices.getUserMedia({ audio: requested });
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
  if (beaconTimer) { clearInterval(beaconTimer); beaconTimer = null; }
  if (echoTimer) { clearInterval(echoTimer); echoTimer = null; }
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

// One beacon emission: up-chirp on the left channel at sample 0, down-chirp
// on the right channel offsetMs later — one stereo buffer, one DAC clock, so
// the stagger between the two sounds is exact by construction. That stagger
// is the only "timestamp" the beacon ever provides, and it costs nothing.
function emitBeaconPair() {
  if (!ctx) return;
  const p = currentChirpParams();
  const up = buildChirp(sampleRate, p);
  const down = buildChirp(sampleRate, { ...p, f0: p.f1, f1: p.f0 });
  const off = Math.round((beaconCfg.offsetMs / 1000) * sampleRate);
  const buf = ctx.createBuffer(2, off + down.length, sampleRate);
  buf.getChannelData(0).set(up, 0);
  buf.getChannelData(1).set(down, off);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = Math.pow(10, params.gainDb / 20);
  src.connect(g).connect(ctx.destination);
  src.start();
  signaling.send({
    type: 'beacon-params', ...p,
    offsetMs: beaconCfg.offsetMs, baselineM: beaconCfg.baselineM,
  });
  logEv('beacon-emit', { ...p, offsetMs: beaconCfg.offsetMs, baselineM: beaconCfg.baselineM });
}

// One echo measurement: the same chirp three times in ONE stereo buffer —
// both speakers, then left alone, then right alone.
//
// One buffer rather than three timed emissions, and that is the whole reason
// the stereo comparison is trustworthy. The quantity being measured is a 14 cm
// path difference; hand or table drift between emissions 500 ms apart is
// centimetres, and it would land directly inside it. One buffer means one DAC
// clock and a stagger that is exact by construction — the same argument
// emitBeaconPair makes for its own L/R offset.
//
// variantMs must exceed RT60 (~0.4 s at these frequencies) or each variant's
// reverberation is still sounding when the next fires.
function emitEchoTriplet() {
  if (!ctx) return;
  const p = currentChirpParams();
  const data = buildChirp(sampleRate, p);
  const step = Math.round((echoCfg.variantMs / 1000) * sampleRate);
  const buf = ctx.createBuffer(2, step * (ECHO_VARIANTS.length - 1) + data.length, sampleRate);
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.getChannelData(1);
  ECHO_VARIANTS.forEach((v, i) => {
    if (v === 'both' || v === 'l') ch0.set(data, i * step);
    if (v === 'both' || v === 'r') ch1.set(data, i * step);
  });
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = Math.pow(10, params.gainDb / 20);
  src.connect(g).connect(ctx.destination);
  src.start();

  // Close the previous triplet before starting a new one. A variant that never
  // came back is the predicted failure mode of this whole design — the earpiece
  // is built for speech and may be 10-20 dB down at 8-16 kHz — so it is
  // counted rather than silently lost. `heard` naming the variants that landed
  // is what tells a weak speaker apart from a bad session.
  if (echo.seq) {
    const heard = ECHO_VARIANTS.filter((v) => echo.triplet[v]);
    if (heard.length < ECHO_VARIANTS.length) {
      logEv('echo-incomplete', {
        sp: echo.sp,
        seq: echo.seq,
        heard,
        missing: ECHO_VARIANTS.filter((v) => !echo.triplet[v]),
        snrDb: heard.map((v) => +echo.triplet[v].directSnrDb.toFixed(1)),
      });
    }
  }

  lastEmit = p;
  lastEmitPerf = performance.now();
  echo.emitPerf = lastEmitPerf;
  // Roughly which capture frame we were on when this went out. The worklet's
  // counter and ctx.currentTime both run from context start, so they agree to
  // well inside the one-second window this is used to police.
  echo.emitFrame = ctx.currentTime * sampleRate;
  emitSeq++;
  echo.seq = emitSeq;
  echo.first = null;
  echo.triplet = {};
  // Deliberately NOT broadcast as chirp-params: an echo session is on its own
  // band, and retuning another operator's listener onto 8-16 kHz would break
  // whatever they were measuring.
  logEv('echo-emit', {
    sp: echo.sp, seq: echo.seq, ...p, gainDb: params.gainDb,
    variantMs: echoCfg.variantMs, dSepM: echoCfg.dSepM, order: ECHO_VARIANTS,
  });
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
  // Both directions: the ranging exchange is up-answered-by-down, and a
  // beacon's two speakers carry up (left) and down (right) — a listener that
  // has heard a beacon announce itself needs both templates too.
  if (mode === 'range' || (mode === 'listen' && beaconFresh())) {
    const p = currentChirpParams();
    return [
      { label: 'up', p },
      { label: 'down', p: { ...p, f0: p.f1, f1: p.f0 } },
    ];
  }
  // Echo is monostatic, so like chirp mode the template must describe the chirp
  // already in the air — a slider drag must never re-template a triplet still
  // sounding, and a triplet spans 1.5 s.
  const p = ((mode === 'chirp' || mode === 'echo') && lastEmit) ? lastEmit : currentChirpParams();
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
  // Same reasoning for the echo buffer: hop moves with the template length, and
  // a deferred pick indexes into a segment that no longer means anything.
  resetEchoFilter();
}

function resetFilterState() {
  carry = null;
  pending = [];
  pendingLen = 0;
  pendingStartAbs = 0;
  templates = [];
  filterKey = '';
  lastEmit = null;
  resetEchoFilter();
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
    // Echo mode wants the whole envelope behind the direct arrival, not one
    // pick out of it. Everything above this line is shared with every other
    // mode — the forward FFT, the spectral multiply, the robust sigma floor,
    // the best/bestIdx scan. Everything below is the single-arrival policy,
    // which echo must not run. Branching here rather than earlier keeps the
    // segment bookkeeping fed even on segments with nothing in them.
    if (mode === 'echo') {
      echoScan(tm, segStartAbs, firstValid, hop, floor, best, bestIdx, snrDb);
      continue;
    }
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
  // The suppression below rejects any peak within `a.tm.len` of an accepted
  // one — 3840 samples at 80 ms and 48 kHz, which is 27 m of round trip. Every
  // echo in the room would be thrown away as "the same chirp". Bypassed here,
  // never modified: four journaled sessions have to replay bit-identically.
  if (mode === 'echo') return;

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
// Echo mode's detector.
//
// The single-arrival path above answers "when did the chirp arrive". This one
// answers "and what came back after it", which needs the whole correlation
// envelope and a different suppression radius: the mainlobe, ~12 samples,
// instead of the template length's 3840.

function resetEchoFilter() {
  echo.buf = null;
  echo.bufHop = 0;
  echo.deferred = null;
  echo.first = null;
}

function echoScan(tm, segStartAbs, firstValid, hop, floor, best, bestIdx, snrDb) {
  // Two segments of correlation magnitude, processed one segment late.
  //
  // Valid outputs run [0, hop) — about 261 ms — while the echo window is
  // 2*maxRange of sound, about 35 ms. A direct arrival landing near the end of
  // a segment has its tail in the next one, which is ~18% of emissions at 6 m.
  // Deferring by exactly one segment means the whole window is always in hand,
  // which removes that case rather than detecting and rejecting it.
  if (!echo.buf || echo.bufHop !== hop) {
    echo.buf = new Float64Array(hop * 2);
    echo.bufHop = hop;
    echo.deferred = null;
  }
  echo.buf.copyWithin(0, hop);
  for (let i = 0; i < hop; i++) echo.buf[hop + i] = corrMag[i];
  echo.bufAbs = segStartAbs - hop;

  // The previous segment's arrival now has its full tail behind it. Must run
  // after the shift above: the deferred pick was an index into what is now the
  // first half.
  if (echo.deferred) {
    const d = echo.deferred;
    echo.deferred = null;
    echoMeasure(d, hop);
  }

  if (snrDb < params.threshDb) return;

  // SNR over the noise floor is not enough to say a chirp arrived, and in echo
  // mode it is actively misleading. Triplets are seconds apart while segments
  // are 261 ms, so MOST segments contain no chirp at all; a near-silent one
  // drives the median sigma estimate onto its 1e-6 clamp and the ratio explodes
  // through any threshold. Measured on the 15:48 session: a segment with floor
  // -120 dB reported a 138 dB "direct arrival", and 72 of 91 recorded echoes
  // came back louder than the direct they were referenced to — which is
  // impossible, and meant every delay in those measurements was noise.
  //
  // Two gates, both absolute rather than relative.
  //
  // The arrival must land in the window our own emission could have produced.
  // We know when we played it, so a pick outside that is not our chirp.
  // bestIdx rather than the walked-back pick: the two differ by at most the
  // 5 ms walk-back, and pick is not computed until below.
  const sinceEmit = (segStartAbs + bestIdx) - echo.emitFrame;
  const tripletSpan = (echoCfg.variantMs / 1000) * sampleRate * ECHO_VARIANTS.length;
  if (echo.emitFrame && (sinceEmit < -0.1 * sampleRate
    || sinceEmit > tripletSpan + 1.0 * sampleRate)) {
    logEv('echo-reject', { sp: echo.sp, seq: echo.seq, reason: 'off-window' });
    return;
  }
  // And it must be comparable in absolute amplitude to the loudest direct
  // arrival this standpoint has produced. Self-calibrating, so it needs no
  // constant tuned to a particular phone's volume: real self-loop arrivals sat
  // at +19 to +25 dB on that session while the noise picks sat at -37.
  const amp = best;
  if (echo.bestDirect && amp < echo.bestDirect * Math.pow(10, -25 / 20)) {
    logEv('echo-reject', { sp: echo.sp, seq: echo.seq, reason: 'weak-direct' });
    return;
  }
  if (amp > echo.bestDirect) echo.bestDirect = amp;

  // Direct pick, the same way every other mode picks a first arrival — copied
  // rather than re-derived, because this is the zero of every echo delay and it
  // must not be a second opinion about what "first arrival" means.
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
  let frac = 0;
  if (pick > 0 && pick < hop - 1) {
    const a = corrMag[pick - 1]; const b = corrMag[pick]; const c = corrMag[pick + 1];
    const denom = a - 2 * b + c;
    if (denom < 0) frac = 0.5 * (a - c) / denom;
  }

  // Re-arm on the VARIANT stagger, not on intervalMs: the three sub-emissions
  // are 500 ms apart inside one triplet and each needs its own direct pick, so
  // the usual intervalMs/2 would swallow two of the three.
  const stepS = (echoCfg.variantMs / 1000) * sampleRate;
  const absIdx = segStartAbs + pick;
  if (absIdx - tm.lastDetAbs < stepS * 0.4) {
    logEv('echo-reject', { sp: echo.sp, seq: echo.seq, reason: 'rearm' });
    return;
  }
  tm.lastDetAbs = absIdx;

  echo.deferred = {
    pick, frac, snrDb, lobe, floor, absStart: segStartAbs,
    floorDb: 20 * Math.log10(floor),
  };
}

// Everything behind one direct arrival, and which sub-emission it belongs to.
function echoMeasure(d, hop) {
  // No standpoint is NOT a reason to throw a measurement away, and gating on it
  // cost a whole 120 s session: 47 triplets emitted, 143 direct arrivals found,
  // every one discarded because a button had not been pressed. The standpoint
  // is metadata the OFFLINE tool needs to place walls in a room. The stereo
  // floor/ceiling classification — the strongest thing this mode does — needs
  // nothing but d_sep, and the sound-speed solve needs only the ceiling. Both
  // are computable with no idea where the phone is standing.
  //
  // So everything is measured and journaled; `declared` marks whether the
  // geometry is trustworthy, and replay-echo.js decides what that permits.
  // Variants are attributed by ARRIVAL INDEX, not by template: all three
  // sub-emissions are the same chirp, so the matched filter cannot tell them
  // apart. Three different chirps would triple the correlator's inner loop and
  // buy nothing — reversed chirps only reject each other by ~26 dB (measured;
  // see the cross-template comment above), which is inside the dynamic range
  // echoes need.
  const stepS = (echoCfg.variantMs / 1000) * sampleRate;
  const absPick = d.absStart + d.pick + d.frac;
  let vi = 0;
  if (!echo.first) {
    echo.first = { abs: absPick };
  } else {
    const k = Math.round((absPick - echo.first.abs) / stepS);
    const err = Math.abs((absPick - echo.first.abs) - k * stepS);
    if (k < 0 || k >= ECHO_VARIANTS.length || err > stepS * 0.2) {
      logEv('echo-reject', { sp: echo.sp, seq: echo.seq, reason: 'variant-edge' });
      return;
    }
    vi = k;
  }
  const variant = ECHO_VARIANTS[vi];

  const c = echoC();
  const guard = Math.max(2 * d.lobe, Math.round((echoCfg.blindMs / 1000) * sampleRate));
  const span = Math.round(((2 * echoCfg.maxRangeM) / c) * sampleRate);
  const from = d.pick + guard;
  const to = Math.min(d.pick + span, hop * 2 - 2);
  const mag = echo.buf;
  // Absolute: over the noise floor. Relative: within reach of the direct
  // arrival, which is the only amplitude reference in the frame that means
  // anything — the noise floor says how quiet the room is, not how loud a
  // reflection should be.
  const thrAbs = d.floor * Math.pow(10, echoCfg.echoThreshDb / 20);
  const directAmp = d.floor * Math.pow(10, d.snrDb / 20);
  const thrRel = directAmp * Math.pow(10, -echoCfg.echoRelDb / 20);
  const thr = Math.max(thrAbs, thrRel);
  const promRatio = Math.pow(10, echoCfg.promDb / 20);
  const promHalf = d.lobe * 8;

  const gate = { raw: 0, amp: 0, prom: 0 };
  const peaks = [];
  for (let i = Math.max(1, from); i < to; i++) {
    const v = mag[i];
    let isMax = true;
    for (let j = Math.max(1, i - d.lobe); j <= Math.min(to, i + d.lobe); j++) {
      if (mag[j] > v) { isMax = false; break; }
    }
    if (!isMax) continue;
    gate.raw++;
    if (v < thr) continue;
    gate.amp++;

    // Prominence against the local neighbourhood. A specular arrival stands
    // above what surrounds it; reverberation is a plateau where every sample is
    // as loud as its neighbours, so the ratio collapses to 1 and the gate bites
    // exactly where the amplitude gates could not.
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(1, i - promHalf); j <= Math.min(to, i + promHalf); j += 4) {
      sum += mag[j];
      cnt++;
    }
    const local = cnt ? sum / cnt : d.floor;
    if (!(v > local * promRatio)) continue;
    gate.prom++;

    let frac = 0;
    const a = mag[i - 1]; const b = v; const cc = mag[i + 1];
    const den = a - 2 * b + cc;
    if (den < 0) frac = 0.5 * (a - cc) / den;
    peaks.push({
      dSamp: (i + frac) - (d.pick + d.frac),
      snrDb: 20 * Math.log10(v / d.floor),
      promDb: 20 * Math.log10(v / Math.max(local, 1e-12)),
    });
    // The whole policy substitution, in one line: two arrivals are two arrivals
    // once they are a mainlobe apart. The single-arrival path uses tm.len here.
    i += d.lobe;
  }
  // Cap by strength, then restore time order. The cap is a journal-size bound
  // (server.js drops any line over 8192 bytes, silently), not a physical claim
  // — so whether it BOUND is journaled, because a saturated cap silently turned
  // a whole session into 24 arbitrary samples of a reverb tail.
  peaks.sort((a, b) => b.snrDb - a.snrDb);
  // 48 at ~22 bytes each is ~1 kB, comfortably inside the 8192-byte line limit
  // and generous enough that the offline tool can re-select from it.
  const CAP = 48;
  const kept = peaks.slice(0, CAP).sort((a, b) => a.dSamp - b.dSamp);
  gate.capped = peaks.length > CAP;

  echo.triplet[variant] = { peaks: kept, directSnrDb: d.snrDb, floorDb: d.floorDb };
  echo.traces[variant] = snapshotEchoTrace(d, from, to);

  logEv('echo', {
    sp: echo.sp,
    seq: echo.seq,
    declared: echo.declared,
    sr: sampleRate,
    variant,
    directAbs: Math.round(d.absStart + d.pick),
    directFrac: +d.frac.toFixed(3),
    directSnrDb: +d.snrDb.toFixed(2),
    floorDb: +d.floorDb.toFixed(2),
    // Every gate's survivor count, so the next replay can see which one bound
    // instead of inferring it. `raw` saturating with `prom` near zero is a
    // reverberant room; `raw` near zero is a band too quiet to hear anything.
    gate,
    peaks: kept.map((p) => [+p.dSamp.toFixed(3), +p.snrDb.toFixed(1), +p.promDb.toFixed(1)]),
  });

  // The envelope itself, for the first few triplets of a standpoint, so a
  // session can be read afterwards without the phone in hand.
  //
  // All THREE variants, not just `both`: the left-against-right envelope is the
  // stereo argument, and a journal carrying only the summed one cannot be used
  // to check the classifier's working afterwards — only to take its word.
  if (echo.tracesLogged < 9) {
    echo.tracesLogged++;
    const t = echo.traces[variant];
    logEv('echo-trace', {
      sp: echo.sp, seq: echo.seq, variant, n: t.mag.length, span: to - from,
      lo: t.lo - d.pick, peakAt: +t.peakAt.toFixed(4),
      mag: Array.from(t.mag),
    });
  }

  detCount++;
  bigSnrEl.textContent = `${d.snrDb.toFixed(1)} dB`;
  detCountEl.textContent = `${detCount} detection${detCount === 1 ? '' : 's'}`;
  // Fed to the SNR timeline so the existing chart keeps working. Deliberately
  // not onDetection(): that path owns the self-heard verdict, the sweep sample
  // and the range/beacon hooks, none of which mean anything here.
  detections.push({
    t: performance.now(), label: `echo:${variant}`, snrDb: d.snrDb,
    floorDb: d.floorDb, self: true, seq: echo.seq, band: [params.f0, params.f1],
    abs: absPick,
  });
  if (detections.length > 2000) detections.splice(0, 1000);

  if (echo.triplet.l && echo.triplet.r) echoClassify();
}

// The envelope in dB over the noise floor, downsampled to a fixed width.
// snapshotCorrTrace is left alone: it is +-20 ms around the pick and
// peak-normalised, and both are wrong here — the span is far too short for a
// room and the normalisation destroys the dB-over-floor scale the peak test is
// expressed in.
const ECHO_TRACE_N = 384;

function snapshotEchoTrace(d, from, to) {
  const mag = echo.buf;
  const out = new Uint8Array(ECHO_TRACE_N);
  const lo = Math.max(0, d.pick - d.lobe * 2);
  const span = Math.max(1, to - lo);
  for (let k = 0; k < ECHO_TRACE_N; k++) {
    const i = lo + Math.floor((k / ECHO_TRACE_N) * span);
    const db = 20 * Math.log10(Math.max(mag[i], 1e-9) / d.floor);
    out[k] = Math.max(0, Math.min(255, Math.round(db * 4)));
  }
  return { mag: out, lo, span, peakAt: (d.pick - lo) / span };
}

// ---------------------------------------------------------------------------
// The stereo verdict, live.
//
// A compact version of what experiments/echo-geom.js does offline — that module
// is the authority and the page deliberately keeps no map, no segments and no
// prediction. This exists so the operator can see whether the session is worth
// analysing at all before walking away from it.

function echoPathM(dSamp, c) {
  return (c * dSamp) / sampleRate + echoCfg.spkMicM;
}

function echoPair(top, bottom, c) {
  const dSep = echoCfg.dSepM;
  const tol = dSep / 3;
  const cands = [];
  top.forEach((t, i) => bottom.forEach((b, j) => {
    const delta = echoPathM(t.dSamp, c) - echoPathM(b.dSamp, c);
    if (Math.abs(delta) <= dSep * 1.5) cands.push({ i, j, delta, ad: Math.abs(delta) });
  }));
  cands.sort((a, b) => a.ad - b.ad);
  const ut = new Set();
  const ub = new Set();
  const pairs = [];
  for (const k of cands) {
    if (ut.has(k.i) || ub.has(k.j)) continue;
    ut.add(k.i); ub.add(k.j);
    const cls = Math.abs(k.delta - dSep) < tol ? 'floor'
      : Math.abs(k.delta + dSep) < tol ? 'ceiling'
        : Math.abs(k.delta) < tol ? 'vertical' : 'ambiguous';
    pairs.push({
      cls,
      delta: k.delta,
      top: top[k.i],
      bottom: bottom[k.j],
      pathM: (echoPathM(top[k.i].dSamp, c) + echoPathM(bottom[k.j].dSamp, c)) / 2,
    });
  }
  return pairs;
}

// The floor and the ceiling are the SHORTEST arrivals of their class, and that
// is physics rather than a tie-break: a wall+floor bounce is hypot(2d, h_s+h_m)
// and can never be shorter than the h_s+h_m inside it. It has to be enforced,
// because second-order bounces do not sit at delta 0 — off a near wall their
// delta approaches -d_sep closely enough to be classified `ceiling` outright,
// and taking the first such pair put the solved sound speed 70 m/s low.
function echoShortest(pairs, cls) {
  return pairs.filter((p) => p.cls === cls)
    .reduce((best, p) => (!best || p.pathM < best.pathM ? p : best), null);
}

function echoClassify() {
  const L = echo.triplet.l;
  const R = echo.triplet.r;
  if (!L || !R) return;
  const cUsed = echoC();

  // Which channel drives the top speaker is a device and rotation property and
  // no API reports it. The sign test IS the calibration: only the correct
  // mapping can produce a floor at +d_sep AND a ceiling at -d_sep.
  const tryMap = (topCh) => {
    const top = topCh === 'l' ? L.peaks : R.peaks;
    const bot = topCh === 'l' ? R.peaks : L.peaks;
    const pairs = echoPair(top, bot, cUsed);
    const score = pairs.filter((p) => p.cls === 'floor' || p.cls === 'ceiling').length;
    return { topCh, pairs, score };
  };
  const opts = echo.topChannel ? [tryMap(echo.topChannel)] : [tryMap('l'), tryMap('r')];
  const bestMap = opts.reduce((a, b) => (b.score > a.score ? b : a));
  if (bestMap.score > 0) echo.topChannel = bestMap.topCh;

  const pairs = bestMap.pairs;
  const fl = echoShortest(pairs, 'floor');
  const ce = echoShortest(pairs, 'ceiling');

  // Two independent checks on the arrival identification, in order of how much
  // they need to be told. Neither is used to range anything — see echoC().
  let c = null;
  let from = null;
  if (fl && ce && echoCfg.ceilM > 0) {
    // floorPath + ceilPath = 2H exactly, for any one speaker — both the phone
    // height and the speaker offset cancel outright. Same channel for both, or
    // the cancellation is not exact.
    const sum = fl.bottom.dSamp + ce.bottom.dSamp;
    if (sum > 0) {
      c = ((2 * echoCfg.ceilM - 2 * echoCfg.spkMicM) * sampleRate) / sum;
      from = 'ceiling';
    }
  }
  if (!c && fl && fl.top.dSamp > fl.bottom.dSamp) {
    // d_sep/dt on the floor echo. Needs nothing about the room at all, so it
    // survives a session with no usable ceiling return.
    c = (echoCfg.dSepM * sampleRate) / (fl.top.dSamp - fl.bottom.dSamp);
    from = 'split';
  }
  echo.cSolvedMps = c;
  echo.cSolvedFrom = from;
  echo.hEstM = fl ? fl.bottom.pathM / 2 : null;

  echo.results = pairs;
  for (const p of pairs) if (p.cls === 'vertical') echo.hist.push(p.pathM / 2);
  if (echo.hist.length > 4000) echo.hist.splice(0, 2000);

  // Every delta near zero means the device is mono, or the OS summed the
  // channels to one speaker. A legitimate thing to find out, and it has to be
  // said out loud — silently it looks like a room made entirely of walls.
  // Needs enough pairs to be a claim about the device rather than about one
  // quiet triplet — with none at all the max below is 0 and every session would
  // open by announcing a mono phone.
  const spread = pairs.length ? Math.max(...pairs.map((p) => Math.abs(p.delta))) : null;
  echo.warn = (spread !== null && pairs.length >= 3 && spread < echoCfg.dSepM / 3)
    ? 'every delta is ~0 — mono speaker, or the OS summed both channels. '
      + 'The stereo discriminator does not exist on this device.'
    : '';

  // cMps is what every path in this verdict was measured with; cSolved* is the
  // check on it. Both are journaled because a replay has to be able to tell a
  // bad identification from a bad room without re-deriving either.
  const cOff = c ? Math.abs(c - cUsed) / cUsed : null;
  logEv('echo-verdict', {
    sp: echo.sp,
    seq: echo.seq,
    // Per triplet, not per standpoint: the whole reason the camera stays on for
    // the run is that a bump is otherwise invisible, and a pose that only
    // existed at "Set standpoint" could not show one. |u.g| rides with it
    // because the floor/ceiling split this verdict just made is only readable
    // when the speaker axis is not level — and that is the number that says so.
    pose: standpointPose.current(),
    topChannel: echo.topChannel,
    cMps: +cUsed.toFixed(2),
    cFrom: 'model',
    cSolvedMps: c ? +c.toFixed(2) : null,
    cSolvedFrom: from,
    hEstM: echo.hEstM != null ? +echo.hEstM.toFixed(3) : null,
    classes: pairs.map((p) => [p.cls, +p.pathM.toFixed(3), +p.delta.toFixed(4)]),
  });

  echoCEl.textContent = `c = ${cUsed.toFixed(1)} m/s (model, ${echoCfg.tempC} °C)`
    + (c ? ` · ${from} solve ${c.toFixed(0)}`
      + (cOff > C_SOLVE_TOL ? ` — ${(cOff * 100).toFixed(0)}% off, arrival ID suspect` : ' ✓') : '')
    + (echo.hEstM != null ? ` · h check ${echo.hEstM.toFixed(2)} m` : '')
    + (echo.topChannel ? ` · top = ${echo.topChannel.toUpperCase()}` : '');
  const named = pairs.filter((p) => p.cls !== 'ambiguous')
    .map((p) => `${p.cls[0]}${(p.pathM / 2).toFixed(2)}`).join(' ');
  echoPeaksEl.textContent = `${pairs.length} paired: ${named || '—'}`;
  echoWarnEl.textContent = echo.warn;
  echoWarnEl.className = echo.warn ? 'bad' : '';
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
  if (mode === 'listen' && beaconFresh()) beaconOnDetection(label, absIdx + frac);
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
// Beacon TDOA on the listener. The up (left speaker) and down (right speaker)
// arrivals, minus the beacon's exact emission offset, give
// d_right − d_left on this device's own sample clock — no clock sync, and the
// beacon never needed a mic. With the baseline B known, the far-field bearing
// is asin((d_left − d_right)/B), positive toward the beacon's right speaker
// as it faces the room. Front/back of the baseline is inherently ambiguous.
function beaconOnDetection(label, absT) {
  if (label === 'up') {
    beacon.lastUp = absT;
    return;
  }
  if (label !== 'down' || beacon.lastUp == null) return;
  const gapS = (absT - beacon.lastUp) / sampleRate - beacon.params.offsetMs / 1000;
  beacon.lastUp = null;
  // The residual gap is the acoustic path difference: bounded by the baseline
  // (~metres → ms). A pairing across different emissions is off by whole
  // offsets and cannot land in this window.
  if (Math.abs(gapS) > 0.03) {
    logEv('tdoa-reject', { gapMs: +(gapS * 1000).toFixed(3) });
    return;
  }
  const ddM = gapS * SOUND_MPS;                  // d_right − d_left
  const sin = Math.max(-1, Math.min(1, -ddM / beacon.params.baselineM));
  const deg = (Math.asin(sin) * 180) / Math.PI;
  beacon.results.push({ t: performance.now(), ddM, deg });
  if (beacon.results.length > 400) beacon.results.splice(0, 200);
  distEl.textContent = `${(ddM * 100).toFixed(0)} cm Δ`;
  distMedEl.textContent = `bearing ${deg.toFixed(0)}°`;
  logEv('tdoa', {
    ddM: +ddM.toFixed(4),
    bearingDeg: +deg.toFixed(2),
    baselineM: beacon.params.baselineM,
  });
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

// Echo overlays three series where the page only had two hues. The third is the
// green already validated for colour-vision deficiency against this same
// #1c1c1c surface in the tag-history charts, reused rather than picked afresh.
const ECHO_COL = [COL.heard, COL.self, '#3aa471'];

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

// --- beacon bearing: where the listener sits relative to the beacon's
// speaker axis, over the last two minutes.
function drawTdoaChart() {
  const [c, w, h] = setupCanvas(tdoaCv);
  const now = performance.now();
  const SPAN = 120000;
  const yOf = (deg) => h / 2 - (deg / 90) * (h / 2 - 12);
  c.strokeStyle = COL.grid;
  for (const deg of [-45, 45]) {
    c.beginPath(); c.moveTo(0, yOf(deg)); c.lineTo(w, yOf(deg)); c.stroke();
  }
  c.strokeStyle = COL.axis;
  c.beginPath(); c.moveTo(0, yOf(0)); c.lineTo(w, yOf(0)); c.stroke();
  c.fillStyle = COL.muted;
  c.font = '11px system-ui, sans-serif';
  c.fillText('right +45°', 4, yOf(45) - 3);
  c.fillText('left −45°', 4, yOf(-45) - 3);
  const pts = beacon.results.filter((r) => now - r.t <= SPAN);
  if (!pts.length) {
    label(c, 'beacon bearing · needs a device in Beacon mode', 6, 12);
    return;
  }
  c.fillStyle = COL.heard;
  for (const p of pts) {
    const x = w - ((now - p.t) / SPAN) * w;
    c.beginPath(); c.arc(x, yOf(p.deg), 3, 0, 2 * Math.PI); c.fill();
  }
  label(c, 'bearing to beacon · 0° = on the speakers’ mid-line', 6, 12);
}

// --- echo envelope: all three variants overlaid, x in metres of ONE-WAY
// distance. The whole stereo argument is visible here or nowhere — a floor peak
// splitting one way while a ceiling peak splits the other is the most
// convincing thing this page can draw.
function drawEchoTrace() {
  const [c, w, h] = setupCanvas(echoCv);
  gridLines(c, w, h, 4);
  const any = ECHO_VARIANTS.some((v) => echo.traces[v]);
  if (!any) {
    label(c, mode === 'echo' ? 'echo mode — waiting for the first triplet'
      : 'echo envelope (echo mode)', 6, 14);
    return;
  }
  const cNow = echoC();
  const maxM = echoCfg.maxRangeM;
  const xOf = (m) => (m / maxM) * w;

  // Blind zone: direct-path ringing and speaker decay mask the first few ms.
  c.fillStyle = COL.grid;
  c.fillRect(0, 0, xOf((cNow * (echoCfg.blindMs / 1000)) / 2), h);

  for (let m = 1; m < maxM; m++) {
    c.strokeStyle = COL.axis;
    c.beginPath(); c.moveTo(xOf(m), 0); c.lineTo(xOf(m), h); c.stroke();
    label(c, `${m}m`, xOf(m) + 3, h - 4);
  }

  ECHO_VARIANTS.forEach((v, i) => {
    const t = echo.traces[v];
    if (!t) return;
    c.strokeStyle = ECHO_COL[i];
    c.lineWidth = 1;
    c.beginPath();
    for (let k = 0; k < t.mag.length; k++) {
      // The trace starts a little before the direct pick; map bin -> delay ->
      // one-way metres so all three variants share one axis.
      const dSamp = (k / t.mag.length) * t.span - (t.peakAt * t.span);
      const m = ((cNow * dSamp) / sampleRate + echoCfg.spkMicM) / 2;
      const y = h - Math.min(h, (t.mag[k] / 4 / 45) * h);
      const x = xOf(m);
      if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  });

  for (const p of echo.results) {
    if (p.cls === 'ambiguous') continue;
    const x = xOf(p.pathM / 2);
    c.fillStyle = p.cls === 'floor' ? COL.self : p.cls === 'ceiling' ? ECHO_COL[2] : COL.heard;
    c.beginPath(); c.arc(x, 12, 3.5, 0, 2 * Math.PI); c.fill();
    label(c, `${p.cls[0]}${(p.pathM / 2).toFixed(2)}`, x + 5, 15);
  }
  legendDot(c, 6, h - 18, ECHO_COL[0], 'both');
  legendDot(c, 56, h - 18, ECHO_COL[1], 'left');
  legendDot(c, 102, h - 18, ECHO_COL[2], 'right');
}

// --- histogram of vertical-surface distances over the whole standpoint. This
// is the page's own verdict on the session: resting still, a real room's comb
// is stable, and a comb that wanders means the phone moved, a hand is in the
// way, or the band is wrong. Without it the operator has no way to know a
// session is worth analysing until it is already over.
function drawEchoHist() {
  const [c, w, h] = setupCanvas(echoHistCv);
  gridLines(c, w, h, 4);
  if (!echo.hist.length) {
    label(c, 'echo distances, this standpoint', 6, 14);
    return;
  }
  const maxM = echoCfg.maxRangeM;
  const binM = 0.02;
  const n = Math.ceil(maxM / binM);
  const bins = new Float64Array(n);
  for (const m of echo.hist) {
    if (m >= 0 && m < maxM) bins[Math.floor(m / binM)]++;
  }
  const peak = Math.max(...bins, 1);
  c.fillStyle = COL.heard;
  for (let i = 0; i < n; i++) {
    if (!bins[i]) continue;
    const x = (i / n) * w;
    const bh = (bins[i] / peak) * (h - 20);
    c.fillRect(x, h - bh, Math.max(1, w / n - 0.5), bh);
  }
  for (let m = 1; m < maxM; m++) {
    c.strokeStyle = COL.axis;
    c.beginPath(); c.moveTo((m / maxM) * w, 0); c.lineTo((m / maxM) * w, h); c.stroke();
    label(c, `${m}m`, (m / maxM) * w + 3, h - 4);
  }
  label(c, `${echo.hist.length} vertical arrival(s), 2 cm bins`, 6, 12);
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
  drawTdoaChart();
  drawEchoTrace();
  drawEchoHist();
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
const modeBeaconBtn = $('modeBeacon');
const rangeGoBtn = $('rangeGoBtn');
const rangeCv = $('rangeCv');
const tdoaCv = $('tdoaCv');
const distEl = $('dist');
const distMedEl = $('distMed');
const modeEchoBtn = $('modeEcho');
const echoCv = $('echoCv');
const echoHistCv = $('echoHistCv');
const echoCEl = $('echoC');
const echoPeaksEl = $('echoPeaks');
const echoWarnEl = $('echoWarn');
const echoSpEl = $('echoSp');
const echoSetBtn = $('echoSetBtn');

function fmtBand(f0, f1) {
  return `${(f0 / 1000).toFixed(1)}–${(f1 / 1000).toFixed(1)} kHz`;
}

// Every echo field is a plain number box bound straight to echoCfg — the whole
// standpoint declaration, which is the only thing the operator has to get right
// for the offline tool to be able to say anything.
const ECHO_FIELDS = [
  ['tagId', 'echoTag'], ['outM', 'echoOut'], ['alongM', 'echoAlong'],
  ['heightM', 'echoHeight'], ['ceilM', 'echoCeil'], ['dSepM', 'echoDSep'],
  ['micOffM', 'echoMicOff'], ['tempC', 'echoTemp'], ['spkMicM', 'echoSpkMic'],
  ['maxRangeM', 'echoMaxRange'], ['echoThreshDb', 'echoThresh'],
  ['echoRelDb', 'echoRel'], ['promDb', 'echoProm'], ['mount', 'echoMount'],
];

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
  $('beaconBase').value = beaconCfg.baselineM;
  $('beaconOff').value = beaconCfg.offsetMs;
  for (const [key, id] of ECHO_FIELDS) $(id).value = echoCfg[key];
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

// Echo forces its own band and gives the previous one back on the way out —
// the same save/restore runSweep() does, and for the same reason: the
// 16.5-21.5 kHz defaults are measured numbers the other four modes rely on, and
// a mode switch must not quietly rewrite them.
let echoSavedBand = null;

function enterEchoBand() {
  if (echoSavedBand) return;
  echoSavedBand = { f0: params.f0, f1: params.f1, durMs: params.durMs };
  Object.assign(params, ECHO_BAND);
  reflectParams();
  logEv('param-change', { source: 'mode-echo', ...currentChirpParams() });
  // Provisional, so nothing measured from here on can be lost for want of a
  // button press. "Set standpoint" replaces it with a declared one.
  declareStandpoint(false);
}

function leaveEchoBand() {
  if (!echoSavedBand) return;
  Object.assign(params, echoSavedBand);
  echoSavedBand = null;
  reflectParams();
  logEv('param-change', { source: 'mode-echo-restore', ...currentChirpParams() });
}

function setMode(m) {
  // A session started in beacon mode never opened the mic; every other mode
  // is built on the capture path, so the switch needs a fresh Start.
  if (running && !micStream && m !== 'beacon') {
    running = false;
    stopAudio();
    stopRounds();
    startBtn.textContent = 'Start';
    setStatus('mic needed for this mode — press Start again');
  }
  if (m === 'echo') enterEchoBand(); else leaveEchoBand();
  mode = m;
  modeChirpBtn.classList.toggle('active', m === 'chirp');
  modeListenBtn.classList.toggle('active', m === 'listen');
  modeRangeBtn.classList.toggle('active', m === 'range');
  modeBeaconBtn.classList.toggle('active', m === 'beacon');
  modeEchoBtn.classList.toggle('active', m === 'echo');
  sweepBtn.disabled = m !== 'chirp' || !running;
  rangeGoBtn.disabled = m !== 'range' || !running;
  followEl.textContent = m === 'listen' ? 'listen mode — follows the chirper’s parameters'
    : m === 'range' ? 'range mode — responds to rounds automatically'
      : m === 'beacon' ? 'beacon mode — emits L/R chirp pairs, no mic'
        : m === 'echo' ? 'echo mode — 8–16 kHz (audible), phone PORTRAIT and resting still' : '';
  if (chirpTimer) { clearInterval(chirpTimer); chirpTimer = null; }
  if (beaconTimer) { clearInterval(beaconTimer); beaconTimer = null; }
  if (echoTimer) { clearInterval(echoTimer); echoTimer = null; }
  if (m === 'chirp' && running) armChirpTimer();
  if (m === 'beacon' && running) armBeaconTimer();
  if (m === 'echo' && running) armEchoTimer();
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

let echoTimer = null;

function armEchoTimer() {
  if (echoTimer) clearInterval(echoTimer);
  // A triplet spans variantMs*2 + durMs; the period keeps whole triplets apart
  // AND leaves the last variant's reverberation time to die, or the next
  // triplet's `both` lands on top of the previous one's tail.
  const span = echoCfg.variantMs * (ECHO_VARIANTS.length - 1) + params.durMs;
  const period = Math.max(echoCfg.periodMs, span + 800);
  echoTimer = setInterval(emitEchoTriplet, period);
  emitEchoTriplet();
}

let beaconTimer = null;

function armBeaconTimer() {
  if (beaconTimer) clearInterval(beaconTimer);
  // The pair spans offsetMs + durMs; the period keeps whole pairs apart so a
  // listener can never pair one emission's up with the next one's down.
  const period = Math.max(1000, params.intervalMs, beaconCfg.offsetMs * 3);
  beaconTimer = setInterval(emitBeaconPair, period);
}

modeChirpBtn.addEventListener('click', () => setMode('chirp'));
modeListenBtn.addEventListener('click', () => setMode('listen'));
modeRangeBtn.addEventListener('click', () => setMode('range'));
modeBeaconBtn.addEventListener('click', () => setMode('beacon'));
modeEchoBtn.addEventListener('click', () => setMode('echo'));

// The height tripwire, checked live as the field is dragged rather than
// discovered after a session.
//
// When |2h - 2(H-h)| is small the floor and ceiling echoes overlap and neither
// can be identified — which takes the primary sound-speed solve with it. With a
// 2.5 m ceiling that bans h ~ 1.25 m, which is exactly where a person naturally
// holds a phone, so without saying so the calibration fails mysteriously on the
// first session and looks like a hardware problem.
function echoHeightWarning() {
  const gap = Math.abs(2 * echoCfg.heightM - 2 * (echoCfg.ceilM - echoCfg.heightM));
  if (gap < 0.4) {
    return `floor and ceiling echoes are ${(gap * 100).toFixed(0)} cm apart — `
      + 'too close to tell apart. Raise or lower the phone by 30 cm.';
  }
  return '';
}

for (const [key, id] of ECHO_FIELDS) {
  $(id).addEventListener('input', () => {
    const raw = $(id).value;
    echoCfg[key] = key === 'mount' ? raw : Number(raw);
    if (key === 'heightM' || key === 'ceilM') {
      const warn = echoHeightWarning();
      echoWarnEl.textContent = warn || echo.warn;
      echoWarnEl.className = (warn || echo.warn) ? 'bad' : '';
    }
  });
}

// A standpoint, declared or merely assumed.
//
// Entering echo mode declares a provisional one immediately so a journal is
// always self-describing — a session where the button was never pressed is
// still a complete record of what the room sounded like, and the stereo verdict
// in it is just as good. `declared` says only whether the room geometry in it
// was measured by a person or left at its defaults.
function declareStandpoint(declared) {
  echo.sp++;
  echo.declared = declared;
  // A standpoint resets everything that described the previous one. The
  // histogram especially: it is the operator's evidence that the phone is
  // holding still, and carrying it across a move would hide exactly the thing
  // it exists to show.
  echo.hist = [];
  echo.results = [];
  echo.traces = {};
  echo.tracesLogged = 0;
  echo.cSolvedMps = null;
  echo.cSolvedFrom = null;
  echo.topChannel = null;
  echo.first = null;
  echo.triplet = {};
  // The amplitude reference is a property of where the phone is standing, not
  // of the session — a new spot may be quieter, and carrying the old maximum
  // over would gate out every real arrival at it.
  echo.bestDirect = 0;
  const warn = echoHeightWarning();
  echoWarnEl.textContent = warn;
  echoWarnEl.className = warn ? 'bad' : '';
  // Re-emitted with every standpoint so a journal is self-describing — an
  // offline reader must never need a second file to know where the phone was.
  //
  // `solved` is the room-frame answer when the camera is on, and it is a
  // SEPARATE field from the taped tag/out/along rather than a replacement for
  // them: a reader must be able to see which one it got, and a session where
  // the two disagree is the only way the tape and the map ever get compared.
  const solved = standpointPose.current();
  logEv('echo-standpoint', {
    sp: echo.sp,
    declared,
    ...echoCfg,
    solved,
    topChannel: echo.topChannel,
    ...currentChirpParams(),
  });
  echoSpEl.textContent = declared
    ? `standpoint ${echo.sp} SET · tag ${echoCfg.tagId}, ${echoCfg.outM} m out, `
      + `${echoCfg.alongM} m along, h ${echoCfg.heightM} m`
    : `standpoint ${echo.sp} assumed (defaults) — measuring anyway. Floor/ceiling and `
      + 'sound speed need no standpoint; only wall geometry does.';
  echoSpEl.className = declared ? 'good' : '';
  if (declared) {
    setStatus(`standpoint ${echo.sp}: tag ${echoCfg.tagId}, `
      + `${echoCfg.outM} m out, ${echoCfg.alongM} m along, h ${echoCfg.heightM} m`);
  }
}

echoSetBtn.addEventListener('click', () => declareStandpoint(true));

$('echoPoseOn').addEventListener('change', async (ev) => {
  await standpointPose.setEnabled(ev.target.checked);
  // The switch reflects what actually happened, not what was asked: a camera
  // the UA refuses leaves the box ticked and the operator believing the
  // standpoint is solved when it is still the taped one.
  ev.target.checked = standpointPose.on;
});

$('beaconBase').addEventListener('input', () => {
  beaconCfg.baselineM = Number($('beaconBase').value) || 1;
  logEv('param-change', { source: 'beacon-baseline', baselineM: beaconCfg.baselineM });
});
$('beaconOff').addEventListener('input', () => {
  beaconCfg.offsetMs = Math.max(150, Number($('beaconOff').value) || 250);
  logEv('param-change', { source: 'beacon-offset', offsetMs: beaconCfg.offsetMs });
});

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
    if (mode === 'beacon') armBeaconTimer();
    if (mode === 'echo') armEchoTimer();
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
  echo.hist = [];
  echo.results = [];
  echo.traces = {};
});

reflectParams();
setMode('listen');
setStatus('idle — press Start');
requestAnimationFrame(frame);
