// TUI selection widgets rendered in-screen with raw ANSI.
// Three primitives: CheckboxList, SingleSelectPicker, NumberPicker.
// All widgets work in raw mode using arrow keys, space/Enter for interaction.
// Designed for the alt-screen buffer -- no readline dependency.

import { BOLD, DIM, GREEN, YELLOW, CYAN, RESET, RED } from "./output.ts";
import type { WorkItem } from "./types.ts";
import { PRIORITY_NUM } from "./types.ts";
import type { MergeStrategy } from "./orchestrator.ts";
import type { CrewAction } from "./commands/crew.ts";
import { CREW_CODE_PATTERN, normalizeCrewCode } from "./commands/crew.ts";

// ── ANSI escape helpers ─────────────────────────────────────────────

const HIDE_CURSOR = "\x1B[?25l";
const SHOW_CURSOR = "\x1B[?25h";
const CLEAR_SCREEN = "\x1B[2J\x1B[H"; // clear + cursor home
const CURSOR_HOME = "\x1B[H";

// Move cursor to row,col (1-based)
function moveTo(row: number, col: number): string {
  return `\x1B[${row};${col}H`;
}

// Clear from cursor to end of line
const CLEAR_LINE = "\x1B[K";

// ── Types ───────────────────────────────────────────────────────────

export interface WidgetIO {
  write: (s: string) => void;
  onKey: (handler: (key: string) => void) => void;
  offKey: (handler: (key: string) => void) => void;
  getRows: () => number;
  getCols: () => number;
}

export interface CheckboxItem {
  id: string;
  label: string;
  detail?: string; // e.g., priority, deps
  checked: boolean;
}

export interface CheckboxListResult {
  selectedIds: string[];
  cancelled: boolean;
  allSelected: boolean;
}

