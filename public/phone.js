'use strict';

const preview = document.getElementById('preview');
const switchBtn = document.getElementById('switchBtn');
const micBtn = document.getElementById('micBtn');
const resSelect = document.getElementById('resSelect');

const RESOLUTIONS = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

let facing = 'environment';
let audioEnabled = false;
let stream = null;
let pc = null;
let recorder = null;
let wsOpen = false;
let viewerWaiting = false;

const signaling = connectSignaling('phone', {
  onOpen() {
    wsOpen = true;
    setStatus('connected, waiting for viewer');
    startRecorder();
  },
  onClose() {
    wsOpen = false;
    setStatus('signaling lost, reconnecting…');
    stopRecorder();
  },
  async onMessage(msg) {
    if (msg.type === 'viewer-ready') {
      viewerWaiting = true;
      if (stream) await startCall();
    } else if (msg.type === 'restart-recorder') {
      startRecorder();
    } else if (msg.type === 'answer' && pc) {
      await pc.setRemoteDescription(msg.description);
    } else if (msg.type === 'ice' && pc) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch {
        // Stale candidate from a previous connection — ignore.
      }
    }
  },
});

async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  const res = RESOLUTIONS[resSelect.value];
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: res.width },
      height: { ideal: res.height },
    },
    audio: audioEnabled,
  });
  preview.srcObject = stream;

  // Swap tracks into the live call where a sender of the same kind exists;
  // kind additions/removals need renegotiation (callers run startCall then).
  if (pc) {
    for (const track of stream.getTracks()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === track.kind);
      if (sender) await sender.replaceTrack(track);
    }
  }
}

async function startCall() {
  pc?.close();
  pc = new RTCPeerConnection(RTC_CONFIG);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  pc.onicecandidate = (ev) => {
    if (ev.candidate) signaling.send({ type: 'ice', candidate: ev.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus('streaming');
    else if (pc.connectionState === 'failed') setStatus('connection failed');
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signaling.send({ type: 'offer', description: pc.localDescription });
}

// ---------------------------------------------------------------------------
// Recording: ship MediaRecorder chunks to the server. A new recorder (and a
// recording-start message, so the server opens a fresh file) is needed
// whenever the stream or the socket changes — the first chunk carries the
// WebM header.
function pickMime() {
  const candidates = stream.getAudioTracks().length
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function stopRecorder() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  recorder = null;
}

function startRecorder() {
  if (!stream || !wsOpen) return;
  stopRecorder();
  signaling.send({ type: 'recording-start' });
  recorder = new MediaRecorder(stream, {
    mimeType: pickMime(),
    videoBitsPerSecond: 4_000_000,
  });
  recorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) signaling.sendBinary(ev.data);
  };
  recorder.start(1000);
}

// ---------------------------------------------------------------------------
switchBtn.onclick = async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  try {
    await startCamera();
    startRecorder();
  } catch (err) {
    setStatus(`camera switch failed: ${err.message}`);
  }
};

micBtn.onclick = async () => {
  audioEnabled = !audioEnabled;
  micBtn.textContent = `Mic: ${audioEnabled ? 'on' : 'off'}`;
  try {
    await startCamera();
    startRecorder();
    // Adding/removing an audio track changes the track set — renegotiate.
    if (pc) await startCall();
  } catch (err) {
    audioEnabled = !audioEnabled;
    micBtn.textContent = `Mic: ${audioEnabled ? 'on' : 'off'}`;
    setStatus(`mic toggle failed: ${err.message}`);
  }
};

resSelect.onchange = async () => {
  try {
    await startCamera();
    startRecorder();
  } catch (err) {
    setStatus(`resolution change failed: ${err.message}`);
  }
};

async function keepAwake() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    // Wake lock unavailable — screen may sleep, not fatal.
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
});

(async () => {
  try {
    await startCamera();
  } catch (err) {
    setStatus(`camera error: ${err.message}`);
    return;
  }
  keepAwake();
  startRecorder();
  if (viewerWaiting) await startCall();
})();
