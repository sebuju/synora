'use strict';

// Orthographic 2D room views, one renderer for both projections:
//   'top'  — the floor plan, x-z plane (y collapsed)
//   'side' — the elevation, x-y plane (z collapsed), y drawn upward
// Same data feeds as the 3D scene — markers and client poses — rendered
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
  const SMOOTH_TAU_MS = 120;
  // Measured spread of the recent fixes, drawn rather than hidden: a bare dot
  // claims a precision the fix does not have. Same convention as the 3D ring —
  // 2x the rms so it reads as "probably in here", smoothed so the circle does
  // not pulse with its own measurement window.
  const UNCERTAINTY_SIGMA = 2;
  const RADIUS_TAU_MS = 400;
  const RADIUS_MIN_PX = 3;
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
      ctx.fillText(`C${ph.id} · ${pa.toFixed(2)}, ${pb.toFixed(2)}`, sx, sy - 12);
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

  };
}
