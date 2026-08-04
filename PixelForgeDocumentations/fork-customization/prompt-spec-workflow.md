# Prompt-spec ingestion flow

> Part of [fork-customization](INDEX.md). Covers the intended agent-side usage pattern for
> `get_workflow_prompt_template` + `workflow_from_prompt_spec` (see `tool-surface.md` item 9).

## The mandatory sequence

When a user (or another AI) hands over a raw/free-form description of a generation setup —
checkpoint, LoRA(s), sampler settings, prompt — that is **not already** written in the exact
prompt-spec grammar, always do all three steps, in order:

1. Call `get_workflow_prompt_template`. Never guess the grammar from memory or from a previous
   session — the returned `template`/`usage_note` is the single source of truth.
2. Rewrite the user's raw content onto that exact template: exact section headers
   (`[CHECKPOINT / MODEL]`, `[LORA]`, `[SAMPLER & SCHEDULER SETTINGS]`, `[POSITIVE PROMPT]`,
   `[NEGATIVE PROMPT]`, `[POST-PROCESSING / PIXEL PERFECT GRID]`), exact key names (`Checkpoint:`,
   `LoRA Name:`, `LoRA Model Weight:`, `LoRA CLIP Weight:`, `Trigger Words:`, `Sampler:`,
   `Scheduler:`, `Steps:`, `CFG Scale:`, `Resolution:`, `Downscale Node:`, `Upscale Node:`), every
   `<placeholder>` replaced with a real value. Duplicate the whole `[LORA]` block per LoRA instead
   of numbering headers. Delete optional sections/lines that don't apply (`VAE:`, the `[LORA]`
   block, `[NEGATIVE PROMPT]`, the post-processing section) rather than leaving them half-filled.
3. Call `workflow_from_prompt_spec` with the filled text as `spec_text` (or write it to a file and
   pass `spec_path`).

**Never pass a user's raw/unedited file straight through as `spec_path` or `spec_text`.** It will
almost always fail validation, and even where it happens to parse, values won't have been checked
against what's actually installed (see below).

## Why the parser won't do this for you

`src/sprite/spec/prompt-spec-parser.ts` matches section headers and keys by **exact string**
(after lowercasing/whitespace-collapsing) — not fuzzy or synonym matching. The only aliases it
knows about are hardcoded: the checkpoint/sampler/post-processing section headers accept one
alternate phrasing each, and `CFG Scale:`/`CFG:` are interchangeable. Everything else — `Primary
Model:` vs `Checkpoint:`, `Weight:` vs `LoRA Model Weight:`, free-form section names like `[STYLE
KEYWORDS]` — is either a hard validation error or silently ignored, never remapped.

This is deliberate, not a gap to patch in the parser. Per the commit that introduced
`get_workflow_prompt_template` (`18cf749`), the template is co-located with the parser and kept in
sync only by a round-trip regression test specifically so the mapping step happens once, in the
agent, with full context of user intent — not heuristically inside a strict, testable parser. Do
not "fix" this by adding fuzzy key matching to the parser; that would silently guess at a human
author's intent instead of surfacing a clear, fixable error.

## Asset-gap judgment call

Filling in the template correctly is a mechanical rewrite, but the *values* the user names —
checkpoint filename, LoRA filename(s) — may not exist locally. Check with `list_local_models`
before finalizing the filled spec. If a named checkpoint/LoRA isn't installed:

- Do **not** silently substitute a "close enough" local file — a different checkpoint family
  (e.g. SDXL instead of FLUX) or an unrelated LoRA can produce meaningfully different output than
  what the user asked for.
- Do **not** silently pass `auto_download_missing: true` — that tool option is explicit-opt-in for
  a reason (same convention as `generate_sprite`'s `auto_download_missing`, see `tool-surface.md`).
- **Stop and ask the user** how to resolve the gap: substitute a specific local equivalent, supply
  exact download sources (CivitAI version id / HuggingFace repo+filename) for
  `auto_download_missing` + `lora_sources`, or drop the missing LoRA/use an alternate checkpoint
  from the spec's own `(o <alternate>)` fallback if one was given. This is a decision about user
  intent, not something to resolve unilaterally.

## Worked example

Raw user input (free-form, wrong keys, descriptive rather than filenames):

```
Model: something FLUX based, high quality
LoRA: pixel art style, medium strength
Steps 30, cfg 2, square 1024
Prompt: a glowing sci-fi rune, top-down icon
```

After step 1 (`get_workflow_prompt_template`) and step 2 (rewrite onto the grammar, using a real
installed checkpoint/LoRA confirmed via `list_local_models`):

```
[CHECKPOINT / MODEL]
Checkpoint: flux1-schnell-fp8.safetensors
VAE: ae.safetensors

[LORA]
LoRA Name: pixel-art-xl.safetensors
LoRA Model Weight: 0.5
LoRA CLIP Weight: 0.5

[SAMPLER & SCHEDULER SETTINGS]
Sampler: euler
Scheduler: simple
Steps: 30
CFG Scale: 2.0
Resolution: 1024x1024

[POSITIVE PROMPT]
a glowing sci-fi rune, top-down icon, pixel art
```

Then step 3: call `workflow_from_prompt_spec` with this text as `spec_text`.
