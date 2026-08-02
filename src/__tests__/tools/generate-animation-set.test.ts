import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONTROLNET_POSE_REJECTION_MESSAGE } from "../../sprite/types.js";
import type { SpriteJobRequest } from "../../sprite/types.js";

// ── Mock the seams generate_animation_set MUST reuse ────────────────────────
// enqueue (sprite-job), the sprite layer's single poll loop (sprite-status),
// style->checkpoint mapping, and reference staging. Mocking the LEAF modules
// (not the barrel) proves the tool goes through the real
// src/sprite/comfyui/index.js re-exports, and keeps the test free of a live
// ComfyUI.

type FrameFate = "error" | "timeout" | "no-asset" | null;

const state = vi.hoisted(() => ({
  enqueued: [] as SpriteJobRequest[],
  jobs: new Map<string, SpriteJobRequest>(),
  stagedAssetIds: [] as string[],
  checkpointCalls: [] as Array<{ style: string; override?: string }>,
  nextPromptId: 0,
  inFlight: 0,
  maxInFlight: 0,
  /** Decide a frame's fate from the request that produced it. */
  fateFor: null as ((req: SpriteJobRequest) => FrameFate) | null,
  /** Asset ids whose staging blows up (breaks the chain without failing the frame). */
  stagingFailsFor: new Set<string>(),
  enqueueThrowsFor: null as ((req: SpriteJobRequest) => boolean) | null,
  /** Attach a fake downloadedModels payload to the FIRST enqueued job only. */
  downloadOnFirstEnqueue: false,
}));

vi.mock("../../sprite/comfyui/sprite-job.js", () => ({
  enqueueSpriteJob: vi.fn(async (req: SpriteJobRequest) => {
    if (state.enqueueThrowsFor?.(req)) throw new Error("queue refused the prompt");
    const isFirst = state.enqueued.length === 0;
    state.enqueued.push(req);
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const promptId = `prompt-${++state.nextPromptId}`;
    state.jobs.set(promptId, req);
    return {
      promptId,
      queueRemaining: 0,
      checkpoint: req.checkpoint ?? "mapped.safetensors",
      seed: req.seed,
      mode: req.referenceImage === undefined ? "txt2img" : "img2img",
      downloadedModels:
        state.downloadOnFirstEnqueue && isFirst
          ? [
              {
                requested: "missing.safetensors",
                installed: "installed.safetensors",
                source: "huggingface" as const,
                nodeType: "CheckpointLoaderSimple",
              },
            ]
          : undefined,
    };
  }),
}));

