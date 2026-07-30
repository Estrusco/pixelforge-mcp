import { ValidationError } from "../../utils/errors.js";
import type { SpritesheetMetadata } from "../types.js";

// ---------------------------------------------------------------------------
// Boundary validation for a caller-supplied `SpritesheetMetadata` object.
//
// pack_spritesheet builds this document itself, so it never needs this check.
// export_for_engine instead RECEIVES it as external input (typically pasted
// back from a prior pack_spritesheet call, but not provably so) — that makes
// it a system boundary, and a stale or hand-edited copy must fail loudly
// rather than translate into silently wrong Unity rects.
// ---------------------------------------------------------------------------

export function assertMetadataConsistent(metadata: SpritesheetMetadata): void {
  if (metadata.frames.length === 0) {
    throw new ValidationError("metadata.frames must be a non-empty array.");
  }
  if (metadata.frames.length !== metadata.frame_count) {
    throw new ValidationError(
      `metadata.frame_count (${metadata.frame_count}) does not match metadata.frames.length ` +
        `(${metadata.frames.length}) — this metadata does not describe a single consistent sheet.`,
    );
  }
  for (const rect of metadata.frames) {
    const inBounds =
      rect.x >= 0 &&
      rect.y >= 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.x + rect.width <= metadata.sheet_width &&
      rect.y + rect.height <= metadata.sheet_height;
    if (!inBounds) {
      throw new ValidationError(
        `metadata.frames[${rect.index}] (x=${rect.x}, y=${rect.y}, ${rect.width}x${rect.height}) ` +
          `falls outside the declared ${metadata.sheet_width}x${metadata.sheet_height} sheet bounds.`,
      );
    }
  }
}

/** The sheet image actually loaded must be the exact sheet the metadata describes. */
export function assertSheetMatchesMetadata(
  actual: { width: number; height: number },
  metadata: SpritesheetMetadata,
): void {
  if (actual.width !== metadata.sheet_width || actual.height !== metadata.sheet_height) {
    throw new ValidationError(
      `The sheet image is ${actual.width}x${actual.height} but metadata describes a ` +
        `${metadata.sheet_width}x${metadata.sheet_height} sheet — they must be the exact same ` +
        "pack_spritesheet output.",
    );
  }
}
