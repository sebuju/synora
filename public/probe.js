'use strict';

// Landmark feasibility probe. Not part of the product: this page exists to
// answer one question offline, against recordings already on disk, before any
// landmark pipeline is written — is a detected object's landmark point a fixed 3D
// point at all, and how wide a viewing arc does it take to tell?
//
// It reuses the real detector (detect-core.js) and the real transform maths
// (pose-math.js) so the camera pose it measures against is the same pose the
// product would have had. Nothing here is a second copy of a product code path;
// the one thing it re-implements is the observation fuse, which lives inside
// survey.js's closure and cannot be reached from a browser (see fuseTags).
//
// Three inputs, all picked from disk — the static server only serves public/,
// and a measurement harness has no business opening a route into recordings/.
//
//   .pose.jsonl   the client's own tag solutions. Used ONLY to recover the
//                 camera intrinsics: every journaled tag carries the corners it
//                 was measured at and the rvec/tvec the client solved with its
//                 real K, and reprojecting known marker geometry under that pose
//                 is linear in (fx,cx) for u and (fy,cy) for v. Measured on
//                 2026-07-29_200054: 0.194 px residual over 3412 corners, and
//                 the 4K and 1080p segments agree to 0.06%.
//   markers.json  the surveyed tag map, i.e. the room frame.
//   .webm         the recording to label.
//
// Frame-to-journal time alignment is deliberately not attempted. Tags are
// re-detected in each frame and the camera pose is solved from them directly,
// so the pose belongs to exactly the frame being labelled and carries no
// alignment error at all.
//
// Frames arrive as JPEGs, not as a video. Recordings are raw MediaRecorder
// chunk streams and Chrome's demuxer refuses them outright — remuxing the
// container did not help, because the ALPHA_MODE flag survives it. Rather than
// keep guessing at the demuxer, the video is taken out of the loop: ffmpeg
// extracts frames once and the page only ever decodes JPEG.
//
//   tools\ffmpeg.exe -y -fflags +genpts -i recordings/<name>.webm \
//     -vf fps=2 -q:v 2 frames/f_%04d.jpg
//
// 2 fps is plenty — labelling wants ~30 frames spread over an arc, not every
// frame — and it keeps the whole session under 40 MB.

const els = {};
for (const id of ['view', 'status', 'out', 'tNow', 'step', 'lmName', 'lmList',
  'autoStep', 'fJournal', 'fMap', 'fFrames', 'fLabels', 'minObs', 'minArc', 'fAnchors']) {
  els[id] = document.getElementById(id);
}
const ctx = els.view.getContext('2d', { willReadFrequently: true });

// Gates and weights mirrored from survey.js so the camera pose measured here is
// the pose the product would have produced from the same frame.
const OBS_MAX_ERR_PX = 3;
const OBS_MAX_DIST_M = 10;
const OBS_MIN_COS_ANGLE = 0.15;
const SIN2_FLOOR = 0.02;

let core = null;
let lumaSource = null;
let intrinsics = new Map();   // "WxH" -> {fx,fy,cx,cy}
let markerSizeM = 0.15;
let markers = new Map();      // id -> {p,q}
let frame = null;             // { w, h, pose, tags } for the frame on screen
let labels = new Map();       // name -> [{ t, u, v, w, h, pose }] — t is a frame index
let active = null;            // landmark name being labelled
let shots = [];               // the loaded JPEGs, in filename order
let at = 0;                   // index into shots
let bitmap = null;            // decoded frame on screen; owned here, closed on step
let autoTracks = null;        // id -> [{ t, u, v, w, h, pose }] from autoCollect
let autoVerdict = new Map();  // id -> { ok, P } so the overlay can show both
let framePose = [];           // frame index -> tag-solved camera pose, or null
let landmarkMap = [];           // qualified landmarks + descriptors, from this session
let loadedMap = null;         // a landmark map from a *different* session, for M6

function status(msg) {
  els.status.textContent = msg;
}

// Intrinsics for a frame size, scaling from the nearest fitted one when there is
// no exact match. WebRTC drops resolution under congestion, so the host does not
// get to assume the size it calibrated at — this is the same linear rescale
// intrinsicsFor() applies in cv-common.js (fx/fy/cx/cy scale with pixel pitch).
// Only valid within one orientation; a rotation would swap the axes, and nothing
// here ever sees a landscape frame.
function intrinsicsAt(w, h) {
  const exact = intrinsics.get(`${w}x${h}`);
  if (exact) return exact;
  let best = null;
  for (const K of intrinsics.values()) {
    if ((K.h > K.w) !== (h > w)) continue;
    if (!best || Math.abs(K.w - w) < Math.abs(best.w - w)) best = K;
  }
  if (!best) return null;
  const s = w / best.w;
  return {
    fx: best.fx * s, fy: best.fy * s, cx: best.cx * s, cy: best.cy * s,
    w, h, dist: best.dist, residual: best.residual, scaledFrom: `${best.w}x${best.h}`,
  };
}

// ---------------------------------------------------------------------------
// Intrinsics, recovered from the journal.

