# Syncing with upstream (fork maintenance)

> Part of [fork-customization](INDEX.md).

Sync via **`git merge`, never GitHub's "Sync fork" / "Discard commits" button** (that hard-resets
to upstream and destroys local commits). Our `CLAUDE.md` is **decoupled from upstream's** so our
guidance stays ours: a `merge=ours` driver in `.gitattributes` makes every merge keep our
`CLAUDE.md` verbatim, and upstream's copy is mirrored into **`CLAUDE_mainrepo.md`** (a read-only
snapshot, not auto-loaded by Claude Code) so upstream's tooling notes stay visible for manual
review/port. `CLAUDE_mainrepo.md` is ours (upstream never touches that path), so it never conflicts.

## Sync procedure

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

## Notes

- If `merge.ours.driver` is **not** set, the `.gitattributes` line is inert and git would try to
  merge upstream's `CLAUDE.md` into ours — always run step 0 first. (The driver only fires on a
  real 3-way merge, which the diverged fork history always produces; a fast-forward can't happen
  here.)
- Resolve any code conflicts manually; never blanket-pick ours/theirs on `src/tools/index.ts`
  (`TOOL_GROUPS`), anything under `src/sprite/`, or dependency logic.
- Upstream commit authorship is preserved on merge — do **not** rewrite it to satisfy signature
  checks; that would falsify authorship and break the attribution requirement (see
  [`overview.md`](overview.md)).
