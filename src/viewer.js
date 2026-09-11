/* ============================================================================
   viewer.js — scene, camera controls, geometry building, picking, UI wiring
   Z-up world (matches Autoware / Lanelet2 / PCD map frames).
   ==========================================================================*/

const V = {
  scene: null, camera: null, renderer: null, raycaster: null,
  root: null,            // everything map-related
  cloud: null,           // THREE.Points
  cloudData: null,       // parsed pcd
  osm: null,             // parsed osm
  layers: {},            // name -> Object3D
  lanelets: [],          // { rel, tris:Float32Array, center:{x,y,z}, length, width }
  laneletFaceIndex: [],  // triangle index -> lanelet array index
  segPos: null, segMeta: null,
  selection: null, hover: null,
  highlight: null, hoverHighlight: null,
  measure: { on: false, pts: [], obj: null },
  offset: { x: 0, y: 0, z: 0 },
  pointBudget: 2500000,
  cloudColorMode: 'height',
  clipZ: { on: false, min: -1e9, max: 1e9 },
};

/* ------------------------------------------------------------- colours --- */

const PALETTE = {
  road: [0x4a, 0x8f, 0xff],
  crosswalk: [0xff, 0xa8, 0x3d],
  walkway: [0x6b, 0xd6, 0x8f],
  other: [0x9b, 0x8c, 0xff],
  line_thin_solid: 0xf2f2f2,
  line_thin_dashed: 0x9fb3c8,
  line_thick: 0xffffff,
  curbstone: 0xffd166,
  road_border: 0xffd166,
  virtual: 0x5a6b7d,
  guard_rail: 0xc0a0ff,
  fence: 0xc0a0ff,
  wall: 0xc0a0ff,
  stop_line: 0xff4d5e,
  traffic_light: 0x2ee6a8,
  traffic_sign: 0x2ee6a8,
  default: 0xb0bec5,
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));
function turbo(t) {
  t = clamp01(t);
  const r = (34.61 + t * (1172.33 + t * (-10793.56 + t * (33300.12 + t * (-38394.49 + t * 14825.05))))) / 255;
  const g = (23.31 + t * (557.33 + t * (1225.33 + t * (-3574.96 + t * (3220.54 + t * -1073.29))))) / 255;
  const b = (27.2 + t * (3211.1 + t * (-15327.97 + t * (27814 + t * (-22569.18 + t * 6838.66))))) / 255;
  return [clamp01(r), clamp01(g), clamp01(b)];
}

/** Robust display range: ignore the top/bottom tail so a few outliers don't
 *  flatten the whole ramp (common with LiDAR intensity and tall structures). */
function percentileRange(read, n, lo = 0.02, hi = 0.98) {
  if (n === 0) return [0, 1];
  const step = Math.max(1, Math.floor(n / 60000));
  const s = [];
  for (let i = 0; i < n; i += step) { const v = read(i); if (isFinite(v)) s.push(v); }
  if (!s.length) return [0, 1];
  s.sort((a, b) => a - b);
  const a = s[Math.floor(lo * (s.length - 1))];
  const b = s[Math.floor(hi * (s.length - 1))];
  return b > a ? [a, b] : [s[0], s[s.length - 1] > s[0] ? s[s.length - 1] : s[0] + 1];
}
function viridis(t) {
  t = Math.min(1, Math.max(0, t));
  const c = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  const s = t * (c.length - 1), i = Math.min(c.length - 2, Math.floor(s)), f = s - i;
  return [0, 1, 2].map((k) => (c[i][k] + (c[i + 1][k] - c[i][k]) * f) / 255);
}

/* --------------------------------------------------------------- setup --- */

function initScene(canvas) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f14);
  scene.fog = null;

  const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 20000);
  camera.up.set(0, 0, 1);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(120, 180, 260);
  scene.add(dir);

  const root = new THREE.Group();
  scene.add(root);

  const grid = new THREE.GridHelper(1000, 100, 0x2a3646, 0x18212c);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.05;
  root.add(grid);

  V.scene = scene; V.camera = camera; V.renderer = renderer; V.root = root;
  V.layers.grid = grid;
  V.raycaster = new THREE.Raycaster();
  V.raycaster.params.Points.threshold = 0.4;

  ['lanelets', 'boundaries', 'stoplines', 'signals', 'arrows', 'challenges'].forEach((k) => {
    const g = new THREE.Group();
    g.renderOrder = 2;
    root.add(g);
    V.layers[k] = g;
  });

  V.highlight = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide })
  );
  V.highlight.renderOrder = 10; V.highlight.visible = false; V.highlight.frustumCulled = false;
  scene.add(V.highlight);

  V.hoverHighlight = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.28, depthTest: false, side: THREE.DoubleSide })
  );
  V.hoverHighlight.renderOrder = 9; V.hoverHighlight.visible = false; V.hoverHighlight.frustumCulled = false;
  scene.add(V.hoverHighlight);

  return { scene, camera, renderer };
}

