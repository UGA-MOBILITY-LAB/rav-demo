/* ============================================================================
   demo.js — procedurally generates a small example map so the page is useful
   before anyone loads a file. Produces a real Lanelet2 .osm string and a real
   binary .pcd ArrayBuffer, which are then fed through the same parsers as
   user data (so the demo also exercises the real code path).
   ==========================================================================*/

function buildDemoOSM() {
  let nid = 1, wid = 1000, rid = 5000;
  const nodes = [];
  const ways = [];
  const rels = [];

  const N = (x, y, z = 0) => {
    const id = nid++;
    nodes.push(
      `  <node id="${id}" lat="${(33.95 + y / 111320).toFixed(9)}" lon="${(-83.375 + x / 93000).toFixed(9)}">\n` +
      `    <tag k="local_x" v="${x.toFixed(3)}"/>\n` +
      `    <tag k="local_y" v="${y.toFixed(3)}"/>\n` +
      `    <tag k="ele" v="${z.toFixed(3)}"/>\n  </node>`
    );
    return id;
  };
  const W = (refs, tags) => {
    const id = wid++;
    ways.push(
      `  <way id="${id}">\n` + refs.map((r) => `    <nd ref="${r}"/>`).join('\n') + '\n' +
      Object.entries(tags).map(([k, v]) => `    <tag k="${k}" v="${v}"/>`).join('\n') + '\n  </way>'
    );
    return id;
  };
  const R = (members, tags) => {
    const id = rid++;
    rels.push(
      `  <relation id="${id}">\n` +
      members.map((m) => `    <member type="${m.type}" ref="${m.ref}" role="${m.role}"/>`).join('\n') + '\n' +
      Object.entries(tags).map(([k, v]) => `    <tag k="${k}" v="${v}"/>`).join('\n') + '\n  </relation>'
    );
    return id;
  };

  // gentle terrain so the 3D view has something to show
  const ground = (x, y) => 0.35 * Math.sin(x / 60) + 0.25 * Math.cos(y / 45);

  const LANE_W = 3.5;
  const SEG = 6;          // metres between boundary nodes
  const ARM = 90;         // arm length from intersection centre
  const HALF = 12;        // half-width of intersection box

  const lineWay = (pts, tags) => W(pts.map((p) => N(p[0], p[1], ground(p[0], p[1]))), tags);

  // sample a straight boundary line
  const sample = (x0, y0, x1, y1) => {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const k = Math.max(2, Math.round(d / SEG));
    const out = [];
    for (let i = 0; i <= k; i++) out.push([x0 + (x1 - x0) * i / k, y0 + (y1 - y0) * i / k]);
    return out;
  };

  const laneletIds = [];
  const makeArm = (dirX, dirY, name) => {
    // perpendicular unit
    const px = -dirY, py = dirX;
    const arms = [];
    // two lanes outbound (offset +0.5W,+1.5W,+2.5W) and two inbound (negative side)
    const laneDefs = [
      { inner: 0, outer: 1, oneway: 'yes', dir: 1, kind: 'outbound' },
      { inner: 1, outer: 2, oneway: 'yes', dir: 1, kind: 'outbound' },
      { inner: 0, outer: -1, oneway: 'yes', dir: -1, kind: 'inbound' },
      { inner: -1, outer: -2, oneway: 'yes', dir: -1, kind: 'inbound' },
    ];
    const start = HALF, end = ARM;
    const boundaryCache = new Map();
    const boundary = (offMult, subtype) => {
      const key = offMult + '|' + subtype;
      if (boundaryCache.has(key)) return boundaryCache.get(key);
      const o = offMult * LANE_W;
      const pts = sample(dirX * start + px * o, dirY * start + py * o, dirX * end + px * o, dirY * end + py * o);
      const type = Math.abs(offMult) === 2 ? 'curbstone' : 'line_thin';
      const tags = type === 'curbstone'
        ? { type: 'curbstone', subtype: 'low' }
        : { type: 'line_thin', subtype };
      const id = lineWay(pts, tags);
      boundaryCache.set(key, id);
      return id;
    };

    laneDefs.forEach((ld, i) => {
      const a = Math.min(ld.inner, ld.outer), b = Math.max(ld.inner, ld.outer);
      const subA = a === 0 ? 'solid' : 'dashed';
      const subB = b === 0 ? 'solid' : 'dashed';
      const leftId = boundary(ld.dir > 0 ? b : a, ld.dir > 0 ? subB : subA);
      const rightId = boundary(ld.dir > 0 ? a : b, ld.dir > 0 ? subA : subB);
      const id = R(
        [{ type: 'way', ref: leftId, role: 'left' }, { type: 'way', ref: rightId, role: 'right' }],
        {
          type: 'lanelet', subtype: 'road', location: 'urban', one_way: 'yes',
          speed_limit: '40 km/h', participant_vehicle: 'yes',
          lane_name: `${name}_${ld.kind}_${i}`,
        }
      );
      laneletIds.push(id);
      arms.push(id);
    });

    // stop line across the inbound lanes, at the intersection edge
    const s0 = [dirX * HALF + px * 0.2, dirY * HALF + py * 0.2];
    const s1 = [dirX * HALF + px * 2 * LANE_W, dirY * HALF + py * 2 * LANE_W];
    const stopId = lineWay(sample(s0[0], s0[1], s1[0], s1[1]), { type: 'stop_line' });

    // traffic light: a short horizontal linestring 5.2 m up, on the far side
    const tlx = dirX * (HALF + 2) + px * LANE_W;
    const tly = dirY * (HALF + 2) + py * LANE_W;
    const zt = ground(tlx, tly) + 5.2;
    const tlA = N(tlx - px * 0.35, tly - py * 0.35, zt);
    const tlB = N(tlx + px * 0.35, tly + py * 0.35, zt);
    const tlWay = W([tlA, tlB], { type: 'traffic_light', subtype: 'red_yellow_green', height: '0.9' });

    R(
      [{ type: 'way', ref: tlWay, role: 'refers' }, { type: 'way', ref: stopId, role: 'ref_line' }],
      { type: 'regulatory_element', subtype: 'traffic_light' }
    );

    // crosswalk just outside the stop line
    const cwOff = HALF + 3.5;
    const cw = 3.0;
    const cwLeft = lineWay(
      sample(dirX * cwOff - px * 2 * LANE_W, dirY * cwOff - py * 2 * LANE_W,
             dirX * cwOff + px * 2 * LANE_W, dirY * cwOff + py * 2 * LANE_W),
      { type: 'line_thin', subtype: 'solid' }
    );
    const cwRight = lineWay(
      sample(dirX * (cwOff + cw) - px * 2 * LANE_W, dirY * (cwOff + cw) - py * 2 * LANE_W,
             dirX * (cwOff + cw) + px * 2 * LANE_W, dirY * (cwOff + cw) + py * 2 * LANE_W),
      { type: 'line_thin', subtype: 'solid' }
    );
    const cwId = R(
      [{ type: 'way', ref: cwLeft, role: 'left' }, { type: 'way', ref: cwRight, role: 'right' }],
      { type: 'lanelet', subtype: 'crosswalk', participant_pedestrian: 'yes', one_way: 'no' }
    );
    laneletIds.push(cwId);
    return arms;
  };

  makeArm(1, 0, 'east');
  makeArm(-1, 0, 'west');
  makeArm(0, 1, 'north');
  makeArm(0, -1, 'south');

  // a few through-lanelets across the intersection box (virtual boundaries)
  const through = (ax, ay, bx, by, name, turn) => {
    const px = -(by - ay), py = (bx - ax);
    const L = Math.hypot(px, py) || 1;
    const ux = px / L, uy = py / L;
    const mid = [(ax + bx) / 2, (ay + by) / 2];
    const bend = [mid[0] * 0.55, mid[1] * 0.55];
    const curve = (o) => {
      const p0 = [ax + ux * o, ay + uy * o];
      const p2 = [bx + ux * o, by + uy * o];
      const p1 = [bend[0] + ux * o, bend[1] + uy * o];
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8, mt = 1 - t;
        pts.push([mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
                  mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]]);
      }
      return lineWay(pts, { type: 'virtual' });
    };
    const l = curve(LANE_W / 2), r = curve(-LANE_W / 2);
    const id = R(
      [{ type: 'way', ref: l, role: 'left' }, { type: 'way', ref: r, role: 'right' }],
      { type: 'lanelet', subtype: 'road', location: 'urban', one_way: 'yes', turn_direction: turn, lane_name: name }
    );
    laneletIds.push(id);
  };
  through(-HALF, LANE_W / 2, HALF, LANE_W / 2, 'wb_through', 'straight');
  through(HALF, -LANE_W / 2, -HALF, -LANE_W / 2, 'eb_through', 'straight');
  through(-LANE_W / 2, -HALF, -LANE_W / 2, HALF, 'nb_through', 'straight');
  through(LANE_W / 2, HALF, LANE_W / 2, -HALF, 'sb_through', 'straight');
  through(-HALF, LANE_W * 1.5, LANE_W * 1.5, HALF, 'wb_right', 'right');
  through(HALF, -LANE_W * 1.5, -LANE_W * 1.5, -HALF, 'eb_right', 'right');

  return `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="hdmap-viewer-demo">
${nodes.join('\n')}
${ways.join('\n')}
${rels.join('\n')}
</osm>`;
}

