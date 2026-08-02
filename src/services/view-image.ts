import sharp from "sharp";
import { AssetRegistry } from "./asset-registry.js";
import { getOutputImage } from "./image-management.js";

export interface ViewImageResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
}

export type ViewImageBackground = "dark" | "light" | "checker";

const SUPPORTED_IMAGE_MIME_PREFIX = "image/";

/**
 * view_image / get_image both composite transparency onto WHITE by default
 * (the client's own rendering), which makes dark-on-transparent pixel art
 * (e.g. neon-on-black cutouts) look faded or broken at a glance even when the
 * alpha is correct — the exact confusion reported after a luma_key batch.
 * `background` composites onto a deliberate backdrop server-side instead.
 */
async function compositeOnBackground(bytes: Buffer, background: ViewImageBackground): Promise<Buffer> {
  if (background === "dark") {
    return sharp(bytes).flatten({ background: { r: 24, g: 24, b: 24 } }).png().toBuffer();
  }
  if (background === "light") {
    return sharp(bytes).flatten({ background: { r: 255, g: 255, b: 255 } }).png().toBuffer();
  }
  const meta = await sharp(bytes).metadata();
  const width = meta.width ?? 1;
  const height = meta.height ?? 1;
  const cell = 8;
  // A tiled 2x2-cell checker pattern via SVG, then the source composited on
  // top ("over") — simplest way to get a pixel-perfect infinite tile at any
  // image size without hand-rolling a pixel loop.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><pattern id="c" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">` +
    `<rect width="${cell * 2}" height="${cell * 2}" fill="#cccccc"/>` +
    `<rect width="${cell}" height="${cell}" fill="#999999"/>` +
    `<rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#999999"/>` +
    `</pattern></defs>` +
    `<rect width="100%" height="100%" fill="url(#c)"/></svg>`;
  const checkerBg = await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(checkerBg).composite([{ input: bytes, blend: "over" }]).png().toBuffer();
}

/**
 * Fetch a registered asset's bytes and return them as an MCP image content
 * block so the agent can see the actual image. Throws on missing/expired
 * assets and on non-image mime types (audio/video are not viewable inline).
 *
 * `background` composites the image onto a solid dark/light backdrop or a
 * checker pattern before returning it (always as PNG regardless of the
 * source format) — see compositeOnBackground for why this exists.
 */
export async function viewAssetImage(
  assetId: string,
  background?: ViewImageBackground,
): Promise<ViewImageResult> {
  const record = AssetRegistry.get(assetId);
  if (!record) {
    throw new Error(
      `No asset found for id "${assetId}". It may have expired or never been registered.`,
    );
  }

  const validType = record.type === "output" || record.type === "input" || record.type === "temp";
  const fetchType: "output" | "input" | "temp" = validType
    ? (record.type as "output" | "input" | "temp")
    : "output";

  const { base64, mimeType } = await getOutputImage(
    record.filename,
    fetchType,
    record.subfolder,
  );

  if (!mimeType.startsWith(SUPPORTED_IMAGE_MIME_PREFIX)) {
    throw new Error(
      `Asset "${assetId}" is not an image (mime: ${mimeType}). view_image only supports PNG/JPEG/WebP.`,
    );
  }

  let outData = base64;
  let outMime = mimeType;
  if (background) {
    const composed = await compositeOnBackground(Buffer.from(base64, "base64"), background);
    outData = composed.toString("base64");
    outMime = "image/png";
  }

  return {
    content: [
      {
        type: "text",
        text: `Asset ${assetId} — ${record.filename} (${mimeType}${background ? `, composited on ${background}` : ""})`,
      },
      {
        type: "image",
        data: outData,
        mimeType: outMime,
      },
    ],
  };
}
