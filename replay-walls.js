'use strict';

// Replay recorded pose journals through the walls module, so carving quality
// is measured instead of argued: acceptance histograms, free area, wall
// extents, and the leak count (free cells behind a tag plane — wrong by
// construction) for any gate setting, against sessions already on disk.
//
//   node replay-walls.js recordings/<stamp>_clientN.pose.jsonl [more ...]
//     [--markers markers.json] [--jitter-mm 25] [--min-views 2]
//     [--tagonly-scale 0.5] [--out grid.json] [--pgm grid.pgm] [--ascii]
//
// The journal lines are fed verbatim to walls.handleReport — the exact
// function the live server calls with the exact object it journals, so a
// replay exercises the real code path. Two known asymmetries, both accepted:
// live carving sees the marker map evolving (promotions, refinement) while a
// replay uses the final markers.json for every endpoint — centimetres of
// difference at 6 cm cells, and replays are for *relative* comparisons; and
// journals do not record survey resets, so a journal spanning one mixes two
// room frames (rare — replay such sessions in pieces).
//
// No Date.now() drives anything here: the walls core is clock-free, and no
// `file` is passed to createWalls so its save debounce is never armed — the
// grid leaves through --out/--pgm explicitly.

const fs = require('fs');
const path = require('path');
const { createWalls, DEFAULTS } = require('./walls.js');

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node replay-walls.js <journal.pose.jsonl> [more ...]\n'
    + '  [--markers markers.json] [--jitter-mm N] [--jitter-soft-mm N] [--min-views N]\n'
    + '  [--tagonly-scale X] [--frustum-scale X] [--cell-m X]\n'
    + '  [--out grid.json] [--pgm grid.pgm] [--ascii]');
  process.exit(1);
}

const journals = [];
const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (key === 'ascii') {
      flags.ascii = true;
    } else {
      if (i + 1 >= argv.length) usage(`missing value for --${key}`);
      flags[key] = argv[++i];
    }
  } else {
    journals.push(a);
  }
}
if (!journals.length) usage();

const markersFile = flags.markers || path.join(__dirname, 'markers.json');
let rawMap;
try {
  rawMap = JSON.parse(fs.readFileSync(markersFile, 'utf8'));
} catch (err) {
  usage(`cannot read ${markersFile}: ${err.message}`);
}

// markers.json is object-keyed; the walls module takes the getMarkerMap()
// array shape. clippedTo is live-only state and is not in the file — plane
// grouping falls back to the geometric predicate, which is the same test.
const markerMap = {
  anchorId: rawMap.anchorId,
  sizeM: rawMap.markerSizeM,
  markers: Object.entries(rawMap.markers || {}).map(([id, m]) => ({
    id: Number(id), p: m.p, q: m.q,
    hops: Number.isFinite(m.hops) ? m.hops : null,
    clippedTo: null,
  })),
};

const opts = {};
if (flags['jitter-mm'] !== undefined) opts.maxJitterMm = Number(flags['jitter-mm']);
if (flags['jitter-soft-mm'] !== undefined) opts.softJitterMm = Number(flags['jitter-soft-mm']);
if (flags['min-views'] !== undefined) opts.minViews = Number(flags['min-views']);
if (flags['tagonly-scale'] !== undefined) opts.tagonlyScale = Number(flags['tagonly-scale']);
if (flags['frustum-scale'] !== undefined) opts.frustumScale = Number(flags['frustum-scale']);
if (flags['cell-m'] !== undefined) opts.cellM = Number(flags['cell-m']);
for (const [k, v] of Object.entries(opts)) {
  if (!Number.isFinite(v)) usage(`bad number for ${k}`);
}

const walls = createWalls({
  log: (m) => console.log(m),
  markerSizeM: rawMap.markerSizeM,
  opts,
});
walls.setMarkerMap(markerMap);

let lines = 0;
for (const file of journals) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    usage(`cannot read ${file}: ${err.message}`);
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;   // torn final line of a journal cut off mid-write
    }
    if (entry.kind === 'meta') {
      if (entry.markerSizeM !== rawMap.markerSizeM) {
        usage(`${path.basename(file)} was recorded with ${entry.markerSizeM} m markers, `
          + `${path.basename(markersFile)} says ${rawMap.markerSizeM} m — refusing to mix scales`);
      }
      continue;
    }
    lines++;
    walls.handleReport(entry);
  }
}

