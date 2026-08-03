import type { WorkflowJSON } from "../../comfyui/types.js";
import { getObjectInfo, resetObjectInfoCache } from "../../comfyui/client.js";
import { downloadModel } from "../../services/model-resolver.js";
import { resolveCivitaiModel, resolveCivitaiModelVersion } from "../../services/civitai-resolver.js";
import {
  findMissingModels,
  liveResolveDeps,
  resolveCandidates,
  type MissingModel,
  type ModelCandidate,
  type ObjectInfoLike,
} from "../../services/missing-models.js";
import { validateWorkflow, type ValidationResult } from "../../services/workflow-validator.js";
import { enqueueWorkflow } from "../../services/workflow-executor.js";
import type { EnqueueWorkflowOptions } from "../../services/workflow-executor.js";
import { ValidationError } from "../../utils/errors.js";
import type { DownloadedModelInfo, SpriteLoraSource, Style } from "../types.js";
import type { SpriteJobRequest, SpriteJobResult } from "../types.js";
import { resolveSpriteCheckpoint, type ResolvedCheckpoint } from "./checkpoint-resolver.js";
import { buildSpriteWorkflow } from "./sprite-workflow.js";

// ---------------------------------------------------------------------------
// Job bridge — a thin wrapper over the INHERITED queue machinery. It resolves a
// checkpoint, builds the graph, validates it, optionally auto-downloads a
// missing checkpoint, and hands it to enqueueWorkflow. It must never grow its
// own queueing, polling, WebSocket, or VRAM logic (CLAUDE.md).
// ---------------------------------------------------------------------------

/** Internal injection seam. Callers pass a request and nothing else. */
export interface SpriteJobDeps {
  readonly resolveCheckpoint: (style: Style, override?: string) => Promise<ResolvedCheckpoint>;
  readonly enqueue: (
    workflow: WorkflowJSON,
    options: EnqueueWorkflowOptions,
  ) => Promise<{ prompt_id: string; queue_remaining?: number }>;
  /** Validate the built graph before submit (pixelforge-mcp-7dc.3). */
  readonly validate: (workflow: WorkflowJSON) => Promise<ValidationResult>;
  /** Only called when `autoDownloadMissing` and `validate()` reported a missing model. */
  readonly getObjectInfo: () => Promise<ObjectInfoLike>;
  /** Drop the MCP's own client-side /object_info cache after a download lands a
   *  new file, or a freshly-downloaded model still looks "missing" on re-validate. */
  readonly resetObjectInfoCache: () => void;
  readonly resolveModelCandidates: (missing: MissingModel) => Promise<ModelCandidate[]>;
  /** Download `candidate` for `missing`. Throws on failure; does not return the
   *  installed filename because the caller already knows it (`candidate.filename`,
   *  passed to the downloader verbatim as the target filename). */
  readonly downloadModelCandidate: (missing: MissingModel, candidate: ModelCandidate) => Promise<void>;
  /** Fetch an explicit `SpriteLoraSource` VERBATIM under `filename` — no search,
   *  no ranking, so a "similar" LoRA can never be substituted (pixelforge-mcp-7dc.1). */
  readonly downloadExplicitSource: (
    directory: string,
    filename: string,
    source: SpriteLoraSource,
  ) => Promise<void>;
}

/**
 * Resolve `missing` to a real download URL and fetch it under `candidate.filename`
 * — an EXPLICIT target filename (never the source's own suggested name), so the
 * workflow can be repointed at exactly what got installed regardless of whether
 * the ranked candidate was an exact-name match or a same-model different-format
 * fallback (see `enqueueSpriteJob`'s post-download rewire).
 */
