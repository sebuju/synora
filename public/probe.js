'use strict';

// Probe: asks this device what it will actually hand over, and makes it prove
// it. Three answers, all of them per-device and per-browser facts that no spec
// sheet gives:
//
// - What WebXR grants, and how far its tracking drifts over a walked loop —
//   the only thing that matters for using it as a pose source.
// - Every sensor the browser exposes, with its live values. A class existing
//   is a browser answer; numbers moving is a hardware one, and the two are
//   routinely different.
// - The browser flags and permissions that decide the rest, since a refused
//   feature and an unset toggle look identical from inside the page.
//
// It was the WebXR half alone to begin with (`/xr-probe`), and the reasoning
// that built it generalised: ARCore's depth is computed from motion stereo on
// the ordinary camera, so it does not need a depth sensor, and world tracking
// needs even less; whether a given phone grants camera-access alongside it is
// a per-device, per-Chrome-version fact. This page reports what was granted
// rather than what should be, and now does so for everything on the device.
//
// Two things an AR session needs that are easy to miss, and both look like the
// same symptom (a black screen that does nothing):
// - A WebGL base layer. The compositor draws the camera passthrough *behind*
//   the session's layer; with no layer there is nothing to composite into and
//   the frame loop runs against a session that never presents.
// - A way to interact that does not assume dom-overlay was granted. It is
//   optional, and when it is refused the page's DOM is not shown over the
//   session at all, so any button on it is unreachable. Screen taps arrive as
//   `select` events regardless, so those drive the measurement and the full
//   report is printed to the page after the session exits.
//
// Nothing here touches the rest of Synora. It is a measurement, not a feature.

const report = document.getElementById('report');
const live = document.getElementById('live');
const startBtn = document.getElementById('startBtn');
const overlay = document.getElementById('overlay');
const overlayText = document.getElementById('overlayText');
const markBtn = document.getElementById('markBtn');
const endBtn = document.getElementById('endBtn');

// Everything worth having, all optional: a device that refuses one should
// still start a session so the rest can be measured. `plane-detection` has to
// stay in this list or the flags block below has nothing to report — a feature
// that is never asked for is never granted, which is indistinguishable from a
// device that cannot do it.
const OPTIONAL = ['camera-access', 'depth-sensing', 'anchors', 'hit-test', 'dom-overlay',
  'light-estimation', 'plane-detection'];

let session = null;
let refSpace = null;
let gl = null;
let origin = null;         // marked pose, for the loop-closure measurement
let maxDist = 0;
let lastDist = 0;
let depthNote = 'not granted';
let frames = 0;
let lost = 0;
let granted = [];
let refused = [];
let spaceKind = '';

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

