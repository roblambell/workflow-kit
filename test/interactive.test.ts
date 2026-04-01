// Tests for core/interactive.ts -- Interactive CLI prompts for orchestrate.

import { describe, it, expect } from "vitest";
import {
  shouldEnterInteractive,
  parseSelection,
  promptItems,
  promptMergeStrategy,
  promptWipLimit,
  promptReviewMode,
  promptConnectionMode,
  confirmSummary,
  runInteractiveFlow,
  displayItemsSummary,
  type PromptFn,
  type InteractiveResult,
} from "../core/interactive.ts";
import type { WidgetIO } from "../core/tui-widgets.ts";
import type { WorkItem } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

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

/** Create a prompt function that returns answers sequentially. */
function makePrompt(answers: string[]): PromptFn {
  let i = 0;
  return async (_question: string): Promise<string> => {
    if (i >= answers.length) return "";
    return answers[i++]!;
  };
}

function createMockIO(): {
  io: WidgetIO;
  sendKeys: (keys: string[]) => void;
  sendKeyBatches: (...batches: string[][]) => void;
} {
  let handler: ((key: string) => void) | null = null;

  const io: WidgetIO = {
    write: () => {},
    onKey: (next) => { handler = next; },
    offKey: () => { handler = null; },
    getRows: () => 40,
    getCols: () => 80,
  };

  const sendKeys = (keys: string[]) => {
    for (const key of keys) handler?.(key);
  };

  return {
    io,
    sendKeys,
    sendKeyBatches: (...batches: string[][]) => {
      if (batches.length === 0) return;
      sendKeys(batches[0]!);
      let chain = Promise.resolve();
      for (let i = 1; i < batches.length; i++) {
        const batch = batches[i]!;
        chain = chain.then(() => new Promise<void>((resolve) => {
          queueMicrotask(() => {
            sendKeys(batch);
            resolve();
          });
        }));
      }
    },
  };
}

// ── shouldEnterInteractive ───────────────────────────────────────────

describe("shouldEnterInteractive", () => {
  it("returns true when no items and TTY", () => {
    expect(shouldEnterInteractive(false, { isTTY: true })).toBe(true);
  });

  it("returns false when items are provided", () => {
    expect(shouldEnterInteractive(true, { isTTY: true })).toBe(false);
  });

  it("returns false when not a TTY (piped input)", () => {
    expect(shouldEnterInteractive(false, { isTTY: false })).toBe(false);
  });

  it("returns false when items provided and not a TTY", () => {
    expect(shouldEnterInteractive(true, { isTTY: false })).toBe(false);
  });
});

// ── parseSelection ───────────────────────────────────────────────────

describe("parseSelection", () => {
  it("parses space-separated numbers", () => {
    expect(parseSelection("1 3 5", 10)).toEqual([0, 2, 4]);
  });

  it("parses comma-separated numbers", () => {
    expect(parseSelection("1,3,5", 10)).toEqual([0, 2, 4]);
  });

  it("parses ranges", () => {
    expect(parseSelection("1-4", 10)).toEqual([0, 1, 2, 3]);
  });

  it("parses mixed ranges and numbers", () => {
    expect(parseSelection("1-3,5,7-8", 10)).toEqual([0, 1, 2, 4, 6, 7]);
  });

  it("deduplicates overlapping ranges", () => {
    expect(parseSelection("1-3,2-4", 10)).toEqual([0, 1, 2, 3]);
  });

  it("ignores out-of-range values", () => {
    expect(parseSelection("0 5 11", 5)).toEqual([4]);
  });

  it("ignores non-numeric input", () => {
    expect(parseSelection("abc xyz", 5)).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(parseSelection("", 5)).toEqual([]);
  });

  it("handles reversed ranges", () => {
    expect(parseSelection("4-1", 10)).toEqual([0, 1, 2, 3]);
  });
});

// ── promptItems ──────────────────────────────────────────────────────