/** Synthetic LiDAR-ish point cloud matching the demo intersection. */
function buildDemoPCD() {
  const pts = [];
  const ground = (x, y) => 0.35 * Math.sin(x / 60) + 0.25 * Math.cos(y / 45);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  const inRoad = (x, y) => {
    const HALF = 12, W = 7.2;
    return (Math.abs(y) <= W && Math.abs(x) <= 95) || (Math.abs(x) <= W && Math.abs(y) <= 95)
      || (Math.abs(x) <= HALF && Math.abs(y) <= HALF);
  };

  // road + verge surface
  for (let i = 0; i < 190000; i++) {
    const x = (rnd() - 0.5) * 200, y = (rnd() - 0.5) * 200;
    const road = inRoad(x, y);
    if (!road && rnd() > 0.16) continue;
    const z = ground(x, y) + (road ? (rnd() - 0.5) * 0.03 : (rnd() - 0.5) * 0.18 + 0.06);
    let inten = road ? 22 + rnd() * 18 : 42 + rnd() * 34;
    // bright lane markings
    const lm = (v) => Math.abs(Math.abs(v) - 3.5) < 0.09 || Math.abs(v) < 0.09 || Math.abs(Math.abs(v) - 7.0) < 0.12;
    if (road && (lm(y) && Math.abs(x) > 12) || (road && lm(x) && Math.abs(y) > 12)) inten = 180 + rnd() * 60;
    pts.push([x, y, z, inten]);
  }
  // curbs
  for (let i = 0; i < 26000; i++) {
    const t = (rnd() - 0.5) * 190;
    const side = rnd() < 0.5 ? 1 : -1;
    const along = rnd() < 0.5;
    const h = rnd() * 0.15;
    if (Math.abs(t) < 13) continue;
    if (along) pts.push([t, side * 7.4 + (rnd() - 0.5) * 0.1, ground(t, side * 7.4) + h, 70 + rnd() * 30]);
    else pts.push([side * 7.4 + (rnd() - 0.5) * 0.1, t, ground(side * 7.4, t) + h, 70 + rnd() * 30]);
  }
  // building facades in the four quadrants
  const facade = (x0, y0, x1, y1, hgt) => {
    for (let i = 0; i < 22000; i++) {
      const t = rnd();
      const x = x0 + (x1 - x0) * t + (rnd() - 0.5) * 0.12;
      const y = y0 + (y1 - y0) * t + (rnd() - 0.5) * 0.12;
      const z = ground(x, y) + rnd() * hgt;
      pts.push([x, y, z, 90 + rnd() * 60]);
    }
  };
  facade(16, 14, 90, 14, 9);   facade(16, 14, 16, 88, 9);
  facade(-16, -14, -90, -14, 7); facade(-16, -14, -16, -88, 7);
  facade(-16, 14, -88, 14, 11);
  facade(16, -14, 88, -14, 6);
  // poles + traffic light masts + trees
  for (let p = 0; p < 26; p++) {
    const ang = rnd() * Math.PI * 2, rad = 14 + rnd() * 70;
    const cx = Math.cos(ang) * rad, cy = Math.sin(ang) * rad;
    if (inRoad(cx, cy)) continue;
    const hgt = 4 + rnd() * 4;
    for (let i = 0; i < 1400; i++) {
      const a = rnd() * Math.PI * 2, r = 0.12 + rnd() * 0.04;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, ground(cx, cy) + rnd() * hgt, 120 + rnd() * 40]);
    }
    if (rnd() < 0.5) { // canopy
      for (let i = 0; i < 2600; i++) {
        const a = rnd() * Math.PI * 2, r = (1.2 + rnd() * 1.6);
        const zz = hgt + rnd() * 2.6;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, ground(cx, cy) + zz, 40 + rnd() * 40]);
      }
    }
  }
  // parked vehicles
  for (let v = 0; v < 12; v++) {
    const along = rnd() < 0.5;
    const t = (rnd() - 0.5) * 150, side = rnd() < 0.5 ? 1 : -1;
    if (Math.abs(t) < 20) continue;
    const cx = along ? t : side * 5.2, cy = along ? side * 5.2 : t;
    for (let i = 0; i < 2200; i++) {
      const L = along ? 4.4 : 1.9, Wd = along ? 1.9 : 4.4;
      const x = cx + (rnd() - 0.5) * L, y = cy + (rnd() - 0.5) * Wd;
      const z = ground(cx, cy) + rnd() * 1.5;
      pts.push([x, y, z, 150 + rnd() * 80]);
    }
  }

  // --- encode as a real binary PCD so it goes through the same parser -------
  const n = pts.length;
  const header =
    `# .PCD v0.7 - Point Cloud Data file format (viewer demo)\nVERSION 0.7\n` +
    `FIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\n` +
    `WIDTH ${n}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${n}\nDATA binary\n`;
  const enc = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(enc.length + n * 16);
  new Uint8Array(buf).set(enc, 0);
  const dv = new DataView(buf, enc.length);
  for (let i = 0; i < n; i++) {
    dv.setFloat32(i * 16, pts[i][0], true);
    dv.setFloat32(i * 16 + 4, pts[i][1], true);
    dv.setFloat32(i * 16 + 8, pts[i][2], true);
    dv.setFloat32(i * 16 + 12, pts[i][3], true);
  }
  return buf;
}
