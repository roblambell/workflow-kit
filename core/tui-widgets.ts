// TUI selection widgets rendered in-screen with raw ANSI.
// Three primitives: CheckboxList, SingleSelectPicker, NumberPicker.
// All widgets work in raw mode using arrow keys, space/Enter for interaction.
// Designed for the alt-screen buffer -- no readline dependency.

import { BOLD, DIM, GREEN, YELLOW, CYAN, RESET, RED } from "./output.ts";
import type { StartupItemsRefreshResult } from "./startup-items.ts";
import type { WorkItem } from "./types.ts";
import { PRIORITY_NUM } from "./types.ts";
import type { MergeStrategy } from "./orchestrator.ts";
import {
  formatInvalidCrewCodeMessage,
  parseCrewCode,
  type ConnectionAction,
} from "./commands/crew.ts";
import { hasAgentFiles, isAiToolId } from "./ai-tools.ts";
import type { AiToolProfile } from "./ai-tools.ts";
import {
  COLLABORATION_MODE_OPTIONS,
  REVIEW_MODE_OPTIONS,
  TUI_SETTINGS_DEFAULTS,
  type TuiSettingsDefaults,
} from "./tui-settings.ts";
import { clampScrollOffset, stripAnsiForWidth } from "./status-render.ts";

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

const ANSI_SEQUENCE_PATTERN = /^(?:\x1b\]8;[^\x07]*\x07|\x1b\[[0-9;]*[A-Za-z])/;

function renderStartupChip(label: string | number, selected: boolean): string {
  const text = String(label);
  return selected
    ? `${GREEN}${BOLD}[${text}]${RESET}`
    : `${DIM} ${text} ${RESET}`;
}

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
  subline?: string;
  checked: boolean;
}

const CHECKBOX_LABEL_INDENT = " ".repeat(6);

function wrapLineToWidth(line: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];
  if (line.length === 0) return [""];

  const wrapped: string[] = [];
  let segmentStart = 0;
  let index = 0;
  let visibleWidth = 0;
  let lastWhitespaceBreak: { end: number; nextStart: number } | null = null;

  while (index < line.length) {
    const ansiMatch = line.slice(index).match(ANSI_SEQUENCE_PATTERN);
    if (ansiMatch) {
      index += ansiMatch[0].length;
      continue;
    }

    const char = line[index]!;
    if (char === "\n") {
      wrapped.push(line.slice(segmentStart, index));
      index += 1;
      segmentStart = index;
      visibleWidth = 0;
      lastWhitespaceBreak = null;
      continue;
    }

    if (char === " " || char === "\t") {
      lastWhitespaceBreak = { end: index, nextStart: index + 1 };
    }

    visibleWidth += 1;
    index += 1;

    if (visibleWidth > maxWidth) {
      if (lastWhitespaceBreak && lastWhitespaceBreak.end > segmentStart) {
        wrapped.push(line.slice(segmentStart, lastWhitespaceBreak.end));
        segmentStart = lastWhitespaceBreak.nextStart;
        index = segmentStart;
      } else {
        const hardBreak = Math.max(segmentStart + 1, index - 1);
        wrapped.push(line.slice(segmentStart, hardBreak));
        segmentStart = hardBreak;
        index = segmentStart;
      }

      visibleWidth = 0;
      lastWhitespaceBreak = null;
    }
  }

  wrapped.push(line.slice(segmentStart));
  return wrapped.length > 0 ? wrapped : [""];
}

function truncateCheckboxLine(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const plain = stripAnsiForWidth(line);
  if (plain.length <= maxWidth) return line;
  if (maxWidth <= 3) return plain.slice(0, maxWidth);
  return `${wrapLineToWidth(line, maxWidth - 3)[0] ?? ""}...${RESET}`;
}

function clampActiveLineScrollOffset(
  scrollOffset: number,
  activeStartLine: number,
  activeEndLine: number,
  viewportHeight: number,
  totalLines: number,
): number {
  if (activeStartLine < scrollOffset) {
    scrollOffset = activeStartLine;
  }
  if (activeEndLine > scrollOffset + viewportHeight) {
    scrollOffset = activeEndLine - viewportHeight;
  }

  return Math.max(0, Math.min(scrollOffset, Math.max(0, totalLines - viewportHeight)));
}