describe("promptItems", () => {
  it("returns empty ids for empty item list", async () => {
    const prompt = makePrompt([]);
    const result = await promptItems([], prompt);
    expect(result.ids).toEqual([]);
    expect(result.allSelected).toBe(false);
  });

  it("returns selected IDs for valid selection", async () => {
    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
      makeWorkItem("C-3", "Third task", "low"),
    ];
    const prompt = makePrompt(["1 3"]);
    const result = await promptItems(items, prompt);
    // Sorted by priority: A-1(high), B-2(medium), C-3(low)
    expect(result.ids).toEqual(["A-1", "C-3"]);
    expect(result.allSelected).toBe(false);
  });

  it("returns all IDs and allSelected: true when 'all' is entered", async () => {
    const items = [
      makeWorkItem("A-1", "First"),
      makeWorkItem("B-2", "Second"),
    ];
    const prompt = makePrompt(["all"]);
    const result = await promptItems(items, prompt);
    expect(result.ids).toHaveLength(2);
    expect(result.ids).toContain("A-1");
    expect(result.ids).toContain("B-2");
    expect(result.allSelected).toBe(true);
  });

  it("returns empty when user quits", async () => {
    const items = [makeWorkItem("A-1", "First")];
    const prompt = makePrompt(["q"]);
    const result = await promptItems(items, prompt);
    expect(result.ids).toEqual([]);
  });

  it("re-prompts on invalid input then accepts valid", async () => {
    const items = [
      makeWorkItem("A-1", "First"),
      makeWorkItem("B-2", "Second"),
    ];
    // First invalid, then valid
    const prompt = makePrompt(["abc", "1"]);
    const result = await promptItems(items, prompt);
    expect(result.ids).toEqual(["A-1"]);
  });

  it("sorts items by priority", async () => {
    const items = [
      makeWorkItem("L-1", "Low task", "low"),
      makeWorkItem("C-1", "Critical task", "critical"),
      makeWorkItem("M-1", "Medium task", "medium"),
    ];
    // Select all to verify sort order
    const prompt = makePrompt(["all"]);
    const result = await promptItems(items, prompt);
    expect(result.ids).toEqual(["C-1", "M-1", "L-1"]);
  });

  it("sets allSelected: true when every item is individually selected", async () => {
    const items = [
      makeWorkItem("A-1", "First"),
      makeWorkItem("B-2", "Second"),
    ];
    // Select "1 2" = every item
    const prompt = makePrompt(["1 2"]);
    const result = await promptItems(items, prompt);
    expect(result.ids).toEqual(["A-1", "B-2"]);
    expect(result.allSelected).toBe(true);
  });
});

// ── promptMergeStrategy ──────────────────────────────────────────────

describe("promptMergeStrategy", () => {
  it("returns auto for selection 1", async () => {
    const result = await promptMergeStrategy(makePrompt(["1"]));
    expect(result).toBe("auto");
  });

  it("returns manual for selection 2", async () => {
    const result = await promptMergeStrategy(makePrompt(["2"]));
    expect(result).toBe("manual");
  });

  it("defaults to auto on empty input", async () => {
    const result = await promptMergeStrategy(makePrompt([""]));
    expect(result).toBe("auto");
  });

  it("accepts strategy name directly", async () => {
    const result = await promptMergeStrategy(makePrompt(["manual"]));
    expect(result).toBe("manual");
  });

  it("re-prompts on invalid input", async () => {
    const result = await promptMergeStrategy(makePrompt(["99", "1"]));
    expect(result).toBe("auto");
  });
});

// ── promptWipLimit ───────────────────────────────────────────────────

describe("promptWipLimit", () => {
  it("returns entered value within range", async () => {
    const result = await promptWipLimit(3, makePrompt(["5"]));
    expect(result).toBe(5);
  });

  it("returns default on empty input", async () => {
    const result = await promptWipLimit(3, makePrompt([""]));
    expect(result).toBe(3);
  });

  it("rejects 0 and re-prompts", async () => {
    const result = await promptWipLimit(3, makePrompt(["0", "2"]));
    expect(result).toBe(2);
  });

  it("rejects negative and re-prompts", async () => {
    const result = await promptWipLimit(3, makePrompt(["-1", "1"]));
    expect(result).toBe(1);
  });

  it("rejects > 10 and re-prompts", async () => {
    const result = await promptWipLimit(3, makePrompt(["11", "10"]));
    expect(result).toBe(10);
  });

  it("accepts boundary value 1", async () => {
    const result = await promptWipLimit(3, makePrompt(["1"]));
    expect(result).toBe(1);
  });

  it("accepts boundary value 10", async () => {
    const result = await promptWipLimit(3, makePrompt(["10"]));
    expect(result).toBe(10);
  });
});

// ── confirmSummary ───────────────────────────────────────────────────

describe("confirmSummary", () => {
  const items = [makeWorkItem("A-1", "First task")];
  const result: InteractiveResult = {
    itemIds: ["A-1"],
    mergeStrategy: "auto",
    wipLimit: 3,
    allSelected: false,
    reviewMode: "mine",
    connectionAction: null,
  };

  it("returns true on Y (default)", async () => {
    const confirmed = await confirmSummary(result, items, makePrompt([""]));
    expect(confirmed).toBe(true);
  });

  it("returns false on n", async () => {
    const confirmed = await confirmSummary(result, items, makePrompt(["n"]));
    expect(confirmed).toBe(false);
  });

  it("returns false on no", async () => {
    const confirmed = await confirmSummary(result, items, makePrompt(["no"]));
    expect(confirmed).toBe(false);
  });

  it("displays reviewMode and connection info", async () => {
    const connResult: InteractiveResult = {
      ...result,
      reviewMode: "all",
      connectionAction: { type: "join", code: "K2F9-AB3X-7YPL-QM4N" },
    };
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await confirmSummary(connResult, items, makePrompt([""]));
    } finally {
      console.log = origLog;
    }
    const output = logs.join("\n");
    expect(output).toContain("all");
    expect(output).toContain("Join session (K2F9-AB3X-7YPL-QM4N)");
  });

  it("displays Local when connectionAction is null", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await confirmSummary(result, items, makePrompt([""]));
    } finally {
      console.log = origLog;
    }
    const output = logs.join("\n");
    expect(output).toContain("Local by default");
  });
});

