'use strict';

// The object detector, behind one interface so the thing producing boxes can be
// swapped without anything downstream noticing.
//
//   const det = createObjectDetector({ log });
//   const boxes = await det.detect(jpegBuffer);   // [{ cls, score, box:[x0,y0,x1,y1] }]
//
// Boxes come back in the pixel coordinates of the *frame that was submitted* —
// the small one the phone sent, not the camera image it was decimated from.
// Scaling back to the camera frame is the caller's job, because only the caller
// knows the intrinsics it is going to project through.
//
// **This runs on the PC and never on a phone.** The measured precedent is not
// close: the optical-flow tracker that was removed on 04/08/26 ran 178-206 ms a
// frame on the phone and took it from 6.38 detections a second to 2.6, with 86
// of every 100 due detections dropped, in exchange for output on 0.1-0.3% of
// tracked frames. RT-DETR R18 at 640x640 is measured here at ~138 ms a frame on
// this desktop CPU; on the phone it would be several times that, on the same
// thread that is already the constraint. The phone's whole job is to hand over
// a small JPEG it already has the pixels for.
//
// The interface exists so an on-phone backend stays a swap rather than a
// rewrite: it would replace the *transport* (the RGBA buffer detect-worker.js
// already receives, results riding back on the existing xr-result message), not
// this contract. That is a measured decision to take later, not a design to
// pre-empt now.
//
// Not built: a `stdio` child-process backend. It was in the plan only to keep an
// ONNX runtime out of package.json, and that constraint was lifted — with `ort`
// available directly there is no case left for shelling out that `http` below
// does not already cover.

const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, 'models');
// Kept in step with `objDetectorModel`'s default in settings.js, so an offline
// run with no flag reads the same model the server does — a comparison whose
// two halves silently used different defaults would be worthless.
const DEFAULT_MODEL_FILE = 'yoloe-o365.onnx';

// How each head wants its picture, in one table rather than spread through the
// decoders — because the *fit* is the one thing in here that silently produces
// plausible-but-wrong boxes rather than an error, and a reader comparing two
// models needs to see the two preprocessings side by side.
//
// - `squash` resizes to exactly the square, aspect not preserved. RT-DETR was
//   trained and evaluated on the squashed square (read off its published
//   preprocessor_config.json), so a tall 287x640 frame is stretched
//   horizontally and undoing it is a plain multiply.
// - `letterbox` is Ultralytics': aspect preserved, the remainder padded evenly
//   on both sides. Getting the pad wrong shifts every box by it, consistently
//   high or low.
// - `padsquare` is OWLv2's, and it is *not* letterbox: the picture is padded to
//   a square at the **bottom and right only**, then resized. Centring it would
//   put every box half a pad out, in a model whose boxes are normalized to the
//   padded square rather than to the picture.
const INPUT_SIZE = 640;
const RESCALE = 1 / 255;
// Ultralytics' letterbox pad, in the model's own input units. Not zero: a black
// border is a thing the network was never trained to see, and it invents edges
// along it.
const LETTERBOX_FILL = 114 * RESCALE;
// OWLv2 pads with mid-grey, in rescaled units, before its normalization.
const OWL_PAD_FILL = 0.5;
// CLIP's, which OWLv2 inherits, and ImageNet's, which SegFormer uses. Neither
// YOLO nor RT-DETR takes any — a mean/std applied where none was trained shifts
// every activation and shows up as a detector that has simply gone quiet.
const CLIP_NORM = {
  mean: [0.48145466, 0.4578275, 0.40821073],
  std: [0.26862954, 0.26130258, 0.27577711],
};
const IMAGENET_NORM = {
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
};

