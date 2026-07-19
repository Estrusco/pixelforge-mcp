// Standalone visual smoke test for src/sprite/postprocess — NOT an MCP tool,
// NOT part of the automated test suite. Run with:
//   npx tsx scripts/test-quantize-pipeline.ts [outDir]
//
// Exercises grid-snap -> palette resolution -> nearest-color mapping ->
// isolated-pixel cleanup across all three palette modes, and confirms alpha
// survives the round trip.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { quantizeImage } from "../src/sprite/postprocess/quantize.js";
import type { PaletteSource } from "../src/sprite/types.js";

const outDir = process.argv[2] ?? "quantize-test-out";

async function buildSyntheticSprite(): Promise<Buffer> {
  // 24x24 RGBA canvas: transparent background, an opaque red/blue checker
  // "sprite", a semi-transparent green pixel (alpha round-trip check), and a
  // handful of single-pixel noise specks (isolated-pixel cleanup check).
  const size = 24;
  const channels = 4;
  const data = Buffer.alloc(size * size * channels, 0);

  const setPixel = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    const i = (y * size + x) * channels;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  };

  for (let y = 6; y < 18; y++) {
    for (let x = 6; x < 18; x++) {
      const isRed = (Math.floor((x - 6) / 2) + Math.floor((y - 6) / 2)) % 2 === 0;
      setPixel(x, y, isRed ? 220 : 40, isRed ? 40 : 60, isRed ? 40 : 220, 255);
    }
  }

  setPixel(12, 12, 40, 200, 90, 128); // semi-transparent pixel inside the sprite

  // Noise specks: single pixels that differ from all 4 neighbors.
  setPixel(3, 3, 255, 255, 0, 255);
  setPixel(20, 4, 0, 255, 255, 255);
  setPixel(2, 20, 255, 0, 255, 255);

  return sharp(data, { raw: { width: size, height: size, channels } }).png().toBuffer();
}

async function run() {
  await mkdir(outDir, { recursive: true });

  const synthetic = await buildSyntheticSprite();
  await writeFile(join(outDir, "0-synthetic-input.png"), synthetic);

  const cases: Array<{ name: string; input: Buffer; target: { width: number; height: number }; palette: PaletteSource }> = [
    {
      name: "synthetic-lospec-pico8",
      input: synthetic,
      target: { width: 24, height: 24 },
      palette: { mode: "lospec", slug: "pico-8" },
    },
    {
      name: "synthetic-lospec-resurrect64",
      input: synthetic,
      target: { width: 24, height: 24 },
      palette: { mode: "lospec", slug: "resurrect-64" },
    },
    {
      name: "synthetic-custom",
      input: synthetic,
      target: { width: 24, height: 24 },
      palette: { mode: "custom", colors: ["#220000", "#ff2b2b", "#2b2bff", "#ffffff"] },
    },
    {
      name: "synthetic-auto-kmeans",
      input: synthetic,
      target: { width: 24, height: 24 },
      palette: { mode: "auto_kmeans", paletteSize: 6 },
    },
    {
      name: "photo-lospec-sweetie16",
      input: await sharp("assets/sample_woman.png").toBuffer(),
      target: { width: 64, height: 36 },
      palette: { mode: "lospec", slug: "sweetie-16" },
    },
    {
      name: "photo-auto-kmeans",
      input: await sharp("assets/sample_woman.png").toBuffer(),
      target: { width: 64, height: 36 },
      palette: { mode: "auto_kmeans", paletteSize: 16 },
    },
  ];

  for (const testCase of cases) {
    const result = await quantizeImage(testCase.input, {
      targetResolution: testCase.target,
      palette: testCase.palette,
    });
    const filePath = join(outDir, `${testCase.name}.png`);
    await writeFile(filePath, result.png);
    console.log(`\n${testCase.name} -> ${filePath}`);
    console.log(`  size: ${result.width}x${result.height}`);
    console.log(`  palette (${result.palette.length}): ${result.palette.join(", ")}`);
  }

  // Verify the semi-transparent alpha byte and the noise specks specifically.
  const cleaned = await quantizeImage(synthetic, {
    targetResolution: { width: 24, height: 24 },
    palette: { mode: "lospec", slug: "pico-8" },
  });
  const { data, info } = await sharp(cleaned.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
  console.log(`\nalpha check: center pixel (12,12) alpha = ${alphaAt(12, 12)} (expected 128, source was semi-transparent)`);
  console.log(`background pixel (0,0) alpha = ${alphaAt(0, 0)} (expected 0, still fully transparent)`);

  const colorAt = (x: number, y: number) => {
    const i = (y * info.width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  console.log(`noise speck (3,3) color after cleanup = ${colorAt(3, 3)} (should match its transparent-background neighbors' color, not yellow)`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
