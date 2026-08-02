'use strict';

const fs = require('fs');
const path = require('path');

// What each surveyed tag has been doing: where it sat, which way it pointed, and
// what refinement was still asking of it, over the life of the map.
//
// The survey records only the *result* — markers.json holds one pose per tag and
// the live resid EMAs describe the last few seconds — so the questions a survey
// actually raises could not be answered at all: has this tag ever moved, did it
// arrive where it now sits or walk there, was it knocked and re-seeded, and when
// did it stop moving. The drawer's "settling / settled" line is one bit of that
// and it is computed from two consecutive maps, which is why it can say a tag is
// settled and be describing a tag that has been drifting for an hour.
//
// A file of its own rather than a section of markers.json: that file is the map,
// read and rewritten as one object every ten seconds, and a log growing inside it
// would be rewritten with it and would have to be skipped by everything that
// reads it. Written debounced and atomically for the same reason the map is.
//
// The history is *of a room frame*, not of a tag id: every position here is
// expressed relative to the anchor, so a new anchor makes every stored sample a
// measurement in a coordinate system that no longer exists. The file therefore
// carries the anchor it was recorded against and is discarded outright when that
// does not match the map being loaded.
const HISTORY_VERSION = 1;

// One sample a second. Refinement runs at 10 Hz per client and nothing a tag does
// is legible at that rate — the pose moves by REFINE_ALPHA of a small
// disagreement per sighting — so a tenth of the samples describe the same curve.
const SAMPLE_MS = 1000;

// Samples kept per tag before the old end is thinned. Not a plain ring: a ring
// throws away the beginning, and the beginning is the part worth keeping — a tag
// arriving in the map and settling is exactly the stretch a reader is looking
// for. Overflow halves the resolution of the oldest half instead, so the record
// keeps reaching back to the tag's first sighting and simply gets coarser the
// further back it goes.
const MAX_SAMPLES = 600;

// Events are rare (a promotion, a re-seed) and each one is a sentence, so a small
// cap holds a long session's worth.
const MAX_EVENTS = 40;

// Longer than the map's own debounce: this file grows by a few hundred bytes a
// second per visible tag while a survey is being walked, and unlike the map
// nothing downstream is waiting on it being current.
const SAVE_DEBOUNCE_MS = 30000;

// Sample wire/disk form, in order: [t, x, y, z, qx, qy, qz, qw, residMm,
// residDeg]. An array rather than an object because a tag's history is several
// hundred of these and they are shipped whole to the dashboard on every poll;
// the key names would be most of the bytes.
function packSample(t, p, q, resid, residDeg) {
  return [
    t,
    // Tenths of a millimetre. The settle test upstream calls a tag still at one
    // millimetre, so rounding at that scale would erase the very motion the
    // history exists to show.
    +p[0].toFixed(4), +p[1].toFixed(4), +p[2].toFixed(4),
    +q[0].toFixed(5), +q[1].toFixed(5), +q[2].toFixed(5), +q[3].toFixed(5),
    resid === undefined || resid === null ? null : Math.round(resid * 1000),
    residDeg === undefined || residDeg === null ? null : +residDeg.toFixed(2),
  ];
}

// Halve the resolution of the oldest half. Applied repeatedly as the tag keeps
// being observed, so an old stretch is thinned again each time it slides further
// back — a geometric decay of detail with age, from one rule.
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
function createTagHistory({ file, log, anchorId }) {
  // id -> { samples: [packed], events: [{ t, kind, ... }], lastAt }
  const tags = new Map();
  let saveTimer = null;
  let dirty = false;

  function entry(id) {
    let e = tags.get(id);
    if (!e) {
      e = { samples: [], events: [], lastAt: 0 };
      tags.set(id, e);
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
      tags: Object.fromEntries([...tags].map(([id, e]) => [id, {
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
      log(`Tag history save failed: ${err.message}`);
    }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
  }

  return {
    // Called after the survey has loaded its map, with the anchor that map is
    // built on: a history recorded against a different anchor describes a room
    // frame that no longer exists and is thrown away rather than mixed in.
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
      for (const [id, t] of Object.entries(raw.tags || {})) {
        tags.set(Number(id), {
          samples: Array.isArray(t.samples) ? t.samples : [],
          events: Array.isArray(t.events) ? t.events : [],
          // Zero, not the last sample's time: a restart is a gap in the record
          // whatever the clock says, and the first sighting after it should be
          // recorded rather than throttled away.
          lastAt: 0,
        });
        n += (t.samples || []).length;
      }
      if (tags.size) log(`Tag history loaded: ${tags.size} tags, ${n} samples`);
    },

    // Where the tag is now and what refinement still wants of it. Throttled here
    // rather than at the call site: refinement calls this from its own hot loop
    // per client, and two clients looking at one tag must not double its sample
    // rate.
    record(id, { p, q, resid, residDeg }) {
      const e = entry(id);
      const now = Date.now();
      // An OS clock step backwards would otherwise freeze the record until real
      // time caught up with the stamp already written.
      if (Math.abs(now - e.lastAt) < SAMPLE_MS) return;
      e.lastAt = now;
      e.samples.push(packSample(now, p, q, resid, residDeg));
      if (e.samples.length > MAX_SAMPLES) e.samples = thin(e.samples);
      scheduleSave();
    },

    // A moment worth naming: promoted into the map, re-seeded after being moved,
    // anchored as the datum. Recorded whole rather than being inferred later from
    // a step in the samples — a re-seed and a nudge look the same in a position
    // trace, and it is the difference between "this tag was knocked" and "this
    // tag is drifting".
    event(id, kind, detail = {}) {
      const e = entry(id);
      e.events.push({ t: Date.now(), kind, ...detail });
      if (e.events.length > MAX_EVENTS) e.events.shift();
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
      const e = tags.get(id);
      if (!e) return { id, samples: [], events: [] };
      return { id, samples: e.samples, events: e.events };
    },

    // A tag removed from the map by hand is gone from the room, not paused: if
    // that id ever comes back it is a different tag on a different wall, and the
    // old record would read as its own past.
    forget(id) {
      if (tags.delete(id)) scheduleSave();
    },

    // A new anchor (or a new marker size) is a new room frame — see the header.
    // Written out rather than merely dropped from memory: the file on disk is
    // still stamped with the old anchor, and a restart before the next debounce
    // fires would load a record of a room that no longer exists. (The anchor
    // stamp would catch it, but only by luck — a new survey that happens to
    // anchor on the same tag id would match.)
    clear() {
      tags.clear();
      dirty = true;
      writeNow();
    },
  };
}

module.exports = { createTagHistory, HISTORY_VERSION };
