/* ============================================================================
   config.js — edit this file to point the site at your own map.
   It is loaded before the app and is NOT bundled, so the entry data of a
   deployed site can be changed without rebuilding anything.
   ==========================================================================*/

window.LANELET_CONFIG = {
  /* Text shown in the top bar. */
  title: 'UGA Demo',
  subtitle: 'example point map and hdmap',

  /* ---- entry data -------------------------------------------------------
     Paths are relative to index.html. Set either one to null to skip it.
     Gzipped assets are supported and decompressed in the browser: point at
     'data/pointcloud.pcd.gz' if your web server does not gzip on the fly.  */
  osm: 'data/26-08-04-22-14-42-lanelet2_map.osm',
  pcd: 'data/fastlio_whole_0.4m_mapframe_refl_mgrs.pcd',

  /* Route challenges overlaid on the map (categorised difficulty callouts).
     Set to null to hide the layer. Edit data/challenges.json to change them. */
  challenges: 'data/challenges.json',

  /* Load the entry data automatically when the page opens.
     false = show the drop zone and wait for the visitor to pick files.     */
  autoload: true,

  /* ---- viewer defaults -------------------------------------------------- */
  pointBudget: 2500000,      // points drawn at once; lower for weak GPUs
  pointSize: 1.6,            // screen pixels
  colorMode: 'auto',         // 'auto' | 'intensity' | 'height' | 'rgb' | 'flat'
  mapOpacity: 0.42,          // lanelet surface fill
  lightBackground: false,

  /* Offset applied to the point cloud if it does not share the map frame. */
  cloudOffset: { x: 0, y: 0, z: 0 },
};

/* ---- URL overrides ---------------------------------------------------------
   Any key above can be overridden with a query string, which makes it easy to
   share a link to one specific map:
       index.html?osm=data/campus.osm&pcd=data/campus.pcd.gz
       index.html?autoload=0
       index.html?colorMode=height&pointSize=2.4
   -------------------------------------------------------------------------*/
(function applyUrlOverrides() {
  const q = new URLSearchParams(location.search);
  const C = window.LANELET_CONFIG;
  const num = (k) => { if (q.has(k)) { const v = parseFloat(q.get(k)); if (isFinite(v)) C[k] = v; } };
  const str = (k) => { if (q.has(k)) C[k] = q.get(k); };
  const bool = (k) => { if (q.has(k)) C[k] = !/^(0|false|no)$/i.test(q.get(k)); };
  ['osm', 'pcd', 'title', 'subtitle', 'colorMode'].forEach(str);
  ['pointBudget', 'pointSize', 'mapOpacity'].forEach(num);
  ['autoload', 'lightBackground'].forEach(bool);
})();
