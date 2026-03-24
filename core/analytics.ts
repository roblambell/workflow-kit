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
    };
  });

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
