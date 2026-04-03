# .ninthwave gitignore: public vs private repos and work item visibility (2026-03-26)

## What happened
Setting up ninthwave on strait (a public repo). `ninthwave init`/`setup` commits the entire `.ninthwave/` directory with no option to ignore parts of it. This works fine for a private org repo where work items are team assets, but on a public repo by a solo dev, committing the task backlog is unnecessary noise in the git history and visible to anyone browsing the repo.

## Challenges

### 1. No public/private toggle
There's no way to tell ninthwave "this is a public repo, don't commit my work items." The setup flow always ends with `git add -A && git commit`. A solo dev on a public repo has different needs from a team on a private repo -- the current one-size-fits-all approach doesn't account for this.

### 2. Should users be able to gitignore work items?
If `.ninthwave/work/` is gitignored, work items only exist locally. This raises questions:
- Work-item-worker agents run in worktrees. If a worker completes a work item and deletes the file on its worktree branch, does that deletion propagate correctly when the branch merges? If work items are gitignored, the delete would be a no-op (the file isn't tracked), so the work item file would persist on the main branch's working tree -- but it's also not tracked, so it just lingers as an untracked file that never gets cleaned up.
- Reconciliation (`ninthwave reconcile`) cross-references merged PRs against work item files. If work items aren't in git, the reconciliation logic can't see what was completed from a clean clone -- it only works on the machine where the work items exist.
- Multiple developers on a private repo might independently create conflicting work items if they're not shared via git.

### 3. Symlinks to ninthwave source are committed
`ninthwave setup` creates symlinks in `.claude/agents/`, `.claude/skills/`, `.opencode/agents/`, and `.github/agents/` pointing to `../../../ninthwave/...`. These resolve to the local ninthwave checkout, so they're broken for any other contributor who clones the repo. On a public repo, that's everyone. These probably need to be gitignored by default, or setup should copy files instead of symlinking when the target project isn't the ninthwave repo itself.

### 4. Version file is local tooling state
`.ninthwave/version` contains a ninthwave commit hash. Different developers may run different ninthwave versions. It's more like a lockfile entry than project config -- unclear whether it belongs in git.

## Impact
- Public repos get cluttered with internal task management files
- Symlinks are broken for external contributors on every ninthwave-managed public repo
- No clear guidance on what to commit vs ignore -- users have to figure it out themselves
