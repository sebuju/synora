'use strict';

// Shared between client and viewer pages: signaling connection + WebRTC config.

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// RTP header extension carrying each frame's capture instant on the sender's
// clock — the basis for aligning feeds from several clients.
const ABS_CAPTURE_TIME_URI = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';

// A client that switches apps gets its page frozen, and the OS tears the
// connection down underneath it — the socket stays nominally OPEN and no close
// event ever arrives, so nothing triggers a reconnect. A ping/pong probe is the
// only reliable liveness signal; an unanswered one means the socket is dead.
const PROBE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 8000;
const RECONNECT_DELAY_MS = 2000;

// A client id that survives reloads, so the server can hand a device the client
// number it had before instead of burning a fresh one on every refresh.
function loadDeviceId(role) {
  const key = `streamer-device-id:${role}`;
  // Devices that predate the phone→client rename keep their identity: read
  // the uuid from the old role's key once and copy it under the new one.
  const legacy = `streamer-client-id:${role.replace(/^client/, 'phone')}`;
  let id = null;
  try {
    id = localStorage.getItem(key) || localStorage.getItem(legacy);
    if (!id) id = crypto.randomUUID();
    localStorage.setItem(key, id);
  } catch {
    // Storage unavailable (private mode, blocked cookies): a per-load id still
    // works, it just does not survive a refresh.
    id ||= crypto.randomUUID();
  }
  return id;
}

// Opens the signaling WebSocket, announces our role, auto-reconnects.
// handlers: { onMessage(msg), onOpen(), onClose(), onPong(msg) } — optional.
// deviceId can be passed so a page's secondary socket (bulk uploads) presents
// the same identity as its primary one.
// Returns { send(obj), sendBinary(blob), close() }.
function connectSignaling(role, handlers = {}, deviceId = loadDeviceId(role)) {
  let ws = null;
  let closedByUs = false;
  let reconnectTimer = null;
  let rxCount = 0;   // any inbound traffic counts as proof of life

  function scheduleReconnect(delay = RECONNECT_DELAY_MS) {
    if (closedByUs || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function open() {
    if (closedByUs) return;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    const sock = new WebSocket(`wss://${location.host}`);
    ws = sock;
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: 'role', role, deviceId }));
      handlers.onOpen?.();
    };
    sock.onmessage = (ev) => {
      rxCount++;
      if (typeof ev.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        // Pongs are liveness plumbing, but they piggyback server state some
        // pages care about — hand them to a separate hook.
        handlers.onPong?.(msg);
        return;
      }
      handlers.onMessage?.(msg);
    };
    sock.onclose = () => {
      // A superseded socket closing says nothing about the current one.
      if (sock !== ws) return;
      handlers.onClose?.();
      scheduleReconnect();
    };
    sock.onerror = () => sock.close();
  }

  // Confirm the socket is really alive, and reopen it if it is not.
  function probe() {
    if (closedByUs) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      scheduleReconnect(0);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const sock = ws;
    const seq = rxCount;
    sock.send(JSON.stringify({ type: 'ping' }));
    setTimeout(() => {
      // Nothing came back: close so onclose drives the reconnect.
      if (sock === ws && sock.readyState === WebSocket.OPEN && rxCount === seq) sock.close();
    }, PROBE_TIMEOUT_MS);
  }

  open();
  setInterval(probe, PROBE_INTERVAL_MS);
  // Timers are throttled or suspended while hidden, so returning to the
  // foreground is the first chance to notice a connection died — check now
  // instead of waiting out the interval.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') probe();
  });

  return {
    send(obj) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    sendBinary(blob) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(blob);
    },
    // Unsent bytes sitting in the socket. Senders of bulky, droppable data
    // must check this — everything shares one socket, and small
    // time-critical messages queue behind whatever was sent before them.
    get bufferedAmount() {
      return ws?.readyState === WebSocket.OPEN ? ws.bufferedAmount : 0;
    },
    close() {
      closedByUs = true;
      ws?.close();
    },
  };
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

