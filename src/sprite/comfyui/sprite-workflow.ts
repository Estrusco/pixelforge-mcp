import type { WorkflowJSON } from "../../comfyui/types.js";
import { createWorkflow, getNextNodeId } from "../../services/workflow-composer.js";
import { WorkflowExecutionError } from "../../utils/errors.js";
import type { SpriteGenerationMode, SpriteJobRequest, SpriteLoraRequest } from "../types.js";
import { composeSpritePrompt } from "./sprite-prompt.js";
import { STYLE_PROFILES } from "./style-profiles.js";

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

function findNodeId(workflow: WorkflowJSON, classType: string): string {
  const id = Object.keys(workflow).find((key) => workflow[key].class_type === classType);
  if (id === undefined) {
    throw new WorkflowExecutionError(
      `Sprite workflow template is missing an expected ${classType} node.`,
    );
  }
  return id;
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

/**
 * Insert a `LoraLoader` between `CheckpointLoaderSimple` and everything that
 * consumed its `model`/`clip` outputs (KSampler, both CLIPTextEncode nodes).
 * Generic over node ids on purpose — it rewires by CONNECTION, not by
 * hardcoded node id, so it works unchanged whether the template is txt2img
 * (ids 1-7) or img2img (ids 1-8). The checkpoint's VAE output (index 2) is
 * untouched: `LoraLoader` never sees or passes it through.
 */
function insertLora(workflow: WorkflowJSON, lora: SpriteLoraRequest): void {
  const ckptId = findNodeId(workflow, "CheckpointLoaderSimple");
  const loraId = getNextNodeId(workflow);
  const strengthModel = lora.strengthModel ?? 1.0;
  const strengthClip = lora.strengthClip ?? strengthModel;

  workflow[loraId] = {
    class_type: "LoraLoader",
    inputs: {
      model: [ckptId, 0],
      clip: [ckptId, 1],
      lora_name: lora.name,
      strength_model: strengthModel,
      strength_clip: strengthClip,
    },
    _meta: { title: "Sprite LoRA" },
  };

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (nodeId === loraId) continue;
    for (const [key, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value) || value[0] !== ckptId) continue;
      if (value[1] === 0) node.inputs[key] = [loraId, 0];
      else if (value[1] === 1) node.inputs[key] = [loraId, 1];
    }
  }
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
    insertLora(workflow, request.lora);
  }

  workflow[findNodeId(workflow, "SaveImage")].inputs.filename_prefix = SPRITE_FILENAME_PREFIX;

  return { workflow, mode };
}
