import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { AssetRegistry } from "../services/asset-registry.js";
import { getOutputImage } from "../services/image-management.js";
import { resolveOutputDir } from "../services/output-dir.js";
import { ValidationError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Disk/ComfyUI image I/O for the sprite tool layer: turn a caller-supplied
// "asset_id OR path" pair into bytes, and vet a caller-supplied out_path.
//
// This is the ONLY place the sprite layer reads source images from; the
// packing/ and postprocess/ modules stay pure (buffers in, buffers out).
// ---------------------------------------------------------------------------

/** Where an image came from — asset id or filesystem path, never both. */
export interface ImageSourceRef {
  readonly assetId?: string;
  readonly path?: string;
}

export interface LoadedImage {
  /** Human-readable origin, echoed in tool responses. */
  readonly label: string;
  readonly bytes: Buffer;
}

/** Path safety: absolute paths pass; relative ones must stay inside the output dir. */
export async function resolveReadablePath(path: string, label: string): Promise<string> {
  if (path.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string.`);
  }
  if (isAbsolute(path)) return resolve(path);
  const outputDir = await resolveOutputDir();
  const resolved = resolve(outputDir, path);
  if (resolved !== outputDir && !resolved.startsWith(outputDir + sep)) {
    throw new ValidationError(`A relative ${label} must stay within the ComfyUI output directory.`);
  }
  return resolved;
}

/** Same rule for writes, so a tool can never be talked into writing outside it. */
export async function resolveWritableOutputPath(path: string, label: string): Promise<string> {
  if (path.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty path.`);
  }
  const outputDir = await resolveOutputDir();
  const resolved = isAbsolute(path) ? resolve(path) : resolve(outputDir, path);
  if (resolved !== outputDir && !resolved.startsWith(outputDir + sep)) {
    throw new ValidationError(`${label} must stay within the ComfyUI output directory.`);
  }
  return resolved;
}

/**
 * Load one image from exactly one of `assetId` / `path`.
 *
 * `context` prefixes every error so a caller packing 16 frames learns WHICH
 * entry was wrong ("frames[7]: ..."), not just that something was.
 */
export async function loadImageSource(
  ref: ImageSourceRef,
  context: string,
): Promise<LoadedImage> {
  const hasAsset = ref.assetId !== undefined && ref.assetId.trim().length > 0;
  const hasPath = ref.path !== undefined && ref.path.trim().length > 0;
  if (hasAsset === hasPath) {
    throw new ValidationError(`${context}: provide exactly one image source, asset_id or path.`);
  }

  if (hasAsset) {
    const assetId = ref.assetId!;
    const record = AssetRegistry.get(assetId);
    if (!record) {
      throw new ValidationError(
        `${context}: no asset found for id "${assetId}". It may have expired or never been registered.`,
      );
    }
    const validType = record.type === "output" || record.type === "input" || record.type === "temp";
    const fetchType: "output" | "input" | "temp" = validType
      ? (record.type as "output" | "input" | "temp")
      : "output";
    const image = await getOutputImage(record.filename, fetchType, record.subfolder);
    return {
      label: `asset ${assetId} (${record.filename})`,
      bytes: Buffer.from(image.base64, "base64"),
    };
  }

  const resolved = await resolveReadablePath(ref.path!, `${context} path`);
  try {
    return { label: resolved, bytes: await readFile(resolved) };
  } catch {
    throw new ValidationError(`${context}: source image not found or unreadable: ${resolved}`);
  }
}
