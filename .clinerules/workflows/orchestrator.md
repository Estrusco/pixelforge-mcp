# Orchestrator / Router — PixelForge MCP

> Cline workflow ported from `.claude/agents/orchestrator.md` (a Claude Code subagent). That file is
> the source of record — if it changes, port the change here too; don't edit only this copy.
>
> **Important difference from the Claude Code original:** Claude Code's orchestrator dispatches to
> separate subagents through the `Agent` tool, each running in its own context. Cline has no
> equivalent tool — there is only this one conversation. So this workflow does not hand off work to
> another process; it has you (Cline, acting as yourself) figure out which specialist domain(s) a
> request touches, adopt that specialist's guidance from the matching file in
> `.clinerules/workflows/`, and do the work directly, in sequence, in this same session.

## Role

Given a user request, before writing any code: (1) identify which specialist domain(s) it belongs
to, (2) note the recommended model tier for each (informational only — switch your Cline API
profile yourself if you keep separate Sonnet/Opus profiles; nothing here does it automatically), and
(3) work through the domains in dependency order, reading the matching workflow file(s) below for
the relevant constraints before implementing. Do not skip straight to coding on a cross-domain
request just because part of it looks small.

## Specialist domains

| Domain | Workflow file | Owns |
|---|---|---|
| MCP Protocol Architect | `.clinerules/workflows/mcp-protocol-architect.md` | Tool schemas (`src/sprite/types.ts`), tool surface contract, versioning, transport/queue integration |
| ComfyUI Integration Specialist | `.clinerules/workflows/comfyui-integration-specialist.md` | Workflow JSON construction, style/viewpoint → checkpoint mapping, seeds, job-bridge |
| Pixel Art Post-Processing Specialist | `.clinerules/workflows/pixel-art-postprocessing-specialist.md` | `pixelate_image`, `remove_background` pipelines, quantization, palettes |
| Sprite Export Specialist | `.clinerules/workflows/sprite-export-specialist.md` | `pack_spritesheet`, `export_for_engine`, frame metadata |
| Prompt Engineer | `.clinerules/workflows/prompt-engineer.md` | ComfyUI positive/negative prompt templates, cross-specialist output review |
| TypeScript Architecture Specialist | `.clinerules/workflows/typescript-architecture-specialist.md` | Code structure, module boundaries, barrel files, convention review |

## Model-tier heuristic (informational)

Same heuristic as `CLAUDE.md` § "Subagent model tiers":

- **Opus-level care** — ambiguous requirements needing a judgment call; anything that touches or
  risks reversing a "locked architectural decision" in `CLAUDE.md`; cross-cutting design/tradeoff
  work; first-pass design of a new tool, pipeline, or schema; reviewing/critiquing prior output.
- **Sonnet-level care** — well-scoped, mechanical work following an already-documented pattern (e.g.
  adding a row to an existing mapping table, a straightforward bug fix with a clear root cause,
  incremental changes to an existing pure-transformation module that don't change its contract).
- **Default to the more careful (opus-level) pass when unsure** — getting it wrong costs more (a
  redo, a possible silent scope violation) than the extra effort of being careful once.

## Process

1. Read the user's request against the **Tool surface** and **Locked architectural decisions**
   sections of `CLAUDE.md` to identify which domain(s) it touches. A request can touch more than one
   domain (e.g. "add a new consistency mode" touches the MCP Protocol Architect domain for the schema
   and the ComfyUI Integration Specialist domain for the workflow logic — and note that
   `controlnet_pose` is explicitly gated behind user confirmation, so that particular request should
   stop and ask rather than proceed).
2. For each domain touched, open the matching workflow file above and hold its constraints in mind
   while you work — treat it the way you'd treat briefing a colleague, except the colleague is you.
3. If multiple domains are touched, work through them in dependency order (e.g. schema/contract
   changes before the implementation that consumes them; architecture/prompt review after
   implementation, not before).
4. If the request would silently reverse a locked decision, add an unlisted tool, or otherwise needs
   a design decision beyond what's already recorded in `CLAUDE.md` — stop and ask the user instead of
   picking a domain/tier and proceeding anyway.

## What this workflow does NOT do

- It does not spawn a separate agent or process — everything happens in this one conversation.
- It does not invent a new domain beyond the six above.
- It does not decide architecture on the user's behalf when a locked decision would be reversed —
  flag it and ask instead.
