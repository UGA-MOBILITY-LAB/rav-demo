# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A **static, dependency-free web viewer** for Lanelet2 HD maps (`.osm`) and LiDAR
point clouds (`.pcd`). Everything parses and renders in the browser; the server
only serves files. Built for the UGA Mobility Lab to inspect HD maps against the
point cloud they were built from.

Current scope is **view and inspect only** — no editing, no write-back. Editing
is the planned v2 (see *Adding editing* below).

## Commands

```bash
npm start        # dev server on :8080, serves the repo root (src/ loaded unbundled)
npm run data     # regenerate data/example.osm + data/example.pcd from src/demo.js
npm run build    # write dist/ (bundle, config, data, standalone.html, artifact.html, .gz siblings)
npm run serve    # serve dist/ on :8080 — always test this before deploying
npm run preview  # build + serve

node scripts/verify.mjs        # headless smoke test of dist/ (needs: npm i -D playwright)
```

There is no bundler, no framework, no transpiler and **no runtime npm
dependencies**. `vendor/three.min.js` (r160, UMD, global `THREE`) is committed.
Keep it that way — the whole point is that this deploys as a folder.

## Architecture

Load order matters; each file is a plain `<script>` populating globals.

| File | Responsibility |
|---|---|
| `config.js` | Entry data paths + defaults. **Never bundled** — it must stay editable on a deployed site. Applies `?query=` overrides. |
| `src/parsers.js` | `parseOSM(text)` → `{nodes, ways, relations, lanelets, regulatory, frame}`. `parsePCD(buffer, {maxPoints})` → typed arrays. `lzfDecompress` for `binary_compressed`. Pure functions, no DOM, no three.js. |
| `src/viewer.js` | The `V` global: scene, camera, custom orbit controls, `buildMap()`, `buildCloud()`, picking. Owns all three.js. |
| `src/loader.js` | `CFG` (merged config) + `fetchBuffer()` with progress and gzip. |
| `src/app.js` | The `APP` global: UI wiring, inspector rendering, measure, search, entry-data autoload. Owns all DOM. |
| `src/demo.js` | Procedural example map. Used by the "Example map" button *and* by `npm run data`. |

**Layer boundary to respect:** `parsers.js` knows nothing about three.js;
`viewer.js` knows nothing about the DOM; `app.js` is the only file that touches
`document`. The one deliberate exception is `V.rampInfo`, which `viewer.js` sets
for `app.js` to render the colour legend.

**Coordinate frame:** Z-up throughout (`camera.up = (0,0,1)`), metres. Lanelet2
nodes use their `local_x` / `local_y` / `ele` tags when present — that is
Autoware's map frame and matches the `.pcd`. Maps with only `lat`/`lon` get an
equirectangular projection about their centroid (`frame === 'enu_from_latlon'`),
which is fine for viewing but will not align with a point cloud.

**Performance invariants** — do not break these when adding features:
- Lanelet surfaces are **one merged mesh**; `V.laneletFaceIndex[faceIndex]`
  maps a raycast hit back to a lanelet. Never one mesh per lanelet.
- Boundaries are **one merged `LineSegments`**; they are picked on the CPU by
  `pickWay()` scanning `V.segPos` / `V.segMeta`. Never one `Line` per way.
- Point clouds are decimated at parse time by `maxPoints` (stride sampling), not
  after upload to the GPU.

## Gotchas that have already cost time

1. **`String.replace` with a `$` in the replacement.** The minified three.js
   bundle contains `$&`-like sequences. `scripts/build.mjs` must pass
   replacements as *functions* (`s.replace(needle, () => value)`), or chunks of
   the document get spliced into `standalone.html`. There is a `sub()` helper —
   use it.
2. **PCD `binary_compressed` is field-major**, not row-major: all x, then all y,
   then all z. Row-major decoding silently produces a garbage cloud, not an error.
3. **`file://` cannot `fetch()`.** Autoload only works over http. `npm start`,
   or use `dist/standalone.html`, which has autoload off by design.
4. **`.pcd` needs an explicit MIME type.** Several servers 404 or mis-serve
   unknown extensions; `deploy/nginx.conf` and `server.mjs` both declare it.
5. **Picking priority.** A click within ~5 px of a boundary selects the *way*,
   not the lanelet surface underneath it (`wayHit.score < 0.55` in `app.js`).
   Changing this makes boundaries effectively unclickable.
6. **The three.js UMD deprecation warning on load is expected.** Do not
   "fix" it by switching to ES modules — that would break the plain-script,
   no-build dev flow.
7. **Colour ramp maths.** `turbo()`'s polynomial needs the whole expression
   divided by 255, not just the tail. Getting it wrong renders everything white
   with no error.

## Common tasks

**Support a new Lanelet2 element type** — add it to `styleOf()` and `PALETTE` in
`viewer.js`; if it needs its own layer, create the group in `initScene()`, add a
checkbox with `data-layer="<key>"` in `index.html`, and a legend colour in
`renderTypeLegend()` (`app.js`).

**Support a new PCD field** — extend the offset/reader logic in `parsePCD()`,
then add a colour mode to `recolorCloud()` and an `<option>` to `#colorMode`.

**Change what the site opens with** — `config.js` only. Never hard-code paths in
`app.js`.

**Adding editing (v2)** — the full node/way/relation graph is already in
`V.osm`, so the work is: a transform gizmo writing back to `V.osm.nodes`, a tag
editor in the inspector panel, incremental re-run of `buildMap()`, and an
`.osm` serialiser. Keep the original XML formatting decisions (2-space indent,
`local_x`/`local_y`/`ele` tags) so diffs against Autoware tooling stay readable.

**After any change**, run `npm run build && node scripts/verify.mjs`. The test
covers autoload, the gzip path, query-string overrides, and `standalone.html`.
A silent regression here is invisible in the UI until someone loads real data.

## Hosting

This is a static folder, so a rented server is only needed for: point clouds too
big for a free host's per-file limit, access control over unpublished lab data,
or a future backend (tiled streaming, saving edits). Otherwise deploy free —
see the table in `README.md`. `deploy/` has ready configs for nginx, Docker,
GitHub Pages, Netlify and Vercel.

The lab publishes on GitHub Pages under the `uga-mobility-lab` org, so a
project page (`https://uga-mobility-lab.github.io/<repo>/`) is the default
target. **Every asset reference must stay relative** — the site is served from
a subpath, and a single leading `/` in a path, a `<base>` tag, or an absolute
URL in `config.js` breaks it. This is verified by loading `dist/` under a
subpath in `scripts/verify.mjs`; keep that check if you touch asset paths.

With git-lfs point clouds the Actions workflow in `deploy/github-pages.yml` is
required — Pages serves LFS *pointer files* when deploying from a branch.

## Style

- Plain ES2020, no TypeScript, no JSX. 2-space indent, semicolons.
- Comments explain *why*, especially around format quirks. Section banners use
  the `/* ---- name ---- */` form already in the files.
- User-facing strings are British-neutral English and say what happened
  ("Could not read that .pcd: …"), never bare error codes.
- Do not add npm runtime dependencies. Dev-only tooling is fine.
