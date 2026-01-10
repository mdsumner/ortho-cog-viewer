/**
 * Ortho COG Viewer - Main entry point
 *
 * Pure WebGL2 implementation with custom view controller.
 * No deck.gl dependency.
 */

import { generateGridMesh } from './mesh';
import { computeTextureCoords, transformBounds, SourceBounds } from './uv';
import { registerProjections } from './crs';
import { loadCOGMetadata, loadCOGPreview } from './cog';
import { MeshRenderer } from './MeshRenderer';
import { ViewController, ViewState } from './ViewController';

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
  const container = document.getElementById('app')!;
  
  const setStatus = (msg: string) => {
    console.log(msg);
    infoEl.innerHTML = `<strong>Ortho COG Viewer</strong><br>${msg}`;
  };

  // Create canvas
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.cursor = 'grab';
  container.appendChild(canvas);

  // Handle high-DPI displays
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Get WebGL2 context
  const glContext = canvas.getContext('webgl2', { 
    antialias: true,
    alpha: false 
  });
  if (!glContext) {
    setStatus('WebGL2 not supported');
    return;
  }
  const gl = glContext;  // TypeScript now knows gl is non-null

  // Clear function
  function clear() {
    gl.clearColor(0.1, 0.1, 0.1, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

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

  // Create renderer
  const renderer = new MeshRenderer(gl);
  renderer.setMesh({
    positions: mesh.positions,
    texCoords: mesh.texCoords,
    indices: mesh.indices
  });
  renderer.setTexture(textureCanvas);

  // Render function
  function render(state: ViewState) {
    // Clear with a background color
    clear();

    // Render the mesh
    renderer.renderWithViewport(
      state.centerX,
      state.centerY,
      state.zoom,
      canvas.clientWidth,
      canvas.clientHeight
    );

    // Update info
    infoEl.innerHTML = `
      <strong>Ortho COG Viewer</strong><br>
      Display: ${DISPLAY_CRS}<br>
      Source: ${sourceCRS}<br>
      Grid: ${GRID_SIZE}×${GRID_SIZE}<br>
      Zoom: ${state.zoom.toFixed(2)}
    `;
  }

  // Calculate initial zoom to fit bounds
  const boundsWidth = displayBounds.maxX - displayBounds.minX;
  const boundsHeight = displayBounds.maxY - displayBounds.minY;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const scale = Math.min(cssWidth / boundsWidth, cssHeight / boundsHeight) * 0.9;
  const initialZoom = Math.log2(scale);

  // Create view controller
  const controller = new ViewController(
    canvas,
    {
      centerX: (displayBounds.minX + displayBounds.maxX) / 2,
      centerY: (displayBounds.minY + displayBounds.maxY) / 2,
      zoom: initialZoom
    },
    render  // Called on every view change
  );

  // Also re-render on resize
  window.addEventListener('resize', () => {
    resizeCanvas();
    render(controller.getState());
  });

  console.log('Viewer ready (no deck.gl!)');
}

main().catch(console.error);
