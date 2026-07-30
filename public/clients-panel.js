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

function createClientsPanel(el, { onControl, onVcam, onRename }) {
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
      out.push(`NO ARCORE TRACK ${(info.lostMs / 1000).toFixed(0)}s — tags only`);
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
  const tagCards = new Map();   // tag id -> { root, live }
  let tagsFrom = null;

  function buildTags(markerMap) {
    // Rebuilt only when the map object changes — it is replaced wholesale by
    // every marker-map message and this panel repaints four times a second.
    if (tagsFrom === markerMap) return;
    tagsFrom = markerMap;
    tagsEl.replaceChildren();
    tagCards.clear();
    for (const tag of [...(markerMap?.markers || [])].sort((a, b) => a.id - b.id)) {
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
      kind.textContent = tag.id === markerMap.anchorId
        ? 'anchor · room origin'
        : `${tag.nObs} obs`;
      head.append(name, kind);

      const lines = document.createElement('div');
      lines.className = 'lines';
      // Each ordinate in its own axis colour, the same three the 3D helper and
      // the 2D crosses use. Three bare numbers on a line give no clue which is
      // the height, and height is the one that exposes a tilted room frame.
      const at = document.createElement('div');
      at.append('at ');
      tag.p.forEach((v, k) => {
        const span = document.createElement('span');
        span.style.color = roomAxisColorCss(k);
        span.textContent = v.toFixed(2);
        at.append(span, k < 2 ? ', ' : '');
      });
      // Which way the tag faces, in the same yaw/pitch convention the client
      // rows use. A tag mounted a few degrees off is invisible in its position
      // but is exactly what a mirror-flipped sighting leaves behind.
      const n = quatRotate(tag.q, [0, 0, 1]);
      const yaw = Math.atan2(n[0], n[2]) * 180 / Math.PI;
      const pitch = Math.asin(Math.max(-1, Math.min(1, n[1]))) * 180 / Math.PI;
      const facing = document.createElement('div');
      facing.textContent = `faces yaw ${Math.round(yaw)}° · pitch ${Math.round(pitch)}°`;
      // What placed this tag and how far that is from the datum. A position
      // alone cannot say whether a tag carries the anchor's error once or three
      // times over, and the deepest-chained tag is usually the one that looks
      // wrong. Parents are ordered by how much of the placing each one did.
      const via = document.createElement('div');
      if (tag.id === markerMap.anchorId) {
        via.textContent = 'measured against nothing';
      } else if (tag.from?.length) {
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
      // Whether the tag is still moving, and by how much it wants to. Without
      // this the survey is a black box: a tag healing ten degrees over ten
      // minutes and a tag frozen at the wrong orientation look identical, which
      // is exactly how a stuck one went unnoticed. `resid` is what refinement is
      // still being told to correct, not what it has corrected.
      const settle = document.createElement('div');
      if (tag.id === markerMap.anchorId) {
        // The anchor is the room frame, not a measurement of it. It is pinned at
        // the origin by definition and there is nothing it could be refined
        // against — saying "never refined" about it reads as a fault when it is
        // the one tag for which that is the correct and only possible state.
        settle.textContent = 'fixed at the origin — the frame everything else is measured in';
      } else if (tag.refinedAtMs) {
        const mm = Math.round((tag.resid ?? 0) * 1000);
        const deg = (tag.residDeg ?? 0).toFixed(1);
        const age = Date.now() - tag.refinedAtMs;
        const settled = mm <= 5 && (tag.residDeg ?? 0) <= 1;
        settle.textContent = (settled ? 'settled' : 'settling')
          + ` · off by ${mm} mm · ${deg}° · nudged ${fmtAge(age)}`;
        if (!settled) settle.className = 'warn';
      } else if (tag.checkedAtMs) {
        // It has been seen beside a known tag — every check just landed too far
        // away to average toward (past the reseed threshold refinement refuses,
        // by design). Saying "needs another known tag in the same frame" here
        // is false and sends whoever is holding the phone hunting the wrong
        // problem: the tag is mis-placed, not unobserved.
        const mm = Math.round((tag.checkOff ?? 0) * 1000);
        settle.textContent = `disputed — checks land ${mm} mm away `
          + `(last ${fmtAge(Date.now() - tag.checkedAtMs)} ago): too far to refine, `
          + 'will drop and re-survey once enough witnesses agree';
        settle.className = 'warn';
      } else {
        // Refinement needs two known tags in one frame, and a tag that is never
        // seen beside another one is never corrected however long it is watched.
        settle.textContent = 'never refined — needs another known tag in the same frame';
        settle.className = 'warn';
      }
      // Asserted geometry, shown as such. This is the one number on the card
      // that was not measured, so it says which tag it was snapped to and how
      // far it was moved — a silent correction is indistinguishable from a
      // survey that happened to come out clean.
      const clip = document.createElement('div');
      if (tag.clippedTo !== null && tag.clippedTo !== undefined) {
        clip.textContent = `clipped ${tag.clippedMm ?? 0} mm and `
          + `${(tag.clippedDeg ?? 0).toFixed(1)}° onto tag ${tag.clippedTo}'s plane`;
      }
      const live = document.createElement('div');
      lines.append(at, facing, via, settle, clip, live);

      root.append(head, lines);
      tagsEl.append(root);
      tagCards.set(tag.id, { root, live });
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
  el.append(emptyEl);
  // Clients are updated in place, so they need a container of their own or a
  // client connecting after the map arrived would be appended below the tags.
  const clientsEl = document.createElement('div');
  const tagsEl = document.createElement('div');
  el.append(clientsEl, tagsEl);

  return {
    setActive(on) {
      el.classList.toggle('active', on);
    },
    update(list, markerMap = null) {
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
      buildTags(markerMap);
      paintTagsLive(list);
    },
  };
}
