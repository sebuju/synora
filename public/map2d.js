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

// Half the end tick on a dimension bar, in screen pixels. Fixed rather than on
// the world scale: it is punctuation saying "this is a length", not part of the
// length being read.
const BAR_TICK_PX = 3;

// Label text, and the second line some labels carry under it. The sub line is
// smaller and set in the same family: it is the same label continued, not a
// second label, and at equal size the two lines read as two marks.
const LABEL_FONT = '12px ui-monospace, monospace';
const LABEL_SUB_FONT = '10px ui-monospace, monospace';
// Baseline of the sub line below the main one, and how far the pair reaches
// under the anchor — both in screen pixels, since that is what the dodge and
// the obstacle tests are measured in.
const LABEL_SUB_DY = 11;

// Pixels per metre past which an object's label carries its measurements as a
// second line. Absolute rather than a multiple of the current fit: what a second
// line needs is room on screen between one object and the next, and that is a
// distance in pixels — a fit-relative rule would open the detail on a zoomed-out
// phone and hold it shut on a zoomed-in monitor. At 250 px/m the four objects on
// one wall of this room stand about a label-width apart.
const OBJ_DETAIL_PX_PER_M = 250;

// Room y, the one axis that means something without knowing the room frame's
// convention. Written as an arrow and a magnitude — `↑0.38`, `↓0.73` — where x
// and z are written as a letter and a signed number. The floor plan collapses
// exactly this axis, which is how a clock 0.38 m up the wall and a plant 0.73 m
// down on the floor came to be drawn on the same spot; the arrow is what tells
// those apart at a glance, where `y +0.38` has to be read. One formatter for
// every coordinate this file prints, so the object labels and the pointer
// readout can never disagree about how a number is spelled.
// A screen point carried back into the space the drawing was turned in, about
// the middle of the canvas. Module level because both users need it and neither
// can borrow the other's: the draw pass has one for the few marks that belong
// to the canvas rather than to the room, and the pointer readout needs the same
// inverse after the frame is over and those locals are gone.
function unrotateScreen(sx, sy, w, h, rot) {
  if (Math.abs(rot) <= 1e-4) return [sx, sy];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const dx = sx - w / 2;
  const dy = sy - h / 2;
  return [w / 2 + dx * c + dy * s, h / 2 - dx * s + dy * c];
}

const AXIS_UP = 1;
function fmtAxis(axis, v) {
  if (axis === AXIS_UP) return `${v >= 0 ? '↑' : '↓'}${Math.abs(v).toFixed(2)}`;
  return `${ROOM_AXIS_NAMES[axis]} ${v.toFixed(2)}`;
}

// The gates `objects.js` promotes and trusts an object by. Mirrored rather than
// carried on the wire: the wire already says whether an object is `usable`, and
// only the *reason* is worth printing next to it. `objects.js` DEFAULTS is the
// source of truth for both — keep them in step by hand, they change rarely and
// a drift here misnames a state rather than breaking one.
const OBJ_MIN_ARC_DEG = 8;
const OBJ_PRIOR_FRAC_MAX = 0.35;

// The mark that says how big an object was measured to be, in metres, in the
// two room axes a view keeps. **It carries as many dimensions as that view has
// measured extents in it, and never more** — the whole hazard of drawing a size
// is that a mark with an area claims a footprint, and a mark with a long axis
// claims a bearing, whether or not either was measured.
//
// Three cases, in falling order of what is known:
//
//   - **A fitted circular outline** is what the thing *is* and which way it
//     faces, so its projection is a genuine 2D footprint: a disc of radius r
//     facing n, projected orthographically, is an ellipse — a full circle seen
//     face on, a sliver seen edge on, and correctly angled in between. Taken
//     through the projection rather than axis by axis: extents measured along
//     the two room axes separately give the shape's *bounding box*, which for a
//     paper-thin object on a wall running at an angle to the room is a fat blob
//     claiming footprint in two directions it does not have.
//   - **`w` and `h`**, in an elevation. Two extents whose directions are both
//     known — `h` is world-vertical and `w` is horizontal, which is the axis
//     running across an elevation — so an axis-aligned ellipse is exactly the
//     claim being made.
//   - **`w` alone**, in the floor plan, where both kept axes are horizontal and
//     only one horizontal extent was ever measured. One number, so one
//     dimension: a bar of that length, not a circle. A circle would assert a
//     footprint measured in every direction, which is true of a chair and badly
//     false of a television, and nothing here can tell those apart.
//
// A fitted quad falls to the second case: it has `w` and `h` in its own plane
// but nothing here knows which way round they lie in it, and guessing would
// invent exactly the bearing this whole function refuses to invent.
function objMark(rec, axisA, axisB, orient) {
  if (rec.shape?.kind === 'ellipse' && rec.shape.r > 0 && rec.shape.n) {
    const r = rec.shape.r;
    const n = rec.shape.n;
    // Any two orthonormal vectors spanning the disc's plane. Which two does not
    // matter — they parameterize the same circle, and the SVD below recovers the
    // projected ellipse's own axes regardless of where the parameterization
    // started. Seeded off whichever room axis the normal leans on least, so the
    // cross product is never taken against something nearly parallel.
    const k = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = unitv([k[1] * n[2] - k[2] * n[1],
      k[2] * n[0] - k[0] * n[2],
      k[0] * n[1] - k[1] * n[0]]);
    const e2 = unitv([n[1] * e1[2] - n[2] * e1[1],
      n[2] * e1[0] - n[0] * e1[2],
      n[0] * e1[1] - n[1] * e1[0]]);
    // The disc's points in screen directions, before the common pixel scale: a
    // point r(cosθ·e1 + sinθ·e2) lands at M·(cosθ, sinθ). `orient` rides along
    // because an elevation draws its second axis upward.
    const mark = ellipseFromMatrix(
      r * e1[axisA], r * e2[axisA],
      orient * r * e1[axisB], orient * r * e2[axisB],
    );
    // Below a millimetre the minor axis is not a thin ellipse, it is a line the
    // canvas would render as a hairline of arbitrary width.
    if (mark.ry < 0.001) return { kind: 'bar', len: mark.rx * 2, rot: mark.rot };
    return mark;
  }
  const wide = rec.w || null;
  if (axisB === AXIS_UP || axisA === AXIS_UP) {
    const up = rec.h || null;
    if (!wide || !up) return null;
    return {
      kind: 'ellipse',
      rx: (axisA === AXIS_UP ? up : wide) / 2,
      ry: (axisB === AXIS_UP ? up : wide) / 2,
      rot: 0,
    };
  }
  return wide ? { kind: 'bar', len: wide, rot: null } : null;
}

