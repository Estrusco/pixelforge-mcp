import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError, errorToToolResult } from "../../utils/errors.js";
import { runAnimationSet } from "../animation-runner.js";
import { assertSpriteDimension, resolveSpriteSeed } from "../arg-validation.js";
import { enqueueSpriteJob } from "../comfyui/index.js";
import { resolveReferenceImage } from "../reference-image.js";
import {
  ANIMATION_MAX_FRAMES_PER_STATE,
  ANIMATION_MAX_MOTION_STATES,
  ANIMATION_MIN_FRAMES_PER_STATE,
  DEFAULT_CONSISTENCY_MODE,
  SPRITE_DIM_MAX,
  SPRITE_DIM_MIN,
  SPRITE_DIM_STEP,
  SPRITE_STYLES,
} from "../types.js";
import type {
  AnimationSetRequest,
  SpriteJobRequest,
  SpriteJobResult,
  Style,
} from "../types.js";
import { assertDenoise as assertSpriteDenoise } from "./generate-sprite.js";
import {
  assertDenoise as assertAnimationDenoise,
  assertFramesPerState,
  assertMotionStates,
  frameToJson,
  noteForOutcome,
} from "./generate-animation-set.js";

// ---------------------------------------------------------------------------
// generate_arcade_topdown_set — preset wrapper over generate_sprite (1) and
// generate_animation_set (3) for topdown arcade assets (e.g. Math Serpent).
//
// This file owns ONLY: argument validation, forcing viewpoint to "topdown",
// choosing which of the two underlying request shapes to build, and response
// formatting. It deliberately reuses generate_sprite's/generate_animation_set's
// own validators and formatters (imported above) rather than re-declaring
// them, and delegates to the same `enqueueSpriteJob` / `runAnimationSet` entry
// points those tools use — there is no third generation path here.
//
// LOCKED DECISION (CLAUDE.md): `symmetric_rotation_safe` (default true) picks
// the mode:
//   - true  -> ONE canonical frame (wraps generate_sprite). The engine rotates
//     it at runtime. Safe ONLY for 90-degree-aligned movement; using a rotated
//     frame for non-90-degree rotation causes pixel-grid aliasing. No
//     `motion_states` / `frames_per_state` in this mode — there is exactly one
//     frame, so per-state lists have nothing to attach to.
//   - false -> full animation set (wraps generate_animation_set) forced to
//     `viewpoint: "topdown"`. Used when the subject needs distinct art per
//     facing/state instead of one rotated frame. `motion_states` is required
//     here, same free-form semantics as generate_animation_set (LOCKED: never
//     a fixed vocabulary) — it may name facings (e.g. 'face_up', 'face_right')
//     or genuine motion states.
// ---------------------------------------------------------------------------

const generateArcadeTopdownSetSchema = {
  prompt: z
    .string()
    .describe(
      "Positive prompt describing the sprite subject (e.g. 'a coiled green serpent'). " +
        "Do not mention camera angle — viewpoint is always forced to topdown.",
    ),
  style: z
    .enum(SPRITE_STYLES)
    .describe(`Rendering aesthetic. One of: ${SPRITE_STYLES.join(", ")}.`),
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
  symmetric_rotation_safe: z
    .boolean()
    .optional()
    .describe(
      "Default true: generates ONE canonical frame and expects the game engine to rotate it at " +
        "runtime for the other facings. Safe ONLY for 90-degree-aligned movement (e.g. a " +
        "Math Serpent-style up/down/left/right grid) -- using a rotated frame for non-90-degree " +
        "rotation needs causes visible pixel-grid aliasing. Set to false when the subject needs " +
        "distinct art per facing/state instead of one rotated frame; that path requires " +
        "motion_states and produces a full animation set.",
    ),
  motion_states: z
    .array(z.string())
    .optional()
    .describe(
      "Required when symmetric_rotation_safe is false, and rejected when true (a single " +
        "canonical frame has no per-state list to attach to). FREE-FORM, same semantics as " +
        "generate_animation_set's motion_states -- distinct facings " +
        "(e.g. ['face_up','face_right','face_down','face_left']) or genuine motion states.",
    ),
  frames_per_state: z
    .number()
    .optional()
    .describe(
      "Only valid together with symmetric_rotation_safe: false; see generate_animation_set's " +
        `frames_per_state (${ANIMATION_MIN_FRAMES_PER_STATE}-${ANIMATION_MAX_FRAMES_PER_STATE}, ` +
        "default 4).",
    ),
  negative_prompt: z
    .string()
    .optional()
    .describe("Extra negative prompt. Style/viewpoint-specific negatives are added automatically."),
  seed: z
    .number()
    .optional()
    .describe("Sampling seed (non-negative integer). Omit to randomize; the seed used is always returned."),
  checkpoint: z
    .string()
    .optional()
    .describe("Checkpoint filename override. Bypasses the style + viewpoint mapping entirely."),
  reference_asset_id: z
    .string()
    .optional()
    .describe(
      "Registered asset id of a reference image. Switches the single-frame path to img2img, or " +
        "seeds the first frame of the first motion state in the animation-set path. At most one " +
        "of reference_asset_id / reference_path.",
    ),
  reference_path: z
    .string()
    .optional()
    .describe(
      "Path to a reference image: absolute, or relative to the ComfyUI output directory. Same " +
        "role as reference_asset_id. At most one of reference_asset_id / reference_path.",
    ),
  denoise: z
    .number()
    .optional()
    .describe(
      "img2img denoise strength, 0 < denoise <= 1. In the single-frame path only valid together " +
        "with a reference image; in the animation-set path applies to every frame after the " +
        "first (default 0.35, same as generate_animation_set).",
    ),
};

