import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SpriteJobRequest } from "../../sprite/types.js";

// ── Mock the seams generate_arcade_topdown_set MUST reuse ───────────────────
// Same leaf modules as generate_sprite / generate_animation_set: enqueue
// (sprite-job), the sprite layer's single poll loop (sprite-status),
// style->checkpoint mapping, and reference staging. Mocking the LEAF modules
// (not the barrel) proves the tool goes through the real
// src/sprite/comfyui/index.js re-exports that generate_sprite and
// generate_animation_set themselves use — there is no third generation path.

type FrameFate = "error" | "timeout" | "no-asset" | null;

const state = vi.hoisted(() => ({
  enqueued: [] as SpriteJobRequest[],
  jobs: new Map<string, SpriteJobRequest>(),
  stagedAssetIds: [] as string[],
  checkpointCalls: [] as Array<{ style: string; override?: string }>,
  nextPromptId: 0,
  fateFor: null as ((req: SpriteJobRequest) => FrameFate) | null,
}));

vi.mock("../../sprite/comfyui/sprite-job.js", () => ({
  enqueueSpriteJob: vi.fn(async (req: SpriteJobRequest) => {
    state.enqueued.push(req);
    const promptId = `prompt-${++state.nextPromptId}`;
    state.jobs.set(promptId, req);
    return {
      promptId,
      queueRemaining: 0,
      checkpoint: req.checkpoint ?? "mapped.safetensors",
      seed: req.seed,
      mode: req.referenceImage === undefined ? "txt2img" : "img2img",
    };
  }),
}));

vi.mock("../../sprite/comfyui/sprite-status.js", () => ({
  resolveSpriteJobStatus: vi.fn(),
  waitForSpriteJob: vi.fn(async (promptId: string) => {
    const req = state.jobs.get(promptId);
    const fate: FrameFate = req ? (state.fateFor?.(req) ?? null) : null;
    const base = { promptId, running: false, pending: false, done: true };
    if (fate === "timeout") return { ...base, running: true, done: false, timedOut: true };
    if (fate === "error") {
      return {
        ...base,
        timedOut: false,
        error: { node_id: "3", node_type: "KSampler", exception_message: "CUDA blew up" },
      };
    }
    if (fate === "no-asset") return { ...base, timedOut: false, assets: [] };
    return {
      ...base,
      timedOut: false,
      assets: [
        { assetId: `asset-of-${promptId}`, filename: `${promptId}.png`, subfolder: "pixelforge" },
      ],
    };
  }),
}));

vi.mock("../../sprite/comfyui/checkpoint-resolver.js", () => ({
  resolveSpriteCheckpoint: vi.fn(async (style: string, override?: string) => {
    state.checkpointCalls.push({ style, override });
    return { checkpoint: override ?? "mapped.safetensors" };
  }),
}));

vi.mock("../../sprite/reference-image.js", () => ({
  resolveReferenceImage: vi.fn(async (assetId?: string, path?: string) => {
    if (assetId === undefined && path === undefined) return undefined;
    if (assetId !== undefined) state.stagedAssetIds.push(assetId);
    const filename = assetId !== undefined ? `staged_${assetId}.png` : "staged_from_path.png";
    return { filename, source: assetId ?? path };
  }),
}));

// ── Fake McpServer that captures tool handlers ──────────────────────────────

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

interface FrameJson {
  status: "succeeded" | "failed" | "skipped";
}

interface StateJson {
  motion_state: string;
  frames: FrameJson[];
}

interface ToolBody {
  error?: string;
  message?: string;
  mode_kind?: "single_canonical_frame" | "animation_set";
  symmetric_rotation_safe?: boolean;
  viewpoint?: string;
  prompt_id?: string;
  mode?: "txt2img" | "img2img";
  seed?: number;
  checkpoint?: string;
  outcome?: "complete" | "partial" | "failed";
  states?: StateJson[];
}

function parse(result: ToolResult): ToolBody {
  return JSON.parse(result.content[0].text ?? "{}") as ToolBody;
}

async function getHandler(): Promise<ToolHandler> {
  const { registerGenerateArcadeTopdownSetTool } = await import(
    "../../sprite/tools/generate-arcade-topdown-set.js"
  );
  const { server, tools } = fakeServer();
  registerGenerateArcadeTopdownSetTool(server);
  const handler = tools.get("generate_arcade_topdown_set");
  if (!handler) throw new Error("generate_arcade_topdown_set was not registered");
  return handler;
}

