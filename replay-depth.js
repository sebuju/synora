'use strict';

// The measurement the depth ban asks for: ARCore's depth samples against the
// tag solver's own geometry. Every journaled tag sighting carries tvec — the
// tag's position in the camera frame, solved from its corners at millimetre
// grade — and, on builds that sample it, `d`, the depth-map reading at the
// tag's centre pixel. tvec[2] is the ground truth for exactly the number the
// depth map claims (distance along the view z), so the error distribution
// here IS the answer to "is this depth source good enough", per tag, per
// distance, with no argument left to have.
//
//   node replay-depth.js recordings/<stamp>_clientN.pose.jsonl [more ...]
//
// Tracked points' `d` values are counted for coverage but not judged — there
// is no truth to hold them against frame by frame; the tags are the ruler.

const { parseArgs, readJournals } = require('./replay-common.js');

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node replay-depth.js <journal.pose.jsonl> [more ...]');
  process.exit(1);
}

const { positional: journals } = parseArgs(process.argv.slice(2), { usage });
if (!journals.length) usage();

let lines = 0;
let tagSightings = 0;
let tagSampled = 0;
let ptTotal = 0;
let ptSampled = 0;
const errs = [];   // { z, err } — err = depth - tvec[2], metres
for (const { entry } of readJournals(journals, { onError: usage })) {
  lines++;
  const msg = entry.msg;
  if (entry.kind !== 'xr-pose' && entry.kind !== 'pose') continue;
  for (const t of msg?.tags || []) {
    tagSightings++;
    if (t.d == null || !Array.isArray(t.tvec)) continue;
    tagSampled++;
    errs.push({ z: t.tvec[2], err: t.d - t.tvec[2] });
  }
  for (const p of msg?.points || []) {
    ptTotal++;
    if (p.d != null) ptSampled++;
  }
}

const pct = (arr, p) => (arr.length
  ? arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] : NaN);
const stat = (list) => {
  const abs = list.map((e) => Math.abs(e.err) * 1000);
  const signed = list.map((e) => e.err * 1000);
  return `n ${list.length}  |err| median ${pct(abs, 0.5).toFixed(0)} mm, `
    + `p90 ${pct(abs, 0.9).toFixed(0)} mm, worst ${Math.max(...abs).toFixed(0)} mm  `
    + `bias ${pct(signed, 0.5).toFixed(0)} mm`;
};

console.log(`\n${journals.length} journal(s), ${lines} entries`);
console.log(`tag sightings ${tagSightings}, with a depth sample ${tagSampled}`
  + (tagSightings ? ` (${(100 * tagSampled / tagSightings).toFixed(0)}%)` : ''));
console.log(`tracked points ${ptTotal}, with a depth sample ${ptSampled}`
  + (ptTotal ? ` (${(100 * ptSampled / ptTotal).toFixed(0)}%)` : ''));
if (!errs.length) {
  console.log('\nNo depth-sampled tag sightings. Either the journal predates the '
    + 'sampling build, or the device did not grant depth-sensing.');
  process.exit(0);
}
console.log(`\ndepth vs solved tag distance (tvec z):`);
console.log(`  all        ${stat(errs)}`);
// Distance buckets: depth-from-motion degrades with range, and the number
// that matters is the error at the ranges the walls are actually carved at.
for (const [lo, hi] of [[0, 1], [1, 2], [2, 3], [3, 5], [5, Infinity]]) {
  const b = errs.filter((e) => e.z >= lo && e.z < hi);
  if (b.length) {
    console.log(`  ${`${lo}-${hi === Infinity ? '∞' : hi} m`.padEnd(9)}  ${stat(b)}`);
  }
}
// A bias whose sign tracks the distance is calibration; a huge symmetric
// spread is noise; errors that mirror with screen height would be the Y
// convention in depthAt() being wrong — three different verdicts, all
// readable from the lines above.
