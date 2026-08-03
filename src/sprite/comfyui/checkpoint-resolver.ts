import { listLocalModels } from "../../services/model-resolver.js";
import type { LocalModel } from "../../services/model-resolver.js";
import { logger } from "../../utils/logger.js";
import type { Style } from "../types.js";
import { STYLE_PROFILES } from "./style-profiles.js";
import type { ModelFamily } from "./style-profiles.js";

// ---------------------------------------------------------------------------
// style -> checkpoint resolution, with graceful degradation.
//
// The developer's ComfyUI may not have any of the checkpoints a style names, so
// this NEVER hard-fails on a missing model file: a tool that refuses to run out
// of the box is worse than one that runs on a suboptimal checkpoint. The
// checkpoint actually chosen is echoed back to the caller by the tool layer.
//
// Precedence: caller override > named candidate installed locally > same-family
// local checkpoint > any local checkpoint > the style's preferred candidate name
// (let ComfyUI produce the authoritative "model not found" error).
// ---------------------------------------------------------------------------

/** Injection seam so callers/tests can supply a model listing. Internal. */
export type CheckpointLister = (modelType: string) => Promise<LocalModel[]>;

export interface ResolvedCheckpoint {
  readonly checkpoint: string;
  /**
   * Set ONLY when the fallback path (no candidate named by the style is
   * installed) landed on a checkpoint that does not even match the style's
   * expected `ModelFamily` — e.g. style `32bit` wants sd15 but only SDXL is
   * installed locally, so `pickByFamily` had to fall back further than "same
   * family, unnamed file". Never set for an explicit `override` (the caller's
   * choice is respected without second-guessing) or when no local checkpoints
   * exist at all (nothing to compare `preferred` against).
   */
  readonly familyMismatchWarning?: string;
}

const CHECKPOINT_EXTENSIONS = [".safetensors", ".ckpt", ".sft", ".pt"];

/**
 * Family hints for ranking an unknown local checkpoint. Deliberately crude —
 * this only runs when the named candidates are all absent, and picking a
 * plausible model beats picking none.
 */
const FAMILY_HINTS: Record<ModelFamily, { prefer: RegExp; avoid: RegExp }> = {
  sdxl: {
    prefer: /(sdxl|xl[._-]|[._-]xl|pony|illustrious|juggernaut|animagine)/i,
    avoid: /(sd15|sd[._-]1[._-]5|v1-5|1\.5)/i,
  },
  sd15: {
    prefer: /(sd15|sd[._-]1[._-]5|v1-5|1[._-]5|dreamshaper|realistic[._-]?vision|epicrealism)/i,
    avoid: /(sdxl|xl)/i,
  },
};

/** ComfyUI reports nested models as "SD1.5/foo.safetensors"; compare on the leaf. */
function leafName(name: string): string {
  const parts = name.split(/[/\\]+/);
  return (parts[parts.length - 1] ?? name).toLowerCase();
}

export function isCheckpointFile(name: string): boolean {
  const lower = name.toLowerCase();
  return CHECKPOINT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Match a candidate against the installed list by full name or by leaf name. */
export function findInstalled(available: readonly LocalModel[], candidate: string): string | undefined {
  const wanted = leafName(candidate);
  const hit = available.find(
    (m) => m.name.toLowerCase() === candidate.toLowerCase() || leafName(m.name) === wanted,
  );
  return hit?.name;
}

function pickByFamily(available: readonly LocalModel[], family: ModelFamily): string | undefined {
  const { prefer, avoid } = FAMILY_HINTS[family];
  const preferred = available.find((m) => prefer.test(m.name) && !avoid.test(m.name));
  if (preferred) return preferred.name;
  const neutral = available.find((m) => !avoid.test(m.name));
  return neutral?.name;
}

/**
 * Resolve the checkpoint filename for a sprite job.
 *
 * `override` is the caller's explicit `checkpoint` param and ALWAYS wins — it is
 * passed through untouched, without an existence check, so a caller can name a
 * model this process cannot enumerate (remote ComfyUI, extra_model_paths).
 */
export async function resolveSpriteCheckpoint(
  style: Style,
  override?: string,
  list: CheckpointLister = listLocalModels,
): Promise<ResolvedCheckpoint> {
  const trimmedOverride = override?.trim();
  if (trimmedOverride) return { checkpoint: trimmedOverride };

  const profile = STYLE_PROFILES[style];
  const preferred = profile.checkpointCandidates[0];

  let available: LocalModel[] = [];
  try {
    available = (await list("checkpoints")).filter((m) => isCheckpointFile(m.name));
  } catch (err) {
    logger.debug("Checkpoint listing failed; using the style's preferred candidate", { err });
    return { checkpoint: preferred };
  }

  if (available.length === 0) return { checkpoint: preferred };

  for (const candidate of profile.checkpointCandidates) {
    const hit = findInstalled(available, candidate);
    if (hit) return { checkpoint: hit };
  }

  const familyHit = pickByFamily(available, profile.family);
  const chosen = familyHit ?? available[0].name;
  logger.info("No mapped checkpoint installed for sprite style; falling back", {
    style,
    family: profile.family,
    preferred,
    chosen,
  });

  // pickByFamily's own "preferred" branch already matches these hints, so this
  // is a no-op warning-wise on that path — it only fires when the fallback had
  // to go further still (the "neutral" branch, or no local checkpoint at all
  // avoids `avoid`/`prefer` cleanly, or the blind `available[0]` pick).
  const { prefer, avoid } = FAMILY_HINTS[profile.family];
  const matchesExpectedFamily = prefer.test(chosen) && !avoid.test(chosen);
  const familyMismatchWarning = matchesExpectedFamily
    ? undefined
    : `style "${style}" expects a ${profile.family} checkpoint, but none is installed — using ` +
      `"${chosen}" instead (a different base-model family). Results may look wrong for this style. ` +
      `Pass an explicit checkpoint override, or install a ${profile.family} checkpoint.`;

  return { checkpoint: chosen, familyMismatchWarning };
}