function esc(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// Three of the phone's more interesting measurement channels are reachable but
// gated behind a browser flag, and whether this browser has one turned on is a
// fact about *this* device — the same thing the rest of this page exists to
// report. Without it, a refused feature and an unset toggle look identical.
//
// `test` returns true, false, or **null for "cannot be known yet"**, which is
// not the same as off: nothing can say whether plane-detection was granted
// before a session has run, and printing "off" there would send someone to
// flip a flag that is already on.
const FLAGS = [
  {
    slug: 'webxr-incubations',
    name: 'WebXR Incubations',
    unlocks: 'plane-detection',
    why: "ARCore's own wall, floor and table polygons, in session space.",
    test: () => (granted.length + refused.length ? granted.includes('plane-detection') : null),
  },
  {
    slug: 'enable-generic-sensor-extra-classes',
    name: 'Generic Sensor Extra Classes',
    unlocks: 'Magnetometer, AmbientLightSensor',
    why: 'Raw 3-axis magnetic field in µT (capped at 10 Hz), and ambient light in lux.',
    // `typeof` is the one operator that does not throw on an undeclared name,
    // which is what an unflagged sensor class is.
    test: () => typeof Magnetometer === 'function',
  },
  // The three Bluetooth rows are a chain and are listed in the order they have
  // to be satisfied: the namespace has to exist, then scanning has to be
  // enabled on it, then permissions have to survive a reload. A row further
  // down reading "off" while one above it is also off says nothing.
  {
    slug: 'brave-web-bluetooth-api',
    name: 'Web Bluetooth API (Brave only)',
    only: 'brave://',
    unlocks: 'navigator.bluetooth',
    why: 'Brave ships Web Bluetooth switched off, and without it the whole namespace '
      + 'is absent — which reads exactly like a phone with no Bluetooth at all.',
    test: () => !!navigator.bluetooth,
  },
  {
    slug: 'enable-experimental-web-platform-features',
    name: 'Experimental Web Platform features',
    unlocks: 'navigator.bluetooth.requestLEScan',
    why: 'Passive BLE advertisement scanning — the only way a page can read an RSSI. '
      + 'A broad flag: it turns on a great deal else besides.',
    test: () => typeof navigator.bluetooth?.requestLEScan === 'function',
  },
  {
    slug: 'enable-web-bluetooth-new-permissions-backend',
    name: 'Use the new permissions backend for Web Bluetooth',
    unlocks: 'navigator.bluetooth.getDevices()',
    why: 'Device grants persist across loads instead of dying with the page, so a '
      + 'paired device can be re-opened without the chooser. Scanning does not need it.',
    test: () => typeof navigator.bluetooth?.getDevices === 'function',
  },
];

// Brave is a Chromium derivative with its own scheme and it announces itself
// properly, so nothing here has to sniff a UA string. Anything unexpected
// shows both addresses rather than guessing wrong.
let schemes = ['chrome://', 'brave://'];
let isBrave = false;

async function resolveSchemes() {
  try {
    if (await navigator.brave?.isBrave?.()) {
      isBrave = true;
      schemes = ['brave://'];
    } else if (navigator.brave === undefined) {
      schemes = ['chrome://'];
    }
  } catch {
    // Leave both standing: a browser that has the hook and throws on it is
    // exactly the case where a guess would be wrong.
  }
}

// The address cannot be a link. Chromium refuses navigation to chrome:// and
// brave:// from web content, and an <a href> to one does nothing at all with
// no error to say why — so it is text plus a copy button or it is nothing.
function flagUrl(url) {
  const wrap = document.createElement('div');
  wrap.className = 'flagUrl';
  const text = document.createElement('code');
  text.textContent = url;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'copy';
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = 'copied';
      setTimeout(() => { btn.textContent = 'copy'; }, 1500);
    } catch {
      // A copy button that silently does nothing is worse than no button, so a
      // refusal selects the text and says how to take it from there.
      const range = document.createRange();
      range.selectNodeContents(text);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = 'long-press';
    }
  };
  wrap.append(text, btn);
  return wrap;
}

function noteEl(text) {
  const el = document.createElement('div');
  el.className = 'flagNote';
  el.textContent = text;
  return el;
}

// A row reading "on" is a claim that an API *exists*. Whether there is working
// hardware behind it is a different question and the only thing that answers it
// is a number moving on the screen — a phone with no light sensor still gets
// the class when the flag is set, and a magnetometer can be present and refused
// by permissions. So each flag that has data to show gets a reader.
//
// Every reader stops: a sensor left running holds the sensor hub awake and a
// BLE scan holds the radio, which on a page whose whole subject is battery-fed
// measurement is not a detail.
const readers = [];
const permRefreshers = [];

// There is no `permissions.request()` anywhere in the platform. A Generic
// Sensor's permission is decided by Chromium at the moment `start()` is called
// and never by asking first, so the only thing that can be done up front is
// *read* the state — which is worth doing, because a denial and a sensor that
// simply produced nothing look identical otherwise.
//
// `query` throws on a name the browser does not know rather than answering, so
// an unknown name is reported as unknown and not as denied.
async function permState(name) {
  if (!navigator.permissions?.query) return null;
  try {
    return (await navigator.permissions.query({ name })).state;
  } catch {
    return null;
  }
}

async function permLine(names) {
  if (!names?.length) return '';
  const parts = await Promise.all(names.map(async (n) => `${n} ${await permState(n) ?? '?'}`));
  return `permission: ${parts.join(', ')}`;
}

// The two real prompts this page can raise. `DeviceMotionEvent.requestPermission`
// exists on iOS only and is the one explicit sensor request in the platform;
// geolocation has no query-then-request either, so the request *is* a fix.
// Bluetooth is left to its own row: it needs the click as its gesture and
// prompts there anyway.
async function requestPermissions(out) {
  const said = [];
  for (const [label, Ev] of [['motion', globalThis.DeviceMotionEvent],
    ['orientation', globalThis.DeviceOrientationEvent]]) {
    if (typeof Ev?.requestPermission !== 'function') continue;
    try {
      said.push(`${label}: ${await Ev.requestPermission()}`);
    } catch (err) {
      said.push(`${label}: ${err.name}`);
    }
  }
  if (navigator.geolocation) {
    said.push(await new Promise((res) => {
      navigator.geolocation.getCurrentPosition(
        () => res('geolocation: granted'),
        (err) => res(`geolocation: ${err.code === 1 ? 'denied' : err.message}`),
        { timeout: 15000, maximumAge: 0 });
    }));
  }
  out.textContent = said.length
    ? said.join('\n')
    : 'nothing here has an explicit request — sensor permission is decided at start().';
}

