// Interactive CLI prompts for the orchestrate command.
// Two modes:
// 1. TUI widgets (default for TTY) -- in-screen selection with raw keypresses
// 2. Readline fallback (legacy, non-TTY, or when TUI is explicitly disabled)
// All I/O is injectable for testing.

import { createInterface } from "readline";
import { BOLD, DIM, GREEN, YELLOW, CYAN, RESET } from "./output.ts";
import type { WorkItem } from "./types.ts";
import { PRIORITY_NUM } from "./types.ts";
import type { MergeStrategy } from "./orchestrator.ts";
import type { CrewAction } from "./commands/crew.ts";
import {
  runSelectionScreen,
  createProcessIO,
  type WidgetIO,
  type SelectionScreenResult,
} from "./tui-widgets.ts";

// ── Types ────────────────────────────────────────────────────────────

export type PromptFn = (question: string) => Promise<string>;

export interface InteractiveResult {
  itemIds: string[];
  mergeStrategy: MergeStrategy;
  wipLimit: number;
  allSelected: boolean;
  reviewMode: "all" | "mine" | "off";
  crewAction: CrewAction | null;
}

export interface InteractiveDeps {
  prompt?: PromptFn;
  isTTY?: boolean;
  /** When true, skip TUI widgets and use readline prompts. */
  useLegacyPrompts?: boolean;
  /** Injectable WidgetIO for testing the TUI path. */
  widgetIO?: WidgetIO;
}

// ── Default prompt using readline ────────────────────────────────────

const defaultPrompt: PromptFn = (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

// ── Merge strategy descriptions ──────────────────────────────────────

interface StrategyOption {
  value: MergeStrategy;
  label: string;
  description: string;
}

const MERGE_STRATEGIES: StrategyOption[] = [
  {
    value: "auto",
    label: "auto",
    description: "Auto-merge when CI passes (and review completes, if enabled)",
  },
  {
    value: "manual",
    label: "manual",
    description: "Create PR, never auto-merge -- human clicks merge",
  },
];

// ── Detection ────────────────────────────────────────────────────────

/**
 * Returns true when interactive mode should activate:
 * no --items flag provided AND stdin is a TTY.
 */
export function shouldEnterInteractive(
  hasItems: boolean,
  deps: InteractiveDeps = {},
): boolean {
  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true);
  return !hasItems && isTTY;
}

// ── Display-only item summary ───────────────────────────────────────

/**
 * Render a read-only numbered list of available work items.
 * Sorted by priority with color coding and dependency info.
 * Display-only -- no selection prompt.
 */
export function displayItemsSummary(todos: WorkItem[]): void {
  if (todos.length === 0) {
    console.log(`  ${YELLOW}No work items found.${RESET}`);
    return;
  }

  // Sort by priority then ID (same logic as promptItems)
  const sorted = [...todos].sort((a, b) => {
    const pa = PRIORITY_NUM[a.priority] ?? 3;
    const pb = PRIORITY_NUM[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });

  console.log();
  console.log(`${BOLD}Work items (${sorted.length}):${RESET}`);
  console.log();
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    const priorityColor =
      t.priority === "critical" || t.priority === "high"
        ? YELLOW
        : DIM;
    const depInfo =
      t.dependencies.length > 0
        ? ` ${DIM}(deps: ${t.dependencies.join(", ")})${RESET}`
        : "";
    console.log(
      `  ${BOLD}${String(i + 1).padStart(3)}${RESET}. ${CYAN}${t.id}${RESET}  ${priorityColor}[${t.priority}]${RESET}  ${t.title}${depInfo}`,
    );
  }
  console.log();
}

// ── Mode prompt ─────────────────────────────────────────────────────

export type Mode = "orchestrate" | "launch" | "quit";

/**
 * Prompt the user to choose between "Orchestrate" (default) and "Launch subset".
 * Returns "orchestrate", "launch", or "quit".
 * Used by cmdNoArgs() in onboard.ts for the mode-first flow.
 */
export async function promptMode(
  prompt: PromptFn,
): Promise<Mode> {
  console.log(`  ${BOLD}1${RESET}. ${CYAN}Orchestrate${RESET}  ${DIM}-- daemon mode with auto-merge and monitoring${RESET} ${GREEN}(default)${RESET}`);
  console.log(`  ${BOLD}2${RESET}. ${CYAN}Launch subset${RESET} ${DIM}-- targeted work on selected items${RESET}`);
  console.log();

  while (true) {
    const answer = await prompt(`${BOLD}Choose [1-2]: ${RESET}`);

    if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
      return "quit";
    }

    // Default to orchestrate on empty input
    if (answer === "" || answer === "1" || answer.toLowerCase() === "orchestrate") {
      return "orchestrate";
    }

    if (answer === "2" || answer.toLowerCase() === "launch") {
      return "launch";
    }

    console.log(`  ${YELLOW}Enter 1, 2, or "q" to quit.${RESET}`);
  }
}

