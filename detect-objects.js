'use strict';

// Run the object detector over recorded frame logs, offline.
//
//   node detect-objects.js recordings/<stamp>_clientN.frames [more ...]
//     [--score 0.3] [--out-dir recordings] [--force] [--limit N]
//
// Writes `recordings/<stamp>_clientN.obj.jsonl` beside each input: one line per
// frame, joined to the pose journal later by (sid, fseq).
//
// This exists as a separate offline step rather than only as a live path
// because the detector is the part of this experiment most likely to be wrong.
// A different model, a different threshold, a different class allow-list has to
// be answerable by re-running over bytes already on disk — the alternative is
// another walk around the room for every question, which is how tuning stops
// being measured and starts being argued.
//
// The depth map recorded beside each picture is passed straight through to the
// output as a per-detection `d`, sampled at the box centre through the *same*
// `depthAtPixel` the phone uses at tag centres. It is a prior and never a
// coordinate — see how objects.js weights it.

const fs = require('fs');
const path = require('path');
const { parseArgs, numFlag } = require('./replay-common.js');
const { readFrameLog, readFrameLogMeta } = require('./frame-log.js');
const { depthAtPixel } = require('./public/frame-wire.js');
const { createObjectDetector, DEFAULT_SCORE_MIN } = require('./object-detector.js');
const { writeBoxImage } = require('./frame-images.js');
const { fitOutlines, DEFAULTS: OUTLINE_DEFAULTS } = require('./outlines.js');

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node detect-objects.js <log.frames> [more ...]\n'
    + '  [--score X] [--out-dir DIR] [--limit N] [--stride N] [--force] [--boxes]\n'
    + '  [--embeds]   (appearance vector per detection, where the head has one)\n'
    + '  [--outlines] (fit an ellipse or a quad inside boxes of shape-capable classes)\n'
    + '  [--outline-min-px N] [--outline-fit-rms X] [--outline-cover-frac X]\n'
    + '  [--model FILE]   (or SYNORA_OBJDET_MODEL)');
  process.exit(1);
}

const { positional, flags } = parseArgs(process.argv.slice(2), {
  booleans: ['force', 'boxes', 'embeds', 'outlines'], usage,
});
if (!positional.length) usage('no .frames files given');

const scoreMin = numFlag(flags, 'score', DEFAULT_SCORE_MIN, usage);
const limit = numFlag(flags, 'limit', Infinity, usage);
// Every Nth frame, for a model too expensive to run over the whole corpus.
// Deliberately a stride rather than a head count: `--limit` takes the first N
// frames of each walk, which is the part of a walk where the phone is still
// being pointed at the first tag, and a coverage figure measured there is a
// figure about starting a walk. Everything downstream joins on `fseq`, so a
// gapped detection file costs nothing but the frames it skipped — the coverage
// percentages are over joined frames, not over the walk.
const stride = Math.max(1, numFlag(flags, 'stride', 1, usage));
const outDir = flags['out-dir'] || null;
// Overlays land in an `.images` directory beside this run's own `.obj.jsonl`,
// so `--out-dir` already keeps two models' pictures apart — which is what
// comparing them wants. This is where a letterbox or an NMS bar is actually
// judged: the funnel cannot tell a shifted box from a shy room.
const wantBoxes = !!flags.boxes;
// The outline fitter, and its gates as flags. Every one of them is a threshold
// a picture can disagree with, and a threshold that cannot be swept is one
// opinion with a number attached — the same reason the veto's gates are all
// flags in `replay-objects.js`.
const wantOutlines = !!flags.outlines;
const outlineOpts = {
  outlineMinPx: numFlag(flags, 'outline-min-px', OUTLINE_DEFAULTS.outlineMinPx, usage),
  outlineFitRms: numFlag(flags, 'outline-fit-rms', OUTLINE_DEFAULTS.outlineFitRms, usage),
  outlineCoverFrac: numFlag(flags, 'outline-cover-frac', OUTLINE_DEFAULTS.outlineCoverFrac, usage),
};

