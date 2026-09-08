/**
 * Ortho COG Viewer - Main entry point
 *
 * Multi-layer COG viewer with arbitrary source CRS -> arbitrary display CRS.
 *
 * Two view modes share the same renderer, loader and UV machinery:
 *
 *   fixed    A static display CRS and mesh extent; a camera pans/zooms over it.
 *            This is the original design.
 *
 *   centred  The display CRS is a template whose lon_0/lat_0 track the view
 *            centre. The mesh is always the screen rectangle around (0, 0)
 *            and panning moves the projection centre. See centred.ts.
 */

import { generateGridMesh, GridMesh } from './mesh';
import { buildLayerGeometry, isLongLat, transformBounds, SourceBounds } from './uv';
import { registerProjections, ensureCRS } from './crs';
import { loadCOGMetadata, getOverviews, selectOverview, loadOverview, OverviewInfo } from './cog';
import { MeshRenderer } from './MeshRenderer';
import { LineRenderer } from './LineRenderer';
import { buildGraticule } from './graticule';
import { ViewController, ViewState } from './ViewController';
import { CENTRED_PRESETS, centredCRS, isPresetName, panCentre, resolveTemplate, normaliseLonLat } from './centred';
import proj4 from 'proj4';

registerProjections();

type Mode = 'fixed' | 'centred';

const DEFAULT_EXTENT = Math.PI * 6378137 * 2;  // ~40M meters
const MAX_VERTICES = 66000;  // ~256x256 grid max
const DEFAULT_COG = 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/january/world.200401.3x5400x2700_geo.tif';

// ---------------------------------------------------------------------------
// Display state
// ---------------------------------------------------------------------------

let mode: Mode = 'centred';
let gridSize = 64;
let showWireframe = false;
let showGraticule = true;
let graticuleCRS = '';        // display CRS the current graticule was built for

// fixed mode
let displayCRS = 'EPSG:3857';
let meshExtent = {
  minX: -DEFAULT_EXTENT,
  minY: -DEFAULT_EXTENT,
  maxX: DEFAULT_EXTENT,
  maxY: DEFAULT_EXTENT
};

// centred mode
let centredProj = 'ortho';            // preset name or raw template
let centreLon = 135;
let centreLat = -35;
let meshZoom = NaN;                   // zoom the current screen mesh was built for
let meshCssW = 0;
let meshCssH = 0;

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
  validFraction: number;
  wrapU: boolean;
}

let layers: Layer[] = [];
let nextLayerId = 0;
let baseMesh: GridMesh;
let gl: WebGL2RenderingContext;
let viewController: ViewController;
let canvas: HTMLCanvasElement;

// UI elements
let urlInput: HTMLInputElement;
let modeSelect: HTMLSelectElement;
let fixedPanel: HTMLElement;
let centredPanel: HTMLElement;
let displayCrsInput: HTMLInputElement;
let extentInput: HTMLInputElement;
let projSelect: HTMLSelectElement;
let projTemplateInput: HTMLInputElement;
let centreLonInput: HTMLInputElement;
let centreLatInput: HTMLInputElement;
let gridSizeInput: HTMLInputElement;
let wireframeInput: HTMLInputElement;
let graticuleInput: HTMLInputElement;
let gratMinor: LineRenderer;
let gratMajor: LineRenderer;
let vertexCountEl: HTMLElement;
let infoEl: HTMLElement;
let layersEl: HTMLElement;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentDisplayCRS(): string {
  if (mode === 'centred') {
    return centredCRS(resolveTemplate(centredProj), centreLon, centreLat);
  }
  return displayCRS;
}

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
 * Rebuild the base mesh for the current mode.
 *
 * fixed:   the configured extent, gridSize x gridSize.
 * centred: the screen rectangle in display metres around (0,0), with roughly
 *          square cells. Only depends on zoom and canvas size.
 */
function regenerateMesh(state?: ViewState): void {
  if (mode === 'centred') {
    const zoom = state ? state.zoom : viewController.getState().zoom;
    const cssW = canvas.clientWidth || 1;
    const cssH = canvas.clientHeight || 1;
    const scale = Math.pow(2, zoom);
    const halfW = cssW / scale / 2;
    const halfH = cssH / scale / 2;
    const rows = Math.max(4, Math.round(gridSize * cssH / cssW));
    baseMesh = generateGridMesh([-halfW, -halfH, halfW, halfH], gridSize, rows);
    meshZoom = zoom;
    meshCssW = cssW;
    meshCssH = cssH;
  } else {
    baseMesh = generateGridMesh(
      [meshExtent.minX, meshExtent.minY, meshExtent.maxX, meshExtent.maxY],
      gridSize
    );
  }
  updateVertexCount();
}

