/**
 * Minimal pan/zoom controller for orthographic 2D view
 * 
 * Handles mouse/wheel/touch input and tracks view state.
 */

export interface ViewState {
  centerX: number;
  centerY: number;
  zoom: number;  // log2 scale: 0 = 1:1, -1 = half size, 1 = double size
  /** The pan in centerX/centerY came from a shift-drag (mouse only). */
  shift?: boolean;
  /** A drag is in progress; the next change with this false is the release. */
  dragging?: boolean;
}

export type ViewChangeCallback = (state: ViewState) => void;

export class ViewController {
  private canvas: HTMLCanvasElement;
  private state: ViewState;
  private onChange: ViewChangeCallback;
  
  // Interaction state
  private isDragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(
    canvas: HTMLCanvasElement, 
    initialState: ViewState,
    onChange: ViewChangeCallback
  ) {
    this.canvas = canvas;
    this.state = { ...initialState };
    this.onChange = onChange;
    
    this.setupEventListeners();
    
    // Initial callback
    this.onChange(this.state);
  }

  private setupEventListeners(): void {
    const canvas = this.canvas;
    // One code path for mouse, pen and touch. touch-action: none hands
    // every gesture on the map to us (no page scroll, no browser zoom).
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('resize', this.onResize);
  }

  /** Pointers currently down on the map, by id, at their last position. */
  private pointers = new Map<number, { x: number; y: number }>();
  /** Two-pointer gesture baseline: distance, zoom and midpoint at its start. */
  private pinchDist = 0;
  private pinchZoom = 0;
  private pinchMidX = 0;
  private pinchMidY = 0;
  /** For double-tap on touch, which does not fire dblclick everywhere. */
  private lastTapTime = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  private moved = false;
  /** Touch double-taps are handled on pointerup; a dblclick after one is not ours. */
  private lastPointerType = 'mouse';

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /**
   * (Re)start the gesture from the pointers now down. Called whenever a
   * finger lands or lifts, so going from two fingers to one (or back) carries
   * on smoothly instead of jumping.
   */
  private beginGesture(): void {
    const pts = [...this.pointers.values()];
    if (pts.length === 1) {
      this.lastX = pts[0].x;
      this.lastY = pts[0].y;
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      this.pinchDist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      this.pinchZoom = this.state.zoom;
      this.pinchMidX = (a.x + b.x) / 2;
      this.pinchMidY = (a.y + b.y) / 2;
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    this.lastPointerType = e.pointerType;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 1) {
      this.moved = false;
      this.state.shift = e.shiftKey;
    } else {
      // A second finger: a pinch, which is never a look-around.
      this.state.shift = false;
    }
    this.isDragging = true;
    this.state.dragging = true;
    this.canvas.style.cursor = 'grabbing';
    this.beginGesture();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    const pts = [...this.pointers.values()];
    if (pts.length === 1) {
      const dx = p.x - this.lastX;
      const dy = p.y - this.lastY;
      if (dx === 0 && dy === 0) return;
      this.lastX = p.x;
      this.lastY = p.y;
      this.moved = true;
      this.pan(dx, dy);
      return;
    }
    // Two fingers: zoom by the change in spread, about the midpoint, and
    // pan by the midpoint's own movement.
    const [a, b] = pts;
    const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    this.moved = true;
    this.applyPinch(midX, midY, this.pinchZoom + Math.log2(dist / this.pinchDist));
  };