// A sensor that neither reads nor errors is the case worth naming out loud. On
// Android that is normally the Motion sensors site setting or Brave's
// fingerprint blocking, and both are silent by design — nothing throws, nothing
// is denied, the readings simply never come. Waiting looks identical.
function silenceWatch(out, gotAny) {
  return setTimeout(() => {
    if (gotAny()) return;
    out.textContent = 'no readings and no error. Nothing is refusing this — the '
      + 'readings are simply not arriving, which on Android means the Motion sensors '
      + 'site setting is off, or Brave Shields is blocking device sensors. Both '
      + 'addresses are under the Sensors heading.';
  }, 3000);
}

function sensorReader(name, freq, format, perms) {
  let s = null;
  let hits = 0;
  let since = 0;
  let quiet = 0;
  return {
    label: name,
    perms,
    available: () => typeof globalThis[name] === 'function',
    // The flag can be on with nothing behind it, so construction is the first
    // thing that can fail and it fails synchronously.
    start(out) {
      const Ctor = globalThis[name];
      if (typeof Ctor !== 'function') { out.textContent = `${name} is not defined`; return false; }
      hits = 0;
      since = performance.now();
      try {
        s = new Ctor({ frequency: freq });
      } catch (err) {
        out.textContent = `construct failed: ${err.name} — ${err.message}`;
        return false;
      }
      s.addEventListener('reading', () => {
        hits++;
        clearInterval(quiet);
        // The achieved rate, not the asked one: Chromium caps these (60 Hz for
        // motion, 10 for magnetometer and light) and the cap is worth seeing.
        const hz = hits / ((performance.now() - since) / 1000);
        out.textContent = `${format(s)}    ${hz.toFixed(1)} Hz  n=${hits}`;
      });
      // Permission refusals and absent hardware both arrive here and nowhere
      // else; without this they are indistinguishable from "no readings yet".
      s.addEventListener('error', (e) => {
        clearInterval(quiet);
        out.textContent = `error: ${e.error?.name || 'unknown'} — ${e.error?.message || ''}`;
      });
      try {
        s.start();
      } catch (err) {
        out.textContent = `start failed: ${err.name} — ${err.message}`;
        return false;
      }
      out.textContent = 'waiting for first reading…';
      // `activated` and `hasReading` are the only two things the platform will
      // say about a sensor that is silent, and they separate the two causes
      // that look identical from outside: never activated means there is no
      // such sensor here at all, while activated-and-silent means the readings
      // are being withheld or have simply stopped arriving.
      quiet = setInterval(() => {
        if (hits) { clearInterval(quiet); quiet = 0; return; }
        const age = ((performance.now() - since) / 1000).toFixed(1);
        out.textContent = `no reading after ${age} s — activated ${s?.activated}, `
          + `hasReading ${s?.hasReading}\n`
          + (s?.activated === false
            ? 'never activated: this device has no such sensor, or Chromium does not '
              + 'implement it on this platform. Nothing on the page can change that.'
            : 'activated but silent: the Motion sensors site setting, Brave Shields, '
              + 'or a sensor the platform has stopped reporting.');
      }, 500);
      return true;
    },
    stop() {
      clearInterval(quiet);
      quiet = 0;
      try { s?.stop(); } catch { /* already gone */ }
      s = null;
    },
  };
}

// The old event-based path, kept beside the Generic Sensor classes because the
// two are blocked by different things: `devicemotion` firing while
// `Accelerometer` stays silent narrows the fault to the sensor class, and both
// silent at once points at the site setting or Shields.
function eventReader(evName, ctorName, format, perms) {
  let on = null;
  let hits = 0;
  let since = 0;
  let quiet = 0;
  return {
    label: evName,
    perms,
    available: () => typeof globalThis[ctorName] !== 'undefined',
    start(out) {
      hits = 0;
      since = performance.now();
      on = (e) => {
        hits++;
        clearTimeout(quiet);
        const hz = hits / ((performance.now() - since) / 1000);
        out.textContent = `${format(e)}    ${hz.toFixed(1)} Hz  n=${hits}`;
      };
      addEventListener(evName, on);
      out.textContent = 'listening…';
      quiet = silenceWatch(out, () => hits > 0);
      return true;
    },
    stop() {
      clearTimeout(quiet);
      removeEventListener(evName, on);
      on = null;
    },
  };
}

