import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError, errorToToolResult } from "../../utils/errors.js";
import { assertMetadataConsistent, assertSheetMatchesMetadata, translateToUnity } from "../export/index.js";
import { loadImageSource, resolveWritableOutputPath } from "../image-io.js";
import { probeImageDimensions } from "../packing/index.js";
import {
  DEFAULT_PIXELS_PER_UNIT,
  EXPORT_ENGINES,
  SPRITESHEET_LAYOUTS,
  assertImplementedExportEngine,
} from "../types.js";
import type { ExportEngine, SpritesheetMetadata } from "../types.js";

// ---------------------------------------------------------------------------
// export_for_engine — the MCP contract layer.
//
// This file owns ONLY: argument validation, sheet-image loading (asset_id |
// path), the caller's out_path write, and response formatting. It takes the
// EXACT `metadata` object pack_spritesheet returns — engine-agnostic,
// top-left/y-down rects — as external input, so it is validated as a system
// boundary (../export/validate-metadata.js) rather than trusted. The one
// actual translation (top-left/y-down -> Unity bottom-left/y-up, sprite
// naming, Pixels Per Unit) lives in ../export/unity.js and stays pure.
//
// LOCKED DECISION (CLAUDE.md): MVP is Unity-only, PNG + JSON for MANUAL
// import — no .meta generation. `engine` advertises "godot"/"gamemaker" in
// the schema for contract stability, but `assertImplementedExportEngine`
// REJECTS them before any image is loaded or any file written — never a
// silent no-op. Mirrors the same schema-ready-but-rejected pattern
// generate_animation_set uses for `consistency_mode: "controlnet_pose"`.
// ---------------------------------------------------------------------------

const spritePivotSchema = z.object({ x: z.number(), y: z.number() });

const spritesheetFrameRectSchema = z.object({
  index: z.number(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const spritesheetMetadataSchema = z
  .object({
    version: z.literal(1),
    frame_width: z.number(),
    frame_height: z.number(),
    sheet_width: z.number(),
    sheet_height: z.number(),
    layout: z.enum(SPRITESHEET_LAYOUTS),
    columns: z.number(),
    rows: z.number(),
    frame_count: z.number(),
    fps: z.number(),
    pivot: spritePivotSchema,
    frames: z.array(spritesheetFrameRectSchema),
  })
  .describe("The exact `metadata` object pack_spritesheet returned for this same sheet.");

const exportForEngineSchema = {
  engine: z
    .enum(EXPORT_ENGINES)
    .describe(
      `Target engine. One of: ${EXPORT_ENGINES.join(", ")}. Only "unity" is implemented in MVP — ` +
        "the others are present for contract stability and are REJECTED, never silently skipped.",
    ),
  sheet_asset_id: z
    .string()
    .optional()
    .describe(
      "Registered asset id of the packed spritesheet PNG. One of sheet_asset_id or sheet_path.",
    ),
  sheet_path: z
    .string()
    .optional()
    .describe(
      "Path to the packed spritesheet PNG: absolute, or relative to the ComfyUI output " +
        "directory — typically pack_spritesheet's own out_path. One of sheet_asset_id or sheet_path.",
    ),
  metadata: spritesheetMetadataSchema,
  sprite_name: z
    .string()
    .describe("Base name for the per-frame sprite entries; frame N is named '<sprite_name>_N'."),
  pixels_per_unit: z
    .number()
    .optional()
    .describe(`Unity Pixels Per Unit for the generated sprites (default ${DEFAULT_PIXELS_PER_UNIT}).`),
  out_path: z
    .string()
    .optional()
    .describe(
      "Optional PNG path under the ComfyUI output directory to also write to. The JSON metadata " +
        "is written alongside it with a .json extension. Omit to receive both inline only.",
    ),
};

type ExportForEngineArgs = {
  engine: ExportEngine;
  sheet_asset_id?: string;
  sheet_path?: string;
  metadata: SpritesheetMetadata;
  sprite_name: string;
  pixels_per_unit?: number;
  out_path?: string;
};

/** `foo.png` -> `foo.json`; anything else gets `.json` appended. */
function deriveJsonPath(pngPath: string): string {
  return /\.png$/i.test(pngPath) ? pngPath.replace(/\.png$/i, ".json") : `${pngPath}.json`;
}

export function registerExportForEngineTool(server: McpServer): void {
  server.tool(
    "export_for_engine",
    "Translate a pack_spritesheet output (sheet PNG + its metadata) into an engine-specific " +
      "import format. MVP: 'unity' only — PNG + JSON slicing metadata for MANUAL import, no " +
      "'.meta' file generation. 'godot'/'gamemaker' are in the schema for contract stability but " +
      "are REJECTED, never silently skipped. The Unity translation flips each frame rect from " +
      "pack_spritesheet's top-left/y-down convention to Unity's bottom-left/y-up convention and " +
      "names each frame '<sprite_name>_<frame_index>'; the normalized pivot passes through " +
      "unchanged (already bottom-origin).",
    exportForEngineSchema,
    async (args: ExportForEngineArgs) => {
      try {
        // FIRST, before any image load or disk write: reject unimplemented
        // engines. No side effects on a rejected call.
        const engine = assertImplementedExportEngine(args.engine);

        if (args.sprite_name.trim().length === 0) {
          throw new ValidationError("sprite_name must be a non-empty string.");
        }
        const pixelsPerUnit = args.pixels_per_unit ?? DEFAULT_PIXELS_PER_UNIT;
        if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0) {
          throw new ValidationError(`pixels_per_unit must be a positive number (got ${pixelsPerUnit}).`);
        }

        assertMetadataConsistent(args.metadata);

        const sheet = await loadImageSource(
          { assetId: args.sheet_asset_id, path: args.sheet_path },
          "sheet",
        );
        const sheetDimensions = await probeImageDimensions(sheet.bytes);
        assertSheetMatchesMetadata(sheetDimensions, args.metadata);

        const unityMetadata = translateToUnity(args.metadata, args.sprite_name, pixelsPerUnit);

        let outPngPath: string | undefined;
        let outJsonPath: string | undefined;
        if (args.out_path) {
          outPngPath = await resolveWritableOutputPath(args.out_path, "out_path");
          outJsonPath = await resolveWritableOutputPath(deriveJsonPath(args.out_path), "out_path");
          await writeFile(outPngPath, sheet.bytes);
          await writeFile(outJsonPath, JSON.stringify(unityMetadata, null, 2));
        }

        const summary = {
          status: "exported",
          tool: "export_for_engine",
          engine,
          sprite_count: unityMetadata.sprites.length,
          sheet_source: sheet.label,
          out_png_path: outPngPath,
          out_json_path: outJsonPath,
          metadata: unityMetadata,
          note:
            "sprites[].rect uses Unity's BOTTOM-LEFT origin (y up) — already converted from " +
            "pack_spritesheet's top-left/y-down rects. No .meta file is generated; import the " +
            "PNG manually and slice it using this JSON.",
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(summary, null, 2) },
            { type: "image" as const, data: sheet.bytes.toString("base64"), mimeType: "image/png" },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
