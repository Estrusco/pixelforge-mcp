import { describe, expect, it, vi, beforeEach } from "vitest";
import type { WorkflowJSON } from "../../../comfyui/types.js";
import type { ValidationResult } from "../../../services/workflow-validator.js";
import type { MissingModel, ModelCandidate, ObjectInfoLike } from "../../../services/missing-models.js";
import type { SpriteJobRequest } from "../../../sprite/types.js";

// ── enqueueSpriteJob orchestration ──────────────────────────────────────────
// Every seam is injected via SpriteJobDeps, so this never touches the real
// getObjectInfo/validateWorkflow/downloadModel/enqueueWorkflow modules — only
// buildSpriteWorkflow (pure, no I/O) and findMissingModels (pure, no I/O) run
// for real, which is exactly what lets these tests exercise the REAL
// checkpoint-node wiring without a live ComfyUI.

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

function nonModelErrorResult(): ValidationResult {
  return {
    valid: false,
    issues: [
      {
        severity: "error",
        node_id: "99",
        node_type: "SomeCustomNode",
        kind: "missing_node_type",
        message: 'Unknown node type "SomeCustomNode". This node may not be installed.',
      },
    ],
    summary: "Workflow has 1 error(s) and 0 warning(s)",
  };
}

/** objectInfo whose CheckpointLoaderSimple.ckpt_name combo does NOT list `missingName`. */
function objectInfoMissingCheckpoint(missingName: string, installedName = "installed.safetensors"): ObjectInfoLike {
  return {
    CheckpointLoaderSimple: {
      input: {
        required: { ckpt_name: [[installedName, `not-${missingName}`]] },
      },
    },
  };
}