function unitv(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

// The ellipse that the unit circle maps to under the 2x2 matrix [[a,b],[c,d]] —
// its two semi-axes and the angle the major one sits at. Closed-form 2x2 SVD;
// `rx` is the larger by construction, which is what makes the rotation the major
// axis's own angle rather than one of two conventions.
function ellipseFromMatrix(a, b, c, d) {
  const e = (a + d) / 2;
  const f = (a - d) / 2;
  const g = (c + b) / 2;
  const hh = (c - b) / 2;
  const q = Math.hypot(e, hh);
  const r = Math.hypot(f, g);
  return {
    kind: 'ellipse',
    rx: q + r,
    ry: Math.abs(q - r),
    rot: (Math.atan2(hh, e) + Math.atan2(g, f)) / 2,
  };
}

// Everything about an object except which object it is, as short rows under the
// name. Held back until the view is zoomed in far enough to have room for them:
// at the fit these are a dozen numbers per object over a room that fits in a
// hand, and the question a zoomed-out map answers is which things are where.
//
// One row per kind of claim — what its geometry is, how well that is known —
// rather than one long line. Rows keep the block narrow, and narrow is what
// matters now that object labels sit on their objects and no longer step aside
// for each other.
//
// `axis`/`v` are the coordinate the view collapses and its value, which is the
// one number the picture cannot be read for. It rides down here with the rest
// because the name line is only ever the name.
function objDetail(rec, axis, v) {
  const rows = [];
  const size = [];
  if (rec.w) size.push(`w ${rec.w.toFixed(2)}`);
  if (rec.h) size.push(`h ${rec.h.toFixed(2)}`);
  // Last on the row the sizes are on, not first and not on one of its own: it
  // is the third number about this object's geometry, and the arrow (or the
  // axis letter, in an elevation) already tells it apart from the two lengths
  // beside it.
  size.push(fmtAxis(axis, v));
  rows.push(size.join(' · '));
  const state = [`arc ${(rec.arcDeg ?? 0).toFixed(1)}°`];
  const why = objWhy(rec);
  // `arc` is already the first thing on this row, so the arc doubt state would
  // be the same number printed twice.
  if (why && !why.startsWith('arc')) state.push(why);
  rows.push(state.join(' · '));
  return rows;
}

// Why this object is not yet something the map stands on, most-fundamental
// first: an entry still accumulating is a different statement from one that has
// sightings but was never seen from enough angles. Null once it has cleared all
// three, which is when the label drops the clause entirely.
function objWhy(rec) {
  if (!rec) return null;
  if (!rec.promoted) return `n=${rec.nObs ?? 0}`;
  if (rec.priorFrac > OBJ_PRIOR_FRAC_MAX) return `prior ${Math.round(rec.priorFrac * 100)}%`;
  if (rec.arcDeg < OBJ_MIN_ARC_DEG) return `arc ${rec.arcDeg.toFixed(1)}°`;
  return null;
}

function createMap2dView(canvas, mode = 'top', {
  onHover, onSelect, raf, maxPixels, pairsFocusOnly,
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
  // Detected objects, keyed by the id objects.js assigns. Same match-don't-
  // replace contract as the tags: a snapshot arrives whole and an object that
  // moved is still that object.
  const objectDots = new Map();
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
  // The heading arrow's floor, in screen pixels: its 0.2 m world length
  // disappears at the zoom a whole room fits a phone screen at, and a heading
  // is a direction, so its drawn length may be floored without lying.
  const HEADING_MIN_PX = 20;
  // How far behind the client its label is pinned on a heading-up map. Clear of
  // the 6 px dot, and no further: the label belongs to that dot, and a gap wide
  // enough to fit anything else between them is a gap wide enough to read it as
  // belonging to whatever lands there.
  const CLIENT_LABEL_PIN_PX = 14;
  const HOVER_MS = 120;
  let lastFrameAt = 0;
  // The loop itself is common.js's — see createDrawLoop for why the latch it
  // owns is a token rather than a flag, and why that is load-bearing here in
  // particular: on /xr-client `nextFrame` is the XR *session's*
  // requestAnimationFrame, and a session that ends with a frame queued never
  // delivers it. `draw` is a declaration, so it is already bound here.
  const loop = createDrawLoop({ nextFrame, draw });
  const schedule = loop.schedule;
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
  // What is highlighted — { kind: 'tag' | 'client', id } or null.
  // Set from outside only: the drawer and every room view highlight the same
  // entity at once, so the one place that can know is the viewer, and every
  // renderer here is told rather than deciding for itself. One value, not one
  // per kind — two hovers can never both be lit.
  let hovered = null;
  // Client dots as drawn this frame, for the hit test — same convention as
  // lastGlyphs: the shape the pointer is tested against is the shape on
  // screen, recorded in the same (turned) space.
  let lastClientDots = [];
  // Object marks as drawn this frame, same convention again. The radius is the
  // hit target rather than a fixed one: an object's mark is whatever `objMark`
  // decided, from a 4 px ring to a metre-wide ellipse, and a fixed target would
  // be unmissable on one and unhittable on the other.
  let lastObjectDots = [];
  // Which object the reader has opened in the drawer, told from outside exactly
  // as `focusId` is. It is what draws the co-visibility legs: every object's
  // partners at once is a web across the whole room, and the question is only
  // ever asked of one object at a time.
  let focusObjectId = null;
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
  // The two halves of the object layer, switched apart because they are two
  // different claims about the room: `showObjects` is what the map has committed
  // to (promoted, and standing on parallax rather than on a depth prior),
  // `showObjectCandidates` everything else it has drawn a ring for. That is the
  // same and only split the marks themselves carry — best colour and a dashed
  // ring against the dim colour and a dotted one — so a reader turning one off
  // is left with exactly the class the other icon shows.
  let showObjects = true;
  let showObjectCandidates = true;
  // The name and stat block drawn on each object's own mark. Separate from the
  // marks themselves because a caller can already be naming them somewhere else:
  // the XR client carries a list of what is in view and the names belong there,
  // where there is room to read them, rather than on a map the size of a stamp
  // held at arm's length. Default on — the dashboard's map is the only place its
  // objects are named, and the panel's cards cross-reference the `#id` this
  // prints.
  let showObjectLabels = true;
  // One fade each, not one shared: turning the candidates off has to leave the
  // committed objects at full strength, and a single alpha would dim every mark
  // on the way to hiding half of them.
  let objectsAlpha = 0;
  let objCandAlpha = 0;
  let wallsAlpha = 1;
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
  //
  // The centre outlives the turn, though: the near fit below follows the pose
  // whether or not the map is turned to its heading, so a caller may set a
  // follow point with no heading at all.
  let headingRad = null;   // null: north up, the room frame's own orientation
  let followPos = null;    // null: the fit's own bounds, centred on the room
  // Where the client is pointing, and how wide its camera is — set only by a
  // page that *is* somewhere in the room, which is the capture client and never
  // the dashboard. Null on the dashboard, and null is "no gaze", which is why
  // nothing there changes. See `setGaze`.
  let gaze = null;
  // Reach only as far as the followed client's own business instead of holding
  // the whole survey in view — see the fit below. The client has to be named
  // for it: the fit is built from what *that* client can see, and the map has
  // no way to work out which of its dots is the page it is being drawn on.
  let nearFit = false;
  let selfId = null;
  // How far past the farthest thing worth keeping in view the near fit reaches,
  // and the radius it never goes under. The margin keeps a tag off the very edge
  // of the screen (a mark on the rim reads as one on its way out), and the floor
  // is what a client with nothing in view gets — a room-sized view of where it
  // is standing rather than a microscope on an empty patch of floor.
  const NEAR_FIT_MARGIN = 1.25;
  const NEAR_FIT_MIN_M = 3;
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
  // The two object colours are `ROOM_OBJECT_CSS` and `ROOM_OBJECT_BEST_CSS` in
  // common.js — teal for one the map would stand on, periwinkle for one still
  // accumulating — because the object drawer paints its cards with the same
  // pair. These are their fills, and they are the canvas's alone: the size mark
  // is filled where the scatter ring is only stroked, because the two marks are
  // different claims and must not be mistakeable for each other.
  const ROOM_OBJECT_FILL_CSS = 'rgba(127,143,214,0.18)';
  const ROOM_OBJECT_BEST_FILL_CSS = 'rgba(127,184,164,0.18)';
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
  // How far inside the canvas a mark has to be to count as already shown, for
  // focusOn below.
  const FOCUS_EDGE_PX = 48;
  const FOCUS_EDGE_MAX = 0.25;   // ...but never more than this share of the pane

  // Seeded from what is on screen, not from the fit it is easing toward: a
  // grab that lands mid-ease must continue from where the user can see, or the
  // view jumps forward to the fit the moment it is touched.
  function takeOver() {
    if (!view && (shown || lastFit)) view = { ...(shown || lastFit) };
    return !!view;
  }

  // Where one entity is, as the room point focusOn should centre on. The eased
  // position rather than the arriving one: the pan has to land where the mark
  // is *drawn*, and a tag still gliding to a refined pose would otherwise be
  // centred on somewhere it has not reached. A dead entity is fading out and is
  // not something to bring on screen.
  function focusPos(sel) {
    if (!sel) return null;
    if (sel.kind === 'tag') {
      const m = markers.get(sel.id);
      return m && !m.dead ? m.pos : null;
    }
    if (sel.kind === 'object') {
      const o = objectDots.get(sel.id);
      return o && !o.dead ? o.pos : null;
    }
    if (sel.kind === 'client') {
      const c = clients.get(sel.id);
      return c && !c.dead ? c.cur.p : null;
    }
    return null;
  }

  canvas.addEventListener('wheel', (ev) => {
    // Shift hands the notch back to the browser, unzoomed and unswallowed.
    if (!noDefault(ev)) return;
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
    // Shift gives the right button back to the browser, which means its menu:
    // panning through the menu that the suppressed contextmenu above would
    // otherwise have hidden leaves a drag whose pointerup never arrives.
    if (ev.button !== PAN_BUTTON || clickSkipped(ev) || !takeOver()) return;
    drag = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    canvas.setPointerCapture(ev.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  // Or the menu opens on the button that starts the pan, over the map it is
  // panning, and the drag never gets its pointerup.
  canvas.addEventListener('contextmenu', (ev) => noDefault(ev));
  // Distance from a point to a segment, not to its infinite line: a tag bar is
  // 150 mm of wall and the line it lies on runs the length of the room.
  // Ids in the order the shared helper produced them — it deduplicates a pair
  // to one entry, so the key is that entry's identity and needs no sorting.
  const pairKey = (p) => `${p.kind}:${p.a.id}-${p.b.id}`;

  const pairShown = (p) =>
    !pairsFocusOnly || (focusId !== null && (p.a.id === focusId || p.b.id === focusId));

  // Which way round a pair's right-angle elbow turns. The decomposition can
  // corner at either of the rectangle's two free vertices and the two say the
  // same thing — the same two lengths, the same claim — so the choice is free,
  // and is spent on keeping the legs out of the walls. A leg drawn through a
  // wall reads as a distance a tape could be stretched along, which is the one
  // thing these legs are for.
  //
  // Settled when the map or the walls change rather than per frame: tags glide
  // to their positions and walls ease with them, so an elbow re-picked every
  // frame would flip back and forth for the length of the glide.
  const pairElbows = new Map();   // pair key -> corner at (a's across, b's up)
  // Tags are mounted on the walls, so a leg leaves its tag from the very plane
  // it must not be counted against. Both ends are pulled in before the test.
  const ELBOW_END_TRIM_M = 0.15;

  // Proper crossing only: two legs meeting a wall end-on at a shared point are
  // touching it, not running along it.
  const turn = (ox, oy, ux, uy, vx, vy) => (ux - ox) * (vy - oy) - (uy - oy) * (vx - ox);
  function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    return (turn(cx, cy, dx, dy, ax, ay) > 0) !== (turn(cx, cy, dx, dy, bx, by) > 0)
      && (turn(ax, ay, bx, by, cx, cy) > 0) !== (turn(ax, ay, bx, by, dx, dy) > 0);
  }

  function chooseElbows() {
    pairElbows.clear();
    // An elevation draws a wall as the face of it, not as a footprint, so there
    // is no second way past one to pick.
    if (elevation) return;
    const segs = walls.filter((s) => !s.dead).map((s) => [...s.ta, ...s.tb]);
    if (!segs.length) return;
    for (const pair of pairs) {
      // The positions the map arrived with, not the gliding ones — see above.
      const [ax, ay] = proj(pair.a.p);
      const [bx, by] = proj(pair.b.p);
      const crossings = (ex, ey) => {
        let n = 0;
        for (const [p, q, trimP] of [[[ax, ay], [ex, ey], true], [[ex, ey], [bx, by], false]]) {
          const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
          // A stub shorter than the two trims is not drawn long enough to read
          // as running anywhere.
          if (len <= ELBOW_END_TRIM_M * 2) continue;
          const t = ELBOW_END_TRIM_M / len;
          // Only the tag end of each leg is pulled in; the corner is out in the
          // room and a wall through it is a wall the leg really does cross.
          const x1 = trimP ? p[0] + (q[0] - p[0]) * t : p[0];
          const y1 = trimP ? p[1] + (q[1] - p[1]) * t : p[1];
          const x2 = trimP ? q[0] : q[0] - (q[0] - p[0]) * t;
          const y2 = trimP ? q[1] : q[1] - (q[1] - p[1]) * t;
          for (const s of segs) if (segsCross(x1, y1, x2, y2, s[0], s[1], s[2], s[3])) n++;
        }
        return n;
      };
      // Ties keep the corner the view has always turned: with no wall to
      // separate them the two elbows are equally good, and one of them being
      // the default is what stops the pick wandering as walls come and go.
      if (crossings(ax, by) < crossings(bx, ay)) pairElbows.set(pairKey(pair), true);
    }
  }

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

  // Where the pointer is, in canvas pixels, and the transform the last frame was
  // drawn with. Screen coordinates are kept rather than room ones and converted
  // at draw time: a pan or a zoom under a pointer that never moved changes what
  // it is over, and a readout frozen until the mouse twitches is a readout that
  // lies while the map is being driven.
  let pointerPx = null;
  let lastXf = null;

  // A canvas point in room coordinates, as the pair of axes this view keeps.
  // The inverse of the draw pass, in its order: out of the rotation first, then
  // out of `toPx`. Null before the first frame, when there is no transform to
  // invert.
  function screenToRoom(sx, sy) {
    if (!lastXf) return null;
    const {
      ca, cb, scale, w, h, rot,
    } = lastXf;
    const [x, y] = unrotateScreen(sx, sy, w, h, rot);
    return [(x - w / 2) / scale + ca, orient * (y - h / 2) / scale + cb];
  }

  // The other way, off the same snapshot and in the reverse order: `toPx`, then
  // into the rotation. Written beside its inverse so the pair cannot drift —
  // the turn is `unrotateScreen` with the angle negated, which is the same
  // matrix and not a second copy of it.
  function roomToScreen(a, b) {
    if (!lastXf) return null;
    const {
      ca, cb, scale, w, h, rot,
    } = lastXf;
    return unrotateScreen((a - ca) * scale + w / 2, orient * (b - cb) * scale + h / 2, w, h, -rot);
  }

  // What the pointer was last reported to be over, so a move across one tag
  // does not repaint the drawer four hundred times.
  let reportedHover = '';
  function reportHover(h) {
    const key = h ? `${h.kind}:${h.id}` : '';
    if (key === reportedHover) return;
    reportedHover = key;
    onHover?.(h);
  }

  // The client dot under the pointer, when no tag glyph claimed it first — a
  // tag bar crossing a client dot goes to the tag, matching draw order.
  const CLIENT_HIT_PX = 10;
  function clientAt(x, y) {
    for (const c of lastClientDots) {
      if (Math.hypot(x - c.x, y - c.y) <= CLIENT_HIT_PX) return c.id;
    }
    return null;
  }

  // The object mark under the pointer, when nothing above it claimed it first.
  // Last in the order because objects are drawn under everything — the survey is
  // what the room is measured by, and a guess about the furniture must not take
  // a hover from it. Nearest centre wins where two overlap, which on this map is
  // the normal case: duplicates of one thing sit within a few centimetres.
  const OBJECT_HIT_MIN_PX = 8;
  function objectAt(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const o of lastObjectDots) {
      const d = Math.hypot(x - o.x, y - o.y);
      if (d <= Math.max(OBJECT_HIT_MIN_PX, o.r) && d < bestD) {
        bestD = d;
        best = o.id;
      }
    }
    return best;
  }

  // What is under a canvas point, as the `{ kind, id }` every surface names an
  // entity by. Tag, then client, then object — draw order, so what is drawn on
  // top is what is picked.
  //
  // One test for the hover and the click both. Two would eventually disagree,
  // and the way that shows up is a mark lighting up under the pointer while a
  // different one takes the click.
  function hitAt(x, y) {
    const tagId = markerAt(x, y);
    if (tagId !== null) return { kind: 'tag', id: tagId };
    const clientId = clientAt(x, y);
    if (clientId !== null) return { kind: 'client', id: clientId };
    const objId = objectAt(x, y);
    return objId !== null ? { kind: 'object', id: objId } : null;
  }

  canvas.addEventListener('pointermove', (ev) => {
    // Before the drag branch below returns: the readout has to keep up while
    // the paper is being pushed around, which is when a reading is most likely
    // to be wanted.
    pointerPx = [ev.offsetX, ev.offsetY];
    schedule();
    if (!drag) {
      const h = hitAt(ev.offsetX, ev.offsetY);
      canvas.style.cursor = h ? 'pointer' : '';
      reportHover(h);
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

  canvas.addEventListener('pointerleave', () => {
    pointerPx = null;
    reportHover(null);
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

  // Selecting is the **left** button, and it has to be its own press rather than
  // something hung off the pan's: the pan is on the right (see PAN_BUTTON), so a
  // left press never enters that path at all. The two gestures are on different
  // buttons and cannot be confused, which is also why this needs no threshold
  // against a pan — only against the hand's own wobble.
  //
  // A touch pointer reports button 0 and cannot pan, so a tap selects, which is
  // the only sensible thing a tap on a mark could mean.
  const CLICK_SLOP_PX = 5;
  let press = null;
  canvas.addEventListener('pointerdown', (ev) => {
    press = ev.button === 0 ? { id: ev.pointerId, x: ev.offsetX, y: ev.offsetY } : null;
  });
  canvas.addEventListener('pointerup', (ev) => {
    const p = press;
    press = null;
    // This is a click, assembled by hand rather than delivered as one, so it
    // asks the shift question itself — the guard that swallows clicks page-wide
    // has no `click` event here to swallow.
    if (!p || p.id !== ev.pointerId || clickSkipped(ev)) return;
    if (Math.hypot(ev.offsetX - p.x, ev.offsetY - p.y) > CLICK_SLOP_PX) return;
    // Hit-tested where the press landed rather than where it ended: within the
    // slop they are the same spot, and the press is the one that was aimed.
    const sel = hitAt(p.x, p.y);
    if (sel) onSelect?.(sel);
  });

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

  function draw(now) {
    if (!loop.active) return;
    const dt = lastFrameAt ? now - lastFrameAt : 16;
    lastFrameAt = now;

    // All text is queued and drawn after everything else: labels must never
    // sit under a wall stroke or a tag, and if a spot is taken the label
    // steps aside rather than overprints. Obstacles are the wall and tag
    // strokes of this same frame, in pixels.
    const labels = [];
    const obstacles = [];
    // `pin` is a fixed offset from the anchor for a label whose *place* is part
    // of what it says — the client label sits opposite the heading arrow, so it
    // may not be dodged somewhere else and then read as pointing the wrong way.
    // A pinned label takes its spot before anything searches and is drawn last,
    // over whatever it lands on.
    // `opts.sub` is an array of smaller lines drawn under the first and placed
    // as one block with it — detail belonging to the same mark, not further
    // labels that could end up somewhere else and be read against another one.
    // `opts.fixed` opts the label out of the dodge entirely, in both directions:
    // it does not move and nothing moves for it. Both in an options bag rather
    // than as a ninth and tenth positional, which is where the argument list
    // stopped being readable.
    const queueLabel = (key, text, x, y, color, bg, alpha = 1, pin = null, opts = null) =>
      labels.push({
        key,
        text,
        x,
        y,
        color,
        bg,
        alpha,
        pin,
        sub: opts?.sub?.length ? opts.sub : null,
        fixed: !!opts?.fixed,
      });
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
      // Keyed by size as well as by string: the sub line is set smaller, and one
      // cache across two fonts would hand back whichever width happened to be
      // measured first.
      const halfWidth = (text, small) => {
        const key = small ? `sub:${text}` : text;
        let half = textHalfWidths.get(key);
        if (half === undefined) {
          if (textHalfWidths.size > 512) textHalfWidths.clear();
          if (small) ctx.font = LABEL_SUB_FONT;
          half = ctx.measureText(text).width / 2;
          if (small) ctx.font = LABEL_FONT;
          textHalfWidths.set(key, half);
        }
        return half;
      };
      // A two-line label is as wide as its widest line and reaches a line
      // further down. Everything that places or reserves space goes through
      // these two, so the dodge, the obstacle test and the drawing can never
      // disagree about how big a label is.
      const labelHalf = (lb) => (lb.sub || []).reduce(
        (m, s) => Math.max(m, halfWidth(s, true)), halfWidth(lb.text));
      const labelDrop = (lb) => (lb.sub ? lb.sub.length * LABEL_SUB_DY : 0);
      // The dodge runs in the same turned space as the geometry it is dodging;
      // only the drawing is straightened, about the spot the label ended up at.
      // Text that rode the rotation would be sideways or upside down exactly
      // when the map is most in use.
      const drawLabel = (lb, x, y) => {
        if (labelRot) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(labelRot);
          ctx.translate(-x, -y);
        }
        if (lb.bg) {
          const w2 = labelHalf(lb) + 4;
          ctx.fillStyle = lb.bg;
          ctx.fillRect(x - w2, y - 11, w2 * 2, 14 + labelDrop(lb));
        }
        ctx.fillStyle = lb.color;
        ctx.fillText(lb.text, x, y);
        if (lb.sub) {
          // Smaller, and only smaller. The size difference is what says the
          // rows are subordinate to the name; dimming them as well would make
          // the detail hard to read at exactly the zoom it exists for.
          ctx.font = LABEL_SUB_FONT;
          lb.sub.forEach((s, i) => ctx.fillText(s, x, y + (i + 1) * LABEL_SUB_DY));
          ctx.font = LABEL_FONT;
        }
        if (labelRot) ctx.restore();
      };
      const boxFor = (lb, ox, oy) => ({
        minX: lb.x + ox - labelHalf(lb) - LABEL_PAD,
        minY: lb.y + oy - 11 - LABEL_PAD,
        maxX: lb.x + ox + labelHalf(lb) + LABEL_PAD,
        maxY: lb.y + oy + 3 + labelDrop(lb) + LABEL_PAD,
      });
      // Solid labels claim their spot first and the fading ones dodge around
      // them, never the other way round. Below half opacity a label stops
      // reserving at all — a ghost about to disappear must not push a live
      // label aside for good, since a kept spot is only given up when blocked.
      const order = labels.slice().sort((a, b) => b.alpha - a.alpha);
      // A fixed label sits on its anchor and takes no part in any of this: it
      // neither dodges nor reserves. The dodge exists so that a label which
      // *names a place* is not read against the wrong mark, and it pays for that
      // with a label that can end up a long way from what it names. An object
      // label is not naming a place — the object's mark is drawn around it and
      // its own coordinate is in the text — so it can sit dead on the thing and
      // let whatever else lands there land there. Drawn before everything, so
      // the survey's own text is the layer on top when they do collide.
      for (const lb of order) {
        if (!lb.fixed || lb.alpha <= 0.01) continue;
        ctx.globalAlpha = lb.alpha;
        drawLabel(lb, lb.x, lb.y);
      }
      // A pinned label cannot move, so it is the one thing every dodge has to
      // route around: it reserves before the search starts rather than in turn.
      for (const lb of order) {
        if (lb.fixed) continue;
        if (lb.pin && lb.alpha > 0.5) taken.push(boxFor(lb, lb.pin[0], lb.pin[1]));
      }
      // Held back and drawn after the rest, so a pinned label lands on top of
      // whatever could not get out of its way.
      const pinned = [];
      for (const lb of order) {
        if (lb.alpha <= 0.01 || lb.fixed) continue;
        if (lb.pin) {
          pinned.push(lb);
          continue;
        }
        ctx.globalAlpha = lb.alpha;
        const half = labelHalf(lb);
        const drop = labelDrop(lb);
        let x = lb.x;
        let y = lb.y;
        const boxAt = (ox, oy) => boxFor(lb, ox, oy);
        const clearAt = (ox, oy) => {
          const cx = lb.x + ox;
          const cy = lb.y + oy;
          const b = boxAt(ox, oy);
          if (taken.some((t) => t.minX < b.maxX && t.maxX > b.minX
            && t.minY < b.maxY && t.maxY > b.minY)) return false;
          return obstacles.every((o) => !segHitsBox(o.x1, o.y1, o.x2, o.y2,
            cx - half - o.r, cy - 10 - o.r, cx + half + o.r, cy + 2 + drop + o.r));
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
        drawLabel(lb, x, y);
      }
      for (const lb of pinned) {
        ctx.globalAlpha = lb.alpha;
        drawLabel(lb, lb.x + lb.pin[0], lb.y + lb.pin[1]);
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
      // Same quick clock as the tag hover — pointer feedback, not smoothing.
      ph.hot = animFade(ph.hot ?? 0,
        hovered?.kind === 'client' && ph.id === hovered.id, dt, HOVER_MS);
      // Dead reckoning is a state the reader acts on (walk back toward a
      // tag), so it fades like staleness does rather than snapping.
      ph.drMix = animFade(ph.drMix ?? 0, !!ph.dr, dt);
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
      m.hot = animFade(m.hot, hovered?.kind === 'tag' && id === hovered.id, dt, HOVER_MS);
      m.anchorMix = animFade(m.anchorMix, id === markerMap?.anchorId, dt);
      // Whether the survey is still working on this tag, from the same verdict
      // the drawer's dot is painted from (`tagSettleState`, common.js) — the
      // two surfaces are looking at one tag and must not disagree about it.
      // The datum is exempt: it is where it is by definition and there is no
      // measurement to be settled. A tag on its way out is left alone rather
      // than asked, so a forgotten tag fades out rather than growing a border
      // on the way.
      const settling = !m.dead && !!m.rec
        && !['settled', 'datum'].includes(tagSettleState(m.rec, markerMap?.anchorId));
      // Default speed, not HOVER_MS: this is a change in the survey rather than
      // pointer feedback, and a border that snaps off reads as a glitch instead
      // of as a tag arriving somewhere.
      m.settleMix = animFade(m.settleMix ?? 0, settling, dt);
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

    // Objects ease and fade like the tags: a promotion, a re-seed after
    // something was moved, or a forget is worth being able to watch happen.
    for (const [id, o] of objectDots) {
      o.fade = animFade(o.fade, !o.dead, dt);
      if (o.dead && o.fade === 0) {
        objectDots.delete(id);
        continue;
      }
      animApproachArr(o.pos, o.tp, dt, MOTION_TAU_MS);
      o.r = animApproach(o.r, o.tr, dt, MOTION_TAU_MS);
    }

    poseMix = animFade(poseMix, showPose, dt);
    objectsAlpha = animFade(objectsAlpha, showObjects, dt);
    objCandAlpha = animFade(objCandAlpha, showObjectCandidates, dt);
    wallsAlpha = animFade(wallsAlpha, showWalls, dt);
    backdropAlpha = animFade(backdropAlpha, showBackdrop, dt);
    pairsAlpha = animFade(pairsAlpha, showPairs, dt);
    // With the backdrop gone there is nothing behind the text but the camera
    // passthrough — a moving, unpredictably bright picture, and a distance or a
    // tag name laid straight on it is lost against exactly the busy patch it is
    // describing. So every value carries its own plate, and only then: on the
    // dark backdrop the same plates would be boxes drawn around text for no
    // reason. Tied to the fading alpha rather than to the switch, so the plates
    // arrive as the backdrop leaves instead of appearing after it.
    const labelBg = backdropAlpha > 0.99
      ? null
      : `rgba(10,12,14,${(0.62 * (1 - backdropAlpha)).toFixed(3)})`;
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
    //
    // The near fit keeps the centre and takes a different radius: only as far as
    // what this client is dealing with right now, which is the tags it can see —
    // the sight lines are drawn to them, and a line running off the edge of the
    // screen points at nothing — and the place it has been told to walk to.
    // Everything else in the room stays where it is and simply falls outside.
    // It needs the client itself to do that, so until one is named *and* on the
    // map the view stays out at the whole-room fit rather than closing in on a
    // guess — a wrong guess here is a map zoomed hard into an empty patch of
    // floor, which looks exactly like a map that has broken.
    const follow = mode === 'top' && followPos
      && (headingRad !== null || nearFit) ? proj(followPos) : null;
    const self = nearFit && selfId !== null ? clients.get(selfId) : null;
    if (follow) {
      const [fa, fb] = follow;
      let rad;
      if (self) {
        rad = NEAR_FIT_MIN_M;
        for (const id of self.seen || []) {
          const m = markers.get(id);
          if (!m || m.dead) continue;
          const [ta, tb] = proj(m.pos);
          rad = Math.max(rad, Math.hypot(ta - fa, tb - fb));
        }
        rad *= NEAR_FIT_MARGIN;
      } else {
        rad = Math.max(2.5, Math.hypot(
          Math.max(fa - minA, maxA - fa), Math.max(fb - minB, maxB - fb)));
      }
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
    // The transform this frame was drawn with, kept so a pointer can be carried
    // back through it after the frame is over. Taken from `shown` — the eased
    // view, which is what is on screen — and never from `view`: mid-pan the two
    // disagree by exactly the distance the readout would then be wrong by.
    lastXf = { ca, cb, scale, w, h, rot: viewRot };

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
    const unturn = (sx, sy) => unrotateScreen(sx, sy, w, h, turned ? viewRot : 0);

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

    ctx.font = LABEL_FONT;
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
        gx + ux * lp, gy + uy * lp + 4, roomAxisColorCss(k), labelBg);
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
              '#b9c6cb', labelBg, wallsAlpha * seg.fade);
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
      // A leg is a statement about two tags, so it is on screen only while both
      // of them are. Presence is the whole of it: a leg is a measurement, and a
      // half-faded number reads as a less certain one, which it never is.
      if (Math.min(markers.get(a.id)?.fade ?? 1, markers.get(b.id)?.fade ?? 1) <= 0.01) continue;
      ctx.globalAlpha = 1;
      // The elbow: by default b's across-screen axis and a's up-screen one, the
      // other way round where that is the corner that keeps the legs out of the
      // walls (see chooseElbows). Built off this view's own axis pair rather
      // than off a fixed component, or a projection that does not keep x draws
      // its corner on top of one of the tags.
      const [ax, ay] = px(ap);
      const [bx, by] = px(bp);
      const elbow = ap.slice();
      if (pairElbows.get(key)) elbow[axisB] = bp[axisB];
      else elbow[axisA] = bp[axisA];
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
          (x1 + x2) / 2, (y1 + y2) / 2 - 3, legColor, labelBg, 1);
      });
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // Detected objects, under the tags: the survey is what the room is measured
    // by and must not be obscured by a guess about the furniture.
    lastObjectDots = [];
    if (objectsAlpha > 0.01 || objCandAlpha > 0.01) {
      // The co-visibility legs of the opened object, under its own mark and
      // under everything else's. One line per thing it has been in frame with,
      // its weight the count: what this drawer question is really asking is
      // which of the room's things travel together, and a leg that looked the
      // same at three sightings and three hundred would answer it wrongly.
      //
      // Drawn from the *opened* object only. The whole table at once is a web
      // across the room with a line between every pair, which is a picture of
      // the map's density rather than of any object's neighbourhood.
      // Which of the two fades a mark belongs to, in one place: the colour, the
      // dash and the switch all have to agree about what "committed" means, and
      // three copies of the test is three chances for a mark to be drawn in one
      // half's palette while the other half's button controls it.
      const committedOf = (rec) => !!(rec?.promoted && rec.usable !== false);
      const alphaOf = (rec) => (committedOf(rec) ? objectsAlpha : objCandAlpha);
      const focus = focusObjectId === null ? null : objectDots.get(focusObjectId);
      // The legs fade with the object they radiate from — a hidden object with
      // its neighbourhood still drawn is a web anchored on nothing.
      const focusAlpha = focus ? alphaOf(focus.rec) : 0;
      if (focus?.rec?.seenWith?.length && focusAlpha > 0.01) {
        const [fx, fy] = px(focus.pos);
        const top = focus.rec.seenWith.reduce((m, [, n]) => Math.max(m, n), 1);
        ctx.setLineDash([]);
        for (const [k, n] of focus.rec.seenWith) {
          let to = null;
          if (k.startsWith('t')) {
            const tag = markerMap?.markers?.find((m) => m.id === Number(k.slice(1)));
            if (tag) to = px(tag.p);
          } else {
            const other = objectDots.get(Number(k.slice(1)));
            if (other) to = px(other.pos);
          }
          if (!to) continue;
          // A tag partner is a different claim from an object one — it puts this
          // near a *surveyed* position — so it is drawn in the tag's own colour
          // rather than the object palette, which is the same distinction the
          // card's text makes.
          ctx.strokeStyle = k.startsWith('t')
            ? roomTagColorCss(Number(k.slice(1))) : ROOM_OBJECT_BEST_CSS;
          ctx.globalAlpha = focusAlpha * (0.25 + 0.55 * (n / top));
          ctx.lineWidth = 1 + 1.5 * (n / top);
          ctx.beginPath();
          ctx.moveTo(fx, fy);
          ctx.lineTo(to[0], to[1]);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
      }
      for (const [, o] of objectDots) {
        // Which half this mark is in, decided before anything is drawn: the halo
        // and the hit target are the object too, and a ring switched off that
        // still lights under the pointer is a target for something invisible.
        const committed = committedOf(o.rec);
        const objAlpha = committed ? objectsAlpha : objCandAlpha;
        if (objAlpha <= 0.01) continue;
        const [ox, oy] = px(o.pos);
        // Straight off the scale rather than by projecting an offset point: the
        // projection is uniform in both axes, so a metre is `scale` pixels in
        // every view and there is no axis to pick. The offset used to be built
        // along room x unconditionally, which the front elevation collapses —
        // there every ring came out at the 4 px floor whatever its scatter.
        const rPx = Math.max(4, o.r * scale);
        // The pointer target, and the halo. An object the drawer has open or the
        // pointer is over gets a ring behind it in the neutral highlight white —
        // the same one a hovered tag gets, and neutral for the same reason: the
        // object already owns two colours saying what it is, and a third meaning
        // "this one" would be a third thing to learn. Behind the mark, so the
        // mark is still the thing being read.
        const lit = focusObjectId === o.rec?.id
          || (hovered?.kind === 'object' && hovered.id === o.rec?.id);
        if (lit) {
          ctx.globalAlpha = o.fade * objAlpha;
          ctx.strokeStyle = HOVER_HALO_CSS;
          ctx.lineWidth = 3;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(ox, oy, rPx + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        // Dashed, always. A solid ring would read like the carved walls, which
        // are evidence; this is an estimate from a neural detector and has to
        // look like one.
        //
        // And it is an estimate of an *error*, not of a size: `e.r` is the 90th
        // percentile of the inlier bearings' own residuals (`objects.js`), so a
        // fat ring means the sightings disagreed about where the thing is. The
        // solid mark below is the size. They are usually not the same order —
        // scatter floors at 5 cm and most furniture is wider than that — so the
        // size mark normally reaches past the ring rather than sitting inside
        // it, which is the honest picture: a well-located object is a big shape
        // with a small ring at its middle.
        // **State is never carried by opacity here.** A dimmed object is a
        // half-erased one: at 28% it was unreadable over the carved floor and
        // the grid, which is how a mapped clock came to be reported as missing
        // in the first place. Alpha is the fade animation and the show/hide
        // switch, and nothing else — every state below is a difference in the
        // stroke, which stays legible at full strength.
        const objCss = committed ? ROOM_OBJECT_BEST_CSS : ROOM_OBJECT_CSS;
        ctx.globalAlpha = o.fade * objAlpha;
        ctx.strokeStyle = objCss;
        // The measured size, under the scatter ring so the ring stays readable
        // over it. Solid and filled where the ring is dashed and hollow: this is
        // a length in metres the map actually measured, and the two marks must
        // not be able to be mistaken for one another. What shape it takes — and
        // whether there is one at all — is `objMark`'s call, on how many extents
        // this view has behind it.
        const mark = o.rec ? objMark(o.rec, axisA, axisB, orient) : null;
        // The detail rows, computed here rather than at the label because the
        // dimension bar has to be placed clear of them.
        const near = scale >= OBJ_DETAIL_PX_PER_M;
        const sub = near && o.rec ? objDetail(o.rec, 3 - axisA - axisB,
          o.pos[3 - axisA - axisB]) : null;
        if (mark) {
          ctx.lineWidth = 1;
          ctx.fillStyle = committed ? ROOM_OBJECT_BEST_FILL_CSS : ROOM_OBJECT_FILL_CSS;
          if (mark.kind === 'ellipse') {
            ctx.beginPath();
            ctx.ellipse(ox, oy, mark.rx * scale, mark.ry * scale, mark.rot, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          } else if (mark.rot !== null || near) {
            // A length with no bearing behind it, drawn flat on the screen and
            // deliberately *unturned*: on a heading-up map every room direction
            // swings with the room and this one does not, which is the signal
            // that it is a measurement and not an outline. End ticks for the
            // same reason — a bare line reads as a thin object seen edge on,
            // which is exactly the claim being avoided.
            //
            // **Slung under the object rather than through it, and only close
            // up.** A dimension is not where the thing is; drawn across the
            // centre it read as part of the mark, and at a zoom where objects
            // are a few pixels apart a field of crossed lines said nothing at
            // all. Below the ring and below the rows it belongs with, it reads
            // as what it is — the caption's last line, drawn instead of written.
            //
            // A bar that *did* come out of a facing (a fitted disc seen edge on)
            // is not a dimension at all: it is the object's own outline, seen
            // edge on. That one keeps its angle, keeps the centre, and is drawn
            // at every zoom like any other shape.
            const dim = mark.rot === null;
            const rot = dim ? -viewRot : mark.rot;
            const half = (mark.len / 2) * scale;
            // Clear of the ring and of the rows: the label block straddles the
            // centre, so its bottom is half a drop below the baseline.
            const drop = sub ? sub.length * LABEL_SUB_DY : 0;
            const by = dim ? Math.max(oy + rPx, oy + 4 + drop / 2 + 3) + 7 : oy;
            ctx.save();
            ctx.translate(ox, by);
            ctx.rotate(rot);
            ctx.beginPath();
            ctx.moveTo(-half, 0);
            ctx.lineTo(half, 0);
            ctx.moveTo(-half, -BAR_TICK_PX);
            ctx.lineTo(-half, BAR_TICK_PX);
            ctx.moveTo(half, -BAR_TICK_PX);
            ctx.lineTo(half, BAR_TICK_PX);
            ctx.stroke();
            ctx.restore();
          }
        }
        ctx.lineWidth = 1.5;
        // Dashed for a position the map has committed to, dotted for one it has
        // not — and there are two ways to not be committed: not promoted yet
        // (too few sightings, viewpoints or sessions), or promoted but still
        // standing on a depth prior rather than on parallax. The second is the
        // dangerous one to draw confidently, since it looks exactly like a
        // measured object while being a single depth reading wearing a position.
        // Carried by the dash rather than by the alpha it used to be: the two
        // read apart at a glance and both read at all.
        ctx.setLineDash(committed ? [3, 3] : [1, 3]);
        ctx.beginPath();
        ctx.arc(ox, oy, rPx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        // `usable` — whether the position came from parallax or is still
        // standing on a depth prior — used to be a filled 2 px core here. The
        // label now sits on the object's centre and covers it, and the same
        // state is already legible twice over: the ring's dash pattern, and the
        // `prior NN%` row under the name. A third telling that has to be
        // uncovered to be read is not a third telling.
        // **Every object is named, committed or not.** Candidates used to be
        // left unlabelled so a guess would not read as a fact about the room —
        // but an unlabelled dim ring reads as *nothing at all*, and a correct
        // object that looks absent is the worse failure of the two. A wall clock
        // is seen from a narrow sweep and so sits below the arc gate more or
        // less permanently; it was on this map all along and was reported as
        // missing. The label carries its own doubt instead: the ring keeps its
        // dotted stroke, and the rows under the name say which gate it is under.
        //
        // The id is what makes two rings of one class distinguishable at all,
        // and it is the same id `objects.json`, `server.log` and
        // `replay-objects.js --dump` use — so the map cross-references the
        // tooling for nothing.
        //
        // The coordinate the rows below carry is the axis *this view collapses*
        // — the one number the projection destroys, and therefore the only one
        // the picture cannot already be read for. Three axes, two kept.
        // With a gaze set, only what the client is pointing at is named — see
        // `setGaze`. Measured in the projected pair of room axes and without
        // `orient`, which is a screen convention and would flip the test on an
        // elevation: this is a bearing in the room, not an angle on the canvas.
        // An object the client is standing on has no bearing to test and counts
        // as looked at.
        let named = true;
        if (gaze) {
          const fa = gaze.fwd[axisA];
          const fb = gaze.fwd[axisB];
          const da = o.pos[axisA] - gaze.pos[axisA];
          const db = o.pos[axisB] - gaze.pos[axisB];
          const fl = Math.hypot(fa, fb);
          const dl = Math.hypot(da, db);
          named = fl < 1e-6 || dl < 1e-3
            || (fa * da + fb * db) / (fl * dl) >= gaze.cosHalf;
        }
        if (named && showObjectLabels && o.rec?.cls) {
          // **The name line is only ever the name.** Class and instance are what
          // a label is for at every zoom — which thing is this, and which of the
          // several of its class. Every number about it lives in the rows below,
          // which appear only when there is room to read them: a coordinate, a
          // size and a confidence hung off the end of the name made the widest
          // text on the map out of the one thing that has to stay scannable.
          //
          // Read off the eased position the mark is actually drawn at, not off
          // the record's target: a number that disagreed with the mark it sits
          // over would be the one thing on this map that cannot be trusted.
          const text = `${o.rec.cls} #${o.rec.id}`;
          // Dead on the object, and fixed: no dodge, nothing dodging for it.
          // The mark is drawn around this point and the text names the thing at
          // it, so a label that had wandered clear of a neighbour would be a
          // label pointing at the wrong object — the one failure the dodge
          // cannot trade away here. Two of them landing on each other is a
          // crowded map, which is a true thing about the room.
          //
          // The baseline is lifted by half of whatever hangs below it, so the
          // whole block straddles the centre rather than the name sitting on it
          // with the rows pushed off downward.
          queueLabel(`obj:${o.rec.id}`, text, ox,
            oy + 4 - ((sub ? sub.length * LABEL_SUB_DY : 0) / 2),
            // Backed like every other label on this map, which matters here more
            // than anywhere: the object label sits *on* its own mark by design,
            // and on the phone the whole map is drawn over camera passthrough —
            // text on a lit room with a dashed ring behind it is not text. The
            // backing is null wherever the backdrop is already opaque, so the
            // dashboard is unchanged.
            objCss, labelBg, o.fade * objAlpha, null,
            { sub, fixed: true });
        }
        // The hit target, in the same turned space the pointer is tested in.
        // Recorded last so it is the mark as actually drawn, ring and all.
        if (o.rec && !o.dead) lastObjectDots.push({ id: o.rec.id, x: ox, y: oy, r: rPx });
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
      const tagColor = animMixCss(roomTagColorCss(id), ROOM_ANCHOR_COLOR_CSS, m.anchorMix);
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
      // The survey is not done with this tag. Absence is the resting state, so
      // a converged room draws no borders at all and a border always means go
      // and look — which is why it is the *unsettled* tag that is marked and
      // not the settled one. On the chip rather than on the bar: the bar is the
      // tag's identity colour, shared with the drawer, and the hover halo
      // already owns the shape around it. One pixel out from the chip and the
      // halo two, so a settling tag that is also hovered shows both rings
      // concentrically instead of one overdrawing the other.
      if (m.settleMix > 0.01) {
        ctx.globalAlpha = m.fade * m.settleMix;
        ctx.strokeStyle = ROOM_SETTLING_CSS;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-chipHalf - 1, side * 9 - 8, chipHalf * 2 + 2, 16);
        ctx.globalAlpha = m.fade;
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(idText, 0, side * 9 + 4);
      // Underlined, because the chip turns with the bar: a heading-up map spins
      // the whole room under a reader who has no horizon to read the digits
      // against, and the flip that keeps the chip from ever being upside down
      // means the number's own up is not the map's. One digit gives no clue at
      // all on its own, and 6 and 9 are the same glyph turned over. The rule is
      // the baseline made visible, so it is the width of the number rather than
      // of the chip.
      ctx.fillRect(-(chipHalf - 4), side * 9 + 5, (chipHalf - 4) * 2, 1.5);
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
    lastClientDots = [];
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
      if (!ph.dead) lastClientDots.push({ id: ph.id, x: sx, y: sy });
      // Under everything of this client's, the same neutral white the tag
      // hover uses — the client's own colour is its identity and stays.
      const hot = ph.hot || 0;
      if (hot > 0.01) {
        ctx.globalAlpha = fade * hot;
        ctx.strokeStyle = HOVER_HALO_CSS;
        ctx.lineWidth = 3 * hot;
        ctx.beginPath();
        ctx.arc(sx, sy, CLIENT_HIT_PX, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = fade;
      }

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
        // Big enough to be a shape of its own, the circle has to say what it
        // is — unlabelled, it read as some mysterious zone rather than as
        // "your position, give or take this much".
        if (rPx > 28) {
          queueLabel(`unc:${ph.id}`, `±${ph.shownRadius.toFixed(1)} m`,
            ux, uy - rPx - 4, color, labelBg, fade * ringAlpha * 0.8);
        }
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
            (sx + tx) / 2, (sy + ty) / 2 - 4, roomAngleColor(ang), labelBg, lineAlpha);
        }
      }

      // Heading: a 0.2 m world-space arrow through the projection — but
      // floored in screen pixels, because a heading is a direction, not a
      // measurement, and at the phone map's zoom 0.2 m shrank to a nub the
      // dot swallowed. Direction stays world-true; only the length is drawn.
      const tip = anchorP.map((v, i) => v + ph.cur.fwd[i] * 0.2);
      const [hx, hy] = px(tip);
      let dxh = hx - sx;
      let dyh = hy - sy;
      const hlen = Math.hypot(dxh, dyh);
      if (hlen > 1e-6 && hlen < HEADING_MIN_PX) {
        dxh *= HEADING_MIN_PX / hlen;
        dyh *= HEADING_MIN_PX / hlen;
      }
      // Dead reckoning draws the heading dashed and the dot hollow: the
      // survey is not standing behind this pose, and the map must not present
      // an inertial guess with the same weight as a fix. Cross-faded on
      // drMix, so the state change is watchable rather than a blink.
      const dr = ph.drMix ?? 0;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      if (dr < 0.99) {
        ctx.globalAlpha = fade * (1 - dr);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + dxh, sy + dyh);
        ctx.stroke();
      }
      if (dr > 0.01) {
        ctx.globalAlpha = fade * dr;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + dxh, sy + dyh);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = fade;
      if (poseMix > 0.01) {
        // Grown rather than switched on, so the dot and the centre marker it
        // replaces read as one thing changing. The fill hollows out as dead
        // reckoning takes over; the outline stays, so the client never loses
        // its place on the map — only its claim to certainty.
        ctx.fillStyle = color;
        if (dr < 0.99) {
          ctx.globalAlpha = fade * (1 - dr);
          ctx.beginPath();
          ctx.arc(sx, sy, 6 * poseMix, 0, Math.PI * 2);
          ctx.fill();
        }
        if (dr > 0.01) {
          ctx.globalAlpha = fade * dr;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sx, sy, 5 * poseMix, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = fade;
      }
      const [pa, pb] = proj(anchorP);
      // Heading-up: the label goes behind the client, opposite the arrow, and
      // stays there. On this map the arrow is the thing being read while
      // walking, and a label free to dodge sat on it as often as not — worse,
      // "behind me" is information, so a label that hops to the far side of the
      // dot is saying something untrue about which way the phone is pointing.
      // Pinned it also stops giving way to sight-line distances and tag names,
      // which are the labels it was losing to and the least of what is on
      // screen. North-up it dodges as before: there is no arrow to be opposite
      // to, since the client's own heading is then just one more mark.
      const hn = Math.hypot(dxh, dyh);
      const pin = headingRad !== null && hn > 1e-6
        ? [-dxh / hn * CLIENT_LABEL_PIN_PX, -dyh / hn * CLIENT_LABEL_PIN_PX + 4]
        : null;
      queueLabel(`client:${ph.id}`,
        `C${ph.id} · ${pa.toFixed(2)}, ${pb.toFixed(2)}${dr > 0.5 ? ' · DR' : ''}`,
        sx, pin ? sy : sy - 12, color, labelBg, fade, pin);
      ctx.globalAlpha = 1;
    }

    // Back to screen space for the text. The labels carry turned-space
    // coordinates, so the context has to still be turned while they are placed
    // — each one straightens itself about its own anchor instead.
    labelRot = -viewRot;
    flushLabels();
    if (turned) ctx.restore();

    // Where the pointer is, in room metres. The map is a picture of a measured
    // room and there was no way to ask it what a spot *is* — reading a position
    // off it meant hovering something that already had a label.
    //
    // Outside the turn and after the labels, in plain canvas pixels: this
    // belongs to the canvas rather than to the room, and a reading that rode a
    // heading-up rotation would be sideways exactly when the map is in use. One
    // line per axis this view keeps, in the corner gizmo's own colours, so the
    // two agree about which letter is which direction — the gizmo says where
    // the axes point, this says how far along them the pointer is.
    if (pointerPx) {
      const at = screenToRoom(pointerPx[0], pointerPx[1]);
      if (at) {
        ctx.textAlign = 'right';
        const rx = w - AXIS_GIZMO_PAD;
        let ry = AXIS_GIZMO_PAD + 10;
        [axisA, axisB].forEach((axis, i) => {
          ctx.fillStyle = roomAxisColorCss(axis);
          ctx.fillText(fmtAxis(axis, at[i]), rx, ry);
          ry += 15;
        });
        ctx.textAlign = 'center';
      }
    }
    schedule();
  }

  return {
    setActive(on) {
      if (on) {
        lastFrameAt = 0;
        // A hidden view ran no frames, so its eased viewport is as old as the
        // last time it was looked at. Re-seeded from whatever is in force now
        // rather than swept there over the first tenth of a second.
        shown = null;
      }
      loop.setActive(on);
    },

    setShowPose(on) {
      showPose = on;
      schedule();
    },

    // { kind, id } or null — one entity hot across the whole dashboard.
    setHovered(h) {
      const key = h ? `${h.kind}:${h.id}` : '';
      if (key === (hovered ? `${hovered.kind}:${hovered.id}` : '')) return;
      hovered = h;
      schedule();
    },

    // The tag whose card is open in the drawer. Only meaningful with
    // `pairsFocusOnly`, where it is what decides which legs are drawn at all.
    setFocusMarker(id) {
      if (id === focusId) return;
      focusId = id;
      schedule();
    },

    // The object whose card is open in the drawer. What it decides is which
    // object's co-visibility legs are drawn — every object's at once is a web
    // across the room, and "what has this been seen with" is a question asked of
    // one thing at a time. Told from outside for the same reason the hover and
    // the focused tag are: the drawer and every room view have to agree, and the
    // only thing that can know is the viewer.
    setFocusObject(id) {
      if (id === focusObjectId) return;
      focusObjectId = id;
      schedule();
    },

    // Bring one entity on screen, for a card opened in a drawer that cannot see
    // this canvas. `{ kind, id }`, the shape every surface names an entity by.
    //
    // Only when it is not already comfortably on screen, because this is not
    // free: any view written from outside latches this pane out of its auto-fit
    // for good (see takeOver), and doing that for a tag the eye is already on
    // would cost the fit and give nothing. It also makes the reverse gesture
    // silent on its own — a card opened by clicking the mark cannot pan the map
    // away from the mark that was clicked.
    //
    // Only the centre moves. The scale is the reader's, and a card opened to
    // check a figure is not a reason to change how much of the room is in view.
    focusOn(sel) {
      const p = focusPos(sel);
      // No transform yet means no first frame: nothing to test against, and no
      // scale to keep. The next frame fits the whole room anyway, which shows
      // it.
      if (!p || !lastXf) return;
      const [a, b] = proj(p);
      const at = roomToScreen(a, b);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      // Inset from the edges, not the edges themselves: a mark two pixels
      // inside the frame is on screen and unreadable, and a mark near the edge
      // has none of its label or its legs. Capped as a fraction so a narrow
      // pane keeps a safe box at all.
      const insetX = Math.min(FOCUS_EDGE_PX, w * FOCUS_EDGE_MAX);
      const insetY = Math.min(FOCUS_EDGE_PX, h * FOCUS_EDGE_MAX);
      if (at && at[0] >= insetX && at[0] <= w - insetX
        && at[1] >= insetY && at[1] <= h - insetY) return;
      if (!takeOver()) return;
      view.ca = a;
      view.cb = b;
      schedule();
    },

    // Detected objects. Same reconcile as setMarkerMap below and for the same
    // reason: the snapshot arrives whole, and clearing it would throw away the
    // one thing that says an object at a new position is the same object.
    setObjects(list) {
      const live = new Set();
      for (const o of list || []) {
        live.add(o.id);
        const had = objectDots.get(o.id);
        if (had) {
          had.tp = o.p;
          had.tr = o.r;
          had.dead = false;
          had.rec = o;
        } else {
          objectDots.set(o.id, {
            pos: [...o.p], tp: o.p, r: o.r, tr: o.r, fade: 0, dead: false, rec: o,
          });
        }
      }
      for (const [id, o] of objectDots) if (!live.has(id)) o.dead = true;
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
          had.rec = m;
        } else {
          markers.set(m.id, {
            pos: [...m.p], q: [...m.q], tp: m.p, tq: m.q,
            normal: quatRotate(m.q, [0, 0, 1]),
            ax3: quatRotate(m.q, [1, 0, 0]),
            fade: 0, dead: false, hot: 0, settleMix: 0,
            // The arriving record, kept whole. `tagSettleState` needs the
            // residuals and the refinement timestamps, and it needs the tag's
            // *stored* pose — `pos`/`q` here are the eased ones, and a tag
            // still gliding to where the survey just put it would read as one
            // the survey is still moving.
            rec: m,
            // Seeded at the answer: a tag that arrives as the anchor is the
            // anchor, it did not become one.
            anchorMix: m.id === map.anchorId ? 1 : 0,
          });
        }
      }
      for (const [id, m] of markers) {
        if (!live.has(id)) m.dead = true;
      }
      chooseElbows();
      schedule();
    },

    // `uncertainty` is { r, p }: the radius of the "probably here" circle and
    // the point it is centred on. They are one measurement, and neither is the
    // pose — the pose is the newest single reading, the circle is the spread
    // the readings scattered over, so the circle moves far less than the dot.
    // A null p (non-XR client, or no window yet) falls back to the pose.
    updateClient(clientId, pose, seenTagIds = [], uncertainty = null, room = null) {
      let ph = clients.get(clientId);
      if (!ph) {
        ph = {
          id: clientId,
          color: roomClientColorCss(clientId),
          cur: { p: [...pose.p], fwd: [0, 0, 1] },
          target: null, seen: [], at: 0,
          uncertaintyM: 0, shownRadius: 0,
          ringTarget: null, ringAt: null, ringSeeded: false,
          fade: 0, dead: false, staleMix: 0, drMix: 0,
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
      // Dead reckoning, by the survey's own verdict: mapSafe is true exactly
      // when it stands behind this pose (a fresh tag fix or the alignFresh
      // carry), so the flag holds steady across the detection/carry interleave
      // instead of flickering per report. A message with no room verdict
      // (older server) keeps the last state.
      if (room) ph.dr = room.mapSafe !== true;
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
      // The walls are half of what decides which way each pair's elbow turns,
      // and they arrive on their own schedule.
      chooseElbows();
      schedule();
    },

    setLayer(name, on) {
      if (name === 'walls') {
        showWalls = on;
        schedule();
      } else if (name === 'backdrop') {
        showBackdrop = on;
        schedule();
      } else if (name === 'pairs') {
        showPairs = on;
        schedule();
      } else if (name === 'objects') {
        showObjects = on;
        schedule();
      } else if (name === 'object-candidates') {
        showObjectCandidates = on;
        schedule();
      } else if (name === 'object-labels') {
        showObjectLabels = on;
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
    // it on this room-frame point, or null for either to leave that half in the
    // room's own orientation and bounds. Both given in the room frame rather
    // than as an angle and a pair of screen coordinates, so the caller never has
    // to know which two axes this projection keeps or which way its second one
    // runs — that convention lives here and has exactly one definition.
    //
    // A centre with no direction is a view that follows the pose without turning
    // with it, which is what the near fit wants when heading-up is off.
    setHeadingUp(fwd, pos = null) {
      followPos = pos;
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

    // Where this client is standing and which way it is pointing, so the map can
    // answer "what am I looking at". Object labels are the only thing that reads
    // it: on a phone held up in a room the map is a few centimetres across, and
    // a dozen names on it is a wall of text over the one or two things in front
    // of the person holding it. The marks all stay — what is *there* does not
    // depend on which way anyone is facing — and only the naming narrows.
    //
    // `fwd` points **out of the lens**, in the room frame — `quatRotate(q,
    // [0,0,1])` in this project's CV axes, the same vector `objects.js` dots
    // against a camera-to-object offset to get depth along the optical axis.
    // Taken unnegated for that reason. `setHeadingUp` negates the same vector
    // and is not a precedent: it is answering "how far must the map turn so this
    // direction points up the screen", which is a rotation of the paper and not
    // a claim about which way the camera faces.
    //
    // Deliberately not folded into `setHeadingUp`: heading-up is a switch the
    // user turns off, and where the phone is pointing does not stop being true
    // when they do.
    //
    // Any of the three null clears it, and cleared means every object is
    // labelled — the dashboard's behaviour, and the honest fallback for a client
    // that has lost its fix.
    setGaze(fwd, pos, halfFovRad) {
      gaze = fwd && pos && halfFovRad > 0
        ? { fwd, pos, cosHalf: Math.cos(Math.min(halfFovRad, Math.PI / 2)) }
        : null;
      schedule();
    },

    // Zoom in on the followed client rather than holding the whole survey in
    // view. Needs a follow point (setHeadingUp above) to have anything to close
    // in on, and `setSelfClient` to know whose sight lines decide how far out it
    // has to reach.
    setNearFit(on) {
      if (nearFit === !!on) return;
      nearFit = !!on;
      schedule();
    },

    // Which of the clients on this map is the page drawing it, or null on a view
    // that is not any of them (the dashboard). Only the server can answer that —
    // the id is its own numbering — so it is told rather than worked out here.
    setSelfClient(id) {
      if (selfId === id) return;
      selfId = id;
      schedule();
    },

  };
}
