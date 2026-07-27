'use strict';

// Shared between phone and viewer pages: signaling connection + WebRTC config.

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// RTP header extension carrying each frame's capture instant on the sender's
// clock — the basis for aligning feeds from several phones.
const ABS_CAPTURE_TIME_URI = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';

// Opens the signaling WebSocket, announces our role, auto-reconnects.
// handlers: { onMessage(msg), onOpen(), onClose() } — all optional.
// Returns { send(obj), sendBinary(blob), socket() }.
function connectSignaling(role, handlers = {}) {
  let ws = null;
  let closedByUs = false;

  function open() {
    ws = new WebSocket(`wss://${location.host}`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'role', role }));
      handlers.onOpen?.();
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handlers.onMessage?.(msg);
    };
    ws.onclose = () => {
      handlers.onClose?.();
      if (!closedByUs) setTimeout(open, 2000);
    };
    ws.onerror = () => ws.close();
  }

  open();
  return {
    send(obj) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    sendBinary(blob) {
      if (ws.readyState === WebSocket.OPEN) ws.send(blob);
    },
    close() {
      closedByUs = true;
      ws.close();
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
    start() {
      // A short burst first (converges quickly), then occasional re-probes to
      // track drift.
      for (let i = 0; i < 5; i++) setTimeout(probe, i * 200);
      setInterval(probe, 10000);
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
