'use strict';

// 3D room view: surveyed markers, live client frusta, and (once mapping runs)
// the voxel map — all in the room frame the server's survey defines. Pure
// renderer: everything it shows arrives via the setters below.
//
// Conventions: room frame is the anchor tag's frame (x right, y up, z out of
// the wall). A client pose {p,q} maps camera coordinates (OpenCV: +z forward,
// +y down) into the room, so meshes built in that camera convention can take
// the quaternion as-is.

// Shared by the 3D scene and the 2D top-down map.
const ROOM_CLIENT_COLORS = [0x4dabf7, 0xffa94d, 0x69db7c, 0xff6b6b, 0xda77f2, 0xffe066];
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
  const FLOOR_Y = -1.5;         // tags mount roughly at eye height; cosmetic only

  let three = null;             // lazy — no WebGL context until first activation
  let active = false;
  let markerMapPending = null;
  let wallsPending = null;
  // Display-only, like the 2D views: hiding a layer must not stop it building.
  let showVoxels = true;
  let showWalls = true;
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
    scene.add(new THREE.AxesHelper(0.5));

    const markerGroup = new THREE.Group();
    scene.add(markerGroup);
    const wallGroup = new THREE.Group();
    scene.add(wallGroup);

    // Voxel map: one InstancedMesh, grown by doubling; freed slots are filled
    // by swap-remove so the draw range stays dense.
    const voxelState = {
      mesh: null,
      capacity: 0,
      count: 0,
      sizeM: 0.075,
      indexByKey: new Map(),
      keyByIndex: [],
    };

    three = { renderer, scene, camera, controls, markerGroup, wallGroup, voxelState };

    // Clients whose poses arrived before the 3D view was first opened already
    // have groups — they were parked outside any scene until now.
    for (const ph of clients.values()) {
      scene.add(ph.group, ph.tagLines);
      for (const label of ph.distLabels.values()) scene.add(label.sprite);
    }
  }

  function keyOf(v) {
    return `${v[0]},${v[1]},${v[2]}`;
  }

  function growVoxels(minCapacity) {
    const vs = three.voxelState;
    if (vs.mesh) vs.mesh.visible = showVoxels;
    const capacity = Math.max(4096, vs.capacity * 2, minCapacity);
    const geo = new THREE.BoxGeometry(vs.sizeM, vs.sizeM, vs.sizeM);
    const mat = new THREE.MeshLambertMaterial({ color: 0x7fb8a4 });
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.Matrix4();
    for (let i = 0; i < vs.count; i++) {
      vs.mesh.getMatrixAt(i, m);
      mesh.setMatrixAt(i, m);
    }
    mesh.count = vs.count;
    if (vs.mesh) {
      three.scene.remove(vs.mesh);
      vs.mesh.geometry.dispose();
      vs.mesh.material.dispose();
    }
    three.scene.add(mesh);
    vs.mesh = mesh;
    vs.capacity = capacity;
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

  // Wall layer: translucent quads for the server's fitted room-shell
  // segments. Walls change on the order of seconds, so a full rebuild per
  // update is fine.
  function rebuildWalls(walls) {
    const group = three.wallGroup;
    while (group.children.length) {
      const child = group.children.pop();
      child.geometry?.dispose();
      child.material?.dispose();
      group.remove(child);
    }
    for (const wl of walls) {
      const dx = wl.b[0] - wl.a[0];
      const dz = wl.b[1] - wl.a[1];
      const len = Math.hypot(dx, dz);
      if (!len) continue;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(len, wl.y1 - wl.y0),
        new THREE.MeshBasicMaterial({
          color: 0x8fa8b8, transparent: true, opacity: 0.22,
          side: THREE.DoubleSide, depthWrite: false,
        }));
      mesh.position.set(
        (wl.a[0] + wl.b[0]) / 2, (wl.y0 + wl.y1) / 2, (wl.a[1] + wl.b[1]) / 2);
      // Rotating +x by θ about y lands on (cosθ, 0, -sinθ) — solve for the
      // segment direction in the floor plane.
      mesh.rotation.y = Math.atan2(-dz, dx);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: 0xaec6d4 }));
      edges.position.copy(mesh.position);
      edges.rotation.copy(mesh.rotation);
      group.add(mesh, edges);
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

    // Lines to the tags this client currently sees. Positions are rewritten
    // every frame from the smoothed client position; the labels ride midway.
    const tagLineGeo = new THREE.BufferGeometry();
    tagLineGeo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(ROOM_LINE_MAX * 2 * 3), 3));
    const tagLines = new THREE.LineSegments(tagLineGeo,
      new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.5 }));
    tagLines.frustumCulled = false;
    tagLines.visible = false;

    three?.scene.add(group, tagLines);
    ph = {
      id: clientId, group, cone, label, tagLines, colorCss,
      distLabels: new Map(),      // tag id -> text sprite at the line midpoint
      seenTags: [],
      target: null, at: 0, colorHex, lastDraw: 0,
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
      ph.group.position.lerp(ph.targetPos, alpha);
      ph.group.quaternion.slerp(ph.targetQuat, alpha);
      // Stale pose: keep the last position but say so with a grey cone.
      const stale = performance.now() - ph.at > POSE_STALE_MS;
      ph.cone.material.color.setHex(stale ? 0x555555 : ph.colorHex);
      const p = ph.group.position;
      ph.label.set(`C${ph.id} · ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`);
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
        if (wallsPending !== null) {
          rebuildWalls(wallsPending);
          wallsPending = null;
        }
        lastFrameAt = 0;
        scheduleDraw();
      }
    },

    setMarkerMap(map) {
      if (three) rebuildMarkers(map);
      else markerMapPending = map;
    },

    setLayer(name, on) {
      if (name === 'voxels') showVoxels = on;
      else if (name === 'walls') showWalls = on;
      if (!three) return;
      three.wallGroup.visible = showWalls;
      if (three.voxelState?.mesh) three.voxelState.mesh.visible = showVoxels;
    },

    setWalls(walls) {
      if (three) rebuildWalls(walls || []);
      else wallsPending = walls || [];
    },

    updateClient(clientId, pose, seenTagIds = []) {
      const ph = ensureClient(clientId);
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
      three?.scene.remove(ph.group, ph.tagLines);
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

    // Incremental voxel updates from the mapping worker. reset drops
    // everything (new snapshot incoming).
    applyVoxels({ voxelSizeM, added = [], removed = [], reset = false }) {
      init();
      const vs = three.voxelState;
      if (reset || (voxelSizeM && voxelSizeM !== vs.sizeM)) {
        vs.indexByKey.clear();
        vs.keyByIndex = [];
        vs.count = 0;
        vs.sizeM = voxelSizeM || vs.sizeM;
        if (vs.mesh) {
          three.scene.remove(vs.mesh);
          vs.mesh.geometry.dispose();
          vs.mesh.material.dispose();
          vs.mesh = null;
          vs.capacity = 0;
        }
      }
      if (added.length + vs.count > vs.capacity) growVoxels(added.length + vs.count);
      const m = new THREE.Matrix4();
      for (const v of added) {
        const key = keyOf(v);
        if (vs.indexByKey.has(key)) continue;
        const idx = vs.count++;
        vs.indexByKey.set(key, idx);
        vs.keyByIndex[idx] = key;
        m.makeTranslation(v[0], v[1], v[2]);
        vs.mesh.setMatrixAt(idx, m);
      }
      for (const v of removed) {
        const key = keyOf(v);
        const idx = vs.indexByKey.get(key);
        if (idx === undefined) continue;
        const lastIdx = --vs.count;
        const lastKey = vs.keyByIndex[lastIdx];
        if (idx !== lastIdx) {
          vs.mesh.getMatrixAt(lastIdx, m);
          vs.mesh.setMatrixAt(idx, m);
          vs.indexByKey.set(lastKey, idx);
          vs.keyByIndex[idx] = lastKey;
        }
        vs.indexByKey.delete(key);
        vs.keyByIndex.length = vs.count;
      }
      if (vs.mesh) {
        vs.mesh.count = vs.count;
        vs.mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
