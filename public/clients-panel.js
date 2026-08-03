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
// Nothing here is rebuilt — every list is matched against what is already on
// screen and moved (syncKeyed in common.js), the same rule the room views
// follow in anim.js. This panel repaints four times a second and the marker map
// under it is replaced several times a second while a survey is being walked,
// so a rebuild would close the resolution dropdown the instant it was opened,
// throw away the canvases a tag's history is drawn on, drop a two-click
// confirmation halfway through, and make it impossible to select a line of the
// readout for long enough to copy it.

const PANEL_RESOLUTIONS = ['480p', '720p', '1080p', '1440p', '4K'];

// A pose older than this says nothing about where the client is now.
const PANEL_POSE_STALE_MS = 2000;

// How strongly a card is washed with its owning client's colour. This is the
// whole of the ownership cue — there is no coloured edge any more — so it has to
// be readable against the card's own #1c1c1c at a glance and still stay behind
// the text. Faint on purpose: several of these stack under the tag cards, and a
// drawer of saturated blocks reads as a warning rather than as a grouping.
const CARD_TINT_ALPHA = 0.13;

function createClientsPanel(el,
  { onControl, onVcam, onRename, onHover, onTagOpen, onTagRemove, onTagHistory }) {
  const cards = new Map();   // clientId -> card DOM

  // Pointing at a card here points at the same entity in the room views, and
  // vice versa. Reported, never applied: what is hot is the viewer's to
  // decide, or a card and the map would each hold their own answer and
  // disagree the moment the pointer moved between them. One shape for every
  // card family — { kind: 'tag' | 'client' | 'region', id }.
  //
  // `id` identifies the *card*, and nothing else may be smuggled into it: it is
  // what the dashboard compares hovers by, so two cards sharing one id are one
  // entity and light as one. Anything a room view needs in order to draw the
  // hover at its own coarser grain rides in `extra` instead.
  function hoverable(root, kind, id, extra = null) {
    root.onpointerenter = () => onHover?.({ kind, id, ...extra });
    root.onpointerleave = () => onHover?.(null);
  }

  function button(label, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (title) b.title = title;
    return b;
  }

  // Did this client say anything about the switch at all? Absent is "no such
  // control on that page", which is not the same answer as off — and a button
  // drawn off against a client that has never heard of it is a lie.
  function reported(v) {
    return v !== null && v !== undefined;
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
    hoverable(root, 'client', id);

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
    // XR only — the tracker cost lives on the phone, so this drives the
    // phone's own switch and, like every control here, renders only what the
    // client reports back.
    const lm = toggle('Landmarks', 'landmarks', id,
      'Landmark collection — off saves most of the phone\'s per-frame cost');
    // XR only — that page's camera is a GL texture with no stream behind it, so
    // sending video is work it does on purpose rather than something it is
    // always doing. Off costs it nothing.
    const stream = toggle('Stream', 'stream', id,
      'Send video to the dashboard and record it here — costs the phone detection rate');
    const flip = button('Flip', 'Switch between the front and rear camera');
    const rec = button('New rec', 'Close the current recording and start the next');
    rec.onclick = () => onControl(id, 'record', true);
    ctrls.append(res, mic, pose, paused, blank, lm, stream, flip, rec);

    root.append(head, lines, ctrls);
    return {
      root, name, rename, kind, lines, vcamBtn,
      res, mic, pose, paused, blank, lm, stream, flip, rec,
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
    if (info.landmarks === false) bits.push('landmarks off');
    out.push(bits.join(' · '));
    // Reconnaissance, XR only: which WebXR features the session granted.
    // plane-detection or anchors turning up here is ARCore offering geometry
    // the CV pipeline currently computes by hand.
    if (info.kind === 'xr' && info.xrFeatures?.length) {
      out.push(`xr: ${info.xrFeatures.join(' ')}`);
    }

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
    } else if (info.kind !== 'xr' || info.stream) {
      // An XR client with the switch off is not missing anything; one that says
      // it is streaming and has no feed here is.
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

    // Only the room line is coloured, and only while it is fresh: a stale
    // position reading in the same green as a live one is the one thing this
    // panel must not do.
    syncTextRows(card.lines, statusLines(info).map((text, i) => ({
      text,
      cls: i === 0 && (info.paused || info.blank) ? 'warn'
        : text.startsWith('NO ARCORE TRACK') ? 'bad'
          : text.startsWith('room ') && info.poseAge < PANEL_POSE_STALE_MS ? 'room'
            : '',
    })));

    // An XR client has no mic, no lens and no resolution to pick — ARCore
    // chooses the camera image — and its tag detection is the entire point of
    // the page, so pausing it would mean stopping the one thing it is for.
    // Offering those controls would be offering buttons that do nothing.
    const full = info.kind !== 'xr';
    for (const c of [card.res, card.mic, card.pose, card.paused, card.flip]) {
      c.style.display = full ? '' : 'none';
    }
    // The XR page's switches. A client that never reported the state (old
    // build, capture client) gets no button rather than a lying one.
    card.lm.style.display = reported(info.landmarks) ? '' : 'none';
    card.stream.style.display = reported(info.stream) ? '' : 'none';
    // A recording to cut exists on any client that is sending one.
    card.rec.style.display = full || info.stream ? '' : 'none';
    card.vcamBtn.style.display = full && info.vcamAvailable ? '' : 'none';
    card.vcamBtn.classList.toggle('on', !!info.vcam);

    if (document.activeElement !== card.res && info.res) card.res.value = info.res;
    card.mic.classList.toggle('on', !!info.mic);
    card.pose.classList.toggle('on', !!info.pose);
    card.paused.classList.toggle('on', !!info.paused);
    card.blank.classList.toggle('on', !!info.blank);
    card.lm.classList.toggle('on', !!info.landmarks);
    card.stream.classList.toggle('on', !!info.stream);
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
  const tagCards = new Map();   // tag id -> card, see buildTagCard
  // The nesting the tree is drawn as, kept beside the cards: a card moving to a
  // new parent is a re-parenting of the node it sits in, not a rebuild of it.
  const tagNodes = new Map();   // tag id -> { node, plain, chained }
  let tagsFrom = null;
  // Whether each tag's stored pose is still walking anywhere. `resid` alone
  // cannot answer that — it is one fix's disagreement, and the fixes are noisy,
  // so it never falls to the few millimetres that read as converged and every
  // tag showed "settling" forever. What settling means is that refinement is
  // still moving the pose, so that is what is measured: the stored pose against
  // where it was, held here because the map object is replaced wholesale on
  // every message and carries no history of itself.
  const settleHist = new Map();   // tag id -> { p, q, stillAtMs }
  // Last hover the viewer told this panel about, as { kind, id } | null. Held
  // rather than read back off the cards: what is hot is one entity across the
  // whole dashboard, and a card arriving under a pointer that has not moved
  // since must be drawn hot from the start.
  let hot = null;
  const isHot = (kind, id) => !!hot && hot.kind === kind && hot.id === id;
  let agesPaintedAt = 0;
  const AGE_TICK_MS = 1000;
  const SETTLE_WINDOW_MS = 20000;
  const SETTLE_MOVE_M = 0.001;
  const SETTLE_MOVE_DEG = 0.1;

  // Which tag card is open, and the record the server sent for it. One at a
  // time: a tag's history is the thing being compared *against the room*, not
  // against the tag below it, and a drawer of open cards is a drawer nobody can
  // find a tag in. Held out here rather than read off the DOM, for the same
  // reason the hover is: it is the panel's state, not the map's.
  let openTagId = null;
  // { id, samples, events } as it last arrived. Kept whole rather than merged
  // into a running copy: the server sends the whole record every poll precisely
  // so that there is one description of a tag's past and it is the server's.
  let tagHist = null;
  let histAskedAt = 0;
  // Polled while a card is open. A sample a second is what the server records,
  // so asking faster only re-sends the same array.
  const HIST_POLL_MS = 1000;

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

  // Every line on a tag card is one fact, written `label: value` with the
  // labels down the left edge and the colons in one column: a card is read down
  // its numbers and compared against the card above it, and a sentence jamming
  // three facts together has to be parsed before either can happen. The lines
  // block is monospace and pre-wrapped, so padding the label is the whole of the
  // alignment.
  // The colon column is the longest label *on that card*, not the longest one
  // the panel can print: the anchor's card is a single `in view` row, and padded
  // to the width of a card carrying `last check` it reads as a column of blank
  // space with a stray line in it. Which rows a card has changes as it is
  // repainted — a tag going disputed grows a `last check` — so the label and the
  // value are kept on each row and the whole block is re-padded together;
  // padding a row on its own is what would let one card hold two columns.
  function layoutKv(node) {
    const root = node.closest('.lines') || node;
    const rows = [...root.querySelectorAll('[data-kv-label]')];
    // One space past the longest label, so the colon column stands off every
    // label including the one that set it — a colon hard against the widest
    // label reads as belonging to that word rather than to the column.
    const w = Math.max(0, ...rows.map((r) => r.dataset.kvLabel.length)) + 1;
    for (const r of rows) {
      r.textContent = `${r.dataset.kvLabel.padEnd(w)}: ${r.dataset.kvValue}`;
    }
  }

  // Records the fact; the padding is decided by the block it ends up in.
  function kvRow(label, value) {
    const div = document.createElement('div');
    div.dataset.kvLabel = label;
    div.dataset.kvValue = value;
    return div;
  }

  function setKv(el, label, value) {
    el.dataset.kvLabel = label;
    el.dataset.kvValue = value;
    layoutKv(el);
  }

  // Whether the tag is still moving, and by how much it wants to. Without this
  // the survey is a black box: a tag healing ten degrees over ten minutes and a
  // tag frozen at the wrong orientation look identical, which is exactly how a
  // stuck one went unnoticed. `resid` is what refinement is still being told to
  // correct, not what it has corrected. Its own function because it is the one
  // line on a card that goes stale on its own — it carries an age, and the
  // cards are rebuilt only when a new map arrives, which is never once a survey
  // stops moving.
  function settleRows(tag) {
    if (tag.refinedAtMs) {
      const mm = Math.round((tag.resid ?? 0) * 1000);
      const deg = (tag.residDeg ?? 0).toFixed(1);
      const settled = settleState(tag);
      return {
        rows: [
          ['state', settled ? 'settled' : 'settling'],
          ['off by', `${mm} mm / ${deg}°`],
          ['nudged', `${fmtAge(Date.now() - tag.refinedAtMs)} ago`],
        ],
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
        rows: [
          ['state', 'disputed'],
          ['off by', `${mm} mm`],
          ['last check', `${fmtAge(Date.now() - tag.checkedAtMs)} ago`],
          ['note', 'too far to refine, will drop and re-survey once enough witnesses agree'],
        ],
        warn: true,
      };
    }
    // Refinement needs two known tags in one frame, and a tag that is never
    // seen beside another one is never corrected however long it is watched.
    return {
      rows: [
        ['state', 'never refined'],
        ['note', 'needs another known tag in the same frame'],
      ],
      warn: true,
    };
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
  //
  // A tag with no founding chain at all — promoted while ARCore carried the pose
  // — is then hung off whichever tag has since done most of the *refining* of it,
  // drawn on a dashed rail because that link is where the tag is being corrected
  // from, not where it came from. The same cycle argument covers it, one step
  // further on: the server derives `chainHops` from the parents' founding depth
  // only, so a chained tag (founding depth null) can never satisfy either parent
  // test and is always a leaf.
  function tagTree(markers, anchorId) {
    const byId = new Map(markers.map((t) => [t.id, t]));
    const kids = new Map(markers.map((t) => [t.id, []]));
    const roots = [];
    for (const tag of markers) {
      const founding = Number.isFinite(tag.hops) && tag.hops > 0
        ? (tag.from || []).find((id) => byId.get(id)?.hops === tag.hops - 1)
        : undefined;
      const parent = founding !== undefined ? founding
        : Number.isFinite(tag.chainHops)
          ? (tag.chainFrom || []).find((id) => byId.get(id)?.hops === tag.chainHops - 1)
          : undefined;
      if (parent === undefined) roots.push(tag);
      else kids.get(parent).push({ tag, chained: founding === undefined });
    }
    const byIdAsc = (a, b) => a.id - b.id;
    // The anchor heads the list whatever its id: everything else is measured
    // from it, and a tag with no provenance is also a root but is not a datum.
    roots.sort((a, b) => (a.id === anchorId ? -1 : b.id === anchorId ? 1 : byIdAsc(a, b)));
    for (const list of kids.values()) list.sort((a, b) => byIdAsc(a.tag, b.tag));
    return { roots, kids };
  }

  // The wrapper a tag's card and its children's rails live in. One per tag for
  // as long as the tag is in the map, so a tag that changes parent is moved
  // rather than rebuilt — and the two `.tag-kids` rails under it are made on
  // demand and simply detached when that group empties, since the stylesheet
  // draws the rail off the container's own border.
  function tagNode(id) {
    let n = tagNodes.get(id);
    if (!n) {
      const node = document.createElement('div');
      node.className = 'tag-node';
      n = { node, plain: null, chained: null };
      tagNodes.set(id, n);
    }
    return n;
  }

  function buildTags(markerMap) {
    // Repainted only when the map object changes — it is replaced wholesale by
    // every marker-map message and this panel repaints four times a second.
    if (tagsFrom === markerMap) return false;
    tagsFrom = markerMap;
    agesPaintedAt = Date.now();
    const markers = [...(markerMap?.markers || [])];
    const { roots, kids } = tagTree(markers, markerMap?.anchorId);
    const live = new Set(markers.map((t) => t.id));
    for (const id of [...tagCards.keys()]) {
      if (live.has(id)) continue;
      tagNodes.get(id)?.node.remove();
      tagNodes.delete(id);
      tagCards.delete(id);
      // A removed tag that comes back is a re-survey, not a continuation, so
      // its old stillness is not evidence about the new pose.
      settleHist.delete(id);
    }
    for (const tag of markers) {
      const isAnchor = tag.id === markerMap.anchorId;
      const had = tagCards.get(tag.id);
      // The one thing a card cannot be repainted across: the anchor's card is a
      // different shape — no observation count, no facing, "origin" where the
      // position column goes — because it is a datum rather than a measurement.
      // Re-anchoring is a whole new room frame anyway.
      if (had && had.isAnchor !== isAnchor) {
        had.root.remove();
        tagCards.delete(tag.id);
      }
      if (!tagCards.has(tag.id)) tagCards.set(tag.id, buildTagCard(tag.id, isAnchor));
    }
    // Depth-first, so a tag sits directly under its parent and the rails in the
    // stylesheet are the nesting itself rather than a computed indent. Founding
    // children first, then the refine-chained ones on their own rail — one
    // group per kind of link, so the rail itself carries which it is. Both
    // placed through the same call, or the two rails drift apart the first time
    // either is touched.
    const place = (tag) => {
      const n = tagNode(tag.id);
      const inner = [tagCards.get(tag.id).root];
      for (const chained of [false, true]) {
        const list = (kids.get(tag.id) || []).filter((k) => k.chained === chained);
        const which = chained ? 'chained' : 'plain';
        if (!list.length) {
          n[which]?.remove();
          continue;
        }
        if (!n[which]) {
          const sub = document.createElement('div');
          sub.className = chained ? 'tag-kids chained' : 'tag-kids';
          n[which] = sub;
        }
        orderChildren(n[which], list.map((kid) => place(kid.tag)), true);
        inner.push(n[which]);
      }
      orderChildren(n.node, inner, true);
      return n.node;
    };
    // Placed before painted, not after: drawSpark sizes a chart from the
    // canvas's own layout box, and a card painted while still detached draws
    // its history at the fallback width until the next poll.
    orderChildren(tagsEl, roots.map(place), true);
    for (const tag of markers) paintTagCard(tagCards.get(tag.id), tag);
    // The open card's tag left the map — dropped for disagreeing, or forgotten
    // by hand. Nothing would ever close it otherwise, and the panel would go on
    // asking the server about a tag it no longer has.
    if (openTagId !== null && !tagCards.has(openTagId)) setOpenTag(null);
    return true;
  }

  // The region cards on screen, keyed the way every other list here is so
  // setHovered can reach one. A note (the singleton tally, a candidate line)
  // belongs to no region and carries `clientId: null`.
  const groupCards = new Map();   // key -> { root, clientId, ... }

  // Landmark regions as cards, one per group, newest survey state each call.
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
    const items = shown.map((g) => ({ k: `r${g.clientId}:${g.id}`, g }));
    if (solo) {
      items.push({
        k: 'solo',
        bg: 'rgba(255,255,255,0.03)',
        text: `+${solo} single-anchor region${solo === 1 ? '' : 's'}`,
      });
    }
    for (const c of cand) {
      items.push({
        k: `c${c.clientId}`,
        // The candidate grey, not the client's colour: a card in the client's
        // colour claims the client *has* these, and the whole point of the card
        // is that it does not yet.
        bg: roomCandidateColorCss(CARD_TINT_ALPHA),
        text: `${c.n} candidate${c.n === 1 ? '' : 's'}`
          + ` · best arc ${Math.round(c.best)}/${ROOM_LANDMARK_ARC_DEG}°`,
      });
    }
    syncKeyed(groupsEl, items, {
      key: (it) => it.k,
      store: groupCards,
      make: (it) => (it.g ? buildGroupCard(it.g.clientId, it.k, it.g.id) : buildGroupNote()),
      paint: (card, it) => (it.g ? paintGroupCard(card, it.g) : paintGroupNote(card, it)),
    });
  }

  function buildGroupNote() {
    const root = document.createElement('div');
    root.className = 'drawer-card';
    root.style.opacity = '0.6';
    return { root, clientId: null };
  }

  function paintGroupNote(card, it) {
    card.root.style.background = it.bg;
    if (card.root.textContent !== it.text) card.root.textContent = it.text;
  }

  function buildGroupCard(clientId, key, regionId) {
    const root = document.createElement('div');
    root.className = 'drawer-card';
    // The card's own key, not its client's. A client has several regions, and
    // keying the hover by the client made them one entity: pointing at any
    // region card lit every other region that client owns.
    //
    // The client and the region ride along for the map, which draws points
    // rather than cards and identifies them by that pair.
    hoverable(root, 'region', key, { clientId, regionId });
    // Tinted rather than classed: the tint is the client's own colour, so it
    // cannot live in the stylesheet as a fixed value. Kept faint — this has to
    // read as "not a tag" at a glance without competing with the tags above it.
    root.style.background = roomClientColorCss(clientId, CARD_TINT_ALPHA);

    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('span');
    name.className = 'name';
    name.style.color = roomClientColorCss(clientId);
    const kind = document.createElement('span');
    kind.className = 'kind';
    head.append(name, kind);

    // `lines` is the tag card's own body container, so these sit on the same
    // grid as everything above them rather than inventing a second layout.
    const lines = document.createElement('div');
    lines.className = 'lines';
    const pos = document.createElement('div');
    const arc = document.createElement('div');
    lines.append(pos, arc);

    root.append(head, lines);
    return { root, clientId, key, name, kind, pos, arc };
  }

  function paintGroupCard(card, g) {
    card.root.classList.toggle('hot', isHot('region', card.key));
    card.name.textContent = `Region ${g.id}`;
    // Live against total is the honest state of it: a landmark the map remembers
    // but nothing is currently looking at cannot contribute to a fix.
    card.kind.textContent = `${g.live}/${g.n} landmarks`;
    card.pos.textContent = `${g.p.map((v) => v.toFixed(2)).join(', ')} m`;
    // The widest arc any member was seen through. It is the quality of the look
    // this region got, and the reason one region qualifies where another does
    // not — so it is the one measurement worth a line here.
    card.arc.textContent = `client ${g.clientId} · seen through ${g.span}°`;
  }

  // --- What the tag has been doing ------------------------------------------
  // The card's other lines are all *now*: where the tag is, what it is being
  // told to correct, how long since it was last nudged. None of them can answer
  // the questions a survey actually raises — did this tag arrive where it sits
  // or walk there, has it ever been knocked, has it stopped moving or has it
  // merely stopped being looked at. The server keeps the record (tag-history.js)
  // and the open card asks for it.
  //
  // Drawn rather than listed: a settling line repeated two hundred times says
  // nothing more than one of them, and the shape of the curve — a step, a slow
  // decay, a flat line with a gap in it — is the whole of the answer.

  // Sample layout as tag-history.js packs it: [t, x,y,z, qx,qy,qz,qw, mm, deg].
  const S_T = 0, S_P = 1, S_Q = 4, S_MM = 8, S_DEG = 9;

  const SPARK_H = 40;
  // The two series share one chart and are therefore a categorical pair, checked
  // as one against this card's own #1c1c1c: OKLab ΔE 8.9 under protanopia and
  // deuteranopia, 16.7 with normal vision, both above the floor. They are the
  // panel's own green and amber taken down into the dark-surface lightness band
  // — the text colours (#8fc79d / #e0a03a) sit above it, and as 2 px lines on
  // near-black they are too pale and too close to each other to tell apart.
  const SPARK_MOVED = '#3aa471';
  const SPARK_OFF = '#bd8420';
  // Reserved, and used here for the one event that is a fault: the tag was found
  // somewhere else and dropped. A promotion is not a fault, so it is muted.
  const SPARK_RESEED = '#e0603a';
  const SPARK_EVENT = '#7a7a7a';
  const SPARK_AXIS = '#333';
  const SPARK_INK = '#9a9a9a';
  // A break in the line rather than a straight segment across the gap: nothing
  // was measured in between, and a level line there reads as "held still" —
  // which is exactly the claim a tag nobody looked at must not be allowed to
  // make.
  //
  // Measured against the record's own cadence, never a fixed interval. The
  // server samples at most once a second but only while the tag is *being
  // refined*, which needs two known tags in one frame — on a real journal that
  // came out at one sample every ten seconds — and the old half of a long record
  // is thinned, so its spacing is a multiple of the new half's. A fixed 2.5 s
  // rule broke every segment of every series: nothing was drawn but the axis.
  const SPARK_GAP_FACTOR = 4;
  const SPARK_GAP_MIN_MS = 5000;
  // Below this many points the samples are drawn as dots as well as a line: a
  // sparse record is mostly breaks, and a break between two invisible points
  // leaves an empty chart that cannot be told from no data at all.
  const SPARK_DOTS_UNDER = 80;

  function gapMs(pts) {
    if (pts.length < 3) return SPARK_GAP_MIN_MS;
    const d = [];
    for (let i = 1; i < pts.length; i++) d.push(pts[i][0] - pts[i - 1][0]);
    d.sort((a, b) => a - b);
    return Math.max(SPARK_GAP_MIN_MS, SPARK_GAP_FACTOR * d[d.length >> 1]);
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const mag = 10 ** Math.floor(Math.log10(v));
    // Finer than the usual 1/2/5: a 107 mm trace against a 200 mm ceiling uses
    // half the height it has, and these are 40 px tall to begin with. Nothing
    // here rounds past 1.5x the data.
    for (const step of [1, 1.5, 2, 3, 5, 7.5, 10]) {
      if (v <= step * mag) return step * mag;
    }
    return 10 * mag;
  }

  // One chart, any number of series on one axis — both charts here are built
  // from it, and a second copy would be the place the two drift apart. Series
  // that do not share a unit never share a chart: millimetres and degrees are
  // two charts, not two axes.
  function drawSpark(canvas, { series, events, t0, t1, fmt, hoverT }) {
    const w = Math.max(60, Math.round(canvas.clientWidth || 0));
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(SPARK_H * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(SPARK_H * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, SPARK_H);
    const top = 11, bottom = SPARK_H - 3;
    const span = Math.max(1, t1 - t0);
    let vmax = 0;
    for (const s of series) for (const [, v] of s.pts) vmax = Math.max(vmax, v);
    vmax = niceMax(vmax);
    const x = (t) => ((t - t0) / span) * (w - 1);
    const y = (v) => bottom - (Math.min(v, vmax) / vmax) * (bottom - top);

    // The zero line, because every series here is a distance from something and
    // zero is where they all mean "no disagreement left".
    g.strokeStyle = SPARK_AXIS;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, bottom + 0.5);
    g.lineTo(w, bottom + 0.5);
    g.stroke();

    // Under the traces: an event is when something happened to the tag, not a
    // measurement of it, and it must not cover the curve it explains.
    for (const ev of events) {
      if (ev.t < t0) continue;
      const ex = Math.round(x(ev.t)) + 0.5;
      g.strokeStyle = ev.kind === 'reseeded' ? SPARK_RESEED : SPARK_EVENT;
      g.beginPath();
      g.moveTo(ex, top - 3);
      g.lineTo(ex, bottom);
      g.stroke();
    }

    for (const s of series) {
      g.strokeStyle = s.color;
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      const gap = gapMs(s.pts);
      let prevT = null;
      for (const [t, v] of s.pts) {
        if (prevT === null || t - prevT > gap) g.moveTo(x(t), y(v));
        else g.lineTo(x(t), y(v));
        prevT = t;
      }
      g.stroke();
      if (s.pts.length <= SPARK_DOTS_UNDER) {
        g.fillStyle = s.color;
        for (const [t, v] of s.pts) {
          g.beginPath();
          g.arc(x(t), y(v), 1.5, 0, Math.PI * 2);
          g.fill();
        }
      }
    }

    // The scale, as one number: these are sparklines in a 320 px drawer and an
    // axis would cost more room than the trace it labels. Without it the chart
    // is shape-only and a 2 mm wobble looks like a 2 m one.
    g.fillStyle = SPARK_INK;
    g.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    g.textAlign = 'right';
    g.textBaseline = 'top';
    g.fillText(fmt(vmax), w - 1, 0);

    if (hoverT !== null && hoverT !== undefined) {
      const hx = Math.round(x(hoverT)) + 0.5;
      g.strokeStyle = '#cfcfcf';
      g.beginPath();
      g.moveTo(hx, top - 3);
      g.lineTo(hx, bottom);
      g.lineWidth = 1;
      g.stroke();
      for (const s of series) {
        const pt = nearestPt(s.pts, hoverT);
        if (!pt) continue;
        g.fillStyle = s.color;
        g.beginPath();
        g.arc(x(pt[0]), y(pt[1]), 2.5, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  function nearestPt(pts, t) {
    let best = null, bestD = Infinity;
    for (const p of pts) {
      const d = Math.abs(p[0] - t);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  // Everything the two charts draw, derived from the raw record in one place so
  // the charts, the summary and the hover readout cannot disagree about what a
  // number means. Both drift series are measured against the pose the map holds
  // *now* — the question being asked of the history is how far the tag has come
  // to get here, so the curve has to arrive at zero on the right.
  function histSeries(hist) {
    const s = hist.samples;
    const out = { moved: [], off: [], turned: [], offDeg: [], path: 0 };
    if (!s.length) return out;
    const last = s[s.length - 1];
    const p = [last[S_P], last[S_P + 1], last[S_P + 2]];
    const q = [last[S_Q], last[S_Q + 1], last[S_Q + 2], last[S_Q + 3]];
    let prev = null;
    for (const k of s) {
      const kp = [k[S_P], k[S_P + 1], k[S_P + 2]];
      out.moved.push([k[S_T], Math.hypot(kp[0] - p[0], kp[1] - p[1], kp[2] - p[2]) * 1000]);
      out.turned.push([k[S_T],
        quatAngleDeg([k[S_Q], k[S_Q + 1], k[S_Q + 2], k[S_Q + 3]], q)]);
      if (k[S_MM] !== null) out.off.push([k[S_T], k[S_MM]]);
      if (k[S_DEG] !== null) out.offDeg.push([k[S_T], k[S_DEG]]);
      // Distance actually walked, not net displacement: a tag that healed 40 mm
      // one way and 40 mm back is not a tag that never moved.
      if (prev) out.path += Math.hypot(kp[0] - prev[0], kp[1] - prev[1], kp[2] - prev[2]) * 1000;
      prev = kp;
    }
    return out;
  }

  // Two lines: the whole record, and the last minute of it. The second is the
  // one that answers "is it still moving" — the settle line above says settled
  // or settling from two consecutive maps, and this says by how much.
  function histSummary(hist, ser) {
    const s = hist.samples;
    const now = Date.now();
    const first = s[0][S_T];
    const last = s[s.length - 1];
    const net = ser.moved[0][1];
    // The span of the record itself, not how far back it reaches: a session that
    // ended hours ago covers the minutes it covered, and "52 samples over 9.9
    // hrs" claims a record of the whole night. How long ago it stopped is the
    // second line's job.
    const lines = [s.length < 2
      ? '1 sample — nothing to compare it against yet'
      : `${s.length} samples spanning ${fmtAge(last[S_T] - first)} · `
        + `${Math.round(net)} mm net, ${Math.round(ser.path)} mm walked`];

    // Against the oldest sample still inside the window, so a tag observed twice
    // in the last minute is compared over those two and not over the whole
    // record. A tag nobody has looked at in a minute has no answer, and says so
    // rather than reporting the stillness of a record that simply stopped.
    const recent = ser.moved.filter((k) => now - k[0] <= 60000);
    if (recent.length >= 2) {
      const turned = ser.turned.filter((k) => now - k[0] <= 60000);
      lines.push(`last minute ${Math.round(recent[0][1] - recent[recent.length - 1][1])} mm · `
        + `${(turned[0][1] - turned[turned.length - 1][1]).toFixed(1)}°`
        + (last[S_MM] === null ? '' : ` · still off by ${last[S_MM]} mm, ${last[S_DEG]}°`));
    } else {
      lines.push('nothing recorded in the last minute — last sample '
        + `${fmtAge(now - last[S_T])} ago`);
    }
    return lines;
  }

  // The legend, as its own row under each chart: two series always carry one
  // (colour alone must not be the only thing telling them apart), and the same
  // row is where the hover readout lands, so the card does not change height as
  // the pointer moves across it.
  // One span per key rather than one per entry, so the swatches stay flat
  // siblings of the labels — the gap before an entry is a `.sw:not(:first-child)`
  // rule and wrapping each entry would take it away.
  function keyRow(el, entries) {
    const items = [];
    entries.forEach(([color, label], i) => {
      // A colourless entry is the hover readout's timestamp: it belongs to no
      // series and must not be given a swatch that implies one.
      if (color) items.push({ k: `sw${i}`, color });
      items.push({ k: `tx${i}`, label });
    });
    syncKeyed(el, items, {
      key: (it) => it.k,
      make: (it) => {
        const span = document.createElement('span');
        if (it.color !== undefined) span.className = 'sw';
        return span;
      },
      paint: (span, it) => {
        if (it.color !== undefined) span.style.background = it.color;
        // Text in the card's own ink, never the series colour: the swatch beside
        // it carries the identity.
        else if (span.textContent !== it.label) span.textContent = it.label;
      },
    });
  }

  // The two charts a tag card carries. Millimetres and degrees are two charts
  // and never two axes on one: a second scale down the right-hand side makes any
  // two curves look related, and the relation is the reader's own eye.
  const HIST_CHARTS = [
    {
      unit: 'mm',
      fmt: (v) => `${Math.round(v)} mm`,
      series: [
        [SPARK_MOVED, 'away from here', 'moved'],
        [SPARK_OFF, 'off by', 'off'],
      ],
    },
    {
      unit: 'deg',
      fmt: (v) => `${+v.toFixed(2)}°`,
      series: [
        [SPARK_MOVED, 'turned from here', 'turned'],
        [SPARK_OFF, 'off by', 'offDeg'],
      ],
    },
  ];

  function buildHistBlock() {
    const root = document.createElement('div');
    root.className = 'hist';
    const sum = document.createElement('div');
    sum.className = 'hist-sum';
    root.append(sum);
    const charts = HIST_CHARTS.map((spec) => {
      const canvas = document.createElement('canvas');
      canvas.className = 'spark';
      const key = document.createElement('div');
      key.className = 'spark-key';
      root.append(canvas, key);
      const chart = { spec, canvas, key, hoverT: null, series: [], events: [], t0: 0, t1: 0 };
      // A crosshair rather than a tooltip: the drawer is 320 px wide, a floating
      // box would cover the chart it describes, and the legend row underneath is
      // already the right size for the readout — so the reading lands there and
      // the card does not change height as the pointer crosses it.
      canvas.onpointermove = (ev) => {
        if (!chart.series.length) return;
        const rect = canvas.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / Math.max(1, rect.width)));
        chart.hoverT = chart.t0 + frac * (chart.t1 - chart.t0);
        drawChart(chart);
      };
      canvas.onpointerleave = () => {
        chart.hoverT = null;
        drawChart(chart);
      };
      return chart;
    });
    return { root, sum, charts };
  }

  function drawChart(chart) {
    drawSpark(chart.canvas, {
      series: chart.series,
      events: chart.events,
      t0: chart.t0,
      t1: chart.t1,
      unit: chart.spec.unit,
      fmt: chart.spec.fmt,
      hoverT: chart.hoverT,
    });
    if (chart.hoverT === null) {
      keyRow(chart.key, chart.series.map((s) => [s.color, s.label]));
      return;
    }
    // The hovered instant is named by age, like every other time on this panel:
    // a wall-clock stamp would be the only one here and would have to be read
    // against the "nudged 4 min ago" two lines above it.
    const at = nearestPt(chart.series[0]?.pts || [], chart.hoverT);
    const parts = chart.series.map((s) => {
      const pt = nearestPt(s.pts, chart.hoverT);
      return [s.color, pt ? `${s.label} ${chart.spec.fmt(pt[1])}` : `${s.label} —`];
    });
    if (at) parts.unshift([null, fmtAge(Date.now() - at[0])]);
    keyRow(chart.key, parts);
  }

  // The one notable thing that has happened to this tag, named. The charts carry
  // events as ticks and a tick cannot say what it was — and the difference
  // between a step in the position trace that is a re-seed and one that is a
  // long drift is the whole reading.
  function histEventLine(hist) {
    const ev = hist.events[hist.events.length - 1];
    if (!ev) return null;
    const age = fmtAge(Date.now() - ev.t);
    if (ev.kind === 'anchored') {
      return `anchored ${age} ago`
        + (ev.ambiguous ? ' — from a sighting whose mirror was still plausible' : '');
    }
    if (ev.kind === 'reseeded') {
      return `re-seeded ${age} ago — it was found ${ev.offMm} mm away `
        + `${ev.n} sightings running, so the old pose was dropped`;
    }
    if (ev.kind === 'promoted') {
      return `placed ${age} ago on ${ev.n}/${ev.of} estimates`
        + (ev.from?.length ? ` via ${ev.from.join(', ')}` : ' off ARCore alone');
    }
    return `${ev.kind} ${age} ago`;
  }

  function paintHistory(card) {
    const els = card.histEls;
    const lines = [];
    // The record for another tag, or none yet: the poll is a round trip and the
    // card is open before it lands. Saying so beats an empty box that cannot be
    // told apart from a tag with no history.
    if (!tagHist || tagHist.id !== card.tag.id) {
      els.root.classList.add('empty');
      syncTextRows(els.sum, [{ text: 'reading the record…' }]);
      return;
    }
    const hist = tagHist;
    const ser = hist.samples.length ? histSeries(hist) : null;
    if (!ser) {
      els.root.classList.add('empty');
      lines.push(card.isAnchor
        // The anchor is not measured against anything, so there is nothing to
        // record about it and an empty chart would imply there ought to be.
        ? 'the room origin — its pose is asserted, not measured, so nothing about '
          + 'it is refined and nothing is recorded'
        // Deliberately not "it has never been refined": the record starts when
        // the server does, and a map that has outlived its history — a restart,
        // a re-anchoring — has tags with thousands of cross-checks and nothing
        // recorded. Saying they were never refined would be a lie the card above
        // it contradicts.
        : 'nothing recorded yet — a tag is sampled as it is refined, and this one '
          + 'has not been refined since the record began');
      const ev = histEventLine(hist);
      if (ev) lines.push(ev);
      syncTextRows(els.sum, lines.map((text) => ({ text })));
      return;
    }
    els.root.classList.remove('empty');
    lines.push(...histSummary(hist, ser));
    const ev = histEventLine(hist);
    if (ev) lines.push(ev);
    syncTextRows(els.sum, lines.map((text) => ({ text })));

    const t0 = hist.samples[0][S_T];
    // The right edge is now, not the last sample: a tag nobody has looked at for
    // ten minutes must be seen to stop, or a record that simply ended reads as a
    // tag that has settled.
    const t1 = Date.now();
    els.charts.forEach((chart) => {
      chart.series = chart.spec.series.map(([color, label, key]) =>
        ({ color, label, pts: ser[key] }));
      chart.events = hist.events;
      chart.t0 = t0;
      chart.t1 = t1;
      drawChart(chart);
    });
  }

  // Opening a card is what asks the server for its history, and closing one is
  // what stops the polling. One at a time, so the answer being held is always
  // the answer to the card on screen.
  function setOpenTag(id) {
    if (openTagId === id) return;
    openTagId = id;
    tagHist = null;
    histAskedAt = 0;
    for (const [tagId, card] of tagCards) {
      card.root.classList.toggle('open', tagId === id);
      if (tagId === id) paintHistory(card);
    }
    // The room views draw the open tag's distances to its neighbours, and this
    // is the only place that knows which card that is. Reported, never applied —
    // the same arrangement as the hover.
    onTagOpen?.(id);
    askHistory();
  }

  function askHistory() {
    if (openTagId === null || !onTagHistory) return;
    histAskedAt = Date.now();
    onTagHistory(openTagId);
  }

  // A metre figure with its sign always written. The position column is
  // monospace and pushed to the card's right edge, so it is read *down* the
  // drawer — and an unsigned positive is one character narrower than a negative,
  // which shifts every ordinate on that card out of the column its neighbours
  // sit in. The sign is taken from the rendered digits rather than the raw
  // value: -0.001 prints as -0.00, and a + on it would claim a side of zero the
  // number on screen does not show.
  function fmtSignedM(v) {
    const s = v.toFixed(2);
    return s.startsWith('-') ? s : `+${s}`;
  }

  // Everything about a tag card that never changes while the tag is in the map.
  // Built once and then only painted: it owns two canvases, a two-click
  // confirmation and whatever the pointer is currently doing to it, none of
  // which a marker-map message knows anything about.
  function buildTagCard(id, isAnchor) {
    const root = document.createElement('div');
    // `tag` as well: a client card carries the remote control and must stay
    // open, so only these collapse.
    root.className = 'drawer-card tag';
    const head = document.createElement('div');
    head.className = 'head';
    // The settle state, as a dot, because a collapsed card has no room for the
    // sentence — and a drawer of collapsed cards must still be able to say which
    // tag is the one worth opening.
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `Tag ${id}`;
    // nObs because a tag promoted on 8 estimates and one settled over 226 are
    // not the same claim, and that gap is usually what a position that looks
    // wrong turns out to be. The anchor has none — it is the datum, not a
    // measurement, and it is the one tag whose being wrong is undetectable.
    const kind = document.createElement('span');
    kind.className = 'kind';
    if (!isAnchor) head.append(dot, name, kind);
    else head.append(dot, name);

    // The right edge is the position column, read down the drawer rather than
    // within one card — so what stands in place of the anchor's position goes
    // there too, and the column answers "where is this tag" on every card.
    const at = document.createElement('span');
    at.className = 'at';
    const axes = [];
    if (isAnchor) {
      at.textContent = 'origin';
    } else {
      // Each ordinate in its own axis colour, the same three the 3D helper and
      // the 2D crosses use. Three bare numbers give no clue which is the
      // height, and height is the one that exposes a tilted room frame. The
      // separators are their own text nodes: a comma inside the span would take
      // that ordinate's colour and read as part of the number.
      for (let k = 0; k < 3; k++) {
        const span = document.createElement('span');
        span.style.color = roomAxisColorCss(k);
        axes.push(span);
        at.append(span);
        if (k < 2) at.append(', ');
      }
    }
    head.append(at);

    const lines = document.createElement('div');
    lines.className = 'lines';
    // The settle block is several rows and their number changes with the state,
    // so it owns a container of its own inside the lines.
    const settle = document.createElement('div');
    // Carries its label from the start: the anchor's card is this row and
    // nothing else, and a row with no label in it would decide that card's
    // colon column until the first live paint arrived.
    const live = kvRow('in view', 'no');
    if (isAnchor) {
      // The datum has nothing to be settled about — it is where it is by
      // definition — so its dot says "not a measurement" rather than "fine".
      dot.className = 'dot datum';
      dot.title = 'The room origin: not measured, never refined';
    }

    const histEls = buildHistBlock();

    // The escape hatch for a tag that is gone from the room — one shown on a
    // screen, or a wall that was repainted. This is the only way to forget one
    // now: it used to be a double-click on the tag in the top view, which is
    // also the gesture that resets that view, on a target a few pixels across.
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'icon-btn mini rm danger';
    rm.title = isAnchor
      ? `Forget tag ${id} — it is the anchor, so the whole survey resets`
      : `Forget tag ${id}`;
    rm.setAttribute('aria-label', `Forget tag ${id}`);
    // A bin, not a cross: a cross on a card is the gesture for closing it, and
    // this one throws the tag out of the survey. No ribs on the body — at the
    // 12px this glyph is drawn at they close up into a smudge and cost the
    // silhouette that carries the meaning.
    rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M4 7h16"/><path d="M9.5 4h5"/>'
      + '<path d="M6.5 7l.9 12.1A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.9L17.5 7"/></svg>';
    // The arming lives in the button, which now outlives every map message —
    // it used to have to be carried across the rebuild by the panel, or the
    // second click could never land while a survey was running.
    const confirm = confirmButton(rm, () => onTagRemove?.(id), {
      armedTitle: isAnchor
        ? 'Click again to forget the anchor — the whole survey resets'
        : `Click again to forget tag ${id}`,
    });
    head.append(rm);

    hoverable(root, 'tag', id);

    // Left click anywhere on the card opens it, and opening one closes whatever
    // was open. Not on the buttons inside it: the remove button is a two-click
    // gesture of its own, and a card that also collapsed under it would move the
    // second click's target out from under the pointer.
    // The charts are excluded as well as the buttons: reading one means moving
    // the pointer along it, and a click landing at the end of that gesture must
    // not shut the thing being read.
    root.onclick = (ev) => {
      if (ev.button !== 0 || ev.target.closest('button, canvas')) return;
      setOpenTag(openTagId === id ? null : id);
    };

    root.append(head, lines, histEls.root);
    // `tag` is the newest map entry for it, kept so the settle line can be
    // repainted without one: it carries an age, and no marker-map message comes
    // back to a tag that has stopped being refined.
    return { root, live, confirm, settle, dot, kind, axes, lines, tag: null, isAnchor, histEls };
  }

  // Which rows a card carries changes as the tag's standing does — a tag going
  // disputed grows a `last check`, one that gets chained grows two more — so the
  // body is reconciled by label rather than rebuilt. The two containers that are
  // painted from elsewhere (the settle block, the in-view line) take part in the
  // ordering as themselves.
  function tagCardRows(card, tag) {
    const rows = [];
    if (!card.isAnchor) {
      // Which way the tag faces, in the same yaw/pitch convention the client
      // rows use. A tag mounted a few degrees off is invisible in its position
      // but is exactly what a mirror-flipped sighting leaves behind.
      const n = quatRotate(tag.q, [0, 0, 1]);
      const yaw = Math.atan2(n[0], n[2]) * 180 / Math.PI;
      const pitch = Math.asin(Math.max(-1, Math.min(1, n[1]))) * 180 / Math.PI;
      rows.push({ k: 'yaw', label: 'yaw', value: `${Math.round(yaw)}°` });
      rows.push({ k: 'pitch', label: 'pitch', value: `${Math.round(pitch)}°` });
      // What placed this tag and how far that is from the datum. The tree says
      // the depth already, but not *which* parents did the placing nor how well
      // checked the result is, and the deepest-chained tag is usually the one
      // that looks wrong. Parents are ordered by how much of the placing each
      // did — the first is the one the tree hangs this card off.
      const depth = (h) => ({
        k: 'depth',
        label: 'depth',
        value: h === null || h === undefined ? 'unrecorded' : `${h} hop${h === 1 ? '' : 's'} out`,
      });
      if (tag.from?.length) {
        rows.push({ k: 'via', label: 'via', value: tag.from.join(', ') }, depth(tag.hops));
      } else if (tag.from && tag.chainFrom?.length) {
        // Founded with no tag in view, but chained since: the founding fact is
        // permanent and stays first, and what has happened since follows it. A
        // tag that has been corrected against the map for an hour is not the
        // same thing as one that entered on ARCore this minute, and the card
        // said they were identical.
        rows.push(
          { k: 'placed', label: 'placed', value: 'off ARCore alone' },
          { k: 'chained', label: 'chained', value: tag.chainFrom.join(', ') },
          depth(tag.chainHops),
        );
      } else {
        // No tag in view when it was placed and none has checked it since — the
        // fix was ARCore carrying the pose, which is the weakest way into the map.
        rows.push({
          k: 'placed',
          label: 'placed',
          value: tag.from ? 'off ARCore alone' : 'before this was recorded',
        });
      }
      // How many checks this tag has survived: promoting estimates measured
      // against a two-known-tag fix, plus every refinement since — each one
      // compared the stored pose against a fix from *other* tags and could
      // have disagreed. Zero means genuinely unfalsified: placed and then
      // never once seen beside another known tag. Printed whatever the founding
      // was, because the tag it matters most for is the one with no founding
      // chain to print it beside — that branch used to omit it, so a tag being
      // cross-checked ten times a second still read as the weakest thing in the
      // map.
      //
      // Unchecked is the thing worth colouring, not unchained: a tag founded off
      // ARCore and cross-checked four hundred times since is no longer the
      // suspect entry on the card.
      rows.push({
        k: 'checked',
        label: 'checked',
        value: tag.verified === null || tag.verified === undefined
          ? 'unrecorded'
          : `${tag.verified} times`,
        cls: tag.verified ? '' : 'warn',
      });
      rows.push({ k: 'settle', el: card.settle });
      // Asserted geometry, shown as such. This is the one number on the card
      // that was not measured, so it says which tag it was snapped to and how
      // far it was moved — a silent correction is indistinguishable from a
      // survey that happened to come out clean.
      if (tag.clippedTo !== null && tag.clippedTo !== undefined) {
        rows.push({
          k: 'clipped',
          label: 'clipped',
          value: `${tag.clippedMm ?? 0} mm / `
            + `${(tag.clippedDeg ?? 0).toFixed(1)}° onto tag ${tag.clippedTo}'s plane`,
        });
      }
    }
    rows.push({ k: 'live', el: card.live });
    return rows;
  }

  function paintTagCard(card, tag) {
    card.tag = tag;
    if (!card.isAnchor) {
      card.kind.textContent = `${tag.nObs} obs`;
      tag.p.forEach((v, k) => { card.axes[k].textContent = fmtSignedM(v); });
    }
    syncKeyed(card.lines, tagCardRows(card, tag), {
      key: (r) => r.k,
      make: (r) => r.el || document.createElement('div'),
      paint: (el, r) => {
        // A row painted from elsewhere carries its own value; this call only
        // decides where in the block it sits.
        if (r.el) return;
        el.dataset.kvLabel = r.label;
        el.dataset.kvValue = r.value;
        el.className = r.cls || '';
      },
    });
    if (!card.isAnchor) paintSettle(card.settle, card.dot, tag);
    // Re-padded as a whole: the colon column is the longest label on the card
    // and the set of rows just changed.
    layoutKv(card.lines);
    card.root.classList.toggle('hot', isHot('tag', tag.id));
    card.root.classList.toggle('open', tag.id === openTagId);
    // The record already in hand rather than the next poll: the charts are
    // drawn against *now* as their right edge, and a map message is as good a
    // moment as any to move it on.
    if (tag.id === openTagId) paintHistory(card);
  }

  // The rows are plain divs aligned by their own padding, so nesting them in a
  // container of their own costs nothing. Keyed by label: the state's own rows
  // change with it, and the ones both states carry are the same rows.
  function paintSettle(el, dot, tag) {
    const { rows, warn } = settleRows(tag);
    syncKeyed(el, rows, {
      key: ([label]) => label,
      make: () => document.createElement('div'),
      paint: (div, [label, value]) => {
        div.dataset.kvLabel = label;
        div.dataset.kvValue = value;
        div.className = warn ? 'warn' : '';
      },
    });
    // The state's own rows change with it — a tag going disputed grows a
    // `last check` — so the card is re-padded as a whole, not just here.
    layoutKv(el);
    dot.className = warn ? 'dot warn' : 'dot';
    dot.title = rows.map(([label, value]) => `${label}: ${value}`).join(' · ');
  }

  // The ages on the cards, moved on regardless of survey traffic. A tag that
  // has stopped being refined is exactly the one whose "nudged" figure matters,
  // and it is also the one no marker-map message will ever come back to.
  function paintTagsAges() {
    for (const card of tagCards.values()) {
      if (!card.isAnchor) paintSettle(card.settle, card.dot, card.tag);
      // The open card's charts are drawn against *now* as their right edge, so
      // they go stale on the same clock the ages do — a tag that stopped being
      // refined must be seen to trail off rather than ending at the edge.
      if (card.tag.id === openTagId) paintHistory(card);
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
      setKv(card.live, 'in view', seen ? seen.join(' · ') : 'no');
      card.live.className = seen ? 'room' : '';
      // Also on the card itself, because a collapsed one has no room for the
      // line: which tags are in view right now is what a survey is walked by.
      card.root.classList.toggle('seen', !!seen);
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

    // Told from outside, like the room views: one entity is hot across the
    // whole dashboard, and this only draws it — on whichever card family the
    // entity belongs to.
    setHovered(h) {
      hot = h;
      for (const [tagId, card] of tagCards) {
        card.root.classList.toggle('hot', isHot('tag', tagId));
      }
      for (const [id, card] of cards) {
        card.root.classList.toggle('hot', isHot('client', id));
      }
      for (const card of groupCards.values()) {
        if (card.clientId === null) continue;
        card.root.classList.toggle('hot', isHot('region', card.key));
      }
    },
    update(list, markerMap = null, landmarks = []) {
      buildGroups(landmarks);
      emptyEl.style.display = list.length ? 'none' : '';
      syncKeyed(clientsEl, list, {
        key: (info) => info.id,
        store: cards,
        make: (info) => buildCard(info.id),
        paint,
      });
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
      // The history poll rides this tick rather than a timer of its own, for the
      // same reason the ages do: nothing is asked for behind a closed drawer,
      // because a closed drawer never calls update().
      if (openTagId !== null && Math.abs(Date.now() - histAskedAt) >= HIST_POLL_MS) askHistory();
    },

    // The answer to askHistory(). Ignored unless it is about the card that is
    // open — a reply can be in flight when the reader moves to another tag, and
    // drawing it would put one tag's past on another tag's card.
    setTagHistory(msg) {
      if (msg.id !== openTagId) return;
      tagHist = { id: msg.id, samples: msg.samples || [], events: msg.events || [] };
      const card = tagCards.get(msg.id);
      if (card) paintHistory(card);
    },
  };
}
