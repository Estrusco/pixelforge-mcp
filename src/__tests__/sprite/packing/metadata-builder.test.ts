import { describe, expect, it } from "vitest";
import { buildSpritesheetMetadata } from "../../../sprite/packing/metadata-builder.js";
import {
  DEFAULT_SPRITESHEET_FPS,
  DEFAULT_SPRITE_PIVOT,
  SPRITESHEET_MAX_FRAMES,
} from "../../../sprite/types.js";
import type { SpritesheetPackOptions } from "../../../sprite/types.js";

// Layout geometry is pure arithmetic, so it is asserted as arithmetic — no
// image decoding involved. These tests pin the parts of the metadata document
// that are a PUBLIC CONTRACT: rect origin (top-left, y down), playback order ==
// frame index, and the uniform-cell layout.

const FRAME = { width: 32, height: 24 };

function options(overrides: Partial<SpritesheetPackOptions> = {}): SpritesheetPackOptions {
  return {
    layout: "grid",
    fps: DEFAULT_SPRITESHEET_FPS,
    pivot: DEFAULT_SPRITE_PIVOT,
    ...overrides,
  };
}

describe("buildSpritesheetMetadata", () => {
  it("lays a grid out left-to-right then top-to-bottom, top-left origin", () => {
    const meta = buildSpritesheetMetadata(5, FRAME, options({ columns: 3 }));

    expect(meta.columns).toBe(3);
    expect(meta.rows).toBe(2);
    expect(meta.sheet_width).toBe(96);
    expect(meta.sheet_height).toBe(48);
    expect(meta.frames.map((f) => [f.index, f.x, f.y])).toEqual([
      [0, 0, 0],
      [1, 32, 0],
      [2, 64, 0],
      [3, 0, 24],
      [4, 32, 24],
    ]);
    // The 6th cell is left empty rather than filled by reordering frames.
    expect(meta.frame_count).toBe(5);
  });

  it("defaults a grid to the squarest column count", () => {
    expect(buildSpritesheetMetadata(9, FRAME, options()).columns).toBe(3);
    expect(buildSpritesheetMetadata(5, FRAME, options()).columns).toBe(3);
    expect(buildSpritesheetMetadata(1, FRAME, options()).columns).toBe(1);
  });

  it("packs horizontal into one row and vertical into one column", () => {
    const horizontal = buildSpritesheetMetadata(4, FRAME, options({ layout: "horizontal" }));
    expect([horizontal.columns, horizontal.rows]).toEqual([4, 1]);
    expect(horizontal.sheet_height).toBe(FRAME.height);

    const vertical = buildSpritesheetMetadata(4, FRAME, options({ layout: "vertical" }));
    expect([vertical.columns, vertical.rows]).toEqual([1, 4]);
    expect(vertical.sheet_width).toBe(FRAME.width);
  });

  it("rejects columns for non-grid layouts instead of ignoring it", () => {
    expect(() =>
      buildSpritesheetMetadata(4, FRAME, options({ layout: "horizontal", columns: 2 })),
    ).toThrow(/grid/i);
  });

  it("echoes fps and pivot into the document unchanged", () => {
    const meta = buildSpritesheetMetadata(2, FRAME, options({ fps: 8, pivot: { x: 0.5, y: 0 } }));
    expect(meta.fps).toBe(8);
    expect(meta.pivot).toEqual({ x: 0.5, y: 0 });
    expect(meta.version).toBe(1);
    expect(meta.frame_width).toBe(FRAME.width);
    expect(meta.frame_height).toBe(FRAME.height);
  });

  it("rejects an out-of-range fps, pivot, columns and frame count", () => {
    expect(() => buildSpritesheetMetadata(2, FRAME, options({ fps: 0 }))).toThrow(/fps/);
    expect(() => buildSpritesheetMetadata(2, FRAME, options({ fps: 1000 }))).toThrow(/fps/);
    expect(() => buildSpritesheetMetadata(2, FRAME, options({ pivot: { x: 1.5, y: 0.5 } }))).toThrow(
      /pivot_x/,
    );
    expect(() => buildSpritesheetMetadata(2, FRAME, options({ pivot: { x: 0.5, y: -1 } }))).toThrow(
      /pivot_y/,
    );
    expect(() => buildSpritesheetMetadata(2, FRAME, options({ columns: 0 }))).toThrow(/columns/);
    expect(() => buildSpritesheetMetadata(0, FRAME, options())).toThrow(/frame count/);
    expect(() => buildSpritesheetMetadata(SPRITESHEET_MAX_FRAMES + 1, FRAME, options())).toThrow(
      /at most/,
    );
  });

  it("refuses a layout that would exceed the maximum texture dimension", () => {
    expect(() =>
      buildSpritesheetMetadata(64, { width: 512, height: 512 }, options({ layout: "horizontal" })),
    ).toThrow(/maximum texture dimension/);
  });
});
