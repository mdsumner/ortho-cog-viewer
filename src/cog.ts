/**
 * COG loading utilities using geotiff.js
 */

import { fromUrl, GeoTIFF, GeoTIFFImage } from 'geotiff';
import { SourceBounds } from './uv';

export interface COGMetadata {
  crs: string | null;
  bounds: SourceBounds;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  samplesPerPixel: number;
  bitsPerSample: number[];
  overviewCount: number;
}

export interface OverviewInfo {
  index: number;
  width: number;
  height: number;
  resolution: number;  // world units per pixel
}

// One open GeoTIFF handle per URL, so multiple layers don't evict each other.
// The promise is cached (not the result) so concurrent callers share one open.
const tiffCache = new Map<string, Promise<GeoTIFF>>();

async function getTiff(url: string): Promise<GeoTIFF> {
  let p = tiffCache.get(url);
  if (!p) {
    p = fromUrl(url);
    tiffCache.set(url, p);
    p.catch(() => tiffCache.delete(url));
  }
  return p;
}

/**
 * Parse CRS from GeoTIFF GeoKeys.
 */
function parseCRSFromGeoKeys(geoKeys: Record<string, number>): string | null {
  // ProjectedCSTypeGeoKey (3072)
  if (geoKeys.ProjectedCSTypeGeoKey && geoKeys.ProjectedCSTypeGeoKey !== 32767) {
    return `EPSG:${geoKeys.ProjectedCSTypeGeoKey}`;
  }
  
  // GeographicTypeGeoKey (2048)
  if (geoKeys.GeographicTypeGeoKey && geoKeys.GeographicTypeGeoKey !== 32767) {
    return `EPSG:${geoKeys.GeographicTypeGeoKey}`;
  }
  
  return null;
}

/**
 * Load COG metadata without fetching pixel data.
 */
export async function loadCOGMetadata(url: string): Promise<COGMetadata> {
  console.log('Loading COG metadata from:', url);
  
  const tiff = await getTiff(url);
  const image = await tiff.getImage();
  
  const geoKeys = image.getGeoKeys();
  const bbox = image.getBoundingBox();
  
  const metadata: COGMetadata = {
    crs: parseCRSFromGeoKeys(geoKeys),
    bounds: {
      minX: bbox[0],
      minY: bbox[1],
      maxX: bbox[2],
      maxY: bbox[3]
    },
    width: image.getWidth(),
    height: image.getHeight(),
    tileWidth: image.getTileWidth(),
    tileHeight: image.getTileHeight(),
    samplesPerPixel: image.getSamplesPerPixel(),
    bitsPerSample: image.getBitsPerSample(),
    overviewCount: await tiff.getImageCount() - 1
  };
  
  console.log('COG metadata:', metadata);
  console.log('GeoKeys:', geoKeys);
  
  return metadata;
}

/**
 * Get info about all available overviews.
 */
export async function getOverviews(url: string, bounds: SourceBounds): Promise<OverviewInfo[]> {
  const tiff = await getTiff(url);
  const imageCount = await tiff.getImageCount();
  const overviews: OverviewInfo[] = [];
  
  const boundsWidth = bounds.maxX - bounds.minX;
  
  for (let i = 0; i < imageCount; i++) {
    const img = await tiff.getImage(i);
    const width = img.getWidth();
    const height = img.getHeight();
    const resolution = boundsWidth / width;  // world units per pixel
    
    overviews.push({ index: i, width, height, resolution });
  }
  
  console.log('Available overviews:', overviews);
  return overviews;
}

/**
 * Select the best overview for a given display resolution.
 * Returns the overview that provides at least 1:1 pixel density.
 */
export function selectOverview(overviews: OverviewInfo[], displayResolution: number): OverviewInfo {
  // Sort by resolution (finest to coarsest)
  const sorted = [...overviews].sort((a, b) => a.resolution - b.resolution);
  
  // Find the coarsest overview that still has higher resolution than display
  // (i.e., resolution <= displayResolution)
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].resolution <= displayResolution) {
      return sorted[i];
    }
  }
  
  // If display needs finer than our finest, use the finest we have
  return sorted[0];
}

