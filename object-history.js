'use strict';

const { createHistoryStore, HISTORY_VERSION } = require('./history-store.js');

// What each mapped object has been doing: where it sat, how tightly its own
// sightings agreed about that, and how it came to be believed.
//
// `objects.json` holds one line per object and that line is always *now*. Every
// question this experiment actually raises is about the path, not the endpoint:
// did this chair arrive where it sits or walk there; was this the third clock
// all along or did two of them merge into it; did the arc grow because the room
// was walked properly or because a fragment was absorbed; was it quarantined for
// something it did, or because a detector that could not name it was loaded.
// None of those can be asked of a position and a counter.
//
// The machinery is `history-store.js`, shared with `tag-history.js`. What is
// here is the one thing that is about objects: what a sample of one is, and
// which moments are worth naming.

// One sample a second. Detections arrive at a few hertz per client and an
// object's position moves by a fraction of a small disagreement per sighting, so
// a second's worth describes the same curve.
const SAMPLE_MS = 1000;

// Samples kept per object before the old end is thinned. Lower than the tags':
// there are an order of magnitude more objects than tags, most of them are seen
// in bursts rather than continuously, and the shape being read here is coarser
// — a step when something merged, a drift when something moved.
const MAX_SAMPLES = 300;

// Events are the point of this record for objects, far more than for tags: an
// object's life is a sequence of named moments (born, promoted, absorbed a
// fragment, quarantined) and the samples are mostly there to date them.
const MAX_EVENTS = 60;

const SAVE_DEBOUNCE_MS = 30000;

// Sample wire/disk form, in order:
//   [t, x, y, z, rMm, arcDeg, priorPct, nObs, cells, confPct]
//
// Position at tenths of a millimetre for the same reason the tags use it: the
// motion worth seeing here is a few centimetres, and the re-seed test that calls
// an object *moved* trips well below that.
//
// The rest are integers at the precision they are actually known to. `r` is the
// 90th-percentile ray residual in millimetres — the scatter, not a size — and
// `priorPct` is how much of the position is the depth prior rather than
// parallax, which is the difference between a measured object and a single
// depth reading wearing a position.
function packSample(t, {
  p, r, arcDeg, priorFrac, nObs, cells, conf,
}) {
  const n = (v) => (v === undefined || v === null ? null : v);
  return [
    t,
    +p[0].toFixed(4), +p[1].toFixed(4), +p[2].toFixed(4),
    r === undefined || r === null ? null : Math.round(r * 1000),
    arcDeg === undefined || arcDeg === null ? null : +arcDeg.toFixed(1),
    priorFrac === undefined || priorFrac === null ? null : Math.round(priorFrac * 100),
    n(nObs),
    n(cells),
    conf === undefined || conf === null ? null : Math.round(conf * 100),
  ];
}

function createObjectHistory({ file, log, anchorId }) {
  return createHistoryStore({
    file,
    log,
    anchorId,
    label: 'Object history',
    key: 'objects',
    pack: packSample,
    sampleMs: SAMPLE_MS,
    maxSamples: MAX_SAMPLES,
    maxEvents: MAX_EVENTS,
    saveDebounceMs: SAVE_DEBOUNCE_MS,
  });
}

module.exports = { createObjectHistory, HISTORY_VERSION };
