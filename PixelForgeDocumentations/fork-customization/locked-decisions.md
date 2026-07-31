# Locked architectural decisions (do not silently reverse)

> Part of [fork-customization](INDEX.md). If a task is about to violate one of these, stop and ask
> for confirmation instead of proceeding.

- **`style` and `viewpoint` are independent axes.** Style = rendering aesthetic (16bit, chibi,
  hand-painted...). Viewpoint = camera angle (side, topdown, isometric). Never conflate them.
  Enforced structurally in `src/sprite/comfyui/style-profiles.ts`: checkpoint mapping is keyed by
  style alone, and `ViewpointProfile` has no checkpoint/sampler field at all — a
  (style × viewpoint) → checkpoint table would silently reintroduce the conflation this decision
  forbids, even if no one intended it.
- **The inherited `img2img` template (`services/workflow-composer.ts`) derives its latent size from
  the reference image**, so a caller's requested width/height would otherwise be silently ignored
  in img2img mode. Fixed at the sprite layer, not upstream: `buildSpriteWorkflow` in
  `src/sprite/comfyui/sprite-workflow.ts` inserts an `ImageScale` node between `LoadImage` and
  `VAEEncode` after calling `createWorkflow("img2img", ...)`. Do not "fix" this by editing the
  upstream template — that would touch inherited code for a PixelForge-only need and fight future
  `git merge upstream/main` for no benefit.
- **`consistency_mode` for animation**: MVP default is `"img2img_low_denoise"` (implemented,
  known limitation: pose changes are approximate without ControlNet). `"controlnet_pose"` is
  schema-ready but **NOT implemented** — it requires per-frame pose skeletons and, for real
  character consistency, a trained character LoRA (non-trivial VRAM/asset-prep cost). Implementing
  it requires explicit user confirmation, evaluated and deliberately deferred during design.
- **Palettes are hardcoded, no network fetch.** MVP set: PICO-8, Endesga-32, Sweetie-16,
  Resurrect-64, plus `auto_kmeans` (via `image-q`) and `custom` (caller-provided hex list). No
  lospec.com API integration — local-first, deterministic constraint.
- **Background removal is always delegated to ComfyUI**, never reimplemented server-side.
- **No Aseprite / no second MCP server dependency.** Evaluated during design (willibrandon/pixel-mcp,
  MIT, mature, Aseprite-based) and explicitly rejected in favor of a single self-contained
  TypeScript pipeline using `image-q`/`sharp`. Do not reintroduce this dependency without a new
  design decision.
- **Unity export is PNG + JSON only in MVP** — no `.meta` generation, manual import expected.

See also: [`rejected-alternatives.md`](rejected-alternatives.md) for the third-party tools evaluated
and rejected during design (context for "why don't we just use X"), and
[`repo-layout.md`](repo-layout.md) for where each of these constraints lives in code.
