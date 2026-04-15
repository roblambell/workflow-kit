// Tests for core/tui-widgets.ts -- In-TUI selection widgets.

import { describe, it, expect, vi } from "vitest";
import { stripAnsiForWidth } from "../core/status-render.ts";
import {
  runCheckboxList,
  runSingleSelect,
  runNumberPicker,
  runConfirm,
  runStartupSettingsScreen,
  runTextInput,
  runSelectionScreen,
  sortWorkItems,
  toCheckboxItems,
  type WidgetIO,
  type CheckboxItem,
  type CheckboxListController,
  type SingleSelectOption,
  type TextInputResult,
} from "../core/tui-widgets.ts";
import type { WorkItem } from "../core/types.ts";
import type { MergeStrategy } from "../core/orchestrator.ts";
import type { AiToolProfile } from "../core/ai-tools.ts";
import type { StartupItemsRefreshResult } from "../core/startup-items.ts";

// ── Test helpers ────────────────────────────────────────────────────

/** Create a mock WidgetIO with injectable key sequences. */
function createMockIO(opts?: { rows?: number; cols?: number }): {
  io: WidgetIO;
  sendKey: (key: string) => void;
  sendKeys: (keys: string[]) => void;
  /** Send keys with microtask gaps between each batch (for composite widgets). */
  sendKeyBatches: (...batches: string[][]) => void;
  getOutput: () => string;
} {
  let handler: ((key: string) => void) | null = null;
  let output = "";

  const io: WidgetIO = {
    write: (s: string) => { output += s; },
    onKey: (h) => { handler = h; },
    offKey: () => { handler = null; },
    getRows: () => opts?.rows ?? 40,
    getCols: () => opts?.cols ?? 80,
  };

  const sendKeys = (keys: string[]) => {
    for (const k of keys) handler?.(k);
  };

  return {
    io,
    sendKey: (key: string) => { handler?.(key); },
    sendKeys,
    sendKeyBatches: (...batches: string[][]) => {
      // Send first batch synchronously, rest via chained microtasks.
      // This allows async widget transitions (await between widgets).
      if (batches.length === 0) return;
      sendKeys(batches[0]!);
      let chain = Promise.resolve();
      for (let i = 1; i < batches.length; i++) {
        const batch = batches[i]!;
        chain = chain.then(() => new Promise<void>((r) => {
          queueMicrotask(() => { sendKeys(batch); r(); });
        }));
      }
    },
    getOutput: () => output,
  };
}

function makeWorkItem(
  id: string,
  title: string,
  priority: "critical" | "high" | "medium" | "low" = "medium",
  deps: string[] = [],
): WorkItem {
  return {
    id,
    priority,
    title,
    domain: "test",
    dependencies: deps,
    bundleWith: [],
    status: "open",
    filePath: `/tmp/items/${id}.md`,
    rawText: `## ${id}\n${title}`,
    filePaths: [],
    testPlan: "",
  };
}

function makeCheckboxItems(count: number): CheckboxItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `T-${i + 1}`,
    label: `Item ${i + 1}`,
    checked: false,
  }));
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function getLastRenderedFrame(output: string): string {
  const frames = output.split("\x1B[H");
  return frames[frames.length - 1] ?? output;
}

function getPlainFrameLines(output: string): string[] {
  return getLastRenderedFrame(output).split("\n").map((line) => stripAnsiForWidth(line));
}

function getPlainFrameLine(output: string, pattern: string): string {
  const line = getPlainFrameLines(output).find((frameLine) => frameLine.includes(pattern));
  if (!line) {
    throw new Error(`No frame line matched pattern: ${pattern}`);
  }
  return line;
}

function getStartupChipStart(line: string, label: string): number {
  for (const variant of [`[${label}]`, ` ${label} `]) {
    const index = line.indexOf(variant);
    if (index !== -1) {
      return index;
    }
  }
  throw new Error(`No chip found for label: ${label}`);
}

// ── CheckboxList widget ─────────────────────────────────────────────

