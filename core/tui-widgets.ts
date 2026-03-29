// TUI selection widgets rendered in-screen with raw ANSI.
// Three primitives: CheckboxList, SingleSelectPicker, NumberPicker.
// All widgets work in raw mode using arrow keys, space/Enter for interaction.
// Designed for the alt-screen buffer -- no readline dependency.

import { BOLD, DIM, GREEN, YELLOW, CYAN, RESET, RED } from "./output.ts";
import type { WorkItem } from "./types.ts";
import { PRIORITY_NUM } from "./types.ts";
import type { MergeStrategy } from "./orchestrator.ts";

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

/** Result of the full selection screen flow. */
export interface SelectionScreenResult {
  itemIds: string[];
  allSelected: boolean;
  mergeStrategy: MergeStrategy;
  wipLimit: number;
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
  opts: { title?: string; errorMessage?: string; linkAllId?: string } = {},
): Promise<CheckboxListResult> {
  return new Promise((resolve) => {
    if (items.length === 0) {
      resolve({ selectedIds: [], cancelled: true, allSelected: false });
      return;
    }

    let cursor = 0;
    let scrollOffset = 0;
    let error = opts.errorMessage ?? "";

    const render = () => {
      const rows = io.getRows();
      const cols = io.getCols();
      // Layout: title (2 lines), items (variable), footer (3 lines)
      const headerLines = 3; // title + blank + optional error
      const footerLines = 3; // blank + instructions + blank
      const viewportHeight = Math.max(1, rows - headerLines - footerLines);

      // Clamp scroll to keep cursor visible
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + viewportHeight) {
        scrollOffset = cursor - viewportHeight + 1;
      }

      let out = CURSOR_HOME;

      // Title
      const title = opts.title ?? "Select items";
      out += `${BOLD}${title}${RESET}${CLEAR_LINE}\n`;

      // Selected count
      const selectedCount = items.filter((i) => i.checked).length;
      out += `${DIM}${selectedCount}/${items.length} selected${RESET}${CLEAR_LINE}\n`;

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
              // Toggling a regular item
              item.checked = !item.checked;
              // Sync __ALL__: checked only when all regular items are checked
              const allItem = items.find((i) => i.id === linkId);
              if (allItem) {
                const regularItems = items.filter((i) => i.id !== linkId);
                allItem.checked = regularItems.every((i) => i.checked);
              }
            }
          } else {
            items[cursor]!.checked = !items[cursor]!.checked;
          }
          break;
        }
        case "a": { // Toggle all
          const allChecked = items.every((i) => i.checked);
          for (const item of items) item.checked = !allChecked;
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
 * 4. Summary confirmation
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

  // Step 1: Item selection
  io.write(CLEAR_SCREEN + HIDE_CURSOR);
  const itemResult = await runCheckboxList(io, checkboxItemsWithAll, {
    title: `Ninthwave \u00b7 Select work items (${sorted.length} available)`,
    linkAllId: ALL_SENTINEL_ID,
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

  // Step 4: Confirmation summary
  io.write(CLEAR_SCREEN);
  const summaryLines = [
    `${BOLD}Items (${selectedItemIds.length}):${RESET}`,
    ...selectedItemIds.map((id) => {
      const item = sorted.find((t) => t.id === id);
      return `  ${CYAN}${id}${RESET}  ${item?.title ?? ""}`;
    }),
    "",
    `${BOLD}Merge strategy:${RESET}  ${strategyResult.value}`,
    `${BOLD}WIP limit:${RESET}       ${wipResult.value}`,
  ];

  const confirmed = await runConfirm(io, {
    title: "Start orchestration?",
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
