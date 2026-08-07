'use strict';

// The object channel's frames written out as ordinary image files, beside the
// `.frames` log they came from — the picture, the depth map, and the two
// composited so a person can see at a glance whether the depth lines up with
// what the camera was looking at.
//
// All three are switchable independently (`objSaveCamera`, `objDepthImages`,
// `objSaveOverlay`) because they cost very different things: the picture is
// already in the log and writing it again is pure duplication, the depth PNG is
// the only readable form of data that exists nowhere else, and the overlay is
// the expensive one — a decode, a per-pixel blend and a re-encode per frame.
//
// ## Depth maps
//
// The bytes are already in the log losslessly, so these files exist to be
// *looked at* — but they are not a preview: 16-bit grayscale at a fixed metric
// scale is the standard way depth datasets are stored (Kinect, TUM, NYU all do
// exactly this), so the pixel value is the measurement and a viewer, a script
// or OpenCV all read it the same way.
//
// **Fixed scale, never per-frame normalization.** `DEPTH_FULL_SCALE_M` maps to
// the top of the 16-bit range, so two frames are directly comparable and a
// value means the same thing in every file. Auto-stretching each frame to its
// own range would make a corridor and a cupboard look identical, which is the
// one thing a depth image must not do. 0 stays 0 and means "no reading", also
// the dataset convention.
//
// **Written in the camera image's orientation, not the buffer's.** ARCore hands
// over a 160x90 landscape buffer for a portrait picture — the
// `normDepthBufferFromNormView` matrix is a quarter turn — so the raw buffer
// laid next to the photograph would be sideways and unreadable. Resampling
// through `depthAtPixel` fixes that and does something more useful besides: it
// is the *same* lookup the object map samples box centres with, so if that
// convention were ever wrong (the Y direction is the risk) these images would
// show it at a glance instead of it hiding in a prior nobody can see.
//
// ## Every file is written the right way up
//
// The phone's layout is orientation-locked, so the camera image is always
// portrait however the device is held — and it is held landscape 98% of the
// time, which means the picture as captured is lying on its side. The frame
// header carries the quarter turn the phone measured from gravity
// (`screenRotDeg`, the same figure its own overlay is stood up by), and every
// file written here is turned by it.
//
// **Only the files.** Nothing in the pipeline is rotated: the detector sees the
// frame as captured, boxes stay in captured-frame pixels, and `bearing()` in
// objects.js projects through intrinsics that describe that same frame. A
// rotation applied anywhere upstream of those would be a silent reinterpretation
// of every bearing in the map. Boxes are therefore drawn *before* the turn, in
// their own coordinates, and the composed picture is turned as a whole — the
// two cannot come apart.
//
// Quarter turns only, so it is an index remap and not a resample: no
// interpolation, no softening, and a 180 does not cost more than a 90.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { depthAtPixel } = require('./public/frame-wire.js');

// Chosen from the data rather than picked: across 590k readings from two walks
// the median is 2.15 m, p90 3.58 and only 0.7% exceed 6 m. Six metres over 16
// bits is 0.09 mm a step — finer than the source's own millimetre quantisation,
// so nothing is lost under the ceiling — and it puts a typical room at about a
// third to two thirds brightness, which is the difference between an image
// somebody can read and one that looks black.
//
// Values above the ceiling clamp to white. That is honest rather than lossy in
// any way that matters: measured, the error past 3 m runs 0.9-1.7 m with the
// bias *being* the error, and nothing in the product reads a sample past 3.5 m.
// The full-precision values are in the `.frames` log either way — these files
// are for looking at.
const DEPTH_FULL_SCALE_M = 6;

// The turn that stands a picture up, from the roll its producer recorded.
//
// **Counter-clockwise**, and this is the one thing here that cannot be reasoned
// out — it was got wrong first time and fixed against a recorded landscape walk.
// The header's `roll` is `screenRotDeg`: how far the *screen* has been rolled,
// which is what the phone's own DOM overlay is rotated *by* to stand itself back
// up. The camera image is not the overlay: it comes out of the same rolled view,
// so it has to come back the other way. Measured on a roll=90 frame — the desk
// runs down the left edge, so world-down is at image-left and world-up at
// image-right, and bringing image-right to the top is a left turn.
function uprightDeg(roll) { return -(roll || 0); }

