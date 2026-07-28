'use strict';

// Depth inference worker: decodes a keyframe JPEG, runs Depth Anything V2,
// converts the output to metric depth using the tags visible in the very
// same frame, backprojects through the keyframe's room pose, and returns the
// touched voxel keys. Runs in a worker_thread so a ~0.5 s CPU inference never
// blocks the signaling loop.
//
// Both model flavors reduce to the same two numbers in inverse-depth space:
//
//     y = A * (1/z) + B,    y = pred (relative) | 1/pred (metric)
//
// - relative: output is inverse depth up to scale AND shift, so (A, B) is
//   literally what the model is missing.
// - metric (preferred): output claims to be metres, i.e. (A, B) = (1, 0).
//   Measured on real keyframes it is not — the range comes back compressed,
//   and a single multiplicative scale cannot undo compression: fixing the
//   near end throws the far end out and back again.
//
// This worker does not fit them. (A, B) belongs to the camera, not to the
// frame, so it is measured once by a deliberate calibration sweep (depth-cal.js
// pools tag samples across frames) and handed in frozen. Two jobs:
// - mode 'sample': infer, report the tag samples, paint nothing. The sweep.
// - mode 'map': infer, check the tags against the frozen calibration, and
//   backproject. A frame the calibration cannot explain is refused, because
//   the alternative — bending the calibration to fit the frame — is exactly
//   what made the map disagree with itself.

const { parentPort, workerData } = require('worker_threads');
const ort = require('onnxruntime-node');
const jpeg = require('jpeg-js');
const { quatRotate, quatConj, quatFromRvec } = require('./public/pose-math.js');
const { integrateGrid } = require('./surface.js');

const SIZE = 518;               // model input, square
// Backprojection stride over the depth map. 2 keeps ~4x the surface samples
// of the old 4: voxel evidence gets dense enough that walls fill in from far
// fewer keyframes. Backprojection is cheap next to the inference; the carve
// loop below subsamples to stay bounded.
const STRIDE = 2;
const MIN_Z_M = 0.2;
const MAX_Z_M = 10;
// Voxel keys pack three 10-bit signed-ish indices; ±512 cells covers ±38 m
// at 7.5 cm — beyond any room.
const KEY_OFFSET = 512;

// ImageNet normalization, per Depth Anything's preprocessing.
const NORM_MEAN = [0.485, 0.456, 0.406];
const NORM_STD = [0.229, 0.224, 0.225];

let sessionPromise = ort.InferenceSession.create(workerData.modelPath, {
  // All cores fight the main thread otherwise; inference latency is not the
  // bottleneck at 1 fps keyframes.
  intraOpNumThreads: Math.max(1, require('os').cpus().length - 2),
});

// Where "up" points in this frame, as an angle in image coordinates (x right,
// y down), so the frame can be fed to the model the way up it was trained on.
// Monocular depth leans on gravity and the ground plane; a phone held sideways
// hands it a world rotated out of that prior, and the frame size does not
// change when the phone turns, so nothing downstream would notice.
//
// The room pose is the better source (room y is up by construction). During a
// calibration sweep there is no room pose, and the tag supplies it instead:
// the marker frame is x right, y up, z out of the marker, so an upright-mounted
// tag carries gravity with it. Both give an upright image, which is what keeps
// a calibration valid across the sweep and the mapping that uses it.
function upAngle(pose, tags) {
  if (pose) {
    const up = quatRotate(quatConj(pose.q), [0, 1, 0]);
    return Math.atan2(up[0], -up[1]);
  }
  const angles = [];
  for (const t of tags) {
    const u = quatRotate(quatFromRvec(t.rvec), [0, 1, 0]);
    angles.push(Math.atan2(u[0], -u[1]));
  }
  if (!angles.length) return 0;
  angles.sort((a, b) => a - b);
  return angles[angles.length >> 1];
}

