# Development Notes

## Local Testing with npm link

The developer uses `npm link` so that `npx comfyui-mcp` resolves to the local build at `C:\Users\klutt\code\comfyui-mcp\dist\`.

**DO NOT modify `plugin/.mcp.json`** to point to a local path. It must stay as:
```json
{
  "comfyui": {
    "command": "npx",
    "args": ["-y", "comfyui-mcp"]
  }
}
```
This works for both:
- **Public users**: `npx` downloads from npm
- **Developer**: `npm link` makes `npx` resolve to the local build

After code changes: `npm run build` then `/mcp` reconnect in Claude Code.

## Official comfy-cli Integration

`comfyui-mcp` integrates with official `comfy-cli` 1.11.1 or newer. Resolve the executable in this order: `COMFY_CLI_PATH`, the selected ComfyUI workspace's `.venv`/`venv`, then `PATH`.

- Prefer the `comfy_cli_*` MCP tools for CLI-owned behavior: environment/workspace discovery, managed server lifecycle, jobs, loaded-node search, workflow validation/execution, upload/download, model discovery/download/removal, and official agent skills.
- Local custom-node install/update/reinstall/fix operations prefer `comfy node` when a supported CLI is available. Fall back to ComfyUI-Manager HTTP when the CLI is missing or too old. Remote custom-node operations use Manager HTTP because the MCP host cannot manage the remote filesystem.
- Always invoke comfy-cli non-interactively with global `--json --skip-prompt`. Newer commands emit `envelope/1`; legacy `stop`, `node`, and singular `model` commands may still print plain text in v1.11.1, so the adapter normalizes their exit status/stdout/stderr into the same envelope contract.
- Treat `comfy stop` reporting that no background ComfyUI is running as idempotent success, so restart can continue to launch.
- Project-scoped `comfy skills` operations require an explicit project working directory. Do not let them inherit the MCP package directory.
- Do not reintroduce ComfyUI-Manager's removed `cm-cli.py` subprocess path.

See the **Official comfy-cli** section in `README.md` and `COMFY_CLI_PATH` in `.env.example` for the user-facing contract.

## Plugin File Sync

The plugin runs from cached copies, not the source tree. After changing files in `plugin/`:
- Cache: `~/.claude/plugins/cache/comfyui-mcp/comfy/0.1.0/`
- Marketplace: `~/.claude/plugins/marketplaces/comfyui-mcp/plugin/`

Copy changed files to both locations, then restart Claude Code for hooks or `/mcp` for MCP tools.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


---

# PixelForge MCP — Project Context

> Everything below this line is specific to the PixelForge sprite/pixel-art layer built on top of
> this fork. The sections above (npm link, plugin file sync, beads) are upstream fork tooling and
> still apply as-is — this project uses the same local-testing and issue-tracking workflow.
>
> Full detail behind every topic below lives in
> [`PixelForgeDocumentations/fork-customization/`](PixelForgeDocumentations/fork-customization/INDEX.md)
> — this section keeps only what must be known by default in every session. Read the linked doc
> before doing substantial work in the area it covers.

This file is the persistent context layer for Claude Code sessions on the PixelForge extension,
including autonomous `/goal` runs. Read this before making architectural changes. If you are about
to violate one of the "locked decisions" below, stop and ask for confirmation instead of
proceeding — full rationale and where each is structurally enforced:
[`locked-decisions.md`](PixelForgeDocumentations/fork-customization/locked-decisions.md).

## What this project is

PixelForge MCP is a local MCP server, in **TypeScript/Node.js**, that generates, animates,
post-processes, and exports sprites and pixel art for game development — built as a **fork of
[`artokun/comfyui-mcp`](https://github.com/artokun/comfyui-mcp)** (MIT license). It drives a local
**ComfyUI** instance (via Stability Matrix) already configured on the user's machine.

Primary consumer: a solo developer, expert in C#/Unity, building **Math Serpent** and other Unity
games. **Unity is the only export target in MVP.**

Attribution requirement (legal, not optional) and extended overview:
[`overview.md`](PixelForgeDocumentations/fork-customization/overview.md).

## Syncing with upstream (fork maintenance)

Sync via **`git merge`, never GitHub's "Sync fork" / "Discard commits" button** (that hard-resets
to upstream and destroys local commits). Full procedure, `.gitattributes`/`merge.ours.driver`
setup, and conflict-resolution notes:
[`upstream-sync.md`](PixelForgeDocumentations/fork-customization/upstream-sync.md).

## Repo layout

`src/` is inherited from artokun/comfyui-mcp (touch only when necessary); `src/sprite/` is
PixelForge-specific code isolated to keep future `git merge upstream/main` low-conflict;
`.claude/agents/` holds the six specialist subagent domains. Full per-file map and rationale:
[`repo-layout.md`](PixelForgeDocumentations/fork-customization/repo-layout.md).

## Tool surface (MVP — locked, do not add/remove without recorded decision)

`generate_sprite`, `get_sprite_result`, `generate_animation_set`, `generate_arcade_topdown_set`,
`pixelate_image`, `remove_background`, `pack_spritesheet`, `export_for_engine` — all implemented.
Full contract per tool: [`tool-surface.md`](PixelForgeDocumentations/fork-customization/tool-surface.md).

## Locked architectural decisions (do not silently reverse)

- `style` and `viewpoint` are independent axes — never conflate rendering aesthetic with camera angle.
- The sprite layer fixes img2img latent-size scaling itself (`buildSpriteWorkflow`) — never patch
  the upstream template for this.
- `consistency_mode: "controlnet_pose"` is schema-ready but **not implemented** — requires explicit
  user confirmation before starting that work.
- Palettes are hardcoded, no network fetch (no lospec.com API).
- Background removal is always delegated to ComfyUI, never reimplemented server-side.
- No Aseprite / no second MCP server dependency.
- Unity export is PNG + JSON, with **opt-in-by-default `.meta` generation**: `export_for_engine`
  writes a minimal Unity TextureImporter `.meta` (Sprite/Single/Point filter/no compression) next
  to each PNG it writes, auto-detected when the destination resolves inside a real Unity project
  (`generate_meta` overrides the heuristic either way) — and **never overwrites an existing
  `.meta`** (would reassign a GUID scenes/prefabs may reference). See
  `src/sprite/export/unity-meta.ts`.

Full rationale, enforcement location in code, and the alternatives evaluated and rejected during
design: [`locked-decisions.md`](PixelForgeDocumentations/fork-customization/locked-decisions.md) and
[`rejected-alternatives.md`](PixelForgeDocumentations/fork-customization/rejected-alternatives.md).

## Subagent orchestration

`.claude/agents/` holds six specialist domains plus an `orchestrator` entry point, each specialist
as a sonnet/opus tier pair — never dispatch to a bare (non-tiered) domain name. Full routing rules
and the model-tier heuristic:
[`subagent-orchestration.md`](PixelForgeDocumentations/fork-customization/subagent-orchestration.md).

## Conventions (non-negotiable)

- Every `index.ts` is a **barrel file only** — re-exports, zero logic.
- One module, one responsibility. Pure transformation logic never touches disk I/O.
- Explicit TypeScript types everywhere — no implicit `any`. Tool I/O contracts in `types.ts` are
  the source of truth.
- Reuse the inherited queue/transport/VRAM-watchdog machinery from upstream artokun code — never
  duplicate it inside `src/sprite/`.
- Use `image-q`/`sharp` for quantization/resizing — don't hand-roll these algorithms.
- `.claude/agents/*.md` subagent prompts are always in English. Project discussion/design docs are Italian.
- Task tracking follows the **beads (`bd`)** workflow documented above — do not use TodoWrite or
  markdown TODO lists for PixelForge work either.

(Canonical, linkable copy: [`conventions-and-language.md`](PixelForgeDocumentations/fork-customization/conventions-and-language.md).)

## Working language

Code, comments, `.claude/agents/*.md`, and this file: English.
Project design discussion (in the companion claude.ai Project): Italian.
