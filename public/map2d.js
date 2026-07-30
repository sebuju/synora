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
  // World->pixel mapping of the last drawn frame, for hit tests.
  let lastPx = null;
  // Right-angle legs between neighbouring tags, derived once per map.
  let pairs = [];

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
  canvas.addEventListener('pointermove', (ev) => {
    if (!drag || drag.id !== ev.pointerId || !view) return;
    view.ca -= (ev.clientX - drag.x) / view.scale;
    view.cb -= orient * (ev.clientY - drag.y) / view.scale;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    schedule();
  });
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
    if (lastPx && onMarkerDblClick) {
      for (const [id, m] of markers) {
        const [mx, my] = lastPx(m.pos);
        if (Math.hypot(ev.offsetX - mx, ev.offsetY - my) < 14) {
          onMarkerDblClick(id);
          return;
        }
      }
    }
    view = null;
    schedule();
  });

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
      ctx.fillStyle = roomAxisColorCss(k);
      // Pushed a further tenth along its own direction, so the letter sits off
      // the end of the arm rather than on top of the other one's.
      const [lx, ly] = px(end.map((v) => v * 1.25));
      ctx.fillText(ROOM_AXIS_NAMES[k], lx, ly + 4);
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
      ctx.fillStyle = kind === 'chain' ? '#a08a5c' : '#6b7789';
      // Only where there is room for it: at three neighbours a tag these labels
      // outnumber everything else on screen, and a leg a few pixels long says
      // nothing worth crowding the view for.
      for (const [x1, y1, x2, y2] of [[ax, ay, cx, cy], [cx, cy, bx, by]]) {
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 34) continue;
        // Back through the scale rather than from the world points: the leg is
        // axis-aligned on screen, so its pixel length is its world length.
        ctx.fillText((len / scale).toFixed(2), (x1 + x2) / 2, (y1 + y2) / 2 - 3);
      }
    }
    ctx.setLineDash([]);

    // Markers: a stroke along the tag's x axis, projected.
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
          ctx.fillStyle = roomAngleColor(ang);
          ctx.fillText(`${dist.toFixed(2)} m · ${Math.round(ang)}°`,
            (sx + tx) / 2, (sy + ty) / 2 - 4);
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
      ctx.fillStyle = color;
      const [pa, pb] = proj(anchorP);
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

    setShowPose(on) {
      showPose = on;
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

  };
}
