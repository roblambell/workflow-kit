# Refactor: Agent role rename and scope isolation guards (H-RN-2)

**Priority:** High
**Source:** Scope reduction plan 2026-03-28
**Depends on:** H-RN-1
**Domain:** rename

Rename agent files from "worker" convention to role-based names and add scope isolation guards so agents don't activate outside ninthwave context.

Agent renames:
- `agents/todo-worker.md` -> `agents/implementer.md` (name: ninthwave-implementer)
- `agents/review-worker.md` -> `agents/reviewer.md` (name: ninthwave-reviewer)
- `agents/repair-worker.md` -> `agents/repairer.md` (name: ninthwave-repairer)

Update AGENT_SOURCES in `core/commands/setup.ts` (~line 226) to reference new filenames. Update `core/commands/launch.ts` which references agent filenames when seeding worktrees (~line 79 AGENT_FILES array). Update any references in docs: CLAUDE.md, CONTRIBUTING.md, ARCHITECTURE.md, docs/copilot-cli.md.

For each renamed agent, update the frontmatter:
- `name:` prefix with `ninthwave-` (e.g., `ninthwave-implementer`)
- `description:` make explicitly scoped (e.g., "ninthwave orchestration agent -- implements work items during `nw watch` sessions")

Add a tool-agnostic scope isolation guard to the top of each agent prompt (after frontmatter, before first section):
```
If no ninthwave work item context is available to you (no item ID,
no item specification, no work item details), you were not launched
by the ninthwave orchestrator. Inform the user this agent is
designed for ninthwave orchestration (`nw watch`) and stop.
```

This guard works across Claude Code (system prompt), OpenCode (env vars), and Copilot CLI (cwd conventions) without assuming a specific context mechanism.

Update symlink target directories: `.claude/agents/`, `.opencode/agents/`, `.github/agents/` will get new filenames. The `.github/agents/` suffix is `.agent.md` (e.g., `ninthwave-reviewer.agent.md`).

Update all test expectations that reference old agent filenames.

**Test plan:**
- Run `bun test test/` -- setup, init, launch tests must pass with new agent filenames
- Verify `grep -r "todo-worker" .` returns zero hits (except CHANGELOG)
- Verify `grep -r "review-worker" .` returns zero hits (except CHANGELOG)
- Verify `grep -r "repair-worker" .` returns zero hits (except CHANGELOG)
- Verify each agent file has the scope isolation guard text
- Verify each agent frontmatter has ninthwave- prefix in name field

Acceptance: Agent files renamed to implementer.md, reviewer.md, repairer.md. All frontmatter has ninthwave- prefixed names and scoped descriptions. Each agent has the isolation guard. Zero references to old names (except CHANGELOG). Setup/init correctly symlink new filenames into tool agent directories. All tests pass.

Key files: `agents/todo-worker.md`, `agents/review-worker.md`, `agents/repair-worker.md`, `core/commands/setup.ts:226`, `core/commands/launch.ts:79`, `test/setup.test.ts`, `test/init.test.ts`, `test/launch.test.ts`
