# TODOS

<!-- Format guide: core/docs/todos-format.md -->

## Engineering Review (eng review, 2026-03-23)

### Test: Unit tests for parser and key functions (H-ER-1)

**Priority:** High
**Source:** Eng review 2026-03-23
**Depends on:** None

Add unit tests for the TODOS.md parser and key batch-todos.sh functions using bats-core or plain bash assertions with fixture files. The parser is the foundation everything else depends on and currently has zero test coverage. Cover: parse_todos with various TODOS.md fixtures (valid, malformed, empty), batch-order topological sort (including circular dependency detection), mark-done item removal (single, multiple, empty section cleanup), and version-bump LOC threshold logic.

Acceptance: Tests exist in a `test/` directory. Parser correctly handles well-formed input, malformed input (missing ID, missing priority), and empty files. Batch-order detects circular dependencies. Mark-done removes items and cleans empty sections. All tests pass via a single command (e.g., `bats test/`).

Key files: `core/batch-todos.sh`, `test/`

---

