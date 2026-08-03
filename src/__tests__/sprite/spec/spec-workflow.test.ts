import { describe, expect, it } from "vitest";
import { buildWorkflowFromSpec } from "../../../sprite/spec/spec-workflow.js";
import type { PromptSpec } from "../../../sprite/spec/prompt-spec-types.js";
import type { WorkflowJSON, WorkflowNode } from "../../../comfyui/types.js";

function baseSpec(overrides: Partial<PromptSpec> = {}): PromptSpec {
  return {
    checkpointCandidates: ["pixelArtDiffusionXL_v2.safetensors"],
    loras: [],
    sampler: "dpmpp_2m_sde",
    scheduler: "karras",
    steps: 35,
    cfg: 7.0,
    width: 1024,
    height: 1024,
    positivePrompt: "pixel art, a portal",
    negativePrompt: "3d render",
    ...overrides,
  };
}

function node(workflow: WorkflowJSON, classType: string): WorkflowNode {
  const n = Object.values(workflow).find((entry) => entry.class_type === classType);
  if (!n) throw new Error(`no ${classType} node in the built workflow`);
  return n;
}

function entry(workflow: WorkflowJSON, classType: string): [string, WorkflowNode] {
  const found = Object.entries(workflow).find(([, n]) => n.class_type === classType);
  if (!found) throw new Error(`no ${classType} node in the built workflow`);
  return found;
}

describe("buildWorkflowFromSpec — base graph", () => {
  it("wires sampler/scheduler/steps/cfg/resolution/prompts from the spec", () => {
    const { workflow } = buildWorkflowFromSpec(baseSpec(), "pixelArtDiffusionXL_v2.safetensors");
    const ksampler = node(workflow, "KSampler");

    expect(ksampler.inputs.sampler_name).toBe("dpmpp_2m_sde");
    expect(ksampler.inputs.scheduler).toBe("karras");
    expect(ksampler.inputs.steps).toBe(35);
    expect(ksampler.inputs.cfg).toBe(7.0);

    const [ckptId, ckpt] = entry(workflow, "CheckpointLoaderSimple");
    expect(ckpt.inputs.ckpt_name).toBe("pixelArtDiffusionXL_v2.safetensors");

    const clipEncoders = Object.values(workflow).filter((n) => n.class_type === "CLIPTextEncode");
    expect(clipEncoders.map((n) => n.inputs.text)).toEqual(["pixel art, a portal", "3d render"]);
    for (const enc of clipEncoders) {
      expect(enc.inputs.clip).toEqual([ckptId, 1]);
    }

    const latent = node(workflow, "EmptyLatentImage");
    expect(latent.inputs.width).toBe(1024);
    expect(latent.inputs.height).toBe(1024);
  });

  it("adds no VAELoader/LoraLoader/ImageScale when the spec omits them", () => {
    const { workflow } = buildWorkflowFromSpec(baseSpec(), "some.safetensors");
    expect(Object.values(workflow).some((n) => n.class_type === "VAELoader")).toBe(false);
    expect(Object.values(workflow).some((n) => n.class_type === "LoraLoader")).toBe(false);
    expect(Object.values(workflow).some((n) => n.class_type === "ImageScale")).toBe(false);

    const [ckptId] = entry(workflow, "CheckpointLoaderSimple");
    const vaeDecode = node(workflow, "VAEDecode");
    expect(vaeDecode.inputs.vae).toEqual([ckptId, 2]);
    const saveImage = node(workflow, "SaveImage");
    const [vaeDecodeId] = entry(workflow, "VAEDecode");
    expect(saveImage.inputs.images).toEqual([vaeDecodeId, 0]);
  });
});

describe("buildWorkflowFromSpec — VAELoader", () => {
  it("inserts a VAELoader and repoints VAEDecode at it, leaving the checkpoint's own VAE output unused", () => {
    const { workflow } = buildWorkflowFromSpec(baseSpec({ vae: "sdxl_vae.safetensors" }), "ckpt.safetensors");
    const [vaeLoaderId, vaeLoader] = entry(workflow, "VAELoader");
    expect(vaeLoader.inputs.vae_name).toBe("sdxl_vae.safetensors");

    const vaeDecode = node(workflow, "VAEDecode");
    expect(vaeDecode.inputs.vae).toEqual([vaeLoaderId, 0]);
  });
});

