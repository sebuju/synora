'use strict';

// Measure the object map against recorded journals, so this experiment is
// settled by numbers rather than by argument — the same bargain replay-walls.js
// and replay-survey.js already make for their own modules.
//
//   node replay-objects.js recordings/*.pose.jsonl --obj recordings [flags]
//
// The pose journal and the detection file are joined on **(sid, fseq)**, never
// on arrival order or on time: the frame and its pose travelled on different
// sockets and their order is not meaningful. `fseq` is minted once per camera
// read on the phone and rides both.
//
// What this has to answer, in order, is whether the object channel can do the
// thing the landmark feature could not. Landmarks measured 12.8% of frames as
// their target case and delivered on 0.1-0.3% of them, with **0** usable
// cross-session re-identifications. Metrics (a) and (b) are the direct
// replacements for those two numbers, and (d) is the one most likely to end
// this: if the same-class instances in this room are closer together than their
// own position scatter, no constellation can tell them apart and the design
// stops there — with a measurement rather than an opinion.
//
// As with the other replays: the marker map is the *final* one for every
// journal while the live run saw it being built, so these are relative
// comparisons between two runs over the same journals, never absolute truth.

const fs = require('fs');
const path = require('path');
const { parseArgs, numFlag, readJournals, expandJournals } = require('./replay-common.js');
const {
  createObjects, DEFAULTS, sub, norm, unit, dot, rayDistance, worldClipAxes,
  tagBoxes, explainedByTag, shapeFor, normClass, resolveNormal, angleDeg,
} = require('./objects.js');
const { quatRotate, sessionAlignment } = require('./public/pose-math.js');

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node replay-objects.js <journal.pose.jsonl> [more ...] --obj <dir|file ...>\n'
    + '  [--score X] [--min-arc-deg X] [--cluster-m X] [--depth-prior 0|1]\n'
    + '  [--class-allow a,b,c] [--localize] [--align] [--view-cell-m X] [--verbose]\n'
    + '  [--min-sightings N] [--merge-every N] [--vocab coco|o365]\n'
    + '  [--veto] [--veto-deg X] [--veto-assoc-deg X] [--veto-margin-deg X]\n'
    + '  [--veto-min-obs N] [--veto-min-cells N] [--veto-min-objects N]\n'
    + '  [--veto-dir-spread-deg X] [--veto-window-ms X]\n'
    + '  [--bad-carry-m X] [--run-min-s X] [--dump FILE] [--dump-sightings FILE]\n'
    + '  [--shape-normal-tol-deg X] [--shape-branch-margin-deg X]\n'
    + '  [--outlines]  (o1)-(o4): outline yield, shape repeatability, the\n'
    + '                single-object fix and what it covers');
  process.exit(1);
}

const { positional, flags } = parseArgs(process.argv.slice(2), {
  booleans: ['verbose', 'localize', 'align', 'veto', 'outlines', 'shape-support', 'stale'], usage,
});
if (!positional.length) usage('no pose journals given');

const objArg = flags.obj || 'recordings';
const scoreMin = numFlag(flags, 'score', 0.35, usage);
const minArcDeg = numFlag(flags, 'min-arc-deg', 8, usage);
const clusterM = numFlag(flags, 'cluster-m', 0.5, usage);
const viewCellM = numFlag(flags, 'view-cell-m', 0.4, usage);
const depthPrior = numFlag(flags, 'depth-prior', 1, usage);
const classAllow = flags['class-allow'] ? flags['class-allow'].split(',').map((s) => s.trim()) : null;
// Defaulted from the module rather than repeated, so a sweep is measured
// against the bar the live map actually uses. Sweep it from a shell loop and
// read what it costs in metric (d), not in how many more objects appear.
const minSightings = numFlag(flags, 'min-sightings', DEFAULTS.minSightings, usage);
// The merge bar, both halves. A fragment that does not know where it is has to
// be judged against what it claims, and how far that goes is exactly the kind of
// number this harness exists to settle.
const mergeSigmaK = numFlag(flags, 'merge-sigma-k', DEFAULTS.mergeSigmaK, usage);
const mergeMaxM = numFlag(flags, 'merge-max-m', DEFAULTS.mergeMaxM, usage);
const mergeEveryN = numFlag(flags, 'merge-every', 200, usage);

// Every gate the veto stands on, sweepable, defaulted from the module. The
// deliverable of `--veto` is a confusion matrix and a confusion matrix that
// cannot be swept is one opinion with a number attached.
const vetoOpts = {
  vetoDeg: numFlag(flags, 'veto-deg', DEFAULTS.vetoDeg, usage),
  vetoAssocDeg: numFlag(flags, 'veto-assoc-deg', DEFAULTS.vetoAssocDeg, usage),
  vetoMarginDeg: numFlag(flags, 'veto-margin-deg', DEFAULTS.vetoMarginDeg, usage),
  vetoMinObs: numFlag(flags, 'veto-min-obs', DEFAULTS.vetoMinObs, usage),
  vetoMinCells: numFlag(flags, 'veto-min-cells', DEFAULTS.vetoMinCells, usage),
  vetoMinObjects: numFlag(flags, 'veto-min-objects', DEFAULTS.vetoMinObjects, usage),
  vetoDirSpreadDeg: numFlag(flags, 'veto-dir-spread-deg', DEFAULTS.vetoDirSpreadDeg, usage),
  vetoWindowMs: numFlag(flags, 'veto-window-ms', DEFAULTS.vetoWindowMs, usage),
};
// The oracle's own two constants. `badCarryM` is what counts as a carry that
// ended badly — the thing the veto is supposed to have caught. `runMinS` is the
// shortest tagless run worth scoring: a run of a few frames has neither time to
// drift nor time to accumulate a quorum, and including them buries the cases
// this is for in a mass of trivially-fine ones.
// Every gate the single-object fix stands on, sweepable and defaulted from the
// module — the same rule the veto's gates follow. A false-fix rate that cannot
// be swept cannot answer the only question that matters about it: whether there
// is a setting that fires on real fixes and not on wrong ones, or whether the
// two distributions overlap. That question is what killed the slip veto.
const shapeOpts = {
  shapeElevTolDeg: numFlag(flags, 'shape-elev-tol-deg', DEFAULTS.shapeElevTolDeg, usage),
  shapeElevMarginDeg: numFlag(flags, 'shape-elev-margin-deg', DEFAULTS.shapeElevMarginDeg, usage),
  shapeNormalTolDeg: numFlag(flags, 'shape-normal-tol-deg', DEFAULTS.shapeNormalTolDeg, usage),
  shapeBranchMarginDeg: numFlag(flags, 'shape-branch-margin-deg', DEFAULTS.shapeBranchMarginDeg, usage),
  shapeMinObs: numFlag(flags, 'shape-min-obs', DEFAULTS.shapeMinObs, usage),
  shapeMinCells: numFlag(flags, 'shape-min-cells', DEFAULTS.shapeMinCells, usage),
  shapeSupport: !!flags['shape-support'],
  shapeSupportMargin: numFlag(flags, 'shape-support-margin', DEFAULTS.shapeSupportMargin, usage),
  shapeSeenWindowMs: numFlag(flags, 'shape-seen-window-ms', DEFAULTS.shapeSeenWindowMs, usage),
};
const badCarryM = numFlag(flags, 'bad-carry-m', 0.5, usage);
const runMinS = numFlag(flags, 'run-min-s', 5, usage);

// --- load the detections, indexed by (sid, fseq) ---

// Detection files sit beside the `.frames` log they came from, which is inside a
// session directory — so a directory argument is walked one level down as well
// as across, the same reach `expandJournals` gives the pose journals.
function objFiles(arg) {
  return expandJournals(String(arg).split(','), 'obj.jsonl');
}

const detsBySid = new Map();      // sid -> Map(fseq -> {dets, w, h})
const objMeta = [];
for (const f of objFiles(objArg)) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  let sid = null;
  let byFseq = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.kind === 'meta') {
      sid = o.sid ?? `file:${path.basename(f)}`;
      objMeta.push({
        file: path.basename(f), model: o.model, scoreMin: o.scoreMin, sid,
        // Written by `detect-objects.js` since the Objects365 swap. A file from
        // before it says nothing, and COCO is the only thing it can have been.
        vocab: o.vocab || 'coco',
      });
      if (!detsBySid.has(sid)) detsBySid.set(sid, new Map());
      byFseq = detsBySid.get(sid);
      continue;
    }
    if (!byFseq) continue;
    byFseq.set(o.fseq, { dets: o.dets || [], w: o.w, h: o.h });
  }
}
const totalDetFrames = [...detsBySid.values()].reduce((n, m) => n + m.size, 0);

// --- walk the pose journals ---

// Which vocabulary the detection files are spelled in. Taken from the files
// themselves rather than from a flag, and a run mixing two of them is refused
// outright: the allow-lists are deliberately not merged, so a mixed corpus would
// silently drop every detection from whichever model lost the vote.
const vocabsSeen = [...new Set(objMeta.map((m) => m.vocab))];
if (!flags.vocab && vocabsSeen.length > 1) {
  usage(`detection files mix vocabularies (${vocabsSeen.join(', ')}) — `
    + 'run them separately, or force one with --vocab');
}
const vocab = flags.vocab || vocabsSeen[0] || 'coco';

