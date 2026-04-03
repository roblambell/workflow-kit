# Orchestrator merge detection failures from title collision check (2026-03-26)

## What happened
Three items (H-STP-1, M-SKL-1, M-TEL-1) were auto-merged via `gh pr merge --squash --auto` by workers, but the orchestrator never detected the merges. M-SKL-1 entered an infinite merge retry loop (~17s intervals, 20+ attempts). H-STP-1 stayed stuck in ci-pending for 76+ minutes despite its PR being merged. The supervisor correctly diagnosed the issues but couldn't force state transitions.

## Root causes found and fixed

### 1. Title collision check too aggressive (CRITICAL)
The `prTitleMatchesTodo` collision check (added in H-MID-1 / PR #206) was applied unconditionally to ALL merged PR detections. When the worker used a different PR title than the work item title (common -- workers often rephrase), the orchestrator dropped the merge detection entirely. Fix: skip title check when the orchestrator already tracks the PR number (`orchItem.prNumber === mergedPrNum`).

### 2. No merge retry limit
`executeMerge` had no retry counter. On failure, it transitioned back to ci-passed, which re-triggered the merge action on the next poll -- creating an infinite loop. Fix: added `mergeFailCount` on OrchestratorItem and `maxMergeRetries: 3` config. After 3 failures, item transitions to stuck.

### 3. No duplicate orchestrator prevention in foreground mode
The `isDaemonRunning` check only ran for `--daemon` mode. Three foreground orchestrator instances ran simultaneously (PIDs 15920, 77603, 80657), all writing to the same state file and creating status flickering. Fix: foreground mode now writes a PID file and checks for existing instances before starting.

## Impact
- All three items' PRs merged successfully but the orchestrator couldn't see it
- L-VIS-10 was blocked for the entire session (its deps never cleared)
- Workers were bombarded with 20+ incorrect health check messages
- Status display flickered between two incompatible states every 5 seconds
