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
    clockSync.start();
    startRecorder();
  },
  onClose() {
    wsOpen = false;
    setStatus('signaling lost, reconnecting…');
    stopRecorder();
  },
  async onMessage(msg) {
    if (clockSync.handle(msg)) return;
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

const clockSync = createClockSync(signaling);

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

// Advertise the absolute-capture-time RTP header extension on the video
// section. It carries each frame's capture instant on the sender's clock,
// which is what lets the dashboard align feeds from different phones.
function withAbsCaptureTime(sdp) {
  if (sdp.includes(ABS_CAPTURE_TIME_URI)) return sdp;
  const sections = sdp.split(/(?=^m=)/m);
  return sections.map((section) => {
    if (!section.startsWith('m=video')) return section;
    const used = [...section.matchAll(/^a=extmap:(\d+)/gm)].map((m) => Number(m[1]));
    let id = 1;
    while (used.includes(id)) id++;
    if (id > 14) return section;
    const lines = section.trimEnd().split('\r\n');
    const last = lines.map((l) => l.startsWith('a=extmap:')).lastIndexOf(true);
    lines.splice(last + 1, 0, `a=extmap:${id} ${ABS_CAPTURE_TIME_URI}`);
    return `${lines.join('\r\n')}\r\n`;
  }).join('');
}

// The dashboard sees each frame's RTP timestamp but has no way to know when it
// was captured. Encoded-frame access gives us both at the sending end, so we
// publish the pairing and let the dashboard interpolate the rest.
function publishFrameTiming(sender) {
  if (!sender.createEncodedStreams) return;
  let streams;
  try {
    streams = sender.createEncodedStreams();
  } catch {
    return;
  }
  let lastSent = 0;
  const tagger = new TransformStream({
    transform(frame, controller) {
      const now = clockSync.now();
      // The RTP clock is exact between pairings, so these are only needed
      // often enough for the dashboard to find a low-encode-delay sample.
      if (clockSync.synced && now - lastSent > 250) {
        lastSent = now;
        signaling.send({ type: 'rtp-map', rtp: frame.timestamp, serverTime: now });
      }
      controller.enqueue(frame);
    },
  });
  streams.readable.pipeThrough(tagger).pipeTo(streams.writable).catch(() => {});
}

async function startCall() {
  pc?.close();
  pc = new RTCPeerConnection({ ...RTC_CONFIG, encodedInsertableStreams: true });
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind === 'video') publishFrameTiming(sender);
  }
  pc.onicecandidate = (ev) => {
    if (ev.candidate) signaling.send({ type: 'ice', candidate: ev.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus('streaming');
    else if (pc.connectionState === 'failed') setStatus('connection failed');
  };
  const offer = await pc.createOffer();
  offer.sdp = withAbsCaptureTime(offer.sdp);
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