// Turn an interleaved raster clockwise by a multiple of 90 degrees. `stride` is
// the elements per pixel, so this serves the RGBA pictures and the 16-bit depth
// grid alike rather than being written once per element type — the destination
// index is the whole of the difference between the two.
//
// A plain geometric primitive: it takes the angle it is given. Which angle
// stands a frame up is `uprightDeg`'s business, in one place, so the sign lives
// somewhere it can be stated and checked rather than in four call sites.
function rotateQuarter(src, w, h, deg, stride = 1) {
  const q = ((Math.round((deg || 0) / 90) % 4) + 4) % 4;
  if (!q) return { data: src, w, h };
  const rw = q === 2 ? w : h;
  const rh = q === 2 ? h : w;
  const out = new src.constructor(rw * rh * stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx;
      let dy;
      if (q === 1) { dx = h - 1 - y; dy = x; }
      else if (q === 2) { dx = w - 1 - x; dy = h - 1 - y; }
      else { dx = y; dy = w - 1 - x; }
      const s = (y * w + x) * stride;
      const d = (dy * rw + dx) * stride;
      for (let c = 0; c < stride; c++) out[d + c] = src[s + c];
    }
  }
  return { data: out, w: rw, h: rh };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// `samples` is a Uint16Array of w*h, row-major, big-endian on the way out
// because that is what PNG specifies.
function encodeGray16(samples, w, h) {
  const stride = w * 2;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const base = y * (stride + 1);
    raw[base] = 0;                       // filter: none
    for (let x = 0; x < w; x++) {
      raw.writeUInt16BE(samples[y * w + x], base + 1 + x * 2);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 16;    // bit depth
  ihdr[9] = 0;     // colour type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Resample a depth map into the camera image's own orientation and aspect.
// `outLong` is the long edge of the result; the short edge follows the picture,
// so the file lines up with the frame it belongs to.
function depthToPng(depth, imgW, imgH, outLong = 160, roll = 0) {
  if (!depth?.data?.length) return null;
  const portrait = imgH >= imgW;
  const outH = portrait ? outLong : Math.max(1, Math.round(outLong * imgH / imgW));
  const outW = portrait ? Math.max(1, Math.round(outLong * imgW / imgH)) : outLong;
  const samples = new Uint16Array(outW * outH);
  const k = 65535 / DEPTH_FULL_SCALE_M;
  let any = false;
  for (let y = 0; y < outH; y++) {
    // Sampled at pixel centres, in the frame's own pixel coordinates, because
    // that is what depthAtPixel normalizes against.
    const v = ((y + 0.5) / outH) * imgH;
    for (let x = 0; x < outW; x++) {
      const u = ((x + 0.5) / outW) * imgW;
      const m = depthAtPixel(depth, u, v, imgW, imgH);
      if (m === null) continue;          // outside the buffer, or no reading: stays 0
      samples[y * outW + x] = Math.max(1, Math.min(65535, Math.round(m * k)));
      any = true;
    }
  }
  if (!any) return null;                 // a warm-up frame with nothing in it
  // Turned after resampling, not during: the sampling grid is in the frame's own
  // pixel coordinates because that is what depthAtPixel normalizes against, and
  // rotating the lookup instead of the result would put the one convention this
  // file exists to expose behind a second transform.
  const rot = rotateQuarter(samples, outW, outH, uprightDeg(roll));
  return encodeGray16(rot.data, rot.w, rot.h);
}

function writeDepthPng(pathname, depth, imgW, imgH, outLong, roll) {
  const png = depthToPng(depth, imgW, imgH, outLong, roll);
  if (!png) return false;
  fs.writeFileSync(pathname, png);
  return true;
}

// --- the overlay ---

// Turbo, as piecewise-linear interpolation between its control points. Chosen
// over grayscale for the composite because the picture underneath is already
// grayscale-ish in places, and over jet because jet's bright yellow band
// invents an edge where the data is smooth. Near is dark blue, far is dark red,
// which is the convention every depth viewer uses.
const TURBO = [
  [0x30, 0x12, 0x3b], [0x41, 0x45, 0xab], [0x46, 0x75, 0xed], [0x39, 0xa2, 0xfc],
  [0x1b, 0xcf, 0xd4], [0x62, 0xfc, 0x6b], [0xd1, 0xe8, 0x34], [0xfe, 0x9b, 0x2d],
  [0x7a, 0x04, 0x03],
];

function turbo(t) {
  const x = Math.max(0, Math.min(1, t)) * (TURBO.length - 1);
  const i = Math.min(TURBO.length - 2, Math.floor(x));
  const f = x - i;
  const a = TURBO[i];
  const b = TURBO[i + 1];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

// The camera frame with depth painted over it, as a JPEG.
//
// Blended rather than placed side by side: the question this answers is whether
// a depth reading belongs to the thing the detector drew a box around, and two
// pictures next to each other cannot answer that. Pixels with no reading are
// left untouched, so the holes in ARCore's coverage are visible as the
// photograph showing through rather than as a colour that means something.
function compositeJpeg(jpeg, depth, quality = 0.8, alpha = 0.45, roll = 0) {
  const { decode, encode } = require('jpeg-js');
  const img = decode(jpeg, { useTArray: true });
  const { width: w, height: h, data } = img;
  if (!depth?.data?.length) return null;
  const inv = 1 / DEPTH_FULL_SCALE_M;
  let painted = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = depthAtPixel(depth, x + 0.5, y + 0.5, w, h);
      if (m === null) continue;
      const [r, g, b] = turbo(m * inv);
      const o = (y * w + x) * 4;
      data[o] = data[o] * (1 - alpha) + r * alpha;
      data[o + 1] = data[o + 1] * (1 - alpha) + g * alpha;
      data[o + 2] = data[o + 2] * (1 - alpha) + b * alpha;
      painted++;
    }
  }
  if (!painted) return null;
  const rot = rotateQuarter(data, w, h, uprightDeg(roll), 4);
  return encode({ data: rot.data, width: rot.w, height: rot.h }, Math.round(quality * 100)).data;
}

// --- detection overlays ---

// A 5x7 bitmap font, five bits a row, most significant bit leftmost. Written
// out rather than depended on for the same reason `encodeGray16` and `turbo`
// are: one small table against a font library and a canvas implementation, for
// text that only ever has to be legible at 1:1 over a 287x640 photograph.
//
// Uppercase only, and unknown characters become `?` rather than a gap — a label
// with letters silently dropped reads as a different class.
const FONT_W = 5;
const FONT_H = 7;
const GLYPHS = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0e],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x1f],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x11, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x11, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  '%': [0x19, 0x19, 0x02, 0x04, 0x08, 0x13, 0x13],
  '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
};

