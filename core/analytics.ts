// Structured metrics emitter for orchestrator runs.
// Collects timing, item counts, CI retry counts, merge strategy,
// and tool info as structured log events.

import type { OrchestratorItem, OrchestratorConfig } from "./orchestrator.ts";
import { run } from "./shell.ts";
import type { RunResult } from "./types.ts";

// ── Metrics schema ────────────────────────────────────────────────────

export interface ItemMetric {
  id: string;
  state: string;
  ciRetryCount: number;
  /** Number of worker crash retries for this item. */
  retryCount: number;
  tool: string;
  prNumber?: number;
  /** Detection latency in milliseconds for this item's last transition. */
  detectionLatencyMs?: number;
  /** ISO timestamp of when the worker was launched. */
  startedAt?: string;
  /** ISO timestamp of when the worker completed or failed. */
  endedAt?: string;
  /** Exit code from the worker process (null when unknown). */
  exitCode?: number | null;
}

/** Aggregate detection latency percentiles for a run. */
export interface DetectionLatencyStats {
  /** Median detection latency in milliseconds. */
  p50Ms: number;
  /** 95th percentile detection latency in milliseconds. */
  p95Ms: number;
  /** Maximum detection latency in milliseconds. */
  maxMs: number;
  /** Number of transitions with latency measurements. */
  sampleCount: number;
  /** True when p95 exceeds the slow detection threshold (default 60s). */
  slowDetection: boolean;
}

export interface RunMetrics {
  /** ISO 8601 timestamp of when the run started. */
  runTimestamp: string;
  /** Wall-clock duration in milliseconds. */
  wallClockMs: number;
  /** Total items tracked by this run. */
  itemsAttempted: number;
  /** Items that reached the "done" state. */
  itemsCompleted: number;
  /** Items that reached the "stuck" state. */
  itemsFailed: number;
  /** Merge strategy used for this run. */
  mergeStrategy: string;
  /** Per-item metrics. */
  items: ItemMetric[];
  /** Detection latency percentiles for this run. Null when no latency data is available. */
  detectionLatency: DetectionLatencyStats | null;
}

// ── Detection latency helpers ─────────────────────────────────────────

/** Default threshold (ms) above which p95 detection latency is flagged as slow. */
export const SLOW_DETECTION_THRESHOLD_MS = 60_000; // 60 seconds

/**
 * Compute a percentile value from a sorted array of numbers.
 * Uses nearest-rank method. Returns 0 for empty arrays.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

/**
 * Compute detection latency stats from item latency values.
 * Returns null when no items have latency data.
 */
export function computeDetectionLatency(
  latencies: number[],
  thresholdMs: number = SLOW_DETECTION_THRESHOLD_MS,
): DetectionLatencyStats | null {
  if (latencies.length === 0) return null;

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50Ms = percentile(sorted, 50);
  const p95Ms = percentile(sorted, 95);
  const maxMs = sorted[sorted.length - 1]!;

  return {
    p50Ms,
    p95Ms,
    maxMs,
    sampleCount: sorted.length,
    slowDetection: p95Ms > thresholdMs,
  };
}

// ── Worker telemetry parsing ────────────────────────────────────────

/** Parsed telemetry from worker screen output. */
export interface WorkerTelemetry {
  exitCode: number | null;
  stderrTail: string;
}

/**
 * Parse worker telemetry from screen output.
 *
 * Extracts:
 * - Exit code: looks for patterns like "exit code 1", "exited with 1",
 *   "Process exited with code 1", or "Exit status: 1"
 * - Stderr tail: extracts the last 20 non-empty lines from the screen
 *   (the screen content itself serves as the stderr proxy since worker
 *   output is captured on the terminal)
 *
 * Returns null exit code and empty stderr when input is empty.
 */
export function parseWorkerTelemetry(screenText: string): WorkerTelemetry {
  if (!screenText) return { exitCode: null, stderrTail: "" };

  let exitCode: number | null = null;

  // Match exit code patterns:
  // "exit code 1", "exit code: 1", "exited with 1", "exited with code 1"
  // "Process exited with code 1", "Exit status: 1"
  const exitMatch = screenText.match(
    /(?:exit\s+(?:code|status)\s*[:=]?\s*|exited\s+with\s+(?:code\s+)?|process\s+exited\s+with\s+code\s+)(\d+)/i,
  );
  if (exitMatch) {
    const parsed = parseInt(exitMatch[1]!, 10);
    if (!isNaN(parsed)) {
      exitCode = parsed;
    }
  }

  // Extract last 20 non-empty lines as stderr tail
  const lines = screenText.split("\n").filter((l) => l.trim());
  const tail = lines.slice(-20).join("\n");

  return { exitCode, stderrTail: tail };
}