/* ------------------------------------------------------------ controls --- */

function makeControls(camera, dom, onChange) {
  const st = {
    target: new THREE.Vector3(0, 0, 0),
    radius: 220, theta: -Math.PI / 2, phi: 0.62,
    minR: 1.5, maxR: 12000,
  };
  let mode = null, lastX = 0, lastY = 0;
  let tweenRAF = null;
  const touches = [];

  function apply() {
    const sp = Math.sin(st.phi), cp = Math.cos(st.phi);
    camera.position.set(
      st.target.x + st.radius * sp * Math.cos(st.theta),
      st.target.y + st.radius * sp * Math.sin(st.theta),
      st.target.z + st.radius * cp
    );
    camera.lookAt(st.target);
    camera.near = Math.max(0.05, st.radius / 5000);
    camera.far = Math.max(2000, st.radius * 60);
    camera.updateProjectionMatrix();
    onChange && onChange();
  }

  function rotate(dx, dy) {
    st.theta -= dx * 0.005;
    st.phi = Math.min(Math.PI / 2 - 0.001, Math.max(0.001, st.phi - dy * 0.005));
    apply();
  }
  function pan(dx, dy) {
    const k = st.radius * 0.0016;
    const ct = Math.cos(st.theta), stn = Math.sin(st.theta);
    // screen-right in world XY
    const rx = -stn, ry = ct;
    // screen-up projected onto ground
    const ux = -ct, uy = -stn;
    st.target.x += (-dx * rx + dy * ux) * k;
    st.target.y += (-dx * ry + dy * uy) * k;
    apply();
  }
  function dolly(f) {
    st.radius = Math.min(st.maxR, Math.max(st.minR, st.radius * f));
    apply();
  }

  /* ---- smooth camera transitions (Fit / Top / 3D) --------------------- */
  function stopTween() { if (tweenRAF) { cancelAnimationFrame(tweenRAF); tweenRAF = null; } }
  // interpolate an angle along the shorter arc
  function deltaAngle(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  function animateTo(goal, dur = 520) {
    stopTween();
    const s0 = { tx: st.target.x, ty: st.target.y, tz: st.target.z, r: st.radius, ph: st.phi };
    const g = {
      tx: goal.target ? goal.target.x : s0.tx,
      ty: goal.target ? goal.target.y : s0.ty,
      tz: goal.target ? goal.target.z : s0.tz,
      r: goal.radius != null ? goal.radius : s0.r,
      ph: goal.phi != null ? goal.phi : s0.ph,
    };
    const dth = goal.theta != null ? deltaAngle(st.theta, goal.theta) : 0;
    const th0 = st.theta;
    // a jump across the world (e.g. the very first fit) should snap, not fly
    const dist = Math.hypot(g.tx - s0.tx, g.ty - s0.ty, g.tz - s0.tz);
    if (dist > Math.max(s0.r, g.r) * 4) {
      st.target.set(g.tx, g.ty, g.tz); st.radius = g.r; st.theta = th0 + dth; st.phi = g.ph;
      apply(); return;
    }
    const t0 = performance.now();
    const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2); // easeInOutCubic
    function step(now) {
      let u = (now - t0) / dur;
      if (u > 1) u = 1;
      const e = ease(u);
      st.target.set(s0.tx + (g.tx - s0.tx) * e, s0.ty + (g.ty - s0.ty) * e, s0.tz + (g.tz - s0.tz) * e);
      st.radius = s0.r + (g.r - s0.r) * e;
      st.theta = th0 + dth * e;
      st.phi = s0.ph + (g.ph - s0.ph) * e;
      apply();
      tweenRAF = u < 1 ? requestAnimationFrame(step) : null;
    }
    tweenRAF = requestAnimationFrame(step);
  }

  dom.addEventListener('contextmenu', (e) => e.preventDefault());
  dom.addEventListener('pointerdown', (e) => {
    stopTween();
    if (e.pointerType === 'touch') { touches.push(e); return; }
    dom.setPointerCapture(e.pointerId);
    mode = (e.button === 0 && !e.shiftKey && !e.ctrlKey) ? 'rot' : 'pan';
    lastX = e.clientX; lastY = e.clientY;
  });
  dom.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      const i = touches.findIndex((t) => t.pointerId === e.pointerId);
      if (i >= 0) {
        if (touches.length === 1) {
          rotate(e.clientX - touches[0].clientX, e.clientY - touches[0].clientY);
        } else if (touches.length === 2) {
          const other = touches[1 - i];
          const prevD = Math.hypot(touches[i].clientX - other.clientX, touches[i].clientY - other.clientY);
          const newD = Math.hypot(e.clientX - other.clientX, e.clientY - other.clientY);
          if (prevD > 0 && Math.abs(newD - prevD) > 1) dolly(prevD / newD);
          else pan((e.clientX - touches[i].clientX) * 0.6, (e.clientY - touches[i].clientY) * 0.6);
        }
        touches[i] = e;
      }
      return;
    }
    if (!mode) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (mode === 'rot') rotate(dx, dy); else pan(dx, dy);
  });
  const up = (e) => {
    const i = touches.findIndex((t) => t.pointerId === e.pointerId);
    if (i >= 0) touches.splice(i, 1);
    mode = null;
  };
  dom.addEventListener('pointerup', up);
  dom.addEventListener('pointercancel', up);
  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    stopTween();
    dolly(Math.pow(1.0015, e.deltaY));
  }, { passive: false });

  st.apply = apply;
  st.rotate = rotate; st.pan = pan; st.dolly = dolly;
  st.fit = (box, padding = 1.25) => {
    if (!box || box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(s.x, s.y, s.z, 5);
    const radius = Math.min(st.maxR, (maxDim * padding) / (2 * Math.tan((camera.fov * Math.PI) / 360)));
    animateTo({ target: c, radius }, 560);
  };
  st.top = () => animateTo({ phi: 0.0011 }, 430);
  st.iso = () => animateTo({ phi: 0.62 }, 430);
  st.stopTween = stopTween;
  apply();
  return st;
}