// Everything a head needs before its own decoder is reached. The head itself is
// read off the loaded graph's signature (see `build`), never off the filename or
// the setting, so this table is indexed by something the model declared.
const HEADS = {
  rtdetr: { size: 640, fit: 'squash', norm: null, fill: 0 },
  yolo: { size: 640, fit: 'letterbox', norm: null, fill: LETTERBOX_FILL },
  yoloworld: { size: 640, fit: 'letterbox', norm: null, fill: LETTERBOX_FILL },
  owlv2: { size: 960, fit: 'padsquare', norm: CLIP_NORM, fill: OWL_PAD_FILL },
  segformer: { size: 512, fit: 'squash', norm: IMAGENET_NORM, fill: 0 },
};
// The decoder emits a fixed 300 queries and needs no NMS — that is the point of
// the architecture. What it does need is a score threshold.
const DEFAULT_SCORE_MIN = 0.35;
const DEFAULT_MAX_DETS = 50;
// Duplicate suppression. RT-DETR is trained with one-to-one matching and is
// described as NMS-free, and at its own operating threshold it is — but at the
// lower thresholds this experiment wants (an object seen across a room is a
// small, low-confidence box) several queries do land on one object. Measured on
// six frames from an existing recording: one potted plant came back as five
// overlapping boxes and one fridge as two nested ones.
//
// That is not a cosmetic problem here. Every box becomes a bearing, and five
// bearings to one plant from one viewpoint would look to the map exactly like
// five independent confirmations of a position that no other viewpoint agrees
// with — the failure the viewpoint-cell rule exists to catch, arriving from
// inside a single frame where that rule cannot see it.
const DEDUPE_IOU = 0.55;
// IoU alone misses the nested case: a box wholly inside a larger one can score
// well under any sane IoU bar while being the same object. Containment is the
// second test, against the smaller box's own area.
const DEDUPE_CONTAIN = 0.75;
// The smallest share of the label grid a segmentation component may cover and
// still become a detection. A semantic label map is speckled at boundaries, and
// a four-pixel island is a boundary artefact rather than a chair across the
// room; 0.2% of a 128x128 grid is 33 cells, which at this camera's field of
// view is about a 40 mm object at 3 m.
const SEG_MIN_AREA_FRAC = 0.002;
// How many tokens a prompt is padded to. OWLv2's processor uses 16 and the
// prompts here are two or three words, so nothing is ever truncated.
const PROMPT_TOKENS = 16;

// Which frame edges a box ran off, in *image* axes. Turning these into world
// axes needs the camera's orientation and is objects.js's job.
const CLIP_LEFT = 1 << 0;
const CLIP_RIGHT = 1 << 1;
const CLIP_TOP = 1 << 2;
const CLIP_BOTTOM = 1 << 3;

// `models/foo.onnx` -> `models/foo`. `path.basename` first, always: the model
// name reaches here from a setting and an environment variable, and a name that
// could contain a separator would be a way to read and load files outside
// `models/`.
function modelPath(name) {
  return path.join(MODELS_DIR, path.basename(name || DEFAULT_MODEL_FILE));
}

