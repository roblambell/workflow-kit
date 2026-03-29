// Shared types for the ninthwave CLI.

// ── Structured logging ────────────────────────────────────────────────

/** Structured log entry emitted as newline-delimited JSON to stdout (JSON mode) or log file (TUI mode). */
export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error" | "debug";
  event: string;
  [key: string]: unknown;
}

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
  reviewExternal?: string;
  githubToken?: string;
  scheduleEnabled?: string;
}

export interface WorktreeInfo {
  itemId: string;
  repoRoot: string;
  worktreePath: string;
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

// ── Scheduled tasks ──────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;           // slug-style, e.g. "daily-test-run"
  title: string;
  schedule: string;     // raw expression from the file, e.g. "every 2h"
  scheduleCron: string;  // normalized 5-field cron, e.g. "0 */2 * * *"
  priority: Priority;
  domain: string;
  timeout: number;      // ms, default 30 min (1_800_000)
  prompt: string;       // body text (the task prompt)
  filePath: string;
  enabled: boolean;
}

// File extension patterns for path extraction
export const CODE_EXTENSIONS =
  /\.(ex|exs|ts|tsx|js|jsx|md|yml|yaml|json|conf|sh|py|go|rs|rb|java|kt|swift)$/;
