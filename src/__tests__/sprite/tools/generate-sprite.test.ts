import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SpriteJobRequest, SpriteJobResult } from "../../../sprite/types.js";

const state = vi.hoisted(() => ({
  lastRequest: null as SpriteJobRequest | null,
  result: null as Partial<SpriteJobResult> | null,
  throws: false,
}));

vi.mock("../../../sprite/comfyui/sprite-job.js", () => ({
  enqueueSpriteJob: vi.fn(async (req: SpriteJobRequest): Promise<SpriteJobResult> => {
    if (state.throws) throw new Error("queue refused the prompt");
    state.lastRequest = req;
    return {
      promptId: "prompt-1",
      queueRemaining: 0,
      checkpoint: req.checkpoint ?? "mapped.safetensors",
      seed: req.seed,
      mode: req.referenceImage === undefined ? "txt2img" : "img2img",
      ...state.result,
    };
  }),
}));

vi.mock("../../../sprite/reference-image.js", () => ({
  resolveReferenceImage: vi.fn(async () => undefined),
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

interface ToolBody {
  error?: string;
  message?: string;
  checkpoint?: string;
  checkpoint_warning?: string;
  downloaded_models?: unknown[];
  seed?: number;
}

function parse(result: ToolResult): ToolBody {
  return JSON.parse(result.content[0].text ?? "{}");
}

async function getHandler(): Promise<ToolHandler> {
  const { registerGenerateSpriteTool } = await import("../../../sprite/tools/generate-sprite.js");
  const { server, tools } = fakeServer();
  registerGenerateSpriteTool(server);
  const handler = tools.get("generate_sprite");
  if (!handler) throw new Error("generate_sprite was not registered");
  return handler;
}

const BASE_ARGS = {
  prompt: "a coiled green serpent",
  style: "32bit",
  viewpoint: "side",
  width: 512,
  height: 512,
};

describe("generate_sprite — sampling overrides & auto_download_missing wiring", () => {
  beforeEach(() => {
    state.lastRequest = null;
    state.result = null;
    state.throws = false;
  });

  it("forwards steps/cfg/sampler/scheduler as *Override fields on the job request", async () => {
    const handler = await getHandler();
    await handler({ ...BASE_ARGS, steps: 4, cfg: 1.0, sampler: "euler", scheduler: "simple" });

    expect(state.lastRequest?.stepsOverride).toBe(4);
    expect(state.lastRequest?.cfgOverride).toBe(1.0);
    expect(state.lastRequest?.samplerOverride).toBe("euler");
    expect(state.lastRequest?.schedulerOverride).toBe("simple");
  });

  it("leaves the *Override fields undefined when the args are omitted", async () => {
    const handler = await getHandler();
    await handler({ ...BASE_ARGS });

    expect(state.lastRequest?.stepsOverride).toBeUndefined();
    expect(state.lastRequest?.cfgOverride).toBeUndefined();
    expect(state.lastRequest?.samplerOverride).toBeUndefined();
    expect(state.lastRequest?.schedulerOverride).toBeUndefined();
  });

  it("forwards auto_download_missing, defaulting to unset", async () => {
    const handler = await getHandler();
    await handler({ ...BASE_ARGS, auto_download_missing: true });
    expect(state.lastRequest?.autoDownloadMissing).toBe(true);

    await handler({ ...BASE_ARGS });
    expect(state.lastRequest?.autoDownloadMissing).toBeUndefined();
  });

  it("surfaces checkpoint_warning and downloaded_models when the job reports them", async () => {
    state.result = {
      checkpointFamilyWarning: 'style "32bit" expects a sd15 checkpoint, but none is installed',
      downloadedModels: [
        { requested: "missing.safetensors", installed: "installed.safetensors", source: "huggingface", nodeType: "CheckpointLoaderSimple" },
      ],
    };
    const handler = await getHandler();
    const body = parse(await handler({ ...BASE_ARGS }));

    expect(body.checkpoint_warning).toContain("sd15");
    expect(body.downloaded_models).toHaveLength(1);
  });

  it("omits checkpoint_warning/downloaded_models when the job reports neither", async () => {
    const handler = await getHandler();
    const body = parse(await handler({ ...BASE_ARGS }));

    expect(body.checkpoint_warning).toBeUndefined();
    expect(body.downloaded_models).toBeUndefined();
  });
});
