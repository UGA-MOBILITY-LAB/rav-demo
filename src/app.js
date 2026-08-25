/* ============================================================================
   app.js — UI wiring for the Lanelet Inspector
   ==========================================================================*/

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
/* Data stat cards were removed from the sidebar (display-only build); these
   fields may be absent, so set text only when the element still exists. */
const setText = (s, v) => { const e = $(s); if (e) e.textContent = v; };

const APP = {
  controls: null,
  pcdBuffers: [],     // keep raw buffers so the point budget can be re-applied
  osmText: null,
  fps: { last: performance.now(), frames: 0, value: 0 },
  cursor: new THREE.Vector3(),
  plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
};

/* ------------------------------------------------------------- status ---- */

let statusTimer = null;
function status(msg, kind = 'info', sticky = false) {
  const el = $('#status');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => el.classList.remove('show'), 4200);
}
const nf = (n) => n.toLocaleString('en-US');

/* --------------------------------------------------------------- boot ---- */

function boot() {
  const canvas = $('#gl');
  initScene(canvas);
  APP.controls = makeControls(V.camera, canvas, () => {});
  resize();
  window.addEventListener('resize', resize);
  wireUI(canvas);
  animate();
  applyConfig();
  if (CFG.autoload && (CFG.osm || CFG.pcd)) loadEntryData();
}

const baseName = (p) => String(p).split('/').pop().split('?')[0];

/** Push everything from config.js into the controls, before any data loads. */
function applyConfig() {
  const t = String(CFG.title || 'Lanelet·Inspector');
  $('#appTitle').innerHTML = t.includes('\u00b7')
    ? esc(t.split('\u00b7')[0]) + '<span class="tick">\u00b7</span>' + esc(t.split('\u00b7').slice(1).join('\u00b7'))
    : esc(t);
  $('#appSubtitle').textContent = CFG.subtitle || '';
  document.title = t.replace(/\u00b7/g, ' ');

  const budget = $('#budget');
  if (![...budget.options].some((o) => +o.value === +CFG.pointBudget)) {
    const o = document.createElement('option');
    o.value = String(CFG.pointBudget);
    o.textContent = (CFG.pointBudget / 1e6).toFixed(1).replace(/\.0$/, '') + ' M';
    budget.appendChild(o);
  }
  budget.value = String(CFG.pointBudget);

  $('#pointSize').value = CFG.pointSize;
  $('#pointSizeOut').textContent = Number(CFG.pointSize).toFixed(1);
  $('#mapOpacity').value = CFG.mapOpacity;

  if (CFG.colorMode && CFG.colorMode !== 'auto') {
    $('#colorMode').value = CFG.colorMode;
    APP.userPickedColor = true;
  }
  if (CFG.lightBackground) {
    $('#bgToggle').checked = true;
    $('#bgToggle').dispatchEvent(new Event('change'));
  }
  const off = CFG.cloudOffset || {};
  ['x', 'y', 'z'].forEach((ax) => {
    const v = Number(off[ax] || 0);
    V.offset[ax] = v;
    $('#off' + ax.toUpperCase()).value = v;
  });
}

