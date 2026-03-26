# Docs: Update documentation for TUI mode and supervisor session (L-SUP-4)

**Priority:** Low
**Source:** Supervisor session pivot plan — documentation phase
**Depends on:** M-SUP-3
**Domain:** docs

## Context

The daemon output pivot and supervisor session changes affect the documented architecture, CLI flags, and skill instructions. Update docs to reflect the new reality.

## Requirements

1. Update `CLAUDE.md` architecture section:
   - Add `agents/supervisor.md` to the file listing
   - Add `core/status-render.ts` to the file listing
   - Document TUI mode vs JSON mode for the daemon
   - Note that the inline supervisor has been replaced by a session-based supervisor
2. Update `skills/work/SKILL.md`:
   - Remove references to the status pane
   - Update supervisor mode description to reflect session-based approach
   - Document `--json` flag for orchestrate command
3. Update any other skill docs that reference:
   - The inline supervisor
   - The status pane
   - `supervisorTick` or `callClaudeCLI`

Acceptance: All documentation accurately reflects the current architecture. No references to the inline supervisor, status pane, or removed functions remain in docs. New flags (`--json`) and new files (`agents/supervisor.md`, `core/status-render.ts`) are documented.

**Test plan:**
- Grep docs for "status pane", "supervisorTick", "callClaudeCLI" — zero matches
- CLAUDE.md lists `agents/supervisor.md` and `core/status-render.ts`
- skills/work/SKILL.md references `--json` flag

Key files: `CLAUDE.md`, `skills/work/SKILL.md`
