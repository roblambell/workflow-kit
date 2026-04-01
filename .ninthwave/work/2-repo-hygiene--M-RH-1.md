# Update tests docs and repo tracking for generated artifacts (M-RH-1)

**Priority:** Medium
**Source:** /decompose 2026-04-01
**Depends on:** H-COP-1, M-SG-3
**Domain:** repo-hygiene

Finish the migration by aligning tests, docs, and this repo's tracking policy with the new canonical-source model.

Remove tracked generated mirrors from `.claude/`, `.opencode/`, and `.github/`, add repo-local ignore rules so this repo does not track regenerated copies, and update docs to describe generated managed copies instead of symlinks. This repo-specific ignore behavior should not become a universal rule for user repositories.

**Test plan:**
- Update test expectations for copy-based generation and Copilot behavior
- Verify repo-local ignore rules leave regenerated tool artifacts untracked in this repo
- Run `bun test test/`

Acceptance: This repo tracks only the canonical sources, generated tool artifacts stay untracked here, and the docs accurately describe the new behavior for both ninthwave itself and normal user repos.

Key files: `.gitignore`, `test/setup.test.ts`, `test/init.test.ts`, `test/seed-agent-files.test.ts`, `test/ai-tools.test.ts`, `test/launch.test.ts`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/onboarding.md`, `docs/faq.md`