// The class names, which are not in either graph in a form onnxruntime-node
// will hand over (`session.metadata` is null on both). Sidecar shapes are
// probed rather than one, because the models publish them differently:
// RT-DETR ships a HuggingFace `config.json` with `id2label`, the YOLO export
// carries them as an ultralytics metadata property that `fetch-vendor.js`
// extracts into a plain id->name JSON, and an open-vocabulary model has no
// class list at all — its classes are the prompts it was asked for, so the
// prompt file *is* the name list and the two must never disagree.
function loadClassNames(modelFile, log) {
  const base = modelFile.replace(/\.onnx$/i, '');
  for (const [file, pick] of [
    [`${base}-prompts.json`, (o) => (Array.isArray(o) ? o : null)],
    [`${base}-names.json`, (o) => (Array.isArray(o) ? o : o)],
    [`${base}-config.json`, (o) => o.id2label],
  ]) {
    let raw;
    try {
      raw = pick(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch { continue; }
    if (!raw) continue;
    const names = [];
    for (const [id, label] of Object.entries(raw)) names[Number(id)] = label;
    if (names.length) return names;
  }
  // A detection whose class is an integer is one nothing downstream can write an
  // allow-list against, so say so rather than letting it look like it worked.
  log?.(`Object detector: no class names beside ${path.basename(modelFile)} `
    + '— classes will be integers');
  return null;
}

// Which vocabulary the loaded model speaks, for the allow-list downstream. Read
// off the graph and the names themselves rather than off the filename: the file
// can be renamed, and an allow-list written against the wrong vocabulary
// silently maps nothing while looking like an empty room.
//
// `open` is not a vocabulary in the sense the other four are — the classes are
// whatever the prompt file asked for — so it is reported as its own thing
// rather than being squeezed into one of the fixed lists. Downstream that means
// an explicit allow-list, which is honest: nothing here can know what a prompt
// list contains.
function vocabOf(names, head) {
  if (head === 'yoloworld' || head === 'owlv2') return 'open';
  if (head === 'segformer') return 'ade';
  if (!names) return 'unknown';
  if (names.includes('Cabinet/shelf')) return 'o365';
  // The prompt-free YOLOE export speaks the RAM tag list — 4585 names, and the
  // only fixed vocabulary here that can say `door`.
  if (names.length > 1000) return 'ram';
  return 'coco';
}

// How the submitted frame maps into the model's square input. `sx`/`sy` are
// source pixels per input pixel and `padX`/`padY` are the input-space offsets
// the picture starts at, so *one* expression undoes every fit:
// `source = (input - pad) * s`.
function inputFit(sw, sh, fit, size) {
  if (fit === 'squash') return { sx: sw / size, sy: sh / size, padX: 0, padY: 0 };
  const s = Math.max(sw, sh) / size;
  // `padsquare` pads at the bottom and right only, so the picture starts at the
  // origin and there is no offset to undo — the whole difference from letterbox
  // is this one term, which is why they share an expression rather than a
  // second copy of the resampler.
  if (fit === 'padsquare') return { sx: s, sy: s, padX: 0, padY: 0 };
  return { sx: s, sy: s, padX: (size - sw / s) / 2, padY: (size - sh / s) / 2 };
}

// Bilinear resample of an RGBA image into the model's float32 CHW input.
//
// Done here rather than by a library because it is twenty lines and the
// alternative is a native image dependency for one resize. Bilinear rather than
// nearest: the phone already decimated 860x1920 down to about 287x640, and
// point-sampling that again into 640x640 puts aliasing into exactly the
// high-frequency structure a detector keys on.
// One loop for both fits, parameterized by `inputFit` above rather than
// duplicated per model: a second copy of this would be a second place for the
// half-pixel convention to drift, and the two would then disagree about where
// every box is by a fraction that looks like detector noise.
function toInputTensor(rgba, sw, sh, out, fit, head) {
  const size = head.size;
  const plane = size * size;
  const { mean, std } = head.norm || {};
  // The pad has to be written every frame wherever the picture does not cover
  // the whole square — the buffer is reused between frames and the previous
  // picture's edge would otherwise show through. Written already normalized,
  // because the pad value is stated in rescaled units and the network sees it
  // through the same mean/std as everything else.
  if (fit.sx * size > sw + 0.5 || fit.sy * size > sh + 0.5) {
    if (mean) {
      for (let ch = 0; ch < 3; ch++) {
        out.fill((head.fill - mean[ch]) / std[ch], ch * plane, (ch + 1) * plane);
      }
    } else out.fill(head.fill);
  }
  for (let y = 0; y < size; y++) {
    // Sample at pixel centres, or the whole image shifts half a pixel and every
    // box inherits the offset.
    const syRaw = (y + 0.5 - fit.padY) * fit.sy - 0.5;
    if (syRaw < -0.5 || syRaw > sh - 0.5) continue;     // inside the pad
    const sy = Math.min(sh - 1, Math.max(0, syRaw));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < size; x++) {
      const sxRaw = (x + 0.5 - fit.padX) * fit.sx - 0.5;
      if (sxRaw < -0.5 || sxRaw > sw - 0.5) continue;
      const sx = Math.min(sw - 1, Math.max(0, sxRaw));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const a = (y0 * sw + x0) * 4;
      const b = (y0 * sw + x1) * 4;
      const c = (y1 * sw + x0) * 4;
      const d = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const o = y * size + x;
      for (let ch = 0; ch < 3; ch++) {
        const v = (rgba[a + ch] * w00 + rgba[b + ch] * w10
          + rgba[c + ch] * w01 + rgba[d + ch] * w11) * RESCALE;
        out[ch * plane + o] = mean ? (v - mean[ch]) / std[ch] : v;
      }
    }
  }
  return out;
}

// RT-DETR scores each of 300 queries against every class independently through
// a sigmoid — focal-loss training, so the classes do not compete and there is no
// background class to discard.
//
// One deliberate departure from the reference post-processor, which takes a
// top-k over the flattened (query x class) grid and can therefore emit one box
// twice under two labels: only the best-scoring class per query is kept. A
// physical object is one thing in the map, and a chair that is also 31% "couch"
// must not become two entries competing to be triangulated.
function decodeRtdetr(logits, boxes, sw, sh, scoreMin) {
  const nQ = 300;
  const nC = logits.length / nQ;
  const out = [];
  for (let q = 0; q < nQ; q++) {
    let bestC = -1;
    let bestS = 0;
    const base = q * nC;
    for (let c = 0; c < nC; c++) {
      // sigmoid, computed without exp overflow on strongly negative logits
      const z = logits[base + c];
      const s = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
      if (s > bestS) { bestS = s; bestC = c; }
    }
    if (bestC < 0 || bestS < scoreMin) continue;
    // cxcywh, normalized to the (squashed) input square. Undoing the squash is
    // a plain multiply by the submitted frame's own size.
    const cx = boxes[q * 4];
    const cy = boxes[q * 4 + 1];
    const bw = boxes[q * 4 + 2];
    const bh = boxes[q * 4 + 3];
    out.push({
      clsId: bestC,
      score: bestS,
      x0: (cx - bw / 2) * sw,
      y0: (cy - bh / 2) * sh,
      x1: (cx + bw / 2) * sw,
      y1: (cy + bh / 2) * sh,
    });
  }
  return out;
}

// YOLO's single output, `[1, 4 + nc, nAnchors]`, **channel-major**: every
// anchor's cx is contiguous, then every cy, and so on. Verified by loading the
// graph rather than assumed, along with the two things that would otherwise be
// silent errors — the boxes are in *input pixels* (0-640), not normalized, and
// the class scores are **already through a sigmoid** in the exported graph, so
// applying another one here would squash everything toward 0.5 and quietly
// halve the detection count.
//
// There is no objectness channel to reject an anchor cheaply with, so the best
// class has to be found over all `nc` of them for all `nAnchors` — 3.07M reads
// per frame at Objects365's 365 classes, against a 61 ms inference.
function decodeYolo(data, dims, sw, sh, fit, scoreMin) {
  const nA = dims[2];
  const nC = dims[1] - 4;
  const out = [];
  for (let a = 0; a < nA; a++) {
    let bestC = -1;
    let bestS = 0;
    for (let c = 0; c < nC; c++) {
      const s = data[(4 + c) * nA + a];
      if (s > bestS) { bestS = s; bestC = c; }
    }
    if (bestC < 0 || bestS < scoreMin) continue;
    const cx = data[a];
    const cy = data[nA + a];
    const bw = data[2 * nA + a];
    const bh = data[3 * nA + a];
    // Input pixels back to the submitted frame's own pixels: undo the pad, then
    // the scale. The same expression serves both fits because a squash simply
    // has no pad.
    out.push({
      clsId: bestC,
      score: bestS,
      x0: (cx - bw / 2 - fit.padX) * fit.sx,
      y0: (cy - bh / 2 - fit.padY) * fit.sy,
      x1: (cx + bw / 2 - fit.padX) * fit.sx,
      y1: (cy + bh / 2 - fit.padY) * fit.sy,
    });
  }
  return out;
}

// The other YOLO layout: an export with NMS already inside the graph, which
// emits a fixed 300 **rows** of `[x0, y0, x1, y1, score, class, ...]` rather
// than the raw channel-major grid. The prompt-free YOLOE export is one of
// these, and its trailing 32 columns are segmentation mask coefficients that
// nothing here reads.
//
// **Which layout a graph emits is read off the dims, not off the filename.** A
// raw head has far more anchors than channels (8400 against 369) and an
// end-to-end one has far more rows than columns (300 against 38), so the
// comparison is unambiguous in both directions — and getting it backwards
// would produce boxes rather than an error, which is the failure this whole
// file is arranged to prevent.
function decodeYoloRows(data, dims, fit, scoreMin) {
  const n = dims[1];
  const stride = dims[2];
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = i * stride;
    const score = data[base + 4];
    // Sorted by score in these exports, so the first row under the bar ends it —
    // but the loop does not rely on that, because a graph that is not sorted
    // would silently return nothing.
    if (score < scoreMin) continue;
    out.push({
      clsId: Math.round(data[base + 5]),
      score,
      x0: (data[base] - fit.padX) * fit.sx,
      y0: (data[base + 1] - fit.padY) * fit.sy,
      x1: (data[base + 2] - fit.padX) * fit.sx,
      y1: (data[base + 3] - fit.padY) * fit.sy,
    });
  }
  return out;
}