const objs = createObjects({
  log: flags.verbose ? (m) => console.log(`  ${m}`) : () => {},
  opts: {
    minArcDeg,
    viewCellM,
    minSightings,
    mergeEveryN,
    mergeSigmaK,
    mergeMaxM,
    vocab,
    ...vetoOpts,
    ...shapeOpts,
    ...(classAllow ? { classes: classAllow } : {}),
    // `--depth-prior 0` must reproduce the module as if depth had never been
    // sampled. That is the standing regression shape in this project: a feature
    // that cannot be switched off cannot be shown to be doing anything.
    ...(depthPrior ? {} : { depthMaxM: -1 }),
  },
});
objs.load(null);

const stat = {
  poseFrames: 0, joined: 0, withTags: 0, tagless: 0,
  taglessWithDets: [0, 0, 0, 0, 0],     // >=0,1,2,3,4 allow-listed detections
  taglessUnlocalized: 0, taglessUnlocalizedWithDets: 0,
  clipped: 0, dets: 0, kept: 0, withDepth: 0,
  fixes: 0, fixRefused: 0, fixErr: [], fixErrTagless: [], falseFix: 0,
  alignFixes: 0, alignRefused: 0, alignErr: [], carryErr: [], dYaw: [], dPos: [],
  vetoFrames: 0, vetoOrphans: 0, vetoMeasured: 0, vetoWhy: {},
  // (o1)-(o4). `shapeCapable` counts detections of a class that has a known
  // shape at all, which is the only honest denominator for a yield: a chair
  // producing no outline is not a failure of the fitter.
  shapeCapable: 0, shapeClipped: 0, shapeOutlined: 0, shapeTagged: 0,
  shapeFixes: 0, shapeRefused: 0, shapeErr: [], shapeErrTagless: [],
  shapeFalseFix: 0, shapeYawErr: [], shapeBy: {},
  // Split by which fit produced it and by how the mirror was resolved. The plan
  // says the circle is the elegant demonstration and the quad is where the
  // coverage would come from, and it is also the harder fit — that is a claim
  // with two populations behind it and a pooled number cannot test it.
  shapeSplit: {},
  taglessWithOutline: 0, taglessWithMappedOutline: 0, shapeFixStranded: 0,
  shapeWhyStranded: {},
};

// --- the oracle: tag re-acquisition ---
//
// When a tag reappears after a tagless run, the survey's own fix is ground
// truth for where the carried alignment ended up. Every run in the corpus is
// therefore a labelled example, needing no new trust and no new walk: carry
// error at re-acquisition, against whether the veto fired and when.
//
// A run that never re-acquires (the journal ends first) has no label and is
// counted separately rather than scored — it is not a pass.
const runs = [];
let run = null;

// (s1)-(s3). Miss episodes, closed and still open — see the collection pass in
// the frame loop.
const episodes = [];
const openEpisode = new Map();

function endRun(at, msg, pose) {
  if (!run) return;
  run.endAt = at;
  run.durS = (at - run.startAt) / 1000;
  const truth = alignmentFrom(msg.xr, pose);
  if (truth && run.carried && msg.xr?.p) {
    const truthCam = camFrom(truth, msg.xr.p);
    run.carryErrM = norm(sub(camFrom(run.carried, msg.xr.p), truthCam));
  }
  runs.push(run);
  run = null;
}

// The session-to-room alignment implied by one journal entry, from the pose the
// survey actually reported — the only ground truth available offline.
// `sessionAlignment` lives in pose-math.js because the phone and the server
// solve for the same four numbers and all three must agree about them.
const alignmentFrom = sessionAlignment;

function camFrom(align, xrP) {
  const c = Math.cos(align.yaw);
  const sn = Math.sin(align.yaw);
  return [
    c * xrP[0] + sn * xrP[2] + align.t[0],
    xrP[1] + align.t[1],
    -sn * xrP[0] + c * xrP[2] + align.t[2],
  ];
}
let carried = null;   // the alignment as of the last frame that had a tag
let carriedSid = null;
const perClass = new Map();

// A sighting record per accepted ray, kept for metric (c): where this one
// bearing put the object, and which viewpoint cell it was taken from. The
// within-cell versus across-cell split of that scatter is what separates
// detector noise from the silhouette bias, and only the second one is a thing
// averaging cannot fix.
const sightings = [];

// (o2). One record per accepted *outline*, the shape half of what `sightings`
// records for bearings: what this one view measured the thing to be and where it
// was standing. The spread of that across viewpoint cells is the whole metric —
// a shape measured from one standpoint has not been checked.
const shapeSightings = [];

// One line each, because a bare counter name in a table is a thing the reader
// has to go and look up in objects.js to act on.
// One line each, for the same reason `ASSOC_HELP` exists: a bare counter name
// is a thing the reader has to go and look up in objects.js to act on.
const SHAPE_WHY_HELP = {
  noOutline: 'no outline in the frame at all',
  anisotropic: 'the object frame is not a plain decimation of the camera image',
  isTag: 'the outline is a printed tag — refused, it is the survey\'s own evidence',
  noShapedObject: 'nothing of this class in the map carries a measured shape',
  flatNormal: 'the mapped surface points at the ceiling — no azimuth to fix a yaw with',
  noSolution: 'the outline gave no pose at all',
  flatSolution: 'every recovered normal was too flat to fix a yaw',
  elevation: 'the best solution is not the surface the map says this object is',
  mirror: 'two mirror solutions, neither preferred — refused rather than guessed',
  rivals: 'two mapped instances of the class disagreed about where the camera is',
  unsupported: 'one candidate, nothing to challenge it, and the carry puts the camera elsewhere',
};

const ASSOC_HELP = {
  noClassMatch: 'first of its class — nothing to join',
  bearingMiss: 'positioned entries of this class exist; the bearing missed them all',
  noPair: 'candidates exist but hold no ray to pair against',
  updown: 'bearing has no azimuth (pointing straight up or down)',
  parallel: 'no pair had enough parallax to cross',
  behind: 'the lines cross behind a camera',
  range: 'they cross too far away to be one object',
  elevation: 'they cross in plan view at incompatible heights',
};

function cellOf(p) {
  return `${Math.round(p[0] / viewCellM)},${Math.round(p[2] / viewCellM)}`;
}

