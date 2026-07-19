import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AssetRegistry } from "../../services/asset-registry.js";
import { getOutputImage } from "../../services/image-management.js";
import { resolveOutputDir } from "../../services/output-dir.js";
import { ComfyUIError, ValidationError, errorToToolResult } from "../../utils/errors.js";
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
};

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

async function resolveSafePath(path: string): Promise<string> {
  if (path.trim().length === 0) {
    throw new ValidationError("path must be a non-empty string.");
  }
  if (isAbsolute(path)) return resolve(path);
  const outputDir = await resolveOutputDir();
  const resolved = resolve(outputDir, path);
  if (resolved !== outputDir && !resolved.startsWith(outputDir + sep)) {
    throw new ValidationError("A relative path must stay within the ComfyUI output directory.");
  }
  return resolved;
}

interface ResolvedSource {
  label: string;
  bytes: Buffer;
}

async function resolveSourceImage(args: PixelateImageArgs): Promise<ResolvedSource> {
  if (Boolean(args.asset_id) === Boolean(args.path)) {
    throw new ValidationError("Provide exactly one image source: asset_id or path.");
  }

  if (args.asset_id) {
    const record = AssetRegistry.get(args.asset_id);
    if (!record) {
      throw new ValidationError(
        `No asset found for id "${args.asset_id}". It may have expired or never been registered.`,
      );
    }
    const validType = record.type === "output" || record.type === "input" || record.type === "temp";
    const fetchType: "output" | "input" | "temp" = validType
      ? (record.type as "output" | "input" | "temp")
      : "output";
    const image = await getOutputImage(record.filename, fetchType, record.subfolder);
    return {
      label: `asset ${args.asset_id} (${record.filename})`,
      bytes: Buffer.from(image.base64, "base64"),
    };
  }

  const resolvedPath = await resolveSafePath(args.path!);
  try {
    return { label: resolvedPath, bytes: await readFile(resolvedPath) };
  } catch {
    throw new ValidationError(`Source image not found or unreadable: ${resolvedPath}`);
  }
}

async function resolveWritableOutputPath(path: string): Promise<string> {
  if (path.trim().length === 0) {
    throw new ValidationError("out_path must be a non-empty path.");
  }
  const outputDir = await resolveOutputDir();
  const resolved = isAbsolute(path) ? resolve(path) : resolve(outputDir, path);
  if (resolved !== outputDir && !resolved.startsWith(outputDir + sep)) {
    throw new ValidationError("out_path must stay within the ComfyUI output directory.");
  }
  return resolved;
}

export function registerPixelateImageTool(server: McpServer): void {
  server.tool(
    "pixelate_image",
    "Convert an arbitrary image into clean pixel art: nearest-neighbor grid-snap to a target " +
      "resolution, palette quantization (a built-in Lospec preset, an auto-derived k-means-style " +
      "palette, or a caller-provided hex list), nearest-color mapping, and an isolated-pixel " +
      "despeckle pass. Alpha is preserved throughout. Source is an asset_id or a path; returns the " +
      "result inline as a PNG and optionally writes it to out_path.",
    pixelateImageSchema,
    async (args: PixelateImageArgs) => {
      try {
        const targetWidth = assertPositiveInteger(args.target_width, "target_width");
        const targetHeight = assertPositiveInteger(args.target_height, "target_height");
        const palette = resolvePaletteSource(args);
        const source = await resolveSourceImage(args);

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
          outPath = await resolveWritableOutputPath(args.out_path);
          await writeFile(outPath, result.png);
        }

        const summary = {
          source: source.label,
          width: result.width,
          height: result.height,
          palette_mode: args.palette_mode,
          palette: result.palette,
          despeckle: args.despeckle !== false,
          output_bytes: result.png.length,
          out_path: outPath,
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
