import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AssetRegistry } from "../../services/asset-registry.js";

// enqueueWorkflow is a ComfyUI-talking seam the regenerate guard test never
// reaches (it must reject BEFORE it is called), but regenerateAction imports
// it at module load time.
const enqueueWorkflow = vi.fn();
vi.mock("../../services/workflow-executor.js", () => ({
  enqueueWorkflow: (...a: unknown[]) => enqueueWorkflow(...a),
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

/**
 * `regenerate` is no longer a standalone tool (0.50.0 slice 16 folded it into
 * `generate_image (action:"regenerate")`) — the dispatcher wiring is covered by
 * generate-image.test.ts's mocked `regenerateAction`. This exercises the REAL
 * function body: the AssetRegistry lookup, the local-asset guard, and the
 * enqueue call.
 */
async function callRegenerate(args: {
  asset_id: string;
  overrides?: Record<string, unknown>;
  disable_random_seed?: boolean;
}): Promise<ToolResult> {
  const { regenerateAction } = await import("../../tools/assets.js");
  try {
    return await regenerateAction(args);
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
  }
}

/**
 * `get_asset_metadata` is no longer a standalone tool either (folded into
 * `get_image (action:"asset_metadata")`) — its dispatch is covered by
 * image-assets.test.ts's mocked AssetRegistry. This exercises the REAL
 * `saveWorkflowSnapshot` path (fork-specific: pixelforge-mcp-owned, not
 * upstream's) against the real AssetRegistry and filesystem.
 */
async function getAssetMetadataHandler(): Promise<ToolHandler> {
  const { registerImageManagementTools } = await import("../../tools/image-management.js");
  const { server, tools } = fakeServer();
  registerImageManagementTools(server);
  const handler = tools.get("get_image");
  if (!handler) throw new Error("get_image was not registered");
  return (args) => handler({ ...args, action: "asset_metadata" });
}

const scratchRoot = mkdtempSync(join(tmpdir(), "pixelforge-asset-metadata-"));

describe("regenerate", () => {
  beforeEach(() => {
    AssetRegistry.clear();
    enqueueWorkflow.mockReset();
  });

  it("rejects a locally-registered asset instead of enqueueing an empty workflow", async () => {
    const record = AssetRegistry.registerLocal({ filename: "pixelated_abc123.png" });
    const result = await callRegenerate({ asset_id: record.assetId });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not a ComfyUI job");
    expect(enqueueWorkflow).not.toHaveBeenCalled();
  });

  it("reports a clear error for an unknown asset id", async () => {
    const result = await callRegenerate({ asset_id: "a_doesnotexist" });
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
    const result = await callRegenerate({ asset_id: record.assetId });
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
