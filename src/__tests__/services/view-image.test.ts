import { describe, expect, it, beforeEach, vi } from "vitest";
import sharp from "sharp";

vi.mock("../../services/image-management.js", () => ({
  getOutputImage: vi.fn(),
}));

import { AssetRegistry } from "../../services/asset-registry.js";
import { viewAssetImage } from "../../services/view-image.js";
import { getOutputImage } from "../../services/image-management.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

const mockedGetOutputImage = vi.mocked(getOutputImage);

function register(filename: string, type = "output", subfolder = ""): string {
  const wf: WorkflowJSON = {
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
  };
  const [rec] = AssetRegistry.register({
    promptId: "p1",
    workflow: wf,
    outputs: [
      {
        node_id: "9",
        images: [{ filename, subfolder, type, url: "u" }],
      },
    ],
  });
  return rec.assetId;
}

describe("viewAssetImage", () => {
  beforeEach(() => {
    AssetRegistry.configure({ ttlMs: 60_000, now: Date.now });
    AssetRegistry.clear();
    mockedGetOutputImage.mockReset();
  });

  it("returns an image content block for a registered PNG asset", async () => {
    const assetId = register("hero.png");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "aGVsbG8=",
      mimeType: "image/png",
      filename: "hero.png",
    });

    const result = await viewAssetImage(assetId);
    expect(mockedGetOutputImage).toHaveBeenCalledWith("hero.png", "output", "");
    const image = result.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    expect(image).toMatchObject({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  });

  it("throws when asset_id is unknown or expired", async () => {
    await expect(viewAssetImage("a_deadbeef")).rejects.toThrow(/No asset found/);
    expect(mockedGetOutputImage).not.toHaveBeenCalled();
  });

  it("rejects unsupported mime types (e.g. audio/video)", async () => {
    const assetId = register("song.flac");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "x",
      mimeType: "audio/flac",
      filename: "song.flac",
    });
    await expect(viewAssetImage(assetId)).rejects.toThrow(/not an image/i);
  });

  it("passes through subfolder and type to the fetcher", async () => {
    const assetId = register("a.png", "temp", "preview");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "x",
      mimeType: "image/png",
      filename: "a.png",
    });
    await viewAssetImage(assetId);
    expect(mockedGetOutputImage).toHaveBeenCalledWith("a.png", "temp", "preview");
  });

  it("includes a text summary alongside the image block", async () => {
    const assetId = register("b.jpg");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: "x",
      mimeType: "image/jpeg",
      filename: "b.jpg",
    });
    const result = await viewAssetImage(assetId);
    const text = result.content.find((c) => c.type === "text");
    expect(text).toBeDefined();
    expect((text as { text: string }).text).toContain(assetId);
    expect((text as { text: string }).text).toContain("b.jpg");
  });
});

describe("viewAssetImage — background compositing", () => {
  beforeEach(() => {
    AssetRegistry.configure({ ttlMs: 60_000, now: Date.now });
    AssetRegistry.clear();
    mockedGetOutputImage.mockReset();
  });

  /** A 4x4 fully-transparent RGBA PNG — background compositing must fill it in. */
  async function transparentPng(): Promise<string> {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    return png.toString("base64");
  }

  async function pixelAt(base64: string, x: number, y: number): Promise<[number, number, number, number]> {
    const { data, info } = await sharp(Buffer.from(base64, "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  }

  it("composites onto a dark background, always returning PNG", async () => {
    const assetId = register("neon.png");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: await transparentPng(),
      mimeType: "image/png",
      filename: "neon.png",
    });

    const result = await viewAssetImage(assetId, "dark");
    const image = result.content.find((c) => c.type === "image") as { data: string; mimeType: string };
    expect(image.mimeType).toBe("image/png");
    const [r, g, b, a] = await pixelAt(image.data, 0, 0);
    expect([r, g, b]).toEqual([24, 24, 24]);
    expect(a).toBe(255); // flattened opaque, no longer transparent
  });

  it("composites onto a light background", async () => {
    const assetId = register("neon.png");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: await transparentPng(),
      mimeType: "image/png",
      filename: "neon.png",
    });

    const result = await viewAssetImage(assetId, "light");
    const image = result.content.find((c) => c.type === "image") as { data: string };
    const [r, g, b] = await pixelAt(image.data, 0, 0);
    expect([r, g, b]).toEqual([255, 255, 255]);
  });

  it("composites onto a checker pattern", async () => {
    const assetId = register("neon.png");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: await transparentPng(),
      mimeType: "image/png",
      filename: "neon.png",
    });

    const result = await viewAssetImage(assetId, "checker");
    const image = result.content.find((c) => c.type === "image") as { data: string };
    const [r, g, b, a] = await pixelAt(image.data, 0, 0);
    // Checker cells are #cccccc / #999999 — either way it must be opaque gray, not transparent black.
    expect(a).toBe(255);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect([204, 153]).toContain(r);
  });

  it("returns the raw bytes unchanged when background is omitted", async () => {
    const assetId = register("neon.png");
    const raw = await transparentPng();
    mockedGetOutputImage.mockResolvedValueOnce({ base64: raw, mimeType: "image/png", filename: "neon.png" });

    const result = await viewAssetImage(assetId);
    const image = result.content.find((c) => c.type === "image") as { data: string };
    expect(image.data).toBe(raw);
  });

  it("mentions the background in the text summary when set", async () => {
    const assetId = register("neon.png");
    mockedGetOutputImage.mockResolvedValueOnce({
      base64: await transparentPng(),
      mimeType: "image/png",
      filename: "neon.png",
    });

    const result = await viewAssetImage(assetId, "dark");
    const text = result.content.find((c) => c.type === "text") as { text: string };
    expect(text.text).toContain("dark");
  });
});