describe("runCheckboxList", () => {
  it("renders items and confirms selection with space + Enter", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeCheckboxItems(3);

    const resultPromise = runCheckboxList(io, items);
    // Toggle first item, then confirm
    sendKeys([" ", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.selectedIds).toEqual(["T-1"]);
  });

  it("arrow navigation moves cursor down and up", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeCheckboxItems(3);

    const resultPromise = runCheckboxList(io, items);
    // Down twice, select T-3, up once, select T-2, confirm
    sendKeys(["\x1B[B", "\x1B[B", " ", "\x1B[A", " ", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.selectedIds).toContain("T-2");
    expect(result.selectedIds).toContain("T-3");
    expect(result.selectedIds).not.toContain("T-1");
  });

  it("j/k navigation works like arrows", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeCheckboxItems(3);

    const resultPromise = runCheckboxList(io, items);
    // j down to T-2, toggle, k up to T-1, toggle, confirm
    sendKeys(["j", " ", "k", " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).toContain("T-2");
  });

  it("toggle all with 'a' key", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeCheckboxItems(3);

    const resultPromise = runCheckboxList(io, items);
    // Toggle all on, confirm
    sendKeys(["a", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("toggle all twice deselects all", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeCheckboxItems(3);

    const resultPromise = runCheckboxList(io, items);
    // Toggle all on, toggle all off, select just T-1, confirm
    sendKeys(["a", "a", " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toEqual(["T-1"]);
  });

  it("Escape cancels selection", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeCheckboxItems(3);

    const resultPromise = runCheckboxList(io, items);
    sendKeys(["\x1B"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(true);
    expect(result.selectedIds).toEqual([]);
  });

  it("Ctrl+C cancels selection", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeCheckboxItems(3);

    const resultPromise = runCheckboxList(io, items);
    sendKeys(["\x03"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(true);
  });

  it("Enter with zero selected shows error and stays", async () => {
    const { io, sendKeys, getOutput } = createMockIO();
    const items = makeCheckboxItems(3);

    const resultPromise = runCheckboxList(io, items);
    // Try to confirm with nothing selected, then actually select and confirm
    sendKeys(["\r", " ", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.selectedIds).toEqual(["T-1"]);
    // Error message should have been rendered
    expect(getOutput()).toContain("Select at least one item");
  });

  it("returns empty for empty items list", async () => {
    const { io } = createMockIO();
    const result = await runCheckboxList(io, []);
    expect(result.cancelled).toBe(true);
    expect(result.selectedIds).toEqual([]);
  });

  it("cursor wraps around at top boundary", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeCheckboxItems(2);

    const resultPromise = runCheckboxList(io, items);
    // Up from first item wraps to last then back to first, toggle (should toggle T-1)
    sendKeys(["\x1B[A", "\x1B[A", " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toEqual(["T-1"]);
  });

  it("cursor wraps around at bottom boundary", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeCheckboxItems(2);

    const resultPromise = runCheckboxList(io, items);
    // Down past last item wraps around, toggle (should toggle T-2)
    sendKeys(["\x1B[B", "\x1B[B", "\x1B[B", " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toEqual(["T-2"]);
  });

  it("renders at small terminal size (80x25)", async () => {
    const { io, sendKeys, getOutput } = createMockIO({ rows: 25, cols: 80 });
    const items = makeCheckboxItems(5);

    const resultPromise = runCheckboxList(io, items);
    sendKeys(["a", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toHaveLength(5);
    expect(getOutput()).toContain("Item 1");
  });

  it("renders at large terminal size (80x40)", async () => {
    const { io, sendKeys, getOutput } = createMockIO({ rows: 40, cols: 80 });
    const items = makeCheckboxItems(5);

    const resultPromise = runCheckboxList(io, items);
    sendKeys(["a", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toHaveLength(5);
  });

  it("scrolls when items exceed viewport", async () => {
    const { io, sendKeys } = createMockIO({ rows: 12 }); // very small: ~6 items visible
    const items = makeCheckboxItems(20);

    const resultPromise = runCheckboxList(io, items);
    // Navigate down to item 15, toggle it, confirm
    const downKeys = Array(14).fill("\x1B[B");
    sendKeys([...downKeys, " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toEqual(["T-15"]);
  });

  it("renders dependency text on an aligned sub-line", async () => {
    const { io, sendKeys, getOutput } = createMockIO({ rows: 10, cols: 50 });
    const items: CheckboxItem[] = [
      {
        id: "B-2",
        label: "B-2  Dependent task",
        detail: "[medium]",
        subline: "deps: A-1",
        checked: true,
      },
    ];

    const resultPromise = runCheckboxList(io, items);
    sendKeys(["\r"]);

    const result = await resultPromise;
    const lines = getPlainFrameLines(getOutput());
    expect(result.cancelled).toBe(false);
    expect(lines).toContain("> [x] B-2  Dependent task [medium]");
    expect(lines).toContain("      deps: A-1");
  });

  it("keeps the checkbox frame within narrow terminal bounds", async () => {
    const { io, sendKeys, getOutput } = createMockIO({ rows: 8, cols: 24 });
    const items: CheckboxItem[] = [
      {
        id: "T-1",
        label: "Extremely long item label with ANSI",
        detail: "[medium]",
        subline: "deps: A-1, B-2, C-3",
        checked: true,
      },
      {
        id: "T-2",
        label: "Second item with more text",
        detail: "[high]",
        checked: true,
      },
    ];

    const resultPromise = runCheckboxList(io, items);
    sendKeys(["\r"]);

    const result = await resultPromise;
    const lines = getPlainFrameLines(getOutput());
    const itemLines = lines.slice(3, 5);
    expect(result.cancelled).toBe(false);
    expect(lines.length).toBeLessThanOrEqual(8);
    for (const line of itemLines) {
      expect(line.length).toBeLessThanOrEqual(24);
    }
  });

  it("scrolls by rendered lines so active two-line items stay visible", async () => {
    const { io, sendKeys, getOutput } = createMockIO({ rows: 10, cols: 36 });
    const items: CheckboxItem[] = [
      { id: "T-1", label: "Item 1", checked: false },
      { id: "T-2", label: "Item 2", detail: "[medium]", subline: "deps: T-1", checked: false },
      { id: "T-3", label: "Item 3", checked: false },
      { id: "T-4", label: "Item 4", detail: "[high]", subline: "deps: T-2, T-3", checked: false },
    ];

    const resultPromise = runCheckboxList(io, items);
    sendKeys(["\x1B[B", "\x1B[B", "\x1B[B", " ", "\r"]);

    const result = await resultPromise;
    const frame = getPlainFrameLines(getOutput()).join("\n");
    expect(result.selectedIds).toEqual(["T-4"]);
    expect(frame).toContain("> [x] Item 4 [high]");
    expect(frame).toContain("      deps: T-2, T-3");
    expect(frame).not.toContain("Item 1");
  });

  it("replaces checkbox items after first render and preserves surviving selections", async () => {
    const { io, sendKeys } = createMockIO();
    let controller: CheckboxListController | undefined;
    const items: CheckboxItem[] = [
      { id: "__ALL__", label: "All", checked: true },
      { id: "A-1", label: "A-1  First", checked: true },
      { id: "B-2", label: "B-2  Second", checked: true },
    ];

    const resultPromise = runCheckboxList(io, items, {
      linkAllId: "__ALL__",
      bindController: (nextController) => {
        controller = nextController;
      },
    });

    sendKeys(["\x1B[B", "\x1B[B", " "]); // Keep __ALL__ checked but uncheck B-2.
    controller!.replaceState({
      title: "Refreshed",
      linkAllId: "__ALL__",
      items: [
        { id: "__ALL__", label: "All", checked: true },
        { id: "B-2", label: "B-2  Second", checked: true },
        { id: "C-3", label: "C-3  Third", checked: true },
      ],
    });
    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("__ALL__");
    expect(result.selectedIds).toContain("C-3");
    expect(result.selectedIds).not.toContain("B-2");
  });

  it("shows a visible notice when replaced items clear removed selections", async () => {
    const { io, sendKeys, getOutput } = createMockIO();
    let controller: CheckboxListController | undefined;
    const items: CheckboxItem[] = [
      { id: "A-1", label: "A-1  First", checked: true },
      { id: "B-2", label: "B-2  Second", checked: false },
    ];

    const resultPromise = runCheckboxList(io, items, {
      bindController: (nextController) => {
        controller = nextController;
      },
    });

    const replaced = controller!.replaceState({
      title: "Refreshed",
      noticeMessage: "Removed merged items: A-1. Cleared selection for A-1",
      items: [
        { id: "B-2", label: "B-2  Second", checked: false },
        { id: "C-3", label: "C-3  Third", checked: true },
      ],
    });
    sendKeys(["\x1B[B", "\r"]);

    const result = await resultPromise;
    const frame = getLastRenderedFrame(getOutput());
    expect(replaced.removedSelectedIds).toEqual(["A-1"]);
    expect(result.selectedIds).toEqual(["C-3"]);
    expect(frame).toContain("Removed merged items: A-1. Cleared selection for A-1");
  });
});

// ── CheckboxList with linkAllId (linked toggle) ─────────────────────

describe("runCheckboxList with linkAllId", () => {
  /** Creates [__ALL__(T), T-1(T), ..., T-N(T)] -- all checked. */
  function makeLinkedItems(count: number): CheckboxItem[] {
    const allItem: CheckboxItem = { id: "__ALL__", label: "All", checked: true };
    const regularItems = Array.from({ length: count }, (_, i) => ({
      id: `T-${i + 1}`,
      label: `Item ${i + 1}`,
      checked: true,
    }));
    return [allItem, ...regularItems];
  }

  it("toggling __ALL__ off unchecks all items", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeLinkedItems(3); // __ALL__, T-1, T-2, T-3 -- all checked

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // Space on __ALL__ (index 0): unchecks all. Down to T-1, space to re-check. Confirm.
    sendKeys([" ", "\x1B[B", " ", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).not.toContain("T-2");
    expect(result.selectedIds).not.toContain("T-3");
    expect(result.selectedIds).not.toContain("__ALL__");
    expect(result.allSelected).toBe(false);
  });

  it("toggling __ALL__ on checks all items", async () => {
    const { io, sendKeys } = createMockIO();
    // Start all unchecked
    const items: CheckboxItem[] = [
      { id: "__ALL__", label: "All", checked: false },
      { id: "T-1", label: "Item 1", checked: false },
      { id: "T-2", label: "Item 2", checked: false },
    ];

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // Space on __ALL__: checks all. Confirm.
    sendKeys([" ", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.selectedIds).toContain("__ALL__");
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).toContain("T-2");
    expect(result.allSelected).toBe(true);
  });

  it("unchecking a regular item does not affect __ALL__", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeLinkedItems(2); // __ALL__, T-1, T-2 -- all checked

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // Down to T-2 (index 2), space to uncheck. __ALL__ stays checked (independent).
    sendKeys(["\x1B[B", "\x1B[B", " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).not.toContain("T-2");
    expect(result.selectedIds).toContain("__ALL__");
    expect(result.allSelected).toBe(true);
  });

  it("all regular items checked does not auto-check __ALL__", async () => {
    const { io, sendKeys } = createMockIO();
    // Start with __ALL__ unchecked, regular items checked
    const items: CheckboxItem[] = [
      { id: "__ALL__", label: "All", checked: false },
      { id: "T-1", label: "Item 1", checked: true },
      { id: "T-2", label: "Item 2", checked: true },
    ];

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // All regular items already checked. __ALL__ should stay unchecked. Confirm.
    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).toContain("T-2");
    expect(result.selectedIds).not.toContain("__ALL__");
    expect(result.allSelected).toBe(false);
  });

  it("'a' key toggles only regular items, not __ALL__", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeLinkedItems(2); // all checked including __ALL__

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // "a" unchecks regular items (sentinel stays checked), "a" re-checks regular items, confirm
    sendKeys(["a", "a", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("__ALL__");
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).toContain("T-2");
    expect(result.allSelected).toBe(true);
  });

  it("'a' key uncheck leaves __ALL__ unchanged", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeLinkedItems(2); // all checked including __ALL__

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // "a" unchecks regular items only, sentinel stays checked. Select T-1 to confirm.
    sendKeys(["a", "\x1B[B", " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).toContain("__ALL__");
    expect(result.allSelected).toBe(true);
  });

  it("edge case: single work item + __ALL__ (2 items total)", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeLinkedItems(1); // __ALL__ + T-1, both checked

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // Just confirm (all already checked)
    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("__ALL__");
    expect(result.selectedIds).toContain("T-1");
    expect(result.allSelected).toBe(true);
  });

  it("toggling regular item does not affect __ALL__ (single item edge case)", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeLinkedItems(1); // __ALL__ + T-1, both checked

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // Down to T-1, uncheck, re-check -- __ALL__ stays checked throughout (independent)
    sendKeys(["\x1B[B", " ", " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).toContain("__ALL__");
    expect(result.allSelected).toBe(true);
  });
});

// ── SingleSelect picker ─────────────────────────────────────────────

describe("runSingleSelect", () => {
  const options: SingleSelectOption<MergeStrategy>[] = [
    { value: "auto", label: "auto", description: "Auto-merge", isDefault: true },
    { value: "manual", label: "manual", description: "Manual merge" },
  ];

  it("renders options and confirms selection with Enter", async () => {
    const { io, sendKeys, getOutput } = createMockIO();

    const resultPromise = runSingleSelect(io, options);
    // Default is already on "auto", just confirm
    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.value).toBe("auto");
    expect(getOutput()).toContain("auto");
    expect(getOutput()).toContain("manual");
  });

  it("arrow down selects second option", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runSingleSelect(io, options);
    sendKeys(["\x1B[B", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe("manual");
  });

  it("arrow cycles wrap around", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runSingleSelect(io, options);
    // Down, Down wraps to first, confirm
    sendKeys(["\x1B[B", "\x1B[B", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe("auto");
  });

  it("up arrow wraps to last option", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runSingleSelect(io, options);
    // Up from first wraps to last
    sendKeys(["\x1B[A", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe("manual");
  });

  it("Escape cancels", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runSingleSelect(io, options);
    sendKeys(["\x1B"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(true);
  });

  it("Ctrl+C cancels", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runSingleSelect(io, options);
    sendKeys(["\x03"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(true);
  });

  it("j/k navigation works", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runSingleSelect(io, options);
    sendKeys(["j", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe("manual");
  });

  it("starts on default option", async () => {
    const { io, sendKeys } = createMockIO();
    const opts: SingleSelectOption<string>[] = [
      { value: "a", label: "A" },
      { value: "b", label: "B", isDefault: true },
      { value: "c", label: "C" },
    ];

    const resultPromise = runSingleSelect(io, opts);
    sendKeys(["\r"]); // Confirm without moving

    const result = await resultPromise;
    expect(result.value).toBe("b");
  });

  it("returns cancelled for empty options", async () => {
    const { io } = createMockIO();
    const result = await runSingleSelect(io, []);
    expect(result.cancelled).toBe(true);
  });
});

// ── NumberPicker widget ─────────────────────────────────────────────

describe("runNumberPicker", () => {
  it("confirms initial value on Enter", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 4, min: 1, max: 10 });
    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.value).toBe(4);
  });

  it("up arrow increases value", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 4, min: 1, max: 10 });
    sendKeys(["\x1B[A", "\x1B[A", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe(6);
  });

  it("down arrow decreases value", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 4, min: 1, max: 10 });
    sendKeys(["\x1B[B", "\x1B[B", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe(2);
  });

  it("right arrow increases value", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 3, min: 1, max: 10 });
    sendKeys(["\x1B[C", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe(4);
  });

  it("left arrow decreases value", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 3, min: 1, max: 10 });
    sendKeys(["\x1B[D", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe(2);
  });

  it("clamps to max on upper boundary", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 10, min: 1, max: 10 });
    sendKeys(["\x1B[A", "\x1B[A", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe(10);
  });

  it("clamps to min on lower boundary", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 1, min: 1, max: 10 });
    sendKeys(["\x1B[B", "\x1B[B", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe(1);
  });

  it("Escape cancels", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 5 });
    sendKeys(["\x1B"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(true);
  });

  it("Ctrl+C cancels", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 5 });
    sendKeys(["\x03"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(true);
  });

  it("h/l keys work as left/right", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 5, min: 1, max: 10 });
    sendKeys(["l", "l", "h", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe(6);
  });

  it("j/k keys work as down/up", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 5, min: 1, max: 10 });
    sendKeys(["k", "k", "j", "\r"]);

    const result = await resultPromise;
    expect(result.value).toBe(6);
  });

  it("renders current value with visual emphasis", async () => {
    const { io, sendKeys, getOutput } = createMockIO();

    const resultPromise = runNumberPicker(io, { initial: 5, min: 1, max: 10 });
    sendKeys(["\r"]);

    await resultPromise;
    expect(getOutput()).toContain("[5]");
  });

  it("uses defaults when no opts provided", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runNumberPicker(io);
    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result.value).toBe(1); // min default
  });
});

// ── Confirm widget ──────────────────────────────────────────────────

describe("runConfirm", () => {
  it("Enter confirms", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runConfirm(io, { title: "Proceed?", lines: ["Line 1"] });
    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result).toBe(true);
  });

  it("y confirms", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runConfirm(io);
    sendKeys(["y"]);

    expect(await resultPromise).toBe(true);
  });

  it("Y confirms", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runConfirm(io);
    sendKeys(["Y"]);

    expect(await resultPromise).toBe(true);
  });

  it("n cancels", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runConfirm(io, { title: "Proceed?" });
    sendKeys(["n"]);

    expect(await resultPromise).toBe(false);
  });

  it("N cancels", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runConfirm(io);
    sendKeys(["N"]);

    expect(await resultPromise).toBe(false);
  });

  it("Escape cancels", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runConfirm(io, { title: "Proceed?" });
    sendKeys(["\x1B"]);

    expect(await resultPromise).toBe(false);
  });

  it("Ctrl+C cancels", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runConfirm(io);
    sendKeys(["\x03"]);

    expect(await resultPromise).toBe(false);
  });

  it("renders title and lines", async () => {
    const { io, sendKeys, getOutput } = createMockIO();

    const resultPromise = runConfirm(io, {
      title: "Ready?",
      lines: ["item A", "item B"],
    });
    sendKeys(["\r"]);

    await resultPromise;
    const output = getOutput();
    expect(output).toContain("Ready?");
    expect(output).toContain("item A");
    expect(output).toContain("item B");
  });

  it("wraps long summaries into a bounded body and keeps the footer visible", async () => {
    const { io, sendKeys, getOutput } = createMockIO({ rows: 7, cols: 24 });

    const resultPromise = runConfirm(io, {
      title: "Ready?",
      lines: [
        "This is a very long summary line that should wrap inside the confirm dialog body.",
        "A second long line keeps the body overflowing in a short terminal.",
      ],
    });

    const lines = getPlainFrameLines(getOutput());
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(lines.some((line) => line.includes("Enter"))).toBe(true);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(24);
    }

    sendKeys(["\r"]);
    expect(await resultPromise).toBe(true);
  });

  it("scrolls overflowing content with down arrow and j while preserving confirm", async () => {
    const { io, sendKeys, getOutput } = createMockIO({ rows: 7, cols: 28 });

    const resultPromise = runConfirm(io, {
      title: "Proceed?",
      lines: ["Item 1", "Item 2", "Item 3", "Item 4", "Item 5", "Item 6"],
    });

    sendKeys(["\x1B[B", "j"]);

    const frame = getPlainFrameLines(getOutput()).join("\n");
    expect(frame).toContain("Item 3");
    expect(frame).toContain("Item 4");
    expect(frame).not.toContain("Item 1");

    sendKeys(["\r"]);
    expect(await resultPromise).toBe(true);
  });

  it("scrolls overflowing content with k and up arrow while preserving cancel", async () => {
    const { io, sendKeys, getOutput } = createMockIO({ rows: 7, cols: 28 });

    const resultPromise = runConfirm(io, {
      title: "Proceed?",
      lines: ["Item 1", "Item 2", "Item 3", "Item 4", "Item 5", "Item 6"],
    });

    sendKeys(["\x1B[B", "j", "k", "\x1B[A"]);

    const frame = getPlainFrameLines(getOutput()).join("\n");
    expect(frame).toContain("Item 1");
    expect(frame).toContain("Item 2");
    expect(frame).not.toContain("Item 4");

    sendKeys(["\x1B"]);
    expect(await resultPromise).toBe(false);
  });
});

