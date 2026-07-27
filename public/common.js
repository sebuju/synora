'use strict';

// Shared between phone and viewer pages: signaling connection + WebRTC config.

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

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
