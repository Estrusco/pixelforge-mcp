# Tool surface (MVP — locked, do not add/remove without recorded decision)

> Part of [fork-customization](INDEX.md). Status as of 2026-07-30 — check `bd list` for current
> truth, this is a snapshot, not the tracker.

1. `generate_sprite` **(implemented)** — single sprite from prompt (+ optional reference image), style + viewpoint, seed.
2. `get_sprite_result` **(implemented)** — thin wrapper over inherited `get_job_status`.
3. `generate_animation_set` **(implemented)** — coherent set of frames for `motion_states` (free-form strings, NOT a
   fixed humanoid walk/attack/jump vocabulary — a snake needs slither/eat, a bird needs flap/glide).
4. `generate_arcade_topdown_set` **(implemented — pixelforge-mcp-z9v)** — preset wrapper over (1)/(3) for topdown arcade assets (e.g. Math
   Serpent). Forces `viewpoint: "topdown"`. `symmetric_rotation_safe: true` (default) generates ONE
   canonical frame and expects the engine to rotate it at runtime (safe for 90°-aligned movement;
   do not use for non-90° rotation needs — causes pixel-grid aliasing). `symmetric_rotation_safe: false`
   wraps `generate_animation_set` instead (forced topdown), requiring `motion_states` for distinct
   per-facing/per-state art.
5. `pixelate_image` **(implemented)** — nearest-neighbor grid-snap → palette quantization → nearest-color mapping →
   isolated-pixel cleanup, alpha-preserving throughout.
6. `remove_background` **(implemented — reuses/extends the inherited upstream tool, see `repo-layout.md`)** — routes to a ComfyUI custom node (rembg/BiRefNet/U2Net). NEVER reimplement
   background removal in TypeScript.
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

See also: [`../agents/`](../agents/) for a consumer-facing, self-contained tool reference (params,
constraints, end-to-end recipes) meant to be copied into other projects — this page is the
maintainer-facing "what's locked and why" contract instead.
