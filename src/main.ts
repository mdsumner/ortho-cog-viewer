/**
 * Ortho COG Viewer - Main entry point
 *
 * Multi-layer COG viewer with arbitrary source CRS -> arbitrary display CRS.
 *
 * The shell: view modes, the layer list, styling state, the UI and URL
 * state. A layer's pixels belong to its engine (see engine/types.ts), so
 * everything here is independent of how a layer is actually drawn.
 *
 * Two view modes share the same engines, loaders and UI:
 *
 *   fixed    A static display CRS and mesh extent; a camera pans/zooms over it.
 *            This is the original design.
 *
 *   centred  The display CRS is a template whose lon_0/lat_0 track the view
 *            centre. The mesh is always the screen rectangle around (0, 0)
 *            and panning moves the projection centre. See centred.ts.
 */

import { generateGridMesh, GridMesh } from './engine/mesh';
import { registerProjections, ensureCRS, resolveCRS, unknownCRSMessage, setDefinitionProvider, executorFor } from './core/crs';
import { projWasmProvider } from './core/projwasm';
import { RasterSource, parseFragment, formatFragment } from './core/source';
import { COGSource, splitCogUrl } from './core/cogSource';
import { COLORMAPS, colormapCss, colormapRange, isColormapName } from './core/colormap';
import { XYZSource, TILE_PRESETS, isTileTemplate } from './core/xyzSource';
import { isCapabilitiesUrl, fetchCapabilities, splitCapabilitiesUrl, ParsedCapabilities, WMTSLayerInfo } from './core/wmts';
import { LineRenderer } from './engine/LineRenderer';
import { buildGraticule, buildGraticuleAsync } from './core/graticule';
import { geoTransform } from './core/transform';
import { transformBounds, boundsToDisplayAsync, SourceBounds } from './core/bounds';
import { WrapSpec, detectWrap, detectWrapAsync, copyIndex } from './core/wrap';
import { ViewController, ViewState } from './ViewController';
import { CENTRED_PRESETS, centredCRS, isPresetName, panCentre, panCentreAsync, resolveTemplate, normaliseLonLat } from './core/centred';
import { LayerEngine, RenderContext, Style, View, Curve, defaultStyle } from './engine/types';
import { MeshEngine } from './engine/meshEngine';
import proj4 from 'proj4';

registerProjections();
// PROJ in wasm answers for codes nothing built in knows; loaded on first miss.
setDefinitionProvider(projWasmProvider);

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
let wrapWorld = false;         // repeat the world sideways where the projection allows
let wrapSpec: WrapSpec | null = null;
let wrapCRS = '';              // display CRS wrapSpec was detected for
let showGraticule = true;
let graticuleCRS = '';        // display CRS the current graticule was built for
let graticuleInFlight = false;
let graticuleQueued = false;

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
// Display-space point the centred mesh is built around: the origin for a
// re-centring template (the projection follows the view), or the projected
// view centre for a static CRS used in centred mode.
let centredOriginX = 0;
let centredOriginY = 0;
// A shift-drag moves the view over the projection without re-centring it:
// this is that displacement, in display metres, from the projected centre.
// The next ordinary drag folds it back into the centre and clears it.
let lookOffsetX = 0;
let lookOffsetY = 0;
let meshOriginX = NaN;
let meshOriginY = NaN;

// Layer state. The pixels belong to the engine; everything here is the
// shell's business: identity, how the user wants it styled, opacity.
interface Layer {
  id: number;
  url: string;
  source: RasterSource;
  engine: LayerEngine;
  scale: ScaleState | null;
  opacity: number;
}

/** Parameters carried on a layer URL's fragment. */
function fragmentParams(url: string): Map<string, string> {
  return parseFragment(url);
}

/**
 * A layer's Style plus the two policies the shell applies on top of it:
 * whether the range follows each fetched window's 2-98 percentile, and
 * whether nodata comes from the file's own tag.
 */
interface ScaleState extends Style {
  auto: boolean;
  nodataAuto: boolean;
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
let wrapInput: HTMLInputElement;
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

/**
 * Where the centred-mode mesh is anchored in display space: at the projected
 * view centre, plus any shift-drag look-around offset.
 *
 * For a template with both placeholders the projected centre is (0, 0) by
 * construction. For one with only {lon_0} (the world projections) it is
 * (0, y(lat)), which is what lets a north-south drag move the view while the
 * central meridian keeps tracking. For a static CRS (no placeholders) it is
 * simply where the centre falls in that CRS.
 */
function updateCentredOrigin(): void {
  if (mode !== 'centred') {
    centredOriginX = 0;
    centredOriginY = 0;
    return;
  }
  const geo = geoTransform(currentDisplayCRS());
  if (!geo.fromGeoSync) {
    // PROJ executor: the origin arrives later; until then keep the last one.
    // (A template with both placeholders projects its centre to (0, 0)
    // anyway, which is the common case, so the wait rarely shows.)
    void geo.fromGeo(new Float64Array([centreLon, centreLat])).then((xy) => {
      const x = isFinite(xy[0]) ? xy[0] : 0, y = isFinite(xy[1]) ? xy[1] : 0;
      const nx = x + lookOffsetX, ny = y + lookOffsetY;
      if (nx === centredOriginX && ny === centredOriginY) return;
      centredOriginX = nx;
      centredOriginY = ny;
      regenerateMesh();
      layoutAllLayers();
      render(viewController.getState());
    });
    return;
  }
  let x = 0, y = 0;
  try {
    const xy = geo.fromGeoSync(new Float64Array([centreLon, centreLat]));
    x = isFinite(xy[0]) ? xy[0] : 0;
    y = isFinite(xy[1]) ? xy[1] : 0;
  } catch {
    x = 0; y = 0;
  }
  centredOriginX = x + lookOffsetX;
  centredOriginY = y + lookOffsetY;
}

/**
 * The view an engine should draw: the camera in display space, plus the
 * canvas it has to fill.
 */
function currentView(state: ViewState): View {
  return {
    crs: currentDisplayCRS(),
    centreX: state.centerX + centredOriginX,
    centreY: state.centerY + centredOriginY,
    zoom: state.zoom,
    width: canvas.clientWidth,
    height: canvas.clientHeight
  };
}

/** The wrap for the current display CRS, detected once per CRS string. */
function currentWrap(): WrapSpec | null {
  if (!wrapWorld) return null;
  const crs = currentDisplayCRS();
  if (crs !== wrapCRS) {
    wrapCRS = crs;
    const geo = geoTransform(crs);
    if (geo.fromGeoSync) {
      wrapSpec = detectWrap(crs);
    } else {
      // PROJ executor: keep the previous answer until the new one lands.
      void detectWrapAsync(geo).then((w) => {
        if (wrapCRS !== crs) return;
        wrapSpec = w;
        graticuleCRS = '';
        layoutAllLayers();
        render(viewController.getState());
      });
    }
  }
  return wrapSpec;
}

function contextFor(state: ViewState): RenderContext {
  return { view: currentView(state), grid: baseMesh, wrap: currentWrap() };
}

/** Which copies of the world the view currently touches, along the wrap. */
function copyRange(w: WrapSpec, state: ViewState): [number, number] {
  const scale = Math.pow(2, state.zoom);
  const hw = canvas.clientWidth / 2 / scale, hh = canvas.clientHeight / 2 / scale;
  const cx = state.centerX + centredOriginX, cy = state.centerY + centredOriginY;
  let kMin = Infinity, kMax = -Infinity;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const k = copyIndex(w, cx + sx * hw, cy + sy * hh);
    if (k < kMin) kMin = k;
    if (k > kMax) kMax = k;
  }
  return [kMin - 1, kMax + 1];
}

