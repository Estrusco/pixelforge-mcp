// Shared interfaces for PixelForge sprite tooling. Tool I/O contracts (Style,
// Viewpoint, MotionState, etc.) land here as each tool is implemented. This file
// is the SOURCE OF TRUTH for tool contracts — schemas elsewhere derive from it.

import { ValidationError } from "../utils/errors.js";
import type { ExecutionErrorDetails, ExecutionStats } from "../services/job-history.js";

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

// Alpha-preserving RGBA pixel buffer: 4 bytes/pixel, row-major, uint8 per channel.
export interface RawImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

// Palettes verified against a reachable source at implementation time.
export type LospecPresetSlug = "pico-8" | "sweetie-16" | "endesga-32" | "resurrect-64";

export type PaletteSource =
  | { readonly mode: "auto_kmeans"; readonly paletteSize: number }
  | { readonly mode: "lospec"; readonly slug: LospecPresetSlug }
  | { readonly mode: "custom"; readonly colors: readonly string[] };

export interface QuantizeOptions {
  readonly targetResolution: Dimensions;
  readonly palette: PaletteSource;
  // Default true. 4-neighbor despeckle pass after nearest-color mapping.
  readonly cleanupIsolatedPixels?: boolean;
}

export interface QuantizeResult {
  readonly png: Buffer;
  // Resolved hex colors actually used for the nearest-color mapping.
  readonly palette: readonly string[];
  readonly width: number;
  readonly height: number;
}

// ===========================================================================
// Sprite generation contracts
//
// Shared by generate_sprite and, by design, the three tools that build on it:
// get_sprite_result, generate_animation_set, generate_arcade_topdown_set.
// Widening these (adding a Style value, adding an optional field) is
// non-breaking; renaming or removing anything here is a breaking change to a
// locked tool surface.
// ===========================================================================

/**
 * Rendering aesthetic — WHAT the sprite looks like.
 *
 * LOCKED DECISION: `Style` and `Viewpoint` are INDEPENDENT axes and must never
 * be merged into one enum. A style is never a camera angle: "isometric" is a
 * Viewpoint, NOT a Style. An earlier design draft got this wrong; do not
 * reintroduce it.
 *
 * The runtime array is the single source for both the TypeScript union and the
 * zod enum in the tool schema, so the two cannot drift.
 */
export const SPRITE_STYLES = [
  "8bit",
  "16bit",
  "32bit",
  "chibi",
  "hand_painted",
  "flat_vector",
  "realistic",
] as const;

export type Style = (typeof SPRITE_STYLES)[number];

/**
 * Camera angle — HOW the sprite is framed. Independent of Style (see above).
 *
 * `generate_arcade_topdown_set` will force "topdown"; `generate_animation_set`
 * passes the caller's value straight through.
 */
export const SPRITE_VIEWPOINTS = ["side", "topdown", "isometric"] as const;

export type Viewpoint = (typeof SPRITE_VIEWPOINTS)[number];

/**
 * One animation state, e.g. "walk", "slither", "flap", "coil", "cast_spell".
 *
 * LOCKED DECISION: free-form on purpose. NEVER narrow this to a fixed humanoid
 * vocabulary (walk/attack/jump) — a snake needs slither/eat, a bird needs
 * flap/glide. Consumed by generate_animation_set; declared here so the contract
 * is fixed before that tool is written.
 */
export type MotionState = string;

/**
 * A ComfyUI prompt id. `generate_sprite` returns one immediately (fire and
 * forget); `get_sprite_result` takes one and resolves it against the inherited
 * `get_job_status` / AssetRegistry. The MCP-facing field name is `prompt_id`,
 * matching every other generation tool in this server.
 */
export type SpriteJobId = string;

/** txt2img when there is no reference image, img2img when there is one. */
export type SpriteGenerationMode = "txt2img" | "img2img";

/**
 * Canvas bounds shared by every generation tool. SD/SDXL latents are 1/8 scale,
 * so both dimensions must be a multiple of `SPRITE_DIM_STEP`.
 *
 * These are the ONE home for the bound. Every generation tool imports them (and
 * the checks that enforce them, from `src/sprite/arg-validation.ts`) — never
 * re-declare a private copy in a tool file.
 */
export const SPRITE_DIM_MIN = 64;
export const SPRITE_DIM_MAX = 4096;
export const SPRITE_DIM_STEP = 8;