for (const { entry } of readJournals(positional)) {
  if (entry.kind !== 'xr-pose' && entry.kind !== 'pose') continue;
  const msg = entry.msg;
  if (!msg) continue;
  stat.poseFrames++;
  const tags = msg.tags || [];
  const K = msg.intrinsics || msg.intr;
  const pose = entry.room?.pose;
  const sid = msg.sid ?? null;
  const fseq = msg.fseq ?? null;
  const rec = (sid !== null && fseq !== null) ? detsBySid.get(sid)?.get(fseq) : null;

  // Every coverage figure below is over **joined** frames only. Counting
  // tagless frames the detector never saw would put frames in the denominator
  // that had no chance of appearing in the numerator, which understates the
  // headline by exactly the fraction of the walk that was not photographed.
  if (!rec) continue;
  stat.joined++;
  if (tags.length) stat.withTags++;
  else stat.tagless++;
  const quality = entry.room?.quality;
  const stranded = !tags.length && (quality === 'dead' || quality === 'unlocalized' || quality === 'unaligned');
  if (stranded) stat.taglessUnlocalized++;
  // Everything above score and on the allow-list is handed to objects.js; the
  // clipping decision belongs there, because only it knows the camera
  // orientation that turns image edges into world edges. Pre-filtering on the
  // old boolean here would silently reinstate the rule being replaced.
  const usableDets = rec.dets.filter((d) => d.score >= scoreMin && objs.allows(d.cls));
  // For the coverage counts, "usable" means what objects.js will actually
  // accept: not clipped in the world-horizontal direction.
  const countable = pose?.q
    ? usableDets.filter((d) => !(d.clip === undefined
      ? d.clipped
      : worldClipAxes(d.clip, pose.q).h))
    : usableDets.filter((d) => !d.clipped);
  stat.dets += rec.dets.length;
  stat.clipped += rec.dets.filter((d) => d.clipped).length;
  stat.kept += countable.length;
  stat.withDepth += rec.dets.filter((d) => d.d != null).length;
  for (const d of rec.dets) {
    if (!perClass.has(d.cls)) perClass.set(d.cls, { n: 0, clipped: 0 });
    const c = perClass.get(d.cls);
    c.n++;
    if (d.clipped) c.clipped++;
  }

  if (!tags.length) {
    for (let k = 0; k <= 4; k++) if (countable.length >= k) stat.taglessWithDets[k]++;
    if (stranded && countable.length >= 3) stat.taglessUnlocalizedWithDets++;
  }

  // A carried alignment belongs to one XR session: it maps *that* session's
  // frame into the room, and the next session's frame has a different origin
  // and a different yaw. Carrying one across the boundary — which is what
  // walking a corpus of journals in sequence does unless something stops it —
  // compares a pose against a transform for somewhere else entirely.
  if (sid !== carriedSid) {
    run = null;
    carried = null;
    carriedSid = sid;
    objs.resetAlignment(1);
  }

  // The tagless-run bookkeeping and the veto sit *above* the pose guard below:
  // the veto needs no room pose (that is the point of it), and the deepest
  // excursions are exactly the frames where the survey has no answer to offer.
  // Only the oracle needs a pose, and only at the moment a tag comes back.
  if ((flags.veto || flags.align || flags.outlines) && msg.xr && K?.fx) {
    if (tags.length) {
      if (pose) {
        endRun(entry.at, msg, pose);
        const truth = alignmentFrom(msg.xr, pose);
        if (truth) carried = truth;
      }
    } else if (carried) {
      if (!run) {
        run = {
          sid, startAt: entry.at, carried, frames: 0, fresh: [],
          vetoAt: null, vetoFrames: 0, measuredFrames: 0, worstDeg: 0, carryErrM: null,
        };
      }
      run.frames++;
      run.lastAt = entry.at;
      if (flags.veto) {
        const v = objs.checkVeto({
          clientId: 1, sid, at: entry.at, xr: msg.xr, align: carried,
          dets: usableDets, K, camW: msg.w, camH: msg.h, frameW: rec.w, frameH: rec.h,
        });
        if (v) {
          stat.vetoFrames++;
          stat.vetoOrphans += v.orphans;
          if (v.n) stat.vetoMeasured++;
          stat.vetoWhy[v.why] = (stat.vetoWhy[v.why] || 0) + 1;
          if (v.n) run.measuredFrames++;
          run.fresh.push(...v.fresh);
          if (v.worstDeg !== null) run.worstDeg = Math.max(run.worstDeg, v.worstDeg);
          if (v.veto) {
            run.vetoFrames++;
            if (run.vetoAt === null) run.vetoAt = entry.at;
          }
        }
      }
    }
  }

  // (o1). Counted over the *joined* corpus and before anything is mapped, so
  // the denominator is detections this replay actually saw.
  if (flags.outlines) {
    for (const d of usableDets) {
      if (!shapeFor(d.cls)) continue;
      stat.shapeCapable++;
      if (d.clip === undefined ? d.clipped : d.clip) stat.shapeClipped++;
      else if (d.outline) stat.shapeOutlined++;
    }
    // A printed tag is a perfect quad and the best-conditioned one in the room.
    // `observe` refuses these before they can reach the map, but the offline
    // fitter has no pose and therefore no tags, so they are in the files — and a
    // yield figure that quietly counted them would be measuring the survey's own
    // evidence coming back round.
    if (tags.length) {
      const rects = tagBoxes(tags, msg.w, msg.h, rec.w, rec.h);
      for (const d of usableDets) {
        if (d.outline && rects.length
          && explainedByTag(d.box, rects, DEFAULTS.tagInsideFrac, DEFAULTS.tagBoxAreaMax)) {
          stat.shapeTagged++;
        }
      }
    }
  }

  // (o3)/(o4). The single-object fix.
  //
  // **Above the pose guard, like the veto and for the same reason: this needs no
  // room pose — that is the point of it.** It sat below the guard at first,
  // which meant every number it produced was measured only on frames the survey
  // had already answered, i.e. on precisely the frames where nothing needed a
  // second opinion. The same fault was in the live path (`rememberPose` bailed
  // with no room pose) and it is what made the readout go silent exactly when
  // the survey did.
  //
  // Scored before this frame's own detections are folded in — same rule
  // `--localize` follows: a fix graded against evidence it supplied itself is
  // not a measurement.
  if (flags.outlines && msg.xr) {
    const withOutline = usableDets.filter((d) => d.outline);
    if (!tags.length && withOutline.length) stat.taglessWithOutline++;
    // Attempted only when there is an outline to attempt it with, so the
    // refusal rate below is about the solve rather than about how much of the
    // corpus had nothing to look at.
    const note = {};
    const fix = !withOutline.length ? null : objs.poseFromShape({
      note,
      dets: withOutline, K, camW: msg.w, camH: msg.h, frameW: rec.w, frameH: rec.h,
      qGravity: msg.xr.q, align: carried, xr: msg.xr,
      // Who and when, for the window of recent detections the rival tie-break
      // scores against. One client in a replay, but the session must be right
      // or two sessions' offsets get mixed.
      clientId: 1, sid, at: entry.at,
      // The frame's own tags, so a printed tag cannot supply the fix.
      tags,
    });
    if (!fix) {
      if (withOutline.length) stat.shapeRefused++;
      // On a frame the survey could not answer, *which* test refused is the
      // whole diagnosis — that is the condition this exists for, and "no fix"
      // says nothing about what would have to change.
      if (stranded && withOutline.length) {
        stat.shapeWhyStranded[note.why] = (stat.shapeWhyStranded[note.why] || 0) + 1;
      }
    } else {
      stat.shapeFixes++;
      // **A fix on a frame the survey could not answer at all** — the condition
      // this whole idea is for, and the one the metric could not see while it
      // sat below the pose guard. Counted separately because it has no error to
      // report: there is nothing to compare it against, which is the point.
      if (stranded) stat.shapeFixStranded++;
      stat.shapeBy[fix.by] = (stat.shapeBy[fix.by] || 0) + 1;
      const err = pose ? norm(sub(fix.p, pose.p)) : null;
      if (err !== null) {
        // Which mapped object supplied the reference plane. A pooled false-fix
        // rate cannot say whether one wrong normal is producing all of them, and
        // that is the first question to ask of any change to how normals are
        // accepted.
        for (const k of [fix.kind, `by:${fix.by}`, fix.rivals > 1 ? 'rivals:many' : 'rivals:one',
          `obj:${fix.cls} #${fix.id}`]) {
          if (!stat.shapeSplit[k]) stat.shapeSplit[k] = { n: 0, err: [], bad: 0 };
          stat.shapeSplit[k].n++;
          stat.shapeSplit[k].err.push(err);
          if (err > 1.5) stat.shapeSplit[k].bad++;
        }
      }
      if (err !== null) {
        stat.shapeErr.push(err);
        if (!tags.length) stat.shapeErrTagless.push(err);
      }
      // **The bar is zero false fixes, not few.** Every candidate model measured
      // 52-100%; this has to do better by a wide margin or it joins them.
      if (err !== null && err > 1.5) stat.shapeFalseFix++;
    }
    // (o4), the number the whole idea rests on: how often a tagless frame
    // carries an outline of an object the map could actually be solved against,
    // measured against the 1.4% of them that carry the three bearings a
    // from-scratch fix needs.
    if (!tags.length && withOutline.some((d) => [...objs.entries().values()]
      .some((e) => e.promoted && e.p && e.shape?.n
        && e.shape.kind === d.outline.kind && e.key === normClass(d.cls)))) {
      stat.taglessWithMappedOutline++;
    }
  }

  if (!pose || !K?.fx) continue;

  // Localization is scored *before* this frame's own detections are folded into
  // the map, or it would be graded against evidence it supplied itself.
  if (flags.localize && msg.xr) {
    const fix = objs.localize({
      dets: usableDets, K, camW: msg.w, camH: msg.h, frameW: rec.w, frameH: rec.h,
      // The gravity-aligned frame is ARCore's own session frame.
      qGravity: msg.xr.q,
    });
    if (!fix) stat.fixRefused++;
    else {
      // The survey's fix is expressed in the room frame; this one is expressed
      // in the session frame turned into the room by the yaw it solved. What is
      // comparable is the camera position, so that is what is compared.
      stat.fixes++;
      const err = norm(sub(fix.p, pose.p));
      stat.fixErr.push(err);
      if (!tags.length) stat.fixErrTagless.push(err);
      if (err > 1.5) stat.falseFix++;
    }
  }

  if (flags.align && msg.xr) {
    const truth = alignmentFrom(msg.xr, pose);
    if (tags.length) {
      // A tag is in view, so the survey's alignment is trustworthy right now —
      // `carried` was refreshed to it above, which is what the system would
      // carry forward from here.
      objs.trackAlignment({
        clientId: 1, sid, at: entry.at, xr: msg.xr, align: carried,
        dets: usableDets, K, camW: msg.w, camH: msg.h, frameW: rec.w, frameH: rec.h,
      });
    } else if (carried && truth) {
      const fix = objs.trackAlignment({
        clientId: 1, sid, at: entry.at, xr: msg.xr, align: carried,
        dets: usableDets, K, camW: msg.w, camH: msg.h, frameW: rec.w, frameH: rec.h,
      });
      if (!fix) stat.alignRefused++;
      else {
        stat.alignFixes++;
        const truthCam = camFrom(truth, msg.xr.p);
        stat.carryErr.push(norm(sub(camFrom(carried, msg.xr.p), truthCam)));
        stat.alignErr.push(norm(sub(camFrom(fix, msg.xr.p), truthCam)));
        stat.dYaw.push(Math.abs(fix.dYawDeg));
        stat.dPos.push(fix.dPosM);
      }
    }
  }

  const before = new Map([...objs.entries()].map(([id, e]) => [id, e.rays.length]));
  // The stale rule's live state, snapshotted before the frame, because the rule
  // *clears* it on a sighting — after `observe` a streak that ended is
  // indistinguishable from one that never started. See the (s1)-(s3) report.
  const beforeMiss = flags.stale
    ? new Map([...objs.entries()].map(([id, e]) => [id, [e.evidence || 0, e.missCells.size]])) : null;
  // Only built when it will be read: this is a map over every entry, once per
  // frame, on a path that already builds one.
  const beforeShape = flags.outlines
    ? new Map([...objs.entries()].map(([id, e]) => [id, e.shapeObs.length])) : null;
  objs.observe({
    sid, at: entry.at, pose, K,
    camW: msg.w, camH: msg.h, frameW: rec.w, frameH: rec.h,
    dets: usableDets,
    // The same tag-suppression evidence the live path gets, from the journal
    // this frame is joined to.
    tags,
  });
  // Record what each newly-added ray had to say about where its object is.
  for (const [id, e] of objs.entries()) {
    if (!e.p || (before.get(id) ?? 0) >= e.rays.length) continue;
    const r = e.rays[e.rays.length - 1];
    const { t } = rayDistance(r.o, r.dir, e.p);
    if (t <= 0) continue;
    sightings.push({
      id, cls: e.cls, cell: cellOf(r.o), sid,
      range: t,
      p: [r.o[0] + r.dir[0] * t, r.o[1] + r.dir[1] * t, r.o[2] + r.dir[2] * t],
      // Carried only when the detector produced one. Grouped by `id` this is
      // the same physical object seen from somewhere else, and grouped by `cls`
      // across ids it is a *different* instance of the same class — which is
      // exactly the pair of distributions that says whether an appearance
      // vector can do what a class label cannot.
      ...(r.emb ? { emb: r.emb } : {}),
    });
  }
  // One miss episode per entry per unbroken run of being expected and absent.
  // Recorded as it ends, with the streak it reached, the standpoints it spanned
  // at each step, and **how it ended** — a sighting, or the corpus running out.
  // That last distinction is the whole oracle: an episode that ends in a
  // sighting proves the object was there for every frame of it, so any threshold
  // that would have convicted mid-episode is a false conviction, measurable
  // without anyone having to remove a chair from the room and write it down.
  if (flags.stale) {
    for (const [id, e] of objs.entries()) {
      const [wasEv] = beforeMiss.get(id) ?? [0, 0];
      const ev = e.evidence || 0;
      if (ev > wasEv) {
        // Still missing. Remember the first streak length at which this episode
        // reached each distinct cell count, so a sweep over `staleMinCells` can
        // be answered from the record instead of re-run.
        let ep = openEpisode.get(id);
        if (!ep) { ep = { id, cls: e.cls, cellAt: [] }; openEpisode.set(id, ep); }
        const c = e.missCells.size;
        while (ep.cellAt.length < c) ep.cellAt.push(ev);
        ep.streak = e.missStreak;
        ep.ev = ev;
      } else if (wasEv > 0 && ev === 0) {
        // Seen. The object was there for the whole run that just ended.
        const ep = openEpisode.get(id);
        if (ep) { episodes.push({ ...ep, endedBySighting: true }); openEpisode.delete(id); }
      }
    }
  }
  if (flags.outlines) {
    for (const [id, e] of objs.entries()) {
      if ((beforeShape.get(id) ?? 0) >= e.shapeObs.length) continue;
      const so = e.shapeObs[e.shapeObs.length - 1];
      // Which of the two candidates this sighting contributed is only knowable
      // against the aggregate, so it is resolved here rather than guessed: with
      // no aggregate yet, the first candidate stands in and the record says so.
      const ref = e.shape?.n || null;
      let pick = so.cands[0];
      if (ref) for (const c of so.cands) if (dot(c.n, ref) > dot(pick.n, ref)) pick = c;
      shapeSightings.push({
        id, cls: e.cls, cell: so.cell, kind: so.kind, cond: so.cond,
        r: pick.r ?? null, w: pick.w ?? null, h: pick.h ?? null,
        n: pick.n, resolved: !!ref,
      });
    }
  }
}