function wrapPlainLine(line: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];

  const plain = stripAnsiForWidth(line);
  if (!plain) return [""];

  const wrapped: string[] = [];
  let remaining = plain;

  while (remaining.length > maxWidth) {
    let breakIndex = remaining.lastIndexOf(" ", maxWidth);
    if (breakIndex <= 0) breakIndex = maxWidth;

    const segment = remaining.slice(0, breakIndex).trimEnd();
    wrapped.push(segment);

    remaining = remaining.slice(breakIndex);
    if (breakIndex !== maxWidth) remaining = remaining.replace(/^\s+/, "");
  }

  wrapped.push(remaining);
  return wrapped;
}

function buildConfirmInstructions(overflow: boolean, cols: number): string {
  if (!overflow) return cols >= 27 ? "Enter confirm  n/Esc cancel" : "Enter/n/Esc";
  if (cols >= 42) return "↑/↓/j/k scroll  Enter confirm  n/Esc cancel";
  if (cols >= 26) return "↑/↓/j/k scroll  Enter/n/Esc";
  if (cols >= 18) return "Scroll  Enter/n/Esc";
  return "Enter/n/Esc";
}

function buildCheckboxRenderLines(
  items: CheckboxItem[],
  cursor: number,
  linkAllId?: string,
): { lines: string[]; itemStartLines: number[]; itemEndLines: number[] } {
  const lines: string[] = [];
  const itemStartLines: number[] = [];
  const itemEndLines: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const isActive = i === cursor;
    itemStartLines[i] = lines.length;

    const checkbox = item.checked ? `${GREEN}[x]${RESET}` : `[ ]`;
    const pointer = isActive ? `${CYAN}>${RESET}` : " ";
    const label = isActive ? `${BOLD}${item.label}${RESET}` : item.label;
    const detail = item.detail ? ` ${DIM}${item.detail}${RESET}` : "";
    lines.push(`${pointer} ${checkbox} ${label}${detail}`);

    if (item.subline) {
      lines.push(`${CHECKBOX_LABEL_INDENT}${DIM}${item.subline}${RESET}`);
    }

    if (linkAllId && item.id === linkAllId) {
      lines.push("");
    }

    itemEndLines[i] = lines.length;
  }

  return { lines, itemStartLines, itemEndLines };
}

export interface CheckboxListResult {
  selectedIds: string[];
  cancelled: boolean;
  allSelected: boolean;
}

export interface CheckboxListReplaceResult {
  removedSelectedIds: string[];
}

export interface CheckboxListViewState {
  items: CheckboxItem[];
  title?: string;
  linkAllId?: string;
  noticeMessage?: string;
  validate?: (selectedIds: string[]) => string | null;
}

export interface CheckboxListController {
  replaceState: (nextState: CheckboxListViewState) => CheckboxListReplaceResult;
  setNotice: (message: string) => void;
  clearNotice: () => void;
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
  reviewMode: "on" | "off";
  collaborationMode: "local" | "share" | "join";
  sessionLimit: number;
  cancelled: boolean;
}

