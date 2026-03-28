# Refactor: CLI user-facing strings and command variables -- TODO to work item (H-TM-2)

**Priority:** High
**Source:** Terminology migration -- completing rename from TODO to work item
**Depends on:** H-TM-1
**Domain:** terminology

Update all user-facing string literals in CLI command files from "TODO" to "work item" terminology. Also rename internal local variables (e.g., `todoMap` -> `workItemMap`, `allTodos` -> `workItems`). Update corresponding test assertions that check for these output strings.

Files and changes:

**core/help.ts** (11 description strings):
- "TODO item IDs to process" -> "Work item IDs to process"
- "List TODO items" -> "List work items"
- "Show dependency chain for a TODO item" -> "Show dependency chain for a work item"
- "Check file conflicts between TODO items" -> "Check file conflicts between work items"
- "Launch parallel coding sessions for TODO items" -> "Launch parallel coding sessions for work items"
- "Close all cmux todo workspaces" -> "Close all cmux workspaces"
- "Remove completed TODO files from disk" -> "Remove completed work item files from disk"
- "Sync TODO files with merged PRs" -> "Sync work items with merged PRs"
- "Report worker progress (auto-detects TODO ID from branch)" -> "Report worker progress (auto-detects item ID from branch)"
- "Launch TODO items by ID" -> "Launch work items by ID" (2 occurrences in printHelp/printHelpAll)

**core/commands/onboard.ts**:
- "process existing TODOs" -> "process existing work items"
- "there are no TODO items" -> "there are no work items"
- "Create TODO files manually" -> "Create work items manually"

**core/interactive.ts**:
- "No TODO items found." -> "No work items found."
- "Available TODOs:" -> "Available work items:"

**core/commands/launch.ts**:
- "Start implementing this TODO now." -> "Start implementing this work item now." (2 occurrences)
- "TODO item ${id} not found" -> "Work item ${id} not found"
- "Commit TODO files before launching workers." -> "Commit work item files before launching workers."
- "miss uncommitted TODO specs." -> "miss uncommitted work item specs."

**core/commands/orchestrate.ts**:
- "Watching for new TODOs..." -> "Watching for new work items..."
- "Commit and push TODO files" -> "Commit and push work item files"
- "Uncommitted TODO files detected" -> "Uncommitted work item files detected"
- "chore: commit TODO files before orchestration" -> "chore: commit work item files before orchestration"
- "TODO files committed and pushed." -> "Work item files committed and pushed."
- "Failed to auto-commit TODO files" -> "Failed to auto-commit work item files"
- "not found in todo files" -> "not found in work item files"

**core/commands/clean.ts**:
- "todo workspace(s)" -> "workspace(s)"

**core/commands/heartbeat.ts**:
- "Not on a todo branch" -> "Not on an item branch"

**core/commands/preflight.ts**:
- Update any "TODO" references in validation messages

Also rename local variables in command files: `todoMap` -> `workItemMap`, `allTodos` -> `workItems`, `todoCheck` -> `itemCheck`, `todoTitle` -> `itemTitle`, etc.

Update test assertions in test files that check for the old string values (e.g., `expect(output).toContain("TODO items")` -> `expect(output).toContain("work items")`).

**Test plan:**
- Run `bun test test/` -- all tests pass
- Run `nw --help` and verify no "TODO" in output
- Run `nw list --help`, `nw conflicts --help`, `nw start --help` -- verify updated descriptions
- Run `nw` with no args in a project with no work items -- verify "no work items" message
- Grep check: `grep -rn "TODO" core/help.ts core/commands/onboard.ts core/interactive.ts core/commands/launch.ts core/commands/orchestrate.ts core/commands/clean.ts core/commands/heartbeat.ts` should return no user-facing TODO references

Acceptance: All user-facing CLI output uses "work item" instead of "TODO". `nw --help` shows "work items" throughout. Error messages, prompts, and status messages use the new terminology. All tests pass. Internal variable names in command files use workItem/item instead of todo.

Key files: `core/help.ts`, `core/commands/onboard.ts`, `core/interactive.ts`, `core/commands/launch.ts`, `core/commands/orchestrate.ts`, `core/commands/clean.ts`, `core/commands/heartbeat.ts`