function leScanReader() {
  let scan = null;
  let timer = 0;
  let total = 0;
  let out = null;
  const seen = new Map();

  const onAdvert = (e) => {
    total++;
    const key = e.device?.id || e.device?.name || '?';
    const prev = seen.get(key);
    seen.set(key, {
      n: (prev?.n || 0) + 1,
      rssi: e.rssi,
      tx: e.txPower,
      name: e.device?.name || e.name || '(no name)',
    });
  };

  const draw = () => {
    if (!out) return;
    // Strongest first: RSSI is the only thing here that stands in for range, so
    // the near devices are what a ranging experiment would be looking at.
    const rows = [...seen.entries()]
      .sort((a, b) => (b[1].rssi ?? -999) - (a[1].rssi ?? -999))
      .slice(0, 8)
      .map(([, d]) => `${String(d.rssi ?? '?').padStart(4)} dBm  `
        + `tx ${d.tx ?? '—'}  n=${String(d.n).padStart(3)}  ${d.name}`);
    out.textContent = [`${seen.size} devices, ${total} adverts`, ...rows].join('\n');
  };

  return {
    label: 'requestLEScan',
    perms: ['bluetooth'],
    available: () => typeof navigator.bluetooth?.requestLEScan === 'function',
    async start(el) {
      out = el;
      seen.clear();
      total = 0;
      el.textContent = 'requesting…';
      try {
        // keepRepeatedDevices is not optional here: the default reports each
        // device once, and one RSSI sample per device is not a measurement.
        scan = await navigator.bluetooth.requestLEScan({
          acceptAllAdvertisements: true, keepRepeatedDevices: true,
        });
      } catch (err) {
        // On Android this also fails when Bluetooth or Location is off, and the
        // message is the only thing that tells those apart from a refusal.
        el.textContent = `refused: ${err.name} — ${err.message}`;
        return false;
      }
      navigator.bluetooth.addEventListener('advertisementreceived', onAdvert);
      timer = setInterval(draw, 500);
      el.textContent = 'scanning, no adverts yet…';
      return true;
    },
    stop() {
      clearInterval(timer);
      timer = 0;
      navigator.bluetooth.removeEventListener('advertisementreceived', onAdvert);
      try { scan?.stop(); } catch { /* already stopped */ }
      scan = null;
    },
  };
}

// Position is watched, not polled: a single fix is whatever the OS had cached,
// and the accuracy figure only means something once it has had a chance to move.
function geolocationReader() {
  let id = 0;
  return {
    label: 'geolocation',
    perms: ['geolocation'],
    available: () => !!navigator.geolocation,
    start(out) {
      if (!navigator.geolocation) { out.textContent = 'no geolocation'; return false; }
      out.textContent = 'waiting for a fix (this prompts)…';
      id = navigator.geolocation.watchPosition((p) => {
        const c = p.coords;
        out.textContent = [
          `lat ${c.latitude.toFixed(6)}  lon ${c.longitude.toFixed(6)}`,
          `accuracy ${c.accuracy?.toFixed(1)} m`
            + (c.altitude != null ? `   alt ${c.altitude.toFixed(1)} ±${c.altitudeAccuracy?.toFixed(1)} m` : ''),
          `speed ${c.speed ?? '—'}  heading ${c.heading ?? '—'}`,
        ].join('\n');
      }, (err) => {
        out.textContent = `error: ${err.message}`;
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
      return true;
    },
    stop() { navigator.geolocation.clearWatch(id); id = 0; },
  };
}

// Not a sensor of the room, but it is the budget every other reading is spent
// out of, and a long walk that ends early ends here.
function batteryReader() {
  let batt = null;
  let onChange = null;
  return {
    label: 'battery',
    available: () => !!navigator.getBattery,
    async start(out) {
      if (!navigator.getBattery) { out.textContent = 'no Battery Status API'; return false; }
      try {
        batt = await navigator.getBattery();
      } catch (err) {
        out.textContent = `refused: ${err.name} — ${err.message}`;
        return false;
      }
      onChange = () => {
        out.textContent = `${(batt.level * 100).toFixed(0)}%  `
          + (batt.charging ? 'charging' : 'on battery')
          + (Number.isFinite(batt.dischargingTime) && batt.dischargingTime !== Infinity
            ? `  ${(batt.dischargingTime / 60).toFixed(0)} min left` : '');
      };
      for (const ev of ['levelchange', 'chargingchange', 'dischargingtimechange']) {
        batt.addEventListener(ev, onChange);
      }
      onChange();
      return true;
    },
    stop() {
      if (!batt || !onChange) return;
      for (const ev of ['levelchange', 'chargingchange', 'dischargingtimechange']) {
        batt.removeEventListener(ev, onChange);
      }
      batt = null;
      onChange = null;
    },
  };
}

const f2 = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');
const xyz = (s, unit) => `x ${f2(s.x)}  y ${f2(s.y)}  z ${f2(s.z)} ${unit}`
  + `   |v| ${f2(Math.hypot(s.x || 0, s.y || 0, s.z || 0))}`;

// A heading on its own cannot say where it came from. Held still, one backed by
// the magnetic field stays put and one dead-reckoned from a gyro walks — so the
// reading that matters is not alpha but how far it has moved while nothing did.
// Stateful, and made per reader: the span is meaningless across a stop and start.
function headingStats() {
  let lo = Infinity;
  let hi = -Infinity;
  let first = null;
  let t0 = 0;
  return (e) => {
    const a = e.alpha;
    if (a == null) return 'no alpha — the event fires but carries nothing';
    if (first === null) { first = a; t0 = performance.now(); }
    // Unwrapped against the first sample, or a heading sitting near 0/360 reads
    // as a 360-degree swing every time it crosses.
    const d = ((a - first + 540) % 360) - 180;
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
    const mins = (performance.now() - t0) / 60000;
    return `alpha ${a.toFixed(1)}°  beta ${f2(e.beta)}°  gamma ${f2(e.gamma)}°  `
      + `absolute ${e.absolute}\n`
      + `moved ${d.toFixed(1)}° from first   span ${(hi - lo).toFixed(1)}°   `
      + `over ${mins.toFixed(2)} min`;
  };
}

// Quaternion as three angles as well as four numbers. The quaternion is the
// value; the angles are what a person standing in the room can check against
// which way they are actually facing.
function quatLine(s) {
  const q = s.quaternion;
  if (!q) return 'no quaternion yet';
  const [x, y, z, w] = q;
  const deg = 180 / Math.PI;
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * deg;
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))) * deg;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * deg;
  return `q ${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)} ${w.toFixed(3)}\n`
    + `yaw ${yaw.toFixed(1)}°  pitch ${pitch.toFixed(1)}°  roll ${roll.toFixed(1)}°`;
}

