// Tests for core/tui-widgets.ts -- In-TUI selection widgets.

import { describe, it, expect, vi } from "vitest";
import {
  runCheckboxList,
  runSingleSelect,
  runNumberPicker,
  runConfirm,
  runTextInput,
  runSelectionScreen,
  sortWorkItems,
  toCheckboxItems,
  type WidgetIO,
  type CheckboxItem,
  type SingleSelectOption,
  type TextInputResult,
} from "../core/tui-widgets.ts";
import type { WorkItem } from "../core/types.ts";
import type { MergeStrategy } from "../core/orchestrator.ts";
import type { AiToolProfile } from "../core/ai-tools.ts";

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
    repoAlias: "",
    rawText: `## ${id}\n${title}`,
    filePaths: [],
    testPlan: "",
    bootstrap: false,
  };
}

function makeCheckboxItems(count: number): CheckboxItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `T-${i + 1}`,
    label: `Item ${i + 1}`,
    checked: false,
  }));
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

  it("cursor clamps at boundaries", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeCheckboxItems(2);

    const resultPromise = runCheckboxList(io, items);
    // Try to go above first item, toggle (should toggle T-1)
    sendKeys(["\x1B[A", "\x1B[A", " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toEqual(["T-1"]);
  });

  it("cursor clamps at bottom boundary", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeCheckboxItems(2);

    const resultPromise = runCheckboxList(io, items);
    // Try to go below last item, toggle (should toggle T-2)
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
    expect(checkboxItems[1]!.detail).toContain("deps: A-1");
  });

  it("handles items without dependencies", () => {
    const items = [makeWorkItem("A-1", "Solo task", "low")];
    const checkboxItems = toCheckboxItems(items);
    expect(checkboxItems[0]!.detail).not.toContain("deps:");
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
      ["\r"],        // Step 2: Confirm summary
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.itemIds).toContain("A-1");
    expect(result!.itemIds).toContain("B-2");
    expect(result!.itemIds).not.toContain("__ALL__");
    expect(result!.allSelected).toBe(true);
    expect(result!.futureOnly).toBe(false);
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.wipLimit).toBe(4);
    expect(result!.reviewMode).toBe("off");
    expect(result!.connectionAction).toBeNull();
    expect(result!.cancelled).toBe(false);
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
      ["n"],        // Cancel confirmation
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
      ["\r"],        // Confirm summary
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

  it("returns local-first defaults for merge, review, connection, and WIP", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "First")];

    const resultPromise = runSelectionScreen(io, items, 5);
    sendKeyBatches(
      ["\r"],  // Confirm all items
      ["\r"],  // Confirm summary
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.wipLimit).toBe(5);
    expect(result!.reviewMode).toBe("off");
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
      ["\r"],                       // Confirm summary
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

// ── Selection screen: local-first defaults ─────────────────────────

describe("runSelectionScreen -- local-first defaults", () => {
  it("always returns reviewMode 'off' without prompting", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(
      ["\r"],  // items
      ["\r"],  // confirm
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.reviewMode).toBe("off");
  });

  it("ignores defaultReviewMode option (no review prompt)", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4, { defaultReviewMode: "all" });
    sendKeyBatches(
      ["\r"],  // items
      ["\r"],  // confirm
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.reviewMode).toBe("off");
  });

  it("always returns manual merge strategy", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.mergeStrategy).toBe("manual");
  });

  it("always returns null connectionAction (Local)", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.connectionAction).toBeNull();
  });

  it("passes through defaultWipLimit as wipLimit", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 7);
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.wipLimit).toBe(7);
  });

  it("showConnectionStep option is ignored (always local)", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    // showConnectionStep: true should not add a connection step
    const resultPromise = runSelectionScreen(io, items, 4, { showConnectionStep: true });
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.connectionAction).toBeNull();
  });
});

// ── Selection screen: confirmation shows local-first defaults ───────

describe("runSelectionScreen -- confirmation display", () => {
  it("confirmation shows 'All (dynamic)' when allSelected", async () => {
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

  it("confirmation shows individual item list when not allSelected", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [
      makeWorkItem("A-1", "First task"),
      makeWorkItem("B-2", "Second task"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4);
    // Explicitly uncheck __ALL__ (unchecks all), then re-check A-1
    sendKeyBatches(
      [" ", "\x1B[B", " ", "\r"],  // uncheck __ALL__, re-check A-1
      ["\r"],   // confirm
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.allSelected).toBe(false);
    expect(getOutput()).toContain("A-1");
  });

  it("confirmation shows manual merge strategy", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(getOutput()).toContain("manual");
  });

  it("confirmation shows AI reviews Off", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(getOutput()).toContain("Off");
  });

  it("confirmation shows collaboration: Local by default", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO();
    const items = [makeWorkItem("A-1", "Task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(getOutput()).toContain("Local by default");
  });

  it("confirmation title is 'Ninthwave · Start orchestration?'", async () => {
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

    // Local-first: only items and confirm (no strategy/WIP/review/connection)
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
    expect(result!.wipLimit).toBe(4);
    expect(result!.reviewMode).toBe("off");
    expect(result!.connectionAction).toBeNull();
  });

  it("runInteractiveFlow falls back to readline when useLegacyPrompts is true", async () => {
    const { runInteractiveFlow } = await import("../core/interactive.ts");

    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
    ];

    let promptIdx = 0;
    // Local-first: only items + confirmation (no merge/wip/review/connection prompts)
    const answers = ["1 2", ""];
    const mockPrompt = async (_q: string) => answers[promptIdx++] ?? "";

    const result = await runInteractiveFlow(items, 3, {
      useLegacyPrompts: true,
      prompt: mockPrompt,
      isTTY: true,
    });

    expect(result).not.toBeNull();
    expect(result!.itemIds).toEqual(["A-1", "B-2"]);
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.wipLimit).toBe(3);
    expect(result!.reviewMode).toBe("off");
    expect(result!.connectionAction).toBeNull();
  });
});
