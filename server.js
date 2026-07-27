'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode-terminal');

const PORT = 8443;
const CERT_DIR = path.join(__dirname, 'certs');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FFMPEG = path.join(__dirname, 'tools', 'ffmpeg.exe');
const AKVCAM_MANAGER = path.join(
  process.env.ProgramFiles || 'C:\\Program Files', 'AkVirtualCamera', 'x64', 'AkVCamManager.exe');
const VCAM_WIDTH = 1280;
const VCAM_HEIGHT = 720;
const VCAM_FPS = 30;

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
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/viewer.html';
  if (urlPath === '/phone') urlPath = '/phone.html';
  if (urlPath === '/viewer' || urlPath === '/dashboard') urlPath = '/viewer.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
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
let nextPhoneId = 1;
let viewerSocket = null;

function log(msg) {
  console.log(`[${fmtDateTime(new Date())}] ${msg}`);
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
// Virtual webcam: pipe one phone's WebM chunks through ffmpeg into the
// AkVirtualCamera device, so the stream shows up as a normal webcam in any
// Windows app. Enabled only when ffmpeg and the AkVCam driver are present.
let vcamDeviceId = null;
let vcamPhoneId = null;
let vcamFfmpeg = null;

function detectVcam() {
  if (!fs.existsSync(FFMPEG)) {
    log('Virtual cam disabled: tools/ffmpeg.exe not found');
    return;
  }
  if (!fs.existsSync(AKVCAM_MANAGER)) {
    log('Virtual cam disabled: AkVirtualCamera not installed');
    return;
  }
  const res = spawnSync(AKVCAM_MANAGER, ['devices'], { encoding: 'utf8' });
  const id = (res.stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l);
  if (!id) {
    log('Virtual cam disabled: no AkVCam device configured');
    return;
  }
  vcamDeviceId = id;
  log(`Virtual cam ready: ${vcamDeviceId}`);
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

function handleSignal(ws, msg) {
  if (msg.type === 'role') {
    if (msg.role === 'phone') {
      ws.role = 'phone';
      ws.phoneId = nextPhoneId++;
      phones.set(ws.phoneId, ws);
      log(`Phone ${ws.phoneId} connected (${phones.size} total)`);
      if (viewerSocket) send(ws, { type: 'viewer-ready' });
    } else if (msg.role === 'viewer') {
      if (viewerSocket && viewerSocket !== ws) viewerSocket.close();
      viewerSocket = ws;
      ws.role = 'viewer';
      log('Viewer connected');
      send(ws, { type: 'vcam-state', phoneId: vcamPhoneId, available: !!vcamDeviceId });
      for (const phone of phones.values()) send(phone, { type: 'viewer-ready' });
    }
    return;
  }
  if (msg.type === 'recording-start') {
    if (ws.role === 'phone') openRecording(ws);
    return;
  }
  if (msg.type === 'time-ping') {
    // NTP-style probe: clients use the server clock as the common timebase
    // for aligning frames captured on different devices.
    send(ws, { type: 'time-pong', t0: msg.t0, tServer: Date.now() });
    return;
  }
  if (msg.type === 'vcam') {
    if (ws.role === 'viewer') {
      if (msg.phoneId === null) stopVcam();
      else startVcam(msg.phoneId);
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

function main() {
  detectVcam();
  const tls = loadOrCreateCert();
  const server = https.createServer(tls, serveStatic);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (ws.role === 'phone' && ws.recordingStream) {
          ws.recordingStream.write(data);
          ws.recordingBytes += data.length;
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
        phones.delete(ws.phoneId);
        closeRecording(ws);
        if (ws.phoneId === vcamPhoneId) stopVcam();
        log(`Phone ${ws.phoneId} disconnected (${phones.size} total)`);
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
