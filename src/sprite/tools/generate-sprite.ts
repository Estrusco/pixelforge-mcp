import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError, errorToToolResult } from "../../utils/errors.js";
import {
  assertDenoiseRange,
  assertSpriteDimension,
  resolveSpriteSeed,
} from "../arg-validation.js";
import { enqueueSpriteJob } from "../comfyui/index.js";
import { resolveReferenceImage } from "../reference-image.js";
import {
  SPRITE_DIM_MAX,
  SPRITE_DIM_MIN,
  SPRITE_DIM_STEP,
  SPRITE_STYLES,
  SPRITE_VIEWPOINTS,
} from "../types.js";
import type { SpriteJobRequest, SpriteJobResult, Style, Viewpoint } from "../types.js";

// ---------------------------------------------------------------------------
// generate_sprite — the MCP contract layer.
//
// This file owns ONLY: argument validation and response formatting. Everything
// else is delegated and must stay that way:
//   - shared argument bounds  -> ../arg-validation.js (bounds themselves in ../types.js)
//   - reference-image staging -> ../reference-image.js
//   - checkpoint mapping, workflow JSON, enqueue -> ../comfyui/ (enqueueSpriteJob)
//
// So this file deliberately contains no workflow JSON, no checkpoint knowledge,
// and no queue logic. Note in particular that `enqueueSpriteJob` must enqueue
// with `disable_random_seed: true` (see src/sprite/comfyui/sprite-job.ts) or the
// seed echoed back here is a lie.
// ---------------------------------------------------------------------------

const generateSpriteSchema = {
  prompt: z
    .string()
    .describe("Positive prompt describing the sprite subject (e.g. 'a coiled green serpent')."),
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
        "Generate large, then downsample with pixelate_image — do NOT ask the model for a 32px canvas.",
    ),
  height: z
    .number()
    .describe(
      `Diffusion canvas height in px (${SPRITE_DIM_MIN}-${SPRITE_DIM_MAX}, multiple of ${SPRITE_DIM_STEP}).`,
    ),
  negative_prompt: z
    .string()
    .optional()
    .describe("Extra negative prompt. Style/viewpoint-specific negatives are added automatically."),
  seed: z
    .number()
    .optional()
    .describe(
      "Sampling seed (non-negative integer). Omit to randomize. The seed actually used is " +
        "always returned, so a result can be reproduced or extended into an animation set.",
    ),
  checkpoint: z
    .string()
    .optional()
    .describe("Checkpoint filename override. Bypasses the style + viewpoint mapping entirely."),
  reference_asset_id: z
    .string()
    .optional()
    .describe(
      "Registered asset id of a reference image (from a completed job). Supplying a reference " +
        "switches the pipeline to img2img. Provide at most one of reference_asset_id / reference_path.",
    ),
  reference_path: z
    .string()
    .optional()
    .describe(
      "Path to a reference image: absolute, or relative to the ComfyUI output directory. " +
        "Supplying a reference switches the pipeline to img2img. " +
        "Provide at most one of reference_asset_id / reference_path.",
    ),
  denoise: z
    .number()
    .optional()
    .describe(
      "img2img denoise strength, 0 < denoise <= 1. Lower keeps more of the reference. " +
        "Only valid together with a reference image.",
    ),
  auto_download_missing: z
    .boolean()
    .optional()
    .describe(
      "Explicit opt-in (default false — NEVER silent): if the resolved checkpoint isn't actually " +
        "installed, download the best-ranked CivitAI/HuggingFace candidate before enqueueing, " +
        "instead of enqueueing a graph ComfyUI will only reject later. Reports what was downloaded " +
        "in the result. If no installable candidate is found, fails with an actionable error " +
        "instead of proceeding with a broken checkpoint.",
    ),
};

type GenerateSpriteArgs = {
  prompt: string;
  style: Style;
  viewpoint: Viewpoint;
  width: number;
  height: number;
  negative_prompt?: string;
  seed?: number;
  checkpoint?: string;
  reference_asset_id?: string;
  reference_path?: string;
  denoise?: number;
  auto_download_missing?: boolean;
};

/**
 * img2img-only gate; the 0 < denoise <= 1 range check is shared.
 * Exported: generate_arcade_topdown_set's rotation-safe (single-frame) path
 * wraps the same generate_sprite semantics and must apply the same gate
 * rather than a re-declared copy.
 */
export function assertDenoise(denoise: number | undefined, hasReference: boolean): number | undefined {
  if (denoise === undefined) return undefined;
  if (!hasReference) {
    throw new ValidationError(
      "denoise only applies to img2img. Provide reference_asset_id or reference_path, or drop denoise.",
    );
  }
  return assertDenoiseRange(denoise);
}

export function registerGenerateSpriteTool(server: McpServer): void {
  server.tool(
    "generate_sprite",
    "Generate a single game sprite from a text prompt, optionally guided by a reference image. " +
      "'style' (rendering aesthetic: 8bit/16bit/chibi/hand_painted/...) and 'viewpoint' (camera " +
      "angle: side/topdown/isometric) are INDEPENDENT parameters — 'isometric' is a viewpoint, not " +
      "a style. Without a reference image this runs txt2img; with one it runs img2img. The " +
      "style+viewpoint pair selects a checkpoint unless you override it with 'checkpoint'. " +
      "Fire-and-forget: returns prompt_id immediately along with the exact seed used, so the result " +
      "is reproducible and can be extended into an animation set. Retrieve the finished image with " +
      "get_sprite_result (or view_image) once the completion notification arrives. Generate at a " +
      "diffusion-friendly size, then run pixelate_image to get true pixel art.",
    generateSpriteSchema,
    async (args: GenerateSpriteArgs) => {
      try {
        if (args.prompt.trim().length === 0) {
          throw new ValidationError("prompt must be a non-empty string.");
        }
        if (args.checkpoint !== undefined && args.checkpoint.trim().length === 0) {
          throw new ValidationError("checkpoint, when provided, must be a non-empty filename.");
        }

        const width = assertSpriteDimension(args.width, "width");
        const height = assertSpriteDimension(args.height, "height");
        const seed = resolveSpriteSeed(args.seed);

        const reference = await resolveReferenceImage(args.reference_asset_id, args.reference_path);
        const denoise = assertDenoise(args.denoise, reference !== undefined);

        const request: SpriteJobRequest = {
          prompt: args.prompt,
          negativePrompt: args.negative_prompt,
          style: args.style,
          viewpoint: args.viewpoint,
          width,
          height,
          seed,
          checkpoint: args.checkpoint,
          referenceImage: reference?.filename,
          denoise,
          autoDownloadMissing: args.auto_download_missing,
        };

        const result: SpriteJobResult = await enqueueSpriteJob(request);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  tool: "generate_sprite",
                  prompt_id: result.promptId,
                  queue_remaining: result.queueRemaining,
                  mode: result.mode,
                  style: args.style,
                  viewpoint: args.viewpoint,
                  checkpoint: result.checkpoint,
                  seed: result.seed,
                  width,
                  height,
                  reference_image: reference?.source,
                  downloaded_models: result.downloadedModels,
                  note:
                    "Fire-and-forget. The asset_id arrives in the completion notification; pass this " +
                    "prompt_id to get_sprite_result to fetch the sprite. Reuse `seed` to reproduce it.",
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
