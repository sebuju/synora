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
const { quatRotate, quatConj, snapQuarterTurn, sessionAlignment } = require('./public/pose-math.js');
const { createDeviceRegistry, modelFromUa } = require('./devices.js');
const { createSettings } = require('./settings.js');
const { openFrameLog, readFrameLogMeta } = require('./frame-log.js');
const { decodeFrameRecord, depthAtPixel } = require('./public/frame-wire.js');
const { createObjects } = require('./objects.js');
const { createObjectHistory } = require('./object-history.js');
const { writeFrameImages, writeBoxImage } = require('./frame-images.js');
const { createObjectDetector, objectDetectorAvailable } = require('./object-detector.js');
const { fitOutlines } = require('./outlines.js');

const PORT = Number(process.env.PORT) || 8443;
// How often the server pings each socket at the protocol level. One missed
// round is a drop, so this is also the worst-case lag on noticing a client that
// vanished without closing — a phone whose page was frozen or killed.
const HEARTBEAT_MS = 10000;
// Three of the client's own 5 s ping intervals. Anything less flags a phone
// that merely had a slow moment; anything more and a frozen page sits in the
// roster looking healthy for most of a minute.
const APP_SILENCE_MS = 15000;
// Where everything the server *writes* lives. Overridable because a second
// instance — a replay feed, an experiment, a spare-port server — would
// otherwise overwrite the marker map and the walls grid of the room the real
// one is surveying, and those are the two files in this project that cannot be
// regenerated. Defaults to the repo root, which is where they have always been.
const STATE_DIR = process.env.SYNORA_STATE_DIR || __dirname;
const CERT_DIR = path.join(__dirname, 'certs');
const RECORDINGS_DIR = path.join(STATE_DIR, 'recordings');
const PUBLIC_DIR = path.join(__dirname, 'public');
// One-off measurement rigs (in the spirit of /probe, but not features at
// all) live outside public/ so the app's own pages stay uncluttered by them.
const EXPERIMENTS_DIR = path.join(__dirname, 'experiments');
const FFMPEG = path.join(__dirname, 'tools', 'ffmpeg.exe');
const AKVCAM_MANAGER = path.join(
  process.env.ProgramFiles || 'C:\\Program Files', 'AkVirtualCamera', 'x64', 'AkVCamManager.exe');
const VCAM_WIDTH = 1280;
const VCAM_HEIGHT = 720;
const VCAM_FPS = 30;
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');
const MARKER_MAP_FILE = path.join(STATE_DIR, 'markers.json');
const WALLS_FILE = path.join(STATE_DIR, 'walls.json');
const OBJECTS_FILE = path.join(STATE_DIR, 'objects.json');
// Beside the object map rather than inside it, for the reason the tag history is
// beside the marker map: it is a log *of* a map, not part of one.
const OBJECT_HISTORY_FILE = path.join(STATE_DIR, 'objects-history.json');
const DEVICES_FILE = path.join(STATE_DIR, 'devices.json');
// Named for what it used to hold — the printed marker size, and nothing else.
// Kept under the old name deliberately: it is where every existing install's
// *measured* tag size is stored, and a rename would silently drop rooms back to
// the 150 mm default with nothing anywhere saying so.
const SETTINGS_FILE = path.join(STATE_DIR, 'pose-settings.json');
const LOG_FILE = path.join(STATE_DIR, 'server.log');
// What the capture pages are showing on their own screens, as they show it.
// Separate from server.log on purpose: it is a transcript of one client's
// overlay a few times a second, and interleaving that with the server's own
// narration would bury both.
const OVERLAY_FILE = path.join(STATE_DIR, 'overlay.log');
// The tag family, which is not a setting: the printed sheets, the client
// detector and cv-common.js all have to agree on it, and only one is ever
// built. The measured things about a tag — its size, how often it is looked
// for — live in the settings store below.
const POSE_DICTIONARY = 'DICT_4X4_50';

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