type GenerateArcadeTopdownSetArgs = {
  prompt: string;
  style: Style;
  width: number;
  height: number;
  symmetric_rotation_safe?: boolean;
  motion_states?: string[];
  frames_per_state?: number;
  negative_prompt?: string;
  seed?: number;
  checkpoint?: string;
  reference_asset_id?: string;
  reference_path?: string;
  denoise?: number;
};

export function registerGenerateArcadeTopdownSetTool(server: McpServer): void {
  server.tool(
    "generate_arcade_topdown_set",
    "Preset wrapper over generate_sprite / generate_animation_set for topdown arcade assets " +
      "(e.g. Math Serpent). Always forces viewpoint to 'topdown' -- do not pass one. " +
      "'symmetric_rotation_safe' (default true) picks the mode: true generates ONE canonical " +
      "frame that the game engine rotates at runtime, safe ONLY for 90-degree-aligned movement " +
      "(non-90-degree rotation causes pixel-grid aliasing); false generates a full animation set " +
      "(same blocking, sequential-frame behavior as generate_animation_set) and REQUIRES " +
      "'motion_states' for distinct per-facing/per-state art instead of one rotated frame.",
    generateArcadeTopdownSetSchema,
    async (args: GenerateArcadeTopdownSetArgs) => {
      try {
        if (args.prompt.trim().length === 0) {
          throw new ValidationError("prompt must be a non-empty string.");
        }
        if (args.checkpoint !== undefined && args.checkpoint.trim().length === 0) {
          throw new ValidationError("checkpoint, when provided, must be a non-empty filename.");
        }

        const rotationSafe = args.symmetric_rotation_safe ?? true;
        const width = assertSpriteDimension(args.width, "width");
        const height = assertSpriteDimension(args.height, "height");
        const seed = resolveSpriteSeed(args.seed);
        const reference = await resolveReferenceImage(args.reference_asset_id, args.reference_path);

        if (rotationSafe) {
          if (args.motion_states !== undefined) {
            throw new ValidationError(
              "motion_states is only valid when symmetric_rotation_safe is false; the rotation-safe " +
                "mode generates a single canonical frame with no per-state list to attach to.",
            );
          }
          if (args.frames_per_state !== undefined) {
            throw new ValidationError(
              "frames_per_state is only valid when symmetric_rotation_safe is false.",
            );
          }

          const denoise = assertSpriteDenoise(args.denoise, reference !== undefined);

          const request: SpriteJobRequest = {
            prompt: args.prompt,
            negativePrompt: args.negative_prompt,
            style: args.style,
            viewpoint: "topdown",
            width,
            height,
            seed,
            checkpoint: args.checkpoint,
            referenceImage: reference?.filename,
            denoise,
          };

          const result: SpriteJobResult = await enqueueSpriteJob(request);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "enqueued",
                    tool: "generate_arcade_topdown_set",
                    mode_kind: "single_canonical_frame",
                    symmetric_rotation_safe: true,
                    prompt_id: result.promptId,
                    queue_remaining: result.queueRemaining,
                    mode: result.mode,
                    style: args.style,
                    viewpoint: "topdown",
                    checkpoint: result.checkpoint,
                    seed: result.seed,
                    width,
                    height,
                    reference_image: reference?.source,
                    note:
                      "Fire-and-forget. Safe ONLY for 90-degree-aligned engine-side rotation -- do not " +
                      "use this single frame for non-90-degree rotation needs. Retrieve it with " +
                      "get_sprite_result, then pixelate_image. Reuse `seed` to reproduce it.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (args.motion_states === undefined) {
          throw new ValidationError(
            "motion_states is required when symmetric_rotation_safe is false.",
          );
        }
        if (args.motion_states.length > ANIMATION_MAX_MOTION_STATES) {
          throw new ValidationError(
            `motion_states may contain at most ${ANIMATION_MAX_MOTION_STATES} entries ` +
              `(got ${args.motion_states.length}).`,
          );
        }

        const motionStates = assertMotionStates(args.motion_states);
        const framesPerState = assertFramesPerState(args.frames_per_state, motionStates.length);
        const denoise = assertAnimationDenoise(args.denoise);

        const request: AnimationSetRequest = {
          prompt: args.prompt,
          negativePrompt: args.negative_prompt,
          style: args.style,
          viewpoint: "topdown",
          motionStates,
          framesPerState,
          width,
          height,
          seed,
          checkpoint: args.checkpoint,
          consistencyMode: DEFAULT_CONSISTENCY_MODE,
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
                  tool: "generate_arcade_topdown_set",
                  mode_kind: "animation_set",
                  symmetric_rotation_safe: false,
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
