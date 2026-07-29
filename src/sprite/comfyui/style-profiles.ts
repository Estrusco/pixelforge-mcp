import type { Style, Viewpoint } from "../types.js";

// ---------------------------------------------------------------------------
// Style and viewpoint profiles — pure data, no I/O.
//
// LOCKED DECISION (CLAUDE.md): `style` and `viewpoint` are INDEPENDENT axes.
// This file enforces that STRUCTURALLY rather than by convention: there are two
// separate tables, and `ViewpointProfile` has no checkpoint, sampler, or family
// field at all. It is therefore impossible to express "topdown implies
// checkpoint X" — a camera angle can only ever contribute prompt conditioning.
//
// The corollary is that the checkpoint mapping is keyed by STYLE ALONE. A
// checkpoint encodes a rendering aesthetic (pixel art, anime/chibi, painterly);
// framing is a compositional property the same weights render fine either way.
// A (style x viewpoint) table would both conflate the axes and grow O(S*V) with
// nothing to say in most cells; these two tables grow O(S+V) and compose.
//
// Prompt fragments here are deliberately terse. Prompt-template refinement is
// the `prompt-engineer` domain and will be revisited — do not grow a prompt DSL
// in this file.
// ---------------------------------------------------------------------------

/**
 * Base-model family a style's checkpoint candidates belong to. Used ONLY to
 * rank unknown local checkpoints when none of the named candidates are
 * installed (see checkpoint-resolver.ts). It is not a second mapping axis.
 */
export type ModelFamily = "sd15" | "sdxl";

export interface StyleProfile {
  readonly family: ModelFamily;
  /**
   * Checkpoint filenames in preference order. Best-effort guesses for a typical
   * Stability Matrix install — a miss is expected and handled by the resolver's
   * fallback, never by a hard failure.
   */
  readonly checkpointCandidates: readonly string[];
  readonly steps: number;
  readonly cfg: number;
  readonly samplerName: string;
  readonly scheduler: string;
  readonly positive: readonly string[];
  readonly negative: readonly string[];
}

/** Camera framing only. Intentionally has NO model or sampling fields. */
export interface ViewpointProfile {
  readonly positive: readonly string[];
  readonly negative: readonly string[];
}

/** Applies to every sprite regardless of style or viewpoint. */
export const SPRITE_BASE_POSITIVE: readonly string[] = [
  "game sprite",
  "single centered subject",
  "plain flat background",
];

export const SPRITE_BASE_NEGATIVE: readonly string[] = [
  "text",
  "watermark",
  "signature",
  "multiple characters",
  "cropped",
  "frame",
  "border",
];

// NOTE (model gap, flagged rather than silently absorbed): the 8bit/16bit/32bit
// profiles reach their look through the checkpoint and prompt alone. A dedicated
// pixel-art LoRA would materially improve them, but LoRA wiring is not part of
// this tool's graph yet and no specific LoRA file is known to be installed. The
// pipeline is correct without one — pixelate_image does the actual grid/palette
// work downstream — so this is a quality ceiling, not a broken path.
export const STYLE_PROFILES: Record<Style, StyleProfile> = {
  "8bit": {
    family: "sd15",
    checkpointCandidates: [
      "v1-5-pruned-emaonly.safetensors",
      "v1-5-pruned-emaonly-fp16.safetensors",
      "dreamshaper_8.safetensors",
    ],
    steps: 20,
    cfg: 7.0,
    samplerName: "euler_ancestral",
    scheduler: "normal",
    positive: ["8-bit pixel art", "NES era sprite", "chunky pixels", "very limited palette"],
    negative: ["photorealistic", "smooth gradients", "anti-aliased edges", "3d render"],
  },
  "16bit": {
    family: "sd15",
    checkpointCandidates: [
      "v1-5-pruned-emaonly.safetensors",
      "v1-5-pruned-emaonly-fp16.safetensors",
      "dreamshaper_8.safetensors",
    ],
    steps: 24,
    cfg: 7.0,
    samplerName: "euler_ancestral",
    scheduler: "normal",
    positive: ["16-bit pixel art", "SNES era sprite", "crisp pixel clusters", "limited palette"],
    negative: ["photorealistic", "smooth gradients", "anti-aliased edges", "3d render"],
  },
  "32bit": {
    family: "sd15",
    checkpointCandidates: [
      "dreamshaper_8.safetensors",
      "v1-5-pruned-emaonly.safetensors",
      "v1-5-pruned-emaonly-fp16.safetensors",
    ],
    steps: 28,
    cfg: 7.0,
    samplerName: "dpmpp_2m",
    scheduler: "karras",
    positive: ["32-bit era sprite art", "detailed pixel shading", "rich palette", "clean outlines"],
    negative: ["photorealistic", "blurry", "3d render"],
  },
  chibi: {
    family: "sdxl",
    checkpointCandidates: [
      "animagineXLV31_v31.safetensors",
      "ponyDiffusionV6XL.safetensors",
      "sd_xl_base_1.0.safetensors",
    ],
    steps: 30,
    cfg: 7.5,
    samplerName: "dpmpp_2m",
    scheduler: "karras",
    positive: ["chibi character", "oversized head", "small rounded body", "clean cel shading", "bold outlines"],
    negative: ["realistic proportions", "photorealistic", "gritty", "blurry"],
  },
  hand_painted: {
    family: "sdxl",
    checkpointCandidates: ["sd_xl_base_1.0.safetensors", "juggernautXL_v9.safetensors"],
    steps: 30,
    cfg: 7.0,
    samplerName: "dpmpp_2m",
    scheduler: "karras",
    positive: ["hand-painted game art", "painterly brush strokes", "soft shading", "stylized illustration"],
    negative: ["pixelated", "photorealistic", "flat vector", "blurry"],
  },
  flat_vector: {
    family: "sdxl",
    checkpointCandidates: ["sd_xl_base_1.0.safetensors", "juggernautXL_v9.safetensors"],
    steps: 26,
    cfg: 6.5,
    samplerName: "euler",
    scheduler: "normal",
    positive: ["flat vector art", "solid color fills", "clean geometric shapes", "bold even outlines"],
    negative: ["gradients", "texture noise", "painterly", "photorealistic", "3d render"],
  },
  realistic: {
    family: "sdxl",
    checkpointCandidates: ["juggernautXL_v9.safetensors", "sd_xl_base_1.0.safetensors"],
    steps: 30,
    cfg: 7.0,
    samplerName: "dpmpp_2m",
    scheduler: "karras",
    positive: ["realistic rendered game asset", "detailed materials", "physically plausible lighting"],
    negative: ["cartoon", "flat shading", "pixelated", "blurry"],
  },
};

export const VIEWPOINT_PROFILES: Record<Viewpoint, ViewpointProfile> = {
  side: {
    positive: ["side view", "orthographic side profile", "subject facing right"],
    negative: ["three-quarter view", "front view", "perspective distortion"],
  },
  topdown: {
    positive: ["top-down view", "seen directly from above", "overhead orthographic perspective"],
    negative: ["side view", "horizon line", "front-facing portrait"],
  },
  isometric: {
    positive: ["isometric view", "three-quarter overhead angle", "2:1 isometric projection"],
    negative: ["flat front view", "one-point perspective", "top-down view"],
  },
};
