/**
 * Colour ramps for numeric data, as 256x1 RGBA byte arrays for a lookup
 * texture. Control points are interpolated linearly in RGB.
 */

export interface Colormap {
  label: string;
  stops: [number, number, number][];   // 0..255 RGB
  /**
   * For value-anchored palettes: the data value of each stop, ascending.
   * Selecting such a palette pins the layer's range to [values[0], values[n-1]]
   * and the ramp is interpolated in value space, so a colour always means the
   * same depth or height regardless of what the data's own range is.
   */
  values?: number[];
}

export const COLORMAPS: Record<string, Colormap> = {
  viridis: {
    label: 'viridis',
    stops: [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
            [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]]
  },
  magma: {
    label: 'magma',
    stops: [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122],
            [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]]
  },
  inferno: {
    label: 'inferno',
    stops: [[0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85],
            [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164]]
  },
  turbo: {
    label: 'turbo',
    stops: [[48, 18, 59], [70, 107, 227], [39, 173, 241], [29, 228, 170], [122, 250, 89],
            [200, 234, 44], [251, 191, 45], [242, 116, 24], [190, 45, 5], [122, 4, 3]]
  },
  cividis: {
    label: 'cividis',
    stops: [[0, 32, 77], [30, 50, 100], [65, 70, 107], [96, 91, 111], [126, 112, 116],
            [156, 134, 116], [188, 157, 110], [222, 181, 99], [255, 208, 80]]
  },
  grey: {
    label: 'grey',
    stops: [[0, 0, 0], [255, 255, 255]]
  },
  blues: {
    label: 'blues',
    stops: [[247, 251, 255], [198, 219, 239], [107, 174, 214], [33, 113, 181], [8, 48, 107]]
  },
  rdbu: {
    label: 'red-blue (diverging)',
    stops: [[103, 0, 31], [214, 96, 77], [244, 165, 130], [247, 247, 247],
            [146, 197, 222], [67, 147, 195], [5, 48, 97]]
  },
  bathy: {
    label: 'bathymetry (deep-shallow)',
    stops: [[8, 24, 68], [20, 60, 120], [40, 110, 170], [90, 170, 210], [170, 220, 235], [235, 245, 250]]
  },
  // DiRT bathymetry/topography palette as used aboard RSV Nuyina: anchored
  // at depths in metres, -8000 to +1000, so it scales sensibly for the whole
  // ocean with very few control points.
  dirt: {
    label: 'DiRT bathy/topo (m, anchored)',
    values: [-8000, -7000, -6000, -5000, -4000, -3500, -3000, -2500, -2000, -1500, -1000, -750, -500, -250, 0, 500, 1000],
    stops: [[126, 2, 2], [126, 2, 62], [126, 2, 118], [75, 2, 126], [30, 1, 136], [1, 25, 146],
            [1, 84, 156], [1, 152, 167], [1, 177, 127], [1, 187, 64], [8, 198, 0], [86, 208, 0],
            [172, 218, 0], [229, 192, 0], [255, 255, 255], [236, 254, 251], [207, 246, 239]]
  }
};

/**
 * Data range a palette pins the layer to, or null for relative palettes.
 */
export function colormapRange(name: string): [number, number] | null {
  const cm = COLORMAPS[name];
  if (!cm || !cm.values) return null;
  return [cm.values[0], cm.values[cm.values.length - 1]];
}

export function isColormapName(s: string): boolean {
  return Object.prototype.hasOwnProperty.call(COLORMAPS, s);
}

/**
 * 256 RGBA bytes for a lookup texture.
 */
export function colormapBytes(name: string): Uint8Array {
  const cm = COLORMAPS[name] || COLORMAPS.viridis;
  const out = new Uint8Array(256 * 4);
  const n = cm.stops.length;
  // Stop positions in [0, 1]: evenly spaced, or by value for anchored palettes
  const pos: number[] = cm.values
    ? cm.values.map(v => (v - cm.values![0]) / (cm.values![n - 1] - cm.values![0]))
    : cm.stops.map((_, i) => i / (n - 1));
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let k = 0;
    while (k < n - 2 && pos[k + 1] < x) k++;
    const span = pos[k + 1] - pos[k] || 1;
    const f = Math.max(0, Math.min(1, (x - pos[k]) / span));
    const a = cm.stops[k], b = cm.stops[k + 1];
    out[i * 4 + 0] = Math.round(a[0] + (b[0] - a[0]) * f);
    out[i * 4 + 1] = Math.round(a[1] + (b[1] - a[1]) * f);
    out[i * 4 + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * CSS gradient for a legend swatch.
 */
export function colormapCss(name: string): string {
  const cm = COLORMAPS[name] || COLORMAPS.viridis;
  const n = cm.stops.length;
  const pos = cm.values
    ? cm.values.map(v => (v - cm.values![0]) / (cm.values![n - 1] - cm.values![0]))
    : cm.stops.map((_, i) => i / (n - 1));
  return `linear-gradient(to right, ${cm.stops.map((s, i) => `rgb(${s[0]},${s[1]},${s[2]}) ${(pos[i] * 100).toFixed(1)}%`).join(', ')})`;
}