// Age of an instant in one-character units, one decimal: 3.2s, 1.5m, 2.0h,
// 1.1d. Every panel that shows how stale something is uses this one, so a
// figure means the same thing wherever it is read.
function fmtAge(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

// Screen blanking. A capture device runs for hours with a wake lock holding the
// display on, and the display is the largest single draw on the phone — nothing
// else a page can switch off comes close. Blanking costs nothing: the camera,
// the recorder, the peer connection and tag detection all keep running, only
// the picture stops being drawn.
//
// `root` is what the black div is mounted on, and that is the whole difference
// between the two callers: on an ordinary page it is the body, but inside an
// immersive-AR session the UA only composites the DOM overlay root's subtree
// over the camera passthrough, so /xr-client has to mount it there or the black
// never reaches the screen.
function createBlankScreen(root, onChange) {
  const el = document.createElement('div');
  el.className = 'blank-screen';
  const hint = document.createElement('span');
  hint.textContent = 'tap to wake';
  el.append(hint);
  // The tap must not reach what is underneath: on /client the feed toggles
  // pause on click, so waking the screen would also unpause it.
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    set(false);
  });
  root.append(el);

  let on = false;
  function set(next) {
    if (next === on) return;
    on = next;
    el.classList.toggle('on', on);
    // Restart the hint's fade so it is readable again on the next blank.
    if (on) {
      hint.style.animation = 'none';
      void hint.offsetWidth;
      hint.style.animation = '';
    }
    onChange?.(on);
  }

  return {
    set,
    toggle() {
      set(!on);
    },
    get on() {
      return on;
    },
  };
}

// How a pose message's camera model should be described and how loudly. Both
// the client overlay and the dashboard tile report this, from the same wire
// fields, so the wording cannot drift between them.
//
// Level maps to the shared .warn/.bad classes: a model that was rotated or
// rescaled from another resolution is not wrong so much as unverified at the
// resolution in use, and those tiers are exactly where an orientation change
// used to move the map — so they are worth seeing rather than being folded into
// the same "calibrated" as an exact fit. `source` is absent on messages from
// before it existed; fall back to the boolean.
function describeCameraModel(msg) {
  if (msg.source === 'guess') {
    return {
      level: 'bad',
      text: 'UNCALIBRATED',
      long: 'UNCALIBRATED — FOV guess, distances ~5% out; run /calibrate',
    };
  }
  if (msg.source === undefined) {
    // A client from before provenance existed, or the XR path's own model.
    return msg.calibrated
      ? { level: 'ok', text: 'calibrated', long: 'calibrated' }
      : { level: 'bad', text: 'UNCALIBRATED', long: 'UNCALIBRATED' };
  }
  const from = msg.from ? ` from ${msg.from}` : '';
  const scaled = Number.isFinite(msg.scale) && Math.abs(msg.scale - 1) > 1e-6;
  const parts = [];
  let hint = '';
  if (msg.source === 'rotated') parts.push('rotated');
  if (msg.source === 'rotated-approx') {
    parts.push('rotated, turn direction unknown');
    hint = ' — recalibrate in this orientation to pin the principal point';
  }
  if (scaled) parts.push(`scaled x${msg.scale.toFixed(2)}`);
  if (!parts.length) return { level: 'ok', text: 'calibrated', long: 'calibrated' };
  const text = `${parts.join(', ')}${from}`;
  return { level: 'warn', text, long: `${text}${hint}` };
}

// ---------------------------------------------------------------------------
// Clock sync. Clients and the dashboard run on independent clocks, so frames
// can only be aligned against a shared reference: the server's clock. Probes
// are NTP-style — the sample with the lowest round trip carries the least
// uncertainty — but a single such sample is not enough to hold a session
// together: these clocks drift tens of ppm against the server, so an offset
// measured at startup is tens of milliseconds stale a few minutes later, and
// two clients drifting opposite ways pull their feeds that far apart. Samples
// are kept in a sliding window instead; the low-RTT ones are fitted with a
// line, and its slope is the drift.
const CLOCK_BURST = 8;                 // probes on start and on becoming visible
const CLOCK_BURST_SPACING_MS = 150;
const CLOCK_PROBE_INTERVAL_MS = 2000;
const CLOCK_WINDOW_MS = 120000;
const CLOCK_RTT_TOLERANCE = 1.5;       // fit only samples this close to the best RTT
const CLOCK_FIT_MIN_SAMPLES = 4;
const CLOCK_FIT_MIN_SPAN_MS = 20000;   // a slope measured over less is noise
const CLOCK_MAX_SKEW_PPM = 300;        // steeper than any real crystal
const CLOCK_STEP_MS = 250;             // a jump no round trip could explain

