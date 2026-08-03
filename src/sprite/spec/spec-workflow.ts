import type { WorkflowJSON } from "../../comfyui/types.js";
import { createWorkflow, getNextNodeId } from "../../services/workflow-composer.js";
import { findNodeId, insertLora, insertVae } from "../comfyui/graph-edit.js";
import type { PromptSpec, SpecImageScaleStep } from "./prompt-spec-types.js";

// ---------------------------------------------------------------------------
// PromptSpec -> ComfyUI workflow JSON — PURE. No disk, no network, no queue.
//
// Builds on the same inherited txt2img template as buildSpriteWorkflow
// (sprite-workflow.ts), then applies the spec's own extras: an explicit VAE
// loader when the spec names one, one chained LoraLoader per `[LORA]` block,
// and — new here — baking the pixel-grid downscale/upscale into the graph
// itself as real ImageScale nodes, since the spec asks for them by name
// rather than the client-side pixelate_image post-process the rest of
// PixelForge uses.
// ---------------------------------------------------------------------------

export interface BuiltSpecWorkflow {
  readonly workflow: WorkflowJSON;
}

/** Insert one `ImageScale` node after `sourceId`'s output 0, return its id. */
function appendImageScale(workflow: WorkflowJSON, sourceId: string, step: SpecImageScaleStep, title: string): string {
  const scaleId = getNextNodeId(workflow);
  workflow[scaleId] = {
    class_type: "ImageScale",
    inputs: {
      image: [sourceId, 0],
      upscale_method: step.method,
      width: step.width,
      height: step.height,
      crop: "disabled",
    },
    _meta: { title },
  };
  return scaleId;
}

/**
 * Insert the pixel-grid downscale -> upscale pair between `VAEDecode` and
 * `SaveImage`, then repoint `SaveImage` at the final (upscaled) output.
 */
function insertPixelGrid(workflow: WorkflowJSON, downscale: SpecImageScaleStep, upscale: SpecImageScaleStep): void {
  const vaeDecodeId = findNodeId(workflow, "VAEDecode");
  const saveImageId = findNodeId(workflow, "SaveImage");

  const downscaleId = appendImageScale(workflow, vaeDecodeId, downscale, "Pixel Grid Downscale");
  const upscaleId = appendImageScale(workflow, downscaleId, upscale, "Pixel Grid Upscale");

  workflow[saveImageId].inputs.images = [upscaleId, 0];
}

/**
 * Build a full txt2img workflow from a parsed `PromptSpec`, wired exactly the
 * way a human following the spec by hand in the ComfyUI canvas would build
 * it: CheckpointLoaderSimple -> (VAELoader) -> (LoraLoader)* -> CLIPTextEncode
 * (positive/negative) -> KSampler -> VAEDecode -> (pixel-grid ImageScale
 * down/up) -> SaveImage. `(LoraLoader)*` is one chained node per `[LORA]`
 * block, in declaration order.
 */
export function buildWorkflowFromSpec(spec: PromptSpec, checkpoint: string): BuiltSpecWorkflow {
  const workflow = createWorkflow("txt2img", {
    checkpoint,
    positive_prompt: spec.positivePrompt,
    negative_prompt: spec.negativePrompt,
    width: spec.width,
    height: spec.height,
    steps: spec.steps,
    cfg: spec.cfg,
    sampler_name: spec.sampler,
    scheduler: spec.scheduler,
  });

  if (spec.vae) {
    insertVae(workflow, spec.vae, "Spec VAE");
  }

  // insertLora rewires by following whatever currently points at the
  // checkpoint's model/clip outputs, re-resolving the checkpoint node fresh
  // on every call. So calling it a second time doesn't append after the
  // first LoRA — it inserts BEFORE it (the first LoraLoader is now the only
  // thing still pointing at the checkpoint, so the second call rewires that).
  // Iterating spec.loras in reverse makes the first-declared LoRA end up
  // adjacent to the checkpoint, i.e. graph order matches declaration order:
  // checkpoint -> LoRA 1 -> LoRA 2 -> ... -> {KSampler, CLIPTextEncode}.
  for (let i = spec.loras.length - 1; i >= 0; i--) {
    insertLora(workflow, spec.loras[i], `Spec LoRA ${i + 1}`);
  }

  if (spec.postProcess) {
    insertPixelGrid(workflow, spec.postProcess.downscale, spec.postProcess.upscale);
  }

  return { workflow };
}
