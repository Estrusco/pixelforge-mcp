import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOutputImage = vi.fn();
vi.mock("../../services/image-management.js", () => ({
  getOutputImage: (...a: unknown[]) => getOutputImage(...a),
}));

const resolveOutputDir = vi.fn();
vi.mock("../../services/output-dir.js", () => ({
  resolveOutputDir: (...a: unknown[]) => resolveOutputDir(...a),
}));

const registryGet = vi.fn();
vi.mock("../../services/asset-registry.js", () => ({
  AssetRegistry: { get: (...a: unknown[]) => registryGet(...a) },
}));

import { loadImageSource, resolveSaveDir, resolveWritableOutputPath } from "../../sprite/image-io.js";

const scratchRoot = mkdtempSync(join(tmpdir(), "pixelforge-image-io-"));

afterAll(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

beforeEach(() => {
  getOutputImage.mockReset();
  resolveOutputDir.mockReset();
  registryGet.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadImageSource — asset_id / path exclusivity", () => {
  it("rejects when neither asset_id nor path is given", async () => {
    await expect(loadImageSource({}, "image")).rejects.toThrow(/exactly one/);
  });

  it("rejects when both asset_id and path are given", async () => {
    await expect(
      loadImageSource({ assetId: "a_1", path: "/x.png" }, "image"),
    ).rejects.toThrow(/exactly one/);
  });
});

describe("loadImageSource — absolute path", () => {
  it("reads directly from disk, never touching resolveOutputDir", async () => {
    const file = join(scratchRoot, "abs.png");
    writeFileSync(file, Buffer.from("fake-png-bytes"));

    const loaded = await loadImageSource({ path: file }, "image");
    expect(loaded.bytes.toString()).toBe("fake-png-bytes");
    expect(resolveOutputDir).not.toHaveBeenCalled();
  });

  it("reports a clear error for a missing absolute file", async () => {
    await expect(
      loadImageSource({ path: join(scratchRoot, "missing.png") }, "image"),
    ).rejects.toThrow(/not found or unreadable/);
  });
});

describe("loadImageSource — relative path, output dir resolvable", () => {
  it("reads from the resolved output dir and enforces containment", async () => {
    resolveOutputDir.mockResolvedValue(scratchRoot);
    const file = join(scratchRoot, "rel.png");
    writeFileSync(file, Buffer.from("rel-bytes"));

    const loaded = await loadImageSource({ path: "rel.png" }, "image");
    expect(loaded.bytes.toString()).toBe("rel-bytes");
    expect(loaded.label).toBe(resolve(scratchRoot, "rel.png"));
    expect(getOutputImage).not.toHaveBeenCalled();
  });

  it("rejects a relative path that escapes the output dir", async () => {
    resolveOutputDir.mockResolvedValue(scratchRoot);
    await expect(
      loadImageSource({ path: "../escape.png" }, "image"),
    ).rejects.toThrow(/must stay within/);
    expect(getOutputImage).not.toHaveBeenCalled();
  });
});

describe("loadImageSource — relative path, no local output dir knowable", () => {
  it("falls back to HTTP /view instead of throwing (COMFYUI_PATH unset, no argv override)", async () => {
    resolveOutputDir.mockRejectedValue(new Error("COMFYUI_PATH is not configured."));
    getOutputImage.mockResolvedValue({
      base64: Buffer.from("http-bytes").toString("base64"),
      mimeType: "image/png",
      filename: "shot_00001_.png",
    });

    const loaded = await loadImageSource({ path: "shot_00001_.png" }, "image");
    expect(loaded.bytes.toString()).toBe("http-bytes");
    expect(getOutputImage).toHaveBeenCalledWith("shot_00001_.png", "output", "");
  });

  it("splits a nested relative path into filename + subfolder for the HTTP fetch", async () => {
    resolveOutputDir.mockRejectedValue(new Error("COMFYUI_PATH is not configured."));
    getOutputImage.mockResolvedValue({
      base64: Buffer.from("nested-bytes").toString("base64"),
      mimeType: "image/png",
      filename: "shot.png",
    });

    await loadImageSource({ path: "batch1/shot.png" }, "image");
    expect(getOutputImage).toHaveBeenCalledWith("shot.png", "output", "batch1");
  });

  it("wraps an HTTP fetch failure in a ValidationError with the original path", async () => {
    resolveOutputDir.mockRejectedValue(new Error("COMFYUI_PATH is not configured."));
    getOutputImage.mockRejectedValue(new Error("ComfyUI /view returned 404"));

    await expect(loadImageSource({ path: "gone.png" }, "image")).rejects.toThrow(
      /gone\.png/,
    );
  });
});

describe("loadImageSource — asset_id", () => {
  it("fetches via getOutputImage using the registered record's type/subfolder", async () => {
    registryGet.mockReturnValue({
      assetId: "a_1",
      filename: "sheet.png",
      subfolder: "sub",
      type: "input",
    });
    getOutputImage.mockResolvedValue({
      base64: Buffer.from("asset-bytes").toString("base64"),
      mimeType: "image/png",
      filename: "sheet.png",
    });

    const loaded = await loadImageSource({ assetId: "a_1" }, "image");
    expect(loaded.bytes.toString()).toBe("asset-bytes");
    expect(getOutputImage).toHaveBeenCalledWith("sheet.png", "input", "sub");
  });

  it("rejects an unknown asset id without calling resolveOutputDir", async () => {
    registryGet.mockReturnValue(undefined);
    await expect(loadImageSource({ assetId: "a_missing" }, "image")).rejects.toThrow(
      /no asset found/,
    );
    expect(resolveOutputDir).not.toHaveBeenCalled();
  });
});

describe("resolveWritableOutputPath", () => {
  it("still requires resolveOutputDir to succeed (unchanged behavior)", async () => {
    resolveOutputDir.mockRejectedValue(new Error("COMFYUI_PATH is not configured."));
    await expect(resolveWritableOutputPath("out.png", "out_path")).rejects.toThrow(
      /COMFYUI_PATH/,
    );
  });
});

describe("resolveSaveDir", () => {
  it("creates the directory and resolves it without consulting resolveOutputDir", async () => {
    const dir = join(scratchRoot, "arbitrary", "nested", "save-dir");
    const resolved = await resolveSaveDir(dir, "save_dir");
    expect(resolved).toBe(resolve(dir));
    expect(resolveOutputDir).not.toHaveBeenCalled();

    // Directory actually exists and is writable.
    const marker = join(resolved, "marker.txt");
    writeFileSync(marker, "ok");
    expect(readFileSync(marker, "utf-8")).toBe("ok");
  });

  it("rejects an empty save_dir", async () => {
    await expect(resolveSaveDir("   ", "save_dir")).rejects.toThrow(/non-empty/);
  });
});
