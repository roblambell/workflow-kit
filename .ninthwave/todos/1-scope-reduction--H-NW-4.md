# Refactor: Remove migration commands and TODOS.md (H-NW-4)

**Priority:** High
**Source:** Plan: Focus ninthwave to narrowest wedge (0.2.0)
**Depends on:** None
**Domain:** scope-reduction

Remove the `migrate-todos` and `generate-todos` CLI commands (legacy TODOS.md ↔ file-per-todo migration). Also remove `TODOS.md` itself -- it's auto-generated and redundant with `.ninthwave/todos/` which is the canonical source.

**Delete files:**
- `core/commands/migrate-todos.ts` (510 lines)
- `TODOS.md` (auto-generated, ~121 lines)
- `test/migrate-todos.test.ts`

**Modify:**
- `core/cli.ts` -- Remove `cmdMigrateTodos` and `cmdGenerateTodos` imports, remove their case branches in the command dispatcher, remove from `COMMANDS` help array

**Test plan:**
- Run `bun test test/` -- all surviving tests must pass
- Verify `ninthwave --help` no longer lists `migrate-todos` or `generate-todos`
- Verify `grep -r "migrate-todos\|generate-todos\|cmdMigrateTodos\|cmdGenerateTodos" core/` returns nothing

Acceptance: migrate-todos.ts deleted, TODOS.md deleted, commands removed from CLI dispatcher and help, `bun test test/` passes.

Key files: `core/commands/migrate-todos.ts`, `core/cli.ts`, `TODOS.md`
