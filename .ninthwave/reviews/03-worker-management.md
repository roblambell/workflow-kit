# Review 3: Worker Management & Message Delivery

## Summary

The worker lifecycle spans six modules: `core/commands/launch.ts` (1,272 LOC) handles session initialization, `core/worker-health.ts` (270 LOC) provides screen-parsing heuristics, `core/send-message.ts` (142 LOC) and `core/delivery.ts` (63 LOC) handle message delivery, `core/partitions.ts` (112 LOC) manages port/DB isolation, and `core/commands/clean.ts` (322 LOC) handles cleanup. The multiplexer abstraction lives in `core/mux.ts` (293 LOC) and `core/cmux.ts` (156 LOC).

The system is well-designed for reliability: message delivery uses paste-buffer-then-Return with verification and exponential backoff retry, worker health detection uses a three-layer hierarchy (heartbeat → process liveness → commit-based), and cleanup uses best-effort error handling that continues through individual failures. The most significant concerns are: (1) launch-time resource leaks where worktree creation succeeds but later steps fail, leaving orphaned worktrees, (2) partition allocation using non-atomic `existsSync` + `writeFileSync`, creating a TOCTOU race between concurrent daemons, (3) screen-parsing heuristics that are fragile against AI tool UI changes and vulnerable to false positives from code content, and (4) the message delivery "silent success" path where unverifiable deliveries are assumed successful.

Cross-reference: Review 1 identified that `partition` and `workspaceRef` are not serialized in `DaemonStateItem` (Finding 1), meaning a daemon crash loses the ability to manage in-flight workers. This review confirms the impact: without `workspaceRef`, liveness checks return `false` for all workers after restart, and without `partition`, partition files become orphaned until `cleanupStalePartitions` runs. Review 2 identified that `stuckOrRetry` doesn't reset `lastCommitTime` (Finding 2); this review adds that it also doesn't reset `lastScreenOutput`, which could confuse diagnostics for the retried attempt.

## Findings

### 1. Launch resource leak: worktree created but later steps fail -- SEVERITY: high
**Tag:** SIMPLIFY

`launchSingleItem()` (`launch.ts:427-665`) performs a sequence of operations:
1. Resolve target repo (line 438)
2. Clean stale branches (line 449)
3. Create worktree (lines 462-612)
4. Write cross-repo index (lines 615-618)
5. Seed agent files (line 621)
6. Allocate partition (lines 624-628)
7. Build and write system prompt (lines 637-652)
8. Launch AI session (lines 654-664)

If step 8 (`launchAiSession`) fails (returns null), the function returns null at line 663, but the worktree (step 3), partition (step 6), cross-repo index entry (step 4), and seeded agent files (step 5) are all leaked. The caller receives null and has no reference to clean up.

The same applies if `writeFileSync` at line 652 throws (disk full, permissions), or if partition allocation at line 627 throws -- the worktree exists but no cleanup runs.

In practice, `cleanupStalePartitions()` recovers orphaned partitions on the next launch cycle, and `cmdClean` can remove the orphaned worktree. But between the leak and the cleanup, the partition is consumed and the worktree occupies disk. With a WIP limit of 5 and aggressive launch/fail cycles, partition exhaustion is unlikely but the disk usage could accumulate.

**Recommendation:** Wrap steps 3-8 in a try/catch that cleans up on failure:
```typescript
try {
  // steps 3-8
} catch (e) {
  // Cleanup: remove worktree, release partition, remove cross-repo index entry
  releasePartition(partitionDir, item.id);
  removeCrossRepoIndex(crossRepoIndex, item.id);
  try { removeWorktree(targetRepo, worktreePath, true); } catch { /* best-effort */ }
  throw e; // or return null
}
```
Estimated effort: ~15 LOC.

### 2. Partition allocation TOCTOU race -- SEVERITY: medium
**Tag:** SIMPLIFY

`allocatePartition()` (`partitions.ts:16-30`) uses `existsSync(path)` followed by `writeFileSync(path, todoId)`. This is a classic Time-of-Check-Time-of-Use race: two concurrent processes could both see partition N as available, and both write to it. The second write silently overwrites the first, resulting in two workers sharing the same partition number.

In the current architecture, only a single daemon process calls `allocatePartition` (via `launchSingleItem` in the main poll loop). The race would require two simultaneous `nw start` invocations, or two daemon instances watching the same project. The orchestrator's single-threaded event loop makes this unlikely in normal usage.

However, `nw start <ID>` can be called manually while the daemon is running, and the daemon's `executeLaunch` calls `launchSingleItem` from within `executeAction`. If a user manually runs `nw start` at the exact moment the daemon is launching, the race is possible.

