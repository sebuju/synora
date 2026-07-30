'use strict';

// Device registry: everything the server knows about a capture device, keyed by
// the UUID that device's browser persists.
//
// The browser used to hold all of this itself — capture settings and, more
// importantly, camera calibration. Both were in `localStorage`, which means a
// cleared site data, a reinstalled browser or a switch from Chrome to anything
// else lost a calibration that took fifteen careful ChArUco captures to make.
// The browser now holds one thing, its id; everything tied to that id lives
// here and survives the browser entirely.
//
// The id itself is still the weak link, so it is recoverable two ways: a
// fingerprint of the device is stored alongside the record and re-matched when a
// browser turns up without an id (see `match`), and the client can be shown the
// list and told to pick (see `list`). The fingerprint is a hint, never a
// decision: two identical phone models fingerprint identically, and quietly
// merging two devices would cross-contaminate exactly the calibration this is
// meant to protect.

const fs = require('fs');

const REGISTRY_VERSION = 1;
// Settings change on every tap; calibration is rare and precious. One debounce
// for both, short enough that a phone put down straight after a change still
// has it saved.
const SAVE_DEBOUNCE_MS = 2000;

// Fingerprint weights. Anything that describes the *hardware* is worth much more
// than anything that describes its current configuration: a GPU string and a
// screen geometry survive a browser reinstall, a language list does not say much
// and a browser version changes every few weeks on its own.
const FINGERPRINT_WEIGHTS = {
  gpu: 5,        // WebGL unmasked renderer — the strongest model signal
  screen: 4,     // physical resolution and pixel ratio
  model: 4,      // device model parsed out of the user agent
  cameras: 4,    // camera labels and their maximum resolutions
  cores: 2,
  memory: 2,
  platform: 1,
  langs: 1,
  tz: 1,
};

// A match this good, and this much better than the runner-up, is taken without
// asking. Below either bar the client is shown the list with the best guess on
// top — a wrong silent adoption is far worse than one extra tap, because it
// hands one phone another phone's camera model and nothing downstream can tell.
const MATCH_ACCEPT = 0.82;
const MATCH_MARGIN = 0.15;
// Below this a candidate is not worth showing as a suggestion at all.
const MATCH_SUGGEST = 0.45;

// Device model out of a user agent. Only the part that names hardware — the
// browser and OS version churn on their own and would break the match on every
// update.
function modelFromUa(ua) {
  if (!ua) return null;
  const android = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^)]*)?\)/.exec(ua);
  if (android) return android[1].trim();
  if (/\biPad\b/.test(ua)) return 'iPad';
  if (/\biPhone\b/.test(ua)) return 'iPhone';
  const win = /Windows NT ([\d.]+)/.exec(ua);
  if (win) return `Windows ${win[1]}`;
  if (/\bMacintosh\b/.test(ua)) return 'Mac';
  if (/\bLinux\b/.test(ua)) return 'Linux';
  return null;
}