export async function downloadModelCandidate(missing: MissingModel, candidate: ModelCandidate): Promise<void> {
  if (!missing.directory) {
    throw new ValidationError(
      `generate_sprite: "${missing.name}" (needed by ${missing.node_type}.${missing.widget}) is missing, ` +
        "and its target models/ subdirectory could not be inferred, so it cannot be auto-downloaded. " +
        "Install it manually with download_model / download_civitai_model.",
    );
  }
  if (candidate.source === "huggingface") {
    if (!candidate.url) {
      throw new ValidationError(`generate_sprite: candidate "${candidate.filename}" has no download URL.`);
    }
    await downloadModel(candidate.url, missing.directory, candidate.filename);
    return;
  }
  const resolved =
    candidate.civitai_version_id !== undefined
      ? await resolveCivitaiModelVersion(candidate.civitai_version_id)
      : candidate.civitai_model_id !== undefined
        ? await resolveCivitaiModel(candidate.civitai_model_id)
        : undefined;
  if (!resolved) {
    throw new ValidationError(
      `generate_sprite: candidate "${candidate.filename}" has no CivitAI model/version id to resolve.`,
    );
  }
  await downloadModel(resolved.downloadUrl, missing.directory, candidate.filename);
}

/**
 * Fetch `source` VERBATIM under `filename` — no keyword search, no candidate
 * ranking. This is the "exact model, no substitution" path pixelforge-mcp-7dc.1
 * exists for: a caller who knows exactly which LoRA it wants (e.g.
 * nerijs/pixel-art-xl) names its source precisely instead of hoping a
 * fuzzy/stem search match happens to land on the same file.
 * Resolution order when more than one field is set: civitaiVersionId >
 * civitaiModelId > the huggingface pair.
 */
export async function downloadExplicitLoraSource(
  directory: string,
  filename: string,
  source: SpriteLoraSource,
): Promise<void> {
  if (source.civitaiVersionId !== undefined) {
    const resolved = await resolveCivitaiModelVersion(source.civitaiVersionId);
    await downloadModel(resolved.downloadUrl, directory, filename);
    return;
  }
  if (source.civitaiModelId !== undefined) {
    const resolved = await resolveCivitaiModel(source.civitaiModelId);
    await downloadModel(resolved.downloadUrl, directory, filename);
    return;
  }
  if (source.huggingfaceRepo && source.huggingfaceFilename) {
    const repoPath = source.huggingfaceRepo.split("/").map(encodeURIComponent).join("/");
    const url = `https://huggingface.co/${repoPath}/resolve/main/${source.huggingfaceFilename}`;
    await downloadModel(url, directory, filename);
    return;
  }
  throw new ValidationError(
    "generate_sprite: lora.source must set civitai_version_id, civitai_model_id, or both " +
      "huggingface_repo and huggingface_filename.",
  );
}

