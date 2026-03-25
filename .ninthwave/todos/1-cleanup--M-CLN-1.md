# Chore: Remove superseded TODO M-REM-3 (M-CLN-1)

**Priority:** Medium
**Source:** L-VIS-8 vision review
**Depends on:** (none)
**Domain:** cleanup

The TODO file `2-remote--M-REM-3.md` is marked as superseded — its scope was consolidated into H-REM-2, which has already shipped. The file should be deleted to keep the TODO queue clean.

**Test plan:**
- Verify M-REM-3 file is deleted
- Verify no other TODO references M-REM-3 as a dependency
- `bun test test/` passes

Acceptance: `2-remote--M-REM-3.md` deleted from `.ninthwave/todos/`. No broken dependency references. Tests pass.

Key files: `.ninthwave/todos/2-remote--M-REM-3.md`
