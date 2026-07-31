'use strict';

// 3D room view: surveyed markers and live client frusta, in the room frame the
// server's survey defines. Pure renderer: everything it shows arrives via the
// setters below.
//
// Conventions: room frame is the anchor tag's frame (x right, y up, z out of
// the wall). A client pose {p,q} maps camera coordinates (OpenCV: +z forward,
// +y down) into the room, so meshes built in that camera convention can take
// the quaternion as-is.

// Shared by the 3D scene and the 2D top-down map.
const ROOM_CLIENT_COLORS = [0x4dabf7, 0xffa94d, 0x69db7c, 0xff6b6b, 0xda77f2, 0xffe066];

// The one place a client's colour is picked. The 3D scene, the 2D maps, the
// roster overlay and the client drawer all key off the same id, and a client
// that reads as two different colours across them is worse than no colour.
function roomClientColor(id) {
  return ROOM_CLIENT_COLORS[id % ROOM_CLIENT_COLORS.length];
}

function roomClientColorCss(id) {
  return `#${roomClientColor(id).toString(16).padStart(6, '0')}`;
}

// Room axes, indexed the way a position is: x, y, z. Near three.js's own
// AxesHelper defaults, and the helper below is told them explicitly rather than
// left on its defaults — the 2D views and the drawer read the same three
// numbers, and an axis that is red in one view and blue in another is worse
// than no colour at all. `ROOM_AXIS_LEN_M` is the helper's length, so the 2D
// cross is the same size as the 3D one and reads as the same object.
// x and z are pulled off their pure primaries: #0000ff is the darkest colour a
// screen can make and #ff0000 the most saturated, and the ordinates printed in
// them were, respectively, unreadable and glaring on the drawer's near-black
// card. Softened, not re-hued, so they stay the red and blue axes everywhere.
const ROOM_AXIS_COLORS = [0xe05c5c, 0x00ff00, 0x4a90d9];
const ROOM_AXIS_NAMES = ['x', 'y', 'z'];
const ROOM_AXIS_LEN_M = 0.5;

function roomAxisColorCss(k) {
  return `#${ROOM_AXIS_COLORS[k].toString(16).padStart(6, '0')}`;
}

// Stable, distinctive colour per tag id — the golden-angle hue walk keeps any
// two ids that appear together visually far apart. Shared by every view that
// labels tags, so tag 3 is the same colour everywhere.
function roomTagColorCss(id) {
  return `hsl(${(id * 137.5) % 360}, 62%, 40%)`;
}
const ROOM_POSE_STALE_MS = 2000;

// Green head-on sliding to red as the view of a tag gets oblique — pose
// quality falls off hard past ~60°.
function roomAngleColor(angleDeg) {
  const badness = Math.min(1, Math.max(0, angleDeg / 75));
  return `hsl(${Math.round(120 * (1 - badness))}, 85%, 55%)`;
}

