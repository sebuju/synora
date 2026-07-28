'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode-terminal');
const { createSurvey } = require('./survey.js');
const { createMapping } = require('./mapping.js');
const { createDepthCal } = require('./depth-cal.js');

const PORT = Number(process.env.PORT) || 8443;
const CERT_DIR = path.join(__dirname, 'certs');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FFMPEG = path.join(__dirname, 'tools', 'ffmpeg.exe');
const AKVCAM_MANAGER = path.join(
  process.env.ProgramFiles || 'C:\\Program Files', 'AkVirtualCamera', 'x64', 'AkVCamManager.exe');
const VCAM_WIDTH = 1280;
const VCAM_HEIGHT = 720;
const VCAM_FPS = 30;
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');
const MODELS_DIR = path.join(__dirname, 'models');
const DEPTH_MODEL = path.join(MODELS_DIR, 'depth.onnx');
// Metric variant (metres out): preferred when present — a single tag then
// suffices to calibrate each keyframe's depth.
const DEPTH_MODEL_METRIC = path.join(MODELS_DIR, 'depth-metric.onnx');
const MARKER_MAP_FILE = path.join(__dirname, 'markers.json');
const DEPTH_CAL_FILE = path.join(__dirname, 'depth-calibration.json');
const LOG_FILE = path.join(__dirname, 'server.log');
// Physical marker edge length in meters — must match the printed size from
// /markers, or every distance in the room frame scales by the same error.
const POSE_CONFIG = {
  markerSizeM: 0.15,
  dictionary: 'DICT_4X4_50',
  // 10 Hz: more samples per second converges the survey and the jump gate
  // faster; detection itself costs a client a few tens of ms per frame.
  poseRateMs: 100,
  keyframeMs: 1000,
};

// Every device aligns its frames against this clock, so it must not step:
// Windows resyncs the wall clock on its own schedule, and each client would
// chase the jump separately, tearing the composite apart for as long as they
// took to reconverge. Anchor to the wall clock once, advance monotonically.
const CLOCK_EPOCH = Date.now() - performance.now();

function serverNow() {
  return CLOCK_EPOCH + performance.now();
}

// ---------------------------------------------------------------------------
// Shared date/time formatting (24h, dd/mm/yy) — keep all formatting here.
function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtDateTime(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Sortable identifier for filenames (not a display format).
function fmtFileStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// TLS certificate: generate a self-signed one on first run.
function loadOrCreateCert() {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const selfsigned = require('selfsigned');
  const attrs = [{ name: 'commonName', value: 'synora.local' }];
  const pems = selfsigned.generate(attrs, {
    algorithm: 'sha256',
    keySize: 2048,
    days: 3650,
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          ...lanAddresses().map((ip) => ({ type: 7, ip })),
        ],
      },
    ],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log('Generated self-signed certificate in certs/');
  return { key: pems.private, cert: pems.cert };
}

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Static file server.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  // Required for WebAssembly.instantiateStreaming, which rejects any other
  // content type. The vendored opencv.js inlines its wasm today, but a split
  // build (the fallback path) would need this.
  '.wasm': 'application/wasm',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  // Legacy path — printed QR codes and bookmarks from before the rename.
  if (urlPath === '/phone') {
    res.writeHead(301, { Location: '/client' });
    res.end();
    return;
  }
  if (urlPath === '/client') urlPath = '/client.html';
  if (urlPath === '/viewer' || urlPath === '/dashboard') urlPath = '/viewer.html';
  if (urlPath === '/calibrate') urlPath = '/calibrate.html';
  if (urlPath === '/markers') urlPath = '/markers.html';
  if (urlPath === '/depth-calibrate') urlPath = '/depth-calibrate.html';
  if (urlPath === '/xr-probe') urlPath = '/xr-probe.html';
  if (urlPath === '/xr-client') urlPath = '/xr-client.html';
  if (urlPath === '/digital') urlPath = '/digital.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const headers = { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' };
  // Vendored libs are ~10 MB and immutable-in-practice; stream them instead
  // of buffering whole files per request, and let the browser cache them so a
  // client reload does not re-pull opencv.js over the LAN every time.
  if (urlPath.startsWith('/vendor/')) {
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      headers['Content-Length'] = stat.size;
      headers['Cache-Control'] = 'public, max-age=86400';
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// WebSocket signaling + recording sink.
// N clients (each gets a numeric id) + a single viewer (the dashboard).
// Text frames = JSON signaling. Client→viewer messages get tagged with the
// client's id; viewer→client messages carry a clientId for routing. Binary
// frames from a client = recording chunks for that client's current file.
const clients = new Map();
// Client ids are stable per device: a client persists a random id across
// reloads and presents it on every connection, so a refresh keeps its slot on
// the dashboard (and its recording filenames) instead of taking a new number.
const clientIdsByDevice = new Map();
let nextClientId = 1;
let viewerSocket = null;

// Everything log() prints also lands in server.log; the file starts fresh on
// every boot ('w'), so it holds exactly this run.
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });

