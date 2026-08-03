// ---------------------------------------------------------------------------
// The structured representation of a plain-text "prompt spec" file — the
// bracketed-section format a human would hand-author for a single ComfyUI
// generation (checkpoint, VAE, LoRA, sampler settings, prompts, pixel-grid
// post-processing). See prompt-spec-parser.ts for the parser that produces
// this from raw text.
// ---------------------------------------------------------------------------

/** One `ImageScale` step: resize to `width`x`height` using `method`. */
export interface SpecImageScaleStep {
  readonly width: number;
  readonly height: number;
  readonly method: string;
}

/** One `[LORA]` block — the section is repeatable for more than one LoRA. */
export interface SpecLora {
  readonly name: string;
  /** `LoraLoader.strength_model`. Defaults to 1.0 when the section omits it. */
  readonly strengthModel: number;
  /** `LoraLoader.strength_clip`. Defaults to `strengthModel` when omitted. */
  readonly strengthClip: number;
  /** Informational only — never auto-injected into the prompt text. */
  readonly triggerWords: readonly string[];
}

/** The `[POST-PROCESSING / PIXEL PERFECT GRID]` section, when present. */
export interface SpecPostProcess {
  readonly downscale: SpecImageScaleStep;
  readonly upscale: SpecImageScaleStep;
}

/** Fully parsed prompt-spec file, ready to resolve models and build a workflow. */
export interface PromptSpec {
  /** Ordered checkpoint filenames — the first is preferred; later ones are the
   *  "(o alternativa.safetensors)" fallbacks named in the file. Always >= 1. */
  readonly checkpointCandidates: readonly string[];
  /** Separate VAE filename from the `VAE:` line, when the checkpoint's bundled
   *  VAE should not be used. */
  readonly vae?: string;
  /** Zero or more `[LORA]` blocks, in document order. Empty when the spec has
   *  none — the section header is repeatable for more than one LoRA. */
  readonly loras: readonly SpecLora[];
  readonly sampler: string;
  readonly scheduler: string;
  readonly steps: number;
  readonly cfg: number;
  readonly width: number;
  readonly height: number;
  readonly positivePrompt: string;
  readonly negativePrompt: string;
  readonly postProcess?: SpecPostProcess;
}
