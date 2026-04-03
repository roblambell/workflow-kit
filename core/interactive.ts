// Interactive CLI prompts for the orchestrate command.
// Two modes:
// 1. TUI widgets (default for TTY) -- in-screen selection with raw keypresses
// 2. Readline fallback (legacy, non-TTY, or when TUI is explicitly disabled)
// All I/O is injectable for testing.

import { createInterface } from "readline";
import { BOLD, DIM, GREEN, YELLOW, CYAN, RESET } from "./output.ts";
import type { UserConfig } from "./config.ts";
import type { WorkItem } from "./types.ts";
import { PRIORITY_NUM } from "./types.ts";
import type { MergeStrategy } from "./orchestrator.ts";
import type { ConnectionAction } from "./commands/crew.ts";
import { formatInvalidCrewCodeMessage, parseCrewCode } from "./commands/crew.ts";
import type { AiToolProfile } from "./ai-tools.ts";
import type { StartupItemsRefreshResult } from "./startup-items.ts";
import {
  STARTUP_COLLABORATION_MODE_OPTIONS,
  STARTUP_MERGE_STRATEGY_OPTIONS,
  STARTUP_REVIEW_MODE_OPTIONS,
  type PersistedBackendMode,
  type StartupReviewMode as ReviewMode,
  type TuiSettingsDefaults,
} from "./tui-settings.ts";
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
  backendMode?: PersistedBackendMode;
  mergeStrategy: MergeStrategy;
  sessionLimit: number;
  allSelected: boolean;
  /** True when starting with no current items and watching future work only. */
  futureOnly?: boolean;
  reviewMode: "all" | "mine" | "off";
  connectionAction: ConnectionAction | null;
  scheduleEnabled?: boolean;
  /** Selected AI tool ID, undefined when the step was skipped. */
  aiTool?: string;
  /** Selected AI tool IDs (multi-select), undefined when the step was skipped. */
  aiTools?: string[];
}

export interface InteractiveDeps {
  prompt?: PromptFn;
  isTTY?: boolean;
  /** When true, skip TUI widgets and use readline prompts. */
  useLegacyPrompts?: boolean;
  /** Injectable WidgetIO for testing the TUI path. */
  widgetIO?: WidgetIO;
  /** When false, skip the connection step (e.g. run-more re-entry where session is already active). */
  showConnectionStep?: boolean;
  /** Default review mode from project config. */
  defaultReviewMode?: "all" | "mine" | "off";
  /** Resolved startup settings defaults for future TUI settings widgets. */
  defaultSettings?: TuiSettingsDefaults;
  /** Pre-detected installed AI tool profiles. Skip tool step if undefined or single entry. */
  installedTools?: AiToolProfile[];
  /** One-shot async startup refresh applied after the picker first paints. */
  refreshStartupItems?: () => Promise<StartupItemsRefreshResult>;
  /** Pre-selected tool IDs from user config (multi-select). */
  savedToolIds?: string[];
  /** When true, skip the AI tool step (tool already determined by --tool or user config). */
  skipToolStep?: boolean;
}

export interface StartupPersistenceOptions {
  backendMode?: PersistedBackendMode;
  savedToolIds?: string[];
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

const STARTUP_MERGE_STRATEGIES = STARTUP_MERGE_STRATEGY_OPTIONS;

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

// ── Item selection ───────────────────────────────────────────────────

export interface PromptItemsResult {
  ids: string[];
  allSelected: boolean;
}

/**
 * Display available work items and let the user toggle selections.
 * Accepts space/comma-separated numbers or ranges (e.g. "1 3 5" or "1-4,6").
 * Entering "all" or selecting every item sets allSelected: true.
 */
export async function promptItems(
  todos: WorkItem[],
  prompt: PromptFn,
): Promise<PromptItemsResult> {
  if (todos.length === 0) {
    console.log(`  ${YELLOW}No work items found.${RESET}`);
    return { ids: [], allSelected: false };
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
    const answer = await prompt(`${BOLD}Select work items: ${RESET}`);

    if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
      return { ids: [], allSelected: false };
    }

    if (answer.toLowerCase() === "all") {
      return { ids: sorted.map((t) => t.id), allSelected: true };
    }

    const indices = parseSelection(answer, sorted.length);
    if (indices.length === 0) {
      console.log(
        `  ${YELLOW}No valid selection. Enter work item numbers 1-${sorted.length}, ranges, "all", or "q".${RESET}`,
      );
      continue;
    }

    const ids = indices.map((idx) => sorted[idx]!.id);
    return { ids, allSelected: ids.length === sorted.length };
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
  for (let i = 0; i < STARTUP_MERGE_STRATEGIES.length; i++) {
    const s = STARTUP_MERGE_STRATEGIES[i]!;
    const defaultTag = s.runtimeValue === "auto" ? ` ${GREEN}(default)${RESET}` : "";
    console.log(
      `  ${BOLD}${i + 1}${RESET}. ${CYAN}${s.startupLabel}${RESET}  ${DIM}-- ${s.startupDescription}${RESET}${defaultTag}`,
    );
  }
  console.log();

  while (true) {
    const answer = await prompt(
      `${BOLD}Choose [1-${STARTUP_MERGE_STRATEGIES.length}]: ${RESET}`,
    );

    // Default to auto on empty input
    if (answer === "") return "auto";

    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < STARTUP_MERGE_STRATEGIES.length) {
      return STARTUP_MERGE_STRATEGIES[idx]!.runtimeValue;
    }

    // Also accept typing the name directly
    const byName = STARTUP_MERGE_STRATEGIES.find(
      (s) => s.startupLabel === answer.toLowerCase(),
    );
    if (byName) return byName.runtimeValue;

    console.log(
      `  ${YELLOW}Enter 1-${STARTUP_MERGE_STRATEGIES.length} or a strategy name.${RESET}`,
    );
  }
}

