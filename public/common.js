'use strict';

// Shared between phone and viewer pages: signaling connection + WebRTC config.

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// RTP header extension carrying each frame's capture instant on the sender's
// clock — the basis for aligning feeds from several phones.
const ABS_CAPTURE_TIME_URI = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';

// A phone that switches apps gets its page frozen, and the OS tears the
// connection down underneath it — the socket stays nominally OPEN and no close
// event ever arrives, so nothing triggers a reconnect. A ping/pong probe is the
// only reliable liveness signal; an unanswered one means the socket is dead.
const PROBE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 8000;
const RECONNECT_DELAY_MS = 2000;

// A client id that survives reloads, so the server can hand a device the phone
// number it had before instead of burning a fresh one on every refresh.
function loadClientId(role) {
  const key = `streamer-client-id:${role}`;
  let id = null;
  try {
    id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
  } catch {
    // Storage unavailable (private mode, blocked cookies): a per-load id still
    // works, it just does not survive a refresh.
    id ||= crypto.randomUUID();
  }
  return id;
}

// Opens the signaling WebSocket, announces our role, auto-reconnects.
// handlers: { onMessage(msg), onOpen(), onClose() } — all optional.
// Returns { send(obj), sendBinary(blob), close() }.
function connectSignaling(role, handlers = {}) {
  const clientId = loadClientId(role);
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
      sock.send(JSON.stringify({ type: 'role', role, clientId }));
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
      if (msg.type === 'pong') return;
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
    close() {
      closedByUs = true;
      ws?.close();
    },
  };
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

// ---------------------------------------------------------------------------
// Clock sync. Phones and the dashboard run on independent clocks, so frames
// can only be aligned against a shared reference: the server's clock. Probes
// are NTP-style — the sample with the lowest round trip carries the least
// uncertainty, so that one wins.
function createClockSync(signaling) {
  let offset = 0;          // add to local Date.now() to get server time
  let bestRtt = Infinity;
  let synced = false;
  let timer = null;

  function probe() {
    signaling.send({ type: 'time-ping', t0: Date.now() });
  }

  return {
    // Feed every incoming message here; returns true if it was a clock reply.
    handle(msg) {
      if (msg.type !== 'time-pong') return false;
      const t1 = Date.now();
      const rtt = t1 - msg.t0;
      if (rtt <= bestRtt) {
        bestRtt = rtt;
        offset = msg.tServer + rtt / 2 - t1;
        synced = true;
      }
      return true;
    },
    // Safe to call again after a reconnect: the drift timer is only armed once.
    start() {
      // A short burst first (converges quickly), then occasional re-probes to
      // track drift.
      for (let i = 0; i < 5; i++) setTimeout(probe, i * 200);
      if (!timer) timer = setInterval(probe, 10000);
    },
    now() {
      return Date.now() + offset;
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
