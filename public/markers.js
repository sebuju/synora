'use strict';

// Renders the printable room tags. Everything meaningful about the tags
// (dictionary, count) lives in cv-common.js so the client detector and this
// page cannot drift apart.

const sheets = document.getElementById('sheets');
const genStatus = document.getElementById('genStatus');

document.getElementById('printBtn').onclick = () => print();

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
  genStatus.textContent =
    `${ROOM_TAG_COUNT} tags (${ROOM_DICT}, 150 mm). Use the browser's print dialog at 100% scale.`;
})();