function fitIntrinsics(text) {
  const lines = text.trim().split('\n');
  const meta = JSON.parse(lines[0]);
  if (meta.kind !== 'meta') throw new Error('first line is not a meta record');
  markerSizeM = meta.markerSizeM;
  const s = markerSizeM / 2;
  // ArUco corner order TL,TR,BR,BL; marker frame x right, y up, z out — the
  // same object points detect-core.js builds.
  const obj = [[-s, s, 0], [s, s, 0], [s, -s, 0], [-s, -s, 0]];

  const acc = new Map();
  const rows = [];
  for (const line of lines.slice(1)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.msg;
    if (!m?.tags?.length || !m.w || !m.h) continue;
    const key = `${m.w}x${m.h}`;
    if (!acc.has(key)) acc.set(key, { u: [0, 0, 0, 0, 0], v: [0, 0, 0, 0, 0], n: 0 });
    const a = acc.get(key);
    for (const t of m.tags) {
      if (t.corners?.length !== 8 || !t.rvec || !t.tvec) continue;
      const q = quatFromRvec(t.rvec);
      for (let i = 0; i < 4; i++) {
        const c = quatRotate(q, obj[i]);
        const Z = c[2] + t.tvec[2];
        if (!(Z > 1e-6)) continue;
        const x = (c[0] + t.tvec[0]) / Z;
        const y = (c[1] + t.tvec[1]) / Z;
        const u = t.corners[i * 2];
        const v = t.corners[i * 2 + 1];
        a.u[0] += x * x; a.u[1] += x; a.u[2] += 1; a.u[3] += x * u; a.u[4] += u;
        a.v[0] += y * y; a.v[1] += y; a.v[2] += 1; a.v[3] += y * v; a.v[4] += v;
        a.n++;
        rows.push({ key, x, y, u, v });
      }
    }
  }

  const lsq = ([Sxx, Sx, Sn, Sxu, Su]) => {
    const det = Sxx * Sn - Sx * Sx;
    if (Math.abs(det) < 1e-12) return null;
    return { f: (Sxu * Sn - Sx * Su) / det, c: (Sxx * Su - Sx * Sxu) / det };
  };

  const report = [];
  intrinsics = new Map();
  for (const [key, a] of acc) {
    const fu = lsq(a.u);
    const fv = lsq(a.v);
    if (!fu || !fv) continue;
    const [w, h] = key.split('x').map(Number);
    // Distortion is ignored on purpose: at the residual this fit achieves it is
    // below the corner noise, and carrying k1..k3 through would imply a
    // precision the labels (a human clicking a pixel) do not have.
    const K = { fx: fu.f, fy: fv.f, cx: fu.c, cy: fv.c, w, h, dist: [0, 0, 0, 0, 0] };
    let sum = 0;
    let n = 0;
    for (const r of rows) {
      if (r.key !== key) continue;
      sum += Math.hypot(K.fx * r.x + K.cx - r.u, K.fy * r.y + K.cy - r.v);
      n++;
    }
    K.residual = sum / n;
    intrinsics.set(key, K);
    report.push(`${key}  fx ${K.fx.toFixed(1)} fy ${K.fy.toFixed(1)} `
      + `cx ${K.cx.toFixed(1)} cy ${K.cy.toFixed(1)}  residual ${K.residual.toFixed(3)} px (${n})`);
  }
  if (!intrinsics.size) throw new Error('no usable tag sightings in the journal');
  return `markerSizeM ${markerSizeM}\n${report.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Camera pose for the frame on screen, solved from the tags in it.

// survey.js's fuseCameraPose lives inside createSurvey's closure and the server
// module cannot be loaded here, so the weighting is restated rather than shared.
// It must stay identical to survey.js: sin^2 of the viewing angle over distance
// to the fourth, times the reprojection-error proxy.
function fuseTags(tags) {
  const obs = [];
  for (const t of tags) {
    const m = markers.get(t.id);
    if (!m) continue;
    const dist = Math.hypot(t.tvec[0], t.tvec[1], t.tvec[2]);
    const n = quatRotate(quatFromRvec(t.rvec), [0, 0, 1]);
    const cos = dist > 1e-6
      ? Math.abs(n[0] * t.tvec[0] + n[1] * t.tvec[1] + n[2] * t.tvec[2]) / dist : 1;
    if (t.err > OBS_MAX_ERR_PX || dist > OBS_MAX_DIST_M || cos < OBS_MIN_COS_ANGLE) continue;
    obs.push({
      pose: se3Compose(m, se3Invert(se3FromRvecTvec(t.rvec, t.tvec))),
      w: Math.max(SIN2_FLOOR, 1 - cos * cos) / (Math.max(dist ** 4, 1) * (0.5 + t.err) ** 2),
      id: t.id, dist, err: t.err,
    });
  }
  if (!obs.length) return null;
  const wsum = obs.reduce((a, o) => a + o.w, 0);
  const p = [0, 0, 0];
  for (const o of obs) for (let k = 0; k < 3; k++) p[k] += o.pose.p[k] * (o.w / wsum);
  return { pose: { p, q: quatMean(obs.map((o) => o.pose.q), obs.map((o) => o.w)) }, used: obs };
}

async function solveFrame() {
  if (!bitmap) return;
  const w = bitmap.width;
  const h = bitmap.height;
  if (!w || !h) return;
  els.view.width = w;
  els.view.height = h;
  ctx.drawImage(bitmap, 0, 0);

  frame = { w, h, pose: null, tags: [] };
  const K = intrinsicsAt(w, h);
  if (!K) {
    status(`no intrinsics for ${w}x${h} — the journal has no sightings at this size`);
    draw();
    return;
  }
  // A least-squares fit from the journal's own corners at exactly this size —
  // neither a stored calibration nor a guess, so it gets its own provenance
  // rather than borrowing a tier it did not come from.
  if (!core.hasIntrinsics(w, h)) {
    core.setIntrinsics(w, h, { ...K, calibrated: true, source: 'fit', scale: 1, from: null });
  }
  // Every seek is a jump, so the region-of-interest crop from the previous
  // frame describes a picture that is no longer on screen.
  core.resetScan();
  const res = await core.detect(lumaSource, bitmap, w, h, performance.now());
  if (res) {
    frame.tags = res.tags;
    const fused = fuseTags(res.tags);
    if (fused) frame.pose = fused.pose;
    const seen = res.tags.map((t) => `${t.id}@${Math.hypot(...t.tvec).toFixed(1)}m`).join(' ');
    status(frame.pose
      ? `${w}x${h} · pose ${frame.pose.p.map((x) => x.toFixed(2)).join(', ')} · tags ${seen}`
      : `${w}x${h} · NO POSE — tags seen: ${seen || 'none'} (frame unusable)`);
  }
  draw();
}

function draw() {
  if (!frame || !bitmap) return;
  ctx.drawImage(bitmap, 0, 0);
  ctx.lineWidth = Math.max(2, frame.w / 600);
  ctx.font = `${Math.max(14, frame.w / 60)}px system-ui`;

  for (const t of frame.tags) {
    ctx.strokeStyle = '#39d98a';
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const x = t.corners[i * 2];
      const y = t.corners[i * 2 + 1];
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#39d98a';
    ctx.fillText(String(t.id), t.corners[0], t.corners[1] - 6);
  }

  // Auto-collected tracks, so the qualification can be watched rather than
  // taken on trust: green survived the split-arc test, red was thrown out.
  if (autoTracks) {
    const r = ctx.lineWidth * 2.5;
    for (const [id, obs] of autoTracks) {
      const here = obs.find((o) => o.t === at);
      if (!here) continue;
      const v = autoVerdict.get(id);
      ctx.strokeStyle = !v ? 'rgba(150,150,150,0.35)' : v.ok ? '#39d98a' : 'rgba(226,80,80,0.55)';
      ctx.lineWidth = v?.ok ? ctx.lineWidth : Math.max(1, ctx.lineWidth / 2);
      ctx.beginPath();
      ctx.arc(here.u, here.v, v?.ok ? r * 1.6 : r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = Math.max(2, frame.w / 600);
  }

  for (const [name, obs] of labels) {
    const here = obs.find((o) => o.t === at);
    if (!here) continue;
    ctx.strokeStyle = name === active ? '#ffd166' : '#7aa7d9';
    ctx.beginPath();
    ctx.arc(here.u, here.v, ctx.lineWidth * 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(name, here.u + ctx.lineWidth * 6, here.v);
  }
}

// ---------------------------------------------------------------------------
// Labelling.

els.view.addEventListener('click', (ev) => {
  if (!active) { status('add and select a landmark first'); return; }
  if (!frame?.pose) { status('this frame has no camera pose — nothing to label it against'); return; }
  const r = els.view.getBoundingClientRect();
  const u = (ev.clientX - r.left) * (els.view.width / r.width);
  const v = (ev.clientY - r.top) * (els.view.height / r.height);
  const list = labels.get(active);
  const i = list.findIndex((o) => o.t === at);
  const entry = {
    t: at, u, v, w: frame.w, h: frame.h, K: intrinsicsAt(frame.w, frame.h), pose: frame.pose,
  };
  if (i >= 0) list[i] = entry; else list.push(entry);
  renderLandmarks();
  draw();
  if (els.autoStep.checked) stepBy(Number(els.step.value));
});

function renderLandmarks() {
  els.lmList.innerHTML = '';
  for (const [name, obs] of labels) {
    const row = document.createElement('div');
    row.className = 'lm';
    const pick = document.createElement('button');
    pick.textContent = name;
    pick.className = name === active ? 'on' : '';
    pick.onclick = () => { active = name; renderLandmarks(); draw(); };
    const count = document.createElement('span');
    count.className = 'muted';
    count.textContent = `${obs.length} obs`;
    const del = document.createElement('button');
    del.textContent = '×';
    del.onclick = () => {
      labels.delete(name);
      if (active === name) active = labels.keys().next().value ?? null;
      renderLandmarks();
      draw();
    };
    row.append(pick, count, del);
    els.lmList.append(row);
  }
}

// ---------------------------------------------------------------------------
// Geometry.
//
// triangulate / splitArc / unwrapAzimuths / rms / reproject / azimuthOf /
// dist3 / qualifyTrack all live in landmark-math.js now: the server's landmark
// map runs the identical functions, so what this page measures and what the
// product then does cannot drift apart. Each observation carries its own `K`
// rather than looking one up by frame size, because on the server the camera
// model arrives per message.

// M2: how much the estimate moves when any single sighting is removed.
function leaveOneOut(obs, P) {
  if (obs.length < 4) return NaN;
  const pts = [];
  for (let i = 0; i < obs.length; i++) {
    const q = triangulate(obs.filter((_, k) => k !== i));
    if (q) pts.push(q);
  }
  if (!pts.length) return NaN;
  const m = [0, 1, 2].map((k) => pts.reduce((a, p) => a + p[k], 0) / pts.length);
  return Math.sqrt(pts.reduce((a, p) => a + dist3(p, m) ** 2, 0) / pts.length) * 1000;
}

function compute() {
  const out = [];
  for (const [name, obs] of labels) {
    out.push(`── ${name}  (${obs.length} observations)`);
    if (obs.length < 4) { out.push('   need at least 4 to say anything\n'); continue; }
    const P = triangulate(obs);
    if (!P) { out.push('   degenerate — all rays parallel\n'); continue; }
    const rng = obs.map((o) => dist3(P, o.pose.p));
    const sa = splitArc(obs, P);
    out.push(`   position   ${P.map((v) => v.toFixed(3)).join(', ')} m`);
    out.push(`   range      ${Math.min(...rng).toFixed(2)} – ${Math.max(...rng).toFixed(2)} m`);
    out.push(`   arc span   ${sa.span.toFixed(1)}°`);
    // Not a tight threshold: a hand-clicked label on a small feature costs
    // several px on its own, and that is noise the arc averages away — measured,
    // a clock hub sat at 7.03 px and still converged to an 8 mm split-arc gap.
    // What RMS rules out is the case where *no* 3D point fits the labels at all,
    // which is a pendant lamp at 27.9 px.
    out.push(`   M1 rms     ${rms(P, obs).toFixed(2)} px          (< 10; label noise, not the verdict)`);
    // Precision, not accuracy — a consistent bias is consistently reproduced, so
    // this passes things it should not. A lamp scored 14 mm here.
    out.push(`   M2 L1O     ${leaveOneOut(obs, P).toFixed(0)} mm          (precision only — never read alone)`);
    out.push('   split-arc disagreement — the qualification signal:');
    if (!sa.rows.length) out.push('     (need ≥4 observations inside a window)');
    for (const r of sa.rows) {
      out.push(`     ${String(r.width).padStart(4)}°  n=${String(r.n).padStart(3)}  ${r.gap.toFixed(0).padStart(5)} mm`);
    }
    // Read the trend, not any single row. A narrow window holds few sightings,
    // so label noise dominates it and even a genuine point looks bad there;
    // widening the arc averages that away, while a viewpoint-correlated bias
    // survives untouched. Verified against synthetic ground truth: a real
    // corner under 1.5 px of noise falls 62.9 -> 1.8 mm across the arc, an
    // asymmetric object only 63.4 -> 33.1 mm.
    if (sa.rows.length >= 2) {
      const first = sa.rows[0];
      const last = sa.rows[sa.rows.length - 1];
      const collapsed = last.gap < first.gap / 5;
      out.push(`   trend      ${first.gap.toFixed(0)} mm @${first.width}° → `
        + `${last.gap.toFixed(0)} mm @${last.width}°`);
      // Reprojection is the one signal that does not need a wide arc. If no
      // single 3D point can explain the labels, the bearings simply do not
      // intersect, and that shows up immediately — measured on real footage at
      // 16° of arc: a clock face sat at 3.8 px while a pendant lamp sat at 27.9.
      // Reporting only "arc too narrow" there throws away a decided answer.
      const err = rms(P, obs);
      out.push(`   verdict    ${err > 10
        ? `FAILS ON REPROJECTION (${err.toFixed(1)} px) — no single 3D point fits `
          + 'these labels, so the arc no longer matters'
        : last.width < 60
          ? 'ARC TOO NARROW — walk a wider orbit, under 60° cannot tell noise from bias'
          : collapsed
            ? 'looks like a fixed 3D point (gap collapsed as the arc widened)'
            : 'DOES NOT QUALIFY — gap persists across the arc, i.e. viewpoint-correlated'}`);
    }
    out.push('');
  }
  if (!out.length) out.push('no landmarks labelled');
  out.push('A fixed physical point\'s split-arc gap collapses as the arc widens —');
  out.push('noise averages out. A viewpoint-correlated bias does not. Read the');
  out.push('trend across arc widths, never a single row: the narrow windows are');
  out.push('noise-dominated for everything. 60° is the floor for a usable call.');
  els.out.textContent = out.join('\n');
}

// ---------------------------------------------------------------------------
// Automatic landmark collection.
//
// This is the point of the whole exercise: hand-labelling was only ever
// scaffolding to find out whether a landmark's landmark point is a fixed 3D point
// before committing to a detector. It is, so the clicking can go.
//
// Note what this deliberately does NOT do: detect objects. M1 showed the failure
// was never the object class — it was labelling a silhouette *centre*, which
// moves with viewpoint, instead of a real image feature, which does not. A
// corner tracker only ever produces real features, so the whole
// clock-vs-lamp-vs-picture taxonomy dissolves. Anything it picks up that is not
// a fixed point is thrown out by the same split-arc test the manual path uses.
//
// Every function here is already bound in the vendored opencv.js 4.9.0 — no new
// dependency, no model, no download. Checked rather than assumed, because this
// build silently lacks solvePnPGeneric and cornerSubPix.

// The tracker itself is createFeatureTracker in detect-core.js — the same one
// the client runs, so what qualifies here is what would qualify in the room.
// It works on a downscaled frame where this page used to track at full
// resolution; that is the measured operating point, not a saving.
//
// Descriptors for re-identification. cv.KeyPoint is not constructible in this
// build, so a descriptor cannot be computed at an arbitrary point — ORB has to
// pick its own keypoints and each track then adopts the nearest one. That is
// also the honest arrangement: at relocalization time ORB will again pick its
// own keypoints, so a landmark described at a location ORB does not naturally
// choose could never be matched.
const ORB_FEATURES = 1200;
const ORB_ASSOC_PX = 4;
const DESC_PER_ANCHOR = 12;    // kept per landmark, spread across the arc
const MATCH_RATIO = 0.75;      // Lowe ratio
const RELOC_MIN_MATCHES = 6;

async function autoCollect() {
  if (!shots.length || !core?.ready) { status('load frames first'); return; }
  const cv = core.cv;
  const minObs = Math.max(4, Number(els.minObs.value) || 12);
  const minArc = Math.max(10, Number(els.minArc.value) || 60);

  const tracks = new Map();     // id -> [{ t, u, v, w, h, K, pose }]
  framePose = new Array(shots.length).fill(null);
  autoVerdict = new Map();
  let live = [];                // [{ id, u, v }] in full-frame pixels
  let posed = 0;

  // Its own luma source, at the tracker's own width — see createFeatureTracker
  // for why it cannot share the detector's.
  const tracker = createFeatureTracker(cv,
    createCanvasLumaSource(cv, { maxWidth: TRACK_WIDTH }));
  const orb = new cv.ORB(ORB_FEATURES);
  const descs = new Map();      // track id -> [Uint8Array(32), ...]

  for (let i = 0; i < shots.length; i++) {
    const bm = await createImageBitmap(shots[i]);
    const w = bm.width;
    const h = bm.height;
    const K = intrinsicsAt(w, h);
    if (!K) { bm.close(); continue; }
    if (!core.hasIntrinsics(w, h)) core.setIntrinsics(w, h, { ...K, calibrated: true });

    // Tags first: the tracker masks them out, so it needs this frame's boxes.
    core.resetScan();
    const det = await core.detect(lumaSource, bm, w, h, performance.now());
    const tags = det?.tags ?? [];
    const fused = fuseTags(tags);
    const pose = fused ? fused.pose : null;
    if (pose) posed++;
    framePose[i] = pose;

    // Every seek is a jump on this page, but auto-collect walks the frames in
    // order, so the tracker is followed rather than reset — that is the whole
    // source of correspondence.
    const tracked = await tracker.track(bm, det?.boxes ?? []);
    live = tracked ? tracked.points : [];

    // Record a sighting for every live track that has a camera pose to pin it
    // to. Tracks keep running through unposed frames — losing the pose loses
    // the observation, not the track.
    if (pose) {
      for (const p of live) {
        if (!tracks.has(p.id)) tracks.set(p.id, []);
        tracks.get(p.id).push({ t: i, u: p.u, v: p.v, w, h, K, pose });
      }
    }

    // Describe: let ORB find its own keypoints, then hand each live track the
    // descriptor of the keypoint sitting on it. Only where there is a pose —
    // an undescribed sighting is no loss, but a described one that cannot be
    // triangulated is a descriptor with no 3D point behind it. This runs on the
    // full-resolution luma because the tracked points are in full-frame pixels.
    if (pose && live.length) {
      const grabbed = await lumaSource.luma(bm, null);
      const kp = new cv.KeyPointVector();
      const dsc = new cv.Mat();
      orb.detectAndCompute(grabbed.mat, new cv.Mat(), kp, dsc);
      if (dsc.rows) {
        for (const p of live) {
          const have = descs.get(p.id);
          if (have && have.length >= DESC_PER_ANCHOR) continue;
          let best = -1;
          let bestD = ORB_ASSOC_PX;
          for (let k = 0; k < kp.size(); k++) {
            const pt = kp.get(k).pt;
            const d = Math.hypot(pt.x - p.u, pt.y - p.v);
            if (d < bestD) { bestD = d; best = k; }
          }
          if (best < 0) continue;
          const row = new Uint8Array(32);
          for (let b = 0; b < 32; b++) row[b] = dsc.data[best * dsc.cols + b];
          if (!have) descs.set(p.id, [row]); else have.push(row);
        }
      }
      kp.delete();
      dsc.delete();
    }
    bm.close();

    if (i % 5 === 0) {
      status(`auto-collect ${i + 1}/${shots.length} · ${live.length} live tracks · `
        + `${tracks.size} seen · ${posed} posed frames`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  tracker.dispose();

  // ---- qualify ------------------------------------------------------------
  const judged = [];
  let tooFew = 0;
  let tooNarrow = 0;
  for (const [id, obs] of tracks) {
    const j = qualifyTrack(obs, { minObs, minArcDeg: minArc });
    if (j.reason === 'few-obs' || j.reason === 'no-triangulation') { tooFew++; continue; }
    if (j.reason === 'narrow-arc' || j.reason === 'no-windows') { tooNarrow++; continue; }
    judged.push({
      ...j,
      id,
      range: dist3(j.P, obs[0].pose.p),
    });
  }

  // Several tracks often sit on one physical feature, so a raw count overstates
  // how many landmarks the room actually gained.
  const good = judged.filter((j) => j.ok).sort((a, b) => a.last - b.last);
  const clusters = clusterLandmarks(good);

  orb.delete();
  autoTracks = tracks;
  for (const j of judged) autoVerdict.set(j.id, { ok: j.ok, P: j.P });
  // The saveable map: a qualified 3D point plus the descriptors that were seen
  // sitting on it. Landmarks with no descriptor are useless for relocalization
  // however good their geometry — they can never be found again.
  landmarkMap = good
    .filter((j) => descs.get(j.id)?.length)
    .map((j) => ({ P: j.P, n: j.n, span: j.span, desc: descs.get(j.id).map((d) => [...d]) }));
  // Exposed so a scripted run can hand the map straight to a second session
  // without a download-and-repick round trip. Diagnostics only.
  self.__landmarkMap = landmarkMap;
  draw();

  const out = [];
  out.push(`frames ${shots.length} · ${posed} with a camera pose`);
  out.push(`tracks started        ${tracks.size}`);
  out.push(`  too few sightings   ${tooFew}   (< ${minObs})`);
  out.push(`  arc too narrow      ${tooNarrow}   (< ${minArc}°)`);
  out.push(`  judgeable           ${judged.length}`);
  out.push(`  QUALIFIED           ${good.length}`);
  out.push(`  distinct landmarks  ${clusters.length}   (within ${CLUSTER_M * 1000} mm merged)`);
  out.push('');
  if (!judged.length) {
    out.push('Nothing was judgeable. Either too few frames carried a camera pose,');
    out.push('or the walk did not swing far enough around anything.');
  } else {
    out.push('top landmarks by split-arc agreement:');
    out.push('   n   arc    rng     rms      narrow -> widest        position');
    for (const j of clusters.slice(0, 15)) {
      const b = j[0];
      out.push(`  ${String(b.n).padStart(3)}  ${b.span.toFixed(0).padStart(3)}°  `
        + `${b.range.toFixed(1)}m  ${b.err.toFixed(1).padStart(5)}px  `
        + `${b.first.toFixed(0).padStart(5)} -> ${b.last.toFixed(0).padStart(4)} mm   `
        + `${b.P.map((v) => v.toFixed(2)).join(', ')}`
        + (j.length > 1 ? `  (x${j.length})` : ''));
    }
    const rejected = judged.filter((j) => !j.ok);
    if (rejected.length) {
      out.push('');
      out.push(`rejected ${rejected.length} judgeable track(s) — these are the ones the`);
      out.push('split-arc test exists to remove. Worst offenders:');
      for (const j of rejected.sort((a, b) => b.last - a.last).slice(0, 5)) {
        out.push(`  ${String(j.n).padStart(3)}  ${j.span.toFixed(0).padStart(3)}°  `
          + `${j.err.toFixed(1).padStart(5)}px  ${j.first.toFixed(0)} -> ${j.last.toFixed(0)} mm`);
      }
    }
  }
  els.out.textContent = out.join('\n');
  status(`auto-collect done · ${clusters.length} distinct landmarks from ${tracks.size} tracks`);
}

// ---------------------------------------------------------------------------
// M6: re-identification. Everything up to here rides on LK, which hands over
// correspondence for free as long as the feature never leaves the frame. That
// says nothing about walking back in tomorrow. Here the landmarks come from a
// *different session* and the only link is the descriptor: ORB picks its own
// keypoints in the new frames, matches them against the stored map, and
// solvePnPRansac has to recover a pose from whatever survives.
//
// The tag-solved pose of the new session is the reference. Tags take no part in
// the solve — they only say where the camera actually was.

async function relocalizeM6() {
  if (!loadedMap?.length) { status('load a landmark map first'); return; }
  if (!shots.length || !core?.ready) { status('load frames first'); return; }
  const cv = core.cv;

  // One train matrix of every stored descriptor, plus a row -> landmark index map.
  const rows = [];
  const owner = [];
  loadedMap.forEach((a, ai) => {
    for (const d of a.desc) { rows.push(d); owner.push(ai); }
  });
  const train = cv.matFromArray(rows.length, 32, cv.CV_8U, rows.flat());
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const orb = new cv.ORB(ORB_FEATURES);

  const res = [];
  let posed = 0;
  for (let i = 0; i < shots.length; i++) {
    const bm = await createImageBitmap(shots[i]);
    const w = bm.width;
    const h = bm.height;
    const K = intrinsicsAt(w, h);
    if (!K) { bm.close(); continue; }
    if (!core.hasIntrinsics(w, h)) core.setIntrinsics(w, h, { ...K, calibrated: true });

    // Reference pose from tags — measured against, never fed into the solve.
    core.resetScan();
    const det = await core.detect(lumaSource, bm, w, h, performance.now());
    const truth = fuseTags(det?.tags ?? [])?.pose ?? null;
    const grabbed = await lumaSource.luma(bm, null);
    const gray = grabbed.mat.clone();
    bm.close();
    if (!truth) { gray.delete(); continue; }
    posed++;

    const kp = new cv.KeyPointVector();
    const dsc = new cv.Mat();
    orb.detectAndCompute(gray, new cv.Mat(), kp, dsc);
    const pairs = new Map();   // landmark index -> best 2D point for it
    if (dsc.rows) {
      const mv = new cv.DMatchVectorVector();
      matcher.knnMatch(dsc, train, mv, 2);
      for (let m = 0; m < mv.size(); m++) {
        const pair = mv.get(m);
        if (pair.size() < 2) { pair.delete(); continue; }
        const a = pair.get(0);
        const b = pair.get(1);
        // Lowe's ratio against the *second* neighbour. Several descriptors can
        // belong to one landmark, so a tie between two views of the same landmark
        // is not ambiguity — compare only across different landmarks.
        if (owner[a.trainIdx] !== owner[b.trainIdx] && a.distance < MATCH_RATIO * b.distance) {
          const ai = owner[a.trainIdx];
          const prev = pairs.get(ai);
          if (!prev || a.distance < prev.d) {
            const pt = kp.get(a.queryIdx).pt;
            pairs.set(ai, { u: pt.x, v: pt.y, d: a.distance });
          }
        }
        pair.delete();
      }
      mv.delete();
    }
    kp.delete();
    dsc.delete();
    gray.delete();

    // How many landmarks were geometrically in shot at all, from the tag pose.
    // Without this a low match rate is unreadable: a landmark that was never in
    // frame cannot be matched, and a map built on one object is out of view for
    // most of a walk through the flat. This is the ceiling the matcher is
    // actually competing against.
    let visible = 0;
    for (const a of loadedMap) {
      const c = transformPoint(se3Invert(truth), a.P);
      if (!(c[2] > 0.1)) continue;
      const u = K.fx * c[0] / c[2] + K.cx;
      const v = K.fy * c[1] / c[2] + K.cy;
      if (u >= 0 && v >= 0 && u < w && v < h) visible++;
    }
    const entry = { i, matches: pairs.size, visible, solved: false };
    if (pairs.size >= RELOC_MIN_MATCHES) {
      const objs = [];
      const imgs = [];
      for (const [ai, p] of pairs) {
        objs.push(loadedMap[ai].P);
        imgs.push([p.u, p.v]);
      }
      const objMat = cv.matFromArray(objs.length, 3, cv.CV_32F, objs.flat());
      const imgMat = cv.matFromArray(imgs.length, 2, cv.CV_32F, imgs.flat());
      const KM = cv.matFromArray(3, 3, cv.CV_64F, [K.fx, 0, K.cx, 0, K.fy, K.cy, 0, 0, 1]);
      const D = cv.matFromArray(1, 5, cv.CV_64F, [0, 0, 0, 0, 0]);
      const rvec = new cv.Mat();
      const tvec = new cv.Mat();
      const inl = new cv.Mat();
      let ok = false;
      try {
        ok = cv.solvePnPRansac(objMat, imgMat, KM, D, rvec, tvec, false, 500, 5.0, 0.99, inl, cv.SOLVEPNP_ITERATIVE);
      } catch { ok = false; }
      if (ok) {
        const cam = se3Invert(se3FromRvecTvec([...rvec.data64F], [...tvec.data64F]));
        entry.solved = true;
        entry.inliers = inl.rows;
        entry.dp = dist3(cam.p, truth.p) * 1000;
        entry.dq = quatAngleDeg(cam.q, truth.q);
      }
      objMat.delete(); imgMat.delete(); KM.delete(); D.delete();
      rvec.delete(); tvec.delete(); inl.delete();
    }
    res.push(entry);

    if (i % 5 === 0) {
      status(`M6 relocalize ${i + 1}/${shots.length} · ${res.filter((r) => r.solved).length} solved`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  train.delete();
  matcher.delete();
  orb.delete();

  const solved = res.filter((r) => r.solved);
  const good = solved.filter((r) => r.dp < 300);
  const pcs = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)];
  const out = [];
  out.push('M6 — re-identification across sessions');
  out.push('   landmarks come from a different recording; the only link is the ORB');
  out.push('   descriptor. Tags supply the reference pose only, never the solve.');
  out.push('');
  const couldSee = res.filter((r) => r.visible >= RELOC_MIN_MATCHES);
  out.push(`landmarks in map     ${loadedMap.length}  (${rows.length} descriptors)`);
  out.push(`frames with a tag pose  ${posed}`);
  out.push(`  of those, frames where ≥${RELOC_MIN_MATCHES} landmarks were actually in shot: `
    + `${couldSee.length}   <- the ceiling`);
  out.push(`frames with ≥${RELOC_MIN_MATCHES} matches   ${res.filter((r) => r.matches >= RELOC_MIN_MATCHES).length}`);
  out.push(`RANSAC returned a pose  ${solved.length}`);
  out.push(`  of those, within 300 mm  ${good.length}`);
  out.push('');
  if (couldSee.length) {
    const hit = couldSee.filter((r) => r.matches >= RELOC_MIN_MATCHES).length;
    const med = couldSee.map((r) => r.matches).sort((a, b) => a - b)[Math.floor(couldSee.length / 2)];
    out.push(`among frames that COULD have matched: ${hit}/${couldSee.length} did `
      + `(${(100 * hit / couldSee.length).toFixed(0)}%), median ${med} matches against `
      + `a median ${couldSee.map((r) => r.visible).sort((a, b) => a - b)[Math.floor(couldSee.length / 2)]} visible`);
    out.push('');
  }
  if (solved.length) {
    const dp = solved.map((r) => r.dp);
    out.push(`position error   median ${pcs(dp, 0.5).toFixed(0)} mm · p90 ${pcs(dp, 0.9).toFixed(0)} mm`);
    out.push(`matched landmarks  median ${pcs(solved.map((r) => r.matches), 0.5)} per frame`);
    if (good.length) {
      const g = good.map((r) => r.dp);
      out.push(`among the ${good.length} plausible fixes: median ${pcs(g, 0.5).toFixed(0)} mm · `
        + `median ${pcs(good.map((r) => r.dq), 0.5).toFixed(2)}°`);
    }
  }
  out.push('');
  out.push(`match rate: ${(100 * res.filter((r) => r.matches >= RELOC_MIN_MATCHES).length / Math.max(1, posed)).toFixed(0)}% of posed frames`);
  out.push(`success rate: ${(100 * good.length / Math.max(1, posed)).toFixed(0)}% of posed frames got a usable fix`);
  els.out.textContent = out.join('\n');
  status(`M6 done · ${good.length}/${posed} usable fixes`);
}

// ---------------------------------------------------------------------------
// M3: can a camera localize on the collected landmarks with the tags withheld?
//
// The holdout has to be real. Landmarks are triangulated *from* tag-solved camera
// poses, so building and testing on the same frames asks whether the landmarks
// agree with the poses that created them — which they trivially do. Landmarks are
// therefore built from even frames only and tested on odd ones.
//
// Withholding tags does not mean withholding the tag *pose*: that is the
// reference being measured against. It means no tag contributes to the solve.

function holdoutM3() {
  if (!autoTracks?.size) { status('run auto-collect first'); return; }
  const cv = core.cv;
  const minObs = Math.max(4, Number(els.minObs.value) || 12);
  const minArc = Math.max(10, Number(els.minArc.value) || 60);

  // ---- build landmarks from even frames only --------------------------------
  const landmarks = new Map();
  for (const [id, obs] of autoTracks) {
    const build = obs.filter((o) => o.t % 2 === 0);
    const j = qualifyTrack(build, { minObs, minArcDeg: minArc });
    if (j.ok) landmarks.set(id, j.P);
  }

  // ---- localize each odd frame from those landmarks alone -------------------
  const rows = [];
  let attempted = 0;
  for (let i = 1; i < shots.length; i += 2) {
    const truth = framePose[i];
    if (!truth) continue;
    const objs = [];
    const imgs = [];
    let K = null;
    for (const [id, P] of landmarks) {
      const o = autoTracks.get(id).find((x) => x.t === i);
      if (!o) continue;
      K ??= o.K;
      objs.push(P);
      imgs.push([o.u, o.v]);
    }
    attempted++;
    if (objs.length < 4 || !K) { rows.push({ n: objs.length, solved: false }); continue; }

    const objMat = cv.matFromArray(objs.length, 3, cv.CV_32F, objs.flat());
    const imgMat = cv.matFromArray(imgs.length, 2, cv.CV_32F, imgs.flat());
    const KM = cv.matFromArray(3, 3, cv.CV_64F, [K.fx, 0, K.cx, 0, K.fy, K.cy, 0, 0, 1]);
    const D = cv.matFromArray(1, 5, cv.CV_64F, [0, 0, 0, 0, 0]);
    const rvec = new cv.Mat();
    const tvec = new cv.Mat();
    const inliers = new cv.Mat();
    let ok = false;
    try {
      ok = cv.solvePnPRansac(objMat, imgMat, KM, D, rvec, tvec, false, 200, 4.0, 0.99, inliers, cv.SOLVEPNP_ITERATIVE);
    } catch {
      ok = false;
    }
    if (ok) {
      // solvePnP returns room -> camera; the camera's own room pose is the
      // inverse, which is what the tag path reports.
      const cam = se3Invert(se3FromRvecTvec([...rvec.data64F], [...tvec.data64F]));
      rows.push({
        n: objs.length,
        inl: inliers.rows,
        solved: true,
        dp: dist3(cam.p, truth.p) * 1000,
        dq: quatAngleDeg(cam.q, truth.q),
      });
    } else {
      rows.push({ n: objs.length, solved: false });
    }
    objMat.delete(); imgMat.delete(); KM.delete(); D.delete();
    rvec.delete(); tvec.delete(); inliers.delete();
  }

  // ---- report -------------------------------------------------------------
  const solved = rows.filter((r) => r.solved);
  const out = [];
  out.push(`M3 — localization with tags withheld (holdout: landmarks from even frames,`);
  out.push(`     tested on odd frames, so no landmark was built from the frame it is tested on)`);
  out.push('');
  out.push(`landmarks built     ${landmarks.size}`);
  out.push(`test frames       ${attempted}`);
  out.push(`solved            ${solved.length}   (needs ≥4 landmarks in view)`);
  if (!solved.length) {
    out.push('');
    out.push('Nothing solved. Either too few landmarks survive on even frames alone,');
    out.push('or they are never 4-at-a-time in one odd frame.');
    els.out.textContent = out.join('\n');
    return;
  }
  const pcs = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)];
  const dp = solved.map((r) => r.dp);
  const dq = solved.map((r) => r.dq);
  out.push('');
  out.push(`position error    median ${pcs(dp, 0.5).toFixed(0)} mm · p90 ${pcs(dp, 0.9).toFixed(0)} mm · worst ${Math.max(...dp).toFixed(0)} mm`);
  out.push(`orientation error median ${pcs(dq, 0.5).toFixed(2)}° · p90 ${pcs(dq, 0.9).toFixed(2)}° · worst ${Math.max(...dq).toFixed(2)}°`);
  out.push(`                  (reference: < 150 mm, < 3°)`);

  // The curve, not the verdict: how good the fix is given how much it had.
  out.push('');
  out.push('as a function of how many landmarks were in view:');
  out.push('  landmarks   n    median mm   median °');
  const buckets = [[4, 5], [6, 8], [9, 14], [15, 24], [25, 1e9]];
  for (const [lo, hi] of buckets) {
    const g = solved.filter((r) => r.n >= lo && r.n <= hi);
    if (!g.length) continue;
    const label = hi > 1e8 ? `${lo}+` : `${lo}-${hi}`;
    out.push(`  ${label.padStart(7)}  ${String(g.length).padStart(3)}   `
      + `${pcs(g.map((r) => r.dp), 0.5).toFixed(0).padStart(9)}   `
      + `${pcs(g.map((r) => r.dq), 0.5).toFixed(2).padStart(8)}`);
  }
  const gross = solved.filter((r) => r.dp > 1000).length;
  out.push('');
  out.push(`gross failures (> 1 m): ${gross} of ${solved.length}`);
  els.out.textContent = out.join('\n');
  status(`M3 done · median ${pcs(dp, 0.5).toFixed(0)} mm from ${landmarks.size} landmarks`);
}

// ---------------------------------------------------------------------------
// Frame stepping. Decoding is one createImageBitmap per step — no demuxer, no
// seek, no duration, none of the things that made the video path fail.

let stepping = null;

async function goTo(i) {
  if (!shots.length) return;
  const want = Math.max(0, Math.min(shots.length - 1, i));
  // A held key can outrun the decode; serialise so frames cannot land in the
  // wrong order and leave the canvas showing one frame and `at` naming another.
  if (stepping) await stepping.catch(() => {});
  stepping = (async () => {
    at = want;
    const next = await createImageBitmap(shots[at]);
    bitmap?.close();
    bitmap = next;
    els.tNow.textContent = `${at + 1}/${shots.length}  ${shots[at].name}`;
    await solveFrame();
  })();
  return stepping;
}

function stepBy(d) {
  return goTo(at + Math.round(d));
}

// ---------------------------------------------------------------------------
// Wiring.

els.fJournal.addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    status(`fitting intrinsics from ${f.name}…\n${fitIntrinsics(await f.text())}`);
  } catch (err) {
    status(`journal failed: ${err.message}`);
  }
});

els.fMap.addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const raw = JSON.parse(await f.text());
    markers = new Map();
    for (const [id, m] of Object.entries(raw.markers || {})) {
      markers.set(Number(id), { p: m.p, q: m.q });
    }
    if (raw.markerSizeM && Math.abs(raw.markerSizeM - markerSizeM) > 1e-9) {
      status(`map markerSizeM ${raw.markerSizeM} but journal says ${markerSizeM} — `
        + 'these are different surveys, the numbers would be meaningless');
      return;
    }
    status(`map: anchor ${raw.anchorId}, ${markers.size} tags [${[...markers.keys()].join(' ')}]`);
  } catch (err) {
    status(`map failed: ${err.message}`);
  }
});

els.fFrames.addEventListener('change', async (ev) => {
  const picked = [...ev.target.files];
  if (!picked.length) return;
  if (!intrinsics.size) { status('load the pose journal first — it carries the camera model'); return; }
  if (!markers.size) { status('load markers.json first — it is the room frame'); return; }
  // Every await below is in one try: an async listener's rejection goes nowhere,
  // so without this a throw is indistinguishable from a hang — which is exactly
  // how the first run of this page presented.
  try {
    if (!core) {
      status('loading opencv.js (~10 MB, then a wasm compile)…');
      core = createDetectCore();
      await core.ensureReady();
      status(`opencv.js ready · solvePnPGeneric ${typeof core.cv.solvePnPGeneric === 'function'
        ? 'available' : 'NOT bound in this build'}`);
      lumaSource = createCanvasLumaSource(core.cv);
    }
    core.setMarkerSize(markerSizeM);

    // A multi-select file picker hands files back in whatever order it likes,
    // and the frame order is the whole basis of stepping.
    shots = picked.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    at = 0;
    bitmap?.close();
    bitmap = null;
    status(`${shots.length} frames · ${shots[0].name} … ${shots[shots.length - 1].name}`);
    await goTo(0);
  } catch (err) {
    console.error(err);
    status(`failed: ${err.message}\n\nsee the browser console for the stack`);
  }
});

document.getElementById('bPrev').onclick = () => stepBy(-10 * Number(els.step.value));
document.getElementById('bBack').onclick = () => stepBy(-Number(els.step.value));
document.getElementById('bFwd').onclick = () => stepBy(Number(els.step.value));
document.getElementById('bNext').onclick = () => stepBy(10 * Number(els.step.value));
document.getElementById('bSolve').onclick = () => solveFrame();
document.getElementById('bCompute').onclick = () => compute();
document.getElementById('bAuto').onclick = () => {
  autoCollect().catch((err) => {
    console.error(err);
    status(`auto-collect failed: ${err.message}`);
  });
};
document.getElementById('bSaveMap').onclick = () => {
  if (!landmarkMap.length) { status('run auto-collect first'); return; }
  const blob = new Blob([JSON.stringify({ anchors: landmarkMap })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'landmark-map.json';
  a.click();
  status(`saved ${landmarkMap.length} landmarks with `
    + `${landmarkMap.reduce((s, x) => s + x.desc.length, 0)} descriptors`);
};

els.fAnchors.addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    loadedMap = JSON.parse(await f.text()).anchors;  // field name kept for old saved maps
    status(`landmark map loaded: ${loadedMap.length} landmarks, `
      + `${loadedMap.reduce((s, x) => s + x.desc.length, 0)} descriptors`);
  } catch (err) {
    status(`landmark map failed: ${err.message}`);
  }
});

document.getElementById('bM6').onclick = () => {
  relocalizeM6().catch((err) => {
    console.error(err);
    status(`M6 failed: ${err.message}`);
  });
};

document.getElementById('bM3').onclick = () => {
  try {
    holdoutM3();
  } catch (err) {
    console.error(err);
    status(`M3 failed: ${err.message}`);
  }
};

document.getElementById('bAddLm').onclick = () => {
  const name = els.lmName.value.trim();
  if (!name || labels.has(name)) return;
  labels.set(name, []);
  active = name;
  els.lmName.value = '';
  renderLandmarks();
};

document.getElementById('bExport').onclick = () => {
  const blob = new Blob([JSON.stringify({
    markerSizeM,
    intrinsics: [...intrinsics],
    labels: [...labels],
  }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'landmark-labels.json';
  a.click();
};

els.fLabels.addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const raw = JSON.parse(await f.text());
  labels = new Map(raw.labels);
  if (!intrinsics.size && raw.intrinsics) intrinsics = new Map(raw.intrinsics);
  if (raw.markerSizeM) markerSizeM = raw.markerSizeM;
  active = labels.keys().next().value ?? null;
  renderLandmarks();
  status(`${labels.size} landmarks restored`);
});