const s = walls.stats();
const segs = walls.getWalls();
const leakCount = walls.leaks();

const rejLine = (rej) => Object.entries(rej)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${v}`)
  .join(', ') || 'none';

console.log(`\n${journals.length} journal(s), ${lines} pose reports`);
console.log(`reports accepted ${s.reports.accepted}/${s.reports.total}`
  + ` — rejected: ${rejLine(s.reports.rej)}`);
console.log(`rays    accepted ${s.rays.accepted}/${s.rays.total}`
  + ` — rejected: ${rejLine(s.rays.rej)}`);
console.log(`grid: ${s.cells} cells touched, ${s.free} free / ${s.occ} occupied`
  + ` (${s.freeM2} m² attested free)`);
console.log(`leaks: ${leakCount} free cell(s) behind a tag plane`
  + ' (wrong by construction — this is the gate-quality headline)');
console.log(`walls: ${segs.length} segment(s)`);
for (const seg of segs) {
  const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
  const ext = seg.ext
    ? ` (corner-extended${seg.ext.a ? ` a+${seg.ext.a}m` : ''}${seg.ext.b ? ` b+${seg.ext.b}m` : ''})`
    : '';
  console.log(`  tags [${seg.ids.join(' ')}] `
    + `(${seg.a[0].toFixed(2)}, ${seg.a[1].toFixed(2)}) -> `
    + `(${seg.b[0].toFixed(2)}, ${seg.b[1].toFixed(2)}), ${len.toFixed(2)} m${ext}`);
}

// Cell bounds shared by the ascii and pgm renderings.
function gridBounds(floor) {
  let minIx = Infinity;
  let maxIx = -Infinity;
  let minIz = Infinity;
  let maxIz = -Infinity;
  const scan = (arr) => {
    for (let i = 0; i < arr.length; i += 2) {
      minIx = Math.min(minIx, arr[i]); maxIx = Math.max(maxIx, arr[i]);
      minIz = Math.min(minIz, arr[i + 1]); maxIz = Math.max(maxIz, arr[i + 1]);
    }
  };
  scan(floor.free);
  scan(floor.occ);
  return Number.isFinite(minIx) ? { minIx, maxIx, minIz, maxIz } : null;
}

const floor = walls.getFloor();
const bounds = gridBounds(floor);

if (flags.ascii && bounds) {
  // Downsample so the room fits a terminal; any occupied cell in a block wins
  // over free, free over unknown — the honest order for an eyeball check.
  const step = Math.max(1, Math.ceil((bounds.maxIx - bounds.minIx + 1) / 100));
  const cols = Math.ceil((bounds.maxIx - bounds.minIx + 1) / step);
  const rows = Math.ceil((bounds.maxIz - bounds.minIz + 1) / step);
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(' '));
  const mark = (arr, ch, keep) => {
    for (let i = 0; i < arr.length; i += 2) {
      const cx = Math.floor((arr[i] - bounds.minIx) / step);
      const cz = Math.floor((arr[i + 1] - bounds.minIz) / step);
      if (!keep || grid[cz][cx] === ' ') grid[cz][cx] = ch;
    }
  };
  mark(floor.free, '.', true);
  mark(floor.occ, '#', false);
  console.log(`\nascii floor plan (${step} cell(s) per char, `
    + `x right, z down, '.' free, '#' wall):`);
  for (const row of grid) console.log(row.join(''));
}

if (flags.out) {
  fs.writeFileSync(flags.out, JSON.stringify({
    stats: s, leaks: leakCount, walls: segs, floor,
  }));
  console.log(`grid written to ${flags.out}`);
}

if (flags.pgm && bounds) {
  // Grayscale log-odds: mid grey unknown, white free, black occupied. P5.
  const w = bounds.maxIx - bounds.minIx + 1;
  const h = bounds.maxIz - bounds.minIz + 1;
  const px = Buffer.alloc(w * h, 128);
  const paint = (arr, val) => {
    for (let i = 0; i < arr.length; i += 2) {
      px[(arr[i + 1] - bounds.minIz) * w + (arr[i] - bounds.minIx)] = val;
    }
  };
  paint(floor.free, 255);
  paint(floor.occ, 0);
  const header = Buffer.from(`P5\n${w} ${h}\n255\n`, 'ascii');
  fs.writeFileSync(flags.pgm, Buffer.concat([header, px]));
  console.log(`pgm written to ${flags.pgm} (${w}x${h})`);
}
