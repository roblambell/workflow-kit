// Tests for core/interactive.ts -- Interactive CLI prompts for orchestrate.

import { describe, it, expect } from "vitest";
import {
  shouldEnterInteractive,
  parseSelection,
  promptItems,
  promptMergeStrategy,
  promptWipLimit,
  promptReviewMode,
  promptCrewMode,
  confirmSummary,
  runInteractiveFlow,
  displayItemsSummary,
  type PromptFn,
  type InteractiveResult,
} from "../core/interactive.ts";
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
    crewAction: null,
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

  it("displays reviewMode and crew info", async () => {
    const crewResult: InteractiveResult = {
      ...result,
      reviewMode: "all",
      crewAction: { type: "join", code: "K2F9-AB3X-7YPL-QM4N" },
    };
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await confirmSummary(crewResult, items, makePrompt([""]));
    } finally {
      console.log = origLog;
    }
    const output = logs.join("\n");
    expect(output).toContain("all");
    expect(output).toContain("join K2F9-AB3X-7YPL-QM4N");
  });

  it("displays solo when crewAction is null", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await confirmSummary(result, items, makePrompt([""]));
    } finally {
      console.log = origLog;
    }
    const output = logs.join("\n");
    expect(output).toContain("solo");
  });
});

// ── runInteractiveFlow ───────────────────────────────────────────────

describe("runInteractiveFlow", () => {
  const items = [
    makeWorkItem("A-1", "First task", "high"),
    makeWorkItem("B-2", "Second task", "medium"),
  ];

  it("returns complete result for valid legacy flow", async () => {
    // Answers: select items "1 2", merge strategy "1" (auto), wip limit "5",
    //          review mode "" (default=mine), crew "1" (solo), confirm ""
    const prompt = makePrompt(["1 2", "1", "5", "", "1", ""]);
    const result = await runInteractiveFlow(items, 3, { prompt, useLegacyPrompts: true });

    expect(result).not.toBeNull();
    expect(result!.itemIds).toEqual(["A-1", "B-2"]);
    expect(result!.mergeStrategy).toBe("auto");
    expect(result!.wipLimit).toBe(5);
    expect(result!.reviewMode).toBe("mine");
    expect(result!.crewAction).toBeNull();
    expect(result!.allSelected).toBe(true);
  });

  it("returns null when user quits at item selection", async () => {
    const prompt = makePrompt(["q"]);
    const result = await runInteractiveFlow(items, 3, { prompt, useLegacyPrompts: true });
    expect(result).toBeNull();
  });

  it("returns null when user cancels at confirmation", async () => {
    // Answers: select items "1", merge strategy "1" (auto), wip limit "",
    //          review mode "", crew "1" (solo), confirm "n"
    const prompt = makePrompt(["1", "1", "", "", "1", "n"]);
    const result = await runInteractiveFlow(items, 3, { prompt, useLegacyPrompts: true });
    expect(result).toBeNull();
  });

  it("returns null for empty item list", async () => {
    const prompt = makePrompt([]);
    const result = await runInteractiveFlow([], 3, { prompt, useLegacyPrompts: true });
    expect(result).toBeNull();
  });

  it("completes flow with manual strategy and custom wip", async () => {
    // Answers: select "all", merge "2" (manual), wip "7",
    //          review mode "1" (all), crew "1" (solo), confirm ""
    const prompt = makePrompt(["all", "2", "7", "1", "1", ""]);
    const result = await runInteractiveFlow(items, 3, { prompt, useLegacyPrompts: true });

    expect(result).not.toBeNull();
    expect(result!.mergeStrategy).toBe("manual");
    expect(result!.wipLimit).toBe(7);
    expect(result!.allSelected).toBe(true);
    expect(result!.reviewMode).toBe("all");
  });

  it("skips crew step when showCrewStep is false", async () => {
    // Answers: select "1", merge "1" (auto), wip "",
    //          review mode "" (default=mine), confirm "" (no crew prompt)
    const prompt = makePrompt(["1", "1", "", "", ""]);
    const result = await runInteractiveFlow(items, 3, {
      prompt,
      useLegacyPrompts: true,
      showCrewStep: false,
    });

    expect(result).not.toBeNull();
    expect(result!.crewAction).toBeNull();
  });

  it("passes defaultReviewMode through to readline flow", async () => {
    // Answers: select "1", merge "1", wip "",
    //          review mode "" (default=all from deps), crew "1" (solo), confirm ""
    const prompt = makePrompt(["1", "1", "", "", "1", ""]);
    const result = await runInteractiveFlow(items, 3, {
      prompt,
      useLegacyPrompts: true,
      defaultReviewMode: "all",
    });

    expect(result).not.toBeNull();
    expect(result!.reviewMode).toBe("all");
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

// ── promptCrewMode ──────────────────────────────────────────────────

describe("promptCrewMode", () => {
  it("returns null for solo (default)", async () => {
    const result = await promptCrewMode(makePrompt([""]));
    expect(result).toBeNull();
  });

  it("returns null for solo on input 1", async () => {
    const result = await promptCrewMode(makePrompt(["1"]));
    expect(result).toBeNull();
  });

  it('returns create on input "3"', async () => {
    const result = await promptCrewMode(makePrompt(["3"]));
    expect(result).toEqual({ type: "create" });
  });

  it('returns create on text "create"', async () => {
    const result = await promptCrewMode(makePrompt(["create"]));
    expect(result).toEqual({ type: "create" });
  });

  it('returns join with code on input "2" then valid code', async () => {
    const result = await promptCrewMode(makePrompt(["2", "K2F9-AB3X-7YPL-QM4N"]));
    expect(result).toEqual({ type: "join", code: "K2F9-AB3X-7YPL-QM4N" });
  });

  it("returns null when user cancels join code prompt", async () => {
    const result = await promptCrewMode(makePrompt(["join", "q"]));
    expect(result).toBeNull();
  });

  it("retries on invalid crew code then accepts valid", async () => {
    const result = await promptCrewMode(makePrompt(["2", "invalid", "K2F9-AB3X-7YPL-QM4N"]));
    expect(result).toEqual({ type: "join", code: "K2F9-AB3X-7YPL-QM4N" });
  });

  it("retries on invalid choice then accepts valid", async () => {
    const result = await promptCrewMode(makePrompt(["99", "solo"]));
    expect(result).toBeNull();
  });
});