// The mapping between the model's square input and the keyframe's pixels:
// the frame rotated upright by `phi` and scaled to fit, letterboxed rather
// than squashed. Squashing a 9:16 frame into a square measurably curves flat
// surfaces (~15-20% worse plane residuals on real keyframes), and every
// surface this pipeline cares about is flat.
function makeGeom(w, h, phi) {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const bw = Math.abs(w * c) + Math.abs(h * s);
  const bh = Math.abs(w * s) + Math.abs(h * c);
  const scale = SIZE / Math.max(bw, bh);
  const CW = Math.max(1, Math.round(bw * scale));
  const CH = Math.max(1, Math.round(bh * scale));
  const x0 = (SIZE - CW) >> 1;
  const y0 = (SIZE - CH) >> 1;
  const halfW = CW / 2 - 0.5;
  const halfH = CH / 2 - 0.5;
  return {
    phi, scale, CW, CH, x0, y0,
    // Model pixel -> keyframe pixel. Returns null outside the frame: the
    // rotated rectangle leaves the canvas corners empty.
    src(x, y) {
      const X = (x - x0 - halfW) / scale;
      const Y = (y - y0 - halfH) / scale;
      const u = X * c - Y * s + w / 2;
      const v = X * s + Y * c + h / 2;
      if (u < 0 || u >= w || v < 0 || v >= h) return null;
      return [u, v];
    },
    // Keyframe pixel -> model pixel, for reading the depth map at a tag.
    dst(u, v) {
      const U = u - w / 2;
      const V = v - h / 2;
      return [
        x0 + halfW + (U * c + V * s) * scale,
        y0 + halfH + (-U * s + V * c) * scale,
      ];
    },
  };
}

// Bilinear resize + rotate + normalize straight into CHW float32. Untouched
// canvas stays at 0, which after normalization is the ImageNet mean — neutral
// grey rather than black, so the corners left over by the rotation do not read
// as a dark object.
function preprocess(rgba, w, h, geom) {
  const out = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let y = geom.y0; y < geom.y0 + geom.CH; y++) {
    for (let x = geom.x0; x < geom.x0 + geom.CW; x++) {
      const src = geom.src(x, y);
      if (!src) continue;
      const sx = src[0] - 0.5;
      const sy = src[1] - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const y0 = Math.max(0, Math.floor(sy));
      const y1 = Math.min(h - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * w + x0) * 4;
      const i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const v =
          (rgba[i00 + c] * (1 - fx) + rgba[i01 + c] * fx) * (1 - fy) +
          (rgba[i10 + c] * (1 - fx) + rgba[i11 + c] * fx) * fy;
        out[c * plane + y * SIZE + x] = (v / 255 - NORM_MEAN[c]) / NORM_STD[c];
      }
    }
  }
  return out;
}

// Median predicted value in a patch around a (frame-pixel) point.
function samplePred(pred, u, v, geom) {
  const [cx0, cy0] = geom.dst(u, v);
  const cx = Math.round(cx0);
  const cy = Math.round(cy0);
  const vals = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) vals.push(pred[y * SIZE + x]);
    }
  }
  vals.sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length / 2)] : null;
}