function baseRequest(overrides: Partial<SpriteJobRequest> = {}): SpriteJobRequest {
  return {
    prompt: "a coiled green serpent",
    style: "16bit",
    viewpoint: "side",
    width: 512,
    height: 512,
    seed: 42,
    ...overrides,
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const enqueued: WorkflowJSON[] = [];
  const validate = vi.fn(async (): Promise<ValidationResult> => VALID);
  const deps = {
    resolveCheckpoint: vi.fn(async (_style: string, override?: string) => override ?? "mapped.safetensors"),
    enqueue: vi.fn(async (workflow: WorkflowJSON) => {
      enqueued.push(workflow);
      return { prompt_id: "p1", queue_remaining: 0 };
    }),
    validate,
    getObjectInfo: vi.fn(async (): Promise<ObjectInfoLike> => ({})),
    resetObjectInfoCache: vi.fn(),
    resolveModelCandidates: vi.fn(async (): Promise<ModelCandidate[]> => []),
    downloadModelCandidate: vi.fn(async () => {}),
    ...overrides,
  };
  return { deps, enqueued, validate };
}

describe("enqueueSpriteJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enqueues straight through when validation passes, no download attempted", async () => {
    const { enqueueSpriteJob } = await import("../../../sprite/comfyui/sprite-job.js");
    const { deps, enqueued } = makeDeps();

    const result = await enqueueSpriteJob(baseRequest(), deps);

    expect(result.promptId).toBe("p1");
    expect(enqueued).toHaveLength(1);
    expect(deps.getObjectInfo).not.toHaveBeenCalled();
    expect(deps.resolveModelCandidates).not.toHaveBeenCalled();
    expect(result.downloadedModels).toBeUndefined();
    // disable_random_seed is REQUIRED — a random seed here would make the
    // seed echoed back to the caller a lie.
    expect(deps.enqueue).toHaveBeenCalledWith(expect.any(Object), { disable_random_seed: true });
  });

  it("throws without downloading when validation fails and autoDownloadMissing is unset", async () => {
    const { enqueueSpriteJob } = await import("../../../sprite/comfyui/sprite-job.js");
    const validate = vi.fn(async () =>
      missingModelResult("1", "CheckpointLoaderSimple", "ckpt_name", "missing.safetensors"),
    );
    const { deps, enqueued } = makeDeps({ validate });

    await expect(enqueueSpriteJob(baseRequest(), deps)).rejects.toThrow(/failed validation/);
    expect(enqueued).toHaveLength(0);
    expect(deps.getObjectInfo).not.toHaveBeenCalled();
  });

  it("throws without attempting a download when the failure isn't a missing model", async () => {
    const { enqueueSpriteJob } = await import("../../../sprite/comfyui/sprite-job.js");
    const validate = vi.fn(async () => nonModelErrorResult());
    const { deps, enqueued } = makeDeps({ validate, getObjectInfo: vi.fn(async () => ({})) });

    await expect(
      enqueueSpriteJob(baseRequest({ autoDownloadMissing: true }), deps),
    ).rejects.toThrow(/Unknown node type/);
    expect(enqueued).toHaveLength(0);
    // findMissingModels found nothing missing (empty objectInfo has no matching
    // node type either way) — the download loop must never run.
    expect(deps.downloadModelCandidate).not.toHaveBeenCalled();
  });

  it("downloads the best candidate, rewires the graph, and enqueues on re-validation success", async () => {
    const { enqueueSpriteJob } = await import("../../../sprite/comfyui/sprite-job.js");
    const missingName = "missing-checkpoint.safetensors";
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
    const { deps, enqueued } = makeDeps({
      validate,
      resolveCheckpoint: vi.fn(async () => missingName),
      getObjectInfo: vi.fn(async () => objectInfoMissingCheckpoint(missingName)),
      resolveModelCandidates: vi.fn(async () => [candidate]),
    });

    const result = await enqueueSpriteJob(baseRequest({ autoDownloadMissing: true }), deps);

    expect(deps.downloadModelCandidate).toHaveBeenCalledTimes(1);
    const [missingArg, candidateArg] = (deps.downloadModelCandidate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((missingArg as MissingModel).name).toBe(missingName);
    expect((missingArg as MissingModel).directory).toBe("checkpoints");
    expect(candidateArg).toBe(candidate);

    expect(deps.resetObjectInfoCache).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(enqueued).toHaveLength(1);
    // The graph must be REWIRED to the actually-installed filename, not left
    // pointing at the name that was never present.
    expect(enqueued[0]["1"].inputs.ckpt_name).toBe("installed.safetensors");

    expect(result.downloadedModels).toEqual([
      {
        requested: missingName,
        installed: "installed.safetensors",
        source: "huggingface",
        nodeType: "CheckpointLoaderSimple",
      },
    ]);
  });

  it("throws an actionable error when no installable candidate is found, never downloading", async () => {
    const { enqueueSpriteJob } = await import("../../../sprite/comfyui/sprite-job.js");
    const missingName = "missing-checkpoint.safetensors";
    const validate = vi.fn(async () =>
      missingModelResult("1", "CheckpointLoaderSimple", "ckpt_name", missingName),
    );
    const { deps, enqueued } = makeDeps({
      validate,
      resolveCheckpoint: vi.fn(async () => missingName),
      getObjectInfo: vi.fn(async () => objectInfoMissingCheckpoint(missingName)),
      resolveModelCandidates: vi.fn(async () => []),
    });

    await expect(
      enqueueSpriteJob(baseRequest({ autoDownloadMissing: true }), deps),
    ).rejects.toThrow(/no installable candidate/);
    expect(deps.downloadModelCandidate).not.toHaveBeenCalled();
    expect(enqueued).toHaveLength(0);
  });

  it("throws the validation error (not a false success) when the download did not fix the graph", async () => {
    const { enqueueSpriteJob } = await import("../../../sprite/comfyui/sprite-job.js");
    const missingName = "missing-checkpoint.safetensors";
    const stillBroken = missingModelResult("1", "CheckpointLoaderSimple", "ckpt_name", "installed.safetensors");
    const validate = vi
      .fn<() => Promise<ValidationResult>>()
      .mockResolvedValueOnce(missingModelResult("1", "CheckpointLoaderSimple", "ckpt_name", missingName))
      .mockResolvedValueOnce(stillBroken);
    const candidate: ModelCandidate = {
      filename: "installed.safetensors",
      source: "huggingface",
      url: "https://huggingface.co/org/repo/resolve/main/installed.safetensors",
      precision: "fp16",
    };
    const { deps, enqueued } = makeDeps({
      validate,
      resolveCheckpoint: vi.fn(async () => missingName),
      getObjectInfo: vi.fn(async () => objectInfoMissingCheckpoint(missingName)),
      resolveModelCandidates: vi.fn(async () => [candidate]),
    });

    await expect(enqueueSpriteJob(baseRequest({ autoDownloadMissing: true }), deps)).rejects.toThrow(
      /failed validation/,
    );
    expect(deps.downloadModelCandidate).toHaveBeenCalledTimes(1);
    expect(enqueued).toHaveLength(0);
  });
});

// ── downloadModelCandidate ──────────────────────────────────────────────────
// Isolated from enqueueSpriteJob's orchestration: mocks the real
// downloadModel/resolveCivitaiModel(Version) imports to verify the HF vs
// CivitAI branching and the explicit-target-filename contract (the download
// MUST land under candidate.filename, never a source-suggested name — that's
// what lets enqueueSpriteJob rewire the graph without re-reading the result).

const downloadModel = vi.fn();
vi.mock("../../../services/model-resolver.js", () => ({
  downloadModel: (...args: unknown[]) => downloadModel(...args),
}));