**Recommendation:** Use atomic file creation via `O_CREAT | O_EXCL` (exclusive create):
```typescript
import { openSync, writeSync, closeSync, constants } from "fs";
const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
writeSync(fd, todoId);
closeSync(fd);
```
This is atomic on POSIX filesystems -- the second opener gets `EEXIST`. Estimated effort: ~10 LOC.

### 3. Screen-parsing heuristics are brittle against tool UI changes -- SEVERITY: medium
**Tag:** QUESTIONABLE

`worker-health.ts` classifies worker state using three keyword lists:
- `PROMPT_INDICATORS` (lines 25-32): `"❯"`, `"Enter a prompt"`, `"bypass permissions"`, `"What can I help"`, `"How can I help"`, `"> "`
- `PROCESSING_INDICATORS` (lines 35-57): braille spinners, `"Thinking"`, `"Reading"`, `"Writing"`, `"Searching"`, tool prefixes like `"Bash("`, `"Read("`
- `ERROR_INDICATORS` (lines 60-69): `"Error:"`, `"FATAL"`, `"panic:"`, etc.

**False positive risk with ERROR_INDICATORS:** The `"Error:"` indicator (line 61) will match if the worker's screen shows code containing the string "Error:" -- e.g., a Python traceback in a test output, a code review mentioning error handling, or the worker reading a file that contains `throw new Error("...")`. The `getWorkerHealthStatus` function (lines 111-127) checks error indicators first (line 117: `if (isWorkerInError(screenContent)) return "error"`), so a false positive here overrides all other signals.

However, the health status returned by `getWorkerHealthStatus` is only used by `worker-health.ts` itself for the launch-and-verify sequence (`sendWithReadyWait`, `waitForInputPrompt`, `verifySendProcessing`). The orchestrator's liveness detection in `orchestrate.ts:866` uses `isWorkerAlive()` which checks workspace listing, not screen content. So false positives in `getWorkerHealthStatus` only affect message delivery verification, not the stuck/retry lifecycle.

**False negative risk with PROMPT_INDICATORS:** If Claude Code changes its prompt character from `❯` to something else, or drops the `"Enter a prompt"` text, `waitForInputPrompt` will timeout. The code handles this gracefully -- line 249 comments "If prompt never appeared, still try sending" and the send attempt proceeds. The `sendWithReadyWait` function returns false, triggering the legacy fallback in `launchAiSession` (launch.ts:307-321).

**Staleness risk:** The `PROCESSING_INDICATORS` include tool-specific prefixes (`"Agent("`, `"Bash("`, `"Read("`, etc.) that match Claude Code's current tool output format. A major UI overhaul would require updating these lists. No versioning or tool-specific indicator sets exist.

**Recommendation:** Two improvements:
1. Make `ERROR_INDICATORS` more specific -- e.g., require `"Error:"` to appear at the start of a line or after a newline: `screenContent.split("\n").some(line => line.trimStart().startsWith("Error:"))`. This would eliminate most false positives from code content.
2. Consider making indicator lists configurable or tool-specific. A `Map<string, string[]>` keyed by AI tool name would allow tool-specific indicators without changing the detection algorithm.
Estimated effort: ~30 LOC for line-anchored error detection; ~50 LOC for tool-specific indicators.

### 4. Message delivery "silent success" on verification failure -- SEVERITY: medium
**Tag:** SIMPLIFY

The `verifyDelivery` function (`send-message.ts:122-141`) reads 3 lines from the screen and checks if the message text is stuck in the input field. The critical path:

```typescript
if (screen.exitCode !== 0) {
  // Can't verify -- assume success (paste-submit is inherently reliable)
  return true;  // line 138
}
```

When `read-screen` fails (cmux not responding, workspace closed, IPC error), the function assumes the message was delivered. The comment justifies this: "paste-submit is inherently reliable." This is true for the paste-buffer path (`attemptSend`, lines 39-78), but `attemptDirectSend` (lines 82-113) uses `cmux send` which delivers via keystrokes -- not inherently reliable.

The `attemptDirectSend` fallback path also calls `verifyDelivery` (line 112). If the screen can't be read in the fallback path, the function claims success for a keystroke-based delivery that may have failed.

The full "silent failure" trace:
1. `sendMessageImpl` calls `sendWithRetry` with `attemptSend` (line 32-35)
2. `attemptSend` tries paste-buffer → paste fails → falls back to `attemptDirectSend` (line 61)
3. `attemptDirectSend` sends via keystrokes (cmux send), succeeds
4. `attemptDirectSend` calls `verifyDelivery` → `read-screen` fails → returns `true`
5. `sendWithRetry` gets `true` on first attempt, stops retrying
6. The message may not have been delivered (keystrokes can be dropped or interleaved with user input)

