/* ============================================================================
   parsers.js — Lanelet2 (.osm) and Point Cloud Data (.pcd) parsing
   ==========================================================================*/

/* ---------------------------------------------------------------- OSM ---- */

function readTags(el) {
  const tags = {};
  for (const t of el.children) {
    if (t.nodeName === 'tag') tags[t.getAttribute('k')] = t.getAttribute('v');
  }
  return tags;
}

/**
 * Parse a Lanelet2 / OSM XML string.
 * Coordinate handling:
 *   - Autoware-style maps carry local_x / local_y tags on each node -> use directly
 *     (these are already metric, in the same frame as the .pcd map).
 *   - Plain OSM maps only carry lat/lon -> project to a local ENU tangent plane
 *     centred on the mean lat/lon.
 */
function parseOSM(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML parse error: ' + err.textContent.slice(0, 200));

  const nodes = new Map();
  let haveLocal = 0, haveLatLon = 0;
  let latSum = 0, lonSum = 0, llCount = 0;

  for (const n of doc.getElementsByTagName('node')) {
    const id = n.getAttribute('id');
    const tags = readTags(n);
    const lat = n.hasAttribute('lat') ? parseFloat(n.getAttribute('lat')) : null;
    const lon = n.hasAttribute('lon') ? parseFloat(n.getAttribute('lon')) : null;
    const rec = { id, tags, lat, lon, x: null, y: null, z: 0 };

    if (tags.local_x !== undefined && tags.local_y !== undefined) {
      rec.x = parseFloat(tags.local_x);
      rec.y = parseFloat(tags.local_y);
      haveLocal++;
    } else if (lat !== null && lon !== null && isFinite(lat) && isFinite(lon)) {
      haveLatLon++;
      latSum += lat; lonSum += lon; llCount++;
    }
    if (tags.ele !== undefined) rec.z = parseFloat(tags.ele) || 0;
    else if (tags.local_z !== undefined) rec.z = parseFloat(tags.local_z) || 0;
    nodes.set(id, rec);
  }

  let frame = 'local_xy';
  if (haveLocal === 0 && llCount > 0) {
    // equirectangular projection about the map centroid — good to <1cm over a
    // few km, which is the scale HD maps live at.
    frame = 'enu_from_latlon';
    const lat0 = latSum / llCount, lon0 = lonSum / llCount;
    const R = 6378137.0;
    const k = Math.PI / 180;
    for (const n of nodes.values()) {
      if (n.lat === null) continue;
      n.x = R * (n.lon - lon0) * k * Math.cos(lat0 * k);
      n.y = R * (n.lat - lat0) * k;
    }
  }
  for (const n of nodes.values()) {
    if (n.x === null || !isFinite(n.x)) { n.x = 0; n.y = 0; }
  }

  const ways = new Map();
  for (const w of doc.getElementsByTagName('way')) {
    const id = w.getAttribute('id');
    const refs = [];
    for (const c of w.children) if (c.nodeName === 'nd') refs.push(c.getAttribute('ref'));
    ways.set(id, { id, refs, tags: readTags(w) });
  }

  const relations = new Map();
  for (const r of doc.getElementsByTagName('relation')) {
    const id = r.getAttribute('id');
    const members = [];
    for (const c of r.children) {
      if (c.nodeName === 'member') {
        members.push({
          type: c.getAttribute('type'),
          ref: c.getAttribute('ref'),
          role: c.getAttribute('role') || '',
        });
      }
    }
    relations.set(id, { id, members, tags: readTags(r) });
  }

  // ---- classify -----------------------------------------------------------
  const lanelets = [];
  const areas = [];
  const regulatory = [];
  for (const rel of relations.values()) {
    const t = rel.tags.type;
    if (t === 'lanelet') lanelets.push(rel);
    else if (t === 'multipolygon') areas.push(rel);
    else if (t === 'regulatory_element') regulatory.push(rel);
  }

  // map: lanelet id -> regulatory element relations that it refers to
  const regById = new Map(regulatory.map((r) => [r.id, r]));
  for (const ll of lanelets) {
    ll.regulatory = ll.members
      .filter((m) => m.role === 'regulatory_element')
      .map((m) => regById.get(m.ref))
      .filter(Boolean);
  }

  return {
    nodes, ways, relations, lanelets, areas, regulatory, frame,
    stats: {
      nodes: nodes.size, ways: ways.size, relations: relations.size,
      lanelets: lanelets.length, regulatory: regulatory.length, areas: areas.length,
      haveLocal, haveLatLon,
    },
  };
}

/* ---------------------------------------------------------------- PCD ---- */

