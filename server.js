'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode-terminal');
const { createSurvey } = require('./survey.js');
const { createWalls } = require('./walls.js');
const { createLandmarks, landmarkGate } = require('./landmarks.js');
const { MIN_ARC_DEG: LANDMARK_MIN_ARC_DEG } = require('./public/landmark-math.js');
const { createDeviceRegistry, modelFromUa } = require('./devices.js');

const PORT = Number(process.env.PORT) || 8443;
// Where everything the server *writes* lives. Overridable because a second
// instance — a replay feed, an experiment, a spare-port server — would
// otherwise overwrite the marker map and the walls grid of the room the real
// one is surveying, and those are the two files in this project that cannot be
// regenerated. Defaults to the repo root, which is where they have always been.
const STATE_DIR = process.env.SYNORA_STATE_DIR || __dirname;
const CERT_DIR = path.join(__dirname, 'certs');
const RECORDINGS_DIR = path.join(STATE_DIR, 'recordings');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FFMPEG = path.join(__dirname, 'tools', 'ffmpeg.exe');
const AKVCAM_MANAGER = path.join(
  process.env.ProgramFiles || 'C:\\Program Files', 'AkVirtualCamera', 'x64', 'AkVCamManager.exe');
const VCAM_WIDTH = 1280;
const VCAM_HEIGHT = 720;
const VCAM_FPS = 30;
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');
const MARKER_MAP_FILE = path.join(STATE_DIR, 'markers.json');
const WALLS_FILE = path.join(STATE_DIR, 'walls.json');
const DEVICES_FILE = path.join(STATE_DIR, 'devices.json');
const POSE_SETTINGS_FILE = path.join(STATE_DIR, 'pose-settings.json');
const LOG_FILE = path.join(STATE_DIR, 'server.log');
// What the capture pages are showing on their own screens, as they show it.
// Separate from server.log on purpose: it is a transcript of one client's
// overlay a few times a second, and interleaving that with the server's own
// narration would bury both.
const OVERLAY_FILE = path.join(STATE_DIR, 'overlay.log');
// Physical marker edge length in meters — the outer edge of the black square,
// not the sheet and not the quiet zone. Must match the printed size from
// /markers, or every distance in the room frame scales by the same error.
// Measured 142 mm on the printed set: a 150 mm marker sent through a printer's
// "fit to page" comes back at about 95%, and nothing downstream can see the
// difference — it just reports a room 5.6% too big, consistently enough to
// look right. Changing it invalidates markers.json — the loader checks the
// size the map was surveyed at and refuses a mismatch.
// Settable from /markers, so this is the default rather than the value.
const POSE_CONFIG = {
  markerSizeM: 0.15,
  dictionary: 'DICT_4X4_50',
  // 10 Hz: more samples per second converges the survey and the jump gate
  // faster; detection itself costs a client a few tens of ms per frame.
  poseRateMs: 100,
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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Calibration payloads are the largest thing that comes back this way: a
// handful of small records, nowhere near this.
const JSON_BODY_LIMIT = 64 * 1024;

function readJson(req, res, then) {
  let body = '';
  let over = false;
  req.on('data', (c) => {
    body += c;
    if (body.length > JSON_BODY_LIMIT) {
      over = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (over) return;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad JSON' });
      return;
    }
    then(parsed);
  });
}

// Small JSON routes, for the pages that have no WebSocket of their own
// (/markers, /calibrate) and for the one exchange that has to happen before a
// page knows which client it even is. Returns true when it handled the request.
function serveApi(req, res, urlPath) {
  if (!urlPath.startsWith('/api/')) return false;

  // /markers is a plain page, and the marker size it sets and renders at is the
  // room's only metric datum — so it rides a route rather than the WS protocol.
  if (urlPath === '/api/pose-config') {
    if (req.method === 'GET') {
      sendJson(res, 200, { markerSizeM: POSE_CONFIG.markerSizeM });
    } else if (req.method === 'POST') {
      readJson(req, res, (body) => {
        let out;
        try {
          out = applyMarkerSize(Number(body.markerSizeM));
        } catch (err) {
          out = { ok: false, error: err.message };
        }
        sendJson(res, out.ok ? 200 : 400, out);
      });
    } else {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }
    return true;
  }

  // The device model is parsed out of the user agent here rather than on the
  // page, so there is one parser and a stored fingerprint is always comparable
  // with a fresh one. The browser and OS versions are deliberately left out —
  // they change on their own every few weeks and would walk a device out of
  // matching range of its own record.
  const withModel = (fingerprint) => (fingerprint
    ? { ...fingerprint, model: modelFromUa(req.headers['user-agent']) }
    : null);

  // Everything a device has ever been told about itself. Fetched before the
  // camera is opened, because the size and lens it opens with come from here.
  if (urlPath === '/api/device/hello' && req.method === 'POST') {
    readJson(req, res, (body) => {
      const rec = registry.touch(body.deviceId, {
        userAgent: req.headers['user-agent'],
        fingerprint: withModel(body.fingerprint),
      });
      if (!rec) {
        sendJson(res, 400, { ok: false, error: 'no deviceId' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        device: {
          id: rec.id, name: rec.name, settings: rec.settings, intrinsics: rec.intrinsics,
        },
      });
    });
    return true;
  }

  // A browser that has lost its id asking who it used to be. Answers with an
  // id to adopt only when the fingerprint picks one device out unambiguously;
  // otherwise with the candidates, for a person to choose between.
  if (urlPath === '/api/device/match' && req.method === 'POST') {
    readJson(req, res, (body) => {
      const out = registry.match(withModel(body.fingerprint));
      // Logged because it is otherwise invisible and it is the mechanism that
      // decides whether a device keeps its calibration: a browser that turned
      // up blank and walked away with a fresh id looks exactly like a browser
      // that was always new.
      const best = out.candidates[0];
      log(`Device match: ${out.adopt ? `adopt ${out.adopt.slice(0, 8)}` : 'no adoption'}`
        + ` (${out.candidates.length} candidate(s)`
        + `${best ? `, best ${best.name} at ${Math.round(best.score * 100)}%` : ''})`);
      sendJson(res, 200, { ok: true, ...out });
    });
    return true;
  }

  if (urlPath === '/api/devices' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, devices: registry.list() });
    return true;
  }

  // Calibration, from /calibrate. Merged rather than replaced — a device
  // calibrated at several resolutions has a record per resolution.
  if (urlPath === '/api/device/intrinsics' && req.method === 'POST') {
    readJson(req, res, (body) => {
      if (!registry.has(body.deviceId)) {
        sendJson(res, 404, { ok: false, error: 'unknown device' });
        return;
      }
      const n = registry.mergeIntrinsics(body.deviceId, body.intrinsics);
      sendJson(res, 200, { ok: true, stored: n });
    });
    return true;
  }

  sendJson(res, 404, { ok: false, error: 'no such route' });
  return true;
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (serveApi(req, res, urlPath)) return;
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
  // Everything else is this app's own source, edited constantly and served over
  // a LAN to devices that are awkward to clear the cache on. With no headers at
  // all a browser is free to cache heuristically, and it does not have to make
  // the same choice for the page as for the script it loads: a fresh page with
  // a stale script is a button that exists and does nothing, which looks like a
  // bug in the code rather than a copy of last week's.
  headers['Cache-Control'] = 'no-store';
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

// Everything log() prints also lands in server.log. Appended, not truncated:
// `npm run dev` restarts on every file change, and truncating meant the log of
// the run that showed the problem was gone by the time the fix was typed. The
// boot banner below is the run separator.
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

logStream.write(`\n===== server start ${fmtDateTime(new Date())} =====\n`);

function log(msg) {
  const line = `[${fmtDateTime(new Date())}] ${msg}`;
  console.log(line);
  logStream.write(`${line}\n`);
}

function onOff(v) {
  return v === undefined ? '?' : v ? 'on' : 'off';
}

// Roster of connected clients, printed whenever it changes. Settings come from
// the clients themselves (see client-state), so they read '?' until reported.
const CLIENT_COLUMNS = [
  ['id', (id) => String(id)],
  ['kind', (id, s) => s.kind || '?'],
  ['resolution', (id, s) => s.res || '?'],
  ['mic', (id, s) => onOff(s.mic)],
  ['pose', (id, s) => onOff(s.pose)],
  ['paused', (id, s) => onOff(s.paused)],
  ['blank', (id, s) => onOff(s.blank)],
  ['map', (id, s) => s.map || '?'],
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

// The roster as the dashboard needs it. A client only gets a video tile there
// once a peer connection is up, and the XR client never opens one at all — so
// before this, a positioning client was invisible on the dashboard even though
// the server had it listed the whole time. Everything the dashboard can control
// is in here, and the controls render from this rather than from what they last
// asked for: an optimistic button lies whenever the client refuses.
function clientList() {
  return [...clients.keys()].sort((a, b) => a - b).map((id) => {
    const ws = clients.get(id);
    return {
      clientId: id,
      ...(ws.clientState || {}),
      // The registry's name, not the socket's: it is the device that is named,
      // and the same device keeps that name across reconnects and client ids.
      name: registry.get(ws.deviceId)?.name || null,
      connectedAt: ws.connectedAt,
      recording: ws.recordingStream
        ? { name: path.basename(ws.recordingPath), bytes: ws.recordingBytes }
        : null,
      vcam: id === vcamClientId,
    };
  });
}

function sendClients() {
  send(viewerSocket, { type: 'client-list', clients: clientList() });
}

// The dashboard is no longer the only thing that draws the room: a client that
// reports `map` on renders the same top-down view on the phone, so whoever is
// walking the room can see the survey without walking back to the PC. Those
// clients are room *watchers* — they get the same room messages the viewer gets
// and nothing else changes about them.
//
// `bulk` marks a whole-snapshot message (the carved floor, the wall set): those
// are resent on a timer, so a socket with bytes still queued skips one rather
// than pushing a few thousand ints ahead of that client's own pose traffic — it
// shares this socket with pose-config and room-pose. The next push is a second
// away. The dashboard is never skipped: the room is all it is for.
const ROOM_BULK_BACKLOG = 64 * 1024;

function watchingRoom(ws) {
  const m = ws.clientState?.map;
  return m === 'split' || m === 'full';
}

function sendWatchers(obj, { bulk = false } = {}) {
  for (const ws of clients.values()) {
    if (!watchingRoom(ws)) continue;
    if (bulk && ws.bufferedAmount > ROOM_BULK_BACKLOG) continue;
    send(ws, obj);
  }
}

function sendRoom(obj, opts) {
  send(viewerSocket, obj);
  sendWatchers(obj, opts);
}

// What a room view needs from a pose report: who, where, how good it is, and
// which tags were in the frame. The dashboard keeps getting the whole report —
// its tile labels read the camera-frame detail — but a client drawing the map
// does not, and the tag corners and the ARCore matrix are nearly all of it, ten
// times a second, on the same socket as that client's own pose traffic.
function roomPoseMessage(clientId, msg, room) {
  return {
    type: 'pose',
    clientId,
    room,
    tags: (msg.tags || []).map((t) => ({ id: t.id })),
    // Carried through because an empty `tags` means two different things: this
    // frame's detection found none, or there was no detection. The room views
    // draw sight lines from it and must not blink them out on the second.
    carry: !!msg.carry,
  };
}

function closeRecording(ws) {
  if (!ws.recordingStream) return;
  ws.recordingStream.end();
  const mb = (ws.recordingBytes / (1024 * 1024)).toFixed(1);
  log(`Recording saved: ${path.relative(__dirname, ws.recordingPath)} (${mb} MB)`);
  ws.recordingStream = null;
  ws.recordingPath = null;
  sendClients();
}

function openRecording(ws) {
  closeRecording(ws);
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  ws.recordingPath = path.join(
    RECORDINGS_DIR, `${fmtFileStamp(new Date())}_client${ws.clientId}.webm`);
  ws.recordingStream = fs.createWriteStream(ws.recordingPath);
  ws.recordingBytes = 0;
  log(`Recording started: ${path.relative(__dirname, ws.recordingPath)}`);
  sendClients();
}

// Pose journal: every observation the survey consumes, kept so a session can be
// replayed offline against different constants. The survey's tuning — how small
// a tag is too small to trust, how much disagreement means a tag was moved, how
// many estimates make a position — decides whether the map is right, and all of
// it was being argued from a summary line throttled to one every three seconds
// while the numbers that would settle it arrived ten times a second and were
// dropped on the floor. Deliberately independent of the video recorder: pose
// runs whether or not anything is recording, and a session worth replaying is
// usually one where nothing was.
function closePoseJournal(ws) {
  if (!ws.poseJournal) return;
  ws.poseJournal.end();
  log(`Pose journal saved: ${path.relative(__dirname, ws.poseJournalPath)} `
    + `(${ws.poseJournalLines} observations)`);
  ws.poseJournal = null;
  ws.poseJournalPath = null;
}

function journalPose(ws, entry) {
  if (!ws.poseJournal) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    ws.poseJournalPath = path.join(RECORDINGS_DIR,
      `${fmtFileStamp(new Date())}_client${ws.clientId}.pose.jsonl`);
    ws.poseJournal = fs.createWriteStream(ws.poseJournalPath);
    ws.poseJournalLines = 0;
    // The marker size cannot be recovered from the observations — it is the
    // room's only metric datum — and a replay run against the wrong one
    // reproduces nothing. Same reason markers.json carries it.
    ws.poseJournal.write(`${JSON.stringify({
      kind: 'meta',
      at: Date.now(),
      clientId: ws.clientId,
      deviceId: ws.deviceId,
      markerSizeM: POSE_CONFIG.markerSizeM,
    })}\n`);
    log(`Pose journal started: ${path.relative(__dirname, ws.poseJournalPath)}`);
  }
  // Both sides of the transaction: the observation as it arrived and the pose
  // the survey produced from it. A replay that only had the input could not be
  // diffed against what actually happened at the time.
  ws.poseJournal.write(`${JSON.stringify(entry)}\n`);
  ws.poseJournalLines++;
}

function send(socket, obj) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

// A client's own overlay, appended as it reports it. The phone is the only
// place several of these numbers exist — the tracker's churn, the frame count,
// what ARCore is saying about tracking — and reading them means holding the
// phone, which is exactly what cannot be done while walking the room they
// describe. This is that screen, on disk, afterwards.
let overlayStream = null;

function journalOverlay(ws, text) {
  // The client is not trusted to size this. It is a screen's worth of text and
  // nothing more, and a client that says otherwise is not one to hand an
  // unbounded append to.
  if (typeof text !== 'string' || !text) return;
  const body = text.length > 2000 ? `${text.slice(0, 2000)}…[truncated]` : text;
  overlayStream ??= fs.createWriteStream(OVERLAY_FILE, { flags: 'a' });
  overlayStream.write(`[${fmtDateTime(new Date())}] client ${ws.clientId}\n${body}\n\n`);
}

// ---------------------------------------------------------------------------
// Marker survey: turns per-tag camera-frame observations from the clients into
// a persistent room-frame marker map and room-frame client poses.
// The printed marker size is measured, not decided: a printer's "fit to page"
// silently returns a 150 mm marker at ~142 mm, and nothing downstream can tell
// — the room simply comes out uniformly too big. So it is settable from
// /markers and persisted here, ahead of the survey that depends on it.
function loadPoseSettings() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(POSE_SETTINGS_FILE, 'utf8'));
  } catch {
    return;   // no settings yet — the defaults above stand
  }
  if (raw.markerSizeM > 0) POSE_CONFIG.markerSizeM = raw.markerSizeM;
}