// A stable colour per class, so the same thing is the same colour in every
// frame and two adjacent classes are told apart at a glance. The golden angle
// spreads the hues without a palette to run out of, and **not** turbo: that
// ramp means depth in the file sitting next to this one.
//
// Per *class* here and per *object id* on the phone's own overlay, which is not
// an inconsistency: these files are read one frame at a time with no map beside
// them, and the phone's boxes are read against a list of mapped objects where
// telling two chairs apart is the whole question.
function classColour(cls) {
  let hash = 0;
  for (let i = 0; i < cls.length; i++) hash = (hash * 31 + cls.charCodeAt(i)) >>> 0;
  const hue = (hash * 137.508) % 360;
  const s = 0.85;
  const c = s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const seg = Math.floor(hue / 60) % 6;
  const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  const m = 1 - c;
  return rgb.map((v) => Math.round((v + m) * 255));
}

// Integer coordinates, enforced here rather than trusted from the caller.
// Detection boxes arrive rounded to a tenth of a pixel, and a fractional index
// into a raster is not an out-of-range error in JavaScript — it silently writes
// a named property onto the typed array and draws nothing at all. Measured: with
// this missing, most strokes simply did not appear and the picture looked like a
// detector that had found nothing.
function setPixel(data, w, h, xf, yf, rgb, alpha = 1) {
  const x = Math.round(xf);
  const y = Math.round(yf);
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const o = (y * w + x) * 4;
  data[o] = data[o] * (1 - alpha) + rgb[0] * alpha;
  data[o + 1] = data[o + 1] * (1 - alpha) + rgb[1] * alpha;
  data[o + 2] = data[o + 2] * (1 - alpha) + rgb[2] * alpha;
}

function drawText(data, w, h, text, x0, y0, scale, rgb) {
  let x = x0;
  for (const ch of text) {
    const g = GLYPHS[ch] || GLYPHS['?'];
    for (let r = 0; r < FONT_H; r++) {
      for (let c = 0; c < FONT_W; c++) {
        if (!(g[r] & (1 << (FONT_W - 1 - c)))) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            setPixel(data, w, h, x + c * scale + sx, y0 + r * scale + sy, rgb);
          }
        }
      }
    }
    x += (FONT_W + 1) * scale;
  }
}

function fillRect(data, w, h, x0, y0, x1, y1, rgb, alpha) {
  const ya = Math.max(0, Math.round(y0));
  const yb = Math.min(h, Math.round(y1));
  const xa = Math.max(0, Math.round(x0));
  const xb = Math.min(w, Math.round(x1));
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) setPixel(data, w, h, x, y, rgb, alpha);
  }
}

