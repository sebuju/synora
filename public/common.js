'use strict';

// Shared between client and viewer pages: signaling connection + WebRTC config.

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// RTP header extension carrying each frame's capture instant on the sender's
// clock — the basis for aligning feeds from several clients.
const ABS_CAPTURE_TIME_URI = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';

// A client that switches apps gets its page frozen, and the OS tears the
// connection down underneath it — the socket stays nominally OPEN and no close
// event ever arrives, so nothing triggers a reconnect. A ping/pong probe is the
// only reliable liveness signal; an unanswered one means the socket is dead.
const PROBE_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 8000;
const RECONNECT_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Device identity.
//
// The browser holds one thing: this id. Everything tied to it — capture
// settings and, far more importantly, camera calibration — lives on the server,
// so clearing site data or changing browser costs nothing but the id itself.
//
// The id is therefore the single point of failure, and it is recoverable two
// ways: the server re-matches a fingerprint of the device (automatic, and only
// trusted when it picks one device out unambiguously), and failing that the
// person is shown the list and asked. Both live below.

const DEVICE_ID_KEY = (role) => `streamer-device-id:${role}`;
// Devices that predate the phone→client rename keep their identity: the uuid is
// read from the old role's key once and copied under the new one.
const DEVICE_ID_LEGACY = (role) => `streamer-client-id:${role.replace(/^client/, 'phone')}`;

function storedDeviceId(role) {
  try {
    return localStorage.getItem(DEVICE_ID_KEY(role))
      || localStorage.getItem(DEVICE_ID_LEGACY(role))
      || null;
  } catch {
    return null;
  }
}

function saveDeviceId(role, id) {
  try {
    localStorage.setItem(DEVICE_ID_KEY(role), id);
  } catch {
    // Storage unavailable (private mode, blocked cookies): the id works for
    // this load, it just does not survive a refresh — and the fingerprint match
    // is what gets it back next time.
  }
}

// Synchronous id for the pages that are not devices (the dashboard) and for a
// page's secondary socket. Mints one if there is none; a device page must use
// resolveDevice() instead, which can recover an id rather than burning a new
// one.
function loadDeviceId(role) {
  const id = storedDeviceId(role) || crypto.randomUUID();
  saveDeviceId(role, id);
  return id;
}

// Small JSON calls to the server. Every one of these sits in front of the
// camera opening, so none of them may hang: a server that does not answer has
// to degrade to defaults rather than leave the page dark.
const API_TIMEOUT_MS = 2000;

async function apiJson(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;   // offline, aborted, or a server that is not there
  } finally {
    clearTimeout(timer);
  }
}

// The GPU string is the strongest single hint that two visits are the same
// physical device: it names the chip, and it survives a browser reinstall. The
// context is thrown away immediately — this is one read, not a renderer.
function gpuRenderer() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name || null;
  } catch {
    return null;
  }
}

// Camera labels, when the browser will say. They are only exposed once camera
// permission has been granted — and clearing site data usually clears that too,
// so the case this whole mechanism exists for is often the case where this
// field is missing. It is worth collecting anyway: the server treats an absent
// field as missing information rather than disagreement, and a client that
// re-announces itself after opening the camera fills it in for next time.
async function cameraLabels() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list
      .filter((d) => d.kind === 'videoinput' && d.label)
      .map((d) => d.label)
      .sort();
  } catch {
    return [];
  }
}

async function deviceFingerprint() {
  const labels = await cameraLabels();
  // Screen dimensions swap with orientation on a phone, so the pair is sorted:
  // a fingerprint that changed when the device was turned would match nothing.
  const a = Math.min(screen.width, screen.height);
  const b = Math.max(screen.width, screen.height);
  return {
    gpu: gpuRenderer(),
    screen: `${a}x${b}@${window.devicePixelRatio}`,
    cameras: labels,
    cores: navigator.hardwareConcurrency ?? null,
    memory: navigator.deviceMemory ?? null,
    platform: navigator.userAgentData?.platform || navigator.platform || null,
    langs: (navigator.languages || [navigator.language]).join(','),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
  };
}

// Resolve who this device is and fetch everything the server holds for it.
// Returns { id, name, settings, intrinsics } — settings and intrinsics are null
// / empty when the server could not be reached, which is what makes the caller
// fall back to its own defaults rather than wait.
async function resolveDevice(role = 'client') {
  const fingerprint = await deviceFingerprint();
  let id = storedDeviceId(role);

  if (!id) {
    // No id. Ask the server who this fingerprint used to be; it answers with an
    // id to adopt only when one device is picked out unambiguously, because two
    // identical phones fingerprint identically and adopting the wrong one hands
    // this phone another phone's camera model.
    const m = await apiJson('/api/device/match', { fingerprint });
    if (m?.adopt) {
      id = m.adopt;
    } else if (m?.candidates?.length) {
      id = await openDevicePicker({
        devices: m.candidates,
        title: 'Which device is this?',
        note: 'This browser has no stored identity. Picking the right one restores '
          + 'its camera calibration and settings.',
      });
    }
    id ||= crypto.randomUUID();
    saveDeviceId(role, id);
  }

  const hello = await apiJson('/api/device/hello', { deviceId: id, fingerprint });
  return {
    id,
    name: hello?.device?.name ?? null,
    settings: hello?.device?.settings ?? null,
    intrinsics: hello?.device?.intrinsics ?? {},
    // The camera labels are usually missing on the load that matters. Calling
    // this again once the camera is open fills them in, so the *next* recovery
    // has a stronger fingerprint to work from.
    async refresh() {
      await apiJson('/api/device/hello', { deviceId: id, fingerprint: await deviceFingerprint() });
    },
  };
}

