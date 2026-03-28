// Tests for core/interactive.ts — Interactive CLI prompts for orchestrate.

import { describe, it, expect } from "vitest";
import {
  shouldEnterInteractive,
  parseSelection,
  promptItems,
  promptMergeStrategy,
  promptWipLimit,
  confirmSummary,
  runInteractiveFlow,
  type PromptFn,
  type InteractiveResult,
} from "../core/interactive.ts";
import type { WorkItem } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTodo(
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
    filePath: `/tmp/todos/${id}.md`,
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
  it("returns empty array for empty todo list", async () => {
    const prompt = makePrompt([]);
    const result = await promptItems([], prompt);
    expect(result).toEqual([]);
  });

  it("returns selected IDs for valid selection", async () => {
    const todos = [
      makeTodo("A-1", "First task", "high"),
      makeTodo("B-2", "Second task", "medium"),
      makeTodo("C-3", "Third task", "low"),
    ];
    const prompt = makePrompt(["1 3"]);
    const result = await promptItems(todos, prompt);
    // Sorted by priority: A-1(high), B-2(medium), C-3(low)
    expect(result).toEqual(["A-1", "C-3"]);
  });

  it("returns all IDs when 'all' is entered", async () => {
    const todos = [
      makeTodo("A-1", "First"),
      makeTodo("B-2", "Second"),
    ];
    const prompt = makePrompt(["all"]);
    const result = await promptItems(todos, prompt);
    expect(result).toHaveLength(2);
    expect(result).toContain("A-1");
    expect(result).toContain("B-2");
  });

  it("returns empty when user quits", async () => {
    const todos = [makeTodo("A-1", "First")];
    const prompt = makePrompt(["q"]);
    const result = await promptItems(todos, prompt);
    expect(result).toEqual([]);
  });

  it("re-prompts on invalid input then accepts valid", async () => {
    const todos = [
      makeTodo("A-1", "First"),
      makeTodo("B-2", "Second"),
    ];
    // First invalid, then valid
    const prompt = makePrompt(["abc", "1"]);
    const result = await promptItems(todos, prompt);
    expect(result).toEqual(["A-1"]);
  });

  it("sorts items by priority", async () => {
    const todos = [
      makeTodo("L-1", "Low task", "low"),
      makeTodo("C-1", "Critical task", "critical"),
      makeTodo("M-1", "Medium task", "medium"),
    ];
    // Select all to verify sort order
    const prompt = makePrompt(["all"]);
    const result = await promptItems(todos, prompt);
    expect(result).toEqual(["C-1", "M-1", "L-1"]);
  });
});

// ── promptMergeStrategy ──────────────────────────────────────────────

describe("promptMergeStrategy", () => {
  it("returns asap for selection 1", async () => {
    const result = await promptMergeStrategy(makePrompt(["1"]));
    expect(result).toBe("asap");
  });

  it("returns approved for selection 2", async () => {
    const result = await promptMergeStrategy(makePrompt(["2"]));
    expect(result).toBe("approved");
  });

  it("returns reviewed for selection 3", async () => {
    const result = await promptMergeStrategy(makePrompt(["3"]));
    expect(result).toBe("reviewed");
  });

  it("defaults to asap on empty input", async () => {
    const result = await promptMergeStrategy(makePrompt([""]));
    expect(result).toBe("asap");
  });

  it("accepts strategy name directly", async () => {
    const result = await promptMergeStrategy(makePrompt(["approved"]));
    expect(result).toBe("approved");
  });

  it("re-prompts on invalid input", async () => {
    const result = await promptMergeStrategy(makePrompt(["99", "1"]));
    expect(result).toBe("asap");
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
  const todos = [makeTodo("A-1", "First task")];
  const result: InteractiveResult = {
    itemIds: ["A-1"],
    mergeStrategy: "asap",
    wipLimit: 3,
  };

  it("returns true on Y (default)", async () => {
    const confirmed = await confirmSummary(result, todos, makePrompt([""]));
    expect(confirmed).toBe(true);
  });

  it("returns false on n", async () => {
    const confirmed = await confirmSummary(result, todos, makePrompt(["n"]));
    expect(confirmed).toBe(false);
  });

  it("returns false on no", async () => {
    const confirmed = await confirmSummary(result, todos, makePrompt(["no"]));
    expect(confirmed).toBe(false);
  });
});

// ── runInteractiveFlow ───────────────────────────────────────────────

describe("runInteractiveFlow", () => {
  const todos = [
    makeTodo("A-1", "First task", "high"),
    makeTodo("B-2", "Second task", "medium"),
  ];

  it("returns complete result for valid flow", async () => {
    // Answers: select items "1 2", merge strategy "1" (asap), wip limit "5", confirm ""
    const prompt = makePrompt(["1 2", "1", "5", ""]);
    const result = await runInteractiveFlow(todos, 3, { prompt });

    expect(result).not.toBeNull();
    expect(result!.itemIds).toEqual(["A-1", "B-2"]);
    expect(result!.mergeStrategy).toBe("asap");
    expect(result!.wipLimit).toBe(5);
  });

  it("returns null when user quits at item selection", async () => {
    const prompt = makePrompt(["q"]);
    const result = await runInteractiveFlow(todos, 3, { prompt });
    expect(result).toBeNull();
  });

  it("returns null when user cancels at confirmation", async () => {
    // Answers: select items "1", merge strategy "1", wip limit "", confirm "n"
    const prompt = makePrompt(["1", "1", "", "n"]);
    const result = await runInteractiveFlow(todos, 3, { prompt });
    expect(result).toBeNull();
  });

  it("returns null for empty todo list", async () => {
    const prompt = makePrompt([]);
    const result = await runInteractiveFlow([], 3, { prompt });
    expect(result).toBeNull();
  });

  it("completes flow with approved strategy and custom wip", async () => {
    // Answers: select "all", merge "2" (approved), wip "7", confirm ""
    const prompt = makePrompt(["all", "2", "7", ""]);
    const result = await runInteractiveFlow(todos, 3, { prompt });

    expect(result).not.toBeNull();
    expect(result!.mergeStrategy).toBe("approved");
    expect(result!.wipLimit).toBe(7);
  });
});
