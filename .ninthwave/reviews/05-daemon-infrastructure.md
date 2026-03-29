# Review 5: Daemon Event Loop, Scheduling & Infrastructure

## Summary

The daemon infrastructure spans the event loop (`core/commands/orchestrate.ts`, 3,890 LOC), state persistence (`core/daemon.ts`, 712 LOC), crew coordination (`core/crew.ts`, 600 LOC + `core/mock-broker.ts`, 626 LOC = 1,226 LOC), scheduling (`core/schedule-eval.ts` 262 LOC + `core/schedule-files.ts` 214 LOC + `core/schedule-runner.ts` 317 LOC + `core/schedule-state.ts` 108 LOC + `core/schedule-history.ts` 130 LOC = 1,031 LOC), analytics (`core/analytics.ts`, 449 LOC), shell execution (`core/shell.ts`, 101 LOC), and pre-flight checks (`core/preflight.ts`, 230 LOC). Total across all files: **~8,239 LOC**.

The core loop in `orchestrate.ts` is structurally sound: poll → transition → execute → sleep, with abort signal support, adaptive poll intervals, and graceful shutdown. The Orchestrator class (Review 2) is the pure state machine; `orchestrate.ts` wires it to the real world. However, at 3,890 LOC it has become a monolith accumulating TUI rendering (~400 LOC), keyboard handling (~200 LOC), crew mode integration (~120 LOC), schedule processing (~220 LOC), arg parsing (~250 LOC), state reconstruction (~200 LOC), external review processing (~100 LOC), and completion prompt logic (~80 LOC) on top of the core loop (~600 LOC) and snapshot building (~400 LOC).

The most critical findings are: (1) `writeStateFile` is not atomic (direct write, not write-then-rename), creating corruption risk on crash mid-write, (2) the event loop can block on a slow `buildSnapshot` since all GitHub API calls for all items happen in a single poll cycle, (3) crew mode adds 1,226 LOC of WebSocket coordination infrastructure that has zero production users, (4) scheduling adds 1,031 LOC of cron infrastructure that has zero production users, and (5) the TUI complexity has grown beyond "minimum viable" with keyboard shortcuts, panel modes, log viewers, detail panels, help overlays, and scroll management.

Cross-reference: Review 1 identified state serialization concerns (Findings 1, 9). This review confirms `writeStateFile` uses direct `writeFileSync` without rename-atomicity, making the state file the primary corruption risk on daemon crash. Review 2 identified `orchestrate.ts` as a decomposition candidate (Theme B). This review provides specific LOC counts for each extractable subsystem. Review 3 identified workspace listing cache as an optimization (Finding 11); the same redundancy exists in the schedule runner's `isScheduleWorkerAlive` which calls `listWorkspaces()` independently per schedule worker. Review 4 identified GitHub API error swallowing (Finding 1); this directly causes event loop starvation when API outages make `buildSnapshot` return empty/stale data.

## Findings

### 1. writeStateFile is not atomic -- SEVERITY: high
**Tag:** SIMPLIFY

`writeStateFile()` (`daemon.ts:245-256`) calls `io.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8")` directly. This writes to the target file in-place. If the daemon process is killed (SIGKILL, OOM) during the write, the file may contain partial JSON. On restart, `readStateFile()` (`daemon.ts:258-270`) will `JSON.parse(content)` the truncated file, catch the error, and return `null`. The daemon then starts with zero state, losing all tracked items.

The `archiveStateFile()` function (`daemon.ts:299-336`) is called before a new daemon starts, but it reads the state file before archiving. If the state file is corrupted, the archive will contain corrupted data.

The `writeHeartbeat()` function (`daemon.ts:428-454`) has the same pattern -- direct `writeFileSync`. Heartbeat corruption is less critical (worst case: a stale heartbeat, the daemon retries next cycle).

**Recommendation:** Use write-then-rename for state file:
```typescript
const tmpPath = filePath + ".tmp";
io.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
io.renameSync(tmpPath, filePath);
```
`renameSync` is atomic on POSIX filesystems -- the file either has the old content or the new content, never partial. Estimated effort: ~5 LOC.

### 2. buildSnapshot blocks the event loop -- SEVERITY: medium
**Tag:** SIMPLIFY

The `buildSnapshotAsync` function (called from `orchestrateLoop` at line 2187) makes N GitHub API calls per poll cycle -- one `checkPrStatusAsync` per tracked item. Each call involves `prListAsync`, `prViewAsync`, and `prChecksAsync`. With 5 concurrent items, that's 15+ sequential `gh` CLI invocations per cycle.

The async variants (`gh.ts` lines 102-188) use `Bun.spawn` which yields to the event loop between calls, keeping the TUI responsive. However, the total latency of a poll cycle is O(N) in the number of items, with each `gh` call taking 1-3 seconds. At 5 items, a single poll cycle takes 5-15 seconds, during which no new actions can be executed.

