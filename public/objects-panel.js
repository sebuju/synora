'use strict';

// The object drawer: one card per mapped object, and inside an open card the
// record of what that object has been doing.
//
// The map answers "what is where". Everything this experiment is actually
// undecided about is a question about the *path*: did this chair arrive where it
// sits or walk there; was this the third clock all along or did two of them
// merge into it; did the arc grow because the room was walked properly or
// because a fragment was absorbed; was it quarantined for something it did, or
// because a detector that could not name it happened to be loaded. None of those
// can be read off a position and a counter, and until now there was no surface
// that even held the question.
//
// Its own file rather than another section of `clients-panel.js`: that file is
// already the roster, the remote control and the tag drawer, and this shares
// nothing with them but the chart — which is why the chart is in `spark.js` and
// this is here. Same construction shape as the clients panel, so the viewer
// wires both the same way.

// How often an open card re-asks the server for its record. The record only
// changes when the object is being looked at, and a card is open because someone
// is reading it — not scrubbing it.
const OBJ_HIST_POLL_MS = 2000;

// Sample layout as object-history.js packs it:
//   [t, x, y, z, rMm, arcDeg, priorPct, nObs, cells, confPct]
const O_T = 0;
const O_P = 1;
const O_R = 4;
const O_ARC = 5;
const O_PRIOR = 6;
const O_N = 7;
const O_CELLS = 8;
const O_CONF = 9;

// Which named moments are faults. A merge and a promotion are the map working;
// a quarantine and a re-seed are the map having been wrong about something, and
// those are the marks a reader is scanning for.
const OBJ_FAULTS = new Set(['quarantined', 'moved', 'merged-away']);
const objEventColor = (kind) => (OBJ_FAULTS.has(kind) ? SPARK_RESEED : SPARK_EVENT);

// One line per event, in the words the record stores rather than a code. Written
// out here rather than in the history module: the module records what happened,
// this decides how to say it, and a phrasing change should not rewrite a file.
function eventLine(ev) {
  switch (ev.kind) {
    case 'born':
      return `born${ev.why ? ` — ${ev.why}` : ''}`;
    case 'promoted':
      return `promoted — ${ev.nObs} sightings, arc ${ev.arcDeg}°, `
        + `${ev.cells} cells, ${ev.sessions} session${ev.sessions === 1 ? '' : 's'}`;
    case 'moved':
      return `moved ${ev.byM} m — re-seeded, dropped ${ev.dropped} sightings`
        + `${ev.wasPromoted ? ', demoted' : ''}`;
    case 'absorbed':
      return `absorbed #${ev.other} (${ev.apartM} m apart) — now ${ev.nObs} sightings, `
        + `arc ${ev.arcDeg}°`;
    case 'merged-away':
      return `merged into #${ev.into}`;
    case 'quarantined':
      return `quarantined — ${ev.why}`;
    case 'restored':
      return `back in the map — ${ev.why}`;
    default:
      return ev.kind;
  }
}

