'use strict';

// The dashboard's drawer columns, and the one gesture that rearranges them.
//
// A drawer is not a place — it is however many panels currently sit next to
// each other. There is no main drawer and no fixed set: walking the last panel
// out of a column destroys it, walking one off either end opens a new one. That
// is the whole model, and everything here follows from it. What this owns is
// the arrangement; what a panel *is* stays with whoever built it.
//
// Nothing is ever recreated. A panel's root and its toggle button are the same
// elements from page load to reload, re-parented between columns — a rebuilt
// composite canvas would go black mid-frame, and a rebuilt button would lose
// the handler and the viewToggles entry that make it a toggle at all.
//
// A pure renderer, like clients-panel.js and objects-panel.js: it is told the
// arrangement, it reports a change back through onChange, and it stores
// nothing. Persistence is the caller's, because the caller is the one that
// already owns a storage key and the rules for reading a stale one.

// `items` is [{ key, el, btn, name, shown }] — a stable key, the panel's single
// root, the button that shows or hides it, a word for it, and a read of whether
// it is currently shown. The button travels with the panel: a column shows the
// toggles for what it holds and nothing else, which is what makes a column of
// one readable rather than a row of six buttons repeated three times. `shown`
// is read, never set — whether a panel is on belongs to the caller, and all
// this does with the answer is name it in the row and decide whether the column
// has anything in it worth reserving width for.
function createDrawerLayout(mainEl, items, { onChange } = {}) {
  const byKey = new Map(items.map((it) => [it.key, it]));

  // The columns live in a flex row of their own rather than as siblings of the
  // stage. Two reasons: orderChildren works from the *front* of a parent, which
  // would put the drawers ahead of the stage, and with the stage away the
  // columns have to divide one box between them rather than each argue with it.
  const host = document.createElement('div');
  host.id = 'drawers';
  mainEl.append(host);

  let layout = [];        // array of arrays of keys, left to right
  let active = false;
  let inert = false;

  // One wrapper per panel, built once and moved with it. It carries the toggle
  // and the two arrows; the arrows are revealed by hovering the wrapper, so
  // they have to be inside the thing being hovered or the pointer would lose
  // them on the way down. See the .tool rules in style.css.
  const tools = new Map(items.map((it) => [it.key, buildTool(it)]));

  function arrow(key, dir, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn mini';
    b.title = title;
    b.setAttribute('aria-label', title);
    // A bare chevron: at 12px anything with more than one stroke in it closes
    // up, and these two are only ever read as a pair pointing apart.
    const d = dir < 0 ? 'M14.5 5.5L8 12l6.5 6.5' : 'M9.5 5.5L16 12l-6.5 6.5';
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"'
      + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
    // The key is fixed for the life of the button; which column it is in is
    // not, and is looked up at the moment of the click rather than held here.
    b.onclick = () => move(key, dir);
    return b;
  }

  function buildTool(it) {
    const root = document.createElement('span');
    root.className = 'tool';
    const flyout = document.createElement('span');
    flyout.className = 'move';
    const left = arrow(it.key, -1, 'Move to the drawer on the left');
    const right = arrow(it.key, 1, 'Move to the drawer on the right');
    flyout.append(left, right);
    root.append(it.btn, flyout);
    return { root, left, right };
  }

  // Walking a panel one column over. The two ends are the interesting case: a
  // panel with nowhere to go that way opens a column there, unless it is the
  // only thing in the column it would be leaving — that move would destroy one
  // column to build an identical one, so it is refused rather than performed
  // invisibly (the arrow is disabled for it too, in apply).
  //
  // Where it lands is not arbitrary either: moving left it joins the end of the
  // column on the left and moving right it joins the start of the one on the
  // right, so a panel always arrives next to the edge it crossed rather than at
  // the far side of its new column.
  function move(key, dir) {
    const from = layout.find((d) => d.includes(key));
    if (!from) return;
    const i = layout.indexOf(from);
    const alone = from.length === 1;
    let to;
    if (dir < 0) {
      if (i === 0) {
        if (alone) return;
        to = [];
        layout.unshift(to);
      } else to = layout[i - 1];
    } else {
      if (i === layout.length - 1) {
        if (alone) return;
        to = [];
        layout.push(to);
      } else to = layout[i + 1];
    }
    from.splice(from.indexOf(key), 1);
    if (dir < 0) to.push(key);
    else to.unshift(key);
    // The column it left, if that was the last thing in it. A drawer is what is
    // in it; an empty one is not a drawer waiting to be filled.
    if (!from.length) layout.splice(layout.indexOf(from), 1);
    apply();
    onChange?.();
  }

  // Columns are keyed by position, not identity: they are interchangeable
  // boxes, and what moves between them is the panels. Keying by position is
  // what makes "the third column is gone" a removal of the third box rather
  // than a rebuild of all three.
  function apply() {
    syncKeyed(host, layout.map((keys, i) => ({ i, keys })), {
      key: (d) => d.i,
      make: () => {
        const root = document.createElement('div');
        root.className = 'drawer';
        const row = document.createElement('div');
        row.className = 'drawer-tools';
        // What this column is currently showing, in words, at the far end of
        // the row from the buttons. The buttons say it too — a lit one is a
        // panel that is on — but only for the column they are in and only if
        // you already know which glyph is which. Read across three columns of
        // icons, "Tags · Clients" is the answer to "where did the roster go".
        const names = document.createElement('span');
        names.className = 'names';
        row.append(names);
        return { root, row, names };
      },
      paint: (h, d) => {
        h.root.classList.toggle('active', active);
        const on = d.keys.filter((k) => byKey.get(k).shown?.());
        h.names.textContent = on.map((k) => byKey.get(k).name).join(' · ');
        // A column whose every panel is switched off is a tool row and nothing
        // else, and it should take the width of one rather than hold 380px of
        // empty background open. Reached on every refreshViews through
        // setActive, which is what re-runs this after a toggle.
        h.root.classList.toggle('empty', !on.length);
        h.root.inert = inert;
        orderChildren(h.row, [h.names, ...d.keys.map((k) => tools.get(k).root)], true);
        orderChildren(h.root, [h.row, ...d.keys.map((k) => byKey.get(k).el)], true);
      },
    });
    // An arrow that would do nothing is disabled rather than left to be
    // clicked: the only failing move is the one that would rebuild the column
    // it just emptied, and a control that silently declines is worse than one
    // that says it cannot.
    for (const [key, t] of tools) {
      const i = layout.findIndex((d) => d.includes(key));
      const alone = i >= 0 && layout[i].length === 1;
      t.left.disabled = i <= 0 && alone;
      t.right.disabled = i === layout.length - 1 && alone;
    }
  }

  return {
    // The arrangement, as the caller stored it or as it now stands. Plain
    // arrays both ways — the caller validates what it read from storage,
    // because it is the one that knows what a key meant last release.
    setLayout(next) {
      layout = next.map((d) => [...d]);
      apply();
    },
    getLayout() {
      return layout.map((d) => [...d]);
    },
    // Every column at once: the header's drawer button is one switch for all of
    // them, and a column that could be hidden on its own would be a column with
    // no way back — its toggles are inside it.
    setActive(on) {
      active = on;
      apply();
    },
    // Another dashboard took the viewer slot. Every control in every column
    // talks over a socket that is gone.
    setInert(on) {
      inert = on;
      apply();
    },
  };
}