// OWLv2. One logit per (patch, prompt) through a sigmoid — the prompts do not
// compete, so there is no softmax and no background class, and a patch that
// matches nothing simply scores low against everything.
//
// Boxes are cxcywh normalized to the **padded square**, not to the picture, so
// the scale that undoes them is `max(w, h)` — which is exactly `fit.sx` times
// the input size. Padding at the bottom and right only is what makes that a
// plain multiply with no offset.
//
// Best prompt per patch only, for the reason `decodeRtdetr` keeps best class
// per query: a physical object is one thing in the map, and a door that is also
// 30% "doorway" must not become two entries competing to be triangulated.
function decodeOwl(logits, boxes, dims, fit, size, scoreMin, embeds) {
  const nP = dims[1];
  const nQ = dims[2];
  const scale = fit.sx * size;
  const out = [];
  for (let p = 0; p < nP; p++) {
    let bestQ = -1;
    let bestS = 0;
    const base = p * nQ;
    for (let q = 0; q < nQ; q++) {
      const z = logits[base + q];
      const s = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
      if (s > bestS) { bestS = s; bestQ = q; }
    }
    if (bestQ < 0 || bestS < scoreMin) continue;
    const cx = boxes[p * 4] * scale;
    const cy = boxes[p * 4 + 1] * scale;
    const bw = boxes[p * 4 + 2] * scale;
    const bh = boxes[p * 4 + 3] * scale;
    out.push({
      clsId: bestQ, score: bestS,
      x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2,
      // The vision feature for the patch this detection came from, when asked
      // for. A class label is a weak identity token — it says "a shelf", never
      // "*this* shelf" — and same-class instances 0.4 m apart are what every
      // measurement here is limited by. This vector is the strong version, and
      // it is free: the graph computes it whether or not anybody reads it.
      ...(embeds ? { emb: patchEmbed(embeds, p) } : {}),
    });
  }
  return out;
}