// ── sortWorkItems ───────────────────────────────────────────────────

describe("sortWorkItems", () => {
  it("sorts by priority then ID", () => {
    const items = [
      makeWorkItem("L-1", "Low task", "low"),
      makeWorkItem("C-1", "Critical task", "critical"),
      makeWorkItem("M-1", "Medium task", "medium"),
      makeWorkItem("H-1", "High task", "high"),
    ];

    const sorted = sortWorkItems(items);
    expect(sorted.map((i) => i.id)).toEqual(["C-1", "H-1", "M-1", "L-1"]);
  });

  it("breaks priority ties by ID", () => {
    const items = [
      makeWorkItem("Z-1", "Z task", "medium"),
      makeWorkItem("A-1", "A task", "medium"),
      makeWorkItem("M-1", "M task", "medium"),
    ];

    const sorted = sortWorkItems(items);
    expect(sorted.map((i) => i.id)).toEqual(["A-1", "M-1", "Z-1"]);
  });

  it("returns empty array for empty input", () => {
    expect(sortWorkItems([])).toEqual([]);
  });

  it("does not mutate original array", () => {
    const items = [
      makeWorkItem("B-1", "B", "low"),
      makeWorkItem("A-1", "A", "high"),
    ];
    const sorted = sortWorkItems(items);
    expect(items[0]!.id).toBe("B-1"); // original unchanged
    expect(sorted[0]!.id).toBe("A-1");
  });
});