// A run the corpus never closed — the journal, or the session, ended mid-
// excursion. It has no ground truth at either end, so it is counted and not
// scored: an unlabelled run is not a run the veto got right.
if (run) {
  run.durS = ((run.lastAt ?? run.startAt) - run.startAt) / 1000;
  runs.push(run);
  run = null;
}

// --- reporting helpers ---

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '--');
function med(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
function p90(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
}
function p10(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.1)];
}
function spread(pts) {
  if (pts.length < 2) return null;
  const c = [0, 1, 2].map((i) => pts.reduce((s, p) => s + p[i], 0) / pts.length);
  return med(pts.map((p) => norm(sub(p, c))));
}
const f3 = (v) => (v === null || v === undefined ? '--' : v.toFixed(3));

console.log(`\n=== ${positional.length} journal(s), ${objMeta.length} detection file(s), `
  + `${totalDetFrames} detected frames ===`);
if (objMeta.length) {
  const models = [...new Set(objMeta.map((m) => m.model))];
  console.log(`model: ${models.join(', ')}   vocab ${vocab}   score >= ${scoreMin}   `
    + `depth prior ${depthPrior ? 'on' : 'OFF'}   min arc ${minArcDeg} deg   `
    + `min sightings ${minSightings}`);
}
console.log(`pose reports ${stat.poseFrames}, joined to a frame ${stat.joined} `
  + `(${pct(stat.joined, stat.poseFrames)})`);
if (!stat.joined) {
  console.log('\nNothing joined. Either no walk has been recorded with object frames on '
    + '(settings: "Object frames"), or detect-objects.js has not been run over the '
    + '.frames logs yet, or the journals predate the fseq field.');
  process.exit(0);
}

// (a) Coverage — does this channel reach where the tags do not.
console.log('\n(a) COVERAGE — frames with no tag in view');
console.log(`  joined frames with >=1 tag : ${stat.withTags}`);
console.log(`  joined frames with NO tag  : ${stat.tagless}`);
for (const k of [1, 2, 3, 4]) {
  console.log(`    of those, >=${k} usable detection(s): ${stat.taglessWithDets[k]} `
    + `(${pct(stat.taglessWithDets[k], stat.tagless)})`);
}
console.log(`  HEADLINE  tagless frames with >=3 detections: `
  + `${pct(stat.taglessWithDets[3], stat.tagless)}`);
console.log(`  frames the system currently has nothing for (tagless + dead/unlocalized/unaligned): `
  + `${stat.taglessUnlocalized}; of those with >=3 detections: `
  + `${stat.taglessUnlocalizedWithDets} (${pct(stat.taglessUnlocalizedWithDets, stat.taglessUnlocalized)})`);
console.log('  For scale: the removed landmark feature had 12.8% of frames as its target case '
  + 'and produced output on 0.1-0.3% of tracked frames.');

// Detection supply.
console.log('\n    detections ' + stat.dets + `, clipped ${stat.clipped} (${pct(stat.clipped, stat.dets)}), `
  + `with depth ${stat.withDepth} (${pct(stat.withDepth, stat.dets)}), `
  + `kept (allow-listed, unclipped, above score) ${stat.kept}`);
