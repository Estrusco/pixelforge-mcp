# Tool surface (MVP — locked, do not add/remove without recorded decision)

> Part of [fork-customization](INDEX.md). Status as of 2026-08-03 — check `bd list` for current
> truth, this is a snapshot, not the tracker.

1. `generate_sprite` **(implemented)** — single sprite from prompt (+ optional reference image), style + viewpoint, seed.
   Optional `steps`/`cfg`/`sampler`/`scheduler` override the style profile's tuned defaults (e.g. Flux-schnell's
   `cfg: 1.0`/4-8 steps). Optional `auto_download_missing` (explicit opt-in, never silent — pixelforge-mcp-7dc.2)
   downloads the best-ranked CivitAI/HuggingFace candidate for a missing checkpoint before enqueue instead of
   letting ComfyUI reject the job later; the built workflow is also validated before submit either way
   (pixelforge-mcp-7dc.3). Surfaces a `checkpoint_warning` when the resolved checkpoint's base-model family doesn't
   match the requested style and nothing better is installed.
2. `get_sprite_result` **(implemented)** — thin wrapper over inherited `get_job_status`.
3. `generate_animation_set` **(implemented)** — coherent set of frames for `motion_states` (free-form strings, NOT a
   fixed humanoid walk/attack/jump vocabulary — a snake needs slither/eat, a bird needs flap/glide). Accepts the
   same sampling overrides and `auto_download_missing` as `generate_sprite`, applied per frame.
4. `generate_arcade_topdown_set` **(implemented — pixelforge-mcp-z9v)** — preset wrapper over (1)/(3) for topdown arcade assets (e.g. Math
   Serpent). Forces `viewpoint: "topdown"`. `symmetric_rotation_safe: true` (default) generates ONE
   canonical frame and expects the engine to rotate it at runtime (safe for 90°-aligned movement;
   do not use for non-90° rotation needs — causes pixel-grid aliasing). `symmetric_rotation_safe: false`
   wraps `generate_animation_set` instead (forced topdown), requiring `motion_states` for distinct
   per-facing/per-state art.
5. `pixelate_image` **(implemented)** — nearest-neighbor grid-snap → palette quantization → nearest-color mapping →
   isolated-pixel cleanup → optional nearest-neighbor upscale (`output_size`/`output_scale`, at most one, applied
   after quantization so the logical grid stays exact), alpha-preserving throughout. `save_dir` writes the PNG to
   any local directory without requiring `COMFYUI_PATH` (separate from `out_path`, which stays under the ComfyUI
   output dir). The result is re-uploaded and registered as an `asset_id` (best-effort — a PNG is still returned
   inline if ComfyUI is unreachable), so it chains directly into `remove_background`/`pack_spritesheet`/
   `export_for_engine` without the caller managing files; `regenerate` is not supported on assets registered this
   way since there is no real ComfyUI workflow behind them.
6. `remove_background` **(implemented — reuses/extends the inherited upstream tool, see `repo-layout.md`)** — two
   modes: `birefnet` (default) routes to a ComfyUI custom node (rembg/BiRefNet/U2Net); `luma_key` builds a
   LoadImage→R/G/B-channel-mask→threshold→invert→JoinImageWithAlpha graph from ComfyUI's core mask nodes only (no
   custom-node dependency) for dark-background/glow art (e.g. neon-on-black pixel art) where BiRefNet's hard matte
   destroys the glow or opacifies hollow interiors. NEVER reimplement background removal in TypeScript.
7. `pack_spritesheet` **(implemented)** — frames → packed sheet + JSON metadata (frame rects, fps, pivot).
8. `export_for_engine` **(implemented — pixelforge-mcp-7mn, `.meta` added — pixelforge-mcp-8b3.6)** —
   MVP: Unity only, outputs **PNG + JSON slicing metadata**, plus an opt-in-by-default minimal
   Unity `.meta` (see `locked-decisions.md`). A single sprite is just `pack_spritesheet` called with
   one frame — no special-casing needed. Godot/GameMaker are advertised in the schema but rejected
   by `assertImplementedExportEngine` (`src/sprite/types.ts`) before any image is loaded or file
   written — never a silent no-op. Takes the exact `metadata` object `pack_spritesheet` returns as
   input (validated as a boundary in `src/sprite/export/validate-metadata.ts`) and flips each frame
   rect from `pack_spritesheet`'s top-left/y-down convention to Unity's bottom-left/y-up convention
   in the pure `src/sprite/export/unity.ts` translator; the normalized pivot passes through
   unchanged (already bottom-origin). `.meta` generation (detection heuristic, GUID handling, the
   never-overwrite mitigation) lives in `src/sprite/export/unity-meta.ts`.

## Beyond the MVP list

9. `workflow_from_prompt_spec` **(implemented — pixelforge-mcp-n0f)** — NOT part of the locked
   8-tool MVP surface above; a separate, explicitly-confirmed-with-the-user addition, listed here
   rather than renumbered into it so the "locked" set above stays exactly what it always was.
   Parses a structured plain-text "prompt spec" file (bracketed `[CHECKPOINT / MODEL]`, `[LORA]`,
   `[SAMPLER & SCHEDULER SETTINGS]`, `[POSITIVE PROMPT]`, `[NEGATIVE PROMPT]`, optional
   `[POST-PROCESSING / PIXEL PERFECT GRID]` sections — see `src/sprite/spec/prompt-spec-parser.ts`)
   into a full ComfyUI workflow: `CheckpointLoaderSimple` → optional `VAELoader` (new — the rest of
   PixelForge always uses the checkpoint's bundled VAE) → optional `LoraLoader` (reuses the same
   connection-rewiring helper `generate_sprite` uses, extracted to `src/sprite/comfyui/graph-edit.ts`)
   → `CLIPTextEncode` (positive/negative) → `KSampler` → `VAEDecode` → optional pixel-grid
   downscale/upscale `ImageScale` pair baked directly into the graph (new — everywhere else in
   PixelForge this step is client-side via `pixelate_image`, but the spec format names real
   `ImageScale` nodes) → `SaveImage`. Same `auto_download_missing` opt-in-never-silent convention as
   `generate_sprite` (checkpoint/VAE: best-ranked candidate; LoRA: exact match or an explicit
   `lora_source`, never a "similar" substitute — reuses the resolve/download loop extracted to
   `src/sprite/comfyui/model-download.ts`). Unlike every generation tool above, it never enqueues or
   runs the workflow — it only builds, resolves, validates, and **saves** it into the connected
   ComfyUI server's own workflow library (`src/services/workflow-converter.ts`'s
   `saveWorkflowToLibrary`, extracted from the generic `save_workflow` tool) so it opens in the
   ComfyUI web UI exactly as if a person had built it there by hand; running it afterward is the
   generic `enqueue_workflow` tool's job, not this one's.

See also: [`../agents/`](../agents/) for a consumer-facing, self-contained tool reference (params,
constraints, end-to-end recipes) meant to be copied into other projects — this page is the
maintainer-facing "what's locked and why" contract instead.
