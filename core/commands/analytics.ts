// analytics command: display orchestration performance trends.
// Reads .ninthwave/analytics/*.json files and shows summary statistics
// with trend arrows comparing the latest run to the overall average.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { BOLD, RESET, GREEN, RED, YELLOW, CYAN, DIM } from "../output.ts";
import type { RunMetrics, DetectionLatencyStats } from "../analytics.ts";
import { computeDetectionLatency } from "../analytics.ts";

// ── Dependencies (injectable for testing) ─────────────────────────────

export interface AnalyticsReadIO {
  existsSync: (path: string) => boolean;
  readdirSync: (path: string) => string[];
  readFileSync: (path: string, encoding: "utf-8") => string;
}

// ── Summary types ─────────────────────────────────────────────────────

export interface AnalyticsSummary {
  totalRuns: number;
  totalItemsShipped: number;
  avgWallClockMs: number;
  avgItemsPerBatch: number;
  ciRetryRate: number;
  itemsPerDay: number;
  latestWallClockMs: number;
  latestItemsPerBatch: number;
  latestCiRetryRate: number;
  /** Total tokens used across all runs. Null when no cost data is available. */
  totalTokensUsed: number | null;
  /** Total cost in USD across all runs. Null when no cost data is available. */
  totalCostUsd: number | null;
  /** Aggregate detection latency across all runs. Null when no latency data. */
  detectionLatency: DetectionLatencyStats | null;
  runs: RunMetrics[];
}

// ── Core logic ────────────────────────────────────────────────────────

/**
 * Load and parse analytics JSON files from the analytics directory.
 * Returns runs sorted by timestamp (oldest first).
 *
 * Validates JSON structure: runTimestamp (string), wallClockMs (number),
 * items (array where every entry has `id` and `state` strings).
 * Corrupt or structurally invalid files are skipped. When an `onWarn`
 * callback is provided, it is called with a diagnostic message for each
 * skipped file.
 */
export function loadRuns(
  analyticsDir: string,
  io: AnalyticsReadIO,
  onWarn?: (message: string) => void,
): RunMetrics[] {
  if (!io.existsSync(analyticsDir)) return [];

  const files = io.readdirSync(analyticsDir)
    .filter((f) => f.endsWith(".json"))
    .sort(); // lexicographic sort on timestamp-based filenames = chronological

  const runs: RunMetrics[] = [];
  for (const file of files) {
    try {
      const content = io.readFileSync(join(analyticsDir, file), "utf-8");
      const parsed = JSON.parse(content) as RunMetrics;

      // Basic field validation
      if (typeof parsed.runTimestamp !== "string" || typeof parsed.wallClockMs !== "number") {
        onWarn?.(`Skipping ${file}: missing or invalid runTimestamp/wallClockMs`);
        continue;
      }

      // Structural validation: items array must exist
      if (!Array.isArray(parsed.items)) {
        onWarn?.(`Skipping ${file}: missing or invalid items array`);
        continue;
      }

      // Structural validation: each item must have id (string) and state (string)
      const hasInvalidItem = parsed.items.some(
        (item: unknown) =>
          typeof item !== "object" ||
          item === null ||
          typeof (item as Record<string, unknown>).id !== "string" ||
          typeof (item as Record<string, unknown>).state !== "string",
      );
      if (hasInvalidItem) {
        onWarn?.(`Skipping ${file}: one or more items missing id or state`);
        continue;
      }

      runs.push(parsed);
    } catch {
      onWarn?.(`Skipping ${file}: invalid JSON`);
    }
  }

  return runs;
}

/**
 * Compute summary statistics from a list of runs.
 */
