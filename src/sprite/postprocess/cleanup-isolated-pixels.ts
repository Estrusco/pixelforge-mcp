import type { RawImage } from "../types.js";

type Rgb = readonly [number, number, number];

const CHANNELS = 4;

function rgbAt(image: RawImage, x: number, y: number): Rgb {
  const idx = (y * image.width + x) * CHANNELS;
  const { data } = image;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

function sameColor(a: Rgb, b: Rgb): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function dominantColor(neighbors: readonly Rgb[]): Rgb {
  const counts = new Map<string, { count: number; color: Rgb }>();
  for (const color of neighbors) {
    const key = color.join(",");
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { count: 1, color });
  }
  let best = neighbors[0];
  let bestCount = 0;
  for (const entry of counts.values()) {
    if (entry.count > bestCount) {
      bestCount = entry.count;
      best = entry.color;
    }
  }
  return best;
}

// Despeckle pass on color only: a pixel whose RGB matches none of its 4
// orthogonal neighbors is "isolated" and gets its RGB replaced by the
// dominant (most common) neighbor color. Alpha is never read for the
// comparison and never rewritten — every pixel keeps its own original alpha
// byte, so a lone semi-transparent pixel amid opaque same-color neighbors is
// left alone rather than treated as noise.
// Operates on a copy so replacements never feed off already-cleaned pixels.
export function cleanupIsolatedPixels(image: RawImage): RawImage {
  const { width, height } = image;
  const out = Buffer.from(image.data);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const center = rgbAt(image, x, y);
      const neighbors: Rgb[] = [];
      if (x > 0) neighbors.push(rgbAt(image, x - 1, y));
      if (x < width - 1) neighbors.push(rgbAt(image, x + 1, y));
      if (y > 0) neighbors.push(rgbAt(image, x, y - 1));
      if (y < height - 1) neighbors.push(rgbAt(image, x, y + 1));

      const isIsolated = neighbors.length > 0 && neighbors.every((n) => !sameColor(n, center));
      if (!isIsolated) continue;

      const [r, g, b] = dominantColor(neighbors);
      const idx = (y * width + x) * CHANNELS;
      out[idx] = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
    }
  }

  return { data: out, width, height };
}