function log(msg) {
  const line = `[${fmtDateTime(new Date())}] ${msg}`;
  console.log(line);
  logStream.write(`${line}\n`);
}

// Roster of connected clients, printed whenever it changes. Settings come from
// the clients themselves (see client-state), so they read '?' until reported.
const CLIENT_COLUMNS = [
  ['id', (id) => String(id)],
  ['resolution', (id, s) => s.res || '?'],
  ['mic', (id, s) => (s.mic === undefined ? '?' : s.mic ? 'on' : 'off')],
  ['pose', (id, s) => (s.pose === undefined ? '?' : s.pose ? 'on' : 'off')],
];
const CLIENT_COL_WIDTH = 12;

function clientRow(cells) {
  return `  ${cells.map((c) => c.padEnd(CLIENT_COL_WIDTH)).join('').trimEnd()}`;
}

function logClients() {
  if (clients.size === 0) {
    log('Clients: none');
    return;
  }
  log(`Clients (${clients.size}):`);
  const rows = [clientRow(CLIENT_COLUMNS.map(([name]) => name))];
  for (const id of [...clients.keys()].sort((a, b) => a - b)) {
    const state = clients.get(id).clientState || {};
    rows.push(clientRow(CLIENT_COLUMNS.map(([, value]) => value(id, state))));
  }
  for (const row of rows) {
    console.log(row);
    logStream.write(`${row}\n`);
  }
}

function closeRecording(ws) {
  if (!ws.recordingStream) return;
  ws.recordingStream.end();
  const mb = (ws.recordingBytes / (1024 * 1024)).toFixed(1);
  log(`Recording saved: ${path.relative(__dirname, ws.recordingPath)} (${mb} MB)`);
  ws.recordingStream = null;
  ws.recordingPath = null;
}

function openRecording(ws) {
  closeRecording(ws);
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  ws.recordingPath = path.join(
    RECORDINGS_DIR, `${fmtFileStamp(new Date())}_client${ws.clientId}.webm`);
  ws.recordingStream = fs.createWriteStream(ws.recordingPath);
  ws.recordingBytes = 0;
  log(`Recording started: ${path.relative(__dirname, ws.recordingPath)}`);
}

function send(socket, obj) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

// ---------------------------------------------------------------------------
// Marker survey: turns per-tag camera-frame observations from the clients into
// a persistent room-frame marker map and room-frame client poses.
const survey = createSurvey({
  file: MARKER_MAP_FILE,
  markerSizeM: POSE_CONFIG.markerSizeM,
  log,
});

// The depth model's scale and shift for one camera at one keyframe size —
// measured by a deliberate sweep on /depth-calibrate, then frozen.
const depthCal = createDepthCal({
  file: DEPTH_CAL_FILE,
  metric: fs.existsSync(DEPTH_MODEL_METRIC),
  log,
  fmtDateTime,
});

// Room mapping: posed keyframes -> depth inference -> voxel grid, streamed to
// the viewer as deltas. Needs the depth model present *and* the keyframe's
// camera calibrated — an uncalibrated camera's frames are refused, not guessed.
const mapping = createMapping({
  modelPath: fs.existsSync(DEPTH_MODEL_METRIC) ? DEPTH_MODEL_METRIC : DEPTH_MODEL,
  metric: fs.existsSync(DEPTH_MODEL_METRIC),
  survey,
  depthCal,
  log,
  onCalState: (clientId, deviceId) => sendCalState(clientId, deviceId),
  onDelta: (delta) => send(viewerSocket, { type: 'map-delta', ...delta }),
  onSnapshot: (parts) => parts.forEach((p) => send(viewerSocket, p)),
  onWalls: (walls) => send(viewerSocket, { type: 'walls', walls }),
});

