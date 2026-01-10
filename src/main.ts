/**
 * Ortho COG Viewer - Main entry point
 *
 * Uses minimal WebGL2 for textured mesh rendering with deck.gl for view control.
 */

import { Deck, OrthographicView } from '@deck.gl/core';
import { generateGridMesh } from './mesh';
import { computeTextureCoords, transformBounds, SourceBounds } from './uv';
import { registerProjections } from './crs';
import { loadCOGMetadata, loadCOGPreview } from './cog';
import { MeshRenderer } from './MeshRenderer';

registerProjections();

const COG_URL = 'https://projects.pawsey.org.au/image-cogs/images/Topographic_Base_Map.tif';
const DISPLAY_CRS = 'EPSG:3857';
const GRID_SIZE = 32;

function createTestPattern(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const cellSize = width / 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#4a90d9' : '#2d5986';
      ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
    }
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = '20px monospace';
  ctx.fillText('NW', 10, 30);
  ctx.fillText('NE', width - 40, 30);
  ctx.fillText('SW', 10, height - 10);
  ctx.fillText('SE', width - 40, height - 10);
  return canvas;
}

async function main() {
  const infoEl = document.getElementById('info')!;
  const setStatus = (msg: string) => {
    console.log(msg);
    infoEl.innerHTML = `<strong>Ortho COG Viewer</strong><br>${msg}`;
  };

  setStatus('Loading COG metadata...');

  let sourceCRS: string;
  let sourceBounds: SourceBounds;
  let textureCanvas: HTMLCanvasElement;

  try {
    const metadata = await loadCOGMetadata(COG_URL);
    if (!metadata.crs) throw new Error('COG has no CRS information');
    sourceCRS = metadata.crs;
    sourceBounds = metadata.bounds;
    setStatus(`COG CRS: ${sourceCRS}<br>Loading preview...`);

    const preview = await loadCOGPreview(COG_URL, 2048);

    // Create canvas from preview data
    textureCanvas = document.createElement('canvas');
    textureCanvas.width = preview.width;
    textureCanvas.height = preview.height;
    const ctx = textureCanvas.getContext('2d')!;
    const imageData = ctx.createImageData(preview.width, preview.height);
    imageData.data.set(preview.data);
    ctx.putImageData(imageData, 0, 0);

    setStatus(`Loaded ${preview.width}x${preview.height} preview`);
  } catch (err) {
    console.error('Failed to load COG:', err);
    setStatus(`COG load failed: ${err}<br>Using test pattern`);
    sourceCRS = 'EPSG:4326';
    sourceBounds = { minX: 112, minY: -44, maxX: 154, maxY: -10 };
    textureCanvas = createTestPattern(512, 512);
  }

  const displayBounds = transformBounds(sourceBounds, sourceCRS, DISPLAY_CRS);
  console.log('Source CRS:', sourceCRS);
  console.log('Display bounds:', displayBounds);

  // Generate mesh in display space
  const mesh = generateGridMesh(
    [displayBounds.minX, displayBounds.minY, displayBounds.maxX, displayBounds.maxY],
    GRID_SIZE
  );
  console.log(`Mesh: ${mesh.vertexCount} vertices, ${mesh.triangleCount} triangles`);

  // Compute UVs via inverse projection
  mesh.texCoords = computeTextureCoords(
    mesh.positions,
    DISPLAY_CRS,
    sourceCRS,
    sourceBounds
  );

  // Log some UVs for debugging
  console.log('Sample UVs:');
  for (let i = 0; i < 3; i++) {
    console.log(`  vertex ${i}: u=${mesh.texCoords[i*2].toFixed(4)}, v=${mesh.texCoords[i*2+1].toFixed(4)}`);
  }

  // Calculate view parameters
  const centerX = (displayBounds.minX + displayBounds.maxX) / 2;
  const centerY = (displayBounds.minY + displayBounds.maxY) / 2;
  const boundsWidth = displayBounds.maxX - displayBounds.minX;
  const boundsHeight = displayBounds.maxY - displayBounds.minY;
  const initialZoom = Math.log2(Math.min(window.innerWidth, window.innerHeight) / Math.max(boundsWidth, boundsHeight));

  const container = document.getElementById('app') as HTMLDivElement;
  if (!container) throw new Error('App container not found');

  // Renderer and view state
  let meshRenderer: MeshRenderer | null = null;
  let currentViewState = {
    target: [centerX, centerY, 0] as [number, number, number],
    zoom: initialZoom
  };

  const deck = new Deck({
    parent: container,
    views: new OrthographicView({
      id: 'ortho',
      flipY: false,
      controller: true
    }),
    initialViewState: {
      target: [centerX, centerY, 0],
      zoom: initialZoom,
      minZoom: -20,
      maxZoom: 10
    },
    controller: true,
    layers: [],

    onLoad: () => {
      console.log('Deck loaded, setting up WebGL renderer...');

      const canvas = container.querySelector('canvas');
      if (!canvas) {
        console.error('No canvas found');
        return;
      }

      const gl = canvas.getContext('webgl2');
      if (!gl) {
        console.error('No WebGL2 context');
        return;
      }

      meshRenderer = new MeshRenderer(gl);
      meshRenderer.setMesh({
        positions: mesh.positions,
        texCoords: mesh.texCoords,
        indices: mesh.indices
      });
      meshRenderer.setTexture(textureCanvas);

      console.log('WebGL renderer ready');
    },

    onViewStateChange: ({ viewState }) => {
      currentViewState = {
        target: viewState.target as [number, number, number],
        zoom: typeof viewState.zoom === 'number' ? viewState.zoom : initialZoom
      };

      infoEl.innerHTML = `
        <strong>Ortho COG Viewer</strong><br>
        Display: ${DISPLAY_CRS}<br>
        Source: ${sourceCRS}<br>
        Grid: ${GRID_SIZE}×${GRID_SIZE}<br>
        Zoom: ${currentViewState.zoom.toFixed(2)}
      `;
    },

    onAfterRender: () => {
      if (!meshRenderer) return;

      const viewport = deck.getViewports()[0];
      if (!viewport) return;

      meshRenderer.renderWithViewport(
        currentViewState.target[0],
        currentViewState.target[1],
        currentViewState.zoom,
        viewport.width,
        viewport.height
      );
    }
  });

  console.log('Viewer initialized');
}

main().catch(console.error);