function browserFromUa(ua) {
  if (!ua) return null;
  // Order matters: every one of these also claims to be Chrome and Safari.
  if (/\bEdgA?\//.test(ua)) return 'Edge';
  if (/\bOPR\//.test(ua)) return 'Opera';
  if (/\bSamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/\bFirefox\//.test(ua)) return 'Firefox';
  if (/\bChrome\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua)) return 'Safari';
  return null;
}

// A name someone can pick out of a list. Nothing here is unique — two of the
// same phone get the same name — which is why the list also shows when each was
// last seen and what it has been calibrated for, and why the name is editable.
function deviceNameFromUa(ua) {
  const model = modelFromUa(ua);
  const browser = browserFromUa(ua);
  if (model && browser) return `${model} · ${browser}`;
  return model || browser || null;
}

// Compare one fingerprint field. Cameras are a set comparison because a device
// can enumerate them in any order and may report fewer of them before camera
// permission has been granted; everything else is exact.
function fieldScore(key, a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return null;
  if (key === 'cameras') {
    const sa = new Set(a);
    const sb = new Set(b);
    if (!sa.size || !sb.size) return null;
    let hit = 0;
    for (const v of sa) if (sb.has(v)) hit++;
    // Fraction of the *smaller* set: a device seen once without camera
    // permission knows fewer cameras, and that is missing information rather
    // than disagreement.
    return hit / Math.min(sa.size, sb.size);
  }
  if (key === 'langs') {
    return String(a) === String(b) ? 1 : 0;
  }
  return a === b ? 1 : 0;
}

// How well a fresh fingerprint matches a stored one: the weighted fraction of
// the fields both of them actually have. Fields only one side knows are left
// out of both the numerator and the denominator — an absent field is not
// evidence of disagreement, and treating it as such would punish exactly the
// device that has not been given camera permission yet.
function fingerprintScore(a, b) {
  if (!a || !b) return 0;
  let got = 0;
  let total = 0;
  let strong = 0;
  for (const [key, weight] of Object.entries(FINGERPRINT_WEIGHTS)) {
    const s = fieldScore(key, a[key], b[key]);
    if (s === null) continue;
    total += weight;
    got += weight * s;
    if (weight >= 4 && s >= 0.99) strong++;
  }
  // Agreement on nothing but core count and timezone is not a match, however
  // clean the ratio looks.
  if (!total || strong < 2) return 0;
  return got / total;
}

function createDeviceRegistry({ file, log }) {
  const devices = new Map();
  let saveTimer = null;

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const out = {
        version: REGISTRY_VERSION,
        updatedAtMs: Date.now(),
        devices: Object.fromEntries(devices),
      };
      // Atomic replace: a crash mid-write must not eat every calibration on it.
      const tmp = `${file}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
        fs.renameSync(tmp, file);
      } catch (err) {
        log(`Device registry save failed: ${err.message}`);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function blank(id) {
    return {
      id,
      name: null,
      createdAtMs: Date.now(),
      lastSeenMs: Date.now(),
      userAgent: null,
      fingerprint: null,
      // Capture settings. Absent until the device reports them; a client that
      // has never connected must be handed nothing rather than a guess, or the
      // guess becomes the setting.
      settings: null,
      // Camera calibration, keyed `${facing}:${w}x${h}` exactly as the browser
      // keyed it in localStorage. The key format is deliberately unchanged so a
      // migrated record and a fresh one are the same thing.
      intrinsics: {},
    };
  }

  // What a browser with no id is offered. Enough per entry to tell two devices
  // apart by hand: what it is, when it was last seen, and what it has been
  // calibrated for — that last one is the whole reason for adopting rather than
  // starting fresh.
  function listAll() {
    return [...devices.values()]
      .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
      .map((rec) => ({
        id: rec.id,
        name: rec.name || `device ${rec.id.slice(0, 8)}`,
        lastSeenMs: rec.lastSeenMs,
        createdAtMs: rec.createdAtMs,
        settings: rec.settings,
        calibrations: Object.entries(rec.intrinsics).map(([key, c]) => ({
          key, facing: key.split(':')[0], w: c.w, h: c.h, rms: c.rms ?? null,
        })),
      }));
  }

  return {
    load() {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return;   // no registry yet
      }
      for (const [id, rec] of Object.entries(raw.devices || {})) {
        devices.set(id, { ...blank(id), ...rec, id });
      }
      const cal = [...devices.values()].reduce(
        (n, d) => n + Object.keys(d.intrinsics || {}).length, 0);
      log(`Device registry loaded: ${devices.size} devices, ${cal} calibrations`);
    },

    get(id) {
      return devices.get(id) || null;
    },

    has(id) {
      return devices.has(id);
    },

    // Called whenever a device announces itself. Creates the record on first
    // sight and refreshes what the device says about itself — the fingerprint
    // has to be re-stored or a browser update slowly walks it out of matching
    // range of its own record.
    touch(id, { userAgent, fingerprint } = {}) {
      if (!id) return null;
      let rec = devices.get(id);
      if (!rec) {
        rec = blank(id);
        devices.set(id, rec);
        log(`New device ${id.slice(0, 8)}${userAgent ? ` (${deviceNameFromUa(userAgent)})` : ''}`);
      }
      rec.lastSeenMs = Date.now();
      if (userAgent) {
        rec.userAgent = userAgent;
        // Only ever fills a blank: a name someone typed is not overwritten by
        // one parsed out of a user agent string.
        rec.name ||= deviceNameFromUa(userAgent);
      }
      if (fingerprint) rec.fingerprint = fingerprint;
      scheduleSave();
      return rec;
    },

    setSettings(id, settings) {
      const rec = devices.get(id);
      if (!rec) return;
      const prev = JSON.stringify(rec.settings);
      rec.settings = settings;
      if (JSON.stringify(settings) !== prev) scheduleSave();
    },

    // Merge, never replace: a device calibrated at 4K and then at 1080p has two
    // records, and the second save must not drop the first.
    mergeIntrinsics(id, entries) {
      const rec = devices.get(id);
      if (!rec || !entries) return 0;
      let added = 0;
      for (const [key, data] of Object.entries(entries)) {
        if (!data || !(data.w > 0) || !(data.h > 0)) continue;
        rec.intrinsics[key] = data;
        added++;
      }
      if (added) {
        log(`Device ${id.slice(0, 8)}: stored ${added} calibration(s), `
          + `${Object.keys(rec.intrinsics).length} total`);
        scheduleSave();
      }
      return added;
    },

    rename(id, name) {
      const rec = devices.get(id);
      if (!rec) return null;
      const clean = String(name || '').trim().slice(0, 64);
      rec.name = clean || deviceNameFromUa(rec.userAgent);
      scheduleSave();
      return rec.name;
    },

    forget(id) {
      if (!devices.delete(id)) return false;
      log(`Device ${id.slice(0, 8)} forgotten`);
      scheduleSave();
      return true;
    },

    list: listAll,

    // Which stored device this fingerprint probably belongs to.
    // `adopt` is set only when one candidate is both good on its own and clearly
    // better than the next — see MATCH_ACCEPT / MATCH_MARGIN. Otherwise the
    // ranked candidates are returned for a human to choose from, which is the
    // honest answer when two identical phones are indistinguishable.
    match(fingerprint, { exclude = [] } = {}) {
      const skip = new Set(exclude);
      const scored = [...devices.values()]
        .filter((rec) => !skip.has(rec.id))
        .map((rec) => ({ id: rec.id, score: fingerprintScore(fingerprint, rec.fingerprint) }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      const next = scored[1];
      const decisive = !!best && best.score >= MATCH_ACCEPT
        && (!next || best.score - next.score >= MATCH_MARGIN);
      const byId = new Map(listAll().map((d) => [d.id, d]));
      return {
        adopt: decisive ? best.id : null,
        candidates: scored
          .filter((s) => s.score >= MATCH_SUGGEST)
          .map((s) => ({ ...byId.get(s.id), score: Math.round(s.score * 100) / 100 })),
      };
    },
  };
}

module.exports = { createDeviceRegistry, deviceNameFromUa, modelFromUa };
