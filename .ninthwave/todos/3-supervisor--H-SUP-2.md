# Feat: Launch supervisor session and wire into orchestrate (H-SUP-2)

**Priority:** High
**Source:** Supervisor session pivot plan
**Depends on:** H-TUI-2, H-SUP-1
**Domain:** supervisor

## Context

With the status pane removed (H-TUI-2) and the supervisor agent prompt created (H-SUP-1), we can now launch the supervisor as a full Claude Code session and connect it to the orchestrate loop via event messages. This replaces the inline `supervisorTick()` calls.

## Requirements

### Supervisor session launch

1. Add `launchSupervisorSession()` function to `core/commands/start.ts`, modeled on `launchAiSession()`.
2. Key differences from `launchAiSession()`:
   - No worktree — runs in `projectRoot` (supervisor reads but doesn't edit code)
   - Uses `--agent supervisor` (reads from `.claude/agents/supervisor.md`)
   - No partition allocation
   - No sandbox wrapping
   - No `--append-system-prompt` — dynamic context is sent as the initial message
3. Seed `agents/supervisor.md` to `{projectRoot}/.claude/agents/supervisor.md` before launch (if not already present).
4. Send initial message containing: current item states, workspace refs, merge strategy, WIP limit, friction dir path.
5. Use `sendWithReadyWait()` for prompt delivery, same pattern as workers.

### Orchestrate integration

6. In `cmdOrchestrate()`: when `supervisorActive && !isDaemonChild`, call `launchSupervisorSession()`.
7. Track `supervisorSessionRef` alongside items. Add to `DaemonState` interface for crash recovery persistence.
8. Graceful degradation: if supervisor launch fails, log a warning and continue without supervision.
9. Close supervisor session in the `finally` cleanup block.

### Event messages (replacing supervisorTick)

10. Remove `supervisorTick()` calls from the event loop (lines ~1456-1509).
11. Remove `supervisorState` initialization and log-wrapping (lines ~1174-1194).
12. Remove `supervisorDeps` from `OrchestrateLoopDeps` and `supervisor` from `OrchestrateLoopConfig`.
13. Add `supervisorSessionRef?: string` to `OrchestrateLoopConfig`.
14. Send fire-and-forget messages to supervisor at key transition points:
    - Item launched: include workspace ref so supervisor can monitor it
    - CI failed: include failure details and attempt count
    - Item merged: include PR number
    - Item stuck: include reason
    - Worker health change: include screen health status
15. Send periodic heartbeat (every 5 min): full state summary with all items, states, elapsed times, workspace refs.
16. Messages are fire-and-forget — log a warning if `sendMessage` fails, don't block.

### Crash recovery

17. On daemon restart, check for existing supervisor session via `mux.listWorkspaces()` scan. If alive, reuse the ref; if dead, relaunch.

Acceptance: `ninthwave orchestrate --items X --supervisor` launches a Claude Code session in a separate cmux workspace. The supervisor receives event messages on state transitions and periodic heartbeats. No inline `claude --print` calls are made. The supervisor session is closed on daemon exit. Crash recovery discovers and reuses existing supervisor sessions.

**Test plan:**
- Unit test: `launchSupervisorSession()` builds correct claude command with `--agent supervisor`
- Unit test: initial message includes all required context (items, refs, strategy)
- Unit test: event messages sent on state transitions (mock sendMessage)
- Unit test: heartbeat sent after configured interval
- Unit test: failed supervisor launch logs warning and continues
- Unit test: supervisor session closed on daemon exit
- Edge case: supervisor sendMessage failure doesn't block orchestrate loop

Key files: `core/commands/start.ts`, `core/commands/orchestrate.ts`, `core/daemon.ts`
