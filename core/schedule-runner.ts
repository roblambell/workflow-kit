// Schedule runner: check schedules, launch workers, monitor liveness, manage session queueing.
// Pure functions with injected dependencies for testability.

import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { isDue } from "./schedule-eval.ts";
import { userStateDir as userStateDirFn } from "./daemon.ts";
import type { ScheduledTask } from "./types.ts";
import type {
  ScheduleState,
  ScheduleWorkerEntry,
} from "./schedule-state.ts";
import type { CrewBroker } from "./crew.ts";
import { isAiToolId, getToolProfile } from "./ai-tools.ts";

// ── Check schedules ─────────────────────────────────────────────────

/**
 * Determine which scheduled tasks are due to fire right now.
 *
 * A task is due when:
 * 1. It is enabled
 * 2. isDue() returns true (cron matches + not double-fired)
 * 3. It is not already running (no active worker entry)
 * 4. It is not already queued
 *
 * Returns task IDs that should be launched or queued.
 */
export function checkSchedules(
  tasks: ScheduledTask[],
  state: ScheduleState,
  now: Date,
): string[] {
  const activeIds = new Set(state.active.map((w) => w.taskId));
  const queuedIds = new Set(state.queued);
  const due: string[] = [];

  for (const task of tasks) {
    if (!task.enabled) continue;
    if (activeIds.has(task.id)) continue;
    if (queuedIds.has(task.id)) continue;

    const lastRunAt = state.tasks[task.id]?.lastRunAt
      ? new Date(state.tasks[task.id]!.lastRunAt)
      : null;

    if (isDue(task.scheduleCron, lastRunAt, now)) {
      due.push(task.id);
    }
  }

  return due;
}

// ── Process schedule queue ──────────────────────────────────────────

/**
 * Result of processing the schedule queue: tasks to launch and updated queue.
 */
export interface ProcessQueueResult {
  /** Task IDs that should be launched now. */
  toLaunch: string[];
  /** Updated queue (tasks still waiting for session slots). */
  remainingQueue: string[];
}

/**
 * Dequeue tasks from the schedule queue when session slots are available.
 *
 * Scheduled tasks consume from the shared memory-aware session pool.
 *
 * @param state       Current schedule state
 * @param availableSessionSlots    Number of free session slots available for scheduled tasks
 * @returns           Tasks to launch and remaining queue
 */
export function processScheduleQueue(
  state: ScheduleState,
  availableSessionSlots: number,
): ProcessQueueResult {
  if (state.queued.length === 0 || availableSessionSlots <= 0) {
    return { toLaunch: [], remainingQueue: [...state.queued] };
  }

  const slotsToUse = Math.min(availableSessionSlots, state.queued.length);
  const toLaunch = state.queued.slice(0, slotsToUse);
  const remainingQueue = state.queued.slice(slotsToUse);

  return { toLaunch, remainingQueue };
}

// ── Launch scheduled task ───────────────────────────────────────────

/** Dependencies for launching a scheduled task worker. */
export interface LaunchScheduledDeps {
  /** Create a cmux workspace. Returns workspace ref or null. */
  launchWorkspace: (cwd: string, command: string, workItemId?: string) => string | null;
}

/**
 * Launch a scheduled task worker.
 *
 * Creates a cmux workspace and launches an AI worker with the task prompt
 * on the main branch (no worktree -- scheduled tasks run on main).
 *
 * Returns the workspace ref on success, null on failure.
 */
export function launchScheduledTask(
  task: ScheduledTask,
  projectRoot: string,
  aiTool: string,
  deps: LaunchScheduledDeps,
): string | null {
  // Build the worker command: launch AI tool with the task prompt
  // The prompt instructs the worker to commit work items to a branch and push.
  const escapedPrompt = task.prompt
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");

  // For known AI tools, derive the command name from the profile (makes derivation
  // explicit and ensures future profiles stay consistent); for custom tools
  // (--tool override), use the raw string as-is.
  const toolCmd = isAiToolId(aiTool) ? getToolProfile(aiTool).id : aiTool;
  const command = `cd "${projectRoot}" && ${toolCmd} --print "${escapedPrompt}"`;

  const ref = deps.launchWorkspace(projectRoot, command, `schedule-${task.id}`);
  return ref;
}

// ── Monitor schedule workers ────────────────────────────────────────

/** Outcome of monitoring a single worker. */
export type WorkerMonitorResult =
  | { status: "running" }
  | { status: "completed" }
  | { status: "timeout"; elapsedMs: number }
  | { status: "crashed" };

/** Dependencies for monitoring schedule workers. */
export interface MonitorScheduleDeps {
  /** List all workspaces (raw output string). */
  listWorkspaces: () => string;
  /** Close a workspace. Returns true on success. */
  closeWorkspace: (ref: string) => boolean;
}

/**
 * Check if a scheduled task worker is still alive.
 *
 * Uses the same pattern as isWorkerAlive in orchestrate.ts:
 * checks if the workspace ref appears in the workspace listing.
 */