The `sendWithRetry` wrapper (`delivery.ts:47-63`) retries up to `maxRetries + 1` times with exponential backoff. But since `verifyDelivery` returned `true`, no retry occurs.

In the orchestrator, `executeSendMessage` (`orchestrator.ts:2112-2129`) checks the return value of `deps.sendMessage()`. If it returns `false`, it returns `{ success: false, error: "Failed to send..." }`. But in the trace above, it returns `true` despite possible non-delivery. The orchestrator treats this as a success. The undelivered message is silently lost.

**Impact:** For CI fix requests and review feedback, a lost message means the worker never acts on the feedback. The orchestrator won't re-send because it believes delivery succeeded. The worker may eventually be marked stuck due to inactivity (the activity timeout will fire after `activityTimeoutMs`), but this creates a delay of up to 60 minutes before recovery.

**Recommendation:** Change `verifyDelivery` to return `false` when screen reading fails if the delivery was via the keystroke fallback path. This requires propagating a "delivery method" flag:
```typescript
export function verifyDelivery(
  workspaceRef: string,
  message: string,
  runner: Runner,
  usedPasteBuffer: boolean = true,
): boolean {
  // ...
  if (screen.exitCode !== 0) {
    return usedPasteBuffer; // Only trust unverified paste, not keystrokes
  }
  // ...
}
```
Estimated effort: ~15 LOC.

### 5. Cleanup ordering: remote branch failure doesn't block partition release -- SEVERITY: low
**Tag:** KEEP

`cleanSingleWorktree()` (`clean.ts:253-303`) performs cleanup in order:
1. Remove worktree (line 280-289)
2. Delete local branch (line 290-294)
3. Delete remote branch (line 295-299)
4. Release partition (line 300)
5. Remove cross-repo index entry (line 301)

Each step is wrapped in try/catch, and failures don't prevent subsequent steps. This means:
- If remote branch deletion fails (network issue), the partition is still released ✓
- If worktree removal fails (file locked), local branch deletion still runs ✓
- If local branch deletion fails (branch checked out elsewhere), remote branch deletion still runs ✓

The function returns `true` regardless of individual step failures -- it's signaling "I found and attempted to clean the worktree" not "everything was perfectly cleaned." This is pragmatic but means the caller can't distinguish partial cleanup from complete cleanup.

**The remaining risk:** If remote branch deletion fails, the remote branch persists but the local branch and worktree are gone. The next launch attempt for the same item ID will create a new worktree with `createWorktree`, which creates a new local branch. The remote branch from the old attempt remains as an orphan on the remote. This is a minor git hygiene issue, not a functional bug.

**Recommendation:** Keep as-is. The best-effort approach is correct for cleanup code. The orphaned remote branch is cleaned up naturally when the PR is closed/merged or by periodic `git remote prune`.

### 6. Worker health debounce: 10 seconds is tight for cmux listing latency -- SEVERITY: low
**Tag:** QUESTIONABLE

`NOT_ALIVE_THRESHOLD = 5` (`orchestrator.ts:433`). The daemon polls every ~2 seconds (typical `pollIntervalMs`), so 5 consecutive false readings = ~10 seconds before declaring a worker dead.

The `isWorkerAlive` function (`orchestrate.ts:866-877`) calls `mux.listWorkspaces()` and searches the output. This is a synchronous `cmux list-workspaces` shell command. The latency depends on:
- cmux IPC overhead (typically <100ms)
- Number of workspaces listed (linear scan)
- System load (shell spawn cost under memory pressure)

Under heavy load (5 concurrent workers, compilation running, disk I/O saturated), shell spawn time can spike to 1-2 seconds. If `listWorkspaces` takes >2s, the poll loop may skip an entire cycle, making the 5-poll debounce effectively ~3 actual checks.

More critically, `isWorkerAlive` is called once per active item per poll cycle. With 5 workers, that's 5 `cmux list-workspaces` calls per cycle. Each call gets a fresh listing (no caching). This means 5 redundant shell spawns per cycle, each producing the same output.

**Recommendation:** Two improvements:
1. Cache `listWorkspaces()` result within a single poll cycle. The `buildPollSnapshot` function in `orchestrate.ts` could call `listWorkspaces()` once and pass the result to per-item checks. Estimated savings: 4 shell spawns per cycle × ~100ms = ~400ms/cycle.
2. Consider bumping `NOT_ALIVE_THRESHOLD` to 8 (16 seconds) to accommodate system load spikes. The cost is 6 extra seconds before detecting genuinely crashed workers.
Estimated effort: ~20 LOC for caching, ~1 LOC for threshold change.