function meshCellSize(): number {
  // Width of one cell in display units; used to scale the round-trip tolerance.
  const p = baseMesh.positions;
  return Math.abs(p[3] - p[0]) || 1;
}

function updateVertexCount(): void {
  const verts = baseMesh ? baseMesh.vertexCount : (gridSize + 1) * (gridSize + 1);
  vertexCountEl.textContent = `(${verts} verts)`;
  vertexCountEl.style.color = verts > MAX_VERTICES ? '#f66' : '#aaa';
}

/**
 * Recompute UVs (and the validity-filtered index buffer) for a layer.
 */
function updateLayerMesh(layer: Layer): void {
  const crs = currentDisplayCRS();
  const geom = buildLayerGeometry(
    baseMesh.positions,
    baseMesh.indices,
    crs,
    layer.sourceCRS,
    layer.sourceBounds,
    meshCellSize() * 1e-2,
    layer.wrapU
  );
  layer.validFraction = geom.validFraction;
  layer.renderer.setMesh({
    positions: geom.positions,
    texCoords: geom.texCoords,
    indices: geom.indices
  });
}

/**
 * A source is periodic in u when it is geographic and spans all longitudes.
 */
function sourceWrapsU(crs: string, b: SourceBounds): boolean {
  return isLongLat(crs) && (b.maxX - b.minX) >= 359.9;
}

/**
 * Rebuild the graticule if the display CRS changed since it was last built.
 */
function updateGraticule(): void {
  if (!showGraticule || !baseMesh) return;
  const crs = currentDisplayCRS();
  if (crs === graticuleCRS) return;
  const g = buildGraticule(crs, { stepDeg: 10, sampleDeg: 1, tolerance: meshCellSize() * 1e-2 });
  gratMinor.setLines(g.minor);
  gratMajor.setLines(g.major);
  graticuleCRS = crs;
}

