// Tests for core/schedule-files.ts — schedule file parsing and listing.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseScheduleFile, listScheduledTasks } from "../core/schedule-files.ts";

// Track temp dirs for cleanup
const tempDirs: string[] = [];

function makeTempDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "nw-schedule-"));
  tempDirs.push(tmp);
  return tmp;
}

afterEach(() => {
  for (const d of tempDirs) {
    if (existsSync(d)) {
      rmSync(d, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
});

// ── parseScheduleFile ────────────────────────────────────────────────

describe("parseScheduleFile", () => {
  it("parses a valid file with all fields", () => {
    const dir = makeTempDir();
    const fp = join(dir, "daily-test-run.md");
    writeFileSync(
      fp,
      `# Daily Test Run (daily-test-run)

**Schedule:** every day at 09:00
**Priority:** High
**Domain:** ci
**Timeout:** 15m
**Enabled:** true

Run the full test suite and report results.
Check for flaky tests.
`,
    );

    const task = parseScheduleFile(fp);
    expect(task).not.toBeNull();
    expect(task!.id).toBe("daily-test-run");
    expect(task!.title).toBe("Daily Test Run");
    expect(task!.schedule).toBe("every day at 09:00");
    expect(task!.scheduleCron).toBe("0 9 * * *");
    expect(task!.priority).toBe("high");
    expect(task!.domain).toBe("ci");
    expect(task!.timeout).toBe(15 * 60 * 1000);
    expect(task!.enabled).toBe(true);
    expect(task!.prompt).toBe("Run the full test suite and report results.\nCheck for flaky tests.");
    expect(task!.filePath).toBe(fp);
  });

  it("parses a file with defaults only (no optional fields)", () => {
    const dir = makeTempDir();
    const fp = join(dir, "simple-task.md");
    writeFileSync(
      fp,
      `# Simple Task (simple-task)

**Schedule:** every 2h

Do the thing.
`,
    );

    const task = parseScheduleFile(fp);
    expect(task).not.toBeNull();
    expect(task!.id).toBe("simple-task");
    expect(task!.title).toBe("Simple Task");
    expect(task!.schedule).toBe("every 2h");
    expect(task!.scheduleCron).toBe("0 */2 * * *");
    expect(task!.priority).toBe("medium"); // default
    expect(task!.domain).toBe("uncategorized"); // default
    expect(task!.timeout).toBe(30 * 60 * 1000); // default 30m
    expect(task!.enabled).toBe(true); // default
    expect(task!.prompt).toBe("Do the thing.");
  });

  it("returns null when missing Schedule field", () => {
    const dir = makeTempDir();
    const fp = join(dir, "no-schedule.md");
    writeFileSync(
      fp,
      `# No Schedule (no-schedule)

**Priority:** Low

Just a description.
`,
    );

    const task = parseScheduleFile(fp);
    expect(task).toBeNull();
  });

  it("returns null when missing heading", () => {
    const dir = makeTempDir();
    const fp = join(dir, "no-heading.md");
    writeFileSync(
      fp,
      `No heading here.

**Schedule:** every 1h
`,
    );

    const task = parseScheduleFile(fp);
    expect(task).toBeNull();
  });

  it("returns null when heading has no ID in parentheses", () => {
    const dir = makeTempDir();
    const fp = join(dir, "no-id.md");
    writeFileSync(
      fp,
      `# Missing ID

**Schedule:** every 1h
`,
    );

    const task = parseScheduleFile(fp);
    expect(task).toBeNull();
  });

  it("parses a disabled file (enabled=false)", () => {
    const dir = makeTempDir();
    const fp = join(dir, "disabled-task.md");
    writeFileSync(
      fp,
      `# Disabled Task (disabled-task)

**Schedule:** every 6h
**Enabled:** false

This task is disabled.
`,
    );

    const task = parseScheduleFile(fp);
    expect(task).not.toBeNull();
    expect(task!.enabled).toBe(false);
  });

  it("returns null for nonexistent file", () => {
    const task = parseScheduleFile("/nonexistent/file.md");
    expect(task).toBeNull();
  });

  it("returns null for malformed schedule expression", () => {
    const dir = makeTempDir();
    const fp = join(dir, "bad-schedule.md");
    writeFileSync(
      fp,
      `# Bad Schedule (bad-schedule)

**Schedule:** whenever I feel like it
`,
    );

    const task = parseScheduleFile(fp);
    expect(task).toBeNull();
  });

  it("parses timeout in different units", () => {
    const dir = makeTempDir();
    const fp = join(dir, "timeout-test.md");
    writeFileSync(
      fp,
      `# Timeout Test (timeout-test)

**Schedule:** every 1h
**Timeout:** 2h

Do stuff.
`,
    );

    const task = parseScheduleFile(fp);
    expect(task).not.toBeNull();
    expect(task!.timeout).toBe(2 * 60 * 60 * 1000);
  });

  it("parses raw cron passthrough", () => {
    const dir = makeTempDir();
    const fp = join(dir, "cron-task.md");
    writeFileSync(
      fp,
      `# Cron Task (cron-task)

**Schedule:** cron: 30 4 * * 1-5

Run on weekdays at 4:30 AM.
`,
    );

    const task = parseScheduleFile(fp);
    expect(task).not.toBeNull();
    expect(task!.schedule).toBe("cron: 30 4 * * 1-5");
    expect(task!.scheduleCron).toBe("30 4 * * 1-5");
  });
});

// ── listScheduledTasks ───────────────────────────────────────────────

describe("listScheduledTasks", () => {
  it("lists valid tasks and skips invalid ones", () => {
    const dir = makeTempDir();

    // Valid task
    writeFileSync(
      join(dir, "valid-task.md"),
      `# Valid Task (valid-task)

**Schedule:** every 2h

Do something.
`,
    );

    // Another valid task
    writeFileSync(
      join(dir, "another-task.md"),
      `# Another Task (another-task)

**Schedule:** every day at 12:00
**Priority:** Low

Lunchtime task.
`,
    );

    // Invalid task (no schedule)
    writeFileSync(
      join(dir, "invalid-task.md"),
      `# Invalid Task (invalid-task)

No schedule here.
`,
    );

    // Non-markdown file (should be skipped)
    writeFileSync(join(dir, "readme.txt"), "Not a markdown file.");

    const tasks = listScheduledTasks(dir);
    expect(tasks).toHaveLength(2);

    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["another-task", "valid-task"]);
  });

  it("returns empty array for nonexistent directory", () => {
    const tasks = listScheduledTasks("/nonexistent/dir");
    expect(tasks).toEqual([]);
  });

  it("returns empty array for directory with no markdown files", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "notes.txt"), "No markdown here.");

    const tasks = listScheduledTasks(dir);
    expect(tasks).toEqual([]);
  });
});