### 7. `calculateMemoryWipLimit` uses `os.freemem()` which underreports on macOS -- SEVERITY: medium
**Tag:** SIMPLIFY

`calculateMemoryWipLimit()` (`orchestrator.ts:419-427`) takes `freeMemBytes` as a parameter. In `launch.ts:1034` and `launch.ts:1221`, this is called with `freemem()` from `os`. On macOS, `os.freemem()` reports only the "free" memory category from Mach statistics, excluding "inactive" pages (file cache that the OS can reclaim on demand).

A typical macOS system might report 500MB "free" but have 4GB "inactive" -- all reclaimable. `calculateMemoryWipLimit` with `BYTES_PER_WORKER = 2.5GB` would compute `floor(500MB / 2.5GB) = 0`, clamped to 1. The actual available memory is ~4.5GB, supporting 1-2 workers comfortably.

The daemon (`orchestrate.ts:1404-1424`) already fixes this with `getAvailableMemory()`, which parses `vm_stat` on macOS to include inactive pages. But `launch.ts` (the `nw start` and `nw <ID>` paths) uses raw `freemem()`, not `getAvailableMemory()`.

This means `nw start` calculates a more conservative WIP limit than `nw watch` for the same system state. A user might see "WIP limit: 1 (1GB free)" from `nw start` but "WIP limit: 3" from the daemon.

Cross-reference: This was called out in the work item's review criteria (#7). The daemon's `getAvailableMemory` function correctly handles macOS, but the fix isn't applied consistently.

**Recommendation:** Export `getAvailableMemory()` from `orchestrate.ts` (or extract to a shared `core/memory.ts`) and use it in `launch.ts` instead of raw `freemem()`. Estimated effort: ~10 LOC.

### 8. `launchSingleItem` has 240 lines of branch management logic -- SEVERITY: medium
**Tag:** SIMPLIFY

`launchSingleItem()` (`launch.ts:427-665`) is 238 lines, of which roughly 150 lines (lines 462-612) handle branch existence, collision, external worktree detection, PR detection, and retry scenarios. The branch management logic handles:

1. Worktree already exists (line 463-464) → reuse
2. Existing branch + external worktree in different location (lines 516-528) → remove external, continue
3. Existing branch + open PR + not force (lines 532-547) → skip launch, return existingPrNumber
4. Existing branch + open PR + force (lines 548-553) → reuse branch, launch worker
5. Existing branch + worktree exists + no PR (lines 554-560) → reuse for retry
6. Existing branch + no worktree + no PR (lines 561-591) → delete branch, retry deletion if blocked by worktree
7. Reuse branch + worktree exists (lines 594-598) → skip create
8. Reuse branch + no worktree (lines 599-603) → attachWorktree
9. Fresh branch (lines 604-611) → createWorktree from start point

Each branch adds to the cognitive complexity. The nested conditionals are well-commented but hard to follow. The `reuseExistingBranch` boolean flag threading adds implicit state.

**Recommendation:** Extract the branch management logic into a dedicated function:
```typescript
function ensureWorktreeAndBranch(
  item: WorkItem,
  targetRepo: string,
  worktreePath: string,
  branchName: string,
  baseBranch?: string,
  forceWorkerLaunch?: boolean,
): { action: "launch" | "skip-with-pr"; existingPrNumber?: number }
```
This would isolate the branching logic from the prompt construction and session launch. Estimated effort: ~20 LOC overhead (function signature, return type), but significant readability improvement.

### 9. Multiplexer abstraction has only one implementation -- SEVERITY: low
**Tag:** QUESTIONABLE

`core/mux.ts` defines a `Multiplexer` interface (lines 16-39) with 10 methods, plus `MuxType`, `DetectMuxDeps`, `AutoLaunchDeps`, `AutoLaunchResult`, `SpawnFn`, and helper functions. `CmuxAdapter` (lines 42-76) is a 1:1 passthrough to `core/cmux.ts` -- every method simply delegates to the corresponding `cmux.*` function.

The `MuxType` union (line 79) is `"cmux"` -- a single variant. `detectMuxType()` (lines 108-121) checks for cmux and errors if not found. The `getMux()` function (lines 131-139) always returns `CmuxAdapter` regardless of detection.