// Every sensor the browser can hand over, whether or not this project has ever
// used one. The point of the page is what the device will give, so the list is
// the platform's, not synora's.
const MOTION = ['accelerometer', 'gyroscope'];
const SENSORS = [
  { make: () => sensorReader('Accelerometer', 60, (s) => xyz(s, 'm/s²'), ['accelerometer']),
    why: 'proper acceleration, gravity included' },
  { make: () => sensorReader('LinearAccelerationSensor', 60, (s) => xyz(s, 'm/s²'), ['accelerometer']),
    why: 'the same with gravity fused out' },
  { make: () => sensorReader('GravitySensor', 60, (s) => xyz(s, 'm/s²'), ['accelerometer']),
    why: 'the gravity vector alone — the one absolute attitude reference the phone has' },
  { make: () => sensorReader('Gyroscope', 60, (s) => xyz(s, 'rad/s'), ['gyroscope']),
    why: 'angular rate' },
  // A fused sensor needs every source it fuses, so a denial on any one of them
  // is the reason it never reads — which is invisible if only one is shown.
  { make: () => sensorReader('AbsoluteOrientationSensor', 60, quatLine, [...MOTION, 'magnetometer']),
    why: 'attitude referenced to magnetic north — the only yaw here that does not drift' },
  { make: () => sensorReader('RelativeOrientationSensor', 60, quatLine, MOTION),
    why: 'attitude with a free-running yaw' },
  { make: () => sensorReader('Magnetometer', 10, (s) => xyz(s, 'µT'), ['magnetometer']),
    why: 'raw field. Needs the Generic Sensor Extra Classes flag. Measured on the phone '
      + 'here: NotReadableError, while deviceorientationabsolute reports absolute true and '
      + 'tracks a turn — so the magnetometer exists and is being fused, and only the raw '
      + 'field is closed. Check both before concluding anything about the hardware' },
  { make: () => sensorReader('AmbientLightSensor', 10,
    (s) => `${f2(s.illuminance)} lux`, ['ambient-light-sensor']),
    why: 'illuminance. Same flag, and many phones have no sensor behind it' },
  { make: () => eventReader('devicemotion', 'DeviceMotionEvent', (e) => {
    const a = e.acceleration || {};
    const g = e.accelerationIncludingGravity || {};
    const r = e.rotationRate || {};
    return `accel      ${f2(a.x)} ${f2(a.y)} ${f2(a.z)} m/s²\n`
      + `+gravity   ${f2(g.x)} ${f2(g.y)} ${f2(g.z)} m/s²\n`
      + `rotation   ${f2(r.alpha)} ${f2(r.beta)} ${f2(r.gamma)} °/s   interval ${e.interval} ms`;
  }, MOTION), why: 'the old event path for the same hardware — a useful cross-check' },
  { make: () => eventReader('deviceorientation', 'DeviceOrientationEvent',
    headingStats(), MOTION),
    why: 'screen-relative attitude' },
  { make: () => eventReader('deviceorientationabsolute', 'DeviceOrientationEvent',
    headingStats(), [...MOTION, 'magnetometer']),
    why: 'compass heading with no permission call — Android fires this one without asking. '
      + 'absolute true is not proof of a magnetometer: a device without one falls back to '
      + 'an accel+gyro rotation vector and still says absolute. Put the phone down and '
      + 'leave it: a magnetic heading holds, a dead-reckoned one walks away' },
  { make: geolocationReader,
    why: 'fused GNSS/WiFi fix. 10-40 m indoors — building scale, not room scale' },
  { make: leScanReader,
    why: 'passive BLE advertisement RSSI. Needs the Experimental Web Platform features '
      + 'flag, plus Bluetooth and Location switched on' },
  { make: batteryReader, why: 'what every other reading is spent out of' },
];

