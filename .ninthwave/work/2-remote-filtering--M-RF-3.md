# Feat: Seed agent files from origin/main (M-RF-3)

**Priority:** Medium
**Source:** Decomp backlog 2026-03-28
**Depends on:** H-RF-1
**Domain:** remote-filtering

Currently `seedAgentFiles()` copies agent prompt files from the user's local checkout (`projectRoot/agents/`). With remote-only filtering, the orchestrator should also read agent files from origin/main for consistency -- workers should get the same agent prompts that correspond to the remote state of the work items.

Use `git show origin/main:agents/<filename>` to read agent file content from the remote branch instead of the local filesystem. Fall back to local filesystem reads if the remote version is unavailable (offline, file doesn't exist on remote).

**Test plan:**
- Test agent file content is read from origin/main when available
- Test fallback to local filesystem when git show fails
- Test fallback when agents/ directory doesn't exist on remote
- Edge case: agent file exists locally but not on remote -- uses local version

Acceptance: When launching workers, agent files are read from origin/main. Local-only agent file edits don't affect workers until pushed. Graceful fallback to local files when remote is unavailable.

Key files: `core/commands/launch.ts`
