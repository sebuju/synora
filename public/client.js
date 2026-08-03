'use strict';

const preview = document.getElementById('preview');
const feed = document.querySelector('main');
const clientLabel = document.getElementById('clientLabel');
const switchBtn = document.getElementById('switchBtn');
const micBtn = document.getElementById('micBtn');
const recBtn = document.getElementById('recBtn');
const poseBtn = document.getElementById('poseBtn');
const blankBtn = document.getElementById('blankBtn');
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

// Defaults only. The device's real settings live on the server under its id and
// are applied by applyStoredConfig() below, before anything opens the camera.
// `appliedRes` is also the answer to "did the resolution actually change": the
// select already shows the new value by the time its change event fires, so it
// cannot be compared against itself.
let appliedRes = resSelect.value;
let facing = 'environment';
let audioEnabled = false;
let paused = false;
// Two halves of one label: the client number matches this device's recording
// filenames and its dashboard tile, the device name is what a person calls it.
// They arrive from different places at different times, so neither writes the
// element directly.
let clientNumber = null;
let deviceName = null;

function updateLabel() {
  const parts = [];
  if (clientNumber !== null) parts.push(`client${clientNumber}`);
  if (deviceName) parts.push(deviceName);
  clientLabel.textContent = parts.join(' · ') || 'identifying…';
}
let stream = null;
let cameraPending = null;
let restarting = false;
let restartQueued = false;

// Identity comes first: both sockets announce it, every stored setting and
// every camera calibration is keyed by it, and the server can only hand this
// device its own state once it knows which device it is. Resolving it may
// involve asking the person which device this browser is, so it is a promise
// the sockets wait on rather than a value.
const device = resolveDevice('client');
const deviceIdReady = device.then((d) => d.id);

const signaling = connectSignaling('client', {
  async onOpen() {
    tx.socketOpened();
    setStatus('connected, waiting for viewer');
    clockSync.start();
    sendClientState();
    // The server tracks a recording per socket, so a new socket needs a fresh
    // recorder — its first chunk carries the WebM header.
    if (await ensureCamera()) tx.startRecorder();
  },
  onClose() {
    tx.socketClosed();
    setStatus('signaling lost, reconnecting…');
  },
  onPong(msg) {
    tx.handlePong(msg);
  },
  async onMessage(msg) {
    if (clockSync.handle(msg)) return;
    // Everything to do with the peer connection and the recorder, in one place
    // shared with the XR client.
    if (tx.handleMessage(msg)) return;
    if (msg.type === 'client-id') {
      clientNumber = msg.clientId;
      updateLabel();
    } else if (msg.type === 'control') {
      // Remote control from the dashboard. Every action lands in the same
      // setter the on-screen button calls — a second path would be a second
      // set of bugs, and the two would drift.
      await REMOTE_ACTIONS[msg.action]?.(msg.value);
    } else if (msg.type === 'pose-config') {
      posePipeline.setConfig(msg);
    } else if (msg.type === 'room-pose') {
      posePipeline.setRoomPose(msg);
    }
  },
}, deviceIdReady);

const clockSync = createClockSync(signaling);

// Bulk uploads (recorder chunks) get their own socket. They share
// one TCP stream's ordering, but more importantly they no longer sit in front
// of pose and signaling messages — half a megabyte of WebM per second queued
// ahead of a pose message is exactly the lag it caused. Same deviceId, so the
// server maps both sockets to the same client.
const bulk = connectSignaling('client-bulk', {}, deviceIdReady);

// The peer connection and the recorder. This page owns the source (the camera)
// and the recovery policy (restartCall below, which has a camera to reacquire);
// the module owns everything downstream of the tracks.
const tx = createMediaTx({
  signaling,
  bulk,
  clockSync,
  getStream: () => stream,
  onStatus: setStatus,
  // A new recorder does not carry the paused state over.
  onRecorderStarted: () => applyPaused(),
  onViewerReady: () => restartCall(),
  onCallFailed: () => setTimeout(restartCall, 1000),
});

