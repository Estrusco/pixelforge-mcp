import { ValidationError } from "../../utils/errors.js";
import {
  DEFAULT_SPRITESHEET_FPS,
  DEFAULT_SPRITE_PIVOT,
  SPRITESHEET_MAX_FRAMES,
  SPRITESHEET_MAX_FPS,
  SPRITESHEET_MAX_SHEET_DIMENSION,
  SPRITESHEET_MIN_FPS,
} from "../types.js";
import type {
  Dimensions,
  SpritePivot,
  SpritesheetFrameRect,
  SpritesheetLayout,
  SpritesheetMetadata,
  SpritesheetPackOptions,
} from "../types.js";

// ---------------------------------------------------------------------------
// Pure geometry. No images, no sharp, no disk — frame COUNT plus frame SIZE in,
// a fully validated `SpritesheetMetadata` out.
//
// Splitting this from the compositor is what makes the sheet layout testable
// (and reusable by export_for_engine) without ever decoding a PNG.
// ---------------------------------------------------------------------------

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${label} must be a positive integer (got ${String(value)}).`);
  }
  return value;
}

function assertFps(fps: number): number {
  if (!Number.isFinite(fps) || fps < SPRITESHEET_MIN_FPS || fps > SPRITESHEET_MAX_FPS) {
    throw new ValidationError(
      `fps must be a number between ${SPRITESHEET_MIN_FPS} and ${SPRITESHEET_MAX_FPS} ` +
        `(got ${String(fps)}). Omit it to use the default of ${DEFAULT_SPRITESHEET_FPS}.`,
    );
  }
  return fps;
}

function assertPivot(pivot: SpritePivot): SpritePivot {
  for (const axis of ["x", "y"] as const) {
    const value = pivot[axis];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new ValidationError(
        `pivot_${axis} must be a number between 0 and 1 (got ${String(value)}). ` +
          `The pivot is NORMALIZED inside one frame — ${DEFAULT_SPRITE_PIVOT.x} is the center ` +
          "and y=0 is the frame's bottom edge — not a pixel offset.",
      );
    }
  }
  return { x: pivot.x, y: pivot.y };
}

/**
 * Columns per row for a layout. "horizontal"/"vertical" are fixed by
 * definition; "grid" honours the caller's `columns` and otherwise picks the
 * squarest sheet, which keeps the texture close to power-of-two friendly and
 * wastes the fewest trailing cells.
 */
function resolveColumns(
  frameCount: number,
  layout: SpritesheetLayout,
  columns: number | undefined,
): number {
  if (layout === "horizontal") {
    if (columns !== undefined) {
      throw new ValidationError('columns applies to layout "grid" only; "horizontal" is one row.');
    }
    return frameCount;
  }
  if (layout === "vertical") {
    if (columns !== undefined) {
      throw new ValidationError('columns applies to layout "grid" only; "vertical" is one column.');
    }
    return 1;
  }
  if (columns === undefined) return Math.ceil(Math.sqrt(frameCount));
  return assertPositiveInteger(columns, "columns");
}

/**
 * Build the metadata document for `frameCount` frames of `frameSize`.
 *
 * Frames are laid out in the caller's order, left to right then top to bottom.
 * When the last row is short, the leftover cells stay EMPTY (the compositor
 * fills them with transparent pixels) — frames are never reordered to fill them.
 */
export function buildSpritesheetMetadata(
  frameCount: number,
  frameSize: Dimensions,
  options: SpritesheetPackOptions,
): SpritesheetMetadata {
  assertPositiveInteger(frameCount, "frame count");
  if (frameCount > SPRITESHEET_MAX_FRAMES) {
    throw new ValidationError(
      `A spritesheet may contain at most ${SPRITESHEET_MAX_FRAMES} frames (got ${frameCount}). ` +
        "Pack several sheets instead.",
    );
  }

  const frameWidth = assertPositiveInteger(frameSize.width, "frame width");
  const frameHeight = assertPositiveInteger(frameSize.height, "frame height");
  const fps = assertFps(options.fps);
  const pivot = assertPivot(options.pivot);
  const columns = resolveColumns(frameCount, options.layout, options.columns);
  const rows = Math.ceil(frameCount / columns);

  const sheetWidth = columns * frameWidth;
  const sheetHeight = rows * frameHeight;
  if (sheetWidth > SPRITESHEET_MAX_SHEET_DIMENSION || sheetHeight > SPRITESHEET_MAX_SHEET_DIMENSION) {
    throw new ValidationError(
      `The requested layout produces a ${sheetWidth}x${sheetHeight} sheet, above the ` +
        `${SPRITESHEET_MAX_SHEET_DIMENSION}px maximum texture dimension. Use more columns/rows ` +
        "(layout 'grid'), fewer frames, or smaller frames.",
    );
  }

  const frames: SpritesheetFrameRect[] = [];
  for (let index = 0; index < frameCount; index++) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    frames.push({
      index,
      x: column * frameWidth,
      y: row * frameHeight,
      width: frameWidth,
      height: frameHeight,
    });
  }

  return {
    version: 1,
    frame_width: frameWidth,
    frame_height: frameHeight,
    sheet_width: sheetWidth,
    sheet_height: sheetHeight,
    layout: options.layout,
    columns,
    rows,
    frame_count: frameCount,
    fps,
    pivot,
    frames,
  };
}
