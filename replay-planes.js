'use strict';

// Replay recorded xr-planes journal entries against the surveyed marker map,
// so ARCore's plane geometry is measured instead of trusted: per vertical
// plane, the angle and perpendicular distance to the nearest surveyed tag
// plane. This is the number that decides whether planes may ever feed the
// walls grid — the same bar the depth pipeline failed and was removed for.
//
//   node replay-planes.js recordings/<stamp>_clientN.pose.jsonl [more ...]
//     [--markers markers.json] [--match-deg 30] [--match-m 0.6]
//
// The journal carries planes in the session frame (deliberately — see the
// server's maintainPlanes). The room mapping is re-derived here the way the
// live server derives it: from the alignment implied by each tag-confirmed
// xr-pose entry (room = T ∘ session, so T = room ∘ session⁻¹), tracked per
// session id as the journal streams. Compare only against a *fixed*
// markers.json — the live server rewrites it mid-session.

const fs = require('fs');
const path = require('path');
const { parseArgs, readJournals } = require('./replay-common.js');
const {
  se3Compose, se3Invert, quatRotate, transformPoint,
} = require('./public/pose-math.js');

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node replay-planes.js <journal.pose.jsonl> [more ...]\n'
    + '  [--markers markers.json] [--match-deg N] [--match-m X]');
  process.exit(1);
}

const { positional: journals, flags } = parseArgs(process.argv.slice(2), { usage });
if (!journals.length) usage();

const markersFile = flags.markers || path.join(__dirname, 'markers.json');
let rawMap;
try {
  rawMap = JSON.parse(fs.readFileSync(markersFile, 'utf8'));
} catch (err) {
  usage(`cannot read ${markersFile}: ${err.message}`);
}
const matchDeg = Number(flags['match-deg'] ?? 30);
const matchM = Number(flags['match-m'] ?? 0.6);
if (!Number.isFinite(matchDeg) || !Number.isFinite(matchM)) usage('bad number');

// Surveyed tag planes: point + outward normal, in the room frame.
const tagPlanes = Object.entries(rawMap.markers || {}).map(([id, m]) => ({
  id: Number(id), p: m.p, n: quatRotate(m.q, [0, 0, 1]),
}));
if (!tagPlanes.length) usage(`${markersFile} holds no tags to compare against`);

// Normal of a 3D polygon (Newell's method) plus its centroid.
function polyPlane(pts) {
  const n = [0, 0, 0];
  const c = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    for (let k = 0; k < 3; k++) c[k] += a[k] / pts.length;
  }
  const len = Math.hypot(...n);
  if (!(len > 1e-9)) return null;
  return { n: n.map((v) => v / len), c };
}

let lines = 0;
let planeSnaps = 0;
let noAlign = 0;
// sid -> room←session transform, refreshed from every tag-confirmed pose.
const alignBySid = new Map();
// planeKey (sid:id) -> latest room-frame measurement, so a plane refined over
// a whole walk is judged once, at its final shape, not once per snapshot.
const latest = new Map();

for (const { entry } of readJournals(journals, { onError: usage })) {
  lines++;
  if (entry.kind === 'xr-pose') {
    // Only a tag-confirmed frame pins the alignment; a 'tracked' one merely
    // rides it. rawPose ?? pose is the journal's raw fix.
    if (entry.room?.quality === 'good' && entry.room.pose && entry.msg?.xr) {
      alignBySid.set(entry.msg.sid ?? null,
        se3Compose(entry.room.pose, se3Invert(entry.msg.xr)));
    }
    continue;
  }
  if (entry.kind !== 'xr-planes') continue;
  planeSnaps++;
  const T = alignBySid.get(entry.msg?.sid ?? null);
  if (!T) { noAlign++; continue; }
  for (const p of entry.msg.planes || []) {
    if (!Array.isArray(p.pts) || p.pts.length < 3) continue;
    const pts = p.pts.map((q) => transformPoint(T, q));
    latest.set(`${entry.msg.sid}:${p.id}`, { orient: p.orient, pts });
  }
}

const angles = [];
const dists = [];
let vertical = 0;
let matched = 0;
const unmatched = [];
for (const [key, pl] of latest) {
  if (pl.orient !== 'v') continue;
  vertical++;
  const g = polyPlane(pl.pts);
  if (!g) continue;
  let best = null;
  for (const t of tagPlanes) {
    // Sign-free: ARCore's polygon winding does not promise which way the
    // normal points, and a wall is the same wall from either side here.
    const cos = Math.abs(g.n[0] * t.n[0] + g.n[1] * t.n[1] + g.n[2] * t.n[2]);
    const ang = Math.acos(Math.min(1, cos)) * 180 / Math.PI;
    const d = Math.abs((g.c[0] - t.p[0]) * t.n[0]
      + (g.c[1] - t.p[1]) * t.n[1] + (g.c[2] - t.p[2]) * t.n[2]);
    if (!best || ang + d * 20 < best.ang + best.d * 20) best = { id: t.id, ang, d };
  }
  if (best && best.ang <= matchDeg && best.d <= matchM) {
    matched++;
    angles.push(best.ang);
    dists.push(best.d * 1000);
  } else {
    // Not an error: a plane with no surveyed wall near it is either noise or
    // exactly the un-tagged wall this feature exists to reach.
    unmatched.push({ key, ang: best?.ang, d: best?.d, span: pl.pts.length });
  }
}

const pct = (arr, p) => (arr.length
  ? arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] : NaN);
console.log(`\n${journals.length} journal(s), ${lines} entries, `
  + `${planeSnaps} plane snapshot(s) (${noAlign} before any alignment)`);
console.log(`distinct planes ${latest.size}, vertical ${vertical}`);
console.log(`matched to a surveyed tag plane (≤${matchDeg}°, ≤${matchM} m): ${matched}`);
if (angles.length) {
  console.log(`  angle    median ${pct(angles, 0.5).toFixed(1)}°, `
    + `p90 ${pct(angles, 0.9).toFixed(1)}°, worst ${Math.max(...angles).toFixed(1)}°`);
  console.log(`  distance median ${pct(dists, 0.5).toFixed(0)} mm, `
    + `p90 ${pct(dists, 0.9).toFixed(0)} mm, worst ${Math.max(...dists).toFixed(0)} mm`);
}
console.log(`unmatched vertical planes: ${unmatched.length}`
  + ' (no surveyed wall nearby — noise, or exactly the un-tagged walls this is for)');
for (const u of unmatched.slice(0, 12)) {
  console.log(`  ${u.key}: nearest ${u.ang === undefined ? '—'
    : `${u.ang.toFixed(1)}° / ${(u.d * 1000).toFixed(0)} mm`}`);
}