// ── Item selection ───────────────────────────────────────────────────

/**
 * Display available TODOs and let the user toggle selections.
 * Accepts space/comma-separated numbers or ranges (e.g. "1 3 5" or "1-4,6").
 * Entering "all" selects everything.
 */
export async function promptItems(
  todos: WorkItem[],
  prompt: PromptFn,
): Promise<string[]> {
  if (todos.length === 0) {
    console.log(`  ${YELLOW}No work items found.${RESET}`);
    return [];
  }

  // Sort by priority then ID
  const sorted = [...todos].sort((a, b) => {
    const pa = PRIORITY_NUM[a.priority] ?? 3;
    const pb = PRIORITY_NUM[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });

  console.log();
  console.log(`${BOLD}Available work items:${RESET}`);
  console.log();
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    const priorityColor =
      t.priority === "critical" || t.priority === "high"
        ? YELLOW
        : DIM;
    const depInfo =
      t.dependencies.length > 0
        ? ` ${DIM}(deps: ${t.dependencies.join(", ")})${RESET}`
        : "";
    console.log(
      `  ${BOLD}${String(i + 1).padStart(3)}${RESET}. ${CYAN}${t.id}${RESET}  ${priorityColor}[${t.priority}]${RESET}  ${t.title}${depInfo}`,
    );
  }
  console.log();
  console.log(
    `  ${DIM}Enter numbers (e.g. "1 3 5"), ranges ("1-4"), "all", or "q" to quit.${RESET}`,
  );

  while (true) {
    const answer = await prompt(`${BOLD}Select items: ${RESET}`);

    if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
      return [];
    }

    if (answer.toLowerCase() === "all") {
      return sorted.map((t) => t.id);
    }

    const indices = parseSelection(answer, sorted.length);
    if (indices.length === 0) {
      console.log(
        `  ${YELLOW}No valid selection. Enter numbers 1-${sorted.length}, ranges, "all", or "q".${RESET}`,
      );
      continue;
    }

    return indices.map((idx) => sorted[idx]!.id);
  }
}

/**
 * Parse a selection string like "1 3 5" or "1-4,6" into 0-based indices.
 * Returns only valid indices within [0, max).
 */
export function parseSelection(input: string, max: number): number[] {
  const indices = new Set<number>();
  // Split on commas and whitespace
  const tokens = input.split(/[\s,]+/).filter(Boolean);

  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      for (let n = Math.min(start, end); n <= Math.max(start, end); n++) {
        if (n >= 1 && n <= max) indices.add(n - 1);
      }
    } else {
      const n = parseInt(token, 10);
      if (!isNaN(n) && n >= 1 && n <= max) indices.add(n - 1);
    }
  }

  return [...indices].sort((a, b) => a - b);
}

// ── Merge strategy prompt ────────────────────────────────────────────

export async function promptMergeStrategy(
  prompt: PromptFn,
): Promise<MergeStrategy> {
  console.log();
  console.log(`${BOLD}Merge strategy:${RESET}`);
  console.log();
  for (let i = 0; i < MERGE_STRATEGIES.length; i++) {
    const s = MERGE_STRATEGIES[i]!;
    const defaultTag = s.value === "auto" ? ` ${GREEN}(default)${RESET}` : "";
    console.log(
      `  ${BOLD}${i + 1}${RESET}. ${CYAN}${s.label}${RESET}  ${DIM}-- ${s.description}${RESET}${defaultTag}`,
    );
  }
  console.log();

  while (true) {
    const answer = await prompt(
      `${BOLD}Choose [1-${MERGE_STRATEGIES.length}]: ${RESET}`,
    );

    // Default to auto on empty input
    if (answer === "") return "auto";

    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < MERGE_STRATEGIES.length) {
      return MERGE_STRATEGIES[idx]!.value;
    }

    // Also accept typing the name directly
    const byName = MERGE_STRATEGIES.find(
      (s) => s.value === answer.toLowerCase(),
    );
    if (byName) return byName.value;

    console.log(
      `  ${YELLOW}Enter 1-${MERGE_STRATEGIES.length} or a strategy name.${RESET}`,
    );
  }
}

// ── WIP limit prompt ─────────────────────────────────────────────────

export async function promptWipLimit(
  defaultLimit: number,
  prompt: PromptFn,
): Promise<number> {
  console.log();

  while (true) {
    const answer = await prompt(
      `${BOLD}WIP limit${RESET} ${DIM}[1-10, default ${defaultLimit}]:${RESET} `,
    );

    // Default on empty input
    if (answer === "") return defaultLimit;

    const n = parseInt(answer, 10);
    if (!isNaN(n) && n >= 1 && n <= 10) return n;

    console.log(`  ${YELLOW}Enter a number between 1 and 10.${RESET}`);
  }
}