// A clock reading, 24-hour, no locale formatting anywhere — see the project's
// own rule. Seconds because the events being read are seconds apart.
function hhmmss(t) {
  const d = new Date(t);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function ago(ms) {
  if (!(ms >= 0)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

// Hilbert index of a point on a 2^ORDER grid — what orders the list, so cards
// for things near each other in the room are near each other in the drawer.
//
// A space-filling curve rather than a nearest-neighbour chain, and rather than
// sorting by x or by distance from anywhere. A chain reads best but depends on
// where it starts, so one object appearing reorders the whole list; sorting by a
// single axis puts the two ends of the room next to each other every time that
// axis happens to agree. Hilbert order depends only on the positions, so the
// list is stable as the map grows, and it keeps *both* axes' locality — which is
// the whole of what was asked for.
const HILBERT_ORDER = 8;
function hilbertD(ix, iy) {
  let x = ix;
  let y = iy;
  let d = 0;
  for (let s = 1 << (HILBERT_ORDER - 1); s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

// The room's own extent, so the curve resolves this room rather than a fixed
// span it might occupy a corner of. Height is ignored: the drawer is a list and
// the question "what is near this" is a floor-plan question — a wall clock and
// the plant under it are neighbours in the room whatever their heights.
function spatialOrder(list) {
  if (list.length < 2) return list;
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const o of list) {
    minX = Math.min(minX, o.p[0]); maxX = Math.max(maxX, o.p[0]);
    minZ = Math.min(minZ, o.p[2]); maxZ = Math.max(maxZ, o.p[2]);
  }
  const span = Math.max(1e-3, maxX - minX, maxZ - minZ);
  const n = (1 << HILBERT_ORDER) - 1;
  const key = new Map();
  for (const o of list) {
    key.set(o.id, hilbertD(
      Math.round(((o.p[0] - minX) / span) * n),
      Math.round(((o.p[2] - minZ) / span) * n),
    ));
  }
  return [...list].sort((a, b) => key.get(a.id) - key.get(b.id) || a.id - b.id);
}

function createObjectsPanel(el, { onObjectHistory, onHover, onOpen }) {
  const cards = new Map();       // object id -> card
  // The map, and what the map has ruled out. Held apart because they are two
  // different claims and the list draws them as such — but they are one set of
  // cards, so an object that gets quarantined while its card is open keeps that
  // card, and the record inside it goes straight on.
  let objects = [];
  let quarantined = [];
  let openId = null;
  let hist = null;
  let askedAt = 0;
  // A card opened from the map is scrolled to twice: see openObject.
  let revealPending = false;

  const listEl = document.createElement('div');
  listEl.className = 'tag-list';
  const emptyEl = document.createElement('div');
  emptyEl.className = 'empty';
  emptyEl.textContent = 'No objects mapped';
  el.append(listEl, emptyEl);

  function setOpen(id) {
    if (openId === id) return;
    openId = id;
    hist = null;
    askedAt = 0;
    // Cleared here rather than only where it is used, so a card opened by hand
    // never scrolls the drawer out from under the pointer when its record
    // lands. Only a card opened from the map sets it, and only for that card.
    revealPending = false;
    for (const [oid, card] of cards) {
      card.root.classList.toggle('open', oid === id);
      if (oid === id) paintHistory(card);
    }
    // The room views draw the open object's halo and its co-visibility legs, and
    // this is the only thing that knows which card that is. Reported, never
    // applied — the same arrangement as the hover, and the same one the tag
    // cards already have.
    onOpen?.(id);
    ask();
  }

  function ask() {
    if (openId === null || !onObjectHistory) return;
    askedAt = Date.now();
    onObjectHistory(openId);
  }

  // Everything the charts draw, derived from the raw record in one place so the
  // charts and the summary cannot disagree about what a number means.
  //
  // Drift is measured against where the object sits **now**, so the curve
  // arrives at zero on the right: the question being asked of the record is how
  // far this thing came to get here.
  function series(rec) {
    const s = rec.samples || [];
    const out = {
      drift: [], scatter: [], arc: [], prior: [], nObs: [], conf: [],
    };
    if (!s.length) return out;
    const last = s[s.length - 1];
    const p = [last[O_P], last[O_P + 1], last[O_P + 2]];
    for (const k of s) {
      const t = k[O_T];
      out.drift.push([t, Math.hypot(k[O_P] - p[0], k[O_P + 1] - p[1], k[O_P + 2] - p[2]) * 1000]);
      if (k[O_R] !== null) out.scatter.push([t, k[O_R]]);
      if (k[O_ARC] !== null) out.arc.push([t, k[O_ARC]]);
      if (k[O_PRIOR] !== null) out.prior.push([t, k[O_PRIOR]]);
      if (k[O_N] !== null) out.nObs.push([t, k[O_N]]);
      if (k[O_CONF] !== null) out.conf.push([t, k[O_CONF]]);
    }
    return out;
  }

  // Three charts, because three units. Millimetres, degrees and counts do not
  // share an axis — the same rule the tag drawer follows, for the same reason: a
  // shared axis between a 200 mm drift and a 50-degree arc means one of them is
  // a flat line at the bottom.
  const CHARTS = [
    {
      key: 'mm',
      fmt: (v) => `${Math.round(v)} mm`,
      pick: (S) => [
        { pts: S.drift, color: SPARK_MOVED, label: 'drift' },
        { pts: S.scatter, color: SPARK_OFF, label: 'scatter' },
      ],
    },
    {
      key: 'deg',
      fmt: (v) => `${Math.round(v)}°`,
      pick: (S) => [{ pts: S.arc, color: SPARK_MOVED, label: 'arc' }],
    },
    {
      key: 'pct',
      fmt: (v) => `${Math.round(v)}`,
      pick: (S) => [
        { pts: S.nObs, color: SPARK_MOVED, label: 'sightings' },
        { pts: S.prior, color: SPARK_OFF, label: 'prior %' },
      ],
    },
  ];

  function buildCard(id) {
    const root = document.createElement('div');
    root.className = 'drawer-card tag object';

    const head = document.createElement('div');
    head.className = 'head';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.className = 'name';
    const kind = document.createElement('span');
    kind.className = 'kind';
    // No position on the head. A tag's card carries one there because a tag's
    // position is read *down* the drawer as a column — where a tag sits is the
    // survey's whole output. An object's is not: what is read across these cards
    // is which things they are and which the map has ruled out, and the list is
    // ordered by position already, so a column of ordinates repeats what the
    // order says while taking the width the class names need. It moves inside,
    // where it is one of the numbers about an object rather than its heading.
    head.append(dot, name, kind);

    // The body only exists while the card is open — a shut card is one line, and
    // twenty-six of them is the list this drawer is for.
    const body = document.createElement('div');
    body.className = 'body';
    const stats = document.createElement('div');
    stats.className = 'rows';
    const charts = CHARTS.map(() => {
      const c = document.createElement('canvas');
      c.className = 'spark';
      return c;
    });
    const events = document.createElement('div');
    events.className = 'events';
    body.append(stats, ...charts, events);
    root.append(head, body);

    // On the card, not on its heading — the same gesture the tag cards carry,
    // and for a reason that is invisible in the markup: the padding around the
    // heading belongs to the *card*, so a handler on the heading leaves the top
    // and bottom bands of a shut card dead. That is a third of it, on a card
    // whose whole box says `cursor: pointer`, so the click misses often enough
    // to read as a flaky list rather than as an area that was never live.
    //
    // Charts and buttons excluded like the tag cards': reading a chart means
    // moving the pointer along it, and a click landing at the end of that
    // gesture must not shut the thing being read.
    root.addEventListener('click', (ev) => {
      if (ev.button !== 0 || ev.target.closest('button, canvas')) return;
      setOpen(openId === id ? null : id);
    });
    // Same hover contract as the tag cards: reported, never applied. What is hot
    // is the viewer's to decide, or the card and the map would each hold their
    // own answer.
    root.addEventListener('pointerenter', () => onHover?.({ kind: 'object', id }));
    root.addEventListener('pointerleave', () => onHover?.(null));

    return {
      id, root, dot, name, kind, stats, charts, events,
    };
  }

  // A co-visibility key as something readable. `o<id>` is another mapped object
  // and is named by its class where the map still has it — an id that has since
  // been merged away or quarantined keeps its number, which is the honest thing
  // to show rather than dropping the count that mentions it.
  function nameFor(k) {
    if (k.startsWith('t')) return `tag ${k.slice(1)}`;
    const id = Number(k.slice(1));
    const o = objects.find((x) => x.id === id) || quarantined.find((x) => x.id === id);
    return o ? `${o.cls} #${id}` : `#${id}`;
  }

  function paintCard(card, o) {
    // The same two colours the map draws it in, so a card and a ring name each
    // other without a reader matching ids across two surfaces. A quarantined one
    // is grey in both senses — it has no ring to match, because the renderers
    // never receive it.
    card.root.classList.toggle('gone', !!o.gone);
    card.dot.style.background = o.gone ? '#5a5a5a'
      : (o.promoted && o.usable !== false ? ROOM_OBJECT_BEST_CSS : ROOM_OBJECT_CSS);
    card.name.textContent = `${o.cls} #${o.id}`;
    const bits = [];
    // The reason first and alone: on a quarantined card nothing else about it is
    // the question being asked.
    if (o.gone) bits.push(`out — ${o.gone.why}`);
    else if (!o.promoted) bits.push(`n=${o.nObs}`);
    else if (o.priorFrac > 0.35) bits.push(`prior ${Math.round(o.priorFrac * 100)}%`);
    else if (o.arcDeg < 8) bits.push(`arc ${o.arcDeg.toFixed(1)}°`);
    // A shape whose mirror was never resolved is a size and not a bearing, and
    // the card has to say so: the map draws it as a plain extent, and a chip
    // reading `ellipse` beside a bar is the card claiming a measurement the
    // renderer knows it does not have.
    if (!o.gone && o.shape) bits.push(o.shape.n ? o.shape.kind : `${o.shape.kind} · no normal`);
    card.kind.textContent = bits.join(' · ');
    card.rec = o;
    if (card.id === openId) paintHistory(card);
  }

  function paintHistory(card) {
    const rec = hist && hist.id === card.id ? hist : null;
    const samples = rec?.samples || [];
    const evs = rec?.events || [];
    const S = series(rec || { samples: [] });

    card.stats.textContent = '';
    const row = (k, v) => {
      const d = document.createElement('div');
      d.className = 'row';
      const a = document.createElement('span');
      a.textContent = k;
      const b = document.createElement('span');
      if (typeof v === 'string') b.textContent = v;
      else b.append(...v);
      d.append(a, b);
      card.stats.append(d);
      return d;
    };

    // First, because it is what the card is about once it is open, and because
    // the head no longer carries it. Each ordinate in its own axis colour — the
    // same three the map's gizmo and its crosses use: three bare numbers give no
    // clue which is the height, and height is the one that separates a clock on
    // the wall from the plant under it.
    if (card.rec) {
      row('at', [0, 1, 2].map((k) => {
        const s = document.createElement('span');
        s.style.color = roomAxisColorCss(k);
        const v = card.rec.p[k];
        s.textContent = (k ? '  ' : '') + (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));
        return s;
      }));
    }
    if (!samples.length) {
      row('record', evs.length ? `${evs.length} events, no samples yet` : 'nothing yet');
    } else {
      const t0 = samples[0][O_T];
      const t1 = samples[samples.length - 1][O_T];
      // How far it has come, not how far it is from anywhere in particular: the
      // largest drift in the record is what says "this walked" against "this was
      // measured badly once".
      const maxDrift = S.drift.reduce((m, [, v]) => Math.max(m, v), 0);
      row('record', `${samples.length} samples over ${ago(t1 - t0)}`);
      row('drift', `${Math.round(maxDrift)} mm max, last seen ${ago(Date.now() - t1)} ago`);
      const lastS = samples[samples.length - 1];
      row('now', `${lastS[O_N]} sightings · ${lastS[O_CELLS]} cells · `
        + `arc ${lastS[O_ARC]}° · prior ${lastS[O_PRIOR]}%`);
    }

    // The stale rule's case against this object, and the only way to tell a bar
    // set right from one that has simply not fired yet. `looked at and not
    // found` is not the same as `not seen`: it counts only frames where this was
    // comfortably in view, in range, and something else *was* detected.
    if (card.rec && (card.rec.hits || card.rec.misses)) {
      const s = card.rec.missStreak;
      row('seen', `found ${card.rec.hits} · missed ${card.rec.misses}`
        + (s ? ` · ${s} in a row now` : ''));
    }

    // What this has been in frame with, strongest first. A tag partner is worth
    // more than an object one and is named as such: a frame holding this and a
    // surveyed tag puts it near a *known* position, where a frame holding it and
    // another guess only says the two guesses travel together.
    const with_ = card.rec?.seenWith || [];
    if (with_.length) {
      row('seen with', with_.map(([k, n]) => `${nameFor(k)} ×${n}`).join(', '));
    }

    const t0 = samples.length ? samples[0][O_T] : Date.now() - 1000;
    const t1 = samples.length ? samples[samples.length - 1][O_T] : Date.now();
    CHARTS.forEach((spec, i) => {
      const canvas = card.charts[i];
      const ser = spec.pick(S).filter((s) => s.pts.length);
      canvas.style.display = ser.length ? '' : 'none';
      if (!ser.length) return;
      drawSpark(canvas, {
        series: ser,
        events: evs,
        t0,
        t1,
        fmt: spec.fmt,
        hoverT: null,
        eventColor: objEventColor,
      });
    });

    // Newest first: the question a reader arrives with is "what just happened to
    // this", and the answer is at the end of a chronological list.
    card.events.textContent = '';
    for (const ev of [...evs].reverse()) {
      const d = document.createElement('div');
      d.className = `event${OBJ_FAULTS.has(ev.kind) ? ' fault' : ''}`;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = hhmmss(ev.t);
      const w = document.createElement('span');
      w.textContent = eventLine(ev);
      d.append(t, w);
      card.events.append(d);
    }
  }

  function render() {
    const all = [...objects, ...quarantined];
    const present = new Set(all.map((o) => o.id));
    for (const id of [...cards.keys()]) {
      if (present.has(id)) continue;
      cards.get(id).root.remove();
      cards.delete(id);
    }
    for (const o of all) {
      if (!cards.has(o.id)) cards.set(o.id, buildCard(o.id));
    }
    // **Ordered by where things are, not by what they are.** The drawer is read
    // beside the map, and the question carried from one to the other is "what
    // else is over there" — so the two chairs at the same end of the room are
    // adjacent here, and the promoted/candidate split that used to lead is not a
    // reason to put them pages apart. Ruled-out entries still come last: they
    // are a list of things that are *not* in the room and must not read as part
    // of it.
    const order = [...spatialOrder(objects), ...spatialOrder(quarantined)];
    // Through `orderChildren`, which moves only what is actually out of place.
    // Appending every card each time worked and ate clicks: this runs on every
    // objects push, several times a second, and a node re-parented between a
    // pointer going down on it and coming up is a node the browser never fires
    // `click` on. The card opened on the second or third try, which reads as a
    // flaky button rather than as a list quietly rebuilding itself underneath
    // one.
    orderChildren(listEl, order.map((o) => cards.get(o.id).root), true);
    for (const o of order) paintCard(cards.get(o.id), o);
    emptyEl.style.display = all.length ? 'none' : '';
    // The open card's object left the map — quarantined, merged away, or the
    // survey was reset. Nothing else would ever close it, and the panel would go
    // on asking the server about an object it no longer has.
    if (openId !== null && !cards.has(openId)) setOpen(null);
  }

  return {
    setObjects(list, out) {
      objects = list || [];
      quarantined = out || [];
      render();
    },

    // What the pointer is over anywhere in the dashboard. One value for the
    // whole app — a card and a mark on the map must never each hold their own
    // answer — so this takes the same `{ kind, id }` every other surface does and
    // simply ignores the kinds that are not its own.
    setHovered(h) {
      const id = h?.kind === 'object' ? h.id : null;
      for (const [oid, card] of cards) card.root.classList.toggle('hot', oid === id);
    },

    // Opened from the map rather than from its own head. Scrolled to as well as
    // opened: the list runs to dozens of cards and is ordered by position, so
    // the card for the thing just clicked is reliably somewhere off screen — and
    // a card that opened where nobody could see it would read as a click that
    // did nothing.
    //
    // Scrolled to *twice*, because the card is not its final height yet: it
    // opens against an empty record (setOpen clears `hist`), and the answer to
    // the request that opening it just sent adds the rows, the charts and the
    // events block below them. Fitting the card as it stands and leaving it
    // there puts the half the reader wanted back off screen a moment later.
    openObject(id) {
      if (!cards.has(id)) return;
      setOpen(id);
      revealPending = true;
      revealCard(cards.get(id).root);
    },

    setObjectHistory(rec) {
      if (!rec || rec.id !== openId) return;
      hist = rec;
      const card = cards.get(openId);
      if (card) paintHistory(card);
      if (card && revealPending) {
        revealPending = false;
        revealCard(card.root);
      }
    },

    // Called on the panel's own repaint tick, like the tag drawer's.
    tick() {
      if (openId !== null && Math.abs(Date.now() - askedAt) >= OBJ_HIST_POLL_MS) ask();
    },

    openId() {
      return openId;
    },
  };
}