describe("buildWorkflowFromSpec — LoRA (reuses graph-edit.insertLora)", () => {
  it("wires a LoraLoader between the checkpoint and everything downstream", () => {
    const { workflow } = buildWorkflowFromSpec(
      baseSpec({
        loras: [{ name: "pixel-art-xl-v1.safetensors", strengthModel: 0.9, strengthClip: 0.85, triggerWords: [] }],
      }),
      "ckpt.safetensors",
    );
    const [ckptId] = entry(workflow, "CheckpointLoaderSimple");
    const [loraId, lora] = entry(workflow, "LoraLoader");
    expect(lora.inputs.model).toEqual([ckptId, 0]);
    expect(lora.inputs.clip).toEqual([ckptId, 1]);
    expect(lora.inputs.lora_name).toBe("pixel-art-xl-v1.safetensors");
    expect(lora.inputs.strength_model).toBe(0.9);
    expect(lora.inputs.strength_clip).toBe(0.85);

    const ksampler = node(workflow, "KSampler");
    expect(ksampler.inputs.model).toEqual([loraId, 0]);

    const vaeDecode = node(workflow, "VAEDecode");
    expect(vaeDecode.inputs.vae).toEqual([ckptId, 2]);
  });

  it("chains multiple LoraLoaders in declaration order, first LoRA adjacent to the checkpoint", () => {
    const { workflow } = buildWorkflowFromSpec(
      baseSpec({
        loras: [
          { name: "first.safetensors", strengthModel: 0.9, strengthClip: 0.9, triggerWords: [] },
          { name: "second.safetensors", strengthModel: 0.6, strengthClip: 0.6, triggerWords: [] },
        ],
      }),
      "ckpt.safetensors",
    );

    const [ckptId] = entry(workflow, "CheckpointLoaderSimple");
    const loraLoaders = Object.entries(workflow).filter(([, n]) => n.class_type === "LoraLoader");
    expect(loraLoaders).toHaveLength(2);

    const first = loraLoaders.find(([, n]) => n.inputs.lora_name === "first.safetensors");
    const second = loraLoaders.find(([, n]) => n.inputs.lora_name === "second.safetensors");
    if (!first || !second) throw new Error("expected both LoraLoader nodes to exist");
    const [firstId, firstNode] = first;
    const [secondId, secondNode] = second;

    // checkpoint -> first (declared first) -> second (declared second) -> KSampler/CLIP
    expect(firstNode.inputs.model).toEqual([ckptId, 0]);
    expect(firstNode.inputs.clip).toEqual([ckptId, 1]);
    expect(secondNode.inputs.model).toEqual([firstId, 0]);
    expect(secondNode.inputs.clip).toEqual([firstId, 1]);

    const ksampler = node(workflow, "KSampler");
    expect(ksampler.inputs.model).toEqual([secondId, 0]);
    const clipEncoders = Object.values(workflow).filter((n) => n.class_type === "CLIPTextEncode");
    for (const enc of clipEncoders) {
      expect(enc.inputs.clip).toEqual([secondId, 1]);
    }
  });
});

describe("buildWorkflowFromSpec — pixel-grid post-processing", () => {
  it("inserts downscale then upscale ImageScale nodes between VAEDecode and SaveImage", () => {
    const { workflow } = buildWorkflowFromSpec(
      baseSpec({
        postProcess: {
          downscale: { width: 128, height: 128, method: "nearest-exact" },
          upscale: { width: 1024, height: 1024, method: "nearest-exact" },
        },
      }),
      "ckpt.safetensors",
    );

    const [vaeDecodeId] = entry(workflow, "VAEDecode");
    const scales = Object.entries(workflow).filter(([, n]) => n.class_type === "ImageScale");
    expect(scales).toHaveLength(2);

    const [downscaleId, downscale] = scales[0];
    expect(downscale.inputs.image).toEqual([vaeDecodeId, 0]);
    expect(downscale.inputs.width).toBe(128);
    expect(downscale.inputs.height).toBe(128);
    expect(downscale.inputs.upscale_method).toBe("nearest-exact");

    const [upscaleId, upscale] = scales[1];
    expect(upscale.inputs.image).toEqual([downscaleId, 0]);
    expect(upscale.inputs.width).toBe(1024);
    expect(upscale.inputs.height).toBe(1024);

    const saveImage = node(workflow, "SaveImage");
    expect(saveImage.inputs.images).toEqual([upscaleId, 0]);
  });

  it("combines VAE + LoRA + pixel-grid together without cross-wiring errors", () => {
    const { workflow } = buildWorkflowFromSpec(
      baseSpec({
        vae: "sdxl_vae.safetensors",
        loras: [{ name: "l.safetensors", strengthModel: 1, strengthClip: 1, triggerWords: [] }],
        postProcess: {
          downscale: { width: 128, height: 128, method: "nearest-exact" },
          upscale: { width: 1024, height: 1024, method: "nearest-exact" },
        },
      }),
      "ckpt.safetensors",
    );

    const [vaeLoaderId] = entry(workflow, "VAELoader");
    const [loraId] = entry(workflow, "LoraLoader");
    const ksampler = node(workflow, "KSampler");
    const vaeDecode = node(workflow, "VAEDecode");
    const saveImage = node(workflow, "SaveImage");
    const scales = Object.entries(workflow).filter(([, n]) => n.class_type === "ImageScale");

    expect(ksampler.inputs.model).toEqual([loraId, 0]);
    expect(vaeDecode.inputs.vae).toEqual([vaeLoaderId, 0]);
    expect(saveImage.inputs.images).toEqual([scales[1][0], 0]);
  });
});
