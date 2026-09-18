# Ortho COG Viewer

CRS-agnostic Cloud Optimized GeoTIFF viewer with GPU-accelerated reprojection.

**Live demo:** https://mdsumner.github.io/ortho-cog-viewer/

## Examples

All state lives in the URL, so these are links to specific scenes. The default
layer is NASA's Blue Marble (January, EPSG:4326, 5400x2700) and the default
view is an orthographic globe centred over Australia.

`S2` below is a Sentinel-2 true-colour COG over Tasmania (tile 55GEN, UTM 55S):
`https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/55/G/EN/2024/12/S2A_55GEN_20241204_0_L2A/TCI.tif`

Centred projection mode (the projection centre follows the screen centre, drag to spin):

- [Orthographic globe over Australia](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=ortho&center=135,-35)
- [Orthographic globe over the South Pole](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=ortho&center=0,-90)
- [Azimuthal equidistant from Hobart (great circles from the centre are straight, the antipode is the rim)](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=aeqd&center=147.3,-42.9&zoom=-16)
- [Lambert azimuthal equal area centred on Casey](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=laea&center=110.5,-66.3&zoom=-13)
- [Gnomonic over the Ross Sea](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=gnom&center=180,-75&zoom=-13)
- [S2 Tasmania tile on the globe, Blue Marble underneath](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=ortho&center=147,-42&zoom=-10&url=https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/january/world.200401.3x5400x2700_geo.tif&url=https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/55/G/EN/2024/12/S2A_55GEN_20241204_0_L2A/TCI.tif)
- [Goode homolosine, interrupted, rotating under the cursor](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=igh&center=147,-20&zoom=-16&graticule=1&url=preset:gebco-2024)

Fixed extent mode (a static display CRS with a camera over it, the original design):