The timeout protection in `shell.ts` (`GH_TIMEOUT = 60_000`) prevents individual calls from hanging indefinitely. But there is no aggregate timeout for the entire `buildSnapshot` call. If GitHub is slow (not failing, just slow -- 10s per call), a 5-item snapshot takes 50+ seconds. During that time, the `activityTimeoutMs` clock for all workers is ticking, but the daemon can't act on timeouts because it's still building the snapshot.

**Recommendation:** Two improvements:
1. Batch API calls where possible. GitHub's GraphQL API can fetch PR status for multiple PRs in a single request. Replace 15 REST calls with 1 GraphQL call. Estimated savings: 10-14 seconds per cycle at 5 items.
2. Add an aggregate snapshot timeout (e.g., 30 seconds). If `buildSnapshot` exceeds it, return a partial snapshot for items that completed, and use stale data for the rest. Estimated effort: ~30 LOC.

### 3. State file write frequency: every poll cycle -- SEVERITY: low
**Tag:** KEEP

`writeStateFile` is called via `onPollComplete` every poll cycle (line 3584-3591). With the default adaptive poll interval of 2-10 seconds, this means 6-30 writes per minute. Each write serializes all items to JSON and writes to disk.

At typical state sizes (5-20 items, ~5-20KB JSON), this is not a performance concern. The write is synchronous (`writeFileSync`) which briefly blocks the event loop, but at 5-20KB the I/O is sub-millisecond.

However, combined with Finding 1 (non-atomic writes), the high write frequency increases the probability of corruption during a crash -- more writes means more windows where a kill signal could hit mid-write.