const BASE_ARGS = {
  prompt: "a coiled green serpent",
  style: "16bit",
  width: 512,
  height: 512,
};

describe("generate_arcade_topdown_set", () => {
  beforeEach(() => {
    state.enqueued = [];
    state.jobs.clear();
    state.stagedAssetIds = [];
    state.checkpointCalls = [];
    state.nextPromptId = 0;
    state.fateFor = null;
  });

  // ── symmetric_rotation_safe: true (default) — single canonical frame ──────

  it("defaults to the single-canonical-frame mode and forces viewpoint topdown", async () => {
    const handler = await getHandler();
    const body = parse(await handler({ ...BASE_ARGS, seed: 42 }));

    expect(body.mode_kind).toBe("single_canonical_frame");
    expect(body.symmetric_rotation_safe).toBe(true);
    expect(body.viewpoint).toBe("topdown");
    expect(body.mode).toBe("txt2img");
    expect(body.seed).toBe(42);
    expect(state.enqueued).toHaveLength(1);
    expect(state.enqueued[0].viewpoint).toBe("topdown");
    expect(state.enqueued[0].seed).toBe(42);
  });

  it("rejects motion_states in the rotation-safe (single-frame) mode", async () => {
    const handler = await getHandler();
    const result = await handler({ ...BASE_ARGS, motion_states: ["slither"] });

    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain("motion_states");
    expect(state.enqueued).toHaveLength(0);
  });

  it("rejects frames_per_state in the rotation-safe (single-frame) mode", async () => {
    const handler = await getHandler();
    const result = await handler({ ...BASE_ARGS, frames_per_state: 4 });

    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain("frames_per_state");
    expect(state.enqueued).toHaveLength(0);
  });

  it("switches to img2img and validates denoise only when a reference image is given", async () => {
    const handler = await getHandler();

    const rejected = await handler({ ...BASE_ARGS, denoise: 0.4 });
    expect(rejected.isError).toBe(true);
    expect(parse(rejected).message).toContain("denoise");

    const body = parse(
      await handler({ ...BASE_ARGS, reference_asset_id: "base-image", denoise: 0.4 }),
    );
    expect(body.mode).toBe("img2img");
    expect(state.enqueued[0].referenceImage).toBe("staged_base-image.png");
    expect(state.enqueued[0].denoise).toBe(0.4);
  });

  // ── symmetric_rotation_safe: false — full animation set ────────────────────

  it("requires motion_states when symmetric_rotation_safe is false", async () => {
    const handler = await getHandler();
    const result = await handler({ ...BASE_ARGS, symmetric_rotation_safe: false });

    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain("motion_states is required");
    expect(state.enqueued).toHaveLength(0);
  });

  it("delegates to the animation-set engine with viewpoint forced to topdown", async () => {
    const handler = await getHandler();
    const body = parse(
      await handler({
        ...BASE_ARGS,
        symmetric_rotation_safe: false,
        motion_states: ["face_up", "face_right"],
        frames_per_state: 2,
        seed: 99,
      }),
    );

    expect(body.mode_kind).toBe("animation_set");
    expect(body.symmetric_rotation_safe).toBe(false);
    expect(body.viewpoint).toBe("topdown");
    expect(body.outcome).toBe("complete");
    expect(body.states?.map((s) => s.motion_state)).toEqual(["face_up", "face_right"]);
    expect(state.enqueued).toHaveLength(4);
    expect(state.enqueued.every((r) => r.viewpoint === "topdown")).toBe(true);
    expect(state.enqueued.every((r) => r.seed === 99)).toBe(true);
  });

  it("reports partial failure from the animation-set path without throwing", async () => {
    state.fateFor = (req) => (req.denoise !== undefined ? "error" : null);

    const handler = await getHandler();
    const result = await handler({
      ...BASE_ARGS,
      symmetric_rotation_safe: false,
      motion_states: ["face_up"],
      frames_per_state: 3,
    });

    expect(result.isError).toBeUndefined();
    const body = parse(result);
    expect(body.outcome).toBe("partial");
    expect(body.states?.[0].frames.map((f) => f.status)).toEqual([
      "succeeded",
      "failed",
      "skipped",
    ]);
  });
});
