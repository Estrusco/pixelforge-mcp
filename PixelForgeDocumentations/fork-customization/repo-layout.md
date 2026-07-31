# Repo layout

> Part of [fork-customization](INDEX.md).

```
src/                — inherited from artokun/comfyui-mcp. Touch only when necessary.
                       Provides: stdio/streamable-HTTP transport, enqueue_workflow, get_job_status,
                       WebSocket progress, VRAM watchdog, process management.
  tools/remove-background.ts — the one upstream file PixelForge intentionally touches, because it
                       already WAS locked tool #6 in all but name: widened to also accept
                       asset_id/path (via src/sprite/reference-image.ts) alongside the original
                       `image` filename param. Same tool name, same ComfyUI-RMBG workflow, no new
                       registration — do not fork this into a second sprite-namespaced tool.
src/sprite/          — PixelForge-specific code. Isolated from upstream to keep future
                       `git pull` from upstream low-conflict.
  types.ts           — shared interfaces: tool I/O contracts (Style, Viewpoint, MotionState,
                       SpriteJobRequest/Result, AnimationSet*, packing types, ...) — source of truth.
  reference-image.ts — resolveReferenceImage(assetId, path): stages a registered asset or a
                       filesystem path as a bare filename in ComfyUI's input dir. Shared by
                       generate_sprite, generate_animation_set, and the upstream remove_background
                       enhancement above — the one legitimate place this logic lives.
  image-io.ts        — asset_id/path → local RawImage bytes, plus out_path safety. Used by
                       pack_spritesheet and export_for_engine; pixelate_image still has its own
                       private duplicate of this (tracked as pixelforge-mcp-b3u — dedupe when picked up).
  arg-validation.ts  — shared dimension/seed/denoise validators used across sprite tool schemas.
  animation-runner.ts — the sequential frame-chaining engine behind generate_animation_set: one job
                       in flight at a time (frame N+1 needs frame N's actual pixels), one seed for
                       the whole set, partial failures recorded per-frame rather than thrown.
  comfyui/           — workflow JSON construction, style→checkpoint mapping (checkpoint is keyed by
                       STYLE ALONE — `ViewpointProfile` has structurally no checkpoint field, so
                       "viewpoint implies a model" is inexpressible, not just discouraged; see
                       style-profiles.ts), the sprite job-bridge (thin wrapper over inherited
                       enqueueWorkflow), and the sprite layer's one polling loop
                       (sprite-status.ts → waitForSpriteJob, used by get_sprite_result and the
                       animation runner — never hand-roll a second poll loop).
  postprocess/       — quantization, grid-snap, isolated-pixel cleanup, palettes/
  packing/           — spritesheet packer (fixed-cell grid, NOT a bin-packer — sprite frames are
                       uniform-size and a grid is what a Unity slice-import wants) + metadata builder.
  tools/             — one file per MCP tool (see tool-surface.md).
  export/            — engine translation for `export_for_engine`: `unity.ts` is the pure
                       top-left/y-down → bottom-left/y-up rect translator (Unity only in MVP);
                       `validate-metadata.ts` is the boundary check on the caller-supplied
                       `pack_spritesheet` metadata object (frame_count/frames.length agreement,
                       rects within sheet bounds). Neither touches disk or `sharp`.
.claude/agents/      — Claude Code subagent prompts, always in English. One orchestrator plus six
                       specialist domains, each as a sonnet/opus tier pair (see
                       subagent-orchestration.md).
```

See also: [`tool-surface.md`](tool-surface.md) for what each `src/sprite/tools/*.ts` file's tool
does, and [`locked-decisions.md`](locked-decisions.md) for the architectural constraints this
layout was built to enforce structurally (not just by convention).