const byCount = [...perClass.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
for (const [cls, c] of byCount) {
  console.log(`      ${cls.padEnd(16)} ${String(c.n).padStart(6)}  clipped ${pct(c.clipped, c.n)}`
    + `${objs.allows(cls) ? '' : '   (not allow-listed)'}`);
}

// (b) Repeatability across viewpoints and sessions.
const all = objs.debugEntries();
// The map itself, for a question the printed metrics do not answer. Every
// figure above is a summary; a question like "do the light switches share one
// height" is about the positions, and the room frame is gravity-aligned so that
// question is answerable directly from `p[1]`. Written only when asked for, so
// nothing changes for a run that does not pass it.
if (flags.dump) {
  fs.writeFileSync(flags.dump, JSON.stringify(all, null, 1));
  console.log(`\nwrote ${all.length} entries to ${flags.dump}`);
}
// The per-sighting record, which is what an appearance question is actually
// about — metric (c) already summarises these positions, and nothing summarises
// what each sighting *looked like*.
if (flags['dump-sightings']) {
  fs.writeFileSync(flags['dump-sightings'], JSON.stringify(sightings));
  console.log(`wrote ${sightings.length} sightings to ${flags['dump-sightings']}`);
}
const promoted = all.filter((e) => e.promoted);
console.log('\n(b) REPEATABILITY');
console.log(`  entries ${all.length}, promoted ${promoted.length}`);
const bySessions = promoted.filter((e) => e.sessions >= 2).length;
const byCells = promoted.filter((e) => e.cells >= 3).length;
console.log(`  promoted seen in >=2 sessions: ${bySessions}   from >=3 viewpoint cells: ${byCells}`);
console.log('  (the landmark feature measured 0 usable cross-session re-identifications)');
for (const e of promoted.sort((a, b) => b.nObs - a.nObs).slice(0, 15)) {
  console.log(`    #${String(e.id).padStart(3)} ${e.cls.padEnd(14)} n=${String(e.nObs).padStart(4)} `
    + `arc=${String(Math.round(e.arcDeg)).padStart(3)}deg cells=${String(e.cells).padStart(3)} `
    + `sess=${e.sessions} prior=${((e.priorFrac || 0) * 100).toFixed(0).padStart(3)}% `
    + `inlier=${(e.inlierFrac || 0).toFixed(2)} resid=${f3(e.resid)} `
    // How sure the detector was, median over the inlier sightings. A high
    // inlier fraction with a low `conf` is a confidently-placed mislabel — the
    // failure every other number on this line is blind to.
    + `conf=${e.conf === null || e.conf === undefined ? '--' : e.conf.toFixed(2)} `
    // The measured extents, in world axes. A box drawn from these is the shape
    // the thing is; drawn from `r` it was the shape of the bearing scatter.
    + `wxh=${e.w === null || e.w === undefined ? '--' : e.w.toFixed(2)}`
    + `x${e.h === null || e.h === undefined ? '--' : e.h.toFixed(2)}m`);
}
if (flags.verbose) {
  for (const e of all.filter((x) => !x.promoted)) {
    console.log(`    unpromoted #${e.id} ${e.cls} n=${e.nObs} arc=${Math.round(e.arcDeg || 0)} `
      + `cells=${e.cells} sess=${e.sessions} inlier=${(e.inlierFrac || 0).toFixed(2)}`);
  }
}

// (i) The promotion funnel — why the map is as sparse as it is.
//
// In a room that *has* tags, this is the metric that matters: the camera pose
// is known, so mapping is not in question, and the only question is how much of
// the room actually makes it into the map and what stops the rest. Reported as
// the first gate each entry fails, in gate order, so the counts add up to the
// unpromoted total instead of double-counting an entry that fails several.
{
  const gates = [
    ['sightings', (e) => e.nObs < objs.opts.minSightings],
    ['arc', (e) => e.arcDeg < objs.opts.minArcDeg],
    ['viewpoint cells', (e) => e.cells < objs.opts.minViewCells],
    ['sessions', (e) => e.sessions < objs.opts.minSessions],
    ['inlier fraction', (e) => (e.inlierFrac ?? 0) < objs.opts.minInlierFrac],
    ['no position', (e) => !e.p],
  ];
  const fail = new Map(gates.map(([n]) => [n, []]));
  let promotedN = 0;
  for (const e of all) {
    if (e.promoted) { promotedN++; continue; }
    const g = gates.find(([, f]) => f(e));
    if (g) fail.get(g[0]).push(e);
  }
  console.log('\n(i) PROMOTION FUNNEL — what stops an entry becoming an anchor');
  console.log(`  entries ${all.length}  ->  promoted ${promotedN}`);
  for (const [name, list] of fail) {
    if (!list.length) continue;
    const byCls = new Map();
    for (const e of list) byCls.set(e.cls, (byCls.get(e.cls) || 0) + 1);
    const top = [...byCls].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([c, n]) => `${c} x${n}`).join(', ');
    console.log(`    blocked on ${name.padEnd(16)} ${String(list.length).padStart(3)}   ${top}`);
  }
  // A one-sighting entry is usually not a shy object, it is an association that
  // never found its way back to an existing one — the same detection seen twice
  // and filed twice. Worth separating, because the fix is different: one is a
  // gate to loosen, the other is a bug to find.
  const singles = all.filter((e) => !e.promoted && e.nObs <= 2);
  console.log(`    of the unpromoted, ${singles.length} have <=2 sightings `
    + '(candidates that never re-associated, not shy objects)');

  // Which test refused, rather than the inference that something must have.
  // "Blocked on sightings" was as far as this could see before, and the fixes
  // it prompted were guesses that happened to be right; this is the same
  // question asked of the code instead of of the reader.
  const st = objs.getStats();
  const reasons = Object.entries(st.assoc).sort((a, b) => b[1] - a[1]);
  if (reasons.length) {
    const total = reasons.reduce((n, [, c]) => n + c, 0);
    console.log(`\n    why a detection started a new entry (${total} of ${st.observed} observed):`);
    for (const [why, n] of reasons) {
      console.log(`      ${why.padEnd(14)} ${String(n).padStart(5)}  ${pct(n, total)}`
        + `   ${ASSOC_HELP[why] || ''}`);
    }
    // Which reason the entries that never grew were born under: the same
    // counters restricted to the fragments they were meant to explain.
    const byWhy = new Map();
    for (const e of singles) byWhy.set(e.bornWhy, (byWhy.get(e.bornWhy) || 0) + 1);
    if (byWhy.size) {
      console.log(`      of the ${singles.length} <=2-sighting entries, born under: `
        + [...byWhy].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} x${n}`).join(', '));
    }
  }
  console.log(`    reconciliation: ${st.merges} merges from ${st.mergeChecks} candidate pairs`);
  // A printed tag is a black square on a white sheet, which is a perfectly good
  // picture as far as a detector is concerned. This is how many boxes were
  // really that.
  console.log(`    refused as printed tags: ${st.tagSuppressed}`);
}

// (c) Scatter, and the split that matters.
console.log('\n(c) POSITION SCATTER (per object, from its own bearings)');
console.log('    within-cell is detector noise; the excess across cells is the silhouette');
console.log('    bias, which more sightings reduce the variance of but never remove.');
const byId = new Map();
for (const s of sightings) {
  if (!byId.has(s.id)) byId.set(s.id, []);
  byId.get(s.id).push(s);
}
const rangeBuckets = [[0, 2], [2, 3], [3, 5], [5, 99]];
const bucketErr = rangeBuckets.map(() => []);
for (const [id, ss] of byId) {
  const e = all.find((x) => x.id === id);
  if (!e || !e.promoted || ss.length < 4) continue;
  const byCell = new Map();
  for (const s of ss) {
    if (!byCell.has(s.cell)) byCell.set(s.cell, []);
    byCell.get(s.cell).push(s.p);
  }
  const within = [...byCell.values()].filter((g) => g.length >= 3).map(spread).filter((v) => v !== null);
  const across = spread(ss.map((s) => s.p));
  for (const s of ss) {
    const b = rangeBuckets.findIndex(([lo, hi]) => s.range >= lo && s.range < hi);
    if (b >= 0 && e.p) bucketErr[b].push(norm(sub(s.p, e.p)));
  }
  console.log(`    #${String(id).padStart(3)} ${e.cls.padEnd(14)} n=${String(ss.length).padStart(4)} `
    + `cells=${byCell.size}  within-cell ${f3(med(within))}m  across-cell ${f3(across)}m`
    + `  ratio ${within.length && med(within) ? (across / med(within)).toFixed(1) : '--'}`);
}
console.log('    by range:');
rangeBuckets.forEach(([lo, hi], i) => {
  const xs = bucketErr[i];
  if (!xs.length) return;
  console.log(`      ${lo}-${hi === 99 ? '+' : hi} m  n=${String(xs.length).padStart(5)}  `
    + `median ${f3(med(xs))}m  p90 ${f3(p90(xs))}m  worst ${f3(Math.max(...xs))}m`);
});

// (d) The number most likely to end this.
console.log('\n(d) SAME-CLASS SEPARATION vs SCATTER — can a constellation tell them apart?');
const clsGroups = new Map();
for (const e of promoted) {
  if (!e.p) continue;
  if (!clsGroups.has(e.cls)) clsGroups.set(e.cls, []);
  clsGroups.get(e.cls).push(e);
}
let anyFail = false;
for (const [cls, group] of [...clsGroups].sort((a, b) => b[1].length - a[1].length)) {
  const sigmas = group.map((e) => {
    const ss = byId.get(e.id) || [];
    return ss.length >= 4 ? spread(ss.map((s) => s.p)) : null;
  }).filter((v) => v !== null);
  const sigma = med(sigmas);
  if (group.length < 2) {
    console.log(`    ${cls.padEnd(16)} 1 instance   sigma ${f3(sigma)}m   (no ambiguity)`);
    continue;
  }
  let minSep = Infinity;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      minSep = Math.min(minSep, norm(sub(group[i].p, group[j].p)));
    }
  }
  const ratio = sigma ? minSep / sigma : null;
  const verdict = ratio === null ? '' : (ratio >= 3 ? '  OK' : '  AMBIGUOUS (needs minSep > 3 sigma)');
  if (ratio !== null && ratio < 3) anyFail = true;
  console.log(`    ${cls.padEnd(16)} ${group.length} instances  minSep ${f3(minSep)}m  `
    + `sigma ${f3(sigma)}m  ratio ${ratio === null ? '--' : ratio.toFixed(1)}${verdict}`);
}
if (anyFail) {
  console.log('    At least one class cannot be disambiguated by position. Those instances');
  console.log('    must not carry the constellation — see localize()\'s ambiguity margin,');
  console.log('    which refuses a fix rather than guessing between them.');
}

