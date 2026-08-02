import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { uploadImageHttp } from "../../comfyui/client.js";
import { AssetRegistry } from "../../services/asset-registry.js";
import { ComfyUIError, ValidationError, errorToToolResult } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { loadImageSource, resolveSaveDir, resolveWritableOutputPath } from "../image-io.js";
import { quantizeImage, LOSPEC_PRESET_SLUGS } from "../postprocess/index.js";
import type { LospecPresetSlug, PaletteSource } from "../types.js";

// pixelate_image — the postprocess/ pipeline (grid-snap -> nearest-color
// quantization -> isolated-pixel cleanup) exposed as an MCP tool. This is a
// pure local transform (sharp/image-q), never a ComfyUI job.

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

const pixelateImageSchema = {
  asset_id: z
    .string()
    .optional()
    .describe("Registered asset id from a completed job. Provide exactly one of asset_id or path."),
  path: z
    .string()
    .optional()
    .describe(
      "Path to a source image: absolute, or relative to the ComfyUI output directory. " +
        "Provide exactly one of asset_id or path.",
    ),
  target_width: z
    .number()
    .describe("Target pixel grid width, a positive integer (e.g. 32)."),
  target_height: z
    .number()
    .describe("Target pixel grid height, a positive integer (e.g. 32)."),
  palette_mode: z
    .enum(["lospec", "auto_kmeans", "custom"])
    .describe(
      "Palette source: 'lospec' (a built-in preset), 'auto_kmeans' (derive a palette from the " +
        "image), or 'custom' (caller-provided hex colors).",
    ),
  palette_preset: z
    .string()
    .optional()
    .describe(
      `Required when palette_mode is "lospec". One of: ${LOSPEC_PRESET_SLUGS.join(", ")}.`,
    ),
  palette_size: z
    .number()
    .optional()
    .describe("Required when palette_mode is 'auto_kmeans': target color count (integer >= 2)."),
  custom_palette: z
    .array(z.string())
    .optional()
    .describe("Required when palette_mode is 'custom': non-empty list of 6-digit hex colors."),
  despeckle: z
    .boolean()
    .optional()
    .describe("Run the isolated-pixel cleanup pass after quantization (default true)."),
  out_path: z
    .string()
    .optional()
    .describe("Optional path under the ComfyUI output directory to also write the pixelated PNG to."),
  save_dir: z
    .string()
    .optional()
    .describe(
      "Optional local directory (arbitrary, not required to be inside the ComfyUI output " +
        "directory or to have COMFYUI_PATH configured) to also save the pixelated PNG to, under " +
        "an auto-generated filename. Created if it does not exist.",
    ),
};

type PixelateImageArgs = {
  asset_id?: string;
  path?: string;
  target_width: number;
  target_height: number;
  palette_mode: "lospec" | "auto_kmeans" | "custom";
  palette_preset?: string;
  palette_size?: number;
  custom_palette?: string[];
  despeckle?: boolean;
  out_path?: string;
  save_dir?: string;
};

/** Content-addressed so re-running the same result never collides with a stale upload. */
function derivePixelatedFilename(png: Buffer): string {
  const hash = createHash("sha256").update(png).digest("hex").slice(0, 12);
  return `pixelated_${hash}.png`;
}

/**
 * Upload the pixelated PNG to ComfyUI's input/ dir and register it as an
 * asset, so the result can be chained into remove_background/pack_spritesheet
 * via asset_id without the caller managing files. Best-effort: a ComfyUI
 * that's unreachable must not fail the whole tool call, since the pixelated
 * bytes are already being returned inline regardless.
 */
