'use strict';

// Server settings that survive a restart.
//
// The knobs a room is actually tuned with had become a habit of `const`s
// scattered through server.js, and a value that can only be changed by editing
// a source file and restarting the server is not a setting — it is a build
// option. Worse, the one that matters most (the printed tag size, the room's
// only metric datum) already had a hand-rolled load/save/validate/apply path of
// its own, so the second one would have copied it.
//
// This module is the store, the schema and the validator, and deliberately
// knows nothing about what any setting *does*: the effects belong with the
// things they affect — the survey, the walls grid — and are
// registered here as `on(key, fn)` callbacks by server.js. Nothing in here can
// reach any of them, so a settings change cannot grow a second version of a
// reset that already exists elsewhere.

const fs = require('fs');

// One entry per setting. `def` is the value a server with no settings file
// starts at, and stays the value a rejected or corrupt stored value falls back
// to. `scale` is a *display* factor only — the wire and the file always carry
// the stored unit, so a viewer that renders millimetres and a journal that
// records metres cannot come to disagree about what 150 means.
//
// `group` is the heading a setting appears under in the dashboard, and the
// reason the order of this list is not arbitrary: consecutive entries sharing a
// group are one run under one heading, so a new setting goes beside the ones it
// belongs with rather than at the end. What a setting acts on is the split —
// the room, what the phone sends, what this PC does with it, what is written as
// pictures — and the dashboard renders the string it is given, so nothing over
// there decides what belongs where.
//
// `danger` is the sentence shown before the change is allowed through, for the
// settings that throw work away. It is copy, not a mechanism: the store applies
// whatever it validates. Asking is the dashboard's job, because the dashboard
// is the only place that can ask.
const SPEC = [
  {
    key: 'markerSizeM',
    label: 'Tag size',
    group: 'Room',
    type: 'number',
    def: 0.15,
    min: 0.02,
    max: 1,
    step: 1,
    unit: 'mm',
    scale: 1000,
    danger: 'Rescales the room — the survey and the carve are both cleared',
    help: 'Outer edge of the black square on the printed tag, not the sheet and not the '
      + 'quiet zone. Measure a printed one: "fit to page" silently returns a 150 mm tag at '
      + 'about 142 mm, and nothing downstream can see it — the room simply comes out '
      + 'uniformly too big.',
  },
  {
    key: 'poseRateMs',
    label: 'Detection interval',
    group: 'Room',
    type: 'number',
    def: 100,
    min: 50,
    max: 1000,
    step: 10,
    unit: 'ms',
    help: 'How often a client attempts a tag detection. More samples a second converge the '
      + 'survey and the jump gate faster; each one costs that client tens of milliseconds '
      + 'of CPU. Detection is attempted at this rate, not achieved — a phone that takes '
      + 'longer than this per frame runs as fast as it can.',
  },
  {
    key: 'wallsEnabled',
    label: 'Wall carving',
    group: 'Room',
    type: 'bool',
    def: true,
    help: 'Carve free space and infer walls from accepted pose reports. Off, the grid stops '
      + 'growing but is kept — clearing it is the wipe in the tool row above.',
  },
  {
    key: 'poseJournalEnabled',
    label: 'Pose journal',
    group: 'Room',
    type: 'bool',
    def: true,
    help: 'Record every observation and the pose the survey made of it to '
      + 'recordings/*.pose.jsonl. This is what the replay tools re-run, so survey and wall '
      + 'tuning is measured rather than argued. Off, a long session stops writing '
      + 'tens of megabytes it will never be asked for.',
  },
];

const BY_KEY = new Map(SPEC.map((s) => [s.key, s]));

// Validation is per setting and total: a patch is checked whole before any of
// it is applied. markerSizeM throws the survey away, so half-applying a patch
// that was going to be rejected for another key would clear the room for
// nothing.
function coerce(spec, raw) {
  if (spec.type === 'bool') {
    if (typeof raw !== 'boolean') return { error: `${spec.key} must be true or false` };
    return { value: raw };
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) return { error: `${spec.key} must be a number` };
  if (v < spec.min || v > spec.max) {
    // Stated in the unit it was entered in — a "must be 0.02-1" against a field
    // that says millimetres is a worse answer than no answer. Rounded through
    // toPrecision because the scaling is binary floating point.
    const shown = (x) => Number((x * (spec.scale || 1)).toPrecision(12));
    return {
      error: `${spec.label} must be ${shown(spec.min)}-${shown(spec.max)}`
        + `${spec.unit ? ` ${spec.unit}` : ''}`,
    };
  }
  return { value: v };
}

function createSettings({ file, log = () => {} } = {}) {
  const values = {};
  for (const spec of SPEC) values[spec.key] = spec.def;
  const handlers = new Map();

  // A stored value that no longer validates leaves the default standing rather
  // than wedging the server: these come back from a file a person may well have
  // edited, and the schema changes under them across versions.
  (function load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;   // no settings yet — the defaults stand
    }
    for (const spec of SPEC) {
      if (!(spec.key in raw)) continue;
      const out = coerce(spec, raw[spec.key]);
      if (out.error) log(`Ignoring stored setting: ${out.error}`);
      else values[spec.key] = out.value;
    }
  }());

  function save() {
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(values, null, 1));
      fs.renameSync(tmp, file);
    } catch (err) {
      log(`Could not save settings: ${err.message}`);
    }
  }

  return {
    spec: SPEC,

    get(key) {
      return values[key];
    },

    all() {
      return { ...values };
    },

    // What a setting *does*, registered by whoever owns the thing it does it
    // to. Called after the new value is in the store, so a handler reading
    // other settings sees the whole patch already applied.
    on(key, fn) {
      if (!BY_KEY.has(key)) throw new Error(`no such setting: ${key}`);
      handlers.set(key, fn);
    },

    // Returns { ok, changed: [key], values } or { ok: false, error }. An
    // unknown key is an error rather than a silent drop: this is reachable from
    // a browser, and a typo that quietly does nothing looks exactly like a
    // setting that does not work.
    set(patch) {
      const wanted = new Map();
      for (const [key, raw] of Object.entries(patch || {})) {
        const spec = BY_KEY.get(key);
        if (!spec) return { ok: false, error: `no such setting: ${key}` };
        const out = coerce(spec, raw);
        if (out.error) return { ok: false, error: out.error };
        wanted.set(key, out.value);
      }
      // In schema order, not patch order, so the effects of a multi-key change
      // land in the same sequence however the request happened to be written.
      const changed = SPEC.filter((s) => wanted.has(s.key) && wanted.get(s.key) !== values[s.key]);
      for (const spec of changed) values[spec.key] = wanted.get(spec.key);
      if (changed.length) {
        save();
        for (const spec of changed) handlers.get(spec.key)?.(values[spec.key]);
      }
      return { ok: true, changed: changed.map((s) => s.key), values: { ...values } };
    },
  };
}

module.exports = { createSettings, SETTINGS_SPEC: SPEC };