// ---------------------------------------------------------------------------
// Device picker. Shown automatically when a browser turns up with no id and the
// server cannot tell on its own which device it is; also reachable at any time
// from the id chip, which is the escape hatch for a phone that adopted the
// wrong record or minted a fresh id while the server was unreachable.
//
// Resolves to the chosen device id, or null for "this is a new device".
function openDevicePicker({ devices, title, note, currentId = null }) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'device-picker';

    const panel = document.createElement('div');
    panel.className = 'panel';
    const h = document.createElement('h2');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = note;
    panel.append(h, p);

    const choose = (id) => {
      root.remove();
      resolve(id);
    };

    for (const d of devices) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'device';
      if (d.id === currentId) item.classList.add('current');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = d.name + (d.id === currentId ? ' — this browser now' : '');
      const meta = document.createElement('div');
      meta.className = 'meta';
      // Last seen and what it is calibrated for are what actually tell two of
      // the same phone model apart.
      const cal = d.calibrations?.length
        ? d.calibrations.map((c) => `${c.w}x${c.h} ${c.facing === 'user' ? 'front' : 'rear'}`).join(', ')
        : 'never calibrated';
      meta.textContent = `seen ${fmtAge(Date.now() - d.lastSeenMs)} ago · ${cal}`
        + (d.score !== undefined ? ` · ${Math.round(d.score * 100)}% match` : '');
      item.append(name, meta);
      item.onclick = () => choose(d.id);
      panel.append(item);
    }

    const fresh = document.createElement('button');
    fresh.type = 'button';
    fresh.className = 'device new';
    fresh.textContent = 'This is a new device';
    fresh.onclick = () => choose(null);
    panel.append(fresh);

    root.append(panel);
    document.body.append(root);
  });
}

// Hand the id chip to the picker. Adopting a different device changes the
// calibration and the settings the page is running on, so it reloads rather
// than trying to re-apply half a page's state in place.
function wireDeviceChip(el, role = 'client') {
  if (!el) return;
  el.classList.add('clickable');
  el.title = 'Which device this browser is — tap to change';
  el.onclick = async () => {
    const list = await apiJson('/api/devices');
    if (!list?.devices?.length) return;
    const picked = await openDevicePicker({
      devices: list.devices,
      title: 'Which device is this?',
      note: 'Pick the record this browser should use. Its calibration and capture '
        + 'settings come with it. The page reloads.',
      currentId: storedDeviceId(role),
    });
    if (!picked || picked === storedDeviceId(role)) return;
    saveDeviceId(role, picked);
    location.reload();
  };
}

// Opens the signaling WebSocket, announces our role, auto-reconnects.
// handlers: { onMessage(msg), onOpen(), onClose(), onPong(msg) } — optional.
// deviceId can be passed so a page's secondary socket (bulk uploads) presents
// the same identity as its primary one. It may be a promise: a device page
// resolves its identity against the server before it is entitled to announce
// one, and both of its sockets wait on the same resolution.
// Returns { send(obj), sendBinary(blob), close() }.
function connectSignaling(role, handlers = {}, deviceId) {
  // A capture device's identity is resolved against the server — it may have to
  // be recovered from a fingerprint, or asked about — so those pages pass it in.
  // Falling back to loadDeviceId() here is not a harmless convenience: the
  // default is evaluated at module load, before resolveDevice has even read
  // storage, and it *mints and saves* a fresh id. That silently destroyed the
  // recovery path, and looked exactly like a device that had never been seen.
  if (deviceId === undefined) {
    if (role.startsWith('client')) {
      throw new Error(`connectSignaling('${role}') needs a resolved deviceId`);
    }
    deviceId = loadDeviceId(role);
  }
  let ws = null;
  let closedByUs = false;
  let reconnectTimer = null;
  let rxCount = 0;   // any inbound traffic counts as proof of life

  function scheduleReconnect(delay = RECONNECT_DELAY_MS) {
    if (closedByUs || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function open() {
    if (closedByUs) return;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    const sock = new WebSocket(`wss://${location.host}`);
    ws = sock;
    sock.onopen = async () => {
      const id = await deviceId;
      // The socket may have been superseded or torn down while identity was
      // being resolved; announcing a role on a dead one throws.
      if (sock !== ws || sock.readyState !== WebSocket.OPEN) return;
      sock.send(JSON.stringify({ type: 'role', role, deviceId: id }));
      handlers.onOpen?.();
    };
    sock.onmessage = (ev) => {
      rxCount++;
      if (typeof ev.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        // Pongs are liveness plumbing, but they piggyback server state some
        // pages care about — hand them to a separate hook.
        handlers.onPong?.(msg);
        return;
      }
      handlers.onMessage?.(msg);
    };
    sock.onclose = () => {
      // A superseded socket closing says nothing about the current one.
      if (sock !== ws) return;
      handlers.onClose?.();
      scheduleReconnect();
    };
    sock.onerror = () => sock.close();
  }

  // Confirm the socket is really alive, and reopen it if it is not.
  function probe() {
    if (closedByUs) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      scheduleReconnect(0);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const sock = ws;
    const seq = rxCount;
    sock.send(JSON.stringify({ type: 'ping' }));
    setTimeout(() => {
      // Nothing came back: close so onclose drives the reconnect.
      if (sock === ws && sock.readyState === WebSocket.OPEN && rxCount === seq) sock.close();
    }, PROBE_TIMEOUT_MS);
  }

  open();
  setInterval(probe, PROBE_INTERVAL_MS);
  // Timers are throttled or suspended while hidden, so returning to the
  // foreground is the first chance to notice a connection died — check now
  // instead of waiting out the interval.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') probe();
  });

  return {
    send(obj) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    sendBinary(blob) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(blob);
    },
    // Unsent bytes sitting in the socket. Senders of bulky, droppable data
    // must check this — everything shares one socket, and small
    // time-critical messages queue behind whatever was sent before them.
    get bufferedAmount() {
      return ws?.readyState === WebSocket.OPEN ? ws.bufferedAmount : 0;
    },
    close() {
      closedByUs = true;
      ws?.close();
    },
  };
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

