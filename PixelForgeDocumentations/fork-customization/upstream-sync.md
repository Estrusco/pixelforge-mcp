# Syncing with upstream (fork maintenance)

> Part of [fork-customization](INDEX.md).

Sync via **`git merge`, never GitHub's "Sync fork" / "Discard commits" button** (that hard-resets
to upstream and destroys local commits). Our `CLAUDE.md` and `README.md` are **decoupled from
upstream's** so our guidance/attribution stays ours: `merge=ours` drivers in `.gitattributes` make
every merge keep both files verbatim, and upstream's copies are mirrored into
**`CLAUDE_mainrepo.md`** / **`README_mainrepo.md`** (read-only snapshots, not auto-loaded by Claude
Code and not what GitHub/npm render for this repo) so upstream's tooling notes and full generic
ComfyUI docs stay visible for manual review/port. Both `_mainrepo.md` files are ours (upstream
never touches those paths), so they never conflict.

## Sync procedure

```bash
# 0. Activate the "ours" driver for this clone. REQUIRED — a fresh clone does
#    not have it set, and without it the .gitattributes rules below are inert.
git config merge.ours.driver true

# 1. Fetch upstream (does not exist yet in a fresh clone → add it once).
git remote get-url upstream 2>/dev/null || \
  git remote add upstream https://github.com/artokun/comfyui-mcp.git
git fetch upstream

# 2. Refresh the upstream CLAUDE.md / README.md mirrors BEFORE merging.
git show upstream/main:CLAUDE.md > CLAUDE_mainrepo.md
git show upstream/main:README.md > README_mainrepo.md

# 3. Review what's incoming, then merge (merge — not rebase, not reset).
git log --oneline HEAD..upstream/main
git merge upstream/main     # our CLAUDE.md and README.md are retained automatically
```

## Notes

- If `merge.ours.driver` is **not** set, the `.gitattributes` lines are inert and git would try to
  merge upstream's `CLAUDE.md`/`README.md` into ours — always run step 0 first. (The driver only
  fires on a real 3-way merge, which the diverged fork history always produces; a fast-forward
  can't happen here.)
- Step 2's `git show` dumps upstream's file verbatim, which overwrites the "READ-ONLY MIRROR"
  header comment at the top of `CLAUDE_mainrepo.md`/`README_mainrepo.md` — re-add it after
  refreshing (copy it from the previous version via `git diff`/`git show HEAD:<file>`, or from the
  other mirror file, before committing the refresh).
- Resolve any code conflicts manually; never blanket-pick ours/theirs on `src/tools/index.ts`
  (`TOOL_GROUPS`), anything under `src/sprite/`, or dependency logic.
- Upstream commit authorship is preserved on merge — do **not** rewrite it to satisfy signature
  checks; that would falsify authorship and break the attribution requirement (see
  [`overview.md`](overview.md)).