export function computeSummary(runs: RunMetrics[]): AnalyticsSummary {
  if (runs.length === 0) {
    return {
      totalRuns: 0,
      totalItemsShipped: 0,
      avgWallClockMs: 0,
      avgItemsPerBatch: 0,
      ciRetryRate: 0,
      itemsPerDay: 0,
      latestWallClockMs: 0,
      latestItemsPerBatch: 0,
      latestCiRetryRate: 0,
      totalTokensUsed: null,
      totalCostUsd: null,
      detectionLatency: null,
      runs: [],
    };
  }

  const totalItemsShipped = runs.reduce((sum, r) => sum + r.itemsCompleted, 0);
  const totalItemsAttempted = runs.reduce((sum, r) => sum + r.itemsAttempted, 0);
  const totalCiRetries = runs.reduce(
    (sum, r) => sum + r.items.reduce((s, i) => s + i.ciRetryCount, 0),
    0,
  );
  const avgWallClockMs = runs.reduce((sum, r) => sum + r.wallClockMs, 0) / runs.length;
  const avgItemsPerBatch = totalItemsAttempted / runs.length;
  const ciRetryRate = totalItemsAttempted > 0 ? totalCiRetries / totalItemsAttempted : 0;

  // Items per day: total items shipped / span of time from first to last run
  const firstTimestamp = new Date(runs[0]!.runTimestamp).getTime();
  const lastTimestamp = new Date(runs[runs.length - 1]!.runTimestamp).getTime();
  const spanMs = lastTimestamp - firstTimestamp;
  const spanDays = spanMs / (1000 * 60 * 60 * 24);
  const itemsPerDay = spanDays > 0 ? totalItemsShipped / spanDays : totalItemsShipped;

  const latest = runs[runs.length - 1]!;
  const latestCiRetries = latest.items.reduce((s, i) => s + i.ciRetryCount, 0);
  const latestCiRetryRate = latest.itemsAttempted > 0
    ? latestCiRetries / latest.itemsAttempted
    : 0;

  // Aggregate cost data across all runs — null when no run has cost data
  const runsWithTokens = runs.filter((r) => r.totalTokensUsed != null);
  const runsWithCost = runs.filter((r) => r.totalCostUsd != null);

  const totalTokensUsed = runsWithTokens.length > 0
    ? runsWithTokens.reduce((sum, r) => sum + r.totalTokensUsed!, 0)
    : null;
  const totalCostUsd = runsWithCost.length > 0
    ? runsWithCost.reduce((sum, r) => sum + r.totalCostUsd!, 0)
    : null;

  // Aggregate detection latency across all runs — collect all per-item latencies
  const allLatencies = runs.flatMap((r) =>
    r.items
      .map((i) => i.detectionLatencyMs)
      .filter((ms): ms is number => ms != null && ms > 0),
  );
  const detectionLatency = computeDetectionLatency(allLatencies);

  return {
    totalRuns: runs.length,
    totalItemsShipped,
    avgWallClockMs,
    avgItemsPerBatch,
    ciRetryRate,
    itemsPerDay,
    latestWallClockMs: latest.wallClockMs,
    latestItemsPerBatch: latest.itemsAttempted,
    latestCiRetryRate,
    totalTokensUsed,
    totalCostUsd,
    detectionLatency,
    runs,
  };
}

/**
 * Return a trend arrow comparing current value to average.
 * ↑ = current > average (with tolerance), ↓ = current < average, → = roughly equal.
 *
 * @param current - Current (latest) value
 * @param average - Historical average
 * @param higherIsBetter - If true, ↑ is green and ↓ is red; otherwise reversed
 * @param tolerance - Percentage threshold for "roughly equal" (default 5%)
 */
export function trendArrow(
  current: number,
  average: number,
  higherIsBetter: boolean,
  tolerance: number = 0.05,
): string {
  if (average === 0 && current === 0) return `${DIM}→${RESET}`;
  if (average === 0) return higherIsBetter ? `${GREEN}↑${RESET}` : `${RED}↑${RESET}`;

  const ratio = (current - average) / Math.abs(average);

  if (Math.abs(ratio) <= tolerance) {
    return `${YELLOW}→${RESET}`;
  }

  if (ratio > 0) {
    return higherIsBetter ? `${GREEN}↑${RESET}` : `${RED}↑${RESET}`;
  }

  return higherIsBetter ? `${RED}↓${RESET}` : `${GREEN}↓${RESET}`;
}

// ── Formatting helpers ────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatDate(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z").slice(0, 19);
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

// ── Display ───────────────────────────────────────────────────────────

/**
 * Format analytics output as plain text lines.
 * Pure function — no side effects — for easy testing.
 */
