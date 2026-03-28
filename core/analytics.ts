// Structured metrics emitter for orchestrator runs.
// Writes a JSON file per run to .ninthwave/analytics/ with timing,
// item counts, CI retry counts, merge strategy, cost/token tracking, and tool info.

import type { OrchestratorItem, OrchestratorConfig } from "./orchestrator.ts";

// ── Metrics schema ────────────────────────────────────────────────────

export interface ItemMetric {
  id: string;
  state: string;
  ciRetryCount: number;
  /** Number of worker crash retries for this item. */
  retryCount: number;
  tool: string;
  prNumber?: number;
  /** Total tokens used by this item's worker session. Null when cost data is unavailable. */
  tokensUsed?: number | null;
  /** Total cost in USD for this item's worker session. Null when cost data is unavailable. */
  costUsd?: number | null;
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
  /** Aggregate tokens used across all items. Null when no cost data is available. */
  totalTokensUsed: number | null;
  /** Aggregate cost in USD across all items. Null when no cost data is available. */
  totalCostUsd: number | null;
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

// ── Cost/token parsing ────────────────────────────────────────────────

/** Parsed cost summary from a worker session's exit output. */
export interface CostSummary {
  tokensUsed: number | null;
  costUsd: number | null;
}

/**
 * Parse Claude Code's exit summary for token count and cost.
 *
 * Handles common output formats:
 *   - "Total tokens: 42,567" or "Tokens: 42567"
 *   - "Total cost: $3.45" or "Cost: $0.12"
 *
 * Returns null for each field that cannot be parsed.
 * Gracefully handles empty input, malformed text, and tools
 * that don't report cost data.
 */
export function parseCostSummary(text: string): CostSummary {
  if (!text) return { tokensUsed: null, costUsd: null };

  let tokensUsed: number | null = null;
  let costUsd: number | null = null;

  // Match token count: "Total tokens: 42,567", "Tokens: 42567", "Total token: 100,000"
  // Requires either "total" prefix or plural "tokens" to avoid false positives
  // like "CSRF token: 12345".
  const tokenMatch = text.match(/(?:total\s+tokens?|tokens)\s*[:=]\s*([\d,]+)/i);
  if (tokenMatch) {
    const parsed = parseInt(tokenMatch[1]!.replace(/,/g, ""), 10);
    if (!isNaN(parsed) && parsed > 0) {
      tokensUsed = parsed;
    }
  }

  // Match cost: "$3.45" or "cost: $0.12" or "cost: 1.23"
  const costMatch = text.match(/cost\s*[:=]\s*\$?\s*([\d.]+)/i);
  if (costMatch) {
    const parsed = parseFloat(costMatch[1]!);
    if (!isNaN(parsed) && parsed >= 0) {
      costUsd = parsed;
    }
  }

  return { tokensUsed, costUsd };
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
 * @param costData - Optional per-item cost data parsed from worker exit output
 */
export function collectRunMetrics(
  allItems: OrchestratorItem[],
  config: OrchestratorConfig,
  startTime: string,
  endTime: string,
  aiTool: string,
  costData?: Map<string, CostSummary>,
): RunMetrics {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const wallClockMs = Math.max(0, end - start);

  const items: ItemMetric[] = allItems.map((item) => {
    const cost = costData?.get(item.id);
    return {
      id: item.id,
      state: item.state,
      ciRetryCount: item.ciFailCount,
      retryCount: item.retryCount,
      tool: aiTool,
      ...(item.prNumber != null ? { prNumber: item.prNumber } : {}),
      tokensUsed: cost?.tokensUsed ?? null,
      costUsd: cost?.costUsd ?? null,
      ...(item.detectionLatencyMs != null ? { detectionLatencyMs: item.detectionLatencyMs } : {}),
      ...(item.startedAt ? { startedAt: item.startedAt } : {}),
      ...(item.endedAt ? { endedAt: item.endedAt } : {}),
      ...(item.exitCode != null ? { exitCode: item.exitCode } : {}),
    };
  });

  // Compute detection latency percentiles from items that have latency data
  const latencies = allItems
    .map((item) => item.detectionLatencyMs)
    .filter((ms): ms is number => ms != null && ms > 0);
  const detectionLatency = computeDetectionLatency(latencies);

  // Aggregate totals — null when no items have cost data
  const itemsWithTokens = items.filter((i) => i.tokensUsed != null);
  const itemsWithCost = items.filter((i) => i.costUsd != null);

  const totalTokensUsed = itemsWithTokens.length > 0
    ? itemsWithTokens.reduce((sum, i) => sum + i.tokensUsed!, 0)
    : null;
  const totalCostUsd = itemsWithCost.length > 0
    ? itemsWithCost.reduce((sum, i) => sum + i.costUsd!, 0)
    : null;

  return {
    runTimestamp: startTime,
    wallClockMs,
    itemsAttempted: allItems.length,
    itemsCompleted: allItems.filter((i) => i.state === "done").length,
    itemsFailed: allItems.filter((i) => i.state === "stuck").length,
    mergeStrategy: config.mergeStrategy,
    items,
    totalTokensUsed,
    totalCostUsd,
    detectionLatency,
  };
}

// ── File I/O dependencies (injectable for testing) ────────────────────

export interface AnalyticsIO {
  mkdirSync: (path: string, opts: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
}

// ── Metrics persistence ───────────────────────────────────────────────

/**
 * Write a run metrics file to the analytics directory.
 * Creates the directory if it doesn't exist.
 * File is named by timestamp: `YYYY-MM-DDTHH-MM-SS-MMMZ.json`
 *
 * @param metrics - The run metrics to persist
 * @param analyticsDir - Path to `.ninthwave/analytics/`
 * @param io - Injectable file system operations
 * @returns The path of the written file
 */
export function writeRunMetrics(
  metrics: RunMetrics,
  analyticsDir: string,
  io: AnalyticsIO,
): string {
  io.mkdirSync(analyticsDir, { recursive: true });

  // Convert ISO timestamp to a filesystem-safe name
  const safeName = metrics.runTimestamp
    .replace(/:/g, "-")
    .replace(/\./g, "-");
  const filePath = `${analyticsDir}/${safeName}.json`;

  io.writeFileSync(filePath, JSON.stringify(metrics, null, 2) + "\n");

  return filePath;
}

// ── Auto-commit analytics files ────────────────────────────────────────

/** Injectable git operations for analytics commit (avoids vi.mock). */
export interface AnalyticsCommitDeps {
  hasChanges: (repoRoot: string, pathspec: string) => boolean;
  gitAdd: (repoRoot: string, files: string[]) => void;
  getStagedFiles: (repoRoot: string) => string[];
  gitCommit: (repoRoot: string, message: string) => void;
  gitReset: (repoRoot: string, files: string[]) => void;
}

export interface CommitAnalyticsResult {
  committed: boolean;
  reason?: "no_changes" | "dirty_index" | "committed";
}

/**
 * Auto-commit analytics files after an orchestration run.
 * Only stages files under the analytics path — never commits unrelated changes.
 *
 * Safety: if non-analytics files are already staged in the index, skips the
 * commit and returns `dirty_index` to avoid accidentally including them.
 *
 * @param projectRoot - The git repo root
 * @param analyticsRelPath - Relative path to analytics dir (e.g., ".ninthwave/analytics")
 * @param deps - Injectable git operations
 */
export function commitAnalyticsFiles(
  projectRoot: string,
  analyticsRelPath: string,
  deps: AnalyticsCommitDeps,
): CommitAnalyticsResult {
  // 1. Check if analytics files have any changes
  if (!deps.hasChanges(projectRoot, analyticsRelPath)) {
    return { committed: false, reason: "no_changes" };
  }

  // 2. Stage analytics files only
  deps.gitAdd(projectRoot, [analyticsRelPath]);

  // 3. Safety check: ensure only analytics files are staged
  const staged = deps.getStagedFiles(projectRoot);
  const nonAnalytics = staged.filter((f) => !f.startsWith(analyticsRelPath));
  if (nonAnalytics.length > 0) {
    // Unstage analytics files we just added to avoid leaving them staged
    deps.gitReset(projectRoot, [analyticsRelPath]);
    return { committed: false, reason: "dirty_index" };
  }

  // 4. Commit
  deps.gitCommit(projectRoot, "chore: update orchestration analytics");
  return { committed: true, reason: "committed" };
}

/**
 * Auto-commit friction entries after an orchestration run.
 * Only stages files under the friction path — never commits unrelated changes.
 *
 * Safety: if non-friction files are already staged in the index, skips the
 * commit and returns `dirty_index` to avoid accidentally including them.
 *
 * @param projectRoot - The git repo root
 * @param frictionRelPath - Relative path to friction dir (e.g., ".ninthwave/friction")
 * @param deps - Injectable git operations
 */
export function commitFrictionFiles(
  projectRoot: string,
  frictionRelPath: string,
  deps: AnalyticsCommitDeps,
): CommitAnalyticsResult {
  // 1. Check if friction files have any changes
  if (!deps.hasChanges(projectRoot, frictionRelPath)) {
    return { committed: false, reason: "no_changes" };
  }

  // 2. Stage friction files only
  deps.gitAdd(projectRoot, [frictionRelPath]);

  // 3. Safety check: ensure only friction files are staged
  const staged = deps.getStagedFiles(projectRoot);
  const nonFriction = staged.filter((f) => !f.startsWith(frictionRelPath));
  if (nonFriction.length > 0) {
    // Unstage friction files we just added to avoid leaving them staged
    deps.gitReset(projectRoot, [frictionRelPath]);
    return { committed: false, reason: "dirty_index" };
  }

  // 4. Commit
  deps.gitCommit(projectRoot, "chore: commit friction entries");
  return { committed: true, reason: "committed" };
}