/** LZF decompression (used by PCD `binary_compressed`). */
function lzfDecompress(input, outLength) {
  const out = new Uint8Array(outLength);
  let ip = 0, op = 0;
  const inLength = input.length;
  while (ip < inLength) {
    let ctrl = input[ip++];
    if (ctrl < 32) {
      ctrl++;
      if (op + ctrl > outLength) throw new Error('LZF: output overrun');
      while (ctrl--) out[op++] = input[ip++];
    } else {
      let len = ctrl >> 5;
      let ref = op - ((ctrl & 0x1f) << 8) - 1;
      if (ip >= inLength) throw new Error('LZF: input overrun');
      if (len === 7) {
        len += input[ip++];
        if (ip >= inLength) throw new Error('LZF: input overrun');
      }
      ref -= input[ip++];
      if (op + len + 2 > outLength) throw new Error('LZF: output overrun');
      if (ref < 0) throw new Error('LZF: invalid back-reference');
      out[op++] = out[ref++];
      out[op++] = out[ref++];
      while (len--) out[op++] = out[ref++];
    }
  }
  return out;
}

function parsePCDHeader(buffer) {
  // The header is ASCII and always ends with a "DATA <mode>\n" line.
  const probe = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1 << 16));
  const text = new TextDecoder('ascii').decode(probe);
  const m = /[\r\n]DATA\s+(\S+)\s*\n/i.exec('\n' + text);
  if (!m) throw new Error('Not a PCD file (no DATA line found in the first 64 KB).');
  const headerEnd = m.index + m[0].length - 1; // -1 for the '\n' we prepended
  const header = text.slice(0, headerEnd);

  const get = (key) => {
    const r = new RegExp('^\\s*' + key + '\\s+(.*)$', 'im').exec(header);
    return r ? r[1].trim() : null;
  };
  const fields = (get('FIELDS') || get('COLUMNS') || '').split(/\s+/).filter(Boolean);
  const size = (get('SIZE') || '').split(/\s+/).filter(Boolean).map(Number);
  const type = (get('TYPE') || '').split(/\s+/).filter(Boolean);
  const count = (get('COUNT') || '').split(/\s+/).filter(Boolean).map(Number);
  const width = parseInt(get('WIDTH') || '0', 10);
  const height = parseInt(get('HEIGHT') || '1', 10);
  const pointsHdr = parseInt(get('POINTS') || '0', 10);
  const points = pointsHdr || width * (height || 1);
  const data = m[1].toLowerCase();

  const cnt = fields.map((_, i) => (count[i] || 1));
  const offsets = {};
  let rowSize = 0;
  fields.forEach((f, i) => {
    offsets[f] = rowSize;
    rowSize += (size[i] || 4) * cnt[i];
  });

  return { fields, size, type, count: cnt, width, height, points, data, offsets, rowSize, headerEnd, headerText: header };
}

/**
 * Parse a .pcd ArrayBuffer.
 * @returns {{position:Float32Array, intensity:Float32Array|null, rgb:Float32Array|null,
 *            count:number, header:object, bbox:object}}
 */
