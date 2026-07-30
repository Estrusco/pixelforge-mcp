import type { SpritesheetMetadata, UnityExportMetadata, UnitySpriteEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Pure Unity translation. No images, no sharp, no disk — an engine-agnostic
// `SpritesheetMetadata` (the pack_spritesheet contract) in, a Unity-flavored
// `UnityExportMetadata` out.
//
// The ONLY thing this module does that pack_spritesheet deliberately does not:
//   - flip each frame rect from top-left/y-down to Unity's bottom-left/y-up
//     texture convention (`engine_y = sheet_height - y - height`, per the
//     locked note on `SpritesheetFrameRect` in types.ts)
//   - name each frame as a sprite (`<sprite_name>_<frame_index>`)
//   - attach Unity's Pixels Per Unit, which has no engine-agnostic meaning
//
// The pivot is passed through UNCHANGED: `SpritePivot` is already normalized
// with y=0 at the frame's bottom edge, which is already Unity's convention.
// ---------------------------------------------------------------------------

export function translateToUnity(
  metadata: SpritesheetMetadata,
  spriteName: string,
  pixelsPerUnit: number,
): UnityExportMetadata {
  const sprites: UnitySpriteEntry[] = metadata.frames.map((rect) => ({
    name: `${spriteName}_${rect.index}`,
    frame_index: rect.index,
    rect: {
      x: rect.x,
      y: metadata.sheet_height - rect.y - rect.height,
      width: rect.width,
      height: rect.height,
    },
    pivot: metadata.pivot,
  }));

  return {
    version: 1,
    engine: "unity",
    sheet_width: metadata.sheet_width,
    sheet_height: metadata.sheet_height,
    pixels_per_unit: pixelsPerUnit,
    fps: metadata.fps,
    sprites,
  };
}