/**
 * Exclusive upper bound for randomized seeds. Matches the range the inherited
 * workflow-composer templates use and stays well inside
 * `Number.MAX_SAFE_INTEGER` so seeds survive JSON round-trips intact.
 */
export const SPRITE_SEED_MAX = 2 ** 48;

/**
 * Everything `src/sprite/comfyui/` needs to build and enqueue one sprite job.
 *
 * Produced by the tool layer, which owns argument validation, seed resolution
 * and reference-image staging. The comfyui module owns workflow construction,
 * style+viewpoint -> checkpoint mapping, and the enqueue itself.
 */
export interface SpriteJobRequest {
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly style: Style;
  readonly viewpoint: Viewpoint;
  /** Diffusion canvas width in px. Already validated: 64..4096, multiple of 8. */
  readonly width: number;
  /** Diffusion canvas height in px. Already validated: 64..4096, multiple of 8. */
  readonly height: number;
  /**
   * Fully resolved seed — NEVER undefined. The tool layer randomizes when the
   * caller omits one, so the value echoed back to the caller is always the value
   * actually sampled with. See the enqueue contract note about
   * `disable_random_seed`.
   */
  readonly seed: number;
  /** Caller override. When absent, the module maps style + viewpoint. */
  readonly checkpoint?: string;
  /**
   * Bare filename of an image already staged in ComfyUI's input directory,
   * ready to drop into a LoadImage widget. Present => img2img, absent =>
   * txt2img. The tool layer guarantees it is staged before enqueue.
   */
  readonly referenceImage?: string;
  /**
   * img2img denoise, 0 < denoise <= 1. Lower = closer to the reference.
   * Meaningless (and rejected by the tool layer) without `referenceImage`.
   */
  readonly denoise?: number;
  /**
   * Sampling overrides — same pattern as generate_image's steps/cfg/sampler/
   * scheduler. Each falls back to the style's profile default
   * (STYLE_PROFILES[style]) when omitted; present ONLY to unblock a checkpoint
   * whose family needs different sampling than the style profile assumes (the
   * canonical case: a Flux-schnell checkpoint needs cfg 1.0 / 4-8 steps, not
   * the profile's SDXL-tuned cfg 7 / 30 steps).
   */
  readonly stepsOverride?: number;
  readonly cfgOverride?: number;
  /** ComfyUI KSampler `sampler_name` (e.g. "euler", "dpmpp_2m"). */
  readonly samplerOverride?: string;
  readonly schedulerOverride?: string;
  /**
   * Explicit opt-in (default false — NEVER silent): when the built workflow
   * fails validation because a model it references isn't installed, resolve
   * and download the best CivitAI/HuggingFace candidate before enqueueing,
   * instead of enqueueing a graph ComfyUI will only fail on later. See
   * `enqueueSpriteJob` (sprite-job.ts) for the full resolve/download/re-validate
   * sequence. Never wired for LoRA (pixelforge-mcp-7dc.1) — checkpoints only.
   */
  readonly autoDownloadMissing?: boolean;
}

/** One model auto-downloaded during an `enqueueSpriteJob` call. */
export interface DownloadedModelInfo {
  /** The filename the workflow originally asked for (not installed). */
  readonly requested: string;
  /** The filename actually installed and wired into the workflow (best-ranked
   *  candidate — usually equal to `requested` on an exact match, but not always). */
  readonly installed: string;
  readonly source: "civitai" | "huggingface";
  /** The node class_type that needed it, e.g. "CheckpointLoaderSimple". */
  readonly nodeType: string;
}

/** What the tool layer echoes back to the caller after a successful enqueue. */
export interface SpriteJobResult {
  readonly promptId: SpriteJobId;
  readonly queueRemaining?: number;
  /** The checkpoint actually used — the override, or the mapped one. */
  readonly checkpoint: string;
  /** Must equal `SpriteJobRequest.seed`; echoed for reproducibility. */
  readonly seed: number;
  readonly mode: SpriteGenerationMode;
  /** Present only when `autoDownloadMissing` actually triggered a download. */
  readonly downloadedModels?: readonly DownloadedModelInfo[];
  /** See `ResolvedCheckpoint.familyMismatchWarning` (checkpoint-resolver.ts). */
  readonly checkpointFamilyWarning?: string;
}

/**
 * One resolved image asset produced by a finished sprite job, ready to hand
 * straight to `view_image`, `pixelate_image`, or `generate_animation_set`'s
 * reference-image parameter.
 */
