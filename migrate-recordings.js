'use strict';

// Convert a flat `recordings/` directory into one directory per walk.
//
//   node migrate-recordings.js            # say what would move, touch nothing
//   node migrate-recordings.js --apply    # move it
//   node migrate-recordings.js --undo     # put it back, from the manifest
//
// The server writes the new layout directly; this exists for the corpus already
// on disk, which is the whole evidence base every replay comparison in this
// project runs against and therefore is not something to rearrange by hand.
//
// **Grouping.** A walk's files are opened at different moments — the pose
// journal when the first pose arrives, the recording when someone presses
// record, the frame log when the XR session announces itself — so their stamps
// differ by a second or two and there is no shared key in the names. What there
// is, is the client id and the clock: files of the same client whose stamps fall
// within `CLUSTER_S` of the previous one are one walk, named for the earliest.
// Measured against this corpus: within a walk the spread is 0-2 s, and the
// nearest two genuinely separate walks are 18 s apart, so the window is set well
// below that gap rather than at some round number.
//
// `phoneN` is the pre-rename spelling of `clientN` and groups the same way — it
// is the same device under an older name, and its calibration and settings live
// on the server under one deviceId — which is why those recordings are still
// worth keeping.
//
// A manifest is written beside the result so the move is reversible. This is a
// bulk rename of the only irreplaceable thing in the repo; "it can be undone" is
// not a nicety.

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./replay-common.js');

const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const MANIFEST = path.join(RECORDINGS_DIR, '.migration.json');
const CLUSTER_S = 5;

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node migrate-recordings.js [--apply] [--undo]');
  process.exit(1);
}

const { flags } = parseArgs(process.argv.slice(2), {
  booleans: ['apply', 'undo'], usage,
});

// `2026-08-05_142018_client1.pose.jsonl` -> stamp, client, extension.
// The stamp is parsed rather than string-compared because the clustering is a
// question about seconds, and `_235958_` to `_000002_` is four seconds.
const NAME = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})_((?:client|phone)\d+)\.(.+)$/;

function parseName(name) {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, who, ext] = m;
  return {
    name,
    who,
    ext,
    at: Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss) / 1000,
    stamp: `${y}-${mo}-${d}_${hh}${mm}${ss}`,
  };
}

// What a file is called inside its walk's directory. The stamp goes: the
// directory carries it, and repeating it in every child was most of what made
// the flat layout unreadable. The suffix survives because the replay tools match
// on it.
const INNER = [
  [/^pose\.jsonl$/, 'pose.jsonl'],
  [/^obj\.jsonl$/, 'frames.obj.jsonl'],
  [/^frames$/, 'frames.frames'],
  [/^webm$/, 'capture.webm'],
  [/^images$/, 'images'],
];

function innerName(ext) {
  for (const [re, to] of INNER) if (re.test(ext)) return to;
  return ext;              // anything unrecognised keeps its own tail
}

// A second file of the same kind in one walk — the recorder is rebuilt on a
// camera switch, a resolution change and a mic toggle, so several `.webm` per
// walk is normal, not a collision to refuse.
function uniqueName(dir, want, taken) {
  if (!taken.has(`${dir}/${want}`)) { taken.add(`${dir}/${want}`); return want; }
  const dot = want.indexOf('.');
  for (let i = 2; ; i++) {
    const alt = dot < 0 ? `${want}-${i}` : `${want.slice(0, dot)}-${i}${want.slice(dot)}`;
    if (!taken.has(`${dir}/${alt}`)) { taken.add(`${dir}/${alt}`); return alt; }
  }
}

function plan() {
  const entries = [];
  for (const name of fs.readdirSync(RECORDINGS_DIR).sort()) {
    const parsed = parseName(name);
    if (parsed) entries.push(parsed);
  }
  // Grouped per client, then clustered in time. Sorting inside the client keeps
  // the cluster walk linear and makes the earliest file the one that names the
  // directory.
  const byWho = new Map();
  for (const e of entries) {
    if (!byWho.has(e.who)) byWho.set(e.who, []);
    byWho.get(e.who).push(e);
  }
  const moves = [];
  const taken = new Set();
  for (const [who, list] of byWho) {
    list.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
    let dir = null;
    let last = -Infinity;
    for (const e of list) {
      if (e.at - last > CLUSTER_S) dir = `${e.stamp}_${who}`;
      last = e.at;
      moves.push({ from: e.name, dir, to: uniqueName(dir, innerName(e.ext), taken) });
    }
  }
  return moves;
}

function apply(moves) {
  const done = [];
  for (const m of moves) {
    const from = path.join(RECORDINGS_DIR, m.from);
    const dir = path.join(RECORDINGS_DIR, m.dir);
    const to = path.join(dir, m.to);
    fs.mkdirSync(dir, { recursive: true });
    // Refused rather than overwritten: the only way this collides is a bug in
    // the naming above, and losing a walk to it is not a recoverable mistake.
    if (fs.existsSync(to)) {
      console.error(`REFUSED ${m.from}: ${path.relative(RECORDINGS_DIR, to)} already exists`);
      continue;
    }
    // A running server holds write handles on the walk in progress, and Windows
    // refuses to rename an open file. Skipped rather than fatal, and the whole
    // point of that is that re-running finishes the job once it is closed — a
    // half-migrated tree with no manifest would be the worst outcome available.
    try {
      fs.renameSync(from, to);
    } catch (err) {
      console.error(`SKIPPED ${m.from}: ${err.code || err.message} (in use? re-run when closed)`);
      continue;
    }
    done.push(m);
  }
  fs.writeFileSync(MANIFEST, JSON.stringify({ at: Date.now(), moves: done }, null, 1));
  console.log(`\nmoved ${done.length} entries into ${new Set(done.map((m) => m.dir)).size} `
    + `session directories\nmanifest: ${path.relative(__dirname, MANIFEST)} `
    + '(node migrate-recordings.js --undo puts it back)');
}

function undo() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    usage(`no manifest at ${path.relative(__dirname, MANIFEST)} — nothing to undo`);
  }
  let n = 0;
  for (const m of raw.moves.slice().reverse()) {
    const from = path.join(RECORDINGS_DIR, m.dir, m.to);
    const to = path.join(RECORDINGS_DIR, m.from);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.renameSync(from, to);
    n++;
  }
  for (const dir of new Set(raw.moves.map((m) => m.dir))) {
    try { fs.rmdirSync(path.join(RECORDINGS_DIR, dir)); } catch { /* not empty: leave it */ }
  }
  fs.unlinkSync(MANIFEST);
  console.log(`restored ${n} entries to the flat layout`);
}

if (flags.undo) {
  undo();
} else {
  const moves = plan();
  if (!moves.length) {
    console.log('nothing to migrate — no flat <stamp>_client<N>.<ext> entries found');
    process.exit(0);
  }
  const dirs = new Set(moves.map((m) => m.dir));
  console.log(`${moves.length} entries -> ${dirs.size} session directories`);
  // A sample rather than all 400 lines, plus every directory that came out with
  // only one file in it — those are the ones where the clustering has nothing to
  // check itself against and are worth a glance before this is applied.
  const perDir = new Map();
  for (const m of moves) perDir.set(m.dir, (perDir.get(m.dir) || 0) + 1);
  for (const m of moves.slice(-12)) {
    console.log(`  ${m.from}  ->  ${m.dir}/${m.to}`);
  }
  const singles = [...perDir].filter(([, n]) => n === 1);
  console.log(`\ndirectories holding one entry: ${singles.length} of ${dirs.size}`);
  if (!flags.apply) console.log('\ndry run — pass --apply to move');
  else apply(moves);
}
