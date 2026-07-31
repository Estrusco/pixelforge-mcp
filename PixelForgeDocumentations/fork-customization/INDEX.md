# Fork customization — index

This documents how **PixelForge MCP** customizes/extends its upstream, **[`artokun/comfyui-mcp`](https://github.com/artokun/comfyui-mcp)** (MIT license). It is referenced from the "PixelForge MCP — Project Context" section of the repo's `CLAUDE.md`, which keeps only what must be known by default in every Claude Code session and points here for full detail.

| Topic | What it covers |
|---|---|
| [`overview.md`](overview.md) | What PixelForge MCP is, its primary consumer/use case, and the attribution requirement toward upstream. |
| [`upstream-sync.md`](upstream-sync.md) | How to merge in upstream changes without destroying local commits or losing this repo's `CLAUDE.md` — the `merge=ours` driver setup and step-by-step sync procedure. |
| [`repo-layout.md`](repo-layout.md) | Directory-by-directory, file-by-file map of `src/`, `src/sprite/`, and `.claude/agents/`, with the reasoning behind each module's boundary. |
| [`tool-surface.md`](tool-surface.md) | The 8 locked MVP sprite tools — what each does, its implementation status, and the specific guarantees it makes. |
| [`locked-decisions.md`](locked-decisions.md) | Architectural decisions that must not be silently reversed, with the reasoning and where each is structurally enforced in code. |
| [`rejected-alternatives.md`](rejected-alternatives.md) | Third-party tools/services evaluated as a substitute for building PixelForge, and why each was rejected — context for "why don't we just use X". |
| [`subagent-orchestration.md`](subagent-orchestration.md) | The six specialist subagent domains, the `orchestrator` entry point, and the sonnet/opus model-tier heuristic. |
| [`conventions-and-language.md`](conventions-and-language.md) | Non-negotiable coding conventions and the English/Italian working-language split. |

Not covered here: [`../agents/`](../agents/) holds the portable `pixelforge-expert-sonnet`/`-opus` subagent — a *consumer*-facing agent meant to be copied into other projects that use the PixelForge MCP server, as opposed to the maintainer-facing customization notes on this page.
