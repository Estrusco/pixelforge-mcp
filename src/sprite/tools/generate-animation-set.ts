import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError, errorToToolResult } from "../../utils/errors.js";
import { runAnimationSet } from "../animation-runner.js";
import {
  assertDenoiseRange,
  assertSpriteDimension,
  resolveSpriteSeed,
} from "../arg-validation.js";
import { resolveReferenceImage } from "../reference-image.js";
import {
  ANIMATION_CONSISTENCY_MODES,
  ANIMATION_DEFAULT_DENOISE,
  ANIMATION_DEFAULT_FRAMES_PER_STATE,
  ANIMATION_MAX_FRAMES_PER_STATE,
  ANIMATION_MAX_MOTION_STATES,
  ANIMATION_MAX_TOTAL_FRAMES,
  ANIMATION_MIN_FRAMES_PER_STATE,
  DEFAULT_CONSISTENCY_MODE,
  SPRITE_DIM_MAX,
  SPRITE_DIM_MIN,
  SPRITE_DIM_STEP,
  SPRITE_STYLES,
  SPRITE_VIEWPOINTS,
  assertImplementedConsistencyMode,
} from "../types.js";
import type {
  AnimationFrameResult,
  AnimationSetRequest,
  AnimationSetResult,
  ConsistencyMode,
  MotionState,
  Style,
  Viewpoint,
} from "../types.js";

// ---------------------------------------------------------------------------
// generate_animation_set — the MCP contract layer.
//
// This file owns ONLY: argument validation, seed resolution, base-image
// staging, and response formatting. The sequential frame-chaining engine lives
// in `../animation-runner.js`; workflow JSON, checkpoint mapping, queueing and
// polling all stay where they already are.
//
// LOCKED DECISION (CLAUDE.md): `consistency_mode: "controlnet_pose"` is
// advertised in the schema but NOT implemented, and is REJECTED here — never
// silently downgraded to img2img. The rejection runs FIRST, before any staging
// or generation, so a rejected call has no side effects. The narrowing itself
// is delegated to `assertImplementedConsistencyMode` in types.ts, which is the
// only sanctioned path from `ConsistencyMode` to the `ImplementedConsistencyMode`
// that `AnimationSetRequest` demands — there is no compile-legal way to reach
// the generation layer around it.
// ---------------------------------------------------------------------------

const generateAnimationSetSchema = {
  prompt: z
    .string()
    .describe(
      "Positive prompt describing the SUBJECT, shared by every frame (e.g. 'a green pixel " +
        "serpent'). The motion state is appended automatically per frame — do not put motion " +
        "into this prompt.",
    ),
  motion_states: z
    .array(z.string())
    .describe(
      "Motion states to generate, in order. FREE-FORM — describe what THIS creature does: a " +
        "snake needs ['slither','coil','eat'], a bird ['flap','glide']. There is no fixed " +
        `walk/attack/jump vocabulary. 1-${ANIMATION_MAX_MOTION_STATES} entries, no duplicates.`,
    ),
  style: z
    .enum(SPRITE_STYLES)
    .describe(
      `Rendering aesthetic. One of: ${SPRITE_STYLES.join(", ")}. ` +
        "This is the LOOK only — the camera angle is the separate 'viewpoint' parameter.",
    ),
  viewpoint: z
    .enum(SPRITE_VIEWPOINTS)
    .describe(
      `Camera angle, independent of style. One of: ${SPRITE_VIEWPOINTS.join(", ")}. ` +
        "'isometric' is a viewpoint, never a style.",
    ),
  width: z
    .number()
    .describe(
      `Diffusion canvas width in px (${SPRITE_DIM_MIN}-${SPRITE_DIM_MAX}, multiple of ${SPRITE_DIM_STEP}). ` +
        "Generate large, then downsample with pixelate_image.",
    ),
  height: z
    .number()
    .describe(
      `Diffusion canvas height in px (${SPRITE_DIM_MIN}-${SPRITE_DIM_MAX}, multiple of ${SPRITE_DIM_STEP}).`,
    ),
  frames_per_state: z
    .number()
    .optional()
    .describe(
      `Frames to generate for each motion state (${ANIMATION_MIN_FRAMES_PER_STATE}-` +
        `${ANIMATION_MAX_FRAMES_PER_STATE}, default ${ANIMATION_DEFAULT_FRAMES_PER_STATE}). ` +
        `motion_states x frames_per_state must not exceed ${ANIMATION_MAX_TOTAL_FRAMES}.`,
    ),
  negative_prompt: z
    .string()
    .optional()
    .describe("Extra negative prompt. Style/viewpoint-specific negatives are added automatically."),
  seed: z
    .number()
    .optional()
    .describe(
      "Sampling seed (non-negative integer). Omit to randomize. EVERY frame in the set uses this " +
        "exact seed — that is half of the consistency strategy — and it is always returned so " +
        "the whole set can be reproduced.",
    ),
  checkpoint: z
    .string()
    .optional()
    .describe("Checkpoint filename override. Bypasses the style mapping for every frame."),
  consistency_mode: z
    .enum(ANIMATION_CONSISTENCY_MODES)
    .optional()
    .describe(
      `How frames are kept consistent. Default "${DEFAULT_CONSISTENCY_MODE}": each frame is ` +
        "img2img from the previous frame at low denoise, same seed throughout. " +
        '"controlnet_pose" is present in the schema for contract stability but is NOT ' +
        "implemented and will be REJECTED (not downgraded) — it needs per-frame pose skeletons " +
        "and a trained character LoRA.",
    ),
  denoise: z
    .number()
    .optional()
    .describe(
      `Per-frame img2img denoise, 0 < denoise <= 1 (default ${ANIMATION_DEFAULT_DENOISE}). Lower ` +
        "keeps the character stable but barely moves; higher moves more but drifts identity.",
    ),
  reference_asset_id: z
    .string()
    .optional()
    .describe(
      "Registered asset id of a base image. Applies to the FIRST frame of the FIRST motion state " +
        "only — every later frame chains from the previous frame. At most one of " +
        "reference_asset_id / reference_path.",
    ),
  reference_path: z
    .string()
    .optional()
    .describe(
      "Path to a base image: absolute, or relative to the ComfyUI output directory. Applies to " +
        "the FIRST frame of the FIRST motion state only. At most one of reference_asset_id / " +
        "reference_path.",
    ),
};

