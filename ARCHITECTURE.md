# ninthwave Architecture

A reference for contributors who want to understand how the pieces fit together before diving into code.

See also: [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and coding conventions.

---

## Table of Contents

1. [Orchestrator State Machine](#orchestrator-state-machine)
2. [Data Flow](#data-flow)
3. [Key Abstractions](#key-abstractions)
4. [Extension Points](#extension-points)
5. [Worker Lifecycle](#worker-lifecycle)

---

## Orchestrator State Machine

Each TODO item moves through a state machine defined in [`core/orchestrator.ts`](core/orchestrator.ts). The `processTransitions` function is pure — it takes a poll snapshot and returns actions to execute; no side effects.

### States

| State | Description |
|-------|-------------|
| `queued` | Added to orchestration; waiting for dependencies to complete |
| `ready` | Dependencies done; waiting for a WIP slot |
| `bootstrapping` | Cross-repo target being cloned/initialised |
| `launching` | Worktree created, AI session being started |
| `implementing` | Worker is active and coding |
| `pr-open` | PR created; waiting for CI to start |
| `ci-pending` | CI checks running |
| `ci-passed` | CI green; ready to merge (or review) |
| `ci-failed` | CI red; worker being notified |
| `review-pending` | Awaiting review worker launch |
| `reviewing` | Review worker active |
| `merging` | Merge in progress |
| `merged` | PR merged |
| `done` | Cleanup complete |
| `stuck` | Max retries exhausted or unrecoverable failure |

### Transition Diagram

```mermaid
stateDiagram-v2
    [*] --> queued : addItem()
    queued --> ready : deps done
    ready --> bootstrapping : cross-repo item
    ready --> launching : hub-local item
    bootstrapping --> launching : repo ready
    bootstrapping --> stuck : clone failed
    launching --> implementing : worker started
    implementing --> pr_open : PR detected
    pr_open --> ci_pending : CI started
    ci_pending --> ci_passed : all checks green
    ci_pending --> ci_failed : check failure
    ci_passed --> review_pending : reviewEnabled=true
    ci_passed --> merging : reviewEnabled=false
    review_pending --> reviewing : review worker launched
    reviewing --> ci_passed : approved
    reviewing --> ci_failed : CI regression
    ci_failed --> ci_pending : worker notified, retrying
    ci_failed --> stuck : maxCiRetries exceeded
    merging --> merged : gh merge succeeded
    merged --> done : cleanup complete
    implementing --> stuck : launch/activity timeout
    stuck --> ready : retry command
```

### WIP Limit

States that count toward the WIP limit (see `OrchestratorConfig.wipLimit`): `launching`, `implementing`, `pr-open`, `ci-pending`, `ci-passed`, `ci-failed`, `review-pending`. Review workers have a separate limit (`reviewWipLimit`).

### Stacked Launches

When `enableStacking=true`, an item whose only in-flight dependency is in a "stackable" state (`implementing`, `pr-open`, `ci-pending`, `ci-passed`, `ci-failed`) can launch early against the dep's branch rather than waiting for the dep to fully merge. See `STACKABLE_STATES` in `core/orchestrator.ts`.

---

## Data Flow

```
User runs /decompose
  └─→ skill explores codebase, writes .ninthwave/todos/*.md (one file per TODO)

User runs /work
  └─→ skill reads .ninthwave/todos/, presents item selection
      └─→ calls nw <IDs>
            ├─ git worktree create .worktrees/todo-<ID>
            ├─ allocate partition (port/DB isolation) via core/partitions.ts
            ├─ seed agent files into worktree (core/commands/launch.ts seedAgentFiles)
            └─ launch AI session in multiplexer workspace, send worker prompt

Worker session (per TODO)
  ├─ reads project CLAUDE.md / AGENTS.md for conventions
  ├─ implements the TODO, runs tests
  ├─ git push → gh pr create
  └─ idles, waiting for orchestrator messages

nw watch (event loop, ~10s poll)
  ├─ poll GitHub for PR/CI/review status (core/commands/watch.ts checkPrStatus)
  ├─ poll multiplexer for worker liveness (core/mux.ts readScreen)
  ├─ run processTransitions (pure state machine → list of Actions)
  ├─ executeAction for each action:
  │   ├─ launch   → launch.ts launchSingleItem
  │   ├─ merge    → gh.ts prMerge
  │   ├─ notify-ci-failure  → mux.sendMessage to worker
  │   ├─ notify-review      → mux.sendMessage to worker
  │   ├─ rebase   → git.ts daemonRebase
  │   ├─ clean    → clean.ts cleanSingleWorktree
  │   └─ launch-review → launch.ts launchReviewWorker

Post-merge
  ├─ worktree and workspace cleaned up
  ├─ TODO file removed from .ninthwave/todos/
  ├─ stacked dependents retargeted to main
  └─ version bump deferred until all items done
```

Key files: [`core/parser.ts`](core/parser.ts) (read todos), [`core/commands/launch.ts`](core/commands/launch.ts) (launch), [`core/commands/orchestrate.ts`](core/commands/orchestrate.ts) (event loop), [`core/commands/clean.ts`](core/commands/clean.ts) (cleanup).

---

## Key Abstractions

### `Multiplexer` — `core/mux.ts`

Abstracts terminal multiplexer operations behind a clean interface.

```typescript
interface Multiplexer {
  readonly type: MuxType;                                           // "cmux"
  isAvailable(): boolean;
  launchWorkspace(cwd: string, command: string, todoId?: string): string | null;
  sendMessage(ref: string, message: string): boolean;
  readScreen(ref: string, lines?: number): string;
  listWorkspaces(): string;
  closeWorkspace(ref: string): boolean;
}
```

Concrete implementation: `CmuxAdapter`. Auto-detection via `getMux()` checks `CMUX_WORKSPACE_ID` env var first, then falls back to binary availability.

---

## Extension Points

### Adding a New Multiplexer Adapter

1. Add your type to `MuxType` in `core/mux.ts`:
   ```typescript
   export type MuxType = "cmux" | "mymux";
   ```
2. Implement the `Multiplexer` interface as a new class in `core/mux.ts` (follow `CmuxAdapter` as a template).
3. Add detection logic in `detectMuxType()` — check an env var or binary.
4. Add a case in `getMux()` to return the new adapter.
5. Add tests in `test/mux.test.ts`.

### Adding a New CLI Command

1. Create `core/commands/mycommand.ts` and export a `cmdMyCommand(args: string[])` function.
2. Import and route it in `core/cli.ts`:
   ```typescript
   import { cmdMyCommand } from "./commands/mycommand.ts";
   // ...inside the arg-switch:
   case "mycommand":
     cmdMyCommand(args);
     break;
   ```
3. Add a help entry to the `COMMANDS` array in `core/cli.ts`:
   ```typescript
   ["mycommand [--flag]", "One-line description"],
   ```
4. Add tests in `test/mycommand.test.ts`.

---

---

## Worker Lifecycle

Each TODO item gets an isolated AI coding session managed as follows:

### Launch

`launchSingleItem()` in [`core/commands/launch.ts`](core/commands/launch.ts):

1. `git worktree add .worktrees/todo-<ID> -b todo/<ID>` — isolated checkout.
2. `allocatePartition(id)` — assigns a unique port range and DB prefix for test isolation.
3. `seedAgentFiles(worktreePath, hubRoot)` — copies `todo-worker.md` to `.claude/agents/`, `.opencode/agents/`, `.github/agents/` inside the worktree.
4. `mux.launchWorkspace(worktreePath, command, todoId)` — spawns the session; returns a workspace ref (e.g., `"workspace:1"` for cmux, `"nw-H-1-1-3"` for tmux).
5. `sendWithReadyWait(mux, ref, prompt, ...)` — waits for the AI prompt, sends the todo-worker instructions, verifies the worker starts processing.

The workspace ref is stored in `OrchestratorItem.workspaceRef` for later messaging and cleanup.

### Heartbeat and Health

The orchestrator tracks two signals per worker:

- **Commit freshness** (`lastCommitTime`): timestamp of the most recent commit on `todo/<ID>`. A worker with recent commits is considered active regardless of screen state.
- **Screen health** (`ScreenHealthStatus`): classified by `computeScreenHealth()` in [`core/worker-health.ts`](core/worker-health.ts). Categories: `healthy`, `stalled-empty`, `stalled-permission`, `stalled-error`, `stalled-unchanged`.

Timeout thresholds (configurable via `OrchestratorConfig`): 30 minutes for a worker with no commits since launch (`launchTimeoutMs`), 60 minutes for a worker with stale commits (`activityTimeoutMs`).

### Cleanup

`cleanSingleWorktree(id, ...)` in [`core/commands/clean.ts`](core/commands/clean.ts):

1. `mux.closeWorkspace(workspaceRef)` — closes the terminal session.
2. `git worktree remove .worktrees/todo-<ID>` — removes the checkout.
3. `releasePartition(id)` — frees the port/DB allocation.
