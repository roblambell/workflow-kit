// Shared types for the ninthwave CLI.

export type Priority = "critical" | "high" | "medium" | "low";
export type Status = "open" | "in-progress";

export interface WorkItem {
  id: string; // e.g., "H-BF5-1"
  priority: Priority;
  title: string;
  domain: string; // normalized domain slug
  dependencies: string[]; // list of dependency IDs
  bundleWith: string[]; // list of bundle IDs
  status: Status;
  filePath: string; // path to the individual todo file
  repoAlias: string; // "" | "self" | "hub" | repo name
  rawText: string; // full markdown text of the TODO item
  filePaths: string[]; // extracted file paths mentioned in the item
  testPlan: string; // extracted from **Test plan:** section (empty if not present)
  bootstrap: boolean; // whether the orchestrator should bootstrap the target repo before launch
}

export const PRIORITY_NUM: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface WorkspacePackage {
  name: string;
  path: string;
  testCmd: string;
}

export interface WorkspaceConfig {
  tool: "pnpm" | "yarn" | "npm" | "turborepo";
  root: string;
  packages: WorkspacePackage[];
}

export interface ProjectConfig {
  locExtensions: string;
  [key: string]: string;
}

export interface WorktreeInfo {
  itemId: string;
  repoRoot: string;
  worktreePath: string;
}

export interface PRStatus {
  number: number;
  state: "open" | "closed" | "merged";
  reviewDecision: string;
  ciStatus: "pass" | "fail" | "pending" | "unknown";
  isMergeable: boolean;
}

export interface WatchResult {
  id: string;
  prNumber: string;
  status: string;
}

export interface Transition {
  id: string;
  prNumber: string;
  from: string;
  to: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

// ID pattern: X-code-N[suffix] (e.g., H-BF5-1, D-2-1, H-CP-7a, H-CP-7b)
// The optional [a-z]* suffix supports split items like 7a/7b.
export const ID_PATTERN = /[A-Z]-[A-Za-z0-9]+-[0-9]+[a-z]*/;
export const ID_PATTERN_GLOBAL = /[A-Z]-[A-Za-z0-9]+-[0-9]+[a-z]*/g;
export const ID_IN_PARENS = /\(([A-Z]-[A-Za-z0-9]+-[0-9]+[a-z]*)/;

// Filename pattern: extracts ID from "--{ID}.md" suffix in todo filenames
export const ID_IN_FILENAME = /--([A-Z]-[A-Za-z0-9]+-[0-9]+[a-z]*)\.md$/;

// Source string for building composite regexes (keeps the pattern in one place)
export const ID_PATTERN_SOURCE = "[A-Z]-[A-Za-z0-9]+-[0-9]+[a-z]*";

// Wildcard dependency pattern: matches patterns like "MUX-*", "H-MUX-*", "DF-*"
// Captures an uppercase start, optional hyphen-separated segments, ending with -*
export const WILDCARD_DEP_PATTERN = /[A-Z](?:[A-Za-z0-9]*-)*\*/g;

// Default LOC extensions for version-bump
export const DEFAULT_LOC_EXTENSIONS =
  "*.ex *.exs *.ts *.tsx *.js *.jsx *.py *.go *.rs *.rb *.java *.kt *.swift";

// ── Worker cost tracking ───────────────────────────────────────────────

/** Cost and token data from a worker session. */
export interface WorkerCostData {
  model?: string;       // e.g., "claude-sonnet-4-20250514", "gpt-4o"
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  source: "heartbeat" | "exit-output" | "manual";
}

// ── Model pricing lookup ──────────────────────────────────────────────

/** Per-million-token pricing for known models. */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Pricing lookup table for common models (USD per million tokens).
 * These are approximate list prices; actual costs may vary by agreement.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-20250514": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-opus-4-20250514": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-haiku-3.5": { inputPerMillion: 0.8, outputPerMillion: 4 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "o3": { inputPerMillion: 10, outputPerMillion: 40 },
  "o4-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4 },
};

/**
 * Estimate cost in USD from model name and token counts.
 * Returns null if the model is unknown or token counts are missing.
 */
export function estimateCost(
  model: string | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | null {
  if (!model || (inputTokens == null && outputTokens == null)) return null;

  // Try exact match first, then prefix match for versioned model names
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    const key = Object.keys(MODEL_PRICING).find((k) => model.startsWith(k));
    if (key) pricing = MODEL_PRICING[key];
  }
  if (!pricing) return null;

  const inCost = (inputTokens ?? 0) * pricing.inputPerMillion / 1_000_000;
  const outCost = (outputTokens ?? 0) * pricing.outputPerMillion / 1_000_000;
  return Math.round((inCost + outCost) * 10000) / 10000; // Round to 4 decimal places
}

// File extension patterns for path extraction
export const CODE_EXTENSIONS =
  /\.(ex|exs|ts|tsx|js|jsx|md|yml|yaml|json|conf|sh|py|go|rs|rb|java|kt|swift)$/;
export const CODE_EXTENSIONS_FOR_LINE =
  /\.(ex|exs|ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift)$/;
