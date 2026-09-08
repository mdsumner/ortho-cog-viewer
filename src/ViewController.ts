/**
 * Minimal pan/zoom controller for orthographic 2D view
 * 
 * Handles mouse/wheel/touch input and tracks view state.
 */

export interface ViewState {
  centerX: number;
  centerY: number;
  zoom: number;  // log2 scale: 0 = 1:1, -1 = half size, 1 = double size
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
    
    // Mouse events
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('mouseleave', this.onMouseUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    
    // Touch events
    canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    canvas.addEventListener('touchend', this.onTouchEnd);
    
    // Resize
    window.addEventListener('resize', this.onResize);
  }

  private onMouseDown = (e: MouseEvent): void => {
    this.isDragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.style.cursor = 'grabbing';
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isDragging) return;
    
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    
    this.pan(dx, dy);
  };

  private onMouseUp = (): void => {
    this.isDragging = false;
    this.canvas.style.cursor = 'grab';
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    
    // Zoom centered on mouse position
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // Normalize delta across browsers
    const delta = -Math.sign(e.deltaY) * 0.1;
    
    this.zoomAt(mouseX, mouseY, delta);
  };

  // Touch handling for pinch zoom
  private touchStartDist = 0;
  private touchStartZoom = 0;
  private touchStartCenter = { x: 0, y: 0 };

  private onTouchStart = (e: TouchEvent): void => {
    e.preventDefault();
    
    if (e.touches.length === 1) {
      this.isDragging = true;
      this.lastX = e.touches[0].clientX;
      this.lastY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      // Pinch zoom
      this.isDragging = false;
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      this.touchStartDist = Math.sqrt(dx * dx + dy * dy);
      this.touchStartZoom = this.state.zoom;
      this.touchStartCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2
      };
    }
  };

  private onTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    
    if (e.touches.length === 1 && this.isDragging) {
      const dx = e.touches[0].clientX - this.lastX;
      const dy = e.touches[0].clientY - this.lastY;
      this.lastX = e.touches[0].clientX;
      this.lastY = e.touches[0].clientY;
      this.pan(dx, dy);
    } else if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const scale = dist / this.touchStartDist;
      const newZoom = this.touchStartZoom + Math.log2(scale);
      
      const rect = this.canvas.getBoundingClientRect();
      const cx = this.touchStartCenter.x - rect.left;
      const cy = this.touchStartCenter.y - rect.top;
      
      this.setZoomAt(cx, cy, newZoom);
    }
  };

  private onTouchEnd = (): void => {
    this.isDragging = false;
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
    canvas.removeEventListener('mousedown', this.onMouseDown);
    canvas.removeEventListener('mousemove', this.onMouseMove);
    canvas.removeEventListener('mouseup', this.onMouseUp);
    canvas.removeEventListener('mouseleave', this.onMouseUp);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('touchstart', this.onTouchStart);
    canvas.removeEventListener('touchmove', this.onTouchMove);
    canvas.removeEventListener('touchend', this.onTouchEnd);
    window.removeEventListener('resize', this.onResize);
  }
}