/* ---------------------------------------------------- geometry building --- */

function resample(pts, n) {
  // pts: [[x,y,z],...]  -> n points evenly spaced by arc length
  if (pts.length === 0) return [];
  if (pts.length === 1) return new Array(n).fill(pts[0]);
  const d = [0];
  for (let i = 1; i < pts.length; i++) {
    d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  }
  const total = d[d.length - 1] || 1;
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * total;
    while (j < d.length - 2 && d[j + 1] < t) j++;
    const seg = d[j + 1] - d[j] || 1;
    const f = (t - d[j]) / seg;
    out.push([
      pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f,
      pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f,
      pts[j][2] + (pts[j + 1][2] - pts[j][2]) * f,
    ]);
  }
  return out;
}

function wayPoints(osm, wayId) {
  const w = osm.ways.get(String(wayId));
  if (!w) return null;
  const pts = [];
  for (const r of w.refs) {
    const n = osm.nodes.get(r);
    if (n) pts.push([n.x, n.y, n.z]);
  }
  return pts.length ? pts : null;
}

function laneletCategory(rel) {
  const s = rel.tags.subtype || 'road';
  if (s === 'crosswalk') return 'crosswalk';
  if (s === 'walkway' || s === 'pedestrian_lane') return 'walkway';
  if (s === 'road' || s === 'highway' || s === 'road_shoulder' || s === 'bicycle_lane') return 'road';
  return 'other';
}

/** Upright locator pin at the centroid of a feature's points, so small map
    features (stop lines, signs) are easy to spot. Added into the feature's
    layer group, so its existing checkbox shows/hides the pin too. */
function addLocatorPin(group, pts, colorHex, height = 10, headR = 1.6) {
  if (!pts || !pts.length) return;
  let cx = 0, cy = 0, cz = Infinity;
  for (const p of pts) { cx += p[0]; cy += p[1]; if (p[2] < cz) cz = p[2]; }
  cx /= pts.length; cy /= pts.length;
  if (!isFinite(cz)) cz = 0;
  const col = new THREE.Color(colorHex);
  const stem = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(cx, cy, cz), new THREE.Vector3(cx, cy, cz + height)]),
    new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9, depthTest: false })
  );
  stem.renderOrder = 11;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(headR, 14, 10),
    new THREE.MeshBasicMaterial({ color: col, depthTest: false })
  );
  head.position.set(cx, cy, cz + height);
  head.renderOrder = 12;
  group.add(stem, head);
}

