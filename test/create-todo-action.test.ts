import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getNextCiId,
  generateTodoId,
  generateTodoFilename,
  generateTodoContent,
} from "../actions/create-todo/lib.ts";
import { parseTodoFile } from "../core/todo-files.ts";

describe("getNextCiId", () => {
  it("returns 1 when no CI files exist", () => {
    expect(getNextCiId([])).toBe(1);
  });

  it("returns 1 when files exist but none are CI", () => {
    const files = [
      "1-cli--H-CLI-2.md",
      "2-backend--M-CKU-1.md",
      "3-docs--L-DOC-1.md",
    ];
    expect(getNextCiId(files)).toBe(1);
  });

  it("returns next number after highest existing CI id", () => {
    const files = [
      "1-ci--H-CI-1.md",
      "1-ci--H-CI-3.md",
      "1-ci--H-CI-2.md",
    ];
    expect(getNextCiId(files)).toBe(4);
  });

  it("handles mixed priority prefixes", () => {
    const files = [
      "1-ci--H-CI-1.md",
      "2-ci--M-CI-5.md",
      "0-ci--C-CI-2.md",
    ];
    expect(getNextCiId(files)).toBe(6);
  });

  it("ignores non-matching patterns", () => {
    const files = [
      "1-ci--H-CI-10.md",
      "README.md",
      "not-a-todo.txt",
      "1-cli--H-CLI-99.md",
    ];
    expect(getNextCiId(files)).toBe(11);
  });
});

describe("generateTodoId", () => {
  it("generates H prefix for high priority", () => {
    expect(generateTodoId("high", 1)).toBe("H-CI-1");
  });

  it("generates M prefix for medium priority", () => {
    expect(generateTodoId("medium", 5)).toBe("M-CI-5");
  });

  it("generates C prefix for critical priority", () => {
    expect(generateTodoId("critical", 3)).toBe("C-CI-3");
  });

  it("generates L prefix for low priority", () => {
    expect(generateTodoId("low", 2)).toBe("L-CI-2");
  });

  it("defaults to H for unknown priority", () => {
    expect(generateTodoId("unknown", 1)).toBe("H-CI-1");
  });

  it("handles case-insensitive priority", () => {
    expect(generateTodoId("High", 7)).toBe("H-CI-7");
  });
});

describe("generateTodoFilename", () => {
  it("generates correct filename for high priority ci", () => {
    expect(generateTodoFilename("H-CI-1", "high", "ci")).toBe(
      "1-ci--H-CI-1.md",
    );
  });

  it("generates correct filename for critical priority", () => {
    expect(generateTodoFilename("C-CI-5", "critical", "ci")).toBe(
      "0-ci--C-CI-5.md",
    );
  });

  it("generates correct filename for medium priority", () => {
    expect(generateTodoFilename("M-CI-2", "medium", "ci")).toBe(
      "2-ci--M-CI-2.md",
    );
  });

  it("generates correct filename for low priority", () => {
    expect(generateTodoFilename("L-CI-3", "low", "ci")).toBe(
      "3-ci--L-CI-3.md",
    );
  });

  it("defaults to 1 for unknown priority", () => {
    expect(generateTodoFilename("H-CI-1", "bogus", "ci")).toBe(
      "1-ci--H-CI-1.md",
    );
  });
});

