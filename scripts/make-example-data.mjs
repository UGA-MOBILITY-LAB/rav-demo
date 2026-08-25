/* Generates data/example.osm and data/example.pcd from src/demo.js so the site
   ships with working entry data. Run: npm run data                          */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = fs.readFileSync(path.join(root, 'src/demo.js'), 'utf8');
const { buildDemoOSM, buildDemoPCD } = new Function(
  code + '\nreturn { buildDemoOSM, buildDemoPCD };'
)();

const outDir = path.join(root, 'data');
fs.mkdirSync(outDir, { recursive: true });

const osm = buildDemoOSM();
fs.writeFileSync(path.join(outDir, 'example.osm'), osm);

const pcd = Buffer.from(buildDemoPCD());
fs.writeFileSync(path.join(outDir, 'example.pcd'), pcd);

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('data/example.osm ' + kb(Buffer.byteLength(osm)));
console.log('data/example.pcd ' + kb(pcd.length));