// (e) Localization against the survey's own fix.
if (flags.localize) {
  console.log('\n(e) LOCALIZATION vs the survey\'s own pose');
  console.log(`  fixes ${stat.fixes}, refused ${stat.fixRefused} `
    + `(${pct(stat.fixRefused, stat.fixes + stat.fixRefused)} of attempts)`);
  if (stat.fixes) {
    console.log(`  position error   median ${f3(med(stat.fixErr))}m   p90 ${f3(p90(stat.fixErr))}m   `
      + `worst ${f3(Math.max(...stat.fixErr))}m`);
    console.log(`  on tagless frames only: n=${stat.fixErrTagless.length} `
      + `median ${f3(med(stat.fixErrTagless))}m`);
    console.log(`  fixes further than 1.5 m from the survey (candidate false fixes): `
      + `${stat.falseFix} (${pct(stat.falseFix, stat.fixes)})`);
    console.log('  The bar for ever promoting this to a real pose source is zero false');
    console.log('  fixes, not few — a confidently wrong position is worse than none.');
  }
} else {
  console.log('\n(e) LOCALIZATION — skipped (pass --localize)');
}

// (s1)-(s3) STALE: the one rule that removes something from the map, and the
// only one whose bar was set by caution rather than by measurement.
if (flags.stale) {
  // Whatever was still missing when the corpus ran out is an episode too — it
  // just has no verdict at the end of it.
  for (const ep of openEpisode.values()) episodes.push({ ...ep, endedBySighting: false });

  console.log('\n(s1) MISS EPISODES — every unbroken run of expected-and-absent');
  const seen = episodes.filter((e) => e.endedBySighting);
  const open = episodes.filter((e) => !e.endedBySighting);
  console.log(`  episodes ${episodes.length}: ${seen.length} ended in a sighting, `
    + `${open.length} still missing when the corpus ended`);
  console.log('  An episode that ends in a sighting proves the object was there for all of it.');
  console.log('  Those are the only labelled examples there are, and every threshold that');
  console.log('  would have convicted inside one is wrong by construction.');
  if (seen.length) {
    const ls = seen.map((e) => e.ev).sort((a, b) => a - b);
    console.log(`  innocent evidence reached: median ${f3(med(ls))}  p90 ${f3(p90(ls))}  `
      + `max ${f3(ls[ls.length - 1])} nats`);
    const lf = seen.map((e) => e.streak).sort((a, b) => a - b);
    console.log(`  ...over frames:         median ${med(lf)}  p90 ${p90(lf)}  max ${lf[lf.length - 1]}`);
    const lc = seen.map((e) => e.cellAt.length).sort((a, b) => a - b);
    console.log(`  standpoints they spanned: median ${med(lc)}  p90 ${p90(lc)}  max ${lc[lc.length - 1]}`);
  }

  console.log('\n(s2) THE SWEEP — what each bar would have convicted');
  console.log('  nats  cells   convictions   of those FALSE (the object was seen again)');
  console.log('  (evidence AND a sustained run, at 3 standpoints)');
  for (const cells of [3]) {
    for (const streak of [2, 4, 8, 12]) {
      // A threshold convicts inside an episode when the streak reaches it *and*
      // the cell count has by then reached the bar — which is what `cellAt`
      // records, so the sweep is answered off the record rather than re-run.
      for (const run of [0, 20, 40, 60, 80]) {
        const convicts = (e) => e.ev >= streak && e.streak >= run
          && (e.cellAt[cells - 1] ?? Infinity) <= e.ev;
        const all = episodes.filter(convicts);
        const bad = all.filter((e) => e.endedBySighting);
        if (!all.length) continue;
        console.log(`  ${String(streak).padStart(4)} nats + ${String(run).padStart(3)} frames   `
          + `${String(all.length).padStart(4)} convictions   ${String(bad.length).padStart(3)} false`
          + ` (${pct(bad.length, all.length)})`);
      }
    }
  }
  console.log(`  Live bar is ${DEFAULTS.staleEvidence} nats + ${DEFAULTS.staleStreak} frames`
    + ` over ${DEFAULTS.staleMinCells} standpoints.`);

  console.log('\n(s3) WHO — the entries a conviction would have taken');
  const at = episodes.filter((e) => e.ev >= DEFAULTS.staleEvidence
    && e.streak >= DEFAULTS.staleStreak
    && (e.cellAt[DEFAULTS.staleMinCells - 1] ?? Infinity) <= e.ev);
  if (!at.length) console.log('  nothing reaches the live bar in this corpus.');
  else {
    for (const e of at.sort((a, b) => b.ev - a.ev).slice(0, 12)) {
      console.log(`  ${String(`${e.cls} #${e.id}`).padEnd(22)} ${f3(e.ev).padStart(7)} nats`
        + ` over ${String(e.streak).padStart(4)} frames`
        + `  cells ${e.cellAt.length}`
        + (e.endedBySighting ? '   FALSE — seen again afterwards' : '   never seen again'));
    }
  }
} else {
  console.log('\n(s1)-(s3) STALE — skipped (pass --stale)');
}