// ── toCheckboxItems ─────────────────────────────────────────────────

describe("toCheckboxItems", () => {
  it("converts work items to checkbox items", () => {
    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium", ["A-1"]),
    ];

    const checkboxItems = toCheckboxItems(items);
    expect(checkboxItems).toHaveLength(2);
    expect(checkboxItems[0]!.id).toBe("A-1");
    expect(checkboxItems[0]!.checked).toBe(true);
    expect(checkboxItems[1]!.id).toBe("B-2");
    expect(checkboxItems[1]!.detail).toContain("[medium]");
    expect(checkboxItems[1]!.detail).not.toContain("deps:");
    expect(checkboxItems[1]!.subline).toBe("deps: A-1");
  });

  it("handles items without dependencies", () => {
    const items = [makeWorkItem("A-1", "Solo task", "low")];
    const checkboxItems = toCheckboxItems(items);
    expect(checkboxItems[0]!.detail).not.toContain("deps:");
    expect(checkboxItems[0]!.subline).toBeUndefined();
  });
});

describe("runStartupSettingsScreen", () => {
  it("changes rows with up/down and values with left/right", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runStartupSettingsScreen(io, {
      summaryLines: ["Items: A-1"],
      defaultSessionLimit: 4,
      defaultSettings: {
        mergeStrategy: "manual",
        reviewMode: "off",
        collaborationMode: "local",
      },
    });

    sendKeys([
      "\x1B[C", // reviews off -> on
      "\x1B[B", // collaboration
      "\x1B[C", // local -> share
      "\r",
    ]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.mergeStrategy).toBe("manual");
    expect(result.reviewMode).toBe("on");
    expect(result.collaborationMode).toBe("share");
    expect(result.sessionLimit).toBe(4);
  });

  it("confirms defaults on Enter", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runStartupSettingsScreen(io, {
      summaryLines: ["Items: A-1"],
      defaultSessionLimit: 4,
    });

    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.mergeStrategy).toBe("manual");
    expect(result.reviewMode).toBe("on");
    expect(result.collaborationMode).toBe("local");
    expect(result.sessionLimit).toBe(4);
  });

  it("preserves auto merge strategy from persisted config on Enter", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runStartupSettingsScreen(io, {
      summaryLines: ["Items: A-1"],
      defaultSessionLimit: 4,
      defaultSettings: {
        mergeStrategy: "auto",
        reviewMode: "off",
        collaborationMode: "local",
      },
    });

    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.mergeStrategy).toBe("auto");
  });

  it("cancels on Escape and Ctrl+C", async () => {
    const { io, sendKeys } = createMockIO();
    const escapePromise = runStartupSettingsScreen(io, {
      summaryLines: ["Items: A-1"],
      defaultSessionLimit: 4,
    });
    sendKeys(["\x1B"]);
    expect((await escapePromise).cancelled).toBe(true);

    const second = createMockIO();
    const ctrlCPromise = runStartupSettingsScreen(second.io, {
      summaryLines: ["Items: A-1"],
      defaultSessionLimit: 4,
    });
    second.sendKeys(["\x03"]);
    expect((await ctrlCPromise).cancelled).toBe(true);
  });

  it("keeps title, footer, and the active row visible in a short terminal", async () => {
    const { io, sendKey, getOutput } = createMockIO({ rows: 9, cols: 38 });

    const resultPromise = runStartupSettingsScreen(io, {
      summaryLines: [
        "Items: A-1 A very long task title that should wrap across multiple viewport lines",
        "AI tool: Claude Code round-robin with a second tool label that also wraps",
      ],
      defaultSessionLimit: 4,
    });

    const activeLabels = ["Reviews", "Collaboration"];

    for (let i = 0; i < activeLabels.length; i++) {
      const lines = getPlainFrameLines(getOutput());
      expect(lines.length).toBeLessThanOrEqual(9);
      expect(lines[0]).toContain("Start orchestration");
      expect(lines.some((line) => line.includes("↑/↓ change row"))).toBe(true);
      expect(lines.some((line) => line.includes(`> ${activeLabels[i]}`))).toBe(true);

      if (i < activeLabels.length - 1) {
        sendKey("\x1B[B");
      }
    }

    sendKey("\r");

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.mergeStrategy).toBe("manual");
    expect(result.reviewMode).toBe("on");
    expect(result.collaborationMode).toBe("local");
    expect(result.sessionLimit).toBe(4);
  });

  it("wraps long summaries and descriptions within the terminal viewport", async () => {
    const summary = createMockIO({ rows: 10, cols: 32 });

    const summaryPromise = runStartupSettingsScreen(summary.io, {
      summaryLines: [
        "Items: A-1 A very long task title that should wrap neatly inside the viewport",
      ],
      defaultSessionLimit: 4,
    });

    const summaryLines = getPlainFrameLines(summary.getOutput());
    expect(summaryLines.length).toBeLessThanOrEqual(10);
    for (const line of summaryLines) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
    expect(summaryLines).toContain("  Items: A-1 A very long task");
    expect(summaryLines).toContain("title that should wrap neatly");
    expect(summaryLines).toContain("inside the viewport");

    summary.sendKeys(["\r"]);

    const summaryResult = await summaryPromise;
    expect(summaryResult.cancelled).toBe(false);

    const description = createMockIO({ rows: 12, cols: 32 });

    const descriptionPromise = runStartupSettingsScreen(description.io, {
      summaryLines: [],
      defaultSessionLimit: 4,
      defaultSettings: {
        mergeStrategy: "manual",
        reviewMode: "off",
        collaborationMode: "local",
      },
    });

    description.sendKeys(["\x1B[B"]);

    const lines = getPlainFrameLines(description.getOutput());
    expect(lines.length).toBeLessThanOrEqual(12);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
    expect(lines.some((line) => line.includes("> Collaboration"))).toBe(true);

    description.sendKeys(["\r"]);

    const result = await descriptionPromise;
    expect(result.cancelled).toBe(false);
  });

  it("shows only Reviews and Collaboration rows", async () => {
    const { io, sendKeys, getOutput } = createMockIO();

    const resultPromise = runStartupSettingsScreen(io, {
      summaryLines: ["Items: A-1"],
      defaultSessionLimit: 4,
    });

    const output = getOutput();
    expect(output).toContain("Reviews");
    expect(output).toContain("Collaboration");
    expect(output).not.toContain("> Merge");
    expect(output).not.toContain("> Session limit");

    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.mergeStrategy).toBe("manual");
    expect(result.sessionLimit).toBe(4);
  });
});

