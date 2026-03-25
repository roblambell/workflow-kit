// Daemon mode utilities: PID file management, state serialization, stale PID detection.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";
import { join } from "path";
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
}

export interface DaemonState {
  pid: number;
  startedAt: string;
  updatedAt: string;
  statusPaneRef?: string | null;
  wipLimit?: number;
  dashboardUrl?: string | null;
  items: DaemonStateItem[];
}

// ── Paths ────────────────────────────────────────────────────────────

export function pidFilePath(projectRoot: string): string {
  return join(projectRoot, ".ninthwave", "orchestrator.pid");
}

export function stateFilePath(projectRoot: string): string {
  return join(projectRoot, ".ninthwave", "orchestrator.state.json");
}

export function logFilePath(projectRoot: string): string {
  return join(projectRoot, ".ninthwave", "orchestrator.log");
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
  return join(projectRoot, ".ninthwave", "external-reviews.json");
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
  extras?: { statusPaneRef?: string | null; wipLimit?: number; dashboardUrl?: string | null },
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
    })),
  };
}
