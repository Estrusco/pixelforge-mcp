import { describe, expect, it, beforeEach, vi } from "vitest";
import sharp from "sharp";

vi.mock("../../services/image-management.js", () => ({
  getOutputImage: vi.fn(),
}));

import { AssetRegistry } from "../../services/asset-registry.js";
import { buildContactSheet, CONTACT_SHEET_MAX_ASSETS } from "../../services/contact-sheet.js";
import { getOutputImage } from "../../services/image-management.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

const mockedGetOutputImage = vi.mocked(getOutputImage);

function register(filename: string): string {
  const wf: WorkflowJSON = { "9": { class_type: "SaveImage", inputs: { filename_prefix: "x" } } };
  const [rec] = AssetRegistry.register({
    promptId: `p-${filename}`,
    workflow: wf,
    outputs: [{ node_id: "9", images: [{ filename, subfolder: "", type: "output", url: "u" }] }],
  });
  return rec.assetId;
}

async function solidPng(width: number, height: number, rgb: [number, number, number]): Promise<string> {
  const [r, g, b] = rgb;
  const png = await sharp({ create: { width, height, channels: 4, background: { r, g, b, alpha: 255 } } })
    .png()
    .toBuffer();
  return png.toString("base64");
}

async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number, number]> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

describe("buildContactSheet", () => {
  beforeEach(() => {
    AssetRegistry.configure({ ttlMs: 60_000, now: Date.now });
    AssetRegistry.clear();
    mockedGetOutputImage.mockReset();
  });

  it("rejects an empty asset_ids list", async () => {
    await expect(buildContactSheet({ assetIds: [] })).rejects.toThrow(/non-empty/);
  });

  it("rejects more than CONTACT_SHEET_MAX_ASSETS entries", async () => {
    const ids = Array.from({ length: CONTACT_SHEET_MAX_ASSETS + 1 }, (_, i) => `a_${i}`);
    await expect(buildContactSheet({ assetIds: ids })).rejects.toThrow(/at most/);
  });

  it("rejects an unknown asset id", async () => {
    await expect(buildContactSheet({ assetIds: ["a_doesnotexist"] })).rejects.toThrow(/No asset found/);
  });

  it("rejects a non-positive columns value", async () => {
    const id = register("a.png");
    mockedGetOutputImage.mockResolvedValue({ base64: await solidPng(4, 4, [255, 0, 0]), mimeType: "image/png", filename: "a.png" });
    await expect(buildContactSheet({ assetIds: [id], columns: 0 })).rejects.toThrow(/positive integer/);
  });

  it("lays out a squarest grid by default and sizes the sheet from the largest frame", async () => {
    const ids = [register("a.png"), register("b.png"), register("c.png")];
    mockedGetOutputImage
      .mockResolvedValueOnce({ base64: await solidPng(4, 4, [255, 0, 0]), mimeType: "image/png", filename: "a.png" })
      .mockResolvedValueOnce({ base64: await solidPng(8, 8, [0, 255, 0]), mimeType: "image/png", filename: "b.png" })
      .mockResolvedValueOnce({ base64: await solidPng(4, 4, [0, 0, 255]), mimeType: "image/png", filename: "c.png" });

    const result = await buildContactSheet({ assetIds: ids });

    expect(result.count).toBe(3);
    expect(result.columns).toBe(2); // ceil(sqrt(3))
    expect(result.rows).toBe(2);
    expect(result.cellWidth).toBe(8); // largest frame
    expect(result.cellHeight).toBe(8);
    expect(result.sheetWidth).toBe(16);
    expect(result.sheetHeight).toBe(16);
    const meta = await sharp(result.png).metadata();
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(16);
  });

  it("respects an explicit columns override", async () => {
    const ids = [register("a.png"), register("b.png"), register("c.png"), register("d.png")];
    mockedGetOutputImage.mockResolvedValue({ base64: await solidPng(4, 4, [255, 0, 0]), mimeType: "image/png", filename: "x.png" });

    const result = await buildContactSheet({ assetIds: ids, columns: 4 });
    expect(result.columns).toBe(4);
    expect(result.rows).toBe(1);
  });

  it("defaults to a dark background, filling gaps around a smaller frame", async () => {
    const ids = [register("small.png"), register("big.png")];
    mockedGetOutputImage
      .mockResolvedValueOnce({ base64: await solidPng(2, 2, [255, 0, 0]), mimeType: "image/png", filename: "small.png" })
      .mockResolvedValueOnce({ base64: await solidPng(8, 8, [0, 255, 0]), mimeType: "image/png", filename: "big.png" });

    const result = await buildContactSheet({ assetIds: ids, columns: 2 });
    // Cell is 8x8; the 2x2 red frame is centered in its cell, so a pixel near
    // the cell's own corner (well outside the centered 2x2) must be background.
    const [r, g, b, a] = await pixelAt(result.png, 0, 0);
    expect([r, g, b]).toEqual([24, 24, 24]);
    expect(a).toBe(255);
  });

  it("supports a light background", async () => {
    const ids = [register("small.png"), register("big.png")];
    mockedGetOutputImage
      .mockResolvedValueOnce({ base64: await solidPng(2, 2, [255, 0, 0]), mimeType: "image/png", filename: "small.png" })
      .mockResolvedValueOnce({ base64: await solidPng(8, 8, [0, 255, 0]), mimeType: "image/png", filename: "big.png" });

    const result = await buildContactSheet({ assetIds: ids, background: "light", columns: 2 });
    // Same setup as the dark-background case: the small 2x2 frame is centered
    // in an 8x8 cell, so its own corner (0,0) exposes the sheet's backdrop.
    const [r, g, b] = await pixelAt(result.png, 0, 0);
    expect([r, g, b]).toEqual([255, 255, 255]);
  });

  it("returns one label per asset, in order", async () => {
    const ids = [register("first.png"), register("second.png")];
    mockedGetOutputImage.mockResolvedValue({ base64: await solidPng(2, 2, [1, 1, 1]), mimeType: "image/png", filename: "x.png" });

    const result = await buildContactSheet({ assetIds: ids });
    expect(result.labels).toHaveLength(2);
    expect(result.labels[0]).toContain("first.png");
    expect(result.labels[1]).toContain("second.png");
  });
});
