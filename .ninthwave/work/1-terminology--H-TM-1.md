# Refactor: Core type and module renames -- TODO to work item (H-TM-1)

**Priority:** High
**Source:** Terminology migration -- completing rename from TODO to work item
**Depends on:** None
**Domain:** terminology

Rename core types, module files, and exported functions from "todo" to "work item" terminology. This is the foundation item -- all other TM items depend on it. The changes are purely mechanical: type/interface renames, file renames, function renames, and updating all import paths and call sites across the entire codebase.

Key renames:
- `core/types.ts`: `TodoItem` -> `WorkItem`, `WorktreeInfo.todoId` -> `WorktreeInfo.itemId`
- `core/todo-files.ts` -> `core/work-item-files.ts`: rename file + all exports (`todoFilename` -> `workItemFilename`, `parseTodoFile` -> `parseWorkItemFile`, `listTodos` -> `listWorkItems`, `readTodo` -> `readWorkItem`, `writeTodoFile` -> `writeWorkItemFile`, `deleteTodoFile` -> `deleteWorkItemFile`)
- `core/todo-utils.ts` -> `core/work-item-utils.ts`: rename file + key exports (`prTitleMatchesTodo` -> `prTitleMatchesWorkItem`, `checkUncommittedTodos` -> `checkUncommittedWorkItems`)
- `core/parser.ts`: update imports and re-exports to use new names
- `core/commands/*.ts`: update all import paths and function call sites
- `core/orchestrator.ts`: `OrchestratorItem.todo` -> `OrchestratorItem.workItem` (or keep as `todo` if too disruptive -- use judgment)
- `core/mock-broker.ts`: `TodoEntry` -> `WorkEntry`, related property renames
- `core/crew.ts`: `SyncMessage.activeTodoIds` -> `SyncMessage.activeItemIds`
- `test/*.ts`: update all import paths, type references, and function call sites

Do NOT change string literals (user-facing messages), test descriptions, or `makeTodo()` test helpers -- those are handled by H-TM-2 and M-TM-5.

**Test plan:**
- Run `bun test test/` -- all tests must pass after renames
- Verify `nw list` still works (parser imports updated correctly)
- Verify no remaining imports of old module paths: `grep -r "todo-files\|todo-utils" core/ test/ --include="*.ts"` should return nothing
- Verify no remaining references to `TodoItem` type: `grep -r "TodoItem" core/ test/ --include="*.ts"` should return nothing (except possibly re-exports for backwards compat if needed)

Acceptance: All type names, module files, exported functions, and import paths are renamed from todo to work-item terminology. `bun test test/` passes. No TypeScript compilation errors. `nw list` and `nw watch --help` work correctly.

Key files: `core/types.ts`, `core/todo-files.ts`, `core/todo-utils.ts`, `core/parser.ts`, `core/orchestrator.ts`, `core/commands/launch.ts`, `core/commands/orchestrate.ts`