function stopAllReaders() {
  for (const r of readers.splice(0)) r.stop();
}

function renderSensors() {
  const host = document.getElementById('sensors');
  host.textContent = '';
  // The refreshers close over DOM this render is about to discard.
  permRefreshers.length = 0;
  const head = document.createElement('div');
  head.className = 'flagHead';
  head.textContent = 'Sensors';
  host.append(head, noteEl(
    'What this device will actually hand over, and what it reads. A control that '
    + 'says the class is missing is a browser answer; one that starts and then errors '
    + 'is a hardware or permission answer. Everything stops when you stop it.'));

  // Device sensors have no prompt on Android. When they are off it is one of
  // two settings, neither of which this page can reach or even read — so the
  // addresses are the whole of what can be offered.
  host.append(noteEl(
    'Sensors do not prompt on Android. If a reader stays silent, the switch is in '
    + 'one of these two places, and neither is visible from a page:'));
  for (const s of schemes) host.appendChild(flagUrl(`${s}settings/content/sensors`));
  if (isBrave || schemes.length > 1) {
    host.appendChild(flagUrl('brave://settings/shields'));
    host.appendChild(noteEl(
      "Brave's fingerprint blocking removes device sensors, and it is per-site: the "
      + 'lion icon in the address bar, Shields down for this address, is the quicker '
      + 'test than the settings page.'));
  }
  host.appendChild(noteEl(
    `secure context: ${globalThis.isSecureContext} · ${location.protocol}`
    + ` · top-level: ${globalThis.top === globalThis}`));

  // One button for the only two prompts that can be raised without starting a
  // sensor. Everything else says "granted" the moment its reader runs, or does
  // not, and the row's own permission line is where that shows.
  const ask = document.createElement('div');
  ask.className = 'flagRead';
  const askBtn = document.createElement('button');
  askBtn.type = 'button';
  askBtn.textContent = 'request permissions';
  const askOut = document.createElement('pre');
  askOut.className = 'flagData';
  askOut.textContent = '—';
  askBtn.onclick = async () => {
    askOut.textContent = 'asking…';
    await requestPermissions(askOut);
    // Refresh the rows in place rather than re-rendering: a re-render would
    // drop the DOM of any reader currently running while leaving the reader
    // itself alive, with nothing left on screen able to stop it.
    for (const refresh of permRefreshers) refresh();
  };
  ask.append(askBtn, askOut);
  host.appendChild(ask);

  for (const s of SENSORS) {
    const row = document.createElement('div');
    row.className = 'flagRow';
    row.appendChild(readerControl(s.make, s.why));
    host.appendChild(row);
  }
}

// One control per reader: a button that toggles, the one-line reason, and the
// numbers under it. The button owns the reader's lifetime, so a re-render
// cannot leave a sensor running with nothing on screen attached to it.
function readerControl(make, why) {
  const wrap = document.createElement('div');
  wrap.className = 'flagRead';
  const reader = make();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = reader.label;
  const out = document.createElement('pre');
  out.className = 'flagData';
  out.textContent = '—';

  // Absent is worth seeing without pressing anything: it is a browser answer,
  // where every other failure here is a hardware or permission one.
  const here = reader.available();
  if (!here) {
    btn.disabled = true;
    btn.textContent = `${reader.label} — not available`;
    out.textContent = 'the browser does not define it';
    out.classList.add('sensorOff');
  }

  const note = document.createElement('div');
  note.className = 'flagWhy';
  note.textContent = why;

  // The permission state sits beside the reason, not inside the numbers: it is
  // read before pressing anything, to know whether pressing is worth it.
  const perm = document.createElement('div');
  perm.className = 'flagPerm';
  const showPerm = () => permLine(reader.perms).then((t) => { perm.textContent = t; });
  permRefreshers.push(showPerm);
  showPerm();

  let running = false;
  btn.onclick = async () => {
    if (running) {
      reader.stop();
      const i = readers.indexOf(reader);
      if (i >= 0) readers.splice(i, 1);
      running = false;
      btn.textContent = reader.label;
      return;
    }
    // The BLE scan needs the click itself as its user gesture, so nothing may
    // be awaited before the request goes out.
    const ok = await reader.start(out);
    // Starting is what actually decides a sensor permission, so the state is
    // re-read afterwards either way — a refusal is the interesting case.
    showPerm();
    if (!ok) return;
    running = true;
    readers.push(reader);
    btn.textContent = `stop ${reader.label}`;
  };

  wrap.append(btn, note, perm, out);
  return wrap;
}

