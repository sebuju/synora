'use strict';

// What every replay tool needs before it can start measuring anything: the
// command line, and the journal.
//
// Both tools grew their own copy of this, and the copies had already drifted —
// one coerced every flag to a number at parse time and the other kept strings,
// so the same `--flag` spelling behaved differently depending on which replay
// was being run. The journal readers were the same code twice with the meta
// line handled differently, which is exactly the sort of difference that makes
// two replays of one session disagree for a reason nobody thinks to look for.
//
// This is deliberately not a framework. It knows what a journal line is and
// what an argument looks like; what to do with either belongs to the tool.

const fs = require('fs');
const path = require('path');

// `--key value`, plus bare positionals, plus the flags named in `booleans`
// which take no value. Values come back as strings — the caller converts, since
// only it knows which of its flags are numbers, which are paths and which are
// present/absent.
function parseArgs(argv, { booleans = [], usage } = {}) {
  const bail = usage || ((msg) => { console.error(msg); process.exit(1); });
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    if (booleans.includes(key)) {
      flags[key] = true;
      continue;
    }
    if (i + 1 >= argv.length) bail(`missing value for --${key}`);
    flags[key] = argv[++i];
  }
  return { positional, flags };
}

// A numeric flag, or the default. Refuses rather than quietly reading NaN into
// a threshold, which is the failure that produces a replay that measures
// nothing and says so nowhere.
function numFlag(flags, key, dflt, usage) {
  if (flags[key] === undefined) return dflt;
  const v = Number(flags[key]);
  if (!Number.isFinite(v)) {
    (usage || ((m) => { console.error(m); process.exit(1); }))(`bad number for --${key}`);
  }
  return v;
}

// Journal lines, in order, across every file given.
//
// Two details both callers depend on and neither should have to remember: the
// final line of a journal cut off mid-write is torn and is skipped rather than
// killing the run, and the `meta` line is handed to the caller instead of being
// swallowed — walls has to refuse a marker size that does not match its map,
// while other callers have nothing to check.
// Journals live one per walk inside a session directory, so a path that is a
// directory is walked rather than refused. That keeps `node replay-x.js
// recordings` working as the whole-corpus command it always was, now that
// `recordings/*.pose.jsonl` matches nothing — and a directory of directories is
// the shape every one of these tools is handed.
//
// One level of nesting is all the layout has, and all this looks for: a deeper
// walk would start reading whatever else somebody put under `recordings/`.
// The suffix carries no leading dot on purpose: inside a session directory the
// journal is simply `pose.jsonl` (the directory already says whose walk it is),
// while the pre-migration corpus spells it `<stamp>_client<N>.pose.jsonl`.
// `endsWith('pose.jsonl')` is the one test that matches both, and getting this
// wrong is silent — the tool reports zero reports and looks like an empty room.
function expandJournals(paths, suffix = 'pose.jsonl') {
  const out = [];
  for (const p of paths) {
    let st;
    try { st = fs.statSync(p); } catch { out.push(p); continue; }
    if (!st.isDirectory()) { out.push(p); continue; }
    for (const name of fs.readdirSync(p).sort()) {
      const child = path.join(p, name);
      if (name.endsWith(suffix)) { out.push(child); continue; }
      let cst;
      try { cst = fs.statSync(child); } catch { continue; }
      if (!cst.isDirectory()) continue;
      for (const inner of fs.readdirSync(child).sort()) {
        if (inner.endsWith(suffix)) out.push(path.join(child, inner));
      }
    }
  }
  return out;
}

function* readJournals(paths, { onMeta, onError } = {}) {
  const fail = onError || ((msg) => { console.error(msg); process.exit(1); });
  const files = expandJournals(paths);
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      fail(`cannot read ${file}: ${err.message}`);
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.kind === 'meta') {
        onMeta?.(entry, file);
        continue;
      }
      yield { file, entry };
    }
  }
}

module.exports = { parseArgs, numFlag, readJournals, expandJournals };
