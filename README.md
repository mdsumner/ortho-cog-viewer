# Ortho COG Viewer

CRS-agnostic Cloud Optimized GeoTIFF viewer with GPU-accelerated reprojection.

**Live demo:** https://mdsumner.github.io/ortho-cog-viewer/

## Examples

All state lives in the URL, so these are links to specific scenes. The default
layer is the IBCSO v2 digital chart (EPSG:9354, polar stereographic).

Centred projection mode (the projection centre follows the screen centre, drag to spin):

- [Orthographic globe over the South Pole](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=ortho&center=0,-90)
- [Orthographic globe, oblique from Hobart](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=ortho&center=147.3,-42.9)
- [Lambert azimuthal equal area centred on Casey](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=laea&center=110.5,-66.3&zoom=-12)
- [Azimuthal equidistant from Hobart (great circles from the centre are straight)](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=aeqd&center=147.3,-42.9&zoom=-14)
- [Gnomonic over the Ross Sea](https://mdsumner.github.io/ortho-cog-viewer/?mode=centred&proj=gnom&center=180,-75&zoom=-12.5)

Fixed extent mode (a static display CRS with a camera over it, the original design):

- [Web Mercator](https://mdsumner.github.io/ortho-cog-viewer/?mode=fixed&crs=EPSG:3857)
- [Antarctic Polar Stereographic, EPSG:3031](https://mdsumner.github.io/ortho-cog-viewer/?mode=fixed&crs=EPSG:3031&extent=-6000000,6000000,-6000000,6000000)
- [Australian topo base map (EPSG:3577 source) in Web Mercator](https://mdsumner.github.io/ortho-cog-viewer/?mode=fixed&crs=EPSG:3857&extent=10000000,18000000,-6000000,0&url=https://projects.pawsey.org.au/image-cogs/images/Topographic_Base_Map.tif)

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

- https://projects.pawsey.org.au/image-cogs/images/IBCSO_v2_digital_chart.tif (EPSG:9354)
- https://projects.pawsey.org.au/image-cogs/images/Topographic_Base_Map.tif (EPSG:3577, GDA94 / Australian Albers)

## Next Steps

- Photometric interpretation (grayscale min/max scaling, nodata, colour tables)
- Per-tile loading rather than whole overviews, so full-resolution levels work
- Register CRS definitions on the fly (source COGs with EPSG codes not in crs.ts fail)
- Tile server sources (WMTS/XYZ)
- Graticule overlay, which would make the centred projections much easier to read

## Related

- [deck.gl-raster](https://github.com/developmentseed/deck.gl-raster) - this is now used by source.coop previews!
- [textures R package](https://github.com/hypertidy/textures)
- [earlier R impl. anglr](https://github.com/hypertidy/anglr)
- [textures in rgl discussed in a mesh-spatial talk](https://youtu.be/EnwkVXLRUYI?si=8TvruDeg1F1FnCa8&t=957)
