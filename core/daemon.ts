// Daemon mode utilities: PID file management, state serialization, stale PID detection.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "fs";
import { dirname, join } from "path";
import type { OrchestratorItem } from "./orchestrator.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface DaemonStateItem {
  id: string;
  state: string;
  prNumber: number | null;
  title: string;
  lastTransition: string;
  ciFailCount: number;
  retryCount: number;
  /** cmux workspace reference for the review worker session. */
  reviewWorkspaceRef?: string;
  /** Whether this item's review has been completed (approved). */
  reviewCompleted?: boolean;
  /** Descriptive reason for failure (e.g., "launch-failed: repo not found", "ci-failed: test timeout"). */
  failureReason?: string;
  /** Dependency IDs for this item (omitted when empty). */
  dependencies?: string[];
  /** ISO timestamp of when the worker was launched. */
  startedAt?: string;
  /** ISO timestamp of when the worker completed or failed. */
  endedAt?: string;
  /** Exit code from the worker process (null when unknown). */
  exitCode?: number | null;
  /** Last lines of stderr captured from the worker on failure. */
  stderrTail?: string;
  /** ISO timestamp of the last comment check for this item's PR. */
  lastCommentCheck?: string;
  /** Whether a rebase request is in progress for this item. */
  rebaseRequested?: boolean;
  /** Whether a CI failure notification has been sent for the current failure. */
  ciFailureNotified?: boolean;
  /** The lastCommitTime when ciFailureNotified was set. */
  ciFailureNotifiedAt?: string | null;
}

export interface DaemonState {
  pid: number;
  startedAt: string;
  updatedAt: string;
  statusPaneRef?: string | null;
  wipLimit?: number;
  items: DaemonStateItem[];
}

// ── User state directory ─────────────────────────────────────────────

/**
 * Compute a stable per-project user state directory under ~/.ninthwave/projects/.
 * Uses a path-derived slug (replacing / with -) for uniqueness and readability,
 * matching the Claude Code convention (e.g., /Users/rob/code/proj → -Users-rob-code-proj).
 *
 * Runtime state files (PID, state, log, health-samples, etc.) are stored here
 * instead of inside the project, keeping them out of git.
 */
