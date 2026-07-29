import { createHash } from "node:crypto";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { AssetRegistry } from "../services/asset-registry.js";
import { stageOutputAsInput, uploadImageAuto } from "../services/image-management.js";
import { resolveOutputDir } from "../services/output-dir.js";
import { ComfyUIError, ValidationError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Reference-image staging — resolves a caller-supplied reference (a registered
// asset id OR a filesystem path) into a bare filename already present in
// ComfyUI's input directory, ready to drop into a LoadImage widget.
//
// Tool-layer staging concern, not workflow-JSON construction, so it lives at
// `src/sprite/`, not under `src/sprite/comfyui/`. Shared by generate_sprite,
// generate_animation_set (`base_image`), and generate_arcade_topdown_set.
// ---------------------------------------------------------------------------

// Namespace for reference images this module stages into ComfyUI's input dir,
// so they can never collide with a user's own uploads.
const STAGED_PREFIX = "pixelforge_ref_";

/** Same path-safety rule as pixelate_image: absolute, or inside the output dir. */
async function resolveSafePath(path: string): Promise<string> {
  if (path.trim().length === 0) {
    throw new ValidationError("reference_path must be a non-empty string.");
  }
  if (isAbsolute(path)) return resolve(path);
  const outputDir = await resolveOutputDir();
  const resolved = resolve(outputDir, path);
  if (resolved !== outputDir && !resolved.startsWith(outputDir + sep)) {
    throw new ValidationError("A relative reference_path must stay within the ComfyUI output directory.");
  }
  return resolved;
}

function stagedName(key: string, sourceFilename: string): string {
  const ext = extname(sourceFilename).toLowerCase();
  if (!ext) {
    throw new ValidationError(
      `Cannot determine an image format for "${sourceFilename}" — it has no file extension.`,
    );
  }
  return `${STAGED_PREFIX}${key}${ext}`;
}

export interface StagedReference {
  /** Bare filename inside ComfyUI's input directory, ready for LoadImage. */
  readonly filename: string;
  /** Human-readable origin, for the tool response. */
  readonly source: string;
}

/**
 * Resolve a caller-supplied reference image (asset id OR path) into a filename
 * that lives in ComfyUI's input directory.
 *
 * Both routes go through the ComfyUI server API (/view + /upload/image), so they
 * are correct even when ComfyUI runs with a custom input/output directory or on
 * a remote host. The staged filename is derived deterministically from the
 * source, so repeat calls overwrite the same input file instead of littering it.
 *
 * Callers: generate_sprite, generate_animation_set (`base_image`), and
 * generate_arcade_topdown_set.
 */
export async function resolveReferenceImage(
  assetId: string | undefined,
  path: string | undefined,
): Promise<StagedReference | undefined> {
  if (assetId !== undefined && path !== undefined) {
    throw new ValidationError(
      "Provide at most one reference image source: reference_asset_id or reference_path.",
    );
  }

  if (assetId !== undefined) {
    const record = AssetRegistry.get(assetId);
    if (!record) {
      throw new ValidationError(
        `No asset found for id "${assetId}". It may have expired or never been registered.`,
      );
    }
    // Already an input — ComfyUI can load it as-is, no staging round-trip.
    if (record.type === "input") {
      return { filename: record.filename, source: `asset ${assetId} (${record.filename})` };
    }
    const sourceType: "output" | "temp" = record.type === "temp" ? "temp" : "output";
    try {
      const staged = await stageOutputAsInput({
        filename: record.filename,
        subfolder: record.subfolder,
        type: sourceType,
        kind: "image",
        asFilename: stagedName(assetId, record.filename),
      });
      return { filename: staged.filename, source: `asset ${assetId} (${record.filename})` };
    } catch (err) {
      if (err instanceof ComfyUIError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`Failed to stage asset "${assetId}" as a ComfyUI input: ${message}`);
    }
  }

  if (path !== undefined) {
    const resolved = await resolveSafePath(path);
    const key = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    try {
      const uploaded = await uploadImageAuto(resolved, stagedName(key, resolved));
      return { filename: uploaded.filename, source: resolved };
    } catch (err) {
      if (err instanceof ComfyUIError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Failed to upload reference image "${resolved}" to ComfyUI: ${message}`,
      );
    }
  }

  return undefined;
}
