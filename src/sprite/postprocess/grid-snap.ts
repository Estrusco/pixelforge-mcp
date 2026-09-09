import { requireSharp } from "../../services/sharp-loader.js";
import type { Dimensions, RawImage } from "../types.js";

// Decodes arbitrary encoded image bytes and nearest-neighbor resizes to the
// exact target grid, preserving alpha. This is the entry point of the
// pixelate_image pipeline — every later stage operates on the RawImage it
// returns.
export async function gridSnap(bytes: Buffer, target: Dimensions): Promise<RawImage> {
  const sharp = await requireSharp("pixelate_image");
  const { data, info } = await sharp(bytes, { limitInputPixels: 100_000_000 })
    .resize(target.width, target.height, { kernel: sharp.kernel.nearest, fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height };
}
