import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AssetRegistry } from "../../services/asset-registry.js";

const uploadImageHttp = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  uploadImageHttp: (...a: unknown[]) => uploadImageHttp(...a),
}));

const resolveOutputDir = vi.fn();
vi.mock("../../services/output-dir.js", () => ({
  resolveOutputDir: (...a: unknown[]) => resolveOutputDir(...a),
}));

const getOutputImage = vi.fn();
vi.mock("../../services/image-management.js", () => ({
  getOutputImage: (...a: unknown[]) => getOutputImage(...a),
}));

type ToolResult = { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function fakeServer(): { server: McpServer; tools: Map<string, ToolHandler> } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

interface ToolBody {
  error?: string;
  width?: number;
  height?: number;
  out_path?: string;
  save_path?: string;
  asset_id?: string;
  asset_registration_error?: string;
  note?: string;
}

function parse(result: ToolResult): ToolBody {
  return JSON.parse(result.content[0].text ?? "{}");
}

async function getHandler(): Promise<ToolHandler> {
  const { registerPixelateImageTool } = await import("../../sprite/tools/pixelate-image.js");
  const { server, tools } = fakeServer();
  registerPixelateImageTool(server);
  const handler = tools.get("pixelate_image");
  if (!handler) throw new Error("pixelate_image was not registered");
  return handler;
}

const scratchRoot = mkdtempSync(join(tmpdir(), "pixelforge-pixelate-"));
let sourcePath: string;

const BASE_ARGS = {
  target_width: 2,
  target_height: 2,
  palette_mode: "custom" as const,
  custom_palette: ["#ff0000", "#0000ff"],
};

beforeEach(async () => {
  uploadImageHttp.mockReset();
  resolveOutputDir.mockReset();
  getOutputImage.mockReset();
  AssetRegistry.clear();

  sourcePath = join(scratchRoot, `src-${Math.random().toString(36).slice(2)}.png`);
  const png = await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 255 } },
  })
    .png()
    .toBuffer();
  await sharp(png).toFile(sourcePath);
});

afterAll(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

describe("pixelate_image — asset registration", () => {
  it("uploads the result and registers it as a local asset by default", async () => {
    uploadImageHttp.mockResolvedValue({ name: "pixelated_abc.png", subfolder: "", type: "input" });
    const handler = await getHandler();
    const body = parse(await handler({ ...BASE_ARGS, path: sourcePath }));

    expect(body.asset_id).toBeDefined();
    expect(body.asset_registration_error).toBeUndefined();
    expect(uploadImageHttp).toHaveBeenCalledTimes(1);
    expect(uploadImageHttp.mock.calls[0][2]).toBe("image/png");

    const record = AssetRegistry.get(body.asset_id!);
    expect(record?.filename).toBe("pixelated_abc.png");
    expect(record?.type).toBe("input");
  });

  it("degrades gracefully (no error result) when ComfyUI upload fails", async () => {
    uploadImageHttp.mockRejectedValue(new Error("ECONNREFUSED"));
    const handler = await getHandler();
    const result = await handler({ ...BASE_ARGS, path: sourcePath });
    const body = parse(result);

    expect(result.isError).toBeFalsy();
    expect(body.asset_id).toBeUndefined();
    expect(body.asset_registration_error).toContain("ECONNREFUSED");
    // The pixelated PNG is still returned inline despite the failed upload.
    expect(result.content[1].type).toBe("image");
  });
});

describe("pixelate_image — save_dir", () => {
  it("writes the pixelated PNG to an arbitrary directory, independent of COMFYUI_PATH", async () => {
    uploadImageHttp.mockResolvedValue({ name: "pixelated_abc.png", subfolder: "", type: "input" });
    const saveDir = join(scratchRoot, "save-here");
    const handler = await getHandler();
    const body = parse(await handler({ ...BASE_ARGS, path: sourcePath, save_dir: saveDir }));

    expect(body.save_path).toBeDefined();
    expect(body.save_path!.startsWith(saveDir)).toBe(true);
    expect(readFileSync(body.save_path!).length).toBeGreaterThan(0);
    // save_dir must not depend on resolveOutputDir/COMFYUI_PATH at all.
    expect(resolveOutputDir).not.toHaveBeenCalled();
  });
});

describe("pixelate_image — relative path without a local output dir", () => {
  it("fetches the source over HTTP instead of throwing on missing COMFYUI_PATH", async () => {
    resolveOutputDir.mockRejectedValue(new Error("COMFYUI_PATH is not configured."));
    const sourceBytes = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 255 } },
    })
      .png()
      .toBuffer();
    getOutputImage.mockResolvedValue({
      base64: sourceBytes.toString("base64"),
      mimeType: "image/png",
      filename: "remote-shot.png",
    });
    uploadImageHttp.mockResolvedValue({ name: "pixelated_abc.png", subfolder: "", type: "input" });

    const handler = await getHandler();
    const result = await handler({ ...BASE_ARGS, path: "remote-shot.png" });
    expect(result.isError).toBeFalsy();
    expect(getOutputImage).toHaveBeenCalledWith("remote-shot.png", "output", "");
  });
});