/**
 * Load a specific overview by index.
 */
export async function loadOverview(
  url: string,
  overviewIndex: number
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  console.log(`Loading overview ${overviewIndex}...`);
  
  const tiff = await getTiff(url);
  const image = await tiff.getImage(overviewIndex);
  
  const width = image.getWidth();
  const height = image.getHeight();
  const samplesPerPixel = image.getSamplesPerPixel();
  
  console.log(`  Size: ${width}x${height}, ${samplesPerPixel} bands`);
  
  const rasters = await image.readRasters({ interleave: true });
  const data = rasters as Uint8Array | Uint16Array | Float32Array;
  
  // Convert to RGBA
  const rgba = new Uint8ClampedArray(width * height * 4);
  
  for (let i = 0; i < width * height; i++) {
    if (samplesPerPixel >= 3) {
      rgba[i * 4 + 0] = clampByte(data[i * samplesPerPixel + 0]);
      rgba[i * 4 + 1] = clampByte(data[i * samplesPerPixel + 1]);
      rgba[i * 4 + 2] = clampByte(data[i * samplesPerPixel + 2]);
      rgba[i * 4 + 3] = samplesPerPixel >= 4 ? clampByte(data[i * samplesPerPixel + 3]) : 255;
    } else {
      const v = clampByte(data[i]);
      rgba[i * 4 + 0] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  }
  
  console.log(`  Loaded ${width}x${height} overview`);
  return { data: rgba, width, height };
}

/**
 * Load a downsampled version of the full image (for testing).
 * Uses the appropriate overview level based on target size.
 */
export async function loadCOGPreview(
  url: string, 
  maxSize: number = 1024
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  console.log('Loading COG preview, max size:', maxSize);
  
  const tiff = await fromUrl(url);
  const imageCount = await tiff.getImageCount();
  
  // Find the best overview level
  let bestImage: GeoTIFFImage | null = null;
  let bestIndex = 0;
  
  for (let i = 0; i < imageCount; i++) {
    const img = await tiff.getImage(i);
    const w = img.getWidth();
    const h = img.getHeight();
    
    console.log(`  Image ${i}: ${w}x${h}`);
    
    if (w <= maxSize && h <= maxSize) {
      bestImage = img;
      bestIndex = i;
      break;
    }
    bestImage = img;
    bestIndex = i;
  }
  
  if (!bestImage) {
    throw new Error('No suitable image found in COG');
  }
  
  console.log(`Using image index ${bestIndex}: ${bestImage.getWidth()}x${bestImage.getHeight()}`);
  
  // Read the raster data
  const rasters = await bestImage.readRasters({ interleave: true });
  const width = bestImage.getWidth();
  const height = bestImage.getHeight();
  const samplesPerPixel = bestImage.getSamplesPerPixel();
  
  console.log(`Read ${rasters.length} values, ${samplesPerPixel} samples/pixel`);
  
  // Convert to RGBA for canvas/texture use
  const rgba = new Uint8ClampedArray(width * height * 4);
  const data = rasters as Uint8Array | Uint16Array | Float32Array;
  
  for (let i = 0; i < width * height; i++) {
    if (samplesPerPixel >= 3) {
      // RGB or RGBA
      rgba[i * 4 + 0] = clampByte(data[i * samplesPerPixel + 0]);
      rgba[i * 4 + 1] = clampByte(data[i * samplesPerPixel + 1]);
      rgba[i * 4 + 2] = clampByte(data[i * samplesPerPixel + 2]);
      rgba[i * 4 + 3] = samplesPerPixel >= 4 ? clampByte(data[i * samplesPerPixel + 3]) : 255;
    } else {
      // Grayscale
      const v = clampByte(data[i]);
      rgba[i * 4 + 0] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  }
  
  return { data: rgba, width, height };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Convert RGBA data to a data URL for use as texture.
 */
export function rgbaToDataUrl(
  data: Uint8ClampedArray, 
  width: number, 
  height: number
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  // Ensure we have a regular ArrayBuffer-backed array
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(data);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}
