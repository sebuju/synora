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
const LOG_FILE = path.join(__dirname, 'server.log');
// Physical marker edge length in meters — must match the printed size from
// /markers, or every distance in the room frame scales by the same error.
const POSE_CONFIG = {
  markerSizeM: 0.15,
  dictionary: 'DICT_4X4_50',
  // 10 Hz: more samples per second converges the survey and the jump gate
  // faster; detection itself costs a phone a few tens of ms per frame.
  poseRateMs: 100,
  keyframeMs: 1000,
};

// Every device aligns its frames against this clock, so it must not step:
// Windows resyncs the wall clock on its own schedule, and each phone would
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
  const attrs = [{ name: 'commonName', value: 'android-streamer.local' }];
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
  if (urlPath === '/phone') urlPath = '/phone.html';
  if (urlPath === '/viewer' || urlPath === '/dashboard') urlPath = '/viewer.html';
  if (urlPath === '/calibrate') urlPath = '/calibrate.html';
  if (urlPath === '/markers') urlPath = '/markers.html';
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
  // phone reload does not re-pull opencv.js over the LAN every time.
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
// N phones (each gets a numeric id) + a single viewer (the dashboard).
// Text frames = JSON signaling. Phone→viewer messages get tagged with the
// phone's id; viewer→phone messages carry a phoneId for routing. Binary
// frames from a phone = recording chunks for that phone's current file.
const phones = new Map();
// Phone ids are stable per device: a client persists a random id across
// reloads and presents it on every connection, so a refresh keeps its slot on
// the dashboard (and its recording filenames) instead of taking a new number.
const phoneIdsByClient = new Map();
let nextPhoneId = 1;
let viewerSocket = null;

// Everything log() prints also lands in server.log; the file starts fresh on
// every boot ('w'), so it holds exactly this run.
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });

function log(msg) {
  const line = `[${fmtDateTime(new Date())}] ${msg}`;
  console.log(line);
  logStream.write(`${line}\n`);
}

// Roster of connected phones, printed whenever it changes. Settings come from
// the phones themselves (see client-state), so they read '?' until reported.
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
  if (phones.size === 0) {
    log('Clients: none');
    return;
  }
  log(`Clients (${phones.size}):`);
  const rows = [clientRow(CLIENT_COLUMNS.map(([name]) => name))];
  for (const id of [...phones.keys()].sort((a, b) => a - b)) {
    const state = phones.get(id).clientState || {};
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
    RECORDINGS_DIR, `${fmtFileStamp(new Date())}_phone${ws.phoneId}.webm`);
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
// Marker survey: turns per-tag camera-frame observations from the phones into
// a persistent room-frame marker map and room-frame phone poses.
const survey = createSurvey({
  file: MARKER_MAP_FILE,
  markerSizeM: POSE_CONFIG.markerSizeM,
  log,
});

// Room mapping: posed keyframes -> depth inference -> voxel grid, streamed to
// the viewer as deltas. Enabled only when the depth model is present.
const mapping = createMapping({
  modelPath: fs.existsSync(DEPTH_MODEL_METRIC) ? DEPTH_MODEL_METRIC : DEPTH_MODEL,
  metric: fs.existsSync(DEPTH_MODEL_METRIC),
  survey,
  log,
  onDelta: (delta) => send(viewerSocket, { type: 'map-delta', ...delta }),
  onSnapshot: (parts) => parts.forEach((p) => send(viewerSocket, p)),
  onWalls: (walls) => send(viewerSocket, { type: 'walls', walls }),
});

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
  mapping.handleKeyframe(ws.phoneId, header, Buffer.from(data.subarray(8 + headerLen)));
  return true;
}

// ---------------------------------------------------------------------------
// Virtual webcam: pipe one phone's WebM chunks through ffmpeg into the
// AkVirtualCamera device, so the stream shows up as a normal webcam in any
// Windows app. Enabled only when ffmpeg and the AkVCam driver are present.
let vcamDeviceId = null;
let vcamPhoneId = null;
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
  if (vcamPhoneId !== null) {
    log(`Virtual cam feed stopped (was phone ${vcamPhoneId})`);
    vcamPhoneId = null;
  }
  send(viewerSocket, { type: 'vcam-state', phoneId: null });
}

function startVcam(phoneId) {
  stopVcam();
  const phone = phones.get(phoneId);
  if (!vcamDeviceId || !phone) return;

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
  vcamPhoneId = phoneId;
  // Fresh WebM header + immediate keyframe for the decoder.
  send(phone, { type: 'restart-recorder' });
  log(`Virtual cam feed: phone ${phoneId}`);
  send(viewerSocket, { type: 'vcam-state', phoneId });
}

function phoneIdFor(clientId) {
  // A client that cannot persist an id (or predates the scheme) still gets a
  // number, it just does not survive a reload.
  if (!clientId) return nextPhoneId++;
  if (!phoneIdsByClient.has(clientId)) phoneIdsByClient.set(clientId, nextPhoneId++);
  return phoneIdsByClient.get(clientId);
}

