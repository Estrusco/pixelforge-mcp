import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  removeBackground,
  REMBG_NODE,
  type RemoveBackgroundDeps,
} from "../../services/remove-background.js";
import { DefaultsManager } from "../../services/defaults-manager.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

function makeDeps(overrides: Partial<RemoveBackgroundDeps> = {}) {
  const enqueued: WorkflowJSON[] = [];
  const deps: RemoveBackgroundDeps = {
    isNodeInstalled: vi.fn(async () => true),
    enqueue: async (wf) => {
      enqueued.push(wf);
      return { prompt_id: "pid-rembg", queue_remaining: 0 };
    },
    ...overrides,
  };
  return { deps, enqueued };
}

function node(wf: WorkflowJSON, type: string) {
  return Object.values(wf).find((n) => n.class_type === type);
}

describe("removeBackground", () => {
  beforeEach(() => {
    DefaultsManager.reset();
    DefaultsManager.configure({ configPath: "/tmp/__never__.json", env: {} });
  });

  it("builds a LoadImage → BiRefNetRMBG → SaveImage graph wired in order", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await removeBackground({ image: "subject.png" }, deps);

    expect(res.prompt_id).toBe("pid-rembg");
    const wf = enqueued[0];
    expect(node(wf, "LoadImage")!.inputs.image).toBe("subject.png");
    const rembg = node(wf, REMBG_NODE)!;
    expect(rembg.inputs.image).toEqual(["1", 0]);
    expect(rembg.inputs.model).toBe("BiRefNet_toonout");
    // background=Alpha gives a transparent cutout; the other widgets are "optional"
    // in the node schema but ComfyUI-RMBG reads them by key, so they MUST be passed
    // explicitly or the node KeyErrors at runtime over the API (regression guard).
    expect(rembg.inputs.background).toBe("Alpha");
    expect(rembg.inputs.mask_blur).toBe(0);
    expect(rembg.inputs.mask_offset).toBe(0);
    expect(rembg.inputs.invert_output).toBe(false);
    expect(rembg.inputs.refine_foreground).toBe(false);
    expect(rembg.inputs.background_color).toBe("#222222");
    const save = node(wf, "SaveImage")!;
    expect(save.inputs.images).toEqual(["2", 0]);
  });

  it("applies a model override", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await removeBackground({ image: "s.png", model: "RMBG-2.0" }, deps);
    expect(node(enqueued[0], REMBG_NODE)!.inputs.model).toBe("RMBG-2.0");
    expect(res.model).toBe("RMBG-2.0");
  });

  it("throws an actionable error when the rembg node is not installed", async () => {
    const { deps } = makeDeps({ isNodeInstalled: async () => false });
    await expect(removeBackground({ image: "s.png" }, deps)).rejects.toThrow(
      /ComfyUI-RMBG|comfyui-rmbg|not installed/i,
    );
  });

  it("proceeds when install state is unknown (undefined)", async () => {
    const { deps, enqueued } = makeDeps({ isNodeInstalled: async () => undefined });
    await removeBackground({ image: "s.png" }, deps);
    expect(enqueued).toHaveLength(1);
  });

  it("throws when image is missing", async () => {
    const { deps } = makeDeps();
    await expect(removeBackground({ image: "" }, deps)).rejects.toThrow(/image is required/i);
  });
});

