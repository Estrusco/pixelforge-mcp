import sharp from "sharp";
import { applyPalette, buildPalette, utils } from "image-q";
import type { PaletteSource, QuantizeOptions, QuantizeResult, RawImage } from "../types.js";
import { cleanupIsolatedPixels } from "./cleanup-isolated-pixels.js";
import { gridSnap } from "./grid-snap.js";
import { getLospecPreset } from "./palettes/lospec-presets.js";
import { hexToRgb, rgbToHex } from "./palettes/hex-color.js";

const { Palette, Point, PointContainer } = utils;

// Alpha is never fed to the color-distance/quantization math (nearest-color
// search would otherwise pull semi-transparent pixels toward whatever
// opaque palette entry looks "closest" once alpha enters the metric). The
// working copy is forced fully opaque for quantization, then the *original*
// per-pixel alpha bytes are copied back onto the result unchanged.
function forceOpaque(image: RawImage): Buffer {
  const out = Buffer.from(image.data);
  for (let i = 3; i < out.length; i += 4) out[i] = 0xff;
  return out;
}

function restoreAlpha(quantizedRgba: Uint8Array, original: RawImage): RawImage {
  const out = Buffer.from(quantizedRgba);
  const pixelCount = original.width * original.height;
  for (let i = 0; i < pixelCount; i++) {
    out[i * 4 + 3] = original.data[i * 4 + 3];
  }
  return { data: out, width: original.width, height: original.height };
}

function paletteFromHexColors(colors: readonly string[]): InstanceType<typeof Palette> {
  if (colors.length === 0) {
    throw new Error("Palette must contain at least one color.");
  }
  const palette = new Palette();
  for (const hex of colors) {
    const [r, g, b] = hexToRgb(hex);
    palette.add(Point.createByRGBA(r, g, b, 0xff));
  }
  return palette;
}

async function resolvePalette(
  sourceContainer: InstanceType<typeof PointContainer>,
  source: PaletteSource,
): Promise<InstanceType<typeof Palette>> {
  switch (source.mode) {
    case "auto_kmeans":
      // image-q has no literal k-means; Wu quantization (variance
      // minimization over the color histogram) is its closest built-in
      // equivalent for an "automatic palette sized to N colors" request.
      return buildPalette([sourceContainer], {
        colors: source.paletteSize,
        paletteQuantization: "wuquant",
        colorDistanceFormula: "euclidean-bt709-noalpha",
      });
    case "lospec":
      return paletteFromHexColors(getLospecPreset(source.slug));
    case "custom":
      return paletteFromHexColors(source.colors);
  }
}

function paletteToHexList(palette: InstanceType<typeof Palette>): string[] {
  return palette
    .getPointContainer()
    .getPointArray()
    .map((p) => rgbToHex(p.r, p.g, p.b));
}

// Full pixelate_image postprocess pipeline: grid-snap -> palette resolution
// -> nearest-color mapping -> isolated-pixel cleanup. Alpha is preserved
// byte-for-byte throughout; only RGB is ever quantized.
export async function quantizeImage(bytes: Buffer, options: QuantizeOptions): Promise<QuantizeResult> {
  const snapped = await gridSnap(bytes, options.targetResolution);

  const sourceContainer = PointContainer.fromBuffer(
    forceOpaque(snapped),
    snapped.width,
    snapped.height,
  );

  const palette = await resolvePalette(sourceContainer, options.palette);

  const mapped = await applyPalette(sourceContainer, palette, {
    imageQuantization: "nearest",
    colorDistanceFormula: "euclidean-bt709-noalpha",
  });

  const alphaPreserved = restoreAlpha(mapped.toUint8Array(), snapped);

  const cleaned =
    options.cleanupIsolatedPixels === false ? alphaPreserved : cleanupIsolatedPixels(alphaPreserved);

  const png = await sharp(cleaned.data, {
    raw: { width: cleaned.width, height: cleaned.height, channels: 4 },
  })
    .png()
    .toBuffer();

  return {
    png,
    palette: paletteToHexList(palette),
    width: cleaned.width,
    height: cleaned.height,
  };
}
