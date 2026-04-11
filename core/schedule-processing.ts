// Scheduled task processing: checks due tasks, launches workers, monitors completion.
// Extracted from core/commands/orchestrate.ts for modularity.

import type { Orchestrator } from "./orchestrator.ts";
import type { LogEntry } from "./types.ts";
import type { ScheduledTask } from "./types.ts";
import type { ScheduleState } from "./schedule-state.ts";
import {
  checkSchedules,
  computeScheduleTime,
  processScheduleQueue,
  monitorScheduleWorkers,
  processTriggerFiles,
  type MonitorScheduleDeps,
  type ScheduleClaimResult,
} from "./schedule-runner.ts";
import {
  appendHistoryEntry,
  type ScheduleHistoryIO,
  type ScheduleHistoryEntry,
} from "./schedule-history.ts";

// ── Scheduled task loop dependencies ────────────────────────────────────────

/** Dependencies for scheduled task processing within the orchestrate loop. */
export interface ScheduleLoopDeps {
  /** List all scheduled tasks from the schedules directory. */
  listScheduledTasks: () => ScheduledTask[];
  /** Read schedule state from disk. */
  readState: (projectRoot: string) => ScheduleState;
  /** Write schedule state to disk. */
  writeState: (projectRoot: string, state: ScheduleState) => void;
  /** Launch a scheduled task worker. Returns workspace ref or null. */
  launchWorker: (task: ScheduledTask, projectRoot: string, aiTool: string) => string | null | Promise<string | null>;
  /** Claim a schedule run before launch. Omit in solo mode. */
  claimScheduleRun?: (taskId: string, scheduleTime: string) => Promise<ScheduleClaimResult>;
  /** Monitor deps (workspace listing + close). */
  monitorDeps: MonitorScheduleDeps;
  /** AI tool identifier for worker launch commands. */
  aiTool: string;
  /** Path to the schedule triggers directory. */
  triggerDir: string;
  /** Append a history entry. Injected for testability. */
  appendHistory?: (projectRoot: string, entry: ScheduleHistoryEntry, io?: ScheduleHistoryIO) => void;
}

// ── Scheduled task processing ────────────────────────────────────────

/**
 * Process scheduled tasks: check for due tasks, handle triggers, monitor workers, manage queue.
 *
 * This is called from the orchestrate loop on a 30s interval. It:
 * 1. Reads schedule state from disk
 * 2. Monitors active workers (detect completion/timeout/crash)
 * 3. Checks for trigger files from `nw schedule run`
 * 4. Checks which tasks are due based on cron schedule
 * 5. Queues or launches tasks based on session availability
 * 6. Writes updated state back to disk
 */
