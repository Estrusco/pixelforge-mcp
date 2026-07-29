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

function isCheckpointFile(name: string): boolean {
  const lower = name.toLowerCase();
  return CHECKPOINT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Match a candidate against the installed list by full name or by leaf name. */
function findInstalled(available: readonly LocalModel[], candidate: string): string | undefined {
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
): Promise<string> {
  const trimmedOverride = override?.trim();
  if (trimmedOverride) return trimmedOverride;

  const profile = STYLE_PROFILES[style];
  const preferred = profile.checkpointCandidates[0];

  let available: LocalModel[] = [];
  try {
    available = (await list("checkpoints")).filter((m) => isCheckpointFile(m.name));
  } catch (err) {
    logger.debug("Checkpoint listing failed; using the style's preferred candidate", { err });
    return preferred;
  }

  if (available.length === 0) return preferred;

  for (const candidate of profile.checkpointCandidates) {
    const hit = findInstalled(available, candidate);
    if (hit) return hit;
  }

  const familyHit = pickByFamily(available, profile.family);
  const chosen = familyHit ?? available[0].name;
  logger.info("No mapped checkpoint installed for sprite style; falling back", {
    style,
    family: profile.family,
    preferred,
    chosen,
  });
  return chosen;
}
