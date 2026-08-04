import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AssetRegistry } from "../../services/asset-registry.js";

// enqueueWorkflow/viewAssetImage are ComfyUI-talking seams the regenerate
// guard test never reaches (it must reject BEFORE either is called), but
// registerAssetTools() imports them at module load time.
const enqueueWorkflow = vi.fn();
vi.mock("../../services/workflow-executor.js", () => ({
  enqueueWorkflow: (...a: unknown[]) => enqueueWorkflow(...a),
}));
vi.mock("../../services/view-image.js", () => ({
  viewAssetImage: vi.fn(),
}));

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
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

function parse(result: ToolResult): { error?: string; message?: string } {
  return JSON.parse(result.content[0].text ?? "{}");
}

async function getRegenerateHandler(): Promise<ToolHandler> {
  const { registerAssetTools } = await import("../../tools/assets.js");
  const { server, tools } = fakeServer();
  registerAssetTools(server);
  const handler = tools.get("regenerate");
  if (!handler) throw new Error("regenerate was not registered");
  return handler;
}

async function getAssetMetadataHandler(): Promise<ToolHandler> {
  const { registerAssetTools } = await import("../../tools/assets.js");
  const { server, tools } = fakeServer();
  registerAssetTools(server);
  const handler = tools.get("get_asset_metadata");
  if (!handler) throw new Error("get_asset_metadata was not registered");
  return handler;
}

const scratchRoot = mkdtempSync(join(tmpdir(), "pixelforge-asset-metadata-"));

describe("regenerate", () => {
  beforeEach(() => {
    AssetRegistry.clear();
    enqueueWorkflow.mockReset();
  });

  it("rejects a locally-registered asset instead of enqueueing an empty workflow", async () => {
    const record = AssetRegistry.registerLocal({ filename: "pixelated_abc123.png" });
    const handler = await getRegenerateHandler();
    const result = await handler({ asset_id: record.assetId });

    expect(result.isError).toBe(true);
    const body = parse(result);
    expect(body.message).toContain("not a ComfyUI job");
    expect(enqueueWorkflow).not.toHaveBeenCalled();
  });

  it("reports a clear error for an unknown asset id", async () => {
    const handler = await getRegenerateHandler();
    const result = await handler({ asset_id: "a_doesnotexist" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No asset found");
    expect(enqueueWorkflow).not.toHaveBeenCalled();
  });

  it("still enqueues for a real job-backed asset", async () => {
    enqueueWorkflow.mockResolvedValue({ prompt_id: "p1", queue_remaining: 0 });
    const [record] = AssetRegistry.register({
      promptId: "p1",
      workflow: {
        "3": { class_type: "KSampler", inputs: { seed: 1, cfg: 7 } },
      },
      outputs: [
        {
          node_id: "9",
          images: [{ filename: "a.png", subfolder: "", type: "output", url: "u" }],
        },
      ],
    });
    const handler = await getRegenerateHandler();
    const result = await handler({ asset_id: record.assetId });
    expect(result.isError).toBeFalsy();
    expect(enqueueWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe("get_asset_metadata — save_dir", () => {
  beforeEach(() => {
    AssetRegistry.clear();
  });

  it("writes the workflow snapshot to an arbitrary directory and reports saved_to", async () => {
    const [record] = AssetRegistry.register({
      promptId: "p1",
      workflow: {
        "3": { class_type: "KSampler", inputs: { seed: 12345, cfg: 7 } },
      },
      outputs: [
        {
          node_id: "9",
          images: [{ filename: "ComfyUI_00001_.png", subfolder: "", type: "output", url: "u" }],
        },
      ],
    });
    const saveDir = join(scratchRoot, "unity-project");
    const handler = await getAssetMetadataHandler();
    const result = await handler({ asset_id: record.assetId, save_dir: saveDir });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text ?? "{}");
    expect(body.saved_to).toBeDefined();
    expect(body.saved_to.startsWith(saveDir)).toBe(true);
    expect(body.saved_to.endsWith("ComfyUI_00001_.workflow.json")).toBe(true);
    expect(existsSync(body.saved_to)).toBe(true);

    const written = JSON.parse(readFileSync(body.saved_to, "utf8"));
    expect(written["3"].inputs.seed).toBe(12345);
  });

  it("does not write a file when save_dir is omitted", async () => {
    const [record] = AssetRegistry.register({
      promptId: "p1",
      workflow: { "3": { class_type: "KSampler", inputs: { seed: 1 } } },
      outputs: [
        { node_id: "9", images: [{ filename: "a.png", subfolder: "", type: "output", url: "u" }] },
      ],
    });
    const handler = await getAssetMetadataHandler();
    const result = await handler({ asset_id: record.assetId });

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text ?? "{}");
    expect(body.saved_to).toBeUndefined();
    expect(body.workflow).toBeDefined();
  });

  it("rejects save_dir for a locally-registered asset with no real workflow", async () => {
    const record = AssetRegistry.registerLocal({ filename: "pixelated_abc123.png" });
    const handler = await getAssetMetadataHandler();
    const result = await handler({
      asset_id: record.assetId,
      save_dir: join(scratchRoot, "should-not-be-created"),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not a ComfyUI job");
  });
});