// One patch's feature vector, quantized to int8 and base64'd.
//
// Stored per detection in a file with thousands of them, so 768 float32 (3 KB
// as JSON) is not affordable and 768 int8 (1 KB as base64) is. **The per-vector
// scale is deliberately not stored**: the only thing these are compared with is
// cosine distance, which is invariant to it, and keeping a number nothing reads
// would invite somebody to treat these as calibrated magnitudes later.
function patchEmbed(embeds, p) {
  const dim = embeds.dims[embeds.dims.length - 1];
  const at = p * dim;
  let max = 0;
  for (let i = 0; i < dim; i++) max = Math.max(max, Math.abs(embeds.data[at + i]));
  const q = Buffer.allocUnsafe(dim);
  const s = max > 0 ? 127 / max : 0;
  for (let i = 0; i < dim; i++) q[i] = Math.round(embeds.data[at + i] * s) & 0xff;
  return q.toString('base64');
}

// Semantic segmentation into detections, which is the only candidate here that
// changes what a *bearing* is rather than what a class is called.
//
// A detector's box straddles the background at the silhouette, and the excess
// across-viewpoint scatter that measurement records is that bias. A mask has no
// such straddle, so the thing worth extracting is the **centroid of the mask**,
// not the centre of its bounding box — and since everything downstream reads a
// box centre, the box emitted here is the mask's own extents *recentred on the
// centroid*. The extents are still the silhouette's, which is what `w`/`h` mean
// downstream; only the point the bearing is taken from changes, which is
// precisely the one variable this candidate is for.
//
// Components rather than whole classes: two chairs in one frame are one label
// map and must not average into one bearing pointing between them.
function decodeSegformer(logits, dims, sw, sh, fit, size, scoreMin, minAreaFrac) {
  const nC = dims[1];
  const h = dims[2];
  const w = dims[3];
  const plane = h * w;
  // argmax and its softmax probability per cell, in one pass. The probability
  // is what becomes a score, so the class weight downstream still means "how
  // sure the network was" and not "how big the blob is".
  const lab = new Int16Array(plane);
  const prob = new Float32Array(plane);
  for (let i = 0; i < plane; i++) {
    let best = 0;
    let bestZ = -Infinity;
    for (let c = 0; c < nC; c++) {
      const z = logits[c * plane + i];
      if (z > bestZ) { bestZ = z; best = c; }
    }
    let sum = 0;
    for (let c = 0; c < nC; c++) sum += Math.exp(logits[c * plane + i] - bestZ);
    lab[i] = best;
    prob[i] = 1 / sum;
  }
  // Four-connected flood fill. Iterative and over a 128x128 grid, so the stack
  // depth a recursive one would need is not a question anyone has to answer.
  const seen = new Uint8Array(plane);
  const stack = new Int32Array(plane);
  const minArea = Math.max(4, Math.round(minAreaFrac * plane));
  const out = [];
  // Label-grid cells back to submitted-frame pixels: the grid covers the whole
  // model input, which the fit maps back to the picture.
  const gx = (size / w) * fit.sx;
  const gy = (size / h) * fit.sy;
  for (let start = 0; start < plane; start++) {
    if (seen[start]) continue;
    const cls = lab[start];
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sp = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    while (top > 0) {
      const i = stack[--top];
      const x = i % w;
      const y = (i - x) / w;
      n++;
      sx += x;
      sy += y;
      sp += prob[i];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && !seen[i - 1] && lab[i - 1] === cls) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && !seen[i + 1] && lab[i + 1] === cls) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && !seen[i - w] && lab[i - w] === cls) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && !seen[i + w] && lab[i + w] === cls) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    if (n < minArea) continue;
    const score = sp / n;
    if (score < scoreMin) continue;
    // Centroid and extents in submitted-frame pixels. `+0.5` puts the grid cell
    // at its own centre, the same half-pixel convention the resampler uses.
    const cx = ((sx / n + 0.5) * gx) - fit.padX * fit.sx;
    const cy = ((sy / n + 0.5) * gy) - fit.padY * fit.sy;
    const bw = (x1 - x0 + 1) * gx;
    const bh = (y1 - y0 + 1) * gy;
    out.push({
      clsId: cls, score,
      x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2,
      // The mask's own extent, kept beside the recentred box so a clipped-edge
      // test still asks the question it means: did the *object* run off the
      // frame, not did the recentred rectangle.
      maskBox: [x0 * gx, y0 * gy, (x1 + 1) * gx, (y1 + 1) * gy],
    });
  }
  return out;
}