function buildMap(osm) {
  clearGroup(V.layers.lanelets);
  clearGroup(V.layers.boundaries);
  clearGroup(V.layers.stoplines);
  clearGroup(V.layers.signals);
  clearGroup(V.layers.arrows);
  V.lanelets = []; V.laneletFaceIndex = [];

  const Z_LIFT = 0.06;

  /* ---- lanelet surfaces (one merged mesh, face index -> lanelet) -------- */
  const lp = [], lc = [];
  let faceCounter = 0;

  for (const rel of osm.lanelets) {
    const lm = rel.members.find((m) => m.role === 'left');
    const rm = rel.members.find((m) => m.role === 'right');
    if (!lm || !rm) continue;
    let L = wayPoints(osm, lm.ref), R = wayPoints(osm, rm.ref);
    if (!L || !R) continue;

    // orient the right boundary to run the same way as the left one
    const dHead = Math.hypot(L[0][0] - R[0][0], L[0][1] - R[0][1]);
    const dTail = Math.hypot(L[0][0] - R[R.length - 1][0], L[0][1] - R[R.length - 1][1]);
    if (dTail < dHead) R = R.slice().reverse();

    const n = Math.min(160, Math.max(2, Math.max(L.length, R.length)));
    const Ls = resample(L, n), Rs = resample(R, n);

    const cat = laneletCategory(rel);
    const col = PALETTE[cat].map((v) => v / 255);
    const tris = [];
    let len = 0, widthSum = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = Ls[i], b = Rs[i], c = Ls[i + 1], d = Rs[i + 1];
      tris.push(a[0], a[1], a[2] + Z_LIFT, b[0], b[1], b[2] + Z_LIFT, c[0], c[1], c[2] + Z_LIFT);
      tris.push(b[0], b[1], b[2] + Z_LIFT, d[0], d[1], d[2] + Z_LIFT, c[0], c[1], c[2] + Z_LIFT);
      len += Math.hypot(c[0] - a[0], c[1] - a[1]);
      widthSum += Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    if (!tris.length) continue;

    const li = V.lanelets.length;
    const nTris = tris.length / 9;
    for (let t = 0; t < nTris; t++) V.laneletFaceIndex[faceCounter + t] = li;
    faceCounter += nTris;

    for (let i = 0; i < tris.length; i += 3) {
      lp.push(tris[i], tris[i + 1], tris[i + 2]);
      lc.push(col[0], col[1], col[2]);
    }

    const mid = Math.floor(n / 2);
    V.lanelets.push({
      rel,
      tris: new Float32Array(tris),
      centerline: Ls.map((p, i) => [(p[0] + Rs[i][0]) / 2, (p[1] + Rs[i][1]) / 2, (p[2] + Rs[i][2]) / 2]),
      center: { x: (Ls[mid][0] + Rs[mid][0]) / 2, y: (Ls[mid][1] + Rs[mid][1]) / 2, z: (Ls[mid][2] + Rs[mid][2]) / 2 },
      length: len, width: widthSum / Math.max(1, n - 1),
      leftId: lm.ref, rightId: rm.ref, category: cat,
    });
  }

  if (lp.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
    }));
    mesh.name = 'laneletSurfaces';
    V.layers.lanelets.add(mesh);
    V.laneletMesh = mesh;
  } else {
    V.laneletMesh = null;
  }

  /* ---- boundaries: merged line segments + CPU pick metadata ------------- */
  const bp = [], bc = [], segMeta = [];
  const stopQuads = [];
  const signalQuads = [];

  const styleOf = (tags) => {
    const t = tags.type || '';
    const s = tags.subtype || '';
    if (t === 'stop_line') return { key: 'stop_line', color: PALETTE.stop_line };
    if (t === 'line_thin') return { key: 'line_thin', color: s === 'dashed' ? PALETTE.line_thin_dashed : PALETTE.line_thin_solid };
    if (t === 'line_thick') return { key: 'line_thick', color: PALETTE.line_thick };
    if (t === 'curbstone' || t === 'road_border') return { key: t, color: PALETTE.curbstone };
    if (t === 'virtual') return { key: 'virtual', color: PALETTE.virtual };
    if (t === 'guard_rail' || t === 'fence' || t === 'wall') return { key: t, color: PALETTE.guard_rail };
    if (t === 'traffic_light') return { key: 'traffic_light', color: PALETTE.traffic_light };
    if (t === 'traffic_sign') return { key: 'traffic_sign', color: PALETTE.traffic_sign };
    return { key: t || 'untyped', color: PALETTE.default };
  };

  const typeCounts = {};
  for (const w of osm.ways.values()) {
    const pts = wayPoints(osm, w.id);
    if (!pts || pts.length < 2) continue;
    const st = styleOf(w.tags);
    typeCounts[st.key] = (typeCounts[st.key] || 0) + 1;

    if (st.key === 'stop_line') { stopQuads.push({ pts, way: w }); continue; }
    if (st.key === 'traffic_light' || st.key === 'traffic_sign') { signalQuads.push({ pts, way: w, kind: st.key }); continue; }

    const c = new THREE.Color(st.color);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      bp.push(a[0], a[1], a[2] + Z_LIFT * 1.6, b[0], b[1], b[2] + Z_LIFT * 1.6);
      bc.push(c.r, c.g, c.b, c.r, c.g, c.b);
      segMeta.push(w.id);
    }
  }
  if (bp.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(bc, 3));
    const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    V.layers.boundaries.add(ls);
  }
  V.segPos = new Float32Array(bp);
  V.segMeta = segMeta;

  /* ---- stop lines as ribbons so they read at any zoom ------------------- */
  const ribbon = (pts, width, color, zLift) => {
    const p = [], c = [];
    const col = new THREE.Color(color);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      const nx = (-dy / L) * width / 2, ny = (dx / L) * width / 2;
      const A = [a[0] + nx, a[1] + ny, a[2] + zLift], B = [a[0] - nx, a[1] - ny, a[2] + zLift];
      const C = [b[0] + nx, b[1] + ny, b[2] + zLift], D = [b[0] - nx, b[1] - ny, b[2] + zLift];
      p.push(...A, ...B, ...C, ...B, ...D, ...C);
      for (let k = 0; k < 6; k++) c.push(col.r, col.g, col.b);
    }
    return { p, c };
  };

  if (stopQuads.length) {
    const P = [], C = [];
    V.stopMeta = [];
    for (const s of stopQuads) {
      const { p, c } = ribbon(s.pts, 0.45, PALETTE.stop_line, Z_LIFT * 2.2);
      P.push(...p); C.push(...c);
      // also feed the CPU picker
      for (let i = 0; i < s.pts.length - 1; i++) V.stopMeta.push(s.way.id);
      // findable locator pin (red, matches the stop-line colour)
      addLocatorPin(V.layers.stoplines, s.pts, PALETTE.stop_line, 8, 1.3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    V.layers.stoplines.add(m);
    // stop lines are pickable through the segment picker too
    for (const s of stopQuads) {
      for (let i = 0; i < s.pts.length - 1; i++) {
        const a = s.pts[i], b = s.pts[i + 1];
        appendSeg(a, b, s.way.id);
      }
    }
  }

  /* ---- traffic lights / signs: vertical panels -------------------------- */
  if (signalQuads.length) {
    const P = [], C = [];
    for (const s of signalQuads) {
      const h = parseFloat(s.way.tags.height || (s.kind === 'traffic_light' ? 0.9 : 0.8)) || 0.9;
      const col = new THREE.Color(PALETTE[s.kind]);
      for (let i = 0; i < s.pts.length - 1; i++) {
        const a = s.pts[i], b = s.pts[i + 1];
        const A = [a[0], a[1], a[2]], B = [b[0], b[1], b[2]];
        const A2 = [a[0], a[1], a[2] + h], B2 = [b[0], b[1], b[2] + h];
        P.push(...A, ...B, ...A2, ...B, ...B2, ...A2);
        for (let k = 0; k < 6; k++) C.push(col.r, col.g, col.b);
        appendSeg(a, b, s.way.id);
      }
      // a stem down to the ground for context
      const a = s.pts[0];
      const stem = [[a[0], a[1], a[2]], [a[0], a[1], a[2] - Math.max(0, a[2] - 0.1)]];
      const { p, c } = ribbon(stem, 0.12, 0x8fa3b8, 0);
      P.push(...p); C.push(...c);
      // findable locator pin (green, matches the traffic-sign colour)
      addLocatorPin(V.layers.signals, s.pts, PALETTE[s.kind], 11, 1.6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    V.layers.signals.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }

  /* ---- direction arrows ------------------------------------------------- */
  {
    const P = [], C = [];
    const col = new THREE.Color(0xdff1ff);
    for (const ll of V.lanelets) {
      if (ll.category === 'crosswalk') continue;
      const cl = ll.centerline;
      if (cl.length < 2) continue;
      const step = Math.max(1, Math.floor(cl.length / Math.max(1, Math.round(ll.length / 18))));
      for (let i = step; i < cl.length - 1; i += step) {
        const a = cl[i - 1], b = cl[i + 1] || cl[i];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const L = Math.hypot(dx, dy) || 1;
        const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
        const p = cl[i], s = Math.min(1.6, Math.max(0.6, ll.width * 0.28));
        const z = p[2] + Z_LIFT * 2.6;
        P.push(p[0] + ux * s, p[1] + uy * s, z,
               p[0] - ux * s * 0.5 + nx * s * 0.6, p[1] - uy * s * 0.5 + ny * s * 0.6, z,
               p[0] - ux * s * 0.5 - nx * s * 0.6, p[1] - uy * s * 0.5 - ny * s * 0.6, z);
        for (let k = 0; k < 3; k++) C.push(col.r, col.g, col.b);
      }
    }
    if (P.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
      V.layers.arrows.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
      })));
    }
  }

  flushExtraSegs();
  V.osm = osm;
  V.typeCounts = typeCounts;
  return { typeCounts };
}

