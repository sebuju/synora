'use strict';

// Downloads the large third-party assets that are deliberately not committed
// (public/vendor/ is gitignored, like tools/). Safe to re-run:
// existing files are kept unless they are smaller than the sanity threshold,
// which catches interrupted downloads.
//
// opencv.js: official single-file build (wasm base64-inlined) — loads as a
// plain <script> defining the global `cv`, which is what the zero-build pages
// need. ArUco lives in objdetect since OpenCV 4.7, so this one file covers
// detection, ChArUco calibration, and solvePnP.
// three.js: 0.147.0 is the last release shipping non-module builds of both
// the core and OrbitControls; newer releases are ESM-only, which would break
// the globals-via-script-order convention.
//
// The object detectors, which run on this PC and never on a phone. They land in
// models/ rather than public/vendor/ because nothing serves them to a browser —
// public/vendor/ is on the static path and an 83 MB file that no page needs has
// no business being reachable from one. Both are optional: a network that cannot
// reach Hugging Face leaves the object channel dark and everything else working.
//
// Two of them, because the vocabulary is the open question and the frame corpus
// is re-runnable:
//
// - RT-DETR r18 (COCO, 80 classes, ~138 ms/frame here). The variant is
//   overridable (SYNORA_RTDETR_FILE) because the quantized builds are a third of
//   the size and several times faster, at an accuracy cost this room has not
//   measured.
// - YOLOE-11s (Objects365, 365 classes, ~61 ms/frame here). COCO has no cabinet,
//   picture, lamp, radiator, desk or nightstand — several of the most immovable
//   things in a room, and exactly what an anchor map wants. It has no Door or
//   Window either; Objects365 does not have those, which is worth knowing before
//   hoping for them.

const fs = require('fs');
const path = require('path');
const https = require('https');

const VENDOR_DIR = path.join(__dirname, 'public', 'vendor');
const MODELS_DIR = path.join(__dirname, 'models');

// Pinned by revision, not by branch: a model that silently changes under a
// measurement makes every number recorded against it unattributable.
const RTDETR_REPO = 'onnx-community/rtdetr_r18vd_coco_o365';
const RTDETR_FILE = process.env.SYNORA_RTDETR_FILE || 'model.onnx';
const YOLOE_REPO = 'wide-video/yoloe-11-Objects365-v1.0.0';
const YOLOE_FILE = process.env.SYNORA_YOLOE_FILE || 'yoloe-11s-seg-object365.onnx';
const YOLOE_DEST = path.join(MODELS_DIR, 'yoloe-o365.onnx');
const YOLOE_NAMES = path.join(MODELS_DIR, 'yoloe-o365-names.json');

const ASSETS = [
  {
    // Not every release gets its opencv.js published under docs.opencv.org
    // (4.10/4.11 are 404) — 4.9.0 is the newest pinned one that exists.
    url: 'https://docs.opencv.org/4.9.0/opencv.js',
    dest: path.join(VENDOR_DIR, 'opencv.js'),
    minBytes: 5 * 1024 * 1024,
  },
  {
    url: 'https://unpkg.com/three@0.147.0/build/three.min.js',
    dest: path.join(VENDOR_DIR, 'three.min.js'),
    minBytes: 300 * 1024,
  },
  {
    url: 'https://unpkg.com/three@0.147.0/examples/js/controls/OrbitControls.js',
    dest: path.join(VENDOR_DIR, 'OrbitControls.js'),
    minBytes: 10 * 1024,
  },
  {
    url: `https://huggingface.co/${RTDETR_REPO}/resolve/main/onnx/${RTDETR_FILE}`,
    dest: path.join(MODELS_DIR, 'rtdetr.onnx'),
    // The quantized builds are ~21 MB and the fp32 one ~83 MB, so the floor is
    // set below the smallest real variant rather than at the default's size.
    minBytes: 15 * 1024 * 1024,
    optional: true,
  },
  {
    // The class names, which are not in the graph. Without them a detection is
    // an integer, and every allow-list downstream would be written in integers.
    url: `https://huggingface.co/${RTDETR_REPO}/resolve/main/config.json`,
    dest: path.join(MODELS_DIR, 'rtdetr-config.json'),
    minBytes: 1024,
    optional: true,
  },
  {
    url: `https://huggingface.co/${YOLOE_REPO}/resolve/main/${YOLOE_FILE}`,
    dest: YOLOE_DEST,
    // The published export is 38.5 MB; the floor sits below it rather than at
    // it, so a smaller variant swapped in through the env var is not refused.
    minBytes: 30 * 1024 * 1024,
    optional: true,
    // Its class names live inside the graph, not in a repo file, so they are
    // extracted from the bytes just downloaded rather than fetched.
    after: extractYoloeNames,
  },
];