function parsePCD(buffer, opts = {}) {
  const maxPoints = opts.maxPoints || Infinity;
  const h = parsePCDHeader(buffer);
  if (!('x' in h.offsets && 'y' in h.offsets && 'z' in h.offsets)) {
    throw new Error('PCD has no x/y/z fields (FIELDS = ' + h.fields.join(' ') + ')');
  }

  const total = h.points;
  const stride = Math.max(1, Math.ceil(total / maxPoints));
  const n = Math.floor((total + stride - 1) / stride);

  const position = new Float32Array(n * 3);
  const hasI = 'intensity' in h.offsets;
  const hasRGB = 'rgb' in h.offsets || 'rgba' in h.offsets;
  const intensity = hasI ? new Float32Array(n) : null;
  const rgb = hasRGB ? new Float32Array(n * 3) : null;

  const idx = (f) => h.fields.indexOf(f);
  const readerFor = (field, dv, base) => {
    const i = idx(field);
    const sz = h.size[i], ty = (h.type[i] || 'F').toUpperCase();
    const off = base + h.offsets[field];
    if (ty === 'F') return sz === 8 ? dv.getFloat64(off, true) : dv.getFloat32(off, true);
    if (ty === 'U') return sz === 1 ? dv.getUint8(off) : sz === 2 ? dv.getUint16(off, true) : dv.getUint32(off, true);
    return sz === 1 ? dv.getInt8(off) : sz === 2 ? dv.getInt16(off, true) : dv.getInt32(off, true);
  };

  let bb = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  let iMin = Infinity, iMax = -Infinity;
  let w = 0;

  const push = (x, y, z, ii, r, g, b) => {
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
    position[w * 3] = x; position[w * 3 + 1] = y; position[w * 3 + 2] = z;
    if (x < bb.minX) bb.minX = x; if (x > bb.maxX) bb.maxX = x;
    if (y < bb.minY) bb.minY = y; if (y > bb.maxY) bb.maxY = y;
    if (z < bb.minZ) bb.minZ = z; if (z > bb.maxZ) bb.maxZ = z;
    if (intensity) { intensity[w] = ii; if (ii < iMin) iMin = ii; if (ii > iMax) iMax = ii; }
    if (rgb) { rgb[w * 3] = r; rgb[w * 3 + 1] = g; rgb[w * 3 + 2] = b; }
    w++;
  };

  if (h.data === 'ascii') {
    const text = new TextDecoder('ascii').decode(new Uint8Array(buffer, h.headerEnd));
    const lines = text.split('\n');
    const xi = idx('x'), yi = idx('y'), zi = idx('z'), ii = idx('intensity');
    const ri = idx('rgb') >= 0 ? idx('rgb') : idx('rgba');
    let seen = 0;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].trim();
      if (!line) continue;
      if (seen++ % stride !== 0) continue;
      const p = line.split(/\s+/);
      let r = 0, g = 0, b = 0;
      if (ri >= 0) { const packed = parseFloat(p[ri]) | 0; r = ((packed >> 16) & 255) / 255; g = ((packed >> 8) & 255) / 255; b = (packed & 255) / 255; }
      push(+p[xi], +p[yi], +p[zi], ii >= 0 ? +p[ii] : 0, r, g, b);
      if (w >= n) break;
    }
  } else if (h.data === 'binary') {
    const dv = new DataView(buffer, h.headerEnd);
    for (let i = 0; i < total; i += stride) {
      const base = i * h.rowSize;
      if (base + h.rowSize > dv.byteLength) break;
      let r = 0, g = 0, b = 0;
      if (hasRGB) {
        const f = 'rgb' in h.offsets ? 'rgb' : 'rgba';
        const off = base + h.offsets[f];
        b = dv.getUint8(off) / 255; g = dv.getUint8(off + 1) / 255; r = dv.getUint8(off + 2) / 255;
      }
      push(
        readerFor('x', dv, base), readerFor('y', dv, base), readerFor('z', dv, base),
        hasI ? readerFor('intensity', dv, base) : 0, r, g, b,
      );
      if (w >= n) break;
    }
  } else if (h.data === 'binary_compressed') {
    const dv0 = new DataView(buffer, h.headerEnd);
    const compressedSize = dv0.getUint32(0, true);
    const decompressedSize = dv0.getUint32(4, true);
    const src = new Uint8Array(buffer, h.headerEnd + 8, compressedSize);
    const raw = lzfDecompress(src, decompressedSize);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    // binary_compressed is stored field-major (all x, then all y, ...)
    const fieldBase = {};
    let acc = 0;
    h.fields.forEach((f, i) => { fieldBase[f] = acc; acc += (h.size[i] || 4) * h.count[i] * total; });
    const rd = (field, i) => {
      const fi = idx(field), sz = h.size[fi], ty = (h.type[fi] || 'F').toUpperCase();
      const off = fieldBase[field] + i * sz * h.count[fi];
      if (ty === 'F') return sz === 8 ? dv.getFloat64(off, true) : dv.getFloat32(off, true);
      if (ty === 'U') return sz === 1 ? dv.getUint8(off) : sz === 2 ? dv.getUint16(off, true) : dv.getUint32(off, true);
      return sz === 1 ? dv.getInt8(off) : sz === 2 ? dv.getInt16(off, true) : dv.getInt32(off, true);
    };
    for (let i = 0; i < total; i += stride) {
      let r = 0, g = 0, b = 0;
      if (hasRGB) {
        const f = 'rgb' in h.offsets ? 'rgb' : 'rgba';
        const fi = idx(f);
        const off = fieldBase[f] + i * h.size[fi] * h.count[fi];
        b = dv.getUint8(off) / 255; g = dv.getUint8(off + 1) / 255; r = dv.getUint8(off + 2) / 255;
      }
      push(rd('x', i), rd('y', i), rd('z', i), hasI ? rd('intensity', i) : 0, r, g, b);
      if (w >= n) break;
    }
  } else {
    throw new Error('Unsupported PCD DATA mode: ' + h.data);
  }

  return {
    position: position.subarray(0, w * 3),
    intensity: intensity ? intensity.subarray(0, w) : null,
    rgb: rgb ? rgb.subarray(0, w * 3) : null,
    count: w,
    totalInFile: total,
    stride,
    header: h,
    bbox: bb,
    intensityRange: [iMin, iMax],
  };
}
