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
  steps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Sampling steps override — replaces the style profile's default. Needed for checkpoint " +
        "families the style profile wasn't tuned for, e.g. Flux-schnell wants 4-8 steps, not the " +
        "profile's SDXL-tuned ~30.",
    ),
  cfg: z
    .number()
    .positive()
    .optional()
    .describe(
      "CFG scale override — replaces the style profile's default. Flux-schnell wants cfg 1.0, not " +
        "the profile's ~7. NOTE: at cfg 1.0 the negative_prompt has NO effect (Flux-schnell ignores " +
        "classifier-free guidance) — express exclusions in the positive prompt instead.",
    ),
  sampler: z
    .string()
    .optional()
    .describe("Sampler name override (e.g. 'euler', 'dpmpp_2m') — replaces the style profile's default."),
  scheduler: z
    .string()
    .optional()
    .describe("Scheduler override (e.g. 'normal', 'karras') — replaces the style profile's default."),
  auto_download_missing: z
    .boolean()
    .optional()
    .describe(
      "Explicit opt-in (default false — NEVER silent): if the resolved checkpoint (or 'lora', when " +
        "given) isn't actually installed, download it before enqueueing instead of enqueueing a " +
        "graph ComfyUI will only reject later. Checkpoint: best-ranked CivitAI/HuggingFace " +
        "candidate. LoRA: 'lora.source' when given is fetched EXACTLY (no ranking); without a " +
        "source, only an exact filename match is used — never a 'similar' substitute. Reports what " +
        "was downloaded in the result. If nothing installable is found, fails with an actionable " +
        "error instead of proceeding with a broken graph.",
    ),
  lora: z
    .object({
      name: z
        .string()
        .describe(
          "Exact on-disk LoRA filename (the ComfyUI LoraLoader 'lora_name' widget value), e.g. " +
            "'pixel-art-xl-v1.1.safetensors'. NEVER inferred from the prompt — find it first with " +
            "search_civitai_models / search_models / list_local_models if you don't already know it.",
        ),
      strength_model: z.number().optional().describe("LoraLoader strength_model. Defaults to 1.0."),
      strength_clip: z
        .number()
        .optional()
        .describe("LoraLoader strength_clip. Defaults to strength_model."),
      source: z
        .object({
          civitai_model_id: z.number().optional().describe("CivitAI model id (resolves to its primary file)."),
          civitai_version_id: z
            .number()
            .optional()
            .describe("CivitAI model-VERSION id — preferred over civitai_model_id when both are known."),
          huggingface_repo: z.string().optional().describe("HuggingFace repo id, e.g. 'nerijs/pixel-art-xl'."),
          huggingface_filename: z
            .string()
            .optional()
            .describe("Exact filename inside huggingface_repo — not a search term."),
        })
        .optional()
        .describe(
          "Explicit, exact download source used ONLY when auto_download_missing is true and this " +
            "LoRA isn't installed yet. Set civitai_version_id (preferred), civitai_model_id, or both " +
            "huggingface_repo + huggingface_filename to fetch EXACTLY that file — never a keyword " +
            "search, never a 'similar' substitute. Omit to rely on an exact-filename search match " +
            "instead (still never fuzzy).",
        ),
    })
    .optional()
    .describe(
      "Explicit LoRA applied via a LoraLoader node between the checkpoint and the sampler/CLIP " +
        "encoders. NEVER inferred from the prompt — pass it explicitly. Omit for no LoRA.",
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
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  auto_download_missing?: boolean;
  lora?: {
    name: string;
    strength_model?: number;
    strength_clip?: number;
    source?: {
      civitai_model_id?: number;
      civitai_version_id?: number;
      huggingface_repo?: string;
      huggingface_filename?: string;
    };
  };
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
      "style+viewpoint pair selects a checkpoint unless you override it with 'checkpoint'. Sampling " +
      "(steps/cfg/sampler/scheduler) defaults to the style's tuned profile; override any of them " +
      "when the chosen checkpoint needs different sampling (e.g. Flux-schnell: cfg 1.0, 4-8 steps). " +
      "If the resolved checkpoint's base-model family doesn't match the style (nothing better " +
      "installed), the result carries a checkpoint_warning instead of failing silently. Pass " +
      "'lora' for an explicit LoRA (never inferred from the prompt) — combine with " +
      "auto_download_missing + lora.source to fetch an exact, named LoRA (e.g. a pixel-art LoRA " +
      "found via search_civitai_models) when it isn't installed yet. " +
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
        if (args.lora !== undefined && args.lora.name.trim().length === 0) {
          throw new ValidationError("lora.name, when provided, must be a non-empty filename.");
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
          stepsOverride: args.steps,
          cfgOverride: args.cfg,
          samplerOverride: args.sampler,
          schedulerOverride: args.scheduler,
          autoDownloadMissing: args.auto_download_missing,
          lora: args.lora
            ? {
                name: args.lora.name,
                strengthModel: args.lora.strength_model,
                strengthClip: args.lora.strength_clip,
                source: args.lora.source
                  ? {
                      civitaiModelId: args.lora.source.civitai_model_id,
                      civitaiVersionId: args.lora.source.civitai_version_id,
                      huggingfaceRepo: args.lora.source.huggingface_repo,
                      huggingfaceFilename: args.lora.source.huggingface_filename,
                    }
                  : undefined,
              }
            : undefined,
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
                  checkpoint_warning: result.checkpointFamilyWarning,
                  seed: result.seed,
                  width,
                  height,
                  reference_image: reference?.source,
                  lora: args.lora
                    ? {
                        name: args.lora.name,
                        strength_model: args.lora.strength_model ?? 1.0,
                        strength_clip: args.lora.strength_clip ?? args.lora.strength_model ?? 1.0,
                      }
                    : undefined,
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