**Recommendation:** Keep the write frequency as-is (it's needed for `ninthwave status` to show live data). Fix the atomicity issue (Finding 1) which makes the frequency safe.

### 4. Crash recovery gap: launching state with no workspace ref -- SEVERITY: medium
**Tag:** SIMPLIFY

Cross-reference: Review 1 Finding 1 identified that `workspaceRef` is not serialized in `DaemonStateItem`. This means a daemon crash during the `launching` state loses the workspace reference. On restart, the item is in `launching` state but the daemon can't check liveness (no workspace ref). The `reconstructState` function (in `orchestrate.ts`) attempts to recover workspace refs from live workspaces, but this only works if the workspace is still alive.

The `partition` field is also not serialized (Review 1). A crashed daemon can't release the partition for an item in `launching`/`implementing` state. The partition is recovered by `cleanupStalePartitions` on the next launch, but between crash and cleanup, the partition is consumed.

`resolvedRepoRoot` is not serialized (Review 4). Cross-repo items lose their target repo context after restart. The daemon falls back to hub-repo-only queries, which may miss the item's PR.

**Recommendation:** Add `workspaceRef`, `partition`, and `resolvedRepoRoot` to `DaemonStateItem` and `serializeOrchestratorState`. These three fields are the critical gap in crash recovery. Estimated effort: ~20 LOC (3 fields × serialize + deserialize).

### 5. Event loop starvation via slow action execution -- SEVERITY: medium
**Tag:** KEEP

`handleActionExecution` (line 2254-2256) executes actions synchronously in a for loop:
```typescript
for (const action of actions) {
  handleActionExecution(action, orch, ctx, deps, log, costData);
}
```

A single `executeMerge` action involves: `prMerge` (1-5s), `getMergeCommitSha` (1-2s), `prComment` (1-2s), `fetchOrigin` (1-3s), `ffMerge` (1s), and potentially N `daemonRebase` calls for stacked siblings (each 2-5s). Total: 7-20 seconds for a single merge action.

If multiple items reach `ci-passed` in the same cycle, the action execution for merges is serialized by the priority merge queue (Review 2 Finding 5), so at most one merge executes per cycle. But other action types (launch, send-message, clean) can accumulate.

The TUI stays frozen during action execution because the render happens in `onPollComplete`, which fires after actions complete. The keyboard handler runs on stdin events which are independent, so `q` and `Ctrl-C` still work.

**Recommendation:** Keep. The serialized merge queue prevents the worst case (multiple concurrent merges). Individual action latency is bounded by `GH_TIMEOUT` (60s). The TUI freeze during action execution is acceptable since it's brief (typically <10s per cycle).

### 6. Adaptive poll interval may oscillate -- SEVERITY: low
**Tag:** KEEP

The `adaptivePollInterval` function adjusts the poll interval based on item states:
- Active items (implementing, ci-pending, etc.): shorter interval (~2-5s)
- All items queued/ready: longer interval (~10-30s)

This is a good design that reduces API calls when idle. The oscillation concern: if one item keeps cycling between active and terminal states (e.g., CI fails, retries, fails again), the interval will oscillate between short and long values. This causes alternating fast and slow poll cycles.

In practice, the retry mechanism has a `maxRetries` circuit breaker, so oscillation is bounded. The interval range (2-30s) is narrow enough that oscillation doesn't create user-visible issues.

**Recommendation:** Keep. The adaptive interval is well-designed and the oscillation is bounded.

### 7. TUI panel rendering: full redraw every cycle -- SEVERITY: low
**Tag:** KEEP

The TUI renders the entire screen on every poll cycle via `renderTuiPanelFrame` (line 3609). This includes: status table, log panel or detail panel, footer with keyboard shortcuts, and optional help overlay. The render uses ANSI escape codes to position the cursor and overwrite content.

With the adaptive poll interval (2-10s), this means 6-30 full redraws per minute. Each redraw writes ~2-5KB to stdout (depending on terminal size and item count). At 30 redraws/minute, that's ~150KB/minute of terminal output.

On slower terminals (SSH over high-latency connections), frequent redraws can cause visual flickering. The alternate screen buffer (`ALT_SCREEN_ON` at line 3757) prevents scrollback pollution, but doesn't eliminate flicker.

**Recommendation:** Keep. The current approach is simple and effective. Differential rendering (only rewrite changed lines) would reduce flicker but add significant complexity (~200 LOC) for marginal benefit. The alternate screen buffer is the right approach.

### 8. orchestrate.ts at 3,890 LOC: decomposition candidates -- SEVERITY: medium
**Tag:** SIMPLIFY

The file has these distinct sections (approximate LOC):

| Section | LOC | Lines | Extractable? |
|---------|-----|-------|--------------|
| Imports + types | ~120 | 1-127 | No (stay with their consumers) |
| Log buffer + TUI helpers | ~100 | 128-290 | Yes → `core/tui-log.ts` |
| `orchestratorItemsToStatusItems` | ~50 | 196-290 | Yes → `core/tui-helpers.ts` |
| `buildSnapshot` / `buildSnapshotAsync` | ~400 | 291-880 | Yes → `core/snapshot.ts` |
| `reconstructState` | ~200 | 880-1100 | Yes → `core/reconstruct.ts` |
| State reconstruction helpers | ~100 | 1100-1200 | With reconstruct |
| `handleActionExecution` + helpers | ~250 | 1200-1450 | Yes → stays (thin dispatcher) |
| `handleRunComplete` | ~60 | 1450-1510 | Yes → with analytics |
| External review processing | ~100 | 1510-1650 | Yes → `core/external-review.ts` |
| `syncWorkerDisplay` | ~50 | 1650-1700 | Yes → with TUI helpers |
| `interruptibleSleep` | ~20 | 1700-1720 | Inline |
| `adaptivePollInterval` | ~30 | 1720-1750 | Yes → with snapshot |
| Loop deps interfaces | ~120 | 1750-1870 | Yes → types file |
| `orchestrateLoop` | ~420 | 1905-2320 | No (core, must stay) |
| `processScheduledTasks` | ~220 | 2322-2548 | Yes → `core/schedule-loop.ts` |
| TUI keyboard shortcuts | ~200 | 2550-2803 | Yes → `core/tui-keyboard.ts` |
| `computeDefaultWipLimit` | ~10 | 2805-2818 | Inline |
| `forkDaemon` | ~30 | 2834-2864 | Yes → with daemon.ts |
| Arg parsing | ~250 | 2866-3130 | Yes → `core/commands/watch-args.ts` |
| `cmdOrchestrate` | ~760 | 3130-3890 | No (entry point, must stay) |
| **Total** | **~3,890** | | |

**If crew mode, scheduling, and TUI extras were extracted:**
- Schedule processing: ~220 LOC → `core/schedule-loop.ts`
- TUI keyboard + log buffer: ~300 LOC → `core/tui-keyboard.ts` + `core/tui-log.ts`
- Snapshot building: ~400 LOC → `core/snapshot.ts`
- State reconstruction: ~300 LOC → `core/reconstruct.ts`
- Arg parsing: ~250 LOC → `core/commands/watch-args.ts`
- External reviews: ~100 LOC → `core/external-review.ts`

**Estimated `orchestrate.ts` post-extraction: ~1,600 LOC** (core loop, `cmdOrchestrate` entry point, action dispatcher, and dependency wiring). This is a reasonable size for the central coordination file.

**Recommendation:** Extract at minimum: snapshot building, state reconstruction, arg parsing, and TUI keyboard handling. These have clear boundaries and no circular dependencies with the loop. Estimated effort: ~100 LOC of import/export overhead, but significant cognitive reduction.

## Theme A: Feature Necessity -- Critical Feature-Stripping Recommendations

### Crew Mode: STRIP (1,226 LOC + ~120 LOC in orchestrate.ts = ~1,346 LOC)

**Files:** `core/crew.ts` (600 LOC), `core/mock-broker.ts` (626 LOC)
**In orchestrate.ts:** ~120 LOC across crew setup (~55 LOC at lines 3420-3475), crew sync/claim/complete (~45 LOC scattered in loop), crew status display (~20 LOC in onPollComplete)

**Evidence of non-use:**
1. The `--crew` and `--crew-create` flags are not referenced in any documentation, tutorial, or README.
2. The mock broker (`mock-broker.ts`) is only used in tests and when `--crew-create` is passed. There is no production crew server deployed.
3. The `crewUrl` default falls back to `wss://ninthwave.sh` (line 3460) -- a cloud service that does not exist yet.
4. The feature was designed for multi-machine coordination ("two MacBooks processing the same queue"), but the product is used exclusively as a single-machine CLI tool.
5. The WebSocket protocol includes schedule claim coordination (`ScheduleClaimMessage`, lines 76-89), meaning crew mode depends on scheduling -- two speculative features coupled together.

**What crew mode adds to the loop complexity:**
- Before snapshot: crew sync (lines 2141-2156) -- 15 LOC
- After transitions: crew claim filtering (lines 2194-2238) -- 45 LOC
- After actions: crew complete notification (lines 2258-2270) -- 13 LOC
- In onPollComplete: crew status update (lines 3572-3583) -- 12 LOC
- Arg parsing: 5 crew flags (lines 3020-3037) -- 18 LOC
- Setup: broker creation + connection (lines 3420-3475) -- 55 LOC
- Cleanup: broker disconnect (lines 3865-3868) -- 4 LOC
- **Total in orchestrate.ts: ~162 LOC**

**If stripped:**
- Remove `core/crew.ts` (600 LOC) and `core/mock-broker.ts` (626 LOC): **1,226 LOC**
- Remove crew integration from `orchestrate.ts`: **~162 LOC**
- Remove crew tests: estimated **~300 LOC** across test files
- Remove `crew_update` handling from `status-render.ts`: estimated **~30 LOC**
- **Total savings: ~1,718 LOC**
- The core loop simplifies: no async claim gating, no broker lifecycle, no sync messages. The `processTransitions` → `executeAction` path becomes a straight pipeline.

**Recommendation: STRIP.** Crew mode is speculative infrastructure for a multi-machine future that has not arrived. It adds 1,346 LOC of production code and ~300 LOC of test code for zero users. If multi-machine coordination is needed later, it can be re-implemented with a simpler approach (e.g., file-based claiming via a shared filesystem or GitHub-based coordination).

### Scheduling: STRIP (1,031 LOC + ~220 LOC in orchestrate.ts = ~1,251 LOC)

**Files:** `core/schedule-eval.ts` (262 LOC), `core/schedule-files.ts` (214 LOC), `core/schedule-runner.ts` (317 LOC), `core/schedule-state.ts` (108 LOC), `core/schedule-history.ts` (130 LOC)
**In orchestrate.ts:** ~220 LOC for `processScheduledTasks` function (lines 2335-2548) + ~18 LOC for schedule deps setup (lines 3655-3672) + imports (~20 LOC)

**Evidence of non-use:**
1. No `.ninthwave/schedules/` directory exists in this project or any known user project.
2. The `schedule_enabled` config key defaults to off (no config → no schedules).
3. The CLI commands `nw schedule list`, `nw schedule run` exist but are not referenced in any user-facing documentation or tutorial.
4. The schedule runner depends on crew mode for multi-daemon deduplication (`tryScheduleClaim` in `schedule-runner.ts:283-309`), coupling two speculative features.
5. The scheduling use case (recurring AI tasks like "run tests every 2 hours") overlaps with standard CI/CD tools (GitHub Actions cron triggers, etc.) that users already have.

**What scheduling adds to the loop:**
- 30-second interval check in orchestrate loop (lines 2158-2184): ~25 LOC
- `processScheduledTasks` function (lines 2335-2548): ~220 LOC
- `ScheduleLoopDeps` interface and wiring (lines 1850-1868, 3655-3672): ~35 LOC
- Schedule worker display in TUI (lines 3597-3607): ~10 LOC
- **Total in orchestrate.ts: ~290 LOC**

**If stripped:**
- Remove 5 schedule files: **1,031 LOC**
- Remove schedule integration from orchestrate.ts: **~290 LOC**
- Remove schedule tests: estimated **~400 LOC** across test files
- Remove `ScheduledTask` type from `core/types.ts`: **~15 LOC**
- Remove `schedule_enabled` from config handling: **~5 LOC**
- Remove schedule CLI commands: estimated **~100 LOC**
- **Total savings: ~1,841 LOC**

**Recommendation: STRIP.** The scheduling system is a well-engineered but unused feature. It adds 1,251 LOC of production code for zero users. The cron evaluation, file parsing, state management, history tracking, and worker monitoring are all complete and tested -- but nobody uses them. The use case (recurring AI tasks) is better served by existing CI/CD tooling or, if needed, a simpler `cron + nw start` approach.

### Analytics: SIMPLIFY (449 LOC → ~250 LOC)

**File:** `core/analytics.ts` (449 LOC)

**Evidence of use:**
1. `collectRunMetrics` is called from `handleRunComplete` in `orchestrate.ts` (line 1473 area) on every daemon run completion.
2. Analytics files are written to `.ninthwave/analytics/` and auto-committed.
3. `nw analytics` CLI command reads and displays the data.
4. The heartbeat cost fields (`--tokens-in`, `--tokens-out`, `--model`) are used by implementer agents.
5. Detection latency stats (`DetectionLatencyStats`) power the `nw analytics` performance view.

**What should be simplified:**
1. **`parseCostSummary`** (lines 143-170, ~28 LOC): Parses Claude Code's exit summary text for token/cost data. This text-parsing approach is fragile (pattern-matches "Total tokens: 42,567"). The heartbeat-based cost tracking (`HeartbeatCostFields` in `daemon.ts`) is more reliable since agents explicitly report their own tokens. If heartbeat cost data is preferred, `parseCostSummary` becomes a fallback.
2. **`parseWorkerTelemetry`** (lines 192-215, ~24 LOC): Extracts exit code and stderr tail from screen output. This is used by the `handleRunComplete` function to capture worker exit data. The screen-parsing approach is the same fragile heuristic from Review 3. However, it provides the only post-mortem data for crashed workers.
3. **`commitAnalyticsFiles` and `commitFrictionFiles`** (lines 385-448, ~64 LOC): Two nearly-identical functions that auto-commit analytics/friction files. These could be unified into a single `commitPathFiles(projectRoot, relPath, commitMessage)` function. Saves ~30 LOC.

**Recommendation: SIMPLIFY.** Keep `collectRunMetrics`, `writeRunMetrics`, `DetectionLatencyStats`, and `percentile` (core analytics). Keep `parseCostSummary` and `parseWorkerTelemetry` as fallbacks. Merge `commitAnalyticsFiles` and `commitFrictionFiles` into a single function. Estimated savings: **~30 LOC** from deduplication, plus cleaner API.

Cross-reference: Review 1 Finding 5 (`MODEL_PRICING` / `estimateCost`) identified dead code in `types.ts`. Those functions are not in `analytics.ts` but are analytics-adjacent. They should be stripped as part of this simplification.

### TUI Complexity: SIMPLIFY (remove detail panel, keep core)

**TUI code locations:**
- `core/status-render.ts`: ~600 LOC (status table, panel layout, help overlay, item detail)
- `orchestrate.ts` TUI helpers: ~100 LOC (orchestratorItemsToStatusItems, renderTuiPanelFrame)
- `orchestrate.ts` keyboard handling: ~200 LOC (setupKeyboardShortcuts)
- `orchestrate.ts` log buffer: ~80 LOC (pushLogBuffer, filterLogsByLevel, extractLogLevel)
- `orchestrate.ts` TUI state: ~70 LOC (TuiState interface + initialization)
- `orchestrate.ts` completion prompt: ~50 LOC
- **Total TUI code: ~1,100 LOC**

**What users actually use:**
1. **Status table** (items, states, progress bars) -- essential. Users launch `nw watch` and check back periodically.
2. **Log panel** (structured log stream) -- useful for debugging. Users scroll through logs when something goes wrong.
3. **`q` to quit** -- essential.
4. **Panel mode cycling** (`Tab`) -- occasionally used to maximize either the status table or log panel.

**What is likely unused:**
1. **Item detail panel** (`Enter`/`i` to open, `Escape` to close) -- shows per-item metrics, dependencies, and PR links. This information is available via `nw status` and GitHub. The detail panel adds ~80 LOC of keyboard handling + ~100 LOC of rendering.
2. **Log level filtering** (`l` to cycle info → warn → error → all) -- niche feature. Users who need filtered logs typically use `grep` on the log file.
3. **Help overlay** (`?` to toggle) -- shows keyboard shortcuts. 15 LOC of keyboard handling + ~40 LOC in `status-render.ts`.
4. **Merge strategy cycling** (`Shift+Tab`) -- dangerous in a TUI (accidental keypress changes merge behavior). Better served by a CLI flag.
5. **Scroll management** (Up/Down arrows, `j`/`k`, `G`) -- the status table auto-scrolls. Manual scrolling is needed only with 20+ items, which is rare.

**Minimum viable TUI:**
- Status table with auto-refresh (items, states, progress)
- Log panel (append-only, auto-scroll to bottom)
- `q` to quit, `Ctrl-C` double-tap to force quit
- `Tab` to cycle panel mode (status-only, logs-only, split)

**LOC estimate for simplified TUI:**
- Remove detail panel: **-180 LOC** (keyboard handling + rendering)
- Remove log level filtering: **-30 LOC**
- Remove help overlay: **-55 LOC**
- Remove merge strategy cycling: **-20 LOC**
- **Total savings: ~285 LOC**

**Recommendation: SIMPLIFY.** Keep the core TUI (status table, log panel, quit, panel cycling). Remove the detail panel, log filtering, help overlay, and merge strategy cycling. These features add keyboard complexity without proportionate value. Users who need detailed item info or filtered logs can use `nw status --watch` or `grep` on the log file.

## Theme B: Complexity Reduction

### Total potential LOC reduction

| Feature | Production LOC | Test LOC (est.) | Total |
|---------|---------------|-----------------|-------|
| Strip crew mode | 1,346 | ~300 | **~1,646** |
| Strip scheduling | 1,251 | ~400 | **~1,651** |
| Simplify analytics | 30 | 0 | **~30** |
| Simplify TUI | 285 | ~50 | **~335** |
| **Total potential reduction** | **2,912** | **~750** | **~3,662** |

### What remains after stripping

| Component | Current LOC | Post-strip LOC | Notes |
|-----------|------------|----------------|-------|
| `orchestrate.ts` | 3,890 | ~3,400 | Minus crew (~162), schedule (~290), TUI (~285) |
| `daemon.ts` | 712 | 712 | No changes (all used) |
| `crew.ts` | 600 | **0** | Stripped |
| `mock-broker.ts` | 626 | **0** | Stripped |
| `schedule-*.ts` (5 files) | 1,031 | **0** | Stripped |
| `analytics.ts` | 449 | ~419 | Deduplicate commit functions |
| `shell.ts` | 101 | 101 | No changes |
| `preflight.ts` | 230 | 230 | No changes |
| **Total** | **~8,239** | **~4,862** | **-3,377 LOC (-41%)** |

### If orchestrate.ts is also decomposed

After stripping crew/schedule and simplifying TUI, `orchestrate.ts` would be ~3,400 LOC. Further decomposition (Finding 8):

| Extraction | LOC moved |
|-----------|-----------|
| Snapshot building → `core/snapshot.ts` | ~400 |
| State reconstruction → `core/reconstruct.ts` | ~300 |
| Arg parsing → `core/commands/watch-args.ts` | ~250 |
| TUI keyboard → `core/tui-keyboard.ts` | ~150 (post-simplification) |
| External reviews → `core/external-review.ts` | ~100 |
| **orchestrate.ts after decomposition** | **~2,200 LOC** |

This is still large but focused on the core loop, action dispatcher, and dependency wiring -- all tightly coupled concerns that belong together.

### Can daemon.ts and orchestrate.ts be unified?

No. `daemon.ts` (712 LOC) is a state serialization and persistence layer with injectable I/O for testability. `orchestrate.ts` is the event loop and coordination layer. They have different responsibilities and different testing strategies (daemon.ts tests mock filesystem I/O; orchestrate.ts tests mock external commands and API calls). Merging them would create a larger file with mixed concerns.

However, `forkDaemon` (orchestrate.ts lines 2834-2864, ~30 LOC) logically belongs in `daemon.ts` alongside the PID file management. Moving it would reduce orchestrate.ts by ~30 LOC and improve cohesion.

### Is the buildSnapshot polling approach the simplest?

The polling approach (check all items every N seconds) is the simplest design for GitHub integration. Alternatives:

1. **Webhooks**: Require a publicly accessible HTTP endpoint, which a CLI tool running on a developer laptop cannot provide without a tunnel. Adds infrastructure complexity.
2. **GitHub Actions callback**: Requires a custom GitHub Action that notifies the daemon on CI completion. Adds repository configuration complexity.
3. **Long polling**: GitHub's API doesn't support long polling or Server-Sent Events for check status.

**Verdict:** Polling is the right approach for a CLI tool. The improvements should focus on reducing the cost of each poll (batching, GraphQL), not changing the architecture.

### Are there redundant code paths in action execution?

Review 2 Theme B identified that `cleanRepair`, `cleanReview`, and `cleanVerifier` are nearly identical. Each follows:
```typescript
try { mux.closeWorkspace(ref); } catch { /* best-effort */ }
try { cleanSingleWorktree(`prefix-${itemId}`, worktreeDir, projectRoot); } catch { /* best-effort */ }
return true;
```

A generic `cleanWorkerWorkspace(prefix, itemId, workspaceRef, mux, worktreeDir, projectRoot)` would deduplicate ~30 LOC across the three functions.

Similarly, `launchRepair`, `launchReview`, and `launchVerifier` share a pattern but have enough variation (different agent prompts, different return types, different worktree strategies) that a generic wrapper would need many parameters.

**Verdict:** Deduplicate the clean functions (30 LOC savings). Keep the launch functions separate (different enough to warrant individual implementations).

## Findings (continued)

### 9. Multi-daemon safety: PID race -- SEVERITY: medium
**Tag:** SIMPLIFY

`isDaemonRunning()` (`daemon.ts:229-241`) checks if a PID file exists and the process is alive. In `cmdOrchestrate` (orchestrate.ts:3203-3206):
```typescript
const existingPid = isDaemonRunning(projectRoot);
if (existingPid !== null && existingPid !== process.pid) {
  die(`Another watch daemon is already running...`);
}
```

**TOCTOU race:** Two `nw watch` invocations at the same time could both read the PID file, find no running daemon (or find a stale PID), proceed past the check, and both call `writePidFile`. The second write silently overwrites the first.

The lock module (`lock.ts`, reviewed in Review 4) provides `acquireLock`/`releaseLock` but is only used by cross-repo operations. The main daemon loop does not use it.

In practice, this race is unlikely because users don't launch two daemons simultaneously. But `nw watch` is called by CI, automated scripts, and potentially by the orchestrator itself for sub-project coordination. A concurrent launch would result in two daemons managing the same items -- partition collisions, duplicate PR comments, and state file corruption.

**Recommendation:** Use `lock.ts`'s `acquireLock` for daemon startup, or use the same `O_CREAT | O_EXCL` pattern recommended in Review 3 Finding 2 for the PID file itself. Estimated effort: ~10 LOC.

### 10. Schedule WIP sharing: starvation analysis -- SEVERITY: low (would be medium if scheduling were kept)
**Tag:** STRIP (moot if scheduling is stripped)

`processScheduledTasks` (orchestrate.ts:2489-2496) computes free WIP slots:
```typescript
const activeWorkItemCount = orch.getAllItems()
  .filter((i) => !["done", "stuck", "ready", "queued"].includes(i.state)).length;
const activeScheduleCount = state.active.length;
const freeSlots = Math.max(0, effectiveWip - activeWorkItemCount - activeScheduleCount);
```

Scheduled tasks and work items share the same WIP pool. If `effectiveWip = 5`, 3 work items are active, and 2 scheduled tasks fire simultaneously, all 5 slots are consumed. Work items that become ready during this time cannot launch until a scheduled task completes.

The starvation risk is bounded by:
1. Scheduled tasks have a timeout (default 30 minutes, configurable per task)
2. `checkSchedules` skips tasks that are already active or queued
3. The `processScheduleQueue` function processes the queue FIFO, limited by `freeSlots`

**Starvation scenario:** A scheduled task with a 2-hour timeout on a 2-slot WIP-limit system would block all work item processing for 2 hours. This is a configuration error (long timeout + low WIP), not a design bug.

**Recommendation:** Moot if scheduling is stripped. If kept, add a `maxScheduleWip` config option that caps the number of concurrent scheduled tasks, reserving slots for work items.

### 11. daemon.ts: runtime state migration is one-time code -- SEVERITY: low
**Tag:** KEEP

`migrateRuntimeState()` (`daemon.ts:644-711`, ~68 LOC) migrates files from `.ninthwave/` to `~/.ninthwave/projects/`. This was a one-time migration when the state directory location changed. The function is idempotent and safe to keep -- it no-ops when there's nothing to migrate.

The question is whether 68 LOC of migration code should be kept indefinitely. After all existing users have migrated (a few weeks after the change), the function will never find files to migrate.

**Recommendation:** Keep for now. Remove in a future cleanup (6-12 months after the migration). The 68 LOC is not hurting anything and prevents edge cases where old state files cause confusion.

### 12. shell.ts: clean, minimal, well-designed -- SEVERITY: low (positive finding)
**Tag:** KEEP

`shell.ts` (101 LOC) provides `run()` (sync) and `runAsync()` (async) shell execution. Both have timeout support, consistent `RunResult` return types, and clear handling of edge cases (killed process → exitCode 124, timeout detection via elapsed time).

The `GIT_TIMEOUT` (30s) and `GH_TIMEOUT` (60s) constants are pragmatic defaults. Git operations should be fast (local disk); GitHub CLI operations involve network I/O and can be slower.

The `runAsync` function uses `Bun.spawn` (not `shell: true`), which is safe against shell injection. Arguments are passed as an array, not a string.

**Recommendation:** Keep. The module is well-scoped and well-designed.

### 13. preflight.ts: thorough environment validation -- SEVERITY: low (positive finding)
**Tag:** KEEP

`preflight.ts` (230 LOC) validates: gh CLI installed + authenticated, AI tool available, cmux multiplexer available, git config set, uncommitted work items, and Copilot trust configuration.

The `checkCopilotTrust` function (lines 152-190, ~39 LOC) is specific to Copilot users. It reads `~/.copilot/config.json` to check if the project root is trusted. This prevents an interactive trust prompt from appearing in worktrees (which would block the automated worker). The check is advisory (`warn`, not `fail`), so it doesn't block non-Copilot users.

All checks use an injectable `ShellRunner` for testability. The `preflight()` function (lines 202-230) runs all checks and returns a structured result.

**Recommendation:** Keep. The pre-flight checks prevent a class of errors that would otherwise surface as mysterious worker failures 10+ minutes into a session.

### 14. External review processing: tightly coupled to orchestrate.ts -- SEVERITY: low
**Tag:** SIMPLIFY

`processExternalReviews` (~100 LOC in orchestrate.ts) handles non-ninthwave PR review. It:
1. Scans for open PRs not created by ninthwave
2. Launches review workers for new PRs
3. Monitors review workers for completion
4. Cleans up completed review workers

The function is well-designed but adds ~100 LOC to orchestrate.ts that is orthogonal to the core work-item lifecycle. It should be extracted to `core/external-review.ts` as part of the decomposition (Finding 8).

**Recommendation:** SIMPLIFY by extraction. No behavioral change, just better code organization.

## Recommendations

**Priority 1 (High -- correctness risk):**
1. **Make `writeStateFile` atomic via write-then-rename** (Finding 1). The state file is the single point of truth for crash recovery. Non-atomic writes risk corruption. ~5 LOC.
2. **Serialize `workspaceRef`, `partition`, and `resolvedRepoRoot` in DaemonStateItem** (Finding 4). These fields are critical for crash recovery of in-flight items. ~20 LOC. Cross-reference: Review 1 Finding 1.

**Priority 2 (High -- feature stripping):**
3. **STRIP crew mode** (Theme A). Remove `crew.ts`, `mock-broker.ts`, and all crew integration from `orchestrate.ts`. **~1,718 LOC total savings** (including tests). Zero users, speculative infrastructure.
4. **STRIP scheduling** (Theme A). Remove all 5 `schedule-*.ts` files, schedule integration from `orchestrate.ts`, and schedule CLI commands. **~1,841 LOC total savings** (including tests). Zero users, overlaps with CI/CD tools.

**Priority 3 (Medium -- complexity reduction):**
5. **Simplify TUI** (Theme A). Remove detail panel, log filtering, help overlay, and merge strategy cycling. **~285 LOC savings** in production code.
6. **Decompose `orchestrate.ts`** (Finding 8). Extract snapshot building, state reconstruction, arg parsing, and TUI keyboard handling into separate files. **0 LOC net** but reduces per-file cognitive load from 3,890 to ~2,200 LOC.
7. **Simplify analytics** (Theme A). Merge `commitAnalyticsFiles` and `commitFrictionFiles`. **~30 LOC savings.**
8. **Batch GitHub API calls** (Finding 2). Replace per-item REST calls with a single GraphQL query. **Reduces poll latency from 5-15s to ~2s** for 5 items.

**Priority 4 (Low -- hardening):**
9. **Add PID file locking** (Finding 9). Prevent TOCTOU race between concurrent daemon launches. ~10 LOC.
10. **Move `forkDaemon` to `daemon.ts`** (Theme B). Better cohesion with PID management. ~0 LOC net.
11. **Deduplicate clean functions** (Theme B). Merge `cleanRepair`/`cleanReview`/`cleanVerifier` into a generic helper. ~30 LOC savings.

**Cross-references to Reviews 1-4:**
- **Review 1 Finding 1** (OrchestratorItem/DaemonStateItem divergence): Finding 4 above addresses the three most critical missing fields. The full sync check recommended in Review 1 would additionally catch future omissions.
- **Review 1 Finding 9** (JSON.parse without validation): Finding 1 above addresses the root cause -- if the state file is atomically written, corruption is eliminated and validation becomes a defense-in-depth measure.
- **Review 2 Theme B** (orchestrate.ts decomposition): Finding 8 above provides specific extraction targets and LOC estimates. The total `orchestrate.ts` reduction (from 3,890 to ~2,200 LOC) is achievable with the extractions listed.
- **Review 3 Finding 11** (workspace listing cache): Schedule workers have the same redundancy -- `isScheduleWorkerAlive` calls `listWorkspaces()` per worker, independently of the orchestrator's per-item listing. Stripping scheduling eliminates this redundancy.
- **Review 4 Finding 1** (GitHub API errors silently return empty): This directly causes Finding 2 (event loop starvation via slow snapshot). Fixing the gh.ts error handling (Review 4's top recommendation) would enable the orchestrator to detect API outages and hold state rather than stalling.
- **Review 4 Finding 3** (cross-repo alias sanitization): Stripping crew mode does not affect cross-repo support. Cross-repo is a separate feature with real usage in dogfooding workflows.

## Total "Potential LOC Reduction" Estimate

| Action | LOC Saved |
|--------|-----------|
| Strip crew mode (production + test) | ~1,718 |
| Strip scheduling (production + test) | ~1,841 |
| Simplify TUI | ~285 |
| Simplify analytics | ~30 |
| Deduplicate clean functions | ~30 |
| **Total** | **~3,904 LOC** |

This represents a **~47% reduction** in the reviewed codebase (from ~8,239 to ~4,335 LOC) and a **~41% reduction** in production code (from ~8,239 to ~4,862 LOC, excluding test savings).

The stripped features (crew mode, scheduling) can be re-implemented if demand materializes. The simplified features (TUI, analytics) retain their core functionality with reduced maintenance surface.
