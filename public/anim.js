'use strict';

// Frame-rate-independent easing for the viewer's canvas renderers.
//
// Every animated quantity here is an exponential approach, never a timed tween:
// the render loops are told a target whenever a message arrives, not a
// start/end pair, and a target can change mid-flight. `1 - exp(-dt/tau)` is the
// only form that behaves the same at 30 fps and at 144 fps, and the only one
// that survives a target moving under it.
//
// Two time constants, and they mean different things — motion says "this is the
// same object, it went there", fades say "this appeared / went away". Mixing
// them makes a birth read as a jump.

const MOTION_TAU_MS = 120;   // position, orientation, zoom, view fit
const FADE_MS = 300;         // opacity, colour, appear / disappear

function animAlpha(dt, tau) {
  return 1 - Math.exp(-dt / tau);
}

// The epsilon is load-bearing, not a tidy-up: an entity is deleted when its
// fade reaches zero, and an exponential never arrives. Everything that eases
// must be able to finish.
function animApproach(cur, target, dt, tau, eps = 1e-4) {
  if (Math.abs(target - cur) <= eps) return target;
  return cur + (target - cur) * animAlpha(dt, tau);
}

// In place over any indexable of numbers (a plain [x,y,z] or a typed array).
function animApproachArr(cur, target, dt, tau, eps = 1e-4) {
  const a = animAlpha(dt, tau);
  for (let i = 0; i < cur.length; i++) {
    cur[i] = Math.abs(target[i] - cur[i]) <= eps ? target[i] : cur[i] + (target[i] - cur[i]) * a;
  }
  return cur;
}

// Log-space, for scale factors and camera distances: a zoom is a ratio, and
// easing it linearly makes zooming out crawl while zooming in snaps.
function animApproachGeo(cur, target, dt, tau, eps = 1e-3) {
  if (!(cur > 0) || !(target > 0)) return target;
  const ratio = target / cur;
  if (Math.abs(Math.log(ratio)) <= eps) return target;
  return cur * ratio ** animAlpha(dt, tau);
}

// A linear ramp, not an approach: a fade has two ends and has to reach them.
// An exponential is asymptotic — at a 300 ms time constant a "faded out" thing
// is still 4% visible after a second and is never deleted, because the entity
// is dropped when its fade hits zero. Reversing mid-fade just walks back from
// wherever it had got to.
function animFade(cur, up, dt, ms = FADE_MS) {
  const next = cur + (up ? dt : -dt) / ms;
  return next <= 0 ? 0 : (next >= 1 ? 1 : next);
}

// Canvas normalises whatever CSS colour it is handed, so the parser is the one
// already in the page rather than a regex per notation — the colours here are
// a mix of #rgb, #rrggbb and hsl(). Memoised: the same handful of strings are
// mixed every frame.
const animRgbCache = new Map();
let animProbeCtx = null;
function animRgb(css) {
  let rgb = animRgbCache.get(css);
  if (rgb) return rgb;
  if (!animProbeCtx) animProbeCtx = document.createElement('canvas').getContext('2d');
  animProbeCtx.fillStyle = '#000';
  animProbeCtx.fillStyle = css;
  const norm = animProbeCtx.fillStyle;
  if (norm[0] === '#') {
    const n = parseInt(norm.slice(1), 16);
    rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  } else {
    // Alpha rides along: several of the colours mixed here are translucent
    // fills, and dropping it turns a 13% wash into a solid disc.
    const parts = norm.match(/[\d.]+/g) || [0, 0, 0];
    rgb = [+parts[0], +parts[1], +parts[2], parts[3] === undefined ? 1 : +parts[3]];
  }
  animRgbCache.set(css, rgb);
  return rgb;
}

function animMixCss(cssA, cssB, t) {
  if (t <= 0) return cssA;
  if (t >= 1) return cssB;
  const a = animRgb(cssA);
  const b = animRgb(cssB);
  const mix = (i) => a[i] + (b[i] - a[i]) * t;
  return `rgba(${Math.round(mix(0))},${Math.round(mix(1))},${Math.round(mix(2))},${
    mix(3).toFixed(3)})`;
}
