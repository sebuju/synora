'use strict';

// Orthographic 2D room views, one renderer for both projections:
//   'top'  — the floor plan, x-z plane (y collapsed)
//   'side' — the elevation, x-y plane (z collapsed), y drawn upward
// Same data feeds as the 3D scene — markers and client poses — rendered
// with plain canvas 2D. Viewport auto-fits whatever exists.

function createMap2dView(canvas, mode = 'top', { onMarkerDblClick, onMarkerHover } = {}) {
  const ctx = canvas.getContext('2d');
  // Projection of a room-frame point onto this view's two axes; the second
  // axis is drawn downward for the floor plan and upward for the elevation.
  const proj = mode === 'side'
    ? (p) => [p[0], p[1]]
    : (p) => [p[0], p[2]];
  const orient = mode === 'side' ? -1 : 1;

  let active = false;
  let markerMap = null;
  // On: dot at the reported pose. Off (default): the pose point is hidden and
  // everything anchors on the uncertainty circle's centre instead — the circle
  // is the steadier claim, and sometimes it is the only one wanted.
  let showPose = false;
  // id -> { pos:[3], normal:[3], ax3:[3] (marker x-axis, room frame) }
  const markers = new Map();
  // clientId -> { target, cur {p:[3], fwd:[3]}, seen, at, color }
  const clients = new Map();
  const SMOOTH_TAU_MS = 120;
  // Measured spread of the recent fixes, drawn rather than hidden: a bare dot
  // claims a precision the fix does not have. Same convention as the 3D ring —
  // 2x the rms so it reads as "probably in here", smoothed so the circle does
  // not pulse with its own measurement window.
  const UNCERTAINTY_SIGMA = 2;
  const RADIUS_TAU_MS = 400;
  const RADIUS_MIN_PX = 3;
  // With the pose hidden and the measured spread too small to draw, a small
  // fixed dot marks the circle's centre — the heading line has to visibly
  // start from somewhere. Screen-space: it is a marker, not a measurement.
  const RING_DOT_PX = 3;
  let rafPending = false;
  let lastFrameAt = 0;
  // The tag glyphs of the last drawn frame, in pixels: the bar and the id chip,
  // exactly as they were stroked. Hit tests read this rather than re-deriving a
  // radius around the tag's centre — the glyph is a rotated bar with a chip
  // beside it, so a circle around the middle both misses the chip and claims
  // empty space at either end of a bar seen edge-on.
  // [{ id, x1, y1, x2, y2, chip: { cx, cy, ang, halfW, halfH } }]
  let lastGlyphs = [];
  // Which tag is highlighted. Set from outside only: the drawer and both map
  // views highlight the same tag at once, so the one place that can know is the
  // viewer, and every renderer here is told rather than deciding for itself.
  let hoverId = null;
  // Right-angle legs between neighbouring tags, derived once per map.
  let pairs = [];
  // Carved free-space grid, pre-rendered to a one-pixel-per-cell offscreen
  // canvas on arrival: the draw loop runs every frame and a few thousand
  // fillRects per frame is exactly the cost drawImage exists to avoid.
  let floor = null;      // { cellM, minIx, minIz, w, h, canvas }
  let walls = [];        // [{ a:[x,z], b:[x,z], y0, y1, ids }]
  let showWalls = true;
  const FLOOR_FREE_CSS = 'rgba(127,184,164,0.16)';
  const FLOOR_OCC_CSS = 'rgba(223,120,100,0.25)';
  const FLOOR_EDGE_CSS = 'rgba(190,208,200,0.35)';
  // Neutral white, not a tag colour: the highlight has to read the same on
  // every tag, and each tag already owns a colour of its own.
  const HOVER_HALO_CSS = 'rgba(255,255,255,0.55)';
  const WALL_STROKE_CSS = '#dfe7ea';
  const WALL_FILL_CSS = 'rgba(223,231,234,0.10)';

  // Auto-fit until the user touches it, then their view, unchanged. The fit is
  // still computed every frame and kept in lastFit: it is what a reset returns
  // to, and what the zoom limits are expressed against. Letting the fit keep
  // driving a panned view instead would yank it sideways the moment a tag was
  // surveyed.
  let view = null;
  let lastFit = null;
  const ZOOM_STEP = 1.15;
  const ZOOM_OUT_LIMIT = 0.05;   // times the fit
  const ZOOM_IN_LIMIT = 200;

  function takeOver() {
    if (!view && lastFit) view = { ...lastFit };
    return !!view;
  }

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (!takeOver()) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // The world point under the pointer stays under it, so zooming reads as
    // moving the paper rather than as the view jumping to its own centre.
    const a = (ev.offsetX - w / 2) / view.scale + view.ca;
    const b = orient * (ev.offsetY - h / 2) / view.scale + view.cb;
    const k = ZOOM_STEP ** -Math.sign(ev.deltaY);
    view.scale = Math.max(lastFit.scale * ZOOM_OUT_LIMIT,
      Math.min(lastFit.scale * ZOOM_IN_LIMIT, view.scale * k));
    view.ca = a - (ev.offsetX - w / 2) / view.scale;
    view.cb = b - orient * (ev.offsetY - h / 2) / view.scale;
    schedule();
  }, { passive: false });

  // The pointer id is carried so a second pointer arriving mid-drag cannot end
  // the first one's capture, which releasePointerCapture treats as an error.
  let drag = null;
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !takeOver()) return;
    drag = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    canvas.setPointerCapture(ev.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  // Distance from a point to a segment, not to its infinite line: a tag bar is
  // 150 mm of wall and the line it lies on runs the length of the room.
  function distToSeg(x, y, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
  }

  // Which tag glyph is under the pointer, bar or chip. One hit test, used by
  // both the hover highlight and the double-click that forgets a tag — two
  // tests would mean a tag that lights up under the pointer and is not the one
  // the click lands on.
  const GLYPH_HIT_PX = 7;
  function markerAt(x, y) {
    for (const g of lastGlyphs) {
      if (distToSeg(x, y, g.x1, g.y1, g.x2, g.y2) <= GLYPH_HIT_PX) return g.id;
      // The chip is drawn rotated with the bar, so the point is rotated back
      // into the chip's own frame rather than the box being grown to fit it.
      const dx = x - g.chip.cx;
      const dy = y - g.chip.cy;
      const lx = Math.cos(g.chip.ang) * dx + Math.sin(g.chip.ang) * dy;
      const ly = -Math.sin(g.chip.ang) * dx + Math.cos(g.chip.ang) * dy;
      if (Math.abs(lx) <= g.chip.halfW && Math.abs(ly) <= g.chip.halfH) return g.id;
    }
    return null;
  }

  // What the pointer was last reported to be over, so a move across one tag
  // does not repaint the drawer four hundred times.
  let reportedHover = null;
  function reportHover(id) {
    if (id === reportedHover) return;
    reportedHover = id;
    onMarkerHover?.(id);
  }

  canvas.addEventListener('pointermove', (ev) => {
    if (!drag) {
      const id = markerAt(ev.offsetX, ev.offsetY);
      canvas.style.cursor = id === null ? '' : 'pointer';
      reportHover(id);
      return;
    }
    if (drag.id !== ev.pointerId || !view) return;
    view.ca -= (ev.clientX - drag.x) / view.scale;
    view.cb -= orient * (ev.clientY - drag.y) / view.scale;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    schedule();
  });

  canvas.addEventListener('pointerleave', () => reportHover(null));
  const endDrag = (ev) => {
    if (!drag || drag.id !== ev.pointerId) return;
    canvas.releasePointerCapture(ev.pointerId);
    drag = null;
    canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // One handler, because both meanings live on the same gesture: on a tag it
  // forgets that tag, anywhere else it gives the auto-fit back. Registered even
  // without onMarkerDblClick — the reset is not the caller's to opt out of.
  canvas.addEventListener('dblclick', (ev) => {
    if (onMarkerDblClick) {
      const id = markerAt(ev.offsetX, ev.offsetY);
      if (id !== null) {
        onMarkerDblClick(id);
        return;
      }
    }
    view = null;
    schedule();
  });

  // Does the segment (x1,y1)-(x2,y2) hit the axis-aligned box? Liang–Barsky
  // clip; used by the label pass to keep text off walls and tags.
  function segHitsBox(x1, y1, x2, y2, minX, minY, maxX, maxY) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1 - minX, maxX - x1, y1 - minY, maxY - y1];
    let t0 = 0;
    let t1 = 1;
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false;
      } else {
        const r = q[i] / p[i];
        if (p[i] < 0) {
          if (r > t1) return false;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return false;
          if (r < t1) t1 = r;
        }
      }
    }
    return true;
  }

  function draw(now) {
    rafPending = false;
    if (!active) return;
    const dt = lastFrameAt ? now - lastFrameAt : 16;
    lastFrameAt = now;

    // All text is queued and drawn after everything else: labels must never
    // sit under a wall stroke or a tag, and if a spot is taken the label
    // steps aside rather than overprints. Obstacles are the wall and tag
    // strokes of this same frame, in pixels.
    const labels = [];
    const obstacles = [];
    const queueLabel = (text, x, y, color, bg) => labels.push({ text, x, y, color, bg });
    const LABEL_OFFSETS = [
      [0, 0], [0, -12], [0, 12], [14, 0], [-14, 0],
      [14, -12], [-14, -12], [0, -24], [0, 24],
    ];
    function flushLabels() {
      for (const lb of labels) {
        const half = ctx.measureText(lb.text).width / 2;
        let x = lb.x;
        let y = lb.y;
        for (const [ox, oy] of LABEL_OFFSETS) {
          const cx = lb.x + ox;
          const cy = lb.y + oy;
          const clear = obstacles.every((o) => !segHitsBox(o.x1, o.y1, o.x2, o.y2,
            cx - half - o.r, cy - 10 - o.r, cx + half + o.r, cy + 2 + o.r));
          if (clear) {
            x = cx;
            y = cy;
            break;
          }
        }
        if (lb.bg) {
          const w2 = half + 4;
          ctx.fillStyle = lb.bg;
          ctx.fillRect(x - w2, y - 11, w2 * 2, 14);
        }
        ctx.fillStyle = lb.color;
        ctx.fillText(lb.text, x, y);
      }
    }

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) {
      schedule();
      return;
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    // Smooth clients toward their latest pose (same time constant as 3D).
    const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
    for (const ph of clients.values()) {
      if (!ph.target) continue;
      const fwd = quatRotate(ph.target.q, [0, 0, 1]);
      for (let k = 0; k < 3; k++) {
        ph.cur.p[k] += (ph.target.p[k] - ph.cur.p[k]) * alpha;
        ph.cur.fwd[k] += (fwd[k] - ph.cur.fwd[k]) * alpha;
      }
      const rAlpha = 1 - Math.exp(-dt / RADIUS_TAU_MS);
      ph.shownRadius += (ph.uncertaintyM * UNCERTAINTY_SIGMA - ph.shownRadius) * rAlpha;
      // The circle's centre is a measurement in its own right and moves on the
      // circle's own slow clock, not the dot's — see updateClient.
      if (ph.ringTarget) {
        if (!ph.ringSeeded) {
          ph.ringAt = [...ph.ringTarget];
          ph.ringSeeded = true;
        } else {
          for (let k = 0; k < 3; k++) {
            ph.ringAt[k] += (ph.ringTarget[k] - ph.ringAt[k]) * rAlpha;
          }
        }
      }
    }

    // Auto-fit: bounds of everything worth seeing, floor of 5 m span.
    let minA = -0.5, maxA = 0.5, minB = -0.5, maxB = 0.5;
    const grow = (a, b) => {
      minA = Math.min(minA, a); maxA = Math.max(maxA, a);
      minB = Math.min(minB, b); maxB = Math.max(maxB, b);
    };
    for (const m of markers.values()) grow(...proj(m.pos));
    for (const ph of clients.values()) {
      if (ph.target) grow(...proj(ph.cur.p));
    }
    // Only while shown — a hidden layer must not keep the view zoomed out to
    // fit something invisible.
    if (showWalls) {
      if (mode === 'top' && floor) {
        grow(floor.minIx * floor.cellM, floor.minIz * floor.cellM);
        grow((floor.minIx + floor.w) * floor.cellM, (floor.minIz + floor.h) * floor.cellM);
      }
      for (const seg of walls) {
        if (mode === 'side') {
          grow(seg.a[0], seg.y0);
          grow(seg.b[0], seg.y1);
        } else {
          grow(seg.a[0], seg.a[1]);
          grow(seg.b[0], seg.b[1]);
        }
      }
    }
    let spanA = Math.max(maxA - minA, 5);
    let spanB = Math.max(maxB - minB, 5);
    let scale = Math.min((w - 60) / spanA, (h - 60) / spanB);
    let ca = (minA + maxA) / 2;
    let cb = (minB + maxB) / 2;
    lastFit = { ca, cb, scale };
    if (view) {
      ({ ca, cb, scale } = view);
      // The grid below is drawn over the span it is handed, so a zoomed-in view
      // has to say how much room it actually covers or the lines run out.
      spanA = w / scale;
      spanB = h / scale;
    }
    const toPx = (a, b) => [(a - ca) * scale + w / 2, orient * (b - cb) * scale + h / 2];
    const px = (p) => toPx(...proj(p));

    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, w, h);

    // Attested free space, under everything: it is the claim the rest of the
    // drawing stands on. Only the floor plan can show it — the side view has
    // no honest projection of an x-z grid. Smoothing off so cells read as
    // cells, not as a blur pretending to be a measurement gradient.
    if (showWalls && floor && mode === 'top') {
      const [fx, fy] = toPx(floor.minIx * floor.cellM, floor.minIz * floor.cellM);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(floor.canvas, fx, fy,
        floor.w * floor.cellM * scale, floor.h * floor.cellM * scale);
      ctx.imageSmoothingEnabled = true;
    }

    // 1 m grid.
    ctx.strokeStyle = '#242424';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let ga = Math.ceil(ca - spanA); ga <= Math.floor(ca + spanA); ga++) {
      const [sx] = toPx(ga, 0);
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let gb = Math.ceil(cb - spanB); gb <= Math.floor(cb + spanB); gb++) {
      const [, sy] = toPx(0, gb);
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();

    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';

    // Room axes at the origin, in the 3D scene's colours and at its length, so
    // the cross reads as the same object in every view. Only the two axes this
    // projection keeps are drawn — the collapsed one would be a dot at the
    // origin claiming to be a direction.
    const axes = mode === 'side' ? [0, 1] : [0, 2];
    ctx.lineWidth = 2;
    for (const k of axes) {
      const end = [0, 0, 0];
      end[k] = ROOM_AXIS_LEN_M;
      const [ox, oy] = px([0, 0, 0]);
      const [ex, ey] = px(end);
      ctx.strokeStyle = roomAxisColorCss(k);
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      // Pushed a further tenth along its own direction, so the letter sits off
      // the end of the arm rather than on top of the other one's.
      const [lx, ly] = px(end.map((v) => v * 1.25));
      queueLabel(ROOM_AXIS_NAMES[k], lx, ly + 4, roomAxisColorCss(k));
    }

    // Wall segments. Top: the wall seen edge-on, a stroke from end to end.
    // Side: the wall seen face-on, its attested x extent by its (cosmetic)
    // height band. Both only as far as the extent the carving attested.
    if (showWalls) {
      for (const seg of walls) {
        if (mode === 'side') {
          const [x1, yA] = toPx(Math.min(seg.a[0], seg.b[0]), seg.y0);
          const [x2, yB] = toPx(Math.max(seg.a[0], seg.b[0]), seg.y1);
          const top = Math.min(yA, yB);
          const bot = Math.max(yA, yB);
          if (seg.inferred) ctx.setLineDash([7, 5]);
          else {
            ctx.fillStyle = WALL_FILL_CSS;
            ctx.fillRect(x1, top, x2 - x1, bot - top);
          }
          ctx.strokeStyle = WALL_STROKE_CSS;
          ctx.lineWidth = 1;
          ctx.strokeRect(x1, top, x2 - x1, bot - top);
          ctx.setLineDash([]);
          // Labels dodge the rect's border, not its translucent inside.
          obstacles.push(
            { x1, y1: top, x2, y2: top, r: 2 },
            { x1, y1: bot, x2, y2: bot, r: 2 },
            { x1, y1: top, x2: x1, y2: bot, r: 2 },
            { x1: x2, y1: top, x2, y2: bot, r: 2 });
        } else {
          const [x1, y1] = toPx(seg.a[0], seg.a[1]);
          const [x2, y2] = toPx(seg.b[0], seg.b[1]);
          ctx.strokeStyle = WALL_STROKE_CSS;
          // Dashed and thinner: an inferred wall is a strong reading of the
          // carve boundary, not an asserted tag plane, and the stroke says so.
          ctx.lineWidth = seg.inferred ? 2 : 4;
          if (seg.inferred) ctx.setLineDash([7, 5]);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.lineCap = 'butt';
          ctx.setLineDash([]);
          obstacles.push({ x1, y1, x2, y2, r: seg.inferred ? 2 : 4 });
          // Wall length, hung off the midpoint on the uncarved side — outside
          // the room where it competes with nothing — falling back to either
          // side when both are carved (or no floor snapshot yet).
          const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
          if (len >= 0.6) {
            const mx = (seg.a[0] + seg.b[0]) / 2;
            const mz = (seg.a[1] + seg.b[1]) / 2;
            const nx = -(seg.b[1] - seg.a[1]) / len;
            const nz = (seg.b[0] - seg.a[0]) / len;
            let sign = 1;
            if (floor) {
              const freeAt = (x, z) => floor.freeKeys.has(floor.keyOf(
                Math.floor(x / floor.cellM), Math.floor(z / floor.cellM)));
              if (freeAt(mx + nx * 0.25, mz + nz * 0.25)
                && !freeAt(mx - nx * 0.25, mz - nz * 0.25)) sign = -1;
            }
            const [lx2, ly2] = toPx(mx + nx * 0.22 * sign, mz + nz * 0.22 * sign);
            queueLabel(`${len.toFixed(2)}`, lx2, ly2 + 4, '#b9c6cb');
          }
        }
      }
    }

    // Right-angle distances between neighbouring tags: the two legs of the axis
    // decomposition, dashed, each labelled with its own length. The component
    // this projection collapses is left out rather than drawn misleadingly flat
    // — what is on screen is exactly what the view can honestly show, and it is
    // the same decomposition the client drawer lists. Drawn under the tags and
    // the clients, being the static thing.
    ctx.lineWidth = 1;
    for (const { a, b, kind } of pairs) {
      // The elbow: b's first axis, a's second. Whichever component the mode
      // collapses is never read, so one corner serves both projections.
      const [ax, ay] = px(a.p);
      const [bx, by] = px(b.p);
      const [cx, cy] = px([b.p[0], a.p[1], a.p[2]]);
      // A chain link is not a distance worth tape-measuring, it is where this
      // tag's position came from — drawn differently so the two are not read as
      // the same claim.
      ctx.setLineDash(kind === 'chain' ? [2, 5] : [4, 4]);
      ctx.strokeStyle = kind === 'chain' ? '#6a5a3c' : '#3c4654';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(cx, cy);
      ctx.lineTo(bx, by);
      ctx.stroke();
      const legColor = kind === 'chain' ? '#a08a5c' : '#6b7789';
      // Only where there is room for it: at three neighbours a tag these labels
      // outnumber everything else on screen, and a leg a few pixels long says
      // nothing worth crowding the view for.
      for (const [x1, y1, x2, y2] of [[ax, ay, cx, cy], [cx, cy, bx, by]]) {
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 34) continue;
        // Back through the scale rather than from the world points: the leg is
        // axis-aligned on screen, so its pixel length is its world length.
        queueLabel((len / scale).toFixed(2), (x1 + x2) / 2, (y1 + y2) / 2 - 3, legColor);
      }
    }
    ctx.setLineDash([]);

    // Markers: a stroke along the tag's x axis, projected.
    const half = (markerMap?.sizeM || 0.15) / 2;
    lastGlyphs = [];
    for (const [id, m] of markers) {
      const end1 = m.pos.map((v, i) => v - m.ax3[i] * half);
      const end2 = m.pos.map((v, i) => v + m.ax3[i] * half);
      const [x1, y1] = px(end1);
      const [x2, y2] = px(end2);
      // One colour per tag, shared by the stroke and the label chip, so the
      // chip reads as a name for exactly that mark. The anchor keeps its
      // gold — it is the datum, and the gold is what says so.
      const tagColor = id === markerMap?.anchorId ? '#d4b34c' : roomTagColorCss(id);
      const hot = id === hoverId;
      // A halo under the stroke rather than a different colour on it: the tag
      // colour is the tag's identity here and in the drawer, and swapping it to
      // say "hovered" would break the one thing that ties the two together.
      if (hot) {
        ctx.strokeStyle = HOVER_HALO_CSS;
        ctx.lineWidth = 12;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.lineCap = 'butt';
      }
      ctx.strokeStyle = tagColor;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      obstacles.push({ x1, y1, x2, y2, r: 3 });
      // The id is part of the tag glyph: a chip sitting on the bar itself,
      // rotated with it, so the label and the mark can never drift apart and
      // the bar's orientation stays readable through the chip. Kept out of
      // the dodging label pass — a name printed on the thing it names has
      // nowhere better to be.
      let ang = Math.atan2(y2 - y1, x2 - x1);
      // Never upside down.
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      const idText = String(id);
      const chipHalf = ctx.measureText(idText).width / 2 + 4;
      const [mx, my] = px(m.pos);
      // Beside the bar rather than over it, on the wall's outside, close
      // enough that chip and bar touch: chip half-height 7 plus the bar's
      // half-width 2. Which local side is "outside" comes from projecting the
      // anti-normal into the rotated frame.
      const nh = Math.hypot(m.normal[0], m.normal[2]);
      let side = -1;
      if (nh > 0.3) {
        const [ox, oy] = px([
          m.pos[0] - m.normal[0] / nh * 0.1,
          m.pos[1],
          m.pos[2] - m.normal[2] / nh * 0.1,
        ]);
        const localY = -Math.sin(ang) * (ox - mx) + Math.cos(ang) * (oy - my);
        side = localY >= 0 ? 1 : -1;
      }
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(ang);
      if (hot) {
        ctx.strokeStyle = HOVER_HALO_CSS;
        ctx.lineWidth = 3;
        ctx.strokeRect(-chipHalf - 2, side * 9 - 9, chipHalf * 2 + 4, 18);
      }
      ctx.fillStyle = tagColor;
      ctx.fillRect(-chipHalf, side * 9 - 7, chipHalf * 2, 14);
      ctx.fillStyle = '#fff';
      ctx.fillText(idText, 0, side * 9 + 4);
      ctx.restore();

      // The glyph as drawn, for the hit test. Recorded here so the shape the
      // pointer is tested against is the shape on screen — the chip's offset
      // and rotation are worked out once, above, and never a second time.
      lastGlyphs.push({
        id,
        x1,
        y1,
        x2,
        y2,
        chip: {
          cx: mx - Math.sin(ang) * side * 9,
          cy: my + Math.cos(ang) * side * 9,
          ang,
          halfW: chipHalf,
          halfH: 7,
        },
      });
    }

    // Clients: dot + heading + label, lines to the tags they see.
    for (const ph of clients.values()) {
      if (!ph.target) continue;
      const stale = performance.now() - ph.at > ROOM_POSE_STALE_MS;
      const color = stale ? '#555' : ph.color;
      // With the pose hidden, heading, label, tag lines and distances all
      // anchor on the circle's centre — a line from an invisible point would
      // read as a stray mark.
      const anchorP = showPose ? ph.cur.p : (ph.ringAt || ph.cur.p);
      const [sx, sy] = px(anchorP);

      // Uncertainty first, so the dot and heading draw on top of it.
      const rPx = ph.shownRadius * scale;
      if (rPx > RADIUS_MIN_PX) {
        const [ux, uy] = px(ph.ringAt || ph.cur.p);
        ctx.beginPath();
        ctx.arc(ux, uy, rPx, 0, Math.PI * 2);
        ctx.fillStyle = stale ? 'rgba(85,85,85,0.10)' : `${ph.color}22`;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (!showPose) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, RING_DOT_PX, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!stale) {
        for (const id of ph.seen) {
          const m = markers.get(id);
          if (!m) continue;
          const [tx, ty] = px(m.pos);
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.5;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.globalAlpha = 1;
          // Distance and viewing angle in full 3D — the views are
          // projections, the geometry is not.
          const d = anchorP.map((v, i) => v - m.pos[i]);
          const dist = Math.hypot(...d);
          const cosA = dist > 1e-6
            ? (d[0] * m.normal[0] + d[1] * m.normal[1] + d[2] * m.normal[2]) / dist
            : 1;
          const ang = Math.acos(Math.min(1, Math.max(-1, Math.abs(cosA)))) * 180 / Math.PI;
          queueLabel(`${dist.toFixed(2)} m · ${Math.round(ang)}°`,
            (sx + tx) / 2, (sy + ty) / 2 - 4, roomAngleColor(ang));
        }
      }

      // Heading: a 0.2 m world-space arrow through the projection, so it
      // means the same thing in every view.
      const tip = anchorP.map((v, i) => v + ph.cur.fwd[i] * 0.2);
      const [hx, hy] = px(tip);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      if (showPose) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      const [pa, pb] = proj(anchorP);
      queueLabel(`C${ph.id} · ${pa.toFixed(2)}, ${pb.toFixed(2)}`, sx, sy - 12, color);
    }

    flushLabels();
    schedule();
  }

  function schedule() {
    if (!rafPending && active) {
      rafPending = true;
      requestAnimationFrame(draw);
    }
  }

  return {
    setActive(on) {
      active = on;
      if (on) {
        lastFrameAt = 0;
        schedule();
      }
    },

    setShowPose(on) {
      showPose = on;
      schedule();
    },

    setHoveredMarker(id) {
      if (id === hoverId) return;
      hoverId = id;
      schedule();
    },

    setMarkerMap(map) {
      markerMap = map;
      markers.clear();
      // Derived here rather than per frame, and from the shared helper, so the
      // legs drawn here and the distances listed in the client drawer can never
      // disagree about which tags are neighbours.
      pairs = markerNeighbourhood(map).pairs;
      if (!map) return;
      for (const m of map.markers) {
        markers.set(m.id, {
          pos: m.p,
          normal: quatRotate(m.q, [0, 0, 1]),
          ax3: quatRotate(m.q, [1, 0, 0]),
        });
      }
    },

    // `uncertainty` is { r, p }: the radius of the "probably here" circle and
    // the point it is centred on. They are one measurement, and neither is the
    // pose — the pose is the newest single reading, the circle is the spread
    // the readings scattered over, so the circle moves far less than the dot.
    // A null p (non-XR client, or no window yet) falls back to the pose.
    updateClient(clientId, pose, seenTagIds = [], uncertainty = null) {
      let ph = clients.get(clientId);
      if (!ph) {
        ph = {
          id: clientId,
          color: roomClientColorCss(clientId),
          cur: { p: [...pose.p], fwd: [0, 0, 1] },
          target: null, seen: [], at: 0,
          uncertaintyM: 0, shownRadius: 0,
          ringTarget: null, ringAt: null, ringSeeded: false,
        };
        clients.set(clientId, ph);
      }
      ph.target = pose;
      ph.seen = seenTagIds;
      ph.uncertaintyM = uncertainty?.r ?? 0;
      ph.ringTarget = uncertainty?.p ?? pose.p;
      ph.at = performance.now();
    },

    removeClient(clientId) {
      clients.delete(clientId);
    },

    // Full snapshot each time ({ cellM, free: [ix,iz,...], occ: [ix,iz,...] });
    // pre-rendered here once rather than per frame in draw().
    setFloor(f) {
      if (!f || (!f.free.length && !f.occ.length)) {
        floor = null;
        schedule();
        return;
      }
      let minIx = Infinity;
      let maxIx = -Infinity;
      let minIz = Infinity;
      let maxIz = -Infinity;
      const scan = (arr) => {
        for (let i = 0; i < arr.length; i += 2) {
          minIx = Math.min(minIx, arr[i]); maxIx = Math.max(maxIx, arr[i]);
          minIz = Math.min(minIz, arr[i + 1]); maxIz = Math.max(maxIz, arr[i + 1]);
        }
      };
      scan(f.free);
      scan(f.occ);
      const cw = maxIx - minIx + 1;
      const ch = maxIz - minIz + 1;
      const cnv = document.createElement('canvas');
      cnv.width = cw;
      cnv.height = ch;
      const c = cnv.getContext('2d');
      const paint = (arr, css) => {
        c.fillStyle = css;
        for (let i = 0; i < arr.length; i += 2) {
          c.fillRect(arr[i] - minIx, arr[i + 1] - minIz, 1, 1);
        }
      };
      paint(f.free, FLOOR_FREE_CSS);
      paint(f.occ, FLOOR_OCC_CSS);
      // The rim of the carved region — free cells touching unknown — drawn a
      // shade brighter: it is where a wall *may* be, the tentative counterpart
      // of the asserted wall segments. Computed here (not per frame) because
      // it only changes when a snapshot arrives.
      const known = new Set();
      // Same ±2048 packing as the server grid — a plain ix*K+iz collides for
      // negative indices.
      const keyOf = (ix, iz) => (ix + 2048) * 4096 + (iz + 2048);
      for (let i = 0; i < f.free.length; i += 2) known.add(keyOf(f.free[i], f.free[i + 1]));
      for (let i = 0; i < f.occ.length; i += 2) known.add(keyOf(f.occ[i], f.occ[i + 1]));
      c.fillStyle = FLOOR_EDGE_CSS;
      for (let i = 0; i < f.free.length; i += 2) {
        const ix = f.free[i];
        const iz = f.free[i + 1];
        if (!known.has(keyOf(ix + 1, iz)) || !known.has(keyOf(ix - 1, iz))
          || !known.has(keyOf(ix, iz + 1)) || !known.has(keyOf(ix, iz - 1))) {
          c.fillRect(ix - minIx, iz - minIz, 1, 1);
        }
      }
      // The packed free-cell set rides along for point lookups — label
      // placement wants "is this world point carved free".
      const freeKeys = new Set();
      for (let i = 0; i < f.free.length; i += 2) {
        freeKeys.add(keyOf(f.free[i], f.free[i + 1]));
      }
      floor = { cellM: f.cellM, minIx, minIz, w: cw, h: ch, canvas: cnv, freeKeys, keyOf };
      schedule();
    },

    setWalls(next) {
      walls = next || [];
      schedule();
    },

    setLayer(name, on) {
      if (name === 'walls') {
        showWalls = on;
        schedule();
      }
    },

  };
}
