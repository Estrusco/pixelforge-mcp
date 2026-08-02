import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { quantizeImage } from "../../../sprite/postprocess/quantize.js";

async function makeSourcePng(): Promise<Buffer> {
  // 8x8 red square on a fully transparent background — plenty for a 4x4
  // target grid to resolve distinct colors either side of nearest-neighbor.
  return sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 255 } },
  })
    .png()
    .toBuffer();
}

describe("quantizeImage — outputSize", () => {
  it("writes the PNG at the logical grid size when outputSize is omitted (unchanged default)", async () => {
    const bytes = await makeSourcePng();
    const result = await quantizeImage(bytes, {
      targetResolution: { width: 4, height: 4 },
      palette: { mode: "custom", colors: ["#ff0000"] },
    });

    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    const meta = await sharp(result.png).metadata();
    expect(meta.width).toBe(4);
    expect(meta.height).toBe(4);
  });

  it("upscales the final PNG via nearest-neighbor without changing the logical grid", async () => {
    const bytes = await makeSourcePng();
    const result = await quantizeImage(bytes, {
      targetResolution: { width: 4, height: 4 },
      palette: { mode: "custom", colors: ["#ff0000"] },
      outputSize: { width: 8, height: 8 },
    });

    expect(result.width).toBe(8);
    expect(result.height).toBe(8);
    const meta = await sharp(result.png).metadata();
    expect(meta.width).toBe(8);
    expect(meta.height).toBe(8);

    // Nearest-neighbor 2x: every 2x2 output block must be a single solid
    // color (no blending/blur), confirming the grid was upscaled, not resampled.
    const { data, info } = await sharp(result.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    function px(x: number, y: number) {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    }
    expect(px(0, 0)).toEqual(px(1, 0));
    expect(px(0, 0)).toEqual(px(0, 1));
    expect(px(0, 0)).toEqual(px(1, 1));
  });

  it("supports non-uniform (non-square) output dimensions", async () => {
    const bytes = await makeSourcePng();
    const result = await quantizeImage(bytes, {
      targetResolution: { width: 4, height: 4 },
      palette: { mode: "custom", colors: ["#ff0000"] },
      outputSize: { width: 16, height: 8 },
    });

    expect(result.width).toBe(16);
    expect(result.height).toBe(8);
    const meta = await sharp(result.png).metadata();
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(8);
  });

  it("preserves alpha through an upscale (fully transparent corner stays transparent)", async () => {
    // A 4x4 source with a transparent top-left quadrant and opaque rest.
    const src = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 255 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
          // Default "over" blending lets a fully-transparent source pixel show
          // the opaque destination through — "source" overwrites it outright,
          // which is what actually punches a transparent hole here.
          blend: "source",
        },
      ])
      .png()
      .toBuffer();

    const result = await quantizeImage(src, {
      targetResolution: { width: 4, height: 4 },
      palette: { mode: "custom", colors: ["#00ff00"] },
      outputSize: { width: 8, height: 8 },
    });

    const { data, info } = await sharp(result.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const i = (0 * info.width + 0) * info.channels;
    expect(data[i + 3]).toBe(0); // top-left corner still transparent after upscale
  });
});
