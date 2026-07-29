'use strict';

const preview = document.getElementById('preview');
const feed = document.querySelector('main');
const clientLabel = document.getElementById('clientLabel');
const switchBtn = document.getElementById('switchBtn');
const micBtn = document.getElementById('micBtn');
const recBtn = document.getElementById('recBtn');
const poseBtn = document.getElementById('poseBtn');
const resSelect = document.getElementById('resSelect');

// Constraints use `ideal`, so a client that cannot do the asked size degrades
// to the closest it can rather than failing.
const RESOLUTIONS = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '4K': { width: 3840, height: 2160 },
};

let facing = 'environment';
let audioEnabled = false;
let paused = false;
let stream = null;
let pc = null;
let recorder = null;
let wsOpen = false;
let viewerWaiting = false;
let cameraPending = null;
let restarting = false;
let restartQueued = false;

const signaling = connectSignaling('client', {
  async onOpen() {
    wsOpen = true;
    setStatus('connected, waiting for viewer');
    clockSync.start();
    sendClientState();
    // The server tracks a recording per socket, so a new socket needs a fresh
    // recorder — its first chunk carries the WebM header. It also re-announces
    // the viewer, so wait to be told rather than trusting the old flag.
    viewerWaiting = false;
    if (await ensureCamera()) startRecorder();
  },
  onClose() {
    wsOpen = false;
    viewerWaiting = false;
    setStatus('signaling lost, reconnecting…');
    stopRecorder();
  },
  onPong(msg) {
    // Belt and suspenders for viewer-ready: the pong says whether a viewer is
    // connected right now, so a missed viewer-ready (page was frozen, socket
    // was being swapped) heals within one probe interval instead of needing
    // a manual reload.
    if (msg.viewer === undefined) return;
    if (msg.viewer && (!viewerWaiting || pcDead())) {
      viewerWaiting = true;
      restartCall();
    } else if (!msg.viewer) {
      viewerWaiting = false;
    }
  },
  async onMessage(msg) {
    if (clockSync.handle(msg)) return;
    if (msg.type === 'client-id') {
      // Matches the name the server gives this device's recordings.
      clientLabel.textContent = `client${msg.clientId}`;
    } else if (msg.type === 'viewer-ready') {
      viewerWaiting = true;
      await restartCall();
    } else if (msg.type === 'restart-recorder') {
      startRecorder();
    } else if (msg.type === 'pose-config') {
      posePipeline.setConfig(msg);
    } else if (msg.type === 'room-pose') {
      posePipeline.setRoomPose(msg);
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

// Bulk uploads (recorder chunks) get their own socket. They share
// one TCP stream's ordering, but more importantly they no longer sit in front
// of pose and signaling messages — half a megabyte of WebM per second queued
// ahead of a pose message is exactly the lag it caused. Same deviceId, so the
// server maps both sockets to the same client.
const bulk = connectSignaling('client-bulk', {}, loadDeviceId('client'));

// The server keeps a roster of connected clients; it only learns the settings a
// client chose for itself if the client reports them, on connect and on change.
function sendClientState() {
  signaling.send({
    type: 'client-state',
    res: resSelect.value,
    mic: audioEnabled,
    pose: posePipeline.enabled,
  });
}

// Android hands the camera to whatever app is in the foreground, so a
// backgrounded page comes back with its tracks ended and no video flowing.
function streamLive() {
  return !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
}

// Reacquire the camera if it was taken away. Concurrent callers share one
// getUserMedia call — two in flight would leave the loser's tracks orphaned.
function ensureCamera() {
  if (streamLive()) return Promise.resolve(true);
  cameraPending ??= startCamera()
    .then(() => true)
    .catch((err) => {
      setStatus(`camera error: ${err.message}`);
      return false;
    })
    .finally(() => {
      cameraPending = null;
    });
  return cameraPending;
}

// Pausing keeps the camera open and the call up: the tracks go silent (the
// viewer sees black) and the recorder parks, so resuming is instant and the
// recording continues in the same file. Every path that produces new tracks or
// a new recorder ends here, since neither carries the paused state over.
function applyPaused() {
  stream?.getTracks().forEach((t) => { t.enabled = !paused; });
  if (paused && recorder?.state === 'recording') recorder.pause();
  else if (!paused && recorder?.state === 'paused') recorder.resume();
  // Disabled tracks still deliver frames, they are just black — detecting tags
  // in them costs the same as detecting them in the real picture.
  posePipeline.setPaused(paused);
  document.body.classList.toggle('paused', paused);
}

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
  applyPaused();

  // Swap tracks into the live call where a sender of the same kind exists;
  // kind additions/removals need renegotiation (callers run startCall then).
  if (pc) {
    for (const track of stream.getTracks()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === track.kind);
      if (sender) await sender.replaceTrack(track);
    }
  }

  // New tracks may mean a different lens or resolution; the pose pipeline
  // must re-read its intrinsics and make sure its frame loop is armed.
  posePipeline.onCameraChanged(facing);
}

// Advertise the absolute-capture-time RTP header extension on the video
// section. It carries each frame's capture instant on the sender's clock,
// which is what lets the dashboard align feeds from different clients.
function withAbsCaptureTime(sdp) {
  if (sdp.includes(ABS_CAPTURE_TIME_URI)) return sdp;
  // Within a BUNDLE group an extension id must mean the same thing in every
  // m-section, so the id has to be free across the whole SDP — picking one
  // that is merely free in the video section collides with audio when the mic
  // is on. Ids above 14 need the two-byte header form, so stop there.
  const used = new Set([...sdp.matchAll(/^a=extmap:(\d+)/gm)].map((m) => Number(m[1])));
  let id = 1;
  while (used.has(id)) id++;
  if (id > 14) return sdp;

  return sdp.split(/(?=^m=)/m).map((section) => {
    if (!section.startsWith('m=video')) return section;
    const lines = section.trimEnd().split('\r\n');
    const last = lines.map((l) => l.startsWith('a=extmap:')).lastIndexOf(true);
    // With no extmap lines to follow, append rather than land above the m= line.
    lines.splice(last >= 0 ? last + 1 : lines.length, 0,
      `a=extmap:${id} ${ABS_CAPTURE_TIME_URI}`);
    return `${lines.join('\r\n')}\r\n`;
  }).join('');
}

// Route a sender's encoded frames back out untouched, calling onFrame (if any)
// on the way past. Enabling insertable streams hands every sender's frames to
// the transformer, and a sender whose streams are never read has its media
// dropped — so senders we only want to observe, and ones we care nothing
// about, both have to be piped.
function pipeEncoded(sender, onFrame) {
  if (!sender.createEncodedStreams) return;
  let streams;
  try {
    streams = sender.createEncodedStreams();
  } catch {
    return;
  }
  const relay = new TransformStream({
    transform(frame, controller) {
      onFrame?.(frame);
      controller.enqueue(frame);
    },
  });
  streams.readable.pipeThrough(relay).pipeTo(streams.writable).catch(() => {});
}

// The dashboard sees each frame's RTP timestamp but has no way to know when it
// was captured. Encoded-frame access gives us both at the sending end, so we
// publish the pairing and let the dashboard interpolate the rest.
// Each pairing carries that frame's encode delay on top of the capture
// instant, and the dashboard can only cancel it by taking the smallest one it
// has seen recently — so what matters is how many samples land inside its
// window, not how often the mapping strictly needs refreshing. These cost ~70
// bytes each.
const RTP_MAP_PUBLISH_MS = 125;

function frameTimingPublisher() {
  let lastSent = 0;
  return (frame) => {
    const now = clockSync.now();
    if (clockSync.synced && now - lastSent > RTP_MAP_PUBLISH_MS) {
      lastSent = now;
      // Our own clock error biases this client's feed alone, so the dashboard
      // cannot see it in the alignment it measures — send the bound along.
      signaling.send({
        type: 'rtp-map',
        rtp: frame.timestamp,
        serverTime: now,
        unc: Math.round(clockSync.uncertaintyMs * 10) / 10,
      });
    }
  };
}

async function startCall() {
  pc?.close();
  pc = new RTCPeerConnection({ ...RTC_CONFIG, encodedInsertableStreams: true });
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  for (const sender of pc.getSenders()) {
    pipeEncoded(sender, sender.track?.kind === 'video' ? frameTimingPublisher() : null);
  }
  pc.onicecandidate = (ev) => {
    if (ev.candidate) signaling.send({ type: 'ice', candidate: ev.candidate });
  };
  const self = pc;
  self.onconnectionstatechange = () => {
    if (self !== pc) return;   // superseded by a later call
    if (self.connectionState === 'connected') setStatus('streaming');
    else if (self.connectionState === 'failed') {
      setStatus('connection failed, retrying…');
      setTimeout(restartCall, 1000);
    }
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
  // Bitrate tracks the actual capture size — a flat rate turns 4K into mush.
  // Tiers rather than a formula: encoder efficiency is not linear in pixels.
  // Read from the track, not the select: the camera may have degraded the
  // request to whatever it could actually do.
  const { width = 1280, height = 720 } =
    stream.getVideoTracks()[0]?.getSettings() ?? {};
  const px = width * height;
  recorder = new MediaRecorder(stream, {
    mimeType: pickMime(),
    videoBitsPerSecond:
      px >= 3840 * 2160 * 0.9 ? 16_000_000
        : px >= 2560 * 1440 * 0.9 ? 8_000_000
          : 4_000_000,
  });
  recorder.ondataavailable = (ev) => {
    if (ev.data.size > 0) bulk.sendBinary(ev.data);
  };
  recorder.start(1000);
  applyPaused();
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
  micBtn.classList.toggle('active', audioEnabled);
  try {
    await startCamera();
    startRecorder();
    // Adding/removing an audio track changes the track set — renegotiate.
    if (pc) await startCall();
  } catch (err) {
    audioEnabled = !audioEnabled;
    micBtn.classList.toggle('active', audioEnabled);
    setStatus(`mic toggle failed: ${err.message}`);
  }
  sendClientState();
};

// Cut the current recording and open the next one server-side.
recBtn.onclick = async () => {
  if (!wsOpen) {
    setStatus('not connected — recording unchanged');
    return;
  }
  if (!(await ensureCamera())) return;
  startRecorder();
  // Recording is invisible from the client, so acknowledge the tap.
  recBtn.classList.add('active');
  setTimeout(() => recBtn.classList.remove('active'), 400);
};

feed.onclick = () => {
  paused = !paused;
  applyPaused();
};

poseBtn.onclick = async () => {
  const on = !posePipeline.enabled;
  poseBtn.classList.toggle('active', on);
  try {
    localStorage.setItem('streamer-pose-enabled', on ? '1' : '0');
  } catch {
    // Storage unavailable — the toggle just does not survive a reload.
  }
  try {
    await posePipeline.setEnabled(on);
  } catch (err) {
    poseBtn.classList.remove('active');
    setStatus(`marker tracking failed: ${err.message}`);
  }
};

resSelect.onchange = async () => {
  try {
    await startCamera();
    startRecorder();
  } catch (err) {
    setStatus(`resolution change failed: ${err.message}`);
  }
  sendClientState();
};

// ---------------------------------------------------------------------------
// Recovery. Backgrounding the browser can cost us the camera, the recorder and
// the peer connection at once, and none of them come back on their own.
function ensureRecorder() {
  // A parked recorder (paused feed) is still a live recording — only a dead
  // one needs replacing.
  if (!recorder || recorder.state === 'inactive') startRecorder();
}

async function restartCall() {
  // A request arriving mid-restart must not be dropped: the state it reacted
  // to (a viewer appearing, say) may already have been read past.
  if (restarting) {
    restartQueued = true;
    return;
  }
  restarting = true;
  try {
    do {
      restartQueued = false;
      const cameraWasLive = streamLive();
      if (!(await ensureCamera())) break;
      // New tracks mean the recorder is bound to a dead stream; otherwise the
      // running recording is still good and worth keeping in one file.
      if (cameraWasLive) ensureRecorder();
      else startRecorder();
      if (wsOpen && viewerWaiting) await startCall();
    } while (restartQueued);
  } catch (err) {
    setStatus(`restart failed: ${err.message}`);
  } finally {
    restarting = false;
  }
}

function pcDead() {
  return !pc || ['failed', 'disconnected', 'closed'].includes(pc.connectionState);
}

async function keepAwake() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    // Wake lock unavailable — screen may sleep, not fatal.
  }
}

// The wake lock is dropped whenever the page hides, so it has to be retaken.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  if (!streamLive() || pcDead()) await restartCall();
  else ensureRecorder();
});

(async () => {
  posePipeline.init({
    video: preview,
    signaling,
    bulk,
    clockSync,
    onState: sendClientState,
  });
  // On unless explicitly turned off — the room features are the point.
  let poseWanted = true;
  try {
    poseWanted = localStorage.getItem('streamer-pose-enabled') !== '0';
  } catch {
    // Storage unavailable — default on.
  }
  if (poseWanted) {
    poseBtn.classList.add('active');
    // Loads opencv.js in the background; detection starts once frames flow.
    posePipeline.setEnabled(true).catch((err) => {
      poseBtn.classList.remove('active');
      setStatus(`marker tracking failed: ${err.message}`);
    });
  }
  if (!(await ensureCamera())) return;
  keepAwake();
  ensureRecorder();
  if (viewerWaiting) await startCall();
})();
