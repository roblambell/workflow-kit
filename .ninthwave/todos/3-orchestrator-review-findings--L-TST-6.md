# Test: Add unit tests for git.ts error handling (L-TST-6)

**Priority:** Low
**Source:** Eng review H-ENG-1 — finding F17
**Depends on:** None
**Domain:** orchestrator-review-findings

All 17 git functions in `git.ts` are tested only indirectly. Add direct tests for error handling paths: non-zero exit codes throw with descriptive messages, helper functions return correct defaults on failure.

**Test plan:**
- Unit test: git helper throws Error with command name and stderr on failure
- Unit test: branchExists returns false on non-zero exit
- Unit test: commitCount returns 0 on failure
- Unit test: diffStat returns {0, 0} on failure
- Unit test: getStagedFiles returns [] on failure

Acceptance: Error handling paths in git.ts are directly tested. Tests pass.

Key files: `core/git.ts`, `test/git.test.ts`
