import { mkdtempSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SpritesheetMetadata } from "../../sprite/types.js";

// ── Mock only the output-dir seam ───────────────────────────────────────────
// export_for_engine reads its sheet via an ABSOLUTE `sheet_path`, which
// resolveReadablePath (image-io.js) passes through untouched — no mock
// needed there. Writing `out_path` DOES consult resolveOutputDir, so that's
// the one seam pointed at a real scratch directory instead of ComfyUI's.

const outRoot = mkdtempSync(join(tmpdir(), "pixelforge-export-out-"));

vi.mock("../../services/output-dir.js", () => ({
  resolveOutputDir: () => Promise.resolve(outRoot),
  resolveInputDir: () => Promise.resolve("/comfy/input"),
}));

// ── Fake McpServer that captures tool handlers ──────────────────────────────

type ToolResult = { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function fakeServer(): { server: McpServer; tools: Map<string, ToolHandler> } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

interface UnitySpriteJson {
  name: string;
  frame_index: number;
  rect: { x: number; y: number; width: number; height: number };
  pivot: { x: number; y: number };
}

interface ToolBody {
  error?: string;
  message?: string;
  engine?: string;
  sprite_count?: number;
  out_png_path?: string;
  out_json_path?: string;
  out_meta_path?: string;
  out_meta_written?: boolean;
  out_meta_skipped_existing?: boolean;
  save_png_path?: string;
  save_json_path?: string;
  save_meta_path?: string;
  save_meta_written?: boolean;
  save_meta_skipped_existing?: boolean;
  metadata?: {
    version: 1;
    engine: "unity";
    sheet_width: number;
    sheet_height: number;
    pixels_per_unit: number;
    fps: number;
    sprites: UnitySpriteJson[];
  };
}

function parse(result: ToolResult): ToolBody {
  return JSON.parse(result.content[0].text ?? "{}") as ToolBody;
}

async function getHandler(): Promise<ToolHandler> {
  const { registerExportForEngineTool } = await import("../../sprite/tools/export-for-engine.js");
  const { server, tools } = fakeServer();
  registerExportForEngineTool(server);
  const handler = tools.get("export_for_engine");
  if (!handler) throw new Error("export_for_engine was not registered");
  return handler;
}

// A real 4x8 sheet: 1 column x 2 rows of 4x4 frames, distinguishable by color
// (frame 0 red, frame 1 blue) so a wrong composite would be visible if this
// test ever needed to inspect pixels — it currently only checks geometry.
let sheetPath: string;

const TWO_ROW_METADATA: SpritesheetMetadata = {
  version: 1,
  frame_width: 4,
  frame_height: 4,
  sheet_width: 4,
  sheet_height: 8,
  layout: "vertical",
  columns: 1,
  rows: 2,
  frame_count: 2,
  fps: 12,
  pivot: { x: 0.5, y: 0 },
  frames: [
    { index: 0, x: 0, y: 0, width: 4, height: 4 },
    { index: 1, x: 0, y: 4, width: 4, height: 4 },
  ],
};

const BASE_ARGS = {
  engine: "unity",
  metadata: TWO_ROW_METADATA,
  sprite_name: "Player",
};

describe("export_for_engine", () => {
  beforeAll(async () => {
    sheetPath = join(outRoot, "sheet-src.png");
    const png = await sharp({
      create: { width: 4, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 255 } },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
        {
          input: await sharp({
            create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 255 } },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 4,
        },
      ])
      .png()
      .toBuffer();
    await sharp(png).toFile(sheetPath);
  });

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(outRoot, { recursive: true, force: true });
  });

  // ── LOCKED DECISION: unimplemented engines are rejected, never a no-op ────

  it('rejects engine "godot" with a clear message and no side effects', async () => {
    const handler = await getHandler();
    const result = await handler({ ...BASE_ARGS, engine: "godot", sheet_path: "/does/not/exist.png" });

    expect(result.isError).toBe(true);
    const body = parse(result);
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toContain('not implemented');
    expect(body.message).toContain("unity");
  });

  it('rejects engine "gamemaker" the same way', async () => {
    const handler = await getHandler();
    const result = await handler({ ...BASE_ARGS, engine: "gamemaker", sheet_path: sheetPath });
    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain("not implemented");
  });

  // ── Metadata boundary validation ────────────────────────────────────────

  it("rejects a frame_count that does not match frames.length", async () => {
    const handler = await getHandler();
    const result = await handler({
      ...BASE_ARGS,
      sheet_path: sheetPath,
      metadata: { ...TWO_ROW_METADATA, frame_count: 3 },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain("frame_count");
  });

  it("rejects a frame rect that falls outside the declared sheet bounds", async () => {
    const handler = await getHandler();
    const result = await handler({
      ...BASE_ARGS,
      sheet_path: sheetPath,
      metadata: {
        ...TWO_ROW_METADATA,
        frames: [
          { index: 0, x: 0, y: 0, width: 4, height: 4 },
          { index: 1, x: 0, y: 6, width: 4, height: 4 }, // 6+4=10 > sheet_height 8
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain("outside the declared");
  });

  it("rejects sprite_name when empty", async () => {
    const handler = await getHandler();
    const result = await handler({ ...BASE_ARGS, sheet_path: sheetPath, sprite_name: "   " });
    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain("sprite_name");
  });

  it("rejects a sheet image whose dimensions do not match the metadata", async () => {
    const handler = await getHandler();
    const result = await handler({
      ...BASE_ARGS,
      sheet_path: sheetPath,
      metadata: { ...TWO_ROW_METADATA, sheet_width: 999 },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain("999");
  });

  // ── The actual Unity translation ────────────────────────────────────────

  it("flips top-left/y-down rects to Unity's bottom-left/y-up convention", async () => {
    const handler = await getHandler();
    const body = parse(await handler({ ...BASE_ARGS, sheet_path: sheetPath }));

    expect(body.metadata?.engine).toBe("unity");
    expect(body.metadata?.sheet_width).toBe(4);
    expect(body.metadata?.sheet_height).toBe(8);
    expect(body.sprite_count).toBe(2);

    const [frame0, frame1] = body.metadata!.sprites;
    // Image-space frame 0 sits at the TOP (y=0..4); Unity's bottom-left origin
    // puts it at the UPPER half of the texture: y = 8 - 0 - 4 = 4.
    expect(frame0).toMatchObject({ name: "Player_0", frame_index: 0, rect: { x: 0, y: 4, width: 4, height: 4 } });
    // Image-space frame 1 sits at the BOTTOM (y=4..8); in Unity's convention
    // that is y = 8 - 4 - 4 = 0, i.e. the texture's actual bottom.
    expect(frame1).toMatchObject({ name: "Player_1", frame_index: 1, rect: { x: 0, y: 0, width: 4, height: 4 } });
  });

  it("passes the normalized pivot through unchanged", async () => {
    const handler = await getHandler();
    const body = parse(await handler({ ...BASE_ARGS, sheet_path: sheetPath }));
    for (const sprite of body.metadata!.sprites) {
      expect(sprite.pivot).toEqual({ x: 0.5, y: 0 });
    }
  });

  it("defaults pixels_per_unit to 100 and accepts an override", async () => {
    const handler = await getHandler();
    const defaulted = parse(await handler({ ...BASE_ARGS, sheet_path: sheetPath }));
    expect(defaulted.metadata?.pixels_per_unit).toBe(100);

    const overridden = parse(
      await handler({ ...BASE_ARGS, sheet_path: sheetPath, pixels_per_unit: 16 }),
    );
    expect(overridden.metadata?.pixels_per_unit).toBe(16);
  });

  it("rejects a non-positive pixels_per_unit", async () => {
    const handler = await getHandler();
    const result = await handler({ ...BASE_ARGS, sheet_path: sheetPath, pixels_per_unit: 0 });
    expect(result.isError).toBe(true);
    expect(parse(result).message).toContain("pixels_per_unit");
  });

  // ── out_path: PNG + sibling .json written together ─────────────────────

  it("writes the PNG and a sibling .json when out_path is given", async () => {
    const handler = await getHandler();
    const body = parse(
      await handler({ ...BASE_ARGS, sheet_path: sheetPath, out_path: "Player.png" }),
    );

    expect(body.out_png_path).toBe(join(outRoot, "Player.png"));
    expect(body.out_json_path).toBe(join(outRoot, "Player.json"));

    const writtenPng = readFileSync(body.out_png_path!);
    expect(writtenPng.length).toBeGreaterThan(0);
    const writtenJson = JSON.parse(readFileSync(body.out_json_path!, "utf-8"));
    expect(writtenJson).toEqual(body.metadata);
  });

  it("returns both PNG and JSON inline when out_path is omitted", async () => {
    const handler = await getHandler();
    const result = await handler({ ...BASE_ARGS, sheet_path: sheetPath });
    const body = parse(result);

    expect(body.out_png_path).toBeUndefined();
    expect(body.out_json_path).toBeUndefined();
    expect(result.content[1].type).toBe("image");
    expect(result.content[1].data).toBeTruthy();
  });

  // ── save_dir: arbitrary local directory, independent of COMFYUI_PATH ────

  describe("save_dir", () => {
    let saveDir: string;

    beforeEach(() => {
      saveDir = mkdtempSync(join(tmpdir(), "pixelforge-export-save-"));
    });

    afterEach(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(saveDir, { recursive: true, force: true });
    });

    it("writes '<sprite_name>.png/.json' to an arbitrary save_dir", async () => {
      const handler = await getHandler();
      const body = parse(
        await handler({ ...BASE_ARGS, sheet_path: sheetPath, save_dir: saveDir }),
      );

      expect(body.save_png_path).toBe(join(saveDir, "Player.png"));
      expect(body.save_json_path).toBe(join(saveDir, "Player.json"));
      expect(readFileSync(body.save_png_path!).length).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(body.save_json_path!, "utf-8"))).toEqual(body.metadata);
    });

    it("sanitizes a sprite_name that isn't a safe bare filename", async () => {
      const handler = await getHandler();
      const body = parse(
        await handler({
          ...BASE_ARGS,
          sheet_path: sheetPath,
          sprite_name: "../../evil/Player Name!",
          save_dir: saveDir,
        }),
      );

      expect(body.save_png_path).toBe(join(saveDir, "Player_Name_.png"));
      expect(readFileSync(body.save_png_path!).length).toBeGreaterThan(0);
    });
  });

  // ── generate_meta: Unity .meta generation ───────────────────────────────

  describe("generate_meta", () => {
    let unityRoot: string;
    let assetsSprites: string;
    let plainDir: string;

    beforeEach(async () => {
      unityRoot = mkdtempSync(join(tmpdir(), "pixelforge-export-unity-"));
      assetsSprites = join(unityRoot, "Assets", "Sprites");
      await mkdir(assetsSprites, { recursive: true });
      await mkdir(join(unityRoot, "ProjectSettings"), { recursive: true });

      plainDir = mkdtempSync(join(tmpdir(), "pixelforge-export-plain-"));
    });

    afterEach(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(unityRoot, { recursive: true, force: true });
      await rm(plainDir, { recursive: true, force: true });
    });

    it("auto-detects a Unity project under save_dir and writes a .meta", async () => {
      const handler = await getHandler();
      const body = parse(
        await handler({ ...BASE_ARGS, sheet_path: sheetPath, save_dir: assetsSprites }),
      );

      expect(body.save_meta_path).toBe(`${body.save_png_path}.meta`);
      expect(body.save_meta_written).toBe(true);
      expect(body.save_meta_skipped_existing).toBe(false);

      const meta = readFileSync(body.save_meta_path!, "utf-8");
      expect(meta).toContain("guid: ");
      expect(meta).toMatch(/textureType:\s*8/);
      expect(meta).toContain(`spritePixelsToUnits: ${body.metadata?.pixels_per_unit}`);
    });

    it("does not write a .meta outside a detected Unity project by default", async () => {
      const handler = await getHandler();
      const body = parse(await handler({ ...BASE_ARGS, sheet_path: sheetPath, save_dir: plainDir }));

      expect(body.save_meta_path).toBeUndefined();
      expect(body.save_meta_written).toBeUndefined();
    });

    it("generate_meta:true forces a .meta even outside a detected Unity project", async () => {
      const handler = await getHandler();
      const body = parse(
        await handler({ ...BASE_ARGS, sheet_path: sheetPath, save_dir: plainDir, generate_meta: true }),
      );

      expect(body.save_meta_written).toBe(true);
      expect(readFileSync(body.save_meta_path!, "utf-8")).toContain("fileFormatVersion: 2");
    });

    it("generate_meta:false suppresses a .meta even inside a detected Unity project", async () => {
      const handler = await getHandler();
      const body = parse(
        await handler({ ...BASE_ARGS, sheet_path: sheetPath, save_dir: assetsSprites, generate_meta: false }),
      );

      expect(body.save_meta_path).toBeUndefined();
      expect(body.save_meta_written).toBeUndefined();
    });

    it("NEVER overwrites an existing .meta — skips and reports it instead", async () => {
      const handler = await getHandler();
      // First call creates Player.png + Player.png.meta.
      const first = parse(
        await handler({ ...BASE_ARGS, sheet_path: sheetPath, save_dir: assetsSprites }),
      );
      expect(first.save_meta_written).toBe(true);
      await writeFile(first.save_meta_path!, "HAND-EDITED — DO NOT TOUCH\n");

      // Second call must not clobber the human-edited .meta.
      const second = parse(
        await handler({ ...BASE_ARGS, sheet_path: sheetPath, save_dir: assetsSprites }),
      );
      expect(second.save_meta_written).toBe(false);
      expect(second.save_meta_skipped_existing).toBe(true);
      expect(readFileSync(second.save_meta_path!, "utf-8")).toBe("HAND-EDITED — DO NOT TOUCH\n");
    });

    it("generate_meta requires out_path or save_dir", async () => {
      const handler = await getHandler();
      const result = await handler({ ...BASE_ARGS, sheet_path: sheetPath, generate_meta: true });
      expect(result.isError).toBe(true);
      expect(parse(result).message).toContain("generate_meta requires");
    });

    it("writes independent .meta files for out_path and save_dir when both are given", async () => {
      const handler = await getHandler();
      const body = parse(
        await handler({
          ...BASE_ARGS,
          sheet_path: sheetPath,
          out_path: "Player.png",
          save_dir: assetsSprites,
        }),
      );

      // out_path lands in outRoot (not a Unity project) -> no .meta by default.
      expect(body.out_meta_path).toBeUndefined();
      // save_dir lands inside the detected Unity project -> .meta written.
      expect(body.save_meta_written).toBe(true);
    });
  });
});