// Beside the input by default. With `--out-dir`, **under a copy of the walk's
// own directory** — one directory per walk means every frame log in the corpus
// is called `frames.frames`, so a flat output directory would have all
// twenty-four of them writing to one `frames.obj.jsonl`, each overwriting the
// last, and the run would look like it had worked. `replay-objects.js` reaches
// one level into a directory for exactly this shape.
function outPathFor(file) {
  const base = path.basename(file).replace(/\.frames$/, '');
  if (!outDir) return path.join(path.dirname(file), `${base}.obj.jsonl`);
  const walk = path.basename(path.dirname(path.resolve(file)));
  const dir = path.join(outDir, walk);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${base}.obj.jsonl`);
}

async function run() {
  // scoreMin is passed, not just recorded: the meta line below claims it, and a
  // meta line that describes a run that did not happen is worse than none.
  const det = createObjectDetector({
    scoreMin, modelFile: flags.model || undefined, log: (m) => console.log(m),
    // An appearance vector per detection, for the one question a class label
    // cannot answer: is this the same shelf as the one already in the map, or a
    // second shelf. Costs about a kilobyte a box, so it is asked for rather
    // than assumed.
    wantEmbeds: !!flags.embeds,
  });
  // Loaded up front rather than on the first frame, so the vocabulary is known
  // in time to be written into every meta line below — a detection file that
  // cannot say which vocabulary produced it is one the replay has to guess at.
  const { vocab } = await det.load();
  let totalFrames = 0;
  let totalDets = 0;
  let totalMs = 0;
  let totalOutlineTried = 0;
  let totalOutlineGot = 0;
  let totalOutlineClipped = 0;
  let totalOutlineMs = 0;

  for (const file of positional) {
    const head = readFrameLogMeta(file);
    if (!head) {
      console.error(`skip ${file}: not a frame log`);
      continue;
    }
    const out = outPathFor(file);
    if (fs.existsSync(out) && !flags.force) {
      console.log(`skip ${path.basename(out)} (exists — pass --force to redo)`);
      continue;
    }
    const stream = fs.createWriteStream(out);
    // The model and the threshold are recorded with the output, or a number
    // measured from it is unattributable — which model produced it is exactly
    // the question a second run is asking.
    stream.write(`${JSON.stringify({
      kind: 'meta',
      at: Date.now(),
      model: det.name,
      // Which vocabulary the classes below are spelled in. `replay-objects.js`
      // picks its allow-list off this: COCO's `pottedplant` and Objects365's
      // `Potted Plant` are the same thing, and `Cabinet/shelf` is a class one of
      // them cannot produce at all.
      vocab,
      scoreMin,
      // A gapped file has to say it is gapped, or its coverage figures read as
      // if the whole walk had been looked at.
      ...(stride > 1 ? { stride } : {}),
      // A file whose detections carry outlines has to say so and say what they
      // were fitted under: the gates below are what an outline means, and a
      // replay comparing two runs cannot ask the files which one was stricter
      // unless they carry the answer.
      ...(wantOutlines ? { outlines: outlineOpts } : {}),
      source: path.basename(file),
      sid: head.meta.sid ?? null,
      clientId: head.meta.clientId ?? null,
      deviceId: head.meta.deviceId ?? null,
    })}\n`);

    const imageDir = wantBoxes ? out.replace(/\.obj\.jsonl$/, '.images') : null;
    if (imageDir) fs.mkdirSync(imageDir, { recursive: true });

    let frames = 0;
    let dets = 0;
    let ms = 0;
    let outlineMs = 0;
    let outlineTried = 0;
    let outlineGot = 0;
    let outlineClipped = 0;
    let withDepth = 0;
    let overlays = 0;
    let seen = 0;
    for (const { header, depth, jpeg } of readFrameLog(file)) {
      if (frames >= limit) break;
      if (seen++ % stride) continue;
      const t0 = Date.now();
      let found;
      // Decoded here only when the outline fitter needs the pixels, and then
      // handed to the detector as pixels so the decode is paid for once —
      // `detect()` takes either. Without `--outlines` the buffer goes through
      // untouched and this run costs exactly what it always did.
      let img = null;
      try {
        if (wantOutlines) img = require('jpeg-js').decode(Buffer.from(jpeg), { useTArray: true });
        found = await det.detect(img || Buffer.from(jpeg));
      } catch (err) {
        console.error(`  frame ${header.fseq}: ${err.message}`);
        continue;
      }
      ms += Date.now() - t0;
      if (img) {
        // Measured separately from inference, because (o5) is a claim about what
        // this step adds and a total cannot make it.
        const t1 = Date.now();
        const fit = fitOutlines(img, found, outlineOpts);
        outlineMs += Date.now() - t1;
        outlineTried += fit.tried;
        outlineGot += fit.got;
        outlineClipped += fit.clipped;
      }
      if (depth) withDepth++;
      for (const d of found) {
        // Depth at the box centre, in the *submitted frame's* pixels — which is
        // the space depthAtPixel wants, since it normalizes by the width and
        // height it is handed. Interior to the object by construction, which is
        // the only place on a box where a depth sample is not straddling the
        // silhouette and reading half foreground, half wall.
        const u = (d.box[0] + d.box[2]) / 2;
        const v = (d.box[1] + d.box[3]) / 2;
        const z = depth ? depthAtPixel(depth, u, v, header.w, header.h) : null;
        if (z !== null) d.d = z;
      }
      dets += found.length;
      // Written before the JSON line, and only when there is something to draw:
      // a directory of empty frames is a directory nobody scrolls through.
      if (imageDir && writeBoxImage(imageDir, { header, jpeg }, found)) overlays++;
      stream.write(`${JSON.stringify({
        fseq: header.fseq, t: header.t, w: header.w, h: header.h, dets: found,
      })}\n`);
      frames++;
      if (frames % 100 === 0) process.stdout.write(`\r  ${path.basename(file)}: ${frames} frames`);
    }
    stream.end();
    process.stdout.write('\r');
    console.log(`${path.basename(out)}: ${frames} frames, ${dets} detections, `
      + `${withDepth} with depth, ${frames ? (ms / frames).toFixed(0) : 0} ms/frame`
      + (wantOutlines
        ? `, outlines ${outlineGot}/${outlineTried}`
        + `${outlineTried ? ` (${((100 * outlineGot) / outlineTried).toFixed(0)}%)` : ''}`
        + `, ${outlineClipped} clipped, +${frames ? (outlineMs / frames).toFixed(1) : 0} ms/frame`
        : '')
      + (imageDir ? `, ${overlays} overlays -> ${path.basename(imageDir)}` : ''));
    totalFrames += frames;
    totalDets += dets;
    totalMs += ms;
    totalOutlineTried += outlineTried;
    totalOutlineGot += outlineGot;
    totalOutlineClipped += outlineClipped;
    totalOutlineMs += outlineMs;
  }

  det.close();
  console.log(`\n${positional.length} log(s), ${totalFrames} frames, ${totalDets} detections, `
    + `${totalFrames ? (totalMs / totalFrames).toFixed(0) : 0} ms/frame mean`);
  if (wantOutlines) {
    // (o1) yield and (o5) cost, over the whole run. Under ~30% yield and the
    // supply argument the whole idea rests on has evaporated, so it is printed
    // where it cannot be missed rather than left to the replay.
    console.log(`outlines: ${totalOutlineGot}/${totalOutlineTried} shape-capable detections fitted`
      + `${totalOutlineTried ? ` (${((100 * totalOutlineGot) / totalOutlineTried).toFixed(1)}%)` : ''}`
      + `, ${totalOutlineClipped} skipped as clipped`
      + `, +${totalFrames ? (totalOutlineMs / totalFrames).toFixed(1) : 0} ms/frame`);
  }
}

run().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
