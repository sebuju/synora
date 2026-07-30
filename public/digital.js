'use strict';

// Shows a room tag on this screen at its true physical size, as an
// alternative to printing. The catch: CSS pixels are not millimeters — the
// browser assumes 96 dpi, real panels vary wildly — so the user calibrates
// once against a credit card (ISO/IEC 7810 ID-1: 85.60 mm wide), and the
// pixels-per-mm ratio persists per device.

const tagSelect = document.getElementById('tagSelect');
const calBtn = document.getElementById('calBtn');
const fsBtn = document.getElementById('fsBtn');
const tagCanvas = document.getElementById('tagCanvas');
const tagWrap = document.getElementById('tagWrap');
const tagInfo = document.getElementById('tagInfo');
const warn = document.getElementById('warn');
const ppmmSlider = document.getElementById('ppmmSlider');
const ppmmLabel = document.getElementById('ppmmLabel');
const card = document.getElementById('card');
const calDone = document.getElementById('calDone');

const PPMM_KEY = 'streamer-screen-ppmm';
const CARD_MM = 85.6;
// Browser default assumption: 96 css px per inch.
const DEFAULT_PPMM = 96 / 25.4;

// The physical size to draw at is the server's configured marker size, not a
// constant here: PnP solves every tag against that number, so a screen drawing
// itself at any other size scales every distance measured from it by the
// mismatch and nothing anywhere reports it. ROOM_TAG_MM is the printed default
// and the server's own default, but the setting is live and this page is not
// allowed to guess at it — until the fetch lands there is no tag to show.
let tagMm = null;

let ppmm = DEFAULT_PPMM;
let calibrated = false;
try {
  const stored = parseFloat(localStorage.getItem(PPMM_KEY));
  if (stored > 0) {
    ppmm = stored;
    calibrated = true;
  }
} catch {
  // Storage unavailable — calibration just does not survive a reload.
}

for (let id = 0; id < ROOM_TAG_COUNT; id++) {
  const opt = document.createElement('option');
  opt.value = String(id);
  opt.textContent = `tag ${id}${id === 0 ? ' (origin)' : ''}`;
  tagSelect.append(opt);
}
// Screens are extra tags in the room, not usually the origin — default past 0.
tagSelect.value = '1';

let dict = null;
const markerImg = { mat: null, cv: null };

function renderTag() {
  const cv = markerImg.cv;
  if (!cv || !tagMm) return;
  const id = Number(tagSelect.value);
  dict.generateImageMarker(id, 360, markerImg.mat);
  cv.imshow(tagCanvas, markerImg.mat);

  const px = tagMm * ppmm;
  tagCanvas.style.width = `${px}px`;
  tagCanvas.style.height = `${px}px`;
  // The white panel is the quiet zone: one marker cell (a sixth of the tag)
  // of white on every side.
  tagWrap.style.padding = `${(tagMm / 6) * ppmm}px`;
  tagInfo.textContent =
    `tag ${id} · ${tagMm} mm at ${ppmm.toFixed(2)} px/mm` +
    (calibrated ? '' : ' · SCREEN NOT CALIBRATED — size is a guess');

  // The quiet zone needs roughly one marker cell (25 mm) of white all round.
  const need = px + 2 * (tagMm / 6) * ppmm;
  const fitsW = need <= window.innerWidth;
  const fitsH = need <= window.innerHeight - 60;
  warn.textContent = fitsW && fitsH
    ? ''
    : `Screen too small: the tag needs ${Math.round(need)} px plus margin. ` +
      'Use a bigger screen — a shrunken tag would corrupt every measured distance.';
  setStatus(calibrated ? 'showing tag at true size' : 'calibrate screen size first');
}

function setCalibrating(on) {
  document.body.classList.toggle('calibrating', on);
  if (on) {
    ppmmSlider.value = String(Math.round(CARD_MM * ppmm));
    updateCard();
  }
}

function updateCard() {
  const widthPx = Number(ppmmSlider.value);
  card.style.width = `${widthPx}px`;
  ppmmLabel.textContent = `${(widthPx / CARD_MM).toFixed(2)} px/mm`;
}

ppmmSlider.oninput = updateCard;

calDone.onclick = () => {
  ppmm = Number(ppmmSlider.value) / CARD_MM;
  calibrated = true;
  try {
    localStorage.setItem(PPMM_KEY, String(ppmm));
  } catch {
    // Storage unavailable.
  }
  setCalibrating(false);
  renderTag();
};

calBtn.onclick = () => setCalibrating(!document.body.classList.contains('calibrating'));
tagSelect.onchange = renderTag;
fsBtn.onclick = () => document.getElementById('tagWrap').requestFullscreen?.();
window.onresize = renderTag;

// The screen must not sleep while it is being a marker.
async function keepAwake() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    // Wake lock unavailable — the screen may dim, not fatal.
  }
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  // The size can be changed on the markers page while this screen is sitting
  // there being a tag, and a screen still showing the old size is exactly the
  // silent scale error this page is not allowed to produce.
  if (!tagMm) return;
  try {
    const mm = await fetchTagSize();
    if (mm !== tagMm) {
      tagMm = mm;
      renderTag();
    }
  } catch {
    // Server unreachable — keep showing the size it last confirmed.
  }
});

// Refusing to draw is the right failure here. A tag at the wrong size still
// decodes and still solves — it just puts every distance measured from it out
// by the ratio, silently, with the map showing no sign of it.
async function fetchTagSize() {
  const r = await fetch('/api/pose-config');
  const mm = Math.round((await r.json()).markerSizeM * 1000);
  if (!(mm > 0)) throw new Error('server reported no marker size');
  return mm;
}

(async () => {
  let cv;
  try {
    cv = await loadOpenCv();
  } catch (err) {
    setStatus(err.message);
    return;
  }
  try {
    tagMm = await fetchTagSize();
  } catch {
    warn.textContent = 'Cannot reach the server for the configured tag size. ' +
      'A tag drawn at the wrong size corrupts every distance measured from it, ' +
      `so nothing is shown — set the size on the markers page (default ${ROOM_TAG_MM} mm) ` +
      'and reload.';
    setStatus('no tag size from the server');
    return;
  }
  dict = cv.getPredefinedDictionary(cv[ROOM_DICT]);
  markerImg.cv = cv;
  markerImg.mat = new cv.Mat();
  keepAwake();
  if (!calibrated) setCalibrating(true);
  renderTag();
})();