export interface SpriteResultAsset {
  readonly assetId: string;
  readonly filename: string;
  readonly subfolder: string;
}

/**
 * What `get_sprite_result` returns: the inherited job-status fields (see
 * `JobStatus` in `src/services/queue-manager.ts`) plus, once `done` with no
 * `error`, the sprite asset(s) resolved from `AssetRegistry.list()` filtered by
 * `promptId`. A sprite job registers exactly one image (one SaveImage node) in
 * practice, so `assets` is normally 0 or 1 entries — 0 when the job errored or
 * nothing was registered yet, never more than one expected but not treated as
 * a crash if it is. `assets` is `undefined` while the job is still
 * running/pending, so callers can tell "not done" from "done, nothing found".
 */
export interface SpriteResultStatus {
  readonly promptId: SpriteJobId;
  readonly running: boolean;
  readonly pending: boolean;
  readonly done: boolean;
  readonly statusStr?: string;
  readonly error?: ExecutionErrorDetails;
  readonly executionStats?: ExecutionStats;
  readonly assets?: readonly SpriteResultAsset[];
}

// ===========================================================================
// Animation set contracts (generate_animation_set)
//
// Unlike generate_sprite, this tool is BLOCKING: it enqueues one sprite job per
// frame, waits for each to finish, and chains frame N's output into frame N+1's
// reference image. That is the whole "img2img_low_denoise" consistency story —
// same seed, low denoise, drifting prompt/reference.
//
// Because it blocks across many jobs, PARTIAL FAILURE is a first-class outcome:
// a frame that fails is RECORDED, never thrown. See `AnimationFrameResult`.
// ===========================================================================

/**
 * How frames of one motion state are kept visually consistent with each other.
 *
 * This is the full SCHEMA-LEVEL union — both values are advertised in the MCP
 * tool schema — but only `IMPLEMENTED_CONSISTENCY_MODES` may be executed.
 *
 * LOCKED DECISION (CLAUDE.md): `"controlnet_pose"` is schema-ready and
 * deliberately NOT implemented. It requires per-frame pose skeletons and, for
 * real character identity, a trained character LoRA — a VRAM and asset-prep
 * cost that was evaluated and deferred during design. Passing it MUST raise a
 * ValidationError explaining exactly that (see
 * `assertImplementedConsistencyMode` / `CONTROLNET_POSE_REJECTION_MESSAGE`).
 * It must NEVER be silently downgraded to `"img2img_low_denoise"`, and it must
 * never be implemented without explicit user confirmation.
 */
export const ANIMATION_CONSISTENCY_MODES = ["img2img_low_denoise", "controlnet_pose"] as const;

export type ConsistencyMode = (typeof ANIMATION_CONSISTENCY_MODES)[number];

/**
 * The subset of `ConsistencyMode` that actually runs. `AnimationSetRequest`
 * accepts only this narrower type, so the compiler — not just a runtime check —
 * stops `"controlnet_pose"` from reaching the generation layer.
 */
export const IMPLEMENTED_CONSISTENCY_MODES = ["img2img_low_denoise"] as const;

export type ImplementedConsistencyMode = (typeof IMPLEMENTED_CONSISTENCY_MODES)[number];

/** MVP default when the caller omits `consistency_mode`. */
export const DEFAULT_CONSISTENCY_MODE: ImplementedConsistencyMode = "img2img_low_denoise";

/** Canonical rejection text, exported so tools and tests share one wording. */
export const CONTROLNET_POSE_REJECTION_MESSAGE =
  'consistency_mode "controlnet_pose" is not implemented. It requires per-frame pose ' +
  "skeletons and, for real character identity across frames, a trained character LoRA; " +
  "that cost was evaluated and deliberately deferred at design time. It is present in the " +
  'schema only so the contract is stable. Use "img2img_low_denoise" instead — this request ' +
  "is rejected rather than silently downgraded, so you know the poses you asked for were " +
  "not produced.";

/**
 * The ONLY sanctioned way to turn a caller-supplied `ConsistencyMode` into the
 * `ImplementedConsistencyMode` that `AnimationSetRequest` demands.
 *
 * Lives in types.ts on purpose: the rejection is part of the tool contract, not
 * an implementation detail, and routing every caller through this function is
 * what makes accidentally accepting `"controlnet_pose"` impossible.
 */
