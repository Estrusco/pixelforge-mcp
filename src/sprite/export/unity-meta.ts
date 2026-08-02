import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Unity .meta generation for export_for_engine's single-sprite path.
//
// LOCKED DECISION UPDATE (CLAUDE.md / locked-decisions.md): MVP originally
// shipped PNG + JSON only, no .meta. Revisited with an explicit mitigation —
// generate `<file>.png.meta` ONLY when it doesn't already exist (never
// overwrite one Unity or a human already created, which would reassign a GUID
// referenced by scenes/prefabs and silently break them) and only for the
// TextureImporter settings this pipeline actually needs correct: Sprite type,
// Single import mode, Point filtering, no compression, the caller's Pixels
// Per Unit. This is NOT a byte-for-byte capture of what the Unity Editor
// itself would write — Unity re-serializes and fills in any other default on
// first import, which is how hand- or script-generated .meta files normally
// interoperate with it.
// ---------------------------------------------------------------------------

/** Unity .meta GUIDs are 32 lowercase hex chars, no dashes. */
export function generateUnityGuid(): string {
  return randomUUID().replace(/-/g, "");
}

export interface UnityTextureMetaOptions {
  readonly guid: string;
  readonly pixelsPerUnit: number;
}

/**
 * A minimal, importable Unity TextureImporter .meta for one sprite texture:
 * `textureType: Sprite` (8), `spriteMode: Single` (1), Point filtering
 * (`filterMode: 0`), no compression (`textureCompression: 0`), and the given
 * Pixels Per Unit (`spritePixelsToUnits`). See the module doc comment above
 * for why this deliberately isn't a full field-for-field Editor capture.
 */
export function buildUnityTextureMeta({ guid, pixelsPerUnit }: UnityTextureMetaOptions): string {
  return `fileFormatVersion: 2
guid: ${guid}
TextureImporter:
  internalIDToNameTable: []
  externalObjects: {}
  serializedVersion: 12
  mipmaps:
    mipMapMode: 0
    enableMipMap: 0
    sRGBTexture: 1
    linearTexture: 0
    fadeOut: 0
    borderMipMap: 0
    mipMapsPreserveCoverage: 0
    alphaTestReferenceValue: 0.5
    mipMapFadeDistanceStart: 1
    mipMapFadeDistanceEnd: 3
  bumpmap:
    convertToNormalMap: 0
    externalNormalMap: 0
    heightScale: 0.25
    normalMapFilter: 0
    flipGreenChannel: 0
  isReadable: 0
  streamingMipmaps: 0
  streamingMipmapsPriority: 0
  vTOnly: 0
  ignoreMipmapLimit: 0
  grayScaleToAlpha: 0
  generateCubemap: 6
  cubemapConvolution: 0
  seamlessCubemap: 0
  textureFormat: 1
  maxTextureSize: 2048
  textureSettings:
    serializedVersion: 2
    filterMode: 0
    aniso: 1
    mipBias: 0
    wrapU: 1
    wrapV: 1
    wrapW: 1
  nPOTScale: 0
  lightmap: 0
  compressionQuality: 50
  spriteMode: 1
  spriteExtrude: 1
  spriteMeshType: 1
  alignment: 0
  spritePivot: {x: 0.5, y: 0.5}
  spritePixelsToUnits: ${pixelsPerUnit}
  spriteBorder: {x: 0, y: 0, z: 0, w: 0}
  spriteGenerateFallbackPhysicsShape: 1
  alphaUsage: 1
  alphaIsTransparency: 1
  spriteTessellationDetail: -1
  textureType: 8
  textureShape: 1
  singleChannelComponent: 0
  flipbookRows: 1
  flipbookColumns: 1
  maxTextureSizeSet: 0
  compressionQualitySet: 0
  textureFormatSet: 0
  platformSettings:
  - serializedVersion: 3
    buildTarget: DefaultTexturePlatform
    maxTextureSize: 2048
    resizeAlgorithm: 0
    textureFormat: -1
    textureCompression: 0
    compressionQuality: 50
    crunchedCompression: 0
    allowsAlphaSplitting: 0
    overridden: 0
  spriteSheet:
    serializedVersion: 2
    sprites: []
    outline: []
    physicsShape: []
    bones: []
    spriteID:
    internalID: 0
    vertices: []
    indices:
    edges: []
    weights: []
    secondaryTextures: []
  spritePackingTag:
  pSDRemoveMatte: 0
  pSDShowRemoveMatteOption: 0
  userData:
  assetBundleName:
  assetBundleVariant:
`;
}

/**
 * Detect whether `absoluteFilePath` sits inside a real Unity project's
 * `Assets/` tree: walk up its ancestors looking for a directory literally
 * named "Assets" whose PARENT also has a sibling `ProjectSettings/` directory
 * — the structural signature every Unity project root has. Never throws; any
 * filesystem error along the way just means "not detected" (heuristic, not
 * an assertion), which is exactly what the caller's `generate_meta` override
 * exists to correct when it guesses wrong.
 */
export async function isInsideUnityProject(absoluteFilePath: string): Promise<boolean> {
  let dir = dirname(absoluteFilePath);
  let prev: string | undefined;
  while (dir !== prev) {
    if (basename(dir) === "Assets") {
      const root = dirname(dir);
      try {
        const info = await stat(join(root, "ProjectSettings"));
        if (info.isDirectory()) return true;
      } catch {
        // Not a real Unity root here — keep walking in case of a nested/
        // unrelated "Assets" directory further up the tree.
      }
    }
    prev = dir;
    dir = dirname(dir);
  }
  return false;
}

/** True when a file already exists at `path` (a directory counts as existing too). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
