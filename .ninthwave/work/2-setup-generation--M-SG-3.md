# Add migration and pruning for legacy generated artifacts (M-SG-3)

**Priority:** Medium
**Source:** /decompose 2026-04-01
**Depends on:** H-SG-2
**Domain:** setup-generation

Handle the legacy tracked/generated world explicitly so old symlinks and orphaned generated files do not survive the new copy-based model.

During init, replace legacy symlinks with managed copies, detect broken symlinks with `lstat`, and prune orphaned generated entries only within ninthwave-managed target paths. Keep cleanup narrowly scoped to `.claude/skills/*`, `.claude/agents/*`, `.opencode/agents/*`, `.github/agents/*`, and `.github/copilot-instructions.md`.

**Test plan:**
- Add tests that seed broken symlinks and orphaned generated files, then rerun init
- Verify broken symlinks are handled even when `existsSync` would miss them
- Run `bun test test/`

Acceptance: Legacy symlinks are replaced cleanly, broken links are handled correctly, and orphan cleanup only touches ninthwave-managed generated paths.

Key files: `core/commands/setup.ts`, `core/commands/init.ts`, `core/agent-files.ts`