// ── Summary + confirmation ───────────────────────────────────────────

export async function confirmSummary(
  result: InteractiveResult,
  todos: WorkItem[],
  prompt: PromptFn,
): Promise<boolean> {
  const itemMap = new Map(todos.map((t) => [t.id, t]));

  console.log();
  console.log(`${BOLD}━━━ Summary ━━━${RESET}`);
  console.log();
  console.log(`  ${BOLD}Items (${result.itemIds.length}):${RESET}`);
  for (const id of result.itemIds) {
    const t = itemMap.get(id);
    console.log(`    ${CYAN}${id}${RESET}  ${t?.title ?? ""}`);
  }
  console.log(`  ${BOLD}Merge strategy:${RESET}  ${result.mergeStrategy}`);
  console.log(`  ${BOLD}WIP limit:${RESET}       ${result.wipLimit}`);
  console.log();

  const answer = await prompt(
    `${BOLD}Start orchestration? [Y/n]:${RESET} `,
  );
  return answer.toLowerCase() !== "n" && answer.toLowerCase() !== "no";
}

// ── TUI widget flow ─────────────────────────────────────────────────

/**
 * Run the in-TUI selection flow using raw-mode widgets.
 * Enters raw mode, runs widgets, then restores terminal state.
 * Returns null if cancelled.
 */
export async function runTuiSelectionFlow(
  todos: WorkItem[],
  defaultWipLimit: number,
  deps: InteractiveDeps = {},
): Promise<InteractiveResult | null> {
  const io = deps.widgetIO ?? createProcessIO();
  const stdin = process.stdin;

  // Enter raw mode for widget key handling (unless testing with injected IO)
  const needsRawMode = !deps.widgetIO && stdin.isTTY && stdin.setRawMode;
  if (needsRawMode) {
    stdin.setRawMode!(true);
    stdin.resume();
    stdin.setEncoding("utf8");
  }

  try {
    const result = await runSelectionScreen(io, todos, defaultWipLimit);
    if (!result || result.cancelled) return null;

    return {
      itemIds: result.itemIds,
      mergeStrategy: result.mergeStrategy,
      wipLimit: result.wipLimit,
      allSelected: result.allSelected,
      reviewMode: "off",   // temp default until H-WJ-3
      crewAction: null,    // temp default until H-WJ-3
    };
  } finally {
    // Restore terminal state
    if (needsRawMode) {
      stdin.setRawMode!(false);
      stdin.pause();
    }
  }
}

// ── Main interactive flow ────────────────────────────────────────────

/**
 * Run the full interactive selection flow.
 * Uses TUI widgets by default on TTY; falls back to readline when
 * useLegacyPrompts is true or not a TTY.
 * Returns null if the user cancels at any point.
 */
export async function runInteractiveFlow(
  todos: WorkItem[],
  defaultWipLimit: number,
  deps: InteractiveDeps = {},
): Promise<InteractiveResult | null> {
  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true);

  // Use TUI widgets unless explicitly disabled or not a TTY
  if (!deps.useLegacyPrompts && (isTTY || deps.widgetIO)) {
    return runTuiSelectionFlow(todos, defaultWipLimit, deps);
  }

  // Legacy readline fallback
  return runReadlineFlow(todos, defaultWipLimit, deps);
}

/**
 * Legacy readline-based interactive flow.
 * Kept as fallback for non-TTY or explicit opt-in.
 */
async function runReadlineFlow(
  todos: WorkItem[],
  defaultWipLimit: number,
  deps: InteractiveDeps = {},
): Promise<InteractiveResult | null> {
  const prompt = deps.prompt ?? defaultPrompt;

  // Step 1: Item selection
  const itemIds = await promptItems(todos, prompt);
  if (itemIds.length === 0) return null;

  // Step 2: Merge strategy
  const mergeStrategy = await promptMergeStrategy(prompt);

  // Step 3: WIP limit
  const wipLimit = await promptWipLimit(defaultWipLimit, prompt);

  // Step 4: Summary + confirmation
  const result: InteractiveResult = {
    itemIds,
    mergeStrategy,
    wipLimit,
    allSelected: false,   // legacy readline path doesn't support __ALL__
    reviewMode: "off",    // temp default until H-WJ-3
    crewAction: null,     // temp default until H-WJ-3
  };

  const confirmed = await confirmSummary(result, todos, prompt);
  if (!confirmed) {
    console.log(`  ${DIM}Cancelled.${RESET}`);
    return null;
  }

  return result;
}
