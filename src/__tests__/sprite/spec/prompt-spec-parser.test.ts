import { describe, expect, it } from "vitest";
import { parsePromptSpec } from "../../../sprite/spec/prompt-spec-parser.js";
import { PROMPT_SPEC_TEMPLATE } from "../../../sprite/spec/prompt-spec-template.js";

// Mirrors the format of PixelForgeDocumentations' promptesempio.txt example
// (checkpoint + alternate, separate VAE, LoRA, sampler settings, positive/
// negative prompt, pixel-grid post-processing).
const FULL_SPEC = `\
================================================================================
                    CONFIGURAZIONE GENERAZIONE ASSET PIXEL ART
================================================================================

[CHECKPOINT / MODEL]
Checkpoint: pixelArtDiffusionXL_v2.safetensors (o sd_xl_base_1.0.safetensors)
VAE: sdxl_vae.safetensors

[LORA]
LoRA Name: pixel-art-xl-v1.safetensors
LoRA Model Weight: 0.90
LoRA CLIP Weight: 0.85
Trigger Words: pixel art, pixelart

[SAMPLER & SCHEDULER SETTINGS]
Sampler: dpmpp_2m_sde (o euler_ancestral)
Scheduler: karras
Steps: 35
CFG Scale: 7.0
Resolution: 1024x1024 (Base SDXL)

--------------------------------------------------------------------------------
[POSITIVE PROMPT]
--------------------------------------------------------------------------------
pixel art, pixelart, top-down view of a sci-fi teleportation portal, centered X symbol

--------------------------------------------------------------------------------
[NEGATIVE PROMPT]
--------------------------------------------------------------------------------
3d render, isometric, blurry pixels, watermark

--------------------------------------------------------------------------------
[POST-PROCESSING / PIXEL PERFECT GRID]
--------------------------------------------------------------------------------
Method: Downscale to Native Pixel Resolution -> Upscale Nearest-Neighbor
Downscale Node: ImageScale (Width: 128, Height: 128, Upscale Method: nearest-exact)
Upscale Node: ImageScale (Width: 1024, Height: 1024, Upscale Method: nearest-exact)
================================================================================
`;

describe("parsePromptSpec — full spec", () => {
  const spec = parsePromptSpec(FULL_SPEC);

  it("splits the checkpoint's parenthetical alternate into a candidate list", () => {
    expect(spec.checkpointCandidates).toEqual([
      "pixelArtDiffusionXL_v2.safetensors",
      "sd_xl_base_1.0.safetensors",
    ]);
  });

  it("parses the separate VAE", () => {
    expect(spec.vae).toBe("sdxl_vae.safetensors");
  });

  it("parses the LoRA blocks", () => {
    expect(spec.loras).toEqual([
      {
        name: "pixel-art-xl-v1.safetensors",
        strengthModel: 0.9,
        strengthClip: 0.85,
        triggerWords: ["pixel art", "pixelart"],
      },
    ]);
  });

  it("strips the sampler's parenthetical alternate", () => {
    expect(spec.sampler).toBe("dpmpp_2m_sde");
    expect(spec.scheduler).toBe("karras");
  });

  it("parses steps/cfg as numbers", () => {
    expect(spec.steps).toBe(35);
    expect(spec.cfg).toBe(7.0);
  });

  it("parses resolution, stripping the trailing annotation", () => {
    expect(spec.width).toBe(1024);
    expect(spec.height).toBe(1024);
  });

  it("takes the positive/negative prompt verbatim", () => {
    expect(spec.positivePrompt).toBe(
      "pixel art, pixelart, top-down view of a sci-fi teleportation portal, centered X symbol",
    );
    expect(spec.negativePrompt).toBe("3d render, isometric, blurry pixels, watermark");
  });

  it("parses the pixel-grid post-processing steps", () => {
    expect(spec.postProcess).toEqual({
      downscale: { width: 128, height: 128, method: "nearest-exact" },
      upscale: { width: 1024, height: 1024, method: "nearest-exact" },
    });
  });
});

describe("parsePromptSpec — optional sections", () => {
  const MINIMAL_SPEC = `\
[CHECKPOINT / MODEL]
Checkpoint: sd_xl_base_1.0.safetensors

[SAMPLER & SCHEDULER SETTINGS]
Sampler: euler
Scheduler: normal
Steps: 20
CFG Scale: 8.0
Resolution: 512x512

[POSITIVE PROMPT]
a red fox
`;

  it("omits vae/loras/postProcess when their sections are absent", () => {
    const spec = parsePromptSpec(MINIMAL_SPEC);
    expect(spec.vae).toBeUndefined();
    expect(spec.loras).toEqual([]);
    expect(spec.postProcess).toBeUndefined();
    expect(spec.negativePrompt).toBe("");
    expect(spec.checkpointCandidates).toEqual(["sd_xl_base_1.0.safetensors"]);
  });

  it("defaults LoRA CLIP weight to the model weight when omitted", () => {
    const spec = parsePromptSpec(
      MINIMAL_SPEC.replace(
        "[POSITIVE PROMPT]",
        "[LORA]\nLoRA Name: some-lora.safetensors\nLoRA Model Weight: 0.7\n\n[POSITIVE PROMPT]",
      ),
    );
    expect(spec.loras).toEqual([
      {
        name: "some-lora.safetensors",
        strengthModel: 0.7,
        strengthClip: 0.7,
        triggerWords: [],
      },
    ]);
  });

  it("parses more than one [LORA] block, in document order", () => {
    const spec = parsePromptSpec(
      MINIMAL_SPEC.replace(
        "[POSITIVE PROMPT]",
        "[LORA]\n" +
          "LoRA Name: first-lora.safetensors\n" +
          "LoRA Model Weight: 0.9\n" +
          "LoRA CLIP Weight: 0.85\n" +
          "Trigger Words: first, style\n" +
          "\n" +
          "[LORA]\n" +
          "LoRA Name: second-lora.safetensors\n" +
          "LoRA Model Weight: 0.6\n" +
          "\n" +
          "[POSITIVE PROMPT]",
      ),
    );

    expect(spec.loras).toEqual([
      {
        name: "first-lora.safetensors",
        strengthModel: 0.9,
        strengthClip: 0.85,
        triggerWords: ["first", "style"],
      },
      {
        name: "second-lora.safetensors",
        strengthModel: 0.6,
        strengthClip: 0.6,
        triggerWords: [],
      },
    ]);
  });
});