export function formatAnalytics(summary: AnalyticsSummary, showAll: boolean): string[] {
  const lines: string[] = [];

  if (summary.totalRuns === 0) {
    lines.push("No analytics data found.");
    lines.push("Run `ninthwave orchestrate` to generate metrics.");
    return lines;
  }

  const displayRuns = showAll ? summary.runs : summary.runs.slice(-10);
  const displayLabel = showAll ? "All runs" : `Last ${Math.min(10, summary.runs.length)} runs`;

  // Header
  lines.push(`${BOLD}ninthwave Analytics${RESET}`);
  lines.push(`${DIM}${displayLabel} (${summary.totalRuns} total)${RESET}`);
  lines.push("");

  // Summary metrics with trend arrows (only show trends when >1 run)
  const showTrends = summary.totalRuns > 1;

  const wallClockTrend = showTrends
    ? ` ${trendArrow(summary.latestWallClockMs, summary.avgWallClockMs, false)}`
    : "";
  lines.push(
    `  ${CYAN}Avg wall-clock time:${RESET}  ${formatDuration(summary.avgWallClockMs)}` +
    `  ${DIM}(latest: ${formatDuration(summary.latestWallClockMs)})${RESET}${wallClockTrend}`,
  );

  const batchTrend = showTrends
    ? ` ${trendArrow(summary.latestItemsPerBatch, summary.avgItemsPerBatch, true)}`
    : "";
  lines.push(
    `  ${CYAN}Avg items per batch:${RESET}  ${summary.avgItemsPerBatch.toFixed(1)}` +
    `  ${DIM}(latest: ${summary.latestItemsPerBatch})${RESET}${batchTrend}`,
  );

  const ciTrend = showTrends
    ? ` ${trendArrow(summary.latestCiRetryRate, summary.ciRetryRate, false)}`
    : "";
  lines.push(
    `  ${CYAN}CI retry rate:${RESET}        ${formatPercent(summary.ciRetryRate)}` +
    `  ${DIM}(latest: ${formatPercent(summary.latestCiRetryRate)})${RESET}${ciTrend}`,
  );

  lines.push(`  ${CYAN}Total items shipped:${RESET}  ${summary.totalItemsShipped}`);
  lines.push(`  ${CYAN}Items per day:${RESET}        ${summary.itemsPerDay.toFixed(1)}`);

  // Cost summary — only shown when cost data exists
  if (summary.totalCostUsd != null) {
    lines.push(`  ${CYAN}Total cost:${RESET}           ${formatCost(summary.totalCostUsd)}`);
  }
  if (summary.totalTokensUsed != null) {
    lines.push(`  ${CYAN}Total tokens:${RESET}         ${formatTokens(summary.totalTokensUsed)}`);
  }

  // Detection latency — only shown when latency data exists
  if (summary.detectionLatency) {
    const dl = summary.detectionLatency;
    const slowTag = dl.slowDetection ? `  ${RED}⚠ slow detection${RESET}` : "";
    lines.push(
      `  ${CYAN}Detection latency:${RESET}    ` +
      `p50=${formatDuration(dl.p50Ms)}  p95=${formatDuration(dl.p95Ms)}  max=${formatDuration(dl.maxMs)}` +
      `  ${DIM}(${dl.sampleCount} samples)${RESET}${slowTag}`,
    );
  }

  lines.push("");

  // Determine whether any displayed run has cost data — controls column visibility
  const hasCostData = displayRuns.some((r) => r.totalCostUsd != null);

  // Run history table
  lines.push(`${BOLD}Run History${RESET}`);
  const headerCost = hasCostData ? ` ${"Cost".padEnd(10)}` : "";
  lines.push(
    `  ${DIM}${"Timestamp".padEnd(21)} ${"Duration".padEnd(10)} ${"Items".padEnd(7)} ${"Done".padEnd(6)} ${"Fail".padEnd(6)} ${"CI Retries".padEnd(10)}${headerCost}${RESET}`,
  );
  const separatorCost = hasCostData ? ` ${"─".repeat(10)}` : "";
  lines.push(`  ${DIM}${"─".repeat(21)} ${"─".repeat(10)} ${"─".repeat(7)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(10)}${separatorCost}${RESET}`);

  for (const run of displayRuns) {
    const ciRetries = run.items.reduce((s, i) => s + i.ciRetryCount, 0);
    const failColor = run.itemsFailed > 0 ? RED : "";
    const failReset = run.itemsFailed > 0 ? RESET : "";
    const costCol = hasCostData
      ? ` ${(run.totalCostUsd != null ? formatCost(run.totalCostUsd) : "—").padEnd(10)}`
      : "";

    lines.push(
      `  ${formatDate(run.runTimestamp).padEnd(21)} ${formatDuration(run.wallClockMs).padEnd(10)} ${String(run.itemsAttempted).padEnd(7)} ${String(run.itemsCompleted).padEnd(6)} ${failColor}${String(run.itemsFailed).padEnd(6)}${failReset} ${String(ciRetries).padEnd(10)}${costCol}`,
    );
  }

  return lines;
}

// ── Command entry point ───────────────────────────────────────────────

/**
 * Run the analytics command. Reads files and prints to stdout.
 */
export function analytics(
  projectRoot: string,
  showAll: boolean,
  io: AnalyticsReadIO,
): void {
  const analyticsDir = join(projectRoot, ".ninthwave", "analytics");
  const runs = loadRuns(analyticsDir, io);
  const summary = computeSummary(runs);
  const lines = formatAnalytics(summary, showAll);

  for (const line of lines) {
    console.log(line);
  }
}

/** Default IO using real filesystem. */
function defaultIO(): AnalyticsReadIO {
  return { existsSync, readdirSync, readFileSync };
}

/** CLI entry point for `ninthwave analytics`. */
export function cmdAnalytics(args: string[], projectRoot: string): void {
  const showAll = args.includes("--all");
  analytics(projectRoot, showAll, defaultIO());
}
