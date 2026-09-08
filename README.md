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

Fixed extent mode (a static display CRS with a camera over it, the original design):

- [Web Mercator](https://mdsumner.github.io/ortho-cog-viewer/?mode=fixed&crs=EPSG:3857)
- [Antarctic Polar Stereographic, EPSG:3031, whole world](https://mdsumner.github.io/ortho-cog-viewer/?mode=fixed&crs=EPSG:3031&extent=-12000000,12000000,-12000000,12000000)
- [S2 Tasmania tile (UTM 55S source) in EPSG:3577 Australian Albers](https://mdsumner.github.io/ortho-cog-viewer/?mode=fixed&crs=EPSG:3577&extent=1000000,1500000,-4900000,-4500000&url=https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/55/G/EN/2024/12/S2A_55GEN_20241204_0_L2A/TCI.tif)

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
  is about a thousand transforms for the default 32-wide grid

Presets are in `centred.ts`. A custom template can be given with `{lon_0}` and
`{lat_0}` placeholders, for example an oblique Mercator or a Cassini centred on
the view. Note that proj4js does not default `x_0`/`y_0` and silently returns
NaN without them, so spell out `+x_0=0 +y_0=0`.

### Seams and poles

A global lon/lat source has two failure modes for UV interpolation: a
triangle straddling the antimeridian (u ~ 0 on one side, u ~ 1 on the other,
so the GPU sweeps the whole texture across it) and a triangle containing a
pole (its vertices span every longitude). Each layer therefore gets its own
de-indexed mesh, u is unwrapped per triangle when the source spans 360
degrees (with REPEAT wrapping in the sampler), and the few triangles whose
span is still over half the texture, the ones containing a pole, are dropped.
That leaves a hole about one mesh cell across at each pole; a finer grid
shrinks it.

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
| `url`    | COG URL, repeatable for multiple layers                            |
| `zoom`   | log2 of screen pixels per display unit                             |
| `grid`   | mesh cells across (default 32)                                     |
| `crs`    | fixed mode: display CRS (EPSG code or proj4 string)                |
| `extent` | fixed mode: mesh extent as `xmin,xmax,ymin,ymax`                   |
| `proj`   | centred mode: preset name (`ortho`, `laea`, `aeqd`, `stere`, `gnom`) or a template |
| `center` | centred mode: `lon,lat`; fixed mode: `x,y` in display units        |

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

```
main.ts           - Entry point, view modes, layers, URL state
ViewController.ts - Pan/zoom/touch input handling
MeshRenderer.ts   - WebGL2 textured mesh renderer
mesh.ts           - Grid generation
uv.ts             - Inverse projection UV computation, validity mask
centred.ts        - Centred-projection templates and pan-as-recentre
cog.ts            - geotiff.js wrapper
crs.ts            - proj4 definitions
```

## Test COGs

- NASA Blue Marble, January: https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/january/world.200401.3x5400x2700_geo.tif (EPSG:4326)
- Sentinel-2 L2A true colour, Tasmania: the `S2` URL above (EPSG:32755)
- IBCSO v2 digital chart, EPSG:9354: https://projects.pawsey.org.au/image-cogs/images/IBCSO_v2_digital_chart.tif (host does not currently serve to browsers)

## Next Steps

- Photometric interpretation (grayscale min/max scaling, nodata, colour tables)
- Per-tile loading rather than whole overviews, so full-resolution levels work
- Register more CRS definitions on the fly (UTM zones are synthesised; other EPSG codes still need a def in crs.ts)
- Close the pole hole, probably by doing the inverse projection per fragment in the shader for those triangles
- Tile server sources (WMTS/XYZ)
- Graticule overlay, which would make the centred projections much easier to read


## Related

- [deck.gl-raster](https://github.com/developmentseed/deck.gl-raster) - this is now used by source.coop previews!
- [textures R package](https://github.com/hypertidy/textures)
- [earlier R impl. anglr](https://github.com/hypertidy/anglr)
- [textures in rgl discussed in a mesh-spatial talk](https://youtu.be/EnwkVXLRUYI?si=8TvruDeg1F1FnCa8&t=957)
