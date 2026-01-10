# Ortho COG Viewer - Snapshot

## Status

**Working:**
- COG loading via geotiff.js (reads overviews, metadata, CRS)
- CRS detection from GeoKeys
- proj4 coordinate transforms (Albers → Mercator working)
- Mesh generation with inverse-projection UV computation
- WebGL2 textured mesh rendering (smooth interpolation!)
- Pan/zoom via deck.gl OrthographicView controller

**Known bugs:**
- Aspect ratio distortion (image appears too tall/narrow)
- Clipping when zooming in (part of image disappears)

Both are likely simple issues in `MeshRenderer.ts` `renderWithViewport()` - probably the ortho matrix construction or how we interpret deck.gl's zoom value.

## To run

```bash
pnpm install
pnpm dev     # dev server
pnpm build   # production build
```

## Architecture

```
main.ts          - Entry point, deck.gl setup, COG loading
MeshRenderer.ts  - WebGL2 textured mesh renderer
mesh.ts          - NxN grid generation
uv.ts            - Inverse projection UV computation
cog.ts           - geotiff.js wrapper
crs.ts           - proj4 definitions
```

## The Core Idea

Mesh vertices live in display space (Mercator). UV coordinates are computed by inverse-projecting each vertex position back to source CRS (Albers) and normalizing to [0,1]. GPU interpolates UVs linearly within triangles. Result: reprojected image without pixel resampling.

## Test COG

https://projects.pawsey.org.au/image-cogs/images/Topographic_Base_Map.tif

Australian topo map in EPSG:3577 (GDA94 / Australian Albers)