// (o1)-(o4) Outlines: the shape of a detected thing instead of the box round it.
//
// The order is the order they can kill it. (o1) first, because if the fitter
// does not produce outlines often enough the supply argument that motivates the
// whole idea has evaporated and nothing below it matters.
if (flags.outlines) {
  console.log('\n(o1) OUTLINE YIELD — of detections whose class has a known shape');
  console.log(`  shape-capable detections : ${stat.shapeCapable}`);
  console.log(`  ...clipped (not eligible): ${stat.shapeClipped} `
    + `(${pct(stat.shapeClipped, stat.shapeCapable)})`);
  const eligible = stat.shapeCapable - stat.shapeClipped;
  console.log(`  ...outline fitted        : ${stat.shapeOutlined} of ${eligible} eligible `
    + `(${pct(stat.shapeOutlined, eligible)})`);
  console.log('  Under ~30% and the supply argument this rests on has evaporated.');
  // The tag trap, counted. A printed tag is the best-conditioned quad in this
  // room and any fitter will lock onto one; `observe` refuses them before the
  // map, but they are in the detection files because the offline fitter has no
  // pose and therefore no tags.
  console.log(`  of the fitted, explained by a printed tag: ${stat.shapeTagged} `
    + `(${pct(stat.shapeTagged, stat.shapeOutlined)}) — refused before the map, `
    + 'counted here so the yield is not read as furniture');

  console.log('\n(o2) SHAPE REPEATABILITY — the same object measured from everywhere');
  console.log('    a shape measured from one standpoint is a shape that has not been checked,');
  console.log('    so the spread across viewpoint cells is the metric and the median is not.');
  const shapeById = new Map();
  for (const s of shapeSightings) {
    if (!shapeById.has(s.id)) shapeById.set(s.id, []);
    shapeById.get(s.id).push(s);
  }
  const rows = [];
  for (const [id, ss] of shapeById) {
    const e = all.find((x) => x.id === id);
    if (!e || ss.length < 3) continue;
    const cells = new Set(ss.map((s) => s.cell)).size;
    const sizes = ss[0].kind === 'ellipse'
      ? ss.map((s) => s.r * 2)                     // diameter, so it reads as a size
      : ss.map((s) => s.w);
    const alt = ss[0].kind === 'quad' ? ss.map((s) => s.h) : null;
    // The normal's own scatter about its median direction — the number that says
    // whether the mirror was resolved or merely averaged over.
    let nSpread = null;
    if (ss.some((s) => s.n)) {
      let acc = [0, 0, 0];
      for (const s of ss) acc = [acc[0] + s.n[0], acc[1] + s.n[1], acc[2] + s.n[2]];
      const m = norm(acc) > 1e-9 ? unit(acc) : null;
      if (m) {
        nSpread = med(ss.map((s) => (Math.acos(
          Math.max(-1, Math.min(1, dot(s.n, m)))) * 180) / Math.PI));
      }
    }
    rows.push({
      id, cls: e.cls, kind: ss[0].kind, n: ss.length, cells,
      size: med(sizes), lo: p10(sizes), hi: p90(sizes),
      size2: alt ? med(alt) : null,
      nSpread, shape: e.shape,
    });
  }
  if (!rows.length) console.log('  nothing measured — no positioned object collected an outline.');
  else {
    console.log('  object                kind      n  cells   size (p10..p90)         normal spread');
    for (const r of rows.sort((a, b) => b.n - a.n).slice(0, 14)) {
      const size = r.kind === 'ellipse'
        ? `${f3(r.size)} m across`
        : `${f3(r.size)} x ${f3(r.size2)} m`;
      console.log(`  ${String(`${r.cls} #${r.id}`).padEnd(20)} ${r.kind.padEnd(8)}`
        + ` ${String(r.n).padStart(3)} ${String(r.cells).padStart(5)}   `
        + `${size.padEnd(22)} ${r.nSpread === null ? '--' : `${r.nSpread.toFixed(1)} deg`}`
        + `   [${f3(r.lo)}..${f3(r.hi)}]`
        + (r.shape
          ? (r.shape.n ? `  MAPPED spread ${r.shape.nSpreadDeg} deg`
            : `  MAPPED no normal (${r.shape.nWhy})`)
          : '  (no aggregate)'));
    }
    console.log('  `Clock` measures 0.62 x 0.62 m square from two independent silhouette');
    console.log('  axes, so there is a number for the ellipse to hit.');
  }

  // (o2b) The mirror, and whether it was ever actually resolved.
  //
  // (o2) asks how tightly one branch's members agree. That is the winner's own
  // score and says nothing about the answer it beat: two hypotheses a degree
  // apart in spread are a coin flip, and the map stores the winner as a fact.
  // So the losing branch is printed beside the winner, and the decision is
  // re-run holding one standpoint out at a time — a branch that flips when a
  // single viewpoint cell leaves was decided by that cell, not by the room.
  //
  // Read on the flip count first. A normal that survives every hold-out is
  // resolved whatever its margin; one that flips is wrong half the time by
  // construction, and the elevation column is where that shows up as a
  // television pointed at the ceiling.
  console.log('\n(o2b) THE MIRROR — the branch that lost, and what happens without one standpoint');
  const branchRows = [];
  for (const [id, e] of objs.entries()) {
    const cond = (e.shapeObs || []).filter((o) => o.cond);
    if (cond.length < shapeOpts.shapeMinObs) continue;
    const cells = [...new Set(cond.map((o) => o.cell))];
    if (cells.length < shapeOpts.shapeMinCells) continue;
    const full = resolveNormal(cond, { ...DEFAULTS, ...shapeOpts });
    if (!full) continue;
    // Hold out one viewpoint cell at a time. The residual is measured against
    // the *nearest* candidate of each held-out sighting, because per sighting
    // the mirror genuinely is unresolved — the claim being tested is that a
    // standpoint the fit never saw still has a candidate agreeing with it.
    let flips = 0;
    let scored = 0;
    const resid = [];
    for (const c of cells) {
      const rest = cond.filter((o) => o.cell !== c);
      const held = cond.filter((o) => o.cell === c);
      if (rest.length < shapeOpts.shapeMinObs
        || new Set(rest.map((o) => o.cell)).size < shapeOpts.shapeMinCells) continue;
      const part = resolveNormal(rest, { ...DEFAULTS, ...shapeOpts });
      if (!part) continue;
      scored++;
      // A flip is the answer landing nearer the branch it rejected than the one
      // it chose — the only threshold-free statement of "a different answer".
      if (full.altN && angleDeg(part.n, full.altN) < angleDeg(part.n, full.n)) flips++;
      for (const o of held) {
        let best = null;
        for (const cd of o.cands) {
          const a = angleDeg(cd.n, part.n);
          if (best === null || a < best) best = a;
        }
        if (best !== null) resid.push(best);
      }
    }
    branchRows.push({
      id, cls: e.cls, kind: cond[cond.length - 1].kind, obs: cond.length, cells: cells.length,
      elev: (Math.asin(Math.max(-1, Math.min(1, full.n[1]))) * 180) / Math.PI,
      spread: full.spread, altSpread: full.altSpread, margin: full.margin, sep: full.sepDeg,
      why: full.why, flips, scored, resid: med(resid),
    });
  }
  if (!branchRows.length) console.log('  nothing to resolve — no entry reached the shape bars.');
  else {
    console.log('  object                kind      obs cells   elev    spread   mirror   margin'
      + '    sep   held-out  flips  verdict');
    const d1 = (x) => (x === null || x === undefined ? '  --' : x.toFixed(1).padStart(6));
    for (const r of branchRows.sort((a, b) => (a.margin ?? 99) - (b.margin ?? 99))) {
      console.log(`  ${String(`${r.cls} #${r.id}`).padEnd(20)} ${r.kind.padEnd(8)}`
        + ` ${String(r.obs).padStart(3)} ${String(r.cells).padStart(5)}`
        + ` ${d1(r.elev)}° ${d1(r.spread)}° ${d1(r.altSpread)}° ${d1(r.margin)}°`
        + ` ${d1(r.sep)}° ${d1(r.resid)}°  ${String(`${r.flips}/${r.scored}`).padStart(5)}`
        + `  ${r.why ? `refused (${r.why})` : 'accepted'}`);
    }
    const flipped = branchRows.filter((r) => r.flips);
    const kept = branchRows.filter((r) => !r.why);
    console.log(`  normals kept ${kept.length} of ${branchRows.length}`
      + ` at margin ${shapeOpts.shapeBranchMarginDeg} deg / tol ${shapeOpts.shapeNormalTolDeg} deg;`
      + ` ${flipped.length} flip under hold-out`);
    const stillFlipped = flipped.filter((r) => !r.why);
    console.log(`  kept AND flipping (what the margin failed to catch): `
      + `${stillFlipped.length}${stillFlipped.length
        ? ` — ${stillFlipped.map((r) => `${r.cls} #${r.id}`).join(', ')}` : ''}`);
    console.log('  A flip is not a near miss. Held out one standpoint, the map returns the');
    console.log('  mirror — so with that standpoint it returned one of two answers by luck.');
  }

  console.log('\n(o3) SINGLE-OBJECT FIX vs the survey\'s own pose');
  console.log(`  fixes ${stat.shapeFixes}, refused ${stat.shapeRefused} `
    + `(${pct(stat.shapeRefused, stat.shapeFixes + stat.shapeRefused)} of attempts)`);
  if (stat.shapeFixes) {
    console.log(`  position error   median ${f3(med(stat.shapeErr))}m   `
      + `p90 ${f3(p90(stat.shapeErr))}m   worst ${f3(Math.max(...stat.shapeErr))}m`);
    console.log(`  on tagless frames only: n=${stat.shapeErrTagless.length} `
      + `median ${f3(med(stat.shapeErrTagless))}m`);
    console.log(`  fixes further than 1.5 m from the survey (candidate false fixes): `
      + `${stat.shapeFalseFix} (${pct(stat.shapeFalseFix, stat.shapeFixes)})`);
    // How the mirror was resolved, because "it worked" is not the same claim as
    // "it was never ambiguous", and only one of those is worth anything.
    console.log(`  mirror resolved by: ${Object.entries(stat.shapeBy)
      .map(([k, n]) => `${k} x${n}`).join(', ') || '--'}`);
    for (const [k, v] of Object.entries(stat.shapeSplit)) {
      console.log(`    ${k.padEnd(12)} n=${String(v.n).padStart(4)}  `
        + `median ${f3(med(v.err))}m  p90 ${f3(p90(v.err))}m  `
        + `false ${v.bad} (${pct(v.bad, v.n)})`);
    }
      // Which test refused, over the whole corpus. `rivals` dominating means the
    // class label cannot pick the instance — metric (d)'s question one level up
    // — and no amount of work on the fitter touches it.
    const sw = objs.getStats().shapeWhy;
    const swTotal = Object.values(sw).reduce((n, v) => n + v, 0);
    if (swTotal) {
      console.log('  why an attempt produced nothing (per detection-object pair):');
      for (const [w, n] of Object.entries(sw).sort((a, b) => b[1] - a[1])) {
        console.log(`      ${w.padEnd(16)} ${String(n).padStart(6)}  ${pct(n, swTotal)}`
          + `   ${SHAPE_WHY_HELP[w] || ''}`);
      }
    }
  console.log('  The bar is ZERO false fixes, not few. Every candidate model measured');
    console.log('  52-100%; this has to beat that by a wide margin or it joins them.');
  }

  console.log('\n(o4) COVERAGE — what a single-object fix reaches that three bearings do not');
  console.log(`  tagless frames                              : ${stat.tagless}`);
  console.log(`  ...carrying >=1 fitted outline              : ${stat.taglessWithOutline} `
    + `(${pct(stat.taglessWithOutline, stat.tagless)})`);
  console.log(`  ...carrying an outline of a SHAPED map object: ${stat.taglessWithMappedOutline} `
    + `(${pct(stat.taglessWithMappedOutline, stat.tagless)})`);
  console.log(`  against >=3 mappable detections (the cold-fix bar): `
    + `${pct(stat.taglessWithDets[3], stat.tagless)}`);
  // The frames the system currently has no answer for at all. A fix here has no
  // error to report because there is nothing to compare it against — which is
  // exactly why it is the number this feature exists to move.
  console.log(`  fixes on frames the survey could not localize at all: `
    + `${stat.shapeFixStranded} (of ${stat.taglessUnlocalized} such frames)`);
  const swS = Object.entries(stat.shapeWhyStranded).sort((a, b) => b[1] - a[1]);
  if (swS.length) {
    console.log(`    on those frames, refused by: `
      + swS.map(([w, n]) => `${w} x${n}`).join(', '));
  }
  console.log('  This is the number the whole idea rests on.');
} else {
  console.log('\n(o1)-(o4) OUTLINES — skipped (pass --outlines, and run detect-objects.js --outlines first)');
}

// (h) Alignment correction, against the only baseline that matters: doing
// nothing. The alignment is established from tags; the question is what happens
// to it on the frames after the tags leave view. "Carry it" is what the system
// does today, so the object channel has to beat that or it is not worth its
// bytes.
if (flags.align) {
  console.log('\n(h) ALIGNMENT CORRECTION vs carrying the last tag-derived alignment');
  console.log(`  corrections offered ${stat.alignFixes}, refused ${stat.alignRefused}`);
  const bothN = stat.alignErr.length;
  if (!bothN) {
    console.log('  nothing to compare — no tagless frame had a usable correction.');
  } else {
    console.log(`  frames compared (tagless, correction available): ${bothN}`);
    console.log(`    carried alignment    median ${f3(med(stat.carryErr))}m   p90 ${f3(p90(stat.carryErr))}m`);
    console.log(`    object-corrected     median ${f3(med(stat.alignErr))}m   p90 ${f3(p90(stat.alignErr))}m`);
    const better = stat.alignErr.filter((v, i) => v < stat.carryErr[i]).length;
    console.log(`    corrected is closer on ${better}/${bothN} (${pct(better, bothN)})`);
    const worse = stat.alignErr.filter((v, i) => v > stat.carryErr[i] + 0.25).length;
    console.log(`    corrected is WORSE by >0.25 m on ${worse} (${pct(worse, bothN)}) `
      + '— this is the number that says it is unsafe, not the median');
    console.log(`  correction magnitude: yaw median ${f3(med(stat.dYaw))} deg, `
      + `position median ${f3(med(stat.dPos))}m`);
  }
}

