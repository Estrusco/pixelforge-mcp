import { ValidationError } from "../utils/errors.js";
import { SPRITE_DIM_MAX, SPRITE_DIM_MIN, SPRITE_DIM_STEP, SPRITE_SEED_MAX } from "./types.js";

// ---------------------------------------------------------------------------
// Tool-layer argument validation shared by every generation tool
// (generate_sprite, generate_animation_set, and later
// generate_arcade_topdown_set).
//
// The BOUNDS live in types.ts (SPRITE_DIM_* / SPRITE_SEED_MAX); this module is
// only the checks that enforce them, so the tools cannot drift apart on either
// the rule or the wording of the rejection. Each tool still owns the validation
// that is genuinely its own (motion-state lists, frame caps, the img2img-only
// gate on denoise) — that belongs next to the schema it validates.
//
// Pure: no disk I/O, no ComfyUI knowledge, no MCP knowledge.
// ---------------------------------------------------------------------------

/** Canvas dimension check: integer, within bounds, and latent-aligned. */
export function assertSpriteDimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value < SPRITE_DIM_MIN || value > SPRITE_DIM_MAX) {
    throw new ValidationError(
      `${label} must be an integer between ${SPRITE_DIM_MIN} and ${SPRITE_DIM_MAX} (got ${value}).`,
    );
  }
  if (value % SPRITE_DIM_STEP !== 0) {
    throw new ValidationError(
      `${label} must be a multiple of ${SPRITE_DIM_STEP} (got ${value}); diffusion latents are 1/8 scale.`,
    );
  }
  return value;
}

/** Caller seed if valid, otherwise a fresh random one. Never returns undefined. */
export function resolveSpriteSeed(seed: number | undefined): number {
  if (seed === undefined) return Math.floor(Math.random() * SPRITE_SEED_MAX);
  if (!Number.isInteger(seed) || seed < 0 || seed > Number.MAX_SAFE_INTEGER) {
    throw new ValidationError(
      `seed must be a non-negative integer <= ${Number.MAX_SAFE_INTEGER} (got ${seed}).`,
    );
  }
  return seed;
}

/**
 * Range check only: 0 < denoise <= 1. Whether denoise is *applicable* at all is
 * per-tool policy — generate_sprite rejects it without a reference image,
 * generate_animation_set defaults it — so that stays with the caller.
 */
export function assertDenoiseRange(denoise: number): number {
  if (!Number.isFinite(denoise) || denoise <= 0 || denoise > 1) {
    throw new ValidationError(`denoise must satisfy 0 < denoise <= 1 (got ${denoise}).`);
  }
  return denoise;
}