function createSceneView(canvas) {
  const CLIENT_COLORS = ROOM_CLIENT_COLORS;
  const POSE_STALE_MS = ROOM_POSE_STALE_MS;
  const SMOOTH_TAU_MS = 120;
  // The reported pose is a point; the fix is not. The ring is the measured
  // spread of the last window of fixes, so it shrinks when the geometry is good
  // and swells when it is not — drawing a bare point implies a precision that
  // does not exist. 2x the rms spread contains the large majority of the
  // samples; the rms alone reads far tighter than the thing actually is.
  const UNCERTAINTY_SIGMA = 2;
  // The radius is itself a measurement, so it is smoothed too — an unsmoothed
  // ring pulses every window and reads as instability that is not there.
  const RADIUS_TAU_MS = 400;
  const RADIUS_MIN_M = 0.02;
  const FLOOR_Y = -1.5;         // tags mount roughly at eye height; cosmetic only

  let three = null;             // lazy — no WebGL context until first activation
  let active = false;
  // On: the frustum sits at the reported pose. Off (default): it parks on the
  // uncertainty ring's centre — still showing direction, but anchored on the
  // steadier claim and moving on the ring's slow clock.
  let showPose = false;
  let markerMapPending = null;
  const clients = new Map();     // clientId -> { group, cone, label, target, at, colorHex }

  // Billboard text that can be rewritten cheaply; set() no-ops on unchanged
  // text so it is safe to call every frame.
  function makeTextSprite(text, color, scale = 1) {
    const cnv = document.createElement('canvas');
    cnv.width = 512;
    cnv.height = 64;
    const c = cnv.getContext('2d');
    const texture = new THREE.CanvasTexture(cnv);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.scale.set(1.6 * scale, 0.2 * scale, 1);
    let current = null;
    let currentColor = null;
    const label = {
      sprite,
      set(next, nextColor = color) {
        if (next === current && nextColor === currentColor) return;
        current = next;
        currentColor = nextColor;
        c.clearRect(0, 0, 512, 64);
        c.font = 'bold 36px system-ui, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = nextColor;
        c.fillText(next, 256, 32);
        texture.needsUpdate = true;
      },
      dispose() {
        texture.dispose();
        sprite.material.dispose();
      },
    };
    label.set(text);
    return label;
  }

  function init() {
    if (three) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x181818);
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 100);
    camera.position.set(4, 2.5, 7);
    const controls = new THREE.OrbitControls(camera, canvas);
    controls.target.set(1.5, 0, 2);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5);
    sun.position.set(3, 6, 4);
    scene.add(sun);

    const grid = new THREE.GridHelper(20, 40, 0x3a3a3a, 0x242424);
    grid.position.y = FLOOR_Y;
    scene.add(grid);
    const axes = new THREE.AxesHelper(ROOM_AXIS_LEN_M);
    axes.setColors(...ROOM_AXIS_COLORS.map((c) => new THREE.Color(c)));
    scene.add(axes);

    const markerGroup = new THREE.Group();
    scene.add(markerGroup);


    three = { renderer, scene, camera, controls, markerGroup };

    // Clients whose poses arrived before the 3D view was first opened already
    // have groups — they were parked outside any scene until now.
    for (const ph of clients.values()) {
      scene.add(ph.group, ph.tagLines, ph.ring);
      for (const label of ph.distLabels.values()) scene.add(label.sprite);
    }
  }


  // id -> { pos: Vector3, normal: Vector3 } for the client→tag lines.
  const markerInfo = new Map();

  function rebuildMarkers(map) {
    const group = three.markerGroup;
    while (group.children.length) {
      const child = group.children.pop();
      child.traverse?.((o) => {
        o.geometry?.dispose();
        o.material?.map?.dispose();
        o.material?.dispose();
      });
      group.remove(child);
    }
    markerInfo.clear();
    if (!map) return;
    const size = map.sizeM || 0.15;
    for (const m of map.markers) {
      const holder = new THREE.Group();
      holder.position.set(...m.p);
      holder.quaternion.set(...m.q);
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ color: m.id === map.anchorId ? 0xd4b34c : 0xcccccc, side: THREE.DoubleSide }));
      const label = makeTextSprite(String(m.id), '#eee');
      label.sprite.position.set(0, size * 1.2, 0);
      holder.add(quad, label.sprite);
      group.add(holder);
      markerInfo.set(m.id, {
        pos: new THREE.Vector3(...m.p),
        normal: new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...m.q)),
      });
    }
  }

  function ensureClient(clientId) {
    let ph = clients.get(clientId);
    if (ph) return ph;
    const colorHex = CLIENT_COLORS[clientId % CLIENT_COLORS.length];
    const group = new THREE.Group();
    // Camera frustum wireframe in OpenCV camera axes: apex at the camera,
    // opening toward +z, wider than tall, a tick marking up (-y).
    const w = 0.24, h = 0.18, d = 0.3;
    const pts = [
      [0, 0, 0], [-w, -h, d], [0, 0, 0], [w, -h, d],
      [0, 0, 0], [-w, h, d], [0, 0, 0], [w, h, d],
      [-w, -h, d], [w, -h, d], [w, -h, d], [w, h, d],
      [w, h, d], [-w, h, d], [-w, h, d], [-w, -h, d],
      [0, -h, d], [0, -h * 1.5, d],   // up-tick (camera -y is up)
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(
      pts.map((p) => new THREE.Vector3(...p)));
    const cone = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: colorHex }));
    const colorCss = `#${colorHex.toString(16).padStart(6, '0')}`;
    const label = makeTextSprite(`C${clientId}`, colorCss);
    label.sprite.position.set(0, 0.25, 0);
    group.add(cone, label.sprite);
    group.visible = false;

    // Uncertainty ring, horizontal, drawn at the client's own height. Built at
    // unit radius once and scaled per frame — rebuilding the geometry to resize
    // it would allocate every frame.
    const ringGeo = new THREE.RingGeometry(0.97, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
      depthWrite: false,
    }));
    ring.visible = false;

    // Lines to the tags this client currently sees. Positions are rewritten
    // every frame from the smoothed client position; the labels ride midway.
    const tagLineGeo = new THREE.BufferGeometry();
    tagLineGeo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(ROOM_LINE_MAX * 2 * 3), 3));
    const tagLines = new THREE.LineSegments(tagLineGeo,
      new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.5 }));
    tagLines.frustumCulled = false;
    tagLines.visible = false;

    three?.scene.add(group, tagLines, ring);
    ph = {
      id: clientId, group, cone, label, tagLines, ring, colorCss,
      distLabels: new Map(),      // tag id -> text sprite at the line midpoint
      seenTags: [],
      target: null, at: 0, colorHex, lastDraw: 0,
      uncertaintyM: 0, shownRadius: 0,
      ringTarget: null, ringAt: new THREE.Vector3(), ringSeeded: false,
    };
    clients.set(clientId, ph);
    return ph;
  }

  const ROOM_LINE_MAX = 16;

  // Lines + midpoint labels from a client to every mapped tag it is seeing:
  // distance, and how obliquely the tag is being viewed (0° = straight on —
  // pose quality falls off past ~60°).
  function updateTagLines(ph) {
    const stale = performance.now() - ph.at > POSE_STALE_MS;
    const seen = stale ? [] : ph.seenTags.filter((id) => markerInfo.has(id));
    const posAttr = ph.tagLines.geometry.getAttribute('position');
    const from = ph.group.position;
    const active = new Set();
    seen.slice(0, ROOM_LINE_MAX).forEach((id, i) => {
      const info = markerInfo.get(id);
      posAttr.setXYZ(i * 2, from.x, from.y, from.z);
      posAttr.setXYZ(i * 2 + 1, info.pos.x, info.pos.y, info.pos.z);
      const toClient = new THREE.Vector3().subVectors(from, info.pos);
      const dist = toClient.length();
      const angle = toClient.lengthSq() > 1e-6
        ? THREE.MathUtils.radToDeg(info.normal.angleTo(toClient.normalize()))
        : 0;
      let label = ph.distLabels.get(id);
      if (!label) {
        label = makeTextSprite('', ph.colorCss, 0.8);
        three.scene.add(label.sprite);
        ph.distLabels.set(id, label);
      }
      label.set(`${dist.toFixed(2)} m · ${Math.round(angle)}°`, roomAngleColor(angle));
      label.sprite.position.copy(from).add(info.pos).multiplyScalar(0.5);
      label.sprite.visible = true;
      active.add(id);
    });
    for (const [id, label] of ph.distLabels) {
      if (!active.has(id)) {
        three.scene.remove(label.sprite);
        label.dispose();
        ph.distLabels.delete(id);
      }
    }
    posAttr.needsUpdate = true;
    ph.tagLines.geometry.setDrawRange(0, seen.length * 2);
    ph.tagLines.visible = seen.length > 0;
  }

  let rafPending = false;
  let lastFrameAt = 0;

  function draw(now) {
    rafPending = false;
    if (!active) return;
    const dt = lastFrameAt ? now - lastFrameAt : 16;
    lastFrameAt = now;

    // Match the canvas backing store to its CSS size (the pane resizes with
    // the window).
    const wpx = canvas.clientWidth * window.devicePixelRatio;
    if (canvas.width !== Math.floor(wpx) || three.camera.aspect !== canvas.clientWidth / canvas.clientHeight) {
      three.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      three.camera.aspect = canvas.clientWidth / canvas.clientHeight;
      three.camera.updateProjectionMatrix();
    }

    const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
    for (const ph of clients.values()) {
      if (!ph.target) continue;
      ph.group.visible = true;
      ph.group.quaternion.slerp(ph.targetQuat, alpha);
      // Stale pose: keep the last position but say so with a grey cone.
      const stale = performance.now() - ph.at > POSE_STALE_MS;
      ph.cone.material.color.setHex(stale ? 0x555555 : ph.colorHex);

      const wantR = ph.uncertaintyM * UNCERTAINTY_SIGMA;
      const rAlpha = 1 - Math.exp(-dt / RADIUS_TAU_MS);
      ph.shownRadius += (wantR - ph.shownRadius) * rAlpha;
      // Centre and radius are the same measurement and move on the same slow
      // clock — the ring chasing the dot's 120 ms lerp is exactly the coupling
      // this is here to break.
      if (ph.ringTarget) {
        if (!ph.ringSeeded) {
          ph.ringAt.set(...ph.ringTarget);   // don't fly in from the origin
          ph.ringSeeded = true;
        } else {
          ph.ringAt.x += (ph.ringTarget[0] - ph.ringAt.x) * rAlpha;
          ph.ringAt.y += (ph.ringTarget[1] - ph.ringAt.y) * rAlpha;
          ph.ringAt.z += (ph.ringTarget[2] - ph.ringAt.z) * rAlpha;
        }
      }
      // Positioned after the ring update so the parked frustum tracks this
      // frame's centre, not the last one's.
      if (showPose || !ph.ringSeeded) ph.group.position.lerp(ph.targetPos, alpha);
      else ph.group.position.copy(ph.ringAt);
      const p = ph.group.position;
      ph.label.set(`C${ph.id} · ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`);
      ph.ring.visible = ph.shownRadius > RADIUS_MIN_M;
      if (ph.ring.visible) {
        ph.ring.position.copy(ph.ringAt);
        ph.ring.scale.set(ph.shownRadius, 1, ph.shownRadius);
        ph.ring.material.color.setHex(stale ? 0x555555 : ph.colorHex);
      }
      updateTagLines(ph);
    }

    three.controls.update();
    three.renderer.render(three.scene, three.camera);
    scheduleDraw();
  }

  function scheduleDraw() {
    if (!rafPending && active) {
      rafPending = true;
      requestAnimationFrame(draw);
    }
  }

  return {
    setActive(on) {
      active = on;
      if (on) {
        init();
        if (markerMapPending !== null) {
          rebuildMarkers(markerMapPending);
          markerMapPending = null;
        }
        lastFrameAt = 0;
        scheduleDraw();
      }
    },

    setMarkerMap(map) {
      if (three) rebuildMarkers(map);
      else markerMapPending = map;
    },

    setShowPose(on) {
      showPose = on;
    },


    updateClient(clientId, pose, seenTagIds = [], uncertainty = null) {
      const ph = ensureClient(clientId);
      ph.uncertaintyM = uncertainty?.r ?? 0;
      // No centre reported (no jitter window yet, or a non-XR client): fall back
      // to the pose so the ring is at worst where it used to be.
      ph.ringTarget = uncertainty?.p ?? pose.p;
      ph.target = pose;
      ph.targetPos = new THREE.Vector3(...pose.p);
      ph.targetQuat = new THREE.Quaternion(...pose.q);
      ph.seenTags = seenTagIds;
      ph.at = performance.now();
      // First fix snaps into place rather than flying in from the origin.
      if (!ph.group.visible) {
        ph.group.position.copy(ph.targetPos);
        ph.group.quaternion.copy(ph.targetQuat);
      }
    },

    removeClient(clientId) {
      const ph = clients.get(clientId);
      if (!ph) return;
      three?.scene.remove(ph.group, ph.tagLines, ph.ring);
      ph.ring.geometry.dispose();
      ph.ring.material.dispose();
      ph.cone.geometry.dispose();
      ph.cone.material.dispose();
      ph.label.dispose();
      ph.tagLines.geometry.dispose();
      ph.tagLines.material.dispose();
      for (const label of ph.distLabels.values()) {
        three?.scene.remove(label.sprite);
        label.dispose();
      }
      clients.delete(clientId);
    },

  };
}
