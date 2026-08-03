import type { WorkflowJSON } from "../../comfyui/types.js";
import { createWorkflow, getNextNodeId } from "../../services/workflow-composer.js";
import type { SpriteGenerationMode, SpriteJobRequest } from "../types.js";
import { composeSpritePrompt } from "./sprite-prompt.js";
import { STYLE_PROFILES } from "./style-profiles.js";
import { findNodeId, insertLora } from "./graph-edit.js";

// ---------------------------------------------------------------------------
// Sprite workflow JSON construction — PURE. No disk, no network, no queue.
//
// Builds on the inherited txt2img / img2img templates from
// services/workflow-composer.ts rather than forking them, then applies the few
// sprite-specific tweaks by mutating the returned graph.
// ---------------------------------------------------------------------------

/**
 * img2img denoise when the caller does not specify one. High enough to apply the
 * requested style to an arbitrary reference, low enough to keep its silhouette.
 * generate_animation_set will pass a much lower value explicitly.
 */
export const DEFAULT_SPRITE_DENOISE = 0.6;

/** SaveImage prefix; the "pixelforge/" segment becomes an output subfolder. */
export const SPRITE_FILENAME_PREFIX = "pixelforge/sprite";

export interface BuiltSpriteWorkflow {
  readonly workflow: WorkflowJSON;
  readonly mode: SpriteGenerationMode;
}

/**
 * The inherited img2img template derives its latent from the reference image, so
 * the caller's width/height would otherwise be silently ignored. Insert an
 * ImageScale between LoadImage and VAEEncode so the requested canvas is honored
 * in both modes. `crop: "disabled"` stretches rather than crops — predictable,
 * and it never clips part of the subject away.
 */
function forceCanvasSize(workflow: WorkflowJSON, width: number, height: number): void {
  const loadId = findNodeId(workflow, "LoadImage");
  const encodeId = findNodeId(workflow, "VAEEncode");
  const scaleId = getNextNodeId(workflow);

  workflow[scaleId] = {
    class_type: "ImageScale",
    inputs: {
      image: [loadId, 0],
      upscale_method: "lanczos",
      width,
      height,
      crop: "disabled",
    },
    _meta: { title: "Sprite Canvas" },
  };
  workflow[encodeId].inputs.pixels = [scaleId, 0];
}

export function buildSpriteWorkflow(
  request: SpriteJobRequest,
  checkpoint: string,
): BuiltSpriteWorkflow {
  const profile = STYLE_PROFILES[request.style];
  const { positive, negative } = composeSpritePrompt(request);
  const mode: SpriteGenerationMode = request.referenceImage ? "img2img" : "txt2img";

  const shared = {
    checkpoint,
    positive_prompt: positive,
    negative_prompt: negative,
    width: request.width,
    height: request.height,
    // Seed is passed through verbatim and MUST survive to ComfyUI — the enqueue
    // side disables the inherited seed randomization for exactly this reason.
    seed: request.seed,
    steps: request.stepsOverride ?? profile.steps,
    cfg: request.cfgOverride ?? profile.cfg,
    sampler_name: request.samplerOverride ?? profile.samplerName,
    scheduler: request.schedulerOverride ?? profile.scheduler,
  };

  const workflow =
    mode === "img2img"
      ? createWorkflow("img2img", {
          ...shared,
          // Already a bare filename staged in ComfyUI's input dir — LoadImage
          // takes it as-is; it is not a filesystem path.
          image_path: request.referenceImage,
          denoise: request.denoise ?? DEFAULT_SPRITE_DENOISE,
        })
      : createWorkflow("txt2img", shared);

  if (mode === "img2img") {
    forceCanvasSize(workflow, request.width, request.height);
  }

  if (request.lora) {
    insertLora(workflow, request.lora, "Sprite LoRA");
  }

  workflow[findNodeId(workflow, "SaveImage")].inputs.filename_prefix = SPRITE_FILENAME_PREFIX;

  return { workflow, mode };
}