// ── runInteractiveFlow ───────────────────────────────────────────────

describe("runInteractiveFlow", () => {
  const items = [
    makeWorkItem("A-1", "First task", "high"),
    makeWorkItem("B-2", "Second task", "medium"),
  ];

  it("returns complete result with local-first defaults for valid legacy flow", async () => {
    // Local-first: only prompts for items + confirmation (no merge/wip/review/connection)
    const prompt = makePrompt(["1 2", ""]);
    const result = await runInteractiveFlow(items, 3, { prompt, useLegacyPrompts: true });

    expect(result).not.toBeNull();
    expect(result!.itemIds).toEqual(["A-1", "B-2"]);
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.wipLimit).toBe(3);
    expect(result!.reviewMode).toBe("off");
    expect(result!.connectionAction).toBeNull();
    expect(result!.allSelected).toBe(true);
  });

  it("returns null when user quits at item selection", async () => {
    const prompt = makePrompt(["q"]);
    const result = await runInteractiveFlow(items, 3, { prompt, useLegacyPrompts: true });
    expect(result).toBeNull();
  });

  it("returns null when user cancels at confirmation", async () => {
    // Local-first: items + cancel at confirmation
    const prompt = makePrompt(["1", "n"]);
    const result = await runInteractiveFlow(items, 3, { prompt, useLegacyPrompts: true });
    expect(result).toBeNull();
  });

  it("returns null for empty item list", async () => {
    const prompt = makePrompt([]);
    const result = await runInteractiveFlow([], 3, { prompt, useLegacyPrompts: true });
    expect(result).toBeNull();
  });

  it("uses precomputed WIP limit as default without prompting", async () => {
    // Items "all" + confirm
    const prompt = makePrompt(["all", ""]);
    const result = await runInteractiveFlow(items, 7, { prompt, useLegacyPrompts: true });

    expect(result).not.toBeNull();
    expect(result!.wipLimit).toBe(7);
  });

  it("always returns manual merge strategy", async () => {
    const prompt = makePrompt(["1", ""]);
    const result = await runInteractiveFlow(items, 3, { prompt, useLegacyPrompts: true });

    expect(result).not.toBeNull();
    expect(result!.mergeStrategy).toBe("manual");
  });

  it("always returns reviews off", async () => {
    const prompt = makePrompt(["1", ""]);
    const result = await runInteractiveFlow(items, 3, {
      prompt,
      useLegacyPrompts: true,
      defaultReviewMode: "all",
    });

    expect(result).not.toBeNull();
    expect(result!.reviewMode).toBe("off");
  });

  it("always returns null connectionAction (Local)", async () => {
    const prompt = makePrompt(["1", ""]);
    const result = await runInteractiveFlow(items, 3, { prompt, useLegacyPrompts: true });

    expect(result).not.toBeNull();
    expect(result!.connectionAction).toBeNull();
  });

  it("returns an explicit future-only result in the empty-queue TUI path", async () => {
    const { io, sendKeyBatches } = createMockIO();

    const resultPromise = runInteractiveFlow([], 3, { widgetIO: io });
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.itemIds).toEqual([]);
    expect(result!.allSelected).toBe(false);
    expect(result!.futureOnly).toBe(true);
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.wipLimit).toBe(3);
  });

  it("uses persisted startup defaults in the TUI path", async () => {
    const { io, sendKeyBatches } = createMockIO();

    const resultPromise = runInteractiveFlow(items, 6, {
      widgetIO: io,
      defaultSettings: {
        mergeStrategy: "auto",
        reviewMode: "mine",
        collaborationMode: "share",
      },
    });
    sendKeyBatches(["\r"], ["\r"]);

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result!.mergeStrategy).toBe("auto");
    expect(result!.reviewMode).toBe("mine");
    expect(result!.connectionAction).toEqual({ type: "connect" });
    expect(result!.wipLimit).toBe(6);
  });

  it("returns null when the empty-queue TUI path is cancelled", async () => {
    const { io, sendKeys } = createMockIO();

    const resultPromise = runInteractiveFlow([], 3, { widgetIO: io });
    sendKeys(["\x1B"]);

    const result = await resultPromise;
    expect(result).toBeNull();
  });
});

