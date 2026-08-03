import type { WorkflowJSON } from "../../comfyui/types.js";
import { getObjectInfo, resetObjectInfoCache } from "../../comfyui/client.js";
import { listLocalModels, type LocalModel } from "../../services/model-resolver.js";
import {
  findMissingModels,
  liveResolveDeps,
  resolveCandidates,
  type ObjectInfoLike,
} from "../../services/missing-models.js";
import { validateWorkflow, type ValidationResult } from "../../services/workflow-validator.js";
import { saveWorkflowToLibrary, type SaveWorkflowResult } from "../../services/workflow-converter.js";
import { ComfyUIError, ValidationError } from "../../utils/errors.js";
import type { DownloadedModelInfo, SpriteLoraSource } from "../types.js";
import { findInstalled, isCheckpointFile } from "../comfyui/checkpoint-resolver.js";
import {
  downloadModelCandidate,
  downloadExplicitLoraSource,
} from "../comfyui/sprite-job.js";
import { resolveAndDownloadMissingModels, type ModelDownloadDeps } from "../comfyui/model-download.js";
import { buildWorkflowFromSpec } from "./spec-workflow.js";
import type { PromptSpec } from "./prompt-spec-types.js";

// ---------------------------------------------------------------------------
// Job bridge for the spec-file-driven pipeline — mirrors enqueueSpriteJob's
// resolve/build/validate/auto-download sequence (sprite-job.ts) but ends in a
// SAVE to the ComfyUI user library instead of an enqueue: this tool builds a
// workflow a user can inspect/run themselves, it never runs it on their behalf
// (pixelforge-mcp-n0f, confirmed with the user).
// ---------------------------------------------------------------------------

export interface SpecJobDeps extends ModelDownloadDeps {
  readonly listInstalledCheckpoints: () => Promise<LocalModel[]>;
  readonly validate: (workflow: WorkflowJSON) => Promise<ValidationResult>;
  readonly getObjectInfo: () => Promise<ObjectInfoLike>;
  readonly resetObjectInfoCache: () => void;
  readonly saveWorkflow: (filename: string, workflow: WorkflowJSON) => Promise<SaveWorkflowResult>;
}

/** An explicit, exact download source for one of the spec's `[LORA]` blocks,
 *  matched to it by `name` (must equal that block's `LoRA Name:` value). */
export interface SpecLoraSourceOverride extends SpriteLoraSource {
  readonly name: string;
}

export interface SpecWorkflowRequest {
  readonly spec: PromptSpec;
  /** Filename to save under, e.g. "my_spec.json". */
  readonly filename: string;
  /** Explicit opt-in (default false — never silent), same convention as
   *  generate_sprite's auto_download_missing. */
  readonly autoDownloadMissing?: boolean;
  /** Explicit, exact download source(s) for the spec's `[LORA]` block(s),
   *  used only when `autoDownloadMissing` is true and a named LoRA isn't
   *  installed. One entry per LoRA that needs an explicit source; LoRAs
   *  without a matching entry fall back to an exact-filename search match
   *  (never a "similar" substitute). */
  readonly loraSources?: readonly SpecLoraSourceOverride[];
}

export interface SpecWorkflowResult {
  readonly filename: string;
  readonly checkpoint: string;
  readonly vae?: string;
  readonly loras?: readonly string[];
  readonly downloadedModels?: DownloadedModelInfo[];
  readonly saveMessage: string;
}

const CHECKPOINT_DIR = "checkpoints";

/**
 * Pick the first spec-named checkpoint candidate that is actually installed;
 * falls back to the first (preferred) candidate when none are, so the
 * standard auto-download path can take over from there — same graceful-
 * degradation precedence as `resolveSpriteCheckpoint`.
 */
async function resolveCheckpointCandidate(
  candidates: readonly string[],
  list: () => Promise<LocalModel[]>,
): Promise<string> {
  let available: LocalModel[] = [];
  try {
    available = (await list()).filter((m) => isCheckpointFile(m.name));
  } catch {
    return candidates[0];
  }
  if (available.length === 0) return candidates[0];

  for (const candidate of candidates) {
    const hit = findInstalled(available, candidate);
    if (hit) return hit;
  }
  return candidates[0];
}

const DEFAULT_DEPS: SpecJobDeps = {
  listInstalledCheckpoints: () => listLocalModels(CHECKPOINT_DIR),
  validate: (workflow) => validateWorkflow(workflow, { health: false }),
  getObjectInfo: () => getObjectInfo(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
  resolveModelCandidates: (missing) => resolveCandidates(missing, liveResolveDeps()),
  downloadModelCandidate,
  downloadExplicitSource: downloadExplicitLoraSource,
  saveWorkflow: saveWorkflowToLibrary,
};

function summarizeValidationErrors(validation: ValidationResult): string {
  return validation.issues
    .filter((i) => i.severity === "error")
    .map((i) => i.message)
    .join("; ");
}

/**
 * Resolve the spec's checkpoint, build the workflow, validate it, optionally
 * auto-download whatever's missing (checkpoint/VAE/LoRA(s) — same rules as
 * `enqueueSpriteJob`: a LoRA never substitutes a "similar" file, only an
 * exact match or its `loraSources` entry fetched verbatim), then save it into
 * the connected ComfyUI server's workflow library so it opens in the web UI. Never enqueues
 * or runs the workflow.
 */
export async function buildAndSaveSpecWorkflow(
  request: SpecWorkflowRequest,
  deps: SpecJobDeps = DEFAULT_DEPS,
): Promise<SpecWorkflowResult> {
  const checkpoint = await resolveCheckpointCandidate(
    request.spec.checkpointCandidates,
    deps.listInstalledCheckpoints,
  );
  const { workflow } = buildWorkflowFromSpec(request.spec, checkpoint);

  let validation = await deps.validate(workflow);
  let downloaded: DownloadedModelInfo[] = [];

  if (!validation.valid && request.autoDownloadMissing) {
    const objectInfo = await deps.getObjectInfo();
    const missing = findMissingModels(workflow as unknown as Record<string, unknown>, objectInfo);

    if (missing.length > 0) {
      downloaded = await resolveAndDownloadMissingModels(workflow, missing, deps, {
        explicitSourceFor: (m) => request.loraSources?.find((s) => s.name === m.name),
      });
      deps.resetObjectInfoCache();
      validation = await deps.validate(workflow);
    }
  }

  if (!validation.valid) {
    throw new ValidationError(
      `workflow_from_prompt_spec: workflow failed validation before save (${validation.summary}): ` +
        summarizeValidationErrors(validation),
    );
  }

  const saveResult = await deps.saveWorkflow(request.filename, workflow);
  if (!saveResult.ok) {
    throw new ComfyUIError(saveResult.message, "SAVE_WORKFLOW_FAILED");
  }

  return {
    filename: request.filename,
    checkpoint,
    vae: request.spec.vae,
    loras: request.spec.loras.length > 0 ? request.spec.loras.map((l) => l.name) : undefined,
    downloadedModels: downloaded.length > 0 ? downloaded : undefined,
    saveMessage: saveResult.message,
  };
}