const resolveCivitaiModel = vi.fn();
const resolveCivitaiModelVersion = vi.fn();
vi.mock("../../../services/civitai-resolver.js", () => ({
  resolveCivitaiModel: (...args: unknown[]) => resolveCivitaiModel(...args),
  resolveCivitaiModelVersion: (...args: unknown[]) => resolveCivitaiModelVersion(...args),
}));

describe("downloadModelCandidate", () => {
  beforeEach(() => {
    downloadModel.mockReset();
    resolveCivitaiModel.mockReset();
    resolveCivitaiModelVersion.mockReset();
  });

  function missing(overrides: Partial<MissingModel> = {}): MissingModel {
    return {
      node_id: "1",
      node_type: "CheckpointLoaderSimple",
      widget: "ckpt_name",
      name: "wanted.safetensors",
      directory: "checkpoints",
      ...overrides,
    };
  }

  it("downloads a HuggingFace candidate under its own explicit filename", async () => {
    const { downloadModelCandidate } = await import("../../../sprite/comfyui/sprite-job.js");
    downloadModel.mockResolvedValue("/models/checkpoints/installed.safetensors");
    const candidate: ModelCandidate = {
      filename: "installed.safetensors",
      source: "huggingface",
      url: "https://huggingface.co/org/repo/resolve/main/installed.safetensors",
      precision: "fp16",
    };

    await downloadModelCandidate(missing(), candidate);

    expect(downloadModel).toHaveBeenCalledWith(candidate.url, "checkpoints", "installed.safetensors");
  });

  it("resolves a CivitAI version id then downloads under the candidate's filename", async () => {
    const { downloadModelCandidate } = await import("../../../sprite/comfyui/sprite-job.js");
    resolveCivitaiModelVersion.mockResolvedValue({
      downloadUrl: "https://civitai.com/api/download/models/999",
      filename: "civitai-suggested-name.safetensors",
      versionId: 999,
    });
    downloadModel.mockResolvedValue("/models/checkpoints/installed.safetensors");
    const candidate: ModelCandidate = {
      filename: "installed.safetensors",
      source: "civitai",
      civitai_version_id: 999,
      precision: "fp16",
    };

    await downloadModelCandidate(missing(), candidate);

    expect(resolveCivitaiModelVersion).toHaveBeenCalledWith(999);
    // MUST use candidate.filename, not resolved.filename (the CivitAI-suggested
    // name) — the target filename is what enqueueSpriteJob rewires the graph to.
    expect(downloadModel).toHaveBeenCalledWith(
      "https://civitai.com/api/download/models/999",
      "checkpoints",
      "installed.safetensors",
    );
  });

  it("resolves a bare CivitAI model id when no version id is given", async () => {
    const { downloadModelCandidate } = await import("../../../sprite/comfyui/sprite-job.js");
    resolveCivitaiModel.mockResolvedValue({
      downloadUrl: "https://civitai.com/api/download/models/1",
      versionId: 1,
    });
    downloadModel.mockResolvedValue("/models/checkpoints/installed.safetensors");
    const candidate: ModelCandidate = {
      filename: "installed.safetensors",
      source: "civitai",
      civitai_model_id: 42,
      precision: "fp16",
    };

    await downloadModelCandidate(missing(), candidate);

    expect(resolveCivitaiModel).toHaveBeenCalledWith(42);
    expect(downloadModel).toHaveBeenCalled();
  });

  it("throws without downloading when the missing model has no inferred directory", async () => {
    const { downloadModelCandidate } = await import("../../../sprite/comfyui/sprite-job.js");
    const candidate: ModelCandidate = {
      filename: "installed.safetensors",
      source: "huggingface",
      url: "https://x",
      precision: "fp16",
    };

    await expect(
      downloadModelCandidate(missing({ directory: undefined }), candidate),
    ).rejects.toThrow(/could not be inferred/);
    expect(downloadModel).not.toHaveBeenCalled();
  });

  it("throws when a HuggingFace candidate has no url", async () => {
    const { downloadModelCandidate } = await import("../../../sprite/comfyui/sprite-job.js");
    const candidate: ModelCandidate = {
      filename: "installed.safetensors",
      source: "huggingface",
      precision: "fp16",
    };

    await expect(downloadModelCandidate(missing(), candidate)).rejects.toThrow(/no download URL/);
    expect(downloadModel).not.toHaveBeenCalled();
  });

  it("throws when a CivitAI candidate has neither model id nor version id", async () => {
    const { downloadModelCandidate } = await import("../../../sprite/comfyui/sprite-job.js");
    const candidate: ModelCandidate = {
      filename: "installed.safetensors",
      source: "civitai",
      precision: "fp16",
    };

    await expect(downloadModelCandidate(missing(), candidate)).rejects.toThrow(/no CivitAI model\/version id/);
    expect(downloadModel).not.toHaveBeenCalled();
  });
});
