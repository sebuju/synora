'use strict';

const { createHistoryStore, HISTORY_VERSION } = require('./history-store.js');

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
// All of the machinery is `history-store.js`, which the object map uses for the
// same purpose. What is left here is the one thing that is actually about tags:
// what a sample of one *is*. The rest — the thinning, the throttle, the event
// log, the anchor stamp, the debounced atomic write — is the same problem in
// both places and has one implementation.

// One sample a second. Refinement runs at 10 Hz per client and nothing a tag does
// is legible at that rate — the pose moves by REFINE_ALPHA of a small
// disagreement per sighting — so a tenth of the samples describe the same curve.
const SAMPLE_MS = 1000;

// Samples kept per tag before the old end is thinned.
const MAX_SAMPLES = 600;

// Events are rare (a promotion, a re-seed) and each one is a sentence, so a small
// cap holds a long session's worth.
const MAX_EVENTS = 40;

// Longer than the map's own debounce: this file grows by a few hundred bytes a
// second per visible tag while a survey is being walked, and unlike the map
// nothing downstream is waiting on it being current.
const SAVE_DEBOUNCE_MS = 30000;

// Sample wire/disk form, in order: [t, x, y, z, qx, qy, qz, qw, residMm,
// residDeg].
function packSample(t, {
  p, q, resid, residDeg,
}) {
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

function createTagHistory({ file, log, anchorId }) {
  return createHistoryStore({
    file,
    log,
    anchorId,
    label: 'Tag history',
    // Part of the file's format: every markers-history.json written before this
    // module was split uses this name, and they are still perfectly good.
    key: 'tags',
    pack: packSample,
    sampleMs: SAMPLE_MS,
    maxSamples: MAX_SAMPLES,
    maxEvents: MAX_EVENTS,
    saveDebounceMs: SAVE_DEBOUNCE_MS,
  });
}

module.exports = { createTagHistory, HISTORY_VERSION };
