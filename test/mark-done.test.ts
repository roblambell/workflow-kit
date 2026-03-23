import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { cmdMarkDone } from "../core/commands/mark-done.ts";

const VALID_FIXTURE = readFileSync(
  join(__dirname, "fixtures", "valid.md"),
  "utf-8",
);
const MULTI_SECTION_FIXTURE = readFileSync(
  join(__dirname, "fixtures", "multi_section.md"),
  "utf-8",
);

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = join(
    require("os").tmpdir(),
    `nw-test-mark-done-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function setupTodos(content: string): string {
  const dir = makeTmpDir();
  const todosFile = join(dir, "TODOS.md");
  writeFileSync(todosFile, content);
  return todosFile;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs = [];
});

describe("cmdMarkDone", () => {
  it("removes a single item", () => {
    const todosFile = setupTodos(VALID_FIXTURE);
    cmdMarkDone(["M-CI-1"], todosFile);
    const result = readFileSync(todosFile, "utf-8");
    expect(result).not.toContain("(M-CI-1)");
    expect(result).not.toContain("Upgrade CI runners");
  });

  it("preserves other items after single removal", () => {
    const todosFile = setupTodos(VALID_FIXTURE);
    cmdMarkDone(["M-CI-1"], todosFile);
    const result = readFileSync(todosFile, "utf-8");
    expect(result).toContain("(H-CI-2)");
    expect(result).toContain("(C-UO-1)");
    expect(result).toContain("(H-UO-2)");
  });

  it("preserves section headers with remaining items", () => {
    const todosFile = setupTodos(VALID_FIXTURE);
    cmdMarkDone(["M-CI-1"], todosFile);
    const result = readFileSync(todosFile, "utf-8");
    expect(result).toContain("Cloud Infrastructure");
    expect(result).toContain("User Onboarding");
  });

  it("removes multiple items at once", () => {
    const todosFile = setupTodos(VALID_FIXTURE);
    cmdMarkDone(["M-CI-1", "H-CI-2"], todosFile);
    const result = readFileSync(todosFile, "utf-8");
    expect(result).not.toContain("(M-CI-1)");
    expect(result).not.toContain("(H-CI-2)");
    expect(result).not.toContain("Upgrade CI runners");
    expect(result).not.toContain("Flaky connection pool");
    expect(result).toContain("(C-UO-1)");
    expect(result).toContain("(H-UO-2)");
  });

  it("removes section header when all items in section are removed", () => {
    const todosFile = setupTodos(VALID_FIXTURE);
    cmdMarkDone(["M-CI-1", "H-CI-2"], todosFile);
    const result = readFileSync(todosFile, "utf-8");
    expect(result).not.toContain("Cloud Infrastructure");
  });

  it("keeps section with remaining items", () => {
    const todosFile = setupTodos(VALID_FIXTURE);
    cmdMarkDone(["M-CI-1", "H-CI-2"], todosFile);
    const result = readFileSync(todosFile, "utf-8");
    expect(result).toContain("User Onboarding");
  });

  it("removing all items leaves only the header", () => {
    const todosFile = setupTodos(VALID_FIXTURE);
    cmdMarkDone(["M-CI-1", "H-CI-2", "C-UO-1", "H-UO-2"], todosFile);
    const result = readFileSync(todosFile, "utf-8");
    expect(result).not.toContain("(M-CI-1)");
    expect(result).not.toContain("(H-CI-2)");
    expect(result).not.toContain("(C-UO-1)");
    expect(result).not.toContain("(H-UO-2)");
    expect(result).not.toContain("Cloud Infrastructure");
    expect(result).not.toContain("User Onboarding");
    expect(result).toContain("# TODOS");
  });

  it("removes item from second section, preserves first section", () => {
    const todosFile = setupTodos(MULTI_SECTION_FIXTURE);
    cmdMarkDone(["H-BE-1"], todosFile);
    const result = readFileSync(todosFile, "utf-8");
    expect(result).not.toContain("(H-BE-1)");
    expect(result).toContain("(H-AL-1)");
    expect(result).toContain("(M-AL-2)");
    expect(result).toContain("Section Alpha");
  });

  it("removes empty second section header", () => {
    const todosFile = setupTodos(MULTI_SECTION_FIXTURE);
    cmdMarkDone(["H-BE-1"], todosFile);
    const result = readFileSync(todosFile, "utf-8");
    expect(result).not.toContain("Section Beta");
  });

  it("outputs confirmation message", () => {
    const todosFile = setupTodos(VALID_FIXTURE);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      cmdMarkDone(["M-CI-1"], todosFile);
    } finally {
      console.log = origLog;
    }
    const output = logs.join("\n");
    expect(output).toContain("Marked");
    expect(output).toContain("1 item");
    expect(output).toContain("M-CI-1");
  });
});