/** Result of the full selection screen flow. */
export interface SelectionScreenResult {
  itemIds: string[];
  allSelected: boolean;
  /** True when starting with no current items and watching future work only. */
  futureOnly?: boolean;
  mergeStrategy: MergeStrategy;
  sessionLimit: number;
  reviewMode: "on" | "off";
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
function replaceCheckboxItems(
  currentItems: CheckboxItem[],
  nextItems: CheckboxItem[],
  previousLinkAllId?: string,
  nextLinkAllId?: string,
): CheckboxListReplaceResult & { items: CheckboxItem[] } {
  const previousCheckedById = new Map(currentItems.map((item) => [item.id, item.checked] as const));
  const nextIdSet = new Set(nextItems.map((item) => item.id));
  const previousLinkAllChecked = previousLinkAllId
    ? previousCheckedById.get(previousLinkAllId)
    : undefined;
  const removedSelectedIds = currentItems
    .filter((item) => item.checked)
    .map((item) => item.id)
    .filter((id) => id !== previousLinkAllId && !nextIdSet.has(id));

  const items = nextItems.map((item) => {
    const previousChecked = previousCheckedById.get(item.id);
    if (previousChecked !== undefined) {
      return { ...item, checked: previousChecked };
    }
    if (item.id === nextLinkAllId && previousLinkAllChecked !== undefined) {
      return { ...item, checked: previousLinkAllChecked };
    }
    if (nextLinkAllId && item.id !== nextLinkAllId && previousLinkAllChecked !== undefined) {
      return { ...item, checked: previousLinkAllChecked };
    }
    return { ...item };
  });

  return { items, removedSelectedIds };
}

export function runCheckboxList(
  io: WidgetIO,
  items: CheckboxItem[],
  opts: {
    title?: string;
    errorMessage?: string;
    linkAllId?: string;
    validate?: (selectedIds: string[]) => string | null;
    bindController?: (controller: CheckboxListController) => void;
  } = {},
): Promise<CheckboxListResult> {
  return new Promise((resolve) => {
    if (items.length === 0) {
      resolve({ selectedIds: [], cancelled: true, allSelected: false });
      return;
    }

    let currentItems = items.map((item) => ({ ...item }));
    let title = opts.title;
    let linkAllId = opts.linkAllId;
    let validate = opts.validate;
    let cursor = 0;
    let scrollOffset = 0;
    let error = opts.errorMessage ?? "";
    let notice = "";
    let warningAcked = false;

    const render = () => {
      const rows = io.getRows();
      const cols = io.getCols();
      // Layout: title (2 lines), items viewport (variable rendered lines), footer (3 lines)
      const headerLines = 3; // title + blank + optional error
      const footerLines = 3; // blank + instructions + blank
      const viewportHeight = Math.max(1, rows - headerLines - footerLines);

      const { lines, itemStartLines, itemEndLines } = buildCheckboxRenderLines(currentItems, cursor, linkAllId);
      const totalRenderedLines = lines.length;
      const cursorStartLine = itemStartLines[cursor] ?? 0;
      const cursorEndLine = itemEndLines[cursor] ?? cursorStartLine + 1;

      // Clamp scroll to keep the active item fully visible, accounting for sublines.
      scrollOffset = clampActiveLineScrollOffset(
        scrollOffset,
        cursorStartLine,
        cursorEndLine,
        viewportHeight,
        totalRenderedLines,
      );

      let out = CURSOR_HOME;

      // Title
      out += `${BOLD}${title ?? "Select items"}${RESET}${CLEAR_LINE}\n`;

      // Selected count (exclude sentinel from both numerator and denominator)
      const countItems = linkAllId ? currentItems.filter((i) => i.id !== linkAllId) : currentItems;
      const selectedCount = countItems.filter((i) => i.checked).length;
      out += `${DIM}${selectedCount}/${countItems.length} selected${RESET}${CLEAR_LINE}\n`;

      // Error/notice line (or blank)
      if (error) {
        out += `${RED}${error}${RESET}${CLEAR_LINE}\n`;
      } else if (notice) {
        out += `${YELLOW}${notice}${RESET}${CLEAR_LINE}\n`;
      } else {
        out += `${CLEAR_LINE}\n`;
      }

      // Items
      const visibleLines = lines.slice(scrollOffset, scrollOffset + viewportHeight);
      for (const line of visibleLines) {
        out += `${truncateCheckboxLine(line, cols)}${CLEAR_LINE}\n`;
      }

      // Fill remaining viewport lines
      for (let i = visibleLines.length; i < viewportHeight; i++) {
        out += `${CLEAR_LINE}\n`;
      }

      // Scroll indicator
      if (totalRenderedLines > viewportHeight) {
        const pct = Math.round(((scrollOffset + viewportHeight) / totalRenderedLines) * 100);
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
          cursor = (cursor - 1 + currentItems.length) % currentItems.length;
          break;
        case "\x1B[B": // Down arrow
        case "j":
          cursor = (cursor + 1) % currentItems.length;
          break;
        case " ": { // Space -- toggle
          const linkId = linkAllId;
          if (linkId) {
            const item = currentItems[cursor]!;
            if (item.id === linkId) {
              // Toggling __ALL__: set all items to match new state
              const newState = !item.checked;
              for (const i of currentItems) i.checked = newState;
            } else {
              // Toggling a regular item (sentinel stays independent)
              item.checked = !item.checked;
            }
          } else {
            currentItems[cursor]!.checked = !currentItems[cursor]!.checked;
          }
          break;
        }
        case "a": { // Toggle all regular items (sentinel stays independent)
          const regularItems = linkAllId
            ? currentItems.filter((i) => i.id !== linkAllId)
            : currentItems;
          const allChecked = regularItems.every((i) => i.checked);
          for (const item of regularItems) item.checked = !allChecked;
          break;
        }
        case "\r": { // Enter -- confirm
          const allItem = linkAllId ? currentItems.find((i) => i.id === linkAllId) : null;
          const regularItems = linkAllId
            ? currentItems.filter((i) => i.id !== linkAllId)
            : currentItems;
          const regularSelected = regularItems.filter((i) => i.checked);
          if (regularSelected.length === 0) {
            error = "Select at least one item";
            render();
            return;
          }
          // Validate selection (e.g., dependency warnings)
          if (validate && !warningAcked) {
            const selectedIds = regularSelected.map((i) => i.id);
            const warning = validate(selectedIds);
            if (warning) {
              error = warning;
              warningAcked = true;
              render();
              return;
            }
          }
          io.offKey(handler);
          resolve({
            selectedIds: currentItems.filter((i) => i.checked).map((i) => i.id),
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

    opts.bindController?.({
      replaceState: (nextState) => {
        const replaced = replaceCheckboxItems(
          currentItems,
          nextState.items,
          linkAllId,
          nextState.linkAllId,
        );
        const currentCursorId = currentItems[cursor]?.id;
        currentItems = replaced.items;
        title = nextState.title;
        linkAllId = nextState.linkAllId;
        validate = nextState.validate;
        notice = nextState.noticeMessage ?? "";
        error = "";
        warningAcked = false;
        const nextCursor = currentCursorId
          ? currentItems.findIndex((item) => item.id === currentCursorId)
          : -1;
        cursor = nextCursor >= 0
          ? nextCursor
          : Math.max(0, Math.min(cursor, currentItems.length - 1));
        render();
        return { removedSelectedIds: replaced.removedSelectedIds };
      },
      setNotice: (message) => {
        notice = message;
        error = "";
        render();
      },
      clearNotice: () => {
        notice = "";
        render();
      },
    });

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
    let scrollOffset = 0;

    const render = () => {
      const rows = io.getRows();
      const cols = io.getCols();
      const titleGapLines = rows >= 6 ? 1 : 0;
      const footerGapLines = rows >= 5 ? 1 : 0;
      const reservedLines = 1 + titleGapLines + footerGapLines + 2;
      const viewportHeight = Math.max(1, rows - reservedLines);
      const bodyIndent = cols > 2 ? 2 : 0;
      const bodyPrefix = " ".repeat(bodyIndent);
      const bodyWidth = Math.max(1, cols - bodyIndent);
      const wrappedLines = (opts.lines ?? []).flatMap((line) => wrapPlainLine(line, bodyWidth));
      const bodyLines = wrappedLines.length > 0 ? wrappedLines : [""];
      const overflow = bodyLines.length > viewportHeight;

      scrollOffset = clampScrollOffset(scrollOffset, bodyLines.length, viewportHeight);
      const visibleLines = bodyLines.slice(scrollOffset, scrollOffset + viewportHeight);

      let out = CURSOR_HOME;

      const title = opts.title ?? "Confirm";
      out += `${truncateCheckboxLine(`${BOLD}${title}${RESET}`, cols)}${CLEAR_LINE}\n`;
      if (titleGapLines > 0) out += `${CLEAR_LINE}\n`;

      for (const line of visibleLines) {
        out += `${truncateCheckboxLine(`${bodyPrefix}${line}`, cols)}${CLEAR_LINE}\n`;
      }

      for (let i = visibleLines.length; i < viewportHeight; i++) {
        out += `${CLEAR_LINE}\n`;
      }

      if (footerGapLines > 0) out += `${CLEAR_LINE}\n`;

      const lastVisibleLine = Math.min(scrollOffset + viewportHeight, bodyLines.length);
      const scrollStatus = overflow
        ? `${scrollOffset > 0 ? "▲" : " "} ${scrollOffset + 1}-${lastVisibleLine} of ${bodyLines.length} ${lastVisibleLine < bodyLines.length ? "▼" : " "}`
        : "";
      const instructions = buildConfirmInstructions(overflow, cols);

      out += `${truncateCheckboxLine(scrollStatus ? `${DIM}${scrollStatus}${RESET}` : "", cols)}${CLEAR_LINE}\n`;
      out += `${truncateCheckboxLine(`${DIM}${instructions}${RESET}`, cols)}${CLEAR_LINE}`;

      io.write(out);
    };

    const handler = (key: string) => {
      switch (key) {
        case "\x1B[A": // Up arrow
        case "k":
          scrollOffset -= 1;
          break;
        case "\x1B[B": // Down arrow
        case "j":
          scrollOffset += 1;
          break;
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
        default:
          return;
      }

      render();
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
    defaultSessionLimit: number;
    defaultSettings?: TuiSettingsDefaults;
  },
): Promise<StartupSettingsScreenResult> {
  return new Promise((resolve) => {
    const defaults = opts.defaultSettings ?? TUI_SETTINGS_DEFAULTS;
    const settingRowCount = 2;
    let activeRow = 0;
    let scrollOffset = 0;
    const mergeStrategy = defaults.mergeStrategy;
    let reviewIndex = Math.max(
      0,
      REVIEW_MODE_OPTIONS.findIndex((option) => option.persistedValue === defaults.reviewMode),
    );
    let collaborationIndex = Math.max(
      0,
      COLLABORATION_MODE_OPTIONS.findIndex((option) => option.persistedValue === defaults.collaborationMode),
    );
    const sessionLimit = Math.max(1, Math.min(10, opts.defaultSessionLimit));
    const currentReviewOption = () => REVIEW_MODE_OPTIONS[reviewIndex]!;
    const currentCollaborationOption = () => COLLABORATION_MODE_OPTIONS[collaborationIndex]!;

    const renderChoiceRow = (
      title: string,
      values: string[],
      active: boolean,
    ): string => {
      const pointer = active ? `${CYAN}>${RESET}` : " ";
      return `${pointer} ${BOLD}${title.padEnd(16)}${RESET} ${values.join(" ")}`;
    };

    const reviewValues = () => REVIEW_MODE_OPTIONS.map((option, index) =>
      renderStartupChip(option.startupLabel, index === reviewIndex),
    );
    const collaborationValues = () => COLLABORATION_MODE_OPTIONS.map((option, index) =>
      renderStartupChip(option.startupLabel, index === collaborationIndex),
    );
    const activeDescription = () => {
      switch (activeRow) {
        case 0:
          return currentReviewOption().startupDescription;
        case 1:
          return currentCollaborationOption().startupDescription;
        default:
          return "";
      }
    };

    const render = () => {
      const rows = io.getRows();
      const cols = io.getCols();
      const headerGap = rows >= 8 ? 1 : 0;
      const footerGap = rows >= 6 ? 1 : 0;
      const headerLines = 1 + headerGap;
      const footerLines = 1 + footerGap;
      const viewportHeight = Math.max(1, rows - headerLines - footerLines);
      const bodyLines: string[] = [];
      const rowStartLines: number[] = [];
      const rowEndLines: number[] = [];
      const summaryLines = (opts.summaryLines ?? []).flatMap((line) =>
        wrapLineToWidth(`  ${stripAnsiForWidth(line)}`, cols),
      );
      const descriptionLines = wrapLineToWidth(activeDescription(), cols).map((line) => `${DIM}${line}${RESET}`);

      if (summaryLines.length > 0) {
        bodyLines.push(...summaryLines, "");
      }

      const choiceRows = [
        renderChoiceRow("Reviews", reviewValues(), activeRow === 0),
        renderChoiceRow("Collaboration", collaborationValues(), activeRow === 1),
      ];

      for (let i = 0; i < choiceRows.length; i++) {
        rowStartLines[i] = bodyLines.length;
        bodyLines.push(truncateCheckboxLine(choiceRows[i]!, cols));
        rowEndLines[i] = bodyLines.length;
      }

      bodyLines.push("", ...descriptionLines);
      scrollOffset = clampActiveLineScrollOffset(
        scrollOffset,
        rowStartLines[activeRow] ?? 0,
        rowEndLines[activeRow] ?? (rowStartLines[activeRow] ?? 0) + 1,
        viewportHeight,
        bodyLines.length,
      );

      const visibleBodyLines = bodyLines.slice(scrollOffset, scrollOffset + viewportHeight);
      let out = CURSOR_HOME;

      out += `${truncateCheckboxLine(`${BOLD}${opts.title ?? "Ninthwave · Start orchestration"}${RESET}`, cols)}${CLEAR_LINE}\n`;
      if (headerGap) {
        out += `${CLEAR_LINE}\n`;
      }

      for (const line of visibleBodyLines) {
        out += `${truncateCheckboxLine(line, cols)}${CLEAR_LINE}\n`;
      }
      for (let i = visibleBodyLines.length; i < viewportHeight; i++) {
        out += `${CLEAR_LINE}\n`;
      }

      out += `${truncateCheckboxLine(`${DIM}↑/↓ change row  ←/→ change value  Enter confirm  Esc cancel${RESET}`, cols)}${CLEAR_LINE}`;
      if (footerGap) {
        out += `\n${CLEAR_LINE}`;
      }

      io.write(out);
    };

    const handler = (key: string) => {
      switch (key) {
        case "\x1B[A":
        case "k":
          activeRow = (activeRow - 1 + settingRowCount) % settingRowCount;
          break;
        case "\x1B[B":
        case "j":
          activeRow = (activeRow + 1) % settingRowCount;
          break;
        case "\x1B[D":
        case "h":
          if (activeRow === 0) {
            reviewIndex = (reviewIndex - 1 + REVIEW_MODE_OPTIONS.length) % REVIEW_MODE_OPTIONS.length;
          } else if (activeRow === 1) {
            collaborationIndex = (collaborationIndex - 1 + COLLABORATION_MODE_OPTIONS.length) % COLLABORATION_MODE_OPTIONS.length;
          }
          break;
        case "\x1B[C":
        case "l":
          if (activeRow === 0) {
            reviewIndex = (reviewIndex + 1) % REVIEW_MODE_OPTIONS.length;
          } else if (activeRow === 1) {
            collaborationIndex = (collaborationIndex + 1) % COLLABORATION_MODE_OPTIONS.length;
          }
          break;
        case "\r":
          io.offKey(handler);
          resolve({
            mergeStrategy,
            reviewMode: currentReviewOption().persistedValue,
            collaborationMode: currentCollaborationOption().persistedValue,
            sessionLimit,
            cancelled: false,
          });
          return;
        case "\x1B":
        case "\x03":
          io.offKey(handler);
          resolve({
            mergeStrategy,
            reviewMode: currentReviewOption().persistedValue,
            collaborationMode: currentCollaborationOption().persistedValue,
            sessionLimit,
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
        ? `deps: ${t.dependencies.join(", ")}`
        : undefined;
    return {
      id: t.id,
      label: `${CYAN}${t.id}${RESET}  ${t.title}`,
      detail: `${priorityColor}[${t.priority}]${RESET}`,
      subline: depInfo,
      checked: true,
    };
  });
}

function createStartupSelectionState(
  items: WorkItem[],
): CheckboxListViewState {
  const sorted = sortWorkItems(items);
  const hasCurrentItems = sorted.length > 0;
  const itemMap = new Map(sorted.map((item) => [item.id, item] as const));
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

  return hasCurrentItems
    ? {
      items: [
        {
          id: ALL_SENTINEL_ID,
          label: "All \u2014 includes future items",
          checked: true,
        },
        ...toCheckboxItems(sorted),
      ],
      title: `Ninthwave \u00b7 Select work items (${sorted.length} available)`,
      linkAllId: ALL_SENTINEL_ID,
      validate: validateDeps,
    }
    : {
      items: [
        {
          id: FUTURE_TASKS_ID,
          label: "Future tasks",
          detail: "Start automatically when new work arrives",
          checked: true,
        },
      ],
      title: "Ninthwave \u00b7 No work items queued",
    };
}

function summarizeStartupRefreshNotice(
  refreshResult: StartupItemsRefreshResult,
  removedSelectedIds: string[],
): string | null {
  const prunedIds = refreshResult.changes
    .filter((change) => change.type === "removed" && change.reason === "merged-pruned")
    .map((change) => change.id);

  if (prunedIds.length === 0 && removedSelectedIds.length === 0) {
    return null;
  }

  const prunedLabel = prunedIds.length > 0 ? `Removed merged items: ${prunedIds.join(", ")}` : null;
  const clearedLabel = removedSelectedIds.length > 0
    ? `Cleared selection for ${removedSelectedIds.join(", ")}`
    : null;

  return [prunedLabel, clearedLabel].filter(Boolean).join(". ");
}

/**
 * Run the full TUI selection screen flow:
 * 1. Checkbox list for item selection
 * 2. Checkbox list for AI tool selection (conditional: 2+ tools)
 * 3. Startup settings screen (startup) or summary confirmation (re-entry)
 *
 * Initial startup keeps the item summary visible while arrow keys adjust merge,
 * reviews, collaboration, and session limit. Re-entry flows (`showConnectionStep: false`)
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
  defaultSessionLimit: number,
  opts: {
    defaultReviewMode?: "on" | "off";
    defaultSettings?: TuiSettingsDefaults;
    showConnectionStep?: boolean;
    /** Installed AI tools for the tool selection step. Empty/single = skip screen. */
    installedTools?: AiToolProfile[];
    /** One-shot async refresh for pruning merged startup items after first paint. */
    refreshItems?: () => Promise<StartupItemsRefreshResult>;
    /** Pre-selected tool IDs for multi-select (from saved config). */
    savedToolIds?: string[];
    /** Project root for agent file validation. */
    projectRoot?: string;
  } = {},
): Promise<SelectionScreenResult | null> {
  const resolvedDefaults: TuiSettingsDefaults = {
    mergeStrategy: opts.defaultSettings?.mergeStrategy ?? TUI_SETTINGS_DEFAULTS.mergeStrategy,
    reviewMode: opts.defaultSettings?.reviewMode ?? opts.defaultReviewMode ?? TUI_SETTINGS_DEFAULTS.reviewMode,
    collaborationMode: opts.defaultSettings?.collaborationMode ?? TUI_SETTINGS_DEFAULTS.collaborationMode,
  };
  let currentSortedItems = sortWorkItems(items);
  const hasCurrentItems = currentSortedItems.length > 0;
  const initialSelectionState = createStartupSelectionState(currentSortedItems);

  // Step 1: Item selection
  io.write(CLEAR_SCREEN + HIDE_CURSOR);
  let itemListController: CheckboxListController | null = null;
  let itemSelectionOpen = true;
  const itemResultPromise = runCheckboxList(io, initialSelectionState.items, {
    title: initialSelectionState.title,
    linkAllId: initialSelectionState.linkAllId,
    validate: initialSelectionState.validate,
    bindController: (controller) => {
      itemListController = controller;
    },
  });
  const refreshPromise = hasCurrentItems && opts.refreshItems
    ? opts.refreshItems()
      .then((refreshResult) => {
        if (!itemSelectionOpen || !itemListController) return;
        currentSortedItems = sortWorkItems(refreshResult.activeItems);
        const nextSelectionState = createStartupSelectionState(refreshResult.activeItems);
        const replaced = itemListController.replaceState(nextSelectionState);
        const notice = summarizeStartupRefreshNotice(
          refreshResult,
          replaced.removedSelectedIds,
        );
        if (notice) {
          itemListController.setNotice(notice);
        } else {
          itemListController.clearNotice();
        }
      })
      .catch(() => {
        // Keep the local-first picker visible even when pruning checks fail.
      })
    : null;
  const itemResult = await itemResultPromise;
  itemSelectionOpen = false;

  if (itemResult.cancelled) {
    io.write(SHOW_CURSOR);
    return null;
  }

  void refreshPromise;

  // Filter synthetic sentinels from the selected ids.
  const futureOnly = !hasCurrentItems && itemResult.selectedIds.includes(FUTURE_TASKS_ID);
  const selectedItemIds = itemResult.selectedIds.filter(
    (id) => id !== ALL_SENTINEL_ID && id !== FUTURE_TASKS_ID,
  );

  const defaultMergeStrategy: Extract<MergeStrategy, "auto" | "manual"> = resolvedDefaults.mergeStrategy;
  const initialSessionLimit = Math.max(1, Math.min(10, defaultSessionLimit));
  const defaultReviewMode: "on" | "off" = resolvedDefaults.reviewMode;
  const defaultConnectionAction: ConnectionAction | null = null;

  // Step 2: AI coding tool (conditional -- only when 2+ tools detected)
  let aiTool: string | undefined;
  let aiTools: string[] | undefined;
  const tools = opts.installedTools ?? [];

  if (tools.length >= 2) {
    // Multi-select: pre-check saved tools or all if none saved
    const savedIds = opts.savedToolIds ?? [];
    const toolCheckboxItems: CheckboxItem[] = tools.map((t) => {
      const seeded = opts.projectRoot && isAiToolId(t.id) ? hasAgentFiles(t.id, opts.projectRoot) : true;
      return {
        id: t.id,
        label: t.displayName,
        detail: seeded
          ? `Model defined in ${t.targetDir}/ agent files`
          : `${YELLOW}No agent files at ${t.targetDir}/${RESET}${DIM} -- run "nw init"${RESET}`,
        checked: savedIds.length > 0 ? savedIds.includes(t.id) : true,
      };
    });

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
        const item = currentSortedItems.find((t) => t.id === id);
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
  let sessionLimit = initialSessionLimit;
  let reviewMode: "on" | "off" = defaultReviewMode;
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
      defaultSessionLimit: initialSessionLimit,
      defaultSettings: resolvedDefaults,
    });

    io.write(SHOW_CURSOR);

    if (settingsResult.cancelled) {
      return null;
    }

    mergeStrategy = settingsResult.mergeStrategy;
    sessionLimit = settingsResult.sessionLimit;
    reviewMode = settingsResult.reviewMode;
    if (settingsResult.collaborationMode === "share") {
      connectionAction = { type: "connect" };
    } else if (settingsResult.collaborationMode === "join") {
      io.write(CLEAR_SCREEN);
      const joinCode = await runTextInput(io, {
        title: "Ninthwave · Join session",
        hint: "Format: XXXX-XXXX-XXXX-XXXX (e.g. K2F9-AB3X-7YPL-QM4N)",
        validate: (value) => {
          const trimmed = value.trim();
          return parseCrewCode(trimmed) ? null : formatInvalidCrewCodeMessage(trimmed);
        },
      });
      io.write(SHOW_CURSOR);

      if (joinCode.cancelled) {
        connectionAction = null;
      } else {
        connectionAction = { type: "join", code: parseCrewCode(joinCode.value.trim())! };
      }
    } else {
      connectionAction = null;
    }
  }

  return {
    itemIds: selectedItemIds,
    allSelected: itemResult.allSelected,
    futureOnly,
    mergeStrategy,
    sessionLimit,
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