/** Fetch and display the entry .osm / .pcd named in config.js. */
async function loadEntryData() {
  const dz = $('#dropzone'), prog = $('#dzProgress'), bar = $('#dzBar'), lab = $('#dzProgLabel');
  dz.classList.remove('hidden');
  prog.classList.remove('hidden');
  bar.classList.add('indeterminate');

  // progress only \u2014 no file name shown during loading
  const setProg = (name, received, total) => {
    if (total > 0) {
      bar.classList.remove('indeterminate');
      const pct = Math.min(100, (received / total) * 100);
      bar.style.width = pct.toFixed(1) + '%';
      lab.textContent = `${pct.toFixed(0)}%  \u00b7  ${fmtBytes(received)} / ${fmtBytes(total)}`;
    } else {
      lab.textContent = fmtBytes(received);
    }
  };

  try {
    if (CFG.osm) {
      lab.textContent = 'loading map\u2026';
      const buf = await fetchBuffer(CFG.osm, (r, t) => setProg(baseName(CFG.osm), r, t));
      await loadOSMText(new TextDecoder().decode(new Uint8Array(buf)), baseName(CFG.osm));
      $('#mapOpacity').dispatchEvent(new Event('input'));
    }
    if (CFG.challenges) {
      try { await loadChallenges(); } catch (e) { console.warn('challenges did not load:', e); }
    }
    if (CFG.pcd) {
      bar.classList.add('indeterminate');
      bar.style.width = '35%';
      lab.textContent = 'loading point cloud\u2026';
      const buf = await fetchBuffer(CFG.pcd, (r, t) => setProg(baseName(CFG.pcd), r, t));
      APP.pcdBuffers = [{ name: baseName(CFG.pcd), buffer: buf }];
      bar.classList.add('indeterminate');
      lab.textContent = 'parsing point cloud\u2026';
      await new Promise((r) => setTimeout(r, 25));
      rebuildCloud();
    }
    fitAll();
    dz.classList.add('hidden');
  } catch (e) {
    console.error(e);
    const hint = location.protocol === 'file:'
      ? 'Open the site through a web server (npm start) — browsers block file:// fetches.'
      : e.message;
    status('Entry data did not load. ' + hint, 'error', true);
  } finally {
    prog.classList.add('hidden');
    bar.classList.remove('indeterminate');
  }
}

/* --------------------------------------------------------- challenges ---- */

