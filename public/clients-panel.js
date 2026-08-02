'use strict';

// Dashboard client drawer: the roster, and the remote control for it.
//
// A pure renderer, like scene.js and map2d.js: viewer.js merges the server's
// roster with what it knows locally (peer connection, poses, tracking loss) and
// hands the result over; every control reports back through onControl and
// nothing is changed here. What comes back on the next update is the client's
// answer, so a client that refuses an action never leaves a button lying about
// its state.
//
// Cards are updated in place rather than rebuilt. Rebuilding on every tick
// would close the resolution dropdown the instant it was opened and make every
// button flicker under the pointer.

const PANEL_RESOLUTIONS = ['480p', '720p', '1080p', '1440p', '4K'];

// A pose older than this says nothing about where the client is now.
const PANEL_POSE_STALE_MS = 2000;

// How strongly a card is washed with its owning client's colour. This is the
// whole of the ownership cue — there is no coloured edge any more — so it has to
// be readable against the card's own #1c1c1c at a glance and still stay behind
// the text. Faint on purpose: several of these stack under the tag cards, and a
// drawer of saturated blocks reads as a warning rather than as a grouping.
const CARD_TINT_ALPHA = 0.13;

function createClientsPanel(el, { onControl, onVcam, onRename, onTagHover, onTagRemove }) {
  const cards = new Map();   // clientId -> card DOM

  function button(label, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (title) b.title = title;
    return b;
  }

  function toggle(label, action, id, title) {
    const b = button(label, title);
    b.className = 'toggle';
    // The wanted state, never a flip of what is drawn: the card renders the
    // client's last reported state, which may be a second old.
    b.onclick = () => onControl(id, action, !b.classList.contains('on'));
    return b;
  }

  function buildCard(id) {
    const root = document.createElement('div');
    root.className = 'drawer-card';

    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('span');
    name.className = 'name';
    name.title = 'Click to name this device';
    // Renaming names the *device*, not this connection, so the name follows the
    // phone across reconnects and across client numbers — and it is what the
    // device picker on the phone shows when a browser has to be told which
    // device it is. An input rather than a prompt(): a modal dialog blocks the
    // page, and this panel is repainting four times a second behind it.
    const rename = document.createElement('input');
    rename.className = 'rename';
    rename.type = 'text';
    rename.maxLength = 64;
    rename.hidden = true;
    // Guarded, and not optional: hiding a focused input blurs it, so cancelling
    // with Escape fired the blur handler and committed the very edit it was
    // cancelling. Enter has the same shape — commit, hide, blur, commit again.
    let editing = false;
    const commit = (save) => {
      if (!editing) return;
      editing = false;
      rename.hidden = true;
      name.hidden = false;
      if (save) onRename(id, rename.value);
    };
    name.onclick = (ev) => {
      ev.stopPropagation();
      rename.value = cards.get(id)?.deviceName || '';
      name.hidden = true;
      rename.hidden = false;
      editing = true;
      rename.focus();
      rename.select();
    };
    rename.onkeydown = (ev) => {
      if (ev.key === 'Enter') commit(true);
      else if (ev.key === 'Escape') commit(false);
    };
    rename.onblur = () => commit(true);
    const kind = document.createElement('span');
    kind.className = 'kind';
    const spacer = document.createElement('span');
    spacer.className = 'grow';
    const vcamBtn = button('Webcam', 'Feed this client into the virtual webcam');
    vcamBtn.className = 'toggle';
    vcamBtn.onclick = () => onVcam(id, !vcamBtn.classList.contains('on'));
    head.append(name, rename, kind, spacer, vcamBtn);

    const lines = document.createElement('div');
    lines.className = 'lines';

    const ctrls = document.createElement('div');
    ctrls.className = 'ctrls';
    const res = document.createElement('select');
    res.title = 'Capture resolution';
    for (const r of PANEL_RESOLUTIONS) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      res.append(opt);
    }
    res.onchange = () => onControl(id, 'res', res.value);
    const mic = toggle('Mic', 'mic', id, 'Microphone');
    const pose = toggle('Tags', 'pose', id, 'Marker tracking — off makes it a plain camera');
    const paused = toggle('Pause', 'paused', id, 'Freeze the feed; the recording stays open');
    const blank = toggle('Blank', 'blank', id, 'Black out the screen to save battery');
    const flip = button('Flip', 'Switch between the front and rear camera');
    const rec = button('New rec', 'Close the current recording and start the next');
    rec.onclick = () => onControl(id, 'record', true);
    ctrls.append(res, mic, pose, paused, blank, flip, rec);

    root.append(head, lines, ctrls);
    clientsEl.append(root);
    return {
      root, name, rename, kind, lines, vcamBtn,
      res, mic, pose, paused, blank, flip, rec,
      deviceName: null,
    };
  }

  // The status block. Kept as text rather than a row of chips: this is the same
  // diagnostic readout the room overlay and the server log carry, and it is
  // read as prose more often than it is scanned.
  function statusLines(info) {
    const out = [];
    const size = info.capture ? `${info.capture.w}x${info.capture.h}` : null;
    const asked = info.res && info.res !== 'xr' ? info.res : null;
    // The requested size and the delivered one both matter, and only when they
    // disagree — `ideal` constraints degrade silently.
    const cap = [asked, size && size !== asked ? size : null].filter(Boolean).join(' · ');
    const bits = [cap || 'no capture yet'];
    if (info.facing) bits.push(info.facing === 'user' ? 'front' : 'rear');
    if (info.kind === 'xr') bits.push(info.session ? 'AR session' : 'no AR session');
    if (info.paused) bits.push('PAUSED');
    if (info.blank) bits.push('screen blank');
    if (!info.pose) bits.push('tags off');
    out.push(bits.join(' · '));

    if (info.lostMs !== null) {
      out.push(`NO ARCORE TRACK ${fmtAge(info.lostMs)} — tags only`);
    }

    const room = info.poseMsg?.room;
    if (room?.pose) {
      const p = room.pose.p.map((v) => v.toFixed(2)).join(', ');
      const n = info.poseMsg.tags?.length ?? 0;
      out.push(`room ${p} · ${room.quality} · ${n} tags · ${fmtAge(info.poseAge)}`);
    } else {
      out.push(info.pose ? 'no room fix' : 'not localizing');
    }

    const link = [];
    if (info.live) {
      if (info.latency !== null && info.latency !== undefined) {
        link.push(`lat ${Math.round(info.latency)} ms`);
      }
      if (info.clockUnc !== null && info.clockUnc !== undefined) {
        link.push(`clock ±${Math.round(info.clockUnc)} ms`);
      }
    } else if (info.kind !== 'xr') {
      link.push('no video');
    }
    link.push(info.recording
      ? `rec ${(info.recording.bytes / (1024 * 1024)).toFixed(1)} MB`
      : 'not recording');
    if (info.connectedAt) link.push(`up ${fmtAge(Date.now() - info.connectedAt)}`);
    out.push(link.join(' · '));
    return out;
  }

  function paint(card, info) {
    const id = info.id;
    card.deviceName = info.name || null;
    // Left alone while it is being edited — this repaints four times a second.
    if (card.rename.hidden) {
      card.name.textContent = info.name || `Client ${id}`;
    }
    const kindWord = info.kind === 'xr' ? 'XR · positioning only' : 'camera';
    // The client number still has to be visible somewhere — it is what the
    // recording filenames are prefixed with — so a named device carries it
    // alongside the kind instead of in the heading.
    card.kind.textContent = info.name ? `client${id} · ${kindWord}` : kindWord;
    // Connected but silent: no video and no recent pose. The client is there,
    // nothing is coming from it, and that is worth looking different.
    const fresh = info.poseAge !== null && info.poseAge < PANEL_POSE_STALE_MS;
    card.root.classList.toggle('gone', !info.live && !fresh);

    const lines = statusLines(info);
    // Only the room line is coloured, and only while it is fresh: a stale
    // position reading in the same green as a live one is the one thing this
    // panel must not do.
    card.lines.replaceChildren();
    lines.forEach((text, i) => {
      const div = document.createElement('div');
      div.textContent = text;
      if (i === 0 && (info.paused || info.blank)) div.className = 'warn';
      if (text.startsWith('NO ARCORE TRACK')) div.className = 'bad';
      if (text.startsWith('room ') && info.poseAge < PANEL_POSE_STALE_MS) div.className = 'room';
      card.lines.append(div);
    });

    // An XR client has no mic, no recorder and no resolution to pick, and its
    // tag detection is the entire point of the page — offering those controls
    // would be offering buttons that do nothing.
    const full = info.kind !== 'xr';
    for (const c of [card.res, card.mic, card.pose, card.paused, card.flip, card.rec]) {
      c.style.display = full ? '' : 'none';
    }
    card.vcamBtn.style.display = full && info.vcamAvailable ? '' : 'none';
    card.vcamBtn.classList.toggle('on', !!info.vcam);

    if (document.activeElement !== card.res && info.res) card.res.value = info.res;
    card.mic.classList.toggle('on', !!info.mic);
    card.pose.classList.toggle('on', !!info.pose);
    card.paused.classList.toggle('on', !!info.paused);
    card.blank.classList.toggle('on', !!info.blank);
    card.flip.textContent = info.facing === 'user' ? 'To rear' : 'To front';
    card.flip.onclick = () =>
      onControl(id, 'facing', info.facing === 'user' ? 'environment' : 'user');
  }

  // Surveyed tags, in the same drawer as the clients rather than a panel of
  // their own: a room is its tags and whoever is standing in it. The distances
  // between tags are not here — they are drawn between the tags themselves in
  // the room views, which is where a distance can be read against the thing it
  // measures. What a card answers instead is what the drawing cannot say: where
  // the tag sits, which way it faces, how well established it is, and whether
  // anyone is looking at it right now.
  const tagCards = new Map();   // tag id -> { root, live, confirm }
  let tagsFrom = null;
  // Which tag's remove button is halfway through its two-click confirmation,
  // held for the same reason the hover is: the cards are rebuilt whenever the
  // marker map object is replaced, which is every time any tag is refined —
  // several times a second while a client is streaming. The arming is about the
  // tag, not the button that was torn out, so it is carried across; otherwise
  // the second click can never land while a survey is running.
  let armedTagId = null;
  let armedTagConfirm = null;
  // Whether each tag's stored pose is still walking anywhere. `resid` alone
  // cannot answer that — it is one fix's disagreement, and the fixes are noisy,
  // so it never falls to the few millimetres that read as converged and every
  // tag showed "settling" forever. What settling means is that refinement is
  // still moving the pose, so that is what is measured: the stored pose against
  // where it was, held here because the map object is replaced wholesale on
  // every message and carries no history of itself.
  const settleHist = new Map();   // tag id -> { p, q, stillAtMs }
  // Last hover the viewer told this panel about. Held because the cards are
  // rebuilt whenever the marker map object is replaced — several times a minute
  // while a survey is running — and a rebuild would otherwise drop the
  // highlight off a card the pointer is still sitting on.
  let hotTagId = null;
  let agesPaintedAt = 0;
  const AGE_TICK_MS = 1000;
  const SETTLE_WINDOW_MS = 20000;
  const SETTLE_MOVE_M = 0.001;
  const SETTLE_MOVE_DEG = 0.1;

  function settleState(tag) {
    const prev = settleHist.get(tag.id);
    const now = Date.now();
    const moved = !prev
      || Math.hypot(tag.p[0] - prev.p[0], tag.p[1] - prev.p[1], tag.p[2] - prev.p[2]) > SETTLE_MOVE_M
      || quatAngleDeg(tag.q, prev.q) > SETTLE_MOVE_DEG;
    const stillAtMs = moved ? now : prev.stillAtMs;
    settleHist.set(tag.id, { p: tag.p, q: tag.q, stillAtMs });
    // Tiny residual settles it immediately — otherwise a freshly opened viewer
    // calls an obviously converged tag unsettled for the first window.
    return (tag.resid ?? 0) <= 0.005 && (tag.residDeg ?? 0) <= 1
      || now - stillAtMs >= SETTLE_WINDOW_MS;
  }

  // Whether the tag is still moving, and by how much it wants to. Without this
  // the survey is a black box: a tag healing ten degrees over ten minutes and a
  // tag frozen at the wrong orientation look identical, which is exactly how a
  // stuck one went unnoticed. `resid` is what refinement is still being told to
  // correct, not what it has corrected. Its own function because it is the one
  // line on a card that goes stale on its own — it carries an age, and the
  // cards are rebuilt only when a new map arrives, which is never once a survey
  // stops moving.
  function settleLine(tag) {
    if (tag.refinedAtMs) {
      const mm = Math.round((tag.resid ?? 0) * 1000);
      const deg = (tag.residDeg ?? 0).toFixed(1);
      const settled = settleState(tag);
      return {
        text: (settled ? 'settled' : 'settling')
          + ` · off by ${mm} mm · ${deg}° · nudged ${fmtAge(Date.now() - tag.refinedAtMs)}`,
        warn: !settled,
      };
    }
    if (tag.checkedAtMs) {
      // It has been seen beside a known tag — every check just landed too far
      // away to average toward (past the reseed threshold refinement refuses,
      // by design). Saying "needs another known tag in the same frame" here is
      // false and sends whoever is holding the phone hunting the wrong problem:
      // the tag is mis-placed, not unobserved.
      const mm = Math.round((tag.checkOff ?? 0) * 1000);
      return {
        text: `disputed — checks land ${mm} mm away `
          + `(last ${fmtAge(Date.now() - tag.checkedAtMs)} ago): too far to refine, `
          + 'will drop and re-survey once enough witnesses agree',
        warn: true,
      };
    }
    // Refinement needs two known tags in one frame, and a tag that is never
    // seen beside another one is never corrected however long it is watched.
    return { text: 'never refined — needs another known tag in the same frame', warn: true };
  }

  // Which tag placed each one, as a tree. `hops` and `from` already say it in
  // words on every card, but depth from the anchor is the thing read *across*
  // cards — it is the best predictor of which tag carries the most accumulated
  // error — and a comma list on a dozen cards is not something a reader can
  // assemble. Parent is the first of `from` (they are ordered by how much of
  // the placing each did) sitting one hop nearer the anchor; that depth is
  // strictly decreasing, so the tree cannot contain a cycle. A tag with no
  // recorded provenance, or whose named parent is not in the map, is its own
  // root rather than being hidden.
  function tagTree(markers, anchorId) {
    const byId = new Map(markers.map((t) => [t.id, t]));
    const kids = new Map(markers.map((t) => [t.id, []]));
    const roots = [];
    for (const tag of markers) {
      const parent = Number.isFinite(tag.hops) && tag.hops > 0
        ? (tag.from || []).find((id) => byId.get(id)?.hops === tag.hops - 1)
        : undefined;
      if (parent === undefined) roots.push(tag);
      else kids.get(parent).push(tag);
    }
    const byIdAsc = (a, b) => a.id - b.id;
    // The anchor heads the list whatever its id: everything else is measured
    // from it, and a tag with no provenance is also a root but is not a datum.
    roots.sort((a, b) => (a.id === anchorId ? -1 : b.id === anchorId ? 1 : byIdAsc(a, b)));
    for (const list of kids.values()) list.sort(byIdAsc);
    return { roots, kids };
  }

  function buildTags(markerMap) {
    // Rebuilt only when the map object changes — it is replaced wholesale by
    // every marker-map message and this panel repaints four times a second.
    if (tagsFrom === markerMap) return false;
    tagsFrom = markerMap;
    agesPaintedAt = Date.now();
    const wasArmed = armedTagId;
    armedTagConfirm?.disarm();
    tagsEl.replaceChildren();
    tagCards.clear();
    const { roots, kids } = tagTree([...(markerMap?.markers || [])], markerMap?.anchorId);
    // Depth-first, so a tag is emitted directly under its parent and the rails
    // in the stylesheet are the nesting itself rather than a computed indent.
    const emit = (tag, into) => {
      const node = document.createElement('div');
      node.className = 'tag-node';
      node.append(buildTagCard(tag, markerMap));
      const mine = kids.get(tag.id);
      if (mine.length) {
        const sub = document.createElement('div');
        sub.className = 'tag-kids';
        for (const kid of mine) emit(kid, sub);
        node.append(sub);
      }
      into.append(node);
    };
    for (const tag of roots) emit(tag, tagsEl);
    if (wasArmed !== null) tagCards.get(wasArmed)?.confirm.arm();
    // A removed tag that comes back is a re-survey, not a continuation, so its
    // old stillness is not evidence about the new pose.
    for (const id of settleHist.keys()) {
      if (!tagCards.has(id)) settleHist.delete(id);
    }
    return true;
  }

  // Landmark regions as cards, one per group, newest survey state each call.
  // Rebuilt wholesale rather than diffed: there are a handful of them, they
  // carry no state of their own (no arming, no hover, no rename) and the server
  // sends the whole set every push.
  //
  // A singleton region is one qualified corner. It is real but it is not a
  // place, and a drawer full of them would bury the regions that are — so they
  // are counted rather than listed.
  function buildGroups(landmarks) {
    const rows = [];
    for (const c of landmarks || []) {
      for (const g of c.groups || []) rows.push({ ...g, clientId: c.clientId });
    }
    const solo = rows.filter((g) => g.n < 2).length;
    const shown = rows.filter((g) => g.n >= 2).sort((a, b) => b.n - a.n);
    // Candidates, in one line rather than as cards: they have no identity worth
    // a card, and what is worth knowing is the shape of the pile — how many are
    // being followed and how far the best of them has got, since "plenty of
    // candidates, none past 9°" and "no candidates at all" are the two failures
    // and they call for opposite responses. This is the only place the empty
    // case says anything at all.
    const cand = [];
    for (const c of landmarks || []) {
      if (c.candidates?.length) {
        cand.push({
          clientId: c.clientId,
          n: c.candidates.length,
          best: Math.max(...c.candidates.map((k) => k.span || 0)),
        });
      }
    }
    if (!shown.length && !solo && !cand.length) {
      groupsEl.replaceChildren();
      return;
    }
    const out = shown.map(buildGroupCard);
    if (solo) {
      const note = document.createElement('div');
      note.className = 'drawer-card';
      note.style.background = 'rgba(255,255,255,0.03)';
      note.style.opacity = '0.6';
      note.textContent = `+${solo} single-anchor region${solo === 1 ? '' : 's'}`;
      out.push(note);
    }
    for (const c of cand) {
      const note = document.createElement('div');
      note.className = 'drawer-card';
      // The candidate grey, not the client's colour: a card in the client's
      // colour claims the client *has* these, and the whole point of the card is
      // that it does not yet.
      note.style.background = roomCandidateColorCss(CARD_TINT_ALPHA);
      note.style.opacity = '0.6';
      note.textContent = `${c.n} candidate${c.n === 1 ? '' : 's'}`
        + ` · best arc ${Math.round(c.best)}/${ROOM_LANDMARK_ARC_DEG}°`;
      out.push(note);
    }
    groupsEl.replaceChildren(...out);
  }

  function buildGroupCard(g) {
    const root = document.createElement('div');
    root.className = 'drawer-card';
    const colour = roomClientColorCss(g.clientId);
    // Tinted rather than classed: the tint is the client's own colour, so it
    // cannot live in the stylesheet as a fixed value. Kept faint — this has to
    // read as "not a tag" at a glance without competing with the tags above it.
    root.style.background = roomClientColorCss(g.clientId, CARD_TINT_ALPHA);

    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `Region ${g.id}`;
    name.style.color = colour;
    const kind = document.createElement('span');
    kind.className = 'kind';
    // Live against total is the honest state of it: an anchor the map remembers
    // but nothing is currently looking at cannot contribute to a fix.
    kind.textContent = `${g.live}/${g.n} anchors`;
    head.append(name, kind);

    // `lines` is the tag card's own body container, so these sit on the same
    // grid as everything above them rather than inventing a second layout.
    const lines = document.createElement('div');
    lines.className = 'lines';
    const pos = document.createElement('div');
    pos.textContent = `${g.p.map((v) => v.toFixed(2)).join(', ')} m`;
    const arc = document.createElement('div');
    // The widest arc any member was seen through. It is the quality of the look
    // this region got, and the reason one region qualifies where another does
    // not — so it is the one measurement worth a line here.
    arc.textContent = `client ${g.clientId} · seen through ${g.span}°`;
    lines.append(pos, arc);

    root.append(head, lines);
    return root;
  }

  function buildTagCard(tag, markerMap) {
    const root = document.createElement('div');
    root.className = 'drawer-card';
    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `Tag ${tag.id}`;
    const kind = document.createElement('span');
    kind.className = 'kind';
    // nObs because a tag promoted on 8 estimates and one settled over 226 are
    // not the same claim, and that gap is usually what a position that looks
    // wrong turns out to be. The anchor has none — it is the datum, not a
    // measurement, and it is the one tag whose being wrong is undetectable.
    const isAnchor = tag.id === markerMap.anchorId;
    kind.textContent = isAnchor ? 'origin' : `${tag.nObs} obs`;
    head.append(name, kind);

    // Everything below is a measurement, and the anchor is not one: it sits at
    // the origin facing along the room axes by definition, was measured
    // against nothing and can never be refined. Printing those as facts about
    // it read as a survey result and, worse, as a fault.
    if (!isAnchor) {
      // Each ordinate in its own axis colour, the same three the 3D helper and
      // the 2D crosses use. Three bare numbers give no clue which is the
      // height, and height is the one that exposes a tilted room frame.
      const at = document.createElement('span');
      at.className = 'at';
      tag.p.forEach((v, k) => {
        const span = document.createElement('span');
        span.style.color = roomAxisColorCss(k);
        span.textContent = v.toFixed(2);
        at.append(span, k < 2 ? ', ' : '');
      });
      head.append(at);
    }

    const lines = document.createElement('div');
    lines.className = 'lines';
    const settle = document.createElement('div');
    if (!isAnchor) {
      // Which way the tag faces, in the same yaw/pitch convention the client
      // rows use. A tag mounted a few degrees off is invisible in its position
      // but is exactly what a mirror-flipped sighting leaves behind.
      const n = quatRotate(tag.q, [0, 0, 1]);
      const yaw = Math.atan2(n[0], n[2]) * 180 / Math.PI;
      const pitch = Math.asin(Math.max(-1, Math.min(1, n[1]))) * 180 / Math.PI;
      const facing = document.createElement('div');
      facing.textContent = `yaw ${Math.round(yaw)}° · pitch ${Math.round(pitch)}°`;
      // What placed this tag and how far that is from the datum. The tree says
      // the depth already, but not *which* parents did the placing nor how well
      // checked the result is, and the deepest-chained tag is usually the one
      // that looks wrong. Parents are ordered by how much of the placing each
      // did — the first is the one the tree hangs this card off.
      const via = document.createElement('div');
      if (tag.from?.length) {
        // How many checks this tag has survived: promoting estimates measured
        // against a two-known-tag fix, plus every refinement since — each one
        // compared the stored pose against a fix from *other* tags and could
        // have disagreed. Zero means genuinely unfalsified: placed and then
        // never once seen beside another known tag.
        const checked = tag.verified === null || tag.verified === undefined
          ? 'checks unrecorded'
          : `${tag.verified} cross-checked`;
        via.textContent = `via ${tag.from.join(', ')} · `
          + (tag.hops === null ? 'depth unrecorded' : `${tag.hops} hop${tag.hops === 1 ? '' : 's'} out`)
          + ` · ${checked}`;
        if (!tag.verified) via.className = 'warn';
      } else {
        // No tag in view when it was placed — the fix was ARCore carrying the
        // pose, which is the weakest way into the map.
        via.textContent = tag.from ? 'placed off ARCore alone' : 'placed before this was recorded';
      }
      paintSettle(settle, tag);
      // Asserted geometry, shown as such. This is the one number on the card
      // that was not measured, so it says which tag it was snapped to and how
      // far it was moved — a silent correction is indistinguishable from a
      // survey that happened to come out clean.
      const clip = document.createElement('div');
      if (tag.clippedTo !== null && tag.clippedTo !== undefined) {
        clip.textContent = `clipped ${tag.clippedMm ?? 0} mm and `
          + `${(tag.clippedDeg ?? 0).toFixed(1)}° onto tag ${tag.clippedTo}'s plane`;
      }
      lines.append(facing, via, settle, clip);
    }
    const live = document.createElement('div');
    lines.append(live);

    // The escape hatch for a tag that is gone from the room — one shown on a
    // screen, or a wall that was repainted. This is the only way to forget one
    // now: it used to be a double-click on the tag in the top view, which is
    // also the gesture that resets that view, on a target a few pixels across.
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'icon-btn mini rm danger';
    rm.title = isAnchor
      ? `Forget tag ${tag.id} — it is the anchor, so the whole survey resets`
      : `Forget tag ${tag.id}`;
    rm.setAttribute('aria-label', `Forget tag ${tag.id}`);
    // A bin, not a cross: a cross on a card is the gesture for closing it, and
    // this one throws the tag out of the survey. No ribs on the body — at the
    // 12px this glyph is drawn at they close up into a smudge and cost the
    // silhouette that carries the meaning.
    rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M4 7h16"/><path d="M9.5 4h5"/>'
      + '<path d="M6.5 7l.9 12.1A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.9L17.5 7"/></svg>';
    const confirm = confirmButton(rm, () => onTagRemove?.(tag.id), {
      armedTitle: isAnchor
        ? 'Click again to forget the anchor — the whole survey resets'
        : `Click again to forget tag ${tag.id}`,
      onArmed: (on) => {
        armedTagId = on ? tag.id : null;
        armedTagConfirm = on ? confirm : null;
      },
    });
    head.append(rm);

    // Pointing at a tag here points at it in the room views, and vice versa.
    // Reported, never applied: which tag is hot is the viewer's to decide, or
    // the card and the map would each hold their own answer and disagree the
    // moment the pointer moved between them.
    root.onpointerenter = () => onTagHover?.(tag.id);
    root.onpointerleave = () => onTagHover?.(null);

    root.append(head, lines);
    root.classList.toggle('hot', tag.id === hotTagId);
    // The tag itself is kept so the settle line can be repainted without a
    // rebuild: it carries an age, and the map object it came from is the only
    // thing that triggers one.
    tagCards.set(tag.id, { root, live, confirm, settle, tag, isAnchor });
    return root;
  }

  function paintSettle(el, tag) {
    const { text, warn } = settleLine(tag);
    el.textContent = text;
    el.className = warn ? 'warn' : '';
  }

  // The ages on the cards, moved on regardless of survey traffic. A tag that
  // has stopped being refined is exactly the one whose "nudged" figure matters,
  // and it is also the one no marker-map message will ever come back to.
  function paintTagsAges() {
    for (const card of tagCards.values()) {
      if (!card.isAnchor) paintSettle(card.settle, card.tag);
    }
  }

  // Who is looking at each tag right now, and with how much tag to look at.
  // Apparent size is what bounds a planar pose — a tag can reproject beautifully
  // and still be metres out if there were only a few pixels of it — so it is the
  // number worth watching while walking a survey in.
  function paintTagsLive(list) {
    if (!tagCards.size) return;
    const bySeen = new Map();
    for (const info of list) {
      if (info.poseAge === null || info.poseAge > PANEL_POSE_STALE_MS) continue;
      for (const t of info.poseMsg?.tags || []) {
        if (!bySeen.has(t.id)) bySeen.set(t.id, []);
        // Distance from the tag's own camera-frame translation. The wire format
        // carries tvec and px; `dist` is derived server-side in buildObs and
        // never comes back out, so deriving it here is deriving it once.
        const d = t.tvec ? Math.hypot(...t.tvec).toFixed(2) : '?';
        bySeen.get(t.id).push(`C${info.id} ${d} m`
          + (t.px ? ` · ${Math.round(t.px)} px` : ''));
      }
    }
    for (const [id, card] of tagCards) {
      const seen = bySeen.get(id);
      card.live.textContent = seen ? `seen by ${seen.join(' · ')}` : 'not in view';
      card.live.className = seen ? 'room' : '';
    }
  }

  const emptyEl = document.createElement('div');
  emptyEl.className = 'none';
  emptyEl.textContent = 'No clients connected';
  // Clients are updated in place, so they need a container of their own or a
  // client connecting after the map arrived would be appended below the tags.
  // Tags first: the survey is the standing description of the room and is read
  // top to bottom as a tree, while the clients are whoever happens to be in it
  // — a list that empties and refills, and one that would otherwise push the
  // tree down the drawer every time someone connected.
  const clientsEl = document.createElement('div');
  const tagsEl = document.createElement('div');
  // Landmark regions, directly under the surveyed tags and deliberately in the
  // same column: they are the other thing the room is being localized from, and
  // the comparison is the point. What keeps them from being read *as* tags is
  // the styling — dimmer, tinted, and carrying the colour of the client whose
  // session they belong to, because unlike a tag they are not the room's
  // property. They vanish with that client.
  const groupsEl = document.createElement('div');
  el.append(tagsEl, groupsEl, emptyEl, clientsEl);

  return {
    setActive(on) {
      el.classList.toggle('active', on);
    },

    // Told from outside, like the room views: one tag is hot across the whole
    // dashboard, and this only draws it.
    setHoveredTag(id) {
      hotTagId = id;
      for (const [tagId, card] of tagCards) card.root.classList.toggle('hot', tagId === id);
    },
    update(list, markerMap = null, landmarks = []) {
      buildGroups(landmarks);
      emptyEl.style.display = list.length ? 'none' : '';
      const seen = new Set();
      for (const info of list) {
        seen.add(info.id);
        let card = cards.get(info.id);
        if (!card) {
          card = buildCard(info.id);
          cards.set(info.id, card);
        }
        paint(card, info);
      }
      for (const [id, card] of cards) {
        if (seen.has(id)) continue;
        card.root.remove();
        cards.delete(id);
      }
      const rebuilt = buildTags(markerMap);
      // Ages tick on this panel's own cadence rather than a timer of their own,
      // so nothing is repainted behind a closed drawer. A second is as fine as
      // the figures get, and every fourth tick is close enough to one.
      // An OS clock resync can step the wall clock backwards, and a gate that
      // only looks forward would then freeze every age until real time caught
      // up again — an hour, for an hour's step.
      if (!rebuilt && Math.abs(Date.now() - agesPaintedAt) >= AGE_TICK_MS) {
        agesPaintedAt = Date.now();
        paintTagsAges();
      }
      paintTagsLive(list);
    },
  };
}
