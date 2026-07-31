# Conventions & working language

> Part of [fork-customization](INDEX.md). These are short and non-negotiable enough that
> `CLAUDE.md` keeps them inline too — this page is the canonical, linkable copy.

## Conventions (non-negotiable)

- Every `index.ts` is a **barrel file only** — re-exports, zero logic.
- One module, one responsibility. Pure transformation logic never touches disk I/O.
- Explicit TypeScript types everywhere — no implicit `any`. Tool I/O contracts in `types.ts` are
  the source of truth.
- Reuse the inherited queue/transport/VRAM-watchdog machinery from upstream artokun code — never
  duplicate it inside `src/sprite/`.
- Use `image-q`/`sharp` for quantization/resizing — don't hand-roll these algorithms.
- `.claude/agents/*.md` subagent prompts are always in English. Project discussion/design docs are Italian.
- Task tracking follows the **beads (`bd`)** workflow (see the Beads section of `CLAUDE.md`) — do
  not use TodoWrite or markdown TODO lists for PixelForge work either.

## Working language

Code, comments, `.claude/agents/*.md`, and `CLAUDE.md`: English.
Project design discussion (in the companion claude.ai Project): Italian.
