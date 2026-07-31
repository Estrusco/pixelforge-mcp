# Subagent orchestration

> Part of [fork-customization](INDEX.md).

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

## Subagent model tiers

- **Opus** — ambiguous requirements needing a judgment call; anything that touches or risks
  reversing a "locked architectural decision" (see [`locked-decisions.md`](locked-decisions.md));
  cross-cutting design/tradeoff work; first-pass design of a new tool, pipeline, or schema;
  reviewing/critiquing another agent's output.
- **Sonnet** — well-scoped, mechanical work following an already-documented pattern (e.g. adding a
  row to an existing mapping table, a straightforward bug fix with a clear root cause, incremental
  changes to an existing pure-transformation module that don't change its contract).
- **Default to opus when unsure** — a misrouted sonnet task that comes back wrong costs more (a
  second round-trip, possible silent scope violation) than the extra tokens of running opus once.
- The `orchestrator` agent itself always runs on opus — routing mistakes are more expensive than
  the agent's own token cost.

Note: this is distinct from the portable `pixelforge-expert-sonnet`/`-opus` agent in
[`../agents/`](../agents/), which is a consumer-facing tool-usage agent meant to be copied into
other projects, not one of the six PixelForge-maintainer specialist domains described here.