// ── Selection screen (composite) ────────────────────────────────────

describe("runSelectionScreen", () => {
  it("shows a future-tasks selection screen for an empty queue", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();

    const resultPromise = runSelectionScreen(io, [], 4);
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.itemIds).toEqual([]);
    expect(result!.allSelected).toBe(false);
    expect(result!.futureOnly).toBe(true);
    expect(getOutput()).toContain("Future tasks");
    expect(getOutput()).toContain("No work items queued");
  });

  it("supports future-only startup with direct share selection", async () => {
    const { io, sendKeyBatches } = createMockIO();

    const resultPromise = runSelectionScreen(io, [], 4);
    sendKeyBatches(
      ["\r"],
      ["\x1B[B", "\x1B[C", "\r"],
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.futureOnly).toBe(true);
    expect(result!.connectionAction).toEqual({ type: "connect" });
  });

  it("keeps future-only startup local when join code entry is cancelled", async () => {
    const { io, sendKeyBatches } = createMockIO();

    const resultPromise = runSelectionScreen(io, [], 4);
    sendKeyBatches(
      ["\r"],
      ["\x1B[B", "\x1B[C", "\x1B[C", "\r"],
      ["\x1B"],
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.futureOnly).toBe(true);
    expect(result!.connectionAction).toBeNull();
  });

  it("completes full flow: select items → confirm with local-first defaults", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4);

    // All items start checked (including __ALL__ sentinel). Just confirm items then summary.
    sendKeyBatches(
      ["\r"],        // Step 1: Confirm all items (all pre-checked)
      ["\r"],        // Step 2: Confirm startup settings
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.itemIds).toContain("A-1");
    expect(result!.itemIds).toContain("B-2");
    expect(result!.itemIds).not.toContain("__ALL__");
    expect(result!.allSelected).toBe(true);
    expect(result!.futureOnly).toBe(false);
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.sessionLimit).toBe(4);
    expect(result!.reviewMode).toBe("on");
    expect(result!.connectionAction).toBeNull();
    expect(result!.cancelled).toBe(false);
  });

  it("swaps to refreshed items in place after the first paint", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const refresh = createDeferred<StartupItemsRefreshResult>();
    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4, {
      refreshItems: () => refresh.promise,
    });

    expect(getPlainFrameLines(getOutput()).join("\n")).toContain("A-1  First task");

    refresh.resolve({
      localItems: items,
      activeItems: [items[1]!],
      prunedItems: [{ id: "A-1", prNumber: 42, matchMode: "lineage" }],
      diff: {
        keptItemIds: ["B-2"],
        removedItemIds: ["A-1"],
        addedItemIds: [],
      },
      changes: [
        {
          id: "A-1",
          type: "removed",
          reason: "merged-pruned",
          prNumber: 42,
          matchMode: "lineage",
        },
      ],
    });
    await flushMicrotasks();

    const refreshedFrame = getPlainFrameLines(getOutput()).join("\n");
    expect(refreshedFrame).toContain("B-2  Second task");
    expect(refreshedFrame).not.toContain("A-1  First task");
    expect(refreshedFrame).toContain("Removed merged items: A-1. Cleared selection for A-1");

    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.itemIds).toEqual(["B-2"]);
  });

  it("ignores late refresh results after the user cancels", async () => {
    const { io, sendKeys, getOutput } = createMockIO();
    const refresh = createDeferred<StartupItemsRefreshResult>();
    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4, {
      refreshItems: () => refresh.promise,
    });

    sendKeys(["\x1B"]);
    const result = await resultPromise;
    expect(result).toBeNull();

    const outputBeforeRefresh = getOutput();
    refresh.resolve({
      localItems: items,
      activeItems: [items[1]!],
      prunedItems: [{ id: "A-1", prNumber: 42, matchMode: "lineage" }],
      diff: {
        keptItemIds: ["B-2"],
        removedItemIds: ["A-1"],
        addedItemIds: [],
      },
      changes: [
        {
          id: "A-1",
          type: "removed",
          reason: "merged-pruned",
          prNumber: 42,
          matchMode: "lineage",
        },
      ],
    });
    await flushMicrotasks();

    expect(getOutput()).toBe(outputBeforeRefresh);
    expect(getOutput()).not.toContain("Removed merged items: A-1");
  });

  it("returns null when cancelled at item selection", async () => {
    const { io, sendKeys } = createMockIO();
    const items = [makeWorkItem("A-1", "First task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeys(["\x1B"]); // Escape

    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it("returns null when cancelled at confirmation", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "First task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(
      ["\r"],       // Confirm all items (pre-checked)
      ["\x1B"],     // Cancel startup settings
    );

    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it("selects all items correctly", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [
      makeWorkItem("A-1", "First", "high"),
      makeWorkItem("B-2", "Second", "medium"),
      makeWorkItem("C-3", "Third", "low"),
    ];

    const resultPromise = runSelectionScreen(io, items, 3);
    // All items start checked; just confirm
    sendKeyBatches(
      ["\r"],        // Confirm all items (pre-checked)
      ["\r"],        // Confirm startup settings
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.itemIds).toHaveLength(3);
    expect(result!.itemIds).toContain("A-1");
    expect(result!.itemIds).toContain("B-2");
    expect(result!.itemIds).toContain("C-3");
    expect(result!.itemIds).not.toContain("__ALL__");
    expect(result!.allSelected).toBe(true);
  });

  it("returns local-first defaults for merge, review, connection, and session limit", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "First")];

    const resultPromise = runSelectionScreen(io, items, 5);
    sendKeyBatches(
      ["\r"],  // Confirm all items
      ["\r"],  // Confirm startup settings
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.sessionLimit).toBe(5);
    expect(result!.reviewMode).toBe("on");
    expect(result!.connectionAction).toBeNull();
  });

  it("renders correctly at 80x25 terminal", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO({ rows: 25, cols: 80 });
    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4);
    // All items pre-checked; just confirm each step
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    const output = getOutput();
    expect(output).toContain("Select work items");
    expect(output).toContain("Ninthwave");
  });

  it("renders correctly at 80x40 terminal", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO({ rows: 40, cols: 80 });
    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4);
    // All items pre-checked; just confirm each step
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    const output = getOutput();
    expect(output).toContain("Select work items");
    expect(output).toContain("Ninthwave");
  });

  it("__ALL__ sentinel is filtered from returned itemIds", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "First task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    // Confirm all pre-checked items
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.itemIds).not.toContain("__ALL__");
    expect(result!.itemIds).toContain("A-1");
  });

  it("allSelected is true when __ALL__ is checked at confirmation", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "First task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    // __ALL__ starts checked; confirm all
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.allSelected).toBe(true);
  });

  it("allSelected is false when __ALL__ is explicitly unchecked", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [
      makeWorkItem("A-1", "First task"),
      makeWorkItem("B-2", "Second task"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4);
    // Space on __ALL__ (index 0) to uncheck all, then re-check A-1
    sendKeyBatches(
      [" ", "\x1B[B", " ", "\r"],  // Uncheck __ALL__ (unchecks all), re-check A-1, confirm
      ["\r"],                       // Confirm startup settings
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.allSelected).toBe(false);
    expect(result!.itemIds).toContain("A-1");
    expect(result!.itemIds).not.toContain("B-2");
    expect(result!.itemIds).not.toContain("__ALL__");
  });
});

