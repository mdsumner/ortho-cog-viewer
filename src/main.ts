/**
 * Ortho COG Viewer - Main entry point
 *
 * Multi-layer COG viewer with arbitrary source CRS → Mercator display.
 */

import { generateGridMesh, GridMesh } from './mesh';
import { computeTextureCoords, SourceBounds } from './uv';
import { registerProjections } from './crs';
import { loadCOGMetadata, getOverviews, selectOverview, loadOverview, OverviewInfo } from './cog';
import { MeshRenderer } from './MeshRenderer';
import { ViewController, ViewState } from './ViewController';

registerProjections();

const DISPLAY_CRS = 'EPSG:3857';
const GRID_SIZE = 32;
const WORLD_EXTENT = Math.PI * 6378137 * 2;

// Layer state
interface Layer {
  id: number;
  url: string;
  sourceCRS: string;
  sourceBounds: SourceBounds;
  overviews: OverviewInfo[];
  currentOverviewIndex: number;
  renderer: MeshRenderer;
  isLoading: boolean;
}

let layers: Layer[] = [];
let nextLayerId = 0;
let baseMesh: GridMesh;
let gl: WebGL2RenderingContext;
let viewController: ViewController;
let canvas: HTMLCanvasElement;

// UI elements
let urlInput: HTMLInputElement;
let infoEl: HTMLElement;
let layersEl: HTMLElement;

/**
 * Convert RGBA data to canvas
 */
function rgbaToCanvas(data: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(data);
  ctx.putImageData(imageData, 0, 0);
  return c;
}

/**
 * Add a new layer from URL
 */
async function addLayer(url: string): Promise<Layer | null> {
  console.log('Adding layer:', url);
  
  try {
    // Load metadata
    const metadata = await loadCOGMetadata(url);
    if (!metadata.crs) {
      throw new Error('COG has no CRS information');
    }
    
    // Get overviews
    const overviews = await getOverviews(url, metadata.bounds);
    
    // Compute UVs for this source
    const texCoords = computeTextureCoords(
      baseMesh.positions,
      DISPLAY_CRS,
      metadata.crs,
      metadata.bounds
    );
    
    // Create renderer for this layer
    const renderer = new MeshRenderer(gl);
    renderer.setMesh({
      positions: baseMesh.positions,
      texCoords: texCoords,
      indices: baseMesh.indices
    });
    
    const layer: Layer = {
      id: nextLayerId++,
      url,
      sourceCRS: metadata.crs,
      sourceBounds: metadata.bounds,
      overviews,
      currentOverviewIndex: -1,
      renderer,
      isLoading: false
    };
    
    layers.push(layer);
    
    // Load initial overview
    await updateLayerOverview(layer, viewController.getState());
    
    updateUI();
    render(viewController.getState());
    
    return layer;
  } catch (err) {
    console.error('Failed to add layer:', err);
    alert(`Failed to load COG: ${err}`);
    return null;
  }
}

/**
 * Remove a layer
 */
function removeLayer(id: number): void {
  layers = layers.filter(l => l.id !== id);
  updateUI();
  render(viewController.getState());
}

/**
 * Update layer overview based on zoom
 */
async function updateLayerOverview(layer: Layer, state: ViewState): Promise<void> {
  if (layer.isLoading || layer.overviews.length === 0) return;
  
  const displayRes = 1 / Math.pow(2, state.zoom);
  const needed = selectOverview(layer.overviews, displayRes);
  
  if (needed.index !== layer.currentOverviewIndex) {
    layer.isLoading = true;
    layer.currentOverviewIndex = needed.index;
    updateUI();
    
    try {
      const data = await loadOverview(layer.url, needed.index);
      const textureCanvas = rgbaToCanvas(data.data, data.width, data.height);
      layer.renderer.updateTexture(textureCanvas);
    } catch (err) {
      console.error('Failed to load overview:', err);
    } finally {
      layer.isLoading = false;
      updateUI();
    }
  }
}

