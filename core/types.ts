// Shared types for the ninthwave CLI.

export type Priority = "critical" | "high" | "medium" | "low";
export type Status = "open" | "in-progress";

export interface TodoItem {
  id: string; // e.g., "H-BF5-1"
  priority: Priority;
  title: string;
  domain: string; // normalized domain slug
  dependencies: string[]; // list of dependency IDs
  bundleWith: string[]; // list of bundle IDs
  status: Status;
  lineNumber: number; // line in TODOS.md where this item starts
  lineEndNumber: number; // last line of this item's section
  repoAlias: string; // "" | "self" | "hub" | repo name
  rawText: string; // full markdown text of the TODO item
  filePaths: string[]; // extracted file paths mentioned in the item
  testPlan: string; // extracted from **Test plan:** section (empty if not present)
}

export interface ProjectConfig {
  locExtensions: string;
  [key: string]: string;
}

export interface WorktreeInfo {
  todoId: string;
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
}

// ID pattern: X-code-N (e.g., H-BF5-1, D-2-1)
export const ID_PATTERN = /[A-Z]-[A-Za-z0-9]+-[0-9]+/;
export const ID_PATTERN_GLOBAL = /[A-Z]-[A-Za-z0-9]+-[0-9]+/g;
export const ID_IN_PARENS = /\(([A-Z]-[A-Za-z0-9]+-[0-9]+)/;

// Wildcard dependency pattern: matches patterns like "MUX-*", "H-MUX-*", "DF-*"
// Captures an uppercase start, optional hyphen-separated segments, ending with -*
export const WILDCARD_DEP_PATTERN = /[A-Z](?:[A-Za-z0-9]*-)*\*/g;

// Default LOC extensions for version-bump
export const DEFAULT_LOC_EXTENSIONS =
  "*.ex *.exs *.ts *.tsx *.js *.jsx *.py *.go *.rs *.rb *.java *.kt *.swift";

// Task backend interface for external work-item sources.
export interface TaskBackend {
  /** List all work items from the backend. */
  list(): TodoItem[];
  /** Read a single work item by ID. */
  read(id: string): TodoItem | undefined;
  /** Mark a work item as done. */
  markDone(id: string): boolean;
}

// File extension patterns for path extraction
export const CODE_EXTENSIONS =
  /\.(ex|exs|ts|tsx|js|jsx|md|yml|yaml|json|conf|sh|py|go|rs|rb|java|kt|swift)$/;
export const CODE_EXTENSIONS_FOR_LINE =
  /\.(ex|exs|ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift)$/;