async function loadChallenges() {
  const res = await fetch(CFG.challenges, { cache: 'default' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${CFG.challenges}`);
  const data = await res.json();
  APP.challengeData = data;
  buildChallenges(data);
  renderChallengePanel(data);
}

function renderChallengePanel(data) {
  const list = $('#challengeList');
  if (!list) return;
  const cats = data.categories || [];
  const counts = {};
  (data.items || []).forEach((it) => { counts[it.cat] = (counts[it.cat] || 0) + 1; });
  APP.challengeFilter = new Set(cats.map((c) => c.key));
  list.innerHTML = cats.map((c) => `
    <li><label><input type="checkbox" class="ch-cat" data-cat="${esc(c.key)}" checked>
      <i style="background:${esc(c.color)}"></i>${esc(c.label)}
      <b style="margin-left:auto;color:var(--dim)">${counts[c.key] || 0}</b></label></li>`).join('') ||
    '<li><span>no challenges defined</span></li>';
  $$('.ch-cat').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) APP.challengeFilter.add(cb.dataset.cat);
    else APP.challengeFilter.delete(cb.dataset.cat);
    setChallengeFilter(APP.challengeFilter);
  }));
  setChallengeFilter(APP.challengeFilter);
}

function showTip(ev, ch) {
  const tip = $('#challengeTip');
  if (!tip) return;
  tip.innerHTML = `<b style="color:${esc(ch.cat.color)}">${esc(ch.cat.label)}</b>` +
    (ch.item.note ? `<em>${esc(ch.item.note)}</em>` : '') +
    `<span>${esc(ch.item.desc || ch.cat.desc || '')}</span>`;
  tip.style.display = 'block';
  // keep the tip inside the viewport
  const pad = 16, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > window.innerWidth - 8) x = ev.clientX - pad - w;
  if (y + h > window.innerHeight - 8) y = ev.clientY - pad - h;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
function hideTip() { const t = $('#challengeTip'); if (t) t.style.display = 'none'; }

function resize() {
  const el = $('#viewport');
  const w = el.clientWidth, h = el.clientHeight;
  V.renderer.setSize(w, h, false);
  V.camera.aspect = w / Math.max(1, h);
  V.camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  V.renderer.render(V.scene, V.camera);
  APP.fps.frames++;
  const now = performance.now();
  if (now - APP.fps.last > 500) {
    APP.fps.value = Math.round((APP.fps.frames * 1000) / (now - APP.fps.last));
    APP.fps.frames = 0; APP.fps.last = now;
    $('#fps').textContent = APP.fps.value;
  }
}

/* ------------------------------------------------------------ loading ---- */

async function loadFiles(fileList) {
  const files = Array.from(fileList);
  const osmFiles = files.filter((f) => /\.(osm|xml)$/i.test(f.name));
  const pcdFiles = files.filter((f) => /\.pcd$/i.test(f.name));
  if (!osmFiles.length && !pcdFiles.length) {
    status('Nothing to load — drop a .osm (Lanelet2) or .pcd file.', 'warn');
    return;
  }
  $('#dropzone').classList.add('hidden');

  if (osmFiles.length) {
    status(`Reading ${osmFiles[0].name}…`, 'info', true);
    const text = await osmFiles[0].text();
    await loadOSMText(text, osmFiles[0].name);
  }
  if (pcdFiles.length) {
    APP.pcdBuffers = [];
    for (const f of pcdFiles) {
      status(`Reading ${f.name} (${(f.size / 1048576).toFixed(1)} MB)…`, 'info', true);
      await new Promise((r) => setTimeout(r, 10));
      APP.pcdBuffers.push({ name: f.name, buffer: await f.arrayBuffer() });
    }
    rebuildCloud();
  }
  fitAll();
}

async function loadOSMText(text, name = 'map.osm') {
  try {
    const t0 = performance.now();
    const osm = parseOSM(text);
    APP.osmText = text;
    buildMap(osm);
    const ms = Math.round(performance.now() - t0);
    setText('#mapName', name);
    setText('#statLanelets', nf(osm.stats.lanelets));
    setText('#statWays', nf(osm.stats.ways));
    setText('#statNodes', nf(osm.stats.nodes));
    setText('#statRegs', nf(osm.stats.regulatory));
    setText('#frameNote', osm.frame === 'local_xy'
      ? 'local_x / local_y (metric, map frame)'
      : 'projected from lat / lon (no local_x tags found)');
    renderTypeLegend(V.typeCounts);
    $('#mapOpacity').dispatchEvent(new Event('input'));
    $('#mapCard')?.classList.remove('empty');
    status(`Loaded ${nf(osm.stats.lanelets)} lanelets from ${name} in ${ms} ms`, 'ok');
  } catch (e) {
    console.error(e);
    status('Could not read that .osm: ' + e.message, 'error', true);
  }
}

function rebuildCloud() {
  if (!APP.pcdBuffers.length) return;
  const budget = parseInt($('#budget').value, 10);
  const per = Math.max(1, Math.floor(budget / APP.pcdBuffers.length));
  let merged = null;
  try {
    const parts = APP.pcdBuffers.map((b) => parsePCD(b.buffer, { maxPoints: per }));
    merged = parts.length === 1 ? parts[0] : mergeClouds(parts);
  } catch (e) {
    console.error(e);
    status('Could not read that .pcd: ' + e.message, 'error', true);
    return;
  }
  buildCloud(merged);
  V.cloud.material.size = parseFloat($('#pointSize').value) || 1.6;
  setText('#cloudName', APP.pcdBuffers.map((b) => b.name).join(', '));
  setText('#statPoints', nf(merged.count));
  setText('#statPointsTotal', nf(merged.totalInFile * APP.pcdBuffers.length));
  setText('#statDataMode', merged.header.data);
  setText('#statFields', merged.header.fields.join(' '));
  const bb = merged.bbox;
  setText('#statExtent',
    `${(bb.maxX - bb.minX).toFixed(1)} × ${(bb.maxY - bb.minY).toFixed(1)} × ${(bb.maxZ - bb.minZ).toFixed(1)} m`);
  $('#cloudCard')?.classList.remove('empty');
  const opts = $('#colorMode').options;
  for (const o of opts) {
    if (o.value === 'intensity') o.disabled = !merged.intensity;
    if (o.value === 'rgb') o.disabled = !merged.rgb;
  }
  if (!APP.userPickedColor) $('#colorMode').value = merged.intensity ? 'intensity' : 'height';
  if ($('#colorMode').selectedOptions[0].disabled) $('#colorMode').value = 'height';
  recolorCloud($('#colorMode').value);
  updateRamp();
  status(`Point cloud: ${nf(merged.count)} of ${nf(merged.totalInFile * APP.pcdBuffers.length)} points shown`, 'ok');
}

function mergeClouds(parts) {
  const count = parts.reduce((s, p) => s + p.count, 0);
  const position = new Float32Array(count * 3);
  const hasI = parts.every((p) => p.intensity);
  const hasC = parts.every((p) => p.rgb);
  const intensity = hasI ? new Float32Array(count) : null;
  const rgb = hasC ? new Float32Array(count * 3) : null;
  let o = 0, bb = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  let iMin = Infinity, iMax = -Infinity, total = 0;
  for (const p of parts) {
    position.set(p.position, o * 3);
    if (intensity) intensity.set(p.intensity, o);
    if (rgb) rgb.set(p.rgb, o * 3);
    o += p.count;
    total += p.totalInFile;
    bb.minX = Math.min(bb.minX, p.bbox.minX); bb.maxX = Math.max(bb.maxX, p.bbox.maxX);
    bb.minY = Math.min(bb.minY, p.bbox.minY); bb.maxY = Math.max(bb.maxY, p.bbox.maxY);
    bb.minZ = Math.min(bb.minZ, p.bbox.minZ); bb.maxZ = Math.max(bb.maxZ, p.bbox.maxZ);
    iMin = Math.min(iMin, p.intensityRange[0]); iMax = Math.max(iMax, p.intensityRange[1]);
  }
  return {
    position, intensity, rgb, count, totalInFile: total, stride: parts[0].stride,
    header: parts[0].header, bbox: bb, intensityRange: [iMin, iMax],
  };
}

function loadDemo() {
  status('Generating example map…', 'info', true);
  setTimeout(() => {
    loadOSMText(buildDemoOSM(), 'demo_intersection.osm');
    APP.pcdBuffers = [{ name: 'demo_intersection.pcd', buffer: buildDemoPCD() }];
    rebuildCloud();
    fitAll();
    $('#dropzone').classList.add('hidden');
    status('Example map loaded — click a lane to inspect it.', 'ok');
  }, 30);
}

/* ------------------------------------------------------------- camera ---- */

function contentBox() {
  const box = new THREE.Box3();
  if (V.laneletMesh) box.expandByObject(V.laneletMesh);
  if (V.cloud && V.cloudData) {
    const b = V.cloudData.bbox;
    box.expandByPoint(new THREE.Vector3(b.minX + V.offset.x, b.minY + V.offset.y, b.minZ + V.offset.z));
    box.expandByPoint(new THREE.Vector3(b.maxX + V.offset.x, b.maxY + V.offset.y, b.maxZ + V.offset.z));
  }
  return box;
}
function fitAll() {
  const box = contentBox();
  fitGrid(box);
  APP.controls.fit(box);
}

function updateRamp() {
  const el = $('#ramp');
  if (!el) return;
  const info = V.rampInfo;
  if (!info) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const stops = [];
  for (let i = 0; i <= 10; i++) {
    const c = info.ramp(i / 10).map((v) => Math.round(v * 255));
    stops.push(`rgb(${c[0]},${c[1]},${c[2]}) ${i * 10}%`);
  }
  const unit = info.mode === 'height' ? ' m' : '';
  el.querySelector('.ramp-bar').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  el.querySelector('.ramp-lo').textContent = info.lo.toFixed(info.mode === 'height' ? 2 : 0) + unit;
  el.querySelector('.ramp-hi').textContent = info.hi.toFixed(info.mode === 'height' ? 2 : 0) + unit;
}

/* ---------------------------------------------------------- inspector ---- */

function tagRows(tags) {
  const keys = Object.keys(tags);
  if (!keys.length) return '<div class="muted">no tags</div>';
  return '<dl class="tags">' + keys.map((k) =>
    `<dt>${esc(k)}</dt><dd>${esc(tags[k])}</dd>`).join('') + '</dl>';
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function showLanelet(i) {
  const ll = V.lanelets[i];
  if (!ll) return;
  V.selection = { kind: 'lanelet', index: i };
  setHighlight(V.highlight, ll.tris);
  const osm = V.osm;
  const lw = osm.ways.get(String(ll.leftId)), rw = osm.ways.get(String(ll.rightId));
  const regs = ll.rel.regulatory || [];

  const regHTML = regs.length ? regs.map((r) => {
    const refers = r.members.filter((m) => m.role === 'refers').map((m) => m.ref);
    const refLine = r.members.filter((m) => m.role === 'ref_line').map((m) => m.ref);
    return `<div class="sub">
      <div class="sub-h">${esc(r.tags.subtype || 'regulatory element')} <span class="id">#${esc(r.id)}</span></div>
      ${refers.length ? `<div class="kv"><span>refers</span><b>${refers.map(idLink).join(' ')}</b></div>` : ''}
      ${refLine.length ? `<div class="kv"><span>ref_line</span><b>${refLine.map(idLink).join(' ')}</b></div>` : ''}
    </div>`;
  }).join('') : '<div class="muted">none</div>';

  $('#inspector').innerHTML = `
    <div class="ins-head">
      <div class="ins-kind" data-cat="${ll.category}">lanelet · ${esc(ll.rel.tags.subtype || 'road')}</div>
      <div class="ins-id">#${esc(ll.rel.id)}</div>
    </div>
    <div class="metrics">
      <div><span>length</span><b>${ll.length.toFixed(1)} m</b></div>
      <div><span>mean width</span><b>${ll.width.toFixed(2)} m</b></div>
      <div><span>centre</span><b>${ll.center.x.toFixed(1)}, ${ll.center.y.toFixed(1)}</b></div>
    </div>
    <h4>Tags</h4>${tagRows(ll.rel.tags)}
    <h4>Left boundary ${idLink(ll.leftId)}</h4>${lw ? tagRows(lw.tags) + nodeCount(lw) : '<div class="muted">missing way</div>'}
    <h4>Right boundary ${idLink(ll.rightId)}</h4>${rw ? tagRows(rw.tags) + nodeCount(rw) : '<div class="muted">missing way</div>'}
    <h4>Regulatory elements</h4>${regHTML}
    <div class="ins-actions">
      <button class="btn sm" data-act="focus">Focus</button>
      <button class="btn sm" data-act="json">View JSON</button>
    </div>`;
  openInspector();
}

function nodeCount(w) {
  return `<div class="kv"><span>nodes</span><b>${w.refs.length}</b></div>`;
}
function idLink(id) { return `<a class="id-link" data-goto="${esc(id)}">#${esc(id)}</a>`; }

function showWay(wayId) {
  const w = V.osm.ways.get(String(wayId));
  if (!w) return;
  V.selection = { kind: 'way', wayId: String(wayId) };
  setHighlight(V.highlight, wayHighlightTris(wayId));
  const pts = wayPoints(V.osm, wayId) || [];
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  const zs = pts.map((p) => p[2]);
  const owners = V.lanelets.filter((l) => String(l.leftId) === String(wayId) || String(l.rightId) === String(wayId));

  $('#inspector').innerHTML = `
    <div class="ins-head">
      <div class="ins-kind" data-cat="way">way · ${esc(w.tags.type || 'untyped')}${w.tags.subtype ? ' / ' + esc(w.tags.subtype) : ''}</div>
      <div class="ins-id">#${esc(w.id)}</div>
    </div>
    <div class="metrics">
      <div><span>length</span><b>${len.toFixed(1)} m</b></div>
      <div><span>nodes</span><b>${pts.length}</b></div>
      <div><span>elevation</span><b>${zs.length ? Math.min(...zs).toFixed(2) + ' – ' + Math.max(...zs).toFixed(2) + ' m' : '—'}</b></div>
    </div>
    <h4>Tags</h4>${tagRows(w.tags)}
    <h4>Used by</h4>${owners.length
      ? owners.map((o) => `<div class="kv"><span>${o.rel.tags.subtype || 'lanelet'}</span><b>${idLink(o.rel.id)}</b></div>`).join('')
      : '<div class="muted">no lanelet references this way</div>'}
    <div class="ins-actions">
      <button class="btn sm" data-act="focus">Focus</button>
      <button class="btn sm" data-act="json">View JSON</button>
    </div>`;
  openInspector();
}

function openInspector() { $('#side-right').classList.add('open'); }
function clearSelection() {
  V.selection = null;
  V.highlight.visible = false;
  $('#side-right').classList.remove('open');
}

function focusSelection() {
  if (!V.selection) return;
  const box = new THREE.Box3();
  if (V.selection.kind === 'lanelet') {
    const t = V.lanelets[V.selection.index].tris;
    for (let i = 0; i < t.length; i += 3) box.expandByPoint(new THREE.Vector3(t[i], t[i + 1], t[i + 2]));
  } else {
    const pts = wayPoints(V.osm, V.selection.wayId) || [];
    pts.forEach((p) => box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2])));
  }
  APP.controls.fit(box, 2.4);
}