// ── runTextInput widget ─────────────────────────────────────────────

describe("runTextInput", () => {
  it("accepts valid input on Enter", async () => {
    const { io, sendKey, sendKeys } = createMockIO();
    const validate = (v: string) => v.length > 0 ? null : "Required";

    const resultPromise = runTextInput(io, { title: "Enter value", validate });
    sendKeys(["h", "i", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.value).toBe("hi");
  });

  it("rejects invalid input with error and re-prompts", async () => {
    const { io, sendKeys, getOutput } = createMockIO();
    const validate = (v: string) =>
      /^[A-Za-z0-9]{3}-[A-Za-z0-9]{3}$/.test(v) ? null : "Invalid format";

    const resultPromise = runTextInput(io, { hint: "Format: XXX-XXX", validate });
    // Type invalid ("bad" = 3 chars without hyphen), press Enter (error shown),
    // backspace all 3 chars, then type valid code, confirm
    sendKeys(["b", "a", "d", "\r",
      "\x7f", "\x7f", "\x7f",         // backspace "bad"
      "a", "B", "3", "-", "x", "Y", "9", "\r",
    ]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.value).toBe("aB3-xY9");
    // Error message should have been rendered
    expect(getOutput()).toContain("Invalid format");
  });

  it("rejects invalid input then accepts corrected input via backspace", async () => {
    const { io, sendKeys } = createMockIO();
    const validate = (v: string) =>
      /^[A-Za-z0-9]{3}-[A-Za-z0-9]{3}$/.test(v) ? null : "Invalid format";

    const resultPromise = runTextInput(io, { validate });
    // Type valid session code directly
    sendKeys(["a", "B", "3", "-", "x", "Y", "9", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.value).toBe("aB3-xY9");
  });

  it("backspace removes last character", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runTextInput(io);
    sendKeys(["h", "e", "l", "p", "\x7f", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.value).toBe("hel");
  });

  it("backspace via \\x08 also removes last character", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runTextInput(io);
    sendKeys(["a", "b", "\x08", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.value).toBe("a");
  });

  it("Esc cancels and returns cancelled: true", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runTextInput(io);
    sendKeys(["h", "i", "\x1B"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(true);
    expect(result.value).toBe("");
  });

  it("Ctrl+C cancels", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runTextInput(io);
    sendKeys(["\x03"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(true);
  });

  it("empty Enter with validate shows error", async () => {
    const { io, sendKeys, getOutput } = createMockIO();
    const validate = (v: string) => v.length > 0 ? null : "Cannot be empty";

    const resultPromise = runTextInput(io, { validate });
    // Empty Enter shows error, then type something and confirm
    sendKeys(["\r", "x", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.value).toBe("x");
    expect(getOutput()).toContain("Cannot be empty");
  });

  it("renders title and hint", async () => {
    const { io, sendKeys, getOutput } = createMockIO();

    const resultPromise = runTextInput(io, {
      title: "Ninthwave \u00b7 Join session",
      hint: "Format: XXXX-XXXX-XXXX-XXXX (e.g. K2F9-AB3X-7YPL-QM4N)",
    });
    sendKeys(["\x1B"]);

    await resultPromise;
    const output = getOutput();
    expect(output).toContain("Join session");
    expect(output).toContain("Format: XXXX-XXXX-XXXX-XXXX");
  });

  it("accepts without validate function", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runTextInput(io);
    sendKeys(["o", "k", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.value).toBe("ok");
  });

  it("ignores non-printable characters (escape sequences)", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runTextInput(io);
    // Arrow key sequences should be ignored, printable chars added
    sendKeys(["a", "\x1B[A", "b", "\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
    expect(result.value).toBe("ab");
  });
});

// ── Selection screen: startup defaults ──────────────────────────────

describe("runSelectionScreen -- startup defaults", () => {
  it("returns persisted defaults when confirmed without changes", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 7, {
      defaultSettings: {
        mergeStrategy: "auto",
        reviewMode: "on",
        collaborationMode: "share",
      },
    });
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.mergeStrategy).toBe("auto");
    expect(result!.reviewMode).toBe("on");
    expect(result!.connectionAction).toEqual({ type: "connect" });
    expect(result!.sessionLimit).toBe(7);
  });

  it("returns selected settings values from the startup settings screen", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(
      ["\r"],
      [
        "\x1B[C", // reviews off -> on (default is "on" but on the "off" → "on" cycle)
        "\x1B[B",
        "\x1B[C", // collaboration local -> share
        "\r",
      ],
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.reviewMode).toBe("off");
    expect(result!.connectionAction).toEqual({ type: "connect" });
    expect(result!.sessionLimit).toBe(4);
  });

  it("returns join connectionAction when join is selected", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(
      ["\r"],
      [
        "\x1B[B", // → Collaboration row
        "\x1B[C", // local -> share
        "\x1B[C", // share -> join
        "\r",
      ],
      [
        "k", "2", "f", "9", "a", "b", "3", "x",
        "7", "y", "p", "l", "q", "m", "4", "n", "\r",
      ],
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.connectionAction).toEqual({ type: "join", code: "K2F9-AB3X-7YPL-QM4N" });
  });

  it("falls back to local when join code entry is cancelled", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(
      ["\r"],
      [
        "\x1B[B", // → Collaboration row
        "\x1B[C", // local -> share
        "\x1B[C", // share -> join
        "\r",
      ],
      ["\x1B"],
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.connectionAction).toBeNull();
  });

  it("re-prompts for a valid join code before returning join", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(
      ["\r"],
      [
        "\x1B[B", // → Collaboration row
        "\x1B[C", // local -> share
        "\x1B[C", // share -> join
        "\r",
      ],
      [
        "b", "a", "d", "\r",
        "\x7f", "\x7f", "\x7f",
        "k", "2", "f", "9", "a", "b", "3", "x",
        "7", "y", "p", "l", "q", "m", "4", "n", "\r",
      ],
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.connectionAction).toEqual({ type: "join", code: "K2F9-AB3X-7YPL-QM4N" });
    expect(getOutput()).toContain("Invalid session code: bad");
  });

  it("falls back to defaultReviewMode when defaultSettings are omitted", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4, { defaultReviewMode: "on" });
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.reviewMode).toBe("on");
  });

  it("passes through defaultSessionLimit as the initial sessionLimit", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 7);
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.sessionLimit).toBe(7);
  });

  it("uses confirmation-only re-entry flow when showConnectionStep is false", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4, { showConnectionStep: false });
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.connectionAction).toBeNull();
  });
});