// Pull the class names out of a YOLO ONNX export.
//
// They are an ultralytics metadata property — a Python dict literal, stored as
// a protobuf string near the end of the file — and `onnxruntime-node` does not
// expose custom metadata at all (`session.metadata` is null), so there is no
// API to ask. Scanned rather than parsed as protobuf: one regex over one string
// against a protobuf reader for a single field.
//
// Without this, every class downstream is an integer and the allow-list would
// have to be written in integers too.
function extractYoloeNames(dest) {
  if (sizeOf(YOLOE_NAMES) > 0) return;
  const bytes = fs.readFileSync(dest);
  const at = bytes.indexOf(Buffer.from('names', 'latin1'), bytes.length - 4 * 1024 * 1024);
  if (at < 0) {
    console.log('WARNING  no class names found in the model — classes will be integers');
    return;
  }
  const text = bytes.subarray(at, at + 64 * 1024).toString('latin1');
  const names = {};
  let n = 0;
  for (const m of text.matchAll(/(\d+): '((?:[^'\\]|\\.)*)'/g)) {
    names[Number(m[1])] = m[2];
    n++;
  }
  if (!n) {
    console.log('WARNING  class-name metadata did not parse — classes will be integers');
    return;
  }
  fs.writeFileSync(YOLOE_NAMES, JSON.stringify(names, null, 1));
  console.log(`done     ${path.relative(__dirname, YOLOE_NAMES)} (${n} classes, from the model)`);
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error(`Too many redirects for ${url}`));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const tmp = `${dest}.download`;
      const out = fs.createWriteStream(tmp);
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      let lastPct = -10;
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct >= lastPct + 10) {
            lastPct = pct;
            process.stdout.write(`\r  ${path.basename(dest)}: ${pct}%   `);
          }
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          process.stdout.write('\r');
          fs.renameSync(tmp, dest);
          resolve(got);
        });
      });
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

async function main() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  let failed = 0;
  for (const { url, dest, minBytes, optional, after } of ASSETS) {
    const rel = path.relative(__dirname, dest);
    if (sizeOf(dest) >= minBytes) {
      console.log(`ok       ${rel} (${(sizeOf(dest) / 1024 / 1024).toFixed(1)} MB)`);
      // Still run, so a model already on disk from before this step existed
      // gets its names extracted rather than staying nameless forever.
      after?.(dest);
      continue;
    }
    console.log(`fetching ${rel} <- ${url}`);
    try {
      const bytes = await download(url, dest);
      if (bytes < minBytes) {
        console.log(`WARNING  ${rel}: only ${bytes} bytes — looks wrong, check the URL`);
        failed++;
      } else {
        console.log(`done     ${rel} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
        after?.(dest);
      }
    } catch (err) {
      console.log(`FAILED   ${rel}: ${err.message}`);
      // The detector is an experiment, not part of pose or mapping: a network
      // that cannot reach Hugging Face must not make this script look like it
      // broke the room views.
      if (!optional) failed++;
      else console.log(`         (optional — the object detector stays dark, everything else works)`);
    }
  }
  if (failed) {
    console.log(`${failed} asset(s) missing — the server will run, but pose/mapping features stay disabled.`);
    process.exitCode = 1;
  }
}

main();