function selectionJSON() {
  if (!V.selection) return '{}';
  if (V.selection.kind === 'lanelet') {
    const ll = V.lanelets[V.selection.index];
    return JSON.stringify({
      id: ll.rel.id, type: 'lanelet', tags: ll.rel.tags,
      length_m: +ll.length.toFixed(3), mean_width_m: +ll.width.toFixed(3),
      left: { id: ll.leftId, tags: V.osm.ways.get(String(ll.leftId))?.tags },
      right: { id: ll.rightId, tags: V.osm.ways.get(String(ll.rightId))?.tags },
      regulatory: (ll.rel.regulatory || []).map((r) => ({ id: r.id, tags: r.tags, members: r.members })),
      centerline: ll.centerline.map((p) => p.map((v) => +v.toFixed(3))),
    }, null, 2);
  }
  const w = V.osm.ways.get(String(V.selection.wayId));
  return JSON.stringify({
    id: w.id, type: 'way', tags: w.tags,
    points: (wayPoints(V.osm, w.id) || []).map((p) => p.map((v) => +v.toFixed(3))),
  }, null, 2);
}

/* -------------------------------------------------------------- legend --- */

function renderTypeLegend(counts) {
  const order = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const colorFor = (k) => {
    const map = {
      line_thin: PALETTE.line_thin_solid, line_thick: PALETTE.line_thick,
      curbstone: PALETTE.curbstone, road_border: PALETTE.road_border, virtual: PALETTE.virtual,
      stop_line: PALETTE.stop_line, traffic_light: PALETTE.traffic_light, traffic_sign: PALETTE.traffic_sign,
      guard_rail: PALETTE.guard_rail, fence: PALETTE.fence, wall: PALETTE.wall,
    };
    return '#' + (map[k] ?? PALETTE.default).toString(16).padStart(6, '0');
  };
  $('#typeLegend').innerHTML = order.map(([k, v]) =>
    `<li><i style="background:${colorFor(k)}"></i><span>${esc(k)}</span><b>${nf(v)}</b></li>`).join('');
}