async function handle(msg) {
  const session = await sessionPromise;
  const { w, h, intrinsics, pose, tags, voxelSizeM, mode, fit } = msg;
  const decoded = jpeg.decode(msg.jpeg, { useTArray: true, maxMemoryUsageInMB: 512 });

  const geom = makeGeom(decoded.width, decoded.height, upAngle(pose, tags));
  const input = new ort.Tensor('float32',
    preprocess(decoded.data, decoded.width, decoded.height, geom), [1, 3, SIZE, SIZE]);
  const results = await session.run({ [session.inputNames[0]]: input });
  const pred = results[session.outputNames[0]].data;

  // --- tag samples ----------------------------------------------------------
  // One (true distance, model output) pair per tag the frame can see. In the
  // sweep these are the whole product; in mapping they are the check.
  const yOfPred = workerData.metric ? (p) => 1 / Math.max(0.05, p) : (p) => p;
  const samples = [];
  for (const t of tags) {
    const z = t.tvec[2];
    if (z < MIN_Z_M) continue;
    const u = intrinsics.fx * (t.tvec[0] / z) + intrinsics.cx;
    const v = intrinsics.fy * (t.tvec[1] / z) + intrinsics.cy;
    if (u < 0 || u >= w || v < 0 || v >= h) continue;
    const p = samplePred(pred, u, v, geom);
    if (p !== null) samples.push({ z, x: 1 / z, y: yOfPred(p) });
  }
  if (mode === 'sample') return { samples, sampled: true };

  const reject = (reason) => ({ voxels: new Int32Array(0), samples, rejected: reason });
  if (!fit) return reject('no frozen calibration for this camera');
  if (!samples.length) return reject('no usable tag samples');

  const A = fit.a;
  const B = fit.b;
  const zAt = (y) => {
    const invZ = (y - B) / A;
    return invZ > 0 ? 1 / invZ : Infinity;
  };
  // The tags in this frame are ground truth the calibration has to survive.
  // Failing here means the sweep no longer describes this camera (lens moved,
  // resolution changed, a different room) — the answer is another sweep, not
  // a quietly bent scale.
  //
  // Judged on the median tag, not on every tag: a frame showing three tags
  // usually has one at a glancing angle or far enough that the depth map's
  // value there is noise, and requiring unanimity let that one veto the two
  // that agreed. Measured on a real session it threw away 42% of frames.
  const MAX_RESIDUAL = 0.25;
  const residuals = samples.map((s) => Math.abs(zAt(s.y) - s.z) / s.z).sort((p, q) => p - q);
  const residual = residuals[Math.floor(residuals.length / 2)];
  if (residual > MAX_RESIDUAL) {
    return reject(`frame disagrees with the frozen calibration ` +
      `(${(residual * 100).toFixed(0)}%)`);
  }

  const zOf = (i) => zAt(yOfPred(pred[i]));

  // Whatever the flavor, the calibration must describe the map it will be
  // applied to: most of the scene should land at plausible indoor depths.
  let valid = 0;
  let total = 0;
  for (let i = 0; i < pred.length; i += 97) {
    total++;
    const z = zOf(i);
    if (z > MIN_Z_M && z < MAX_Z_M) valid++;
  }
  if (valid / total < 0.3) return reject('calibration places most of the frame out of range');

  // --- camera-frame point grid --------------------------------------------
  // Backprojection happens on a lattice rather than pixel by pixel because
  // the next two steps need neighbours: a point's honesty is judged by what
  // is around it, not by the point itself.
  const gw = Math.floor(geom.CW / STRIDE);
  const gh = Math.floor(geom.CH / STRIDE);
  const cxArr = new Float32Array(gw * gh);
  const cyArr = new Float32Array(gw * gh);
  const czArr = new Float32Array(gw * gh);
  const ok = new Uint8Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const x = geom.x0 + i * STRIDE;
      const y = geom.y0 + j * STRIDE;
      const z = zOf(y * SIZE + x);
      if (!(z > MIN_Z_M && z < MAX_Z_M)) continue;
      const src = geom.src(x, y);
      if (!src) continue;                 // canvas corner, outside the frame
      const g = j * gw + i;
      cxArr[g] = ((src[0] - intrinsics.cx) / intrinsics.fx) * z;
      cyArr[g] = ((src[1] - intrinsics.cy) / intrinsics.fy) * z;
      czArr[g] = z;
      ok[g] = 1;
    }
  }

  // Everything from here — which points are honest, their normals, the voxel
  // keys and the free-space carving — is shared with the XR client's depth,
  // which arrives as the same shape of lattice from ARCore instead.
  const integrated = integrateGrid({
    cx: cxArr, cy: cyArr, cz: czArr, ok, gw, gh, pose, voxelSizeM,
  });

  return { ...integrated, samples, residual, roll: geom.phi };
}

parentPort.on('message', (msg) => {
  handle(msg)
    .then((res) => {
      const transfers = [];
      for (const arr of [res.voxels, res.dilated, res.empties, res.surf]) {
        if (arr?.buffer && !transfers.includes(arr.buffer)) transfers.push(arr.buffer);
      }
      parentPort.postMessage({ id: msg.id, clientId: msg.clientId, ...res }, transfers);
    })
    .catch((err) => {
      parentPort.postMessage({ id: msg.id, clientId: msg.clientId, error: err.message });
    });
});