// ── Selection screen: startup settings display ───────────────────────

describe("runSelectionScreen -- startup settings display", () => {
  it("settings screen shows 'All (dynamic)' when allSelected", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [
      makeWorkItem("A-1", "First task"),
      makeWorkItem("B-2", "Second task"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4);
    // All items start pre-checked (__ALL__ included) → allSelected = true
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.allSelected).toBe(true);
    expect(getOutput()).toContain("All");
    expect(getOutput()).toContain("dynamic");
  });

  it("settings screen shows individual item list when not allSelected", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [
      makeWorkItem("A-1", "First task"),
      makeWorkItem("B-2", "Second task"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4);
    // Explicitly uncheck __ALL__ (unchecks all), then re-check A-1
    sendKeyBatches(
      [" ", "\x1B[B", " ", "\r"],  // uncheck __ALL__, re-check A-1
      ["\r"],   // confirm settings
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.allSelected).toBe(false);
    expect(getOutput()).toContain("A-1");
  });

  it("settings screen shows AI reviews default chip", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(getOutput()).toContain("[on]");
  });

  it("settings screen shows collaboration defaults", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(["\r"], ["\x1B[B", "\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(getOutput()).toContain("[local]");
    expect(getOutput()).toContain("Local by default, no connection");
  });

  it("renders review chips with reserved bracket slots", async () => {
    const { io, sendKeys, getOutput } = createMockIO();

    const resultPromise = runStartupSettingsScreen(io, {
      summaryLines: ["Items: A-1"],
      defaultSessionLimit: 4,
    });

    const reviewLine = getPlainFrameLine(getOutput(), "> Reviews");

    expect(reviewLine).toContain(" off ");
    expect(reviewLine).toContain("[on]");

    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
  });

  it("keeps review option columns fixed when moving horizontally", async () => {
    const { io, sendKeys, getOutput } = createMockIO();

    const resultPromise = runStartupSettingsScreen(io, {
      summaryLines: ["Items: A-1"],
      defaultSessionLimit: 4,
    });

    const beforeMove = getPlainFrameLine(getOutput(), "> Reviews");
    const beforeStarts = ["on", "off"].map((label) => getStartupChipStart(beforeMove, label));

    sendKeys(["\x1B[C"]);

    const afterMove = getPlainFrameLine(getOutput(), "> Reviews");
    const afterStarts = ["on", "off"].map((label) => getStartupChipStart(afterMove, label));

    expect(beforeMove).toContain("[on]");
    expect(afterMove).toContain("[off]");
    expect(beforeStarts).toEqual(afterStarts);

    sendKeys(["\r"]);

    const result = await resultPromise;
    expect(result.cancelled).toBe(false);
  });

  it("settings screen title includes 'Start orchestration'", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(getOutput()).toContain("Start orchestration");
  });
});

