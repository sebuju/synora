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
  {
    key: 'objFramesEnabled',
    label: 'Object frames',
    group: 'Object frames',
    type: 'bool',
    def: true,
    help: 'Send a small downscaled JPEG from /xr-client a few times a second, for the object '
      + 'detector on this PC to look at. Measured cost to the phone: detection rate 5.4-6.2/s '
      + 'against a 6.38/s baseline, 6-7 ms of frame time and a 21-26 ms encode off the main '
      + 'thread. Costs roughly 5 MB of disk per minute walked. Turn it off if the phone is '
      + 'doing pose work that has nothing to do with objects.',
  },
  {
    key: 'objFrameRateMs',
    label: 'Object frame interval',
    group: 'Object frames',
    type: 'number',
    def: 250,
    min: 100,
    max: 5000,
    step: 50,
    unit: 'ms',
    help: 'How often an object frame is produced. Capped by the tag detection rate whatever '
      + 'this says: the frame comes from the readback the detector already did, so there is '
      + 'no object frame without a detection frame. Setting it at or below the achieved '
      + 'detection interval means "every frame". More frames is what gets an object seen the '
      + 'eight times promotion asks for — the ones that fail are mostly glimpsed once while '
      + 'turning — and it costs the phone detection rate. Measured on disk: 31 KB a frame, so '
      + '3.8 MB per minute at 2 Hz and 7.6 at 4 Hz.',
  },
  {
    key: 'objFrameLongEdge',
    label: 'Object frame size',
    group: 'Object frames',
    type: 'number',
    def: 640,
    min: 320,
    max: 1920,
    step: 32,
    unit: 'px',
    help: 'Long edge of the object frame. Rounded down to a whole-number decimation of the '
      + 'camera image, so the real size is usually a little under this. Tag detection runs at '
      + 'native resolution and is untouched by this — a tag corner needs sub-pixel accuracy, '
      + 'a bounding box needs about one percent of the frame.',
  },
  {
    key: 'objFrameQuality',
    label: 'Object frame quality',
    group: 'Object frames',
    type: 'number',
    def: 0.6,
    min: 0.2,
    max: 0.95,
    step: 5,
    unit: '%',
    scale: 100,
    help: 'JPEG quality for object frames. These are recorded to recordings/*.frames so the '
      + 'detector can be re-run offline against a different model without another walk around '
      + 'the room, which is the main thing spending bytes here buys.',
  },
  {
    key: 'objFrameDepth',
    label: 'Object frame depth',
    group: 'Object frames',
    type: 'bool',
    def: true,
    help: 'Send ARCore\'s depth map alongside each object frame. It is the only way depth can '
      + 'reach a detected object at all — the boxes are found on this PC, long after the frame '
      + 'that owned the depth is gone. Measured: 160x90, 28.2 KB, present on 55% of frames, '
      + 'against a 15.5 KB picture — so it is nearly two thirds of the channel, and turning it '
      + 'off is the cheapest big saving. It only ever acts as a prior inside 3.5 m; objects '
      + 'beyond that never read it, and a phone that refuses depth-sensing sends none.',
  },
  {
    key: 'objDetectorModel',
    label: 'Object detector',
    group: 'Object detection',
    type: 'string',
    // Objects365 by default, measured rather than assumed over the same 2063
    // recorded frames: half the cost (78 ms against 164), ten points fewer
    // clipped boxes, and an anchor population of pictures, cabinets and
    // speakers where COCO's was books and microwaves. Same anchor count either
    // way — it is what gets promoted that changed.
    def: 'yoloe-o365.onnx',
    // Declared here rather than read off models/: see the string branch in
    // coerce(). A selected model that has not been downloaded reports itself
    // once, in the log, as "missing ... run npm run fetch-vendor".
    values: ['rtdetr.onnx', 'yoloe-o365.onnx'],
    danger: 'The two models name classes differently — the existing map may fragment',
    help: 'Which network looks at the object frames. rtdetr.onnx is COCO\'s 80 classes at '
      + 'about 138 ms a frame on this PC; yoloe-o365.onnx is Objects365\'s 365 at about 61 ms, '
      + 'and adds cabinet, picture, lamp, radiator, desk and nightstand — the immovable things '
      + 'an anchor map wants and COCO cannot name. Neither has a door or a window class. '
      + 'Changing this reloads the detector on the next frame; classes that both models spell '
      + 'the same survive in the map, ones they do not become separate objects.',
  },
  {
    key: 'objOutlines',
    label: 'Object outlines',
    group: 'Object detection',
    type: 'bool',
    def: false,
    help: 'Fit the actual outline of a detected thing — an ellipse for a clock, a quad for a '
      + 'picture, a monitor, a cabinet — inside the box the detector drew, and use it to '
      + 'measure the object\'s real size and which way it faces. A bounding box carries four '
      + 'numbers and an outline carries eight, which is what a full pose costs: an object of '
      + 'known shape is a virtual tag, and ONE of those in frame can place the camera where '
      + 'three mapped objects are needed today. Costs about 1-3 ms of this PC per frame beside '
      + 'the detector\'s own 78. Nothing on the phone fits anything; it hands over the frame. '
      + 'The recovered pose feeds nothing — it is published beside the survey\'s own and the '
      + 'disagreement is the product.',
  },
  {
    key: 'objOutlineDebug',
    label: 'Show detections on the phone',
    group: 'Object detection',
    type: 'bool',
    def: false,
    help: 'Push each frame\'s detections back to the client that sent it, drawn as a box with the '
      + 'name and score, and inside it the fitted outline, dashed and pale, wherever a shape was '
      + 'fitted. Drawn through the camera model of the frame they came from, so they land on the '
      + 'object whatever the object map believes — the cost is the round trip, about a third of '
      + 'a second, which shows as lag while the phone is moving and as nothing while it is '
      + 'still. Only detections the map accepted and is currently listing are drawn, each in its '
      + 'own object colour: the raw stream is the whole vocabulary at the score floor, and boxes '
      + 'for classes the allow-list will never take read as the map having lost them.',
  },
  {
    key: 'objOutlineMinPx',
    label: 'Smallest outline',
    group: 'Object detection',
    type: 'number',
    def: 24,
    min: 12,
    max: 120,
    step: 2,
    unit: 'px',
    help: 'Shortest box side worth fitting an outline to, in object-frame pixels. This is what '
      + 'decides which objects are eligible at all: at 3 m in a 287x640 frame a 0.62 m clock is '
      + 'about 91 px across and a light switch is about 13. Below the floor there is no '
      + 'recoverable boundary and the fitter would be reading JPEG blocks.',
  },
  {
    key: 'objSaveCamera',
    label: 'Save camera frames',
    group: 'Saved images',
    type: 'bool',
    def: false,
    help: 'Write each object frame as a plain JPEG into '
      + 'recordings/<stamp>_client<N>.images/. Off by default because the same bytes are '
      + 'already in the .frames log and every tool reads them from there — this is for when '
      + 'the pictures need to be looked through, sorted or handed to something else.',
  },
  {
    key: 'objSaveBoxes',
    label: 'Save detection overlays',
    group: 'Saved images',
    type: 'bool',
    def: false,
    help: 'Write the camera frame with the detector\'s boxes and labels drawn on it, into '
      + 'recordings/<stamp>_client<N>.images/. This is the only direct answer to "did it see '
      + 'what it says it saw", and the way a new model\'s box decoding gets checked: boxes '
      + 'sitting consistently high or low mean the letterbox is wrong, and one object wearing '
      + 'five boxes means the duplicate suppression is too weak. Written when the detector '
      + 'finishes with a frame rather than when it arrives, so a frame dropped as busy has no '
      + 'overlay. Costs a decode, a draw and a re-encode off the socket path.',
  },
  {
    key: 'objSaveOverlay',
    label: 'Save depth overlays',
    group: 'Saved images',
    type: 'bool',
    def: true,
    help: 'Write the camera frame with its depth map blended over it in colour (turbo, near '
      + 'blue to far red, same 6 m scale as the depth PNG). This is the one that answers '
      + 'whether a depth reading actually belongs to the thing it is being read for; two '
      + 'pictures side by side cannot. Costs a decode, a per-pixel blend and a re-encode — '
      + '20-80 ms of this PC per frame, off the socket path. Pixels with no reading are left '
      + 'as the photograph, so gaps in ARCore coverage are visible as gaps.',
  },
  {
    key: 'objDepthImages',
    label: 'Save depth images',
    group: 'Saved images',
    type: 'bool',
    def: true,
    help: 'Write each depth map as a 16-bit grayscale PNG into '
      + 'recordings/<stamp>_client<N>.images/, so it can just be opened. Turned into the '
      + 'camera picture\'s own orientation first — ARCore hands over a sideways 160x90 '
      + 'buffer — and at a fixed 6 m full scale, so two frames are comparable and a pixel '
      + 'value is a real distance rather than a per-frame stretch: metres = value / 65535 * 6. '
      + '0 means no reading. Six metres because the median reading here is 2.15 m and only '
      + '0.7% exceed it.',
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
  if (spec.type === 'string') {
    // A closed set declared in the schema, never an open string. Two reasons,
    // both load-bearing: this module deliberately knows nothing about what a
    // setting does and must not go looking at the filesystem to validate one,
    // and the only string setting so far becomes a path — a fixed list cannot
    // contain a separator, so a hand-edited settings file cannot turn into a
    // way to read something outside models/.
    if (typeof raw !== 'string') return { error: `${spec.key} must be a string` };
    if (!spec.values?.includes(raw)) {
      return { error: `${spec.label} must be one of: ${(spec.values || []).join(', ')}` };
    }
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
