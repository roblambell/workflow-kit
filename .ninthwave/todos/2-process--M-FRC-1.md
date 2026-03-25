# Fix: Auto-commit friction log entries in /work continuous delivery loop (M-FRC-1)

**Priority:** Medium
**Source:** Friction #19 — friction log never committed during grind loop
**Depends on:** None
**Domain:** process

Address friction item #19: the `/work` skill's Phase 3 friction review step discovers and decomposes friction entries, but never commits them. Friction files in `.ninthwave/friction/` and any new TODO files decomposed from friction accumulate uncommitted until someone notices.

**Changes to `skills/work/SKILL.md`:**

1. After Phase 3's friction review and decomposition step, add an explicit "Commit friction artifacts" step:
   - `git add .ninthwave/friction/ .ninthwave/todos/`
   - `git commit -m "chore: commit friction entries and decomposed TODOs"`
   - Only commit if there are staged changes (skip if nothing new)

2. After friction entries are reviewed and decomposed, mark them as processed:
   - Rename reviewed friction files to include a `--processed` suffix, or move them to `.ninthwave/friction/processed/`
   - This prevents re-reviewing the same friction entries in the next loop iteration

3. Document the commit step clearly in the skill instructions so future edits don't accidentally remove it.

**Design decision:** Use a `processed/` subdirectory rather than renaming — it keeps the friction directory clean and scannable. The original files are preserved for audit trail purposes.

Acceptance: The /work skill's Phase 3 commits friction entries and decomposed TODOs before continuing. Processed friction files are moved to a `processed/` subdirectory. The commit step is clearly documented in `skills/work/SKILL.md`. No behavior change to other phases.

**Test plan:**
- Read through the updated SKILL.md and verify the commit step is in the correct position (after friction decomposition, before vision exploration)
- Verify the commit step is conditional (only commits if there are changes)
- Verify processed friction files are moved, not deleted
- Run `bun test test/` to confirm no regressions

Key files: `skills/work/SKILL.md`
