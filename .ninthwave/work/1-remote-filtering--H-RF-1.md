# Feat: Core remote-only filtering for work items (H-RF-1)

**Priority:** High
**Source:** Eng review plan 2026-03-28
**Depends on:** None
**Domain:** remote-filtering

Only process work items that exist on origin/main and match the remote version. Items with local-only state (uncommitted, committed but not pushed, or locally modified) are silently ignored by execution commands. Informational commands (list, deps, etc.) continue showing all local items.

Add `getCleanRemoteWorkItemFiles()` to `core/git.ts` using `git ls-tree` (inclusion set) and `git diff origin/main` (exclusion set). Add optional `projectRoot` param to `parseWorkItems()` in `core/parser.ts` that triggers the filter. Pass `projectRoot` at 4 execution call sites in `orchestrate.ts` and `launch.ts`. Add `fetchOrigin` before scan in watch mode. Replace the auto-commit preflight with an info log ("only items pushed to origin/main will be processed").

Add `setupTempRepoWithRemote()` to `test/helpers.ts` -- creates a temp repo with a bare remote configured as `origin` with an initial commit pushed. Write 8 test cases: getCleanRemoteWorkItemFiles returns correct Set when origin/main has files, returns null when origin/main doesn't exist, returns empty Set for empty remote dir, excludes locally modified files, excludes local-only files, gracefully degrades on diff failure, parseWorkItems filters when projectRoot provided, and falls back to all items on null.

**Test plan:**
- Add `setupTempRepoWithRemote()` helper to `test/helpers.ts` (bare remote + initial push)
- Test `getCleanRemoteWorkItemFiles()`: 6 cases covering ls-tree success/failure, diff exclusion, and graceful degradation
- Test `parseWorkItems()` with `projectRoot`: 2 cases covering filter behavior and null fallback
- Run `bun test test/` to verify no regressions in existing parser tests

Acceptance: `nw watch` and `nw start` only process items whose files exist on origin/main and match the remote content. `nw list` still shows all local items. Watch mode fetches before each scan. Auto-commit preflight replaced with info log. All 8 new tests pass. Existing tests pass unchanged.

Key files: `core/git.ts`, `core/parser.ts`, `core/commands/orchestrate.ts`, `core/commands/launch.ts`, `test/helpers.ts`