export interface SingleSelectOption<T> {
  value: T;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface SingleSelectResult<T> {
  value: T;
  cancelled: boolean;
}

export interface NumberPickerResult {
  value: number;
  cancelled: boolean;
}

export interface TextInputResult {
  value: string;
  cancelled: boolean;
}

/** Result of the full selection screen flow. */
export interface SelectionScreenResult {
  itemIds: string[];
  allSelected: boolean;
  mergeStrategy: MergeStrategy;
  wipLimit: number;
  reviewMode: "all" | "mine" | "off";
  crewAction: CrewAction | null;
  cancelled: boolean;
}

// ── Checkbox List Widget ────────────────────────────────────────────

/**
 * Multi-select checkbox list. Arrow keys navigate, Space toggles, Enter confirms.
 * Escape cancels. Renders within the given viewport area.
 *
 * When `opts.linkAllId` is set, the item with that id acts as an __ALL__ sentinel:
 * toggling it checks/unchecks all others, and unchecking any item auto-unchecks it
 * while re-checking the last unchecked item re-checks it.
 */
export function runCheckboxList(
  io: WidgetIO,
  items: CheckboxItem[],
  opts: { title?: string; errorMessage?: string; linkAllId?: string; validate?: (selectedIds: string[]) => string | null } = {},
): Promise<CheckboxListResult> {
  return new Promise((resolve) => {
    if (items.length === 0) {
      resolve({ selectedIds: [], cancelled: true, allSelected: false });
      return;
    }

    let cursor = 0;
    let scrollOffset = 0;
    let error = opts.errorMessage ?? "";
    let warningAcked = false;

    const render = () => {
      const rows = io.getRows();
      const cols = io.getCols();
      // Layout: title (2 lines), items (variable), footer (3 lines)
      const headerLines = 3; // title + blank + optional error
      const footerLines = 3; // blank + instructions + blank
      const separatorLines = opts.linkAllId ? 1 : 0; // blank line after sentinel
      const viewportHeight = Math.max(1, rows - headerLines - footerLines - separatorLines);

      // Clamp scroll to keep cursor visible
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + viewportHeight) {
        scrollOffset = cursor - viewportHeight + 1;
      }

      let out = CURSOR_HOME;

      // Title
      const title = opts.title ?? "Select items";
      out += `${BOLD}${title}${RESET}${CLEAR_LINE}\n`;

      // Selected count (exclude sentinel from both numerator and denominator)
      const countItems = opts.linkAllId ? items.filter((i) => i.id !== opts.linkAllId) : items;
      const selectedCount = countItems.filter((i) => i.checked).length;
      out += `${DIM}${selectedCount}/${countItems.length} selected${RESET}${CLEAR_LINE}\n`;

      // Error line (or blank)
      if (error) {
        out += `${RED}${error}${RESET}${CLEAR_LINE}\n`;
      } else {
        out += `${CLEAR_LINE}\n`;
      }

      // Items
      const visibleEnd = Math.min(items.length, scrollOffset + viewportHeight);
      for (let i = scrollOffset; i < visibleEnd; i++) {
        const item = items[i]!;
        const isActive = i === cursor;
        const checkbox = item.checked ? `${GREEN}[x]${RESET}` : `[ ]`;
        const pointer = isActive ? `${CYAN}>${RESET}` : " ";
        const label = isActive ? `${BOLD}${item.label}${RESET}` : item.label;
        const detail = item.detail ? ` ${DIM}${item.detail}${RESET}` : "";
        const line = `${pointer} ${checkbox} ${label}${detail}`;
        // Truncate to terminal width
        out += `${line.slice(0, cols + 60)}${CLEAR_LINE}\n`; // +60 for ANSI codes
        // Visual separator after sentinel
        if (opts.linkAllId && item.id === opts.linkAllId) {
          out += `${CLEAR_LINE}\n`;
        }
      }

      // Fill remaining viewport lines
      for (let i = visibleEnd - scrollOffset; i < viewportHeight; i++) {
        out += `${CLEAR_LINE}\n`;
      }

      // Scroll indicator
      if (items.length > viewportHeight) {
        const pct = Math.round(((scrollOffset + viewportHeight) / items.length) * 100);
        out += `${DIM}${Math.min(pct, 100)}%${RESET}${CLEAR_LINE}\n`;
      } else {
        out += `${CLEAR_LINE}\n`;
      }

      // Footer instructions
      out += `${DIM}↑/↓ navigate  Space toggle  a toggle all  Enter confirm  Esc cancel${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}`;

      io.write(out);
    };

    const handler = (key: string) => {
      error = ""; // Clear error on any keypress
      if (key !== "\r") warningAcked = false; // Reset warning ack on non-Enter keys

      switch (key) {
        case "\x1B[A": // Up arrow
        case "k":
          cursor = Math.max(0, cursor - 1);
          break;
        case "\x1B[B": // Down arrow
        case "j":
          cursor = Math.min(items.length - 1, cursor + 1);
          break;
        case " ": { // Space -- toggle
          const linkId = opts.linkAllId;
          if (linkId) {
            const item = items[cursor]!;
            if (item.id === linkId) {
              // Toggling __ALL__: set all items to match new state
              const newState = !item.checked;
              for (const i of items) i.checked = newState;
            } else {
              // Toggling a regular item (sentinel stays independent)
              item.checked = !item.checked;
            }
          } else {
            items[cursor]!.checked = !items[cursor]!.checked;
          }
          break;
        }
        case "a": { // Toggle all regular items (sentinel stays independent)
          const linkId = opts.linkAllId;
          const regularItems = linkId ? items.filter((i) => i.id !== linkId) : items;
          const allChecked = regularItems.every((i) => i.checked);
          for (const item of regularItems) item.checked = !allChecked;
          break;
        }
        case "\r": { // Enter -- confirm
          const linkId = opts.linkAllId;
          const allItem = linkId ? items.find((i) => i.id === linkId) : null;
          const regularItems = linkId ? items.filter((i) => i.id !== linkId) : items;
          const regularSelected = regularItems.filter((i) => i.checked);
          if (regularSelected.length === 0) {
            error = "Select at least one item";
            render();
            return;
          }
          // Validate selection (e.g., dependency warnings)
          if (opts.validate && !warningAcked) {
            const selectedIds = regularSelected.map((i) => i.id);
            const warning = opts.validate(selectedIds);
            if (warning) {
              error = warning;
              warningAcked = true;
              render();
              return;
            }
          }
          io.offKey(handler);
          resolve({
            selectedIds: items.filter((i) => i.checked).map((i) => i.id),
            cancelled: false,
            allSelected: allItem?.checked ?? false,
          });
          return;
        }
        case "\x1B": // Escape (single byte, not arrow sequence)
          io.offKey(handler);
          resolve({ selectedIds: [], cancelled: true, allSelected: false });
          return;
        case "\x03": // Ctrl+C
          io.offKey(handler);
          resolve({ selectedIds: [], cancelled: true, allSelected: false });
          return;
        default:
          return; // Unknown key -- no re-render
      }

      render();
    };

    io.onKey(handler);
    render();
  });
}

