'use strict';

// The drawer's sparkline: one chart, any number of series on one axis, with the
// record's own events marked underneath.
//
// Lifted out of `clients-panel.js` when the object map needed the same chart.
// The two records are different — a tag's is a pose settling, an object's is a
// position and a confidence accumulating — but the drawing is the same problem
// in both: a few hundred points in a 320 px drawer, sampled irregularly, with
// gaps that mean "nobody was looking" and must not be drawn as level lines.
//
// Series that do not share a unit never share a chart: millimetres and degrees
// are two charts, not two axes.

const SPARK_H = 40;
// The series pair, checked as one against the card's own #1c1c1c: OKLab ΔE 8.9
// under protanopia and deuteranopia, 16.7 with normal vision, both above the
// floor. They are the panel's own green and amber taken down into the
// dark-surface lightness band — the text colours (#8fc79d / #e0a03a) sit above
// it, and as 2 px lines on near-black they are too pale and too close to each
// other to tell apart.
const SPARK_MOVED = '#3aa471';
const SPARK_OFF = '#bd8420';
// Reserved for the one kind of event that is a fault — a tag found somewhere
// else and dropped, an object quarantined. A promotion is not a fault, so it is
// muted.
const SPARK_RESEED = '#e0603a';
const SPARK_EVENT = '#7a7a7a';
const SPARK_AXIS = '#333';
const SPARK_INK = '#9a9a9a';

// A break in the line rather than a straight segment across the gap: nothing was
// measured in between, and a level line there reads as "held still" — which is
// exactly the claim a thing nobody looked at must not be allowed to make.
//
// Measured against the record's own cadence, never a fixed interval. A server
// samples at most once a second but only while the thing is actually being
// observed — on a real journal that came out at one sample every ten seconds —
// and the old half of a long record is thinned, so its spacing is a multiple of
// the new half's. A fixed 2.5 s rule broke every segment of every series:
// nothing was drawn but the axis.
const SPARK_GAP_FACTOR = 4;
const SPARK_GAP_MIN_MS = 5000;
// Below this many points the samples are drawn as dots as well as a line: a
// sparse record is mostly breaks, and a break between two invisible points
// leaves an empty chart that cannot be told from no data at all.
const SPARK_DOTS_UNDER = 80;

function gapMs(pts) {
  if (pts.length < 3) return SPARK_GAP_MIN_MS;
  const d = [];
  for (let i = 1; i < pts.length; i++) d.push(pts[i][0] - pts[i - 1][0]);
  d.sort((a, b) => a - b);
  return Math.max(SPARK_GAP_MIN_MS, SPARK_GAP_FACTOR * d[d.length >> 1]);
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  // Finer than the usual 1/2/5: a 107 mm trace against a 200 mm ceiling uses
  // half the height it has, and these are 40 px tall to begin with. Nothing here
  // rounds past 1.5x the data.
  for (const step of [1, 1.5, 2, 3, 5, 7.5, 10]) {
    if (v <= step * mag) return step * mag;
  }
  return 10 * mag;
}

function nearestPt(pts, t) {
  let best = null;
  let bestD = Infinity;
  for (const p of pts) {
    const d = Math.abs(p[0] - t);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// `eventColor(kind)` decides which marks are faults. Supplied by the caller
// because what counts as one is about the record, not about the chart: a
// re-seed is a fault in a tag's life and a promotion is not, and the object
// record's list of named moments is its own.
function drawSpark(canvas, {
  series, events, t0, t1, fmt, hoverT, eventColor,
}) {
  const w = Math.max(60, Math.round(canvas.clientWidth || 0));
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(SPARK_H * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(SPARK_H * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, SPARK_H);
  const top = 11;
  const bottom = SPARK_H - 3;
  const span = Math.max(1, t1 - t0);
  let vmax = 0;
  for (const s of series) for (const [, v] of s.pts) vmax = Math.max(vmax, v);
  vmax = niceMax(vmax);
  const x = (t) => ((t - t0) / span) * (w - 1);
  const y = (v) => bottom - (Math.min(v, vmax) / vmax) * (bottom - top);

  // The zero line, because every series here is a distance from something and
  // zero is where they all mean "no disagreement left".
  g.strokeStyle = SPARK_AXIS;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, bottom + 0.5);
  g.lineTo(w, bottom + 0.5);
  g.stroke();

  // Under the traces: an event is when something happened to the thing, not a
  // measurement of it, and it must not cover the curve it explains.
  for (const ev of events) {
    if (ev.t < t0) continue;
    const ex = Math.round(x(ev.t)) + 0.5;
    g.strokeStyle = eventColor ? eventColor(ev.kind) : SPARK_EVENT;
    g.beginPath();
    g.moveTo(ex, top - 3);
    g.lineTo(ex, bottom);
    g.stroke();
  }

  for (const s of series) {
    g.strokeStyle = s.color;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    const gap = gapMs(s.pts);
    let prevT = null;
    for (const [t, v] of s.pts) {
      if (prevT === null || t - prevT > gap) g.moveTo(x(t), y(v));
      else g.lineTo(x(t), y(v));
      prevT = t;
    }
    g.stroke();
    if (s.pts.length <= SPARK_DOTS_UNDER) {
      g.fillStyle = s.color;
      for (const [t, v] of s.pts) {
        g.beginPath();
        g.arc(x(t), y(v), 1.5, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  // The scale, as one number: these are sparklines in a 320 px drawer and an
  // axis would cost more room than the trace it labels. Without it the chart is
  // shape-only and a 2 mm wobble looks like a 2 m one.
  g.fillStyle = SPARK_INK;
  g.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  g.textAlign = 'right';
  g.textBaseline = 'top';
  g.fillText(fmt(vmax), w - 1, 0);

  if (hoverT !== null && hoverT !== undefined) {
    const hx = Math.round(x(hoverT)) + 0.5;
    g.strokeStyle = '#cfcfcf';
    g.beginPath();
    g.moveTo(hx, top - 3);
    g.lineTo(hx, bottom);
    g.lineWidth = 1;
    g.stroke();
    for (const s of series) {
      const pt = nearestPt(s.pts, hoverT);
      if (!pt) continue;
      g.fillStyle = s.color;
      g.beginPath();
      g.arc(x(pt[0]), y(pt[1]), 2.5, 0, Math.PI * 2);
      g.fill();
    }
  }
}