// The camera frame with the detector's boxes on it, as a JPEG.
//
// This is the only direct answer to "did the model see what it says it saw",
// and it is specifically the defence against the two failures a new decoder head
// produces silently: a letterbox pad handled wrong shifts every box the same
// way, and a weak NMS leaves one object wearing five boxes. Both are obvious
// here in one glance and invisible in every number the map reports.
// The turn happens **first** and the boxes are mapped through it, rather than
// the whole composed picture being turned at the end. Drawing first and turning
// after is a line shorter and puts every label on its side in the one case that
// matters — the phone is held landscape 98% of the time, so that would be
// almost every overlay this ever writes.
// One point through the same quarter turn `rotateQuarter` applies to the raster.
// The single place the mapping is written: a box, an outline and anything else
// drawn over a turned picture have to agree about where a pixel went, and two
// copies of this cannot be relied on to.
function rotatePoint(x, y, w, h, deg) {
  const q = ((Math.round((deg || 0) / 90) % 4) + 4) % 4;
  if (!q) return [x, y];
  if (q === 1) return [h - 1 - y, x];
  if (q === 2) return [w - 1 - x, h - 1 - y];
  return [y, w - 1 - x];
}

function rotateBox(box, w, h, deg) {
  const a = rotatePoint(box[0], box[1], w, h, deg);
  const b = rotatePoint(box[2], box[3], w, h, deg);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

// A straight stroke between two points, as a square stamp walked along the
// longer axis. Not anti-aliased and not meant to be: this is drawn at 1:1 over a
// 287-wide photograph and a hairline that disappears against a bright wall is
// worse than a hard edge.
function drawSegment(data, w, h, x0, y0, x1, y1, rgb, width = 1, alpha = 1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  const r = (width - 1) / 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) setPixel(data, w, h, x + ox, y + oy, rgb, alpha);
    }
  }
}

// A fitted outline, over the frame it was fitted in.
//
// **Drawn as the shape, not as its bounding box** — the whole point of the thing
// being checked here is that it is not a box. A conic fitted to the wrong edge
// chain and a quad built from three good corners and one bad one are both
// obvious in a picture and invisible in every metric that summarises them, which
// is the same argument `drawBoxesJpeg` already makes for boxes and a stronger
// one here: an outline is a much larger claim.
//
// The class colour underneath and a white core on top, so it reads over both a
// white wall and a dark one and is never mistaken for the detector's own box.
function drawOutline(data, w, h, outline, rgb, stroke, imgW, imgH, turn) {
  const pts = [];
  if (outline.kind === 'ellipse') {
    const c = Math.cos(outline.theta);
    const s = Math.sin(outline.theta);
    // 72 samples: at the sizes this runs at (a 0.62 m clock is ~91 px across at
    // 3 m) that is well under a pixel of chord error, and the cost is a rounding
    // error against the fit that produced it.
    for (let i = 0; i <= 72; i++) {
      const t = (i / 72) * 2 * Math.PI;
      const x = outline.rx * Math.cos(t);
      const y = outline.ry * Math.sin(t);
      pts.push(rotatePoint(outline.cx + x * c - y * s, outline.cy + x * s + y * c,
        imgW, imgH, turn));
    }
  } else if (outline.kind === 'quad') {
    for (let i = 0; i <= 4; i++) {
      const p = outline.pts[i % 4];
      pts.push(rotatePoint(p[0], p[1], imgW, imgH, turn));
    }
  } else return;
  for (const width of [Math.max(2, stroke), 1]) {
    const colour = width === 1 ? [255, 255, 255] : rgb;
    for (let i = 1; i < pts.length; i++) {
      drawSegment(data, w, h, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1],
        colour, width, 1);
    }
  }
}