/* ------------------------------------------------------------ measuring - */

function updateMeasure() {
  if (V.measure.obj) { V.scene.remove(V.measure.obj); V.measure.obj.geometry.dispose(); V.measure.obj = null; }
  const p = V.measure.pts;
  if (p.length === 2) {
    const g = new THREE.BufferGeometry().setFromPoints(p);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffb454, depthTest: false }));
    l.renderOrder = 20;
    V.scene.add(l);
    V.measure.obj = l;
    const d = p[0].distanceTo(p[1]);
    const dxy = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
    $('#measureOut').innerHTML = `<b>${d.toFixed(3)} m</b><span>3D</span><b>${dxy.toFixed(3)} m</b><span>planar</span><b>${(p[1].z - p[0].z).toFixed(3)} m</b><span>Δz</span>`;
  } else {
    $('#measureOut').innerHTML = '<span class="muted">click two points</span>';
  }
}

/* ----------------------------------------------------------------- UI ---- */

function wireUI(canvas) {
  // ---- collapsible sidebar sections (click a heading to fold/unfold)
  $$('#side-left .sec > h3').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });

  // ---- files
  $('#fileInput').addEventListener('change', (e) => loadFiles(e.target.files));
  $$('.pick-files').forEach((b) => b.addEventListener('click', () => $('#fileInput').click()));
  $$('.load-demo').forEach((b) => b.addEventListener('click', loadDemo));

  // Display-only build: data is fixed in config.js, so drag-and-drop import
  // is disabled. Swallow file drops so the browser doesn't navigate away.
  const dz = $('#viewport');
  ['dragover', 'drop'].forEach((t) => dz.addEventListener(t, (e) => e.preventDefault()));

  // ---- layers
  $$('[data-layer]').forEach((cb) => cb.addEventListener('change', () => {
    const key = cb.dataset.layer;
    if (key === 'cloud') { if (V.cloud) V.cloud.visible = cb.checked; }
    else if (V.layers[key]) V.layers[key].visible = cb.checked;
  }));

  $('#mapOpacity').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (V.laneletMesh) V.laneletMesh.material.opacity = v;
    ['boundaries', 'stoplines', 'signals', 'arrows'].forEach((k) => {
      V.layers[k].children.forEach((c) => {
        c.material.transparent = true;
        c.material.opacity = Math.min(1, 0.35 + v * 0.85);
      });
    });
  });

  // ---- point cloud controls
  $('#colorMode').addEventListener('change', (e) => {
    APP.userPickedColor = true;
    recolorCloud(e.target.value);
    updateRamp();
  });
  $('#pointSize').addEventListener('input', (e) => {
    if (V.cloud) V.cloud.material.size = parseFloat(e.target.value);
    $('#pointSizeOut').textContent = parseFloat(e.target.value).toFixed(1);
  });
  $('#budget').addEventListener('change', rebuildCloud);
  ['x', 'y', 'z'].forEach((ax) => {
    $('#off' + ax.toUpperCase()).addEventListener('input', (e) => {
      V.offset[ax] = parseFloat(e.target.value) || 0;
      applyCloudOffset();
    });
  });
  $('#resetOffset').addEventListener('click', () => {
    ['x', 'y', 'z'].forEach((ax) => { V.offset[ax] = 0; $('#off' + ax.toUpperCase()).value = 0; });
    applyCloudOffset();
  });

  // ---- view
  $('#btnFit').addEventListener('click', fitAll);
  $('#btnTop').addEventListener('click', () => APP.controls.top());
  $('#btnIso').addEventListener('click', () => APP.controls.iso());
  $('#bgToggle').addEventListener('change', (e) => {
    const light = e.target.checked;
    V.scene.background = new THREE.Color(light ? 0xf2f4f7 : 0x0b0f14);
    V.layers.grid.material.opacity = light ? 0.35 : 1;
    V.layers.grid.material.transparent = true;
  });

  // ---- measure
  $('#btnMeasure').addEventListener('click', () => {
    V.measure.on = !V.measure.on;
    $('#btnMeasure').classList.toggle('active', V.measure.on);
    $('#measurePanel').classList.toggle('hidden', !V.measure.on);
    V.measure.pts = [];
    updateMeasure();
  });

  // ---- inspector actions (delegated)
  $('#side-right').addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act === 'focus') focusSelection();
    if (act === 'json') openModal('Selection', selectionJSON());
    const g = e.target.dataset.goto;
    if (g) gotoId(g);
  });
  $('#closeInspector').addEventListener('click', clearSelection);

  // ---- modal
  $('#modalClose').addEventListener('click', () => $('#modal').classList.remove('open'));
  $('#modalCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#modalBody').textContent); status('Copied to clipboard', 'ok'); }
    catch { status('Select the text and copy manually', 'warn'); }
  });

  // ---- picking
  let downX = 0, downY = 0;
  canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
  canvas.addEventListener('pointerup', (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return; // was a drag
    if (e.button !== 0) return;
    if (V.measure.on) {
      const p = groundPoint(e, canvas);
      const hit = pickLanelet(e, canvas);
      const pt = hit ? hit.point : p;
      if (V.measure.pts.length >= 2) V.measure.pts = [];
      V.measure.pts.push(pt.clone());
      updateMeasure();
      return;
    }
    // a click landing right on a boundary line means the line, even though the
    // lanelet surface underneath it would also be hit
    const wayHit = pickWay(e, canvas);
    const llHit = pickLanelet(e, canvas);
    if (wayHit && (!llHit || wayHit.score < 0.55)) { showWay(wayHit.wayId); return; }
    if (llHit) { showLanelet(llHit.index); return; }
    clearSelection();
  });

  let hoverRAF = null;
  canvas.addEventListener('pointermove', (e) => {
    const p = groundPoint(e, canvas);
    if (p) $('#coords').innerHTML = `<span>x</span>${p.x.toFixed(2)}<span>y</span>${p.y.toFixed(2)}`;
    if (hoverRAF) return;
    hoverRAF = requestAnimationFrame(() => {
      hoverRAF = null;
      const ch = pickChallenge(e, canvas);   // hover the dot / pin to read the difficulty
      if (ch) showTip(e, ch); else hideTip();
      const hit = pickLanelet(e, canvas);
      if (hit) {
        setHighlight(V.hoverHighlight, V.lanelets[hit.index].tris);
        canvas.style.cursor = 'pointer';
      } else {
        V.hoverHighlight.visible = false;
        canvas.style.cursor = ch ? 'pointer' : (V.measure.on ? 'crosshair' : 'grab');
      }
    });
  });

  // ---- keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'f') fitAll();
    if (e.key === 't') APP.controls.top();
    if (e.key === '3') APP.controls.iso();
    if (e.key === 'Escape') { clearSelection(); $('#modal').classList.remove('open'); }
    if (e.key === 'm') $('#btnMeasure').click();
    if (e.key === '[') $('#side-left').classList.toggle('collapsed');
  });
  $('#collapseLeft').addEventListener('click', () => $('#side-left').classList.toggle('collapsed'));
}

