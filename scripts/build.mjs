/* Builds dist/ — the folder you upload to a web server.
   Run: npm run build                                                        */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const kb = (n) => (n / 1024 >= 1024 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });

const SRC = ['src/parsers.js', 'src/demo.js', 'src/viewer.js', 'src/loader.js', 'src/app.js'];
const appJs = [read('vendor/three.min.js'), ...SRC.map(read)].join('\n;\n');
const css = read('src/styles.css');

fs.writeFileSync(path.join(dist, 'assets/app.js'), appJs);
fs.writeFileSync(path.join(dist, 'assets/styles.css'), css);

/* index.html: swap the dev script/style tags for the bundle ---------------- */
let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="src/styles.css">', '<link rel="stylesheet" href="assets/styles.css">');
const devTags = /<script src="vendor\/three\.min\.js"><\/script>[\s\S]*?<script src="src\/app\.js"><\/script>/;
if (!devTags.test(html)) throw new Error('index.html script block not found — did the tag list change?');
html = html.replace(devTags, '<script src="assets/app.js"></script>');
fs.writeFileSync(path.join(dist, 'index.html'), html);

/* config.js stays a separate, editable file in the deployed folder --------- */
fs.copyFileSync(path.join(root, 'config.js'), path.join(dist, 'config.js'));

/* brand logo (optional) — shown next to the title in the top bar ----------- */
if (fs.existsSync(path.join(root, 'logo.png'))) {
  fs.copyFileSync(path.join(root, 'logo.png'), path.join(dist, 'logo.png'));
}

/* .nojekyll: stops GitHub Pages from running Jekyll on a branch deploy, which
   would drop any file or folder beginning with an underscore.               */
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

/* data ------------------------------------------------------------------- */
fs.cpSync(path.join(root, 'data'), path.join(dist, 'data'), { recursive: true });

/* standalone.html: one file, no server, no entry data (open from disk) ----- */
/* NB: pass replacements as functions — the bundle contains $-sequences that
   String.replace would otherwise treat as $&/$' substitution patterns.       */
const sub = (s, needle, replacement) => {
  if (!s.includes(needle)) throw new Error('build: could not find ' + needle);
  return s.replace(needle, () => replacement);
};
let standalone = sub(html, '<link rel="stylesheet" href="assets/styles.css">', '<style>\n' + css + '\n</style>');
standalone = sub(standalone, '<script src="config.js"></script>',
  '<script>window.LANELET_CONFIG = { autoload: false, osm: null, pcd: null };</script>');
standalone = sub(standalone, '<script src="assets/app.js"></script>', '<script>\n' + appJs + '\n</script>');
fs.writeFileSync(path.join(dist, 'standalone.html'), standalone);

/* artifact.html: the same single-file page without the document wrapper, for
   publishers that supply their own <head> (e.g. Claude Artifacts).          */
const fonts = /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/.exec(html)[0];
const inner = standalone.slice(standalone.indexOf('<body>') + 6, standalone.lastIndexOf('</body>'));
fs.writeFileSync(path.join(dist, 'artifact.html'),
  '<title>Lanelet Inspector</title>\n' + fonts + '\n' + inner.trim() + '\n');

/* pre-compressed copies for servers that can serve them (nginx gzip_static) */
for (const rel of ['assets/app.js', 'assets/styles.css', 'index.html', 'data/example.osm', 'data/example.pcd']) {
  const p = path.join(dist, rel);
  if (fs.existsSync(p)) fs.writeFileSync(p + '.gz', zlib.gzipSync(fs.readFileSync(p), { level: 9 }));
}

const list = (d, pre = '') => fs.readdirSync(path.join(dist, d), { withFileTypes: true }).forEach((e) => {
  const rel = path.join(d, e.name);
  if (e.isDirectory()) list(rel, pre + '  ');
  else console.log(`  ${rel.padEnd(28)} ${kb(fs.statSync(path.join(dist, rel)).size)}`);
});
console.log('dist/');
list('.');