// Byte counts, in the unit a person would have chosen. One helper because the
// recorder, the frame log and the walk verdict all print sizes and had each
// picked their own divisor — one of them in MiB and one in MB, which is a
// difference nobody reading two adjacent log lines could see.
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
function fmtBytes(n) {
  const bytes = Number(n) || 0;
  let i = 0;
  let v = Math.abs(bytes);
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
  // Whole bytes are counts, not measurements; everything above is one decimal.
  const shown = i === 0 ? String(Math.round(v)) : v.toFixed(1);
  return `${bytes < 0 ? '-' : ''}${shown} ${BYTE_UNITS[i]}`;
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
  // Narrower than /api/settings on purpose: the printing page has no business
  // being able to turn the pose journal off.
  if (urlPath === '/api/pose-config') {
    if (req.method === 'GET') {
      sendJson(res, 200, { markerSizeM: settings.get('markerSizeM') });
    } else if (req.method === 'POST') {
      readJson(req, res, (body) => {
        const out = applySettings({ markerSizeM: Number(body.markerSizeM) });
        sendJson(res, out.ok ? 200 : 400, out.ok
          ? { ok: true, markerSizeM: settings.get('markerSizeM'), changed: out.changed.length > 0 }
          : out);
      });
    } else {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }
    return true;
  }

  // Every setting, for anything without a dashboard open — a script, a curl, a
  // second machine. The dashboard uses its own socket instead, so a change made
  // anywhere reaches it without a poll.
  if (urlPath === '/api/settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, spec: settings.spec, values: settings.all() });
    } else if (req.method === 'POST') {
      readJson(req, res, (body) => {
        const out = applySettings(body?.values ?? body);
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
  if (urlPath === '/probe') urlPath = '/probe.html';
  if (urlPath === '/xr-client') urlPath = '/xr-client.html';
  if (urlPath === '/digital') urlPath = '/digital.html';
  if (urlPath === '/audio-lab') urlPath = '/experiments/audio-lab.html';

  // Experiment pages are served from their own folder; everything they share
  // with the app (common.js, style.css) still comes from public/, so the
  // rewrite maps the URL prefix to the folder rather than merging the trees.
  let rootDir = PUBLIC_DIR;
  if (urlPath.startsWith('/experiments/')) {
    rootDir = EXPERIMENTS_DIR;
    urlPath = urlPath.slice('/experiments'.length);
  }
  const filePath = path.join(rootDir, path.normalize(urlPath));
  if (!filePath.startsWith(rootDir)) {
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
      // A validator, because max-age on its own is a cliff: the day it expires
      // the phone has no way to ask "still the same?" and re-pulls all ~10 MB —
      // and the moment /xr-client asks for opencv.js is the moment an XR session
      // is starting, which is the worst moment to spend that. With an ETag the
      // expiry costs a 304. `immutable` is honest here: a vendored lib changes
      // by being re-fetched into the directory, and then so does the tag.
      const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      headers['ETag'] = etag;
      headers['Last-Modified'] = stat.mtime.toUTCString();
      headers['Cache-Control'] = 'public, max-age=604800, immutable';
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      headers['Content-Length'] = stat.size;
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
// The bulk (recorder-chunk) sockets per client id, held only so a client whose
// main socket is displaced can have its bulk socket retired with it — the bytes
// are attributed to whichever main socket owns the id at the time they arrive.
const bulkSockets = new Map();
// The object-frame sockets per client id, held for the same reason as the bulk
// sockets above and retired alongside them. A third socket rather than a second
// meaning for binary on the bulk one: that socket's bytes are recorder chunks
// unconditionally (see the binary handler), and a WebM stream makes no promise
// about its first bytes, so a magic-prefix sniff would be guessing against a
// file nobody wants corrupted. A socket whose role *is* the meaning of its
// bytes is the shape this server already uses.
const frameSockets = new Map();
// Client ids are stable per device: a client persists a random id across
// reloads and presents it on every connection, so a refresh keeps its slot on
// the dashboard (and its recording filenames) instead of taking a new number.
const clientIdsByDevice = new Map();
let nextClientId = 1;
let viewerSocket = null;
// /audio-lab pages (the acoustic ranging experiment). Not clients: no roster
// tile, no recording, no pose — they only relay chirp parameters to each other
// and journal their measurements.
const audioLabSockets = new Set();

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
      // The object channel's counters. They live against the *frames* socket,
      // which is a different socket from this one, so they are looked up by
      // client id rather than read off `ws` — and they survive that socket
      // reconnecting, which is what makes a ratio over a whole walk meaningful.
      obj: objStats.get(id) || null,
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

// The object map, to everyone drawing one.
//
// Wider than `sendRoom` by exactly one case: a client showing the object
// readout but not the room map. `/xr-client` has its own button for that
// readout, and tying it to `watchingRoom` meant pressing it did nothing until
// the map — an unrelated control, carrying the walls grid and the marker map
// with it — was switched on too. This sends the one message that page asked
// for, and none of the rest.
function sendObjects(obj) {
  send(viewerSocket, obj);
  for (const ws of clients.values()) {
    if (watchingRoom(ws)) {
      if (ws.bufferedAmount > ROOM_BULK_BACKLOG) continue;
    } else if (!ws.clientState?.objects) continue;
    send(ws, obj);
  }
}

// What a room view needs from a pose report: who, where, how good it is, and
// which tags were in the frame. The dashboard keeps getting the whole report —
// its tile labels read the camera-frame detail — but a client drawing the map
// does not, and the tag corners and the ARCore matrix are nearly all of it, ten
// times a second, on the same socket as that client's own pose traffic.
// Screen roll: how far this client's video sits rotated from upright, read
// off the room-frame pose already computed for it (never a device sensor).
// Room-up (0,1,0) expressed in the camera's own frame (OpenCV: x-right,
// y-down, z-forward) gives the roll the same way xr-client.js's
// updateScreenRotation reads gravity off ARCore's view orientation for its
// own on-device overlay — but that view frame is y-up where this camera
// frame is y-down, so the screen-up reference flips from (0,1) to (0,-1) and
// the atan2 argument order flips to match.
//
// It is a description of the feed, not an instruction to a renderer: a viewer
// standing this picture back up turns *against* it, where the overlay standing
// its own screen back up turns with it. See style.css's .vwrap.
function updateScreenRoll(ws, pose) {
  if (!pose?.q) return ws.screenRollDeg || 0;   // not localized: hold last value
  const v = quatRotate(quatConj(pose.q), [0, 1, 0]);
  // Camera pointed near straight up/down at a tag — roll is noise there.
  if (Math.hypot(v[0], v[1]) < 0.35) return ws.screenRollDeg || 0;
  const deg = Math.atan2(v[0], -v[1]) * 180 / Math.PI;
  ws.screenRollDeg = snapQuarterTurn(deg, ws.screenRollDeg || 0);
  return ws.screenRollDeg;
}

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

// One directory per client connection — one walk — holding everything that walk
// produced: the recording, the pose journal, the object frames, and an `images`
// subdirectory for the pictures.
//
// A walk is the unit every comparison in this project is actually about ("run
// the replay over these journals, then over those"), and it used to be
// reconstructed by eye from four filenames whose stamps differ by a second or
// two because they open at different moments. A directory says it instead.
//
// Keyed on the *main* socket: the bulk and frames sockets are separate
// connections that share a client id, and their bytes belong to the walk that
// socket is having. A frames socket that somehow arrives with no main socket
// falls back to a directory of its own rather than dropping the walk.
function sessionDir(ws) {
  const main = ws.role === 'client' ? ws : clients.get(ws.clientId);
  const owner = main || ws;
  if (!owner.sessionDir) {
    owner.sessionDir = path.join(RECORDINGS_DIR,
      `${fmtFileStamp(new Date())}_client${owner.clientId}`);
  }
  return owner.sessionDir;
}

// Created on first write, never on connect: a client that records nothing must
// not leave an empty directory behind for every reload.
//
// `seq` disambiguates the second and later files of a kind within one walk —
// the recorder is rebuilt on a camera switch, a resolution change and a mic
// toggle, and the frame log reopens with the XR session.
function sessionPath(ws, name, seq = 0) {
  const dir = sessionDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  if (!seq) return path.join(dir, name);
  const dot = name.indexOf('.');
  return path.join(dir, `${name.slice(0, dot)}-${seq + 1}${name.slice(dot)}`);
}

// Null walks. A client that writes nothing leaves no directory at all (above),
// but one that connects and is cancelled a second later writes just enough to
// make one: a pose journal holding its own meta line, a capture.webm holding a
// WebM header and no picture. Hundreds accumulate from reconnect churn and a
// screen that went off, and every replay run over the corpus pays for each of
// them — `expandJournals` has no notion of a journal too short to bother with.
//
// The verdict is read off the directory and nothing else, never off the socket
// that wrote it, so the disconnect path and the startup sweep cannot drift
// apart and a dry run reports exactly what the real run would act on.
const MIN_WALK_POSE_LINES = 10;
// A WebM header is a few hundred bytes and a single chunk a few kilobytes; at
// 4K recorder bitrates a megabyte is still around a second of video. The floor
// separates "the recorder started" from "there is something to look at", and
// the same question is asked of the frame log, whose preamble is likewise
// present in a file that recorded nothing and whose records are whole JPEGs.
const MIN_WALK_CAPTURE_BYTES = 1024 * 1024;
const MIN_WALK_FRAME_BYTES = 1024 * 1024;
// The journal of a real walk is many megabytes and must not be slurped once per
// directory across a corpus of hundreds, so the line count is a bounded head
// read: a file that fills the window without settling the question is far too
// big to be a null walk.
const WALK_POSE_SCAN_BYTES = 256 * 1024;
// Long after a page has finished tearing down its three sockets, and short
// enough that reconnect churn does not pile up. See pruneWalkLater.
const WALK_PRUNE_DELAY_MS = 2000;
const WALKS_MANIFEST = path.join(RECORDINGS_DIR, '.walks.json');
const MAX_PRUNED_RECORDED = 500;
// On by default: the rule was judged against the whole corpus in dry runs
// before it was switched on, and a null walk left on disk is a walk every
// replay run has to read past. `SYNORA_PURGE_WALKS=0` puts the dry run back —
// the same scan, the same report, nothing deleted — which is what to reach for
// after changing a threshold above.
const PURGE_WALKS = process.env.SYNORA_PURGE_WALKS !== '0';

function countPoseLines(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try {
    const buf = Buffer.alloc(WALK_POSE_SCAN_BYTES);
    const n = fs.readSync(fd, buf, 0, WALK_POSE_SCAN_BYTES, 0);
    let lines = 0;
    for (let i = 0; i < n; i++) if (buf[i] === 0x0a) lines++;
    if (n === WALK_POSE_SCAN_BYTES && lines <= MIN_WALK_POSE_LINES) return Infinity;
    // The meta header is not an observation.
    return Math.max(0, lines - 1);
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

// Record bytes, not file bytes: the preamble's own length is in the file, so
// what a log recorded is a subtraction rather than an estimate, and a log that
// opened and recorded nothing measures exactly zero.
function frameLogBytes(file) {
  const head = readFrameLogMeta(file);
  if (!head) return 0;
  try {
    return Math.max(0, fs.statSync(file).size - head.offset);
  } catch {
    return 0;
  }
}

// Null unless every piece of evidence is absent — a single real capture, a
// single recorded frame or ten observations saves the directory. Returns null
// if the directory is already gone.
function walkVerdict(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let poseLines = 0;
  let captureBytes = 0;
  let frameBytes = 0;
  let other = '';
  for (const name of names) {
    const p = path.join(dir, name);
    // `pose-2.jsonl` and later are real journals of the same walk and count
    // toward it, the way `capture-2.webm` does.
    if (/^pose(-\d+)?\.jsonl$/.test(name)) { poseLines += countPoseLines(p); continue; }
    if (/^capture(-\d+)?\.webm$/.test(name)) {
      try { captureBytes = Math.max(captureBytes, fs.statSync(p).size); } catch { /* gone */ }
      continue;
    }
    if (/^frames(-\d+)?\.frames$/.test(name)) {
      frameBytes += frameLogBytes(p);
      continue;
    }
    // Detections, written offline by detect-objects.js from the frame log
    // beside it. Recognised so it is not mistaken for evidence, and worth
    // nothing on its own: the frames it was read from are already counted, and
    // re-running the detector must not be what saves a walk.
    if (/^frames(-\d+)?\.obj\.jsonl$/.test(name)) continue;
    // The image files are the same frames written a second time, so they are
    // measured with the frame log rather than counted as something unknown —
    // otherwise two JPEGs saved a walk whose frame log holds four bytes, which
    // is what the first dry run of this rule actually did.
    if (/^images(-\d+)?$/.test(name)) {
      try {
        for (const img of fs.readdirSync(p)) {
          try { frameBytes += fs.statSync(path.join(p, img)).size; } catch { /* gone */ }
        }
      } catch { /* gone */ }
      continue;
    }
    // Anything this function does not recognise is evidence it cannot weigh,
    // and the safe reading of evidence it cannot weigh is to keep the walk.
    // Named, not just flagged: a walk kept for a reason the columns cannot show
    // reads as a bug in the rule, and the reason is one word long.
    if (!other) other = name;
  }
  const keep = !!other
    || poseLines >= MIN_WALK_POSE_LINES
    || captureBytes >= MIN_WALK_CAPTURE_BYTES
    || frameBytes >= MIN_WALK_FRAME_BYTES;
  return { keep, poseLines, captureBytes, frameBytes, other };
}

// One row of the verdict, as cells rather than a string: the dry run prints
// hundreds of these and they are read down the column, not along the line, so
// the widths have to be taken across the whole list before anything is printed.
function walkRow(name, v) {
  return [
    name,
    `${v.poseLines} obs`,
    `${fmtBytes(v.captureBytes)} capture`,
    `${fmtBytes(v.frameBytes)} frames`,
    v.other ? `+ ${v.other}` : '',
  ];
}

function walkWidths(rows) {
  const w = [];
  for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] || 0, c.length); });
  return w;
}

// Name left, numbers right: a column of right-aligned figures is comparable at
// a glance and a column of left-aligned ones is not.
function padWalkRow(cells, w) {
  return cells.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join(' | ')
    .replace(/[\s|]+$/, '');   // the last column is empty on most rows
}

// The same cells on a line of their own, for the one-walk case that has no
// column to line up with.
function describeWalk(v) {
  return walkRow('', v).slice(1).join(' | ').replace(/[\s|]+$/, '');
}

// The manifest answers "has this one been judged already", so the corpus is
// inspected once rather than on every start. Read and written whole: the rate
// is one disconnect or one boot, and a cached copy is a second place for the
// sweep and the disconnect path to disagree.
function readWalksManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(WALKS_MANIFEST, 'utf8'));
    return {
      kept: m && typeof m.kept === 'object' && m.kept ? m.kept : {},
      pruned: Array.isArray(m && m.pruned) ? m.pruned : [],
    };
  } catch {
    // Missing or unreadable means nothing has been judged yet, not an error.
    return { kept: {}, pruned: [] };
  }
}

function writeWalksManifest(man) {
  // A dry run leaves no state behind, or the next one would report on a corpus
  // it had already made decisions about.
  if (!PURGE_WALKS) return;
  const pruned = man.pruned.length > MAX_PRUNED_RECORDED
    ? man.pruned.slice(-MAX_PRUNED_RECORDED) : man.pruned;
  try {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    fs.writeFileSync(WALKS_MANIFEST,
      JSON.stringify({ at: Date.now(), kept: man.kept, pruned }, null, 1));
  } catch (err) {
    log(`Could not write ${path.relative(__dirname, WALKS_MANIFEST)}: ${err.message}`);
  }
}

function noteWalk(name, pruned) {
  if (!PURGE_WALKS) return;
  const man = readWalksManifest();
  if (pruned) {
    delete man.kept[name];
    man.pruned.push({ name, at: Date.now(), ...pruned });
  } else {
    man.kept[name] = Date.now();
  }
  writeWalksManifest(man);
}

