'use strict';

// Orthographic 2D room views, one renderer for all three projections:
//   'top'   — the floor plan, x-z plane (y collapsed)
//   'side'  — an elevation, x-y plane (z collapsed), y drawn upward
//   'front' — the other elevation, z-y plane (x collapsed), y drawn upward
// Same data feeds as the 3D scene — markers and client poses — rendered
// with plain canvas 2D. Viewport auto-fits whatever exists.
//
// A view is described by the pair of room axes it keeps, and everything that
// differs between them is derived from that pair — a wall between two elevations
// differs only in which room axis runs across the screen, and asking which mode
// is running at each such spot is how the first elevation ended up with its own
// half-copies of code the floor plan already had.

// `raf` is injectable because the XR client draws this map from inside an
// immersive-AR session, where the page's own requestAnimationFrame is not
// guaranteed to run — there the session's frame loop drives it instead.
// Ceiling on the drawn canvas's backing store, in pixels — about 16 MB of
// RGBA. Comfortably above a desktop map at DPR 2 and a phone screen at DPR 3,
// and below what an Android renderer will refuse to allocate.
const MAX_BACKING_PX = 4e6;

// The room-axis gizmo: arm length, the gap from the end of an arm to its
// letter, half a line of text, and the inset of the whole thing from the bottom
// left corner, all in screen pixels. Fixed size rather than `ROOM_AXIS_LEN_M` on
// the world scale — pinned to the corner it is no longer a ruler standing at the
// origin, and a half-metre arm shrinks to nothing on a map zoomed out to a whole
// flat. The letter is pushed a flat gap past the end rather than a fraction of
// the arm: a fraction leaves it sitting on the line it belongs to, since the
// text is centred on the point it is given and half its height reaches back over
// the stroke. The three lengths add up to how far the gizmo reaches from its
// elbow, which is what the corner is measured against.
// Each view by the pair of room axes it keeps: the one running across the
// screen and the one running up it. The whole difference between the three
// projections.
const VIEW_AXES = { top: [0, 2], side: [0, 1], front: [2, 1] };

const AXIS_GIZMO_PX = 26;
const AXIS_GIZMO_LABEL_PX = 14;
const AXIS_GIZMO_TEXT_PX = 7;
const AXIS_GIZMO_PAD = 12;

