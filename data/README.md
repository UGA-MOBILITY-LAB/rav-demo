# Entry data

The site loads whatever `config.js` points at. Out of the box that is the
generated example map:

    osm: 'data/example.osm'
    pcd: 'data/example.pcd'

## Using your own map

1. Copy your files here, e.g. `data/campus.osm` and `data/campus.pcd`.
2. Edit `config.js` in the folder root:

       osm: 'data/campus.osm',
       pcd: 'data/campus.pcd',

3. Reload. Nothing needs rebuilding — `config.js` is a plain file next to
   `index.html`, so this also works on an already-deployed site.

You can also point at data per-visit without touching the config at all:

    https://your-site/?osm=data/campus.osm&pcd=data/campus.pcd

## Large point clouds

Anything the browser loads has to fit in memory, so about **500 MB is the
practical ceiling** for a single `.pcd`, and a slow connection will feel it
long before that. Options, cheapest first:

- **Lower the point budget.** `pointBudget` in `config.js` (or the Budget
  dropdown) decimates on load — the file still downloads in full.
- **Ship a gzipped copy.** `gzip -9 -k data/campus.pcd` and point the config at
  `data/campus.pcd.gz`; the viewer decompresses it in the browser. ASCII `.pcd`
  compresses ~5×, binary float data ~10 %.
- **Downsample the file itself.** A 5 cm voxel grid usually loses nothing that
  matters for map checking:

      pcl_voxel_grid campus.pcd campus_5cm.pcd -leaf 0.05,0.05,0.05

  or with Python:

      import open3d as o3d
      pc = o3d.io.read_point_cloud("campus.pcd")
      o3d.io.write_point_cloud("campus_5cm.pcd",
                               pc.voxel_down_sample(0.05), write_ascii=False)

- **Split by tile** and let visitors pick — one `.pcd` per area, each with its
  own link (`?pcd=data/tile_03.pcd`).

If you outgrow all of that, the next step is a real streaming format
(Potree / Entwine EPT, or 3D Tiles) served by a backend, which is a different
architecture from this folder.

## Coordinate frames

The viewer reads `local_x` / `local_y` / `ele` tags from the Lanelet2 nodes —
the metric map frame Autoware writes — and expects the `.pcd` to be in that
same frame. If the map floats above or beside the cloud, set `cloudOffset` in
`config.js` (or nudge the offset boxes in the Point cloud panel to find the
right numbers first). Maps with only `lat`/`lon` are projected to a local ENU
plane about their centroid, which is fine for viewing but will not line up with
a point cloud in a different frame.
