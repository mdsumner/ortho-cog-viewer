/**
 * Colour ramps for numeric data, as 256x1 RGBA byte arrays for a lookup
 * texture. Control points are interpolated linearly in RGB.
 */

export interface Colormap {
  label: string;
  stops: [number, number, number][];   // 0..255 RGB, evenly spaced
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
  }
};

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
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (n - 1);
    const k = Math.min(n - 2, Math.floor(t));
    const f = t - k;
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
  return `linear-gradient(to right, ${cm.stops.map(s => `rgb(${s[0]},${s[1]},${s[2]})`).join(', ')})`;
}
