// Daemon mode utilities: PID file management, state serialization, stale PID detection,
// and daemon fork (detached background process launch).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
} from "fs";
import { dirname, join } from "path";
import { spawn as nodeSpawn } from "node:child_process";
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
  /** Number of review rounds completed. */
  reviewRound?: number;
  /** Whether a CI failure notification has been sent for the current failure. */
  ciFailureNotified?: boolean;
  /** The lastCommitTime when ciFailureNotified was set. */
  ciFailureNotifiedAt?: string | null;
  /** cmux workspace reference for the rebaser worker session (rebase-only). */
  rebaserWorkspaceRef?: string;
  /** SHA of the merge commit on main (for post-merge CI fix-forward). */
  mergeCommitSha?: string;
  /** Number of times CI fix-forward on main has failed. */
  fixForwardFailCount?: number;
  /** cmux workspace reference for the forward-fixer worker session. */
  fixForwardWorkspaceRef?: string;
  /** Absolute path to the preserved worktree directory (set for stuck items). */
  worktreePath?: string;
  /** cmux workspace reference for the implementation worker session. */
  workspaceRef?: string;
  /** Test partition number assigned to this worker. */
  partition?: number;
  /** Absolute path to the repo where the PR lives (for cross-repo items). */
  resolvedRepoRoot?: string;
  /** AI tool used for this item's implementation worker. */
  aiTool?: string;
}

export interface DaemonState {
  pid: number;
  startedAt: string;
  updatedAt: string;
  statusPaneRef?: string | null;
  wipLimit?: number;
  /** Operator identity (git email of the human running this daemon). */
  operatorId?: string;
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

export function preferencesFilePath(projectRoot: string): string {
  return join(userStateDir(projectRoot), "preferences.json");
}

// ── Layout preference persistence ───────────────────────────────────

export type LayoutPreference = "split" | "logs-only" | "status-only";

/**
 * Read the persisted layout preference for a project.
 * Returns "split" (the default) when the file is missing or contains invalid JSON.
 */
export function readLayoutPreference(projectRoot: string): LayoutPreference {
  const filePath = preferencesFilePath(projectRoot);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const mode = parsed?.panelMode;
    if (mode === "split" || mode === "logs-only" || mode === "status-only") {
      return mode;
    }
  } catch {
    // Missing file or corrupt JSON -- fall through to default
  }
  return "split";
}

/**
 * Write the layout preference for a project.
 * Creates the state directory if needed.
 */
export function writeLayoutPreference(projectRoot: string, mode: LayoutPreference): void {
  const filePath = preferencesFilePath(projectRoot);
  const dir = userStateDir(projectRoot);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify({ panelMode: mode }) + "\n");
  } catch {
    // Non-fatal -- preference write failure shouldn't crash the TUI
  }
}

// ── Injectable I/O ───────────────────────────────────────────────────

export interface DaemonIO {
  writeFileSync: typeof writeFileSync;
  readFileSync: typeof readFileSync;
  unlinkSync: typeof unlinkSync;
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  renameSync: typeof renameSync;
}

const defaultIO: DaemonIO = {
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  renameSync,
};

// ── PID file management ──────────────────────────────────────────────

/**
 * Write the daemon PID file with exclusive creation.
 * Uses O_CREAT | O_EXCL (flag: 'wx') to prevent two concurrent daemons from
 * both claiming the PID file. If the file already exists, throws EEXIST.
 */
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
  io.writeFileSync(filePath, String(pid), { flag: "wx" });
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
      // ignore -- best effort
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
  // Stale PID file -- clean up
  cleanPidFile(projectRoot, io);
  cleanStateFile(projectRoot, io);
  return null;
}

// ── State file management ────────────────────────────────────────────

/**
 * Write the daemon state file atomically.
 * Writes to a `.tmp` file first, then renames to the target path.
 * `renameSync` is atomic on POSIX -- the file either has old content or new
 * content, never partial JSON.
 */
export function writeStateFile(
  projectRoot: string,
  state: DaemonState,
  io: DaemonIO = defaultIO,
): void {
  const filePath = stateFilePath(projectRoot);
  const tmpPath = filePath + ".tmp";
  const dir = dirname(filePath);
  if (!io.existsSync(dir)) {
    io.mkdirSync(dir, { recursive: true });
  }
  io.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  io.renameSync(tmpPath, filePath);
}

/**
 * Read and validate the daemon state file.
 * Returns null (same as corrupt file) if the JSON fails shape validation:
 * - `items` must be an array
 * - Each item must have `id` (string) and `state` (string)
 *
 * This catches partially-written or schema-migrated state files before they
 * cause runtime errors.
 */
