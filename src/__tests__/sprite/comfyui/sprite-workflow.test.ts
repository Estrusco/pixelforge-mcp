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
