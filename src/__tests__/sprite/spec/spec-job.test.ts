import { describe, expect, it, vi, beforeEach } from "vitest";
import type { WorkflowJSON } from "../../../comfyui/types.js";
import type { ValidationResult } from "../../../services/workflow-validator.js";
import type { ModelCandidate, ObjectInfoLike } from "../../../services/missing-models.js";
import type { LocalModel } from "../../../services/model-resolver.js";
import type { PromptSpec } from "../../../sprite/spec/prompt-spec-types.js";
import type { SpecJobDeps } from "../../../sprite/spec/spec-job.js";

// ── buildAndSaveSpecWorkflow orchestration ──────────────────────────────────
// Same DI approach as sprite-job.test.ts: every I/O seam is injected, so only
// buildWorkflowFromSpec (pure) and findMissingModels (pure) run for real.

const VALID: ValidationResult = { valid: true, issues: [], summary: "Workflow is valid" };

function missingModelResult(nodeId: string, nodeType: string, widget: string, value: string): ValidationResult {
  return {
    valid: false,
    issues: [
      {
        severity: "error",
        node_id: nodeId,
        node_type: nodeType,
        kind: "missing_model",
        input: widget,
        value,
        message: `"${widget}" = "${value}" is not in the list of valid options (value_not_in_list).`,
      },
    ],
    summary: "Workflow has 1 error(s) and 0 warning(s)",
  };
}

function objectInfoMissingCheckpoint(missingName: string, installedName = "installed.safetensors"): ObjectInfoLike {
  return {
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [[installedName, `not-${missingName}`]] } },
    },
  };
}

function objectInfoMissingLora(missingName: string, installedName = "installed-lora.safetensors"): ObjectInfoLike {
  return {
    LoraLoader: {
      input: { required: { lora_name: [[installedName, `not-${missingName}`]] } },
    },
  };
}

function baseSpec(overrides: Partial<PromptSpec> = {}): PromptSpec {
  return {
    checkpointCandidates: ["pixelArtDiffusionXL_v2.safetensors", "sd_xl_base_1.0.safetensors"],
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

function localModel(name: string): LocalModel {
  return { name, path: `/models/checkpoints/${name}`, size: 0, modified: "", type: "checkpoints" };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const saved: Array<{ filename: string; workflow: WorkflowJSON }> = [];
  const validate = vi.fn(async (): Promise<ValidationResult> => VALID);
  const deps = {
    listInstalledCheckpoints: vi.fn(async (): Promise<LocalModel[]> => []),
    validate,
    getObjectInfo: vi.fn(async (): Promise<ObjectInfoLike> => ({})),
    resetObjectInfoCache: vi.fn(),
    resolveModelCandidates: vi.fn(async (): Promise<ModelCandidate[]> => []),
    downloadModelCandidate: vi.fn(async () => {}),
    downloadExplicitSource: vi.fn(async () => {}),
    saveWorkflow: vi.fn(async (filename: string, workflow: WorkflowJSON) => {
      saved.push({ filename, workflow });
      return { ok: true, message: `Workflow saved as "${filename}" in the ComfyUI user library.` };
    }),
    ...overrides,
  } satisfies SpecJobDeps;
  return { deps, saved };
}

describe("buildAndSaveSpecWorkflow — checkpoint candidate resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the first candidate already installed, not necessarily the primary one", async () => {
    const { buildAndSaveSpecWorkflow } = await import("../../../sprite/spec/spec-job.js");
    const { deps, saved } = makeDeps({
      listInstalledCheckpoints: vi.fn(async () => [localModel("sd_xl_base_1.0.safetensors")]),
    });

    const result = await buildAndSaveSpecWorkflow({ spec: baseSpec(), filename: "test.json" }, deps);

    expect(result.checkpoint).toBe("sd_xl_base_1.0.safetensors");
    expect(saved[0].workflow["1"].inputs.ckpt_name).toBe("sd_xl_base_1.0.safetensors");
  });

  it("falls back to the primary candidate when none are installed", async () => {
    const { buildAndSaveSpecWorkflow } = await import("../../../sprite/spec/spec-job.js");
    const { deps } = makeDeps();

    const result = await buildAndSaveSpecWorkflow({ spec: baseSpec(), filename: "test.json" }, deps);

    expect(result.checkpoint).toBe("pixelArtDiffusionXL_v2.safetensors");
  });
});

