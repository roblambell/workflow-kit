# Docs: Update documentation from TODO to work item terminology (H-TM-3)

**Priority:** High
**Source:** Terminology migration -- completing rename from TODO to work item
**Depends on:** H-TM-1
**Domain:** terminology

Update all project documentation files to use "work item" instead of "TODO" terminology. Also rename the format guide file from `todos-format.md` to `work-item-format.md` and update its content.

Files and changes:

**README.md**:
- Hero subtext: `todos/*.md` -> `.ninthwave/work/*.md`
- Line 21: "from todo files" -> "from work item files"

**ETHOS.md**:
- "TODOs are scoped to ~200-400 LOC." -> "Work items are scoped to ~200-400 LOC."

**CONTRIBUTING.md**:
- "read the TODO, read project conventions" -> "read the work item, read project conventions"
- "implements the TODO, runs tests" -> "implements the work item, runs tests"
- "todos-format.md" reference -> "work-item-format.md"

**VISION.md**:
- "decompose a feature into TODOs" -> "decompose a feature into work items"
- "all other TODOs complete" -> "all other work items complete"
- "decompose it into TODOs" -> "decompose it into work items"

**CLAUDE.md**:
- "When processing TODOs" -> "When processing work items"
- "process all ready TODOs -> review friction log -> decompose actionable friction into new TODOs -> process friction TODOs -> run vision item -> repeat with new TODOs" -- update all 4 "TODOs" -> "work items"

**core/docs/todos-format.md -> core/docs/work-item-format.md**:
- Rename file
- Title: "Todo File Format Guide" -> "Work Item File Format Guide"
- Update all ~30 "TODO" references to "work item" throughout the file content
- Fix the directory listing (still shows `todos/` instead of `work/`)
- Update references to function names that were renamed in H-TM-1 (e.g., `todoFilename()` -> `workItemFilename()`)

Do NOT modify CHANGELOG.md -- it is a historical record.

**Test plan:**
- Verify renamed file exists: `ls core/docs/work-item-format.md`
- Verify old file removed: `! ls core/docs/todos-format.md`
- Grep check: `grep -rn "TODO" README.md ETHOS.md CONTRIBUTING.md VISION.md CLAUDE.md core/docs/work-item-format.md | grep -v "YOUR_TODO_ID\|# TODO:"` should return no hits
- Verify README hero renders correctly (check HTML tags are intact)
- Manual review of each doc for consistent terminology

Acceptance: All documentation files use "work item" instead of "TODO". The format guide is renamed to `work-item-format.md` with updated content. CHANGELOG.md is unchanged. No broken links or references.

Key files: `README.md`, `ETHOS.md`, `CONTRIBUTING.md`, `VISION.md`, `CLAUDE.md`, `core/docs/todos-format.md`