describe("removeBackground — luma_key mode", () => {
  beforeEach(() => {
    DefaultsManager.reset();
    DefaultsManager.configure({ configPath: "/tmp/__never__.json", env: {} });
  });

  function orderedTypes(wf: WorkflowJSON): string[] {
    return Object.keys(wf)
      .sort((a, b) => Number(a) - Number(b))
      .map((id) => wf[id].class_type);
  }

  it("builds the core-node-only luminance-key graph, never checking BiRefNet install", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await removeBackground({ image: "neon.png", mode: "luma_key" }, deps);

    expect(res.prompt_id).toBe("pid-rembg");
    expect(res.mode).toBe("luma_key");
    expect(res.model).toBeUndefined();
    expect(deps.isNodeInstalled).not.toHaveBeenCalled();

    const wf = enqueued[0];
    expect(orderedTypes(wf)).toEqual([
      "LoadImage",
      "ImageToMask",
      "ImageToMask",
      "ImageToMask",
      "MaskComposite",
      "MaskComposite",
      "InvertMask",
      "JoinImageWithAlpha",
      "SaveImage",
    ]);

    const channels = Object.values(wf)
      .filter((n) => n.class_type === "ImageToMask")
      .map((n) => n.inputs.channel);
    expect(channels.sort()).toEqual(["blue", "green", "red"]);

    const composites = Object.values(wf).filter((n) => n.class_type === "MaskComposite");
    for (const c of composites) expect(c.inputs.operation).toBe("add");

    const join = node(wf, "JoinImageWithAlpha")!;
    expect(join.inputs.image).toEqual(["1", 0]);
    const invert = node(wf, "InvertMask")!;
    expect(join.inputs.alpha).toEqual([Object.keys(wf).find((id) => wf[id] === invert), 0]);
  });

  it("inserts ThresholdMask only when threshold is given, before InvertMask", async () => {
    const { deps, enqueued } = makeDeps();
    await removeBackground({ image: "neon.png", mode: "luma_key", threshold: 0.3 }, deps);
    const wf = enqueued[0];
    expect(orderedTypes(wf)).toContain("ThresholdMask");
    const threshold = node(wf, "ThresholdMask")!;
    expect(threshold.inputs.value).toBe(0.3);
    const invert = node(wf, "InvertMask")!;
    expect(invert.inputs.mask[0]).toBe(
      Object.keys(wf).find((id) => wf[id] === threshold),
    );
  });

  it("inserts GrowMask only when softness is given, after threshold", async () => {
    const { deps, enqueued } = makeDeps();
    await removeBackground(
      { image: "neon.png", mode: "luma_key", threshold: 0.3, softness: 4 },
      deps,
    );
    const wf = enqueued[0];
    const grow = node(wf, "GrowMask")!;
    expect(grow.inputs.expand).toBe(4);
    expect(grow.inputs.tapered_corners).toBe(true);
    const threshold = node(wf, "ThresholdMask")!;
    expect(grow.inputs.mask[0]).toBe(Object.keys(wf).find((id) => wf[id] === threshold));
    const invert = node(wf, "InvertMask")!;
    expect(invert.inputs.mask[0]).toBe(Object.keys(wf).find((id) => wf[id] === grow));
  });

  it("omits threshold/softness nodes entirely by default (exact verified graph)", async () => {
    const { deps, enqueued } = makeDeps();
    await removeBackground({ image: "neon.png", mode: "luma_key" }, deps);
    const wf = enqueued[0];
    expect(node(wf, "ThresholdMask")).toBeUndefined();
    expect(node(wf, "GrowMask")).toBeUndefined();
  });

  it("rejects model with luma_key mode", async () => {
    const { deps } = makeDeps();
    await expect(
      removeBackground({ image: "s.png", mode: "luma_key", model: "x" }, deps),
    ).rejects.toThrow(/model only applies to mode "birefnet"/);
  });

  it("rejects threshold/softness with birefnet mode", async () => {
    const { deps } = makeDeps();
    await expect(
      removeBackground({ image: "s.png", mode: "birefnet", threshold: 0.5 }, deps),
    ).rejects.toThrow(/only apply to mode "luma_key"/);
    await expect(
      removeBackground({ image: "s.png", softness: 2 }, deps),
    ).rejects.toThrow(/only apply to mode "luma_key"/);
  });

  it("rejects an out-of-range threshold", async () => {
    const { deps } = makeDeps();
    await expect(
      removeBackground({ image: "s.png", mode: "luma_key", threshold: 1.5 }, deps),
    ).rejects.toThrow(/threshold must be between 0 and 1/);
  });
});