export function assertImplementedConsistencyMode(mode: ConsistencyMode): ImplementedConsistencyMode {
  if (mode === "controlnet_pose") {
    throw new ValidationError(CONTROLNET_POSE_REJECTION_MESSAGE);
  }
  if (mode !== "img2img_low_denoise") {
    throw new ValidationError(
      `Unknown consistency_mode "${String(mode)}". Supported: ` +
        `${IMPLEMENTED_CONSISTENCY_MODES.join(", ")}.`,
    );
  }
  return mode;
}

/**
 * Frame-count bounds. Every frame is a full diffusion job run sequentially, so
 * these caps are wall-clock guards on a blocking tool, not arbitrary limits.
 *
 * 4 frames/state is the classic pixel-art cycle length and a safe default; 16
 * covers a smooth cycle. `ANIMATION_MAX_TOTAL_FRAMES` bounds the whole call
 * (states x frames), which is the number that actually costs time.
 */
export const ANIMATION_DEFAULT_FRAMES_PER_STATE = 4;
export const ANIMATION_MIN_FRAMES_PER_STATE = 1;
export const ANIMATION_MAX_FRAMES_PER_STATE = 16;
export const ANIMATION_MAX_MOTION_STATES = 12;
export const ANIMATION_MAX_TOTAL_FRAMES = 64;

/**
 * Default per-frame img2img denoise. Deliberately LOW: it is the single knob
 * that trades identity for motion. Below ~0.2 frames barely move; above ~0.5
 * the character's identity drifts frame to frame and the set stops looking like
 * one sprite. The hard bound stays 0 < denoise <= 1 (same as generate_sprite) —
 * the caller may go higher, but not by accident.
 */
export const ANIMATION_DEFAULT_DENOISE = 0.35;

/**
 * Everything the generation layer needs to run one animation set. Fully
 * resolved and validated by the tool layer: `framesPerState`, `seed`,
 * `denoise` and `consistencyMode` are never undefined here, and
 * `motionStates` is guaranteed non-empty.
 *
 * The MCP-facing argument names are snake_case (`motion_states`,
 * `frames_per_state`, `reference_asset_id` / `reference_path`); this is the
 * internal shape after validation, mirroring `SpriteJobRequest`.
 *
 * Per-frame execution builds a `SpriteJobRequest` from these fields — do not
 * invent a second per-frame request type.
 */
export interface AnimationSetRequest {
  /** Subject prompt, shared by every frame; the motion state is appended per frame. */
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly style: Style;
  readonly viewpoint: Viewpoint;
  /**
   * Non-empty, order-significant, free-form (LOCKED: never a fixed humanoid
   * vocabulary). Each state gets its own chain of `framesPerState` frames.
   */
  readonly motionStates: readonly MotionState[];
  /**
   * Frames per motion state. Validated:
   * `ANIMATION_MIN_FRAMES_PER_STATE..ANIMATION_MAX_FRAMES_PER_STATE`, and
   * `motionStates.length * framesPerState <= ANIMATION_MAX_TOTAL_FRAMES`.
   */
  readonly framesPerState: number;
  /** Canvas width in px. Already validated against the SPRITE_DIM_* bounds. */
  readonly width: number;
  /** Canvas height in px. Already validated against the SPRITE_DIM_* bounds. */
  readonly height: number;
  /**
   * Fully resolved base seed — NEVER undefined; the tool layer randomizes when
   * the caller omits one. MVP policy: every frame in the set samples with this
   * exact seed (that is the "same seed" half of the consistency story; drift
   * comes from the per-frame prompt and the chained reference image). Enqueue
   * MUST pass `disable_random_seed: true` or the policy is a lie.
   */
  readonly seed: number;
  /** Caller override. When absent, the generation layer maps style + viewpoint. */
  readonly checkpoint?: string;
  /** Only ever `"img2img_low_denoise"` in MVP — see the type's doc comment. */
  readonly consistencyMode: ImplementedConsistencyMode;
  /** Per-frame img2img denoise, 0 < denoise <= 1. Defaults to `ANIMATION_DEFAULT_DENOISE`. */
  readonly denoise: number;
  /**
   * Optional base image for the FIRST frame of the FIRST motion state only —
   * every later frame is chained from the previous frame's output, so a
   * caller-supplied reference applies exactly once.
   *
   * Bare filename already staged in ComfyUI's input directory, identical in
   * meaning to `SpriteJobRequest.referenceImage`. Absent => that first frame
   * runs txt2img; present => it runs img2img at `denoise`.
   */
  readonly referenceImage?: string;
  /** Forwarded verbatim to every frame's `SpriteJobRequest` — see its doc comment. */
  readonly autoDownloadMissing?: boolean;
  /** Forwarded verbatim to every frame's `SpriteJobRequest` — see its doc comments. */
  readonly stepsOverride?: number;
  readonly cfgOverride?: number;
  readonly samplerOverride?: string;
  readonly schedulerOverride?: string;
}