describe("parsePromptSpec — PROMPT_SPEC_TEMPLATE regression guard", () => {
  // Exact placeholder -> sample value, so this fails loudly (missing key ->
  // the literal placeholder text survives -> a parse error) if
  // prompt-spec-template.ts's wording ever changes without updating this test.
  const SAMPLE_VALUES: Record<string, string> = {
    "<checkpoint_filename.safetensors>": "my_checkpoint.safetensors",
    "<alternate_checkpoint.safetensors>": "alt_checkpoint.safetensors",
    "<optional_separate_vae.safetensors>": "my_vae.safetensors",
    "<lora_filename.safetensors>": "my_lora.safetensors",
    "<0.0-1.0, default 1.0>": "0.9",
    "<0.0-1.0, default = LoRA Model Weight>": "0.85",
    "<comma, separated, words>": "trigger, words",
    "<e.g. dpmpp_2m_sde>": "dpmpp_2m_sde",
    "<e.g. karras>": "karras",
    "<integer>": "30",
    "<number>": "7.0",
    "<width>": "1024",
    "<height>": "1024",
    "<free-form prompt text>": "a red fox, pixel art",
    "<int>": "128",
    "<e.g. nearest-exact>": "nearest-exact",
  };

  it("parses once every <placeholder> is filled with a valid sample value", () => {
    const filled = PROMPT_SPEC_TEMPLATE.replace(/<[^>]+>/g, (placeholder) => {
      const value = SAMPLE_VALUES[placeholder];
      if (value === undefined) throw new Error(`No sample value mapped for placeholder ${placeholder}`);
      return value;
    });

    const spec = parsePromptSpec(filled);
    expect(spec.loras).toEqual([
      { name: "my_lora.safetensors", strengthModel: 0.9, strengthClip: 0.85, triggerWords: ["trigger", "words"] },
    ]);
    expect(spec.postProcess).toEqual({
      downscale: { width: 128, height: 128, method: "nearest-exact" },
      upscale: { width: 128, height: 128, method: "nearest-exact" },
    });
  });
});

describe("parsePromptSpec — required-field errors", () => {
  it("throws when the checkpoint section is missing", () => {
    expect(() =>
      parsePromptSpec(
        "[SAMPLER & SCHEDULER SETTINGS]\nSampler: euler\nScheduler: normal\nSteps: 20\nCFG Scale: 8\nResolution: 512x512\n\n[POSITIVE PROMPT]\nfoo",
      ),
    ).toThrow(/CHECKPOINT \/ MODEL/);
  });

  it("throws when the positive prompt section is missing", () => {
    expect(() =>
      parsePromptSpec(
        "[CHECKPOINT / MODEL]\nCheckpoint: a.safetensors\n\n[SAMPLER & SCHEDULER SETTINGS]\nSampler: euler\nScheduler: normal\nSteps: 20\nCFG Scale: 8\nResolution: 512x512",
      ),
    ).toThrow(/POSITIVE PROMPT/);
  });

  it("throws when a sampler-settings field is missing", () => {
    expect(() =>
      parsePromptSpec(
        "[CHECKPOINT / MODEL]\nCheckpoint: a.safetensors\n\n[SAMPLER & SCHEDULER SETTINGS]\nSampler: euler\nScheduler: normal\n\n[POSITIVE PROMPT]\nfoo",
      ),
    ).toThrow(/Steps/);
  });

  it("throws when resolution can't be parsed", () => {
    expect(() =>
      parsePromptSpec(
        "[CHECKPOINT / MODEL]\nCheckpoint: a.safetensors\n\n[SAMPLER & SCHEDULER SETTINGS]\nSampler: euler\nScheduler: normal\nSteps: 20\nCFG Scale: 8\nResolution: not-a-resolution\n\n[POSITIVE PROMPT]\nfoo",
      ),
    ).toThrow(/could not parse resolution/);
  });

  it("throws when only one of Downscale/Upscale Node is present", () => {
    expect(() =>
      parsePromptSpec(
        "[CHECKPOINT / MODEL]\nCheckpoint: a.safetensors\n\n[SAMPLER & SCHEDULER SETTINGS]\nSampler: euler\nScheduler: normal\nSteps: 20\nCFG Scale: 8\nResolution: 512x512\n\n[POSITIVE PROMPT]\nfoo\n\n[POST-PROCESSING / PIXEL PERFECT GRID]\nDownscale Node: ImageScale (Width: 128, Height: 128, Upscale Method: nearest-exact)",
      ),
    ).toThrow(/both "Downscale Node" and "Upscale Node"/);
  });
});
