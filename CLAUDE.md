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

This file is the persistent context layer for Claude Code sessions on the PixelForge extension,
including autonomous `/goal` runs. Read this before making architectural changes. If you are about
to violate one of the "locked decisions" below, stop and ask for confirmation instead of proceeding.

## What this project is

PixelForge MCP is a local MCP server, in **TypeScript/Node.js**, that generates, animates,
post-processes, and exports sprites and pixel art for game development — built as a **fork of
[`artokun/comfyui-mcp`](https://github.com/artokun/comfyui-mcp)** (MIT license). It drives a local
**ComfyUI** instance (via Stability Matrix) already configured on the user's machine.

Primary consumer: a solo developer, expert in C#/Unity, building **Math Serpent** and other Unity
games. **Unity is the only export target in MVP.**

## Attribution (legal requirement, not optional)

This repo is a fork of `artokun/comfyui-mcp`, MIT-licensed. `README.md` and `LICENSE` must credit
the upstream project. Do not remove or obscure this attribution.

## Syncing with upstream (fork maintenance)

Sync via **`git merge`, never GitHub's "Sync fork" / "Discard commits" button** (that hard-resets
to upstream and destroys local commits). Our `CLAUDE.md` is **decoupled from upstream's** so our
guidance stays ours: a `merge=ours` driver in `.gitattributes` makes every merge keep our
`CLAUDE.md` verbatim, and upstream's copy is mirrored into **`CLAUDE_mainrepo.md`** (a read-only
snapshot, not auto-loaded by Claude Code) so upstream's tooling notes stay visible for manual
review/port. `CLAUDE_mainrepo.md` is ours (upstream never touches that path), so it never conflicts.

Sync procedure:

```bash
# 0. Activate the "ours" driver for this clone. REQUIRED — a fresh clone does
#    not have it set, and without it the .gitattributes rule below is inert.
git config merge.ours.driver true

# 1. Fetch upstream (does not exist yet in a fresh clone → add it once).
git remote get-url upstream 2>/dev/null || \
  git remote add upstream https://github.com/artokun/comfyui-mcp.git
git fetch upstream

# 2. Refresh the upstream CLAUDE.md mirror BEFORE merging.
git show upstream/main:CLAUDE.md > CLAUDE_mainrepo.md

# 3. Review what's incoming, then merge (merge — not rebase, not reset).
git log --oneline HEAD..upstream/main
git merge upstream/main     # our CLAUDE.md is retained automatically
```

Notes:
- If `merge.ours.driver` is **not** set, the `.gitattributes` line is inert and git would try to
  merge upstream's `CLAUDE.md` into ours — always run step 0 first. (The driver only fires on a
  real 3-way merge, which the diverged fork history always produces; a fast-forward can't happen
  here.)
- Resolve any code conflicts manually; never blanket-pick ours/theirs on `src/tools/index.ts`
  (`TOOL_GROUPS`), anything under `src/sprite/`, or dependency logic.
- Upstream commit authorship is preserved on merge — do **not** rewrite it to satisfy signature
  checks; that would falsify authorship and break the attribution requirement above.

## Repo layout

```
src/                — inherited from artokun/comfyui-mcp. Touch only when necessary.
                       Provides: stdio/streamable-HTTP transport, enqueue_workflow, get_job_status,
                       WebSocket progress, VRAM watchdog, process management.
src/sprite/          — NEW. All PixelForge-specific code. Isolated from upstream to keep future
                       `git pull` from upstream low-conflict.
  types.ts           — shared interfaces: tool I/O contracts, Style, Viewpoint, MotionState
  tools/             — one file per MCP tool (see "Tool surface" below)
  comfyui/           — workflow JSON construction, style/viewpoint → checkpoint mapping,
                       job-bridge (thin wrapper over inherited enqueue_workflow/get_job_status)
  postprocess/       — quantization, grid-snap, isolated-pixel cleanup, palettes/
  packing/           — spritesheet packer + frame metadata builder
  export/            — engine-specific export (unity-export.ts in MVP; others throw "not implemented")
.claude/agents/      — Claude Code subagent prompts, always in English. One orchestrator plus six
                       specialist domains, each as a sonnet/opus tier pair (see "Subagent
                       orchestration" below).
```

## Tool surface (MVP — locked, do not add/remove without recorded decision)

