// TUI selection widgets rendered in-screen with raw ANSI.
// Three primitives: CheckboxList, SingleSelectPicker, NumberPicker.
// All widgets work in raw mode using arrow keys, space/Enter for interaction.
// Designed for the alt-screen buffer -- no readline dependency.

import { BOLD, DIM, GREEN, YELLOW, CYAN, RESET, RED } from "./output.ts";
import type { WorkItem } from "./types.ts";
import { PRIORITY_NUM } from "./types.ts";
import type { MergeStrategy } from "./orchestrator.ts";
import { isCrewCode, type ConnectionAction } from "./commands/crew.ts";
import type { AiToolProfile } from "./ai-tools.ts";
import {
  COLLABORATION_MODE_OPTIONS,
  REVIEW_MODE_OPTIONS,
  STARTUP_MERGE_STRATEGY_OPTIONS,
  TUI_SETTINGS_DEFAULTS,
  type TuiSettingsDefaults,
} from "./tui-settings.ts";

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

interface StartupSettingsScreenResult {
  mergeStrategy: Extract<MergeStrategy, "auto" | "manual">;
  reviewMode: "all" | "mine" | "off";
  collaborationMode: "local" | "share" | "join";
  wipLimit: number;
  cancelled: boolean;
}

/** Result of the full selection screen flow. */
export interface SelectionScreenResult {
  itemIds: string[];
  allSelected: boolean;
  /** True when starting with no current items and watching future work only. */
  futureOnly?: boolean;
  mergeStrategy: MergeStrategy;
  wipLimit: number;
  reviewMode: "all" | "mine" | "off";
  connectionAction: ConnectionAction | null;
  cancelled: boolean;
  /** Selected AI tool ID, undefined when the step was skipped. */
  aiTool?: string;
  /** Selected AI tool IDs (multi-select), undefined when the step was skipped. */
  aiTools?: string[];
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
  opts: { title?: string; lines?: string[] } = {},
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