function createMap2dView(canvas, mode = 'top', {
  onMarkerHover, raf, maxPixels, pairsFocusOnly,
} = {}) {
  const ctx = canvas.getContext('2d');
  const nextFrame = raf || ((cb) => requestAnimationFrame(cb));
  // A caller that is paying for every pixel twice — once to draw, once for the
  // compositor to lift a full-screen layer over camera passthrough every frame
  // — can buy sharpness back down. See MAX_BACKING_PX.
  const maxBackingPx = maxPixels || MAX_BACKING_PX;
  // The two room axes this view keeps, across the screen and up it.
  const [axisA, axisB] = VIEW_AXES[mode] || VIEW_AXES.top;
  const elevation = axisB === 1;
  // Projection of a room-frame point onto those two axes; the second axis is
  // drawn downward for the floor plan and upward for an elevation.
  const proj = (p) => [p[axisA], p[axisB]];
  const orient = elevation ? -1 : 1;
  // Wall segments carry their footprint as [x, z] pairs, so the room axis
  // running across an elevation indexes into them one place lower than it does
  // into a position.
  const segA = axisA === 2 ? 1 : 0;

  let active = false;
  let markerMap = null;
  // Screen pixels along the bottom and left edges that the page has covered with
  // chrome of its own — the XR client's button row sits over the canvas, and on
  // a turned overlay the phone's status bar runs along one of these edges. The
  // corner gizmo is the one thing drawn against the canvas edge rather than
  // against the room, so it is the one thing that has to know. The page owns
  // both numbers because only the page can see what it put there.
  let chromeBottomPx = 0;
  let chromeLeftPx = 0;
  // On: dot at the reported pose. Off (default): the pose point is hidden and
  // everything anchors on the uncertainty circle's centre instead — the circle
  // is the steadier claim, and sometimes it is the only one wanted.
  let showPose = false;
  // Eased 0..1 toward showPose: the two anchor points are metres apart, so
  // flipping the switch teleports every line hanging off it.
  let poseMix = 0;
  // id -> { pos:[3], q:[4], tp:[3], tq:[4], fade, dead, hot, anchorMix }
  // Position and orientation are kept as the raw pose and interpolated toward
  // the map's, rather than stored pre-rotated: a normal cannot be interpolated
  // back into a rotation, and the map moves tags whenever the survey refines,
  // re-seeds or forgets one. The drawn vectors are derived per frame instead.
  const markers = new Map();
  // clientId -> { target, cur {p:[3], fwd:[3]}, seen, at, color }
  const clients = new Map();
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
  // Smaller than anything else on the map that means something, on purpose.
  const LANDMARK_DOT_PX = 1.4;
  // A candidate is not a landmark: it is one track's current guess at where a
  // feature is, and most of them never become anything. Drawn as an open ring
  // rather than a dot so the two never read as the same class of thing at a
  // glance, and dimmer again than the anchors are.
  const CANDIDATE_DOT_PX = 2.2;
  // How far a candidate's arc has to have come before it is drawn at full
  // strength. Faint means barely seen, solid means nearly an anchor — which is
  // the whole reason to draw candidates at all, since the number of them says
  // nothing and their progress says everything.
  const CANDIDATE_MIN_ALPHA = 0.18;
  // The guidance. Deliberately a colour nothing else on the map uses: it is an
  // instruction, not a thing in the room, and it must not read as a tag, a
  // client or a wall. White would be the hover halo; a client colour would say
  // "this belongs to that client".
  const GUIDE_CSS = '#ffd166';
  const GUIDE_RING_M = 0.35;
  const GUIDE_RING_MIN_PX = 9;
  const GUIDE_HEAD_PX = 9;
  const HOVER_MS = 120;
  let rafPending = false;
  let lastFrameAt = 0;
  // The tag glyphs of the last drawn frame, in pixels: the bar and the id chip,
  // exactly as they were stroked. Hit tests read this rather than re-deriving a
  // radius around the tag's centre — the glyph is a rotated bar with a chip
  // beside it, so a circle around the middle both misses the chip and claims
  // empty space at either end of a bar seen edge-on.
  // [{ id, x1, y1, x2, y2, chip: { cx, cy, ang, halfW, halfH } }]
  let lastGlyphs = [];
  // text -> half its width in pixels, for the label dodge. Lives across frames:
  // the font never changes, so a string measured once is measured for good.
  const textHalfWidths = new Map();
  // Which tag is highlighted. Set from outside only: the drawer and both map
  // views highlight the same tag at once, so the one place that can know is the
  // viewer, and every renderer here is told rather than deciding for itself.
  let hoverId = null;
  // Which tag the reader has opened, told from outside for the same reason the
  // hover is. With `pairsFocusOnly` the legs are the opened tag's own: a room of
  // a dozen tags draws a leg and two labels for every one of them, which is
  // clutter until a particular tag is the question — and then only that tag's
  // distances are the answer. A page with no way to open a tag (the XR client)
  // leaves the option off and keeps the whole neighbourhood.
  let focusId = null;
  // Right-angle legs between neighbouring tags, derived once per map.
  let pairs = [];
  // Per-pair 0..1, keyed by the pair rather than held on it: the map object is
  // replaced several times a second while a survey is running and `pairs` is
  // rebuilt with it, so a fade living on the entry would restart on every
  // refinement and no leg would ever finish appearing.
  const pairFades = new Map();
  // Which dodge offset each label settled on last frame, keyed by what the
  // label is about — see flushLabels.
  const labelSpots = new Map();
  const labelSeen = new Set();
  // Carved free-space grid, pre-rendered to a one-pixel-per-cell offscreen
  // canvas on arrival: the draw loop runs every frame and a few thousand
  // fillRects per frame is exactly the cost drawImage exists to avoid.
  let floor = null;      // { cellM, minIx, minIz, w, h, canvas }
  // The snapshot being faded out from under it. A carve arrives as a whole new
  // raster with no per-cell identity, so the only honest way to show what
  // changed is to cross-fade the two images — each drawn from its own origin,
  // so a grown grid grows in place. A snapshot arriving mid-fade simply becomes
  // the new outgoing one.
  let prevFloor = null;
  let floorMix = 1;
  // Live wall segments, matched to each arriving snapshot rather than replaced:
  // shown a/b/y0/y1 ease toward the target ones, fade covers birth and death.
  let walls = [];
  let nextWallKey = 1;
  let showWalls = true;
  let wallsAlpha = 1;
  // Per-client landmark anchors: clientId -> [[x,y,z], ...]. Points only, and
  // drawn as such — a landmark has no orientation, no extent and no identity
  // worth a label, and it is a great deal less trustworthy than a surveyed tag.
  // The whole point of the styling below is that the two can never be confused.
  let landmarks = [];
  let showLandmarks = true;
  let landmarksAlpha = 1;
  // Candidates ride the same message but a separate toggle: there are an order
  // of magnitude more of them than anchors and they move as they are refined, so
  // a reader who wants to see the map the survey has settled on wants them off,
  // and one asking why nothing is qualifying wants only them.
  let showCandidates = false;
  let candidatesAlpha = 0;
  // Where to walk next, as the server worked it out for this client (see
  // `guide` in landmarks.js). Only the phone sets one — it is an instruction to
  // the person holding the camera, and an instruction on the dashboard would be
  // addressed to someone who cannot follow it.
  let guide = null;
  let guideAlpha = 0;
  // The dark backdrop and the 1 m grid it carries: everything that is only
  // there to be drawn *on*. Turned off, the canvas is cleared instead of
  // filled, so whatever is behind it shows through — on the XR client that is
  // the camera passthrough, and the map becomes a HUD over the room rather than
  // a picture of it. Faded rather than switched for the same reason every other
  // toggle here is.
  let showBackdrop = true;
  let backdropAlpha = 1;
  // The right-angle legs between neighbouring tags and their length labels.
  // Separate from the backdrop because they are a different kind of clutter —
  // the backdrop is what the room is drawn on, these are a measurement drawn
  // over it — and a caller may want the room without either.
  let showPairs = true;
  let pairsAlpha = 1;
  // Heading-up: the map turns and the client marker stops turning, instead of
  // the other way round. Held as the angle the whole drawing is rotated by,
  // eased like everything else — heading comes off a live pose and a map that
  // tracked it frame for frame would shiver. Only the floor plan can do this;
  // an elevation has no heading to be up.
  //
  // The centre goes with it, and is set by the same call: the drawing is turned
  // about the middle of the canvas, so a map that turned to a pose it was not
  // also centred on would spin about a point that is nothing in particular
  // while the marker orbited it. One setter, so the two can never disagree
  // about which pose the view is built around.
  let headingRad = null;   // null: north up, the room frame's own orientation
  let headingPos = null;   // null: the fit's own bounds, centred on the room
  let viewRot = 0;
  const HEADING_TAU_MS = 260;
  const FLOOR_FREE_CSS = 'rgba(127,184,164,0.16)';
  const FLOOR_OCC_CSS = 'rgba(223,120,100,0.25)';
  const FLOOR_EDGE_CSS = 'rgba(190,208,200,0.35)';
  // Deduced obstructions (blocked sight lines, enclosed never-visited
  // pockets): inferred, not measured — amber, the same standing the dashed
  // inferred walls have against asserted ones.
  const FLOOR_DEDUCED_CSS = 'rgba(212,168,90,0.30)';
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
  //
  // Both `view` and `lastFit` are *targets*. What is actually drawn is `shown`,
  // which eases toward whichever of them is in force: a tag being surveyed, a
  // layer being toggled or a wheel notch all move the viewport, and the eye
  // cannot follow a viewport that teleports. Panning is the exception — a drag
  // is direct manipulation and writes both, or the map lags the pointer.
  let view = null;
  let lastFit = null;
  let shown = null;
  const ZOOM_STEP = 1.15;
  const ZOOM_OUT_LIMIT = 0.05;   // times the fit
  const ZOOM_IN_LIMIT = 200;

  // Seeded from what is on screen, not from the fit it is easing toward: a
  // grab that lands mid-ease must continue from where the user can see, or the
  // view jumps forward to the fit the moment it is touched.
  function takeOver() {
    if (!view && (shown || lastFit)) view = { ...(shown || lastFit) };
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
  //
  // Right button, matching the 3D view — OrbitControls pans on the right button
  // and orbits on the left, and one map panning with a gesture the other one
  // does something else with is worse than either choice. It leaves the left
  // button free on the canvas, and costs the touch drag: a touch pointer has no
  // button 2. Zoom is still the wheel, so a mouse loses nothing.
  const PAN_BUTTON = 2;
  let drag = null;
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== PAN_BUTTON || !takeOver()) return;
    drag = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    canvas.setPointerCapture(ev.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  // Or the menu opens on the button that starts the pan, over the map it is
  // panning, and the drag never gets its pointerup.
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  // Distance from a point to a segment, not to its infinite line: a tag bar is
  // 150 mm of wall and the line it lies on runs the length of the room.
  // Ids in the order the shared helper produced them — it deduplicates a pair
  // to one entry, so the key is that entry's identity and needs no sorting.
  const pairKey = (p) => `${p.kind}:${p.a.id}-${p.b.id}`;

  const pairShown = (p) =>
    !pairsFocusOnly || (focusId !== null && (p.a.id === focusId || p.b.id === focusId));

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
    // Written to the drawn view as well as the target, against the scale that
    // is actually on screen: a drag is the pointer moving the paper, and paper
    // that eases after the finger reads as broken rather than as smooth.
    const da = (ev.clientX - drag.x) / (shown ? shown.scale : view.scale);
    const db = orient * (ev.clientY - drag.y) / (shown ? shown.scale : view.scale);
    view.ca -= da;
    view.cb -= db;
    if (shown) {
      shown.ca -= da;
      shown.cb -= db;
    }
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

  // Gives the auto-fit back, everywhere on the canvas. It used to forget a tag
  // when the double-click landed on one — one gesture with two meanings, on a
  // target a few pixels across; forgetting a tag is the drawer card's button
  // now, where it confirms.
  canvas.addEventListener('dblclick', () => {
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

  // The guidance, drawn as the ground to cover rather than as a label about it.
  //
  // Everything here is built from *room* points and pushed through the view's
  // own projection, never from screen-space trigonometry: this renderer serves
  // three projections and a rotating phone screen, and an arc computed in
  // pixels would be right in exactly one of them.
  //
  // The azimuth convention is the survey's (`azimuthOf` in landmark-math.js):
  // atan2(x - Px, z - Pz), so a point at azimuth A and radius r sits at
  // (Px + r sin A, Pz + r cos A). Two definitions of that would put the arrow
  // on the wrong side of the room, which is the one error that would be
  // actively misleading rather than merely unhelpful.
  function drawGuide(px, g, alpha) {
    const rad = (deg) => deg * Math.PI / 180;
    const at = (A, r) => [g.p[0] + r * Math.sin(rad(A)), g.p[1], g.p[2] + r * Math.cos(rad(A))];
    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeStyle = GUIDE_CSS;
    ctx.fillStyle = GUIDE_CSS;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    // The target itself: a ring on the ground under the cluster, sized in world
    // metres so it reads as a place rather than as a screen decoration.
    const [tx, ty] = px(g.p);
    const ringPx = Math.max(GUIDE_RING_MIN_PX, GUIDE_RING_M * shown.scale);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(tx, ty, ringPx, 0, Math.PI * 2);
    ctx.stroke();

    if (g.mode === 'arc') {
      // From where they stand to where the arc becomes wide enough, swept the
      // way the server said — `dir` is not recoverable from the endpoints,
      // since either way round joins them and one of the two re-walks ground
      // the track already has.
      let delta = ((g.to - g.from) % 360 + 360) % 360;
      if (g.dir < 0) delta -= 360;
      const steps = Math.max(8, Math.ceil(Math.abs(delta) / 6));
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const [x, y] = px(at(g.from + delta * (i / steps), g.radius));
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
      // Arrowhead at the far end, built from the last step of the sweep so it
      // points along the walk in whatever projection this is.
      const end = px(at(g.from + delta, g.radius));
      const before = px(at(g.from + delta * (1 - 1 / steps), g.radius));
      arrowHead(end, before, alpha);
    } else if (g.mode === 'closer') {
      // Straight at it, from where they were standing when the server worked
      // this out. Dashed, because the line is a route and not a measurement.
      const from = px(g.at);
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);
      arrowHead([tx, ty], from, alpha);
    } else {
      // Dwell: nowhere to go, so nothing points anywhere. A second ring just
      // outside the first says "this one, keep it in view" without implying a
      // direction the person does not need to walk in.
      ctx.globalAlpha = alpha * 0.45;
      ctx.beginPath();
      ctx.arc(tx, ty, ringPx + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  // A head at `tip`, opening away from `tail`. Screen space on purpose: this is
  // the one part that is decoration rather than geometry, and it should be the
  // same size however far the map is zoomed out.
  function arrowHead(tip, tail, alpha) {
    const a = Math.atan2(tip[1] - tail[1], tip[0] - tail[0]);
    const wing = 0.45;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(tip[0] - GUIDE_HEAD_PX * Math.cos(a - wing),
      tip[1] - GUIDE_HEAD_PX * Math.sin(a - wing));
    ctx.lineTo(tip[0] - GUIDE_HEAD_PX * Math.cos(a + wing),
      tip[1] - GUIDE_HEAD_PX * Math.sin(a + wing));
    ctx.closePath();
    ctx.fill();
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
    const queueLabel = (key, text, x, y, color, bg, alpha = 1) =>
      labels.push({ key, text, x, y, color, bg, alpha });
    // Nearest first, so a label sits as close to its mark as it can. The ring
    // reaches further than it used to because labels now block each other as
    // well as the strokes: a cluster of sight lines to one tag exhausted the
    // old nine spots and fell back to overprinting at the anchor.
    const LABEL_OFFSETS = [
      [0, 0],
      [0, -12], [0, 12],
      [14, 0], [-14, 0],
      [14, -12], [-14, -12], [14, 12], [-14, 12],
      [0, -24], [0, 24],
      [14, -24], [-14, -24], [14, 24], [-14, 24],
      [28, 0], [-28, 0],
      [0, -36], [0, 36],
    ];
    // Boxes already taken by a label drawn this frame. A label is an obstacle
    // to the next label exactly as a wall is: the dodge searched only the
    // strokes, so two labels landing on the same spot both took it.
    const taken = [];
    const LABEL_PAD = 2;
    // Set from viewRot once the map's rotation is known, and applied per label
    // to cancel it. Zero when the map is north-up, which is every frame on the
    // dashboard.
    let labelRot = 0;
    function flushLabels() {
      // Widths are measured once per distinct string, not once per label per
      // frame: the font is a constant here, so the same twenty-odd strings were
      // being measured thirty times a second for no new information.
      const halfWidth = (text) => {
        let half = textHalfWidths.get(text);
        if (half === undefined) {
          if (textHalfWidths.size > 512) textHalfWidths.clear();
          half = ctx.measureText(text).width / 2;
          textHalfWidths.set(text, half);
        }
        return half;
      };
      // Solid labels claim their spot first and the fading ones dodge around
      // them, never the other way round. Below half opacity a label stops
      // reserving at all — a ghost about to disappear must not push a live
      // label aside for good, since a kept spot is only given up when blocked.
      const order = labels.slice().sort((a, b) => b.alpha - a.alpha);
      for (const lb of order) {
        if (lb.alpha <= 0.01) continue;
        ctx.globalAlpha = lb.alpha;
        const half = halfWidth(lb.text);
        let x = lb.x;
        let y = lb.y;
        const boxAt = (ox, oy) => ({
          minX: lb.x + ox - half - LABEL_PAD,
          minY: lb.y + oy - 11 - LABEL_PAD,
          maxX: lb.x + ox + half + LABEL_PAD,
          maxY: lb.y + oy + 3 + LABEL_PAD,
        });
        const clearAt = (ox, oy) => {
          const cx = lb.x + ox;
          const cy = lb.y + oy;
          const b = boxAt(ox, oy);
          if (taken.some((t) => t.minX < b.maxX && t.maxX > b.minX
            && t.minY < b.maxY && t.maxY > b.minY)) return false;
          return obstacles.every((o) => !segHitsBox(o.x1, o.y1, o.x2, o.y2,
            cx - half - o.r, cy - 10 - o.r, cx + half + o.r, cy + 2 + o.r));
        };
        // The dodge is re-searched every frame against obstacles that move
        // every frame, so a label near a tie flickers between two offsets. Its
        // last choice is kept for as long as that spot is still clear, and only
        // a spot that has actually become blocked is given up. Not eased: the
        // anchor already moves with the geometry, and a label trailing its own
        // mark by a tenth of a second reads worse than the hop it fixes.
        const kept = labelSpots.get(lb.key);
        let picked = kept && clearAt(kept[0], kept[1]) ? kept : null;
        if (!picked) {
          picked = LABEL_OFFSETS.find(([ox, oy]) => clearAt(ox, oy)) || null;
        }
        if (picked) {
          x = lb.x + picked[0];
          y = lb.y + picked[1];
          labelSpots.set(lb.key, picked);
          labelSeen.add(lb.key);
        }
        // Reserved whether or not a clear spot was found: with every offset
        // blocked the label still lands somewhere and still covers that box,
        // so the next label has to route around it either way.
        if (lb.alpha > 0.5) taken.push(boxAt(x - lb.x, y - lb.y));
        // The dodge above runs in the same turned space as the geometry it is
        // dodging; only the drawing is straightened, about the spot the label
        // ended up at. Text that rode the rotation would be sideways or upside
        // down exactly when the map is most in use.
        if (labelRot) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(labelRot);
          ctx.translate(-x, -y);
        }
        if (lb.bg) {
          const w2 = half + 4;
          ctx.fillStyle = lb.bg;
          ctx.fillRect(x - w2, y - 11, w2 * 2, 14);
        }
        ctx.fillStyle = lb.color;
        ctx.fillText(lb.text, x, y);
        if (labelRot) ctx.restore();
      }
      ctx.globalAlpha = 1;
      // A label that stopped being queued has nothing to remember.
      for (const key of labelSpots.keys()) {
        if (!labelSeen.has(key)) labelSpots.delete(key);
      }
      labelSeen.clear();
    }

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) {
      schedule();
      return;
    }
    // Backing store in device pixels, drawing in CSS pixels: every coordinate
    // below (and every font size) is laid out against `w`/`h`, and the pointer
    // reports the same units, so the ratio lives in the transform and nowhere
    // else. On a phone at DPR 3 — the XR client's map, full screen — a CSS-pixel
    // backing store is visibly soft. Writing canvas.width resets the transform,
    // so it is re-applied here rather than once at construction.
    //
    // Capped in total pixels, and the cap is not paranoia: a canvas whose
    // backing store cannot be allocated does not throw or fall back, it renders
    // as a broken-image icon and takes the whole view with it. The element's
    // client size is not always in CSS pixels — inside an immersive-AR DOM
    // overlay it can already be device pixels while devicePixelRatio still
    // reports 3, which asks for nine times the area of the screen it is drawn
    // on. Below 1 is allowed: a soft map beats a broken one.
    // Bounded by the display as well as by the constant: no canvas needs more
    // pixels than the screen it is drawn on, and a canvas whose CSS size does
    // not resolve reports its own backing store as its client size — which
    // makes every frame ask for dpr times the last one. That loop is a layout
    // bug wherever it happens, but it must not be able to take the view down.
    const screenPx = (window.innerWidth || w) * (window.innerHeight || h)
      * (window.devicePixelRatio || 1) ** 2;
    const dpr = Math.min(window.devicePixelRatio || 1,
      Math.sqrt(Math.min(maxBackingPx, screenPx) / (w * h)));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Smooth clients toward their latest pose (same time constant as 3D).
    const alpha = animAlpha(dt, MOTION_TAU_MS);
    for (const ph of clients.values()) {
      ph.fade = animFade(ph.fade, !ph.dead, dt);
      if (ph.dead && ph.fade === 0) {
        clients.delete(ph.id);
        continue;
      }
      if (!ph.target) continue;
      const fwd = quatRotate(ph.target.q, [0, 0, 1]);
      animApproachArr(ph.cur.p, ph.target.p, dt, MOTION_TAU_MS);
      animApproachArr(ph.cur.fwd, fwd, dt, MOTION_TAU_MS);
      // Not a snap to grey at exactly two seconds: the fade is the signal that
      // a client is going quiet, and a colour that changes over a third of a
      // second is the only part of it the eye actually catches.
      ph.staleMix = animFade(ph.staleMix,
        performance.now() - ph.at > ROOM_POSE_STALE_MS, dt);
      ph.shownRadius = animApproach(ph.shownRadius,
        ph.uncertaintyM * UNCERTAINTY_SIGMA, dt, RADIUS_TAU_MS);
      // The circle's centre is a measurement in its own right and moves on the
      // circle's own slow clock, not the dot's — see updateClient.
      if (ph.ringTarget) {
        if (!ph.ringSeeded) {
          ph.ringAt = [...ph.ringTarget];
          ph.ringSeeded = true;
        } else {
          animApproachArr(ph.ringAt, ph.ringTarget, dt, RADIUS_TAU_MS);
        }
      }
    }

    // Tags glide to wherever the survey has moved them and fade in and out, so
    // a promotion, a re-seed or a forget is something that can be watched
    // happening rather than a different picture on the next frame.
    for (const [id, m] of markers) {
      m.fade = animFade(m.fade, !m.dead, dt);
      if (m.dead && m.fade === 0) {
        markers.delete(id);
        continue;
      }
      animApproachArr(m.pos, m.tp, dt, MOTION_TAU_MS);
      m.q = quatNudge(m.q, m.tq, alpha);
      m.normal = quatRotate(m.q, [0, 0, 1]);
      m.ax3 = quatRotate(m.q, [1, 0, 0]);
      // Hover is pointer feedback, so it is quicker than the other fades — a
      // highlight that takes a third of a second to appear reads as lag, not
      // as smoothing.
      m.hot = animFade(m.hot, id === hoverId, dt, HOVER_MS);
      m.anchorMix = animFade(m.anchorMix, id === markerMap?.anchorId, dt);
    }

    // Which legs are on screen changes with every card opened in the drawer, so
    // they arrive and leave the way everything else here does.
    for (const p of pairs) {
      const key = pairKey(p);
      pairFades.set(key, animFade(pairFades.get(key) ?? 0, pairShown(p), dt));
    }

    for (let i = walls.length - 1; i >= 0; i--) {
      const seg = walls[i];
      seg.fade = animFade(seg.fade, !seg.dead, dt);
      if (seg.dead && seg.fade === 0) {
        walls.splice(i, 1);
        continue;
      }
      animApproachArr(seg.a, seg.ta, dt, MOTION_TAU_MS);
      animApproachArr(seg.b, seg.tb, dt, MOTION_TAU_MS);
      seg.y0 = animApproach(seg.y0, seg.ty0, dt, MOTION_TAU_MS);
      seg.y1 = animApproach(seg.y1, seg.ty1, dt, MOTION_TAU_MS);
      seg.width = animApproach(seg.width, seg.inferred ? 2 : 4, dt, MOTION_TAU_MS);
    }

    poseMix = animFade(poseMix, showPose, dt);
    wallsAlpha = animFade(wallsAlpha, showWalls, dt);
    landmarksAlpha = animFade(landmarksAlpha, showLandmarks, dt);
    candidatesAlpha = animFade(candidatesAlpha, showCandidates, dt);
    guideAlpha = animFade(guideAlpha, !!guide, dt);
    backdropAlpha = animFade(backdropAlpha, showBackdrop, dt);
    pairsAlpha = animFade(pairsAlpha, showPairs, dt);
    // Eased the short way round, or turning past the wrap point sends the whole
    // room the long way about.
    {
      const target = mode === 'top' && headingRad !== null ? headingRad : 0;
      // `target - delta` is the current angle re-expressed within half a turn of
      // the target; easing from there can only go the short way.
      const delta = Math.atan2(Math.sin(target - viewRot), Math.cos(target - viewRot));
      viewRot = animApproach(target - delta, target, dt, HEADING_TAU_MS);
    }
    floorMix = animFade(floorMix, true, dt);
    if (floorMix === 1) prevFloor = null;

    // Auto-fit: bounds of everything worth seeing, floor of 5 m span.
    let minA = -0.5, maxA = 0.5, minB = -0.5, maxB = 0.5;
    const grow = (a, b) => {
      minA = Math.min(minA, a); maxA = Math.max(maxA, a);
      minB = Math.min(minB, b); maxB = Math.max(maxB, b);
    };
    // A tag or client on its way out has stopped being something worth seeing
    // the moment it was removed, so it does not hold the view open while it
    // fades — the fit eases too, and both movements finish together.
    for (const m of markers.values()) {
      if (!m.dead) grow(...proj(m.pos));
    }
    for (const ph of clients.values()) {
      if (ph.target && !ph.dead) grow(...proj(ph.cur.p));
    }
    // Only while shown — a hidden layer must not keep the view zoomed out to
    // fit something invisible. Against the fading alpha rather than the switch,
    // so the view zooms in as the layer fades out instead of after it.
    if (wallsAlpha > 0.01) {
      if (mode === 'top' && floor) {
        grow(floor.minIx * floor.cellM, floor.minIz * floor.cellM);
        grow((floor.minIx + floor.w) * floor.cellM, (floor.minIz + floor.h) * floor.cellM);
      }
      for (const seg of walls) {
        if (elevation) {
          grow(seg.a[segA], seg.y0);
          grow(seg.b[segA], seg.y1);
        } else {
          grow(seg.a[0], seg.a[1]);
          grow(seg.b[0], seg.b[1]);
        }
      }
    }
    let spanA = Math.max(maxA - minA, 5);
    let spanB = Math.max(maxB - minB, 5);
    // Following: centred on the client, and the fit taken as a disc about it
    // rather than as a box about the room. A disc is the same at every angle by
    // construction — which is exactly what the turning branch below has to fake
    // — and its radius is the distance from where the client is standing to the
    // farthest corner of what there is to see, so nothing surveyed slides off
    // the edge as it walks into a corner of the room. The floor is half the 5 m
    // span floor below, being a radius where that is a width.
    const follow = mode === 'top' && headingRad !== null && headingPos
      ? proj(headingPos) : null;
    if (follow) {
      const [fa, fb] = follow;
      const rad = Math.max(2.5, Math.hypot(
        Math.max(fa - minA, maxA - fa), Math.max(fb - minB, maxB - fb)));
      lastFit = { ca: fa, cb: fb, scale: (Math.min(w, h) - 60) / 2 / rad };
    } else {
      // Rotating, the fit is taken against the shorter side for *both* spans: a
      // fit that used the true bounds would change as the room turned, so the map
      // would breathe in and out while walking a curve. This one is stable at
      // every angle, at the cost of being a little further out than it must be.
      // Still reached with heading on but no fix behind it yet, and while the
      // turn eases back out after heading is switched off.
      const turning = Math.abs(viewRot) > 1e-3
        || (mode === 'top' && headingRad !== null);
      lastFit = {
        ca: (minA + maxA) / 2,
        cb: (minB + maxB) / 2,
        scale: turning
          ? (Math.min(w, h) - 60) / Math.max(spanA, spanB)
          : Math.min((w - 60) / spanA, (h - 60) / spanB),
      };
    }
    // Ease toward whichever view is in force. The scale eases geometrically —
    // a zoom is a ratio, and easing it linearly makes zooming out crawl while
    // zooming in snaps. Seeded on the first frame so opening a view arrives at
    // its fit rather than flying into it.
    const want = view || lastFit;
    if (!shown) shown = { ...want };
    shown.ca = animApproach(shown.ca, want.ca, dt, MOTION_TAU_MS);
    shown.cb = animApproach(shown.cb, want.cb, dt, MOTION_TAU_MS);
    shown.scale = animApproachGeo(shown.scale, want.scale, dt, MOTION_TAU_MS);
    const { ca, cb, scale } = shown;
    // The grid below is drawn over the span it is handed, so it is asked of the
    // scale actually on screen rather than of the content — mid-ease the two
    // disagree, and the one the lines have to reach the edge of is the screen.
    spanA = w / scale;
    spanB = h / scale;
    const toPx = (a, b) => [(a - ca) * scale + w / 2, orient * (b - cb) * scale + h / 2];
    const px = (p) => toPx(...proj(p));

    // Cleared, not just painted over: a transparent backdrop has to actually
    // erase the last frame, and the fill below is what makes it opaque again.
    // Both in screen space, before the rotation below — the backdrop is the
    // canvas, not part of the drawing, and a rotated fill would leave the
    // corners of the screen bare.
    ctx.clearRect(0, 0, w, h);
    if (backdropAlpha > 0.01) {
      ctx.globalAlpha = backdropAlpha;
      ctx.fillStyle = '#181818';
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // Everything from here to flushLabels() is drawn in a space turned by
    // `viewRot` about the middle of the canvas. One transform rather than a
    // rotation baked into toPx: the carved floor is a bitmap and can only be
    // turned by the context, and a projection that rotated points but not the
    // raster would tear the two apart. Labels undo it one at a time when they
    // are finally drawn, so text stays upright whatever the map is doing.
    const turned = Math.abs(viewRot) > 1e-4;
    if (turned) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(viewRot);
      ctx.translate(-w / 2, -h / 2);
    }
    // Screen point -> the turned-space point that lands on it: the inverse of
    // the transform above, for the few things that belong to the canvas rather
    // than to the room and still have to be drawn in this space.
    const unturn = (sx, sy) => {
      if (!turned) return [sx, sy];
      const c = Math.cos(viewRot);
      const s = Math.sin(viewRot);
      const dx = sx - w / 2;
      const dy = sy - h / 2;
      return [w / 2 + dx * c + dy * s, h / 2 - dx * s + dy * c];
    };

    // Attested free space, under everything: it is the claim the rest of the
    // drawing stands on. Only the floor plan can show it — the side view has
    // no honest projection of an x-z grid. Smoothing off so cells read as
    // cells, not as a blur pretending to be a measurement gradient.
    // The outgoing snapshot fades out under the incoming one, each from its own
    // origin, so a carve that grew the grid grows it in place instead of
    // replacing the picture.
    if (wallsAlpha > 0.01 && mode === 'top' && (floor || prevFloor)) {
      ctx.imageSmoothingEnabled = false;
      const drawFloor = (f, a) => {
        if (!f || a <= 0.01) return;
        const [fx, fy] = toPx(f.minIx * f.cellM, f.minIz * f.cellM);
        ctx.globalAlpha = a;
        ctx.drawImage(f.canvas, fx, fy, f.w * f.cellM * scale, f.h * f.cellM * scale);
      };
      drawFloor(prevFloor, wallsAlpha * (1 - floorMix));
      drawFloor(floor, wallsAlpha * floorMix);
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = true;
    }

    // 1 m grid. Part of the backdrop, not of the room: it is a ruler drawn on
    // the paper, and over camera passthrough it is the first thing in the way.
    if (backdropAlpha > 0.01) {
      ctx.globalAlpha = backdropAlpha;
      ctx.strokeStyle = '#242424';
      ctx.lineWidth = 1;
      ctx.beginPath();
      // Turned, the screen's corners reach past the span that covers it square
      // on — worst case the diagonal, so the lines are run and drawn that much
      // further out. Cheap: they are clipped, not rasterised.
      const reach = turned ? Math.SQRT2 : 1;
      const over = turned ? (Math.SQRT2 - 1) / 2 : 0;
      for (let ga = Math.ceil(ca - spanA * reach); ga <= Math.floor(ca + spanA * reach); ga++) {
        const [sx] = toPx(ga, 0);
        ctx.moveTo(sx, -h * over);
        ctx.lineTo(sx, h * (1 + over));
      }
      for (let gb = Math.ceil(cb - spanB * reach); gb <= Math.floor(cb + spanB * reach); gb++) {
        const [, sy] = toPx(0, gb);
        ctx.moveTo(-w * over, sy);
        ctx.lineTo(w * (1 + over), sy);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';

    // Room axes as a corner gizmo, in the 3D scene's colours. Not at the room
    // origin: that is wherever the anchor tag happens to be, so it pans and
    // zooms off screen with everything else, while "which way is x" is wanted
    // at every viewport. Pinned to the bottom left instead, still turned with
    // the map — the arm directions are taken from the projection, so they point
    // where the room does. Only the two axes this projection keeps are drawn —
    // the collapsed one would be a dot claiming to be a direction.
    const axes = [axisA, axisB];
    const [ox, oy] = px([0, 0, 0]);
    // Direction only — the length is the gizmo's, not the world's.
    const arms = axes.map((k) => {
      const end = [0, 0, 0];
      end[k] = 1;
      const [ex, ey] = px(end);
      const len = Math.hypot(ex - ox, ey - oy) || 1;
      return { k, ux: (ex - ox) / len, uy: (ey - oy) / len };
    });
    // Anchored by its bounding box, not by its elbow: the arms point wherever
    // the room does, so on a heading-up map any of them can be the one reaching
    // for an edge, and an elbow at a fixed inset pushes that one off screen. The
    // box is measured in *screen* space — the arms are about to be drawn through
    // the context's rotation — and its bottom left is what is pinned, so the
    // gizmo sits on the bottom edge whatever it is doing inside.
    const reach = AXIS_GIZMO_PX + AXIS_GIZMO_LABEL_PX + AXIS_GIZMO_TEXT_PX;
    const cosR = Math.cos(viewRot);
    const sinR = Math.sin(viewRot);
    let boxMinX = 0;
    let boxMaxY = 0;
    for (const a of arms) {
      boxMinX = Math.min(boxMinX, (a.ux * cosR - a.uy * sinR) * reach);
      boxMaxY = Math.max(boxMaxY, (a.ux * sinR + a.uy * cosR) * reach);
    }
    // Drawn in the turned space the rest of this block lives in (labels are
    // queued in that space and straighten themselves one at a time), so the
    // elbow is carried back through the rotation rather than the context being
    // unturned and turned again around it.
    const [gx, gy] = unturn(AXIS_GIZMO_PAD + chromeLeftPx - boxMinX,
      h - AXIS_GIZMO_PAD - chromeBottomPx - boxMaxY);
    ctx.lineWidth = 2;
    for (const { k, ux, uy } of arms) {
      ctx.strokeStyle = roomAxisColorCss(k);
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + ux * AXIS_GIZMO_PX, gy + uy * AXIS_GIZMO_PX);
      ctx.stroke();
      // Past the end of the arm along its own direction, so the letter sits off
      // the end rather than on the stroke or on top of the other one's.
      const lp = AXIS_GIZMO_PX + AXIS_GIZMO_LABEL_PX;
      queueLabel(`axis:${k}`, ROOM_AXIS_NAMES[k],
        gx + ux * lp, gy + uy * lp + 4, roomAxisColorCss(k));
    }

    // Wall segments. Top: the wall seen edge-on, a stroke from end to end.
    // Side: the wall seen face-on, its attested x extent by its (cosmetic)
    // height band. Both only as far as the extent the carving attested.
    if (wallsAlpha > 0.01) {
      for (const seg of walls) {
        // The whole segment under one alpha: it is either a wall the carve
        // attests or one it has stopped attesting, and half of it fading is
        // not a state the data has.
        ctx.globalAlpha = wallsAlpha * seg.fade;
        if (elevation) {
          const [x1, yA] = toPx(Math.min(seg.a[segA], seg.b[segA]), seg.y0);
          const [x2, yB] = toPx(Math.max(seg.a[segA], seg.b[segA]), seg.y1);
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
          // The width eases between the two so a wall that gains or loses its
          // tags is the same wall changing; the dash cannot be eased, so it
          // switches at the halfway width.
          ctx.lineWidth = seg.width;
          if (seg.width < 3) ctx.setLineDash([7, 5]);
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
            queueLabel(`wall:${seg.key}`, `${len.toFixed(2)}`, lx2, ly2 + 4,
              '#b9c6cb', null, wallsAlpha * seg.fade);
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    // Right-angle distances between neighbouring tags: the two legs of the axis
    // decomposition, dashed, each labelled with its own length. The component
    // this projection collapses is left out rather than drawn misleadingly flat
    // — what is on screen is exactly what the view can honestly show, and it is
    // the same decomposition the client drawer lists. Drawn under the tags and
    // the clients, being the static thing.
    ctx.lineWidth = 1;
    for (const pair of pairsAlpha > 0.01 ? pairs : []) {
      const { a, b, kind } = pair;
      const key = pairKey(pair);
      const focusFade = pairFades.get(key) ?? 0;
      if (focusFade <= 0.01) continue;
      // Read off the live tags rather than off the positions the map arrived
      // with: the tags are gliding to those positions, and a leg drawn to
      // where a tag is going to be detaches from the tag it belongs to.
      const ap = markers.get(a.id)?.pos || a.p;
      const bp = markers.get(b.id)?.pos || b.p;
      // A leg is a statement about two tags, so it is only as present as the
      // less present of them.
      const legAlpha = pairsAlpha * focusFade
        * Math.min(markers.get(a.id)?.fade ?? 1, markers.get(b.id)?.fade ?? 1);
      if (legAlpha <= 0.01) continue;
      ctx.globalAlpha = legAlpha;
      // The elbow: b's across-screen axis, a's up-screen one. Built off this
      // view's own pair rather than off a fixed component, or a projection that
      // does not keep x draws its corner on top of one of the tags.
      const [ax, ay] = px(ap);
      const [bx, by] = px(bp);
      const elbow = ap.slice();
      elbow[axisA] = bp[axisA];
      const [cx, cy] = px(elbow);
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
      [[ax, ay, cx, cy], [cx, cy, bx, by]].forEach(([x1, y1, x2, y2], leg) => {
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 34) return;
        // Back through the scale rather than from the world points: the leg is
        // axis-aligned on screen, so its pixel length is its world length.
        queueLabel(`leg:${a.id}-${b.id}-${leg}`, (len / scale).toFixed(2),
          (x1 + x2) / 2, (y1 + y2) / 2 - 3, legColor, null, legAlpha);
      });
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // Landmark anchors, under the tags and everything else that carries a
    // claim: a small dot in the owning client's colour, no label, no ring, no
    // extent. They are per-session, are thrown away whenever the tracker
    // resets, and are a good deal less trustworthy than a surveyed tag — so
    // they are drawn as the faintest thing on the map that is still legible,
    // and nothing about them reads as a measurement.
    // The instruction, under everything that describes the room: it is the one
    // thing here that is not a measurement, and it must never be mistaken for
    // one. Drawn before the tags and the anchors so it sits behind them.
    if (guideAlpha > 0.01 && guide) drawGuide(px, guide, guideAlpha);

    // Candidates first, so an anchor sitting on one is drawn over its own ring
    // rather than under it — that is the moment the reader is looking for.
    if (candidatesAlpha > 0.01 && landmarks.length) {
      ctx.lineWidth = 1;
      // One colour for every client's candidates, and not their own: see
      // ROOM_CANDIDATE_COLOR. A candidate is not yet anybody's landmark.
      ctx.strokeStyle = roomCandidateColorCss();
      for (const c of landmarks) {
        if (!c.candidates?.length) continue;
        for (const k of c.candidates) {
          const [x, y] = px(k.p);
          // Arc progress, not confidence: a candidate at 55° is one that has
          // been looked at from nearly enough angles, not one that is nearly
          // right. Floored so a barely-seen feature still marks its place.
          const t = Math.min(1, (k.span || 0) / ROOM_LANDMARK_ARC_DEG);
          ctx.globalAlpha = candidatesAlpha * (CANDIDATE_MIN_ALPHA + 0.5 * t);
          ctx.beginPath();
          ctx.arc(x, y, CANDIDATE_DOT_PX, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    if (landmarksAlpha > 0.01 && landmarks.length) {
      for (const c of landmarks) {
        if (!c.anchors?.length) continue;
        ctx.fillStyle = roomClientColorCss(c.clientId);
        ctx.globalAlpha = landmarksAlpha * 0.45;
        for (const p of c.anchors) {
          const [x, y] = px(p);
          ctx.beginPath();
          ctx.arc(x, y, LANDMARK_DOT_PX, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Markers: a stroke along the tag's x axis, projected.
    const half = (markerMap?.sizeM || 0.15) / 2;
    lastGlyphs = [];
    for (const [id, m] of markers) {
      const end1 = m.pos.map((v, i) => v - m.ax3[i] * half);
      const end2 = m.pos.map((v, i) => v + m.ax3[i] * half);
      const [x1, y1] = px(end1);
      const [x2, y2] = px(end2);
      ctx.globalAlpha = m.fade;
      // One colour per tag, shared by the stroke and the label chip, so the
      // chip reads as a name for exactly that mark. The anchor keeps its
      // gold — it is the datum, and the gold is what says so. It crossfades:
      // the anchor moving is a change of datum, worth seeing happen.
      const tagColor = animMixCss(roomTagColorCss(id), '#d4b34c', m.anchorMix);
      const hot = m.hot;
      // A halo under the stroke rather than a different colour on it: the tag
      // colour is the tag's identity here and in the drawer, and swapping it to
      // say "hovered" would break the one thing that ties the two together.
      if (hot > 0.01) {
        ctx.globalAlpha = m.fade * hot;
        ctx.strokeStyle = HOVER_HALO_CSS;
        ctx.lineWidth = 12 * hot;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.globalAlpha = m.fade;
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
      if (hot > 0.01) {
        ctx.globalAlpha = m.fade * hot;
        ctx.strokeStyle = HOVER_HALO_CSS;
        ctx.lineWidth = 3 * hot;
        ctx.strokeRect(-chipHalf - 2, side * 9 - 9, chipHalf * 2 + 4, 18);
        ctx.globalAlpha = m.fade;
      }
      ctx.fillStyle = tagColor;
      ctx.fillRect(-chipHalf, side * 9 - 7, chipHalf * 2, 14);
      ctx.fillStyle = '#fff';
      ctx.fillText(idText, 0, side * 9 + 4);
      ctx.restore();
      ctx.globalAlpha = 1;

      // A tag on its way out is not a tag the pointer can pick: the double
      // click that forgets one would otherwise land on the ghost of the last.
      if (m.dead) continue;
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
      const fade = ph.fade;
      const stale = ph.staleMix;
      const color = animMixCss(ph.color, '#555', stale);
      // With the pose hidden, heading, label, tag lines and distances all
      // anchor on the circle's centre — a line from an invisible point would
      // read as a stray mark. The two points are metres apart, so the switch
      // slides between them rather than teleporting everything hung off it.
      const ringP = ph.ringAt || ph.cur.p;
      const anchorP = ringP.map((v, i) => v + (ph.cur.p[i] - v) * poseMix);
      const [sx, sy] = px(anchorP);

      // Uncertainty first, so the dot and heading draw on top of it. The circle
      // fades in over the width it takes to be worth drawing rather than
      // appearing whole at the threshold, and the centre dot fades out against
      // it, so neither pops as the measurement tightens.
      const rPx = ph.shownRadius * scale;
      const ringAlpha = Math.min(1, Math.max(0, (rPx - RADIUS_MIN_PX) / RADIUS_MIN_PX));
      if (ringAlpha > 0.01) {
        const [ux, uy] = px(ringP);
        ctx.globalAlpha = fade * ringAlpha;
        ctx.beginPath();
        ctx.arc(ux, uy, rPx, 0, Math.PI * 2);
        ctx.fillStyle = animMixCss(`${ph.color}22`, 'rgba(85,85,85,0.10)', stale);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.globalAlpha = fade * ringAlpha * 0.5;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      if (ringAlpha < 0.99 && poseMix < 0.99) {
        ctx.globalAlpha = fade * (1 - ringAlpha) * (1 - poseMix);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, RING_DOT_PX, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = fade;

      if (stale < 0.99) {
        for (const id of ph.seen) {
          const m = markers.get(id);
          if (!m) continue;
          const [tx, ty] = px(m.pos);
          // Fading with the client going quiet rather than switching off at
          // two seconds, and with the tag it points at.
          const lineAlpha = fade * m.fade * (1 - stale);
          ctx.strokeStyle = color;
          ctx.globalAlpha = lineAlpha * 0.5;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.globalAlpha = fade;
          // Distance and viewing angle in full 3D — the views are
          // projections, the geometry is not.
          const d = anchorP.map((v, i) => v - m.pos[i]);
          const dist = Math.hypot(...d);
          const cosA = dist > 1e-6
            ? (d[0] * m.normal[0] + d[1] * m.normal[1] + d[2] * m.normal[2]) / dist
            : 1;
          const ang = Math.acos(Math.min(1, Math.max(-1, Math.abs(cosA)))) * 180 / Math.PI;
          queueLabel(`sight:${ph.id}-${id}`, `${dist.toFixed(2)} m · ${Math.round(ang)}°`,
            (sx + tx) / 2, (sy + ty) / 2 - 4, roomAngleColor(ang), null, lineAlpha);
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
      if (poseMix > 0.01) {
        // Grown rather than switched on, so the dot and the centre marker it
        // replaces read as one thing changing.
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, 6 * poseMix, 0, Math.PI * 2);
        ctx.fill();
      }
      const [pa, pb] = proj(anchorP);
      queueLabel(`client:${ph.id}`, `C${ph.id} · ${pa.toFixed(2)}, ${pb.toFixed(2)}`,
        sx, sy - 12, color, null, fade);
      ctx.globalAlpha = 1;
    }

    // Back to screen space for the text. The labels carry turned-space
    // coordinates, so the context has to still be turned while they are placed
    // — each one straightens itself about its own anchor instead.
    labelRot = -viewRot;
    flushLabels();
    if (turned) ctx.restore();
    schedule();
  }

  function schedule() {
    if (!rafPending && active) {
      rafPending = true;
      nextFrame(draw);
    }
  }

  return {
    setActive(on) {
      active = on;
      if (on) {
        lastFrameAt = 0;
        // A hidden view ran no frames, so its eased viewport is as old as the
        // last time it was looked at. Re-seeded from whatever is in force now
        // rather than swept there over the first tenth of a second.
        shown = null;
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

    // The tag whose card is open in the drawer. Only meaningful with
    // `pairsFocusOnly`, where it is what decides which legs are drawn at all.
    setFocusMarker(id) {
      if (id === focusId) return;
      focusId = id;
      schedule();
    },

    // Matched against what is already on screen rather than replacing it: a
    // map arrives whole on every survey change, and clearing it would throw
    // away the one thing that says a tag at a new position is the same tag.
    // Tags the map no longer has are marked dead and fade out in draw().
    setMarkerMap(map) {
      markerMap = map;
      // Derived here rather than per frame, and from the shared helper, so the
      // legs drawn here and the distances listed in the client drawer can never
      // disagree about which tags are neighbours.
      pairs = markerNeighbourhood(map).pairs;
      // A pair the new map does not have is gone for good — a leg has no
      // identity to fade out with, unlike the tags it joins.
      const livePairs = new Set(pairs.map(pairKey));
      for (const key of pairFades.keys()) {
        if (!livePairs.has(key)) pairFades.delete(key);
      }
      const live = new Set();
      for (const m of map?.markers || []) {
        live.add(m.id);
        const had = markers.get(m.id);
        if (had) {
          had.tp = m.p;
          had.tq = m.q;
          had.dead = false;
        } else {
          markers.set(m.id, {
            pos: [...m.p], q: [...m.q], tp: m.p, tq: m.q,
            normal: quatRotate(m.q, [0, 0, 1]),
            ax3: quatRotate(m.q, [1, 0, 0]),
            fade: 0, dead: false, hot: 0,
            // Seeded at the answer: a tag that arrives as the anchor is the
            // anchor, it did not become one.
            anchorMix: m.id === map.anchorId ? 1 : 0,
          });
        }
      }
      for (const [id, m] of markers) {
        if (!live.has(id)) m.dead = true;
      }
      schedule();
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
          fade: 0, dead: false, staleMix: 0,
        };
        clients.set(clientId, ph);
      }
      // A client that comes back before its fade finished is the same client:
      // it fades back in from wherever it had got to.
      ph.dead = false;
      ph.target = pose;
      ph.seen = seenTagIds;
      ph.uncertaintyM = uncertainty?.r ?? 0;
      ph.ringTarget = uncertainty?.p ?? pose.p;
      ph.at = performance.now();
    },

    // Faded out and dropped by draw() rather than deleted here: a client
    // vanishing between two frames is indistinguishable from one that was
    // never there.
    removeClient(clientId) {
      const ph = clients.get(clientId);
      if (!ph) return;
      ph.dead = true;
      schedule();
    },

    // Full snapshot each time ({ cellM, free: [ix,iz,...], occ: [ix,iz,...] });
    // pre-rendered here once rather than per frame in draw().
    setFloor(f) {
      // Whatever was on screen becomes the outgoing image, including on a
      // clear: the carve going away is as much a change as the carve arriving.
      prevFloor = floor;
      floorMix = prevFloor ? 0 : 1;
      const deduced = (f && f.deduced) || [];
      if (!f || (!f.free.length && !f.occ.length && !deduced.length)) {
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
      scan(deduced);
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
      paint(deduced, FLOOR_DEDUCED_CSS);
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
      // Deduced cells count as known, or the frontier rim would outline a
      // boundary the deduction already explains.
      for (let i = 0; i < deduced.length; i += 2) known.add(keyOf(deduced[i], deduced[i + 1]));
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

    // Segments carry no id — the carve re-derives the whole set from the grid
    // every time — so each snapshot is matched against the one on screen: by
    // the tags on the plane where there are any, and by where the segment is
    // otherwise, since an inferred wall has nothing else to be recognised by.
    // A match makes a wall that moved one wall moving; a miss is a birth or a
    // death, and fades.
    setWalls(next) {
      const arriving = next || [];
      // Fading segments stay eligible: a wall that flickers out of one
      // snapshot and back into the next is the same wall, and should fade back
      // in rather than leave its own ghost to overlap it.
      const free = walls;
      const taken = new Set();
      const keyOf = (s) => (s.ids?.length ? s.ids.slice().sort((x, y) => x - y).join(',') : '');
      const byKey = new Map();
      for (const s of free) {
        const k = keyOf(s);
        if (k && !byKey.has(k)) byKey.set(k, s);
      }
      // Both ends within a wall's own thickness of noise, either way round:
      // the carve names a segment's ends by which end of the run it walked
      // from, and that can flip between snapshots.
      const MATCH_M = 0.5;
      const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= MATCH_M;
      const matchByShape = (want) => {
        let best = null;
        let bestD = Infinity;
        for (const s of free) {
          if (taken.has(s)) continue;
          const fwd = near(s.a, want.a) && near(s.b, want.b);
          const rev = near(s.a, want.b) && near(s.b, want.a);
          if (!fwd && !rev) continue;
          const d = fwd
            ? Math.hypot(s.a[0] - want.a[0], s.a[1] - want.a[1])
              + Math.hypot(s.b[0] - want.b[0], s.b[1] - want.b[1])
            : Math.hypot(s.a[0] - want.b[0], s.a[1] - want.b[1])
              + Math.hypot(s.b[0] - want.a[0], s.b[1] - want.a[1]);
          if (d < bestD) {
            bestD = d;
            best = { seg: s, flip: rev && !fwd };
          }
        }
        return best;
      };
      const out = [];
      for (const want of arriving) {
        const k = keyOf(want);
        let seg = null;
        let flip = false;
        const keyed = k ? byKey.get(k) : null;
        if (keyed && !taken.has(keyed)) {
          seg = keyed;
          // Even a keyed match can have its ends the other way round.
          flip = Math.hypot(keyed.a[0] - want.a[0], keyed.a[1] - want.a[1])
            > Math.hypot(keyed.a[0] - want.b[0], keyed.a[1] - want.b[1]);
        } else {
          const m = matchByShape(want);
          if (m) {
            seg = m.seg;
            flip = m.flip;
          }
        }
        const ta = flip ? want.b : want.a;
        const tb = flip ? want.a : want.b;
        if (seg) {
          taken.add(seg);
          seg.ta = [...ta];
          seg.tb = [...tb];
          seg.ty0 = want.y0;
          seg.ty1 = want.y1;
          seg.ids = want.ids;
          seg.inferred = want.inferred;
          seg.dead = false;
          out.push(seg);
        } else {
          out.push({
            // A local handle only, for keying the length label's dodge — the
            // carve gives segments no identity of their own.
            key: nextWallKey++,
            a: [...ta], b: [...tb], ta: [...ta], tb: [...tb],
            y0: want.y0, y1: want.y1, ty0: want.y0, ty1: want.y1,
            ids: want.ids, inferred: want.inferred,
            width: want.inferred ? 2 : 4,
            fade: 0, dead: false,
          });
        }
      }
      // Everything the snapshot did not claim is on its way out. Kept in the
      // list so it keeps being drawn while it fades; draw() drops it at zero.
      for (const s of walls) {
        if (taken.has(s)) continue;
        s.dead = true;
        out.push(s);
      }
      walls = out;
      schedule();
    },

    setLandmarks(next) {
      landmarks = next || [];
      schedule();
    },

    // The walk to do next, or null for "nothing worth saying" — which is the
    // common answer and must draw nothing rather than the last instruction.
    setGuide(next) {
      guide = next || null;
      schedule();
    },

    setLayer(name, on) {
      if (name === 'walls') {
        showWalls = on;
        schedule();
      } else if (name === 'landmarks') {
        showLandmarks = on;
        schedule();
      } else if (name === 'candidates') {
        showCandidates = on;
        schedule();
      } else if (name === 'backdrop') {
        showBackdrop = on;
        schedule();
      } else if (name === 'pairs') {
        showPairs = on;
        schedule();
      }
    },

    // How far in from the bottom and left edges the corner gizmo has to start,
    // in CSS pixels, because the page has drawn something of its own over those
    // strips. Nothing else in the map moves: the room fills the canvas it was
    // given, and a tag under a button is still in the right place — the gizmo is
    // the only thing whose position means "the corner of the screen".
    setChromeInset({ bottom = 0, left = 0 } = {}) {
      const b = Math.max(0, bottom);
      const l = Math.max(0, left);
      if (b === chromeBottomPx && l === chromeLeftPx) return;
      chromeBottomPx = b;
      chromeLeftPx = l;
      schedule();
    },

    // Turn the map so this room-frame direction points up the screen and centre
    // it on this room-frame point, or null to leave it in the room's own
    // orientation and bounds. Both given in the room frame rather than as an
    // angle and a pair of screen coordinates, so the caller never has to know
    // which two axes this projection keeps or which way its second one runs —
    // that convention lives here and has exactly one definition.
    setHeadingUp(fwd, pos = null) {
      headingPos = pos;
      if (!fwd) {
        headingRad = null;
      } else {
        const [fa, fb] = proj(fwd);
        // The half turn is the difference between "which way am I facing" and
        // "which way must the map be turned so that is up".
        headingRad = Math.hypot(fa, fb) < 1e-6 ? headingRad : Math.atan2(-fa, -fb * orient);
      }
      schedule();
    },

  };
}
