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

const fs = require('fs');
const path = require('path');
const https = require('https');

const VENDOR_DIR = path.join(__dirname, 'public', 'vendor');

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
];

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
  let failed = 0;
  for (const { url, dest, minBytes } of ASSETS) {
    const rel = path.relative(__dirname, dest);
    if (sizeOf(dest) >= minBytes) {
      console.log(`ok       ${rel} (${(sizeOf(dest) / 1024 / 1024).toFixed(1)} MB)`);
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
      }
    } catch (err) {
      console.log(`FAILED   ${rel}: ${err.message}`);
      failed++;
    }
  }
  if (failed) {
    console.log(`${failed} asset(s) missing — the server will run, but pose/mapping features stay disabled.`);
    process.exitCode = 1;
  }
}

main();