function renderFlags() {
  const host = document.getElementById('flags');
  host.textContent = '';
  const head = document.createElement('div');
  head.className = 'flagHead';
  head.textContent = 'Browser flags';
  host.append(head, noteEl(
    'These addresses are not links — a page is not allowed to open one. Copy it, '
    + 'paste it into the address bar, set the flag, then restart the browser and '
    + 'reload this page. The state below should flip.'));

  for (const f of FLAGS) {
    // A Brave-only flag on a browser known not to be Brave is noise. It stays
    // while the answer is unknown, since that is when it is most likely wanted.
    if (f.only && !schemes.includes(f.only)) continue;
    const on = f.test();
    const row = document.createElement('div');
    row.className = 'flagRow';

    const title = document.createElement('div');
    title.className = 'flagName';
    title.textContent = f.name;
    const pill = document.createElement('span');
    pill.className = on === true ? 'yes' : on === false ? 'no' : 'unknown';
    pill.textContent = on === true ? 'on' : on === false ? 'off' : 'start a session to find out';
    title.appendChild(pill);

    const why = document.createElement('div');
    why.className = 'flagWhy';
    why.textContent = `${f.unlocks} — ${f.why}`;

    row.append(title, why);
    for (const s of (f.only ? [f.only] : schemes)) {
      row.appendChild(flagUrl(`${s}flags/#${f.slug}`));
    }
    host.appendChild(row);
  }

  // Both unconfirmed, and said as much: they are the two ways Brave can look
  // like a phone that cannot do something.
  if (isBrave) {
    host.appendChild(noteEl(
      'Brave, two things neither of which is confirmed here. WebXR was off by default '
      + 'for a period after Chromium 79, so a missing navigator.xr may be the browser '
      + "rather than the phone. And Shields' fingerprinting defences randomise or remove "
      + 'some device APIs, so a sensor that exists but reads nonsense is worth retrying '
      + 'with Shields down (brave://settings/shields).'));
  }
}

async function probe() {
  if (!navigator.xr) {
    report.innerHTML = '<span class="no">navigator.xr missing.</span>\n' +
      'This browser has no WebXR at all. On Android that means Chrome is old ' +
      'or this is not Chrome; on iOS, Safari has no immersive-ar and there is ' +
      'no way around it.' +
      // A Chromium derivative that has switched WebXR off looks exactly like a
      // phone that cannot do AR, and the fix is in a completely different place.
      (isBrave ? '\nThis is Brave, which has shipped with WebXR off by default before ' +
        'now — check the flags below before concluding it is the phone.' : '');
    setStatus('no WebXR');
    return;
  }
  let ar = false;
  try {
    ar = await navigator.xr.isSessionSupported('immersive-ar');
  } catch (err) {
    report.textContent = `isSessionSupported threw: ${err.message}`;
    return;
  }
  report.innerHTML = ar
    ? '<span class="yes">✔ immersive-ar supported</span>\nARCore is present and this device is on its list.'
    : '<span class="no">✘ immersive-ar unsupported</span>\nEither not ARCore-certified, or ' +
      '"Google Play Services for AR" is not installed — that is usually all that is missing.';
  startBtn.disabled = !ar;
  setStatus(ar ? 'ready' : 'immersive-ar unsupported');
  if (ar) {
    report.innerHTML += '\n\nIn the session: <b>tap the screen</b> to mark your starting point, ' +
      'walk a loop around the room, come back to the same spot, then exit with the system ' +
      'back gesture. The reading you want is printed here afterwards.';
  }
}

