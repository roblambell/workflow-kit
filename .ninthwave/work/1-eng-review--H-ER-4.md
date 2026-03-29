# Review: Git & GitHub Integration (H-ER-4)

**Priority:** High
**Source:** Engineering review -- full codebase audit
**Depends on:** H-ER-3
**Domain:** eng-review

Read all git operations, GitHub API interactions, PR lifecycle, cross-repo support, and stacked branch handling. Reference findings from Reviews 1-3. Write findings to `.ninthwave/reviews/04-git-github.md`.

## Files to Review

- `core/git.ts` (388 LOC) -- git abstraction layer
- `core/gh.ts` (518 LOC) -- GitHub CLI wrapper
- `core/cross-repo.ts` (429 LOC) -- sibling directory navigation, cross-repo bootstrap
- `core/commands/pr-monitor.ts` (600 LOC) -- CI polling loop
- `core/stack-comments.ts` -- PR comment relay for stacked branches
- `core/commands/conflicts.ts` -- merge conflict detection
- `core/commands/reconcile.ts` (427 LOC) -- state recovery after daemon crash
- `core/lock.ts` (119 LOC) -- distributed lock via mkdir
- `.ninthwave/reviews/01-types-data-model.md` -- prior review
- `.ninthwave/reviews/02-state-machine.md` -- prior review
- `.ninthwave/reviews/03-worker-management.md` -- prior review

## Review Criteria

1. **Stacked branch base corruption:** When a dependency gets stuck, can a stacked branch end up with a corrupted base? What if the old base branch is already deleted by the time rebase runs?
2. **Lock safety:** `lock.ts` uses mkdir-based locking with PID verification. Is the TOCTOU guard sufficient? What happens if the process crashes between `tryMkdir` and `writePid`? Is the lock only used by cross-repo?
3. **GitHub API error handling:** Many `gh.ts` functions silently return empty arrays/objects on failure. Could a transient GitHub API outage cause the orchestrator to misinterpret "no checks" as "CI pending" and stall indefinitely?
4. **Cross-repo bootstrap security:** `bootstrapRepo` runs shell commands with user-controlled `alias` values from work item files. Is there injection risk?
5. **PR title collision:** `buildSnapshot` uses `prTitleMatchesWorkItem` to detect stale merged PRs. Could a title mismatch cause the orchestrator to ignore a legitimately merged PR?
6. **Force-push safety:** `daemonRebase` uses `--force-with-lease`. But if the daemon's local ref is stale, could it overwrite concurrent worker pushes?
7. **Comment spam prevention:** Can the orchestrator's own comments be processed as "new trusted comments" and relayed back to workers?

## Cross-Cutting Themes

### Theme A: Feature Necessity

- Is cross-repo (`cross-repo.ts`, 429 LOC) being used by real users, or is it foundation code without adoption? If stripped, how much simpler does the system become?
- Is `reconcile.ts` (427 LOC) exercised in practice, or do users just restart the daemon?
- Is `stack-comments.ts` adding value or noise on PRs?
- Is `lock.ts` only used by cross-repo? If cross-repo is stripped, does the lock go too?
- Is `conflicts.ts` actively used or is conflict handling done elsewhere?

### Theme B: Complexity Reduction

- `pr-monitor.ts` at 600 LOC -- is the polling complexity justified or can it be simplified?
- Can `reconcile.ts` be simpler if we accept some states are unrecoverable?
- Is `gh.ts` doing too much (PR creation + merge + checks + comments + review)? Should it be split or is it fine as one file?
- Can stacked branch handling be simplified or removed if it adds more complexity than value?

## Output Format

Write to `.ninthwave/reviews/04-git-github.md` using the same structure. Reference specific line numbers and cross-reference prior reviews.

**Test plan:**
- Verify `.ninthwave/reviews/04-git-github.md` exists with all required sections
- Verify cross-repo security analysis is thorough
- Verify findings cross-reference Reviews 1-3

Acceptance: Review document exists at `.ninthwave/reviews/04-git-github.md` covering git operations, GitHub API safety, cross-repo, stacked branches, and reconciliation, with specific line references and cross-references to prior reviews.

Key files: `core/git.ts`, `core/gh.ts`, `core/cross-repo.ts`, `core/commands/pr-monitor.ts`, `core/stack-comments.ts`, `core/commands/conflicts.ts`, `core/commands/reconcile.ts`, `core/lock.ts`
