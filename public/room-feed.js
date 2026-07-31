'use strict';

// The room views' data feed: the four server messages that describe the room,
// turned into renderer updates. One place, because the dashboard is no longer
// the only page that draws the room — the XR client renders the same top-down
// map from the same messages, and a second copy of this would drift from the
// first the moment either side gained a field.
//
// The views themselves stay pure renderers (scene.js, map2d.js): this decides
// nothing about how the room looks, only which setter each message reaches.

// The room views' uncertainty ring: where this client probably is, and how
// tightly, as the server measured it over its recent fixes. Both halves have
// the phone's own motion divided out (ARCore knows it exactly), so the ring
// describes the fix and not the walk — it does not swell just because the
// client is moving, and its centre does not trail a window behind them. The
// ring is the distribution, the dot is a single draw from it, and tying the
// ring to the dot made the steadier of the two inherit the jitter of the
// noisier.
//
// Only the XR path reports any of it (it needs the phone's own pose to separate
// real motion from fix noise), so anything else gets radius 0 and draws no ring
// rather than inventing one.
function poseUncertainty(msg) {
  const j = msg.room?.jitter;
  return { r: (j?.jitterMm ?? 0) / 1000, p: j?.centre ?? null };
}

function createRoomFeed(views) {
  let markerMap = null;

  return {
    // True if the message was a room message and has been applied. A page with
    // other uses for the same socket tests this and falls through.
    handle(msg) {
      if (msg.type === 'marker-map') {
        markerMap = msg;
        views.forEach((v) => v.setMarkerMap(msg));
        return true;
      }
      // Carved free space and wall segments. Optional chaining because only the
      // 2D views render them — the 3D scene opts out by not having the setter.
      if (msg.type === 'floor') {
        views.forEach((v) => v.setFloor?.(msg));
        return true;
      }
      if (msg.type === 'walls') {
        views.forEach((v) => v.setWalls?.(msg.walls));
        return true;
      }
      return false;
    },

    // Split out from handle(): a pose carries far more than the room views want
    // (camera-frame tags, timing, the client's own report), and the dashboard
    // reads the rest of it for the tile label.
    applyPose(clientId, msg) {
      if (!msg.room?.pose) return;
      const seen = (msg.tags || []).map((t) => t.id);
      views.forEach((v) =>
        v.updateClient(clientId, msg.room.pose, seen, poseUncertainty(msg)));
    },

    removeClient(clientId) {
      views.forEach((v) => v.removeClient(clientId));
    },

    // The last map as it arrived. Held here rather than beside each consumer:
    // the drawer's tag cards and the views must not be able to disagree about
    // which survey they are showing.
    getMarkerMap() {
      return markerMap;
    },
  };
}
