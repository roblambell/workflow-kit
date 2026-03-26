# Feat: Create supervisor agent prompt (H-SUP-1)

**Priority:** High
**Source:** Supervisor session pivot plan — replace inline LLM with full Claude Code session
**Depends on:**
**Domain:** supervisor

## Context

The current supervisor calls `claude --print --model haiku` with a stateless prompt every 5 minutes. We're replacing this with a full Claude Code session seeded with an agent file. The agent prompt defines the supervisor's role, capabilities, and behavioral guidance.

## Requirements

1. Create `agents/supervisor.md` with standard frontmatter (name: supervisor, description, model: inherit).
2. Define the supervisor role: engineering supervisor monitoring a parallel AI coding pipeline run by the ninthwave orchestrator daemon.
3. Document available tools and how to use them:
   - `cmux read-screen --workspace {ref} --lines N` to inspect worker terminals
   - `cmux send --workspace {ref} {message}` to message workers (prefer paste-buffer approach for reliability)
   - `ninthwave status --json` for structured pipeline state
   - Direct file access for reading code, logs, state files
   - Writing friction observations to `.ninthwave/friction/` following the existing convention (source/date frontmatter, `[friction]`/`[improvement]` bullets, filesystem-safe timestamps)
4. Include behavioral guidance adapted from the existing `buildSupervisorPrompt()` in `core/supervisor.ts`:
   - What constitutes anomalies (stalled workers, CI cycling, no-commit patterns)
   - When to intervene vs observe (use commit freshness and screen health)
   - Non-interference principle: observe and nudge, never edit code or force-push branches
   - Escalation: when to flag issues for human attention
5. Explain that dynamic context (item list, workspace refs, merge strategy) will be delivered via the initial message, not baked into the agent file.
6. Include the friction log format specification so the supervisor can write friction files that match the existing convention used by `writeFrictionLog()`.

Acceptance: `agents/supervisor.md` exists with frontmatter matching the pattern in `agents/todo-worker.md`. The prompt covers role definition, tool documentation, behavioral guidance, friction logging format, and non-interference principles. Dynamic context is explicitly noted as coming via initial message.

**Test plan:**
- Verify agent file has valid frontmatter (name, description, model fields)
- Verify the prompt references cmux commands with correct syntax
- Verify friction log format matches the convention in `core/supervisor.ts` `writeFrictionLog()`
- Manual: `claude --agent supervisor` loads the agent without errors

Key files: `agents/supervisor.md` (new), `agents/todo-worker.md` (reference for format)