/** Why one frame is in the frame list. Discriminant of `AnimationFrameResult`. */
export type AnimationFrameStatus = "succeeded" | "failed" | "skipped";

interface AnimationFrameBase {
  readonly motionState: MotionState;
  /** 0-based index WITHIN its motion state, not within the whole set. */
  readonly frameIndex: number;
}

/** A frame that generated an image. `asset` feeds pack_spritesheet directly. */
export interface AnimationFrameSuccess extends AnimationFrameBase {
  readonly status: "succeeded";
  readonly promptId: SpriteJobId;
  readonly asset: SpriteResultAsset;
  /** The seed actually sampled with — echoed so one frame can be reproduced alone. */
  readonly seed: number;
  readonly checkpoint: string;
  /** txt2img only for the very first frame with no base image; img2img otherwise. */
  readonly mode: SpriteGenerationMode;
}

/**
 * A frame that was attempted and did not produce an image. Recorded, NEVER
 * thrown — one bad frame must not discard the frames that already succeeded.
 */
export interface AnimationFrameFailure extends AnimationFrameBase {
  readonly status: "failed";
  /** Absent when the enqueue itself failed, so no job ever existed. */
  readonly promptId?: SpriteJobId;
  readonly seed: number;
  readonly checkpoint: string;
  readonly mode: SpriteGenerationMode;
  /** Human-readable cause: ComfyUI execution error, timeout, or missing asset. */
  readonly error: string;
  /** Structured ComfyUI error when the job itself reported one. */
  readonly errorDetails?: ExecutionErrorDetails;
}

/**
 * A frame that was never attempted because an earlier frame in the SAME motion
 * state failed and broke the img2img chain (frame N needs frame N-1's image).
 * Distinguishing this from "failed" is what lets a caller see that a state's
 * chain stopped early rather than that every frame independently blew up.
 */
export interface AnimationFrameSkipped extends AnimationFrameBase {
  readonly status: "skipped";
  /** e.g. 'frame 1 of "slither" failed; the img2img chain stopped there'. */
  readonly reason: string;
}

/**
 * One entry per planned frame. A discriminated union so "succeeded" cannot be
 * reported without an asset, and "skipped" cannot carry a fake seed.
 */
export type AnimationFrameResult =
  | AnimationFrameSuccess
  | AnimationFrameFailure
  | AnimationFrameSkipped;

/**
 * All frames for one motion state, in generation order.
 *
 * Invariants the generation layer must uphold:
 *   - `frames.length === AnimationSetRequest.framesPerState` — always, even
 *     when the chain broke on frame 0 (the rest come back as "skipped").
 *   - `succeededFrameCount + failedFrameCount + skippedFrameCount === frames.length`
 *   - `chainStoppedEarly === (skippedFrameCount > 0)`
 */
export interface AnimationStateResult {
  readonly motionState: MotionState;
  readonly frames: readonly AnimationFrameResult[];
  readonly succeededFrameCount: number;
  readonly failedFrameCount: number;
  readonly skippedFrameCount: number;
  /** true => this state's img2img chain broke and later frames never ran. */
  readonly chainStoppedEarly: boolean;
}

/**
 * Whole-set verdict, so a caller does not have to reduce the frame list to find
 * out whether it got what it asked for:
 *   - "complete" — every planned frame succeeded.
 *   - "partial"  — at least one frame succeeded and at least one did not.
 *   - "failed"   — no frame succeeded at all.
 */
export type AnimationSetOutcome = "complete" | "partial" | "failed";

/**
 * What generate_animation_set returns after blocking on every frame.
 *
 * `outcome` plus the per-state `chainStoppedEarly` flags are the partial-failure
 * contract: nothing is thrown once generation has started, so a caller can pack
 * the frames that did land and re-run only the states that broke.
 */
