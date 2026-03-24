import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { cmdMarkDone } from "../core/commands/mark-done.ts";

let tmpDirs: string[] = [];

function makeTodosDir(): string {
  const base = join(
    require("os").tmpdir(),
    `nw-test-mark-done-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const todosDir = join(base, ".ninthwave", "todos");
  mkdirSync(todosDir, { recursive: true });
  tmpDirs.push(base);
  return todosDir;
}

function writeTodoFile(todosDir: string, id: string, priority = "medium", domain = "testing"): void {
  const filename = `2-${domain}--${id}.md`;
  writeFileSync(
    join(todosDir, filename),
    `# Test item (${id})\n\n**Priority:** ${priority}\n**Domain:** ${domain}\n`,
  );
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
  it("deletes a single todo file", () => {
    const todosDir = makeTodosDir();
    writeTodoFile(todosDir, "M-CI-1");
    writeTodoFile(todosDir, "H-CI-2");

    cmdMarkDone(["M-CI-1"], todosDir);

    expect(existsSync(join(todosDir, "2-testing--M-CI-1.md"))).toBe(false);
    expect(existsSync(join(todosDir, "2-testing--H-CI-2.md"))).toBe(true);
  });

  it("deletes multiple todo files at once", () => {
    const todosDir = makeTodosDir();
    writeTodoFile(todosDir, "M-CI-1");
    writeTodoFile(todosDir, "H-CI-2");
    writeTodoFile(todosDir, "C-UO-1");

    cmdMarkDone(["M-CI-1", "H-CI-2"], todosDir);

    expect(existsSync(join(todosDir, "2-testing--M-CI-1.md"))).toBe(false);
    expect(existsSync(join(todosDir, "2-testing--H-CI-2.md"))).toBe(false);
    expect(existsSync(join(todosDir, "2-testing--C-UO-1.md"))).toBe(true);
  });

  it("is idempotent: nonexistent ID is a no-op", () => {
    const todosDir = makeTodosDir();
    writeTodoFile(todosDir, "M-CI-1");

    // Should not throw
    cmdMarkDone(["NONEXISTENT-1"], todosDir);

    // Existing file is untouched
    expect(existsSync(join(todosDir, "2-testing--M-CI-1.md"))).toBe(true);
  });

  it("handles mix of found and not-found IDs", () => {
    const todosDir = makeTodosDir();
    writeTodoFile(todosDir, "M-CI-1");
    writeTodoFile(todosDir, "H-CI-2");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      cmdMarkDone(["M-CI-1", "GONE-1"], todosDir);
    } finally {
      console.log = origLog;
    }

    expect(existsSync(join(todosDir, "2-testing--M-CI-1.md"))).toBe(false);
    expect(existsSync(join(todosDir, "2-testing--H-CI-2.md"))).toBe(true);

    const output = logs.join("\n");
    expect(output).toContain("1 item");
    expect(output).toContain("M-CI-1");
    expect(output).toContain("Not found");
    expect(output).toContain("GONE-1");
  });

  it("outputs confirmation message", () => {
    const todosDir = makeTodosDir();
    writeTodoFile(todosDir, "M-CI-1");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      cmdMarkDone(["M-CI-1"], todosDir);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Marked");
    expect(output).toContain("1 item");
    expect(output).toContain("M-CI-1");
  });

  it("marking a previously-deleted ID is silent no-op", () => {
    const todosDir = makeTodosDir();
    writeTodoFile(todosDir, "M-CI-1");

    cmdMarkDone(["M-CI-1"], todosDir);
    expect(existsSync(join(todosDir, "2-testing--M-CI-1.md"))).toBe(false);

    // Mark again — should not throw
    cmdMarkDone(["M-CI-1"], todosDir);
    expect(existsSync(join(todosDir, "2-testing--M-CI-1.md"))).toBe(false);
  });
});