function createClockSync(signaling) {
  // performance.now() is monotonic; Date.now() is not. Android resyncs its
  // wall clock on its own schedule, and a step there would silently move every
  // capture instant this device has already published.
  const localNow = () => performance.now();
  const samples = [];      // { t, offset, rtt }, all on the local clock
  let anchor = 0;          // local time the fit is expressed around
  let base = 0;            // offset at `anchor`
  let skew = 0;            // offset gained per ms of local time
  let bestRtt = Infinity;
  let stepStreak = 0;
  let synced = false;
  let timer = null;
  let visibilityHooked = false;

  function offsetAt(t) {
    return base + skew * (t - anchor);
  }

  function refit() {
    const cutoff = localNow() - CLOCK_WINDOW_MS;
    while (samples.length && samples[0].t < cutoff) samples.shift();
    if (!samples.length) {
      synced = false;
      return;
    }
    // What makes a sample wrong is asymmetry between the two directions, and
    // that can never exceed the round trip itself — so the quickest exchanges
    // are the only ones worth fitting.
    bestRtt = Math.min(...samples.map((s) => s.rtt));
    const good = samples.filter((s) => s.rtt <= bestRtt * CLOCK_RTT_TOLERANCE + 1);
    const span = good[good.length - 1].t - good[0].t;

    if (good.length >= CLOCK_FIT_MIN_SAMPLES && span >= CLOCK_FIT_MIN_SPAN_MS) {
      // Least squares over the window. Anchoring on the newest sample keeps
      // the extrapolation to `now` short, so drift error stays small.
      anchor = good[good.length - 1].t;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const s of good) {
        const x = s.t - anchor;
        sx += x; sy += s.offset; sxx += x * x; sxy += x * s.offset;
      }
      const n = good.length;
      const denom = n * sxx - sx * sx;
      const cap = CLOCK_MAX_SKEW_PPM / 1e6;
      skew = denom > 0 ? Math.max(-cap, Math.min(cap, (n * sxy - sx * sy) / denom)) : 0;
      base = (sy - skew * sx) / n;
    } else {
      // Too little history to tell drift from noise — trust the quickest
      // exchange on its own, as before.
      const best = good.reduce((a, s) => (s.rtt < a.rtt ? s : a));
      anchor = best.t;
      base = best.offset;
      skew = 0;
    }
    synced = true;
  }

  function probe() {
    signaling.send({ type: 'time-ping', t0: localNow() });
  }

  function burst() {
    for (let i = 0; i < CLOCK_BURST; i++) setTimeout(probe, i * CLOCK_BURST_SPACING_MS);
  }

  return {
    // Feed every incoming message here; returns true if it was a clock reply.
    handle(msg) {
      if (msg.type !== 'time-pong') return false;
      const t = localNow();
      const rtt = t - msg.t0;
      // The server wrote its reply somewhere inside the round trip; the
      // midpoint is the best guess and is wrong by at most half the trip.
      const offset = msg.tServer + rtt / 2 - t;
      if (synced && Math.abs(offset - offsetAt(t)) > Math.max(CLOCK_STEP_MS, rtt)) {
        // A server restart, or the device suspending (which stops the
        // monotonic clock but not the world), makes every earlier sample a
        // lie. One wild sample is more likely a reply that sat in a queue, so
        // only a run of them throws the history away.
        if (++stepStreak < 3) return true;
        samples.length = 0;
        stepStreak = 0;
      } else {
        stepStreak = 0;
      }
      samples.push({ t, offset, rtt });
      refit();
      return true;
    },
    // Safe to call again after a reconnect: the timer and the visibility hook
    // are only armed once.
    start() {
      burst();
      if (!timer) timer = setInterval(probe, CLOCK_PROBE_INTERVAL_MS);
      if (!visibilityHooked) {
        visibilityHooked = true;
        // Timers are throttled while hidden, so the window comes back stale —
        // and on a device that suspended, wrong. Re-measure immediately.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') burst();
        });
      }
    },
    // Server-clock time for an instant on the local clock. Detection runs on a
    // worker thread and stamps a frame when it grabs it, so the moment being
    // converted is not always "now" by the time anything asks.
    at(t) {
      return t + offsetAt(t);
    },
    now() {
      const t = localNow();
      return t + offsetAt(t);
    },
    get synced() {
      return synced;
    },
    get uncertaintyMs() {
      return bestRtt / 2;
    },
  };
}

// RTP video clock runs at 90 kHz in a 32-bit field; convert a difference
// between two timestamps to milliseconds, allowing for wraparound.
function rtpDeltaMs(rtp, reference) {
  let diff = (rtp - reference) >>> 0;
  if (diff > 0x80000000) diff -= 0x100000000;
  return diff / 90;
}