describe("buildAndSaveSpecWorkflow — validation and save", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves the workflow and returns its checkpoint/vae/lora when valid", async () => {
    const { buildAndSaveSpecWorkflow } = await import("../../../sprite/spec/spec-job.js");
    const { deps, saved } = makeDeps();
    const spec = baseSpec({
      vae: "sdxl_vae.safetensors",
      lora: { name: "l.safetensors", strengthModel: 0.9, strengthClip: 0.85, triggerWords: [] },
    });

    const result = await buildAndSaveSpecWorkflow({ spec, filename: "test.json" }, deps);

    expect(result.checkpoint).toBe("pixelArtDiffusionXL_v2.safetensors");
    expect(result.vae).toBe("sdxl_vae.safetensors");
    expect(result.lora).toBe("l.safetensors");
    expect(saved).toHaveLength(1);
    expect(saved[0].filename).toBe("test.json");
  });

  it("throws without saving when the graph fails validation and auto-download is off", async () => {
    const { buildAndSaveSpecWorkflow } = await import("../../../sprite/spec/spec-job.js");
    const validate = vi.fn(async () => missingModelResult("1", "CheckpointLoaderSimple", "ckpt_name", "x.safetensors"));
    const { deps, saved } = makeDeps({ validate });

    await expect(buildAndSaveSpecWorkflow({ spec: baseSpec(), filename: "test.json" }, deps)).rejects.toThrow(
      /failed validation/,
    );
    expect(saved).toHaveLength(0);
  });

  it("throws (not a silent save) when the ComfyUI save call itself fails", async () => {
    const { buildAndSaveSpecWorkflow } = await import("../../../sprite/spec/spec-job.js");
    const { deps } = makeDeps({
      saveWorkflow: vi.fn(async () => ({ ok: false, message: "Failed to save workflow: 500 Internal Server Error" })),
    });

    await expect(buildAndSaveSpecWorkflow({ spec: baseSpec(), filename: "test.json" }, deps)).rejects.toThrow(
      /Failed to save workflow/,
    );
  });
});

describe("buildAndSaveSpecWorkflow — auto-download (reuses resolveAndDownloadMissingModels)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("downloads a missing checkpoint, rewires the graph, then saves", async () => {
    const { buildAndSaveSpecWorkflow } = await import("../../../sprite/spec/spec-job.js");
    const missingName = "pixelArtDiffusionXL_v2.safetensors";
    const validate = vi
      .fn<() => Promise<ValidationResult>>()
      .mockResolvedValueOnce(missingModelResult("1", "CheckpointLoaderSimple", "ckpt_name", missingName))
      .mockResolvedValueOnce(VALID);
    const candidate: ModelCandidate = {
      filename: "installed.safetensors",
      source: "huggingface",
      url: "https://huggingface.co/org/repo/resolve/main/installed.safetensors",
      precision: "fp16",
    };
    const { deps, saved } = makeDeps({
      validate,
      getObjectInfo: vi.fn(async () => objectInfoMissingCheckpoint(missingName)),
      resolveModelCandidates: vi.fn(async () => [candidate]),
    });

    const result = await buildAndSaveSpecWorkflow(
      { spec: baseSpec({ checkpointCandidates: [missingName] }), filename: "test.json", autoDownloadMissing: true },
      deps,
    );

    expect(deps.downloadModelCandidate).toHaveBeenCalledTimes(1);
    expect(saved[0].workflow["1"].inputs.ckpt_name).toBe("installed.safetensors");
    expect(result.downloadedModels).toEqual([
      { requested: missingName, installed: "installed.safetensors", source: "huggingface", nodeType: "CheckpointLoaderSimple" },
    ]);
  });

  it("fetches the spec's LoRA via an explicit loraSource, bypassing search/ranking", async () => {
    const { buildAndSaveSpecWorkflow } = await import("../../../sprite/spec/spec-job.js");
    const loraName = "pixel-art-xl-v1.safetensors";
    const validate = vi
      .fn<() => Promise<ValidationResult>>()
      .mockResolvedValueOnce(missingModelResult("2", "LoraLoader", "lora_name", loraName))
      .mockResolvedValueOnce(VALID);
    const { deps } = makeDeps({
      validate,
      getObjectInfo: vi.fn(async () => objectInfoMissingLora(loraName)),
    });

    await buildAndSaveSpecWorkflow(
      {
        spec: baseSpec({ lora: { name: loraName, strengthModel: 0.9, strengthClip: 0.85, triggerWords: [] } }),
        filename: "test.json",
        autoDownloadMissing: true,
        loraSource: { huggingfaceRepo: "nerijs/pixel-art-xl", huggingfaceFilename: loraName },
      },
      deps,
    );

    expect(deps.resolveModelCandidates).not.toHaveBeenCalled();
    expect(deps.downloadExplicitSource).toHaveBeenCalledWith("loras", loraName, {
      huggingfaceRepo: "nerijs/pixel-art-xl",
      huggingfaceFilename: loraName,
    });
  });

  it("without a loraSource, never substitutes a 'similar' LoRA — throws instead", async () => {
    const { buildAndSaveSpecWorkflow } = await import("../../../sprite/spec/spec-job.js");
    const loraName = "pixel-art-xl-v1.safetensors";
    const validate = vi.fn(async () => missingModelResult("2", "LoraLoader", "lora_name", loraName));
    const fuzzy: ModelCandidate = {
      filename: "some-other-pixel-lora.safetensors",
      source: "huggingface",
      url: "https://huggingface.co/org/other/resolve/main/some-other-pixel-lora.safetensors",
      precision: "fp16",
      match: "fuzzy",
    };
    const { deps, saved } = makeDeps({
      validate,
      getObjectInfo: vi.fn(async () => objectInfoMissingLora(loraName)),
      resolveModelCandidates: vi.fn(async () => [fuzzy]),
    });

    await expect(
      buildAndSaveSpecWorkflow(
        {
          spec: baseSpec({ lora: { name: loraName, strengthModel: 1, strengthClip: 1, triggerWords: [] } }),
          filename: "test.json",
          autoDownloadMissing: true,
        },
        deps,
      ),
    ).rejects.toThrow(/EXACT filename match/);
    expect(deps.downloadModelCandidate).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });
});