// Age of an instant in three-letter units, one decimal: 3.2 sec, 1.5 min,
// 2.0 hrs, 1.1 day. Every panel that shows how stale something is uses this
// one, so a figure means the same thing wherever it is read. Spelt out and
// spaced because these sit among metres on the same lines, where a bare `m`
// reads as either.
function fmtAge(ms) {
  const s = ms / 1000;
  // Non-breaking: the drawer is narrow and these sit at the end of a wrapped
  // line, where an ordinary space drops the unit onto a line of its own.
  const u = ' ';   // NBSP
  if (s < 60) return `${s.toFixed(1)}${u}sec`;
  if (s < 3600) return `${(s / 60).toFixed(1)}${u}min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}${u}hrs`;
  return `${(s / 86400).toFixed(1)}${u}day`;
}

// A client that left the dashboard leaves a ghost behind rather than a gap —
// see ghostDevice in viewer.js. The reason and sentence live here, shared with
// clients-panel.js, so the tile and the drawer card describing the same client
// cannot end up saying two different things about it.
const GHOST_TEXT = {
  'stream off': 'stream switched off',
  offline: 'client disconnected',
  'no server': 'dashboard lost the server',
};

function ghostNote(reason, at) {
  return `${GHOST_TEXT[reason] || reason} · ${fmtAge(Date.now() - at)}`;
}

// A rolling-window rate/cost meter, shared by both capture pages' detection
// loops. Read live, a chip or a message sent every frame would mostly be
// dividing by a window a fifth of a second old, so the accumulators roll on
// the caller's own loop and a completed window stands until the next one
// closes — a partial only ever fills in before the first roll.
//
// `shape(win, prevReport)` turns the closed window into whatever the caller
// publishes; `win.count(name)`/`win.rate(name)`/`win.mean(name, digits)` read
// the accumulators, and `mean` returns null rather than 0 for an empty bucket
// — "nothing finished in the window" is not "finished at zero cost".
function createCostMeter({ windowMs = 5000, shape }) {
  let from = 0;
  let counts = {};
  let sums = {};
  let out = null;
  let span = windowMs;   // the window `count`/`rate`/`mean` currently describe

  function count(name) {
    return counts[name] || 0;
  }
  function mean(name, digits = 0) {
    const n = counts[name] || 0;
    if (!n) return null;
    const f = 10 ** digits;
    return Math.round((sums[name] || 0) * f / n) / f;
  }
  function rate(name) {
    return Math.round((counts[name] || 0) * 1e4 / Math.max(1, span)) / 10;
  }
  const win = { count, mean, rate };

  return {
    // A count-only event (`blocked`, a dropped frame) has no duration; a timed
    // one (`dets`, `flips`) sums it for `mean` too.
    bump(name, ms) {
      counts[name] = (counts[name] || 0) + 1;
      if (ms !== undefined) sums[name] = (sums[name] || 0) + ms;
    },
    roll(now) {
      if (!from) {
        from = now;
        return;
      }
      if (now - from < windowMs) return;
      span = now - from;
      out = shape(win, out);
      from = now;
      counts = {};
      sums = {};
    },
    report() {
      if (out) return out;
      if (!from) return null;
      // A partial window, for the reader that asks before the first roll.
      span = Math.max(1, performance.now() - from);
      return shape(win, null);
    },
    // The window belongs to whatever was being measured (a session, a track);
    // carried over, its first report after a restart would describe the thing
    // that just ended.
    reset() {
      from = 0;
      counts = {};
      sums = {};
      out = null;
    },
  };
}

// A redraw loop for a view that is only drawn while it is being looked at.
// Both room renderers had their own copy of it — the same `active` flag, the
// same "a frame is already coming" latch, the same draw that re-schedules
// itself — and they differ in one thing: which requestAnimationFrame they
// queue on. That difference is what made one of them wedge.
//
// `/xr-client` queues the map on the *session's* rAF while an immersive session
// is up, because inside one the document's rAF does not run. A session that
// ends with a frame queued never delivers it. With the latch as a plain
// boolean, nothing ever cleared it: the view was dead for the life of the page,
// and re-entering AR could not revive it because scheduling was a no-op.
//
// So the latch is a token rather than a flag. Activating or deactivating mints
// a new one, and a callback from a previous life is dropped: it does not draw,
// and — the part that matters — it does not clear the latch the current life is
// holding.
function createDrawLoop({ nextFrame = (cb) => requestAnimationFrame(cb), draw }) {
  let active = false;
  let pending = false;
  let life = 0;

  function schedule() {
    if (pending || !active) return;
    pending = true;
    const mine = life;
    nextFrame((t) => {
      if (mine !== life) return;
      pending = false;
      draw(t);
    });
  }

  return {
    schedule,
    get active() {
      return active;
    },
    // Idempotent on purpose: callers re-assert the current state (a mode being
    // re-applied, a session starting), and that must schedule a frame without
    // invalidating the one already in flight.
    setActive(on) {
      if (on !== active) {
        life++;
        pending = false;
      }
      active = on;
      if (on) schedule();
    },
  };
}