The abstraction was designed for multi-tool support (ETHOS.md principle #6: "No vendor lock-in"). However, the adapter pattern adds:
- 293 LOC in `mux.ts` (interface + adapter + detection + auto-launch)
- 156 LOC in `cmux.ts` (concrete implementation)
- Indirection: every mux call goes through `Multiplexer` → `CmuxAdapter` → `cmux.*` → `run("cmux", ...)`

The `Multiplexer` interface is useful for testing -- mock implementations are used in test files to avoid real cmux calls. This is the primary value of the abstraction today.

Cross-reference: Review 2 found that the `OrchestratorDeps` interface (`orchestrator.ts`) provides dependency injection for all mux operations (`sendMessage`, `closeWorkspace`, `readScreen`), which duplicates the testability benefit of the Multiplexer interface at the orchestrator level.

**Recommendation:** The abstraction is justified by testability and future extensibility (tmux, Zellij, WezTerm are potential backends). The ETHOS.md principle explicitly requires adapter interfaces. Keep, but consider whether `mux.ts` could be simplified by removing the detection chain (since there's only one backend) and keeping just the interface + adapter. The auto-launch logic (lines 142-257) is substantial but separate from the adapter pattern. Estimated savings if detection is simplified: ~40 LOC.

### 10. delivery.ts `checkDelivery` heuristic can produce false positives -- SEVERITY: low
**Tag:** KEEP

`checkDelivery()` (`delivery.ts:22-38`) checks if the message is stuck in the input field by looking for a "significant prefix" of the message in the last visible screen line:

```typescript
const probe = message.length > 60 ? message.slice(0, 60) : message;
return !lastLine.includes(probe);
```

**False positive (declares "not delivered" when it was):** If the AI tool echoes the message text back on screen (e.g., Claude Code shows the submitted prompt), the last line might contain the probe text even though the message was successfully submitted. The `sendWithRetry` wrapper would then retry unnecessarily, sending the message again.

In practice, Claude Code clears the input field on submit and shows tool output instead. The probe text is unlikely to appear verbatim in tool output. But for very short messages (< 60 chars), common phrases like "Start" could appear in the tool's response.

**False negative (declares "delivered" when it wasn't):** If the input field shows only part of the message (paste was truncated), the probe text won't match the truncated version, and `checkDelivery` returns `true` (delivered). The truncated message is submitted.

The 60-character probe length is a pragmatic balance. Longer probes reduce false negatives (truncation detection) but increase false positives (echo detection).

**Recommendation:** Keep. The heuristic is imperfect but the retry mechanism provides a safety net for false positives. False negatives (truncated pastes submitted as-is) are rare with the paste-buffer approach. The 3-line screen read window (send-message.ts:132) is narrow enough to typically show only the current UI state.

### 11. Worker liveness check doesn't cache workspace listings -- SEVERITY: medium
**Tag:** SIMPLIFY

`isWorkerAlive()` (`orchestrate.ts:866-877`) calls `mux.listWorkspaces()` every invocation. In `buildPollSnapshot` (the poll function), `isWorkerAlive` is called once per active item:
- Lines 629, 642, 650, 658 (TUI mode snapshot builder)
- Lines 803, 816, 824, 832 (JSON mode snapshot builder)

With 5 concurrent workers in various states (implementing, reviewing, repairing), a single poll cycle may call `listWorkspaces()` 5-10 times, each spawning a `cmux list-workspaces` subprocess. The output is identical within a poll cycle since workspaces don't change that fast.

**Recommendation:** Call `mux.listWorkspaces()` once at the top of `buildPollSnapshot` and pass the cached result to `isWorkerAlive`:
```typescript
function isWorkerAlive(item: OrchestratorItem, workspaceList: string): boolean {
  if (!item.workspaceRef) return false;
  // ... regex matching on workspaceList
}
```
This is a straightforward optimization with no behavioral change. Estimated effort: ~15 LOC.

### 12. `launchAiSession` sends initial prompt differently per tool -- SEVERITY: low
**Tag:** KEEP

`launchAiSession()` (`launch.ts:241-324`) has tool-specific prompt delivery:
- **claude**: Embeds the prompt as a positional arg in the launch command (line 257-258), skips post-launch send
- **opencode**: Reads `.nw-prompt` into the send buffer, sends after launch (line 262)
- **copilot**: Writes prompt to a temp file, uses a launcher script with `-i` flag (lines 264-281), skips post-launch send

For `opencode`, the entire prompt file content is sent via `sendWithReadyWait`, which goes through the paste-buffer → verify → retry pipeline. The prompt can be large (multi-KB for detailed work items). The 60-character probe in `checkDelivery` only checks the first 60 characters of the message, which is sufficient.

For `claude`, the `--append-system-prompt "$(cat '.nw-prompt')"` approach uses shell command substitution, which is subject to argument length limits. On macOS, `ARG_MAX` is ~256KB, and work item prompts are typically 2-10KB, well within limits. But if a prompt contained shell-special characters that escaped `sanitizeForShellQuoting`, the command could break.

The `sanitizeForShellQuoting` function (`launch.ts:57-67`) handles common Unicode punctuation but doesn't escape shell metacharacters (`$`, backtick, `\`). However, the prompt is wrapped in double quotes via the command string, and `$(cat '.nw-prompt')` reads from file, avoiding the quoting issue entirely.

**Recommendation:** Keep. The per-tool divergence is inherent to how each tool accepts prompts. The claude path (file-based) and copilot path (file-based) are both robust. The opencode path (paste-buffer) is the most fragile but benefits from the full delivery verification pipeline.

### 13. `cleanSingleWorktree` doesn't close the workspace -- SEVERITY: low
**Tag:** SIMPLIFY

`cleanSingleWorktree()` (`clean.ts:253-303`) removes the worktree, branches, partition, and cross-repo index -- but does not close the cmux workspace. The worker's terminal session continues running (or shows an error since its CWD was deleted).

By contrast, `cmdClean()` (`clean.ts:145-247`) does close workspaces for merged items via `closeWorkspacesForIds` (line 243). And `cmdCleanSingle()` (`clean.ts:308-321`) -- the CLI wrapper -- also doesn't close the workspace.

The orchestrator calls `cleanSingleWorktree` from `executeClean` (`orchestrator.ts`) after the worker's PR is merged. The workspace may still be alive (worker idle post-PR). The orphaned workspace consumes cmux resources until the user manually closes it or cmux detects the dead process.

**Recommendation:** Add an optional `Multiplexer` parameter to `cleanSingleWorktree` and close the workspace if provided:
```typescript
export function cleanSingleWorktree(
  id: string,
  worktreeDir: string,
  projectRoot: string,
  mux?: Multiplexer,
): boolean {
  // ... existing cleanup ...
  if (mux) {
    try { closeWorkspacesForIds(new Set([id]), mux); } catch { /* best-effort */ }
  }
  return true;
}
```
Estimated effort: ~10 LOC.

### 14. Three-layer health monitoring: all layers justified -- SEVERITY: low
**Tag:** KEEP

The work item asks whether the three-layer health monitoring (heartbeat + liveness + commits) is all necessary. Cross-reference: Review 2 Finding 8 analyzed this in depth and concluded all three layers are justified. This review confirms from the implementation side:

1. **Heartbeat** (`orchestrator.ts:835-845`): Checked first. If a heartbeat arrived within `HEARTBEAT_TIMEOUT_MS` (5 min), the worker is healthy. This is the cheapest check (reads a JSON file, no shell spawn). Short-circuits all timeout logic.

2. **Process liveness** (`orchestrate.ts:866-877` via `isWorkerAlive`): Checks if the cmux workspace still exists. This catches crashed processes that can't heartbeat. The 5-poll debounce (`NOT_ALIVE_THRESHOLD`) prevents false positives from transient cmux listing failures.

3. **Commit-based** (`orchestrator.ts:897-933`): Final backstop. A worker process can be alive (cmux workspace exists) but completely stalled (infinite loop, wedged on a tool call). The commit-based timeout detects this by checking if the worker has pushed any commits within `activityTimeoutMs` (default 60 min).

Each layer addresses a distinct failure mode:
- Layer 1 (heartbeat): worker is healthy and actively reporting
- Layer 2 (liveness): worker process exists but isn't heartbeating (startup gap, broken heartbeat)
- Layer 3 (commits): worker is alive but stalled (zombie process, infinite retry loop)

Removing layer 2 would require either increasing `launchTimeoutMs` to accommodate the 30-60 second startup gap (masking real failures) or requiring instant heartbeating (unreliable during tool initialization).

**Recommendation:** Keep all three layers. The design is sound.

## Theme A: Feature Necessity

### Assessment

| Feature | Tag | Rationale |
|---|---|---|
| `delivery.ts` (63 LOC) | **KEEP** | Shared retry and verification logic used by `send-message.ts`. The `sendWithRetry` function is generic and `checkDelivery` encapsulates a non-trivial heuristic. Without this module, the retry logic would be duplicated or inlined. 63 LOC is minimal. |
| `Multiplexer` interface in `mux.ts` | **KEEP** | Required by ETHOS.md principle #6 (no vendor lock-in). Provides testability via mock implementations. The interface is the contract that enables future backends (tmux, Zellij). |
| `CmuxAdapter` in `mux.ts` | **QUESTIONABLE** | Pure passthrough -- every method delegates to `cmux.*` with no transformation. Could be replaced by having `cmux.ts` export an object conforming to `Multiplexer`. But the adapter pattern is standard and the overhead is ~35 LOC. |
| `mux.ts` auto-launch logic | **KEEP** | The `ensureMuxOrAutoLaunch` function (lines 237-257) is essential UX -- users running `nw watch` outside cmux get auto-launched into a cmux session. The detection chain (`checkAutoLaunch`, lines 166-198) handles recursive launch guards, non-TTY environments, and missing cmux. |
| `mux.ts` `waitForReady` | **QUESTIONABLE** | Legacy ready-detection used as fallback in `launchAiSession` (launch.ts:313). The primary path uses `sendWithReadyWait` from `worker-health.ts`. Could be removed if the legacy fallback is deemed unnecessary. |
| Partition-based port isolation | **KEEP** | Essential for parallel workers. Without partitions, workers running tests on the same project would collide on default ports (3000, 5432, etc.). The partition number is passed as `YOUR_PARTITION` in the system prompt, and workers use it to offset ports. Even if "most projects don't have port conflicts," the ones that do would be silently broken. |
| Three-layer health monitoring | **KEEP** | Each layer addresses a distinct failure mode (see Finding 14). Removing any layer creates a blind spot. |
| `seedAgentFiles` in `launch.ts` | **KEEP** | Required for cross-repo items where the target repo doesn't have agent files. Also handles first-time setup. The three-target seeding (`.claude/agents`, `.opencode/agents`, `.github/agents`) supports multi-tool compatibility (ETHOS.md principle #6). |
| `cleanStaleBranchForReuse` in `launch.ts` | **KEEP** | Addresses a real bug: reused work item IDs with merged branches cause workers to immediately detect the merged PR and exit. The title-matching heuristic (`prTitleMatchesWorkItem`) distinguishes same-ID-same-work from same-ID-different-work. |
| `detectAiTool` in `launch.ts` | **KEEP** | Multi-tool detection chain (env vars → process tree → PATH check). Required for ETHOS.md principle #6. The 5-step chain is thorough. |

### Summary

1 item is questionable (`CmuxAdapter` passthrough, `waitForReady` legacy), 0 items should be stripped, and everything else serves a clear purpose. The `delivery.ts` module, despite being only 63 LOC, provides genuine shared logic.

## Theme B: Complexity Reduction

### Can `launch.ts` at 1,272 LOC be simplified?

Yes. The file has four natural sections:

1. **Utilities** (lines 1-107): sanitization, agent file definitions. ~107 LOC.
2. **Agent seeding** (lines 108-188): `readAgentFileContent`, `seedAgentFiles`. ~80 LOC.
3. **AI tool detection and session launch** (lines 194-411): `detectAiTool`, `launchAiSession`, `cleanStaleBranchForReuse`, `extractItemText`. ~218 LOC.
4. **Worker launch functions** (lines 427-935): `launchSingleItem`, `launchReviewWorker`, `launchRepairWorker`, `launchVerifierWorker`. ~508 LOC.
5. **CLI commands** (lines 937-1272): `cmdRunItems`, `cmdStart`. ~335 LOC.

The most impactful decomposition:
- **Extract branch management** from `launchSingleItem` into a dedicated function (Finding 8). ~150 LOC moved into a focused helper.
- **Extract CLI commands** (`cmdRunItems`, `cmdStart`) into `core/commands/run-items.ts`. These are entry points, not launch logic. ~335 LOC.

**Estimated result:** `launch.ts` drops to ~600 LOC (launch functions + utilities), plus a new `run-items.ts` at ~335 LOC. No functional change.

### Can `mux.ts` be collapsed into `cmux.ts`?

Partially. The `Multiplexer` interface must remain as a separate export (it's the testability contract). But the `CmuxAdapter` class could be replaced by having `cmux.ts` export an object literal conforming to `Multiplexer`:

```typescript
// cmux.ts
export const cmuxMultiplexer: Multiplexer = {
  type: "cmux" as const,
  isAvailable: () => { ... },
  launchWorkspace: (cwd, command) => { ... },
  // ...
};
```

This would eliminate the passthrough class (~35 LOC) but lose the explicit interface conformance that `implements Multiplexer` provides. TypeScript's structural typing means the object literal would still be checked against the interface at usage sites.

The auto-launch logic (lines 142-257) is already cmux-specific and doesn't use the adapter. It could stay in `mux.ts` or move to a dedicated `auto-launch.ts`.

**Verdict:** The savings are small (~35 LOC) and the current structure is clear. Keep unless adding a second backend.

### Can message delivery be simplified?

The current flow: `sendMessageImpl` → `sendWithRetry` → `attemptSend` → paste-buffer → verify → [retry on failure]. The fallback: `attemptDirectSend` → cmux send → verify → [retry].

The retry layer (`sendWithRetry` in `delivery.ts`) adds ~17 LOC. The verification layer (`verifyDelivery` + `checkDelivery`) adds ~35 LOC. Together they add ~52 LOC to the message delivery path.

**Could retries be removed?** The paste-buffer path is reliable (atomic paste + explicit Return key). The retry is primarily for the keystroke fallback path. If the paste-buffer path is ~99% reliable, retries add marginal value.

**Could verification be removed?** Without verification, a failed delivery (message stuck in input field) would be undetected. The worker would appear to have received the message but would actually be idle. The activity timeout would eventually catch this (60 min), but that's a long delay.

**Verdict:** Keep both retries and verification. The 52 LOC cost is justified by the reliability improvement. The "silent success" issue (Finding 4) should be fixed, but the overall approach is sound.

### Is the three-layer health monitoring the minimum viable approach?

Yes. See Finding 14. Each layer addresses a distinct failure mode. A two-layer model (heartbeat + commits) would work only if heartbeating were instant and reliable from launch. The 30-60 second startup gap makes the liveness layer necessary.

The only simplification opportunity is caching the workspace listing (Finding 11), which reduces the cost of layer 2 without removing it.

### LOC Estimates for Simplification

| Action | LOC Change |
|---|---|
| Add launch cleanup on failure (Finding 1) | +15 LOC |
| Atomic partition allocation (Finding 2) | +10 LOC (replaces ~5 LOC) |
| Line-anchored error detection (Finding 3) | +10 LOC |
| Fix silent delivery assumption (Finding 4) | +15 LOC |
| Cache workspace listing (Findings 6, 11) | +15 LOC |
| Share `getAvailableMemory` (Finding 7) | +10 LOC (+ refactor) |
| Extract branch management (Finding 8) | 0 LOC (reorganization) |
| Add workspace close to `cleanSingleWorktree` (Finding 13) | +10 LOC |
| Extract CLI commands to `run-items.ts` (Theme B) | 0 LOC (reorganization) |
| **Net change** | **~+85 LOC** (all fixes, no removals) |

## Recommendations

**Priority 1 (High -- correctness risk):**
1. **Add cleanup-on-failure to `launchSingleItem`** (Finding 1). Worktree, partition, and index entry leak when later launch steps fail. ~15 LOC.
2. **Fix "silent success" in `verifyDelivery` for keystroke fallback** (Finding 4). Unverifiable keystroke deliveries should not be assumed successful. ~15 LOC.

**Priority 2 (Medium -- reliability/performance):**
3. **Use atomic file creation for partition allocation** (Finding 2). Prevents TOCTOU race between concurrent processes. ~10 LOC.
4. **Make error detection line-anchored** (Finding 3). Prevents false "error" health status from code content containing "Error:". ~10 LOC.
5. **Share `getAvailableMemory` between daemon and CLI** (Finding 7). `nw start` underreports available memory on macOS compared to `nw watch`. ~10 LOC.
6. **Cache workspace listing per poll cycle** (Findings 6, 11). Eliminates 4-9 redundant `cmux list-workspaces` calls per poll. ~15 LOC.

**Priority 3 (Low -- code quality):**
7. **Extract branch management from `launchSingleItem`** (Finding 8). 150 lines of branching logic into a focused helper. 0 LOC net.
8. **Add workspace close to `cleanSingleWorktree`** (Finding 13). Prevents orphaned terminal sessions. ~10 LOC.
9. **Extract CLI commands to `run-items.ts`** (Theme B). Drops `launch.ts` from 1,272 to ~600 LOC. 0 LOC net.

**Cross-references to Reviews 1-2:**
- Review 1 Finding 1 (OrchestratorItem/DaemonStateItem divergence): Confirmed impact -- `partition` and `workspaceRef` not being serialized means daemon restart loses worker management capability. `cleanupStalePartitions` mitigates the partition case but there's no recovery for lost workspace refs.
- Review 2 Finding 2 (stuckOrRetry doesn't reset lastCommitTime): Additionally, `stuckOrRetry` (`orchestrator.ts:940-951`) doesn't reset `lastScreenOutput`, which could show the previous attempt's error screen for the retried worker's diagnostics.
- Review 2 Finding 3 (WIP accounting gap): The memory WIP limit inconsistency (Finding 7 above) compounds this -- `nw start` under-allocates slots on macOS, so users running `nw start` may only get 1 slot even when 3-4 are feasible.
- Review 2 Finding 8 (debounce soundness): Confirmed from implementation side -- the workspace listing cache (Finding 11) would improve debounce accuracy by ensuring consistent readings within a poll cycle.
- Review 2 Finding 15 (launching state has no timeout): The launch resource leak (Finding 1 above) is the complementary issue -- workers stuck in launching consume resources that are never cleaned up until the next `cleanupStalePartitions` or manual `nw clean`.