/** The Style a layer's engine should use, from the shell's own state. */
function styleOf(layer: Layer): Style {
  const base = layer.scale ?? defaultStyle();
  return { ...base, opacity: layer.opacity };
}

/**
 * An engine reports that something changed: it started loading, or new
 * pixels arrived. Applying the auto range needs the statistics of what just
 * loaded, so it belongs here rather than in the engine.
 */
function onEngineChange(layer: Layer): void {
  const stats = layer.engine.status().stats;
  if (layer.scale && layer.scale.auto && stats && stats.count > 0 &&
      (layer.scale.min !== stats.p2 || layer.scale.max !== stats.p98)) {
    layer.scale.min = stats.p2;
    layer.scale.max = stats.p98;
    layer.engine.setStyle(styleOf(layer));
  }
  updateUI();
  render(viewController.getState());
  // A layout that landed late (the PROJ executor) may have changed what
  // the view needs from the source; the refresh is debounced, so this is
  // cheap when nothing did.
  scheduleRefresh(viewController.getState());
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
    updateCentredOrigin();
    const ox = centredOriginX, oy = centredOriginY;
    baseMesh = generateGridMesh([ox - halfW, oy - halfH, ox + halfW, oy + halfH], gridSize, rows);
    meshZoom = zoom;
    meshCssW = cssW;
    meshCssH = cssH;
    meshOriginX = ox;
    meshOriginY = oy;
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
 * Rebuild the graticule if the display CRS changed since it was last built.
 */
function updateGraticule(): void {
  if (!showGraticule || !baseMesh) return;
  const crs = currentDisplayCRS();
  const w = currentWrap();
  const [kMin, kMax] = w ? copyRange(w, viewController.getState()) : [0, 0];
  const key = `${crs}|${kMin},${kMax}`;
  if (key === graticuleCRS) return;
  const opts = { stepDeg: 10, sampleDeg: 1, tolerance: meshCellSize() * 1e-2, wrap: w, kMin, kMax };
  const geo = geoTransform(crs);
  if (geo.fromGeoSync) {
    const g = buildGraticule(crs, opts);
    gratMinor.setLines(g.minor);
    gratMajor.setLines(g.major);
    graticuleCRS = key;
    return;
  }
  // PROJ executor: one build in flight; the newest request wins when it
  // lands. The old lines stay up until then.
  graticuleCRS = key;
  if (graticuleInFlight) { graticuleQueued = true; return; }
  graticuleInFlight = true;
  buildGraticuleAsync(geo, opts).then((g) => {
    if (graticuleCRS === key) {
      gratMinor.setLines(g.minor);
      gratMajor.setLines(g.major);
      render(viewController.getState());
    }
  }).catch((err) => console.warn('graticule (PROJ) failed:', err)).finally(() => {
    graticuleInFlight = false;
    if (graticuleQueued) {
      graticuleQueued = false;
      graticuleCRS = '';
      updateGraticule();
    }
  });
}

function layoutAllLayers(): void {
  const ctx = contextFor(viewController.getState());
  for (const layer of layers) {
    try {
      layer.engine.layout(ctx);
    } catch (err) {
      console.error(`Failed to lay out layer ${layer.id}:`, err);
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
    if (executorFor(currentDisplayCRS()) === 'proj' && !state.shift &&
        (state.centerX !== 0 || state.centerY !== 0)) {
      handleViewChangeProj(state);
      return;
    }
    // Consume any pan offset: the display point now at the screen centre
    // becomes the new projection centre, and the camera snaps back to origin.
    if (state.centerX !== 0 || state.centerY !== 0) {
      if (state.shift) {
        // Look around: move over the projection as it stands, no re-centring.
        lookOffsetX += state.centerX;
        lookOffsetY += state.centerY;
      } else {
        const next = panCentre(resolveTemplate(centredProj), centreLon, centreLat,
          centredOriginX + state.centerX, centredOriginY + state.centerY);
        if (next) {
          [centreLon, centreLat] = next;
          lookOffsetX = 0;
          lookOffsetY = 0;
        } else {
          // Off the map: keep the view where it was put, as a look-around.
          lookOffsetX += state.centerX;
          lookOffsetY += state.centerY;
        }
      }
      viewController.setState({ centerX: 0, centerY: 0 });
      state = viewController.getState();
      updateCentredOrigin();
      syncCentreInputs();
    }
    if (state.zoom !== meshZoom || canvas.clientWidth !== meshCssW || canvas.clientHeight !== meshCssH ||
        centredOriginX !== meshOriginX || centredOriginY !== meshOriginY) {
      regenerateMesh(state);
    }
    layoutAllLayers();
  }
  render(state);
  scheduleRefresh(state);
  scheduleUrlUpdate();
}

/**
 * The PROJ executor's pan. The inverse of the screen centre is a worker
 * round trip, so the camera keeps its offset over the existing mesh (the
 * view moves at once, the projection catches up), and when the new centre
 * lands the consumed offset is subtracted from whatever the camera has
 * accumulated since. One request at a time; a drag settles on the last
 * position.
 */
let panInFlight = false;

function handleViewChangeProj(state: ViewState): void {
  render(state);
  scheduleRefresh(state);
  scheduleUrlUpdate();
  // While the drag is going the camera just slides over the mesh it has;
  // re-centring is a round trip and, for an unfolded net, re-cuts the map,
  // so it happens once, on release. (Wheel zoom has no drag and re-centres
  // as it goes.)
  if (state.dragging || panInFlight) return;
  panInFlight = true;
  const dx = state.centerX, dy = state.centerY;
  const template = resolveTemplate(centredProj);
  panCentreAsync(template, centreLon, centreLat, centredOriginX + dx, centredOriginY + dy)
    .then(async (next) => {
      if (!next) {
        // The screen centre is off the map (a facet gap, the horizon): keep
        // the view where the user put it as a look-around, no snap back.
        lookOffsetX += dx;
        lookOffsetY += dy;
        centredOriginX += dx;
        centredOriginY += dy;
        const s = viewController.getState();
        viewController.setState({ centerX: s.centerX - dx, centerY: s.centerY - dy });
        regenerateMesh(viewController.getState());
        layoutAllLayers();
        render(viewController.getState());
        return;
      }
      [centreLon, centreLat] = next;
      lookOffsetX = 0;
      lookOffsetY = 0;
      // The origin for the new centre, then take the consumed pan off the camera.
      const geo = geoTransform(currentDisplayCRS());
      const xy = await geo.fromGeo(new Float64Array([centreLon, centreLat]));
      centredOriginX = isFinite(xy[0]) ? xy[0] : 0;
      centredOriginY = isFinite(xy[1]) ? xy[1] : 0;
      const s = viewController.getState();
      viewController.setState({ centerX: s.centerX - dx, centerY: s.centerY - dy });
      syncCentreInputs();
      regenerateMesh(viewController.getState());
      layoutAllLayers();
      render(viewController.getState());
    })
    .catch((err) => console.warn('pan (PROJ) failed:', err))
    .finally(() => {
      panInFlight = false;
      const s = viewController.getState();
      if (!s.dragging && (s.centerX !== 0 || s.centerY !== 0)) handleViewChangeProj(s);
    });
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

async function applyDisplaySettings(): Promise<void> {
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
    if (!await resolveCRS(newCRS)) {
      alert(unknownCRSMessage(newCRS));
      return;
    }

    mode = 'fixed';
    gridSize = newGrid;
    displayCRS = newCRS;
    meshExtent = { minX: xmin, minY: ymin, maxX: xmax, maxY: ymax };

    regenerateMesh();
    layoutAllLayers();

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
    // A template may be a plain CRS (no placeholders), including an EPSG code
    // that needs resolving before proj4 can use it.
    const instantiated = centredCRS(resolveTemplate(proj), lon, lat);
    if (!await resolveCRS(instantiated)) {
      alert(unknownCRSMessage(instantiated));
      return;
    }

    const wasCentred = mode === 'centred';
    mode = 'centred';
    gridSize = newGrid;
    centredProj = proj;
    [centreLon, centreLat] = normaliseLonLat(lon, lat);
    updateCentredOrigin();

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
    const b = layer.source.bounds;
    const toGeo = proj4(layer.source.crs, 'EPSG:4326');
    const [lon, lat] = toGeo.forward([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]);
    if (!isFinite(lon) || !isFinite(lat)) return;
    [centreLon, centreLat] = normaliseLonLat(lon, lat);
    updateCentredOrigin();
    const crs = currentDisplayCRS();
    const geo = geoTransform(crs);
    const apply = (tb: SourceBounds) => {
      const w = Math.max(tb.maxX - tb.minX, tb.maxY - tb.minY);
      const zoom = isFinite(w) && w > 0
        ? Math.log2(Math.min(canvas.clientWidth, canvas.clientHeight) / (w * 1.1))
        : defaultCentredZoom();
      makeViewController({ centerX: 0, centerY: 0, zoom });
      syncCentreInputs();
    };
    if (geo.fromGeoSync) apply(transformBounds(b, layer.source.crs, crs, 30));
    else void boundsToDisplayAsync(b, layer.source.crs, geo).then(apply);
  } else {
    const geo = geoTransform(displayCRS);
    const apply = (tb: SourceBounds) => viewController.fitBounds(tb.minX, tb.minY, tb.maxX, tb.maxY);
    if (geo.fromGeoSync) apply(transformBounds(layer.source.bounds, layer.source.crs, displayCRS, 30));
    else void boundsToDisplayAsync(layer.source.bounds, layer.source.crs, geo).then(apply);
  }
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

async function openSource(url: string): Promise<RasterSource> {
  if (url.startsWith('preset:')) {
    const p = TILE_PRESETS[url.slice(7)];
    if (p && p.cog) return COGSource.open(p.template);
    return XYZSource.fromPreset(url.slice(7));
  }
  if (isTileTemplate(url)) return XYZSource.fromTemplate(url);
  if (isCapabilitiesUrl(url)) return XYZSource.fromCapabilities(url);
  return COGSource.open(url);
}

async function addLayer(url: string): Promise<Layer | null> {
  console.log('Adding layer:', url);
  try {
    const source = await openSource(url);

    // Styling state first: the engine is constructed with it.
    const alpha = parseFloat(fragmentParams(url).get('alpha') || '');
    const opacity = isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    let scale: ScaleState | null = null;
    if (source.numeric) {
      const o = splitCogUrl(url);
      const cog = source as COGSource;
      const cmap = o.cmap && isColormapName(o.cmap) ? o.cmap : 'viridis';
      const pinned = colormapRange(cmap);
      const explicit = o.min !== undefined && o.max !== undefined;
      const curve: Curve = o.curve === 'sqrt' || o.curve === 'log' ? o.curve : 'linear';
      scale = {
        mode: cog.rgbBands ? 'rgb' : 'single',
        min: pinned ? pinned[0] : (o.min ?? 0),
        max: pinned ? pinned[1] : (o.max ?? 1),
        cmap,
        curve,
        auto: !explicit && !pinned,
        nodata: o.nodata ?? null,
        nodataAuto: o.nodata === undefined,
        shade: o.shade !== undefined,
        shadeStrength: o.shade ?? 0.6,
        zfactor: o.zf ?? 1,
        azimuth: o.az ?? 315,
        altitude: o.alt ?? 45,
        opacity
      };
    }

    const layer = {
      id: nextLayerId++,
      url,
      source,
      scale,
      opacity
    } as Layer;
    layer.engine = new MeshEngine(gl, source, styleOf(layer), () => onEngineChange(layer));

    const ctx = contextFor(viewController.getState());
    layer.engine.layout(ctx);
    layers.push(layer);
    updateUI();

    await layer.engine.refresh(ctx);
    render(viewController.getState());
    scheduleUrlUpdate();
    return layer;
  } catch (err) {
    console.error('Failed to add layer:', err);
    alert(`Failed to load source: ${err}`);
    return null;
  }
}

function removeLayer(id: number): void {
  const layer = layers.find(l => l.id === id);
  if (layer) layer.engine.dispose();
  layers = layers.filter(l => l.id !== id);
  updateUI();
  render(viewController.getState());
  scheduleUrlUpdate();
}

function clearLayers(): void {
  for (const l of layers) l.engine.dispose();
  layers = [];
}

/**
 * Engines may have to fetch or compute to serve a new view, so that is
 * debounced while the view is still moving.
 */
let updateTimeout: number | null = null;
function scheduleRefresh(state: ViewState): void {
  if (updateTimeout) clearTimeout(updateTimeout);
  updateTimeout = window.setTimeout(() => {
    const ctx = contextFor(state);
    layers.forEach(layer => layer.engine.refresh(ctx));
    updateTimeout = null;
  }, 150);
}

// ---------------------------------------------------------------------------
// WMTS layer picker
// ---------------------------------------------------------------------------

let pickerEl: HTMLElement;
let pickerFilter: HTMLInputElement;
let pickerLayer: HTMLSelectElement;
let pickerTms: HTMLSelectElement;
let pickerTimeRow: HTMLElement;
let pickerTime: HTMLInputElement;
let pickerTimeHint: HTMLElement;
let pickerCount: HTMLElement;
let pickerCaps: ParsedCapabilities | null = null;
let pickerUrl = '';

/**
 * Load a capabilities document into the picker. Returns true if the picker
 * was shown (the caller should not add a layer yet), false if the document
 * has exactly one layer and no choices to make.
 */
async function openPicker(url: string): Promise<boolean> {
  const caps = await fetchCapabilities(url);
  const usable = caps.layers.filter(l => l.tmsIds.some(id => {
    const t = caps.tms.get(id);
    return t && ensureCRS(t.crs);
  }));
  if (usable.length === 0) throw new Error('No layer in this capabilities document uses a CRS we can transform');
  const single = usable.length === 1 && usable[0].tmsIds.length <= 1 && usable[0].dimensions.length === 0;
  if (single) return false;

  pickerCaps = caps;
  pickerUrl = url;
  pickerFilter.value = '';
  fillPickerLayers(usable);
  pickerEl.hidden = false;
  return true;
}

function fillPickerLayers(layers: WMTSLayerInfo[]): void {
  const q = pickerFilter.value.trim().toLowerCase();
  const shown = q ? layers.filter(l => (l.title + ' ' + l.id).toLowerCase().includes(q)) : layers;
  pickerLayer.innerHTML = '';
  for (const l of shown.slice(0, 500)) {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = l.title === l.id ? l.id : `${l.title} [${l.id}]`;
    pickerLayer.appendChild(opt);
  }
  pickerCount.textContent = `${shown.length} of ${layers.length} layers`;
  onPickerLayerChange();
}

function pickerUsableLayers(): WMTSLayerInfo[] {
  if (!pickerCaps) return [];
  const caps = pickerCaps;
  return caps.layers.filter(l => l.tmsIds.some(id => {
    const t = caps.tms.get(id);
    return t && ensureCRS(t.crs);
  }));
}

function onPickerLayerChange(): void {
  if (!pickerCaps) return;
  const layer = pickerCaps.layers.find(l => l.id === pickerLayer.value);
  pickerTms.innerHTML = '';
  pickerTimeRow.hidden = true;
  if (!layer) return;
  for (const id of layer.tmsIds) {
    const t = pickerCaps.tms.get(id);
    if (!t || !ensureCRS(t.crs)) continue;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${id} (${t.crs}, ${t.matrices.length} levels)`;
    pickerTms.appendChild(opt);
  }
  const pref = Array.from(pickerTms.options).find(o => /google|webmercator|3857/i.test(o.value));
  if (pref) pickerTms.value = pref.value;

  const time = layer.dimensions.find(d => /^time$/i.test(d.id));
  if (time) {
    pickerTimeRow.hidden = false;
    pickerTime.value = time.default || time.values[0] || '';
    const v = time.values;
    pickerTimeHint.textContent = v.length ? (v.length === 1 ? v[0] : `${v[0]} .. ${v[v.length - 1]}`) : '';
    pickerTimeHint.title = v.slice(0, 20).join('\n');
  }
}

function pickerSelectionUrl(): string {
  const frag = new URLSearchParams();
  frag.set('layer', pickerLayer.value);
  if (pickerTms.value) frag.set('tms', pickerTms.value);
  if (!pickerTimeRow.hidden && pickerTime.value.trim()) frag.set('time', pickerTime.value.trim());
  return `${pickerUrl}#${frag.toString()}`;
}

// ---------------------------------------------------------------------------
// Rendering and UI
// ---------------------------------------------------------------------------

function render(state: ViewState): void {
  const ctx = contextFor(state);
  const { view } = ctx;
  gl.clearColor(0.1, 0.1, 0.1, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  for (const layer of layers) {
    layer.engine.draw(ctx);
  }
  if (showGraticule) {
    updateGraticule();
    gratMinor.render(view.centreX, view.centreY, view.zoom, [1, 1, 1, 0.25]);
    gratMajor.render(view.centreX, view.centreY, view.zoom, [1, 1, 1, 0.6]);
  }
  if (showWireframe) {
    const colors: [number, number, number, number][] = [
      [1, 1, 0, 0.55], [0, 1, 1, 0.55], [1, 0.4, 1, 0.55], [0.5, 1, 0.5, 0.55]
    ];
    layers.forEach((layer, i) => layer.engine.drawWireframe(ctx, colors[i % colors.length]));
  }
  updateInfo(state);
}

function updateInfo(state: ViewState): void {
  const crs = currentDisplayCRS();
  const metresPerPx = 1 / Math.pow(2, state.zoom);
  const lines = [
    `Mode: ${mode}`,
    `Display: <span class="crs-string" title="${crs}">${crs}</span>`,
    `Executor: ${executorFor(crs) === 'proj' ? 'PROJ (wasm), a frame behind' : 'proj4js'}`,
    `Zoom: ${state.zoom.toFixed(2)} (${formatRes(metresPerPx)}/px)`,
  ];
  if (mode === 'centred') {
    lines.push(`Centre: ${centreLon.toFixed(4)}, ${centreLat.toFixed(4)}`);
    if (wrapWorld) lines.push(currentWrap() ? 'Wrap: repeating the world' : 'Wrap: this projection has no sideways repeat');
    if (lookOffsetX !== 0 || lookOffsetY !== 0) {
      lines.push(`Looking ${formatUnits(Math.hypot(lookOffsetX, lookOffsetY), 'm')} off centre (shift-drag; a plain drag re-centres)`);
    }
  } else {
    lines.push(`Centre: ${state.centerX.toFixed(1)}, ${state.centerY.toFixed(1)}`);
    if (wrapWorld) lines.push(currentWrap() ? 'Wrap: repeating the world' : 'Wrap: this projection has no sideways repeat');
  }
  lines.push(`Layers: ${layers.length}`);
  infoEl.innerHTML = lines.join('<br>');
}

function formatUnits(v: number, unit: string): string {
  if (!isFinite(v)) return '?';
  if (unit === 'deg') return v >= 1 ? `${v.toFixed(2)} deg` : `${v.toFixed(4)} deg`;
  return formatRes(v);
}

function formatRes(v: number): string {
  if (!isFinite(v)) return '?';
  if (v >= 1000) return `${(v / 1000).toFixed(1)} km`;
  if (v >= 1) return `${v.toFixed(1)} m`;
  return `${v.toFixed(3)} m`;
}

function updateUI(): void {
  layersEl.innerHTML = layers.map(layer => {
    const src = layer.source;
    const st8 = layer.engine.status();
    const res = st8.hasTexture ? src.levels[st8.level].resolution : NaN;
    const unit = /4326|4269|longlat/.test(src.crs) ? 'deg' : 'm';
    const lvl = st8.hasTexture ? `${formatUnits(res, unit)}/px ${st8.textureSize}` : '...';
    const loading = st8.loading ? ' (loading)' : '';
    const pct = Math.round(st8.validFraction * 100);
    const attr = src.attribution ? `<div class="attribution">${src.attribution}</div>` : '';
    let scaleRow = '';
    if (layer.scale) {
      const sc = layer.scale;
      const cog = src as COGSource;
      const st = layer.engine.status().stats;
      const n = cog.samplesPerPixel;
      const pinned = colormapRange(sc.cmap) !== null;
      const cmapOpts = Object.entries(COLORMAPS).map(([k, v]) =>
        `<option value="${k}"${k === sc.cmap ? ' selected' : ''}>${v.label}</option>`).join('');
      const bandOpts = (sel: number) => Array.from({ length: n }, (_, i) =>
        `<option value="${i + 1}"${i === sel ? ' selected' : ''}>${i + 1}</option>`).join('');
      const bandUI = sc.mode === 'rgb' && cog.rgbBands
        ? `R <select data-band="${layer.id}" data-ch="0">${bandOpts(cog.rgbBands[0])}</select>
           G <select data-band="${layer.id}" data-ch="1">${bandOpts(cog.rgbBands[1])}</select>
           B <select data-band="${layer.id}" data-ch="2">${bandOpts(cog.rgbBands[2])}</select>`
        : (n > 1 ? `band <select data-band="${layer.id}" data-ch="0">${bandOpts(cog.band)}</select>` : '');
      const modeUI = n >= 3
        ? `<select data-mode="${layer.id}">
             <option value="single"${sc.mode === 'single' ? ' selected' : ''}>single band + colormap</option>
             <option value="rgb"${sc.mode === 'rgb' ? ' selected' : ''}>RGB composite</option>
           </select>` : '';
      const statInfo = st && st.count ? `data ${fmtNum(st.min)}..${fmtNum(st.max)}` : '';
      const curveOpts = (['linear', 'sqrt', 'log'] as Curve[]).map(c =>
        `<option value="${c}"${c === sc.curve ? ' selected' : ''}>${c}</option>`).join('');
      const ndValue = sc.nodataAuto ? (cog.fileNodata === null ? '' : String(cog.fileNodata)) : String(sc.nodata ?? '');
      scaleRow = `
      <div class="scale-row" data-layer="${layer.id}">
        ${modeUI} ${bandUI}
        <span class="hint">${statInfo}</span>
      </div>
      <div class="scale-row" data-layer="${layer.id}">
        <canvas class="hist" data-hist="${layer.id}" width="200" height="36"></canvas>
      </div>
      <div class="scale-row" data-layer="${layer.id}">
        <span class="hist-legend" style="background:${sc.mode === 'rgb' ? 'linear-gradient(to right,#000,#fff)' : colormapCss(sc.cmap)}"></span>
        <span class="hint">${pinned ? 'anchored palette: colours are fixed to values' : ''}</span>
      </div>
      <div class="scale-row" data-layer="${layer.id}">
        <input type="text" class="num" data-min="${layer.id}" value="${fmtNum(sc.min)}" title="min"${pinned ? ' disabled' : ''} />
        <input type="text" class="num" data-max="${layer.id}" value="${fmtNum(sc.max)}" title="max"${pinned ? ' disabled' : ''} />
        <button data-auto="${layer.id}" title="2-98 percentile of the current window"${pinned ? ' disabled' : ''}>2-98%</button>
        <button data-minmax="${layer.id}" title="full range of the current window"${pinned ? ' disabled' : ''}>min/max</button>
        <select data-curve="${layer.id}" title="curve">${curveOpts}</select>
      </div>
      <div class="scale-row" data-layer="${layer.id}">
        ${sc.mode === 'rgb' ? '' : `<select data-cmap="${layer.id}">${cmapOpts}</select>`}
        <label class="wide">nodata</label>
        <input type="text" class="num" data-nodata="${layer.id}" value="${ndValue}" placeholder="none" title="nodata value; blank = none" />
        <button data-nodata-auto="${layer.id}" title="use the file's nodata tag"${sc.nodataAuto ? ' disabled' : ''}>auto</button>
        <button data-reset="${layer.id}" title="back to the styling this layer was loaded with">reset</button>
      </div>
      ${sc.mode === 'rgb' ? '' : `<div class="scale-row" data-layer="${layer.id}">
        <input type="checkbox" data-shade="${layer.id}"${sc.shade ? ' checked' : ''} />
        <label class="wide">hillshade</label>
        <input type="range" min="0" max="1" step="0.05" value="${sc.shadeStrength}" data-shade-strength="${layer.id}" title="strength" style="width:70px" />
        <label class="wide">z</label>
        <input type="text" class="num tiny" data-zf="${layer.id}" value="${sc.zfactor}" title="vertical exaggeration" />
        <label class="wide">az</label>
        <input type="text" class="num tiny" data-az="${layer.id}" value="${sc.azimuth}" title="sun azimuth (deg from north)" />
        <label class="wide">alt</label>
        <input type="text" class="num tiny" data-alt="${layer.id}" value="${sc.altitude}" title="sun altitude (deg)" />
      </div>`}`;
    }
    return `
      <div class="layer-item">
        <button data-remove="${layer.id}" title="Remove layer">x</button>
        <button data-fit="${layer.id}" title="Centre the view on this layer">fit</button>
        <span title="${layer.url}">${src.label}</span>
        <span>(${src.kind} ${src.crs}, ${lvl}${loading}, ${pct}% on-globe)</span>
      </div>
      <div class="alpha-row">
        alpha <input type="range" min="0" max="1" step="0.02" value="${layer.opacity}" data-alpha="${layer.id}" />
        <span data-alpha-val="${layer.id}">${Math.round(layer.opacity * 100)}%</span>
      </div>${scaleRow}${attr}
    `;
  }).join('');
  for (const layer of layers) drawHistogram(layer);
}

/**
 * Histogram of the fetched window with the current min/max as handles.
 */
function drawHistogram(layer: Layer): void {
  if (!layer.scale) return;
  const c = layersEl.querySelector(`canvas[data-hist="${layer.id}"]`) as HTMLCanvasElement | null;
  if (!c) return;
  const ctx = c.getContext('2d')!;
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, W, H);
  const st = layer.engine.status().stats;
  if (!st || !st.count) return;
  const sc = layer.scale;
  // Axis spans the union of data range and current range so handles are visible
  const lo = Math.min(st.min, sc.min), hi = Math.max(st.max, sc.max);
  const span = hi - lo || 1;
  const bins = st.hist.length;
  let peak = 0;
  for (let i = 0; i < bins; i++) if (st.hist[i] > peak) peak = st.hist[i];
  const lpeak = Math.log(1 + peak);
  ctx.fillStyle = '#777';
  for (let x = 0; x < W; x++) {
    // bin for this pixel column (data bins cover st.min..st.max)
    const v0 = lo + (x / W) * span;
    const v1 = lo + ((x + 1) / W) * span;
    const b0 = Math.floor((v0 - st.min) / (st.max - st.min || 1) * bins);
    const b1 = Math.max(b0 + 1, Math.ceil((v1 - st.min) / (st.max - st.min || 1) * bins));
    let m = 0;
    for (let b = Math.max(0, b0); b < Math.min(bins, b1); b++) if (st.hist[b] > m) m = st.hist[b];
    if (m > 0) {
      const h = Math.max(1, Math.round((Math.log(1 + m) / lpeak) * (H - 2)));
      ctx.fillRect(x, H - h, 1, h);
    }
  }
  // Selected range and handles
  const xMin = ((sc.min - lo) / span) * W;
  const xMax = ((sc.max - lo) / span) * W;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(xMin, 0, Math.max(1, xMax - xMin), H);
  ctx.fillStyle = '#ff0';
  ctx.fillRect(Math.round(xMin) - 1, 0, 2, H);
  ctx.fillRect(Math.round(xMax) - 1, 0, 2, H);
}

/**
 * Drag the min/max handles on a histogram.
 */
function histogramPointer(layer: Layer, canvas: HTMLCanvasElement, e: PointerEvent): void {
  const st0 = layer.engine.status().stats;
  if (!layer.scale || !st0 || !st0.count) return;
  if (colormapRange(layer.scale.cmap)) return;  // pinned palette
  const st = st0, sc = layer.scale;
  const rect = canvas.getBoundingClientRect();
  const toValue = (clientX: number) => {
    const lo = Math.min(st.min, sc.min), hi = Math.max(st.max, sc.max);
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return lo + x * (hi - lo);
  };
  const v = toValue(e.clientX);
  const which: 'min' | 'max' = Math.abs(v - sc.min) <= Math.abs(v - sc.max) ? 'min' : 'max';
  const move = (ev: PointerEvent) => {
    const nv = toValue(ev.clientX);
    if (which === 'min') applyScale(layer, { min: Math.min(nv, sc.max), auto: false }, false);
    else applyScale(layer, { max: Math.max(nv, sc.min), auto: false }, false);
    drawHistogram(layer);
    const row = layersEl.querySelector(`.scale-row[data-layer="${layer.id}"] [data-${which}]`) as HTMLInputElement | null;
    if (row) row.value = fmtNum(which === 'min' ? sc.min : sc.max);
  };
  const up = () => {
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.releasePointerCapture(e.pointerId);
    scheduleUrlUpdate();
  };
  canvas.setPointerCapture(e.pointerId);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  move(e);
}

function fmtNum(v: number): string {
  if (!isFinite(v)) return '?';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 1e-3) return v.toExponential(3);
  if (a >= 100) return v.toFixed(1);
  return v.toPrecision(4).replace(/\.?0+$/, '');
}

/**
 * Apply an edited scale to a numeric layer: uniforms only, no refetch.
 */
function applyScale(layer: Layer, partial: Partial<ScaleState> & { minmax?: boolean }, updateUrl = true): void {
  if (!layer.scale) return;
  const sc = layer.scale;
  const { minmax, ...rest } = partial;
  Object.assign(sc, rest);
  const pinned = colormapRange(sc.cmap);
  if (pinned) {
    sc.min = pinned[0];
    sc.max = pinned[1];
    sc.auto = false;
  } else {
    const stats = layer.engine.status().stats;
    if (stats && stats.count) {
      if (minmax) {
        sc.min = stats.min;
        sc.max = stats.max;
        sc.auto = false;
      } else if (sc.auto) {
        sc.min = stats.p2;
        sc.max = stats.p98;
      }
    }
  }
  // The source needs the nodata value too: it masks on the raw value as it
  // reads, which the shader cannot do.
  const cog = layer.source as COGSource;
  cog.nodata = sc.nodataAuto ? cog.fileNodata : sc.nodata;
  sc.nodata = cog.nodata;
  layer.engine.setStyle(styleOf(layer));
  render(viewController.getState());
  if (updateUrl) scheduleUrlUpdate();
}

/**
 * Restore the styling a layer was loaded with (its URL fragment, or the
 * defaults). Bands and mode are restored too, which refetches if they differ.
 */
async function resetScale(layer: Layer): Promise<void> {
  if (!layer.scale) return;
  const o = splitCogUrl(layer.url);
  const cog = layer.source as COGSource;
  const cmap = o.cmap && isColormapName(o.cmap) ? o.cmap : 'viridis';
  const pinned = colormapRange(cmap);
  const explicit = o.min !== undefined && o.max !== undefined;
  const wantMode: 'single' | 'rgb' = o.bands && cog.samplesPerPixel >= 3 ? 'rgb' : 'single';
  const wantBands = wantMode === 'rgb' ? o.bands!.map(b => b - 1) : [Math.max(0, (o.band || 1) - 1)];
  const a = parseFloat(fragmentParams(layer.url).get('alpha') || '');
  layer.opacity = isFinite(a) ? a : 1;
  Object.assign(layer.scale, {
    min: pinned ? pinned[0] : (o.min ?? 0),
    max: pinned ? pinned[1] : (o.max ?? 1),
    cmap,
    curve: o.curve === 'sqrt' || o.curve === 'log' ? o.curve : 'linear',
    auto: !explicit && !pinned,
    nodata: o.nodata ?? null,
    nodataAuto: o.nodata === undefined,
    shade: o.shade !== undefined,
    shadeStrength: o.shade ?? 0.6,
    zfactor: o.zf ?? 1,
    azimuth: o.az ?? 315,
    altitude: o.alt ?? 45
  });
  const bandsDiffer = wantMode !== layer.scale.mode ||
    (wantMode === 'rgb' ? !cog.rgbBands || wantBands.some((b, i) => b !== cog.rgbBands![i]) : cog.band !== wantBands[0]);
  if (bandsDiffer) {
    await changeBands(layer, wantMode, wantBands);
  } else {
    applyScale(layer, {});
    updateUI();
  }
}

/**
 * Band or mode changes need the data itself: refetch, then re-run auto range.
 */
async function changeBands(layer: Layer, mode: 'single' | 'rgb', bands: number[]): Promise<void> {
  if (!layer.scale) return;
  const cog = layer.source as COGSource;
  const n = cog.samplesPerPixel;
  const clamp = (b: number) => Math.max(0, Math.min(n - 1, b));
  if (mode === 'rgb') {
    cog.rgbBands = [clamp(bands[0]), clamp(bands[1]), clamp(bands[2])];
  } else {
    cog.rgbBands = null;
    cog.band = clamp(bands[0]);
  }
  layer.scale.mode = mode;
  layer.engine.invalidate();
  await layer.engine.refresh(contextFor(viewController.getState()));
  // stats changed with the new bands: the nodata may too, so recompute
  applyScale(layer, {});
  updateUI();
}

/**
 * The layer URL with its current scaling encoded in the fragment.
 */
function layerUrlWithState(layer: Layer): string {
  const base = splitCogUrl(layer.url);
  const frag = fragmentParams(layer.url);
  for (const k of ['band', 'bands', 'min', 'max', 'cmap', 'curve', 'nodata', 'alpha', 'shade', 'zf', 'az', 'alt']) frag.delete(k);
  if (layer.opacity < 1) frag.set('alpha', layer.opacity.toFixed(2));
  if (!layer.scale) {
    const q0 = formatFragment(frag);
    return q0 ? `${base.url}#${q0}` : base.url;
  }
  const cog = layer.source as COGSource;
  const sc = layer.scale;
  if (sc.mode === 'rgb' && cog.rgbBands) {
    frag.set('bands', cog.rgbBands.map(b => b + 1).join(','));
  } else if (cog.samplesPerPixel > 1) {
    frag.set('band', String(cog.band + 1));
  }
  if (!sc.auto && !colormapRange(sc.cmap)) {
    frag.set('min', String(sc.min));
    frag.set('max', String(sc.max));
  }
  if (sc.mode !== 'rgb' && sc.cmap !== 'viridis') frag.set('cmap', sc.cmap);
  if (sc.curve !== 'linear') frag.set('curve', sc.curve);
  if (!sc.nodataAuto && sc.nodata !== null) frag.set('nodata', String(sc.nodata));
  if (sc.shade) {
    frag.set('shade', sc.shadeStrength.toFixed(2));
    if (sc.zfactor !== 1) frag.set('zf', String(sc.zfactor));
    if (sc.azimuth !== 315) frag.set('az', String(sc.azimuth));
    if (sc.altitude !== 45) frag.set('alt', String(sc.altitude));
  }
  const q = formatFragment(frag);
  return q ? `${base.url}#${q}` : base.url;
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
  wrapInput.checked = wrapWorld;
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

  const wr = params.get('wrap');
  if (wr !== null) wrapWorld = wr === '1' || wr === 'true';

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
  if (wrapWorld) p.set('wrap', '1');
  for (const l of layers) p.append('url', layerUrlWithState(l));
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
  wrapInput = document.getElementById('wrap') as HTMLInputElement;
  graticuleInput = document.getElementById('graticule') as HTMLInputElement;
  vertexCountEl = document.getElementById('vertex-count')!;
  infoEl = document.getElementById('info')!;
  layersEl = document.getElementById('layers')!;
  const loadBtn = document.getElementById('load-btn')!;
  const tilePresetSelect = document.getElementById('tile-preset') as HTMLSelectElement;
  for (const [name, preset] of Object.entries(TILE_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = preset.label;
    tilePresetSelect.appendChild(opt);
  }
  tilePresetSelect.addEventListener('change', () => {
    if (tilePresetSelect.value) {
      urlInput.value = TILE_PRESETS[tilePresetSelect.value].template;
      tilePresetSelect.value = '';
    }
  });
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
  // The display CRS may be an EPSG code from the URL (fixed mode, or a static
  // template in centred mode), so resolve it before anything tries to use it.
  const wantCRS = currentDisplayCRS();
  if (!await resolveCRS(wantCRS)) {
    alert(unknownCRSMessage(wantCRS));
    if (mode === 'centred') centredProj = 'ortho';
    else displayCRS = 'EPSG:3857';
  }
  regenerateMesh(initial);
  makeViewController(initial);
  syncUI();

  // Wire up UI
  async function loadOrAdd(url: string, replace: boolean): Promise<void> {
    if (!url) return;
    if (isCapabilitiesUrl(url) && !splitCapabilitiesUrl(url).layer) {
      try {
        if (await openPicker(splitCapabilitiesUrl(url).url)) return;
      } catch (err) {
        alert(`Failed to read capabilities: ${err}`);
        return;
      }
    }
    if (replace) clearLayers();
    await addLayer(url);
  }
  loadBtn.addEventListener('click', () => loadOrAdd(urlInput.value.trim(), true));
  addBtn.addEventListener('click', () => loadOrAdd(urlInput.value.trim(), false));

  // WMTS picker
  pickerEl = document.getElementById('wmts-picker')!;
  pickerFilter = document.getElementById('wmts-filter') as HTMLInputElement;
  pickerLayer = document.getElementById('wmts-layer') as HTMLSelectElement;
  pickerTms = document.getElementById('wmts-tms') as HTMLSelectElement;
  pickerTimeRow = document.getElementById('wmts-time-row')!;
  pickerTime = document.getElementById('wmts-time') as HTMLInputElement;
  pickerTimeHint = document.getElementById('wmts-time-hint')!;
  pickerCount = document.getElementById('wmts-count')!;
  pickerFilter.addEventListener('input', () => fillPickerLayers(pickerUsableLayers()));
  pickerLayer.addEventListener('change', onPickerLayerChange);
  document.getElementById('wmts-load-btn')!.addEventListener('click', async () => {
    clearLayers();
    await addLayer(pickerSelectionUrl());
  });
  document.getElementById('wmts-add-btn')!.addEventListener('click', async () => {
    await addLayer(pickerSelectionUrl());
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
  wrapInput.addEventListener('change', () => {
    wrapWorld = wrapInput.checked;
    wrapCRS = '';
    graticuleCRS = '';
    layoutAllLayers();
    render(viewController.getState());
    updateUI();
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
    const auto = t.getAttribute('data-auto');
    const minmax = t.getAttribute('data-minmax');
    const ndAuto = t.getAttribute('data-nodata-auto');
    const reset = t.getAttribute('data-reset');
    if (reset !== null) {
      const layer = layers.find(l => l.id === parseInt(reset));
      if (layer) resetScale(layer);
      return;
    }
    if (rm !== null) removeLayer(parseInt(rm));
    if (fit !== null) {
      const layer = layers.find(l => l.id === parseInt(fit));
      if (layer) fitLayer(layer);
    }
    const id = auto ?? minmax ?? ndAuto;
    if (id !== null) {
      const layer = layers.find(l => l.id === parseInt(id));
      if (!layer) return;
      if (auto !== null) applyScale(layer, { auto: true });
      else if (minmax !== null) applyScale(layer, { minmax: true });
      else applyScale(layer, { nodataAuto: true, nodata: null });
      updateUI();
    }
  });
  layersEl.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const sid = t.getAttribute('data-shade-strength');
    if (sid !== null) {
      const layer = layers.find(l => l.id === parseInt(sid));
      if (layer) applyScale(layer, { shadeStrength: parseFloat(t.value) });
      return;
    }
    const id = t.getAttribute('data-alpha');
    if (id === null) return;
    const layer = layers.find(l => l.id === parseInt(id));
    if (!layer) return;
    layer.opacity = parseFloat(t.value);
    layer.engine.setStyle(styleOf(layer));
    const lbl = layersEl.querySelector(`[data-alpha-val="${layer.id}"]`);
    if (lbl) lbl.textContent = `${Math.round(layer.opacity * 100)}%`;
    render(viewController.getState());
    scheduleUrlUpdate();
  });
  layersEl.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    const h = t.getAttribute('data-hist');
    if (h === null) return;
    const layer = layers.find(l => l.id === parseInt(h));
    if (layer) histogramPointer(layer, t as HTMLCanvasElement, e as PointerEvent);
  });
  layersEl.addEventListener('change', async (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const get = (k: string) => t.getAttribute(k);
    const id = get('data-min') ?? get('data-max') ?? get('data-cmap') ?? get('data-curve') ??
               get('data-nodata') ?? get('data-band') ?? get('data-mode') ??
               get('data-shade') ?? get('data-zf') ?? get('data-az') ?? get('data-alt');
    if (id === null) return;
    const layer = layers.find(l => l.id === parseInt(id));
    if (!layer || !layer.scale) return;
    const cog = layer.source as COGSource;
    if (get('data-mode') !== null) {
      const mode = t.value as 'single' | 'rgb';
      const bands = mode === 'rgb' ? [0, 1, 2] : [cog.band];
      await changeBands(layer, mode, bands);
      return;
    }
    if (get('data-band') !== null) {
      const ch = parseInt(get('data-ch') || '0');
      const b = parseInt(t.value) - 1;
      if (layer.scale.mode === 'rgb' && cog.rgbBands) {
        const bands = [...cog.rgbBands];
        bands[ch] = b;
        await changeBands(layer, 'rgb', bands);
      } else {
        await changeBands(layer, 'single', [b]);
      }
      return;
    }
    if (get('data-cmap') !== null) {
      applyScale(layer, { cmap: t.value });
      updateUI();   // pinned palettes change min/max and disable inputs
      return;
    }
    if (get('data-curve') !== null) {
      applyScale(layer, { curve: t.value as Curve });
      return;
    }
    if (get('data-shade') !== null) {
      applyScale(layer, { shade: (t as HTMLInputElement).checked });
      return;
    }
    if (get('data-zf') !== null || get('data-az') !== null || get('data-alt') !== null) {
      const v = parseFloat(t.value);
      if (!isFinite(v)) return;
      if (get('data-zf') !== null) applyScale(layer, { zfactor: v });
      else if (get('data-az') !== null) applyScale(layer, { azimuth: v });
      else applyScale(layer, { altitude: v });
      return;
    }
    if (get('data-nodata') !== null) {
      const txt = t.value.trim();
      const v = txt === '' ? null : parseFloat(txt);
      if (v !== null && !isFinite(v)) return;
      applyScale(layer, { nodata: v, nodataAuto: false });
      updateUI();
      return;
    }
    const v = parseFloat(t.value);
    if (!isFinite(v)) return;
    applyScale(layer, get('data-min') !== null ? { min: v, auto: false } : { max: v, auto: false });
    drawHistogram(layer);
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