// Everything this device was last set to, applied before a camera can open —
// the size and the lens are read at getUserMedia time, so a camera opened
// ahead of this would have to be torn down and reopened, taking the recording
// and the peer connection with it. A server that does not answer leaves the
// defaults standing rather than leaving the page dark: resolveDevice and
// initIntrinsics both give up after a short timeout.
// Never rejects: a server that cannot be reached must leave the defaults
// standing, not wedge every path that waits on this.
const configReady = applyStoredConfig().catch((err) => {
  setStatus(`stored settings unavailable: ${err.message}`);
});

async function applyStoredConfig() {
  const d = await device;
  // Calibration must be in place before the first frame is solved, or the
  // client reports positions from a guessed camera model and only says so in
  // one line of an overlay.
  await initIntrinsics(d);
  deviceName = d.name;
  updateLabel();
  wireDeviceChip(clientLabel, 'client');
  const s = d.settings;
  if (!s) return;
  if (RESOLUTIONS[s.res]) {
    appliedRes = s.res;
    resSelect.value = s.res;
  }
  facing = s.facing === 'user' ? 'user' : 'environment';
  audioEnabled = !!s.mic;
  // The mic button carries its state in a class and nothing else sets it on
  // load.
  micBtn.classList.toggle('active', audioEnabled);
}

// Blanking the screen is the one real power saving available to a page that is
// pinned awake by a wake lock. Nothing is torn down — the stream, the recorder
// and tag detection carry on behind the black.
const blank = createBlankScreen(document.body, (on) => {
  blankBtn.classList.toggle('active', on);
  sendClientState();
});

// The server keeps a roster of connected clients, and the dashboard renders it;
// the server only learns the settings a client chose for itself if the client
// reports them, on connect and on every change.
function sendClientState() {
  // Gated on the restore, because reporting is also the *write* path: the
  // server stores whatever a client says about itself. The socket opens as soon
  // as identity resolves, which is earlier than the settings finish being
  // applied — and a report that raced the restore overwrote the stored settings
  // with this page's defaults, destroying them on every single load.
  configReady.then(reportClientState);
}