// A depth frame from an XR client: 'XRD1' magic, uint32 LE header length, JSON
// header, then a Float32Array of camera-frame points (NaN where ARCore had no
// depth). No depth model and no calibration involved — ARCore measured these.
function tryXrFrame(ws, data) {
  if (data.length < 9 || data[0] !== 0x58 || data[1] !== 0x52 ||
    data[2] !== 0x44 || data[3] !== 0x31) return false;
  const headerLen = data.readUInt32LE(4);
  if (headerLen <= 0 || 8 + headerLen > data.length) return false;
  let header;
  try {
    header = JSON.parse(data.subarray(8, 8 + headerLen).toString('utf8'));
  } catch {
    return false;
  }
  if (!header.xr || !header.gw || !header.gh) return false;
  const body = data.subarray(8 + headerLen);
  // Copy through a fresh buffer: the socket's memory is not aligned for a
  // Float32Array view and is reused for the next message.
  const pts = new Float32Array(header.gw * header.gh * 3);
  Buffer.from(pts.buffer).set(body.subarray(0, pts.byteLength));
  mapping.handleXrFrame(ws.clientId, header, pts);
  return true;
}

// A keyframe binary frame: 'KFR1' magic, uint32 LE header length, JSON
// header, JPEG. Returns true if the frame was consumed as a keyframe. A
// recording chunk opening with the same four bytes (p ~ 2^-32) falls through
// on the JSON parse and lands in the recording as it should.
function tryKeyframe(ws, data) {
  if (data.length < 9 || data[0] !== 0x4b || data[1] !== 0x46 ||
    data[2] !== 0x52 || data[3] !== 0x31) return false;
  const headerLen = data.readUInt32LE(4);
  if (headerLen <= 0 || 8 + headerLen > data.length) return false;
  let header;
  try {
    header = JSON.parse(data.subarray(8, 8 + headerLen).toString('utf8'));
  } catch {
    return false;
  }
  if (!header.intrinsics || !Array.isArray(header.tags)) return false;
  // Copy the JPEG out: the worker takes ownership of the buffer it gets, and
  // a subarray would hand it the whole socket message's memory.
  mapping.handleKeyframe(
    ws.clientId, ws.deviceId, header, Buffer.from(data.subarray(8 + headerLen)));
  return true;
}

// Calibration state goes to the device doing the sweeping — it is holding the
// page, and the numbers are only meaningful next to the tag it is pointing at.
function sendCalState(clientId, deviceId) {
  const sock = clients.get(clientId);
  if (sock) send(sock, depthCal.state(deviceId));
}

// ---------------------------------------------------------------------------
// Virtual webcam: pipe one client's WebM chunks through ffmpeg into the
// AkVirtualCamera device, so the stream shows up as a normal webcam in any
// Windows app. Enabled only when ffmpeg and the AkVCam driver are present.
let vcamDeviceId = null;
let vcamClientId = null;
let vcamFfmpeg = null;

// Re-run whenever the feature is still off, so a driver installed after the
// server started is picked up without a restart. Only state changes are
// logged, so the repeat checks stay silent.
let vcamStatus = null;

function detectVcam() {
  let status;
  if (!fs.existsSync(FFMPEG)) {
    status = 'Virtual cam disabled: tools/ffmpeg.exe not found';
  } else if (!fs.existsSync(AKVCAM_MANAGER)) {
    status = 'Virtual cam disabled: AkVirtualCamera not installed';
  } else {
    // Parseable output is one bare device id per line; the default is a table.
    const res = spawnSync(AKVCAM_MANAGER, ['-p', 'devices'], { encoding: 'utf8' });
    const id = (res.stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l);
    if (id) {
      vcamDeviceId = id;
      status = `Virtual cam ready: ${id}`;
    } else {
      status = 'Virtual cam disabled: no AkVCam device configured';
    }
  }
  if (status !== vcamStatus) {
    vcamStatus = status;
    log(status);
  }
}