export async function processScheduledTasks(
  projectRoot: string,
  orch: Orchestrator,
  deps: ScheduleLoopDeps,
  log: (entry: LogEntry) => void,
  effectiveSessionLimit: number,
): Promise<void> {
  const tasks = deps.listScheduledTasks();
  if (tasks.length === 0) return;

  const state = deps.readState(projectRoot);
  const now = new Date();
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // 1. Monitor active workers
  const writeHistory = deps.appendHistory ?? appendHistoryEntry;
  // Build a lookup for active worker start times (needed for history entries)
  const workerStartMap = new Map<string, string>();
  for (const w of state.active) {
    workerStartMap.set(w.taskId, w.startedAt);
  }

  if (state.active.length > 0) {
    const results = monitorScheduleWorkers(state, tasks, now, deps.monitorDeps);
    const completedIds: string[] = [];
    const timedOutIds: string[] = [];

    for (const [taskId, result] of results) {
      const startedAt = workerStartMap.get(taskId) ?? now.toISOString();
      const durationMs = now.getTime() - new Date(startedAt).getTime();

      if (result.status === "completed") {
        completedIds.push(taskId);
        log({
          ts: now.toISOString(),
          level: "info",
          event: "schedule-completed",
          taskId,
          durationMs,
          result: "success",
        });
        // Write history entry
        try {
          writeHistory(projectRoot, {
            taskId,
            startedAt,
            endedAt: now.toISOString(),
            result: "success",
            durationMs,
          });
        } catch { /* best-effort history write */ }
      } else if (result.status === "timeout") {
        timedOutIds.push(taskId);
        log({
          ts: now.toISOString(),
          level: "warn",
          event: "schedule-completed",
          taskId,
          durationMs: result.elapsedMs,
          result: "timeout",
        });
        // Write history entry
        try {
          writeHistory(projectRoot, {
            taskId,
            startedAt,
            endedAt: now.toISOString(),
            result: "timeout",
            durationMs: result.elapsedMs,
          });
        } catch { /* best-effort history write */ }
      } else if (result.status === "crashed") {
        completedIds.push(taskId);
        log({
          ts: now.toISOString(),
          level: "warn",
          event: "schedule-completed",
          taskId,
          durationMs,
          result: "error",
        });
        // Write history entry
        try {
          writeHistory(projectRoot, {
            taskId,
            startedAt,
            endedAt: now.toISOString(),
            result: "error",
            durationMs,
          });
        } catch { /* best-effort history write */ }
      }
    }

    // Remove completed/timed-out workers from active list
    const removeIds = new Set([...completedIds, ...timedOutIds]);
    state.active = state.active.filter((w) => !removeIds.has(w.taskId));
  }

  // 2. Check for trigger files
  const triggered = processTriggerFiles(projectRoot, deps.triggerDir);
  const activeIds = new Set(state.active.map((w) => w.taskId));
  const queuedIds = new Set(state.queued);

  for (const taskId of triggered) {
    if (!taskMap.has(taskId)) {
      log({
        ts: now.toISOString(),
        level: "warn",
        event: "schedule-skipped",
        taskId,
        reason: "trigger-unknown-task",
      });
      continue;
    }
    if (activeIds.has(taskId) || queuedIds.has(taskId)) {
      log({
        ts: now.toISOString(),
        level: "info",
        event: "schedule-skipped",
        taskId,
        reason: "already-running",
      });
      continue;
    }
    log({
      ts: now.toISOString(),
      level: "info",
      event: "schedule-triggered",
      taskId,
      triggerType: "manual",
      scheduleTime: now.toISOString(),
    });
    // Add to front of queue for priority processing
    state.queued.unshift(taskId);
    queuedIds.add(taskId);
  }

  // 3. Check which tasks are due based on cron schedule
  const dueTasks = checkSchedules(tasks, state, now);
  for (const taskId of dueTasks) {
    if (!queuedIds.has(taskId)) {
      log({
        ts: now.toISOString(),
        level: "info",
        event: "schedule-triggered",
        taskId,
        triggerType: "cron",
        scheduleTime: now.toISOString(),
      });
      state.queued.push(taskId);
    }
  }

  // 4. Process queue: launch tasks when session slots are available
  // Scheduled tasks consume from the shared session pool
  const activeWorkItemCount = orch.getAllItems()
    .filter((i) => !["done", "stuck", "ready", "queued"].includes(i.state)).length;
  const activeScheduleCount = state.active.length;
  const freeSlots = Math.max(0, effectiveSessionLimit - activeWorkItemCount - activeScheduleCount);

  const { toLaunch, remainingQueue } = processScheduleQueue(state, freeSlots);
  state.queued = remainingQueue;

  for (const taskId of toLaunch) {
    const task = taskMap.get(taskId);
    if (!task) continue;

    const scheduleTime = computeScheduleTime(now);
    const claimResult = deps.claimScheduleRun
      ? await deps.claimScheduleRun(task.id, scheduleTime)
      : { action: "launch", reason: "solo" } satisfies ScheduleClaimResult;

    if (claimResult.action === "skip") {
      state.tasks[task.id] = { lastRunAt: scheduleTime };
      log({
        ts: now.toISOString(),
        level: claimResult.reason === "crew-disconnected" ? "warn" : "info",
        event: "schedule-skipped",
        taskId: task.id,
        reason: claimResult.reason,
      });
      continue;
    }

    // Double-fire prevention: update lastRunAt BEFORE launching worker
    // Uses the scheduled fire minute shared with broker claims.
    state.tasks[task.id] = { lastRunAt: scheduleTime };

    const ref = await deps.launchWorker(task, projectRoot, deps.aiTool);
    if (ref) {
      state.active.push({
        taskId: task.id,
        workspaceRef: ref,
        startedAt: now.toISOString(),
      });
      log({
        ts: now.toISOString(),
        level: "info",
        event: "schedule-triggered",
        taskId: task.id,
        triggerType: "launch",
        workspaceRef: ref,
        claimReason: claimResult.reason,
      });
    } else {
      log({
        ts: now.toISOString(),
        level: "warn",
        event: "schedule-error",
        taskId: task.id,
        error: "launch-failed",
      });
    }
  }

  // Log session-limit-full queueing
  if (state.queued.length > 0 && freeSlots === 0) {
    for (const queuedTaskId of state.queued) {
      log({
        ts: now.toISOString(),
        level: "info",
        event: "schedule-skipped",
        taskId: queuedTaskId,
        reason: "session-limit-full-queued",
      });
    }
  }

  // 5. Write updated state
  deps.writeState(projectRoot, state);
}
