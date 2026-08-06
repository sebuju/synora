'use strict';

// 3D room view: surveyed markers and live client frusta, in the room frame the
// server's survey defines. Pure renderer: everything it shows arrives via the
// setters below.
//
// Conventions: room frame is the anchor tag's frame (x right, y up, z out of
// the wall). A client pose {p,q} maps camera coordinates (OpenCV: +z forward,
// +y down) into the room, so meshes built in that camera convention can take
// the quaternion as-is.

// The room palette (client/tag/axis colours) lives in common.js: this file is
// the only room view that needs three.js, and the 2D map is now rendered on the
// XR client too, which cannot load it.

function createSceneView(canvas) {
  const CLIENT_COLORS = ROOM_CLIENT_COLORS;
  const POSE_STALE_MS = ROOM_POSE_STALE_MS;
  // Motion clock shared with the 2D maps (anim.js) — the same client easing at
  // two different rates in two views of the same room reads as disagreement.
  const SMOOTH_TAU_MS = MOTION_TAU_MS;
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
  // Eased 0..1 toward showPose — see the anchor blend in draw().
  let poseMix = 0;
  let markerMapPending = null;
  // Where the wheel has asked the camera to be, in metres from the orbit
  // target. Only the wheel writes it: an orbit leaves the radius alone and a
  // pan moves camera and target together.
  let zoomTargetD = 0;
  const clients = new Map();     // clientId -> { group, cone, label, target, at, colorHex }
  const GREY = new THREE.Color(0x555555);
  const TAG_COLOR = new THREE.Color(0xcccccc);
  const ANCHOR_COLOR = new THREE.Color(ROOM_ANCHOR_COLOR_CSS);
  const HOVER_COLOR = new THREE.Color(0xffffff);
  // Pointer feedback, quicker than the other fades — matches map2d's HOVER_MS.
  const HOVER_MS = 120;
  // What the dashboard says the pointer is on ({ kind, id } | null).
  // Receive-only: there is no raycaster here and OrbitControls owns both drag
  // buttons, so this view lights up what it is told and reports nothing.
  let hovered = null;

  // Billboard text that can be rewritten cheaply; set() no-ops on unchanged
  // text so it is safe to call every frame.
  function makeTextSprite(text, color, scale = 1) {
    const cnv = document.createElement('canvas');
    cnv.width = 512;
    cnv.height = 64;
    const c = cnv.getContext('2d');
    const texture = new THREE.CanvasTexture(cnv);
    // Transparent because everything in this view fades in and out rather than
    // appearing and vanishing, and a sprite that ignores its opacity is the one
    // thing left popping.
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, depthTest: false, transparent: true,
    }));
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
    // OrbitControls damps orbit and pan but applies a dolly whole in the frame
    // the wheel arrives, so zoom is the one camera move that steps. The vendor
    // build is fetched, not checked in, so the notch is taken here instead: the
    // wheel moves a target distance and the camera eases onto it.
    controls.enableZoom = false;
    zoomTargetD = camera.position.distanceTo(controls.target);
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      // The vendor's own step, so the feel of a notch is unchanged.
      zoomTargetD = Math.max(0.3,
        Math.min(60, zoomTargetD * 0.95 ** -Math.sign(ev.deltaY)));
      scheduleDraw();
    }, { passive: false });

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


  // id -> the live tag, including the pos/normal the client→tag lines read.
  // Those are the *drawn* position and normal, updated every frame from the
  // eased holder: a line to where a tag is going to be leaves the tag behind.
  const markerInfo = new Map();

  function disposeMarker(holder) {
    holder.traverse?.((o) => {
      o.geometry?.dispose();
      o.material?.map?.dispose();
      o.material?.dispose();
    });
    three.markerGroup.remove(holder);
  }

  // Matched against what is on screen rather than rebuilt: the survey sends the
  // whole map on every change, and tearing the group down means a refined,
  // re-seeded or forgotten tag is a different picture on the next frame with
  // nothing tying it to the last one. Tags the map dropped fade out and are
  // disposed then, in draw().
  function syncMarkers(map) {
    const size = map?.sizeM || 0.15;
    const live = new Set();
    for (const m of map?.markers || []) {
      live.add(m.id);
      const anchor = m.id === map.anchorId;
      let info = markerInfo.get(m.id);
      if (!info) {
        const holder = new THREE.Group();
        holder.position.set(...m.p);
        holder.quaternion.set(...m.q);
        const quad = new THREE.Mesh(
          new THREE.PlaneGeometry(size, size),
          new THREE.MeshBasicMaterial({
            color: anchor ? ANCHOR_COLOR : TAG_COLOR, side: THREE.DoubleSide,
            transparent: true, opacity: 0,
          }));
        const label = makeTextSprite(String(m.id), '#eee');
        label.sprite.position.set(0, size * 1.2, 0);
        label.sprite.material.opacity = 0;
        holder.add(quad, label.sprite);
        three.markerGroup.add(holder);
        info = {
          holder, quad, label, size,
          pos: holder.position,
          normal: new THREE.Vector3(0, 0, 1).applyQuaternion(holder.quaternion),
          targetPos: new THREE.Vector3(), targetQuat: new THREE.Quaternion(),
          fade: 0, dead: false,
          // Seeded at the answer: a tag that arrives as the anchor is the
          // anchor, it did not become one.
          anchorMix: anchor ? 1 : 0,
        };
        markerInfo.set(m.id, info);
      } else if (info.size !== size) {
        // The map can only change tag size by being a different marker set, but
        // the quad is built from it and would otherwise keep the old one.
        info.quad.geometry.dispose();
        info.quad.geometry = new THREE.PlaneGeometry(size, size);
        info.label.sprite.position.set(0, size * 1.2, 0);
        info.size = size;
      }
      info.targetPos.set(...m.p);
      info.targetQuat.set(...m.q);
      info.anchor = anchor;
      info.dead = false;
    }
    for (const [id, info] of markerInfo) {
      if (!live.has(id)) info.dead = true;
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
    const cone = new THREE.LineSegments(geo,
      new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0 }));
    const colorCss = `#${colorHex.toString(16).padStart(6, '0')}`;
    const label = makeTextSprite(`C${clientId}`, colorCss);
    label.sprite.position.set(0, 0.25, 0);
    label.sprite.material.opacity = 0;
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
      // The pose anchor on its own clock, so the blend between it and the ring
      // is a blend of two smoothed points rather than of one smoothed and one
      // raw. `baseColor` is the client's colour to lerp the stale grey out of.
      smoothPos: new THREE.Vector3(),
      baseColor: new THREE.Color(colorHex),
      fade: 0, dead: false, staleMix: 0,
    };
    clients.set(clientId, ph);
    return ph;
  }

  function disposeClient(ph) {
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
    clients.delete(ph.id);
  }

  const ROOM_LINE_MAX = 16;

  // Lines + midpoint labels from a client to every mapped tag it is seeing:
  // distance, and how obliquely the tag is being viewed (0° = straight on —
  // pose quality falls off past ~60°).
  function updateTagLines(ph) {
    const stale = performance.now() - ph.at > POSE_STALE_MS;
    // A tag on its way out is not something the client is seeing: the line
    // would outlive the tag it points at.
    const seen = stale ? []
      : ph.seenTags.filter((id) => markerInfo.get(id) && !markerInfo.get(id).dead);
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
      label.sprite.material.opacity = ph.fade * info.fade;
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

    const alpha = animAlpha(dt, SMOOTH_TAU_MS);
    poseMix = animFade(poseMix, showPose, dt);

    // Tags glide and fade rather than being torn down and rebuilt.
    for (const [id, info] of markerInfo) {
      info.fade = animFade(info.fade, !info.dead, dt);
      if (info.dead && info.fade === 0) {
        disposeMarker(info.holder);
        markerInfo.delete(id);
        continue;
      }
      info.holder.position.lerp(info.targetPos, alpha);
      info.holder.quaternion.slerp(info.targetQuat, alpha);
      info.normal.set(0, 0, 1).applyQuaternion(info.holder.quaternion);
      // The anchor is the datum, and it changing is worth watching happen.
      info.anchorMix = animFade(info.anchorMix, info.anchor, dt);
      info.hot = animFade(info.hot ?? 0,
        hovered?.kind === 'tag' && id === hovered.id, dt, HOVER_MS);
      info.quad.material.color.copy(TAG_COLOR).lerp(ANCHOR_COLOR, info.anchorMix)
        .lerp(HOVER_COLOR, info.hot * 0.7);
      info.quad.material.opacity = info.fade;
      info.label.sprite.material.opacity = info.fade;
    }

    for (const ph of clients.values()) {
      ph.fade = animFade(ph.fade, !ph.dead, dt);
      if (ph.dead && ph.fade === 0) {
        disposeClient(ph);
        continue;
      }
      if (!ph.target) continue;
      ph.group.visible = true;
      ph.group.quaternion.slerp(ph.targetQuat, alpha);
      // Stale pose: keep the last position but say so with a grey cone — eased,
      // so the client going quiet is something that happens rather than a
      // different colour on one frame two seconds later.
      ph.staleMix = animFade(ph.staleMix,
        performance.now() - ph.at > POSE_STALE_MS, dt);
      ph.hot = animFade(ph.hot ?? 0,
        hovered?.kind === 'client' && ph.id === hovered.id, dt, HOVER_MS);
      ph.cone.material.color.copy(ph.baseColor).lerp(GREY, ph.staleMix)
        .lerp(HOVER_COLOR, ph.hot * 0.7);
      ph.cone.material.opacity = ph.fade;
      ph.label.sprite.material.opacity = ph.fade;
      ph.tagLines.material.opacity = ph.fade * 0.5;

      const wantR = ph.uncertaintyM * UNCERTAINTY_SIGMA;
      ph.shownRadius = animApproach(ph.shownRadius, wantR, dt, RADIUS_TAU_MS);
      // Centre and radius are the same measurement and move on the same slow
      // clock — the ring chasing the dot's 120 ms lerp is exactly the coupling
      // this is here to break.
      if (ph.ringTarget) {
        if (!ph.ringSeeded) {
          ph.ringAt.set(...ph.ringTarget);   // don't fly in from the origin
          ph.ringSeeded = true;
        } else {
          const rAlpha = animAlpha(dt, RADIUS_TAU_MS);
          ph.ringAt.x += (ph.ringTarget[0] - ph.ringAt.x) * rAlpha;
          ph.ringAt.y += (ph.ringTarget[1] - ph.ringAt.y) * rAlpha;
          ph.ringAt.z += (ph.ringTarget[2] - ph.ringAt.z) * rAlpha;
        }
      }
      // Positioned after the ring update so the parked frustum tracks this
      // frame's centre, not the last one's. The two anchors are metres apart
      // and the frustum, its label and every line off it hang on the result,
      // so the switch slides between them instead of teleporting. Each anchor
      // keeps its own clock — the pose's 120 ms, the ring's 400 ms — and only
      // the blend between them is new.
      ph.smoothPos.lerp(ph.targetPos, alpha);
      if (!ph.ringSeeded) ph.group.position.copy(ph.smoothPos);
      else ph.group.position.copy(ph.ringAt).lerp(ph.smoothPos, poseMix);
      const p = ph.group.position;
      ph.label.set(`C${ph.id} · ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`);
      // Faded rather than switched at the threshold: the ring is a measurement
      // shrinking, not a thing that stops existing at 2 cm.
      const ringAlpha = Math.min(1, Math.max(0,
        (ph.shownRadius - RADIUS_MIN_M) / RADIUS_MIN_M));
      ph.ring.visible = ringAlpha > 0.01;
      if (ph.ring.visible) {
        ph.ring.position.copy(ph.ringAt);
        ph.ring.scale.set(ph.shownRadius, 1, ph.shownRadius);
        ph.ring.material.color.copy(ph.baseColor).lerp(GREY, ph.staleMix)
          .lerp(HOVER_COLOR, ph.hot * 0.7);
        ph.ring.material.opacity = ph.fade * ringAlpha * 0.5;
      }
      updateTagLines(ph);
    }

    // The wheel moved a target distance; the camera arrives on the motion
    // clock. Before controls.update() so damping and this compose in one frame.
    const orbitTarget = three.controls.target;
    const d = three.camera.position.distanceTo(orbitTarget);
    if (d > 1e-3) {
      const want = animApproachGeo(d, zoomTargetD, dt, SMOOTH_TAU_MS);
      three.camera.position.sub(orbitTarget).multiplyScalar(want / d).add(orbitTarget);
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
    // { kind, id } | null — one entity hot across the whole dashboard.
    setHovered(h) {
      hovered = h;
      scheduleDraw();
    },
    setActive(on) {
      active = on;
      if (on) {
        init();
        if (markerMapPending !== null) {
          syncMarkers(markerMapPending);
          markerMapPending = null;
        }
        lastFrameAt = 0;
        scheduleDraw();
      }
    },

    setMarkerMap(map) {
      if (three) syncMarkers(map);
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
      // A client that comes back before its fade finished is the same client.
      ph.dead = false;
      // First fix snaps into place rather than flying in from the origin.
      if (!ph.group.visible) {
        ph.group.position.copy(ph.targetPos);
        ph.group.quaternion.copy(ph.targetQuat);
        ph.smoothPos.copy(ph.targetPos);
      }
    },

    // Faded out and disposed by draw() — see disposeClient. A client that has
    // never been drawn (no 3D view opened yet) has nothing to fade, so it goes
    // straight out rather than waiting for a loop that is not running.
    removeClient(clientId) {
      const ph = clients.get(clientId);
      if (!ph) return;
      if (!three || !active) {
        disposeClient(ph);
        return;
      }
      ph.dead = true;
      scheduleDraw();
    },

  };
}