function stopVcam() {
  if (vcamFfmpeg) {
    vcamFfmpeg.kill();
    vcamFfmpeg = null;
  }
  if (vcamClientId !== null) {
    log(`Virtual cam feed stopped (was client ${vcamClientId})`);
    vcamClientId = null;
  }
  send(viewerSocket, { type: 'vcam-state', clientId: null });
}

function startVcam(clientId) {
  stopVcam();
  const client = clients.get(clientId);
  if (!vcamDeviceId || !client) return;

  const ffmpeg = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-i', 'pipe:0',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-vf', `scale=${VCAM_WIDTH}:${VCAM_HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${VCAM_WIDTH}:${VCAM_HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps=${VCAM_FPS}`,
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const manager = spawn(AKVCAM_MANAGER, [
    'stream', '--fps', String(VCAM_FPS),
    vcamDeviceId, 'RGB24', String(VCAM_WIDTH), String(VCAM_HEIGHT),
  ], { stdio: ['pipe', 'ignore', 'pipe'] });

  ffmpeg.stdout.pipe(manager.stdin);
  ffmpeg.stderr.on('data', (d) => log(`ffmpeg: ${d.toString().trim()}`));
  manager.stderr.on('data', (d) => log(`AkVCamManager: ${d.toString().trim()}`));
  ffmpeg.on('close', () => manager.kill());
  ffmpeg.stdin.on('error', () => {});
  manager.stdin.on('error', () => {});

  vcamFfmpeg = ffmpeg;
  vcamClientId = clientId;
  // Fresh WebM header + immediate keyframe for the decoder.
  send(client, { type: 'restart-recorder' });
  log(`Virtual cam feed: client ${clientId}`);
  send(viewerSocket, { type: 'vcam-state', clientId });
}

function clientIdFor(deviceId) {
  // A client that cannot persist an id (or predates the scheme) still gets a
  // number, it just does not survive a reload.
  if (!deviceId) return nextClientId++;
  if (!clientIdsByDevice.has(deviceId)) clientIdsByDevice.set(deviceId, nextClientId++);
  return clientIdsByDevice.get(deviceId);
}

// A device sweeping its depth calibration needs keyframes regardless of what
// the dashboard's map view is set to — the sweep is the one thing that makes
// the map possible in the first place.
function keyframeMsFor(ws) {
  if (depthCal.isCalibrating(ws.deviceId)) return POSE_CONFIG.keyframeMs;
  return mapping.isActive() ? POSE_CONFIG.keyframeMs : 0;
}

