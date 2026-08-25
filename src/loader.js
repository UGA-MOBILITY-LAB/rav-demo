/* ============================================================================
   loader.js — fetches the entry data configured in config.js, with download
   progress and transparent gzip support.
   ==========================================================================*/

const CFG = Object.assign({
  title: 'Lanelet·Inspector',
  subtitle: 'HD map + point cloud',
  osm: null, pcd: null, challenges: null, autoload: false,
  pointBudget: 2500000, pointSize: 1.6, colorMode: 'auto',
  mapOpacity: 0.42, lightBackground: false,
  cloudOffset: { x: 0, y: 0, z: 0 },
}, window.LANELET_CONFIG || {});

const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB');

async function gunzip(u8) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser cannot decompress .gz — serve the plain file instead');
  }
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Fetch a URL as an ArrayBuffer, reporting progress and un-gzipping .gz. */
async function fetchBuffer(url, onProgress) {
  const res = await fetch(url, { cache: 'default' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  const total = parseInt(res.headers.get('content-length') || '0', 10);

  let bytes;
  if (!res.body || !res.body.getReader) {
    bytes = new Uint8Array(await res.arrayBuffer());
    onProgress && onProgress(bytes.length, bytes.length);
  } else {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress && onProgress(received, total);
    }
    bytes = new Uint8Array(received);
    let o = 0;
    for (const c of chunks) { bytes.set(c, o); o += c.length; }
  }

  // Only decompress by hand when the server handed us the raw .gz bytes; if it
  // set Content-Encoding: gzip, fetch already did it (magic number check).
  if (/\.gz$/i.test(new URL(url, location.href).pathname) && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = await gunzip(bytes);
  }
  return bytes.buffer;
}