function reportClientState() {
  // The requested resolution is not the streamed one: constraints use `ideal`,
  // so a camera that cannot do 4K silently hands back whatever it could, and
  // the roster showing the request alone made that invisible.
  const settings = stream?.getVideoTracks()[0]?.getSettings?.() ?? {};
  signaling.send({
    type: 'client-state',
    kind: 'client',
    res: resSelect.value,
    capture: settings.width && settings.height
      ? { w: settings.width, h: settings.height } : null,
    facing,
    mic: audioEnabled,
    pose: posePipeline.enabled,
    paused,
    blank: blank.on,
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
  // Nothing opens the camera before the device's stored settings have been
  // applied, or given up on — the size and lens are fixed at getUserMedia time.
  cameraPending ??= configReady
    .then(startCamera)
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
  tx.setRecorderPaused(paused);
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

  await tx.replaceTracks(stream);

  // New tracks may mean a different lens or resolution; the pose pipeline
  // must re-read its intrinsics and make sure its frame loop is armed.
  posePipeline.onCameraChanged(facing);
  // The single point where lens, resolution and mic all become true rather than
  // requested, so it is the one place the roster has to be told from.
  sendClientState();
}

// ---------------------------------------------------------------------------
// Everything the client can be told to do, as functions of the state wanted
// rather than of a tap. The on-screen buttons and the dashboard's remote
// control both go through these, so there is one implementation of each action
// and the two surfaces cannot drift apart.
// A failed change is rolled back before it is reported. What the client reports
// is what the server stores and hands back on the next load, so a lens or a
// size the camera refused must not become the one it starts with — that would
// fail identically every load, with nothing left to fall back to.
async function setFacing(next) {
  if (next === facing) return;
  const prev = facing;
  facing = next;
  try {
    await startCamera();
    tx.startRecorder();
  } catch (err) {
    facing = prev;
    setStatus(`camera switch failed: ${err.message}`);
    sendClientState();
  }
}

async function setMic(on) {
  if (on === audioEnabled) return;
  audioEnabled = on;
  micBtn.classList.toggle('active', audioEnabled);
  try {
    await startCamera();
    tx.startRecorder();
    // Adding/removing an audio track changes the track set — renegotiate.
    if (tx.hasCall()) await tx.startCall();
  } catch (err) {
    audioEnabled = !audioEnabled;
    micBtn.classList.toggle('active', audioEnabled);
    setStatus(`mic toggle failed: ${err.message}`);
    sendClientState();
  }
}

async function setResolution(value) {
  if (!RESOLUTIONS[value] || value === appliedRes) return;
  const prev = appliedRes;
  appliedRes = value;
  resSelect.value = value;
  try {
    await startCamera();
    tx.startRecorder();
  } catch (err) {
    appliedRes = prev;
    resSelect.value = prev;
    setStatus(`resolution change failed: ${err.message}`);
    sendClientState();
  }
}

// Cut the current recording and open the next one server-side.
async function newRecording() {
  if (!tx.socketOpen) {
    setStatus('not connected — recording unchanged');
    return;
  }
  if (!(await ensureCamera())) return;
  tx.startRecorder();
  // Recording is invisible from the client, so acknowledge the tap.
  recBtn.classList.add('active');
  setTimeout(() => recBtn.classList.remove('active'), 400);
}

function setPaused(on) {
  if (on === paused) return;
  paused = on;
  applyPaused();
  sendClientState();
}

async function setPose(on) {
  if (on === posePipeline.enabled) return;
  poseBtn.classList.toggle('active', on);
  try {
    // setEnabled reports the new state through the onState hook.
    await posePipeline.setEnabled(on);
  } catch (err) {
    poseBtn.classList.remove('active');
    setStatus(`marker tracking failed: ${err.message}`);
  }
}

// Actions the dashboard may drive, keyed by the name it sends. Values are the
// wanted state, not a toggle: the dashboard renders from the state the server
// reported, so a toggle raced against a stale view would land inverted.
const REMOTE_ACTIONS = {
  facing: (v) => setFacing(v === 'user' ? 'user' : 'environment'),
  mic: (v) => setMic(!!v),
  res: (v) => setResolution(v),
  pose: (v) => setPose(!!v),
  paused: (v) => setPaused(!!v),
  blank: (v) => blank.set(!!v),
  record: () => newRecording(),
};

switchBtn.onclick = () => setFacing(facing === 'environment' ? 'user' : 'environment');
micBtn.onclick = () => setMic(!audioEnabled);
recBtn.onclick = () => newRecording();
feed.onclick = () => setPaused(!paused);
poseBtn.onclick = () => setPose(!posePipeline.enabled);
blankBtn.onclick = () => blank.toggle();
resSelect.onchange = () => setResolution(resSelect.value);

// ---------------------------------------------------------------------------
// Recovery. Backgrounding the browser can cost us the camera, the recorder and
// the peer connection at once, and none of them come back on their own. This
// half stays here rather than in media-tx.js: it is about reacquiring the
// *camera*, which is the one thing the XR client does not have.
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
      if (cameraWasLive) tx.ensureRecorder();
      else tx.startRecorder();
      if (tx.socketOpen && tx.viewerWaiting) await tx.startCall();
    } while (restartQueued);
  } catch (err) {
    setStatus(`restart failed: ${err.message}`);
  } finally {
    restarting = false;
  }
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
  if (!streamLive() || tx.pcDead()) await restartCall();
  else tx.ensureRecorder();
});

(async () => {
  posePipeline.init({
    video: preview,
    signaling,
    bulk,
    clockSync,
    onState: sendClientState,
  });
  const d = await device;
  // On unless this device is on record as having turned it off — the room
  // features are the point. Loads opencv.js in the background; detection starts
  // once frames flow, so this is deliberately not awaited.
  if (d.settings?.pose !== false) setPose(true);
  if (!(await ensureCamera())) return;
  keepAwake();
  tx.ensureRecorder();
  if (tx.viewerWaiting) await tx.startCall();
  // Camera labels are only readable once camera permission has been granted, so
  // the fingerprint stored before the camera opened is weaker than the one
  // available now. Re-announcing strengthens the *next* recovery, which is the
  // one that will need it.
  d.refresh();
})();
