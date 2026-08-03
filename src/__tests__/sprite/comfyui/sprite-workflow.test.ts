import { describe, expect, it } from "vitest";
import { buildSpriteWorkflow } from "../../../sprite/comfyui/sprite-workflow.js";
import { STYLE_PROFILES } from "../../../sprite/comfyui/style-profiles.js";
import type { SpriteJobRequest } from "../../../sprite/types.js";
import type { WorkflowJSON, WorkflowNode } from "../../../comfyui/types.js";

function ksampler(workflow: WorkflowJSON): WorkflowNode {
  const node = Object.values(workflow).find((n) => n.class_type === "KSampler");
  if (!node) throw new Error("no KSampler node in the built workflow");
  return node;
}

function baseRequest(overrides: Partial<SpriteJobRequest> = {}): SpriteJobRequest {
  return {
    prompt: "a coiled green serpent",
    style: "32bit",
    viewpoint: "side",
    width: 512,
    height: 512,
    seed: 42,
    ...overrides,
  };
}

describe("buildSpriteWorkflow — sampling overrides", () => {
  it("uses the style profile's sampling defaults when no override is given", () => {
    const profile = STYLE_PROFILES["32bit"];
    const { workflow } = buildSpriteWorkflow(baseRequest(), "some.safetensors");
    const sampler = ksampler(workflow);

    expect(sampler.inputs.steps).toBe(profile.steps);
    expect(sampler.inputs.cfg).toBe(profile.cfg);
    expect(sampler.inputs.sampler_name).toBe(profile.samplerName);
    expect(sampler.inputs.scheduler).toBe(profile.scheduler);
  });

  it("overrides steps/cfg/sampler/scheduler independently — the Flux-schnell case", () => {
    const { workflow } = buildSpriteWorkflow(
      baseRequest({ stepsOverride: 4, cfgOverride: 1.0, samplerOverride: "euler", schedulerOverride: "simple" }),
      "flux1-schnell-fp8.safetensors",
    );
    const sampler = ksampler(workflow);

    expect(sampler.inputs.steps).toBe(4);
    expect(sampler.inputs.cfg).toBe(1.0);
    expect(sampler.inputs.sampler_name).toBe("euler");
    expect(sampler.inputs.scheduler).toBe("simple");
  });

  it("applies a partial override, leaving the rest at the style profile's defaults", () => {
    const profile = STYLE_PROFILES["chibi"];
    const { workflow } = buildSpriteWorkflow(
      baseRequest({ style: "chibi", cfgOverride: 5.5 }),
      "some.safetensors",
    );
    const sampler = ksampler(workflow);

    expect(sampler.inputs.cfg).toBe(5.5);
    expect(sampler.inputs.steps).toBe(profile.steps);
    expect(sampler.inputs.sampler_name).toBe(profile.samplerName);
    expect(sampler.inputs.scheduler).toBe(profile.scheduler);
  });

  it("also applies overrides on the img2img path", () => {
    const { workflow } = buildSpriteWorkflow(
      baseRequest({ referenceImage: "staged.png", stepsOverride: 8, cfgOverride: 1.5 }),
      "flux1-schnell-fp8.safetensors",
    );
    const sampler = ksampler(workflow);

    expect(sampler.inputs.steps).toBe(8);
    expect(sampler.inputs.cfg).toBe(1.5);
  });
});

function checkpointNode(workflow: WorkflowJSON): [string, WorkflowNode] {
  const entry = Object.entries(workflow).find(([, n]) => n.class_type === "CheckpointLoaderSimple");
  if (!entry) throw new Error("no CheckpointLoaderSimple node in the built workflow");
  return entry;
}

function loraNode(workflow: WorkflowJSON): WorkflowNode {
  const node = Object.values(workflow).find((n) => n.class_type === "LoraLoader");
  if (!node) throw new Error("no LoraLoader node in the built workflow");
  return node;
}

describe("buildSpriteWorkflow — LoRA wiring (pixelforge-mcp-7dc.1)", () => {
  it("adds no LoraLoader node when no lora is requested", () => {
    const { workflow } = buildSpriteWorkflow(baseRequest(), "some.safetensors");
    expect(Object.values(workflow).some((n) => n.class_type === "LoraLoader")).toBe(false);
  });

  it("inserts a LoraLoader between the checkpoint and everything downstream (txt2img)", () => {
    const { workflow } = buildSpriteWorkflow(
      baseRequest({ lora: { name: "pixel-art-xl-v1.1.safetensors" } }),
      "sd_xl_base_1.0.safetensors",
    );
    const [ckptId] = checkpointNode(workflow);
    const [loraId, lora] = Object.entries(workflow).find(([, n]) => n.class_type === "LoraLoader")!;

    expect(lora.inputs.model).toEqual([ckptId, 0]);
    expect(lora.inputs.clip).toEqual([ckptId, 1]);
    expect(lora.inputs.lora_name).toBe("pixel-art-xl-v1.1.safetensors");
    expect(lora.inputs.strength_model).toBe(1.0);
    expect(lora.inputs.strength_clip).toBe(1.0);

    const sampler = ksampler(workflow);
    expect(sampler.inputs.model).toEqual([loraId, 0]);

    const clipEncoders = Object.values(workflow).filter((n) => n.class_type === "CLIPTextEncode");
    expect(clipEncoders).toHaveLength(2);
    for (const enc of clipEncoders) {
      expect(enc.inputs.clip).toEqual([loraId, 1]);
    }

    // VAE output (index 2) is untouched — LoraLoader never sees it.
    const vaeDecode = Object.values(workflow).find((n) => n.class_type === "VAEDecode")!;
    expect(vaeDecode.inputs.vae).toEqual([ckptId, 2]);
  });

  it("also wires the LoraLoader on the img2img path (VAEEncode's vae untouched)", () => {
    const { workflow } = buildSpriteWorkflow(
      baseRequest({ referenceImage: "staged.png", lora: { name: "some-lora.safetensors" } }),
      "sd_xl_base_1.0.safetensors",
    );
    const [ckptId] = checkpointNode(workflow);
    const lora = loraNode(workflow);
    expect(lora.inputs.model).toEqual([ckptId, 0]);

    const vaeEncode = Object.values(workflow).find((n) => n.class_type === "VAEEncode")!;
    expect(vaeEncode.inputs.vae).toEqual([ckptId, 2]);
  });

  it("applies strength_model/strength_clip overrides independently", () => {
    const { workflow } = buildSpriteWorkflow(
      baseRequest({ lora: { name: "l.safetensors", strengthModel: 0.7 } }),
      "some.safetensors",
    );
    const lora = loraNode(workflow);
    expect(lora.inputs.strength_model).toBe(0.7);
    // strength_clip defaults to strength_model when omitted.
    expect(lora.inputs.strength_clip).toBe(0.7);
  });

  it("lets strength_clip differ from strength_model", () => {
    const { workflow } = buildSpriteWorkflow(
      baseRequest({ lora: { name: "l.safetensors", strengthModel: 0.7, strengthClip: 0.3 } }),
      "some.safetensors",
    );
    const lora = loraNode(workflow);
    expect(lora.inputs.strength_model).toBe(0.7);
    expect(lora.inputs.strength_clip).toBe(0.3);
  });
});