type GenerateAnimationSetArgs = {
  prompt: string;
  motion_states: string[];
  style: Style;
  viewpoint: Viewpoint;
  width: number;
  height: number;
  frames_per_state?: number;
  negative_prompt?: string;
  seed?: number;
  checkpoint?: string;
  consistency_mode?: ConsistencyMode;
  denoise?: number;
  reference_asset_id?: string;
  reference_path?: string;
};

/**
 * Trim and validate the motion-state list. Values are passed through as-is
 * apart from trimming: motion states are FREE-FORM (locked decision) and must
 * never be matched against a fixed vocabulary here or anywhere downstream.
 */
export function assertMotionStates(states: readonly string[]): readonly MotionState[] {
  if (states.length === 0) {
    throw new ValidationError("motion_states must contain at least one motion state.");
  }
  if (states.length > ANIMATION_MAX_MOTION_STATES) {
    throw new ValidationError(
      `motion_states may contain at most ${ANIMATION_MAX_MOTION_STATES} entries (got ${states.length}).`,
    );
  }
  const trimmed = states.map((state) => state.trim());
  if (trimmed.some((state) => state.length === 0)) {
    throw new ValidationError("Every entry in motion_states must be a non-empty string.");
  }
  const seen = new Set<string>();
  for (const state of trimmed) {
    if (seen.has(state)) {
      throw new ValidationError(
        `motion_states contains the duplicate entry "${state}"; each motion state must be unique.`,
      );
    }
    seen.add(state);
  }
  return trimmed;
}

export function assertFramesPerState(value: number | undefined, stateCount: number): number {
  const frames = value ?? ANIMATION_DEFAULT_FRAMES_PER_STATE;
  if (
    !Number.isInteger(frames) ||
    frames < ANIMATION_MIN_FRAMES_PER_STATE ||
    frames > ANIMATION_MAX_FRAMES_PER_STATE
  ) {
    throw new ValidationError(
      `frames_per_state must be an integer between ${ANIMATION_MIN_FRAMES_PER_STATE} and ` +
        `${ANIMATION_MAX_FRAMES_PER_STATE} (got ${frames}).`,
    );
  }
  const total = stateCount * frames;
  if (total > ANIMATION_MAX_TOTAL_FRAMES) {
    throw new ValidationError(
      `${stateCount} motion states x ${frames} frames = ${total} frames, above the ` +
        `${ANIMATION_MAX_TOTAL_FRAMES}-frame cap for one call. Every frame is a full diffusion ` +
        "job run sequentially — split this into several calls.",
    );
  }
  return frames;
}

/**
 * Animation policy: denoise always applies (every frame after the first is
 * img2img). Exported: generate_arcade_topdown_set's rotation-unsafe (full
 * animation set) path is the same policy under a forced topdown viewpoint.
 */
export function assertDenoise(denoise: number | undefined): number {
  if (denoise === undefined) return ANIMATION_DEFAULT_DENOISE;
  return assertDenoiseRange(denoise);
}

/**
 * Frame result -> the snake_case JSON shape the tool returns. Exported so
 * generate_arcade_topdown_set's animation-set path reports frames in the
 * identical shape rather than a re-declared copy.
 */