/**
 * Update all layer overviews
 */
let updateTimeout: number | null = null;
function scheduleOverviewUpdates(state: ViewState): void {
  if (updateTimeout) clearTimeout(updateTimeout);
  updateTimeout = window.setTimeout(() => {
    layers.forEach(layer => updateLayerOverview(layer, state));
    updateTimeout = null;
  }, 150);
}

/**
 * Render all layers
 */
function render(state: ViewState): void {
  // Clear
  gl.clearColor(0.1, 0.1, 0.1, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  // Render each layer (back to front)
  for (const layer of layers) {
    layer.renderer.renderWithViewport(
      state.centerX,
      state.centerY,
      state.zoom,
      canvas.clientWidth,
      canvas.clientHeight
    );
  }
  
  updateInfo(state);
}

/**
 * Update info panel
 */
function updateInfo(state: ViewState): void {
  infoEl.innerHTML = `
    Display: ${DISPLAY_CRS}<br>
    Zoom: ${state.zoom.toFixed(2)}<br>
    Layers: ${layers.length}
  `;
}

/**
 * Update layers list UI
 */
function updateUI(): void {
  layersEl.innerHTML = layers.map(layer => {
    const ovInfo = layer.currentOverviewIndex >= 0 && layer.overviews[layer.currentOverviewIndex]
      ? `${layer.overviews[layer.currentOverviewIndex].width}×${layer.overviews[layer.currentOverviewIndex].height}`
      : '...';
    const loading = layer.isLoading ? ' ⏳' : '';
    const shortUrl = layer.url.split('/').pop() || layer.url;
    
    return `
      <div class="layer-item">
        <button onclick="window.removeLayer(${layer.id})">×</button>
        <span title="${layer.url}">${shortUrl}</span>
        <span>(${layer.sourceCRS}, ${ovInfo}${loading})</span>
      </div>
    `;
  }).join('');
}

/**
 * Main entry point
 */
async function main() {
  const container = document.getElementById('app')!;
  urlInput = document.getElementById('cog-url') as HTMLInputElement;
  infoEl = document.getElementById('info')!;
  layersEl = document.getElementById('layers')!;
  const loadBtn = document.getElementById('load-btn')!;
  const addBtn = document.getElementById('add-btn')!;
  
  // Create canvas
  canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.cursor = 'grab';
  container.appendChild(canvas);
  
  // Handle high-DPI
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }
  resizeCanvas();
  window.addEventListener('resize', () => {
    resizeCanvas();
    render(viewController.getState());
  });
  
  // Get WebGL2 context
  const glContext = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!glContext) {
    infoEl.innerHTML = 'WebGL2 not supported';
    return;
  }
  gl = glContext;
  
  // Generate base mesh (fixed world extent)
  const displayBounds = {
    minX: -WORLD_EXTENT,
    minY: -WORLD_EXTENT,
    maxX: WORLD_EXTENT,
    maxY: WORLD_EXTENT
  };
  baseMesh = generateGridMesh(
    [displayBounds.minX, displayBounds.minY, displayBounds.maxX, displayBounds.maxY],
    GRID_SIZE
  );
  console.log(`Base mesh: ${baseMesh.vertexCount} vertices`);
  
  // View controller
  viewController = new ViewController(
    canvas,
    { centerX: 0, centerY: 0, zoom: -16 },
    (state) => {
      render(state);
      scheduleOverviewUpdates(state);
    }
  );
  
  // Wire up UI
  loadBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    layers = [];  // Clear existing
    await addLayer(url);
  });
  
  addBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    await addLayer(url);
  });
  
  urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      loadBtn.click();
    }
  });
  
  // Expose removeLayer globally for onclick
  (window as any).removeLayer = removeLayer;
  
  // Load default COG
  urlInput.value = 'https://projects.pawsey.org.au/image-cogs/images/IBCSO_v2_digital_chart.tif';
  await addLayer(urlInput.value);
  
  console.log('Viewer ready!');
}

main().catch(console.error);
