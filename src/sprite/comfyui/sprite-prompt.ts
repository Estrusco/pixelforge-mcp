import type { MotionState, Style, Viewpoint } from "../types.js";
import {
  SPRITE_BASE_NEGATIVE,
  SPRITE_BASE_POSITIVE,
  STYLE_PROFILES,
  VIEWPOINT_PROFILES,
} from "./style-profiles.js";

// Pure prompt composition. Style and viewpoint fragments are concatenated from
// two independent tables (see style-profiles.ts) — neither one can override the
// other's contribution. Kept trivial on purpose: prompt-template refinement is
// the `prompt-engineer` domain.

export interface ComposedPrompt {
  readonly positive: string;
  readonly negative: string;
}

function joinFragments(fragments: readonly (string | undefined)[]): string {
  return fragments
    .map((f) => f?.trim())
    .filter((f): f is string => f !== undefined && f.length > 0)
    .join(", ");
}

export interface SpritePromptInput {
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly style: Style;
  readonly viewpoint: Viewpoint;
}

export function composeSpritePrompt(input: SpritePromptInput): ComposedPrompt {
  const style = STYLE_PROFILES[input.style];
  const viewpoint = VIEWPOINT_PROFILES[input.viewpoint];

  return {
    // Subject first: CLIP weights early tokens more heavily, and the caller's
    // subject matters more than the aesthetic modifiers.
    positive: joinFragments([
      input.prompt,
      ...style.positive,
      ...viewpoint.positive,
      ...SPRITE_BASE_POSITIVE,
    ]),
    negative: joinFragments([
      input.negativePrompt,
      ...style.negative,
      ...viewpoint.negative,
      ...SPRITE_BASE_NEGATIVE,
    ]),
  };
}

/**
 * Coarse, ordered phase descriptors. Deliberately generic ("the motion", never
 * "the stride" / "the step") so they carry no gait, no limbs, and no biped
 * assumption — they read the same for a slither, a wing flap, or a spin.
 *
 * These exist because a bare ordinal is weakly grounded: CLIP-family text
 * encoders barely distinguish "phase 2 of 4" from "phase 3 of 4", but they do
 * ground start / early / midpoint / late / end, which appear all over the
 * captions they were trained on. The descriptor is the part a model can act on.
 */
const PHASE_DESCRIPTORS: readonly string[] = [
  "at the start of the motion",
  "early in the motion",
  "at the midpoint of the motion",
  "late in the motion",
  "at the end of the motion",
];

/**
 * Phase cue for one frame, or `undefined` for a single-frame state (there is no
 * phase to describe, and naming one would only add unearned tokens).
 *
 * The trailing ordinal is NOT a pose instruction — it is a uniqueness guarantee.
 * Descriptors collide once `framesPerState` exceeds their count, and in an
 * `img2img_low_denoise` chain (fixed seed, low denoise, previous frame as the
 * reference) two frames with byte-identical prompts have nothing left to tell
 * them apart. The ordinal keeps every frame's conditioning distinct at the cost
 * of two tokens, placed last where it carries the least weight.
 */
function composePhaseCue(frameIndex: number, framesPerState: number): string | undefined {
  if (framesPerState <= 1) return undefined;
  const progress = frameIndex / (framesPerState - 1);
  const descriptor = PHASE_DESCRIPTORS[Math.round(progress * (PHASE_DESCRIPTORS.length - 1))];
  return `${descriptor}, motion phase ${frameIndex + 1}`;
}

export interface MotionFramePromptInput {
  /** The caller's subject prompt, shared by every frame of the set. */
  readonly prompt: string;
  /** Free-form motion state (LOCKED: never a fixed humanoid vocabulary). */
  readonly motionState: MotionState;
  /** 0-based index within the motion state. */
  readonly frameIndex: number;
  readonly framesPerState: number;
}

/**
 * Fold one motion state (and, for multi-frame states, the frame's phase) into
 * the subject prompt. The result is the `prompt` of a `SpriteJobRequest`, so it
 * still goes through `composeSpritePrompt` for style/viewpoint conditioning —
 * this only produces the SUBJECT half.
 *
 * The motion state is passed through verbatim apart from underscore/dash
 * humanization: it is free-form by design ("slither", "flap", "cast_spell"),
 * so there is no vocabulary to map it against and none may be introduced.
 *
 * The phase cue is the only per-frame variation in an `img2img_low_denoise`
 * chain (seed and reference identity are deliberately held steady). It nudges
 * the pose without a pose skeleton — approximate motion is the KNOWN and
 * ACCEPTED limitation of this mode, not a defect to engineer around.
 *
 * Fragment order is load-bearing: subject, then motion, then phase. The subject
 * must stay first (early tokens dominate, and it is the only thing holding
 * identity together across states, each of which restarts from txt2img), and
 * the phase must stay last so a per-frame nudge can never outweigh the
 * character. Style and viewpoint are appended downstream by
 * `composeSpritePrompt` and are never referenced here — the two axes stay
 * independent, and this function contributes to neither.
 */
export function composeMotionFramePrompt(input: MotionFramePromptInput): string {
  // Trim LAST: a state of only separators ("_", "--") humanizes to whitespace,
  // and trimming first would leave it truthy — emitting a bare "animation pose"
  // with no motion in front of it.
  const motion = input.motionState.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const phase = composePhaseCue(input.frameIndex, input.framesPerState);
  return joinFragments([input.prompt, motion ? `${motion} animation pose` : undefined, phase]);
}
