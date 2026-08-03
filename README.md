# PixelForge MCP

**A game-dev-focused sprite/pixel-art generation layer for [ComfyUI](https://github.com/comfyanonymous/ComfyUI), built on top of [`comfyui-mcp`](https://github.com/artokun/comfyui-mcp).**

PixelForge MCP is an MCP server (and Claude Code plugin) that lets an AI agent generate, animate,
post-process, pack, and export game sprites and pixel art — not just raw diffusion output. It
drives a local ComfyUI instance and adds a purpose-built tool surface on top of it: pick a `style`
and a `viewpoint`, get back a sprite; quantize it to a real palette and pixel grid; cut the
background; pack it into a spritesheet; export it straight into a Unity project, `.meta` file
included.

> **This is a personal fork**, not a published package. It exists to serve one project's actual
> workflow (a solo Unity developer's sprite pipeline) rather than to be a general-purpose public
> tool — see [Relationship to upstream](#relationship-to-upstream) below for what that means in
> practice.

## Attribution

This repository is a fork of [`artokun/comfyui-mcp`](https://github.com/artokun/comfyui-mcp),
MIT-licensed, by [**@artokun**](https://github.com/artokun). All of the underlying ComfyUI control
plane — workflow execution/composition/validation, model & custom-node management, the panel
agent, LoRA training, RunPod support, and roughly 180 general-purpose tools — is inherited from
that project essentially untouched. PixelForge adds a sprite/pixel-art layer on top; it does not
replace or fork the ComfyUI integration itself. See [LICENSE](./LICENSE) for the full MIT terms
and copyright notice.

For the complete upstream feature set — the full MCP tool reference, the Agent Panel, remote/cloud
deployment modes, other-harness support, and the generic ComfyUI quick start — see the mirrored
upstream documentation in **[README_mainrepo.md](./README_mainrepo.md)**.

## What this fork adds

Eight sprite-specific MCP tools, built as an isolated layer (`src/sprite/`) so upstream stays easy
to merge:

| Tool | Purpose |
|------|---------|
| `generate_sprite` | Single sprite from a prompt (+ optional reference image for img2img), `style` + `viewpoint`, seed, sampling overrides, optional auto-download of a missing checkpoint |
| `get_sprite_result` | Poll a sprite job for its finished asset |
| `generate_animation_set` | Coherent multi-frame animation across free-form `motion_states` (not a fixed walk/attack/jump vocabulary) |
| `generate_arcade_topdown_set` | Topdown-arcade preset — one rotation-safe canonical frame, or per-facing frames when the asset genuinely needs them |
| `pixelate_image` | Nearest-neighbor grid-snap → palette quantization (curated presets, k-means, or custom) → despeckle → optional upscale — turns diffusion output into actual pixel art |
| `remove_background` | Always ComfyUI-side: BiRefNet for general cutouts, or a core-nodes-only `luma_key` mode for dark/glow pixel art BiRefNet mishandles |
| `pack_spritesheet` | Frames → one sheet + JSON metadata (rects, fps, pivot) |
| `export_for_engine` | Unity-first export: PNG + JSON slicing metadata, plus an opt-in-by-default Unity `.meta` (auto-detected, never overwrites an existing one) |

Full parameter-level reference, end-to-end recipes, and known limitations:
[`PixelForgeDocumentations/agents/pixelforge-expert-*.md`](PixelForgeDocumentations/agents/) — a
self-contained agent spec meant to be copied into any Unity project's `.claude/agents/` folder.
Maintainer-facing "what's locked and why" for this same tool surface:
[`tool-surface.md`](PixelForgeDocumentations/fork-customization/tool-surface.md).

### Two independent axes: style × viewpoint

`style` (rendering aesthetic — `8bit`/`16bit`/`32bit`/`chibi`/`hand_painted`/`flat_vector`/
`realistic`) picks the checkpoint/sampler profile. `viewpoint` (camera angle — `side`/`topdown`/
`isometric`) only ever contributes prompt fragments. They are never conflated — asking for
"isometric" as a style, or expecting a viewpoint to change the model, isn't how this is built.

## Relationship to upstream

| | Upstream `comfyui-mcp` | This fork (PixelForge) |
|---|---|---|
| **Audience** | General public — any ComfyUI user, any LLM, published on npm | One solo developer's Unity sprite pipeline, run locally via `npm link` |
| **Primary tool surface** | ~180 tools: generic image/video/audio generation, workflow authoring, model/node management | The 180 tools above, **plus** the 8 sprite-specific tools in `src/sprite/` |
| **Output shape** | Raw diffusion output, any use case | Post-processed pixel art with a real palette and grid, ready for a game engine |
| **Export target** | N/A (not its concern) | Unity only in MVP — PNG + JSON + optional `.meta`, locked decision |
| **Distribution** | Published npm package + public plugin marketplace | Not published — local `npm link` + a `directory`-type Claude Code plugin marketplace pointing at this checkout |
| **Task tracking** | GitHub issues | [beads (`bd`)](https://github.com/gastownhall/beads) — see `CLAUDE.md` |
| **Panel agent / RunPod / training / other-harness support** | Yes | Inherited as-is, out of scope for PixelForge's own work |

PixelForge does **not** fork or reimplement the ComfyUI integration itself — workflow execution,
model/node management, the panel agent, and everything else in `src/` (outside `src/sprite/` and
the one intentionally-widened `src/tools/remove-background.ts`) stays on the upstream code path so
`git merge upstream/main` keeps working. See
[`repo-layout.md`](PixelForgeDocumentations/fork-customization/repo-layout.md) for the exact file
boundary and [`upstream-sync.md`](PixelForgeDocumentations/fork-customization/upstream-sync.md) for
how syncing is kept low-conflict (including this `README.md`/`CLAUDE.md` vs. `README_mainrepo.md`/
`CLAUDE_mainrepo.md` split itself).

## Locked architectural decisions

A handful of decisions are deliberately locked — don't silently reverse them:

- `style` and `viewpoint` are independent axes, never conflated.
- The sprite layer fixes img2img latent-size scaling itself; never patch the upstream template for it.
- `consistency_mode: "controlnet_pose"` is schema-visible but not implemented — always rejected.
- Palettes are hardcoded, curated presets — no lospec.com API fetch.
- Background removal is always delegated to ComfyUI, never reimplemented server-side.
- No Aseprite, no second MCP server dependency.
- Unity is the only export target; `.meta` generation is opt-in-by-default, auto-detected, and
  never overwrites an existing `.meta` (its GUID may already be referenced by scenes/prefabs).

Full rationale and where each is enforced in code:
[`locked-decisions.md`](PixelForgeDocumentations/fork-customization/locked-decisions.md).

## Quick start (local dev)

This fork isn't published to npm — point Claude Code at the local build:

```bash
git clone <this-repo>
cd pixelforge-mcp
npm install
npm run build
npm link          # so `npx comfyui-mcp` resolves to this local build
```

Then install the plugin from this checkout as a local, `directory`-type marketplace:

```bash
# In Claude Code
/plugin marketplace add /path/to/pixelforge-mcp
/plugin install pixelforge@pixelforge-mcp
```

`plugin/.mcp.json` deliberately stays `npx -y comfyui-mcp` (never a local path) so the same plugin
config works both for a public user (`npx` downloads from npm) and for local development (`npm
link` makes `npx` resolve to this build) — see `CLAUDE.md` for the full explanation. After code
changes: `npm run build`, then `/mcp` to reconnect (or restart Claude Code for hook/agent changes).

You'll also need a local **ComfyUI** instance running (auto-detected — see
[README_mainrepo.md](./README_mainrepo.md#auto-detection) for the detection rules and `COMFYUI_*`
env vars if you need to override them).

## Documentation

- [`PixelForgeDocumentations/fork-customization/INDEX.md`](PixelForgeDocumentations/fork-customization/INDEX.md) —
  everything about this fork: overview, repo layout, locked decisions, subagent orchestration,
  conventions, upstream-sync procedure.
- [`PixelForgeDocumentations/agents/`](PixelForgeDocumentations/agents/) — self-contained,
  consumer-facing tool reference (params, constraints, recipes) for an agent *using* PixelForge
  from another project.
- [`CLAUDE.md`](./CLAUDE.md) — the persistent session context Claude Code loads automatically;
  start here for any substantial change.
- [`README_mainrepo.md`](./README_mainrepo.md) — the full upstream README (general MCP tool
  reference, Agent Panel, deployment modes, other-harness setup) as a mirror, not re-documented here.

## Development

Standard upstream dev workflow applies — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev
setup, conventions, and how to add an MCP tool. PixelForge-specific conventions (barrel files,
English-only agent prompts, `bd` for task tracking instead of TODO lists, `image-q`/`sharp` for
quantization) are in
[`conventions-and-language.md`](PixelForgeDocumentations/fork-customization/conventions-and-language.md).

```bash
npm run dev      # run from source with tsx (hot reload)
npm run build    # compile TypeScript to dist/
npm test         # unit tests (vitest)
npm run lint     # type-check without emitting
```

## License

MIT — see [LICENSE](./LICENSE). Fork of [`artokun/comfyui-mcp`](https://github.com/artokun/comfyui-mcp);
original copyright retained.