// ── AI tool step ────────────────────────────────────────────────────

/** Minimal AiToolProfile stubs for testing. */
function makeToolProfile(id: string, displayName: string, targetDir: string): AiToolProfile {
  return {
    id: id as any,
    displayName,
    command: id,
    description: `${displayName} desc`,
    installCmd: `install ${id}`,
    targetDir,
    suffix: ".md",
    projectIndicators: [],
    processNames: [],
    buildLaunchCmd: () => ({ cmd: "", initialPrompt: "" }),
    buildHeadlessCmd: () => ({ cmd: "", initialPrompt: "" }),
  };
}

const TOOL_CLAUDE = makeToolProfile("claude", "Claude Code", ".claude/agents");
const TOOL_OPENCODE = makeToolProfile("opencode", "OpenCode", ".opencode/agents");

describe("runSelectionScreen -- AI tool step", () => {
  it("preserves the tool step when the queue is empty", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();

    const resultPromise = runSelectionScreen(io, [], 4, {
      installedTools: [TOOL_CLAUDE, TOOL_OPENCODE],
    });

    sendKeyBatches(
      ["\r"],
      ["\r"],
      ["\r"],
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.futureOnly).toBe(true);
    expect(result!.aiTool).toBe("claude");
    expect(getOutput()).toContain("Future tasks");
    expect(getOutput()).toContain("AI coding tool");
  });

  it("shows tool step when 2+ tools provided, result includes aiTool", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4, {
      installedTools: [TOOL_CLAUDE, TOOL_OPENCODE],
    });

    sendKeyBatches(
      ["\r"],        // Step 1: items
      ["\r"],        // Step 2: tool (accept default = both checked)
      ["\r"],        // Step 3: confirm
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.aiTool).toBe("claude");
    expect(getOutput()).toContain("AI coding tool");
    expect(getOutput()).toContain("Claude Code");
    expect(getOutput()).toContain("OpenCode");
  });

  it("auto-selects single installed tool without showing screen", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4, {
      installedTools: [TOOL_CLAUDE],
    });

    // Only 2 batches: items, confirm (no tool screen for single tool)
    sendKeyBatches(
      ["\r"], ["\r"],
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.aiTool).toBe("claude");
    expect(getOutput()).not.toContain("AI coding tool");
  });

  it("aiTool is undefined when installedTools not provided", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);

    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.aiTool).toBeUndefined();
  });

  it("pre-selects savedToolIds", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4, {
      installedTools: [TOOL_CLAUDE, TOOL_OPENCODE],
      savedToolIds: ["opencode"],
    });

    sendKeyBatches(
      ["\r"],        // items
      ["\r"],        // tool (accept default = opencode since savedToolIds)
      ["\r"],        // confirm
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.aiTool).toBe("opencode");
  });

  it("returns null when cancelled at tool step", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4, {
      installedTools: [TOOL_CLAUDE, TOOL_OPENCODE],
    });

    sendKeyBatches(
      ["\r"],        // items
      ["\x1B"],      // Escape at tool step
    );

    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it("shows tool description referencing agent files directory", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4, {
      installedTools: [TOOL_CLAUDE, TOOL_OPENCODE],
    });

    sendKeyBatches(
      ["\r"], ["\r"], ["\r"],
    );

    await resultPromise;
    expect(getOutput()).toContain(".claude/agents/");
    expect(getOutput()).toContain(".opencode/agents/");
  });

  it("confirmation summary shows selected tool name", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4, {
      installedTools: [TOOL_CLAUDE, TOOL_OPENCODE],
    });

    sendKeyBatches(
      ["\r"], ["\r"], ["\r"],
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(getOutput()).toContain("AI tool:");
    expect(getOutput()).toContain("Claude Code");
  });
});

// ── Integration: TUI flow via interactive.ts ────────────────────────

describe("runTuiSelectionFlow (via interactive.ts)", () => {
  // Import the TUI flow function from interactive.ts
  // We test it through runInteractiveFlow with widgetIO injection

  it("runInteractiveFlow uses TUI widgets when widgetIO is provided", async () => {
    // Import dynamically to avoid circular issues
    const { runInteractiveFlow } = await import("../core/interactive.ts");

    const { io, sendKeyBatches } = createMockIO();
    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
    ];

    const resultPromise = runInteractiveFlow(items, 4, { widgetIO: io });

    // Items followed by startup settings confirmation.
    sendKeyBatches(
      ["\r"], // Confirm all items (pre-checked)
      ["\r"], // Confirm summary
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.itemIds).toContain("A-1");
    expect(result!.itemIds).toContain("B-2");
    expect(result!.itemIds).not.toContain("__ALL__");
    expect(result!.allSelected).toBe(true);
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.sessionLimit).toBe(4);
    expect(result!.reviewMode).toBe("on");
    expect(result!.connectionAction).toBeNull();
  });

  it("runInteractiveFlow falls back to readline when useLegacyPrompts is true", async () => {
    const { runInteractiveFlow } = await import("../core/interactive.ts");

    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
    ];

    let promptIdx = 0;
    const answers = ["1 2", "", ""];
    const mockPrompt = async (_q: string) => answers[promptIdx++] ?? "";

    const result = await runInteractiveFlow(items, 3, {
      useLegacyPrompts: true,
      prompt: mockPrompt,
      isTTY: true,
    });

    expect(result).not.toBeNull();
    expect(result!.itemIds).toEqual(["A-1", "B-2"]);
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.sessionLimit).toBe(3);
    expect(result!.reviewMode).toBe("on");
    expect(result!.connectionAction).toBeNull();
  });
});