// ── WIP limit prompt ─────────────────────────────────────────────────

export async function promptSessionLimit(
  defaultLimit: number,
  prompt: PromptFn,
): Promise<number> {
  console.log();

  while (true) {
    const answer = await prompt(
      `${BOLD}Session limit${RESET} ${DIM}[1-10, default ${defaultLimit}]:${RESET} `,
    );

    // Default on empty input
    if (answer === "") return defaultLimit;

    const n = parseInt(answer, 10);
    if (!isNaN(n) && n >= 1 && n <= 10) return n;

    console.log(`  ${YELLOW}Enter a number between 1 and 10.${RESET}`);
  }
}

/**
 * Prompt the user to choose AI review mode.
 * Returns "all", "mine", or "off".
 */
export async function promptReviewMode(
  defaultMode: ReviewMode,
  prompt: PromptFn,
): Promise<ReviewMode> {
  console.log();
  console.log(`${BOLD}AI reviews:${RESET}`);
  console.log();
  for (let i = 0; i < STARTUP_REVIEW_MODE_OPTIONS.length; i++) {
    const o = STARTUP_REVIEW_MODE_OPTIONS[i]!;
    const defaultTag = o.persistedValue === defaultMode ? ` ${GREEN}(default)${RESET}` : "";
    console.log(
      `  ${BOLD}${i + 1}${RESET}. ${CYAN}${o.startupLabel}${RESET}  ${DIM}-- ${o.startupDescription}${RESET}${defaultTag}`,
    );
  }
  console.log();

  while (true) {
    const answer = await prompt(
      `${BOLD}Choose [1-${STARTUP_REVIEW_MODE_OPTIONS.length}]: ${RESET}`,
    );

    // Default on empty input
    if (answer === "") return defaultMode;

    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < STARTUP_REVIEW_MODE_OPTIONS.length) {
      return STARTUP_REVIEW_MODE_OPTIONS[idx]!.persistedValue;
    }

    // Accept typing the name directly
    const byName = STARTUP_REVIEW_MODE_OPTIONS.find((o) => o.startupLabel === answer.toLowerCase());
    if (byName) return byName.persistedValue;

    console.log(
      `  ${YELLOW}Enter 1-${STARTUP_REVIEW_MODE_OPTIONS.length} or a mode name (all/mine/off).${RESET}`,
    );
  }
}

// ── Connection mode prompt ──────────────────────────────────────────

/**
 * Prompt the user to choose connection mode.
 * Returns a ConnectionAction or null for local mode.
 */