// extra pickable segments (stop lines, signals) collected during buildMap and
// merged into the pick buffer in one pass at the end.
let EXTRA_SEG = [];
function appendSeg(a, b, wayId) {
  EXTRA_SEG.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  V.segMeta.push(wayId);
}
function flushExtraSegs() {
  if (!EXTRA_SEG.length) { EXTRA_SEG = []; return; }
  const old = V.segPos || new Float32Array(0);
  const np = new Float32Array(old.length + EXTRA_SEG.length);
  np.set(old, 0);
  np.set(EXTRA_SEG, old.length);
  V.segPos = np;
  EXTRA_SEG = [];
}

function clearGroup(g) {
  if (!g) return;
  for (let i = g.children.length - 1; i >= 0; i--) {
    const c = g.children[i];
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
    g.remove(c);
  }
}

/* ------------------------------------------------------------ pointcloud - */

function buildCloud(pcd) {
  if (V.cloud) {
    V.cloud.geometry.dispose();
    V.cloud.material.dispose();
    V.root.remove(V.cloud);
    V.cloud = null;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pcd.position, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pcd.count * 3), 3));
  const m = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  V.root.add(pts);
  V.cloud = pts;
  V.cloudData = pcd;
  recolorCloud(V.cloudColorMode);
  applyCloudOffset();
  return pts;
}