vi.mock("../../sprite/comfyui/sprite-status.js", () => ({
  resolveSpriteJobStatus: vi.fn(),
  waitForSpriteJob: vi.fn(async (promptId: string) => {
    state.inFlight -= 1;
    const req = state.jobs.get(promptId);
    const fate: FrameFate = req ? (state.fateFor?.(req) ?? null) : null;
    const base = { promptId, running: false, pending: false, done: true };
    if (fate === "timeout") {
      return { ...base, running: true, done: false, timedOut: true };
    }
    if (fate === "error") {
      return {
        ...base,
        timedOut: false,
        error: { node_id: "3", node_type: "KSampler", exception_message: "CUDA blew up" },
      };
    }
    if (fate === "no-asset") {
      return { ...base, timedOut: false, assets: [] };
    }
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
    if (assetId !== undefined && state.stagingFailsFor.has(assetId)) {
      throw new Error("ComfyUI rejected the upload");
    }
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

/** The JSON body the tool serializes into its single text block. */
interface FrameJson {
  frame_index: number;
  status: "succeeded" | "failed" | "skipped";
  prompt_id?: string;
  asset_id?: string;
  seed?: number;
  mode?: "txt2img" | "img2img";
  error?: string;
  error_details?: { node_id: string; node_type: string; exception_message: string };
  reason?: string;
}

interface StateJson {
  motion_state: string;
  succeeded_frame_count: number;
  failed_frame_count: number;
  skipped_frame_count: number;
  chain_stopped_early: boolean;
  frames: FrameJson[];
}

/** Success and error bodies share one shape here; error responses fill `error`/`message`. */
interface ToolBody {
  error?: string;
  message?: string;
  outcome?: "complete" | "partial" | "failed";
  consistency_mode?: string;
  checkpoint?: string;
  seed?: number;
  base_image?: string;
  requested_frame_count?: number;
  succeeded_frame_count?: number;
  failed_frame_count?: number;
  skipped_frame_count?: number;
  downloaded_models?: Array<{ requested: string; installed: string; source: string; nodeType: string }>;
  states: StateJson[];
}

function parse(result: ToolResult): ToolBody {
  return JSON.parse(result.content[0].text ?? "{}") as ToolBody;
}

async function getHandler(): Promise<ToolHandler> {
  const { registerGenerateAnimationSetTool } = await import(
    "../../sprite/tools/generate-animation-set.js"
  );
  const { server, tools } = fakeServer();
  registerGenerateAnimationSetTool(server);
  const handler = tools.get("generate_animation_set");
  if (!handler) throw new Error("generate_animation_set was not registered");
  return handler;
}

const BASE_ARGS = {
  prompt: "a green pixel serpent",
  style: "16bit",
  viewpoint: "topdown",
  width: 512,
  height: 512,
};

describe("generate_animation_set", () => {
  beforeEach(() => {
    state.enqueued = [];
    state.jobs.clear();
    state.stagedAssetIds = [];
    state.checkpointCalls = [];
    state.nextPromptId = 0;
    state.inFlight = 0;
    state.maxInFlight = 0;
    state.fateFor = null;
    state.stagingFailsFor.clear();
    state.enqueueThrowsFor = null;
    state.downloadOnFirstEnqueue = false;
  });

  // ── LOCKED DECISION: controlnet_pose is rejected, NEVER downgraded ────────

  it('rejects consistency_mode "controlnet_pose" with the canonical message', async () => {
    const handler = await getHandler();
    const result = await handler({
      ...BASE_ARGS,
      motion_states: ["slither"],
      consistency_mode: "controlnet_pose",
    });

    expect(result.isError).toBe(true);
    const body = parse(result);
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toBe(CONTROLNET_POSE_REJECTION_MESSAGE);
  });

  it('does NOT silently downgrade "controlnet_pose" to img2img — nothing is generated', async () => {
    const handler = await getHandler();
    const result = await handler({
      ...BASE_ARGS,
      motion_states: ["slither", "coil"],
      frames_per_state: 4,
      consistency_mode: "controlnet_pose",
    });

    expect(result.isError).toBe(true);
    // The proof it was not downgraded: zero jobs, zero checkpoint lookups, and
    // no reference staging happened. The rejection has no side effects at all.
    expect(state.enqueued).toHaveLength(0);
    expect(state.checkpointCalls).toHaveLength(0);
    expect(state.stagedAssetIds).toHaveLength(0);
    expect(parse(result).outcome).toBeUndefined();
  });

  it('defaults to "img2img_low_denoise" when consistency_mode is omitted', async () => {
    const handler = await getHandler();
    const body = parse(await handler({ ...BASE_ARGS, motion_states: ["slither"] }));
    expect(body.consistency_mode).toBe("img2img_low_denoise");
    expect(body.outcome).toBe("complete");
  });

  // ── Free-form motion states (LOCKED: never a fixed humanoid vocabulary) ───

  it("passes free-form motion states through unnarrowed", async () => {
    const handler = await getHandler();
    const motionStates = ["slither", "coil_strike", "eat", "shed skin", "flap"];
    const body = parse(
      await handler({ ...BASE_ARGS, motion_states: motionStates, frames_per_state: 1 }),
    );

    expect(body.states.map((s) => s.motion_state)).toEqual(motionStates);
    // Each state's own name reaches the prompt — no walk/attack/jump mapping.
    expect(state.enqueued.map((r) => r.prompt)).toEqual([
      "a green pixel serpent, slither animation pose",
      "a green pixel serpent, coil strike animation pose",
      "a green pixel serpent, eat animation pose",
      "a green pixel serpent, shed skin animation pose",
      "a green pixel serpent, flap animation pose",
    ]);
  });

  it("rejects duplicate motion states", async () => {
    const handler = await getHandler();
    const result = await handler({ ...BASE_ARGS, motion_states: ["slither", "slither"] });
    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain("duplicate");
    expect(state.enqueued).toHaveLength(0);
  });

  it("rejects a set above the total-frame cap", async () => {
    const handler = await getHandler();
    const result = await handler({
      ...BASE_ARGS,
      motion_states: ["a", "b", "c", "d", "e"],
      frames_per_state: 16,
    });
    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain("80 frames");
    expect(state.enqueued).toHaveLength(0);
  });

  // ── Chaining, seed policy, sequencing ────────────────────────────────────

  it("chains each frame from the previous frame's staged output at low denoise", async () => {
    const handler = await getHandler();
    const body = parse(
      await handler({
        ...BASE_ARGS,
        motion_states: ["slither"],
        frames_per_state: 3,
        seed: 12345,
        denoise: 0.3,
      }),
    );

    expect(body.outcome).toBe("complete");
    expect(state.enqueued).toHaveLength(3);

    // Frame 0: txt2img, no reference, no denoise (meaningless without one).
    expect(state.enqueued[0].referenceImage).toBeUndefined();
    expect(state.enqueued[0].denoise).toBeUndefined();

    // Frames 1..N: img2img from the ACTUAL resolved output of the frame before.
    expect(state.enqueued[1].referenceImage).toBe("staged_asset-of-prompt-1.png");
    expect(state.enqueued[2].referenceImage).toBe("staged_asset-of-prompt-2.png");
    expect(state.enqueued[1].denoise).toBe(0.3);
    expect(state.enqueued[2].denoise).toBe(0.3);

    // Staging was driven by the previous frame's asset id, and the LAST frame
    // is never staged (nothing left to chain into).
    expect(state.stagedAssetIds).toEqual(["asset-of-prompt-1", "asset-of-prompt-2"]);

    expect(body.states[0].frames.map((f) => f.mode)).toEqual([
      "txt2img",
      "img2img",
      "img2img",
    ]);
  });

  it("uses the SAME seed for every frame and echoes it back", async () => {
    const handler = await getHandler();
    const body = parse(
      await handler({
        ...BASE_ARGS,
        motion_states: ["slither", "coil"],
        frames_per_state: 3,
        seed: 777,
      }),
    );

    expect(state.enqueued).toHaveLength(6);
    expect(state.enqueued.every((r) => r.seed === 777)).toBe(true);
    expect(body.seed).toBe(777);
    for (const stateResult of body.states) {
      for (const frame of stateResult.frames) expect(frame.seed).toBe(777);
    }
  });

  it("resolves the checkpoint once and reuses it for the whole set", async () => {
    const handler = await getHandler();
    const body = parse(
      await handler({ ...BASE_ARGS, motion_states: ["slither", "coil"], frames_per_state: 2 }),
    );

    expect(state.checkpointCalls).toEqual([{ style: "16bit", override: undefined }]);
    expect(state.enqueued.every((r) => r.checkpoint === "mapped.safetensors")).toBe(true);
    expect(body.checkpoint).toBe("mapped.safetensors");
  });

  it("runs strictly sequentially — never more than one job in flight", async () => {
    const handler = await getHandler();
    await handler({ ...BASE_ARGS, motion_states: ["slither", "coil", "eat"], frames_per_state: 3 });
    expect(state.enqueued).toHaveLength(9);
    expect(state.maxInFlight).toBe(1);
  });

  it("seeds only the first frame of the first state from the caller's base image", async () => {
    const handler = await getHandler();
    const body = parse(
      await handler({
        ...BASE_ARGS,
        motion_states: ["slither", "coil"],
        frames_per_state: 2,
        reference_asset_id: "base-image",
      }),
    );

    // State 0 frame 0 => img2img from the base image.
    expect(state.enqueued[0].referenceImage).toBe("staged_base-image.png");
    // State 1 frame 0 => back to txt2img; a base image applies exactly once.
    expect(state.enqueued[2].referenceImage).toBeUndefined();
    expect(body.states[1].frames[0].mode).toBe("txt2img");
    expect(body.base_image).toBe("base-image");
  });

  // ── Partial failure ──────────────────────────────────────────────────────

  it("records a failed frame, skips the rest of its chain, and still runs later states", async () => {
    state.fateFor = (req) => (req.prompt.includes("slither") && req.denoise !== undefined ? "error" : null);

    const handler = await getHandler();
    const result = await handler({
      ...BASE_ARGS,
      motion_states: ["slither", "coil"],
      frames_per_state: 3,
      seed: 42,
    });

    // Partial failure is REPORTED, never thrown.
    expect(result.isError).toBeUndefined();
    const body = parse(result);
    expect(body.outcome).toBe("partial");

    const slither = body.states[0];
    expect(slither.frames.map((f) => f.status)).toEqual(["succeeded", "failed", "skipped"]);
    expect(slither.chain_stopped_early).toBe(true);
    expect(slither.succeeded_frame_count).toBe(1);
    expect(slither.failed_frame_count).toBe(1);
    expect(slither.skipped_frame_count).toBe(1);
    expect(slither.frames[1].error).toContain("CUDA blew up");
    expect(slither.frames[1].error_details.node_type).toBe("KSampler");
    // The skip reason names the frame that broke the chain.
    expect(slither.frames[2].reason).toContain('frame 1 of "slither"');

    // The next motion state still ran, in full.
    const coil = body.states[1];
    expect(coil.frames.map((f) => f.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(coil.chain_stopped_early).toBe(false);

    // 2 attempted for "slither" (frame 2 never enqueued) + 3 for "coil".
    expect(state.enqueued).toHaveLength(5);
    expect(body.succeeded_frame_count).toBe(4);
    expect(body.failed_frame_count).toBe(1);
    expect(body.skipped_frame_count).toBe(1);
    expect(body.requested_frame_count).toBe(6);
  });

  it("treats a wait timeout as a frame failure, not a thrown tool error", async () => {
    state.fateFor = () => "timeout";

    const handler = await getHandler();
    const result = await handler({
      ...BASE_ARGS,
      motion_states: ["slither"],
      frames_per_state: 2,
    });

    expect(result.isError).toBeUndefined();
    const body = parse(result);
    expect(body.outcome).toBe("failed");
    expect(body.states[0].frames[0].status).toBe("failed");
    expect(body.states[0].frames[0].error).toContain("timed out");
    expect(body.states[0].frames[0].prompt_id).toBe("prompt-1");
    expect(body.states[0].frames[1].status).toBe("skipped");
  });

  it("records an enqueue failure as a frame failure with no prompt_id", async () => {
    state.enqueueThrowsFor = (req) => req.prompt.includes("coil");

    const handler = await getHandler();
    const body = parse(
      await handler({
        ...BASE_ARGS,
        motion_states: ["slither", "coil"],
        frames_per_state: 2,
      }),
    );

    expect(body.outcome).toBe("partial");
    expect(body.states[1].frames[0].status).toBe("failed");
    expect(body.states[1].frames[0].prompt_id).toBeUndefined();
    expect(body.states[1].frames[0].error).toContain("enqueue failed");
    expect(body.states[1].frames[1].status).toBe("skipped");
  });

  it("keeps a frame that generated an image when only its staging breaks the chain", async () => {
    state.stagingFailsFor.add("asset-of-prompt-1");

    const handler = await getHandler();
    const body = parse(
      await handler({ ...BASE_ARGS, motion_states: ["slither"], frames_per_state: 3 }),
    );

    // The frame succeeded — its pixels exist — but nothing could chain from it.
    expect(body.states[0].frames.map((f) => f.status)).toEqual([
      "succeeded",
      "skipped",
      "skipped",
    ]);
    expect(body.states[0].frames[1].reason).toContain("could not be staged");
    expect(body.outcome).toBe("partial");
  });

  it("reports a job that finished without registering an asset as a failed frame", async () => {
    state.fateFor = () => "no-asset";

    const handler = await getHandler();
    const body = parse(
      await handler({ ...BASE_ARGS, motion_states: ["slither"], frames_per_state: 1 }),
    );

    expect(body.outcome).toBe("failed");
    expect(body.states[0].frames[0].error).toContain("no image asset");
  });

  // ── Result invariants ────────────────────────────────────────────────────

  it("always returns framesPerState frames per state, with counts that sum", async () => {
    state.fateFor = (req) => (req.referenceImage === undefined ? "error" : null);

    const handler = await getHandler();
    const body = parse(
      await handler({
        ...BASE_ARGS,
        motion_states: ["slither", "coil", "eat"],
        frames_per_state: 4,
      }),
    );

    expect(body.outcome).toBe("failed");
    for (const s of body.states) {
      expect(s.frames).toHaveLength(4);
      expect(s.succeeded_frame_count + s.failed_frame_count + s.skipped_frame_count).toBe(4);
      expect(s.chain_stopped_early).toBe(s.skipped_frame_count > 0);
    }
    expect(body.requested_frame_count).toBe(12);
    expect(
      body.succeeded_frame_count + body.failed_frame_count + body.skipped_frame_count,
    ).toBe(12);
  });

  // ── auto_download_missing propagation (pixelforge-mcp-7dc.2) ─────────────

  it("forwards auto_download_missing to every frame's enqueueSpriteJob request", async () => {
    const handler = await getHandler();
    await handler({
      ...BASE_ARGS,
      motion_states: ["slither", "coil"],
      frames_per_state: 2,
      auto_download_missing: true,
    });

    expect(state.enqueued).toHaveLength(4);
    for (const req of state.enqueued) {
      expect(req.autoDownloadMissing).toBe(true);
    }
  });

  it("defaults auto_download_missing to unset (never silently on)", async () => {
    const handler = await getHandler();
    await handler({ ...BASE_ARGS, motion_states: ["slither"], frames_per_state: 1 });

    expect(state.enqueued[0].autoDownloadMissing).toBeUndefined();
  });

  it("surfaces downloaded_models in the result when a frame job reports one", async () => {
    state.downloadOnFirstEnqueue = true;
    const handler = await getHandler();
    const body = parse(
      await handler({
        ...BASE_ARGS,
        motion_states: ["slither"],
        frames_per_state: 1,
        auto_download_missing: true,
      }),
    );

    expect(body.downloaded_models).toEqual([
      {
        requested: "missing.safetensors",
        installed: "installed.safetensors",
        source: "huggingface",
        nodeType: "CheckpointLoaderSimple",
      },
    ]);
  });
});