function savePoseSettings() {
  const tmp = `${POSE_SETTINGS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ markerSizeM: POSE_CONFIG.markerSizeM }, null, 1));
    fs.renameSync(tmp, POSE_SETTINGS_FILE);
  } catch (err) {
    log(`Could not save pose settings: ${err.message}`);
  }
}

loadPoseSettings();

const survey = createSurvey({
  file: MARKER_MAP_FILE,
  markerSizeM: POSE_CONFIG.markerSizeM,
  log,
});

// Free-space / wall estimate carved from quality-gated pose reports. Consumes
// the same entry objects the pose journal records, so replay-walls.js can
// re-run any session through the identical code path.
const walls = createWalls({
  file: WALLS_FILE,
  markerSizeM: POSE_CONFIG.markerSizeM,
  log,
});

// Per-session landmark map: natural image features the client tracks,
// triangulated from tag-derived camera poses, used to carry a client that has
// walked out of tag view. Fed from the same entry objects walls and the journal
// take, so replay-landmarks.js re-runs any session through this exact code.
//
// Information flows tags -> landmarks, one way, always. Nothing below may reach
// the survey: a landmark never refines a tag, never seeds a promotion, never
// becomes the anchor, and a landmark-derived pose is never handed back for
// survey maintenance. One bad feature must not be able to move the room datum.
const landmarks = createLandmarks({ log });
// Anchors accumulate silently and mostly do not accumulate at all, so this says
// why rather than leaving "no landmarks" to be told apart from "broken" by
// guesswork. The number that matters is the widest viewing arc any one feature
// has been seen through: anchors need *orbiting* motion, and a walk past
// something never builds one however long it is in frame. Measured on recorded
// sessions, normal walking reaches 3-9 deg against a 60 deg gate — so a report
// that says `best arc 8 deg` is the feature working exactly as measured, and one
// that says `narrow-arc` is a room to walk around rather than a bug.
const LANDMARK_LOG_MS = 5000;
let lastLandmarkLog = 0;

function logLandmarks(clientId) {
  if (Date.now() - lastLandmarkLog < LANDMARK_LOG_MS) return;
  lastLandmarkLog = Date.now();
  const s = landmarks.stats();
  const c = s.clients.find((x) => x.clientId === clientId);
  const rej = Object.entries(s.rej).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const n = landmarks.count(clientId);
  const arc = c?.bestSpan ?? 0;
  log(`Landmarks client ${clientId}: ${n} anchor(s) from ${c?.tracks ?? 0} track(s), `
    + `best arc ${arc.toFixed(0)}°`
    // The hint is for the case it explains, and only that one: once anchors are
    // forming, the arc is wide enough and saying so every five seconds is noise.
    + (n ? '' : ` (needs ${LANDMARK_MIN_ARC_DEG}° — orbit a region rather than walk past it)`)
    + `, ${s.observed} obs`
    // Only when it has happened: on a room where nothing moved this is always
    // zero, and a permanent ", 0 stale" trains the eye to skip the field.
    + (s.dropped ? `, ${s.dropped} dropped stale` : '')
    + `, rejected: ${rej}`);
}

// One function for both pose paths, called with the entry after the survey has
// had its say. It either feeds the map or draws on it, never both: a report
// good enough to found anchors is a report that already has a tag-derived pose.
function maintainLandmarks(ws, entry) {
  const { msg, room } = entry;
  const gen = msg.gen;
  if (!msg.points?.length || gen == null) return;
  // The XR page calls it `intrinsics`; /client calls it `intr`. Same thing.
  const intr = msg.intr ?? msg.intrinsics;

  if (landmarkGate(entry)) {
    // The raw fix, never a smoothed one: feeding a filter's output into the map
    // that produced it lets the two agree with each other instead of with the
    // room. Both pose paths report the fix they maintain the survey from.
    landmarks.observe(ws.clientId, msg.points, gen, room.pose, intr);
    // Pushed whenever the map was fed, not only when an anchor appeared. The
    // message carries the *candidates* too, and those move continuously while
    // anchors arrive minutes apart — measured, a 608-report walk produced five
    // pushes, so the candidate cloud and the region cards sat frozen on screen
    // between them while the phone's own guidance updated ten times a second.
    // The push is debounced to 1 Hz, so this costs one snapshot a second while
    // a client is reporting and nothing at all when none is.
    scheduleLandmarkPush();
    logLandmarks(ws.clientId);
    return;
  }
  // No usable tag fix this frame. This is the whole feature: the tags are out
  // of view and the anchors collected while they were visible carry the pose.
  // Anything the survey could still report for itself is left alone — a
  // landmark fix is a last resort, below dead reckoning's first second.
  if (room.pose && room.quality !== 'dead') return;
  const fix = landmarks.solve(ws.clientId, msg.points, gen, intr, room.pose);
  if (!fix) return;
  room.pose = fix.pose;
  room.quality = 'landmark';
  // Not survey-quarantined and not tag-derived, so it must never become
  // permanent evidence anywhere: walls reads exactly this flag.
  room.mapSafe = false;
  room.landmarks = { n: fix.n, inliers: fix.inliers, rms: Math.round(fix.rms * 100) / 100 };
}

// Debounced full-snapshot push: the grid takes evidence at 10 Hz per client
// but the viewer only needs to see it settle, and a snapshot of a real room
// is a few thousand flat ints — cheaper to resend than to diff.
const WALLS_PUSH_MS = 1000;
const WALLS_LOG_MS = 5000;
let wallsPushTimer = null;
let lastWallsLog = 0;

// One snapshot, two audiences: a socket that has just asked for the room, and
// everything already watching it. Built in one place so a newly connected
// viewer and a mid-session push can never describe the grid differently.
function wallsMessages() {
  return [
    { type: 'floor', ...walls.getFloor() },
    { type: 'walls', walls: walls.getWalls() },
  ];
}

function sendWalls(ws) {
  for (const m of wallsMessages()) send(ws, m);
}

function broadcastWalls() {
  for (const m of wallsMessages()) sendRoom(m, { bulk: true });
}

// The anchor cloud, per client. Debounced for the same reason the grid is: it
// grows a few points at a time at 10 Hz and the viewer only needs to see it
// settle. Sent whole rather than diffed — a few hundred triples is cheaper to
// resend than to reconcile, and a client whose anchors were dropped has to be
// able to say so by sending fewer.
const LANDMARK_PUSH_MS = 1000;
let landmarkPushTimer = null;

function landmarkMessage() {
  return {
    type: 'landmarks',
    clients: [...clients.keys()].map((clientId) => ({
      clientId,
      // Position only. A landmark is a bearing-only point with no orientation
      // and no identity worth showing — see the renderers, which draw it
      // deliberately smaller and dimmer than a surveyed tag.
      //
      // Rounded to the millimetre: this goes to the phone as well as the
      // dashboard, once a second, and full float precision more than doubles
      // it for digits no one can see on a 2 px dot.
      anchors: landmarks.forClient(clientId)
        .map((a) => a.p.map((v) => Math.round(v * 1000) / 1000)),
      // The same cloud as regions rather than points, for the drawer. Tiny
      // beside the anchor list and it is what a person can actually read.
      groups: landmarks.groups(clientId),
      // The tracks that have not qualified, with the arc each has reached. Sent
      // alongside rather than folded in: they are a different claim entirely —
      // an anchor is a point the room has been shown to contain, a candidate is
      // one feature's current guess — and the renderers draw them as such.
      candidates: landmarks.candidates(clientId),
    })),
  };
}

function broadcastLandmarks() {
  sendRoom(landmarkMessage(), { bulk: true });
}

function scheduleLandmarkPush() {
  if (landmarkPushTimer) return;
  landmarkPushTimer = setTimeout(() => {
    landmarkPushTimer = null;
    broadcastLandmarks();
  }, LANDMARK_PUSH_MS);
}

function scheduleWallsPush() {
  if (wallsPushTimer) return;
  wallsPushTimer = setTimeout(() => {
    wallsPushTimer = null;
    broadcastWalls();
    if (Date.now() - lastWallsLog > WALLS_LOG_MS) {
      lastWallsLog = Date.now();
      const s = walls.stats();
      const rej = (r) => Object.entries(r).map(([k, v]) => `${k} ${v}`).join(', ');
      log(`Walls: ${s.free} free / ${s.occ} occupied cells (${s.freeM2} m²), `
        + `reports ${s.reports.accepted}/${s.reports.total}`
        + (Object.keys(s.reports.rej).length ? ` (rej: ${rej(s.reports.rej)})` : '')
        + `, rays ${s.rays.accepted}/${s.rays.total}`
        + (Object.keys(s.rays.rej).length ? ` (rej: ${rej(s.rays.rej)})` : '')
        + (s.deduced || s.neg.tags.deposited
          ? `, deduced ${s.deduced} (neg rays ${s.neg.tags.deposited}/${s.neg.tags.total})`
          : ''));
    }
  }, WALLS_PUSH_MS);
}

// Per-device state that has to outlive the browser holding it: capture settings
// and, above all, camera calibration. The browser keeps only its id. See
// devices.js for why, and for how a browser that has lost even that gets its
// identity back.
const registry = createDeviceRegistry({ file: DEVICES_FILE, log });

// Changing the marker size rescales the room, so the survey goes with it:
// every tag position was measured in the old scale and a mixture of the two is
// worse than either.
const MARKER_SIZE_MIN_M = 0.02;
const MARKER_SIZE_MAX_M = 1;

function applyMarkerSize(m) {
  if (!(m >= MARKER_SIZE_MIN_M && m <= MARKER_SIZE_MAX_M)) {
    return { ok: false, error: `marker size must be ${MARKER_SIZE_MIN_M}-${MARKER_SIZE_MAX_M} m` };
  }
  if (m === POSE_CONFIG.markerSizeM) return { ok: true, markerSizeM: m, changed: false };
  POSE_CONFIG.markerSizeM = m;
  savePoseSettings();
  survey.setMarkerSize(m);
  // The grid was carved in the old scale; a rescaled room invalidates it the
  // same way it invalidates the survey.
  walls.setMarkerSize(m);
  walls.setMarkerMap(survey.getMarkerMap());
  scheduleWallsPush();
  // Every anchor position is in the old scale too, and unlike the grid there is
  // no version of them worth rescaling — they cost seconds to collect again.
  landmarks.reset();
  broadcastLandmarks();
  // Clients scale every distance they report by this, so none may keep the
  // old value for even one more pose message.
  for (const client of clients.values()) {
    send(client, { type: 'pose-config', ...POSE_CONFIG });
  }
  sendRoom({ type: 'marker-map', ...survey.getMarkerMap() });
  return { ok: true, markerSizeM: m, changed: true };
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
  sendClients();
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
  sendClients();
}

function clientIdFor(deviceId) {
  // A client that cannot persist an id (or predates the scheme) still gets a
  // number, it just does not survive a reload.
  if (!deviceId) return nextClientId++;
  if (!clientIdsByDevice.has(deviceId)) clientIdsByDevice.set(deviceId, nextClientId++);
  return clientIdsByDevice.get(deviceId);
}

function handleSignal(ws, msg) {
  if (msg.type === 'role') {
    if (msg.role === 'client') {
      ws.role = 'client';
      ws.clientId = clientIdFor(msg.deviceId);
      // Kept as well as the clientId: depth calibration is a property of the
      // physical camera, so it outlives the session-scoped small integer.
      ws.deviceId = msg.deviceId;
      ws.connectedAt = Date.now();
      // The page has normally introduced itself over /api/device/hello already;
      // this refreshes last-seen, and covers a client whose hello never landed.
      registry.touch(ws.deviceId);
      // A reload can land the new socket before the old one's close fires, so
      // retire whatever socket still holds the id — only one owns it.
      const prev = clients.get(ws.clientId);
      if (prev && prev !== ws) prev.close();
      clients.set(ws.clientId, ws);
      log(`Client ${ws.clientId} connected (${clients.size} total)`);
      sendClients();
      // The webcam feed was bound to the socket that just went away; the new
      // one starts a fresh WebM stream, which needs a fresh ffmpeg.
      if (ws.clientId === vcamClientId) startVcam(ws.clientId);
      // The id is the server's to hand out, and the client shows it so a device
      // can be matched with its tile and its recordings.
      send(ws, { type: 'client-id', clientId: ws.clientId });
      // The printed marker size is the server's to declare — a client assuming
      // a different size would scale every distance it reports.
      send(ws, { type: 'pose-config', ...POSE_CONFIG });
      if (viewerSocket) send(ws, { type: 'viewer-ready' });
    } else if (msg.role === 'client-bulk') {
      // A client's second socket, carrying only bulk binary (recorder chunks)
      // so they cannot queue ahead of the client's JSON traffic.
      // Same deviceId as the main socket -> same clientId; recording state
      // stays on the main socket.
      ws.role = 'client-bulk';
      ws.clientId = clientIdFor(msg.deviceId);
      ws.deviceId = msg.deviceId;
    } else if (msg.role === 'viewer') {
      if (viewerSocket && viewerSocket !== ws) {
        // Told, not merely closed. A displaced dashboard sees an ordinary
        // socket close, reconnects two seconds later and displaces this one
        // straight back — two open dashboards trade the slot forever, each
        // showing an empty roster half the time, and every client rebuilds its
        // peer connection on every swap (viewer-ready below). Logged for the
        // same reason: the close handler cannot report it, since this line
        // reassigns the slot before the close event arrives.
        send(viewerSocket, { type: 'viewer-taken' });
        viewerSocket.close();
        log('Viewer displaced by a new dashboard');
      }
      viewerSocket = ws;
      ws.role = 'viewer';
      log('Viewer connected');
      // Catch a driver that appeared since startup. An active feed holds the
      // id it is streaming to, so leave that case alone.
      if (!vcamDeviceId) detectVcam();
      send(ws, { type: 'vcam-state', clientId: vcamClientId, available: !!vcamDeviceId });
      send(ws, { type: 'marker-map', ...survey.getMarkerMap() });
      sendWalls(ws);
      send(ws, landmarkMessage());
      sendClients();
      for (const client of clients.values()) send(client, { type: 'viewer-ready' });
    }
    return;
  }
  if (msg.type === 'client-state') {
    if (ws.role === 'client') {
      const watched = watchingRoom(ws);
      // Copied field by field rather than spread: this object is echoed to the
      // dashboard, and a client should not be able to put arbitrary keys in it.
      ws.clientState = {
        kind: msg.kind === 'xr' ? 'xr' : 'client',
        res: msg.res,
        // What the camera actually delivered, which `ideal` constraints let
        // differ from what was asked for.
        capture: msg.capture && msg.capture.w && msg.capture.h
          ? { w: msg.capture.w, h: msg.capture.h } : null,
        facing: msg.facing === 'user' ? 'user' : msg.facing === 'environment' ? 'environment' : null,
        mic: !!msg.mic,
        pose: !!msg.pose,
        paused: !!msg.paused,
        blank: !!msg.blank,
        // XR only: whether the AR session is actually running.
        session: msg.session === undefined ? null : !!msg.session,
        // Whether this client is drawing the room map itself, and how much of
        // its screen it gives it. Anything but these two is off — the value is
        // also what decides whether the room messages are sent at all.
        map: msg.map === 'split' || msg.map === 'full' ? msg.map : 'off',
      };
      // The XR client shares a browser, and therefore a deviceId, with /client
      // on the same phone. It has no mic, no recorder and no resolution to
      // choose, so storing what it reports would overwrite the settings the
      // capture client on that same phone actually uses. Only a capture
      // client's settings are persisted.
      if (ws.clientState.kind === 'client') {
        registry.setSettings(ws.deviceId, {
          res: ws.clientState.res,
          mic: ws.clientState.mic,
          facing: ws.clientState.facing,
          pose: ws.clientState.pose,
        });
      }
      // A client that has just started watching gets the room as it stands.
      // Waiting for the next survey change or walls push would leave it staring
      // at an empty map for as long as nothing moved.
      if (!watched && watchingRoom(ws)) {
        send(ws, { type: 'marker-map', ...survey.getMarkerMap() });
        sendWalls(ws);
        send(ws, landmarkMessage());
      }
      logClients();
      sendClients();
    }
    return;
  }
  // Naming a device is naming the hardware, not the connection: the name has to
  // outlive both the client id and the browser, so it lives in the registry.
  if (msg.type === 'device-rename') {
    if (ws.role === 'viewer') {
      const target = clients.get(msg.clientId);
      if (target?.deviceId) {
        log(`Client ${msg.clientId} named "${registry.rename(target.deviceId, msg.name)}"`);
        sendClients();
      }
    }
    return;
  }
  // Remote control from the dashboard. The client owns the behaviour — this is
  // only routing — and the action lands in the same setter the client's own
  // button calls, so the two surfaces cannot diverge.
  if (msg.type === 'control') {
    if (ws.role === 'viewer') {
      const target = clients.get(msg.clientId);
      if (target) {
        send(target, { type: 'control', action: msg.action, value: msg.value });
        log(`Control -> client ${msg.clientId}: ${msg.action}=${JSON.stringify(msg.value)}`);
      }
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
  if (msg.type === 'survey-clear') {
    if (ws.role === 'viewer') {
      // Removing the anchor IS the survey reset — same path as double-click
      // removing it, one wipe semantic, not two.
      const anchor = survey.getMarkerMap().anchorId;
      if (anchor != null) survey.removeMarker(anchor);
      const map = survey.getMarkerMap();
      sendRoom({ type: 'marker-map', ...map });
      walls.reset();
      walls.setMarkerMap(map);
      landmarks.reset();
      broadcastLandmarks();
      broadcastWalls();
    }
    return;
  }
  if (msg.type === 'walls-clear') {
    if (ws.role === 'viewer') {
      walls.reset();
      broadcastWalls();
    }
    return;
  }
  if (msg.type === 'marker-remove') {
    if (ws.role === 'viewer' && Number.isInteger(msg.id)) {
      survey.removeMarker(msg.id);
      const map = survey.getMarkerMap();
      sendRoom({ type: 'marker-map', ...map });
      // Removing the anchor resets the survey; the grid and the anchors were
      // measured in that room frame and must not survive into the next one.
      if (map.anchorId == null) {
        walls.reset();
        landmarks.reset();
        broadcastLandmarks();
      }
      walls.setMarkerMap(map);
      broadcastWalls();
    }
    return;
  }
  // What one tag has been doing, for the drawer card the dashboard has open.
  // Polled rather than pushed: only the open card wants it, it is hundreds of
  // samples, and the marker-map push it would otherwise ride on goes to every
  // room watcher several times a second.
  if (msg.type === 'tag-history') {
    if (ws.role === 'viewer' && Number.isInteger(msg.id)) {
      send(ws, { type: 'tag-history', ...survey.getTagHistory(msg.id) });
    }
    return;
  }
  // ARCore tracking loss on an XR client. The client keeps detecting tags
  // through it and falls back to plain `pose` reports, so this is a change of
  // localization mode rather than an outage — but it used to be sent as
  // nothing at all, which reads exactly like a client that went away. Logged on
  // entry and on recovery with a duration, so "how often, how long" is
  // answerable from the log rather than from a gap between journal lines.
  if (msg.type === 'client-overlay') {
    if (ws.role === 'client') journalOverlay(ws, msg.text);
    return;
  }
  if (msg.type === 'xr-tracking') {
    if (ws.role === 'client') {
      if (msg.lost) {
        if (!ws.trackingLostAt) {
          // Both stamps, or the "still lost" reminder below measures its
          // interval from the epoch and fires on the very next ping.
          ws.trackingLostAt = Date.now();
          ws.trackingLostLog = Date.now();
          log(`Client ${ws.clientId} lost ARCore tracking — localizing from tags `
            + 'alone, no carry between sightings');
        } else if (Date.now() - (ws.trackingLostLog || 0) > 10000) {
          // A long outage should not be one line at each end with silence in
          // between; that is the shape that made this invisible before.
          ws.trackingLostLog = Date.now();
          log(`Client ${ws.clientId} still not tracking (${(msg.ms / 1000).toFixed(0)}s)`);
        }
      } else if (ws.trackingLostAt) {
        log(`Client ${ws.clientId} recovered ARCore tracking after `
          + `${(msg.ms / 1000).toFixed(1)}s`);
        ws.trackingLostAt = null;
        ws.trackingLostLog = 0;
      }
      journalPose(ws, { kind: 'xr-tracking', at: Date.now(), msg });
      send(viewerSocket, {
        type: 'client-tracking', clientId: ws.clientId, lost: !!msg.lost, ms: msg.ms });
    }
    return;
  }
  if (msg.type === 'xr-pose') {
    if (ws.role === 'client') {
      // ARCore already knows where the camera is; the tags only say where the
      // room is relative to ARCore's frame.
      const { pose, rawPose, quality, mapChanged, jitter, mapSafe } =
        survey.alignXr(ws.clientId, msg.xr, msg.tags || [], msg.sid ?? null, msg.intrinsics,
          msg.source, msg.xrNow ?? null);
      // One entry object for both consumers: the journal records it and the
      // walls carve from it, so a replayed journal line goes through exactly
      // the code a live report did.
      //
      // `pose` carries the display easing on the alignment (see reportedT in
      // survey.js) and `rawPose` does not. Everything that builds state which
      // outlives the frame reads the raw one — a smoothed pose is the right
      // thing to *look* at and the wrong thing to measure a room with. On the
      // paths that do not ease (the tag-only client), the two are the same
      // object, so nothing has to know which path it is on.
      const entry = {
        kind: 'xr-pose', at: Date.now(), msg,
        room: { pose: rawPose ?? pose, quality, jitter, mapSafe }, mapChanged,
      };
      // Before the journal and every send, so that what is recorded and what is
      // shown are the pose actually being reported. It only ever fills in where
      // the survey had nothing.
      const surveyPose = entry.room.pose;
      maintainLandmarks(ws, entry);
      journalPose(ws, entry);
      // What is *shown* takes the eased pose; what is stored above did not.
      // Only when the survey's own alignment produced it: a landmark fix or a
      // dead-reckon has replaced `entry.room.pose` by now, and neither has an
      // alignment behind it to have eased.
      const shown = pose && entry.room.pose === surveyPose
        ? { ...entry.room, pose }
        : entry.room;
      send(viewerSocket, {
        ...msg, type: 'pose', clientId: ws.clientId, room: shown });
      sendWatchers(roomPoseMessage(ws.clientId, msg, shown));
      // jitter rides back to the client: the measurement needs both the phone's
      // own pose and the room pose, and only this side has both.
      send(ws, {
        type: 'room-pose', pose: shown.pose, quality: shown.quality, jitter,
        landmarks: landmarks.summary(ws.clientId),
        // Where to walk next, for the phone's own map and overlay. Computed
        // here rather than on the client for the same reason every other
        // room-frame answer is: the client knows nothing about the room, and
        // the arc this is derived from is measured in it.
        guide: entry.room.pose ? landmarks.guide(ws.clientId, entry.room.pose) : null });
      if (mapChanged) {
        const map = survey.getMarkerMap();
        sendRoom({ type: 'marker-map', ...map });
        walls.setMarkerMap(map);
      }
      if (walls.handleReport(entry)) scheduleWallsPush();
    }
    return;
  }
  if (msg.type === 'pose') {
    if (ws.role === 'client') {
      // The survey consumes the camera-frame observations and hands back the
      // room-frame pose; the viewer gets both in one message.
      const { pose, quality, mapChanged, mapSafe } = survey.handlePose(msg, ws.clientId);
      const entry = {
        kind: 'pose', at: Date.now(), msg,
        room: { pose, quality, mapSafe }, mapChanged,
      };
      maintainLandmarks(ws, entry);
      journalPose(ws, entry);
      send(viewerSocket, { ...msg, clientId: ws.clientId, room: entry.room });
      sendWatchers(roomPoseMessage(ws.clientId, msg, entry.room));
      // The client cannot know its room pose on its own (the marker map lives
      // here) — reflect it back for the on-client stats overlay.
      send(ws, {
        type: 'room-pose', pose: entry.room.pose, quality: entry.room.quality,
        landmarks: landmarks.summary(ws.clientId) });
      if (mapChanged) {
        const map = survey.getMarkerMap();
        sendRoom({ type: 'marker-map', ...map });
        walls.setMarkerMap(map);
      }
      if (walls.handleReport(entry)) scheduleWallsPush();
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
}

function main() {
  detectVcam();
  probeAssets();
  survey.load();
  walls.load();
  walls.setMarkerMap(survey.getMarkerMap());
  registry.load();
  const tls = loadOrCreateCert();
  const server = https.createServer(tls, serveStatic);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (ws.role !== 'client' && ws.role !== 'client-bulk') return;
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
        closePoseJournal(ws);
        // A reconnect of the same device may already own this id — its state
        // belongs to the new socket, so leave it alone.
        if (clients.get(ws.clientId) !== ws) return;
        clients.delete(ws.clientId);
        // Track ids are meaningful only inside one tracker generation, and a
        // reconnecting client starts a new one. Holding the old anchors would
        // at best waste memory and at worst fuse two different features under
        // one id before the generation change is noticed.
        landmarks.reset(ws.clientId);
        broadcastLandmarks();
        if (ws.clientId === vcamClientId) stopVcam();
        log(`Client ${ws.clientId} disconnected (${clients.size} total)`);
        logClients();
        // To the watchers too, or a client that left keeps a dot on every map
        // still drawing it — the departed socket is exactly the one that can no
        // longer say it has gone.
        sendRoom({ type: 'client-gone', clientId: ws.clientId });
        sendClients();
      } else if (ws === viewerSocket) {
        viewerSocket = null;
        log('Viewer disconnected');
      }
    });

    ws.on('error', () => {});
  });

  // The roster is pushed on every change, but the recording byte count only
  // ever grows — it has no event to hang off, and a size that only moves when
  // something else happens reads as a stalled recording.
  setInterval(() => {
    if (viewerSocket) sendClients();
  }, 1000);

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
