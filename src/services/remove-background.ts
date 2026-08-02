import type { WorkflowJSON } from "../comfyui/types.js";
import { createWorkflow } from "./workflow-composer.js";
import { DefaultsManager } from "./defaults-manager.js";
import { ValidationError } from "../utils/errors.js";
import {
  assertSafeInputFilename,
  assertSafeFilenamePrefix,
} from "../utils/input-paths.js";

export interface RemoveBackgroundArgs {
  /** Filename (in ComfyUI's input dir) of the image to cut out. Upload it first
   *  with upload_image, or stage an output with stage_output_as_input. */
  image: string;
  /** "birefnet" (default, salient-object matting) or "luma_key" (core-node-only
   *  luminance key — no custom node dependency, soft continuous alpha). */
  mode?: "birefnet" | "luma_key";
  /** BiRefNet matting model; auto-downloaded by ComfyUI-RMBG on first run.
   *  birefnet mode only. */
  model?: string;
  filename_prefix?: string;
  /** luma_key mode only: 0-1 cutoff on the combined R+G+B mask. Omit for the
   *  original continuous (unthresholded) mask. */
  threshold?: number;
  /** luma_key mode only: GrowMask expand (pixels, can be negative) applied
   *  before inverting. Omit to skip. */
  softness?: number;
}

export interface RemoveBackgroundDeps {
  /** Returns true/false if the node's install state is known, or undefined when
   *  it can't be determined (no running server) — in which case we proceed and
   *  let execution surface any problem. */
  isNodeInstalled?: (classType: string) => Promise<boolean | undefined>;
  enqueue: (workflow: WorkflowJSON) => Promise<{ prompt_id: string; queue_remaining?: number }>;
}

export interface RemoveBackgroundResult {
  prompt_id: string;
  queue_remaining?: number;
  mode: "birefnet" | "luma_key";
  /** BiRefNet model used. Undefined for luma_key (no model involved). */
  model?: string;
}

/** The ComfyUI-RMBG node class that does the matting (birefnet mode only). */
export const REMBG_NODE = "BiRefNetRMBG";

const DEFAULTABLE_KEYS = ["model", "filename_prefix"] as const;

/**
 * Build + enqueue a background-removal workflow, returning a transparent
 * cutout. "birefnet" (default) uses ComfyUI-RMBG's salient-object matting —
 * requires that custom node pack, and we throw an actionable error instead of
 * enqueuing a graph that will fail at runtime if we can confirm it's absent.
 * "luma_key" builds a LoadImage -> R/G/B ImageToMask -> MaskComposite(add) x2
 * -> [ThresholdMask] -> [GrowMask] -> InvertMask -> JoinImageWithAlpha graph
 * from ComfyUI's comfy-core mask nodes only — no custom node dependency, so
 * no install check is needed for it.
 */
export async function removeBackground(
  args: RemoveBackgroundArgs,
  deps: RemoveBackgroundDeps,
): Promise<RemoveBackgroundResult> {
  if (!args.image || !args.image.trim()) {
    throw new ValidationError(
      "image is required — the filename of an image already in ComfyUI's input dir " +
        "(upload it first with upload_image, or stage an output with stage_output_as_input).",
    );
  }
  assertSafeInputFilename(args.image, "image");

  const mode = args.mode ?? "birefnet";

  if (mode === "birefnet") {
    if (args.threshold !== undefined || args.softness !== undefined) {
      throw new ValidationError(
        "threshold and softness only apply to mode \"luma_key\" — they have no effect on BiRefNet matting.",
      );
    }
  } else {
    if (args.model !== undefined) {
      throw new ValidationError('model only applies to mode "birefnet" — luma_key uses no model.');
    }
    if (args.threshold !== undefined && (args.threshold < 0 || args.threshold > 1)) {
      throw new ValidationError(`threshold must be between 0 and 1 (got ${args.threshold}).`);
    }
  }

  if (mode === "birefnet" && deps.isNodeInstalled) {
    const installed = await deps.isNodeInstalled(REMBG_NODE);
    if (installed === false) {
      throw new ValidationError(
        `The background-removal node "${REMBG_NODE}" (ComfyUI-RMBG) is not installed. ` +
          "Install it with apply_manifest --path packs/wan-transparent/manifest.yaml, " +
          "or install_custom_node id 'comfyui-rmbg'. The BiRefNet model auto-downloads " +
          "into models/RMBG/BiRefNet/ on first run. Alternatively use mode \"luma_key\", which " +
          "needs no custom node.",
      );
    }
  }

  const argsRecord = args as unknown as Record<string, unknown>;
  const seed: Record<string, unknown> = {};
  for (const key of DEFAULTABLE_KEYS) {
    const v = argsRecord[key];
    if (v !== undefined) seed[key] = v;
  }
  const resolved = DefaultsManager.apply(seed);

  // Validate the RESOLVED prefix (post-defaults) — a malicious default
  // filename_prefix must not reach SaveImage unsanitized.
  if (resolved.filename_prefix !== undefined) {
    assertSafeFilenamePrefix(resolved.filename_prefix as string);
  }

  const workflow = createWorkflow("remove_background", {
    image_path: args.image,
    mode,
    model: mode === "birefnet" ? (resolved.model as string | undefined) : undefined,
    filename_prefix: resolved.filename_prefix as string | undefined,
    threshold: args.threshold,
    softness: args.softness,
  });

  const { prompt_id, queue_remaining } = await deps.enqueue(workflow);

  if (mode === "luma_key") {
    return { prompt_id, queue_remaining, mode };
  }
  const model = (workflow["2"]?.inputs.model as string | undefined) ?? "BiRefNet_toonout";
  return { prompt_id, queue_remaining, mode, model };
}
