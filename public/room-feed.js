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
// A coarse-tier fix reports its own radius (`poseR`, metres) and has no jitter
// behind it — it is not an ARCore-carried pose at all, so there is no motion to
// divide out and no centre distinct from the dot. It is checked first because
// a frame that reaches the tier may still carry a stale jitter reading from
// before the survey lost the room, and that reading describes nothing here.
function poseUncertainty(msg) {
  const room = msg.room;
  if (room?.poseR != null) return { r: room.poseR, p: null };
  const j = room?.jitter;
  return { r: (j?.jitterMm ?? 0) / 1000, p: j?.centre ?? null };
}

function createRoomFeed(views) {
  let markerMap = null;
  let landmarks = [];
  // clientId -> the last *detection* message reported. See applyPose and
  // lastDetection (common.js).
  const lastDet = new Map();

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
      // The per-client landmark cloud. Sent whole, so a client whose landmarks were
      // dropped says so by appearing with fewer — the renderers replace rather
      // than merge.
      if (msg.type === 'landmarks') {
        landmarks = msg.clients;
        views.forEach((v) => v.setLandmarks?.(msg.clients));
        return true;
      }
      return false;
    },

    // Split out from handle(): a pose carries far more than the room views want
    // (camera-frame tags, timing, the client's own report), and the dashboard
    // reads the rest of it for the tile label.
    applyPose(clientId, msg) {
      if (!msg.room?.pose) return;
      // See lastDetection (common.js) for why a carry report cannot simply
      // overwrite what the last detection saw.
      const det = lastDetection(lastDet.get(clientId), msg);
      if (det) lastDet.set(clientId, det);
      const seen = (det?.tags || []).map((t) => t.id);
      // The whole room verdict rides along: a view that wants to say "this
      // pose is dead reckoning, not a fix" needs mapSafe/quality, and deriving
      // that here would be a second copy of a decision the survey already made.
      views.forEach((v) =>
        v.updateClient(clientId, msg.room.pose, seen, poseUncertainty(msg), msg.room));
    },

    removeClient(clientId) {
      lastDet.delete(clientId);
      views.forEach((v) => v.removeClient(clientId));
    },

    // The last map as it arrived. Held here rather than beside each consumer:
    // the drawer's tag cards and the views must not be able to disagree about
    // which survey they are showing.
    getMarkerMap() {
      return markerMap;
    },

    // The anchor clouds as they last arrived, for the drawer. Held here for the
    // same reason the marker map is: the views and the panel must not be able
    // to disagree about which collection they are showing.
    getLandmarks() {
      return landmarks;
    },
  };
}