export function readStateFile(
  projectRoot: string,
  io: DaemonIO = defaultIO,
): DaemonState | null {
  const filePath = stateFilePath(projectRoot);
  if (!io.existsSync(filePath)) return null;
  try {
    const content = io.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    if (!validateDaemonState(parsed)) {
      return null;
    }
    return parsed as DaemonState;
  } catch {
    return null;
  }
}

/**
 * Lightweight shape validator for DaemonState.
 * Checks that `items` is an array and each item has `id` (string) and `state` (string).
 */
function validateDaemonState(obj: unknown): boolean {
  if (obj === null || typeof obj !== "object") return false;
  const record = obj as Record<string, unknown>;
  if (!Array.isArray(record.items)) return false;
  for (const item of record.items) {
    if (item === null || typeof item !== "object") return false;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.state !== "string") return false;
  }
  return true;
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
      // ignore -- best effort
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
      // Invalid JSON -- use current time as fallback
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
    // Best-effort -- archiving failure should not block the new daemon
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

// ── Review verdict ──────────────────────────────────────────────────

/** Structured verdict written by the review worker for the orchestrator to consume. */
export interface ReviewVerdict {
  verdict: "approve" | "request-changes";
  summary: string;
  blockingCount: number;
  nonBlockingCount: number;
  /** Architecture quality: modularity, separation of concerns, appropriate abstractions (1-10). */
  architectureScore: number;
  /** Code quality: readability, naming, error handling, idiomatic patterns (1-10). */
  codeQualityScore: number;
  /** Performance: no regressions, efficient algorithms, resource management (1-10). */
  performanceScore: number;
  /** Test coverage: new code tested, edge cases covered, assertions meaningful (1-10). */
  testCoverageScore: number;
  /** Count of unresolved design decisions or ambiguities the implementer should address. */
  unresolvedDecisions: number;
  /** Count of critical gaps: missing error handling, security issues, data loss risks. */
  criticalGaps: number;
  /** Overall confidence in the review: how thoroughly the reviewer understood the change (1-10). */
  confidence: number;
}

/** Read a verdict file. Returns null if the file doesn't exist or is invalid. */
export function readVerdictFile(
  filePath: string,
  io: DaemonIO = defaultIO,
): ReviewVerdict | null {
  if (!io.existsSync(filePath)) return null;
  try {
    const content = io.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as ReviewVerdict;
  } catch {
    return null;
  }
}

// ── Heartbeat ───────────────────────────────────────────────────────

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
  extras?: { statusPaneRef?: string | null; wipLimit?: number; operatorId?: string },
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
      title: item.workItem.title,
      lastTransition: item.lastTransition,
      ciFailCount: item.ciFailCount,
      retryCount: item.retryCount,
      ...(item.reviewWorkspaceRef ? { reviewWorkspaceRef: item.reviewWorkspaceRef } : {}),
      ...(item.reviewCompleted ? { reviewCompleted: item.reviewCompleted } : {}),
      ...(item.reviewRound ? { reviewRound: item.reviewRound } : {}),
      ...(item.failureReason ? { failureReason: item.failureReason } : {}),
      ...(item.workItem.dependencies.length > 0 ? { dependencies: item.workItem.dependencies } : {}),
      ...(item.startedAt ? { startedAt: item.startedAt } : {}),
      ...(item.endedAt ? { endedAt: item.endedAt } : {}),
      ...(item.exitCode != null ? { exitCode: item.exitCode } : {}),
      ...(item.stderrTail ? { stderrTail: item.stderrTail } : {}),
      ...(item.lastCommentCheck ? { lastCommentCheck: item.lastCommentCheck } : {}),
      ...(item.rebaseRequested ? { rebaseRequested: item.rebaseRequested } : {}),
      ...(item.ciFailureNotified ? { ciFailureNotified: item.ciFailureNotified } : {}),
      ...(item.ciFailureNotifiedAt ? { ciFailureNotifiedAt: item.ciFailureNotifiedAt } : {}),
      ...(item.rebaserWorkspaceRef ? { rebaserWorkspaceRef: item.rebaserWorkspaceRef } : {}),
      ...(item.mergeCommitSha ? { mergeCommitSha: item.mergeCommitSha } : {}),
      ...(item.fixForwardFailCount ? { fixForwardFailCount: item.fixForwardFailCount } : {}),
      ...(item.fixForwardWorkspaceRef ? { fixForwardWorkspaceRef: item.fixForwardWorkspaceRef } : {}),
      ...(item.worktreePath ? { worktreePath: item.worktreePath } : {}),
      ...(item.workspaceRef ? { workspaceRef: item.workspaceRef } : {}),
      ...(item.partition != null ? { partition: item.partition } : {}),
      ...(item.resolvedRepoRoot ? { resolvedRepoRoot: item.resolvedRepoRoot } : {}),
      ...(item.aiTool ? { aiTool: item.aiTool } : {}),
    })),
  };
}