export interface AnimationSetResult {
  readonly outcome: AnimationSetOutcome;
  readonly style: Style;
  readonly viewpoint: Viewpoint;
  readonly consistencyMode: ImplementedConsistencyMode;
  /** The checkpoint actually used for every frame — the override, or the mapped one. */
  readonly checkpoint: string;
  /** Echo of `AnimationSetRequest.seed`, for reproducing the whole set. */
  readonly seed: number;
  readonly framesPerState: number;
  /** `motionStates.length * framesPerState` — what was planned. */
  readonly requestedFrameCount: number;
  readonly succeededFrameCount: number;
  readonly failedFrameCount: number;
  readonly skippedFrameCount: number;
  /** One entry per motion state, in the caller's order. Never empty. */
  readonly states: readonly AnimationStateResult[];
  /** Models auto-downloaded across every frame's `enqueueSpriteJob` call, deduped. */
  readonly downloadedModels?: readonly DownloadedModelInfo[];
  /** See `ResolvedCheckpoint.familyMismatchWarning`; resolved once for the whole set. */
  readonly checkpointFamilyWarning?: string;
}

// ===========================================================================
// Spritesheet packing contracts (pack_spritesheet)
//
// Deliberately independent of the generation tools: the packer takes ANY set of
// equally-sized frame images, whether they came from generate_animation_set,
// pixelate_image, or a file the user drew by hand.
//
// The metadata produced here is ENGINE-AGNOSTIC. Unity-specific translation
// (bottom-left rect origin, sprite naming, import-script JSON) belongs to
// export_for_engine — never leak it back into this layer.
// ===========================================================================

export const SPRITESHEET_LAYOUTS = ["grid", "horizontal", "vertical"] as const;

/**
 * Sheet layout:
 *   - "grid"       — `columns` per row, wrapping (default `ceil(sqrt(n))`).
 *   - "horizontal" — one row, every frame side by side.
 *   - "vertical"   — one column, every frame stacked.
 */
export type SpritesheetLayout = (typeof SPRITESHEET_LAYOUTS)[number];

export const DEFAULT_SPRITESHEET_LAYOUT: SpritesheetLayout = "grid";

/** Playback rate defaults to a classic pixel-art cycle rate, not 30/60. */
export const DEFAULT_SPRITESHEET_FPS = 12;
export const SPRITESHEET_MIN_FPS = 1;
export const SPRITESHEET_MAX_FPS = 120;

/** Wall-clock/memory guards. The sheet cap matches Unity's max texture size. */
export const SPRITESHEET_MAX_FRAMES = 256;
export const SPRITESHEET_MAX_SHEET_DIMENSION = 16384;

/**
 * Normalized anchor inside ONE frame: 0..1 on each axis, `{x: 0.5, y: 0.5}` is
 * the frame's center and `y = 0` is its BOTTOM edge.
 *
 * Normalized (not a pixel offset) on purpose: it survives a later resize of the
 * frames, and it is what every engine's sprite pivot field expects.
 */
export interface SpritePivot {
  readonly x: number;
  readonly y: number;
}

export const DEFAULT_SPRITE_PIVOT: SpritePivot = { x: 0.5, y: 0.5 };

/** Fully resolved packing request — no undefined fields reach the packer. */
export interface SpritesheetPackOptions {
  readonly layout: SpritesheetLayout;
  /** Grid layout only; ignored for horizontal/vertical. Positive integer. */
  readonly columns?: number;
  readonly fps: number;
  readonly pivot: SpritePivot;
}

/**
 * One frame's rectangle inside the packed sheet.
 *
 * COORDINATE SYSTEM: image space — origin at the sheet's TOP-LEFT corner, `y`
 * increasing DOWNWARD. This is what sharp/PNG use and it is the stable contract
 * here. Engines that address sprites from the bottom-left (Unity) convert with
 * `engine_y = sheet_height - y - height` in their own export module.
 *
 * `index` is the frame's 0-based position in the caller's frame list, which is
 * also its playback order — never re-sorted by the packer.
 */