function handleSignal(ws, msg) {
  if (msg.type === 'role') {
    if (msg.role === 'client') {
      ws.role = 'client';
      ws.clientId = clientIdFor(msg.deviceId);
      // Kept as well as the clientId: depth calibration is a property of the
      // physical camera, so it outlives the session-scoped small integer.
      ws.deviceId = msg.deviceId;
      // A plain client connection ends any sweep this device left running:
      // the calibration page re-announces itself on every (re)connect, so
      // whatever survives this is genuinely still sweeping.
      depthCal.stop(msg.deviceId);
      // A reload can land the new socket before the old one's close fires, so
      // retire whatever socket still holds the id — only one owns it.
      const prev = clients.get(ws.clientId);
      if (prev && prev !== ws) prev.close();
      clients.set(ws.clientId, ws);
      log(`Client ${ws.clientId} connected (${clients.size} total)`);
      // The webcam feed was bound to the socket that just went away; the new
      // one starts a fresh WebM stream, which needs a fresh ffmpeg.
      if (ws.clientId === vcamClientId) startVcam(ws.clientId);
      // The id is the server's to hand out, and the client shows it so a device
      // can be matched with its tile and its recordings.
      send(ws, { type: 'client-id', clientId: ws.clientId });
      // The printed marker size is the server's to declare — a client assuming
      // a different size would scale every distance it reports.
      send(ws, {
        type: 'pose-config',
        ...POSE_CONFIG,
        keyframeMs: keyframeMsFor(ws),
      });
      if (viewerSocket) send(ws, { type: 'viewer-ready' });
    } else if (msg.role === 'client-bulk') {
      // A client's second socket, carrying only bulk binary (recorder chunks,
      // keyframes) so they cannot queue ahead of the client's JSON traffic.
      // Same deviceId as the main socket -> same clientId; recording state
      // stays on the main socket.
      ws.role = 'client-bulk';
      ws.clientId = clientIdFor(msg.deviceId);
      ws.deviceId = msg.deviceId;
    } else if (msg.role === 'viewer') {
      if (viewerSocket && viewerSocket !== ws) viewerSocket.close();
      viewerSocket = ws;
      ws.role = 'viewer';
      log('Viewer connected');
      // Catch a driver that appeared since startup. An active feed holds the
      // id it is streaming to, so leave that case alone.
      if (!vcamDeviceId) detectVcam();
      send(ws, { type: 'vcam-state', clientId: vcamClientId, available: !!vcamDeviceId });
      send(ws, { type: 'marker-map', ...survey.getMarkerMap() });
      for (const part of mapping.snapshotParts()) send(ws, part);
      send(ws, { type: 'walls', walls: mapping.getWalls() });
      for (const client of clients.values()) send(client, { type: 'viewer-ready' });
    }
    return;
  }
  if (msg.type === 'client-state') {
    if (ws.role === 'client') {
      ws.clientState = { res: msg.res, mic: !!msg.mic, pose: !!msg.pose };
      logClients();
    }
    return;
  }
  if (msg.type === 'recording-start') {
    if (ws.role === 'client') openRecording(ws);
    return;
  }
  if (msg.type === 'ping') {
    // Liveness probe: clients treat an unanswered ping as a dead socket. The
    // reply carries viewer presence so a client that missed a viewer-ready
    // (frozen page, swapped socket) converges within one probe interval.
    send(ws, { type: 'pong', viewer: !!viewerSocket });
    return;
  }
  if (msg.type === 'time-ping') {
    // NTP-style probe: clients use the server clock as the common timebase
    // for aligning frames captured on different devices.
    send(ws, { type: 'time-pong', t0: msg.t0, tServer: serverNow() });
    return;
  }
  if (msg.type === 'vcam') {
    if (ws.role === 'viewer') {
      if (msg.clientId === null) stopVcam();
      else startVcam(msg.clientId);
    }
    return;
  }
  if (msg.type === 'marker-remove') {
    if (ws.role === 'viewer' && Number.isInteger(msg.id)) {
      survey.removeMarker(msg.id);
      send(ws, { type: 'marker-map', ...survey.getMarkerMap() });
    }
    return;
  }
  if (msg.type === 'map-clear') {
    if (ws.role === 'viewer') mapping.clear().forEach((p) => send(ws, p));
    return;
  }
  if (msg.type === 'map-view') {
    if (ws.role === 'viewer') {
      mapping.setViewMode(msg.mode).forEach((p) => send(ws, p));
      // Keyframes are pure waste while mapping is off — tell the clients.
      for (const client of clients.values()) {
        send(client, { type: 'pose-config', keyframeMs: keyframeMsFor(client) });
      }
    }
    return;
  }
  if (msg.type === 'depth-cal') {
    if (ws.role === 'client') {
      if (msg.action === 'start') depthCal.start(ws.deviceId);
      else if (msg.action === 'stop') depthCal.stop(ws.deviceId);
      else if (msg.action === 'clear') depthCal.clear(ws.deviceId);
      else if (msg.action === 'unfreeze') depthCal.unfreeze(ws.deviceId);
      else if (msg.action === 'freeze') {
        const res = depthCal.freeze(ws.deviceId);
        if (!res.ok) send(ws, { type: 'depth-cal-error', reason: res.reason });
      }
      // Starting or stopping changes whether this device owes us keyframes.
      send(ws, { type: 'pose-config', keyframeMs: keyframeMsFor(ws) });
      send(ws, depthCal.state(ws.deviceId));
    }
    return;
  }
  if (msg.type === 'xr-pose') {
    if (ws.role === 'client') {
      // ARCore already knows where the camera is; the tags only say where the
      // room is relative to ARCore's frame.
      const { pose, quality, mapChanged } = survey.alignXr(ws.clientId, msg.xr, msg.tags || []);
      send(viewerSocket, { ...msg, type: 'pose', clientId: ws.clientId, room: { pose, quality } });
      send(ws, { type: 'room-pose', pose, quality });
      if (mapChanged) send(viewerSocket, { type: 'marker-map', ...survey.getMarkerMap() });
    }
    return;
  }
  if (msg.type === 'pose') {
    if (ws.role === 'client') {
      // The survey consumes the camera-frame observations and hands back the
      // room-frame pose; the viewer gets both in one message.
      const { pose, quality, mapChanged } = survey.handlePose(msg, ws.clientId);
      send(viewerSocket, { ...msg, clientId: ws.clientId, room: { pose, quality } });
      // The client cannot know its room pose on its own (the marker map lives
      // here) — reflect it back for the on-client stats overlay.
      send(ws, { type: 'room-pose', pose, quality });
      if (mapChanged) send(viewerSocket, { type: 'marker-map', ...survey.getMarkerMap() });
    }
    return;
  }
  // Relay signaling (offer/answer/ice) between the viewer and one client.
  if (ws.role === 'client') {
    send(viewerSocket, { ...msg, clientId: ws.clientId });
  } else if (ws.role === 'viewer') {
    send(clients.get(msg.clientId), msg);
  }
}