export function userStateDir(projectRoot: string): string {
  const home = process.env.HOME ?? "/tmp";
  const slug = projectRoot.replace(/\//g, "-");
  return join(home, ".ninthwave", "projects", slug);
}

// ── Paths ────────────────────────────────────────────────────────────

export function pidFilePath(projectRoot: string): string {
  return join(userStateDir(projectRoot), "orchestrator.pid");
}

export function stateFilePath(projectRoot: string): string {
  return join(userStateDir(projectRoot), "orchestrator.state.json");
}

export function logFilePath(projectRoot: string): string {
  return join(userStateDir(projectRoot), "orchestrator.log");
}

// ── Injectable I/O ───────────────────────────────────────────────────

export interface DaemonIO {
  writeFileSync: typeof writeFileSync;
  readFileSync: typeof readFileSync;
  unlinkSync: typeof unlinkSync;
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
}

const defaultIO: DaemonIO = {
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
};

// ── PID file management ──────────────────────────────────────────────

export function writePidFile(
  projectRoot: string,
  pid: number,
  io: DaemonIO = defaultIO,
): void {
  const filePath = pidFilePath(projectRoot);
  const dir = dirname(filePath);
  if (!io.existsSync(dir)) {
    io.mkdirSync(dir, { recursive: true });
  }
  io.writeFileSync(filePath, String(pid), "utf-8");
}

export function readPidFile(
  projectRoot: string,
  io: DaemonIO = defaultIO,
): number | null {
  const filePath = pidFilePath(projectRoot);
  if (!io.existsSync(filePath)) return null;
  try {
    const content = io.readFileSync(filePath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function cleanPidFile(
  projectRoot: string,
  io: DaemonIO = defaultIO,
): void {
  const filePath = pidFilePath(projectRoot);
  if (io.existsSync(filePath)) {
    try {
      io.unlinkSync(filePath);
    } catch {
      // ignore — best effort
    }
  }
}

// ── Process existence check ──────────────────────────────────────────

export type ProcessExistsCheck = (pid: number) => boolean;

/** Check if a process with the given PID exists by sending signal 0. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a daemon is running (PID file exists and process is alive).
 * Returns the PID if running, null otherwise.
 * Cleans up stale PID files from crashed daemons.
 */
export function isDaemonRunning(
  projectRoot: string,
  io: DaemonIO = defaultIO,
  check: ProcessExistsCheck = processExists,
): number | null {
  const pid = readPidFile(projectRoot, io);
  if (pid === null) return null;
  if (check(pid)) return pid;
  // Stale PID file — clean up
  cleanPidFile(projectRoot, io);
  cleanStateFile(projectRoot, io);
  return null;
}

// ── State file management ────────────────────────────────────────────

export function writeStateFile(
  projectRoot: string,
  state: DaemonState,
  io: DaemonIO = defaultIO,
): void {
  const filePath = stateFilePath(projectRoot);
  const dir = dirname(filePath);
  if (!io.existsSync(dir)) {
    io.mkdirSync(dir, { recursive: true });
  }
  io.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export function readStateFile(
  projectRoot: string,
  io: DaemonIO = defaultIO,
): DaemonState | null {
  const filePath = stateFilePath(projectRoot);
  if (!io.existsSync(filePath)) return null;
  try {
    const content = io.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as DaemonState;
  } catch {
    return null;
  }
}

export function cleanStateFile(
  projectRoot: string,
  io: DaemonIO = defaultIO,
): void {
  const filePath = stateFilePath(projectRoot);
  if (io.existsSync(filePath)) {
    try {
      io.unlinkSync(filePath);
    } catch {
      // ignore — best effort
    }
  }
}

/** Path to the state archive directory. */
export function stateArchiveDir(projectRoot: string): string {
  return join(userStateDir(projectRoot), "state-archive");
}

/**
 * Archive the current state file (if it exists) to `.ninthwave/state-archive/`.
 * The archived file is named with the original run's startedAt timestamp.
 * Returns the archive path if a file was archived, null otherwise.
 *
 * This should be called when a new daemon run starts, before writing a fresh state file.
 * It preserves the old state for debugging/analytics without mixing it with the new run.
 */
export function archiveStateFile(
  projectRoot: string,
  io: DaemonIO = defaultIO,
): string | null {
  const filePath = stateFilePath(projectRoot);
  if (!io.existsSync(filePath)) return null;

  try {
    const content = io.readFileSync(filePath, "utf-8");

    // Try to extract startedAt for a meaningful archive filename
    let timestamp: string;
    try {
      const state = JSON.parse(content) as DaemonState;
      // Use startedAt to identify which run this was from
      timestamp = state.startedAt.replace(/[:.]/g, "-");
    } catch {
      // Invalid JSON — use current time as fallback
      timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    }

    const archiveDir = stateArchiveDir(projectRoot);
    if (!io.existsSync(archiveDir)) {
      io.mkdirSync(archiveDir, { recursive: true });
    }

    const archivePath = join(archiveDir, `orchestrator.state.${timestamp}.json`);
    io.writeFileSync(archivePath, content, "utf-8");

    // Remove the original state file now that it's archived
    io.unlinkSync(filePath);

    return archivePath;
  } catch {
    // Best-effort — archiving failure should not block the new daemon
    return null;
  }
}

// ── Worker heartbeat I/O ─────────────────────────────────────────────

export interface WorkerProgress {
  id: string;
  progress: number;
  label: string;
  ts: string;
}

/** Directory for heartbeat files: ~/.ninthwave/projects/{slug}/heartbeats/ */
export function heartbeatDir(projectRoot: string): string {
  return join(userStateDir(projectRoot), "heartbeats");
}

/** Path to a single heartbeat file: ~/.ninthwave/projects/{slug}/heartbeats/{id}.json */
export function heartbeatFilePath(projectRoot: string, itemId: string): string {
  return join(heartbeatDir(projectRoot), `${itemId}.json`);
}

/** Read a heartbeat file. Returns null if the file doesn't exist or is invalid. */
export function readHeartbeat(
  projectRoot: string,
  itemId: string,
  io: DaemonIO = defaultIO,
): WorkerProgress | null {
  const filePath = heartbeatFilePath(projectRoot, itemId);
  if (!io.existsSync(filePath)) return null;
  try {
    const content = io.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as WorkerProgress;
  } catch {
    return null;
  }
}

/** Write a heartbeat file atomically. Creates the directory if needed. */
export function writeHeartbeat(
  projectRoot: string,
  id: string,
  progress: number,
  label: string,
  io: DaemonIO = defaultIO,
): void {
  const dir = heartbeatDir(projectRoot);
  if (!io.existsSync(dir)) {
    io.mkdirSync(dir, { recursive: true });
  }
  const data: WorkerProgress = {
    id,
    progress,
    label,
    ts: new Date().toISOString(),
  };
  io.writeFileSync(
    heartbeatFilePath(projectRoot, id),
    JSON.stringify(data, null, 2),
    "utf-8",
  );
}

// ── External review state ────────────────────────────────────────────

export type ExternalReviewState = "detected" | "reviewing" | "reviewed" | "done";

export interface ExternalReviewItem {
  prNumber: number;
  headBranch: string;
  author: string;
  state: ExternalReviewState;
  reviewWorkspaceRef?: string;
  lastReviewedCommit?: string;
  lastTransition: string;
}

export function externalReviewsPath(projectRoot: string): string {
  return join(userStateDir(projectRoot), "external-reviews.json");
}

export function readExternalReviews(
  projectRoot: string,
  io: DaemonIO = defaultIO,
): ExternalReviewItem[] {
  const filePath = externalReviewsPath(projectRoot);
  if (!io.existsSync(filePath)) return [];
  try {
    const content = io.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as ExternalReviewItem[];
  } catch {
    return [];
  }
}

export function writeExternalReviews(
  projectRoot: string,
  items: ExternalReviewItem[],
  io: DaemonIO = defaultIO,
): void {
  const filePath = externalReviewsPath(projectRoot);
  const dir = dirname(filePath);
  if (!io.existsSync(dir)) {
    io.mkdirSync(dir, { recursive: true });
  }
  io.writeFileSync(filePath, JSON.stringify(items, null, 2), "utf-8");
}

// ── State serialization from orchestrator items ──────────────────────

export function serializeOrchestratorState(
  items: OrchestratorItem[],
  pid: number,
  startedAt: string,
  extras?: { statusPaneRef?: string | null; wipLimit?: number },
): DaemonState {
  return {
    pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    ...extras,
    items: items.map((item) => ({
      id: item.id,
      state: item.state,
      prNumber: item.prNumber ?? null,
      title: item.todo.title,
      lastTransition: item.lastTransition,
      ciFailCount: item.ciFailCount,
      retryCount: item.retryCount,
      ...(item.reviewWorkspaceRef ? { reviewWorkspaceRef: item.reviewWorkspaceRef } : {}),
      ...(item.reviewCompleted ? { reviewCompleted: item.reviewCompleted } : {}),
      ...(item.failureReason ? { failureReason: item.failureReason } : {}),
      ...(item.todo.dependencies.length > 0 ? { dependencies: item.todo.dependencies } : {}),
      ...(item.startedAt ? { startedAt: item.startedAt } : {}),
      ...(item.endedAt ? { endedAt: item.endedAt } : {}),
      ...(item.exitCode != null ? { exitCode: item.exitCode } : {}),
      ...(item.stderrTail ? { stderrTail: item.stderrTail } : {}),
      ...(item.lastCommentCheck ? { lastCommentCheck: item.lastCommentCheck } : {}),
      ...(item.rebaseRequested ? { rebaseRequested: item.rebaseRequested } : {}),
      ...(item.ciFailureNotified ? { ciFailureNotified: item.ciFailureNotified } : {}),
      ...(item.ciFailureNotifiedAt ? { ciFailureNotifiedAt: item.ciFailureNotifiedAt } : {}),
    })),
  };
}

// ── Runtime state migration ─────────────────────────────────────────

/** Runtime state files that should live in the user state directory. */
const RUNTIME_STATE_FILES = [
  "orchestrator.pid",
  "orchestrator.state.json",
  "orchestrator.log",
  "health-samples.jsonl",
  "version",
  "external-reviews.json",
];

/**
 * Migrate runtime state files from the old `.ninthwave/` project location
 * to the new `~/.ninthwave/projects/<slug>/` user state directory.
 *
 * This is a one-time, idempotent migration:
 * - Only moves files that exist in the old location and NOT in the new location
 * - Removes old files after successful copy
 * - Best-effort — failures are silently ignored (files will be recreated)
 * - Also migrates the `state-archive/` directory
 *
 * Safe to call repeatedly — no-ops when nothing to migrate.
 */
export function migrateRuntimeState(projectRoot: string): void {
  const newDir = userStateDir(projectRoot);
  const oldDir = join(projectRoot, ".ninthwave");

  if (!existsSync(oldDir)) return;

  let dirCreated = false;
  const ensureDir = () => {
    if (!dirCreated) {
      mkdirSync(newDir, { recursive: true });
      dirCreated = true;
    }
  };

  // Migrate individual files
  for (const file of RUNTIME_STATE_FILES) {
    const oldPath = join(oldDir, file);
    const newPath = join(newDir, file);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      try {
        ensureDir();
        writeFileSync(newPath, readFileSync(oldPath, "utf-8"), "utf-8");
        unlinkSync(oldPath);
      } catch {
        // best-effort — file will be recreated on next write
      }
    } else if (existsSync(oldPath) && existsSync(newPath)) {
      // New location already has the file — just clean up old copy
      try {
        unlinkSync(oldPath);
      } catch {
        // best-effort
      }
    }
  }

  // Migrate state-archive directory
  const oldArchive = join(oldDir, "state-archive");
  if (existsSync(oldArchive)) {
    const newArchive = join(newDir, "state-archive");
    try {
      mkdirSync(newArchive, { recursive: true });
      const entries = readdirSync(oldArchive);
      for (const entry of entries) {
        const oldFile = join(oldArchive, entry);
        const newFile = join(newArchive, entry);
        if (!existsSync(newFile)) {
          writeFileSync(newFile, readFileSync(oldFile, "utf-8"), "utf-8");
        }
        try {
          unlinkSync(oldFile);
        } catch {
          // best-effort
        }
      }
      // Remove old archive directory if now empty
      try {
        if (readdirSync(oldArchive).length === 0) {
          rmSync(oldArchive, { recursive: true });
        }
      } catch {
        // best-effort
      }
    } catch {
      // best-effort — archive will be recreated
    }
  }
}