// ── Log rotation ────────────────────────────────────────────────────

/** Injectable I/O for log rotation (separate from DaemonIO to avoid breaking existing callers). */
export interface LogRotateIO {
  existsSync: typeof existsSync;
  statSync: typeof statSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}

const defaultLogRotateIO: LogRotateIO = {
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
};

/**
 * Rotate a log file if it exceeds `maxBytes`.
 *
 * Shifts existing rotations: `.{maxFiles}` is deleted, `.{n}` → `.{n+1}` for
 * n = maxFiles-1 down to 1, base → `.1`. At most `maxFiles` rotated files are kept.
 *
 * Call at daemon startup before any log writes to bound total log storage.
 */
export function rotateLogs(
  logPath: string,
  maxBytes: number = 5 * 1024 * 1024,
  maxFiles: number = 3,
  io: LogRotateIO = defaultLogRotateIO,
): boolean {
  // Nothing to rotate if the log doesn't exist
  if (!io.existsSync(logPath)) return false;

  let size: number;
  try {
    size = io.statSync(logPath).size;
  } catch {
    return false;
  }

  if (size < maxBytes) return false;

  // Shift existing rotations: delete .{maxFiles}, rename .{n} → .{n+1}
  const maxRotation = `${logPath}.${maxFiles}`;
  if (io.existsSync(maxRotation)) {
    try {
      io.unlinkSync(maxRotation);
    } catch {
      // best-effort
    }
  }

  for (let n = maxFiles - 1; n >= 1; n--) {
    const from = `${logPath}.${n}`;
    const to = `${logPath}.${n + 1}`;
    if (io.existsSync(from)) {
      try {
        io.renameSync(from, to);
      } catch {
        // best-effort
      }
    }
  }

  // Rename base → .1
  try {
    io.renameSync(logPath, `${logPath}.1`);
  } catch {
    // best-effort -- if rename fails, log will just keep growing
    return false;
  }

  return true;
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
 * - Best-effort -- failures are silently ignored (files will be recreated)
 * - Also migrates the `state-archive/` directory
 *
 * Safe to call repeatedly -- no-ops when nothing to migrate.
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
        // best-effort -- file will be recreated on next write
      }
    } else if (existsSync(oldPath) && existsSync(newPath)) {
      // New location already has the file -- just clean up old copy
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
      // best-effort -- archive will be recreated
    }
  }
}

// ── Daemon fork ─────────────────────────────────────────────────────

/**
 * Fork the orchestrate command into a detached background process.
 * Writes PID file, redirects output to log file, and returns immediately.
 *
 * @param childArgs - args to pass to the child (original args with --daemon replaced by --_daemon-child)
 * @param projectRoot - project root for PID/log file paths
 * @param spawnFn - injectable for testing; defaults to node:child_process spawn
 * @param openFn - injectable for testing; defaults to fs.openSync
 * @param daemonIO - injectable I/O for PID file; defaults to real fs
 */
export function forkDaemon(
  childArgs: string[],
  projectRoot: string,
  spawnFn: typeof nodeSpawn = nodeSpawn,
  openFn: typeof openSync = openSync,
  daemonIO: DaemonIO = { writeFileSync, readFileSync: () => "" as any, unlinkSync: () => {}, existsSync, mkdirSync, renameSync },
): { pid: number; logPath: string } {
  const stateDir = userStateDir(projectRoot);
  if (!daemonIO.existsSync(stateDir)) {
    daemonIO.mkdirSync(stateDir, { recursive: true });
  }

  const logPath = logFilePath(projectRoot);

  // Rotate logs at daemon startup to bound total log storage (~20MB max)
  rotateLogs(logPath);

  const logFd = openFn(logPath, "a");

  const child = spawnFn(process.argv[0]!, [process.argv[1]!, "orchestrate", ...childArgs], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: projectRoot,
  });
  child.unref();

  const pid = child.pid!;
  writePidFile(projectRoot, pid, daemonIO);

  return { pid, logPath };
}
