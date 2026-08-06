'use strict';

const fs = require('fs');
const path = require('path');

// What a thing in the map has been doing, over the life of the map: a throttled
// trace of where it was and how well it was known, plus the handful of moments
// worth naming.
//
// This is `tag-history.js`'s machinery, lifted out whole so the object map can
// have the same record without a second copy of it. The two differ in exactly
// one place — what a sample *is* — and that is the `pack` the caller supplies.
// Everything else is the same problem: the map holds only the result, so the
// questions the map actually raises ("did it arrive where it sits or walk
// there, was it knocked, has it stopped moving or merely stopped being looked
// at") cannot be asked of it at all.
//
// A file of its own rather than a section of the map: the map is read and
// rewritten as one object every few seconds, and a log growing inside it would
// be rewritten with it and would have to be skipped by everything that reads it.
// Written debounced and atomically for the same reason the map is.
//
// The record is *of a room frame*, not of a list of ids: every position in it is
// relative to the anchor, so a new anchor makes every stored sample a
// measurement in a coordinate system that no longer exists. The file carries the
// anchor it was recorded against and is discarded outright when that does not
// match the map being loaded.
const HISTORY_VERSION = 1;

// Halve the resolution of the oldest half. Applied repeatedly as the thing keeps
// being observed, so an old stretch is thinned again each time it slides further
// back — a geometric decay of detail with age, from one rule. Not a plain ring:
// a ring throws away the beginning, and the beginning is the part worth keeping.
// An entry arriving in the map and settling is exactly the stretch a reader is
// looking for.
function thin(samples) {
  const half = samples.length >> 1;
  const out = [];
  for (let i = 0; i < half; i += 2) out.push(samples[i]);
  for (let i = half; i < samples.length; i++) out.push(samples[i]);
  return out;
}

// `anchorId` is a getter, not a value: the anchor is chosen after this module is
// built and is replaced whenever the survey is reset, and the file has to be
// stamped with the frame it was actually recorded in.
//
// `label` names the record in the log. `key` is the collection's name inside the
// file and is part of that file's format — `tag-history.js` passes `tags`
// because files written before this module existed use that name.
//
// `pack(t, data)` turns one observation into its wire and disk form. Callers
// return a flat array rather than an object: a record is several hundred of
// these and they are shipped whole to the dashboard, where the key names would
// be most of the bytes.
function createHistoryStore({
  file,
  log = () => {},
  anchorId,
  label,
  key = 'items',
  pack,
  sampleMs = 1000,
  maxSamples = 600,
  maxEvents = 40,
  saveDebounceMs = 30000,
}) {
  // id -> { samples: [packed], events: [{ t, kind, ... }], lastAt }
  const items = new Map();
  let saveTimer = null;
  let dirty = false;

  function entry(id) {
    let e = items.get(id);
    if (!e) {
      e = { samples: [], events: [], lastAt: 0 };
      items.set(id, e);
    }
    return e;
  }

  function writeNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    const out = {
      version: HISTORY_VERSION,
      // The frame these positions are in. See the header: a different anchor
      // makes the whole file meaningless rather than merely stale.
      anchorId: anchorId(),
      [key]: Object.fromEntries([...items].map(([id, e]) => [id, {
        samples: e.samples,
        events: e.events,
      }])),
    };
    // Atomic replace, like the map: a crash mid-write must not leave a file that
    // parses as half a history.
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, file);
    } catch (err) {
      log(`${label} save failed: ${err.message}`);
    }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(writeNow, saveDebounceMs);
  }

  return {
    // Called after the map has loaded, with the anchor that map is built on: a
    // history recorded against a different anchor describes a room frame that no
    // longer exists and is thrown away rather than mixed in.
    load() {
      const anchor = anchorId();
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return;   // no history yet — normal on first run
      }
      if (raw.version !== HISTORY_VERSION) {
        log(`Ignoring ${path.basename(file)}: version ${raw.version}, this build writes `
          + `${HISTORY_VERSION}`);
        return;
      }
      if (anchor === null || anchor === undefined || raw.anchorId !== anchor) {
        log(`Ignoring ${path.basename(file)}: it was recorded against anchor `
          + `${raw.anchorId}, the map is anchored on ${anchor}`);
        return;
      }
      let n = 0;
      for (const [id, t] of Object.entries(raw[key] || {})) {
        items.set(Number(id), {
          samples: Array.isArray(t.samples) ? t.samples : [],
          events: Array.isArray(t.events) ? t.events : [],
          // Zero, not the last sample's time: a restart is a gap in the record
          // whatever the clock says, and the first sighting after it should be
          // recorded rather than throttled away.
          lastAt: 0,
        });
        n += (t.samples || []).length;
      }
      if (items.size) log(`${label} loaded: ${items.size} entries, ${n} samples`);
    },

    // Where it is now and how well it is known. Throttled here rather than at
    // the call site: callers record from their own hot loop, per client, and two
    // clients looking at one thing must not double its sample rate.
    record(id, data) {
      const e = entry(id);
      const now = Date.now();
      // An OS clock step backwards would otherwise freeze the record until real
      // time caught up with the stamp already written.
      if (Math.abs(now - e.lastAt) < sampleMs) return;
      e.lastAt = now;
      e.samples.push(pack(now, data));
      if (e.samples.length > maxSamples) e.samples = thin(e.samples);
      scheduleSave();
    },

    // A moment worth naming: promoted into the map, re-seeded after being moved,
    // quarantined. Recorded whole rather than being inferred later from a step in
    // the samples — a re-seed and a nudge look the same in a position trace, and
    // it is the difference between "this was knocked" and "this is drifting".
    event(id, kind, detail = {}) {
      const e = entry(id);
      e.events.push({ t: Date.now(), kind, ...detail });
      if (e.events.length > maxEvents) e.events.shift();
      // Forced through the sample throttle: an event is exactly the instant a
      // reader will look at, and the throttle would otherwise leave it sitting
      // between two samples up to a second apart.
      e.lastAt = 0;
      scheduleSave();
    },

    // Sent whole on every poll rather than as a delta. A delta needs the
    // dashboard to hold its own copy, and that copy would be the one thing in the
    // room views not replaced wholesale by the message that describes it — with
    // its own thinning rule, drifting from this one. A few hundred samples is a
    // few tens of kilobytes on a LAN socket, and only while a card is open.
    get(id) {
      const e = items.get(id);
      if (!e) return { id, samples: [], events: [] };
      return { id, samples: e.samples, events: e.events };
    },

    // Which ids the record holds anything for. The map is the list of what
    // exists; this answers the different question of what there is a record of,
    // which after a quarantine is deliberately not the same set.
    ids() {
      return [...items.keys()];
    },

    // Removed from the map by hand is gone, not paused: if that id ever comes
    // back it is a different thing, and the old record would read as its own
    // past.
    forget(id) {
      if (items.delete(id)) scheduleSave();
    },

    // A new anchor is a new room frame — see the header. Written out rather than
    // merely dropped from memory: the file on disk is still stamped with the old
    // anchor, and a restart before the next debounce fires would load a record of
    // a room that no longer exists. (The anchor stamp would catch it, but only by
    // luck — a new survey that happens to anchor on the same tag id would match.)
    clear() {
      items.clear();
      dirty = true;
      writeNow();
    },
  };
}

module.exports = { createHistoryStore, HISTORY_VERSION };