// ── Single-Select Picker Widget ─────────────────────────────────────

/**
 * Single-select picker. Arrow keys cycle, Enter confirms.
 * Escape cancels. Renders a compact vertical list.
 */
export function runSingleSelect<T>(
  io: WidgetIO,
  options: SingleSelectOption<T>[],
  opts: { title?: string } = {},
): Promise<SingleSelectResult<T>> {
  return new Promise((resolve) => {
    if (options.length === 0) {
      resolve({ value: undefined as T, cancelled: true });
      return;
    }

    // Start on the default option if any, else first
    let cursor = Math.max(0, options.findIndex((o) => o.isDefault));

    const render = () => {
      const cols = io.getCols();
      let out = CURSOR_HOME;

      const title = opts.title ?? "Select an option";
      out += `${BOLD}${title}${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}\n`;

      for (let i = 0; i < options.length; i++) {
        const opt = options[i]!;
        const isActive = i === cursor;
        const radio = isActive ? `${GREEN}(*)${RESET}` : `( )`;
        const label = isActive ? `${BOLD}${opt.label}${RESET}` : opt.label;
        const desc = opt.description ? ` ${DIM}-- ${opt.description}${RESET}` : "";
        const defaultTag = opt.isDefault && !isActive ? ` ${DIM}(default)${RESET}` : "";
        const line = `  ${radio} ${label}${desc}${defaultTag}`;
        out += `${line.slice(0, cols + 80)}${CLEAR_LINE}\n`;
      }

      out += `${CLEAR_LINE}\n`;
      out += `${DIM}↑/↓ navigate  Enter confirm  Esc cancel${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}`;

      io.write(out);
    };

    const handler = (key: string) => {
      switch (key) {
        case "\x1B[A": // Up
        case "k":
          cursor = (cursor - 1 + options.length) % options.length;
          break;
        case "\x1B[B": // Down
        case "j":
          cursor = (cursor + 1) % options.length;
          break;
        case "\r": // Enter
          io.offKey(handler);
          resolve({ value: options[cursor]!.value, cancelled: false });
          return;
        case "\x1B": // Escape
          io.offKey(handler);
          resolve({ value: options[0]!.value, cancelled: true });
          return;
        case "\x03": // Ctrl+C
          io.offKey(handler);
          resolve({ value: options[0]!.value, cancelled: true });
          return;
        default:
          return;
      }
      render();
    };

    io.onKey(handler);
    render();
  });
}

// ── Number Picker Widget ────────────────────────────────────────────

/**
 * Number picker with up/down to change value, clamped to [min, max].
 * Enter confirms. Escape cancels.
 */
