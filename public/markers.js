'use strict';

// Renders the printable room tags. Everything meaningful about the tags
// (dictionary, count) lives in cv-common.js so the client detector and this
// page cannot drift apart.

const sheets = document.getElementById('sheets');
const genStatus = document.getElementById('genStatus');
const sizeInput = document.getElementById('sizeInput');
const sizeStatus = document.getElementById('sizeStatus');
const applyBtn = document.getElementById('applyBtn');

document.getElementById('printBtn').onclick = () => print();

// The sheet prints at whatever size the server is solving for, so the two
// cannot drift: print at 100%, measure, correct here, reprint or just keep the
// sheets you have — either way both sides end up describing the same tag.
function showSize(mm, note = '', bad = false) {
  document.documentElement.style.setProperty('--marker-mm', `${mm}mm`);
  sizeInput.value = mm;
  sizeStatus.textContent = note;
  sizeStatus.classList.toggle('bad', bad);
  genStatus.textContent =
    `${ROOM_TAG_COUNT} tags (${ROOM_DICT}, ${mm} mm). Use the browser's print dialog at 100% scale.`;
}

async function loadSize() {
  try {
    const r = await fetch('/api/pose-config');
    showSize(Math.round((await r.json()).markerSizeM * 1000));
  } catch (err) {
    sizeStatus.textContent = `could not read size: ${err.message}`;
    sizeStatus.classList.add('bad');
  }
}

applyBtn.onclick = async () => {
  const mm = Number(sizeInput.value);
  if (!(mm > 0)) return;
  applyBtn.disabled = true;
  sizeStatus.classList.remove('bad');
  sizeStatus.textContent = 'applying…';
  try {
    const r = await fetch('/api/pose-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markerSizeM: mm / 1000 }),
    });
    const out = await r.json();
    if (!out.ok) showSize(Number(sizeInput.value), out.error, true);
    else showSize(Math.round(out.markerSizeM * 1000),
      out.changed ? 'applied — survey reset, map cleared' : 'unchanged');
  } catch (err) {
    sizeStatus.textContent = err.message;
    sizeStatus.classList.add('bad');
  }
  applyBtn.disabled = false;
};

loadSize();

(async () => {
  let cv;
  try {
    cv = await loadOpenCv();
  } catch (err) {
    genStatus.textContent = `OpenCV failed to load: ${err.message}`;
    return;
  }

  const dict = cv.getPredefinedDictionary(cv[ROOM_DICT]);
  const img = new cv.Mat();
  for (let id = 0; id < ROOM_TAG_COUNT; id++) {
    // 60 px per marker cell (4 cells + 2 border cells = 6): crisp at print DPI.
    dict.generateImageMarker(id, 360, img);

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, img);
    const label = document.createElement('div');
    label.className = 'tag-label';
    if (id === 0) {
      // Short in the on-screen preview; the full mounting instruction only
      // matters on the printed sheet.
      const short = document.createElement('span');
      short.className = 'screen-only';
      short.textContent = 'ORIGIN';
      const long = document.createElement('span');
      long.className = 'print-only';
      long.textContent = 'tag 0 — ROOM ORIGIN (mount upright on a wall, do not move)';
      label.append(short, long);
    } else {
      label.textContent = `tag ${id}`;
    }
    sheet.append(canvas, label);
    sheets.append(sheet);
  }
  img.delete();
  dict.delete();
  // The size line is owned by showSize (it reports the configured size, not a
  // hardcoded one); refresh it now that the tag count line is meaningful.
  loadSize();
})();
