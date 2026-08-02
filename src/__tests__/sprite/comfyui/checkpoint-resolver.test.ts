import { describe, expect, it } from "vitest";
import { resolveSpriteCheckpoint, type CheckpointLister } from "../../../sprite/comfyui/checkpoint-resolver.js";
import type { LocalModel } from "../../../services/model-resolver.js";

function model(name: string): LocalModel {
  return { name, path: `/models/checkpoints/${name}`, size: 0, modified: "", type: "checkpoints" };
}

function listerReturning(...names: string[]): CheckpointLister {
  return async () => names.map(model);
}

function listerThrowing(): CheckpointLister {
  return async () => {
    throw new Error("ComfyUI unreachable");
  };
}

describe("resolveSpriteCheckpoint", () => {
  it("an explicit override always wins, with no warning and no listing call", async () => {
    let called = false;
    const list: CheckpointLister = async () => {
      called = true;
      return [];
    };
    const result = await resolveSpriteCheckpoint("32bit", "my-custom.safetensors", list);
    expect(result).toEqual({ checkpoint: "my-custom.safetensors" });
    expect(called).toBe(false);
  });

  it("trims whitespace-only override to fall through to style mapping", async () => {
    const result = await resolveSpriteCheckpoint("8bit", "   ", listerReturning());
    expect(result.checkpoint).toBe("v1-5-pruned-emaonly.safetensors");
  });

  it("returns the style's preferred candidate when listing fails, no warning", async () => {
    const result = await resolveSpriteCheckpoint("32bit", undefined, listerThrowing());
    expect(result).toEqual({ checkpoint: "dreamshaper_8.safetensors" });
  });

  it("returns the style's preferred candidate when nothing is installed locally, no warning", async () => {
    const result = await resolveSpriteCheckpoint("32bit", undefined, listerReturning());
    expect(result).toEqual({ checkpoint: "dreamshaper_8.safetensors" });
  });

  it("picks a NAMED candidate that is installed, no warning", async () => {
    const result = await resolveSpriteCheckpoint(
      "32bit",
      undefined,
      listerReturning("some_other.safetensors", "v1-5-pruned-emaonly.safetensors"),
    );
    expect(result).toEqual({ checkpoint: "v1-5-pruned-emaonly.safetensors" });
  });

  it("falls back to a same-family checkpoint by name hint, no warning", async () => {
    // "32bit" wants sd15; none of its named candidates are installed, but a
    // recognizably-sd15 file ("dreamshaper_7" — not one of the exact named
    // candidates) is. pickByFamily's `prefer` regex should catch it.
    const result = await resolveSpriteCheckpoint(
      "32bit",
      undefined,
      listerReturning("some_sd15_v1-5_finetune.safetensors"),
    );
    expect(result.checkpoint).toBe("some_sd15_v1-5_finetune.safetensors");
    expect(result.familyMismatchWarning).toBeUndefined();
  });

  it("warns when the fallback lands on the OPPOSITE family (sd15 style, only SDXL installed)", async () => {
    // Mirrors the gap report's actual failure: 32bit/16bit/8bit expect sd15,
    // but the dev's ComfyUI only had SDXL/Flux checkpoints installed.
    const result = await resolveSpriteCheckpoint(
      "32bit",
      undefined,
      listerReturning("sd_xl_base_1.0.safetensors"),
    );
    expect(result.checkpoint).toBe("sd_xl_base_1.0.safetensors");
    expect(result.familyMismatchWarning).toBeDefined();
    expect(result.familyMismatchWarning).toContain('style "32bit"');
    expect(result.familyMismatchWarning).toContain("sd15");
    expect(result.familyMismatchWarning).toContain("sd_xl_base_1.0.safetensors");
  });

  it("warns when the fallback lands on a name that matches neither family hint", async () => {
    const result = await resolveSpriteCheckpoint(
      "chibi", // expects sdxl
      undefined,
      listerReturning("totally_unbranded_checkpoint.safetensors"),
    );
    expect(result.checkpoint).toBe("totally_unbranded_checkpoint.safetensors");
    expect(result.familyMismatchWarning).toBeDefined();
    expect(result.familyMismatchWarning).toContain("sdxl");
  });

  it("does not warn when the same-family fallback happens to be an SDXL style", async () => {
    const result = await resolveSpriteCheckpoint(
      "chibi", // expects sdxl
      undefined,
      listerReturning("animagineXLV31_v31.safetensors"),
    );
    // Exact named candidate match, not even the fallback path — sanity check
    // that the happy path still carries no warning.
    expect(result.familyMismatchWarning).toBeUndefined();
  });
});