// The half every decoder shares: name the class, record which frame edges the
// box ran off, clamp, deduplicate, cap. Shared rather than written twice
// because every one of these steps is a place two models could come to disagree
// about what a detection means, and nothing downstream could tell.
function finish(raw, sw, sh, maxDets, names) {
  const round1 = (v) => Math.round(v * 10) / 10;
  const out = [];
  for (const d of raw) {
    // Which edges the box ran off *before* it was clamped, and — where a head
    // produced one — the appearance vector, carried straight through. A clipped edge means
    // the object continues past the frame, so the box centre is pulled inward
    // and the bearing it implies is biased by an unknown amount.
    //
    // Recorded per edge rather than as one flag, because the two axes are not
    // equally damaging and which is which depends on how the phone was held.
    // Measured on this room: held landscape (98% of frames), the image's short
    // axis is world-*vertical*, and 36.5% of all detections are clipped only on
    // that axis — their horizontal bearing is intact and they were being thrown
    // away. Only the map knows the roll, so the decision belongs there; this
    // just reports the geometry.
    const edge = 0.5;
    // A segmentation component reports the silhouette it actually covered
    // beside the box it wants a bearing from, and the clip test belongs on the
    // silhouette: recentring on the mask centroid can pull a rectangle away
    // from an edge the object plainly ran off.
    const [ex0, ey0, ex1, ey1] = d.maskBox || [d.x0, d.y0, d.x1, d.y1];
    const clip = (ex0 < edge ? CLIP_LEFT : 0) | (ex1 > sw - edge ? CLIP_RIGHT : 0)
      | (ey0 < edge ? CLIP_TOP : 0) | (ey1 > sh - edge ? CLIP_BOTTOM : 0);
    out.push({
      cls: names ? (names[d.clsId] ?? String(d.clsId)) : String(d.clsId),
      clsId: d.clsId,
      score: Math.round(d.score * 1000) / 1000,
      box: [
        round1(Math.max(0, d.x0)), round1(Math.max(0, d.y0)),
        round1(Math.min(sw, d.x1)), round1(Math.min(sh, d.y1)),
      ],
      clipped: clip !== 0,
      clip,
      ...(d.emb ? { emb: d.emb } : {}),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return dedupe(out).slice(0, maxDets);
}

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return { iou: 0, contain: 0 };
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return {
    iou: union > 0 ? inter / union : 0,
    contain: inter / Math.max(1e-6, Math.min(areaA, areaB)),
  };
}

// Greedy, highest score first, and **within a class only**. Across classes it
// would be wrong: a vase genuinely standing on a dining table overlaps it almost
// completely, and suppressing one because the other scored higher would delete a
// real object rather than a duplicate box.
//
// This is also the NMS the YOLO head needs — that architecture is not NMS-free
// at all — rather than a second implementation of the same idea. The two jobs
// are the same job: several boxes on one object, keep the best. Whether an IoU
// bar tuned on RT-DETR's duplicate queries is tight enough for a dense
// anchor head is a measurement, and `detect-objects.js --boxes` is where it is
// taken; if it is not, the fix is a per-model bar, not a second function.
function dedupe(dets) {
  const kept = [];
  for (const d of dets) {
    let dup = false;
    for (const k of kept) {
      if (k.clsId !== d.clsId) continue;
      const { iou, contain } = overlap(k.box, d.box);
      if (iou >= DEDUPE_IOU || contain >= DEDUPE_CONTAIN) { dup = true; break; }
    }
    if (!dup) kept.push(d);
  }
  return kept;
}

// The prompt side of an open-vocabulary detector, run once per process. Both
// heads take the same prompt list and differ only in how far up the text tower
// the graph starts:
//
// - YOLO-World's export takes `txt_feats`, so the CLIP text tower runs here,
//   offline, and inference is thereafter a plain YOLO forward pass. That is the
//   claim the plan wanted checked before anything else, and it holds: the text
//   encoder is not in the per-frame loop.
// - OWLv2 carries its own text tower, so it takes token ids and re-embeds them
//   on every frame. Nothing can be done about that from here, and it is part of
//   why it is an offline oracle rather than a candidate detector.
async function buildTextFeeds(head, prompts, ort, log) {
  const { createClipTokenizer, embedPrompts } = require('./clip-text.js');
  if (head === 'yoloworld') {
    const rows = await embedPrompts(prompts, { log });
    const dim = rows[0].length;
    const flat = new Float32Array(rows.length * dim);
    rows.forEach((r, i) => flat.set(r, i * dim));
    return { txt_feats: new ort.Tensor('float32', flat, [1, rows.length, dim]) };
  }
  const tok = createClipTokenizer();
  const n = prompts.length;
  const ids = new BigInt64Array(n * PROMPT_TOKENS);
  const mask = new BigInt64Array(n * PROMPT_TOKENS);
  prompts.forEach((p, i) => {
    const t = tok.tokenize(p, PROMPT_TOKENS);
    for (let k = 0; k < PROMPT_TOKENS; k++) {
      ids[i * PROMPT_TOKENS + k] = BigInt(t.ids[k]);
      mask[i * PROMPT_TOKENS + k] = BigInt(t.mask[k]);
    }
  });
  log?.(`OWLv2 prompts: ${n} x ${PROMPT_TOKENS} tokens`);
  return {
    input_ids: new ort.Tensor('int64', ids, [n, PROMPT_TOKENS]),
    attention_mask: new ort.Tensor('int64', mask, [n, PROMPT_TOKENS]),
  };
}

function createOrtBackend({ log, scoreMin, maxDets, modelFile, wantEmbeds }) {
  const file = modelPath(modelFile);
  let session = null;
  let names = null;
  let vocab = 'unknown';
  let input = null;
  let ort = null;
  let head = null;      // a key of HEADS
  let geom = null;      // HEADS[head]
  let inputName = null;
  // Constant across every frame and computed once at load, for the two heads
  // that are prompted rather than trained on a class list: YOLO-World takes the
  // text embeddings as a graph input, OWLv2 takes the token ids and embeds them
  // itself. Either way the text side runs once per process and never per frame,
  // which is the whole reason an open-vocabulary model is affordable here.
  let textFeeds = null;
  // The *promise*, not just the session. `ensure` is awaited from two places at
  // once — the explicit `load()` a caller uses to learn the vocabulary, and the
  // first `detect()` — and a `if (session)` guard cannot see a load that has
  // started and not finished. Measured: the model was built twice on every
  // server start, 160 MB and two full load times for one detector.
  let loading = null;

  async function build() {
    if (!fs.existsSync(file)) {
      throw new Error(`missing ${path.relative(__dirname, file)} — run "npm run fetch-vendor"`);
    }
    // Required lazily: the server must start, and every replay tool must run,
    // on a machine that never fetched the model. Same standing as opencv.js.
    ort = require('onnxruntime-node');
    const t0 = Date.now();
    session = await ort.InferenceSession.create(file);
    // **The head comes from the graph, never from the filename or the flag.**
    // A mislabelled setting could otherwise decode one model's output with the
    // other's reader, and both readers produce numbers rather than errors —
    // boxes in the wrong units, in the wrong place, with no complaint anywhere.
    const outs = session.outputNames;
    const ins = session.inputNames;
    // The two prompted heads are told apart on their *inputs*, and they have to
    // be: OWLv2 emits `logits` and `pred_boxes` exactly as RT-DETR does, and
    // reading one with the other's decoder would produce boxes rather than a
    // complaint. YOLO-World is a plain YOLO grid whose class axis is however
    // many prompts it was handed.
    if (ins.includes('input_ids') && ins.includes('pixel_values')) head = 'owlv2';
    else if (ins.includes('txt_feats')) head = 'yoloworld';
    else if (outs.includes('logits') && outs.includes('pred_boxes')) head = 'rtdetr';
    else if (outs.length === 1 && outs[0] === 'logits') head = 'segformer';
    else if (outs[0] === 'output0') head = 'yolo';
    else {
      session = null;
      throw new Error(`unrecognised detector signature: ${ins.join(',')} -> ${outs.join(',')}`);
    }
    geom = HEADS[head];
    inputName = head === 'owlv2' || head === 'segformer' ? 'pixel_values' : ins[0];
    names = loadClassNames(file, log);
    vocab = vocabOf(names, head);
    if (head === 'yoloworld' || head === 'owlv2') {
      if (!names) {
        session = null;
        throw new Error(`${path.basename(file)} is prompted — it needs a `
          + `${path.basename(file).replace(/\.onnx$/i, '')}-prompts.json beside it`);
      }
      textFeeds = await buildTextFeeds(head, names, ort, log);
    }
    input = new Float32Array(3 * geom.size * geom.size);
    log?.(`Object detector ready: ${path.basename(file)} `
      + `(${head}, ${names ? names.length : 0} classes, ${vocab}, ${geom.size}px ${geom.fit}, `
      + `${ins.join(',')} -> ${outs.join(',')}, ${Date.now() - t0} ms)`);
    return session;
  }

  function ensure() {
    if (session) return Promise.resolve(session);
    if (!loading) {
      // Cleared on failure so a missing model is retried rather than being a
      // permanently rejected promise every later frame awaits.
      loading = build().catch((err) => { loading = null; throw err; });
    }
    return loading;
  }

  return {
    name: `ort:${path.basename(file)}`,
    // What the loaded model can name, for the allow-list downstream. Null until
    // the first detection, because loading is deliberately lazy — a caller that
    // needs it before then is asking a question the process cannot answer yet.
    get classNames() { return names; },
    get vocab() { return vocab; },
    async load() { await ensure(); return { vocab, classNames: names, head }; },
    async detect(jpeg) {
      await ensure();
      // Required lazily for the same reason, and because a caller that hands
      // over already-decoded pixels never needs it at all.
      const { decode } = require('jpeg-js');
      const img = jpeg.width && jpeg.data ? jpeg : decode(jpeg, { useTArray: true });
      const fit = inputFit(img.width, img.height, geom.fit, geom.size);
      toInputTensor(img.data, img.width, img.height, input, fit, geom);
      const feeds = {
        ...textFeeds,
        [inputName]: new ort.Tensor('float32', input, [1, 3, geom.size, geom.size]),
      };
      const res = await session.run(feeds);
      let raw;
      if (head === 'yolo' || head === 'yoloworld') {
        const o = res.output0;
        // Raw channel-major grid, or an export with NMS already inside it. Told
        // apart on the dims, which point opposite ways for the two layouts —
        // see `decodeYoloRows`.
        raw = o.dims[2] > o.dims[1]
          ? decodeYolo(o.data, o.dims, img.width, img.height, fit, scoreMin)
          : decodeYoloRows(o.data, o.dims, fit, scoreMin);
      } else if (head === 'owlv2') {
        raw = decodeOwl(res.logits.data, res.pred_boxes.data, res.logits.dims,
          fit, geom.size, scoreMin, wantEmbeds ? res.image_embeds : null);
      } else if (head === 'segformer') {
        raw = decodeSegformer(res.logits.data, res.logits.dims, img.width, img.height,
          fit, geom.size, scoreMin, SEG_MIN_AREA_FRAC);
      } else {
        raw = decodeRtdetr(res.logits.data, res.pred_boxes.data, img.width, img.height, scoreMin);
      }
      return finish(raw, img.width, img.height, maxDets, names);
    },
    close() { session = null; loading = null; input = null; },
  };
}

// For a detector that is not an ONNX graph — an open-vocabulary model, or one
// running on another machine. Same contract, and the rest of the system cannot
// tell which one answered.
function createHttpBackend({ url, scoreMin, maxDets }) {
  return {
    name: `http:${url}`,
    // Whatever is on the other end names its own classes and this side cannot
    // know which vocabulary they are from, so the allow-list falls back to the
    // default one rather than guessing.
    classNames: null,
    vocab: 'unknown',
    async load() { return { vocab: 'unknown', classNames: null, head: 'http' }; },
    async detect(jpeg) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'image/jpeg' },
        body: jpeg,
      });
      if (!res.ok) throw new Error(`detector HTTP ${res.status}`);
      const body = await res.json();
      const dets = (body.dets || body.detections || [])
        .filter((d) => d.score >= scoreMin)
        .sort((a, b) => b.score - a.score);
      return dets.slice(0, maxDets);
    },
    close() {},
  };
}