export function isScheduleWorkerAlive(
  worker: ScheduleWorkerEntry,
  deps: MonitorScheduleDeps,
): boolean {
  const workspaces = deps.listWorkspaces();
  if (!workspaces) return false;
  const escapedRef = worker.workspaceRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const refRe = new RegExp(`(^|\\s)${escapedRef}($|\\s)`);
  return workspaces.split("\n").some((line) => refRe.test(line));
}

/**
 * Monitor all active schedule workers.
 *
 * For each active worker:
 * - Check liveness via workspace listing
 * - Kill and record error on timeout
 * - Record success on worker exit (workspace no longer present)
 *
 * Returns a map of taskId -> outcome for each worker that needs state updates.
 */
export function monitorScheduleWorkers(
  state: ScheduleState,
  tasks: ScheduledTask[],
  now: Date,
  deps: MonitorScheduleDeps,
): Map<string, WorkerMonitorResult> {
  const results = new Map<string, WorkerMonitorResult>();
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  for (const worker of state.active) {
    const alive = isScheduleWorkerAlive(worker, deps);

    if (alive) {
      // Check timeout
      const elapsed = now.getTime() - new Date(worker.startedAt).getTime();
      const task = taskMap.get(worker.taskId);
      const timeout = task?.timeout ?? 30 * 60 * 1000; // default 30m

      if (elapsed > timeout) {
        // Kill the workspace
        deps.closeWorkspace(worker.workspaceRef);
        results.set(worker.taskId, { status: "timeout", elapsedMs: elapsed });
      } else {
        results.set(worker.taskId, { status: "running" });
      }
    } else {
      // Workspace is gone -- worker completed or crashed
      // We treat workspace disappearance as completion (workers exit cleanly)
      results.set(worker.taskId, { status: "completed" });
    }
  }

  return results;
}

// ── Trigger file processing ─────────────────────────────────────────

/**
 * Check for trigger files in the schedule-triggers directory.
 *
 * Trigger files are created by `nw schedule run <task-id>` and contain
 * the task ID to force-fire. Each file is processed and deleted.
 *
 * @returns Array of task IDs to trigger immediately.
 */
export function processTriggerFiles(
  projectRoot: string,
  triggerDir: string,
  io: TriggerFileIO = defaultTriggerFileIO,
): string[] {
  if (!io.existsSync(triggerDir)) return [];

  const triggered: string[] = [];
  const entries = io.readdirSync(triggerDir);

  for (const entry of entries) {
    if (!entry.endsWith(".trigger")) continue;
    const filePath = join(triggerDir, entry);
    try {
      // The filename is the task ID: e.g. "daily-test-run.trigger"
      const taskId = entry.replace(/\.trigger$/, "");
      triggered.push(taskId);
      // Delete the trigger file
      io.unlinkSync(filePath);
    } catch {
      // Best-effort -- skip unreadable trigger files
    }
  }

  return triggered;
}

/** Injectable I/O for trigger file processing. */
export interface TriggerFileIO {
  existsSync: (path: string) => boolean;
  readdirSync: (path: string) => string[];
  unlinkSync: (path: string) => void;
}

const defaultTriggerFileIO: TriggerFileIO = {
  existsSync,
  readdirSync,
  unlinkSync,
};

// ── Schedule claim (crew mode) ─────────────────────────────────────

/** Result of a schedule claim attempt. */
export type ScheduleClaimResult =
  | { action: "launch"; reason: "solo" | "crew-granted" }
  | { action: "skip"; reason: "crew-denied" | "crew-disconnected" };

/**
 * Compute the schedule fire time for crew claim deduplication.
 *
 * Truncates to minute precision so all daemons polling at the same
 * cron minute generate the same key for the broker.
 */
export function computeScheduleTime(now: Date): string {
  const truncated = new Date(now);
  truncated.setSeconds(0, 0);
  return truncated.toISOString();
}

/**
 * Attempt to claim a schedule slot via the crew broker before launching.
 *
 * - Solo mode (no broker): always returns "launch" with reason "solo".
 * - Crew mode, connected: calls scheduleClaim(). Granted -> "launch".
 *   Denied -> "skip" with reason "crew-denied".
 * - Crew mode, disconnected: skips with reason "crew-disconnected".
 */
export async function tryScheduleClaim(
  crewBroker: CrewBroker | null | undefined,
  taskId: string,
  scheduleTime: string,
): Promise<ScheduleClaimResult> {
  // Solo mode -- no broker
  if (!crewBroker) {
    return { action: "launch", reason: "solo" };
  }

  // Crew mode but disconnected -- skip safely instead of falling back to solo
  if (!crewBroker.isConnected()) {
    return { action: "skip", reason: "crew-disconnected" };
  }

  // Try to claim via the broker
  try {
    const granted = await crewBroker.scheduleClaim(taskId, scheduleTime);
    if (granted) {
      return { action: "launch", reason: "crew-granted" };
    }
    return { action: "skip", reason: "crew-denied" };
  } catch {
    // Claim failed (e.g., WS disconnected mid-request) -- skip safely
    return { action: "skip", reason: "crew-disconnected" };
  }
}

// ── Schedule triggers directory ─────────────────────────────────────

/** Path to the schedule triggers directory for a project. */
export function scheduleTriggerDir(projectRoot: string): string {
  // Import userStateDir at module top level
  return join(userStateDirFn(projectRoot), "schedule-triggers");
}
