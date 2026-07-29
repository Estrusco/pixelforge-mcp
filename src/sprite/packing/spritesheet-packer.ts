import sharp from "sharp";
import { ValidationError } from "../../utils/errors.js";
import { buildSpritesheetMetadata } from "./metadata-builder.js";
import type { Dimensions, PackedSpritesheet, RawImage, SpritesheetPackOptions } from "../types.js";

// ---------------------------------------------------------------------------
// Frame compositing. Buffers in, buffers out — this module never touches disk
// and knows nothing about asset ids, MCP arguments, or any game engine.
//
// PACKING ALGORITHM: a fixed-cell grid, NOT a bin packer. Every frame in an
// animation set is the same size (the packer enforces it), so a uniform grid is
// both optimal in area and the only layout a caller can slice by hand — a
// MaxRects/shelf packer would buy nothing here and would make the resulting
// sheet impossible to describe as "columns x rows of NxM cells", which is
// exactly what a Unity grid-slice import wants.
// ---------------------------------------------------------------------------

/**
 * Decode encoded image bytes (PNG/WebP/...) into an alpha-preserving RGBA
 * buffer at its native size. NO resizing happens here: a frame that is the
 * wrong size is a caller error the packer reports, never something it silently
 * fixes.
 */
export async function decodeFrameImage(bytes: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(bytes, { limitInputPixels: 100_000_000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height };
}

/**
 * Every frame must share one size. Mismatches FAIL LOUDLY (with the offending
 * indices) instead of being cropped or padded: silently resizing a frame is a
 * change to the user's art, and a half-scaled frame in a finished sheet is far
 * more expensive to notice than a rejected call.
 */
function assertUniformFrameSize(frames: readonly RawImage[]): Dimensions {
  const first = frames[0];
  const mismatches: string[] = [];
  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    if (frame.width !== first.width || frame.height !== first.height) {
      mismatches.push(`frame ${i} is ${frame.width}x${frame.height}`);
    }
  }
  if (mismatches.length > 0) {
    const shown = mismatches.slice(0, 5).join(", ");
    const more = mismatches.length > 5 ? `, and ${mismatches.length - 5} more` : "";
    throw new ValidationError(
      `All frames in a spritesheet must have identical dimensions. Frame 0 is ` +
        `${first.width}x${first.height}, but ${shown}${more}. Resize the frames first (e.g. with ` +
        "pixelate_image at one target resolution) — pack_spritesheet will not crop or pad them " +
        "for you.",
    );
  }
  return { width: first.width, height: first.height };
}

/**
 * Composite ordered frames into one packed sheet plus its metadata.
 *
 * Alpha is preserved end to end: the sheet starts as fully transparent pixels,
 * frames are copied in unchanged, and any leftover cell in a short final row
 * stays transparent — never a solid background colour.
 */
export async function packSpritesheet(
  frames: readonly RawImage[],
  options: SpritesheetPackOptions,
): Promise<PackedSpritesheet> {
  if (frames.length === 0) {
    throw new ValidationError("A spritesheet needs at least one frame.");
  }

  const frameSize = assertUniformFrameSize(frames);
  const metadata = buildSpritesheetMetadata(frames.length, frameSize, options);

  const png = await sharp({
    create: {
      width: metadata.sheet_width,
      height: metadata.sheet_height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(
      metadata.frames.map((rect) => ({
        input: frames[rect.index].data,
        raw: { width: rect.width, height: rect.height, channels: 4 as const },
        left: rect.x,
        top: rect.y,
      })),
    )
    .png()
    .toBuffer();

  return { png, metadata };
}