// `announce` is off for the sweep, which has already printed the walk in its
// table and would otherwise say it twice; a failure is always logged.
function pruneWalk(dir, verdict, announce = true) {
  const rel = path.relative(__dirname, dir);
  if (!PURGE_WALKS) {
    if (announce) log(`Null walk (dry run, would delete): ${rel} - ${describeWalk(verdict)}`);
    return false;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // A handle still open holds a Windows write lock. Say so and leave it;
    // the next start will judge it again.
    log(`Could not delete null walk ${rel}: ${err.message}`);
    return false;
  }
  // A directory that disappears silently is worse than one that stays: the
  // server log is the only place this decision is visible.
  if (announce) log(`Null walk deleted: ${rel} - ${describeWalk(verdict)}`);
  return true;
}

// Deferred, because the bulk and frames sockets are separate connections that
// close in no fixed order around the main one and both write into this
// directory, and because closePoseJournal's stream.end() is asynchronous.
// Unref'd so a pending verdict never holds the process open.
function pruneWalkLater(dir) {
  const timer = setTimeout(() => {
    const verdict = walkVerdict(dir);
    if (!verdict) return;
    const name = path.basename(dir);
    if (verdict.keep) { noteWalk(name, null); return; }
    if (pruneWalk(dir, verdict)) {
      noteWalk(name, {
        poseLines: verdict.poseLines,
        captureBytes: verdict.captureBytes,
        frameBytes: verdict.frameBytes,
      });
    }
  }, WALK_PRUNE_DELAY_MS);
  if (timer.unref) timer.unref();
}

// The corpus that accumulated before any of this existed, swept once at boot.
// Safe to run unconditionally: no client socket exists yet, so nothing under
// recordings/ is mid-write.
function sweepWalks() {
  let entries;
  try { entries = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true }); } catch { return; }
  const man = readWalksManifest();
  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
  // Judged names whose directory is gone, dropped so the manifest tracks the
  // corpus rather than accumulating ghosts.
  const live = new Set(dirs.map(e => e.name));
  for (const name of Object.keys(man.kept)) if (!live.has(name)) delete man.kept[name];

  const nulls = [];
  const keeps = [];
  let cached = 0;
  for (const e of dirs) {
    if (man.kept[e.name]) { cached++; continue; }
    const dir = path.join(RECORDINGS_DIR, e.name);
    const verdict = walkVerdict(dir);
    if (!verdict) continue;
    if (verdict.keep) { man.kept[e.name] = Date.now(); keeps.push({ name: e.name, verdict }); continue; }
    nulls.push({ name: e.name, dir, verdict });
  }
  const kept = cached + keeps.length;

  if (!nulls.length) { writeWalksManifest(man); return; }

  // Every walk on both sides of the line, not a sample, and printed before
  // anything is deleted: the report is how the rule is checked against the
  // corpus by hand, and a truncated list is exactly where the walk that should
  // not have been condemned would hide. It goes to server.log as well as the
  // console, so it can be read after the fact — which, once deleting is on, is
  // the only reading there will be.
  //
  // Both lists in date order, which is what the directory name sorts as: the
  // corpus is remembered as sessions, and a walk is recognised by the afternoon
  // it happened rather than by how much it recorded.
  nulls.sort((a, b) => a.name.localeCompare(b.name));
  keeps.sort((a, b) => a.name.localeCompare(b.name));
  const nullRows = nulls.map(n => walkRow(n.name, n.verdict));
  const keepRows = keeps.map(k => walkRow(k.name, k.verdict));
  // One set of widths across both lists: the two are read against each other.
  const w = walkWidths(nullRows.concat(keepRows));
  log(`Recordings: ${nulls.length} of ${kept + nulls.length} walks are null `
    + `(under ${MIN_WALK_POSE_LINES} obs, ${fmtBytes(MIN_WALK_CAPTURE_BYTES)} capture, `
    + `${fmtBytes(MIN_WALK_FRAME_BYTES)} frames)`);
  // Kept first, condemned last: the list that matters is the one still on
  // screen when the scan stops.
  if (keepRows.length) {
    log(`  keeping ${kept}:`);
    for (const r of keepRows) log(`  ${padWalkRow(r, w)}`);
  }
  log(`  deleting ${nulls.length}:`);
  for (const r of nullRows) log(`  ${padWalkRow(r, w)}`);

  if (!PURGE_WALKS) {
    log('  dry run (SYNORA_PURGE_WALKS=0) - nothing deleted');
    return;
  }

  let gone = 0;
  for (const n of nulls) {
    if (!pruneWalk(n.dir, n.verdict, false)) continue;   // locked; judged again next start
    gone++;
    man.pruned.push({
      name: n.name,
      at: Date.now(),
      poseLines: n.verdict.poseLines,
      captureBytes: n.verdict.captureBytes,
      frameBytes: n.verdict.frameBytes,
    });
  }
  log(`  deleted ${gone} of ${nulls.length}, kept ${kept}`);
  writeWalksManifest(man);
}

function closeRecording(ws) {
  if (!ws.recordingStream) return;
  ws.recordingStream.end();
  log(`Recording saved: ${path.relative(__dirname, ws.recordingPath)} `
    + `(${fmtBytes(ws.recordingBytes)})`);
  ws.recordingStream = null;
  ws.recordingPath = null;
  sendClients();
}

