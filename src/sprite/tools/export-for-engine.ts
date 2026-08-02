import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ValidationError, errorToToolResult } from "../../utils/errors.js";
import {
  assertMetadataConsistent,
  assertSheetMatchesMetadata,
  buildUnityTextureMeta,
  generateUnityGuid,
  isInsideUnityProject,
  pathExists,
  translateToUnity,
} from "../export/index.js";
import { loadImageSource, resolveSaveDir, resolveWritableOutputPath } from "../image-io.js";
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
// path), the caller's out_path/save_dir writes (+ optional Unity .meta), and
// response formatting. It takes the EXACT `metadata` object pack_spritesheet
// returns — engine-agnostic, top-left/y-down rects — as external input, so it
// is validated as a system boundary (../export/validate-metadata.js) rather
// than trusted. The one actual translation (top-left/y-down -> Unity
// bottom-left/y-up, sprite naming, Pixels Per Unit) lives in ../export/unity.js
// and stays pure.
//
// LOCKED DECISION UPDATE (CLAUDE.md / locked-decisions.md): MVP was PNG + JSON
// only, no .meta. Revisited: .meta generation is now opt-in-by-default when a
// written PNG is detected inside a real Unity project (see
// ../export/unity-meta.js for the detection heuristic, the mitigation against
// ever overwriting an existing .meta, and why the generated .meta is
// deliberately minimal rather than a full Editor capture). `engine` still
// advertises "godot"/"gamemaker" in the schema for contract stability, but
// `assertImplementedExportEngine` REJECTS them before any image is loaded or
// any file written — never a silent no-op. Mirrors the same
// schema-ready-but-rejected pattern generate_animation_set uses for
// `consistency_mode: "controlnet_pose"`.
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
  save_dir: z
    .string()
    .optional()
    .describe(
      "Optional local directory (arbitrary, not required to be inside the ComfyUI output " +
        "directory or to have COMFYUI_PATH configured) to also write '<sprite_name>.png' and " +
        "'<sprite_name>.json' to. Created if it does not exist — e.g. point this straight at a " +
        "Unity project's Assets/ folder.",
    ),
  generate_meta: z
    .boolean()
    .optional()
    .describe(
      "Write a Unity TextureImporter '.meta' file next to each PNG actually written (out_path " +
        "and/or save_dir) — Sprite type, Single mode, Point filtering, no compression, the given " +
        "pixels_per_unit. Default: auto-detected per path (true when it resolves inside a real " +
        "Unity project's Assets/ folder, i.e. an ancestor 'ProjectSettings/' directory is found; " +
        "false otherwise). Pass explicitly to override the heuristic in either direction. An " +
        "existing '.meta' is NEVER overwritten (would reassign a GUID referenced by scenes/" +
        "prefabs) — writing is skipped and reported in the result instead. Requires out_path and/" +
        "or save_dir; meaningless for an inline-only response.",
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
  save_dir?: string;
  generate_meta?: boolean;
};

/** `foo.png` -> `foo.json`; anything else gets `.json` appended. */
function deriveJsonPath(pngPath: string): string {
  return /\.png$/i.test(pngPath) ? pngPath.replace(/\.png$/i, ".json") : `${pngPath}.json`;
}

/**
 * `sprite_name` is caller-supplied free text, not a trusted path — strip any
 * directory components (basename) and collapse anything else that isn't a
 * safe filename character before using it to build a save_dir file path.
 */
function safeSpriteFilename(spriteName: string, ext: string): string {
  const base = basename(spriteName.trim()).replace(/[^A-Za-z0-9._-]/g, "_");
  return `${base.length > 0 ? base : "sprite"}${ext}`;
}

interface MetaOutcome {
  readonly path: string;
  readonly written: boolean;
  readonly skippedExisting: boolean;
  readonly autoDetected: boolean;
}

/**
 * Decide (explicit override, else auto-detect) whether `pngPath` should get a
 * `.meta`, then write one — unless it already exists, which is never
 * overwritten. Returns undefined when `.meta` was neither requested nor
 * auto-detected, so the caller can omit it from the result entirely.
 */
