# Feat: Em dash lint rule and ARCHITECTURE.md state diagram update (M-RX-5)

**Priority:** Medium
**Source:** CEO review expansion 2026-03-28
**Depends on:** M-RX-3
**Domain:** review-experience

Add `no-em-dash` lint rule to test/lint-tests.test.ts. Create a `getProjectFiles()` helper that globs `**/*.ts` and `**/*.md` excluding node_modules/, .worktrees/, dist/, .git/. Pattern: detect Unicode \u2014. Suppressible with `// lint-ignore: no-em-dash`. Update ARCHITECTURE.md mermaid state diagram to add missing review-pending transitions: reviewing -> review_pending (request-changes), review_pending -> ci_pending (implementer pushes fix), review_pending -> reviewing (re-review after CI passes).

**Test plan:**
- Verify lint rule catches em dash in a .ts file (add one, confirm test fails, remove it)
- Verify lint rule catches em dash in a .md file
- Verify lint-ignore suppression works
- Verify getProjectFiles() excludes node_modules and .worktrees
- Manual: review ARCHITECTURE.md diagram renders correctly

Acceptance: Adding an em dash to any .ts or .md file causes `bun test test/` to fail. ARCHITECTURE.md state diagram includes complete review-pending transitions. `bun test test/` passes.

Key files: `test/lint-tests.test.ts`, `ARCHITECTURE.md`
