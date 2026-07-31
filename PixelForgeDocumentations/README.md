# PixelForge Documentations

This folder is separate from the upstream `docs/` folder (the Mintlify site for the inherited
comfyui-mcp project). It holds PixelForge-specific documentation artifacts that aren't part of the
public docs site — starting with a portable "expert user" subagent.

## `agents/`

Two variants of the same subagent prompt — identical content, differing only in the `model:`
frontmatter field, mirroring the convention used by `.claude/agents/` in this repo:

- `pixelforge-expert-sonnet.md`
- `pixelforge-expert-opus.md`

Unlike the domain specialists in `.claude/agents/` (which own *developing* PixelForge itself and
assume this repo's `CLAUDE.md` is available), this agent is a **consumer/power-user** of the
PixelForge/comfyui-mcp MCP server's tools — meant to be copied into *other* game projects that have
the PixelForge MCP server connected, so those projects get an agent that knows how to drive the
sprite pipeline (and the full underlying ComfyUI/comfy-cli toolset) effectively. It is
self-contained: no dependency on this repo's source, docs, or `CLAUDE.md`.

### To use in another project

Copy the variant matching the model tier you want into the target project's `.claude/agents/`
directory:

```bash
cp PixelForgeDocumentations/agents/pixelforge-expert-sonnet.md /path/to/other-project/.claude/agents/
# or the opus variant
cp PixelForgeDocumentations/agents/pixelforge-expert-opus.md /path/to/other-project/.claude/agents/
```

The target project needs the PixelForge/comfyui-mcp MCP server registered (any server name — the
agent matches tool names by suffix, not by a fixed prefix).