function openRecording(ws) {
  closeRecording(ws);
  ws.recordingSeq = (ws.recordingSeq ?? -1) + 1;
  ws.recordingPath = sessionPath(ws, 'capture.webm', ws.recordingSeq);
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
  if (!settings.get('poseJournalEnabled')) return;
  if (!ws.poseJournal) {
    ws.poseJournalPath = sessionPath(ws, 'pose.jsonl');
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
      markerSizeM: settings.get('markerSizeM'),
    })}\n`);
    log(`Pose journal started: ${path.relative(__dirname, ws.poseJournalPath)}`);
  }
  // Both sides of the transaction: the observation as it arrived and the pose
  // the survey produced from it. A replay that only had the input could not be
  // diffed against what actually happened at the time.
  ws.poseJournal.write(`${JSON.stringify(entry)}\n`);
  ws.poseJournalLines++;
}

// Object frames: the same bargain as the pose journal, for the detector rather
// than the survey. The bytes are kept so a different model or threshold is a
// re-run over one walk instead of another walk, which is the only way a
// detector this experiment does not yet trust can be swapped out cheaply.
//
// The log hangs off the *frames* socket, not the client's main one: it records
// one XR session's pictures, and the frames socket is the thing that lives and
// dies with that session's page.
function closeFrameLog(ws) {
  if (!ws.frameLog) return;
  const { path: p, frames, bytes } = ws.frameLog;
  ws.frameLog.close();
  ws.frameLog = null;
  log(`Object frames saved: ${path.relative(__dirname, p)} `
    + `(${frames} frames, ${fmtBytes(bytes)}`
    + `${ws.imagesWritten ? `, ${ws.imagesWritten} images` : ''})`);
}

// Image files for one frame, on setImmediate rather than inline: the overlay
// costs a decode, a per-pixel blend and a re-encode — tens of milliseconds —
// and the socket handler must not spend that before reading the next frame.
// Dropped rather than queued when it cannot keep up, for the same reason the
// detector drops: a queue here would only ever grow.
function saveFrameImages(ws, record) {
  const want = {
    camera: settings.get('objSaveCamera'),
    depth: settings.get('objDepthImages'),
    overlay: settings.get('objSaveOverlay'),
    quality: settings.get('objFrameQuality'),
  };
  if (!ws.imageDir || (!want.camera && !want.depth && !want.overlay)) return;
  if (ws.imageBusy) return;
  ws.imageBusy = true;
  setImmediate(() => {
    try {
      if (!ws.imagesWritten) fs.mkdirSync(ws.imageDir, { recursive: true });
      const wrote = writeFrameImages(ws.imageDir, record, want);
      if (wrote.camera || wrote.depth || wrote.overlay) ws.imagesWritten++;
    } catch (err) {
      if (!ws.imageErrLogged) {
        ws.imageErrLogged = true;
        log(`Could not write frame images for client ${ws.clientId}: ${err.message}`);
      }
    } finally {
      ws.imageBusy = false;
    }
  });
}

// The detector's own boxes drawn on the frame it looked at.
//
// Separate from `saveFrameImages` because it happens at a different moment: the
// boxes do not exist when the frame arrives, they exist ~160 ms later when
// inference returns. Deferred and guarded like that one, and for the same
// reason — a decode, a draw and a re-encode inside the inference slot would cost
// the channel frames rather than the PC idle time.
function saveBoxImages(ws, record, dets) {
  if (!settings.get('objSaveBoxes') || !ws.imageDir || !dets?.length) return;
  if (ws.boxBusy) return;
  ws.boxBusy = true;
  setImmediate(() => {
    try {
      fs.mkdirSync(ws.imageDir, { recursive: true });
      writeBoxImage(ws.imageDir, record, dets, { quality: settings.get('objFrameQuality') });
    } catch (err) {
      if (!ws.boxErrLogged) {
        ws.boxErrLogged = true;
        log(`Could not write detection overlay for client ${ws.clientId}: ${err.message}`);
      }
    } finally {
      ws.boxBusy = false;
    }
  });
}

// One frame through the detector and into the object map.
//
// Deliberately fire-and-forget: the frame channel is not on the pose path and
// nothing waits for this. A frame whose pose has already fallen out of the ring
// is dropped rather than joined to a neighbouring one — a bearing attached to
// the wrong camera position is not weak evidence, it is wrong evidence, and the
// map has no way to tell afterwards.
async function detectFrame(ws, record) {
  const stat = objStat(ws.clientId);
  stat.offered++;
  if (objBusy.has(ws.clientId)) { stat.busy++; return; }
  if (!objectDetector) {
    const modelFile = settings.get('objDetectorModel');
    if (!objectDetectorAvailable(modelFile)) return;
    objectDetector = createObjectDetector({ modelFile, log });
    // The allow-list follows the model that is actually loaded, not a default:
    // the two vocabularies do not spell the same classes, and a list written
    // against the wrong one maps nothing while looking like an empty room.
    objectDetector.load()
      .then(({ vocab }) => objects.setVocabulary(vocab))
      .catch(() => {});
  }
  objBusy.add(ws.clientId);
  const t0 = Date.now();
  try {
    // Decoded here only when the outline fitter needs the pixels, and then
    // handed to the detector as pixels so the decode is paid for once —
    // `detect()` takes either. With outlines off the buffer goes through
    // untouched and this path costs exactly what it always did.
    const wantOutlines = settings.get('objOutlines');
    const img = wantOutlines
      ? require('jpeg-js').decode(Buffer.from(record.jpeg), { useTArray: true })
      : null;
    const dets = await objectDetector.detect(img || Buffer.from(record.jpeg));
    stat.inferred++;
    stat.ms += Date.now() - t0;
    if (img) {
      const t1 = Date.now();
      fitOutlines(img, dets, { outlineMinPx: settings.get('objOutlineMinPx') });
      stat.outlineMs += Date.now() - t1;
    }
    saveBoxImages(ws, record, dets);
    for (const d of dets) {
      if (!record.depth) continue;
      // Sampled at the box centre, through the same lookup the phone uses at
      // tag centres. Interior to the object, which is the only place on a box
      // where depth is not straddling the silhouette.
      const z = depthAtPixel(record.depth,
        (d.box[0] + d.box[2]) / 2, (d.box[1] + d.box[3]) / 2,
        record.header.w, record.header.h);
      if (z !== null) d.d = z;
    }
    const key = `${ws.frameSid}:${record.header.fseq}`;
    const hit = posesByFseq.get(ws.clientId)?.get(key);
    if (hit) {
      stat.joined++;
      applyDetections(hit, record, dets);
      return;
    }
    // **The frame normally arrives before its own pose.** The phone ships the
    // JPEG as soon as it has decimated it, then hands the same camera read to
    // the tag detector and only reports the pose ~300 ms later when that
    // returns — while inference here takes ~160 ms. So the join almost always
    // fails on the first look, and dropping here meant nothing was ever mapped
    // live even though the offline replay of the same walk mapped it fine.
    //
    // Parked instead, for the pose to collect. Still never joined to a
    // *neighbouring* pose: a bearing attached to the wrong camera position is
    // not weak evidence, it is wrong evidence, and nothing downstream could
    // tell afterwards.
    stat.parked++;
    pendingDets.set(`${ws.clientId}:${key}`, {
      dets, w: record.header.w, h: record.header.h, at: Date.now(),
    });
    while (pendingDets.size > PENDING_MAX) {
      const oldest = pendingDets.keys().next().value;
      pendingDets.delete(oldest);
      // A parked detection whose pose never came is the one loss this path can
      // suffer, so it is counted rather than left to be inferred from a gap
      // between two other numbers.
      objStat(Number(String(oldest).split(':')[0])).evicted++;
    }
  } catch (err) {
    if (!ws.objErrLogged) {
      ws.objErrLogged = true;
      log(`Object detection failed for client ${ws.clientId}: ${err.message}`);
    }
  } finally {
    objBusy.delete(ws.clientId);
  }
}

function openFrameLog_(ws, sid, w, h) {
  closeFrameLog(ws);
  ws.frameSeq = (ws.frameSeq ?? -1) + 1;
  const p = sessionPath(ws, 'frames.frames', ws.frameSeq);
  // `sid` is the join key's other half: the frame header carries `fseq`, which
  // is only unique within a session, and the pose message carries both. A log
  // that could not say which session it recorded would be unjoinable.
  // Held on the socket as well as in the file: the live join needs it on every
  // frame, and re-reading the log to find out which session it is recording
  // would be absurd.
  ws.frameSid = sid ?? null;
  // Re-armed with the log: a socket that opened one unnamed log and then got a
  // proper frames-begin has stopped being the case that was warned about, and
  // should be able to raise it again if it recurs.
  ws.frameSidWarned = false;
  // One `images` subdirectory for the whole walk, not one per frame log: the
  // pictures from a reopened log are the same walk's pictures, and `fseq` keeps
  // rising across the reopen because it is minted per camera read.
  ws.imageDir = path.join(path.dirname(p), 'images');
  ws.imagesWritten = 0;
  ws.frameLog = openFrameLog(p, {
    at: Date.now(),
    clientId: ws.clientId,
    deviceId: ws.deviceId,
    sid: sid ?? null,
    w: w ?? null,
    h: h ?? null,
  });
  log(`Object frames started: ${path.relative(__dirname, p)}`);
}

// Detection rate the client reported achieving against the interval it was
// asked for (`msg.cost`, from either capture page's rolling-window meter —
// see common.js createCostMeter). The setting says the rate is "attempted, not
// achieved" (settings.js) and nothing checked that until now.
//
// Logged only on a crossing, the same shape as the ARCore tracking-loss log
// above — a level judged against one threshold flaps, the lesson already paid
// for once by the depth trust gate, so BEHIND_ON/BEHIND_OFF give the verdict
// two thresholds rather than one.
const BEHIND_ON = 0.75;    // ratio of achieved to target that trips "behind"
const BEHIND_OFF = 0.9;    // ratio that clears it — clears by more than it tripped

function noteDetectRate(ws, cost) {
  if (!cost) return;
  const { detHz, targetMs, askedMs } = cost;
  if (Number.isFinite(detHz) && Number.isFinite(targetMs) && targetMs > 0) {
    const targetHz = 1000 / targetMs;
    const ratio = detHz / targetHz;
    const wasBehind = !!ws.detectBehind;
    const nowBehind = wasBehind ? ratio < BEHIND_OFF : ratio < BEHIND_ON;
    if (nowBehind && !wasBehind) {
      log(`Client ${ws.clientId} behind on detection: ${detHz.toFixed(1)}/s of `
        + `${targetHz.toFixed(1)} asked (${Math.round(targetMs)} ms/detection)`);
    } else if (!nowBehind && wasBehind) {
      log(`Client ${ws.clientId} keeping up on detection again: `
        + `${detHz.toFixed(1)}/s of ${targetHz.toFixed(1)} asked`);
    }
    ws.detectBehind = nowBehind;
  }
  // Where the client is detecting, on the same crossing rule as the rate above.
  // /xr-client is the only page that reports this, and it reports it because it
  // used to be able to lose its detection worker and carry on silently — which
  // read here as a phone that had simply got slow.
  if (cost.det !== undefined) {
    const off = cost.det !== 'worker';
    if (off !== !!ws.detectorOff) {
      log(off
        ? `Client ${ws.clientId} is not detecting: ${cost.detWhy || 'detector unavailable'}`
        : `Client ${ws.clientId} detector back on its worker`);
      ws.detectorOff = off;
    }
  }
  // Separately: the interval the client says it is working to may not be the
  // one this server last asked for — a config push that never arrived, or
  // arrived before a change. Logged once per value, or a client stuck on a
  // stale setting floods the log with the same line every report.
  if (Number.isFinite(askedMs) && askedMs !== settings.get('poseRateMs')
    && ws.detectAskedLogged !== askedMs) {
    ws.detectAskedLogged = askedMs;
    log(`Client ${ws.clientId} detecting at ${askedMs} ms — server is asking for `
      + `${settings.get('poseRateMs')} ms`);
  }
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

// The acoustic ranging experiment's journal (/audio-lab). One shared file per
// server session rather than one per socket: the whole point of the experiment
// is joining what the chirper emitted against what the listener heard, and two
// files would put the join on the reader. Every line carries the sender's
// deviceId and a server-clock stamp for exactly that join.
let audioJournal = null;
let audioJournalPath = null;
let audioJournalLines = 0;

function journalAudio(ws, entry) {
  if (!entry || typeof entry !== 'object') return;
  const line = JSON.stringify({ ...entry, deviceId: ws.deviceId, serverAt: serverNow() });
  // Same stance as journalOverlay: the page is not trusted to size its own
  // append. A measurement event is a handful of numbers, never this.
  if (line.length > 8192) return;
  if (!audioJournal) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    audioJournalPath = path.join(RECORDINGS_DIR, `${fmtFileStamp(new Date())}_audiolab.jsonl`);
    audioJournal = fs.createWriteStream(audioJournalPath);
    audioJournal.write(`${JSON.stringify({ kind: 'meta', at: Date.now() })}\n`);
    log(`Audio journal started: ${path.relative(__dirname, audioJournalPath)}`);
  }
  audioJournal.write(`${line}\n`);
  audioJournalLines++;
}

// ---------------------------------------------------------------------------
// Everything about this server a person is allowed to change, loaded before
// anything that reads one. The printed marker size is the reason the store
// exists: it is measured, not decided — a printer's "fit to page" silently
// returns a 150 mm marker at ~142 mm and nothing downstream can tell, the room
// simply comes out uniformly too big — so it has to be settable at runtime and
// has to survive a restart. What each setting *does* is registered below, once
// the things it does it to exist.
const settings = createSettings({ file: SETTINGS_FILE, log });

// Marker survey: turns per-tag camera-frame observations from the clients into
// a persistent room-frame marker map and room-frame client poses.
const survey = createSurvey({
  file: MARKER_MAP_FILE,
  markerSizeM: settings.get('markerSizeM'),
  log,
});

// Free-space / wall estimate carved from quality-gated pose reports. Consumes
// the same entry objects the pose journal records, so replay-walls.js can
// re-run any session through the identical code path.
const walls = createWalls({
  file: WALLS_FILE,
  markerSizeM: settings.get('markerSizeM'),
  log,
});

// Objects detected in the room and triangulated from their bearings. Reads the
// survey's pose and writes to nothing — not the marker map, not the walls grid,
// not the XR alignment. A second opinion beside the first, and the disagreement
// between them is the diagnostic.
// What each object has been doing over the life of the map — see
// object-history.js. Built here rather than inside `objects` because it is
// anchored on the *survey's* frame: the object map is expressed in it and does
// not own it, and a record stamped with an anchor the survey has since replaced
// is a record of a room that no longer exists.
const objectHistory = createObjectHistory({
  file: OBJECT_HISTORY_FILE,
  log,
  anchorId: () => survey.getMarkerMap().anchorId,
});
// Is there a wall between the camera and this point?
//
// The stale rule's missing input. Not seeing an object that is in frame, in
// range and facing you is evidence it has gone; not seeing one that is behind a
// wall is evidence of the wall. `objects.js` deliberately reads nothing of the
// walls grid, so the question is injected as a predicate rather than imported —
// which also means it is off, and the rule simply loses one gate, wherever no
// walls have been carved.
//
// **A wall an endpoint is standing on cannot be the wall in the way.** A clock,
// a picture and a wall fan are mounted *on* a wall and a phone is often against
// one, so a ray drawn between them crosses that wall — the object is routinely a
// few centimetres past the plane, because the plane is known to about a grid
// cell and the object's own position to rather less.
//
// Measured here: `Fan #388` sits 23 mm beyond the wall at z=0 and was gated from
// everywhere. The first attempt pulled both endpoints in *along the ray*, which
// fails exactly where it matters — looked at from a direction near-parallel to
// the wall, 0.3 m along the ray barely changes the distance to the plane, so the
// endpoint stays on the far side and every sighting is still cut. The margin has
// to be perpendicular to the wall, which is what discarding the segment is.
const WALL_LOS_MARGIN_M = 0.3;
// `getWalls()` regroups planes and re-reads the free set on every call, and this
// is asked once per mapped object per frame. The grid moves over minutes, so a
// few seconds of staleness costs nothing a walk would notice.
const WALL_CACHE_MS = 5000;
let wallSegs = null;
let wallSegsAt = 0;
function wallSegments(now) {
  if (!wallSegs || now - wallSegsAt > WALL_CACHE_MS) {
    wallSegs = walls.getWalls() || [];
    wallSegsAt = now;
  }
  return wallSegs;
}

