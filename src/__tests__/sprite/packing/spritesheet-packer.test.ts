import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { decodeFrameImage, packSpritesheet } from "../../../sprite/packing/spritesheet-packer.js";
import { DEFAULT_SPRITE_PIVOT } from "../../../sprite/types.js";
import type { RawImage, SpritesheetPackOptions } from "../../../sprite/types.js";

// Compositing is asserted by decoding the packed sheet back to raw RGBA and
// sampling pixels: the properties that matter are that each frame lands in its
// metadata rect and that untouched sheet area stays TRANSPARENT (never a solid
// background), which only the pixels can prove.

const OPTIONS: SpritesheetPackOptions = {
  layout: "grid",
  fps: 12,
  pivot: DEFAULT_SPRITE_PIVOT,
};

function solidFrame(width: number, height: number, rgba: [number, number, number, number]): RawImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { data, width, height };
}

async function decodeSheet(png: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function pixelAt(image: RawImage, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3],
  ];
}

describe("packSpritesheet", () => {
  it("places each frame at its metadata rect", async () => {
    const red = solidFrame(4, 4, [255, 0, 0, 255]);
    const green = solidFrame(4, 4, [0, 255, 0, 255]);
    const blue = solidFrame(4, 4, [0, 0, 255, 255]);

    const packed = await packSpritesheet([red, green, blue], {
      ...OPTIONS,
      layout: "horizontal",
    });
    const sheet = await decodeSheet(packed.png);

    expect([sheet.width, sheet.height]).toEqual([12, 4]);
    expect(pixelAt(sheet, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(sheet, 4, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(sheet, 8, 0)).toEqual([0, 0, 255, 255]);
    expect(packed.metadata.frames[2]).toEqual({ index: 2, x: 8, y: 0, width: 4, height: 4 });
  });

  it("leaves unused cells and transparent frame pixels fully transparent", async () => {
    const opaque = solidFrame(4, 4, [10, 20, 30, 255]);
    const transparent = solidFrame(4, 4, [0, 0, 0, 0]);

    // 3 frames in a 2-column grid => one empty trailing cell at (4, 4).
    const packed = await packSpritesheet([opaque, transparent, opaque], {
      ...OPTIONS,
      columns: 2,
    });
    const sheet = await decodeSheet(packed.png);

    expect([sheet.width, sheet.height]).toEqual([8, 8]);
    expect(pixelAt(sheet, 5, 1)[3]).toBe(0); // the transparent frame
    expect(pixelAt(sheet, 5, 5)[3]).toBe(0); // the empty trailing cell
    expect(pixelAt(sheet, 1, 5)).toEqual([10, 20, 30, 255]);
  });

  it("preserves the caller's frame order as the frame index", async () => {
    const frames = [
      solidFrame(2, 2, [1, 1, 1, 255]),
      solidFrame(2, 2, [2, 2, 2, 255]),
      solidFrame(2, 2, [3, 3, 3, 255]),
      solidFrame(2, 2, [4, 4, 4, 255]),
    ];
    const packed = await packSpritesheet(frames, { ...OPTIONS, layout: "vertical" });
    const sheet = await decodeSheet(packed.png);

    for (let i = 0; i < frames.length; i++) {
      const rect = packed.metadata.frames[i];
      expect(rect.index).toBe(i);
      expect(pixelAt(sheet, rect.x, rect.y)[0]).toBe(i + 1);
    }
  });

  it("fails loudly on mismatched frame dimensions instead of cropping or padding", async () => {
    const frames = [solidFrame(4, 4, [0, 0, 0, 255]), solidFrame(4, 8, [0, 0, 0, 255])];
    await expect(packSpritesheet(frames, OPTIONS)).rejects.toThrow(
      /identical dimensions.*frame 1 is 4x8/s,
    );
  });

  it("rejects an empty frame list", async () => {
    await expect(packSpritesheet([], OPTIONS)).rejects.toThrow(/at least one frame/);
  });
});

describe("decodeFrameImage", () => {
  it("decodes to RGBA at native size without resizing", async () => {
    const png = await sharp({
      create: { width: 6, height: 3, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .png()
      .toBuffer();

    const decoded = await decodeFrameImage(png);
    expect([decoded.width, decoded.height]).toEqual([6, 3]);
    expect(decoded.data.length).toBe(6 * 3 * 4);
    expect(pixelAt(decoded, 0, 0)).toEqual([200, 100, 50, 255]);
  });
});