// ── displayItemsSummary ─────────────────────────────────────────────

describe("displayItemsSummary", () => {
  it("output contains item IDs, titles, and priority labels", () => {
    const items = [
      makeWorkItem("A-1", "First task", "high"),
      makeWorkItem("B-2", "Second task", "medium"),
      makeWorkItem("C-3", "Third task", "low"),
    ];

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      displayItemsSummary(items);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("A-1");
    expect(output).toContain("First task");
    expect(output).toContain("[high]");
    expect(output).toContain("B-2");
    expect(output).toContain("Second task");
    expect(output).toContain("[medium]");
    expect(output).toContain("C-3");
    expect(output).toContain("Third task");
    expect(output).toContain("[low]");
  });

  it("renders items sorted by priority", () => {
    const items = [
      makeWorkItem("L-1", "Low task", "low"),
      makeWorkItem("C-1", "Critical task", "critical"),
      makeWorkItem("M-1", "Medium task", "medium"),
    ];

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      displayItemsSummary(items);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    // Critical should appear before medium, medium before low
    const critIdx = output.indexOf("C-1");
    const medIdx = output.indexOf("M-1");
    const lowIdx = output.indexOf("L-1");
    expect(critIdx).toBeLessThan(medIdx);
    expect(medIdx).toBeLessThan(lowIdx);
  });

  it("shows dependency info for items with deps", () => {
    const items = [
      makeWorkItem("A-1", "First task", "high", ["X-1", "Y-2"]),
    ];

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      displayItemsSummary(items);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("deps: X-1, Y-2");
  });

  it("handles empty item list", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      displayItemsSummary([]);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("No work items found");
  });
});

// ── promptReviewMode ────────────────────────────────────────────────

describe("promptReviewMode", () => {
  it('returns "all" on input "1"', async () => {
    const result = await promptReviewMode("mine", makePrompt(["1"]));
    expect(result).toBe("all");
  });

  it('returns default on empty input', async () => {
    const result = await promptReviewMode("mine", makePrompt([""]));
    expect(result).toBe("mine");
  });

  it('returns "all" as default when configured', async () => {
    const result = await promptReviewMode("all", makePrompt([""]));
    expect(result).toBe("all");
  });

  it('returns "mine" on input "2"', async () => {
    const result = await promptReviewMode("mine", makePrompt(["2"]));
    expect(result).toBe("mine");
  });

  it('returns "off" on input "3"', async () => {
    const result = await promptReviewMode("mine", makePrompt(["3"]));
    expect(result).toBe("off");
  });

  it("accepts name directly", async () => {
    const result = await promptReviewMode("mine", makePrompt(["all"]));
    expect(result).toBe("all");
  });

  it("retries on invalid input", async () => {
    const result = await promptReviewMode("mine", makePrompt(["99", "off"]));
    expect(result).toBe("off");
  });
});

// ── promptConnectionMode ───────────────────────────────────────────

describe("promptConnectionMode", () => {
  it("returns connect for default (empty input)", async () => {
    const result = await promptConnectionMode(makePrompt([""]));
    expect(result).toEqual({ type: "connect" });
  });

  it("returns connect on input 1", async () => {
    const result = await promptConnectionMode(makePrompt(["1"]));
    expect(result).toEqual({ type: "connect" });
  });

  it('returns connect on text "share"', async () => {
    const result = await promptConnectionMode(makePrompt(["share"]));
    expect(result).toEqual({ type: "connect" });
  });

  it('returns null (local) on input "3"', async () => {
    const result = await promptConnectionMode(makePrompt(["3"]));
    expect(result).toBeNull();
  });

  it('returns null (local) on text "local"', async () => {
    const result = await promptConnectionMode(makePrompt(["local"]));
    expect(result).toBeNull();
  });

  it('returns join with code on input "2" then valid code', async () => {
    const result = await promptConnectionMode(makePrompt(["2", "K2F9-AB3X-7YPL-QM4N"]));
    expect(result).toEqual({ type: "join", code: "K2F9-AB3X-7YPL-QM4N" });
  });

  it("returns null when user cancels join code prompt", async () => {
    const result = await promptConnectionMode(makePrompt(["join", "q"]));
    expect(result).toBeNull();
  });

  it("retries on invalid session code then accepts valid", async () => {
    const result = await promptConnectionMode(makePrompt(["2", "invalid", "K2F9-AB3X-7YPL-QM4N"]));
    expect(result).toEqual({ type: "join", code: "K2F9-AB3X-7YPL-QM4N" });
  });

  it("retries on invalid choice then accepts valid", async () => {
    const result = await promptConnectionMode(makePrompt(["99", "local"]));
    expect(result).toBeNull();
  });
});