function segmentsCross(a, b, c, d) {
  const s = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return s(a, b, c) !== s(a, b, d) && s(c, d, a) !== s(c, d, b);
}

// Distance from a room point to a wall segment, in plan view.
function distToSeg(p, a, b) {
  const vx = b[0] - a[0];
  const vz = b[1] - a[1];
  const len2 = vx * vx + vz * vz;
  const t = len2 ? Math.max(0, Math.min(1,
    ((p[0] - a[0]) * vx + (p[2] - a[1]) * vz) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + vx * t), p[2] - (a[1] + vz * t));
}

function lineOfSight(cam, p) {
  const segs = wallSegments(Date.now());
  if (!segs.length) return true;
  // Plan view: the grid this is answered from is 2D, and a wall is a wall at
  // every height it has.
  const from = [cam[0], cam[2]];
  const to = [p[0], p[2]];
  for (const w of segs) {
    if (distToSeg(p, w.a, w.b) < WALL_LOS_MARGIN_M) continue;      // mounted on it
    if (distToSeg(cam, w.a, w.b) < WALL_LOS_MARGIN_M) continue;    // standing against it
    if (segmentsCross(from, to, w.a, w.b)) return false;
  }
  return true;
}

const objects = createObjects({
  file: OBJECTS_FILE,
  log,
  history: objectHistory,
  opts: {
    lineOfSight,
    // The other direction, and the first time the object map has ever written
    // to anything. A sighting is proof the line to it was clear, which is the
    // evidence the grid needs and the only source of it the grid has never had.
    // Cheap: `noteObjectSight` is keyed by viewpoint cell and object, so a walk
    // contributes one line per standpoint per object however many frames it
    // spends there, and re-recording is a map lookup.
    onSight: (cam, p, id) => { if (walls.noteObjectSight(cam, p, id)) wallSegs = null; },
  },
});

// The object detector is loaded lazily and only when a frame actually arrives:
// it is 80 MB resident and the channel is off by default.
let objectDetector = null;
// One inference in flight per client. A backlog would join pictures to poses
// that have already been evicted from the ring below, which is worse than
// dropping the frame — the frame is the cheap half.
const objBusy = new Set();
// Recent poses by (clientId, sid, fseq), for the join. The frame and its pose
// travel on different sockets and are never matched by arrival order.
const posesByFseq = new Map();
const POSE_RING = 64;
let objectsPushTimer = null;

// Detections waiting for the pose of the frame they came from — see detectFrame
// for why that is the normal case rather than the exception.
const pendingDets = new Map();
const PENDING_MAX = 64;

// What the frame channel has actually done, per client, for the roster card.
//
// Counts rather than rates, because the number that matters is a **ratio**: the
// join bug — every frame arriving ~300 ms before its pose, inference finishing
// first, every observation dropped — ran for a whole session with nothing on
// screen or in the log that could have shown it. `joined + collected` against
// `inferred` is that bug, visible.
const objStats = new Map();
function objStat(clientId) {
  let s = objStats.get(clientId);
  if (!s) {
    s = {
      offered: 0, inferred: 0, busy: 0, joined: 0, parked: 0, collected: 0, evicted: 0, ms: 0,
      // Measured apart from inference: what the outline fitter adds is a claim
      // about this step, and a total cannot make it.
      outlineMs: 0,
    };
    objStats.set(clientId, s);
  }
  return s;
}

// What one frame's outlines say about where the camera was, pushed back to the
// phone that took it.
//
// **A readout and nothing else.** It feeds no module, corrects no alignment and
// moves nothing on the phone — it is a second opinion published beside the
// survey's own, and the offset between them is the product. That is the same
// standing `objects.localize` has, and the bar for either changing is zero
// measured false fixes.
//
// The offset is against the survey's own pose *for this frame*, which is the
// only ground truth there is, and the yaw against the session alignment that
// pose implies. Both from the same instant: `hit` carries the session pose the
// room pose was solved for.
// The session-to-room alignment carried from the last frame the survey *could*
// answer, per client. This is "where the phone already thinks it is", and it is
// the only thing that can tell two clocks in two rooms apart — a class label
// cannot, and the picture cannot.
//
// Keyed by XR session: an alignment maps *that* session's frame into the room,
// and the next session has a different origin and a different yaw. Carrying one
// across the boundary would compare a pose against a transform for somewhere
// else entirely.
const shapeAlign = new Map();          // clientId -> { sid, align }

function carriedAlign(hit) {
  const held = shapeAlign.get(hit.clientId);
  return held && held.sid === hit.sid ? held.align : null;
}

function shapeReadout(hit, sizes, dets, note) {
  if (!hit.xr?.q || !hit.K?.fx) return null;
  const withOutline = dets.filter((d) => d.outline);
  if (!withOutline.length) return null;
  const fix = objects.poseFromShape({
    note,
    dets: withOutline, K: hit.K, camW: hit.camW, camH: hit.camH,
    frameW: sizes.w ?? sizes.header?.w, frameH: sizes.h ?? sizes.header?.h,
    qGravity: hit.xr.q,
    // Where the phone already thinks it is, for the tie-breaks — the mirror
    // pair within one object, and rival instances of one class. Absent (a fresh
    // session, or one that has never seen a tag) simply removes that step and
    // the ambiguous cases go back to being refused.
    align: carriedAlign(hit), xr: hit.xr,
    // Who and when, for the window of recent detections the rival tie-break
    // scores against — the discriminator that needs no room pose.
    clientId: hit.clientId, sid: hit.sid, at: hit.at,
    // The tags of this same frame: a printed tag is the best-conditioned quad
    // in the room and a pose solved from one is the survey's own answer coming
    // back round.
    tags: hit.tags,
  });
  if (!fix) return null;
  // The offset is against the survey's own pose for this frame — the only
  // ground truth there is — and there is not always one. Where the survey had
  // nothing, the fix's own room position is the whole of what there is to show,
  // and that is the case this feature was built for rather than a degraded one.
  const truth = hit.pose ? sessionAlignment(hit.xr, hit.pose) : null;
  let dYawDeg = null;
  if (truth) {
    let d = (fix.yaw - truth.yaw) * 180 / Math.PI;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    dYawDeg = d;
  }
  return {
    cls: fix.cls,
    id: fix.id,
    kind: fix.kind,
    by: fix.by,
    rivals: fix.rivals,
    p: fix.p.map((v) => Math.round(v * 100) / 100),
    dPosM: hit.pose
      ? Math.hypot(fix.p[0] - hit.pose.p[0], fix.p[1] - hit.pose.p[1],
        fix.p[2] - hit.pose.p[2])
      : null,
    dYawDeg,
  };
}