  /**
   * Set zoom so the world point that was under the gesture's starting
   * midpoint is now under the current midpoint: one state change, one
   * onChange, for both the zoom and the pan of a two-finger gesture.
   */
  private applyPinch(midX: number, midY: number, zoom: number): void {
    const z = Math.max(-20, Math.min(10, zoom));
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const s0 = Math.pow(2, this.state.zoom);
    // The world point under the starting midpoint, in the current state.
    const wx = this.state.centerX + (this.pinchMidX - w / 2) / s0;
    const wy = this.state.centerY - (this.pinchMidY - h / 2) / s0;
    const s1 = Math.pow(2, z);
    this.state.zoom = z;
    this.state.centerX = wx - (midX - w / 2) / s1;
    this.state.centerY = wy + (midY - h / 2) / s1;
    this.pinchMidX = midX;
    this.pinchMidY = midY;
    this.onChange(this.state);
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.pointers.size > 0) {
      // Still a finger down: carry on from where it is.
      this.beginGesture();
      return;
    }
    // Double tap on touch zooms in on the tap (dblclick covers the mouse).
    if (e.pointerType !== 'mouse' && !this.moved && e.type === 'pointerup') {
      const p = this.local(e);
      const now = performance.now();
      if (now - this.lastTapTime < 300 && Math.hypot(p.x - this.lastTapX, p.y - this.lastTapY) < 30) {
        this.lastTapTime = 0;
        this.finishDrag();
        this.zoomAt(p.x, p.y, 1);
        return;
      }
      this.lastTapTime = now;
      this.lastTapX = p.x;
      this.lastTapY = p.y;
    }
    this.finishDrag();
  };

  private finishDrag(): void {
    const wasDragging = this.isDragging;
    this.isDragging = false;
    this.state.dragging = false;
    this.canvas.style.cursor = 'grab';
    // The release is a view change too: whoever defers work during a drag
    // does it now. shift stays set through this call so the release is
    // classified like the drag it ends.
    if (wasDragging) this.onChange(this.state);
    this.state.shift = false;
  }

  private onDoubleClick = (e: MouseEvent): void => {
    e.preventDefault();
    if (this.lastPointerType !== 'mouse') return;
    const p = this.local(e);
    this.zoomAt(p.x, p.y, e.shiftKey ? -1 : 1);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.state.shift = false;
    const p = this.local(e);
    // Proportional to the scroll: a trackpad sends many small deltas and a
    // mouse wheel a few big ones, and both should feel the same. Line and
    // page modes are converted to pixels; 500 px of scroll is one doubling.
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight : 1;
    let delta = -e.deltaY * scale / 500;
    // ctrl+wheel is a trackpad pinch in Chrome, Safari and Firefox; its
    // deltas are small, so speed it up to track the fingers.
    if (e.ctrlKey) delta *= 4;
    delta = Math.max(-1, Math.min(1, delta));
    this.zoomAt(p.x, p.y, delta);
  };

  private onResize = (): void => {
    this.onChange(this.state);
  };

  /**
   * Pan by screen pixels
   */
  private pan(dx: number, dy: number): void {
    const scale = Math.pow(2, this.state.zoom);
    // Convert screen pixels to world units
    this.state.centerX -= dx / scale;
    this.state.centerY += dy / scale;  // Y is flipped in screen coords
    this.onChange(this.state);
  }

  /**
   * Zoom at a screen position
   */
  private zoomAt(screenX: number, screenY: number, delta: number): void {
    const newZoom = Math.max(-20, Math.min(10, this.state.zoom + delta));
    this.setZoomAt(screenX, screenY, newZoom);
  }

  private setZoomAt(screenX: number, screenY: number, newZoom: number): void {
    const oldZoom = this.state.zoom;
    const clampedZoom = Math.max(-20, Math.min(10, newZoom));
    
    if (clampedZoom === oldZoom) return;
    
    // Get world position under cursor before zoom
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    const oldScale = Math.pow(2, oldZoom);
    
    const worldX = this.state.centerX + (screenX - cssWidth / 2) / oldScale;
    const worldY = this.state.centerY - (screenY - cssHeight / 2) / oldScale;
    
    // Apply new zoom
    this.state.zoom = clampedZoom;
    const newScale = Math.pow(2, clampedZoom);
    
    // Adjust center so world position stays under cursor
    this.state.centerX = worldX - (screenX - cssWidth / 2) / newScale;
    this.state.centerY = worldY + (screenY - cssHeight / 2) / newScale;
    
    this.onChange(this.state);
  }

  /**
   * Set view to fit bounds
   */
  fitBounds(minX: number, minY: number, maxX: number, maxY: number, padding = 0.1): void {
    this.state.centerX = (minX + maxX) / 2;
    this.state.centerY = (minY + maxY) / 2;
    
    const boundsWidth = maxX - minX;
    const boundsHeight = maxY - minY;
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    
    // Calculate zoom to fit bounds with padding
    const scaleX = cssWidth / boundsWidth;
    const scaleY = cssHeight / boundsHeight;
    const scale = Math.min(scaleX, scaleY) * (1 - padding);
    
    this.state.zoom = Math.log2(scale);
    this.onChange(this.state);
  }

  /**
   * Replace the state without firing onChange. Used by the centred-projection
   * mode, which consumes the accumulated pan offset each frame and resets the
   * centre to the origin.
   */
  setState(partial: Partial<ViewState>): void {
    Object.assign(this.state, partial);
  }

  getState(): ViewState {
    return { ...this.state };
  }

  destroy(): void {
    const canvas = this.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('resize', this.onResize);
  }
}