function drawBoxesJpeg(jpeg, dets, { quality = 0.8, roll = 0 } = {}) {
  const { decode, encode } = require('jpeg-js');
  const img = decode(jpeg, { useTArray: true });
  const turn = uprightDeg(roll);
  const rot = rotateQuarter(img.data, img.width, img.height, turn, 4);
  const { data } = rot;
  const w = rot.w;
  const h = rot.h;
  // One pixel of stroke on a 287-wide frame is a hairline; the label has to
  // stay readable at 1:1 on the same frame. Both follow the picture rather than
  // being constants, so a larger `objFrameLongEdge` does not shrink them.
  const scale = Math.max(1, Math.round(Math.min(w, h) / 320));
  const stroke = Math.max(2, Math.round(Math.min(w, h) / 200));
  for (const d of dets) {
    const [x0, y0, x1, y1] = rotateBox(d.box, img.width, img.height, turn).map(Math.round);
    const rgb = classColour(d.cls);
    fillRect(data, w, h, x0, y0, x1, y0 + stroke, rgb, 1);
    fillRect(data, w, h, x0, y1 - stroke, x1, y1, rgb, 1);
    fillRect(data, w, h, x0, y0, x0 + stroke, y1, rgb, 1);
    fillRect(data, w, h, x1 - stroke, y0, x1, y1, rgb, 1);
    if (d.outline) drawOutline(data, w, h, d.outline, rgb, stroke, img.width, img.height, turn);
    const label = `${String(d.cls).toUpperCase()} ${Math.round((d.score || 0) * 100)}%`;
    const tw = label.length * (FONT_W + 1) * scale + scale;
    const th = FONT_H * scale + 2 * scale;
    // Above the box where there is room, inside its top edge where there is
    // not — a label off the top of the frame is a label that is not there.
    const ty = y0 - th >= 0 ? y0 - th : y0 + stroke;
    // Nudged back inside the frame rather than clipped. A box against the right
    // edge is the normal case for the thing this picture is checking, and half a
    // class name is not an answer to "what did it think that was".
    const tx = Math.max(0, Math.min(x0, w - tw));
    // A dark bar under the text, because the same class colour has to read over
    // both a white wall and a black one.
    fillRect(data, w, h, tx, ty, tx + tw, ty + th, [0, 0, 0], 0.6);
    drawText(data, w, h, label, tx + scale, ty + scale, scale, rgb);
  }
  return encode({ data, width: w, height: h }, Math.round(quality * 100)).data;
}

// One frame's worth of image files. Returns what was actually written, so the
// caller can report it rather than assuming.
//
// Deliberately synchronous: it is called from a deferred callback, never from
// the socket handler, and an async write queue here would need its own
// backpressure for a job that already drops frames when it falls behind.
function writeFrameImages(dir, record, opts = {}) {
  const name = String(record.header.fseq).padStart(6, '0');
  const roll = record.header.roll || 0;
  const out = { camera: false, depth: false, overlay: false };
  if (opts.camera && record.jpeg?.length) {
    // Upright costs a decode and a re-encode of bytes that were a straight copy
    // before. Worth it: a directory of sideways photographs is one nobody looks
    // through, which is the entire purpose of this file. A frame with no roll
    // recorded still costs nothing.
    fs.writeFileSync(path.join(dir, `${name}_cam.jpg`),
      Buffer.from(rotateJpeg(Buffer.from(record.jpeg), roll, opts.quality)));
    out.camera = true;
  }
  if (opts.depth && record.depth) {
    out.depth = writeDepthPng(path.join(dir, `${name}_depth.png`),
      record.depth, record.header.w, record.header.h, undefined, roll);
  }
  if (opts.overlay && record.depth && record.jpeg?.length) {
    const buf = compositeJpeg(Buffer.from(record.jpeg), record.depth, opts.quality, undefined, roll);
    if (buf) {
      fs.writeFileSync(path.join(dir, `${name}_over.jpg`), Buffer.from(buf));
      out.overlay = true;
    }
  }
  return out;
}

// Stood upright, or handed straight back when there is nothing to turn — the
// no-roll case must not pay a decode and a re-encode to produce the same bytes.
function rotateJpeg(jpeg, roll, quality = 0.8) {
  if (!roll) return jpeg;
  const { decode, encode } = require('jpeg-js');
  const img = decode(jpeg, { useTArray: true });
  const rot = rotateQuarter(img.data, img.width, img.height, uprightDeg(roll), 4);
  return encode({ data: rot.data, width: rot.w, height: rot.h }, Math.round(quality * 100)).data;
}

// The detection overlay for one frame. Separate from `writeFrameImages` because
// it is written at a different moment: the boxes do not exist when the frame
// arrives, they exist when the detector finishes with it, ~160 ms later.
function writeBoxImage(dir, record, dets, opts = {}) {
  if (!record.jpeg?.length || !dets?.length) return false;
  const name = String(record.header.fseq).padStart(6, '0');
  const buf = drawBoxesJpeg(Buffer.from(record.jpeg), dets,
    { quality: opts.quality, roll: record.header.roll || 0 });
  if (!buf) return false;
  fs.writeFileSync(path.join(dir, `${name}_dets.jpg`), Buffer.from(buf));
  return true;
}

module.exports = {
  writeDepthPng, depthToPng, encodeGray16, compositeJpeg, writeFrameImages,
  drawBoxesJpeg, writeBoxImage, rotateQuarter, rotatePoint, rotateJpeg, classColour,
  turbo, DEPTH_FULL_SCALE_M,
};