function applyDetections(hit, sizes, dets) {
  // The map needs a camera position — a bearing from nowhere is not evidence —
  // so with no room pose this frame feeds nothing and only the shape readout
  // below runs. That asymmetry is the point: one of these two answers "where is
  // that object", the other answers "where am I", and only the first needs the
  // survey to have already succeeded.
  // detection -> the map entry it was associated to, for the debug push below.
  // Empty without a room pose, which is the honest answer: with no camera
  // position nothing was associated to anything this frame.
  let assigned = new Map();
  if (hit.pose) {
    const { changed, assigned: got } = objects.observe({
      sid: hit.sid, at: hit.at, pose: hit.pose, K: hit.K,
      camW: hit.camW, camH: hit.camH,
      frameW: sizes.w ?? sizes.header?.w, frameH: sizes.h ?? sizes.header?.h, dets,
      // Where the tags were in this same frame, so a detection that is really a
      // printed tag can be refused. The survey already knows where every tag is;
      // a copy of one in the object map is a second opinion built from the same
      // evidence.
      tags: hit.tags,
    });
    assigned = got;
    if (changed) scheduleObjectsPush();
  }
  // The debug push. Off by default and skipped for a socket with a backlog —
  // this rides the client's own signaling socket, which also carries its pose
  // traffic, and a stale outline is worth nothing at all.
  if (!settings.get('objOutlineDebug')) return;
  const ws = clients.get(hit.clientId);
  if (!ws || ws.bufferedAmount > ROOM_BULK_BACKLOG) return;
  const outlines = dets.filter((d) => d.outline).map((d) => ({ cls: d.cls, ...d.outline }));
  // The boxes as the detector drew them, in the frame's own pixels, each tagged
  // with the map entry it was associated to.
  //
  // **Only the detections the map took.** The raw stream is the whole
  // vocabulary at a 0.35 score floor — 80 classes or 365 — and the map accepts
  // 18 or 28 of them, refuses anything explained by a printed tag, and refuses
  // anything clipped at the sides of the frame. Pushing the raw stream put
  // boxes on screen for things that are in no list and never will be, which
  // reads as the map having lost them rather than never having wanted them.
  // The id is what lets the phone go further and draw only what its own list is
  // showing, and draw it in that row's colour.
  //
  // This is the one overlay that cannot be in the wrong *place*: the box is the
  // recogniser's own answer replayed through the camera model that produced it,
  // so it lands on the object however wrong the map is about where the object
  // is. Stale by a detection round trip, and that is the whole of its error.
  const boxes = dets.filter((d) => assigned.has(d)).map((d) => ({
    cls: d.cls, score: d.score, box: d.box, id: assigned.get(d),
  }));
  if (!outlines.length && !boxes.length) return;
  // Which test refused, carried with the refusal. "No fix" was as far as the
  // phone could see, and a refusal that cannot name its own test is one nobody
  // can act on while standing in front of the object it refused — which is the
  // only place this is ever read.
  const note = {};
  const fix = shapeReadout(hit, sizes, dets, note);
  send(ws, {
    type: 'obj-shape',
    fseq: hit.fseq ?? null,
    w: sizes.w ?? sizes.header?.w,
    h: sizes.h ?? sizes.header?.h,
    // Whether the survey had an answer for this frame at all. Without it the
    // readout cannot tell "the shape fix agrees with the survey" from "the
    // survey has nothing and this is the only answer there is".
    localized: !!hit.pose,
    outlines,
    boxes,
    fix,
    why: fix ? null : (note.why || null),
  });
}

function rememberPose(clientId, msg, pose) {
  if (msg.fseq == null) return;
  // **A frame is remembered even when the survey had no answer for it.**
  //
  // This used to bail on a missing room pose, which silently switched the whole
  // object channel off exactly where it is most wanted: the shape fix exists to
  // place a camera the survey cannot, and requiring the survey's answer before
  // it may be attempted is backwards.
  //
  // What genuinely cannot be done without ARCore is the solve itself — the
  // gravity-aligned orientation is what makes the unknown a yaw and a
  // translation rather than a full six degrees of freedom. So a frame with
  // neither a room pose nor a session pose is still nothing to keep.
  if (!pose && !msg.xr?.q) return;
  let ring = posesByFseq.get(clientId);
  if (!ring) { ring = new Map(); posesByFseq.set(clientId, ring); }
  const key = `${msg.sid}:${msg.fseq}`;
  const hit = {
    // Null where the survey had nothing. Everything reading this has to handle
    // that: the map needs a camera position and skips, the shape fix does not
    // and runs.
    pose: pose ?? null, at: Date.now(), sid: msg.sid, clientId, fseq: msg.fseq,
    K: msg.intrinsics || msg.intr, camW: msg.w, camH: msg.h,
    // The session pose of the same frame. The shape solve needs a gravity-
    // aligned orientation and ARCore's session frame is one by definition;
    // `pose` is the room-frame answer this is measured *against*, so both have
    // to be the same instant or the offset is a fit to two different moments.
    xr: msg.xr ? { p: msg.xr.p, q: msg.xr.q } : null,
    // Corners only: this is kept for one job — refusing detections that are
    // really the printed tag — and holding the whole tag report would put the
    // solver's rvec/tvec on a path that has no business reading them.
    tags: (msg.tags || []).map((t) => ({ id: t.id, corners: t.corners })),
  };
  ring.set(key, hit);
  // Refreshed from every frame the survey *did* answer, and never from one it
  // did not — this is the carry, and a carry updated from its own guesses is a
  // feedback loop rather than a reference.
  if (pose && msg.xr?.p && msg.xr?.q) {
    const align = sessionAlignment(msg.xr, pose);
    if (align) shapeAlign.set(clientId, { sid: msg.sid, align });
  }
  while (ring.size > POSE_RING) ring.delete(ring.keys().next().value);
  // The other half of the join: detections that got here first.
  const pending = pendingDets.get(`${clientId}:${key}`);
  if (pending && hit.K?.fx) {
    pendingDets.delete(`${clientId}:${key}`);
    objStat(clientId).collected++;
    applyDetections(hit, pending, pending.dets);
  }
}

// Debounced like the walls push and sent {bulk: true} for the same reason: a
// watcher with a backlog is also carrying that client's own pose traffic, and
// the next snapshot is a second away.
function scheduleObjectsPush() {
  if (objectsPushTimer) return;
  objectsPushTimer = setTimeout(() => {
    objectsPushTimer = null;
    sendObjects({ type: 'objects', ...objects.getObjects() });
  }, 1000);
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
  const segs = walls.getWalls();
  return [
    { type: 'floor', ...walls.getFloor() },
    { type: 'walls', walls: segs },
  ];
}

function sendWalls(ws) {
  for (const m of wallsMessages()) send(ws, m);
}

