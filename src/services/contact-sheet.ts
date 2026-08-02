import sharp from "sharp";
import { AssetRegistry } from "./asset-registry.js";
import { getOutputImage } from "./image-management.js";
import { ValidationError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// contact_sheet — tile N registered assets into ONE preview PNG for batch QA.
//
// Generic (not sprite-specific): replaces the PowerShell + System.Drawing
// script a reporting user had to hand-write to eyeball 10 generated sprites
// together against a background that actually suits dark/neon pixel art —
// view_image/get_image's default (transparency over whatever the client
// renders, usually white) makes that art look faded or broken at a glance.
// ---------------------------------------------------------------------------

export type ContactSheetBackground = "dark" | "light" | "checker";

export interface ContactSheetOptions {
  readonly assetIds: readonly string[];
  /** Default "dark" — the useful default for QA'ing dark-background pixel art. */
  readonly background?: ContactSheetBackground;
  /** Frames per row. Defaults to the squarest grid, ceil(sqrt(count)). */
  readonly columns?: number;
}

export interface ContactSheetResult {
  readonly png: Buffer;
  readonly columns: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly sheetWidth: number;
  readonly sheetHeight: number;
  readonly count: number;
  readonly labels: readonly string[];
}

/** QA preview, not a game asset — a generous but bounded cap on wall-clock/memory. */
export const CONTACT_SHEET_MAX_ASSETS = 64;

async function renderBackgroundCanvas(
  width: number,
  height: number,
  background: ContactSheetBackground,
): Promise<Buffer> {
  if (background === "dark") {
    return sharp({
      create: { width, height, channels: 4, background: { r: 24, g: 24, b: 24, alpha: 255 } },
    })
      .png()
      .toBuffer();
  }
  if (background === "light") {
    return sharp({
      create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } },
    })
      .png()
      .toBuffer();
  }
  const cell = 8;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><pattern id="c" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">` +
    `<rect width="${cell * 2}" height="${cell * 2}" fill="#cccccc"/>` +
    `<rect width="${cell}" height="${cell}" fill="#999999"/>` +
    `<rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#999999"/>` +
    `</pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

interface LoadedAsset {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly label: string;
}

async function loadAsset(assetId: string): Promise<LoadedAsset> {
  const record = AssetRegistry.get(assetId);
  if (!record) {
    throw new ValidationError(
      `No asset found for id "${assetId}". It may have expired or never been registered.`,
    );
  }
  const validType = record.type === "output" || record.type === "input" || record.type === "temp";
  const fetchType: "output" | "input" | "temp" = validType
    ? (record.type as "output" | "input" | "temp")
    : "output";
  const image = await getOutputImage(record.filename, fetchType, record.subfolder);
  const bytes = Buffer.from(image.base64, "base64");
  const meta = await sharp(bytes).metadata();
  return { bytes, width: meta.width ?? 1, height: meta.height ?? 1, label: `${assetId} (${record.filename})` };
}

/**
 * Tile every asset into a single sheet on a shared backdrop, one QA glance
 * instead of N separate view_image calls. Frames need NOT share dimensions
 * (unlike pack_spritesheet, which is for real game frame sets) — each is
 * centered within a uniform cell sized to the largest frame, so a batch of
 * differently-sized sprites still lines up cleanly.
 */
export async function buildContactSheet(opts: ContactSheetOptions): Promise<ContactSheetResult> {
  if (!opts.assetIds || opts.assetIds.length === 0) {
    throw new ValidationError("asset_ids must be a non-empty array.");
  }
  if (opts.assetIds.length > CONTACT_SHEET_MAX_ASSETS) {
    throw new ValidationError(
      `contact_sheet accepts at most ${CONTACT_SHEET_MAX_ASSETS} asset_ids (got ${opts.assetIds.length}).`,
    );
  }
  if (opts.columns !== undefined && (!Number.isInteger(opts.columns) || opts.columns < 1)) {
    throw new ValidationError(`columns must be a positive integer (got ${opts.columns}).`);
  }

  const images = await Promise.all(opts.assetIds.map(loadAsset));

  const cellWidth = Math.max(...images.map((i) => i.width));
  const cellHeight = Math.max(...images.map((i) => i.height));
  const columns = opts.columns ?? Math.ceil(Math.sqrt(images.length));
  const rows = Math.ceil(images.length / columns);
  const sheetWidth = cellWidth * columns;
  const sheetHeight = cellHeight * rows;
  const background = opts.background ?? "dark";

  const canvas = await renderBackgroundCanvas(sheetWidth, sheetHeight, background);

  const composites = images.map((img, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    // Center each frame within its cell so mismatched sizes still line up.
    const left = col * cellWidth + Math.floor((cellWidth - img.width) / 2);
    const top = row * cellHeight + Math.floor((cellHeight - img.height) / 2);
    return { input: img.bytes, left, top };
  });

  const png = await sharp(canvas).composite(composites).png().toBuffer();

  return {
    png,
    columns,
    rows,
    cellWidth,
    cellHeight,
    sheetWidth,
    sheetHeight,
    count: images.length,
    labels: images.map((i) => i.label),
  };
}