export function runNumberPicker(
  io: WidgetIO,
  opts: { title?: string; min?: number; max?: number; initial?: number } = {},
): Promise<NumberPickerResult> {
  return new Promise((resolve) => {
    const min = opts.min ?? 1;
    const max = opts.max ?? 10;
    let value = opts.initial ?? min;
    value = Math.max(min, Math.min(max, value));

    const render = () => {
      let out = CURSOR_HOME;

      const title = opts.title ?? "Select a value";
      out += `${BOLD}${title}${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}\n`;

      // Visual scale
      const barWidth = max - min + 1;
      let bar = "  ";
      for (let n = min; n <= max; n++) {
        if (n === value) {
          bar += `${GREEN}${BOLD}[${n}]${RESET} `;
        } else {
          bar += `${DIM}${n}${RESET}  `;
        }
      }
      out += `${bar}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}\n`;
      out += `${DIM}←/→ or ↑/↓ change  Enter confirm  Esc cancel${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}`;

      io.write(out);
    };

    const handler = (key: string) => {
      switch (key) {
        case "\x1B[A": // Up
        case "\x1B[C": // Right
        case "k":
        case "l":
          value = Math.min(max, value + 1);
          break;
        case "\x1B[B": // Down
        case "\x1B[D": // Left
        case "j":
        case "h":
          value = Math.max(min, value - 1);
          break;
        case "\r": // Enter
          io.offKey(handler);
          resolve({ value, cancelled: false });
          return;
        case "\x1B": // Escape
          io.offKey(handler);
          resolve({ value, cancelled: true });
          return;
        case "\x03": // Ctrl+C
          io.offKey(handler);
          resolve({ value, cancelled: true });
          return;
        default:
          return;
      }
      render();
    };

    io.onKey(handler);
    render();
  });
}

// ── Text Input Widget ───────────────────────────────────────────────

/**
 * Minimal raw-mode text input. Captures printable characters, handles
 * backspace, and validates on Enter with a provided `validate` function.
 * Returns the typed value or cancels on Esc / Ctrl+C.
 */
export function runTextInput(
  io: WidgetIO,
  opts: {
    title?: string;
    hint?: string;
    validate?: (value: string) => string | null;
    /** Transform input after each keypress (e.g. auto-uppercase, insert hyphen). */
    transform?: (value: string) => string;
  } = {},
): Promise<TextInputResult> {
  return new Promise((resolve) => {
    let value = "";
    let error = "";

    const render = () => {
      let out = CURSOR_HOME + SHOW_CURSOR;

      const title = opts.title ?? "Enter text";
      out += `${BOLD}${title}${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}\n`;

      if (opts.hint) {
        out += `  ${DIM}${opts.hint}${RESET}${CLEAR_LINE}\n`;
        out += `${CLEAR_LINE}\n`;
      }

      out += `  ${CYAN}>${RESET} ${value}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}\n`;

      if (error) {
        out += `${RED}${error}${RESET}${CLEAR_LINE}\n`;
      } else {
        out += `${CLEAR_LINE}\n`;
      }

      out += `${CLEAR_LINE}\n`;
      out += `${DIM}Enter confirm  Esc cancel${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}`;

      io.write(out);
    };

    const handler = (key: string) => {
      if (key === "\r") {
        // Enter: validate
        if (opts.validate) {
          const errMsg = opts.validate(value);
          if (errMsg !== null) {
            error = errMsg;
            render();
            return;
          }
        }
        io.offKey(handler);
        resolve({ value, cancelled: false });
        return;
      }

      if (key === "\x1B" || key === "\x03") {
        // Escape or Ctrl+C: cancel
        io.offKey(handler);
        resolve({ value: "", cancelled: true });
        return;
      }

      if (key === "\x7f" || key === "\x08") {
        // Backspace / DEL
        value = value.slice(0, -1);
        if (opts.transform) value = opts.transform(value);
        error = "";
        render();
        return;
      }

      // Skip escape sequences (arrow keys, function keys, etc.)
      if (key.charCodeAt(0) === 0x1b) return;

      // Printable characters (supports paste: multi-char strings from Cmd-V / Ctrl-V)
      let added = false;
      for (const ch of key) {
        if (ch.charCodeAt(0) >= 32) {
          value += ch;
          added = true;
        }
      }
      if (added) {
        if (opts.transform) value = opts.transform(value);
        error = "";
        render();
        return;
      }
    };

    io.onKey(handler);
    render();
  });
}