function broadcastWalls() {
  for (const m of wallsMessages()) sendRoom(m, { bulk: true });
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

// What each setting does, wired up now that everything it acts on exists. The
// store validated and persisted the value before any of these ran; all that is
// left here is the effect, and every effect is the same call some other path
// already makes for the same reason (a wipe, a re-push, a broadcast).
//
// Changing the marker size rescales the room, so the survey goes with it: every
// tag position was measured in the old scale and a mixture of the two is worse
// than either.
settings.on('markerSizeM', (m) => {
  survey.setMarkerSize(m);
  // The grid was carved in the old scale; a rescaled room invalidates it the
  // same way it invalidates the survey.
  walls.setMarkerSize(m);
  walls.setMarkerMap(survey.getMarkerMap());
  scheduleWallsPush();
  broadcastPoseConfig();
  sendRoom({ type: 'marker-map', ...survey.getMarkerMap() });
  log(`Marker size set to ${(m * 1000).toFixed(0)} mm — survey and carve reset`);
});

settings.on('poseRateMs', (ms) => {
  broadcastPoseConfig();
  log(`Detection interval set to ${ms} ms`);
});

// The grid is deliberately kept — it is measured evidence of the room, and the
// wipe that throws it away is its own control in the dashboard.
settings.on('wallsEnabled', (on) => log(`Wall carving ${on ? 'enabled' : 'disabled'}`));

// Close what is open rather than leaving half-written files behind: a journal
// is read by the replay tools, and one that simply stops mid-session with no
// end is indistinguishable from a server that crashed.
settings.on('poseJournalEnabled', (on) => {
  if (!on) for (const client of clients.values()) closePoseJournal(client);
  log(`Pose journal ${on ? 'enabled' : 'disabled'}`);
});

// Same reason: a frame log left open after the clients stopped feeding it looks
// like a session that is still running.
settings.on('objFramesEnabled', (on) => {
  if (!on) for (const set of frameSockets.values()) for (const f of set) closeFrameLog(f);
  log(`Object frames ${on ? 'enabled' : 'disabled'}`);
});

// Dropped rather than swapped: the session holds ~80 MB and the next frame
// rebuilds it, which also re-reads the class names and re-declares the
// vocabulary. Doing it here rather than at the next frame's expense would mean
// loading a model nobody has asked to use yet.
settings.on('objDetectorModel', (file) => {
  objectDetector?.close();
  objectDetector = null;
  log(`Object detector set to ${file} — loading on the next frame`);
});

// What a capture client has to be told about the room's tags. Assembled here
// rather than stored, so there is no second copy of the marker size to fall out
// of step with the store.
function poseConfigMessage() {
  return {
    type: 'pose-config',
    markerSizeM: settings.get('markerSizeM'),
    dictionary: POSE_DICTIONARY,
    poseRateMs: settings.get('poseRateMs'),
    // The object-frame channel rides the same message rather than growing one
    // of its own: it is paced by the same page, on the same frame loop, and a
    // second config message would be a second thing that can arrive late.
    objFramesEnabled: settings.get('objFramesEnabled'),
    objFrameRateMs: settings.get('objFrameRateMs'),
    objFrameLongEdge: settings.get('objFrameLongEdge'),
    objFrameQuality: settings.get('objFrameQuality'),
    objFrameDepth: settings.get('objFrameDepth'),
  };
}

// Clients scale every distance they report by the marker size and pace their
// detection by the interval, so none may keep an old value for even one more
// pose message.
function broadcastPoseConfig() {
  for (const client of clients.values()) send(client, poseConfigMessage());
}

// The dashboard renders the settings form from the schema, so it never has to
// know what settings exist — a new one in settings.js appears in the drawer
// with no viewer change at all. `out` is the outcome of the attempt that
// prompted the message, absent when nothing prompted it (the initial push).
function settingsMessage(out = null) {
  return {
    type: 'settings',
    spec: settings.spec,
    values: settings.all(),
    error: out && !out.ok ? out.error : null,
    changed: out?.changed ?? [],
  };
}

// The one way in, whichever door was used: the dashboard's socket and the
// /markers page's HTTP route both land here.
//
// The dashboard is told the outcome whether or not it was the one that asked —
// a size applied from the printing page has to be on screen at once rather than
// at the next reload, and a value the store *refused* has to reach the form
// that offered it, since nothing in the drawer is optimistic and the field
// would otherwise sit showing a number the server never took.
function applySettings(patch, asker = null) {
  const out = settings.set(patch);
  if (out.changed?.length || asker === viewerSocket) send(viewerSocket, settingsMessage(out));
  return out;
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
      // Kept as well as the clientId: the camera calibration and capture
      // settings stored under it are properties of the physical device, so it
      // outlives the session-scoped small integer.
      ws.deviceId = msg.deviceId;
      ws.connectedAt = Date.now();
      // The page has normally introduced itself over /api/device/hello already;
      // this refreshes last-seen, and covers a client whose hello never landed.
      registry.touch(ws.deviceId);
      // A reload can land the new socket before the old one's close fires, so
      // retire whatever socket still holds the id — only one owns it.
      const prev = clients.get(ws.clientId);
      if (prev && prev !== ws) {
        // Said out loud, because the interesting case is not a reload. A page
        // Android froze keeps its sockets looking open from here — there is no
        // server-side heartbeat — so a phone whose owner gave up and opened a
        // fresh tab arrives as a displacement, with a dead page still holding
        // the id. Silently, that read as an ordinary connect. How long the old
        // socket had held it is the tell: seconds is a reload, minutes is a
        // page that stopped answering a while ago.
        const heldMs = prev.connectedAt ? Date.now() - prev.connectedAt : null;
        log(`Client ${ws.clientId} displaced an earlier page`
          + (heldMs === null ? '' : ` (it had held the id ${(heldMs / 1000).toFixed(0)}s)`));
        prev.close();
        // And the bulk socket that was feeding it. Binary is written to
        // whichever main socket holds the id *now*, so a chunk still in flight
        // from the page being displaced would land in the new page's file and
        // interleave two WebM streams into one. Unreachable while only /client
        // recorded — with the XR client recording too, one phone can have two
        // recorders and the same deviceId. The surviving page reconnects its
        // own bulk socket and its recording-start opens a fresh file, so no
        // WebM header is lost.
        for (const b of bulkSockets.get(ws.clientId) || []) b.close();
        // And its object-frame socket, for the same reason one level up: a
        // frame still in flight from the displaced page would be logged under
        // the new page's session, joining a picture from one walk to a pose
        // from another.
        for (const f of frameSockets.get(ws.clientId) || []) f.close();
      }
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
      send(ws, poseConfigMessage());
      if (viewerSocket) send(ws, { type: 'viewer-ready' });
    } else if (msg.role === 'client-bulk') {
      // A client's second socket, carrying only bulk binary (recorder chunks)
      // so they cannot queue ahead of the client's JSON traffic.
      // Same deviceId as the main socket -> same clientId; recording state
      // stays on the main socket.
      ws.role = 'client-bulk';
      ws.clientId = clientIdFor(msg.deviceId);
      ws.deviceId = msg.deviceId;
      // Held so a displaced main socket can take its bulk socket with it — see
      // the retire step above.
      if (!bulkSockets.has(ws.clientId)) bulkSockets.set(ws.clientId, new Set());
      bulkSockets.get(ws.clientId).add(ws);
    } else if (msg.role === 'client-frames') {
      // A client's third socket, carrying only object frames (a small JPEG
      // behind the header in public/frame-wire.js). Separate from the bulk
      // socket so a frame cannot queue behind a second of WebM, and separate
      // from signaling so it cannot queue in front of a pose.
      ws.role = 'client-frames';
      ws.clientId = clientIdFor(msg.deviceId);
      ws.deviceId = msg.deviceId;
      if (!frameSockets.has(ws.clientId)) frameSockets.set(ws.clientId, new Set());
      frameSockets.get(ws.clientId).add(ws);
    } else if (msg.role === 'audio-lab') {
      ws.role = 'audio-lab';
      ws.deviceId = msg.deviceId;
      audioLabSockets.add(ws);
      log(`Audio lab connected (${audioLabSockets.size} total)`);
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
      send(ws, settingsMessage());
      send(ws, { type: 'marker-map', ...survey.getMarkerMap() });
      sendWalls(ws);
      send(ws, { type: 'objects', ...objects.getObjects() });
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
        // Whether this client is drawing the object readout. Separate from
        // `map` because it wants only the object map and none of the rest of
        // the room feed — tying it to `map` meant its own button did nothing
        // until an unrelated control was switched on too.
        objects: !!msg.objects,
        // XR only: whether that page is sending video and recording it. Null is
        // "this client never said", which is what hides the control — /client
        // always streams and reports nothing here.
        stream: msg.stream === undefined ? null : !!msg.stream,
        // WebXR features the session actually granted, as reconnaissance —
        // string-filtered and capped because this rides to the dashboard.
        xrFeatures: Array.isArray(msg.xrFeatures)
          ? msg.xrFeatures.filter((f) => typeof f === 'string').slice(0, 16)
          : null,
        // XR only. A page that answers this socket but cannot start a session
        // is indistinguishable from a frozen one from anywhere except its own
        // screen, which is the one place nobody can read it from. Capped: it
        // is a client-supplied string on its way to the dashboard.
        detector: typeof msg.detector === 'string' ? msg.detector.slice(0, 80) : null,
        canStart: msg.canStart === undefined ? null : !!msg.canStart,
        // The page holds a session object that has stopped delivering frames.
        // Only the page can know this — there is no property on XRSession that
        // admits the session is gone, so it is measured from the frame loop.
        stalled: !!msg.stalled,
      };
      // Logged on the crossing only, like the detection-rate and detector-path
      // lines: the state is reported several times a second and only its
      // changes are news.
      const st = ws.clientState;
      if (st.kind === 'xr' && st.canStart !== null) {
        // Two different ways to be unable to start, and telling them apart is
        // the point: waiting on the detector is a page working correctly, while
        // believing in a session that has already gone is the state that reads
        // as a frozen tab — every tap swallowed by an overlay that outlived the
        // session it belonged to.
        const why = st.canStart ? null
          : st.stalled ? 'it still believes a session is running, but no XR frames are arriving'
            : st.session ? null            // an ordinary session, nothing to say
              : `detector ${st.detector || 'unknown'}`;
        // Once per socket, whatever the value. The crossing log below only
        // speaks when something changes, which says nothing at all about a page
        // that arrives already in the state being chased — and a reconnect is
        // the one moment a page that has stopped responding to its user will
        // still describe itself.
        if (!ws.xrStateLogged) {
          ws.xrStateLogged = true;
          log(`Client ${ws.clientId} xr page state: detector ${st.detector}`
            + `, session ${st.session ? 'held' : 'none'}`
            + `, stalled ${st.stalled}, canStart ${st.canStart}`);
        }
        if (why !== (ws.startBlockedWhy ?? null)) {
          if (why) log(`Client ${ws.clientId} cannot start a session: ${why}`);
          else if (ws.startBlockedWhy) log(`Client ${ws.clientId} can start a session again`);
          ws.startBlockedWhy = why;
        }
      }
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
      }
      // The object readout is its own switch, so it gets its own snapshot —
      // a client that turns it on while standing still would otherwise wait for
      // something in the room to change before anything appeared.
      if (watchingRoom(ws) || ws.clientState?.objects) {
        send(ws, { type: 'objects', ...objects.getObjects() });
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
  // One frame log per XR session, announced on the frames socket itself so the
  // session id travels with the pictures rather than being inferred from
  // whatever pose happened to arrive nearby.
  if (msg.type === 'frames-begin') {
    if (ws.role === 'client-frames') openFrameLog_(ws, msg.sid, msg.w, msg.h);
    return;
  }
  // Audio-lab coordination, fanned to the other audio-lab pages verbatim:
  // chirp-params keeps a listener's matched filter tuned to the chirp actually
  // in the air (the sweep changes it every few seconds), range-round announces
  // a ranging exchange, range-report carries each side's two chirp timestamps
  // — the BeepBeep math needs both and each device only measures its own.
  if (msg.type === 'chirp-params' || msg.type === 'range-round' || msg.type === 'range-report'
    || msg.type === 'beacon-params') {
    if (ws.role === 'audio-lab') {
      for (const other of audioLabSockets) if (other !== ws) send(other, msg);
    }
    return;
  }
  if (msg.type === 'audio-log') {
    if (ws.role === 'audio-lab') journalAudio(ws, msg.entry);
    return;
  }
  // /audio-lab asking where it is standing. Deliberately NOT the `pose` branch
  // below: that one surveys, journals, feeds the walls grid, and pushes a
  // roster the measurement rig has no business appearing in.
  // This one reads the map and answers. The rig gets a room-frame position
  // without becoming a client — which is the same line `audio-lab` already
  // holds on settings and recording.
  if (msg.type === 'locate') {
    if (ws.role !== 'audio-lab') return;
    const r = survey.locate(msg);
    send(ws, { type: 'located', seq: msg.seq ?? null, ...r });
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
      broadcastWalls();
      // The object map is expressed in the same room frame and must not
      // survive into the next one, exactly like the grid. The record of it goes
      // with it: every position in there is relative to an anchor that has just
      // stopped existing.
      objects.reset(map.anchorId);
      objectHistory.clear();
      sendObjects({ type: 'objects', ...objects.getObjects() });
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
  if (msg.type === 'settings-set') {
    if (ws.role === 'viewer') applySettings(msg.values, ws);
    return;
  }
  if (msg.type === 'marker-remove') {
    if (ws.role === 'viewer' && Number.isInteger(msg.id)) {
      survey.removeMarker(msg.id);
      const map = survey.getMarkerMap();
      sendRoom({ type: 'marker-map', ...map });
      // Removing the anchor resets the survey; the grid was measured in that
      // room frame and must not survive into the next one.
      if (map.anchorId == null) {
        walls.reset();
        objects.reset(null);
        objectHistory.clear();
        sendObjects({ type: 'objects', ...objects.getObjects() });
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
  // The same bargain for objects, and for the same reasons — see above.
  if (msg.type === 'object-history') {
    if (ws.role === 'viewer' && Number.isInteger(msg.id)) {
      send(ws, { type: 'object-history', ...objectHistory.get(msg.id) });
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
  // A capture page reporting its own failure. Worth a log line of its own
  // rather than the overlay journal: these are the events that precede a page
  // going silent, and the whole difficulty in chasing that has been that the
  // page's last words were never recorded anywhere this side of the LAN.
  if (msg.type === 'client-error') {
    if (ws.role === 'client' && typeof msg.what === 'string') {
      log(`Client ${ws.clientId} reports: ${msg.what.slice(0, 300)}`);
    }
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
      const { pose, rawPose, quality, mapChanged, jitter, mapSafe, quarantined } =
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
        // `quarantined` distinguishes "mapSafe false because the alignment is
        // stale" from "the room frame itself is in doubt". Journalled so
        // replays can reproduce the decision.
        room: { pose: rawPose ?? pose, quality, jitter, mapSafe, quarantined }, mapChanged,
      };
      // Before the journal and every send, so that what is recorded and what is
      // shown are the pose actually being reported. It only ever fills in where
      // the survey had nothing.
      const surveyPose = entry.room.pose;
      entry.room.roll = updateScreenRoll(ws, entry.room.pose);
      journalPose(ws, entry);
      noteDetectRate(ws, msg.cost);
      // The raw survey pose, not the eased one shown below: the object map is
      // measuring geometry, and the easing exists to make a dot move nicely.
      // Same rule the survey applies to its own extend and refine paths.
      rememberPose(ws.clientId, msg, surveyPose);
      // What is *shown* takes the eased pose; what is stored above did not.
      // Only when the survey's own alignment produced it: a dead-reckon has
      // replaced `entry.room.pose` by now and has no alignment behind it to
      // have eased.
      const shown = pose && entry.room.pose === surveyPose
        ? { ...entry.room, pose }
        : entry.room;
      send(viewerSocket, {
        ...msg, type: 'pose', clientId: ws.clientId, room: shown });
      sendWatchers(roomPoseMessage(ws.clientId, msg, shown));
      // jitter rides back to the client: the measurement needs both the phone's
      // own pose and the room pose, and only this side has both.
      send(ws, {
        // Which of the dots on the room map is this client. Its own number is
        // this side's to hand out, and a client drawing the map has no other way
        // to pick itself out of the poses it is being sent for everybody.
        type: 'room-pose', clientId: ws.clientId,
        pose: shown.pose,
        // The frame the object map is measured in, sent beside the one that is
        // shown. `pose` above carries the display easing (see smoothedReport),
        // and the client fits its whole room<-session transform from this
        // message — so a transform fitted to `pose` is a transform fitted to the
        // filter, and every object projected through it comes out displaced by
        // whatever correction is still being absorbed. Measured on a walk:
        // zero between corrections, 217 mm at worst, which at 1.5 m is 8° of
        // arc between a box and the thing it is drawn around.
        rawPose: entry.room.pose,
        quality: shown.quality, jitter });
      if (mapChanged) {
        const map = survey.getMarkerMap();
        sendRoom({ type: 'marker-map', ...map });
        walls.setMarkerMap(map);
      }
      if (settings.get('wallsEnabled') && walls.handleReport(entry)) scheduleWallsPush();
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
      entry.room.roll = updateScreenRoll(ws, entry.room.pose);
      journalPose(ws, entry);
      noteDetectRate(ws, msg.cost);
      rememberPose(ws.clientId, msg, entry.room.pose);
      send(viewerSocket, { ...msg, clientId: ws.clientId, room: entry.room });
      sendWatchers(roomPoseMessage(ws.clientId, msg, entry.room));
      // The client cannot know its room pose on its own (the marker map lives
      // here) — reflect it back for the on-client stats overlay.
      send(ws, {
        type: 'room-pose', clientId: ws.clientId,
        pose: entry.room.pose, quality: entry.room.quality });
      if (mapChanged) {
        const map = survey.getMarkerMap();
        sendRoom({ type: 'marker-map', ...map });
        walls.setMarkerMap(map);
      }
      if (settings.get('wallsEnabled') && walls.handleReport(entry)) scheduleWallsPush();
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
  // Said once, and only as a fact about this checkout: the object channel is an
  // experiment that is off by default, so a missing model is not a fault.
  const model = settings.get('objDetectorModel');
  if (!objectDetectorAvailable(model)) {
    log(`Object detection disabled: models/${model} missing — run "npm run fetch-vendor"`);
  }
}

function main() {
  detectVcam();
  probeAssets();
  survey.load();
  walls.load();
  walls.setMarkerMap(survey.getMarkerMap());
  objects.load(survey.getMarkerMap().anchorId);
  // After the survey, which is what decides the anchor the record is checked
  // against, and after the map, so the log reads in the order things happened.
  objectHistory.load();
  registry.load();
  const tls = loadOrCreateCert();
  const server = https.createServer(tls, serveStatic);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      // Any inbound byte proves the page's main thread ran. Stamped before the
      // dispatch so a message that turns out to be unhandled still counts —
      // liveness is the question here, not usefulness.
      ws.lastMsgAt = Date.now();
      if (isBinary) {
        // Binary means one thing per role, and the role is the only thing that
        // says which. On the frames socket it is an object frame; on the client
        // and bulk sockets it stays a recorder chunk, unconditionally, exactly
        // as it always has.
        if (ws.role === 'client-frames') {
          if (!settings.get('objFramesEnabled')) return;
          const record = decodeFrameRecord(data);
          // A frame that will not decode came from a socket that lied about its
          // role. Dropped loudly rather than guessed at — the alternative is
          // writing whatever it is into a file the offline detector will read.
          if (!record) {
            if (!ws.frameBadLogged) {
              ws.frameBadLogged = true;
              log(`Client ${ws.clientId}: bad object-frame header, dropping`);
            }
            return;
          }
          // No frames-begin arrived (an older page, or a socket that
          // reconnected mid-session). Open a log anyway rather than dropping
          // the walk; it simply cannot name the session it belongs to.
          if (!ws.frameLog) openFrameLog_(ws, null, record.header.w, record.header.h);
          // And say so, once. A log with no session id cannot be joined to a
          // pose — the key is `sid:fseq` — so every detection made from these
          // frames is discarded and the object map gains nothing for as long as
          // this socket lasts. That used to be completely silent: the pictures
          // arrived, the detector ran, and the room simply never learned an
          // object. The bytes are still worth keeping for an offline pass.
          if (ws.frameSid === null && !ws.frameSidWarned) {
            ws.frameSidWarned = true;
            log(`Client ${ws.clientId} object frames name no session — nothing they see can be placed`);
          }
          // Recorded before it is looked at, and recorded whether or not the
          // detector is even installed: the bytes are the durable half. A model
          // can be re-run over them; a walk cannot.
          ws.frameLog.write(data);
          saveFrameImages(ws, record);
          detectFrame(ws, record);
          return;
        }
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
        // Before the displacement check below: a displaced socket's walk is its
        // own directory — the socket that replaced it has a different one — and
        // it is exactly the kind that turns out to hold nothing.
        if (ws.sessionDir) pruneWalkLater(ws.sessionDir);
        // A reconnect of the same device may already own this id — its state
        // belongs to the new socket, so leave it alone.
        if (clients.get(ws.clientId) !== ws) return;
        clients.delete(ws.clientId);
        if (ws.clientId === vcamClientId) stopVcam();
        log(`Client ${ws.clientId} disconnected (${clients.size} total)`);
        logClients();
        // To the watchers too, or a client that left keeps a dot on every map
        // still drawing it — the departed socket is exactly the one that can no
        // longer say it has gone.
        sendRoom({ type: 'client-gone', clientId: ws.clientId });
        sendClients();
      } else if (ws.role === 'client-bulk') {
        const set = bulkSockets.get(ws.clientId);
        set?.delete(ws);
        if (set && !set.size) bulkSockets.delete(ws.clientId);
      } else if (ws.role === 'client-frames') {
        closeFrameLog(ws);
        const set = frameSockets.get(ws.clientId);
        set?.delete(ws);
        if (set && !set.size) frameSockets.delete(ws.clientId);
      } else if (ws === viewerSocket) {
        viewerSocket = null;
        log('Viewer disconnected');
      } else if (ws.role === 'audio-lab') {
        audioLabSockets.delete(ws);
        log(`Audio lab disconnected (${audioLabSockets.size} total)`);
      }
    });

    ws.on('error', () => {});
    // Liveness, from this end. Everything about whether a client is still there
    // has until now been the client's job — it pings, and an unanswered ping is
    // how *it* learns the socket died. Nothing ran in this direction, so a page
    // Android froze left a socket that stays open here forever: the roster kept
    // listing it, the dashboard kept drawing it, and the log recorded no
    // disconnect. That is not a cosmetic gap. It is the diagnostic surface for
    // this whole system, and twice it reported a healthy client that had in
    // fact stopped existing two minutes earlier — which is exactly the evidence
    // used to rule out the page having died.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });

  // Two different deaths, and only both together tell them apart.
  //
  // The protocol ping answers "is the connection there". The browser's network
  // stack replies to it without waking the page, so it detects a socket that
  // has gone, not a page that has stopped running.
  //
  // A page that stops running is what actually happens here — Android freezing
  // or killing a backgrounded renderer — and the tell is the *application*
  // ping, `{type:'ping'}` from common.js every 5 s, which only a live main
  // thread can send. A socket that pongs but has sent nothing for three of
  // those intervals is a frozen page. That state used to be completely
  // invisible: the roster listed the client, the dashboard drew it, and there
  // was no disconnect in the log, so it read as a perfectly healthy phone.
  setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (ws.role === 'client' && ws.lastMsgAt) {
        const quiet = now - ws.lastMsgAt;
        const silent = quiet > APP_SILENCE_MS;
        if (silent !== !!ws.appSilent) {
          log(silent
            ? `Client ${ws.clientId} page has stopped running — nothing sent for ${(quiet / 1000).toFixed(0)}s, socket still open`
            : `Client ${ws.clientId} page is running again`);
          ws.appSilent = silent;
        }
      }
      if (ws.isAlive === false) {
        if (ws.clientId !== undefined) {
          log(`Client ${ws.clientId} stopped answering — dropping the ${ws.role || 'unknown'} socket`);
        }
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  // The roster is pushed on every change, but the recording byte count only
  // ever grows — it has no event to hang off, and a size that only moves when
  // something else happens reads as a stalled recording.
  setInterval(() => {
    if (viewerSocket) sendClients();
  }, 1000);

  sweepWalks();

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