export function frameToJson(frame: AnimationFrameResult): Record<string, unknown> {
  if (frame.status === "skipped") {
    return { frame_index: frame.frameIndex, status: frame.status, reason: frame.reason };
  }
  if (frame.status === "failed") {
    return {
      frame_index: frame.frameIndex,
      status: frame.status,
      prompt_id: frame.promptId,
      seed: frame.seed,
      mode: frame.mode,
      error: frame.error,
      error_details: frame.errorDetails,
    };
  }
  return {
    frame_index: frame.frameIndex,
    status: frame.status,
    prompt_id: frame.promptId,
    asset_id: frame.asset.assetId,
    filename: frame.asset.filename,
    subfolder: frame.asset.subfolder,
    seed: frame.seed,
    mode: frame.mode,
  };
}

/** Exported for reuse by generate_arcade_topdown_set's animation-set path. */
export function noteForOutcome(result: AnimationSetResult): string {
  const limitation =
    "Pose changes are APPROXIMATE: img2img without ControlNet cannot guarantee frame-accurate " +
    "poses. This is a known, accepted limitation of img2img_low_denoise, not a failure.";
  if (result.outcome === "complete") {
    return `${limitation} Pass the asset_ids to pixelate_image, then pack_spritesheet.`;
  }
  if (result.outcome === "partial") {
    return (
      `${limitation} Some frames did not generate: 'failed' frames were attempted and errored, ` +
      "'skipped' frames were never attempted because an earlier frame in the same state broke " +
      "the img2img chain. Re-run only the affected motion_states with the same seed."
    );
  }
  return (
    "No frame generated. Check that ComfyUI is running and the checkpoint exists, then re-run " +
    "with the same seed."
  );
}

export function registerGenerateAnimationSetTool(server: McpServer): void {
  server.tool(
    "generate_animation_set",
    "Generate a coherent set of animation frames for one character across several motion states. " +
      "'motion_states' is FREE-FORM — describe what this creature actually does ('slither', " +
      "'coil', 'flap', 'glide'); there is no fixed walk/attack/jump vocabulary. Consistency " +
      "strategy (consistency_mode 'img2img_low_denoise'): every frame samples with the SAME seed, " +
      "and each frame after the first is img2img from the PREVIOUS frame's image at low denoise. " +
      "An optional reference image seeds the very first frame only. KNOWN LIMITATION: without " +
      "ControlNet the pose changes are approximate — 'controlnet_pose' is in the schema but is " +
      "NOT implemented and will be rejected rather than downgraded. This tool BLOCKS: it runs " +
      "every frame sequentially (one diffusion job at a time) and returns once the whole set is " +
      "done, so expect it to take minutes. Individual frame failures are reported, never thrown — " +
      "a broken frame does not discard the frames that succeeded.",
    generateAnimationSetSchema,
    async (args: GenerateAnimationSetArgs) => {
      try {
        // FIRST, before any staging or generation: reject controlnet_pose. This
        // is the locked decision — no silent downgrade, and no side effects on
        // a rejected call.
        const consistencyMode = assertImplementedConsistencyMode(
          args.consistency_mode ?? DEFAULT_CONSISTENCY_MODE,
        );

        if (args.prompt.trim().length === 0) {
          throw new ValidationError("prompt must be a non-empty string.");
        }
        if (args.checkpoint !== undefined && args.checkpoint.trim().length === 0) {
          throw new ValidationError("checkpoint, when provided, must be a non-empty filename.");
        }

        const motionStates = assertMotionStates(args.motion_states);
        const framesPerState = assertFramesPerState(args.frames_per_state, motionStates.length);
        const width = assertSpriteDimension(args.width, "width");
        const height = assertSpriteDimension(args.height, "height");
        const seed = resolveSpriteSeed(args.seed);
        const denoise = assertDenoise(args.denoise);

        const reference = await resolveReferenceImage(
          args.reference_asset_id,
          args.reference_path,
        );

        const request: AnimationSetRequest = {
          prompt: args.prompt,
          negativePrompt: args.negative_prompt,
          style: args.style,
          viewpoint: args.viewpoint,
          motionStates,
          framesPerState,
          width,
          height,
          seed,
          checkpoint: args.checkpoint,
          consistencyMode,
          denoise,
          referenceImage: reference?.filename,
        };

        const result = await runAnimationSet(request);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "completed",
                  tool: "generate_animation_set",
                  outcome: result.outcome,
                  style: result.style,
                  viewpoint: result.viewpoint,
                  consistency_mode: result.consistencyMode,
                  checkpoint: result.checkpoint,
                  seed: result.seed,
                  denoise,
                  width,
                  height,
                  frames_per_state: result.framesPerState,
                  requested_frame_count: result.requestedFrameCount,
                  succeeded_frame_count: result.succeededFrameCount,
                  failed_frame_count: result.failedFrameCount,
                  skipped_frame_count: result.skippedFrameCount,
                  base_image: reference?.source,
                  states: result.states.map((state) => ({
                    motion_state: state.motionState,
                    succeeded_frame_count: state.succeededFrameCount,
                    failed_frame_count: state.failedFrameCount,
                    skipped_frame_count: state.skippedFrameCount,
                    chain_stopped_early: state.chainStoppedEarly,
                    frames: state.frames.map(frameToJson),
                  })),
                  note: noteForOutcome(result),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
