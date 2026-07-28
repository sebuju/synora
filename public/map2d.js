'use strict';

// Orthographic 2D room views, one renderer for both projections:
//   'top'  — the floor plan, x-z plane (y collapsed)
//   'side' — the elevation, x-y plane (z collapsed), y drawn upward
// Same data feeds as the 3D scene — markers, client poses, voxels — rendered
// with plain canvas 2D. Viewport auto-fits whatever exists.

function createMap2dView(canvas, mode = 'top', { onMarkerDblClick } = {}) {
  const ctx = canvas.getContext('2d');
  // Projection of a room-frame point onto this view's two axes; the second
  // axis is drawn downward for the floor plan and upward for the elevation.
  const proj = mode === 'side'
    ? (p) => [p[0], p[1]]
    : (p) => [p[0], p[2]];
  const orient = mode === 'side' ? -1 : 1;

  let active = false;
  let markerMap = null;
  // id -> { pos:[3], normal:[3], ax3:[3] (marker x-axis, room frame) }
  const markers = new Map();
  // clientId -> { target, cur {p:[3], fwd:[3]}, seen, at, color }
  const clients = new Map();
  // Voxels collapse along the unviewed axis: "ai,bi" -> count. Column
  // density is all a projection needs, and it survives removals cheaply.
  const columns = new Map();
  let voxelSize = 0.075;
  // Wall segments fitted by the server: { a:[x,z], b:[x,z], y0, y1 }.
  let walls = [];
  const SMOOTH_TAU_MS = 120;
  // Only voxels near this view's plane are shown — a full-room projection
  // stacks everything into an unreadable smear. The slab is centered on the
  // room origin's plane: height for the floor plan, the anchor-wall-parallel
  // plane for the elevation.
  const SLAB_M = 1.0;
  const slabCoord = mode === 'side' ? (v) => v[2] : (v) => v[1];

  function colKey(v) {
    const [a, b] = proj(v);
    return `${Math.floor(a / voxelSize)},${Math.floor(b / voxelSize)}`;
  }

  let rafPending = false;
  let lastFrameAt = 0;
  // World->pixel mapping of the last drawn frame, for hit tests.
  let lastPx = null;

  if (onMarkerDblClick) {
    canvas.addEventListener('dblclick', (ev) => {
      if (!lastPx) return;
      for (const [id, m] of markers) {
        const [mx, my] = lastPx(m.pos);
        if (Math.hypot(ev.offsetX - mx, ev.offsetY - my) < 14) {
          onMarkerDblClick(id);
          return;
        }
      }
    });
  }

  function draw(now) {
    rafPending = false;
    if (!active) return;
    const dt = lastFrameAt ? now - lastFrameAt : 16;
    lastFrameAt = now;

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
    for (const key of columns.keys()) {
      const [ai, bi] = key.split(',').map(Number);
      grow(ai * voxelSize, bi * voxelSize);
    }
    for (const wl of walls) {
      if (mode === 'side') {
        grow(wl.a[0], wl.y0);
        grow(wl.b[0], wl.y1);
      } else {
        grow(wl.a[0], wl.a[1]);
        grow(wl.b[0], wl.b[1]);
      }
    }
    const spanA = Math.max(maxA - minA, 5);
    const spanB = Math.max(maxB - minB, 5);
    const scale = Math.min((w - 60) / spanA, (h - 60) / spanB);
    const ca = (minA + maxA) / 2;
    const cb = (minB + maxB) / 2;
    const toPx = (a, b) => [(a - ca) * scale + w / 2, orient * (b - cb) * scale + h / 2];
    const px = (p) => toPx(...proj(p));
    lastPx = px;

    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, w, h);

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

    // Voxel columns, darker with density.
    const cell = Math.max(2, voxelSize * scale);
    for (const [key, count] of columns) {
      const [ai, bi] = key.split(',').map(Number);
      const [sx, sy] = toPx(ai * voxelSize, bi * voxelSize);
      ctx.fillStyle = `rgba(127, 184, 164, ${Math.min(0.9, 0.2 + count / 12)})`;
      ctx.fillRect(sx, sy, cell, cell);
    }

    // Wall layer: the fitted room shell over the raw voxel columns. The
    // elevation draws each wall as its face rectangle (an end-on wall
    // collapses to a sliver); the floor plan draws the segment itself.
    if (mode === 'side') {
      ctx.strokeStyle = '#dfe7ea';
      ctx.fillStyle = 'rgba(223, 231, 234, 0.10)';
      ctx.lineWidth = 1.5;
      for (const wl of walls) {
        const [x1, yTop] = toPx(Math.min(wl.a[0], wl.b[0]), wl.y1);
        const [x2, yBot] = toPx(Math.max(wl.a[0], wl.b[0]), wl.y0);
        const wpx = Math.max(x2 - x1, 3);
        ctx.fillRect(x1, yTop, wpx, yBot - yTop);
        ctx.strokeRect(x1, yTop, wpx, yBot - yTop);
      }
    } else if (walls.length) {
      ctx.strokeStyle = '#dfe7ea';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const wl of walls) {
        ctx.moveTo(...toPx(wl.a[0], wl.a[1]));
        ctx.lineTo(...toPx(wl.b[0], wl.b[1]));
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // Markers: a stroke along the tag's x axis, projected.
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const half = (markerMap?.sizeM || 0.15) / 2;
    for (const [id, m] of markers) {
      const end1 = m.pos.map((v, i) => v - m.ax3[i] * half);
      const end2 = m.pos.map((v, i) => v + m.ax3[i] * half);
      const [x1, y1] = px(end1);
      const [x2, y2] = px(end2);
      ctx.strokeStyle = id === markerMap?.anchorId ? '#d4b34c' : '#cccccc';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const [lx, ly] = px(m.pos);
      ctx.fillStyle = '#eee';
      ctx.fillText(String(id), lx, ly - 8);
    }

    // Clients: dot + heading + label, lines to the tags they see.
    for (const ph of clients.values()) {
      if (!ph.target) continue;
      const stale = performance.now() - ph.at > ROOM_POSE_STALE_MS;
      const color = stale ? '#555' : ph.color;
      const [sx, sy] = px(ph.cur.p);

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
          const d = ph.cur.p.map((v, i) => v - m.pos[i]);
          const dist = Math.hypot(...d);
          const cosA = dist > 1e-6
            ? (d[0] * m.normal[0] + d[1] * m.normal[1] + d[2] * m.normal[2]) / dist
            : 1;
          const ang = Math.acos(Math.min(1, Math.max(-1, Math.abs(cosA)))) * 180 / Math.PI;
          ctx.fillStyle = roomAngleColor(ang);
          ctx.fillText(`${dist.toFixed(2)} m · ${Math.round(ang)}°`,
            (sx + tx) / 2, (sy + ty) / 2 - 4);
        }
      }

      // Heading: a 0.4 m world-space arrow through the projection, so it
      // means the same thing in every view.
      const tip = ph.cur.p.map((v, i) => v + ph.cur.fwd[i] * 0.4);
      const [hx, hy] = px(tip);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.fill();
      const [pa, pb] = proj(ph.cur.p);
      ctx.fillText(`C${ph.id} · ${pa.toFixed(1)}, ${pb.toFixed(1)}`, sx, sy - 12);
    }

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

    setMarkerMap(map) {
      markerMap = map;
      markers.clear();
      if (!map) return;
      for (const m of map.markers) {
        markers.set(m.id, {
          pos: m.p,
          normal: quatRotate(m.q, [0, 0, 1]),
          ax3: quatRotate(m.q, [1, 0, 0]),
        });
      }
    },

    updateClient(clientId, pose, seenTagIds = []) {
      let ph = clients.get(clientId);
      if (!ph) {
        const colorHex = ROOM_CLIENT_COLORS[clientId % ROOM_CLIENT_COLORS.length];
        ph = {
          id: clientId,
          color: `#${colorHex.toString(16).padStart(6, '0')}`,
          cur: { p: [...pose.p], fwd: [0, 0, 1] },
          target: null, seen: [], at: 0,
        };
        clients.set(clientId, ph);
      }
      ph.target = pose;
      ph.seen = seenTagIds;
      ph.at = performance.now();
    },

    removeClient(clientId) {
      clients.delete(clientId);
    },

    setWalls(next) {
      walls = next || [];
    },

    applyVoxels({ voxelSizeM, added = [], removed = [], reset = false }) {
      if (reset || (voxelSizeM && voxelSizeM !== voxelSize)) {
        columns.clear();
        if (voxelSizeM) voxelSize = voxelSizeM;
      }
      for (const v of added) {
        if (Math.abs(slabCoord(v)) > SLAB_M) continue;
        const key = colKey(v);
        columns.set(key, (columns.get(key) || 0) + 1);
      }
      for (const v of removed) {
        if (Math.abs(slabCoord(v)) > SLAB_M) continue;
        const key = colKey(v);
        const n = (columns.get(key) || 0) - 1;
        if (n <= 0) columns.delete(key);
        else columns.set(key, n);
      }
    },
  };
}