// Screen blanking. A capture device runs for hours with a wake lock holding the
// display on, and the display is the largest single draw on the phone — nothing
// else a page can switch off comes close. Blanking costs nothing: the camera,
// the recorder, the peer connection and tag detection all keep running, only
// the picture stops being drawn.
//
// `root` is what the black div is mounted on, and that is the whole difference
// between the two callers: on an ordinary page it is the body, but inside an
// immersive-AR session the UA only composites the DOM overlay root's subtree
// over the camera passthrough, so /xr-client has to mount it there or the black
// never reaches the screen.
function createBlankScreen(root, onChange) {
  const el = document.createElement('div');
  el.className = 'blank-screen';
  const hint = document.createElement('span');
  hint.textContent = 'tap to wake';
  el.append(hint);
  // The tap must not reach what is underneath: on /client the feed toggles
  // pause on click, so waking the screen would also unpause it.
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    set(false);
  });
  root.append(el);

  let on = false;
  function set(next) {
    if (next === on) return;
    on = next;
    el.classList.toggle('on', on);
    // Restart the hint's fade so it is readable again on the next blank.
    if (on) {
      hint.style.animation = 'none';
      void hint.offsetWidth;
      hint.style.animation = '';
    }
    onChange?.(on);
  }

  return {
    set,
    toggle() {
      set(!on);
    },
    get on() {
      return on;
    },
  };
}

// Two-click confirmation for a button that forgets something. The first click
// arms it — red, and its title says what the second one will do — and only the
// second acts.
//
// Shared, and with the armed button held module-wide, because the disarming is
// the whole of it: at most one button on the page is armed at a time, anything
// else the pointer goes down on disarms it, and so does taking the pointer
// away. A per-button copy of that leaves two buttons armed at once, which is
// the one state where the wrong one catches the second click.
//
// Not a confirm() dialog: the dashboard repaints four times a second behind a
// modal, and one of these buttons is a hover-revealed icon a modal would take
// the pointer away from.
const CONFIRM_SLACK_PX = 64;   // pointer further than this from the button disarms it
let armedConfirm = null;

function disarmConfirm() {
  armedConfirm?.disarm();
}

function confirmButton(el, onConfirm, { armedTitle = 'Click again to confirm', onArmed } = {}) {
  const idleTitle = el.title;

  // Capture phase: a click on anything else must disarm this before that
  // control's own handler runs, or one gesture reads as two actions.
  function onPointerDown(ev) {
    if (!el.contains(ev.target)) disarm();
  }

  // "Away" with slack rather than a pointerleave: these are small buttons (the
  // per-tag one is 18 px), and a hand that wobbles a pixel off one has not
  // changed its mind. The connectedness check is the other way an armed button
  // leaves — the card it sits on is dropped from the drawer, which is exactly
  // what a confirmed removal does to the tag beside it.
  function onPointerMove(ev) {
    if (!el.isConnected) {
      disarm();
      return;
    }
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - ev.clientX, 0, ev.clientX - r.right);
    const dy = Math.max(r.top - ev.clientY, 0, ev.clientY - r.bottom);
    if (Math.hypot(dx, dy) > CONFIRM_SLACK_PX) disarm();
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape') disarm();
  }

  function arm() {
    if (armedConfirm === handle) return;
    disarmConfirm();
    armedConfirm = handle;
    el.classList.add('confirm');
    el.title = armedTitle;
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('keydown', onKeyDown, true);
    onArmed?.(true);
  }

  function disarm() {
    if (armedConfirm !== handle) return;
    armedConfirm = null;
    el.classList.remove('confirm');
    el.title = idleTitle;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('keydown', onKeyDown, true);
    onArmed?.(false);
  }

  const handle = {
    arm,
    disarm,
    get armed() {
      return armedConfirm === handle;
    },
  };
  el.addEventListener('click', () => {
    if (handle.armed) {
      disarm();
      onConfirm();
    } else {
      arm();
    }
  });
  return handle;
}

// --- Bringing a card into view ----------------------------------------------
// A card opened by something other than a click on itself — a mark clicked in a
// room view, which cannot see the drawer — has to be scrolled to, or the click
// reads as having done nothing.
//
// `scrollIntoView({ block: 'nearest' })` is what this replaces and is not
// enough: it refuses to scroll at all when the card already straddles the
// scrollport, and when it does scroll it leaves an edge flush against the
// drawer's. Both cases put the card's own body — the part the click asked for —
// half off screen.
//
// Deferred by a frame rather than measured in the calling turn. Opening a card
// can also switch its panel on, and a card in a `display: none` column has no
// box to scroll to; a frame lets that display change, the column layout and the
// panel's own repaint all land first. Always deferred, not only on that path:
// one behaviour is easier to trust than two, and a frame is invisible next to a
// card scrolled to the wrong place.
const REVEAL_PAD_PX = 8;
function revealCard(el, pad = REVEAL_PAD_PX) {
  if (!el) return;
  requestAnimationFrame(() => {
    // Re-tested inside the frame, not before it: a card can leave the drawer
    // between the click and here — the tag it named was forgotten, the object
    // was merged away — and a detached or hidden element measures as a zero box
    // at the origin, which scrolls the drawer to the top for no reason.
    if (!el.isConnected || !el.offsetParent) return;
    const box = scrollParent(el);
    if (!box) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const above = (r.top - pad) - b.top;
    const below = (r.bottom + pad) - b.bottom;
    // A card taller than the drawer cannot be shown whole, so its head wins:
    // the name, the position and the first rows are what was asked for, and the
    // charts below them are read by scrolling on from there.
    if (r.height + pad * 2 > b.height || above < 0) box.scrollTop += above;
    else if (below > 0) box.scrollTop += below;
  });
}