export interface SpritesheetFrameRect {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The pack_spritesheet metadata document — a PUBLIC CONTRACT. Users consume
 * this JSON from their own Unity-side import tooling, and export_for_engine
 * consumes it too, so it is versioned and its field names are snake_case
 * BECAUSE THE TYPE IS THE WIRE SHAPE (no camelCase-to-JSON mapper sits in
 * between that could silently drift from it).
 *
 * Compatible changes: adding an optional field, bumping nothing. Renaming or
 * removing a field, or changing the rect coordinate system, is BREAKING and
 * must bump `version`.
 *
 * All frames share one size (`frame_width`/`frame_height`) — the packer rejects
 * mismatched frames rather than cropping or padding them.
 */
export interface SpritesheetMetadata {
  /** Schema version of this document. Bumped only on a breaking change. */
  readonly version: 1;
  readonly frame_width: number;
  readonly frame_height: number;
  readonly sheet_width: number;
  readonly sheet_height: number;
  readonly layout: SpritesheetLayout;
  readonly columns: number;
  readonly rows: number;
  readonly frame_count: number;
  /** Suggested playback rate for the frame sequence, in frames per second. */
  readonly fps: number;
  /** Normalized per-frame anchor; see `SpritePivot`. */
  readonly pivot: SpritePivot;
  /** In playback order, `index` ascending from 0. Never empty. */
  readonly frames: readonly SpritesheetFrameRect[];
}

/** What the packer returns: the encoded sheet plus its metadata document. */
export interface PackedSpritesheet {
  readonly png: Buffer;
  readonly metadata: SpritesheetMetadata;
}

// ===========================================================================
// Engine export contracts (export_for_engine)
//
// LOCKED DECISION (CLAUDE.md): MVP is Unity-only, PNG + JSON slicing metadata
// for MANUAL import — no .meta file generation. Godot/GameMaker are present in
// the schema for contract stability but MUST throw "not implemented", never
// silently no-op. Same schema-ready-but-rejected shape as
// `ConsistencyMode`/`IMPLEMENTED_CONSISTENCY_MODES` above: the full union is
// advertised, only `IMPLEMENTED_EXPORT_ENGINES` may actually run, and
// `assertImplementedExportEngine` is the one sanctioned narrowing path.
// ===========================================================================

export const EXPORT_ENGINES = ["unity", "godot", "gamemaker"] as const;

export type ExportEngine = (typeof EXPORT_ENGINES)[number];

/** The subset of `ExportEngine` actually implemented in MVP. */
export const IMPLEMENTED_EXPORT_ENGINES = ["unity"] as const;

export type ImplementedExportEngine = (typeof IMPLEMENTED_EXPORT_ENGINES)[number];

/**
 * The ONLY sanctioned way to turn a caller-supplied `ExportEngine` into the
 * `ImplementedExportEngine` the export layer demands. Godot/GameMaker are
 * REJECTED here, never downgraded to a Unity export and never a silent no-op.
 */
export function assertImplementedExportEngine(engine: ExportEngine): ImplementedExportEngine {
  if (engine === "unity") return engine;
  throw new ValidationError(
    `Engine "${engine}" is not implemented. export_for_engine supports "unity" only in MVP; ` +
      "Godot and GameMaker are present in the schema for contract stability but are rejected " +
      "here rather than silently skipped.",
  );
}

/** Unity's own default Pixels Per Unit; used when the caller omits one. */
export const DEFAULT_PIXELS_PER_UNIT = 100;

/**
 * One frame's rectangle in Unity's texture coordinate convention: origin at
 * the sheet's BOTTOM-LEFT corner, `y` increasing UPWARD. This is the one
 * place `SpritesheetFrameRect`'s top-left/y-down rect gets converted, via
 * `engine_y = sheet_height - y - height` (see the locked note on
 * `SpritesheetFrameRect` above) — never leaked back into the engine-agnostic
 * packing layer.
 */
export interface UnitySpriteRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One sprite Unity's manual importer should slice out of the sheet. */
export interface UnitySpriteEntry {
  readonly name: string;
  /** Matches the source `SpritesheetFrameRect.index` — the original playback order. */
  readonly frame_index: number;
  readonly rect: UnitySpriteRect;
  /** Same normalized pivot as the source metadata — already bottom-origin, no conversion needed. */
  readonly pivot: SpritePivot;
}

/**
 * The export_for_engine Unity output document — a PUBLIC CONTRACT, same
 * versioning rule as `SpritesheetMetadata`: adding an optional field is
 * compatible, renaming/removing one or changing the rect coordinate system is
 * breaking and must bump `version`.
 */
export interface UnityExportMetadata {
  readonly version: 1;
  readonly engine: "unity";
  readonly sheet_width: number;
  readonly sheet_height: number;
  readonly pixels_per_unit: number;
  readonly fps: number;
  /** In the source metadata's frame order, `frame_index` ascending from 0. Never empty. */
  readonly sprites: readonly UnitySpriteEntry[];
}
