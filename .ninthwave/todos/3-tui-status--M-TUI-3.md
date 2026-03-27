# Feat: Add domain and ninthwave labels to worker PRs (M-TUI-3)

**Priority:** Medium
**Source:** TUI status display improvements
**Depends on:** None
**Domain:** tui-status

Workers create PRs with `gh pr create` but never set labels. The domain field from TODO files is available but unused for PR metadata. Adding labels makes it easy to filter and organize PRs by domain in GitHub.

Update the worker agent prompt (`agents/todo-worker.md`) to: (1) Extract the domain from the TODO file as a variable (it already parses Priority, Source, etc.). (2) Before creating the PR, ensure the labels exist with `gh label create`. (3) Add `--label "domain:YOUR_DOMAIN" --label "ninthwave"` to the `gh pr create` command.

**Test plan:**
- Manual verification: process a TODO and confirm the resulting PR has both labels set
- Verify `gh label create` uses `--force` flag so it does not error if label already exists
- Check PR creation still works if label creation fails (the `|| true` guard)

Acceptance: Worker PRs are created with a `domain:<slug>` label matching the TODO's domain field and a `ninthwave` label. Labels are created if they do not already exist. PR creation does not fail if label creation fails.

Key files: `agents/todo-worker.md:206-258`
