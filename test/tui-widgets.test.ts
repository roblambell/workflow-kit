// Tests for core/tui-widgets.ts -- In-TUI selection widgets.

import { describe, it, expect, vi } from "vitest";
import {
  runCheckboxList,
  runSingleSelect,
  runNumberPicker,
  runConfirm,
  runSelectionScreen,
  sortWorkItems,
  toCheckboxItems,
  type WidgetIO,
  type CheckboxItem,
  type SingleSelectOption,
} from "../core/tui-widgets.ts";
import type { WorkItem } from "../core/types.ts";
import type { MergeStrategy } from "../core/orchestrator.ts";

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

  it("unchecking any item auto-unchecks __ALL__", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeLinkedItems(2); // __ALL__, T-1, T-2 -- all checked

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // Down to T-2 (index 2), space to uncheck. __ALL__ auto-unchecks.
    sendKeys(["\x1B[B", "\x1B[B", " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).not.toContain("T-2");
    expect(result.selectedIds).not.toContain("__ALL__");
    expect(result.allSelected).toBe(false);
  });

  it("re-checking the last unchecked item re-checks __ALL__", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeLinkedItems(2); // __ALL__, T-1, T-2 -- all checked

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // Down to T-2 (index 2), space to uncheck (auto-unchecks __ALL__).
    // Space again to re-check T-2 (__ALL__ re-checks since all regular items now checked).
    // Confirm.
    sendKeys(["\x1B[B", "\x1B[B", " ", " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).toContain("T-2");
    expect(result.selectedIds).toContain("__ALL__");
    expect(result.allSelected).toBe(true);
  });

  it("'a' key interacts correctly with __ALL__", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeLinkedItems(2); // all checked

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // "a" unchecks all (allChecked=true), "a" re-checks all, confirm
    sendKeys(["a", "a", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("__ALL__");
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).toContain("T-2");
    expect(result.allSelected).toBe(true);
  });

  it("'a' key uncheck when all checked leaves __ALL__ unchecked", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeLinkedItems(2); // all checked

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // "a" unchecks all, then select T-1 to avoid empty error
    sendKeys(["a", "\x1B[B", " ", "\r"]);

    const result = await resultPromise;
    expect(result.selectedIds).toContain("T-1");
    expect(result.selectedIds).not.toContain("__ALL__");
    expect(result.allSelected).toBe(false);
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

  it("uncheck single item re-checks __ALL__ when re-checked (single item edge case)", async () => {
    const { io, sendKeys } = createMockIO();
    const items = makeLinkedItems(1); // __ALL__ + T-1, both checked

    const resultPromise = runCheckboxList(io, items, { linkAllId: "__ALL__" });
    // Down to T-1, uncheck (auto-unchecks __ALL__), re-check (auto-re-checks __ALL__)
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
  it("returns null for empty item list", async () => {
    const { io } = createMockIO();
    const result = await runSelectionScreen(io, [], 4);
    expect(result).toBeNull();
  });

  it("completes full flow: select items → strategy → WIP → confirm", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4);

    // All items start checked (including __ALL__ sentinel). Just confirm each step.
    sendKeyBatches(
      ["\r"],        // Step 1: Confirm all items (all pre-checked)
      ["\r"],        // Step 2: Accept default strategy (auto)
      ["\r"],        // Step 3: Accept default WIP (4)
      ["\r"],        // Step 4: Confirm summary
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.itemIds).toContain("A-1");
    expect(result!.itemIds).toContain("B-2");
    expect(result!.itemIds).not.toContain("__ALL__");
    expect(result!.allSelected).toBe(true);
    expect(result!.mergeStrategy).toBe("auto");
    expect(result!.wipLimit).toBe(4);
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

  it("returns null when cancelled at strategy selection", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "First task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(
      ["\r"],       // Confirm all items (pre-checked)
      ["\x1B"],     // Escape at strategy
    );

    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it("returns null when cancelled at WIP limit", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "First task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(
      ["\r"],       // Confirm all items (pre-checked)
      ["\r"],       // Accept strategy
      ["\x1B"],     // Escape at WIP
    );

    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it("returns null when cancelled at confirmation", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "First task")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(
      ["\r"],       // Confirm all items (pre-checked)
      ["\r"],       // Accept strategy
      ["\r"],       // Accept WIP
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
      ["\r"],        // Accept strategy
      ["\r"],        // Accept WIP
      ["\r"],        // Confirm
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

  it("manual strategy + custom WIP limit", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [makeWorkItem("A-1", "First")];

    const resultPromise = runSelectionScreen(io, items, 4);
    sendKeyBatches(
      ["\r"],                                      // Confirm all items (pre-checked)
      ["\x1B[B", "\r"],                           // Select manual strategy
      ["\x1B[A", "\x1B[A", "\x1B[A", "\r"],      // Increase WIP to 7
      ["\r"],                                      // Confirm
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.wipLimit).toBe(7);
  });

  it("renders correctly at 80x25 terminal", async () => {
    const { io, sendKeyBatches, getOutput } = createMockIO({ rows: 25, cols: 80 });
    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4);
    // All items pre-checked; just confirm each step
    sendKeyBatches(["\r"], ["\r"], ["\r"], ["\r"]);

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
    sendKeyBatches(["\r"], ["\r"], ["\r"], ["\r"]);

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
    sendKeyBatches(["\r"], ["\r"], ["\r"], ["\r"]);

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
    sendKeyBatches(["\r"], ["\r"], ["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.allSelected).toBe(true);
  });

  it("allSelected is false when __ALL__ is unchecked at confirmation", async () => {
    const { io, sendKeyBatches } = createMockIO();
    const items = [
      makeWorkItem("A-1", "First task"),
      makeWorkItem("B-2", "Second task"),
    ];

    const resultPromise = runSelectionScreen(io, items, 4);
    // Uncheck B-2 (index 2 in list: __ALL__, A-1, B-2), which auto-unchecks __ALL__
    sendKeyBatches(
      ["\x1B[B", "\x1B[B", " ", "\r"],  // Navigate to B-2, uncheck, confirm
      ["\r"],                             // Accept strategy
      ["\r"],                             // Accept WIP
      ["\r"],                             // Confirm
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.allSelected).toBe(false);
    expect(result!.itemIds).toContain("A-1");
    expect(result!.itemIds).not.toContain("B-2");
    expect(result!.itemIds).not.toContain("__ALL__");
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

    // All items start checked. Just confirm each step.
    sendKeyBatches(
      ["\r"], // Confirm all items (pre-checked)
      ["\r"], // Accept default strategy
      ["\r"], // Accept default WIP
      ["\r"], // Confirm
    );

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.itemIds).toContain("A-1");
    expect(result!.itemIds).toContain("B-2");
    expect(result!.itemIds).not.toContain("__ALL__");
    expect(result!.allSelected).toBe(true);
    expect(result!.mergeStrategy).toBe("auto");
    expect(result!.wipLimit).toBe(4);
    expect(result!.reviewMode).toBe("off");
    expect(result!.crewAction).toBeNull();
  });

  it("runInteractiveFlow falls back to readline when useLegacyPrompts is true", async () => {
    const { runInteractiveFlow } = await import("../core/interactive.ts");

    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
    ];

    let promptIdx = 0;
    const answers = ["1 2", "1", "5", ""];
    const mockPrompt = async (_q: string) => answers[promptIdx++] ?? "";

    const result = await runInteractiveFlow(items, 3, {
      useLegacyPrompts: true,
      prompt: mockPrompt,
      isTTY: true,
    });

    expect(result).not.toBeNull();
    expect(result!.itemIds).toEqual(["A-1", "B-2"]);
    expect(result!.mergeStrategy).toBe("auto");
    expect(result!.wipLimit).toBe(5);
  });
});
