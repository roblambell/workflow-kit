// Tests for core/backends/github-issues.ts
// Uses vi.spyOn (not vi.mock) to avoid global module pollution in bun test.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as shell from "../core/shell.ts";
import {
  parsePriorityLabel,
  issueToTodoItem,
  GitHubIssuesBackend,
} from "../core/backends/github-issues.ts";
import type { GhIssueJson } from "../core/backends/github-issues.ts";

const runSpy = vi.spyOn(shell, "run");

beforeEach(() => runSpy.mockReset());
afterAll(() => runSpy.mockRestore());

// ---------------------------------------------------------------------------
// parsePriorityLabel
// ---------------------------------------------------------------------------
describe("parsePriorityLabel", () => {
  it("maps priority:high label to high", () => {
    expect(parsePriorityLabel([{ name: "priority:high" }])).toBe("high");
  });

  it("maps priority:critical label to critical", () => {
    expect(parsePriorityLabel([{ name: "priority:critical" }])).toBe(
      "critical",
    );
  });

  it("maps priority:low label to low", () => {
    expect(parsePriorityLabel([{ name: "priority:low" }])).toBe("low");
  });

  it("maps priority:medium label to medium", () => {
    expect(parsePriorityLabel([{ name: "priority:medium" }])).toBe("medium");
  });

  it("defaults to medium when no priority label exists", () => {
    expect(parsePriorityLabel([{ name: "bug" }, { name: "ninthwave" }])).toBe(
      "medium",
    );
  });

  it("defaults to medium for empty labels array", () => {
    expect(parsePriorityLabel([])).toBe("medium");
  });

  it("ignores invalid priority labels like priority:urgent", () => {
    expect(parsePriorityLabel([{ name: "priority:urgent" }])).toBe("medium");
  });

  it("picks the first matching priority label", () => {
    expect(
      parsePriorityLabel([
        { name: "priority:high" },
        { name: "priority:low" },
      ]),
    ).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// issueToTodoItem
// ---------------------------------------------------------------------------
describe("issueToTodoItem", () => {
  it("parses a full issue into TodoItem shape", () => {
    const issue: GhIssueJson = {
      number: 42,
      title: "Add feature X",
      body: "Implement feature X as described",
      labels: [{ name: "ninthwave" }, { name: "priority:high" }],
      milestone: { title: "v1.0" },
      state: "OPEN",
    };

    const item = issueToTodoItem(issue);

    expect(item.id).toBe("GHI-42");
    expect(item.title).toBe("Add feature X");
    expect(item.priority).toBe("high");
    expect(item.domain).toBe("v1.0");
    expect(item.rawText).toBe("Implement feature X as described");
    expect(item.dependencies).toEqual([]);
    expect(item.bundleWith).toEqual([]);
    expect(item.status).toBe("open");
  });

  it("handles issue with no body, no labels, no milestone (safe defaults)", () => {
    const issue: GhIssueJson = {
      number: 99,
      title: "Bare issue",
      body: "",
      labels: [],
      milestone: null,
      state: "OPEN",
    };

    const item = issueToTodoItem(issue);

    expect(item.id).toBe("GHI-99");
    expect(item.title).toBe("Bare issue");
    expect(item.priority).toBe("medium");
    expect(item.domain).toBe("uncategorized");
    expect(item.rawText).toBe("");
    expect(item.filePaths).toEqual([]);
    expect(item.testPlan).toBe("");
  });
});

// ---------------------------------------------------------------------------
// GitHubIssuesBackend.list
// ---------------------------------------------------------------------------
describe("GitHubIssuesBackend.list", () => {
  it("returns TodoItems from gh issue list output", () => {
    const issues: GhIssueJson[] = [
      {
        number: 1,
        title: "First issue",
        body: "body 1",
        labels: [{ name: "ninthwave" }, { name: "priority:high" }],
        milestone: { title: "Sprint 1" },
        state: "OPEN",
      },
      {
        number: 2,
        title: "Second issue",
        body: "body 2",
        labels: [{ name: "ninthwave" }],
        milestone: null,
        state: "OPEN",
      },
    ];

    runSpy.mockReturnValue({
      stdout: JSON.stringify(issues),
      stderr: "",
      exitCode: 0,
    });

    const backend = new GitHubIssuesBackend("/repo");
    const items = backend.list();

    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("GHI-1");
    expect(items[0].priority).toBe("high");
    expect(items[0].domain).toBe("Sprint 1");
    expect(items[1].id).toBe("GHI-2");
    expect(items[1].priority).toBe("medium");
    expect(items[1].domain).toBe("uncategorized");
  });

  it("passes correct label filter to gh CLI", () => {
    runSpy.mockReturnValue({
      stdout: "[]",
      stderr: "",
      exitCode: 0,
    });

    const backend = new GitHubIssuesBackend("/repo", "my-label");
    backend.list();

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "my-label",
        "--json",
        "number,title,body,labels,milestone,state",
        "--limit",
        "100",
      ],
      { cwd: "/repo" },
    );
  });

  it("uses default ninthwave label", () => {
    runSpy.mockReturnValue({
      stdout: "[]",
      stderr: "",
      exitCode: 0,
    });

    const backend = new GitHubIssuesBackend("/repo");
    backend.list();

    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["--label", "ninthwave"]),
      { cwd: "/repo" },
    );
  });

  it("returns empty array when gh command fails", () => {
    runSpy.mockReturnValue({
      stdout: "",
      stderr: "error",
      exitCode: 1,
    });

    const backend = new GitHubIssuesBackend("/repo");
    const items = backend.list();

    expect(items).toEqual([]);
  });

  it("returns empty array when gh returns invalid JSON", () => {
    runSpy.mockReturnValue({
      stdout: "not json",
      stderr: "",
      exitCode: 0,
    });

    const backend = new GitHubIssuesBackend("/repo");
    const items = backend.list();

    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GitHubIssuesBackend.read
// ---------------------------------------------------------------------------
describe("GitHubIssuesBackend.read", () => {
  it("reads a single issue by GHI-N format", () => {
    const issue: GhIssueJson = {
      number: 7,
      title: "Read me",
      body: "Details here",
      labels: [{ name: "priority:critical" }],
      milestone: { title: "Backlog" },
      state: "OPEN",
    };

    runSpy.mockReturnValue({
      stdout: JSON.stringify(issue),
      stderr: "",
      exitCode: 0,
    });

    const backend = new GitHubIssuesBackend("/repo");
    const item = backend.read("GHI-7");

    expect(item).toBeDefined();
    expect(item!.id).toBe("GHI-7");
    expect(item!.priority).toBe("critical");
    expect(item!.domain).toBe("Backlog");

    // Verify the GHI- prefix was stripped for the gh command
    expect(runSpy).toHaveBeenCalledWith(
      "gh",
      [
        "issue",
        "view",
        "7",
        "--json",
        "number,title,body,labels,milestone,state",
      ],
      { cwd: "/repo" },
    );
  });

  it("reads a single issue by plain number string", () => {
    const issue: GhIssueJson = {
      number: 3,
      title: "Plain number",
      body: "",
      labels: [],
      milestone: null,
      state: "OPEN",
    };

    runSpy.mockReturnValue({
      stdout: JSON.stringify(issue),
      stderr: "",
      exitCode: 0,
    });

    const backend = new GitHubIssuesBackend("/repo");
    const item = backend.read("3");

    expect(item).toBeDefined();
    expect(item!.id).toBe("GHI-3");
  });

  it("returns undefined when issue not found", () => {
    runSpy.mockReturnValue({
      stdout: "",
      stderr: "not found",
      exitCode: 1,
    });

    const backend = new GitHubIssuesBackend("/repo");
    const item = backend.read("GHI-999");

    expect(item).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GitHubIssuesBackend.markDone
// ---------------------------------------------------------------------------
describe("GitHubIssuesBackend.markDone", () => {
  it("returns false (stub for read-only backend)", () => {
    const backend = new GitHubIssuesBackend("/repo");
    expect(backend.markDone("GHI-1")).toBe(false);
  });
});
