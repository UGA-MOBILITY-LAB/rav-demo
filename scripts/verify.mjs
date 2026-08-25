import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const dir = process.argv[2] || 'dist';
const port = 8123;
const srv = spawn('node', ['server.mjs', dir, String(port)], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.googleapis/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelector('#dropzone')?.classList.contains('hidden'), { timeout: 30000 });
await page.waitForTimeout(1200);

console.log('autoloaded:', await page.evaluate(() => ({
  map: document.querySelector('#mapName').textContent,
  lanelets: document.querySelector('#statLanelets').textContent,
  cloud: document.querySelector('#cloudName').textContent,
  points: document.querySelector('#statPoints').textContent,
  encoding: document.querySelector('#statDataMode').textContent,
  colorMode: document.querySelector('#colorMode').value,
  title: document.title,
})));
await page.screenshot({ path: 'shot-dist-autoload.png' });

// url override: point budget + colour mode + no autoload
await page.goto(`http://localhost:${port}/?autoload=0&colorMode=height&pointSize=3`, { waitUntil: 'load' });
await page.waitForTimeout(500);
console.log('override:', await page.evaluate(() => ({
  dropzoneVisible: !document.querySelector('#dropzone').classList.contains('hidden'),
  colorMode: document.querySelector('#colorMode').value,
  pointSize: document.querySelector('#pointSize').value,
})));

// gzipped entry data path
await page.goto(`http://localhost:${port}/?osm=data/example.osm.gz&pcd=data/example.pcd.gz`, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelector('#dropzone')?.classList.contains('hidden'), { timeout: 30000 });
console.log('gz entry:', await page.evaluate(() => ({
  map: document.querySelector('#mapName').textContent,
  lanelets: document.querySelector('#statLanelets').textContent,
  points: document.querySelector('#statPoints').textContent,
})));

// served from a subpath, exactly like a GitHub project page
import fsx from 'node:fs';
fsx.rmSync('/tmp/_subpath', { recursive: true, force: true });
fsx.mkdirSync('/tmp/_subpath/repo-name', { recursive: true });
fsx.cpSync(dir, '/tmp/_subpath/repo-name', { recursive: true });
const srv2 = spawn('node', ['server.mjs', '/tmp/_subpath', String(port + 1)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const sub = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const subFails = [];
sub.on('response', (r) => { if (r.status() >= 400) subFails.push(r.status() + ' ' + r.url()); });
await sub.goto(`http://localhost:${port + 1}/repo-name/`, { waitUntil: 'load' });
await sub.waitForFunction(() => document.querySelector('#dropzone')?.classList.contains('hidden'), { timeout: 30000 });
console.log('subpath:', await sub.evaluate(() => ({
  lanelets: document.querySelector('#statLanelets').textContent,
  points: document.querySelector('#statPoints').textContent,
})), subFails.length ? subFails : '(no 4xx)');
await sub.close();
srv2.kill();

// standalone.html still works with no server data
await page.goto(`http://localhost:${port}/standalone.html`, { waitUntil: 'load' });
await page.waitForTimeout(400);
await page.click('.dz-actions .load-demo');
await page.waitForTimeout(2500);
console.log('standalone:', await page.evaluate(() => ({
  lanelets: document.querySelector('#statLanelets').textContent,
  points: document.querySelector('#statPoints').textContent,
})));

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
srv.kill();