function updateAllLayerMeshes(): void {
  for (const layer of layers) {
    try {
      updateLayerMesh(layer);
    } catch (err) {
      console.error(`Failed to update layer ${layer.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// View change handling
// ---------------------------------------------------------------------------

let rafPending = false;
let pendingState: ViewState | null = null;

function onViewChange(state: ViewState): void {
  pendingState = state;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const s = pendingState!;
    pendingState = null;
    handleViewChange(s);
  });
}

function handleViewChange(state: ViewState): void {
  if (mode === 'centred') {
    // Consume any pan offset: the display point now at the screen centre
    // becomes the new projection centre, and the camera snaps back to origin.
    if (state.centerX !== 0 || state.centerY !== 0) {
      const next = panCentre(resolveTemplate(centredProj), centreLon, centreLat, state.centerX, state.centerY);
      if (next) {
        [centreLon, centreLat] = next;
      }
      viewController.setState({ centerX: 0, centerY: 0 });
      state = viewController.getState();
      syncCentreInputs();
    }
    if (state.zoom !== meshZoom || canvas.clientWidth !== meshCssW || canvas.clientHeight !== meshCssH) {
      regenerateMesh(state);
    }
    updateAllLayerMeshes();
  }
  render(state);
  scheduleOverviewUpdates(state);
  scheduleUrlUpdate();
}

function makeViewController(initial: ViewState): void {
  if (viewController) viewController.destroy();
  viewController = new ViewController(canvas, initial, onViewChange);
}

// ---------------------------------------------------------------------------
// Applying display settings from the UI
// ---------------------------------------------------------------------------

function readGridSize(): number | null {
  const n = parseInt(gridSizeInput.value);
  if (isNaN(n) || n < 4) {
    alert('Grid size must be at least 4');
    return null;
  }
  const verts = (n + 1) * (n + 1);
  if (verts > MAX_VERTICES) {
    if (!confirm(`Grid ${n}x${n} = ${verts} vertices. This may be slow. Continue?`)) {
      return null;
    }
  }
  return n;
}

function applyDisplaySettings(): void {
  const newMode = modeSelect.value as Mode;
  const newGrid = readGridSize();
  if (newGrid === null) return;

  if (newMode === 'fixed') {
    const newCRS = displayCrsInput.value.trim();
    if (!newCRS) {
      alert('Invalid CRS');
      return;
    }
    const parts = extentInput.value.split(',').map(s => parseFloat(s.trim()));
    if (parts.length !== 4 || parts.some(isNaN)) {
      alert('Invalid extent. Use format: xmin,xmax,ymin,ymax');
      return;
    }
    const [xmin, xmax, ymin, ymax] = parts;
    try {
      proj4(newCRS, 'EPSG:4326');
    } catch (err) {
      alert(`Unknown CRS: ${newCRS}\n${err}`);
      return;
    }

    mode = 'fixed';
    gridSize = newGrid;
    displayCRS = newCRS;
    meshExtent = { minX: xmin, minY: ymin, maxX: xmax, maxY: ymax };

    regenerateMesh();
    updateAllLayerMeshes();

    const centerX = (xmin + xmax) / 2;
    const centerY = (ymin + ymax) / 2;
    const zoom = Math.log2(canvas.clientWidth / (xmax - xmin));
    makeViewController({ centerX, centerY, zoom });
  } else {
    const proj = projSelect.value === 'custom' ? projTemplateInput.value.trim() : projSelect.value;
    if (!proj) {
      alert('Enter a proj template with {lon_0} and {lat_0} placeholders');
      return;
    }
    const lon = parseFloat(centreLonInput.value);
    const lat = parseFloat(centreLatInput.value);
    if (isNaN(lon) || isNaN(lat)) {
      alert('Invalid centre');
      return;
    }
    try {
      proj4(centredCRS(resolveTemplate(proj), lon, lat), 'EPSG:4326');
    } catch (err) {
      alert(`Projection template failed to parse:\n${err}`);
      return;
    }

    const wasCentred = mode === 'centred';
    mode = 'centred';
    gridSize = newGrid;
    centredProj = proj;
    [centreLon, centreLat] = normaliseLonLat(lon, lat);

    const zoom = wasCentred ? viewController.getState().zoom : defaultCentredZoom();
    makeViewController({ centerX: 0, centerY: 0, zoom });
    // ViewController fires onChange on construction, which builds the mesh
    // and UVs via handleViewChange on the next frame.
  }
  syncUI();
}

function defaultCentredZoom(): number {
  // Fit a hemisphere (2 earth radii) to the shorter screen dimension.
  const px = Math.min(canvas.clientWidth, canvas.clientHeight) || 512;
  return Math.log2(px / (2 * 6378137 * 1.05));
}

/**
 * Centre / fit the view on a layer.
 */
function fitLayer(layer: Layer): void {
  if (mode === 'centred') {
    const b = layer.sourceBounds;
    const toGeo = proj4(layer.sourceCRS, 'EPSG:4326');
    const [lon, lat] = toGeo.forward([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]);
    if (!isFinite(lon) || !isFinite(lat)) return;
    [centreLon, centreLat] = normaliseLonLat(lon, lat);
    const crs = currentDisplayCRS();
    const tb = transformBounds(b, layer.sourceCRS, crs, 30);
    const w = Math.max(tb.maxX - tb.minX, tb.maxY - tb.minY);
    const zoom = isFinite(w) && w > 0
      ? Math.log2(Math.min(canvas.clientWidth, canvas.clientHeight) / (w * 1.1))
      : defaultCentredZoom();
    makeViewController({ centerX: 0, centerY: 0, zoom });
    syncCentreInputs();
  } else {
    const tb = transformBounds(layer.sourceBounds, layer.sourceCRS, displayCRS, 30);
    viewController.fitBounds(tb.minX, tb.minY, tb.maxX, tb.maxY);
  }
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

async function addLayer(url: string): Promise<Layer | null> {
  console.log('Adding layer:', url);
  try {
    const metadata = await loadCOGMetadata(url);
    if (!metadata.crs) {
      throw new Error('COG has no CRS information');
    }
    if (!ensureCRS(metadata.crs)) {
      throw new Error(`Source CRS ${metadata.crs} is not registered in crs.ts (UTM zones are synthesised; other EPSG codes need a def)`);
    }

    const overviews = await getOverviews(url, metadata.bounds);
    const renderer = new MeshRenderer(gl);
    const wrapU = sourceWrapsU(metadata.crs, metadata.bounds);
    renderer.setWrapU(wrapU);

    const layer: Layer = {
      id: nextLayerId++,
      url,
      sourceCRS: metadata.crs,
      sourceBounds: metadata.bounds,
      overviews,
      currentOverviewIndex: -1,
      renderer,
      isLoading: false,
      validFraction: 0,
      wrapU
    };

    updateLayerMesh(layer);
    layers.push(layer);

    await updateLayerOverview(layer, viewController.getState());

    updateUI();
    render(viewController.getState());
    scheduleUrlUpdate();
    return layer;
  } catch (err) {
    console.error('Failed to add layer:', err);
    alert(`Failed to load COG: ${err}`);
    return null;
  }
}

function removeLayer(id: number): void {
  const layer = layers.find(l => l.id === id);
  if (layer) layer.renderer.dispose();
  layers = layers.filter(l => l.id !== id);
  updateUI();
  render(viewController.getState());
  scheduleUrlUpdate();
}

function clearLayers(): void {
  for (const l of layers) l.renderer.dispose();
  layers = [];
}

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
      render(viewController.getState());
    } catch (err) {
      console.error('Failed to load overview:', err);
    } finally {
      layer.isLoading = false;
      updateUI();
    }
  }
}

let updateTimeout: number | null = null;
function scheduleOverviewUpdates(state: ViewState): void {
  if (updateTimeout) clearTimeout(updateTimeout);
  updateTimeout = window.setTimeout(() => {
    layers.forEach(layer => updateLayerOverview(layer, state));
    updateTimeout = null;
  }, 150);
}

// ---------------------------------------------------------------------------
// Rendering and UI
// ---------------------------------------------------------------------------

function render(state: ViewState): void {
  gl.clearColor(0.1, 0.1, 0.1, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  for (const layer of layers) {
    layer.renderer.renderWithViewport(
      state.centerX,
      state.centerY,
      state.zoom,
      canvas.clientWidth,
      canvas.clientHeight
    );
  }
  if (showGraticule) {
    updateGraticule();
    gratMinor.render(state.centerX, state.centerY, state.zoom, [1, 1, 1, 0.25]);
    gratMajor.render(state.centerX, state.centerY, state.zoom, [1, 1, 1, 0.6]);
  }
  if (showWireframe) {
    const colors: [number, number, number, number][] = [
      [1, 1, 0, 0.55], [0, 1, 1, 0.55], [1, 0.4, 1, 0.55], [0.5, 1, 0.5, 0.55]
    ];
    layers.forEach((layer, i) => {
      layer.renderer.renderWireframe(state.centerX, state.centerY, state.zoom, colors[i % colors.length]);
    });
  }
  updateInfo(state);
}

function updateInfo(state: ViewState): void {
  const crs = currentDisplayCRS();
  const metresPerPx = 1 / Math.pow(2, state.zoom);
  const lines = [
    `Mode: ${mode}`,
    `Display: <span class="crs-string" title="${crs}">${crs}</span>`,
    `Zoom: ${state.zoom.toFixed(2)} (${formatRes(metresPerPx)}/px)`,
  ];
  if (mode === 'centred') {
    lines.push(`Centre: ${centreLon.toFixed(4)}, ${centreLat.toFixed(4)}`);
  } else {
    lines.push(`Centre: ${state.centerX.toFixed(1)}, ${state.centerY.toFixed(1)}`);
  }
  lines.push(`Layers: ${layers.length}`);
  infoEl.innerHTML = lines.join('<br>');
}

function formatRes(v: number): string {
  if (!isFinite(v)) return '?';
  if (v >= 1000) return `${(v / 1000).toFixed(1)} km`;
  if (v >= 1) return `${v.toFixed(1)} m`;
  return `${v.toFixed(3)} m`;
}

function updateUI(): void {
  layersEl.innerHTML = layers.map(layer => {
    const ov = layer.currentOverviewIndex >= 0 && layer.overviews[layer.currentOverviewIndex];
    const ovInfo = ov ? `${ov.width}x${ov.height}` : '...';
    const loading = layer.isLoading ? ' (loading)' : '';
    const shortUrl = layer.url.split('/').pop() || layer.url;
    const pct = Math.round(layer.validFraction * 100);
    return `
      <div class="layer-item">
        <button data-remove="${layer.id}" title="Remove layer">x</button>
        <button data-fit="${layer.id}" title="Centre the view on this layer">fit</button>
        <span title="${layer.url}">${shortUrl}</span>
        <span>(${layer.sourceCRS}, ${ovInfo}${loading}, ${pct}% on-globe)</span>
      </div>
    `;
  }).join('');
}

function syncCentreInputs(): void {
  centreLonInput.value = centreLon.toFixed(4);
  centreLatInput.value = centreLat.toFixed(4);
}

/**
 * Push the current state into the form controls.
 */
function syncUI(): void {
  modeSelect.value = mode;
  fixedPanel.hidden = mode !== 'fixed';
  centredPanel.hidden = mode !== 'centred';
  gridSizeInput.value = String(gridSize);
  wireframeInput.checked = showWireframe;
  graticuleInput.checked = showGraticule;
  displayCrsInput.value = displayCRS;
  extentInput.value = [meshExtent.minX, meshExtent.maxX, meshExtent.minY, meshExtent.maxY].join(',');
  if (isPresetName(centredProj)) {
    projSelect.value = centredProj;
    projTemplateInput.value = CENTRED_PRESETS[centredProj].template;
  } else {
    projSelect.value = 'custom';
    projTemplateInput.value = centredProj;
  }
  projTemplateInput.hidden = projSelect.value !== 'custom';
  syncCentreInputs();
  updateVertexCount();
}

// ---------------------------------------------------------------------------
// URL state (so a hosted page can link to a specific scene)
// ---------------------------------------------------------------------------

function applyUrlParams(params: URLSearchParams): void {
  const m = params.get('mode');
  if (m === 'fixed' || m === 'centred') mode = m;

  const g = parseInt(params.get('grid') || '');
  if (!isNaN(g) && g >= 4) gridSize = g;

  const w = params.get('wire');
  if (w !== null) showWireframe = w === '1' || w === 'true';

  const gr = params.get('grat');
  if (gr !== null) showGraticule = gr === '1' || gr === 'true';

  const crs = params.get('crs');
  if (crs) displayCRS = crs;

  const proj = params.get('proj');
  if (proj) centredProj = proj;

  const ext = params.get('extent');
  if (ext) {
    const p = ext.split(',').map(Number);
    if (p.length === 4 && p.every(isFinite)) {
      meshExtent = { minX: p[0], maxX: p[1], minY: p[2], maxY: p[3] };
    }
  }
}

function initialViewFromParams(params: URLSearchParams): ViewState {
  const c = (params.get('center') || '').split(',').map(Number);
  const z = parseFloat(params.get('zoom') || '');
  if (mode === 'centred') {
    if (c.length === 2 && c.every(isFinite)) {
      [centreLon, centreLat] = normaliseLonLat(c[0], c[1]);
    }
    return { centerX: 0, centerY: 0, zoom: isFinite(z) ? z : defaultCentredZoom() };
  }
  const cx = c.length === 2 && isFinite(c[0]) ? c[0] : (meshExtent.minX + meshExtent.maxX) / 2;
  const cy = c.length === 2 && isFinite(c[1]) ? c[1] : (meshExtent.minY + meshExtent.maxY) / 2;
  const zoom = isFinite(z) ? z : Math.log2(canvas.clientWidth / (meshExtent.maxX - meshExtent.minX));
  return { centerX: cx, centerY: cy, zoom };
}

let urlTimeout: number | null = null;
function scheduleUrlUpdate(): void {
  if (urlTimeout) clearTimeout(urlTimeout);
  urlTimeout = window.setTimeout(writeUrl, 300);
}

function writeUrl(): void {
  const state = viewController.getState();
  const p = new URLSearchParams();
  p.set('mode', mode);
  if (mode === 'centred') {
    p.set('proj', centredProj);
    p.set('center', `${centreLon.toFixed(5)},${centreLat.toFixed(5)}`);
  } else {
    p.set('crs', displayCRS);
    p.set('extent', [meshExtent.minX, meshExtent.maxX, meshExtent.minY, meshExtent.maxY].join(','));
    p.set('center', `${state.centerX.toFixed(1)},${state.centerY.toFixed(1)}`);
  }
  p.set('zoom', state.zoom.toFixed(3));
  if (gridSize !== 64) p.set('grid', String(gridSize));
  if (showWireframe) p.set('wire', '1');
  if (!showGraticule) p.set('grat', '0');
  for (const l of layers) p.append('url', l.url);
  history.replaceState(null, '', `${location.pathname}?${p.toString()}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const container = document.getElementById('app')!;
  urlInput = document.getElementById('cog-url') as HTMLInputElement;
  modeSelect = document.getElementById('mode') as HTMLSelectElement;
  fixedPanel = document.getElementById('fixed-panel')!;
  centredPanel = document.getElementById('centred-panel')!;
  displayCrsInput = document.getElementById('display-crs') as HTMLInputElement;
  extentInput = document.getElementById('extent') as HTMLInputElement;
  projSelect = document.getElementById('proj') as HTMLSelectElement;
  projTemplateInput = document.getElementById('proj-template') as HTMLInputElement;
  centreLonInput = document.getElementById('centre-lon') as HTMLInputElement;
  centreLatInput = document.getElementById('centre-lat') as HTMLInputElement;
  gridSizeInput = document.getElementById('grid-size') as HTMLInputElement;
  wireframeInput = document.getElementById('wireframe') as HTMLInputElement;
  graticuleInput = document.getElementById('graticule') as HTMLInputElement;
  vertexCountEl = document.getElementById('vertex-count')!;
  infoEl = document.getElementById('info')!;
  layersEl = document.getElementById('layers')!;
  const loadBtn = document.getElementById('load-btn')!;
  const addBtn = document.getElementById('add-btn')!;
  const applyBtn = document.getElementById('apply-crs-btn')!;
  const panelToggle = document.getElementById('panel-toggle')!;

  // Populate preset select
  for (const [name, preset] of Object.entries(CENTRED_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} - ${preset.label}`;
    projSelect.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'custom template...';
  projSelect.appendChild(custom);

  // Canvas
  canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.cursor = 'grab';
  container.appendChild(canvas);

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }
  resizeCanvas();
  window.addEventListener('resize', () => {
    resizeCanvas();
    if (viewController) onViewChange(viewController.getState());
  });

  const glContext = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!glContext) {
    infoEl.innerHTML = 'WebGL2 not supported';
    return;
  }
  gl = glContext;
  gratMinor = new LineRenderer(gl);
  gratMajor = new LineRenderer(gl);

  // State from URL, then mesh and view
  const params = new URLSearchParams(location.search);
  applyUrlParams(params);
  const initial = initialViewFromParams(params);
  regenerateMesh(initial);
  makeViewController(initial);
  syncUI();

  // Wire up UI
  loadBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    clearLayers();
    await addLayer(url);
  });
  addBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    await addLayer(url);
  });
  urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') loadBtn.click();
  });
  applyBtn.addEventListener('click', applyDisplaySettings);
  graticuleInput.addEventListener('change', () => {
    showGraticule = graticuleInput.checked;
    graticuleCRS = '';
    render(viewController.getState());
    scheduleUrlUpdate();
  });
  wireframeInput.addEventListener('change', () => {
    showWireframe = wireframeInput.checked;
    render(viewController.getState());
    scheduleUrlUpdate();
  });
  modeSelect.addEventListener('change', () => {
    fixedPanel.hidden = modeSelect.value !== 'fixed';
    centredPanel.hidden = modeSelect.value !== 'centred';
  });
  projSelect.addEventListener('change', () => {
    projTemplateInput.hidden = projSelect.value !== 'custom';
    if (projSelect.value !== 'custom') {
      projTemplateInput.value = CENTRED_PRESETS[projSelect.value].template;
    }
  });
  gridSizeInput.addEventListener('input', () => {
    const size = parseInt(gridSizeInput.value) || 32;
    const verts = (size + 1) * (size + 1);
    vertexCountEl.textContent = `(${verts} verts)`;
    vertexCountEl.style.color = verts > MAX_VERTICES ? '#f66' : '#aaa';
  });
  layersEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const rm = t.getAttribute('data-remove');
    const fit = t.getAttribute('data-fit');
    if (rm !== null) removeLayer(parseInt(rm));
    if (fit !== null) {
      const layer = layers.find(l => l.id === parseInt(fit));
      if (layer) fitLayer(layer);
    }
  });
  panelToggle.addEventListener('click', () => {
    document.getElementById('controls')!.classList.toggle('collapsed');
  });

  // Load layers from URL params, or the default
  const urls = params.getAll('url');
  if (urls.length === 0) urls.push(DEFAULT_COG);
  urlInput.value = urls[0];
  for (const u of urls) {
    await addLayer(u);
  }

  console.log('Viewer ready!');
}

main().catch(console.error);
