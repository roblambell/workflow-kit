# Test: Add TmuxAdapter unit tests (M-WRK-8)

**Priority:** Medium
**Source:** Eng review — `docs/reviews/eng-review-workers.md`
**Depends on:** None
**Domain:** worker-reliability

`TmuxAdapter` has zero test coverage. All 7 methods (`isAvailable`, `launchWorkspace`, `splitPane`, `sendMessage`, `readScreen`, `listWorkspaces`, `closeWorkspace`) are untested. Use the injectable `ShellRunner` constructor parameter to test without requiring tmux to be installed. Mirror the structure of the `CmuxAdapter` delegation tests.

**Test plan:**
- Test all 7 TmuxAdapter methods via injected ShellRunner
- Test session name generation (`nw-N` pattern)
- Test `listWorkspaces` filtering to `nw-` prefix
- Test `sendMessage` two-step (send-keys -l + Enter)
- Test error handling when tmux commands fail

Acceptance: All 7 `TmuxAdapter` methods have unit tests. Tests use dependency injection (ShellRunner), no real tmux required. Tests verify session name patterns, filtering, and error handling. No regression.

Key files: `core/mux.ts`, `test/mux.test.ts`