// (i2) The slip veto's confusion matrix, against the tag-reacquisition oracle.
//
// This is the metric that decides the veto, and the number that decides it is
// the **false positive count**, not the recall. A false veto throws away a good
// alignment, so the bar stated before this was built is zero of them over the
// corpus — the same bar objects.md sets for a real pose source.
if (flags.veto) {
  console.log('\n(i2) SLIP VETO vs the tag-reacquisition oracle');
  console.log(`  gates: >${vetoOpts.vetoDeg} deg disagreement, assoc within `
    + `${vetoOpts.vetoAssocDeg} deg, margin ${vetoOpts.vetoMarginDeg} deg, quorum `
    + `${vetoOpts.vetoMinObs} obs / ${vetoOpts.vetoMinCells} cells / `
    + `${vetoOpts.vetoMinObjects} objects, dir spread <= ${vetoOpts.vetoDirSpreadDeg} deg, `
    + `window ${vetoOpts.vetoWindowMs} ms`);
  console.log(`  tagless frames the veto could look at: ${stat.vetoFrames}, `
    + `carrying at least one correspondence: ${stat.vetoMeasured} `
    + `(${pct(stat.vetoMeasured, stat.vetoFrames)})`);
  // The band this design cannot see: a slip gross enough to throw every bearing
  // outside the capture radius associates with nothing and is silent. Reported
  // rather than assumed away, because a silent miss looks exactly like a pass.
  console.log(`  detections that matched no mapped object of their class `
    + `(outside the ${vetoOpts.vetoAssocDeg} deg capture radius — the blind band): `
    + `${stat.vetoOrphans}`);
  const whys = Object.entries(stat.vetoWhy).sort((a, b) => b[1] - a[1]);
  if (whys.length) {
    console.log('  per-frame verdict: ' + whys.map(([w, n]) => `${w} ${n}`).join(', '));
  }

  const labelled = runs.filter((r) => r.carryErrM !== null && r.carryErrM !== undefined);
  const unlabelled = runs.length - labelled.length;
  console.log(`\n  tagless runs: ${runs.length} (${labelled.length} ended in a tag `
    + `re-acquisition and are scored; ${unlabelled} ran off the end of a journal or `
    + 'session and are not)');
  for (const minS of [0, runMinS, 10, 30]) {
    const set = labelled.filter((r) => r.durS >= minS);
    if (!set.length) continue;
    const bad = set.filter((r) => r.carryErrM > badCarryM);
    const good = set.filter((r) => r.carryErrM <= badCarryM);
    const tp = bad.filter((r) => r.vetoAt !== null);
    const fn = bad.length - tp.length;
    const fp = good.filter((r) => r.vetoAt !== null);
    const tn = good.length - fp.length;
    console.log(`\n  runs >= ${minS}s: n=${set.length}   `
      + `carry error at re-acquisition median ${f3(med(set.map((r) => r.carryErrM)))}m  `
      + `p90 ${f3(p90(set.map((r) => r.carryErrM)))}m  `
      + `worst ${f3(Math.max(...set.map((r) => r.carryErrM)))}m`);
    console.log(`    carry ended badly (>${badCarryM} m): ${bad.length}   fine: ${good.length}`);
    console.log(`                     veto fired   veto silent`);
    console.log(`      carry bad      ${String(tp.length).padStart(10)}   ${String(fn).padStart(11)}`);
    console.log(`      carry fine     ${String(fp.length).padStart(10)}   ${String(tn).padStart(11)}   `
      + `<- FALSE POSITIVES: ${fp.length}`);
    if (tp.length) {
      const lead = tp.map((r) => (r.endAt - r.vetoAt) / 1000);
      console.log(`    lead time before re-acquisition: median ${f3(med(lead))}s  `
        + `worst ${f3(Math.min(...lead))}s`);
    }
  }
  // The noise floor, and the number the whole design turns on. Every
  // correspondence taken on a run whose carry is *known* to have ended fine is
  // a measurement of what a correct alignment disagrees by — detector
  // silhouette scatter plus object position error plus whatever the carry
  // really drifted. `vetoDeg` has to sit above this distribution's tail to
  // avoid a false veto, and below the disagreement a slip worth catching would
  // produce. Whether those two constraints leave any room is the result.
  {
    const fine = labelled.filter((r) => r.carryErrM <= badCarryM).flatMap((r) => r.fresh);
    console.log(`\n  disagreement under a carry that ended fine: n=${fine.length}`);
    if (fine.length) {
      const ds = fine.map((c) => c.deg);
      const sorted = [...ds].sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      console.log(`    median ${f3(med(ds))}  p90 ${f3(at(0.9))}  p99 ${f3(at(0.99))}  `
        + `worst ${f3(sorted[sorted.length - 1])} deg`);
      // What a slip of exactly `badCarryM` would look like at the ranges the
      // objects in this corpus are actually seen at. If this sits inside the
      // distribution above, the veto cannot separate the two.
      const ranges = fine.map((c) => c.rangeM).sort((a, b) => a - b);
      const rMed = ranges[ranges.length >> 1];
      const rP90 = ranges[Math.min(ranges.length - 1, Math.floor(ranges.length * 0.9))];
      const slipDeg = (r) => Math.atan2(badCarryM, r) * 180 / Math.PI;
      console.log(`    correspondence range: median ${f3(rMed)}m  p90 ${f3(rP90)}m`);
      console.log(`    a ${badCarryM} m slip seen at those ranges is `
        + `${f3(slipDeg(rMed))} deg / ${f3(slipDeg(rP90))} deg of disagreement`);
      console.log('    Compare the two lines: the threshold has to clear the tail of the');
      console.log('    first and stay under the second, and both are measured, not assumed.');
    }
  }

  console.log('\n  The bar stated before this was built: ZERO false vetoes over the corpus.');
  console.log('  A false veto throws away a good alignment; recall is a bonus. A single');
  console.log('  false positive on this corpus kills it.');
  // Naming them is the only way the kill bar is actionable: a false positive is
  // a specific run with a specific object arrangement behind it.
  const fpRuns = labelled.filter((r) => r.vetoAt !== null && r.carryErrM <= badCarryM);
  for (const r of fpRuns.slice(0, 10)) {
    console.log(`    FP  sid ${r.sid} run ${f3(r.durS)}s  carry err ${f3(r.carryErrM)}m  `
      + `vetoed ${f3((r.vetoAt - r.startAt) / 1000)}s in, ${r.vetoFrames} frame(s), `
      + `worst disagreement ${f3(r.worstDeg)} deg`);
  }
  const badRuns = labelled.filter((r) => r.carryErrM > badCarryM);
  for (const r of badRuns.slice(0, 10)) {
    console.log(`    BAD sid ${r.sid} run ${f3(r.durS)}s  carry err ${f3(r.carryErrM)}m  `
      + `${r.vetoAt === null ? 'veto SILENT' : `vetoed ${f3((r.vetoAt - r.startAt) / 1000)}s in`}`
      + `  frames with a correspondence ${r.measuredFrames}/${r.frames}`);
  }
  if (!badRuns.length) {
    console.log('\n  No carry in this corpus ended badly. That is a result about the corpus,');
    console.log('  not about the veto: with nothing to catch, the only thing measurable here');
    console.log('  is the false-positive rate, and it is measurable — see the matrix above.');
  }
} else {
  console.log('\n(i2) SLIP VETO — skipped (pass --veto)');
}

// (g) Did the prior actually wash out.
console.log('\n(g) DEPTH PRIOR');
const priors = promoted.map((e) => e.priorFrac || 0);
if (!depthPrior) {
  console.log('  disabled (--depth-prior 0). Compare these positions against a run with it on:');
  console.log('  if they differ materially, depth was acting as a coordinate, not a prior.');
} else if (priors.length) {
  console.log(`  priorFrac across promoted objects: median ${(100 * med(priors)).toFixed(1)}%  `
    + `p90 ${(100 * p90(priors)).toFixed(1)}%`);
  const stuck = promoted.filter((e) => (e.priorFrac || 0) > 0.35);
  console.log(`  objects still standing on depth (priorFrac > 35%, excluded from localization): `
    + `${stuck.length}`);
  for (const e of stuck) {
    console.log(`      #${e.id} ${e.cls} arc=${Math.round(e.arcDeg)}deg — `
      + 'narrow arc is the expected cause; check it was only ever seen from one side');
  }
}

console.log('');