function createObjectDetector({
  backend = process.env.SYNORA_OBJDET || 'ort',
  url = process.env.SYNORA_OBJDET_URL || 'http://127.0.0.1:8765/detect',
  scoreMin = Number(process.env.SYNORA_OBJDET_SCORE) || DEFAULT_SCORE_MIN,
  maxDets = DEFAULT_MAX_DETS,
  // The environment variable wins over the argument, so an offline run can
  // switch models without the caller threading a flag through: comparing two
  // models over the same recorded frames is the whole point of that path.
  modelFile = process.env.SYNORA_OBJDET_MODEL || DEFAULT_MODEL_FILE,
  // Off unless asked for: an appearance vector per detection is a kilobyte a
  // box, which is worth paying offline to answer whether two sightings are the
  // same object and is not worth paying anywhere else yet.
  wantEmbeds = false,
  log,
} = {}) {
  if (backend === 'http') return createHttpBackend({ url, scoreMin, maxDets });
  if (backend !== 'ort') throw new Error(`unknown SYNORA_OBJDET backend: ${backend}`);
  return createOrtBackend({ log, scoreMin, maxDets, modelFile, wantEmbeds });
}

// Whether the default backend could run at all, for the one-line startup report.
// Deliberately a file check rather than a load: the server must not spend 300 ms
// and 80 MB of resident memory on a feature that is off by default.
function objectDetectorAvailable(modelFile) {
  return fs.existsSync(modelPath(modelFile || process.env.SYNORA_OBJDET_MODEL));
}

module.exports = {
  createObjectDetector, objectDetectorAvailable, modelPath,
  INPUT_SIZE, DEFAULT_MODEL_FILE, DEFAULT_SCORE_MIN,
  CLIP_LEFT, CLIP_RIGHT, CLIP_TOP, CLIP_BOTTOM,
};