- [Web Mercator](https://mdsumner.github.io/ortho-cog-viewer/?mode=fixed&crs=EPSG:3857)
- [Antarctic Polar Stereographic, EPSG:3031, whole world](https://mdsumner.github.io/ortho-cog-viewer/?mode=fixed&crs=EPSG:3031&extent=-12000000,12000000,-12000000,12000000)
- [S2 Tasmania tile (UTM 55S source) in EPSG:3577 Australian Albers](https://mdsumner.github.io/ortho-cog-viewer/?mode=fixed&crs=EPSG:3577&extent=1000000,1500000,-4900000,-4500000&url=https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/55/G/EN/2024/12/S2A_55GEN_20241204_0_L2A/TCI.tif)

Tile servers (XYZ / WMTS) load the same way, from the presets dropdown or by
pasting a `{z}/{x}/{y}` template into the URL box:

- [Esri World Imagery on an orthographic globe](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=ortho&center=147,-42&url=preset:esri-imagery)
- [OpenStreetMap in Antarctic Polar Stereographic](https://mdsumner.github.io/ortho-cog-viewer/?mode=fixed&crs=EPSG:3031&extent=-6000000,6000000,-6000000,6000000&url=preset:osm)
- [NASA GIBS sea ice concentration (EPSG:3857 tiles) on a south polar laea](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=laea&center=0,-90&zoom=-12.5&url=preset:gibs-bluemarble-3857&url=preset:gibs-seaice-3857)
- [GIBS MODIS true colour (EPSG:4326 tiles) from Hobart, aeqd](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=aeqd&center=147.3,-42.9&zoom=-13&url=preset:gibs-modis-truecolor)
- [GEBCO 2024 bathymetry, hillshaded, orthographic over Tasmania (COG on source.coop)](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=ortho&center=147,-42&zoom=-10&url=preset:gebco-2024)
- [GEBCO 2024 with the DiRT palette, south polar laea](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=laea&center=0,-90&zoom=-13&url=preset:gebco-2024-dirt)
- [GHRSST MUR SST 2026-08-29 in degrees C (int16 COG with scale/offset)](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=ortho&center=147,-42&url=preset:mur-sst-20260829)
- [LIST Tasmania 2026 aerial photo, from its WMTS GetCapabilities, on a laea centred on Hobart](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=laea&center=147.33,-42.88&zoom=-6&url=preset:list-aerial-2026)

## The Core Idea

Mesh vertices live in display space (any CRS). UV coordinates are computed by
inverse-projecting each vertex position back to source CRS and normalizing to
[0,1]. The GPU interpolates UVs linearly within triangles. Result: a
reprojected image without pixel resampling.

**Source and display CRS are completely decoupled.**

### Two view modes

**fixed** - the display CRS is a static thing. We build a regular mesh over an
extent in that CRS and move an orthographic camera around over it. Any proj4
string or registered EPSG code works.

**centred** - the display CRS is a *template* whose `lon_0` / `lat_0` are the
current view centre. The mesh is always the screen rectangle around (0, 0) of
that projection, and panning moves the projection centre rather than the
camera: the screen offset of the drag is inverse-projected through the current
centred CRS to become the next frame's tangent point.

This gives some nice properties for free:

- the screen centre is always the point of zero distortion
- mesh cells are uniform in screen space, so the linear-interpolation error of
  the warp is uniform across the screen at every zoom
- azimuthal projections (ortho, laea, aeqd, stere, gnom) become a globe you can
  spin, with no special-casing of poles or the antimeridian
- the cost is one proj4 round trip per mesh vertex per layer per frame, which
  is a few thousand transforms for the default 64-wide grid

Presets are in `centred.ts`. A custom template can be given with `{lon_0}` and
`{lat_0}` placeholders; anything with a centre parameter works, for example
the `omerc` preset puts `{lon_0}` into `lonc`.

A template with only `{lon_0}` (all the world projections) re-centres the
meridian and lets the view move north-south over it: the mesh is anchored at
the projected view centre, `(0, y(lat))`, rather than at the projection's own
origin. **Shift-drag** looks around without re-centring at all - the
projection stays exactly as it is and the view slides over it, which is how
to inspect a limb, a lobe edge or a pole without the map re-shaping under
you. The next plain drag folds the offset back into the centre.

A template with **no** placeholders is an ordinary fixed CRS - `EPSG:28355`,
say - used in centred mode: the projection stays put and only the mesh
follows the view, anchored at the projected view centre. That gives the
centred-mode conveniences (a lon/lat centre you can type, panning that
reports where you are) over a CRS that does not move, which is usually what
you want for a projected grid like an MGA zone. Note that proj4js does not default `x_0`/`y_0` and silently returns
NaN without them, so spell out `+x_0=0 +y_0=0`.

### Sources: COGs and tile pyramids are the same thing

A layer only needs four things from its source: a CRS, a full extent, a list
of resolution levels, and a way to fetch a texture covering some region at
some level (`source.ts`). A COG provides that through its overviews and a
windowed `readRasters` (`cogSource.ts`); an XYZ/WMTS pyramid provides it
through zoom levels and stitched tiles (`xyzSource.ts`). Nothing in the mesh,
UV or display-CRS code knows the difference, and a tile pyramid in EPSG:3857
or EPSG:4326 reprojects onto a globe exactly like a COG does.

Fetches are viewport-restricted. The UV computation already visits every
visible vertex, so it reports the source-space bounding box of the valid ones
and their span in screen pixels. From those the viewer picks the coarsest
level that still gives roughly one source pixel per screen pixel, pads the
region by 25% so small pans do not refetch, snaps it to the source's tile
grid and fetches only that. Textures are capped at 4096 px a side; a COG
window that is still larger is downsampled on read, a tile request that is
still larger is trimmed. This is also what makes full-resolution COGs work:
zooming in reads a window of tiles at level 0 rather than the whole level.

A tile source is a WMTS-style tile matrix set: per level an origin,
resolution, tile size and matrix size (`xyzSource.ts`). Built-in schemes
for `{z}/{x}/{y}` templates: `GoogleMapsCompatible` (Web Mercator, 256 px,
one tile at z0) and the NASA GIBS EPSG:4326 sets (512 px, 2x1 at z0, padded
past the world; `2km`..`250m` in the URL sets the finest level). A pasted
template is matched against the presets and those patterns, otherwise
assumed to be Web Mercator.

**WMTS GetCapabilities** URLs are parsed directly (`wmts.ts`): the layer,
style, format, RESTful `ResourceURL` template or KVP `GetTile` endpoint,
every `TileMatrixSet` (any CRS proj4 can handle, `ScaleDenominator` to
resolution via the OGC 0.28 mm pixel, lat/lon axis order for `urn:...:4326`),
`TileMatrixSetLimits`, and the layer's `WGS84BoundingBox`, which clamps
fetches so no tiles are requested outside the data. Esri's `default028mm`
sets, whose matrices are cropped to the data per level, work as-is.

Loading a capabilities URL with more than one layer (or a time dimension)
opens a picker: a filterable layer list, the matrix sets that layer offers,
and a time field filled from the layer's `Dimension` default (GIBS layers
are daily, so any date in the advertised range works). The choice is encoded
as `#layer=<id>&tms=<id>&time=<value>` on the capabilities URL, so it can be
pasted, bookmarked, or passed as a `url=` parameter. Tile hosts need CORS; the presets are
known to serve it. Mind each provider's usage policy and keep the
attribution the layer list shows.

### Numeric data

A COG that is not a picture (fewer than three bands, more than 8 bits, or
floating point) is treated as data: bands are read as float32, uploaded as
`R32F` (single band) or `RGB32F` (composite) textures, and rescaled and
colour mapped in the fragment shader. Min, max, curve, colormap and nodata
are uniforms, so every control in the rendering panel is a redraw, not a
refetch; only changing bands or mode reads data again. The panel follows the
one on source.coop's COG previews (which is the deck.gl-raster lineage of
doing raster operations on the GPU):

- **mode** single band + colormap, or RGB composite with three band pickers
  and a shared rescale (the way to look at 16-bit Sentinel-2 bands)
- **histogram** of the fetched window with draggable min/max handles,
  `2-98%` and `min/max` buttons; the range starts at 2-98% and follows the
  window until you touch it
- **curve** linear, sqrt or log
- **nodata** from the GDAL tag (`auto`), or any value you type; NaN is always
  masked
- **colormaps** viridis, magma, inferno, turbo, cividis, grey, blues,
  red-blue, bathymetry, flat, and **DiRT**, a value-anchored bathymetry/topography
  palette (as used aboard RSV Nuyina) with colours fixed to depths from
  -8000 m to +1000 m. Anchored palettes pin the range, so a colour always
  means the same depth whatever the file's own range is.

**Hillshade** is computed in the same fragment shader from the float texture:
Horn's 3x3 slope and aspect using the texel's real ground size (degrees are
converted to metres, x scaled by cos(latitude)), lit from a sun given by
azimuth and altitude, multiplied into whatever palette is active. Strength,
vertical exaggeration and sun position are uniforms, so they are live.
`cmap=flat&shade=1` gives a plain hillshade. This is what makes an anchored
bathymetry palette readable: colour says depth, shading says shape.

GDAL scale/offset metadata is applied on read (nodata is matched on the raw
value), and `#scale=&offset=` on the URL override it, which is how the MUR
preset turns int16 Kelvin into degrees C. `reset` returns a layer to the
styling it was loaded with (its URL fragment, or the defaults).

Per-layer state rides on the URL fragment:
`cog.tif#band=2&min=-2&max=30&cmap=turbo&curve=sqrt&nodata=-9999&shade=0.7&zf=3&az=315&alt=45`, or
`cog.tif#bands=4,3,2&min=0&max=3000` for a composite (`rgb=1` forces the
8-bit picture path).

### Coordinate reference systems

proj4js ships no EPSG database, so every code has to be defined before it can
be used. `crs.ts` resolves one in four steps:

1. a table of named definitions (polar stereographic including the NSIDC and
   Australian Antarctic ones, EASE-Grid 2.0, Australian Albers and Lambert in
   both GDA94 and GDA2020, NZTM, British National Grid, LAEA Europe, UPS, ...);
2. zone arithmetic, for the families where the code number encodes the UTM
   zone: WGS84 `326xx`/`327xx`, **GDA94 MGA `283xx`**, GDA2020 MGA `78xx`,
   NAD83 `269xx`, ETRS89 `258xx`;
3. **PROJ itself**, compiled to wasm with the real EPSG database
   ([proj-wasm](https://github.com/willcohen/clj-proj), Will Cohen's build of
   PROJ 9). It is 15 MB and runs in a worker, so it is not part of the page:
   it is fetched the first time a code misses steps 1 and 2, takes about half
   a second to come up, and then answers for any code PROJ knows, offline.
   A session that only ever sees known codes never loads it;
4. a fetch from epsg.io at runtime, which needs network access and CORS from
   that host. Kept as the fallback for when step 3 cannot load.

Step 3 is not only for codes. Anything PROJ reads - WKT in any dialect,
PROJJSON, a `urn:ogc:def:crs:...`, an `IAU:2015:...` code, a `+proj` string
with parameters proj4js does not parse - goes through the same normalisation
and comes back as the PROJ.4 string proj4js executes.

#### Two executors

That is the split to keep in mind: **PROJ decides what a CRS means; an
executor runs the projection for the mesh.** There are two, chosen per
display CRS, and the status line says which (`Executor:`):

- **proj4js**, whenever it can: synchronous, microseconds per vertex, the
  mesh for a new view is ready in the same frame. Its couple of dozen
  projections plus the five added in `projections.ts` cover most of what
  anyone types.
- **PROJ in wasm**, for everything else (`+proj=aitoff`, `bonne`, any of the
  hundred-odd others, and any CRS PROJ can build that proj4js cannot): the
  display transforms go to the worker as one batch per stage - about 4 ms
  for a 4k-vertex mesh each way - so the mesh for a new view lands a frame
  or two later. The graticule, wrap detection and fit go the same way.

**Re-centre** (the select under the centre, `recentre=auto|live|release`)
says when a drag moves the projection centre. `live` re-centres every
frame, which on a symmetric projection reads as rotating a globe. `release`
lets the camera slide over the map as it is and re-centres once on
mouse-up: re-centring an unfolded net such as `+proj=isea` re-cuts the whole
map, and doing that thirty times a second is hectic rather than
informative, and a lobed map like `+proj=interrupted +base=poly +gores=5`
reads better settling once too. `auto` (the default) is live on proj4js and
on release on PROJ. In either executor a drag whose screen centre lands off
the map (a facet gap, the horizon) is kept as a look-around rather than
snapped back. `core/transform.ts` is the seam: a `GeoTransform`
  with batch `toGeo`/`fromGeo` for either executor, and synchronous forms
  only when the executor is proj4js.

The source side is always proj4js: UVs are computed per vertex on the
main thread, and a source in a CRS proj4js cannot run is rare enough that
it is still reported rather than routed.

Failing all four, put the definition on the layer URL and it is registered
under the source's own code, so later layers get it too (`#crs=` takes WKT
as well, through the same normalisation):

```
cog.tif#crs=+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +x_0=2600000 +y_0=1200000 +ellps=bessel
```

The same works in the display CRS box: paste a proj4 string instead of a code.
Datum shifts are the identity for the GRS80-based datums (GDA94, GDA2020,
NAD83, ETRS89) - a metre or two against WGS84, well inside a screen pixel.

`tools/check-crs.py` checks every definition against PROJ's own EPSG database
by projecting sample points from each CRS's area of use with both proj4js and
pyproj (`pip install pyproj && python3 tools/check-crs.py`). It is how the
EPSG:9354 error below was found, and it should be run after touching the
table.

#### Sharing a CRS with another engine

One place decides what `EPSG:28355` means, and `crsDefinition(crs)` hands that
same decision to anyone else: a proj4 string for a code, the string unchanged
if the CRS already is one, or null if nothing here knows it. That covers the
codes proj4js ships itself (the WGS84 UTM zones), whose parsed definition is
recovered rather than re-invented, so what goes out is what this viewer is
projecting with and not a plausible-looking near-miss.

This matters for a second transform implementation - a GDAL or proj4rs warp
engine in wasm, say, which cannot see proj4js's registry. It is handed the
definition string, never the code. With step 3 in place the arrangement is:
PROJ resolves, proj4js executes for the mesh, and any other engine executes
from the same string. No engine resolves a code on its own; that is how two
views of one COG end up quietly in different places.

`check-crs.py` guards that handoff: projecting through `"EPSG:NNNN"` and
through the string `crsDefinition` gives for it must agree to 1e-6 m, or the
handoff is lossy and nothing downstream can be trusted. The check also takes
`--engine <command>` and drives an external implementation over a small JSON
contract (documented at the top of the script) so another engine can be
compared against both PROJ and proj4js on the same points.
`tools/proj-wasm-engine.mjs` is one such engine, PROJ-in-wasm exactly as the
viewer ships it (`pnpm run check-crs`); it agrees with pyproj to the
millimetre on every code in the table, which is what you would hope from the
same library twice, and it is the template for wiring in proj4rs. Note that
the contract is in degrees: proj4rs works in radians internally, which is
exactly the sort of thing this is meant to catch.

#### Projections proj4js does not have

Resolving a code is one thing; executing the projection for every mesh
vertex is another. proj4js does that synchronously, which is what makes the
interactive path feel the way it does, but it implements a couple of dozen
projections where PROJ has about 150. `core/projections.ts` adds the ones
people reach for in centred mode so they stay on the fast executor:
**Eckert IV, Natural Earth, Hammer, Winkel Tripel** and the **interrupted
Goode homolosine**. Everything else runs through the PROJ executor above. They are spherical closed forms ported
from PROJ's sources, and `tools/check-projections.py` holds them to PROJ on a
global grid: forward within a millimetre, inverse round trip to 1e-10
degrees. All of them are centred-mode presets alongside sinusoidal,
Mollweide, Robinson and Equal Earth, which proj4js already had.

One wart found on the way, worth knowing if a Winkel Tripel definition
leaves this viewer: PROJ's own pipeline defaults a missing `+lat_1` to
Winkel's 50d28' (acos(2/pi)), but when the same string is treated as a CRS
(GDAL, pyproj, `proj_create_crs_to_crs`) the missing `lat_1` is filled in as
0. Same string, two projections, thousands of kilometres apart. The preset
writes `+lat_1` out explicitly so every consumer agrees.

`tools/bundle-proj-wasm.mjs` lays proj-wasm out flat in `public/proj-wasm/`
(one esbuild bundle per entry, workers and all, every file finding its
neighbours relative to its own URL) so the viewer can import it by URL on
demand rather than through the main bundle. It runs before `dev` and `build`
and its output is not committed.

### Repeating the world

Tick "wrap" (`wrap=1`) and projections that have a sideways repeat show more
than one copy of the globe. Which ones do, and by how much, is not a table
of names: `core/wrap.ts` measures the vector across the base world at each
latitude, `fwd(lon_0 + 180, lat) - fwd(lon_0 - 180, lat)`, and calls it a
translational period when it is finite, non-zero at the equator and parallel
at every latitude. That one test sorts every projection in the viewer:

- **merc, eqc, mill**: the vector is constant, copies tile the plane exactly
- **sinu, moll, robin, eqearth, eck4, natearth, hammer, wintri, igh**: parallel
  but shrinking with latitude, so copies touch at the equator with lens-shaped
  gaps between them, like the interruptions of a homolosine. For igh the join
  between copies is simply one more interruption.
- **laea, aeqd**: both edges land on the antipode, the vector is zero: no wrap
- **ortho, gnom, stere**: the edges are off the map or at infinity: no wrap
- **lcc, aea**: the edges are related by a rotation, not a translation: no wrap
- **tmerc, omerc**: both edges are the same meridian. Their repeat runs along
  y (or u) with the meridian circumference as period, which is a separate
  facility not built yet.

The mesh reduces every display vertex into the base copy, projects it there,
and keeps it if the round trip holds; points in the gaps fail the round trip
and are dropped by the same validity mask that handles poles and horizons.
The graticule is drawn once per copy in view.

This is not `+over`. PROJ's `+over` continues a projection's formula past
180 degrees, which for a pseudocylindrical is a shear (the meridian at 360
is another sinusoid), not a copy. The Mercator case is the only one where
the two agree. Also worth knowing: proj4js's `cea` returns NaN without
`+lat_ts`, so a bare `+proj=cea` reports no repeat for that reason alone.

### core/ is worker-safe

Everything under `src/core/` runs without a DOM: no `document`, no `window`,
no `Image`, no `HTMLCanvasElement` in a result. A source's `fetch()` returns
plain buffers (`rgba: {data, width, height}` or `float: {...}`), tiles are
decoded with `fetch` + `createImageBitmap` and assembled on an
`OffscreenCanvas` (a DOM canvas is the fallback where that does not exist),
and proj-wasm's folder is configured with `setProjWasmBase()` when there is
no page to be relative to. The one exception is `wmts.ts`, which uses
`DOMParser` for GetCapabilities and is main-thread only; what it produces is
plain data a worker can be handed.

This is what lets a warp engine, or PROJ executing the mesh, live in a
worker later without the sources being rewritten. Two checks keep it so:

- `node tools/check-worker-core.mjs` greps `core/` for DOM globals (fails on
  any) and bundles `tools/worker-smoke/worker.ts`, which opens a COG and a
  tile pyramid, fetches from both, resolves a code through PROJ-in-wasm,
  and reports - all inside a real Web Worker.
- `python3 tools/check-worker-core.py` runs that in headless Chromium
  (`pnpm run check-worker` does both, after a `pnpm build`).

### Seams and poles

A global lon/lat source has two failure modes for UV interpolation: a
triangle straddling the antimeridian (u ~ 0 on one side, u ~ 1 on the other,
so the GPU sweeps the whole texture across it) and a triangle containing a
pole (its vertices span every longitude). Each layer therefore gets its own
de-indexed mesh, u is unwrapped per triangle when the source spans 360
degrees (with REPEAT wrapping in the sampler), and the few triangles whose
span is still over half the texture, the ones containing a pole, are dropped.
That leaves a hole about one mesh cell across at each pole; a finer grid
shrinks it. Tick "show triangles" (or add `wire=1`) to see the mesh, the
dropped pole triangles, and the rim where vertices fail the validity test.

### Graticule

A 10-degree graticule is projected through the display CRS on the CPU
(`graticule.ts`) whenever the CRS changes, so in centred mode it is rebuilt
every frame along with the UVs. Samples are validated with the same round-trip
test as the mesh, and any segment more than 8x longer than the median segment
on its line is a projection cut and is not drawn.

### Validity mask

A display vertex is only used if display -> lon/lat -> display round-trips to
where it started. That one projection-agnostic test drops vertices beyond the
horizon of an orthographic view, past the Mercator poles, at the antipode of an
aeqd, and anywhere the transform returns NaN. Triangles touching an invalid
vertex are removed from the index buffer, and the layer list shows the
percentage of vertices that survived.

## URL parameters

| param    | meaning                                                            |
|----------|--------------------------------------------------------------------|
| `mode`   | `fixed` or `centred`                                               |
| `url`    | COG URL, a `{z}/{x}/{y}` tile template, or `preset:<name>`; repeatable |
| `zoom`   | log2 of screen pixels per display unit                             |
| `grid`   | mesh cells across (default 64)                                     |
| `wire`   | `1` to draw the mesh triangles over the imagery                    |
| `grat`   | `0` to hide the 10-degree graticule (on by default)                |
| `wrap`   | `1` to repeat the world sideways where the projection has a repeat |
| `recentre` | centred mode: `auto` (default), `live` or `release`, see above |
| `crs`    | fixed mode: display CRS (EPSG code or proj4 string)                |
| `extent` | fixed mode: mesh extent as `xmin,xmax,ymin,ymax`                   |
| `proj`   | centred mode: preset name (`ortho`, `laea`, `aeqd`, `stere`, `gnom`, `omerc`, or a world one: `sinu`, `moll`, `robin`, `eqearth`, `eck4`, `natearth`, `hammer`, `wintri`, `igh`), a template, or a fixed CRS |
| `center` | centred mode: `lon,lat`; fixed mode: `x,y` in display units        |

Any layer URL can carry `#alpha=0.6` for opacity and `#crs=<proj4>` to declare
its CRS; it combines with the
WMTS `layer=`/`tms=`/`time=` and numeric `band=`/`min=`/... fragment keys.

The URL is rewritten as you pan and zoom, so the address bar is always a link
to what you are looking at.

## Status

**Working:**
- COG loading via geotiff.js (reads overviews, metadata, CRS)
- CRS detection from GeoKeys
- proj4 coordinate transforms
- Mesh generation with inverse-projection UV computation and validity mask
- WebGL2 textured mesh rendering (smooth interpolation!)
- Custom pan/zoom controller (touch + mouse)
- Zoom-dependent overview selection
- Multiple layers
- Fixed and centred view modes, shareable URLs
- XYZ/WMTS tile sources, viewport-restricted fetching for both COGs and tiles

**No deck.gl** - pure WebGL2, ~195KB bundle.

## To run

```bash
pnpm install
pnpm dev     # dev server
pnpm build   # production build
```

Pushes to `main` build and deploy to GitHub Pages via
`.github/workflows/pages.yml`. In the repository settings, Pages must be set
to deploy from GitHub Actions the first time.

COG hosts need to allow CORS and HTTP range requests for the viewer to read
them from a browser.

## Architecture

Three layers, with the seam between the second and third the point of the
whole arrangement:

```
src/main.ts          The shell: view modes, layer list, styling state,
                     controls, URL state. Knows nothing about how a layer
                     is drawn.
src/ViewController   Pan/zoom/touch input

src/engine/          How a layer's pixels reach the screen
  types.ts           LayerEngine, View, RenderContext, Style
  meshEngine.ts      The mesh engine: source texture + UV warp
  MeshRenderer.ts    WebGL2 textured mesh + wireframe + colour mapping
  LineRenderer.ts    Flat-colour line overlay (graticule)
  mesh.ts            Screen-aligned grid generation
  uv.ts              Inverse-projection UVs, validity mask, seam handling

src/core/            What a layer is, independent of drawing
  source.ts          RasterSource, fetch planning, URL fragments
  cogSource.ts       COG backend (overviews, windowed tile reads)
  xyzSource.ts       Tile pyramid backend (matrix sets, presets, stitching)
  wmts.ts            WMTS GetCapabilities parsing
  bounds.ts          Extents and transforms between CRSs
  crs.ts             proj4 definitions, zone synthesis, runtime lookup
  projwasm.ts        PROJ in wasm as the resolver of last resort
  projections.ts     eck4, natearth, hammer, wintri, igh for proj4js
  transform.ts       GeoTransform: display <-> lon/lat by either executor
  centred.ts         Centred-projection templates and pan-as-recentre
  colormap.ts        Colour ramps, including value-anchored palettes
  graticule.ts       Lon/lat lines projected into the display CRS
  wrap.ts            Detects a projection's sideways repeat, for wrap

tools/check-crs.py   Checks crs.ts against PROJ's EPSG database
tools/proj-wasm-engine.mjs   proj-wasm as an engine for check-crs.py
tools/check-projections.py   Holds projections.ts to PROJ on a global grid
tools/check-worker-core.mjs  Guards core/ against DOM use; bundles the worker smoke test
tools/check-worker-core.py   Runs the worker smoke test in headless Chromium
tools/bundle-proj-wasm.mjs   Lays proj-wasm out in public/proj-wasm/
```

### The engine seam

A `LayerEngine` owns one layer's pixels: it reads from a `RasterSource` and
puts something on screen for the current `View`. Three verbs, separated by
what they cost:

| | when | mesh engine does |
|---|---|---|
| `layout(ctx)` | every view change | recompute UVs for the screen grid |
| `refresh(ctx)` | debounced | fetch the source window it needs |
| `draw(ctx)` | every frame | one draw call |

Everything above that interface - palettes, rescaling, hillshade, nodata,
alpha, the layer list, the URL state - is engine-agnostic, because styling
is a `Style` of plain numbers that the engine turns into uniforms.

The mesh engine is the only implementation today. The interface exists
because a second one is intended: a warp engine backed by
[rwarp](https://github.com/hypertidy/rwarp), which resamples the source
into a raster on the display grid (a real GDAL warp pipeline in wasm)
instead of approximating the warp with interpolated UVs. Exact and
resampled where the mesh is fast and free; the natural arrangement is mesh
while the view is moving and warp once it settles.

## Test COGs

- NASA Blue Marble, January: https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/january/world.200401.3x5400x2700_geo.tif (EPSG:4326)
- Sentinel-2 L2A true colour, Tasmania: the `S2` URL above (EPSG:32755)
- IBCSO v2 digital chart, EPSG:9354: https://projects.pawsey.org.au/image-cogs/images/IBCSO_v2_digital_chart.tif (host does not currently serve to browsers)

## Next Steps

- Colour tables and categorical palettes; per-band rescale for composites
- Value readout under the cursor for numeric layers
- Smarter regions for views that straddle the antimeridian (currently the full width is fetched)
- Time slider (the time field refetches, but a scrubber over the dimension range would be nicer)
- Close the pole hole, probably by doing the inverse projection per fragment in the shader for those triangles
- Graticule labels

## Related

- [deck.gl-raster](https://github.com/developmentseed/deck.gl-raster) - this is now used by source.coop previews!
- [textures R package](https://github.com/hypertidy/textures)
- [earlier R impl. anglr](https://github.com/hypertidy/anglr)
- [textures in rgl discussed in a mesh-spatial talk](https://youtu.be/EnwkVXLRUYI?si=8TvruDeg1F1FnCa8&t=957)
- [Jason Davies, naturally](https://www.jasondavies.com/)