// ── Confirmation Widget ─────────────────────────────────────────────

/**
 * Simple Y/n confirmation. Renders summary and waits for Enter (yes) or n/Esc (no).
 */
export function runConfirm(
  io: WidgetIO,
  opts: { title?: string; lines?: string[] } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const render = () => {
      let out = CURSOR_HOME;

      const title = opts.title ?? "Confirm";
      out += `${BOLD}${title}${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}\n`;

      if (opts.lines) {
        for (const line of opts.lines) {
          out += `  ${line}${CLEAR_LINE}\n`;
        }
      }

      out += `${CLEAR_LINE}\n`;
      out += `${DIM}Enter confirm  n/Esc cancel${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}`;

      io.write(out);
    };

    const handler = (key: string) => {
      switch (key) {
        case "\r": // Enter
        case "y":
        case "Y":
          io.offKey(handler);
          resolve(true);
          return;
        case "n":
        case "N":
        case "\x1B": // Escape
          io.offKey(handler);
          resolve(false);
          return;
        case "\x03": // Ctrl+C
          io.offKey(handler);
          resolve(false);
          return;
      }
    };

    io.onKey(handler);
    render();
  });
}

// ── Selection Screen (composite) ────────────────────────────────────

/** Merge strategy options for the picker. */
const MERGE_STRATEGY_OPTIONS: SingleSelectOption<MergeStrategy>[] = [
  {
    value: "auto",
    label: "auto",
    description: "Auto-merge when CI passes",
    isDefault: true,
  },
  {
    value: "manual",
    label: "manual",
    description: "Create PR, human clicks merge",
  },
];

/** AI review mode options for the picker. */
const REVIEW_MODE_OPTIONS: SingleSelectOption<"all" | "mine" | "off">[] = [
  {
    value: "all",
    label: "All PRs",
    description: "review work item PRs and external contributor PRs",
  },
  {
    value: "mine",
    label: "My PRs",
    description: "review only ninthwave work item PRs",
  },
  {
    value: "off",
    label: "Off",
    description: "no AI reviews",
  },
];

/** Crew mode option values for the picker. */
type CrewOption = "solo" | "join" | "create";

/** Crew collaboration options for the picker. */
const CREW_OPTIONS: SingleSelectOption<CrewOption>[] = [
  {
    value: "solo",
    label: "Solo",
    description: "run on this machine only",
    isDefault: true,
  },
  {
    value: "join",
    label: "Join crew",
    description: "enter a code to collaborate",
  },
  {
    value: "create",
    label: "Create crew",
    description: "start a new crew session",
  },
];

/**
 * Sort work items by priority then ID (same order as the old readline prompts).
 */
