// ---------------------------------------------------------------------------
// Single source of truth for the prompt-spec grammar's fillable template,
// consumed by get_workflow_prompt_template. Kept here (not in the tool file)
// so it lives next to prompt-spec-parser.ts and can't drift from the actual
// grammar — see prompt-spec-parser.test.ts, which round-trips this template
// through parsePromptSpec as a regression guard.
// ---------------------------------------------------------------------------

export const PROMPT_SPEC_TEMPLATE = `\
[CHECKPOINT / MODEL]
Checkpoint: <checkpoint_filename.safetensors> (o <alternate_checkpoint.safetensors>)
VAE: <optional_separate_vae.safetensors>

[LORA]
LoRA Name: <lora_filename.safetensors>
LoRA Model Weight: <0.0-1.0, default 1.0>
LoRA CLIP Weight: <0.0-1.0, default = LoRA Model Weight>
Trigger Words: <comma, separated, words>

[SAMPLER & SCHEDULER SETTINGS]
Sampler: <e.g. dpmpp_2m_sde>
Scheduler: <e.g. karras>
Steps: <integer>
CFG Scale: <number>
Resolution: <width>x<height>

[POSITIVE PROMPT]
<free-form prompt text>

[NEGATIVE PROMPT]
<free-form prompt text>

[POST-PROCESSING / PIXEL PERFECT GRID]
Downscale Node: ImageScale (Width: <int>, Height: <int>, Upscale Method: <e.g. nearest-exact>)
Upscale Node: ImageScale (Width: <int>, Height: <int>, Upscale Method: <e.g. nearest-exact>)
`;

export const PROMPT_SPEC_USAGE_NOTE =
  "Replace every <placeholder> with a real value, then pass the whole filled text as spec_text to " +
  "workflow_from_prompt_spec (or write it to a file and pass its path as spec_path). Optional " +
  "sections/lines — VAE:, the entire [LORA] block, [NEGATIVE PROMPT], and " +
  "[POST-PROCESSING / PIXEL PERFECT GRID] — can be deleted entirely when not needed. The " +
  "'(o <alternate>)' parenthetical suffixes on Checkpoint/Sampler are themselves optional fallback " +
  "syntax. To specify more than one LoRA, duplicate the whole [LORA] block (header + its 4 keys) " +
  "once per LoRA, back to back — do not number the headers.";