// ── Metrics collection ────────────────────────────────────────────────

/**
 * Collect run metrics from orchestrator state at completion.
 *
 * @param allItems - All orchestrator items at run completion
 * @param config - Orchestrator config (for merge strategy)
 * @param startTime - ISO timestamp when the run started
 * @param endTime - ISO timestamp when the run ended
 * @param aiTool - The AI tool used for this run (e.g., "claude", "cursor")
 */
export function collectRunMetrics(
  allItems: OrchestratorItem[],
  config: OrchestratorConfig,
  startTime: string,
  endTime: string,
  aiTool: string,
): RunMetrics {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const wallClockMs = Math.max(0, end - start);

  const items: ItemMetric[] = allItems.map((item) => ({
    id: item.id,
    state: item.state,
    ciRetryCount: item.ciFailCount,
    retryCount: item.retryCount,
    tool: aiTool,
    ...(item.prNumber != null ? { prNumber: item.prNumber } : {}),
    ...(item.detectionLatencyMs != null ? { detectionLatencyMs: item.detectionLatencyMs } : {}),
    ...(item.startedAt ? { startedAt: item.startedAt } : {}),
    ...(item.endedAt ? { endedAt: item.endedAt } : {}),
    ...(item.exitCode != null ? { exitCode: item.exitCode } : {}),
  }));

  // Compute detection latency percentiles from items that have latency data
  const latencies = allItems
    .map((item) => item.detectionLatencyMs)
    .filter((ms): ms is number => ms != null && ms > 0);
  const detectionLatency = computeDetectionLatency(latencies);

  return {
    runTimestamp: startTime,
    wallClockMs,
    itemsAttempted: allItems.length,
    itemsCompleted: allItems.filter((i) => i.state === "done").length,
    itemsFailed: allItems.filter((i) => i.state === "stuck").length,
    mergeStrategy: config.mergeStrategy,
    items,
    detectionLatency,
  };
}

/** Shell runner signature -- injectable for testing. */
export type ShellRunner = (cmd: string, args: string[]) => RunResult;

/**
 * Stage and commit files under a given sub-path of the repo.
 * Handles both analytics and friction paths (and any other `.ninthwave/` subdirectory).
 *
 * Only stages files under `relPath` -- never commits unrelated changes.
 *
 * Safety: if non-relPath files are already staged in the index, unstages the
 * files we just added and returns false to avoid accidentally including them.
 *
 * @param projectRoot - The git repo root
 * @param relPath - Relative path to stage (e.g., ".ninthwave/friction")
 * @param commitMessage - Commit message to use
 * @param runner - Injectable shell runner (defaults to the real shell)
 * @returns true when a commit was created, false otherwise
 */
export function commitPathFiles(
  projectRoot: string,
  relPath: string,
  commitMessage: string,
  runner: ShellRunner = (cmd, args) => run(cmd, args),
): boolean {
  // 1. Check if relPath has any changes (staged, unstaged, or untracked)
  const status = runner("git", ["-C", projectRoot, "status", "--porcelain", "--", relPath]);
  if (status.exitCode !== 0 || !status.stdout.trim()) {
    return false; // no changes
  }

  // 2. Stage files under relPath
  runner("git", ["-C", projectRoot, "add", "--", relPath]);

  // 3. Safety check: ensure only relPath files are staged
  const staged = runner("git", ["-C", projectRoot, "diff", "--name-only", "--cached"]);
  const stagedFiles = staged.stdout.split("\n").filter(Boolean);
  const nonRelPath = stagedFiles.filter((f) => !f.startsWith(relPath));

  if (nonRelPath.length > 0) {
    // Unstage the files we just added to avoid leaving them staged
    runner("git", ["-C", projectRoot, "restore", "--staged", "--", relPath]);
    return false; // dirty index
  }

  // 4. Commit
  runner("git", ["-C", projectRoot, "commit", "-m", commitMessage]);
  return true;
}
