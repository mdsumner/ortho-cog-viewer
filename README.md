# Ortho COG Viewer

CRS-agnostic Cloud Optimized GeoTIFF viewer with GPU-accelerated reprojection.

## Status

**Working:**
- COG loading via geotiff.js (reads overviews, metadata, CRS)
- CRS detection from GeoKeys
- proj4 coordinate transforms
- Mesh generation with inverse-projection UV computation
- WebGL2 textured mesh rendering (smooth interpolation!)
- Custom pan/zoom controller (touch + mouse)

**No deck.gl** - pure WebGL2, ~191KB bundle.

## To run

```bash
pnpm install
pnpm dev     # dev server
pnpm build   # production build
```

## Architecture

```
main.ts          - Entry point, canvas setup, COG loading
ViewController.ts - Pan/zoom/touch input handling
MeshRenderer.ts  - WebGL2 textured mesh renderer
mesh.ts          - NxN grid generation
uv.ts            - Inverse projection UV computation
cog.ts           - geotiff.js wrapper
crs.ts           - proj4 definitions
```

## The Core Idea

Mesh vertices live in display space (any CRS). UV coordinates are computed by inverse-projecting each vertex position back to source CRS and normalizing to [0,1]. GPU interpolates UVs linearly within triangles. Result: reprojected image without pixel resampling.

**Source and display CRS are completely decoupled.**

## Test COG

https://projects.pawsey.org.au/image-cogs/images/Topographic_Base_Map.tif

Australian topo map in EPSG:3577 (GDA94 / Australian Albers)

## Next Steps

- Multi-resolution COG tiles (zoom-dependent overview selection)
- Photometric interpretation (RGB, grayscale, min/max scaling)
- Multiple layer support
- Tile server sources (WMTS/XYZ)
