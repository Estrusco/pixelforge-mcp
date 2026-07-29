import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ComfyUIError, ValidationError, errorToToolResult } from "../../utils/errors.js";
import { loadImageSource, resolveWritableOutputPath } from "../image-io.js";
import { decodeFrameImage, packSpritesheet } from "../packing/index.js";
import {
  DEFAULT_SPRITESHEET_FPS,
  DEFAULT_SPRITESHEET_LAYOUT,
  DEFAULT_SPRITE_PIVOT,
  SPRITESHEET_LAYOUTS,
  SPRITESHEET_MAX_FPS,
  SPRITESHEET_MAX_FRAMES,
  SPRITESHEET_MIN_FPS,
} from "../types.js";
import type { RawImage, SpritesheetLayout, SpritesheetPackOptions } from "../types.js";

// ---------------------------------------------------------------------------
// pack_spritesheet — the MCP contract layer.
//
// This file owns ONLY: argument validation, frame loading (asset_id | path),
// response formatting, and the optional out_path write. The layout geometry
// lives in ../packing/metadata-builder.js and the compositing in
// ../packing/spritesheet-packer.js; neither touches disk.
//
// Independent of the generation tools by design — it packs any equally-sized
// frame set. Passing generate_animation_set's per-frame asset_ids straight
// through is the convenient path, not a required one.
// ---------------------------------------------------------------------------

const frameSchema = z
  .object({
    asset_id: z
      .string()
      .optional()
      .describe("Registered asset id (e.g. a generate_animation_set frame). One of asset_id or path."),
    path: z
      .string()
      .optional()
      .describe(
        "Path to a frame image: absolute, or relative to the ComfyUI output directory. " +
          "One of asset_id or path.",
      ),
  })
  .describe("One frame source: exactly one of asset_id or path.");

const packSpritesheetSchema = {
  frames: z
    .array(frameSchema)
    .describe(
      "Frames in PLAYBACK ORDER, each { asset_id } or { path }. Order is preserved exactly and " +
        `becomes the frame index in the metadata. 1-${SPRITESHEET_MAX_FRAMES} entries. Every ` +
        "frame must already share the same pixel dimensions — mismatches are rejected, not resized.",
    ),
  layout: z
    .enum(SPRITESHEET_LAYOUTS)
    .optional()
    .describe(
      `Sheet layout (default "${DEFAULT_SPRITESHEET_LAYOUT}"): "grid" wraps at 'columns', ` +
        '"horizontal" is a single row, "vertical" a single column.',
    ),
  columns: z
    .number()
    .optional()
    .describe(
      'Frames per row. Layout "grid" only (rejected for horizontal/vertical). ' +
        "Defaults to the squarest grid, ceil(sqrt(frame_count)).",
    ),
  fps: z
    .number()
    .optional()
    .describe(
      `Suggested playback rate written into the metadata (${SPRITESHEET_MIN_FPS}-${SPRITESHEET_MAX_FPS}, ` +
        `default ${DEFAULT_SPRITESHEET_FPS}). Metadata only — it does not change the packed pixels.`,
    ),
  pivot_x: z
    .number()
    .optional()
    .describe(
      `Normalized pivot X inside one frame, 0-1 (default ${DEFAULT_SPRITE_PIVOT.x}). 0 = left edge.`,
    ),
  pivot_y: z
    .number()
    .optional()
    .describe(
      `Normalized pivot Y inside one frame, 0-1 (default ${DEFAULT_SPRITE_PIVOT.y}). ` +
        "0 = BOTTOM edge (engine pivot convention), 1 = top edge.",
    ),
  out_path: z
    .string()
    .optional()
    .describe("Optional path under the ComfyUI output directory to also write the packed PNG to."),
};

interface FrameArg {
  asset_id?: string;
  path?: string;
}

type PackSpritesheetArgs = {
  frames: FrameArg[];
  layout?: SpritesheetLayout;
  columns?: number;
  fps?: number;
  pivot_x?: number;
  pivot_y?: number;
  out_path?: string;
};

function resolveOptions(args: PackSpritesheetArgs): SpritesheetPackOptions {
  return {
    layout: args.layout ?? DEFAULT_SPRITESHEET_LAYOUT,
    columns: args.columns,
    fps: args.fps ?? DEFAULT_SPRITESHEET_FPS,
    pivot: {
      x: args.pivot_x ?? DEFAULT_SPRITE_PIVOT.x,
      y: args.pivot_y ?? DEFAULT_SPRITE_PIVOT.y,
    },
  };
}

interface LoadedFrames {
  readonly images: RawImage[];
  readonly sources: string[];
}

/** Frames load sequentially so the first bad entry is reported by its index. */
async function loadFrames(frames: readonly FrameArg[]): Promise<LoadedFrames> {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new ValidationError("frames must be a non-empty array of { asset_id } or { path } entries.");
  }
  if (frames.length > SPRITESHEET_MAX_FRAMES) {
    throw new ValidationError(
      `frames may contain at most ${SPRITESHEET_MAX_FRAMES} entries (got ${frames.length}).`,
    );
  }

  const images: RawImage[] = [];
  const sources: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const context = `frames[${i}]`;
    const loaded = await loadImageSource(
      { assetId: frames[i]?.asset_id, path: frames[i]?.path },
      context,
    );
    try {
      images.push(await decodeFrameImage(loaded.bytes));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`${context}: could not decode "${loaded.label}": ${message}`);
    }
    sources.push(loaded.label);
  }
  return { images, sources };
}

export function registerPackSpritesheetTool(server: McpServer): void {
  server.tool(
    "pack_spritesheet",
    "Pack ordered sprite frames into ONE spritesheet PNG plus engine-agnostic JSON metadata " +
      "(per-frame rects, fps, normalized pivot) ready for export_for_engine or a hand-written " +
      "importer. Frames come from asset_ids (e.g. generate_animation_set output) or file paths, " +
      "and keep the order given. Layout is a fixed-cell grid, single row, or single column; every " +
      "frame MUST already share the same dimensions — mismatched frames are rejected, never " +
      "cropped or rescaled. Alpha is preserved and unused cells stay transparent. Frame rects use " +
      "TOP-LEFT origin with y increasing downward; engines that count from the bottom-left convert " +
      "at export time. Returns the sheet inline as a PNG and optionally writes it to out_path.",
    packSpritesheetSchema,
    async (args: PackSpritesheetArgs) => {
      try {
        const options = resolveOptions(args);
        const { images, sources } = await loadFrames(args.frames);

        let packed;
        try {
          packed = await packSpritesheet(images, options);
        } catch (err) {
          if (err instanceof ComfyUIError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new ValidationError(`Failed to pack the spritesheet: ${message}`);
        }

        let outPath: string | undefined;
        if (args.out_path) {
          outPath = await resolveWritableOutputPath(args.out_path, "out_path");
          await writeFile(outPath, packed.png);
        }

        const summary = {
          frame_count: packed.metadata.frame_count,
          sheet_bytes: packed.png.length,
          out_path: outPath,
          sources,
          metadata: packed.metadata,
          note:
            "frames[].x/y are TOP-LEFT origin (y down). pivot is normalized inside one frame " +
            "(y=0 is the bottom edge). Pass this metadata to export_for_engine for a Unity " +
            "import, or slice manually with it.",
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(summary, null, 2) },
            { type: "image" as const, data: packed.png.toString("base64"), mimeType: "image/png" },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
