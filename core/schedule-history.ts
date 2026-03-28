// Schedule history: append-only JSONL log of scheduled task executions.
// File lives at ~/.ninthwave/projects/{slug}/schedule-history.jsonl.
// Each line is a JSON object recording one execution's outcome.

import { existsSync, appendFileSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { userStateDir } from "./daemon.ts";

// ── Types ────────────────────────────────────────────────────────────

/** Result of a scheduled task execution. */
export type ScheduleExecutionResult = "success" | "timeout" | "error";

/** A single execution history entry. */
export interface ScheduleHistoryEntry {
  taskId: string;
  startedAt: string;
  endedAt: string;
  result: ScheduleExecutionResult;
  durationMs: number;
  daemonId?: string;
}

// ── Paths ────────────────────────────────────────────────────────────

/** Path to the schedule history JSONL file for a project. */
export function scheduleHistoryPath(projectRoot: string): string {
  return join(userStateDir(projectRoot), "schedule-history.jsonl");
}

// ── Write ────────────────────────────────────────────────────────────

/** Injectable I/O for history operations. */
export interface ScheduleHistoryIO {
  existsSync: (path: string) => boolean;
  appendFileSync: (path: string, data: string, encoding: "utf-8") => void;
  readFileSync: (path: string, encoding: "utf-8") => string;
  mkdirSync: (path: string, options: { recursive: true }) => void;
}

const defaultIO: ScheduleHistoryIO = {
  existsSync,
  appendFileSync: (path, data, encoding) => appendFileSync(path, data, encoding),
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  mkdirSync: (path, options) => mkdirSync(path, options),
};

/**
 * Append a history entry to the JSONL file.
 * Creates the directory if needed.
 */
export function appendHistoryEntry(
  projectRoot: string,
  entry: ScheduleHistoryEntry,
  io: ScheduleHistoryIO = defaultIO,
): void {
  const filePath = scheduleHistoryPath(projectRoot);
  const dir = dirname(filePath);
  if (!io.existsSync(dir)) {
    io.mkdirSync(dir, { recursive: true });
  }
  const line = JSON.stringify(entry) + "\n";
  io.appendFileSync(filePath, line, "utf-8");
}

// ── Read ─────────────────────────────────────────────────────────────

/**
 * Read all history entries from the JSONL file.
 * Returns entries sorted by startedAt ascending.
 * Skips malformed lines silently.
 */
export function readHistoryEntries(
  projectRoot: string,
  io: ScheduleHistoryIO = defaultIO,
): ScheduleHistoryEntry[] {
  const filePath = scheduleHistoryPath(projectRoot);
  if (!io.existsSync(filePath)) return [];

  const content = io.readFileSync(filePath, "utf-8");
  const entries: ScheduleHistoryEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ScheduleHistoryEntry;
      // Validate required fields
      if (parsed.taskId && parsed.startedAt && parsed.endedAt && parsed.result) {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/**
 * Read history entries filtered by task ID.
 * Returns entries sorted by startedAt descending (most recent first).
 */
export function readHistoryForTask(
  projectRoot: string,
  taskId: string,
  limit: number = 20,
  io: ScheduleHistoryIO = defaultIO,
): ScheduleHistoryEntry[] {
  const all = readHistoryEntries(projectRoot, io);
  return all
    .filter((e) => e.taskId === taskId)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit);
}

/**
 * Read recent history across all tasks.
 * Returns entries sorted by startedAt descending (most recent first).
 */
export function readRecentHistory(
  projectRoot: string,
  limit: number = 20,
  io: ScheduleHistoryIO = defaultIO,
): ScheduleHistoryEntry[] {
  const all = readHistoryEntries(projectRoot, io);
  return all
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit);
}