1. `generate_sprite` — single sprite from prompt (+ optional reference image), style + viewpoint, seed.
2. `get_sprite_result` — thin wrapper over inherited `get_job_status`.
3. `generate_animation_set` — coherent set of frames for `motion_states` (free-form strings, NOT a
   fixed humanoid walk/attack/jump vocabulary — a snake needs slither/eat, a bird needs flap/glide).
4. `generate_arcade_topdown_set` — preset wrapper over (1)/(3) for topdown arcade assets (e.g. Math
   Serpent). Forces `viewpoint: "topdown"`. `symmetric_rotation_safe: true` (default) generates ONE
   canonical frame and expects the engine to rotate it at runtime (safe for 90°-aligned movement;
   do not use for non-90° rotation needs — causes pixel-grid aliasing).
5. `pixelate_image` — nearest-neighbor grid-snap → palette quantization → nearest-color mapping →
   isolated-pixel cleanup, alpha-preserving throughout.
6. `remove_background` — routes to a ComfyUI custom node (rembg/BiRefNet/U2Net). NEVER reimplement
   background removal in TypeScript.
7. `pack_spritesheet` — frames → packed sheet + JSON metadata (frame rects, fps, pivot).
8. `export_for_engine` — MVP: Unity only, outputs **PNG + JSON slicing metadata for manual import**.
   No `.meta` file generation. Godot/GameMaker must throw "not implemented," never silently no-op.

## Locked architectural decisions (do not silently reverse)

- **`style` and `viewpoint` are independent axes.** Style = rendering aesthetic (16bit, chibi,
  hand-painted...). Viewpoint = camera angle (side, topdown, isometric). Never conflate them.
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

## Explicitly rejected alternatives (context for "why don't we just use X")

During discovery, these were evaluated and rejected as a substitute for building PixelForge:
- **SpriteCook** — SaaS only (hosted API, Bearer key), no local/self-hosted option. Excluded.
- **tuannguyen14/ComfyAI-MCP-GameAssets** — no LICENSE file (all-rights-reserved by default, not
  legally forkable), only 2 commits, and technically weak on the exact points that matter (no real
  palette quantization, animation is naive img2img+text-hint with no consistency guarantee, Unity
  export is a bare file copy with no slicing metadata). Not adopted.
- **willibrandon/pixel-mcp** — MIT, mature (123 commits), well-engineered, but solves a different
  problem (manual/programmatic pixel art via Aseprite, not AI generation from ComfyUI). Considered
  as a downstream post-processing dependency, deliberately rejected in favor of a native pipeline
  (see above).

## Subagent orchestration

`.claude/agents/` holds six specialist domains (`mcp-protocol-architect`,
`comfyui-integration-specialist`, `pixel-art-postprocessing-specialist`, `sprite-export-specialist`,
`prompt-engineer`, `typescript-architecture-specialist`), each present as two variants —
`<domain>-sonnet` and `<domain>-opus` — identical prompts, differing only in the `model` frontmatter
field. There is no bare `<domain>` agent; always dispatch to a tiered variant.

`orchestrator` (`.claude/agents/orchestrator.md`, `model: opus`) is the entry point for requests
that aren't obviously single-domain: given a user request, it decides which domain(s) apply and
which model tier to use for each, then dispatches via the `Agent` tool. Use it directly when a
request could span multiple domains or the right specialist/tier isn't obvious; for an
unambiguous single-domain request, dispatching straight to the right `<domain>-sonnet`/`-opus`
agent is also fine.

### Subagent model tiers

- **Opus** — ambiguous requirements needing a judgment call; anything that touches or risks
  reversing a "locked architectural decision" (see below); cross-cutting design/tradeoff work;
  first-pass design of a new tool, pipeline, or schema; reviewing/critiquing another agent's output.
- **Sonnet** — well-scoped, mechanical work following an already-documented pattern (e.g. adding a
  row to an existing mapping table, a straightforward bug fix with a clear root cause, incremental
  changes to an existing pure-transformation module that don't change its contract).
- **Default to opus when unsure** — a misrouted sonnet task that comes back wrong costs more (a
  second round-trip, possible silent scope violation) than the extra tokens of running opus once.
- The `orchestrator` agent itself always runs on opus — routing mistakes are more expensive than
  the agent's own token cost.

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

## Working language

Code, comments, `.claude/agents/*.md`, and this file: English.
Project design discussion (in the companion claude.ai Project): Italian.
