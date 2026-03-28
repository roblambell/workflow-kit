// Schedule state: read/write per-project schedule state for scheduled task execution.
// State file lives at ~/.ninthwave/projects/{slug}/schedule-state.json.
// Handles corrupt JSON (reset to empty + warn) and missing file (return empty state).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { userStateDir } from "./daemon.ts";

// ── Types ────────────────────────────────────────────────────────────

/** Per-task history entry recording when a scheduled task last ran and its outcome. */
export interface ScheduleTaskRecord {
  /** ISO timestamp of when the task was last launched (set before launch for double-fire prevention). */
  lastRunAt: string;
}

/** Active worker entry tracking a running scheduled task worker. */
export interface ScheduleWorkerEntry {
  taskId: string;
  workspaceRef: string;
  startedAt: string;
}

/** Persistent schedule state for a project. */
export interface ScheduleState {
  /** Per-task run history keyed by task ID. */
  tasks: Record<string, ScheduleTaskRecord>;
  /** Task IDs waiting for a WIP slot to open. */
  queued: string[];
  /** Currently running scheduled task workers. */
  active: ScheduleWorkerEntry[];
}

// ── Paths ────────────────────────────────────────────────────────────

/** Path to the schedule state file for a project. */
export function scheduleStatePath(projectRoot: string): string {
  return join(userStateDir(projectRoot), "schedule-state.json");
}

// ── Read/Write ──────────────────────────────────────────────────────

/** Return a fresh empty state. */
export function emptyScheduleState(): ScheduleState {
  return { tasks: {}, queued: [], active: [] };
}

/**
 * Read schedule state from disk.
 * Returns empty state on missing file or corrupt JSON (with console warning).
 */
export function readScheduleState(
  projectRoot: string,
  io: ScheduleStateIO = defaultScheduleStateIO,
): ScheduleState {
  const filePath = scheduleStatePath(projectRoot);
  if (!io.existsSync(filePath)) return emptyScheduleState();

  try {
    const content = io.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as Partial<ScheduleState>;

    // Validate structure -- reset fields that are missing or wrong type
    return {
      tasks: parsed.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {},
      queued: Array.isArray(parsed.queued) ? parsed.queued : [],
      active: Array.isArray(parsed.active) ? parsed.active : [],
    };
  } catch {
    console.warn(
      `[ninthwave] warning: corrupt schedule-state.json at ${filePath}, resetting to empty`,
    );
    return emptyScheduleState();
  }
}

/**
 * Write schedule state to disk atomically.
 * Creates the directory if needed.
 */
export function writeScheduleState(
  projectRoot: string,
  state: ScheduleState,
  io: ScheduleStateIO = defaultScheduleStateIO,
): void {
  const filePath = scheduleStatePath(projectRoot);
  const dir = dirname(filePath);
  if (!io.existsSync(dir)) {
    io.mkdirSync(dir, { recursive: true });
  }
  io.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

// ── Injectable I/O ──────────────────────────────────────────────────

export interface ScheduleStateIO {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf-8") => string;
  writeFileSync: (path: string, data: string, encoding: "utf-8") => void;
  mkdirSync: (path: string, options: { recursive: true }) => void;
}

const defaultScheduleStateIO: ScheduleStateIO = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  writeFileSync: (path, data, encoding) => writeFileSync(path, data, encoding),
  mkdirSync: (path, options) => mkdirSync(path, options),
};
