import type { WorkflowJSON } from "../../comfyui/types.js";
import {
  type MissingModel,
  type ModelCandidate,
} from "../../services/missing-models.js";
import { ValidationError } from "../../utils/errors.js";
import type { DownloadedModelInfo, SpriteLoraSource } from "../types.js";

// ---------------------------------------------------------------------------
// Shared "resolve one missing model, download it, rewire the graph" loop.
//
// Extracted from enqueueSpriteJob (pixelforge-mcp-n0f.3) so it can be reused by
// any caller that builds a workflow and wants the same auto-download semantics
// — currently `enqueueSpriteJob` (sprite-job.ts) and the spec-file-driven
// `workflow_from_prompt_spec` (spec/spec-job.ts). Behavior is unchanged from
// the original inline loop; only the LoRA-source lookup is generalized from a
// single hardcoded `request.lora` field to an injected `explicitSourceFor`
// callback.
// ---------------------------------------------------------------------------

export interface ModelDownloadDeps {
  readonly resolveModelCandidates: (missing: MissingModel) => Promise<ModelCandidate[]>;
  /** Download `candidate` for `missing`. Throws on failure. */
  readonly downloadModelCandidate: (missing: MissingModel, candidate: ModelCandidate) => Promise<void>;
  /** Fetch an explicit `SpriteLoraSource` VERBATIM under `filename` — no search,
   *  no ranking, so a "similar" LoRA can never be substituted. */
  readonly downloadExplicitSource: (
    directory: string,
    filename: string,
    source: SpriteLoraSource,
  ) => Promise<void>;
}

export interface ResolveAndDownloadOptions {
  /** Called only for a missing model in the `loras` directory. Returning a
   *  source fetches it verbatim, bypassing search/ranking entirely
   *  (pixelforge-mcp-7dc.1). Return `undefined` to fall back to the ranked,
   *  exact-match-only candidate search. */
  readonly explicitSourceFor?: (missing: MissingModel) => SpriteLoraSource | undefined;
}

/**
 * Resolve and download every entry in `missing`, rewiring `workflow` in place
 * to reference whatever actually got installed. Mutates `workflow`.
 *
 * - Checkpoint/VAE/other: the best-ranked CivitAI/HuggingFace candidate (may be
 *   a same-model different-format fallback).
 * - LoRA (`missing.directory === "loras"`) with an explicit source from
 *   `opts.explicitSourceFor`: fetched VERBATIM under the requested filename —
 *   no search, no ranking.
 * - LoRA with no explicit source: only an EXACT filename match from the ranked
 *   candidates is accepted; a stem/fuzzy "similar" match is rejected rather
 *   than silently substituted.
 *
 * Throws `ValidationError` (never silently proceeds) when a missing model has
 * no explicit source and no installable candidate is found.
 */
export async function resolveAndDownloadMissingModels(
  workflow: WorkflowJSON,
  missing: readonly MissingModel[],
  deps: ModelDownloadDeps,
  opts: ResolveAndDownloadOptions = {},
): Promise<DownloadedModelInfo[]> {
  const downloaded: DownloadedModelInfo[] = [];

  for (const m of missing) {
    const isLora = m.directory === "loras";
    const explicitSource = isLora ? opts.explicitSourceFor?.(m) : undefined;

    if (explicitSource) {
      await deps.downloadExplicitSource(m.directory as string, m.name, explicitSource);
      // Installed under the exact requested filename — no rewire needed.
      downloaded.push({
        requested: m.name,
        installed: m.name,
        source:
          explicitSource.civitaiVersionId !== undefined || explicitSource.civitaiModelId !== undefined
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
          ? `LoRA "${m.name}" (needed by ${m.node_type}.${m.widget}) is not installed, and no ` +
              "EXACT filename match was found on CivitAI/HuggingFace — a \"similar\" LoRA is never " +
              "substituted automatically. Pass an explicit download source, or install it manually."
          : `"${m.name}" (needed by ${m.node_type}.${m.widget}) is not installed, and no installable ` +
              "candidate was found on CivitAI or HuggingFace. Install it manually, or pass an " +
              "explicit override.",
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

  return downloaded;
}