describe("generateTodoContent", () => {
  const baseOpts = {
    id: "H-CI-1",
    workflowName: "CI",
    runId: 12345,
    runUrl: "https://github.com/owner/repo/actions/runs/12345",
    errorLogs: "Job: test\n  Step: Run tests — failure",
    priority: "high",
    repo: "owner/repo",
  };

  it("includes the todo ID in the heading", () => {
    const content = generateTodoContent(baseOpts);
    expect(content).toContain("# Fix: CI failure in CI (H-CI-1)");
  });

  it("includes priority metadata", () => {
    const content = generateTodoContent(baseOpts);
    expect(content).toContain("**Priority:** High");
  });

  it("includes source metadata", () => {
    const content = generateTodoContent(baseOpts);
    expect(content).toContain("**Source:** GitHub Action (create-todo)");
  });

  it("includes domain metadata", () => {
    const content = generateTodoContent(baseOpts);
    expect(content).toContain("**Domain:** ci");
  });

  it("includes depends on", () => {
    const content = generateTodoContent(baseOpts);
    expect(content).toContain("**Depends on:** -");
  });

  it("includes workflow name and repo in body", () => {
    const content = generateTodoContent(baseOpts);
    expect(content).toContain('CI workflow "CI" failed in owner/repo.');
  });

  it("includes run ID and URL", () => {
    const content = generateTodoContent(baseOpts);
    expect(content).toContain("- **Run ID:** 12345");
    expect(content).toContain(
      "- **Run URL:** https://github.com/owner/repo/actions/runs/12345",
    );
  });

  it("includes acceptance criteria", () => {
    const content = generateTodoContent(baseOpts);
    expect(content).toContain(
      "Acceptance: The CI failure is investigated and resolved.",
    );
  });

  it("includes error logs in a code block", () => {
    const content = generateTodoContent(baseOpts);
    expect(content).toContain("## Error Logs");
    expect(content).toContain("```\nJob: test\n  Step: Run tests — failure\n```");
  });

  it("truncates long error logs", () => {
    const longLogs = "x".repeat(3000);
    const content = generateTodoContent({ ...baseOpts, errorLogs: longLogs });
    expect(content).toContain("... (truncated)");
    // The truncated log should be at most 2000 chars + truncation message
    const logMatch = content.match(/```\n([\s\S]*?)\n```/);
    expect(logMatch).toBeTruthy();
    const logContent = logMatch![1]!;
    expect(logContent).toContain("x".repeat(2000));
  });

  it("omits error logs section when empty", () => {
    const content = generateTodoContent({ ...baseOpts, errorLogs: "" });
    expect(content).not.toContain("## Error Logs");
    expect(content).not.toContain("```");
  });
});

describe("integration: generated todo is parseable by ninthwave", () => {
  it("parseTodoFile successfully parses a generated CI todo", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-test-"));
    const content = generateTodoContent({
      id: "H-CI-1",
      workflowName: "Tests",
      runId: 99999,
      runUrl: "https://github.com/acme/app/actions/runs/99999",
      errorLogs: "Job: unit-tests\n  Step: bun test — failure",
      priority: "high",
      repo: "acme/app",
    });

    const filename = generateTodoFilename("H-CI-1", "high", "ci");
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, content);

    const item = parseTodoFile(filePath);
    expect(item).not.toBeNull();
    expect(item!.id).toBe("H-CI-1");
    expect(item!.priority).toBe("high");
    expect(item!.domain).toBe("ci");
    expect(item!.title).toBe("CI failure in Tests");
    expect(item!.dependencies).toEqual([]);
  });

  it("parseTodoFile parses todo with medium priority", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-test-"));
    const content = generateTodoContent({
      id: "M-CI-3",
      workflowName: "Lint",
      runId: 55555,
      runUrl: "https://github.com/acme/app/actions/runs/55555",
      errorLogs: "",
      priority: "medium",
      repo: "acme/app",
    });

    const filename = generateTodoFilename("M-CI-3", "medium", "ci");
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, content);

    const item = parseTodoFile(filePath);
    expect(item).not.toBeNull();
    expect(item!.id).toBe("M-CI-3");
    expect(item!.priority).toBe("medium");
    expect(item!.domain).toBe("ci");
  });

  it("end-to-end: simulated workflow_run event produces parseable todo", () => {
    // Simulate the full pipeline: event -> ID generation -> content -> parse
    const existingFiles = [
      "1-ci--H-CI-1.md",
      "1-ci--H-CI-2.md",
      "1-cli--H-CLI-1.md",
    ];

    const nextNum = getNextCiId(existingFiles);
    expect(nextNum).toBe(3);

    const priority = "high";
    const todoId = generateTodoId(priority, nextNum);
    expect(todoId).toBe("H-CI-3");

    const filename = generateTodoFilename(todoId, priority, "ci");
    expect(filename).toBe("1-ci--H-CI-3.md");

    const content = generateTodoContent({
      id: todoId,
      workflowName: "Build & Test",
      runId: 777,
      runUrl: "https://github.com/org/repo/actions/runs/777",
      errorLogs: "Job: build\n  Step: Compile — failure\nJob: test\n  Step: Unit tests — failure",
      priority,
      repo: "org/repo",
    });

    // Write and parse
    const tmpDir = mkdtempSync(join(tmpdir(), "nw-test-"));
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, content);

    const item = parseTodoFile(filePath);
    expect(item).not.toBeNull();
    expect(item!.id).toBe("H-CI-3");
    expect(item!.priority).toBe("high");
    expect(item!.domain).toBe("ci");
    expect(item!.title).toBe("CI failure in Build & Test");
    expect(item!.rawText).toContain("Build & Test");
    expect(item!.rawText).toContain("Error Logs");
  });
});