// Pose/mapping assets are gitignored (large binaries); report what is missing
// once at startup so a fresh checkout knows why those features are dark.
function probeAssets() {
  const missing = [];
  for (const f of ['opencv.js', 'three.min.js', 'OrbitControls.js']) {
    if (!fs.existsSync(path.join(VENDOR_DIR, f))) missing.push(`public/vendor/${f}`);
  }
  if (missing.length) {
    log(`Pose features disabled: missing ${missing.join(', ')} — run "npm run fetch-vendor"`);
  }
  if (!fs.existsSync(DEPTH_MODEL_METRIC) && !fs.existsSync(DEPTH_MODEL)) {
    log('Mapping disabled: no depth model in models/ — run "npm run fetch-vendor"');
  }
}

function main() {
  detectVcam();
  probeAssets();
  survey.load();
  depthCal.load();
  const tls = loadOrCreateCert();
  const server = https.createServer(tls, serveStatic);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (ws.role !== 'client' && ws.role !== 'client-bulk') return;
        // Keyframes must be picked off before the recording sink — they are
        // not WebM data, and they arrive whether or not a recording is open.
        if (tryKeyframe(ws, data)) return;
        if (tryXrFrame(ws, data)) return;
        // Recording state lives on the client's main socket, wherever the
        // bytes arrive.
        const main = ws.role === 'client' ? ws : clients.get(ws.clientId);
        if (main?.recordingStream) {
          main.recordingStream.write(data);
          main.recordingBytes += data.length;
          if (ws.clientId === vcamClientId && vcamFfmpeg) vcamFfmpeg.stdin.write(data);
        }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      handleSignal(ws, msg);
    });

    ws.on('close', () => {
      if (ws.role === 'client') {
        closeRecording(ws);
        // A reconnect of the same device may already own this id — its state
        // belongs to the new socket, so leave it alone.
        if (clients.get(ws.clientId) !== ws) return;
        clients.delete(ws.clientId);
        if (ws.clientId === vcamClientId) stopVcam();
        log(`Client ${ws.clientId} disconnected (${clients.size} total)`);
        logClients();
        send(viewerSocket, { type: 'client-gone', clientId: ws.clientId });
      } else if (ws === viewerSocket) {
        viewerSocket = null;
        log('Viewer disconnected');
      }
    });

    ws.on('error', () => {});
  });

  server.listen(PORT, () => {
    const ips = lanAddresses();
    const primary = ips[0] || 'localhost';
    const clientUrl = `https://${primary}:${PORT}/client`;
    console.log('');
    console.log(`Viewer (this PC):  https://localhost:${PORT}/viewer`);
    console.log(`Client (same LAN):  ${clientUrl}`);
    if (ips.length > 1) {
      console.log(`Other interfaces:  ${ips.slice(1).map((ip) => `https://${ip}:${PORT}/client`).join(', ')}`);
    }
    console.log('');
    console.log('Scan on client:');
    qrcode.generate(clientUrl, { small: true });
    console.log('Accept the self-signed certificate warning on both devices.');
  });
}

main();
