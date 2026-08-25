/* Tiny static server for local development and for smoke-testing dist/.
   Usage:  node server.mjs [dir] [port]        (npm start / npm run serve)   */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';

const dir = path.resolve(process.argv[2] || '.');
const port = parseInt(process.argv[3] || process.env.PORT || '8080', 10);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.osm': 'application/xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pcd': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.osm', '.xml', '.pcd', '.svg']);
// Source/text assets that should never be served stale during local dev.
const NO_CACHE = new Set(['.html', '.js', '.css', '.json', '.osm', '.xml', '.svg']);

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(dir, url);
  if (!file.startsWith(dir)) { res.writeHead(403).end('forbidden'); return; }
  // a directory serves its index.html — mirrors how GitHub Pages and nginx
  // resolve https://host/some/subpath/
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      // Code/text revalidates every load so edits show up on a normal reload;
      // big binaries (.pcd, images) stay cached so they aren't re-downloaded.
      'Cache-Control': NO_CACHE.has(ext) ? 'no-cache' : 'public, max-age=3600',
    };
    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && COMPRESSIBLE.has(ext);
    if (wantsGzip) headers['Content-Encoding'] = 'gzip';
    else headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file);
    if (wantsGzip) pipeline(stream, zlib.createGzip({ level: 6 }), res, () => {});
    else pipeline(stream, res, () => {});
  });
}).listen(port, () => {
  console.log(`serving ${dir}\n  http://localhost:${port}`);
});