      // Optional description lines below options
      if (opts.lines && opts.lines.length > 0) {
        out += `${CLEAR_LINE}\n`;
        for (const line of opts.lines) {
          out += `${line}${CLEAR_LINE}\n`;
        }
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

// ── Startup Settings Screen ──────────────────────────────────────────

/**
 * Startup settings screen shown after item/tool selection.
 * Keeps the item summary visible while arrow keys adjust startup settings.
 */
export function runStartupSettingsScreen(
  io: WidgetIO,
  opts: {
    title?: string;
    summaryLines?: string[];
    defaultWipLimit: number;
    defaultSettings?: TuiSettingsDefaults;
  },
): Promise<StartupSettingsScreenResult> {
  return new Promise((resolve) => {
    const defaults = opts.defaultSettings ?? TUI_SETTINGS_DEFAULTS;
    let activeRow = 0;
    let mergeIndex = Math.max(
      0,
      STARTUP_MERGE_STRATEGY_OPTIONS.findIndex((option) => option.runtimeValue === defaults.mergeStrategy),
    );
    let reviewIndex = Math.max(
      0,
      REVIEW_MODE_OPTIONS.findIndex((option) => option.persistedValue === defaults.reviewMode),
    );
    let collaborationIndex = Math.max(
      0,
      COLLABORATION_MODE_OPTIONS.findIndex((option) => option.persistedValue === defaults.collaborationMode),
    );
    let wipLimit = Math.max(1, Math.min(10, opts.defaultWipLimit));

    const currentMergeOption = () => STARTUP_MERGE_STRATEGY_OPTIONS[mergeIndex]!;
    const currentReviewOption = () => REVIEW_MODE_OPTIONS[reviewIndex]!;
    const currentCollaborationOption = () => COLLABORATION_MODE_OPTIONS[collaborationIndex]!;

    const renderChoiceRow = (
      title: string,
      values: string[],
      active: boolean,
    ): string => {
      const pointer = active ? `${CYAN}>${RESET}` : " ";
      return `${pointer} ${BOLD}${title.padEnd(13)}${RESET} ${values.join("  ")}`;
    };

    const mergeValues = () => STARTUP_MERGE_STRATEGY_OPTIONS.map((option, index) =>
      index === mergeIndex
        ? `${GREEN}${BOLD}[${option.startupLabel}]${RESET}`
        : `${DIM}${option.startupLabel}${RESET}`,
    );
    const reviewValues = () => REVIEW_MODE_OPTIONS.map((option, index) =>
      index === reviewIndex
        ? `${GREEN}${BOLD}[${option.startupLabel}]${RESET}`
        : `${DIM}${option.startupLabel}${RESET}`,
    );
    const collaborationValues = () => COLLABORATION_MODE_OPTIONS.map((option, index) =>
      index === collaborationIndex
        ? `${GREEN}${BOLD}[${option.startupLabel}]${RESET}`
        : `${DIM}${option.startupLabel}${RESET}`,
    );
    const wipValues = () => Array.from({ length: 10 }, (_, idx) => idx + 1).map((value) =>
      value === wipLimit
        ? `${GREEN}${BOLD}[${value}]${RESET}`
        : `${DIM}${value}${RESET}`,
    );

    const activeDescription = () => {
      switch (activeRow) {
        case 0:
          return currentMergeOption().startupDescription;
        case 1:
          return currentReviewOption().startupDescription;
        case 2:
          return currentCollaborationOption().startupDescription;
        default:
          return "Maximum work items allowed to run in parallel";
      }
    };

    const render = () => {
      const cols = io.getCols();
      let out = CURSOR_HOME;

      out += `${BOLD}${opts.title ?? "Ninthwave · Start orchestration"}${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}\n`;

      for (const line of opts.summaryLines ?? []) {
        out += `  ${line.slice(0, cols + 80)}${CLEAR_LINE}\n`;
      }

      out += `${CLEAR_LINE}\n`;
      out += `${renderChoiceRow("Merge", mergeValues(), activeRow === 0).slice(0, cols + 80)}${CLEAR_LINE}\n`;
      out += `${renderChoiceRow("Reviews", reviewValues(), activeRow === 1).slice(0, cols + 80)}${CLEAR_LINE}\n`;
      out += `${renderChoiceRow("Collaboration", collaborationValues(), activeRow === 2).slice(0, cols + 80)}${CLEAR_LINE}\n`;
      out += `${renderChoiceRow("WIP limit", wipValues(), activeRow === 3).slice(0, cols + 80)}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}\n`;
      out += `${DIM}${activeDescription()}${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}\n`;
      out += `${DIM}↑/↓ change row  ←/→ change value  Enter confirm  Esc cancel${RESET}${CLEAR_LINE}\n`;
      out += `${CLEAR_LINE}`;

      io.write(out);
    };

    const handler = (key: string) => {
      switch (key) {
        case "\x1B[A":
        case "k":
          activeRow = (activeRow - 1 + 4) % 4;
          break;
        case "\x1B[B":
        case "j":
          activeRow = (activeRow + 1) % 4;
          break;
        case "\x1B[D":
        case "h":
          if (activeRow === 0) {
            mergeIndex = (mergeIndex - 1 + STARTUP_MERGE_STRATEGY_OPTIONS.length) % STARTUP_MERGE_STRATEGY_OPTIONS.length;
          } else if (activeRow === 1) {
            reviewIndex = (reviewIndex - 1 + REVIEW_MODE_OPTIONS.length) % REVIEW_MODE_OPTIONS.length;
          } else if (activeRow === 2) {
            collaborationIndex = (collaborationIndex - 1 + COLLABORATION_MODE_OPTIONS.length) % COLLABORATION_MODE_OPTIONS.length;
          } else {
            wipLimit = Math.max(1, wipLimit - 1);
          }
          break;
        case "\x1B[C":
        case "l":
          if (activeRow === 0) {
            mergeIndex = (mergeIndex + 1) % STARTUP_MERGE_STRATEGY_OPTIONS.length;
          } else if (activeRow === 1) {
            reviewIndex = (reviewIndex + 1) % REVIEW_MODE_OPTIONS.length;
          } else if (activeRow === 2) {
            collaborationIndex = (collaborationIndex + 1) % COLLABORATION_MODE_OPTIONS.length;
          } else {
            wipLimit = Math.min(10, wipLimit + 1);
          }
          break;
        case "\r":
          io.offKey(handler);
          resolve({
            mergeStrategy: currentMergeOption().runtimeValue as Extract<MergeStrategy, "auto" | "manual">,
            reviewMode: currentReviewOption().persistedValue,
            collaborationMode: currentCollaborationOption().persistedValue,
            wipLimit,
            cancelled: false,
          });
          return;
        case "\x1B":
        case "\x03":
          io.offKey(handler);
          resolve({
            mergeStrategy: currentMergeOption().runtimeValue as Extract<MergeStrategy, "auto" | "manual">,
            reviewMode: currentReviewOption().persistedValue,
            collaborationMode: currentCollaborationOption().persistedValue,
            wipLimit,
            cancelled: true,
          });
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

// ── Selection Screen (composite) ────────────────────────────────────

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
 * 2. Checkbox list for AI tool selection (conditional: 2+ tools)
 * 3. Startup settings screen (startup) or summary confirmation (re-entry)
 *
 * Initial startup keeps the item summary visible while arrow keys adjust merge,
 * reviews, collaboration, and WIP. Re-entry flows (`showConnectionStep: false`)
 * keep the simpler confirmation-only step so they do not change live session policy.
 *
 * Renders entirely in the alt-screen buffer using raw keypresses.
 * Returns null if cancelled at any step.
 */
/** Sentinel id for the "select all" checkbox item. */
const ALL_SENTINEL_ID = "__ALL__";
const FUTURE_TASKS_ID = "__FUTURE__";

export async function runSelectionScreen(
  io: WidgetIO,
  items: WorkItem[],
  defaultWipLimit: number,
  opts: {
    defaultReviewMode?: "all" | "mine" | "off";
    defaultSettings?: TuiSettingsDefaults;
    showConnectionStep?: boolean;
    /** Installed AI tools for the tool selection step. Empty/single = skip screen. */
    installedTools?: AiToolProfile[];
    /** Pre-selected tool IDs for multi-select (from saved config). */
    savedToolIds?: string[];
  } = {},
): Promise<SelectionScreenResult | null> {
  const resolvedDefaults: TuiSettingsDefaults = {
    mergeStrategy: opts.defaultSettings?.mergeStrategy ?? TUI_SETTINGS_DEFAULTS.mergeStrategy,
    reviewMode: opts.defaultSettings?.reviewMode ?? opts.defaultReviewMode ?? TUI_SETTINGS_DEFAULTS.reviewMode,
    collaborationMode: opts.defaultSettings?.collaborationMode ?? TUI_SETTINGS_DEFAULTS.collaborationMode,
  };
  const sorted = sortWorkItems(items);
  const hasCurrentItems = sorted.length > 0;
  const checkboxItemsWithAll: CheckboxItem[] = hasCurrentItems
    ? [
      {
        id: ALL_SENTINEL_ID,
        label: "All \u2014 includes future items",
        checked: true,
      },
      ...toCheckboxItems(sorted),
    ]
    : [
      {
        id: FUTURE_TASKS_ID,
        label: "Future tasks",
        detail: "Start automatically when new work arrives",
        checked: true,
      },
    ];

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
    title: hasCurrentItems
      ? `Ninthwave \u00b7 Select work items (${sorted.length} available)`
      : "Ninthwave \u00b7 No work items queued",
    ...(hasCurrentItems
      ? {
        linkAllId: ALL_SENTINEL_ID,
        validate: validateDeps,
      }
      : {}),
  });

  if (itemResult.cancelled) {
    io.write(SHOW_CURSOR);
    return null;
  }

  // Filter synthetic sentinels from the selected ids.
  const futureOnly = !hasCurrentItems && itemResult.selectedIds.includes(FUTURE_TASKS_ID);
  const selectedItemIds = itemResult.selectedIds.filter(
    (id) => id !== ALL_SENTINEL_ID && id !== FUTURE_TASKS_ID,
  );

  const defaultMergeStrategy: Extract<MergeStrategy, "auto" | "manual"> = resolvedDefaults.mergeStrategy;
  const defaultWip = Math.max(1, Math.min(10, defaultWipLimit));
  const defaultReviewMode: "all" | "mine" | "off" = resolvedDefaults.reviewMode;
  const defaultConnectionAction: ConnectionAction | null = null;

  // Step 2: AI coding tool (conditional -- only when 2+ tools detected)
  let aiTool: string | undefined;
  let aiTools: string[] | undefined;
  const tools = opts.installedTools ?? [];

  if (tools.length >= 2) {
    // Multi-select: pre-check saved tools or all if none saved
    const savedIds = opts.savedToolIds ?? [];
    const toolCheckboxItems: CheckboxItem[] = tools.map((t) => ({
      id: t.id,
      label: t.displayName,
      detail: `Model defined in ${t.targetDir}/ agent files`,
      checked: savedIds.length > 0 ? savedIds.includes(t.id) : true,
    }));

    io.write(CLEAR_SCREEN);
    const toolResult = await runCheckboxList(
      io,
      toolCheckboxItems,
      { title: "Ninthwave \u00b7 AI coding tool(s)", validate: (ids) => ids.length > 0 ? null : "Select at least one tool" },
    );

    if (toolResult.cancelled) {
      io.write(SHOW_CURSOR);
      return null;
    }

    aiTools = toolResult.selectedIds;
    aiTool = aiTools[0];
  } else if (tools.length === 1) {
    aiTool = tools[0]!.id; // auto-select single tool
    aiTools = [aiTool];
  }

  // Step 3: Confirmation summary
  // Items summary
  let itemLines: string[];
  if (futureOnly) {
    itemLines = [
      `${BOLD}Items:${RESET}  Future tasks ${DIM}(start when new work arrives)${RESET}`,
    ];
  } else if (itemResult.allSelected) {
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

  // AI tool label (only shown when the tool step was visible)
  const toolLabel = (tools.length >= 2 && aiTools && aiTools.length > 0)
    ? aiTools.map((id) => tools.find((t) => t.id === id)?.displayName ?? id).join(", ") + (aiTools.length > 1 ? " (round-robin)" : "")
    : undefined;

  const summaryLines = [
    ...itemLines,
    ...(toolLabel ? ["", `${BOLD}AI tool:${RESET}         ${toolLabel}`] : []),
  ];

  let mergeStrategy: MergeStrategy = defaultMergeStrategy;
  let wipLimit = defaultWip;
  let reviewMode: "all" | "mine" | "off" = defaultReviewMode;
  let connectionAction: ConnectionAction | null = defaultConnectionAction;

  if (opts.showConnectionStep === false) {
    io.write(CLEAR_SCREEN);
    const confirmed = await runConfirm(io, {
      title: "Ninthwave \u00b7 Start orchestration?",
      lines: summaryLines,
    });

    io.write(SHOW_CURSOR);

    if (!confirmed) {
      return null;
    }
  } else {
    io.write(CLEAR_SCREEN);
    const settingsResult = await runStartupSettingsScreen(io, {
      title: "Ninthwave \u00b7 Start orchestration",
      summaryLines,
      defaultWipLimit: defaultWip,
      defaultSettings: resolvedDefaults,
    });

    io.write(SHOW_CURSOR);

    if (settingsResult.cancelled) {
      return null;
    }

    mergeStrategy = settingsResult.mergeStrategy;
    wipLimit = settingsResult.wipLimit;
    reviewMode = settingsResult.reviewMode;
    if (settingsResult.collaborationMode === "share") {
      connectionAction = { type: "connect" };
    } else if (settingsResult.collaborationMode === "join") {
      io.write(CLEAR_SCREEN);
      const joinCode = await runTextInput(io, {
        title: "Ninthwave · Join session",
        hint: "Format: XXXX-XXXX-XXXX-XXXX (e.g. K2F9-AB3X-7YPL-QM4N)",
        validate: (value) => isCrewCode(value.trim()) ? null : "Invalid session code",
      });
      io.write(SHOW_CURSOR);

      if (joinCode.cancelled) {
        return null;
      }

      connectionAction = { type: "join", code: joinCode.value.trim() };
    } else {
      connectionAction = null;
    }
  }

  return {
    itemIds: selectedItemIds,
    allSelected: itemResult.allSelected,
    futureOnly,
    mergeStrategy,
    wipLimit,
    reviewMode,
    connectionAction,
    cancelled: false,
    aiTool,
    aiTools,
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