function recolorCloud(mode) {
  V.cloudColorMode = mode;
  const pcd = V.cloudData;
  if (!pcd || !V.cloud) return;
  const col = V.cloud.geometry.getAttribute('color');
  const pos = pcd.position;
  const n = pcd.count;
  if (mode === 'rgb' && pcd.rgb) {
    col.array.set(pcd.rgb.subarray(0, n * 3));
  } else if (mode === 'intensity' && pcd.intensity) {
    const [lo, hi] = percentileRange((i) => pcd.intensity[i], n);
    const d = (hi - lo) || 1;
    for (let i = 0; i < n; i++) {
      const c = turbo((pcd.intensity[i] - lo) / d);
      col.array[i * 3] = c[0]; col.array[i * 3 + 1] = c[1]; col.array[i * 3 + 2] = c[2];
    }
    V.rampInfo = { mode: 'intensity', lo, hi, ramp: turbo };
  } else if (mode === 'flat') {
    for (let i = 0; i < n; i++) { col.array[i * 3] = 0.72; col.array[i * 3 + 1] = 0.76; col.array[i * 3 + 2] = 0.82; }
    V.rampInfo = null;
  } else {
    const [lo, hi] = percentileRange((i) => pos[i * 3 + 2], n, 0.01, 0.99);
    const d = (hi - lo) || 1;
    for (let i = 0; i < n; i++) {
      const c = viridis((pos[i * 3 + 2] - lo) / d);
      col.array[i * 3] = c[0]; col.array[i * 3 + 1] = c[1]; col.array[i * 3 + 2] = c[2];
    }
    V.rampInfo = { mode: 'height', lo, hi, ramp: viridis };
  }
  col.needsUpdate = true;
}