async function start() {
  // The base layer has to exist before the first frame or the session presents
  // nothing — a black screen, which is what this looked like without it.
  const canvas = document.createElement('canvas');
  gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: false });
  if (!gl) {
    live.textContent = 'no WebGL context — cannot present an AR session';
    return;
  }

  const init = {
    optionalFeatures: OPTIONAL,
    // Ask for both usages and both formats: whatever comes back is reported
    // rather than assumed.
    depthSensing: {
      usagePreference: ['cpu-optimized', 'gpu-optimized'],
      dataFormatPreference: ['luminance-alpha', 'float32'],
    },
    domOverlay: { root: overlay },
  };
  try {
    session = await navigator.xr.requestSession('immersive-ar', init);
  } catch (err) {
    live.textContent = `session refused: ${err.message}`;
    return;
  }

  granted = OPTIONAL.filter((f) => session.enabledFeatures?.includes(f));
  refused = OPTIONAL.filter((f) => !granted.includes(f));
  // The plane-detection row can be answered now, and the answer is worth having
  // before the session ends rather than only after it.
  renderFlags();

  try {
    await gl.makeXRCompatible();
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  } catch (err) {
    live.textContent = `could not attach a render layer: ${err.message}`;
    await session.end();
    return;
  }

  // local-floor puts the origin on the detected floor, which is the frame a
  // room map would want. Fall back to local if the device will not give it.
  try {
    refSpace = await session.requestReferenceSpace('local-floor');
    spaceKind = 'local-floor';
  } catch {
    refSpace = await session.requestReferenceSpace('local');
    spaceKind = 'local';
  }

  frames = 0;
  lost = 0;
  origin = null;
  maxDist = 0;
  lastDist = 0;
  depthNote = 'not granted';

  overlay.classList.add('on');
  // A tap reaches us whether or not dom-overlay was granted, so the whole
  // measurement is driveable without any visible UI.
  session.addEventListener('select', markOrigin);
  session.addEventListener('end', onEnd);
  session.requestAnimationFrame(onFrame);
  setStatus('session running — tap to mark, walk a loop, then exit');
}

function markOrigin() {
  origin = null;   // re-marked on the next frame, where a pose is available
  maxDist = 0;
}

function onFrame(t, frame) {
  session.requestAnimationFrame(onFrame);
  frames++;

  // Clear the layer to fully transparent: the camera passthrough is composited
  // behind it, so drawing nothing is what shows the room.
  const layer = session.renderState.baseLayer;
  if (layer) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  const pose = frame.getViewerPose(refSpace);
  if (!pose) {
    lost++;
    overlayText.textContent = `TRACKING LOST (${lost} of ${frames} frames)`;
    return;
  }
  const p = pose.transform.position;
  if (!origin) origin = { x: p.x, y: p.y, z: p.z };

  if (depthNote === 'not granted' || depthNote.startsWith('depth')) {
    try {
      const d = frame.getDepthInformation?.(pose.views[0]);
      if (d) {
        depthNote = `depth ${d.width}x${d.height}, centre ` +
          `${d.getDepthInMeters(0.5, 0.5).toFixed(2)} m`;
      }
    } catch (err) {
      depthNote = `depth threw: ${err.message}`;
    }
  }

  // Walk away and come back: the distance on return *is* the accumulated
  // drift, because the true distance is zero.
  lastDist = Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z);
  maxDist = Math.max(maxDist, lastDist);
  overlayText.textContent =
    `pos ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}\n` +
    `from mark ${lastDist.toFixed(3)} m (went out to ${maxDist.toFixed(2)} m)\n` +
    `${depthNote}\nlost ${lost}/${frames} frames`;
}

function onEnd() {
  overlay.classList.remove('on');
  setStatus('session ended');
  const drift = maxDist > 1
    ? `<b>returned ${lastDist.toFixed(3)} m from the mark</b> after walking out to ` +
      `${maxDist.toFixed(2)} m — that residual is the accumulated drift.`
    : `only moved ${maxDist.toFixed(2)} m from the mark, which is too little to ` +
      'say anything about drift — walk a real loop around the room.';
  live.innerHTML = [
    `<span class="yes">granted: ${esc(granted.join(', ')) || '(none reported)'}</span>`,
    `<span class="no">refused: ${esc(refused.join(', ')) || 'nothing'}</span>`,
    `reference space: ${spaceKind}`,
    `depth: ${esc(depthNote)}`,
    `tracking lost on ${lost} of ${frames} frames`,
    drift,
  ].join('\n');
  session = null;
}

startBtn.onclick = start;
markBtn.onclick = markOrigin;
endBtn.onclick = () => session?.end();

// The scheme has to be settled before the sensor block draws too — its help is
// two settings addresses, and the wrong scheme is a dead end rather than a hint.
resolveSchemes().then(() => {
  renderFlags();
  renderSensors();
  probe();
});
// Leaving the page must not leave the sensor hub or the BLE radio running —
// Android freezes the page rather than tearing it down, so nothing else will.
addEventListener('pagehide', stopAllReaders);
