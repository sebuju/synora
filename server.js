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
const { quatRotate, quatConj, snapQuarterTurn } = require('./public/pose-math.js');
const { createDeviceRegistry, modelFromUa } = require('./devices.js');
const { createSettings } = require('./settings.js');

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
// The bulk (recorder-chunk) sockets per client id, held only so a client whose
// main socket is displaced can have its bulk socket retired with it — the bytes
// are attributed to whichever main socket owns the id at the time they arrive.
const bulkSockets = new Map();
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
  if (!settings.get('poseJournalEnabled')) return;
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

// Detection rate the client reported achieving against the interval it was
// asked for (`msg.cost`, from either capture page's rolling-window meter —
// see common.js createCostMeter). The setting says the rate is "attempted, not
// achieved" (settings.js) and nothing checked that until now.
//
// Logged only on a crossing, the same shape as the ARCore tracking-loss log
// above — a level judged against one threshold flaps, the lesson already paid
// for once by depthState (.claude/rules/depth.md), so BEHIND_ON/BEHIND_OFF
// give the verdict two thresholds rather than one.
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

// What a capture client has to be told about the room's tags. Assembled here
// rather than stored, so there is no second copy of the marker size to fall out
// of step with the store.
function poseConfigMessage() {
  return {
    type: 'pose-config',
    markerSizeM: settings.get('markerSizeM'),
    dictionary: POSE_DICTIONARY,
    poseRateMs: settings.get('poseRateMs'),
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
        // XR only: whether that page is sending video and recording it. Null is
        // "this client never said", which is what hides the control — /client
        // always streams and reports nothing here.
        stream: msg.stream === undefined ? null : !!msg.stream,
        // WebXR features the session actually granted, as reconnaissance —
        // string-filtered and capped because this rides to the dashboard.
        xrFeatures: Array.isArray(msg.xrFeatures)
          ? msg.xrFeatures.filter((f) => typeof f === 'string').slice(0, 16)
          : null,
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
      if (map.anchorId == null) walls.reset();
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
        pose: shown.pose, quality: shown.quality, jitter });
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
      } else if (ws === viewerSocket) {
        viewerSocket = null;
        log('Viewer disconnected');
      } else if (ws.role === 'audio-lab') {
        audioLabSockets.delete(ws);
        log(`Audio lab disconnected (${audioLabSockets.size} total)`);
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
