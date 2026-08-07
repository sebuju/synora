'use strict';

// Shift is the way past the page's own gestures, on every page in the project.
//
// Held down, a click reaches nothing the page built: no card opens, no toggle
// flips, no mark is selected — and nothing calls preventDefault either, so what
// is left is whatever the browser itself would have done. Selecting the text
// under the pointer, opening a link in its own window, letting a wheel notch
// scroll the page: all of it is unreachable on a surface that treats every
// gesture as a control, and this hands it back without a modifier key of the
// page's own invention.
//
// One capture-phase listener rather than a test inside each of the several
// dozen handlers. A test that has to be remembered in every new handler is a
// test that will be missed, and the handlers it is missed in are exactly the
// ones that make the escape hatch untrustworthy — a hatch that works in most
// places is worse than none, because it is tried and then not believed.
//
// Loaded first on every page, before anything else registers: two capture
// listeners on the same target run in the order they were added, so being early
// is the whole of how this gets to answer first.
for (const type of ['click', 'dblclick', 'auxclick']) {
  // `stopImmediatePropagation` as well, or a handler bound to window itself —
  // the same target this is on — still sees the event.
  //
  // No preventDefault anywhere in here: leaving the default alone is the point.
  window.addEventListener(type, (ev) => {
    if (!ev.shiftKey) return;
    ev.stopPropagation();
    ev.stopImmediatePropagation();
  }, true);
}

// The same question, for a gesture assembled out of pointer events rather than
// delivered as a click — the room maps select on pointerup so that a press and
// a release can be told apart, and no `click` listener is involved to swallow.
// Asked through here rather than by reading `shiftKey` at each site, so what
// counts as a suppressed click has one answer.
function clickSkipped(ev) {
  return !!ev.shiftKey;
}

// preventDefault, unless shift is held — the other half of handing the gesture
// back. A wheel notch the page still swallows, or a context menu it still
// suppresses, is a hatch that only half opens.
//
// Returns whether the default was taken, so a handler can bail on the same
// test: `if (!noDefault(ev)) return;`.
//
// Events with no modifier state at all (a lost WebGL context, a media event)
// have `shiftKey` undefined, which is falsy, so they are unaffected. Those
// are not gestures and are left calling preventDefault directly.
function noDefault(ev) {
  if (ev.shiftKey) return false;
  ev.preventDefault();
  return true;
}
