/**
 * Ortho COG Viewer - Main entry point
 *
 * Pure WebGL2 implementation with custom view controller.
 * Multi-resolution COG support - loads appropriate overview based on zoom.
 */

import { generateGridMesh } from './mesh';
import { computeTextureCoords, transformBounds, SourceBounds } from './uv';
import { registerProjections } from './crs';
import { loadCOGMetadata, getOverviews, selectOverview, loadOverview, OverviewInfo } from './cog';
import { MeshRenderer } from './MeshRenderer';
import { ViewController, ViewState } from './ViewController';

registerProjections();

const COG_URL = 'https://projects.pawsey.org.au/image-cogs/images/IBCSO_v2_digital_chart.tif';
const DISPLAY_CRS = 'EPSG:3857';  // Always display in Mercator
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

/**
 * Convert RGBA data to canvas
 */
function rgbaToCanvas(data: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(data);
  ctx.putImageData(imageData, 0, 0);
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
  const gl = glContext;

  // Clear function
  function clear() {
    gl.clearColor(0.1, 0.1, 0.1, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  setStatus('Loading COG metadata...');

  let sourceCRS: string;
  let sourceBounds: SourceBounds;
  let overviews: OverviewInfo[] = [];
  let currentOverviewIndex = -1;
  let isLoadingOverview = false;

  try {
    const metadata = await loadCOGMetadata(COG_URL);
    if (!metadata.crs) throw new Error('COG has no CRS information');
    sourceCRS = metadata.crs;
    sourceBounds = metadata.bounds;
    
    setStatus(`COG CRS: ${sourceCRS}<br>Loading overviews...`);
    
    // Get overview info
    overviews = await getOverviews(COG_URL, sourceBounds);
    
    setStatus(`Found ${overviews.length} resolution levels`);
  } catch (err) {
    console.error('Failed to load COG:', err);
    setStatus(`COG load failed: ${err}<br>Using test pattern`);
    sourceCRS = 'EPSG:4326';
    sourceBounds = { minX: 112, minY: -44, maxX: 154, maxY: -10 };
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

  // Start with test pattern, will be replaced when overview loads
  let textureCanvas = createTestPattern(256, 256);
  renderer.setTexture(textureCanvas);

  // Calculate display resolution from view state
  // Returns world units per CSS pixel
  function getDisplayResolution(state: ViewState): number {
    const scale = Math.pow(2, state.zoom);
    // At zoom=0, 1 CSS pixel = 1 world unit
    // At zoom=1, 1 CSS pixel = 0.5 world units (zoomed in)
    // At zoom=-1, 1 CSS pixel = 2 world units (zoomed out)
    return 1 / scale;
  }

  // Load overview if needed based on current resolution
  async function updateOverviewIfNeeded(state: ViewState) {
    if (overviews.length === 0 || isLoadingOverview) return;

    const displayRes = getDisplayResolution(state);
    const needed = selectOverview(overviews, displayRes);
    
    if (needed.index !== currentOverviewIndex) {
      console.log(`Resolution change: ${displayRes.toFixed(1)} -> need overview ${needed.index} (${needed.width}x${needed.height})`);
      
      isLoadingOverview = true;
      currentOverviewIndex = needed.index;
      
      try {
        const data = await loadOverview(COG_URL, needed.index);
        textureCanvas = rgbaToCanvas(data.data, data.width, data.height);
        renderer.updateTexture(textureCanvas);
        
        // Re-render with new texture
        render(state);
      } catch (err) {
        console.error('Failed to load overview:', err);
      } finally {
        isLoadingOverview = false;
      }
    }
  }

  // Render function
  function render(state: ViewState) {
    clear();

    renderer.renderWithViewport(
      state.centerX,
      state.centerY,
      state.zoom,
      canvas.clientWidth,
      canvas.clientHeight
    );

    // Show current overview info
    const ovInfo = currentOverviewIndex >= 0 && overviews[currentOverviewIndex]
      ? `${overviews[currentOverviewIndex].width}×${overviews[currentOverviewIndex].height}`
      : 'loading...';

    infoEl.innerHTML = `
      <strong>Ortho COG Viewer</strong><br>
      Display: ${DISPLAY_CRS}<br>
      Source: ${sourceCRS}<br>
      Overview: ${ovInfo}${isLoadingOverview ? ' ⏳' : ''}<br>
      Zoom: ${state.zoom.toFixed(2)}
    `;
  }

  // Debounce overview loading to avoid excessive requests during zoom
  let updateTimeout: number | null = null;
  function scheduleOverviewUpdate(state: ViewState) {
    if (updateTimeout) {
      clearTimeout(updateTimeout);
    }
    updateTimeout = window.setTimeout(() => {
      updateOverviewIfNeeded(state);
      updateTimeout = null;
    }, 150);  // Wait 150ms after last zoom change
  }

  // Calculate initial zoom to fit bounds
  const boundsWidth = displayBounds.maxX - displayBounds.minX;
  const boundsHeight = displayBounds.maxY - displayBounds.minY;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const scale = Math.min(cssWidth / boundsWidth, cssHeight / boundsHeight) * 0.9;
  const initialZoom = Math.log2(scale);

  // View change handler
  function onViewChange(state: ViewState) {
    render(state);
    scheduleOverviewUpdate(state);
  }

  // Create view controller
  const controller = new ViewController(
    canvas,
    {
      centerX: (displayBounds.minX + displayBounds.maxX) / 2,
      centerY: (displayBounds.minY + displayBounds.maxY) / 2,
      zoom: initialZoom
    },
    onViewChange
  );

  // Also re-render on resize
  window.addEventListener('resize', () => {
    resizeCanvas();
    const state = controller.getState();
    render(state);
    scheduleOverviewUpdate(state);
  });

  // Load initial overview
  const initialState = controller.getState();
  updateOverviewIfNeeded(initialState);

  console.log('Viewer ready with multi-resolution support!');
}

main().catch(console.error);
