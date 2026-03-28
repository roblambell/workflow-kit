// history command: show state transition timeline for a specific item.
// Reads transition events from the structured JSONL orchestrator log (including
// rotated files .1/.2/.3), extracts (timestamp, state) pairs for the target item,
// deduplicates consecutive identical states, and displays a timeline with durations.

import { existsSync, readFileSync } from "fs";
import { BOLD, RESET, CYAN, DIM, YELLOW, GREEN, RED } from "../output.ts";
import {
  logFilePath,
  stateFilePath,
  type DaemonState,
} from "../daemon.ts";
import { resolveLogPaths, type AnalyticsReadIO } from "./analytics.ts";

// ── Dependencies (injectable for testing) ─────────────────────────────

export interface HistoryIO {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf-8") => string;
}

// ── Types ──────────────────────────────────────────────────────────────

export interface StateTransition {
  state: string;
  timestamp: string; // ISO string
}

export interface TimelineEntry {
  state: string;
  timestamp: string; // ISO string
  durationMs: number | null; // null for the final entry
}

// ── Color mapping for states ───────────────────────────────────────────

const STATE_COLORS: Record<string, string> = {
  ready: CYAN,
  queued: CYAN,
  launching: YELLOW,
  implementing: YELLOW,
  "ci-pending": YELLOW,
  "ci-passed": GREEN,
  "ci-failed": RED,
  merging: GREEN,
  merged: GREEN,
  done: GREEN,
  failed: RED,
  stuck: RED,
};

// ── Core logic ─────────────────────────────────────────────────────────

/** A parsed transition event from the structured log. */
export interface LogTransitionEvent {
  ts: string;
  itemId: string;
  from: string;
  to: string;
}

/**
 * Load transition events from the structured JSONL orchestrator log.
 * Reads the current log and all rotated files (.1, .2, .3).
 * Returns events sorted chronologically (oldest first).
 */
export function loadSnapshots(
  projectRoot: string,
  io: HistoryIO,
): LogTransitionEvent[] {
  const logPath = logFilePath(projectRoot);
  const paths = resolveLogPaths(logPath, io);
  const events: LogTransitionEvent[] = [];

  for (const filePath of paths) {
    let content: string;
    try {
      content = io.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed.event === "transition" && typeof parsed.itemId === "string" && typeof parsed.to === "string") {
          events.push({
            ts: (parsed.ts as string) ?? "",
            itemId: parsed.itemId as string,
            from: (parsed.from as string) ?? "",
            to: parsed.to as string,
          });
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  }

  // Sort by timestamp
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return events;
}

/**
 * Extract state transitions for a specific item ID from log events.
 * Filters to the target item and deduplicates consecutive identical states.
 */
export function extractTransitions(
  itemId: string,
  events: LogTransitionEvent[],
): StateTransition[] {
  const observations: StateTransition[] = [];

  for (const event of events) {
    if (event.itemId !== itemId) continue;
    observations.push({
      state: event.to,
      timestamp: event.ts,
    });
  }

  if (observations.length === 0) return [];

  // Already sorted by loadSnapshots, but deduplicate consecutive identical states
  const transitions: StateTransition[] = [observations[0]!];
  for (let i = 1; i < observations.length; i++) {
    const prev = transitions[transitions.length - 1]!;
    const curr = observations[i]!;
    if (curr.state !== prev.state) {
      transitions.push(curr);
    }
  }

  return transitions;
}

/**
 * Build a timeline with duration for each state.
 */
export function buildTimeline(transitions: StateTransition[]): TimelineEntry[] {
  if (transitions.length === 0) return [];

  const timeline: TimelineEntry[] = [];

  for (let i = 0; i < transitions.length; i++) {
    const curr = transitions[i]!;
    const next = transitions[i + 1];

    let durationMs: number | null = null;
    if (next) {
      durationMs = new Date(next.timestamp).getTime() - new Date(curr.timestamp).getTime();
    }

    timeline.push({
      state: curr.state,
      timestamp: curr.timestamp,
      durationMs,
    });
  }

  return timeline;
}

/**
 * Resolve the title for an item ID from the current state file.
 * Falls back to null if not available.
 */
export function resolveTitle(
  itemId: string,
  projectRoot: string,
  io: HistoryIO,
): string | null {
  const currentPath = stateFilePath(projectRoot);
  if (!io.existsSync(currentPath)) return null;
  try {
    const content = io.readFileSync(currentPath, "utf-8");
    const state = JSON.parse(content) as DaemonState;
    const item = state.items?.find((i) => i.id === itemId);
    return item?.title ?? null;
  } catch {
    return null;
  }
}

// ── Formatting helpers ─────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes > 0) return `${hours}h ${remainingMinutes}m`;
  return `${hours}h`;
}

function formatTimestamp(iso: string): string {
  // Display as MM-DD HH:MM:SS
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    const seconds = String(d.getSeconds()).padStart(2, "0");
    return `${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch {
    return iso;
  }
}

// ── Display ────────────────────────────────────────────────────────────

/**
 * Format the timeline as plain text lines.
 * Pure function -- no side effects -- for easy testing.
 */
export function formatTimeline(
  itemId: string,
  title: string | null,
  timeline: TimelineEntry[],
): string[] {
  const lines: string[] = [];

  // Header
  const titleSuffix = title ? ` -- ${title}` : "";
  lines.push(`${BOLD}${itemId}${RESET}${titleSuffix}`);
  lines.push("");

  if (timeline.length === 0) {
    lines.push(`No history found for ${itemId}. Run \`nw list\` to see available items.`);
    return lines;
  }

  // Find the longest state name for alignment
  const maxStateLen = Math.max(...timeline.map((e) => e.state.length));

  for (const entry of timeline) {
    const color = STATE_COLORS[entry.state] ?? "";
    const reset = color ? RESET : "";
    const paddedState = entry.state.padEnd(maxStateLen);
    const ts = formatTimestamp(entry.timestamp);
    const duration = entry.durationMs != null
      ? `  ${DIM}(${formatDuration(entry.durationMs)})${RESET}`
      : "";

    lines.push(`  ${color}${paddedState}${reset}  ${ts}${duration}`);
  }

  // Total wall-clock time
  if (timeline.length >= 2) {
    const first = timeline[0]!;
    const last = timeline[timeline.length - 1]!;
    const totalMs = new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime();
    lines.push("");
    lines.push(`${DIM}Total: ${formatDuration(totalMs)}${RESET}`);
  }

  return lines;
}

// ── Command entry point ────────────────────────────────────────────────

/**
 * Core history logic. Takes an item ID and project root. Testable via IO injection.
 */
export function history(
  itemId: string,
  projectRoot: string,
  io: HistoryIO,
): void {
  const events = loadSnapshots(projectRoot, io);
  const transitions = extractTransitions(itemId, events);
  const timeline = buildTimeline(transitions);
  const title = resolveTitle(itemId, projectRoot, io);
  const lines = formatTimeline(itemId, title, timeline);

  for (const line of lines) {
    console.log(line);
  }
}

/** Default IO using real filesystem. */
function defaultIO(): HistoryIO {
  return { existsSync, readFileSync };
}

/** CLI entry point for `nw history`. */
export function cmdHistory(args: string[], projectRoot: string): void {
  const itemId = args[0];
  if (!itemId) {
    console.error("Usage: nw history <ID>");
    console.error("Example: nw history H-CR-1");
    process.exit(1);
  }

  history(itemId, projectRoot, defaultIO());
}
