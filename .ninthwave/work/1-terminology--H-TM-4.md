# Docs: Update agent prompt and skill docs from TODO to work item (H-TM-4)

**Priority:** High
**Source:** Terminology migration -- completing rename from TODO to work item
**Depends on:** H-TM-1
**Domain:** terminology

Update the implementation agent prompt and skill documentation to use "work item" instead of "TODO" terminology.

Files and changes:

**agents/implementer.md** (~40 references):
- Section header: "# TODO Worker Agent" -> "# Work Item Agent"
- "single TODO item" -> "single work item" throughout
- "Understand the TODO" -> "Understand the work item"
- "the TODO's acceptance criteria" -> "the work item's acceptance criteria"
- "the TODO has a Test plan" -> "the work item has a Test plan"
- "Remove Your TODO File" -> "Remove Your Work Item File"
- "delete your todo file" -> "delete your work item file"
- "Each TODO is a separate file" -> "Each work item is a separate file"
- "TODO files: Only delete your own" -> "Work item files: Only delete your own"
- All remaining "TODO" -> "work item" references in descriptions and comments
- KEEP `YOUR_TODO_ID` placeholders unchanged -- these are substitution tokens used by the launcher
- Update references to renamed functions if mentioned (e.g., format guide path reference)

**skills/decompose/SKILL.md** (~15 references):
- "create todos for" -> "create work items for"
- "for TODO IDs" -> "for work item IDs"
- "into TODO items" -> "into work items"
- "Each TODO should target" -> "Each work item should target"
- "When a TODO targets a repo" -> "When a work item targets a repo"
- "Every TODO MUST include" -> "Every work item MUST include"
- "Group TODOs into batches" -> "Group work items into batches"
- "Write each TODO" -> "Write each work item"
- "ASCII only: TODO files" -> "ASCII only: Work item files"
- "Spec fidelity: Every requirement must map to at least one TODO" -> "...work item"
- "No implementation: This skill only plans and writes TODOs" -> "...work items"
- "Split TODOs > ~500 LOC" -> "Split work items > ~500 LOC"
- "No VERSION/CHANGELOG: TODOs should not" -> "Work items should not"
- Update `todos-format.md` path reference to `work-item-format.md`

**skills/work/SKILL.md** (~20 references):
- "selects TODO items" -> "selects work items"
- "which TODO items to work on" -> "which work items to work on"
- "sync todo state" -> "sync work item state"
- "Commit and push TODO changes" -> "Commit and push work item changes"
- "TODO file changes" -> "Work item file changes"
- "TODO files are created" -> "Work item files are created"
- "chore: sync TODO files" -> "chore: sync work item files"
- "sync todo state with GitHub" -> "sync work item state with GitHub"
- "new actionable entries -- friction items that don't already have corresponding TODOs" -> "...work items"
- "Decompose into TODOs?" -> "Decompose into work items?"
- "decompose into TODOs" -> "decompose into work items"
- "decomposed TODOs" -> "decomposed work items"
- "friction entries and decomposed TODOs" -> "friction entries and decomposed work items"
- "New TODOs created" -> "New work items created"
- "Friction -> TODOs: 2 new items" -> "Friction -> work items: 2 new items"
- "[Worker: TODO-ID]" -> "[Worker: ITEM-ID]" (or keep TODO-ID if it matches YOUR_TODO_ID convention)

**Test plan:**
- Manual review: read each updated file to verify consistent terminology
- Verify no broken markdown formatting
- Grep check: `grep -rn "TODO" agents/implementer.md skills/decompose/SKILL.md skills/work/SKILL.md | grep -v "YOUR_TODO_ID\|TODO_ID\|# TODO:"` should return no hits
- Verify `cat` path reference in decompose/SKILL.md points to `work-item-format.md`

Acceptance: Agent prompt and both skill files use "work item" consistently. YOUR_TODO_ID substitution tokens are preserved. Format guide path references are updated. No broken markdown formatting.

Key files: `agents/implementer.md`, `skills/decompose/SKILL.md`, `skills/work/SKILL.md`
