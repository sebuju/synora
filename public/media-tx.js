'use strict';

// Sending video: one peer connection to the dashboard, one MediaRecorder to the
// server, and the handful of signaling messages both need. Shared because there
// are now two pages that do it — `/client`, whose source is a camera, and
// `/xr-client`, whose source is a canvas fed from the frames its detector was
// already reading back — and the second copy of this would have drifted from
// the first within a session or two.
//
// The split is by what differs between the pages, not by what looks tidy:
//
//   this module   `pc`, the recorder, and the messages that keep them alive
//                 (viewer-ready, restart-recorder, answer, ice). Nothing here
//                 knows where the media comes from.
//   the page      the source and the recovery policy. `/client` has a camera to
//                 reacquire and a re-entrancy guard around doing it; the XR page
//                 has no camera at all — frames either arrive from the session
//                 or they do not — so it has nothing to guard.
//
// Depends on common.js for RTC_CONFIG and ABS_CAPTURE_TIME_URI; load it after.

// Each pairing carries that frame's encode delay on top of the capture instant,
// and the dashboard can only cancel it by taking the smallest one it has seen
// recently — so what matters is how many samples land inside its window, not
// how often the mapping strictly needs refreshing. These cost ~70 bytes each.
const RTP_MAP_PUBLISH_MS = 125;

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

// Recording: ship MediaRecorder chunks to the server. A new recorder (and a
// recording-start message, so the server opens a fresh file) is needed
// whenever the stream or the socket changes — the first chunk carries the
// WebM header.
function pickMime(stream) {
  const candidates = stream.getAudioTracks().length
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function createMediaTx({
  signaling,
  bulk,
  clockSync,
  getStream,
  onStatus = () => {},
  // Called after a fresh recorder is running. /client re-applies its paused
  // state here — a new recorder does not carry it over.
  onRecorderStarted,
  // A viewer appeared, or reappeared after being missed. The page decides what
  // that means: /client runs its whole camera-and-call recovery, the XR page
  // only offers if it has frames to offer.
  onViewerReady,
  // The peer connection failed. Same reasoning — the page owns the retry.
  onCallFailed,
}) {
  let pc = null;
  let recorder = null;
  let wsOpen = false;
  let viewerWaiting = false;
  // The socket hands messages over without awaiting the handler, so an `ice`
  // arriving hard behind its `answer` used to run while setRemoteDescription
  // was still in flight — addIceCandidate throws there, and the candidate was
  // dropped by the catch that was meant for stale ones. Chained instead, so
  // negotiation steps run in the order they arrived.
  let negotiating = Promise.resolve();

  // The dashboard sees each frame's RTP timestamp but has no way to know when
  // it was captured. Encoded-frame access gives us both at the sending end, so
  // we publish the pairing and let the dashboard interpolate the rest.
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
    const stream = getStream();
    if (!stream) return;
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
      if (self.connectionState === 'connected') onStatus('streaming');
      else if (self.connectionState === 'failed') {
        onStatus('connection failed, retrying…');
        onCallFailed?.();
      }
    };
    const offer = await pc.createOffer();
    offer.sdp = withAbsCaptureTime(offer.sdp);
    await pc.setLocalDescription(offer);
    signaling.send({ type: 'offer', description: pc.localDescription });
  }

  // Stopping is announced, not merely done: a closed peer connection leaves the
  // dashboard holding a tile frozen on the last frame it received, which looks
  // exactly like a client that is still there and has stopped moving.
  function stopCall() {
    if (!pc) return;
    pc.close();
    pc = null;
    signaling.send({ type: 'stream-stopped' });
  }

  // Swap tracks into the live call where a sender of the same kind exists;
  // kind additions/removals need renegotiation (callers run startCall then).
  async function replaceTracks(stream) {
    if (!pc) return;
    for (const track of stream.getTracks()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === track.kind);
      if (sender) await sender.replaceTrack(track);
    }
  }

  function stopRecorder() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    recorder = null;
  }

  function startRecorder() {
    const stream = getStream();
    if (!stream || !wsOpen) return;
    stopRecorder();
    signaling.send({ type: 'recording-start' });
    // Bitrate tracks the actual capture size — a flat rate turns 4K into mush.
    // Tiers rather than a formula: encoder efficiency is not linear in pixels.
    // Read from the track, not from what was asked for: the camera may have
    // degraded the request to whatever it could actually do.
    const { width = 1280, height = 720 } =
      stream.getVideoTracks()[0]?.getSettings() ?? {};
    const px = width * height;
    recorder = new MediaRecorder(stream, {
      mimeType: pickMime(stream),
      videoBitsPerSecond:
        px >= 3840 * 2160 * 0.9 ? 16_000_000
          : px >= 2560 * 1440 * 0.9 ? 8_000_000
            : 4_000_000,
    });
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) bulk.sendBinary(ev.data);
    };
    recorder.start(1000);
    onRecorderStarted?.();
  }

  // Parking, not stopping: a paused feed keeps the recording open so it stays
  // one file, and resuming is instant.
  function setRecorderPaused(on) {
    if (on && recorder?.state === 'recording') recorder.pause();
    else if (!on && recorder?.state === 'paused') recorder.resume();
  }

  function ensureRecorder() {
    // A parked recorder (paused feed) is still a live recording — only a dead
    // one needs replacing.
    if (!recorder || recorder.state === 'inactive') startRecorder();
  }

  function pcDead() {
    return !pc || ['failed', 'disconnected', 'closed'].includes(pc.connectionState);
  }

  return {
    startCall,
    stopCall,
    replaceTracks,
    startRecorder,
    stopRecorder,
    ensureRecorder,
    setRecorderPaused,
    pcDead,
    hasCall: () => !!pc,
    get viewerWaiting() { return viewerWaiting; },
    // The one answer to "can anything be sent right now". The pages used to
    // keep their own copy of this beside the module's and they cannot both be
    // right.
    get socketOpen() { return wsOpen; },

    socketOpened() {
      wsOpen = true;
      // The server re-announces the viewer on a new socket, so wait to be told
      // rather than trusting the flag from the socket that just died.
      viewerWaiting = false;
    },

    socketClosed() {
      wsOpen = false;
      viewerWaiting = false;
      stopRecorder();
    },

    // Belt and suspenders for viewer-ready: the pong says whether a viewer is
    // connected right now, so a missed viewer-ready (page was frozen, socket
    // was being swapped) heals within one probe interval instead of needing a
    // manual reload.
    handlePong(msg) {
      if (msg.viewer === undefined) return;
      if (msg.viewer && (!viewerWaiting || pcDead())) {
        viewerWaiting = true;
        onViewerReady?.();
      } else if (!msg.viewer) {
        viewerWaiting = false;
      }
    },

    // True when the message was ours, so the page can stop looking at it.
    handleMessage(msg) {
      if (msg.type === 'viewer-ready') {
        viewerWaiting = true;
        onViewerReady?.();
      } else if (msg.type === 'restart-recorder') {
        // The server tracks a recording per socket, and the vcam tee needs a
        // fresh WebM header and keyframe.
        startRecorder();
      } else if (msg.type === 'answer') {
        negotiating = negotiating
          .then(() => pc?.setRemoteDescription(msg.description))
          .catch(() => {});
      } else if (msg.type === 'ice') {
        negotiating = negotiating
          .then(() => pc?.addIceCandidate(msg.candidate))
          // Stale candidate from a previous connection — ignore.
          .catch(() => {});
      } else {
        return false;
      }
      return true;
    },
  };
}