export async function promptConnectionMode(
  prompt: PromptFn,
  defaultMode: "local" | "share" | "join" = "local",
): Promise<ConnectionAction | null> {
  console.log();
  console.log(`${BOLD}Collaborate via ninthwave.sh:${RESET}`);
  console.log();
  for (let i = 0; i < STARTUP_COLLABORATION_MODE_OPTIONS.length; i++) {
    const option = STARTUP_COLLABORATION_MODE_OPTIONS[i]!;
    const defaultTag = option.persistedValue === defaultMode ? ` ${GREEN}(default)${RESET}` : "";
    console.log(`  ${BOLD}${i + 1}${RESET}. ${CYAN}${option.startupLabel}${RESET}    ${DIM}-- ${option.startupDescription}${RESET}${defaultTag}`);
  }
  console.log();

  while (true) {
    const answer = (await prompt(`${BOLD}Choose [1-3]: ${RESET}`)).trim();
    const selection = answer === "" ? defaultMode : answer.toLowerCase();

    if (selection === "1" || selection === "local") {
      return null;
    }

    if (selection === "2" || selection === "share" || selection === "connect") {
      return { type: "connect" };
    }

    if (selection === "3" || selection === "join") {
      while (true) {
        const code = await prompt(`${BOLD}Session code: ${RESET}`);
        if (code === "" || code.toLowerCase() === "q") return null;
        const normalizedCode = parseCrewCode(code);
        if (normalizedCode) {
          return { type: "join", code: normalizedCode };
        }
        console.log(`  ${YELLOW}${formatInvalidCrewCodeMessage(code)}${RESET}`);
      }
    }

    console.log(`  ${YELLOW}Enter 1-3 or a mode name (share/join/local).${RESET}`);
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
  if (result.futureOnly) {
    console.log(`  ${BOLD}Items:${RESET}  Future tasks ${DIM}(start when new work arrives)${RESET}`);
  } else {
    console.log(`  ${BOLD}Items (${result.itemIds.length}):${RESET}`);
    for (const id of result.itemIds) {
      const t = itemMap.get(id);
      console.log(`    ${CYAN}${id}${RESET}  ${t?.title ?? ""}`);
    }
  }
  console.log(`  ${BOLD}Merge strategy:${RESET}  ${result.mergeStrategy}`);
  if (result.backendMode) {
    console.log(`  ${BOLD}Backend:${RESET}         ${result.backendMode}`);
  }
  console.log(`  ${BOLD}Session limit:${RESET}   ${result.sessionLimit}`);
  console.log(`  ${BOLD}AI reviews:${RESET}      ${result.reviewMode}`);
  if (result.scheduleEnabled !== undefined) {
    console.log(`  ${BOLD}Scheduled tasks:${RESET} ${result.scheduleEnabled ? "On" : "Off"}`);
  }
  if (result.connectionAction) {
    const connectionLabel = result.connectionAction.type === "connect"
      ? "Share session (new)"
      : `Join session (${result.connectionAction.code})`;
    console.log(`  ${BOLD}Collaboration:${RESET}   ${connectionLabel}`);
  } else {
    console.log(`  ${BOLD}Collaboration:${RESET}   Local by default`);
  }
  if (result.aiTools && result.aiTools.length > 0) {
    const toolLabel = result.aiTools.join(", ") + (result.aiTools.length > 1 ? " (round-robin)" : "");
    console.log(`  ${BOLD}AI tool:${RESET}         ${toolLabel}`);
  } else if (result.aiTool) {
    console.log(`  ${BOLD}AI tool:${RESET}         ${result.aiTool}`);
  }
  console.log();

  const answer = await prompt(
    `${BOLD}Start orchestration? [Y/n]:${RESET} `,
  );
  return answer.toLowerCase() !== "n" && answer.toLowerCase() !== "no";
}

export function buildStartupPersistenceUpdates(
  result: InteractiveResult,
  options: StartupPersistenceOptions = {},
): Partial<UserConfig> {
  const aiTools = result.aiTools && result.aiTools.length > 0
    ? [...result.aiTools]
    : result.aiTool
    ? [result.aiTool]
    : options.savedToolIds && options.savedToolIds.length > 0
    ? [...options.savedToolIds]
    : undefined;

  const backendMode = result.backendMode ?? options.backendMode;

  return {
    ...(backendMode ? { backend_mode: backendMode } : {}),
    merge_strategy: result.mergeStrategy === "auto" ? "auto" : "manual",
    review_mode: result.reviewMode,
    session_limit: result.sessionLimit,
    collaboration_mode: result.connectionAction?.type === "connect"
      ? "share"
      : result.connectionAction?.type === "join"
      ? "join"
      : "local",
    ...(aiTools ? { ai_tools: aiTools } : {}),
  };
}

// ── TUI widget flow ─────────────────────────────────────────────────

/**
 * Run the in-TUI selection flow using raw-mode widgets.
 * Enters raw mode, runs widgets, then restores terminal state.
 * Returns null if cancelled.
 */
export async function runTuiSelectionFlow(
  todos: WorkItem[],
  defaultSessionLimit: number,
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
    const result = await runSelectionScreen(io, todos, defaultSessionLimit, {
      defaultReviewMode: deps.defaultReviewMode,
      defaultSettings: deps.defaultSettings,
      showConnectionStep: deps.showConnectionStep,
      installedTools: deps.skipToolStep ? undefined : deps.installedTools,
      refreshItems: deps.refreshStartupItems,
      savedToolIds: deps.savedToolIds,
    });
    if (!result || result.cancelled) return null;

      return {
        itemIds: result.itemIds,
        backendMode: result.backendMode,
        mergeStrategy: result.mergeStrategy,
        sessionLimit: result.sessionLimit,
      allSelected: result.allSelected,
      futureOnly: result.futureOnly,
      reviewMode: result.reviewMode,
      connectionAction: result.connectionAction,
      scheduleEnabled: result.scheduleEnabled,
      aiTool: result.aiTool,
      aiTools: result.aiTools,
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
  defaultSessionLimit: number,
  deps: InteractiveDeps = {},
): Promise<InteractiveResult | null> {
  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true);

  // Use TUI widgets unless explicitly disabled or not a TTY
  if (!deps.useLegacyPrompts && (isTTY || deps.widgetIO)) {
    return runTuiSelectionFlow(todos, defaultSessionLimit, deps);
  }

  // Legacy readline fallback
  return runReadlineFlow(todos, defaultSessionLimit, deps);
}

/**
 * Legacy readline-based interactive flow (local-first).
 * Merge strategy, WIP, and review mode stay on local-first defaults.
 * Collaboration only changes when the user explicitly chooses share/join.
 */
async function runReadlineFlow(
  todos: WorkItem[],
  defaultSessionLimit: number,
  deps: InteractiveDeps = {},
): Promise<InteractiveResult | null> {
  const prompt = deps.prompt ?? defaultPrompt;

  // Step 1: Item selection
  const itemResult = await promptItems(todos, prompt);
  if (itemResult.ids.length === 0) return null;

  // Local-first defaults -- no prompts for these
  const mergeStrategy: MergeStrategy = "manual";
  const backendMode: PersistedBackendMode = deps.defaultSettings?.backendMode ?? "auto";
  const sessionLimit = defaultSessionLimit;
  const reviewMode: ReviewMode = "off";
  const scheduleEnabled = deps.defaultSettings?.scheduleEnabled ?? false;
  let connectionAction: ConnectionAction | null = null;

  // Step 2: AI tool (conditional, multi-select)
  let aiTool: string | undefined;
  let aiTools: string[] | undefined;
  const tools = deps.skipToolStep ? [] : (deps.installedTools ?? []);
  if (tools.length >= 2) {
    const savedIds = deps.savedToolIds ?? [];
    const selected = new Set<number>();
    // Pre-check saved tools or first if none saved
    if (savedIds.length > 0) {
      for (const sid of savedIds) {
        const idx = tools.findIndex((t) => t.id === sid);
        if (idx >= 0) selected.add(idx);
      }
    }
    if (selected.size === 0) selected.add(0);

    const renderToolList = () => {
      console.log();
      console.log(`${BOLD}AI coding tool(s):${RESET} ${DIM}toggle with number, Enter to confirm${RESET}`);
      for (let i = 0; i < tools.length; i++) {
        const t = tools[i]!;
        const check = selected.has(i) ? `[x]` : `[ ]`;
        console.log(`  ${BOLD}${i + 1}${RESET}. ${check} ${t.displayName}`);
        console.log(`     ${DIM}Model defined in ${t.targetDir}/ agent files${RESET}`);
      }
    };

    renderToolList();

    while (true) {
      const answer = await prompt(`Toggle [1-${tools.length}] or Enter to confirm: `);
      if (answer === "") {
        if (selected.size === 0) {
          console.log(`  ${YELLOW}Select at least one tool.${RESET}`);
          continue;
        }
        break;
      }
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < tools.length) {
        if (selected.has(idx)) {
          selected.delete(idx);
        } else {
          selected.add(idx);
        }
        renderToolList();
      } else {
        console.log(`  ${YELLOW}Enter 1-${tools.length}.${RESET}`);
      }
    }
    aiTools = [...selected].sort().map((i) => tools[i]!.id);
    aiTool = aiTools[0];
  } else if (tools.length === 1) {
    aiTool = tools[0]!.id;
    aiTools = [aiTool];
  }

  if (deps.showConnectionStep !== false) {
    connectionAction = await promptConnectionMode(
      prompt,
      deps.defaultSettings?.collaborationMode ?? "local",
    );
  }

  // Step 3: Summary + confirmation
  const result: InteractiveResult = {
    itemIds: itemResult.ids,
    backendMode,
    mergeStrategy,
    sessionLimit,
    allSelected: itemResult.allSelected,
    futureOnly: false,
    reviewMode,
    connectionAction,
    scheduleEnabled,
    aiTool,
    aiTools,
  };

  const confirmed = await confirmSummary(result, todos, prompt);
  if (!confirmed) {
    console.log(`  ${DIM}Cancelled.${RESET}`);
    return null;
  }

  return result;
}