const DEFAULT_DEPS: SpriteJobDeps = {
  resolveCheckpoint: (style, override) => resolveSpriteCheckpoint(style, override),
  enqueue: (workflow, options) => enqueueWorkflow(workflow, options),
  // Health heuristics (disconnected nodes, duplicate loads, …) never flip
  // `valid` and aren't surfaced by this tool layer — skip them for speed.
  validate: (workflow) => validateWorkflow(workflow, { health: false }),
  getObjectInfo: () => getObjectInfo(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
  resolveModelCandidates: (missing) => resolveCandidates(missing, liveResolveDeps()),
  downloadModelCandidate,
  downloadExplicitSource: downloadExplicitLoraSource,
};

function summarizeValidationErrors(validation: ValidationResult): string {
  return validation.issues
    .filter((i) => i.severity === "error")
    .map((i) => i.message)
    .join("; ");
}

/**
 * Build and enqueue one sprite generation job. Fire-and-forget: resolves as soon
 * as ComfyUI accepts the prompt.
 *
 * `disable_random_seed: true` is REQUIRED. enqueueWorkflow otherwise rewrites
 * every `seed` / `noise_seed` input with a fresh random value, which would make
 * the seed reported back to the caller a lie and break both reproduction and
 * generate_animation_set's frame-to-frame consistency.
 *
 * Validates the built graph before submit (always — read-only, no consent
 * needed) so a malformed graph is reported here instead of failing later at
 * ComfyUI. When validation fails ONLY because of missing model(s) AND the
 * caller passed `autoDownloadMissing: true` (explicit opt-in, never silent —
 * pixelforge-mcp-7dc.2), each missing model is resolved and downloaded, the
 * workflow is rewired to reference what was actually installed, and the graph
 * is re-validated before enqueueing:
 *   - Checkpoint: the best-ranked CivitAI/HuggingFace candidate (may be a
 *     same-model different-format fallback).
 *   - LoRA with `request.lora.source` set: that source is fetched VERBATIM
 *     under the requested filename — no search, no ranking, so it can never
 *     resolve to a "similar" LoRA instead of the one actually named
 *     (pixelforge-mcp-7dc.1).
 *   - LoRA with no `source`: only an EXACT filename match from the ranked
 *     candidates is accepted; a stem/fuzzy "similar" match is rejected rather
 *     than silently substituted.
 * Any other validation failure (or a failed/absent auto-download) is a thrown
 * `ValidationError`, never a silent enqueue of a broken graph.
 */
export async function enqueueSpriteJob(
  request: SpriteJobRequest,
  deps: SpriteJobDeps = DEFAULT_DEPS,
): Promise<SpriteJobResult> {
  const { checkpoint, familyMismatchWarning } = await deps.resolveCheckpoint(request.style, request.checkpoint);
  const { workflow, mode } = buildSpriteWorkflow(request, checkpoint);

  let validation = await deps.validate(workflow);
  const downloaded: DownloadedModelInfo[] = [];

  if (!validation.valid && request.autoDownloadMissing) {
    const objectInfo = await deps.getObjectInfo();
    const missing = findMissingModels(workflow as unknown as Record<string, unknown>, objectInfo);

    if (missing.length > 0) {
      for (const m of missing) {
        const isLora = m.directory === "loras";
        // An explicit lora.source is a caller-named EXACT model — fetch it
        // verbatim, bypassing search/ranking entirely, so no "similar" LoRA can
        // ever be substituted for the one actually requested.
        const explicitSource = isLora && request.lora?.name === m.name ? request.lora.source : undefined;

        if (explicitSource) {
          await deps.downloadExplicitSource(m.directory as string, m.name, explicitSource);
          // Installed under the exact requested filename — no rewire needed.
          downloaded.push({
            requested: m.name,
            installed: m.name,
            source: explicitSource.civitaiVersionId !== undefined || explicitSource.civitaiModelId !== undefined
              ? "civitai"
              : "huggingface",
            nodeType: m.node_type,
          });
          continue;
        }

        const candidates = await deps.resolveModelCandidates(m);
        // Already ranked exact-match-first, then best VRAM fit (rankCandidates).
        // LoRA without an explicit source: restrict to an EXACT filename match
        // only — never fall back to a stem/fuzzy "similar" candidate.
        const pool = isLora ? candidates.filter((c) => c.match === "exact") : candidates;
        const best = pool[0];
        if (!best) {
          throw new ValidationError(
            isLora
              ? `generate_sprite: LoRA "${m.name}" (needed by ${m.node_type}.${m.widget}) is not ` +
                  "installed, and no EXACT filename match was found on CivitAI/HuggingFace — a " +
                  "\"similar\" LoRA is never substituted automatically. Pass lora.source with an " +
                  "explicit civitai_version_id/civitai_model_id, or huggingface_repo + " +
                  "huggingface_filename, or install it manually."
              : `generate_sprite: "${m.name}" (needed by ${m.node_type}.${m.widget}) is not installed, and ` +
                  "auto_download_missing found no installable candidate on CivitAI or HuggingFace. Install it " +
                  "manually, or pass an explicit checkpoint override.",
          );
        }
        await deps.downloadModelCandidate(m, best);
        // Rewire the graph at whatever actually got installed — correct even when
        // `best` was a stem/fuzzy match under a different filename than `m.name`.
        workflow[m.node_id].inputs[m.widget] = best.filename;
        downloaded.push({
          requested: m.name,
          installed: best.filename,
          source: best.source,
          nodeType: m.node_type,
        });
      }
      deps.resetObjectInfoCache();
      validation = await deps.validate(workflow);
    }
  }

  if (!validation.valid) {
    throw new ValidationError(
      `generate_sprite: workflow failed validation before submit (${validation.summary}): ` +
        summarizeValidationErrors(validation),
    );
  }

  const { prompt_id, queue_remaining } = await deps.enqueue(workflow, {
    disable_random_seed: true,
  });

  return {
    promptId: prompt_id,
    queueRemaining: queue_remaining,
    checkpoint,
    seed: request.seed,
    mode,
    downloadedModels: downloaded.length > 0 ? downloaded : undefined,
    checkpointFamilyWarning: familyMismatchWarning,
  };
}
