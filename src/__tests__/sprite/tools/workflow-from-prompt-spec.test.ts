import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SpecWorkflowRequest, SpecWorkflowResult } from "../../../sprite/spec/spec-job.js";

const state = vi.hoisted(() => ({
  lastRequest: null as SpecWorkflowRequest | null,
  result: null as Partial<SpecWorkflowResult> | null,
  throws: false,
}));

vi.mock("../../../sprite/spec/spec-job.js", () => ({
  buildAndSaveSpecWorkflow: vi.fn(async (req: SpecWorkflowRequest): Promise<SpecWorkflowResult> => {
    if (state.throws) throw new Error("workflow failed validation before save");
    state.lastRequest = req;
    return {
      filename: req.filename,
      checkpoint: req.spec.checkpointCandidates[0],
      vae: req.spec.vae,
      loras: req.spec.loras.map((l) => l.name),
      saveMessage: `Workflow saved as "${req.filename}" in the ComfyUI user library.`,
      ...state.result,
    };
  }),
}));

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile: readFileMock }));

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
  filename?: string;
  checkpoint?: string;
  vae?: string;
  loras?: string[];
  downloaded_models?: unknown[];
}

function parse(result: ToolResult): ToolBody {
  return JSON.parse(result.content[0].text ?? "{}");
}

async function getHandler(): Promise<ToolHandler> {
  const { registerWorkflowFromPromptSpecTool } = await import(
    "../../../sprite/tools/workflow-from-prompt-spec.js"
  );
  const { server, tools } = fakeServer();
  registerWorkflowFromPromptSpecTool(server);
  const handler = tools.get("workflow_from_prompt_spec");
  if (!handler) throw new Error("workflow_from_prompt_spec was not registered");
  return handler;
}

const MINIMAL_SPEC_TEXT = `\
[CHECKPOINT / MODEL]
Checkpoint: pixelArtDiffusionXL_v2.safetensors (o sd_xl_base_1.0.safetensors)

[SAMPLER & SCHEDULER SETTINGS]
Sampler: euler
Scheduler: normal
Steps: 20
CFG Scale: 8.0
Resolution: 512x512

[POSITIVE PROMPT]
a red fox
`;

describe("workflow_from_prompt_spec — argument validation", () => {
  beforeEach(() => {
    state.lastRequest = null;
    state.result = null;
    state.throws = false;
    readFileMock.mockReset();
  });

  it("rejects when neither spec_path nor spec_text is given", async () => {
    const handler = await getHandler();
    const result = await handler({});
    expect(result.isError).toBe(true);
  });

  it("rejects when both spec_path and spec_text are given", async () => {
    const handler = await getHandler();
    const result = await handler({ spec_path: "C:/x/spec.txt", spec_text: MINIMAL_SPEC_TEXT });
    expect(result.isError).toBe(true);
  });
});

describe("workflow_from_prompt_spec — spec_text path", () => {
  beforeEach(() => {
    state.lastRequest = null;
    state.result = null;
    state.throws = false;
    readFileMock.mockReset();
  });

  it("parses spec_text and defaults the filename to prompt_spec_workflow.json", async () => {
    const handler = await getHandler();
    const result = await handler({ spec_text: MINIMAL_SPEC_TEXT });

    expect(readFileMock).not.toHaveBeenCalled();
    expect(state.lastRequest?.filename).toBe("prompt_spec_workflow.json");
    expect(state.lastRequest?.spec.checkpointCandidates).toEqual([
      "pixelArtDiffusionXL_v2.safetensors",
      "sd_xl_base_1.0.safetensors",
    ]);

    const body = parse(result);
    expect(body.filename).toBe("prompt_spec_workflow.json");
    expect(body.checkpoint).toBe("pixelArtDiffusionXL_v2.safetensors");
  });

  it("forwards an explicit filename instead of the default", async () => {
    const handler = await getHandler();
    await handler({ spec_text: MINIMAL_SPEC_TEXT, filename: "custom_name.json" });
    expect(state.lastRequest?.filename).toBe("custom_name.json");
  });

  it("forwards auto_download_missing and lora_sources", async () => {
    const handler = await getHandler();
    await handler({
      spec_text: MINIMAL_SPEC_TEXT,
      auto_download_missing: true,
      lora_sources: [
        {
          lora_name: "pixel-art-xl-v1.safetensors",
          huggingface_repo: "nerijs/pixel-art-xl",
          huggingface_filename: "pixel-art-xl-v1.safetensors",
        },
      ],
    });

    expect(state.lastRequest?.autoDownloadMissing).toBe(true);
    expect(state.lastRequest?.loraSources).toEqual([
      {
        name: "pixel-art-xl-v1.safetensors",
        civitaiModelId: undefined,
        civitaiVersionId: undefined,
        huggingfaceRepo: "nerijs/pixel-art-xl",
        huggingfaceFilename: "pixel-art-xl-v1.safetensors",
      },
    ]);
  });

  it("surfaces a validation/save failure as an error result instead of throwing", async () => {
    state.throws = true;
    const handler = await getHandler();
    const result = await handler({ spec_text: MINIMAL_SPEC_TEXT });
    expect(result.isError).toBe(true);
  });

  it("surfaces a parse error (malformed spec) as an error result", async () => {
    const handler = await getHandler();
    const result = await handler({ spec_text: "not a valid spec at all" });
    expect(result.isError).toBe(true);
  });
});

describe("workflow_from_prompt_spec — spec_path path", () => {
  beforeEach(() => {
    state.lastRequest = null;
    state.result = null;
    state.throws = false;
    readFileMock.mockReset();
  });

  it("reads spec_path and derives the filename from its basename", async () => {
    readFileMock.mockResolvedValue(MINIMAL_SPEC_TEXT);
    const handler = await getHandler();
    const result = await handler({ spec_path: "C:/Users/estru/Downloads/promptesempio.txt" });

    expect(readFileMock).toHaveBeenCalledWith("C:/Users/estru/Downloads/promptesempio.txt", "utf-8");
    expect(state.lastRequest?.filename).toBe("promptesempio.json");
    const body = parse(result);
    expect(body.filename).toBe("promptesempio.json");
  });
});
