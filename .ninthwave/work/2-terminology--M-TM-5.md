# Refactor: Test infrastructure cleanup -- TODO to work item (M-TM-5)

**Priority:** Medium
**Source:** Terminology migration -- completing rename from TODO to work item
**Depends on:** H-TM-1, H-TM-2
**Domain:** terminology

Clean up remaining "todo" terminology in test files: rename test files, rename `makeTodo()` test helpers to `makeWorkItem()`, update test descriptions, and rename test-local variables.

Note: Import paths and type references were already updated by H-TM-1. User-facing string assertions were already updated by H-TM-2. This item handles the remaining cosmetic cleanup.

**File renames:**
- `test/todo-files.test.ts` -> `test/work-item-files.test.ts`
- `test/todo-id-collision.test.ts` -> `test/work-item-id-collision.test.ts`

**Helper function renames** (in ~16 test files):
- `makeTodo()` -> `makeWorkItem()` in: analytics.test.ts, bootstrap.test.ts, daemon-integration.test.ts, daemon.test.ts, interactive.test.ts, merge-detection.test.ts, orchestrate.test.ts, orchestrator-unit.test.ts, orchestrator.test.ts, status-render.test.ts, telemetry.test.ts, todo-id-collision.test.ts, verify-main.test.ts
- `makeTodoItem()` -> `makeWorkItem()` in: parser.test.ts, todo-files.test.ts
- `makeTodosDir()` / `setupTodosDir()` / `createTodosDir()` -> `makeWorkItemsDir()` / `setupWorkItemsDir()` / `createWorkItemsDir()` in: mark-done.test.ts, parser.test.ts, launch.test.ts, reconcile.test.ts
- `fakeTodo()` -> `fakeWorkItem()` in: onboard.test.ts
- `writeTodoFiles()` -> `writeWorkItemFiles()` in: test/helpers.ts (if not already renamed by H-TM-1)

**Test description updates** (~35 test cases):
- Update `describe()` and `it()` strings containing "todo"/"TODO" across all affected test files
- Examples: "should parse TODO items" -> "should parse work items", "extracts todo ID from branch" -> "extracts item ID from branch"

**Variable renames in tests:**
- `d1TodoIds` / `d2TodoIds` -> `d1ItemIds` / `d2ItemIds` in mock-broker.test.ts
- `todoMap` -> `workItemMap`, `allTodos` -> `workItems` in various test files
- Other local variables using "todo" naming

**Test plan:**
- Run `bun test test/` -- all tests pass after renames
- Verify renamed test files are discovered by bun: `bun test test/work-item-files.test.ts` runs successfully
- Verify old test files are removed: `! ls test/todo-files.test.ts test/todo-id-collision.test.ts`
- Grep check: `grep -rn "makeTodo\|fakeTodo\|setupTodosDir\|createTodosDir" test/ --include="*.ts"` should return no hits
- Grep check: `grep -rn "TodoItem\|TodoEntry" test/ --include="*.ts"` should return no hits (imports already updated by H-TM-1)

Acceptance: All test files use "work item" terminology consistently. Test file renames are complete. All `makeTodo` helpers are renamed to `makeWorkItem`. Test descriptions use "work item" language. `bun test test/` passes with all renames applied.

Key files: `test/todo-files.test.ts`, `test/todo-id-collision.test.ts`, `test/helpers.ts`, `test/parser.test.ts`, `test/orchestrate.test.ts`, `test/launch.test.ts`, `test/onboard.test.ts`, `test/interactive.test.ts`
