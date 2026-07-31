# Explicitly rejected alternatives (context for "why don't we just use X")

> Part of [fork-customization](INDEX.md).

During discovery, these were evaluated and rejected as a substitute for building PixelForge:

- **SpriteCook** — SaaS only (hosted API, Bearer key), no local/self-hosted option. Excluded.
- **tuannguyen14/ComfyAI-MCP-GameAssets** — no LICENSE file (all-rights-reserved by default, not
  legally forkable), only 2 commits, and technically weak on the exact points that matter (no real
  palette quantization, animation is naive img2img+text-hint with no consistency guarantee, Unity
  export is a bare file copy with no slicing metadata). Not adopted.
- **willibrandon/pixel-mcp** — MIT, mature (123 commits), well-engineered, but solves a different
  problem (manual/programmatic pixel art via Aseprite, not AI generation from ComfyUI). Considered
  as a downstream post-processing dependency, deliberately rejected in favor of a native pipeline
  (see [`locked-decisions.md`](locked-decisions.md), "No Aseprite / no second MCP server dependency").