async function registerPixelatedAsset(
  png: Buffer,
): Promise<{ assetId?: string; filename?: string; error?: string }> {
  const filename = derivePixelatedFilename(png);
  try {
    const uploaded = await uploadImageHttp(filename, png, "image/png");
    const record = AssetRegistry.registerLocal({
      filename: uploaded.name,
      subfolder: uploaded.subfolder,
      type: uploaded.type,
    });
    return { assetId: record.assetId, filename: uploaded.name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("pixelate_image: could not register result as an asset", { error: message });
    return { error: message };
  }
}

function assertPositiveInteger(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${label} must be a positive integer (got ${value}).`);
  }
  return value;
}

function resolvePaletteSource(args: PixelateImageArgs): PaletteSource {
  switch (args.palette_mode) {
    case "lospec": {
      if (!args.palette_preset) {
        throw new ValidationError('palette_preset is required when palette_mode is "lospec".');
      }
      if (!LOSPEC_PRESET_SLUGS.includes(args.palette_preset as LospecPresetSlug)) {
        throw new ValidationError(
          `Unknown palette preset "${args.palette_preset}". Valid presets: ${LOSPEC_PRESET_SLUGS.join(", ")}.`,
        );
      }
      return { mode: "lospec", slug: args.palette_preset as LospecPresetSlug };
    }
    case "auto_kmeans": {
      if (
        args.palette_size === undefined ||
        !Number.isInteger(args.palette_size) ||
        args.palette_size < 2
      ) {
        throw new ValidationError(
          `palette_size must be an integer >= 2 when palette_mode is "auto_kmeans" (got ${args.palette_size}).`,
        );
      }
      return { mode: "auto_kmeans", paletteSize: args.palette_size };
    }
    case "custom": {
      if (!args.custom_palette || args.custom_palette.length === 0) {
        throw new ValidationError(
          'custom_palette must be a non-empty array of hex colors when palette_mode is "custom".',
        );
      }
      for (const hex of args.custom_palette) {
        if (!HEX_RE.test(hex.trim())) {
          throw new ValidationError(
            `Invalid hex color "${hex}" in custom_palette. Expected a 6-digit hex, e.g. "#1a1c2c".`,
          );
        }
      }
      return { mode: "custom", colors: args.custom_palette };
    }
  }
}

export function registerPixelateImageTool(server: McpServer): void {
  server.tool(
    "pixelate_image",
    "Convert an arbitrary image into clean pixel art: nearest-neighbor grid-snap to a target " +
      "resolution, palette quantization (a built-in Lospec preset, an auto-derived k-means-style " +
      "palette, or a caller-provided hex list), nearest-color mapping, and an isolated-pixel " +
      "despeckle pass. Alpha is preserved throughout. Source is an asset_id or a path (a relative " +
      "path works even without COMFYUI_PATH configured, fetched over HTTP); returns the result " +
      "inline as a PNG, optionally writes it to out_path and/or an arbitrary local save_dir, and " +
      "registers it as a new asset_id (uploaded to ComfyUI's input dir) so it can be chained " +
      "straight into remove_background/pack_spritesheet/export_for_engine.",
    pixelateImageSchema,
    async (args: PixelateImageArgs) => {
      try {
        const targetWidth = assertPositiveInteger(args.target_width, "target_width");
        const targetHeight = assertPositiveInteger(args.target_height, "target_height");
        const palette = resolvePaletteSource(args);
        const source = await loadImageSource({ assetId: args.asset_id, path: args.path }, "image");

        let result;
        try {
          result = await quantizeImage(source.bytes, {
            targetResolution: { width: targetWidth, height: targetHeight },
            palette,
            cleanupIsolatedPixels: args.despeckle,
          });
        } catch (err) {
          if (err instanceof ComfyUIError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new ValidationError(`Failed to process image "${source.label}": ${message}`);
        }

        let outPath: string | undefined;
        if (args.out_path) {
          outPath = await resolveWritableOutputPath(args.out_path, "out_path");
          await writeFile(outPath, result.png);
        }

        let savePath: string | undefined;
        if (args.save_dir) {
          const saveDir = await resolveSaveDir(args.save_dir, "save_dir");
          savePath = join(saveDir, derivePixelatedFilename(result.png));
          await writeFile(savePath, result.png);
        }

        const asset = await registerPixelatedAsset(result.png);

        const summary = {
          source: source.label,
          width: result.width,
          height: result.height,
          palette_mode: args.palette_mode,
          palette: result.palette,
          despeckle: args.despeckle !== false,
          output_bytes: result.png.length,
          out_path: outPath,
          save_path: savePath,
          asset_id: asset.assetId,
          asset_registration_error: asset.error,
          note: asset.assetId
            ? "asset_id is registered from this local file, not a ComfyUI job — regenerate is not " +
              "supported for it, but it can be passed to remove_background/pack_spritesheet/" +
              "export_for_engine as asset_id."
            : undefined,
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(summary, null, 2) },
            { type: "image" as const, data: result.png.toString("base64"), mimeType: "image/png" },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