function handleSignal(ws, msg) {
  if (msg.type === 'role') {
    if (msg.role === 'phone') {
      ws.role = 'phone';
      ws.phoneId = phoneIdFor(msg.clientId);
      // A reload can land the new socket before the old one's close fires, so
      // retire whatever socket still holds the id — only one owns it.
      const prev = phones.get(ws.phoneId);
      if (prev && prev !== ws) prev.close();
      phones.set(ws.phoneId, ws);
      log(`Phone ${ws.phoneId} connected (${phones.size} total)`);
      // The webcam feed was bound to the socket that just went away; the new
      // one starts a fresh WebM stream, which needs a fresh ffmpeg.
      if (ws.phoneId === vcamPhoneId) startVcam(ws.phoneId);
      // The id is the server's to hand out, and the phone shows it so a device
      // can be matched with its tile and its recordings.
      send(ws, { type: 'phone-id', phoneId: ws.phoneId });
      // The printed marker size is the server's to declare — a phone assuming
      // a different size would scale every distance it reports.
      send(ws, {
        type: 'pose-config',
        ...POSE_CONFIG,
        keyframeMs: mapping.isActive() ? POSE_CONFIG.keyframeMs : 0,
      });
      if (viewerSocket) send(ws, { type: 'viewer-ready' });
    } else if (msg.role === 'phone-bulk') {
      // A phone's second socket, carrying only bulk binary (recorder chunks,
      // keyframes) so they cannot queue ahead of the phone's JSON traffic.
      // Same clientId as the main socket -> same phoneId; recording state
      // stays on the main socket.
      ws.role = 'phone-bulk';
      ws.phoneId = phoneIdFor(msg.clientId);
    } else if (msg.role === 'viewer') {
      if (viewerSocket && viewerSocket !== ws) viewerSocket.close();
      viewerSocket = ws;
      ws.role = 'viewer';
      log('Viewer connected');
      // Catch a driver that appeared since startup. An active feed holds the
      // id it is streaming to, so leave that case alone.
      if (!vcamDeviceId) detectVcam();
      send(ws, { type: 'vcam-state', phoneId: vcamPhoneId, available: !!vcamDeviceId });
      send(ws, { type: 'marker-map', ...survey.getMarkerMap() });
      for (const part of mapping.snapshotParts()) send(ws, part);
      send(ws, { type: 'walls', walls: mapping.getWalls() });
      for (const phone of phones.values()) send(phone, { type: 'viewer-ready' });
    }
    return;
  }
  if (msg.type === 'client-state') {
    if (ws.role === 'phone') {
      ws.clientState = { res: msg.res, mic: !!msg.mic, pose: !!msg.pose };
      logClients();
    }
    return;
  }
  if (msg.type === 'recording-start') {
    if (ws.role === 'phone') openRecording(ws);
    return;
  }
  if (msg.type === 'ping') {
    // Liveness probe: clients treat an unanswered ping as a dead socket. The
    // reply carries viewer presence so a phone that missed a viewer-ready
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
      if (msg.phoneId === null) stopVcam();
      else startVcam(msg.phoneId);
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
      // Keyframes are pure waste while mapping is off — tell the phones.
      for (const phone of phones.values()) {
        send(phone, { type: 'pose-config', keyframeMs: mapping.isActive() ? POSE_CONFIG.keyframeMs : 0 });
      }
    }
    return;
  }
  if (msg.type === 'pose') {
    if (ws.role === 'phone') {
      // The survey consumes the camera-frame observations and hands back the
      // room-frame pose; the viewer gets both in one message.
      const { pose, quality, mapChanged } = survey.handlePose(msg, ws.phoneId);
      send(viewerSocket, { ...msg, phoneId: ws.phoneId, room: { pose, quality } });
      // The phone cannot know its room pose on its own (the marker map lives
      // here) — reflect it back for the on-phone stats overlay.
      send(ws, { type: 'room-pose', pose, quality });
      if (mapChanged) send(viewerSocket, { type: 'marker-map', ...survey.getMarkerMap() });
    }
    return;
  }
  // Relay signaling (offer/answer/ice) between the viewer and one phone.
  if (ws.role === 'phone') {
    send(viewerSocket, { ...msg, phoneId: ws.phoneId });
  } else if (ws.role === 'viewer') {
    send(phones.get(msg.phoneId), msg);
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
  const tls = loadOrCreateCert();
  const server = https.createServer(tls, serveStatic);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (ws.role !== 'phone' && ws.role !== 'phone-bulk') return;
        // Keyframes must be picked off before the recording sink — they are
        // not WebM data, and they arrive whether or not a recording is open.
        if (tryKeyframe(ws, data)) return;
        // Recording state lives on the phone's main socket, wherever the
        // bytes arrive.
        const main = ws.role === 'phone' ? ws : phones.get(ws.phoneId);
        if (main?.recordingStream) {
          main.recordingStream.write(data);
          main.recordingBytes += data.length;
          if (ws.phoneId === vcamPhoneId && vcamFfmpeg) vcamFfmpeg.stdin.write(data);
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
      if (ws.role === 'phone') {
        closeRecording(ws);
        // A reconnect of the same device may already own this id — its state
        // belongs to the new socket, so leave it alone.
        if (phones.get(ws.phoneId) !== ws) return;
        phones.delete(ws.phoneId);
        if (ws.phoneId === vcamPhoneId) stopVcam();
        log(`Phone ${ws.phoneId} disconnected (${phones.size} total)`);
        logClients();
        send(viewerSocket, { type: 'phone-gone', phoneId: ws.phoneId });
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
    const phoneUrl = `https://${primary}:${PORT}/phone`;
    console.log('');
    console.log(`Viewer (this PC):  https://localhost:${PORT}/viewer`);
    console.log(`Phone (same LAN):  ${phoneUrl}`);
    if (ips.length > 1) {
      console.log(`Other interfaces:  ${ips.slice(1).map((ip) => `https://${ip}:${PORT}/phone`).join(', ')}`);
    }
    console.log('');
    console.log('Scan on phone:');
    qrcode.generate(phoneUrl, { small: true });
    console.log('Accept the self-signed certificate warning on both devices.');
  });
}

main();