export function sortWorkItems(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    const pa = PRIORITY_NUM[a.priority] ?? 3;
    const pb = PRIORITY_NUM[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Convert work items to checkbox items for the widget.
 */
export function toCheckboxItems(items: WorkItem[]): CheckboxItem[] {
  return items.map((t) => {
    const priorityColor =
      t.priority === "critical" || t.priority === "high"
        ? YELLOW
        : DIM;
    const depInfo =
      t.dependencies.length > 0
        ? ` (deps: ${t.dependencies.join(", ")})`
        : "";
    return {
      id: t.id,
      label: `${CYAN}${t.id}${RESET}  ${t.title}`,
      detail: `${priorityColor}[${t.priority}]${RESET}${depInfo}`,
      checked: true,
    };
  });
}

/**
 * Run the full TUI selection screen flow:
 * 1. Checkbox list for item selection
 * 2. Single-select for merge strategy
 * 3. Number picker for WIP limit
 * 4. Single-select for AI review mode
 * 5. Single-select for crew collaboration (skippable)
 * 6. Summary confirmation
 *
 * Renders entirely in the alt-screen buffer using raw keypresses.
 * Returns null if cancelled at any step.
 */
/** Sentinel id for the "select all" checkbox item. */
const ALL_SENTINEL_ID = "__ALL__";

export async function runSelectionScreen(
  io: WidgetIO,
  items: WorkItem[],
  defaultWipLimit: number,
  opts: { defaultReviewMode?: "all" | "mine" | "off"; showCrewStep?: boolean } = {},
): Promise<SelectionScreenResult | null> {
  if (items.length === 0) {
    return null;
  }

  const sorted = sortWorkItems(items);
  const checkboxItems = toCheckboxItems(sorted);

  // Prepend __ALL__ sentinel (checked by default)
  const allSentinel: CheckboxItem = {
    id: ALL_SENTINEL_ID,
    label: "All \u2014 includes future items",
    checked: true,
  };
  const checkboxItemsWithAll = [allSentinel, ...checkboxItems];

  // Build dependency validator: warn when selected items have deps in the
  // list that aren't selected (those deps will be treated as already complete).
  const itemMap = new Map(sorted.map((t) => [t.id, t]));
  const validateDeps = (selectedIds: string[]): string | null => {
    const selectedSet = new Set(selectedIds);
    const missing: string[] = [];
    for (const id of selectedIds) {
      const item = itemMap.get(id);
      if (!item) continue;
      for (const dep of item.dependencies) {
        if (itemMap.has(dep) && !selectedSet.has(dep) && !missing.includes(dep)) {
          missing.push(dep);
        }
      }
    }
    if (missing.length === 0) return null;
    return `Deps not selected: ${missing.join(", ")} -- will start without waiting. Enter again to confirm.`;
  };

  // Step 1: Item selection
  io.write(CLEAR_SCREEN + HIDE_CURSOR);
  const itemResult = await runCheckboxList(io, checkboxItemsWithAll, {
    title: `Ninthwave \u00b7 Select work items (${sorted.length} available)`,
    linkAllId: ALL_SENTINEL_ID,
    validate: validateDeps,
  });

  if (itemResult.cancelled) {
    io.write(SHOW_CURSOR);
    return null;
  }

  // Filter __ALL__ sentinel from the selected ids
  const selectedItemIds = itemResult.selectedIds.filter((id) => id !== ALL_SENTINEL_ID);

  // Step 2: Merge strategy
  io.write(CLEAR_SCREEN);
  const strategyResult = await runSingleSelect<MergeStrategy>(
    io,
    MERGE_STRATEGY_OPTIONS,
    { title: "Merge strategy" },
  );

  if (strategyResult.cancelled) {
    io.write(SHOW_CURSOR);
    return null;
  }

  // Step 3: WIP limit
  io.write(CLEAR_SCREEN);
  const wipResult = await runNumberPicker(io, {
    title: "WIP limit",
    min: 1,
    max: 10,
    initial: defaultWipLimit,
  });

  if (wipResult.cancelled) {
    io.write(SHOW_CURSOR);
    return null;
  }

  // Step 4: AI reviews
  const defaultReviewMode = opts.defaultReviewMode ?? "off";
  const reviewModeOptions = REVIEW_MODE_OPTIONS.map((o) => ({
    ...o,
    isDefault: o.value === defaultReviewMode,
  }));

  io.write(CLEAR_SCREEN);
  const reviewResult = await runSingleSelect<"all" | "mine" | "off">(
    io,
    reviewModeOptions,
    { title: "Ninthwave \u00b7 AI reviews" },
  );

  if (reviewResult.cancelled) {
    io.write(SHOW_CURSOR);
    return null;
  }

  // Step 5: Crew collaboration (skippable for run-more re-entry)
  let crewAction: CrewAction | null = null;

  if (opts.showCrewStep !== false) {
    io.write(CLEAR_SCREEN);
    const crewResult = await runSingleSelect<CrewOption>(
      io,
      CREW_OPTIONS,
      { title: "Ninthwave \u00b7 Collaboration" },
    );

    if (crewResult.cancelled) {
      io.write(SHOW_CURSOR);
      return null;
    }

    if (crewResult.value === "create") {
      crewAction = { type: "create" };
    } else if (crewResult.value === "join") {
      io.write(CLEAR_SCREEN);
      const textResult = await runTextInput(io, {
        title: "Ninthwave \u00b7 Join crew",
        hint: "e.g. K2F9 AB3X 7YPL QM4N",
        validate: (v) =>
          CREW_CODE_PATTERN.test(v)
            ? null
            : "Invalid code. Expected 16 characters (e.g. K2F9-AB3X-7YPL-QM4N)",
        transform: (v) => {
          // Auto-uppercase and auto-insert hyphens
          let s = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
          // Insert hyphens after every 4 chars
          let result = "";
          for (let i = 0; i < s.length && i < 16; i++) {
            if (i > 0 && i % 4 === 0) result += "-";
            result += s[i];
          }
          return result;
        },
      });
      io.write(HIDE_CURSOR);

      if (textResult.cancelled) {
        io.write(SHOW_CURSOR);
        return null;
      }

      crewAction = { type: "join", code: normalizeCrewCode(textResult.value) };
    }
    // "solo" => crewAction remains null
  }

  // Step 6: Confirmation summary
  // Items summary
  let itemLines: string[];
  if (itemResult.allSelected) {
    itemLines = [
      `${BOLD}Items:${RESET}  All ${DIM}(dynamic \u2014 new items auto-included)${RESET}`,
    ];
  } else {
    itemLines = [
      `${BOLD}Items (${selectedItemIds.length}):${RESET}`,
      ...selectedItemIds.map((id) => {
        const item = sorted.find((t) => t.id === id);
        return `  ${CYAN}${id}${RESET}  ${item?.title ?? ""}`;
      }),
    ];
  }

  // Review mode label
  const reviewLabel =
    reviewResult.value === "all" ? "All PRs"
    : reviewResult.value === "mine" ? "My PRs"
    : "Off";

  // Crew label
  const crewLabel =
    crewAction === null ? "Solo"
    : crewAction.type === "create" ? "Creating new crew"
    : `Joining crew ${crewAction.code}`;

  const summaryLines = [
    ...itemLines,
    "",
    `${BOLD}Merge strategy:${RESET}  ${strategyResult.value}`,
    `${BOLD}WIP limit:${RESET}       ${wipResult.value}`,
    `${BOLD}AI reviews:${RESET}      ${reviewLabel}`,
    `${BOLD}Crew:${RESET}            ${crewLabel}`,
  ];

  io.write(CLEAR_SCREEN);
  const confirmed = await runConfirm(io, {
    title: "Ninthwave \u00b7 Start orchestration?",
    lines: summaryLines,
  });

  io.write(SHOW_CURSOR);

  if (!confirmed) {
    return null;
  }

  return {
    itemIds: selectedItemIds,
    allSelected: itemResult.allSelected,
    mergeStrategy: strategyResult.value,
    wipLimit: wipResult.value,
    reviewMode: reviewResult.value,
    crewAction,
    cancelled: false,
  };
}

// ── Real IO adapter ─────────────────────────────────────────────────

/**
 * Create a WidgetIO wired to process.stdin/stdout.
 * Assumes raw mode is already enabled on stdin.
 */
export function createProcessIO(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): WidgetIO {
  return {
    write: (s: string) => stdout.write(s),
    onKey: (handler: (key: string) => void) => {
      stdin.on("data", handler);
    },
    offKey: (handler: (key: string) => void) => {
      stdin.removeListener("data", handler);
    },
    getRows: () => stdout.rows ?? 24,
    getCols: () => stdout.columns ?? 80,
  };
}

// Re-export ANSI constants for use by callers
export { HIDE_CURSOR, SHOW_CURSOR, CLEAR_SCREEN };