function applyCloudOffset() {
  if (V.cloud) V.cloud.position.set(V.offset.x, V.offset.y, V.offset.z);
}

/** Re-scale the ground grid so it frames the data instead of the horizon. */
function fitGrid(box) {
  if (!box || box.isEmpty()) return;
  const s = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const span = Math.max(40, Math.ceil(Math.max(s.x, s.y) * 1.15 / 20) * 20);
  const div = Math.min(120, Math.max(8, Math.round(span / 20)));
  const old = V.layers.grid;
  const visible = old ? old.visible : true;
  if (old) { V.root.remove(old); old.geometry.dispose(); old.material.dispose(); }
  const grid = new THREE.GridHelper(span, div, 0x2a3646, 0x18212c);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(c.x, c.y, box.min.z - 0.15);
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  grid.visible = visible;
  V.root.add(grid);
  V.layers.grid = grid;
}

/* --------------------------------------------------------------- picking - */

function ndc(ev, dom) {
  const r = dom.getBoundingClientRect();
  return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
}

function pickLanelet(ev, dom) {
  if (!V.laneletMesh || !V.layers.lanelets.visible) return null;
  V.raycaster.setFromCamera(ndc(ev, dom), V.camera);
  const hits = V.raycaster.intersectObject(V.laneletMesh, false);
  if (!hits.length) return null;
  const li = V.laneletFaceIndex[hits[0].faceIndex];
  return li === undefined ? null : { kind: 'lanelet', index: li, point: hits[0].point };
}

function raySegDistance(o, d, a, b) {
  const ux = d.x, uy = d.y, uz = d.z;
  const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
  const wx = o.x - a[0], wy = o.y - a[1], wz = o.z - a[2];
  const A = ux * ux + uy * uy + uz * uz;
  const B = ux * vx + uy * vy + uz * vz;
  const C = vx * vx + vy * vy + vz * vz;
  const D = ux * wx + uy * wy + uz * wz;
  const E = vx * wx + vy * wy + vz * wz;
  const den = A * C - B * B;
  let s, t;
  if (Math.abs(den) < 1e-9) { s = 0; t = C > 1e-9 ? E / C : 0; }
  else { s = (B * E - C * D) / den; t = (A * E - B * D) / den; }
  if (s < 0) s = 0;
  t = Math.min(1, Math.max(0, t));
  const px = o.x + ux * s, py = o.y + uy * s, pz = o.z + uz * s;
  const qx = a[0] + vx * t, qy = a[1] + vy * t, qz = a[2] + vz * t;
  return { dist: Math.hypot(px - qx, py - qy, pz - qz), along: s, point: [qx, qy, qz] };
}

function pickWay(ev, dom) {
  if (!V.segPos || !V.segPos.length) return null;
  V.raycaster.setFromCamera(ndc(ev, dom), V.camera);
  const o = V.raycaster.ray.origin, d = V.raycaster.ray.direction;
  let best = null;
  const nSeg = V.segMeta.length;
  for (let i = 0; i < nSeg; i++) {
    const a = [V.segPos[i * 6], V.segPos[i * 6 + 1], V.segPos[i * 6 + 2]];
    const b = [V.segPos[i * 6 + 3], V.segPos[i * 6 + 4], V.segPos[i * 6 + 5]];
    const r = raySegDistance(o, d, a, b);
    const tol = Math.max(0.25, r.along * 0.010);   // ≈ 9 px at the default fov
    if (r.dist >= tol) continue;
    const score = r.dist / tol;
    if (!best || score < best.score - 0.05 || (Math.abs(score - best.score) <= 0.05 && r.along < best.along)) {
      best = { ...r, score, wayId: V.segMeta[i] };
    }
  }
  if (!best) return null;
  return { kind: 'way', wayId: best.wayId, score: best.score, point: new THREE.Vector3(...best.point) };
}

function setHighlight(mesh, tris) {
  if (!tris) { mesh.visible = false; return; }
  mesh.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
  mesh.geometry = g;
  mesh.visible = true;
}