async function maybeWriteUnityMeta(
  pngPath: string,
  pixelsPerUnit: number,
  explicitGenerateMeta: boolean | undefined,
): Promise<MetaOutcome | undefined> {
  const autoDetected = explicitGenerateMeta === undefined;
  const shouldGenerate = explicitGenerateMeta ?? (await isInsideUnityProject(pngPath));
  if (!shouldGenerate) return undefined;

  const metaPath = `${pngPath}.meta`;
  if (await pathExists(metaPath)) {
    return { path: metaPath, written: false, skippedExisting: true, autoDetected };
  }

  const meta = buildUnityTextureMeta({ guid: generateUnityGuid(), pixelsPerUnit });
  await writeFile(metaPath, meta);
  return { path: metaPath, written: true, skippedExisting: false, autoDetected };
}

export function registerExportForEngineTool(server: McpServer): void {
  server.tool(
    "export_for_engine",
    "Translate a pack_spritesheet output (sheet PNG + its metadata) into an engine-specific " +
      "import format. MVP: 'unity' only. A SINGLE sprite is just a pack_spritesheet call with one " +
      "frame — that already produces a valid 1-frame metadata object, no special-casing needed " +
      "here. 'godot'/'gamemaker' are in the schema for contract stability but are REJECTED, never " +
      "silently skipped. The Unity translation flips each frame rect from pack_spritesheet's " +
      "top-left/y-down convention to Unity's bottom-left/y-up convention and names each frame " +
      "'<sprite_name>_<frame_index>'; the normalized pivot passes through unchanged (already " +
      "bottom-origin). save_dir writes '<sprite_name>.png/.json' straight to an arbitrary local " +
      "directory, independent of out_path's ComfyUI-output-dir constraint — point it at a Unity " +
      "project's Assets/ folder for the single-sprite workflow. generate_meta additionally writes " +
      "a Unity '.meta' next to each PNG written (Sprite/Single/Point filter/no compression), " +
      "auto-detected by default and NEVER overwriting an existing one.",
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
        if (args.generate_meta === true && !args.out_path && !args.save_dir) {
          throw new ValidationError(
            "generate_meta requires out_path and/or save_dir — there is no PNG on disk to pair a " +
              ".meta file with otherwise.",
          );
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

        let savePngPath: string | undefined;
        let saveJsonPath: string | undefined;
        if (args.save_dir) {
          const saveDir = await resolveSaveDir(args.save_dir, "save_dir");
          savePngPath = join(saveDir, safeSpriteFilename(args.sprite_name, ".png"));
          saveJsonPath = join(saveDir, safeSpriteFilename(args.sprite_name, ".json"));
          await writeFile(savePngPath, sheet.bytes);
          await writeFile(saveJsonPath, JSON.stringify(unityMetadata, null, 2));
        }

        const outMeta = outPngPath
          ? await maybeWriteUnityMeta(outPngPath, pixelsPerUnit, args.generate_meta)
          : undefined;
        const saveMeta = savePngPath
          ? await maybeWriteUnityMeta(savePngPath, pixelsPerUnit, args.generate_meta)
          : undefined;

        const metaNote = [outMeta, saveMeta].some((m) => m?.skippedExisting)
          ? " A '.meta' already existed at at least one destination — it was left untouched (never " +
            "overwriting a GUID scenes/prefabs may reference)."
          : "";

        const summary = {
          status: "exported",
          tool: "export_for_engine",
          engine,
          sprite_count: unityMetadata.sprites.length,
          sheet_source: sheet.label,
          out_png_path: outPngPath,
          out_json_path: outJsonPath,
          out_meta_path: outMeta?.path,
          out_meta_written: outMeta?.written,
          out_meta_skipped_existing: outMeta?.skippedExisting,
          save_png_path: savePngPath,
          save_json_path: saveJsonPath,
          save_meta_path: saveMeta?.path,
          save_meta_written: saveMeta?.written,
          save_meta_skipped_existing: saveMeta?.skippedExisting,
          metadata: unityMetadata,
          note:
            "sprites[].rect uses Unity's BOTTOM-LEFT origin (y up) — already converted from " +
            "pack_spritesheet's top-left/y-down rects." +
            ((outMeta?.written || saveMeta?.written)
              ? " A minimal Unity .meta was written (Sprite/Single/Point filter/no compression) — " +
                "Unity will fill in any other default on first import."
              : " No .meta file was written; import the PNG manually and slice it using this JSON, " +
                "or pass generate_meta:true.") +
            metaNote,
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