function groundPoint(ev, dom) {
  V.raycaster.setFromCamera(ndc(ev, dom), V.camera);
  const out = new THREE.Vector3();
  return V.raycaster.ray.intersectPlane(APP.plane, out) ? out : null;
}

function gotoId(id) {
  if (!id || !V.osm) return;
  id = id.replace(/^#/, '');
  const li = V.lanelets.findIndex((l) => String(l.rel.id) === id);
  if (li >= 0) { showLanelet(li); focusSelection(); return; }
  if (V.osm.ways.has(id)) { showWay(id); focusSelection(); return; }
  const rel = V.osm.relations.get(id);
  if (rel) {
    openModal('Relation #' + id, JSON.stringify({ id: rel.id, tags: rel.tags, members: rel.members }, null, 2));
    return;
  }
  const n = V.osm.nodes.get(id);
  if (n) {
    const b = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(n.x, n.y, n.z), new THREE.Vector3(20, 20, 20));
    APP.controls.fit(b);
    status(`Node #${id} at ${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)}`, 'ok');
    return;
  }
  status(`No lanelet, way, relation or node with id ${id}`, 'warn');
}

function openModal(title, body) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  $('#modalImg').classList.add('hidden');
  $('#modalBody').classList.remove('hidden');
  $('#modalCopy').classList.remove('hidden');
  $('#modal').classList.add('open');
}

let BOOTED = false;
function bootOnce() { if (BOOTED) return; BOOTED = true; boot(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootOnce);
else bootOnce();