// The box a card actually scrolls in. Found rather than named: the panels move
// between columns (drawers.js), so the element above any given card is not
// fixed.
function scrollParent(el) {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

// --- Reusing the elements already on screen ---------------------------------
// Every list on the dashboard arrives as a whole new snapshot — a roster, a
// marker map, a history record — and the obvious rendering of
// a snapshot is to throw the children away and build new ones. That is wrong
// here for the same reason it is wrong in the room views (anim.js): what is on
// screen carries state the snapshot does not. A rebuilt subtree loses the text
// selection under the pointer, the canvas a chart was drawn on, the two-click
// confirmation halfway through, the CSS transition halfway through, and the
// scroll position of the container whose reflow it forced — and this panel
// repaints four times a second, against a map replaced several times a second
// while a survey is being walked.
//
// So: match the arriving snapshot against what is standing, key by key, and
// move what is already there. `make` runs once per key, `paint` runs every
// time. One primitive rather than a loop per list, or the lists drift apart in
// which of these they each remember to preserve.
//
// The handles live in a Map the caller may own (`store`) — the client cards and
// the tag cards keep theirs so the rest of the panel can reach a card by id —
// otherwise in one hung off the parent element. A handle is either the element
// itself or anything carrying it as `.root`.
function syncKeyed(parent, items, { key, make, paint, store, drop } = {}) {
  const map = store || (parent.__syncStore || (parent.__syncStore = new Map()));
  const seen = new Set();
  const ordered = [];
  for (const item of items) {
    const k = key ? key(item) : item;
    seen.add(k);
    let handle = map.get(k);
    if (!handle) {
      handle = make(item, k);
      map.set(k, handle);
    }
    paint?.(handle, item, k);
    ordered.push(handle.root || handle);
  }
  for (const [k, handle] of map) {
    if (seen.has(k)) continue;
    drop?.(handle, k);
    (handle.root || handle).remove();
    map.delete(k);
  }
  orderChildren(parent, ordered);
  return map;
}

// Put `ordered` in that order at the front of `parent`, moving only what is out
// of place: re-inserting an element that is already where it belongs is not
// free — it restarts any CSS transition on it and costs a repaint of anything
// it contains.
//
// `trim` drops whatever is left after them, for a container whose children are
// all managed by this call. Without it a container that empties and is later
// reused keeps its stale tail behind the new children.
function orderChildren(parent, ordered, trim = false) {
  for (let i = 0; i < ordered.length; i++) {
    if (parent.children[i] === ordered[i]) continue;
    parent.insertBefore(ordered[i], parent.children[i] || null);
  }
  if (!trim) return;
  while (parent.children.length > ordered.length) parent.lastElementChild.remove();
}

// A list of plain text lines, the commonest shape of all: a status block, a
// summary, the roster overlay. Each row is { text, cls, color }; the key is the
// position, because these lines are read as a paragraph and a line's identity
// is where it sits in one.
function syncTextRows(parent, rows) {
  syncKeyed(parent, rows.map((row, i) => ({ ...row, i })), {
    key: (row) => row.i,
    make: () => document.createElement('div'),
    paint: (el, row) => {
      if (el.textContent !== row.text) el.textContent = row.text;
      el.className = row.cls || '';
      el.style.color = row.color || '';
    },
  });
}

// How a pose message's camera model should be described and how loudly. Both
// the client overlay and the dashboard tile report this, from the same wire
// fields, so the wording cannot drift between them.
// Level maps to the shared .warn/.bad classes: a model that was rotated or
// rescaled from another resolution is not wrong so much as unverified at the
// resolution in use, and those tiers are exactly where an orientation change
// used to move the map — so they are worth seeing rather than being folded into
// the same "calibrated" as an exact fit. `source` is absent on messages from
// before it existed; fall back to the boolean.
function describeCameraModel(msg) {
  if (msg.source === 'guess') {
    return {
      level: 'bad',
      text: 'UNCALIBRATED',
      long: 'UNCALIBRATED — FOV guess, distances ~5% out; run /calibrate',
    };
  }
  if (msg.source === undefined) {
    // A client from before provenance existed, or the XR path's own model.
    return msg.calibrated
      ? { level: 'ok', text: 'calibrated', long: 'calibrated' }
      : { level: 'bad', text: 'UNCALIBRATED', long: 'UNCALIBRATED' };
  }
  const from = msg.from ? ` from ${msg.from}` : '';
  const scaled = Number.isFinite(msg.scale) && Math.abs(msg.scale - 1) > 1e-6;
  const parts = [];
  let hint = '';
  if (msg.source === 'rotated') parts.push('rotated');
  if (msg.source === 'rotated-approx') {
    parts.push('rotated, turn direction unknown');
    hint = ' — recalibrate in this orientation to pin the principal point';
  }
  if (scaled) parts.push(`scaled x${msg.scale.toFixed(2)}`);
  if (!parts.length) return { level: 'ok', text: 'calibrated', long: 'calibrated' };
  const text = `${parts.join(', ')}${from}`;
  return { level: 'warn', text, long: `${text}${hint}` };
}

// ---------------------------------------------------------------------------
// The room palette. Every view that draws the room reads it from here — the 3D
// scene, both 2D maps, the client drawer, and the XR client's own map. It sat
// in scene.js until the XR client started rendering the top-down map, and that
// page cannot load three.js.

const ROOM_CLIENT_COLORS = [0x4dabf7, 0xffa94d, 0x69db7c, 0xff6b6b, 0xda77f2, 0xffe066];

// The one place a client's colour is picked. The 3D scene, the 2D maps, the
// roster overlay and the client drawer all key off the same id, and a client
// that reads as two different colours across them is worse than no colour.
function roomClientColor(id) {
  return ROOM_CLIENT_COLORS[id % ROOM_CLIENT_COLORS.length];
}

// With an alpha, the same colour as a wash rather than a mark: the drawer tints
// a card's background with the owning client's colour instead of striping its
// edge, and a tint has to be built from the one palette entry rather than being
// a second, hand-picked colour that drifts from it.
function roomClientColorCss(id, alpha = null) {
  const c = roomClientColor(id);
  if (alpha === null) return `#${c.toString(16).padStart(6, '0')}`;
  return `rgba(${(c >> 16) & 255}, ${(c >> 8) & 255}, ${c & 255}, ${alpha})`;
}

// Room axes, indexed the way a position is: x, y, z. Near three.js's own
// AxesHelper defaults, and the helper is told them explicitly rather than left
// on its defaults — the 2D views and the drawer read the same three numbers,
// and an axis that is red in one view and blue in another is worse than no
// colour at all. `ROOM_AXIS_LEN_M` is the helper's length in the 3D scene only,
// where the cross stands at the room origin and is a ruler; the 2D views pin
// theirs to a corner at a fixed pixel size instead (`AXIS_GIZMO_PX`).
// x and z are pulled off their pure primaries: #0000ff is the darkest colour a
// screen can make and #ff0000 the most saturated, and the ordinates printed in
// them were, respectively, unreadable and glaring on the drawer's near-black
// card. Softened, not re-hued, so they stay the red and blue axes everywhere.
const ROOM_AXIS_COLORS = [0xe05c5c, 0x00ff00, 0x4a90d9];
const ROOM_AXIS_NAMES = ['x', 'y', 'z'];
const ROOM_AXIS_LEN_M = 0.5;

function roomAxisColorCss(k) {
  return `#${ROOM_AXIS_COLORS[k].toString(16).padStart(6, '0')}`;
}

// Stable, distinctive colour per tag id — the golden-angle hue walk keeps any
// two ids that appear together visually far apart. Shared by every view that
// labels tags, so tag 3 is the same colour everywhere.
function roomTagColorCss(id) {
  return `hsl(${(id * 137.5) % 360}, 62%, 40%)`;
}

// The anchor is the datum rather than a measurement, and the gold is what says
// so — it stands outside the hue walk on every surface that draws tags (the 2D
// map's bar and chip, the 3D card, the drawer's dot). One constant because
// three copies of a colour whose whole job is "this one is not like the others"
// is exactly the kind of thing that drifts.
const ROOM_ANCHOR_COLOR_CSS = '#d4b34c';
const ROOM_POSE_STALE_MS = 2000;

// A carry report has no detection behind it, so its empty tag list is not a
// statement that nothing is in view — it is the absence of a look. The XR
// client sends several of them between detections; treating each as "no
// tags" made the sight lines to the tags, and every drawer row derived from
// them, blink out and back two or three times a second. What is still true
// is whatever the last actual detection said, so that is what every reader
// of a pose message latches onto instead of the newest message. Shared by
// room-feed.js (the map's sight lines) and viewer.js (the drawer and tile
// label) so the two can never disagree about what is in view.
function lastDetection(prev, msg) {
  return msg.carry ? prev : msg;
}

// Green head-on sliding to red as the view of a tag gets oblique — pose
// quality falls off hard past ~60°.
function roomAngleColor(angleDeg) {
  const badness = Math.min(1, Math.max(0, angleDeg / 75));
  return `hsl(${Math.round(120 * (1 - badness))}, 85%, 55%)`;
}

// ---------------------------------------------------------------------------
// Is the survey still moving this tag? Two surfaces ask — the drawer card's dot
// and the 2D map's tag chip — and they must never answer differently about the
// same tag at the same moment, which is the rule `clientInfo` already holds the
// line on for clients. So it lives here, as one shared instance rather than one
// implementation used twice: the test needs per-tag history, and two histories
// sampled at different instants would settle a tag at two different times.
//
// What settling means is that *refinement is still moving the stored pose*, so
// that is what is measured. Residual alone will not do it: `resid` is smoothed
// and never falls to the few millimetres that read as converged, and reading it
// as the whole answer had every tag saying "settling" forever.
const ROOM_SETTLE_WINDOW_MS = 20000;
const ROOM_SETTLE_MOVE_M = 0.001;
const ROOM_SETTLE_MOVE_DEG = 0.1;
// The marker map is replaced wholesale by every message and carries no history
// of itself, so where each tag was last time is held here. id -> { p, q, stillAtMs }.
const roomSettleHist = new Map();

// 'datum' | 'settled' | 'settling' | 'disputed' | 'unchecked'. A state rather
// than a boolean because the drawer prints a different sentence for each of the
// last three, while the map only needs to know that it is not `settled`.
function tagSettleState(tag, anchorId) {
  // The anchor is where it is by definition and is never refined; a settle
  // verdict on it would be a claim about a measurement that was never made.
  // Decided here rather than at each call site, or the map would re-derive it.
  if (tag.id === anchorId) return 'datum';
  if (!tag.refinedAtMs) {
    // Seen beside a known tag, but every check landed past the reseed
    // threshold — mis-placed, not unobserved. The distinction sends whoever is
    // holding the phone to the right problem.
    return tag.checkedAtMs ? 'disputed' : 'unchecked';
  }
  const now = Date.now();
  // First sight of this tag — a viewer that has just loaded, or a tag promoted
  // a moment ago. Nobody has seen it move, and starting its clock at `now` is a
  // claim that it moved this instant: that is what made every tag on a reloaded
  // viewer read as settling for a full window while the room stood still. The
  // history is a browser-side artefact of watching, not a property of the tag,
  // and the resting state here is *nothing at all* — so the baseline is seeded
  // as though the tag had already been still for a window. A movement anyone
  // actually observes restarts the clock below, for real.
  if (!roomSettleHist.has(tag.id)) {
    roomSettleHist.set(tag.id, { p: tag.p, q: tag.q, stillAtMs: now - ROOM_SETTLE_WINDOW_MS });
  }
  const prev = roomSettleHist.get(tag.id);
  const moved
    = Math.hypot(tag.p[0] - prev.p[0], tag.p[1] - prev.p[1], tag.p[2] - prev.p[2]) > ROOM_SETTLE_MOVE_M
    || quatAngleDeg(tag.q, prev.q) > ROOM_SETTLE_MOVE_DEG;
  // The baseline is the pose as of the last *detected move*, and it is left
  // alone until then — so the question asked is "how long since it moved a
  // millimetre", not "did it move a millimetre since the last time anyone
  // asked". Those differ by the caller's rate: the map queries every frame and
  // the drawer once a second, and against a per-call baseline the tag that
  // walked 255 mm over one session did it at 0.015 mm a frame and would have
  // read as settled throughout on the map while the drawer called it settling.
  if (moved) roomSettleHist.set(tag.id, { p: tag.p, q: tag.q, stillAtMs: now });
  const stillAtMs = moved ? now : prev.stillAtMs;
  // Tiny residual settles it whatever the clock says: there is nothing left for
  // refinement to correct, so a tag still being nudged by micrometres is not a
  // tag anyone should be sent to go and look at. (It was also the cover for a
  // freshly opened viewer calling a converged tag unsettled — that hole is the
  // seeded baseline's job now, and this is left as the claim it always was.)
  const settled = (tag.resid ?? 0) <= 0.005 && (tag.residDeg ?? 0) <= 1
    || now - stillAtMs >= ROOM_SETTLE_WINDOW_MS;
  return settled ? 'settled' : 'settling';
}

// A forgotten tag takes its history with it. If that id ever comes back it is a
// different tag on a different wall, and its predecessor's stillness says
// nothing about it — the same rule `tag-history.js` follows for a hand-removed
// tag.
function forgetTagSettle(id) {
  roomSettleHist.delete(id);
}

// What a surface uses to say "the survey is not done with this one". Both the
// drawer and the 2D map ring the thing rather than recolouring it — the drawer
// outlines the whole card, the map the tag's id chip — leaving the tag's own
// colour to say *which* tag it is; nothing at all is the resting state, so a
// mark always means go and look.
//
// Amber because that is what `.warn` and `.drawer-card.tag.settling` already
// are in style.css — the two must not drift, and the map draws to a canvas and
// cannot read the stylesheet. It does sit near the anchor's gold and the guide's
// (`#ffd166`), which is survivable only because the anchor is `datum` and never
// carries this mark: the two can never appear on the same glyph.
const ROOM_SETTLING_CSS = '#e0a03a';

// Detected objects on the room map. Lives here, not in map2d.js, for the same
// reason every other room colour does: /xr-client draws the same map and cannot
// load scene.js. Deliberately unlike the tag palette and unlike the wall
// strokes — a detected object is an estimate from a neural network, not a
// surveyed mark or carved evidence, and must not be mistaken for either.
const ROOM_OBJECT_CSS = '#7f8fd6';
// And the colour of one the map would actually stand on — promoted, and
// positioned by parallax rather than by a depth prior. The free-space teal at
// full strength rather than a new hue: this is the only other thing the map
// asserts about the room, and a committed object is the same kind of claim.
// Here beside its sibling rather than inside a renderer, because the 2D map and
// the object drawer both draw with it and a second copy is how the two would
// come to disagree about which objects are which.
const ROOM_OBJECT_BEST_CSS = '#7fb8a4';

// ---------------------------------------------------------------------------
// Surveyed tag geometry, as right-angle distances. A map's own coordinates
// cannot be checked against anything, but the distance between two tags can be
// checked against a tape measure — and a tape measure runs along the room, so
// each neighbour carries its three room-axis components as well as the straight
// line. Components are magnitudes: a tape has no sign, and it makes a pair read
// identically from either of its two tags.
//
// Each tag's nearest neighbour, deduplicated into pairs: two tags nearest each
// other are one measurement, not two, and drawing it twice puts two labels on
// the same line. `count` above 1 is there for a caller that wants a tag's whole
// neighbourhood; the room views want the one distance that is easiest to check
// against a tape and hardest to confuse with another.
function markerNeighbourhood(markerMap, count = 1) {
  const tags = [...(markerMap?.markers || [])].sort((a, b) => a.id - b.id);
  const perTag = tags.map((tag) => ({
    tag,
    near: tags
      .filter((b) => b.id !== tag.id)
      .map((b) => ({
        tag: b,
        delta: [0, 1, 2].map((k) => Math.abs(b.p[k] - tag.p[k])),
        d: Math.hypot(...[0, 1, 2].map((k) => b.p[k] - tag.p[k])),
      }))
      .sort((x, y) => x.d - y.d)
      .slice(0, count),
  }));
  const pairs = [];
  const seen = new Set();
  const pairKey = (x, y) => (x < y ? `${x}-${y}` : `${y}-${x}`);
  const add = (a, b, kind) => {
    const key = pairKey(a.id, b.id);
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({
      a,
      b,
      kind,
      delta: [0, 1, 2].map((k) => Math.abs(b.p[k] - a.p[k])),
      d: Math.hypot(...[0, 1, 2].map((k) => b.p[k] - a.p[k])),
    });
  };
  for (const { tag, near } of perTag) {
    for (const n of near) add(tag, n.tag, 'near');
  }
  // Survey chain on top: a tag was measured against its parents, so that link is
  // where its position came from and where any error in it was inherited. Two
  // tags a metre apart that were never measured against each other say nothing
  // about the chain, and a link four metres long that the whole far end hangs
  // off says everything — which is exactly the pair the nearest-neighbour pass
  // leaves out. Only added when that pass did not already draw it.
  const byId = new Map(tags.map((t) => [t.id, t]));
  for (const tag of tags) {
    for (const parentId of tag.from || []) {
      const parent = byId.get(parentId);
      if (parent) add(tag, parent, 'chain');
    }
  }
  return { perTag, pairs };
}

// ---------------------------------------------------------------------------
// Clock sync. Clients and the dashboard run on independent clocks, so frames
// can only be aligned against a shared reference: the server's clock. Probes
// are NTP-style — the sample with the lowest round trip carries the least
// uncertainty — but a single such sample is not enough to hold a session
// together: these clocks drift tens of ppm against the server, so an offset
// measured at startup is tens of milliseconds stale a few minutes later, and
// two clients drifting opposite ways pull their feeds that far apart. Samples
// are kept in a sliding window instead; the low-RTT ones are fitted with a
// line, and its slope is the drift.
const CLOCK_BURST = 8;                 // probes on start and on becoming visible
const CLOCK_BURST_SPACING_MS = 150;
const CLOCK_PROBE_INTERVAL_MS = 2000;
const CLOCK_WINDOW_MS = 120000;
const CLOCK_RTT_TOLERANCE = 1.5;       // fit only samples this close to the best RTT
const CLOCK_FIT_MIN_SAMPLES = 4;
const CLOCK_FIT_MIN_SPAN_MS = 20000;   // a slope measured over less is noise
const CLOCK_MAX_SKEW_PPM = 300;        // steeper than any real crystal
const CLOCK_STEP_MS = 250;             // a jump no round trip could explain

function createClockSync(signaling) {
  // performance.now() is monotonic; Date.now() is not. Android resyncs its
  // wall clock on its own schedule, and a step there would silently move every
  // capture instant this device has already published.
  const localNow = () => performance.now();
  const samples = [];      // { t, offset, rtt }, all on the local clock
  let anchor = 0;          // local time the fit is expressed around
  let base = 0;            // offset at `anchor`
  let skew = 0;            // offset gained per ms of local time
  let bestRtt = Infinity;
  let stepStreak = 0;
  let synced = false;
  let timer = null;
  let visibilityHooked = false;

  function offsetAt(t) {
    return base + skew * (t - anchor);
  }

  function refit() {
    const cutoff = localNow() - CLOCK_WINDOW_MS;
    while (samples.length && samples[0].t < cutoff) samples.shift();
    if (!samples.length) {
      synced = false;
      return;
    }
    // What makes a sample wrong is asymmetry between the two directions, and
    // that can never exceed the round trip itself — so the quickest exchanges
    // are the only ones worth fitting.
    bestRtt = Math.min(...samples.map((s) => s.rtt));
    const good = samples.filter((s) => s.rtt <= bestRtt * CLOCK_RTT_TOLERANCE + 1);
    const span = good[good.length - 1].t - good[0].t;

    if (good.length >= CLOCK_FIT_MIN_SAMPLES && span >= CLOCK_FIT_MIN_SPAN_MS) {
      // Least squares over the window. Anchoring on the newest sample keeps
      // the extrapolation to `now` short, so drift error stays small.
      anchor = good[good.length - 1].t;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const s of good) {
        const x = s.t - anchor;
        sx += x; sy += s.offset; sxx += x * x; sxy += x * s.offset;
      }
      const n = good.length;
      const denom = n * sxx - sx * sx;
      const cap = CLOCK_MAX_SKEW_PPM / 1e6;
      skew = denom > 0 ? Math.max(-cap, Math.min(cap, (n * sxy - sx * sy) / denom)) : 0;
      base = (sy - skew * sx) / n;
    } else {
      // Too little history to tell drift from noise — trust the quickest
      // exchange on its own, as before.
      const best = good.reduce((a, s) => (s.rtt < a.rtt ? s : a));
      anchor = best.t;
      base = best.offset;
      skew = 0;
    }
    synced = true;
  }

  function probe() {
    signaling.send({ type: 'time-ping', t0: localNow() });
  }

  function burst() {
    for (let i = 0; i < CLOCK_BURST; i++) setTimeout(probe, i * CLOCK_BURST_SPACING_MS);
  }

  return {
    // Feed every incoming message here; returns true if it was a clock reply.
    handle(msg) {
      if (msg.type !== 'time-pong') return false;
      const t = localNow();
      const rtt = t - msg.t0;
      // The server wrote its reply somewhere inside the round trip; the
      // midpoint is the best guess and is wrong by at most half the trip.
      const offset = msg.tServer + rtt / 2 - t;
      if (synced && Math.abs(offset - offsetAt(t)) > Math.max(CLOCK_STEP_MS, rtt)) {
        // A server restart, or the device suspending (which stops the
        // monotonic clock but not the world), makes every earlier sample a
        // lie. One wild sample is more likely a reply that sat in a queue, so
        // only a run of them throws the history away.
        if (++stepStreak < 3) return true;
        samples.length = 0;
        stepStreak = 0;
      } else {
        stepStreak = 0;
      }
      samples.push({ t, offset, rtt });
      refit();
      return true;
    },
    // Safe to call again after a reconnect: the timer and the visibility hook
    // are only armed once.
    start() {
      burst();
      if (!timer) timer = setInterval(probe, CLOCK_PROBE_INTERVAL_MS);
      if (!visibilityHooked) {
        visibilityHooked = true;
        // Timers are throttled while hidden, so the window comes back stale —
        // and on a device that suspended, wrong. Re-measure immediately.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') burst();
        });
      }
    },
    // Server-clock time for an instant on the local clock. Detection runs on a
    // worker thread and stamps a frame when it grabs it, so the moment being
    // converted is not always "now" by the time anything asks.
    at(t) {
      return t + offsetAt(t);
    },
    now() {
      const t = localNow();
      return t + offsetAt(t);
    },
    get synced() {
      return synced;
    },
    get uncertaintyMs() {
      return bestRtt / 2;
    },
  };
}

// RTP video clock runs at 90 kHz in a 32-bit field; convert a difference
// between two timestamps to milliseconds, allowing for wraparound.
function rtpDeltaMs(rtp, reference) {
  let diff = (rtp - reference) >>> 0;
  if (diff > 0x80000000) diff -= 0x100000000;
  return diff / 90;
}