function wayHighlightTris(wayId) {
  const pts = wayPoints(V.osm, wayId);
  if (!pts || pts.length < 2) return null;
  const out = [];
  const w = 0.9;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    const nx = (-dy / L) * w / 2, ny = (dx / L) * w / 2;
    const A = [a[0] + nx, a[1] + ny, a[2] + 0.12], B = [a[0] - nx, a[1] - ny, a[2] + 0.12];
    const C = [b[0] + nx, b[1] + ny, b[2] + 0.12], D = [b[0] - nx, b[1] - ny, b[2] + 0.12];
    out.push(...A, ...B, ...C, ...B, ...D, ...C);
  }
  return new Float32Array(out);
}

/* ----------------------------------------------------------- challenges --- */
/* Route difficulty callouts. Each item is anchored to one or more lanelet
   relation IDs from the .osm; a coloured dot is placed at the lane centre (no
   surface highlight) with a floating locator pin so it is easy to spot. app.js
   owns the filter UI and the hover tooltip; viewer owns the geometry, the
   id->challenge map and picking. */

const DOT_R = 40;            // radius (m) of the dot marking the lane centre (v1 size)

function buildChallenges(data) {
  const g = V.layers.challenges;
  if (!g) return [];
  while (g.children.length) {
    const grp = g.children.pop();
    grp.traverse((o) => { o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); });
  }
  V.challengePick = [];        // overlay meshes + pin heads (hover targets)
  V.challengeMarkers = [];     // one entry per item
  V.challengeByLanelet = {};   // laneletId -> { index, item, cat }
  V.challengeData = data;
  const catMap = {};
  (data.categories || []).forEach((c) => { catMap[c.key] = c; });
  V.challengeCats = catMap;

  // index the built lanelets by their relation id so items can resolve them
  const byId = {};
  V.lanelets.forEach((ll, i) => { byId[ll.rel.id] = i; });

  const missing = [];
  (data.items || []).forEach((it, idx) => {
    const cat = catMap[it.cat] || { color: '#b0bec5', label: it.cat, desc: '' };
    const col = new THREE.Color(cat.color);
    const grp = new THREE.Group();
    grp.userData = { challengeIndex: idx };
    const ids = it.lanelets ? it.lanelets : (it.lanelet != null ? [it.lanelet] : []);
    let cx = 0, cy = 0, cz = 0, nc = 0;

    ids.forEach((lid) => {
      const li = byId[lid];
      if (li === undefined) { missing.push(lid); return; }
      const ll = V.lanelets[li];
      V.challengeByLanelet[lid] = { index: idx, item: it, cat };
      cx += ll.center.x; cy += ll.center.y; cz += ll.center.z; nc++;
    });

    if (nc) {
      cx /= nc; cy /= nc; cz /= nc;
      // a single coloured dot at the lane centre — the hover target (v1 size)
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(DOT_R, 48),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, depthTest: false })
      );
      dot.position.set(cx, cy, cz + 0.3);
      dot.renderOrder = 9;
      dot.userData = { challengeIndex: idx };
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(DOT_R - 1.6, DOT_R, 48),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, depthTest: false })
      );
      ring.position.set(cx, cy, cz + 0.35);
      ring.renderOrder = 10;
      grp.add(dot, ring);
      V.challengePick.push(dot);
    }

    g.add(grp);
    V.challengeMarkers.push({ grp, item: it, cat, center: { x: cx, y: cy, z: cz }, lanelets: ids });
  });

  if (missing.length) console.warn('challenges: lanelet id(s) not found in the map:', missing);
  return V.challengeMarkers;
}

/** Raycast the dots and pin heads. Returns { index, item, cat } or null. */
function pickChallenge(ev, dom) {
  if (!V.challengePick || !V.challengePick.length) return null;
  if (!V.layers.challenges || !V.layers.challenges.visible) return null;
  V.raycaster.setFromCamera(ndc(ev, dom), V.camera);
  const vis = V.challengePick.filter((o) => o.parent && o.parent.visible);
  const hits = V.raycaster.intersectObjects(vis, false);
  if (!hits.length) return null;
  const idx = hits[0].object.userData.challengeIndex;
  const m = V.challengeMarkers[idx];
  return m ? { index: idx, item: m.item, cat: m.cat } : null;
}

/** The challenge on a given lanelet id, or null — for hovering the road itself. */
function challengeForLanelet(laneletId) {
  return (V.challengeByLanelet && V.challengeByLanelet[laneletId]) || null;
}

/** active = Set of category keys to show, or null/undefined to show all. */
function setChallengeFilter(active) {
  if (!V.challengeMarkers) return;
  V.challengeMarkers.forEach((m) => { m.grp.visible = !active || active.has(m.item.cat); });
}
