// Tests for core/commands/schedule.ts -- schedule CLI command.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cmdSchedule } from "../core/commands/schedule.ts";

// ── Helpers ─────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempProject(): string {
  const tmp = mkdtempSync(join(tmpdir(), "nw-sched-cmd-"));
  tempDirs.push(tmp);
  mkdirSync(join(tmp, ".ninthwave", "schedules"), { recursive: true });
  return tmp;
}

/** Write a valid schedule file. */
function writeSchedule(
  projectRoot: string,
  filename: string,
  content: string,
): void {
  writeFileSync(join(projectRoot, ".ninthwave", "schedules", filename), content);
}

const VALID_SCHEDULE_1 = `# Daily Tests (daily-tests)

**Schedule:** every day at 09:00
**Priority:** High
**Domain:** ci
**Timeout:** 15m
**Enabled:** true

Run the full test suite and report results.
`;

const VALID_SCHEDULE_2 = `# Weekly Report (weekly-report)

**Schedule:** every monday at 08:00
**Priority:** Medium
**Domain:** analytics
**Timeout:** 30m
**Enabled:** true

Generate weekly analytics report.
`;

const DISABLED_SCHEDULE = `# Nightly Backup (nightly-backup)

**Schedule:** every day at 02:00
**Priority:** Low
**Domain:** ops
**Timeout:** 1h
**Enabled:** false

Run backup process.
`;

// Capture stdout during a function call
function captureStdout(fn: () => void): string {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return logs.join("\n");
}

// Capture stdout, stderr, and exit code all at once
function captureAll(fn: () => void): { stdout: string; stderr: string; code: number | null } {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origExit = process.exit;
  let exitCode: number | null = null;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  };
  // @ts-expect-error -- mocking process.exit
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__EXIT__");
  };

  try {
    fn();
  } catch (e: unknown) {
    if (e instanceof Error && e.message !== "__EXIT__") throw e;
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
  }

  return { stdout: logs.join("\n"), stderr: errs.join("\n"), code: exitCode };
}

afterEach(() => {
  for (const d of tempDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// ── schedule list ───────────────────────────────────────────────────

describe("schedule list", () => {
  it("lists multiple schedules with next-run times", () => {
    const root = makeTempProject();
    writeSchedule(root, "ci--daily-tests.md", VALID_SCHEDULE_1);
    writeSchedule(root, "analytics--weekly-report.md", VALID_SCHEDULE_2);

    const output = captureStdout(() => cmdSchedule([], root));

    expect(output).toContain("daily-tests");
    expect(output).toContain("every day at 09:00");
    expect(output).toContain("ci");
    expect(output).toContain("weekly-report");
    expect(output).toContain("every monday at 08:00");
    expect(output).toContain("analytics");
    // Next-run times should be present (contain time-like patterns)
    expect(output).toMatch(/\d{2}:\d{2}/);
    expect(output).toContain("2 schedule(s)");
  });

  it("shows empty message when no schedules exist", () => {
    const root = makeTempProject();

    const output = captureStdout(() => cmdSchedule(["list"], root));

    expect(output).toContain("No scheduled tasks found.");
  });

  it("shows disabled tag for disabled schedules", () => {
    const root = makeTempProject();
    writeSchedule(root, "ops--nightly-backup.md", DISABLED_SCHEDULE);

    const output = captureStdout(() => cmdSchedule(["list"], root));

    expect(output).toContain("nightly-backup");
    expect(output).toContain("[disabled]");
  });
});

// ── schedule show ───────────────────────────────────────────────────

describe("schedule show", () => {
  it("shows full details for a valid ID", () => {
    const root = makeTempProject();
    writeSchedule(root, "ci--daily-tests.md", VALID_SCHEDULE_1);

    const output = captureStdout(() => cmdSchedule(["show", "daily-tests"], root));

    expect(output).toContain("Daily Tests");
    expect(output).toContain("daily-tests");
    expect(output).toContain("every day at 09:00");
    expect(output).toContain("ci");
    expect(output).toContain("15m");
    expect(output).toContain("true");
    expect(output).toContain("Prompt:");
    expect(output).toContain("Run the full test suite");
    expect(output).toContain("Last run:");
  });

  it("errors on invalid ID", () => {
    const root = makeTempProject();
    writeSchedule(root, "ci--daily-tests.md", VALID_SCHEDULE_1);

    const { stderr, code } = captureAll(() =>
      cmdSchedule(["show", "nonexistent"], root),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("Schedule not found: nonexistent");
  });

  it("shows last-run from state file when available", () => {
    const root = makeTempProject();
    writeSchedule(root, "ci--daily-tests.md", VALID_SCHEDULE_1);

    // Write a mock state file
    const home = process.env.HOME ?? "/tmp";
    const slug = root.replace(/\//g, "-");
    const stateDir = join(home, ".ninthwave", "projects", slug, "schedule-state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "daily-tests.json"),
      JSON.stringify({ lastRunAt: "2026-03-28T09:00:00Z" }),
    );
    tempDirs.push(join(home, ".ninthwave", "projects", slug));

    const output = captureStdout(() => cmdSchedule(["show", "daily-tests"], root));

    expect(output).toContain("2026-03-28T09:00:00Z");
  });
});

// ── schedule validate ───────────────────────────────────────────────

describe("schedule validate", () => {
  it("reports OK for all valid files (exit 0)", () => {
    const root = makeTempProject();
    writeSchedule(root, "ci--daily-tests.md", VALID_SCHEDULE_1);
    writeSchedule(root, "analytics--weekly-report.md", VALID_SCHEDULE_2);

    // Should not throw / exit 1
    const output = captureStdout(() => cmdSchedule(["validate"], root));

    expect(output).toContain("OK:");
    expect(output).toContain("ci--daily-tests.md");
    expect(output).toContain("analytics--weekly-report.md");
    expect(output).not.toContain("ERROR:");
  });

  it("reports errors for malformed files (exit 1)", () => {
    const root = makeTempProject();
    writeSchedule(root, "ci--daily-tests.md", VALID_SCHEDULE_1);
    writeSchedule(
      root,
      "ci--broken.md",
      `# Broken Task (broken-task)

Some text but no Schedule field.
`,
    );

    const { stdout, code } = captureAll(() => cmdSchedule(["validate"], root));

    expect(code).toBe(1);
    expect(stdout).toContain("ERROR:");
    expect(stdout).toContain("ci--broken.md");
  });

  it("reports invalid schedule expression as error", () => {
    const root = makeTempProject();
    writeSchedule(
      root,
      "ci--bad-cron.md",
      `# Bad Cron (bad-cron)

**Schedule:** every potato at noon
**Priority:** High
**Domain:** ci
`,
    );

    const { stdout, code } = captureAll(() => cmdSchedule(["validate"], root));

    expect(code).toBe(1);
    expect(stdout).toContain("ERROR:");
    expect(stdout).toContain("ci--bad-cron.md");
  });

  it("reports missing heading ID as error", () => {
    const root = makeTempProject();
    writeSchedule(
      root,
      "ci--no-id.md",
      `# No ID Here

**Schedule:** every day at 09:00
**Priority:** High
**Domain:** ci
`,
    );

    const { stdout, code } = captureAll(() => cmdSchedule(["validate"], root));

    expect(code).toBe(1);
    expect(stdout).toContain("ERROR:");
    expect(stdout).toContain("missing or malformed heading");
  });
});

// ── schedule run ────────────────────────────────────────────────────

describe("schedule run", () => {
  it("writes trigger file when daemon is running", () => {
    const root = makeTempProject();
    writeSchedule(root, "ci--daily-tests.md", VALID_SCHEDULE_1);

    // Create a fake PID file with our own PID (so isDaemonRunning returns truthy)
    const home = process.env.HOME ?? "/tmp";
    const slug = root.replace(/\//g, "-");
    const pidDir = join(home, ".ninthwave", "projects", slug);
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, "orchestrator.pid"), String(process.pid));
    tempDirs.push(pidDir);

    const output = captureStdout(() => cmdSchedule(["run", "daily-tests"], root));

    expect(output).toContain("Trigger written");
    expect(output).toContain("daily-tests");

    // Verify trigger file was created
    const triggerPath = join(pidDir, "schedule-triggers", "daily-tests");
    expect(existsSync(triggerPath)).toBe(true);
    // Trigger file should contain an ISO timestamp
    const triggerContent = readFileSync(triggerPath, "utf-8");
    expect(triggerContent).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("errors when no daemon is running", () => {
    const root = makeTempProject();
    writeSchedule(root, "ci--daily-tests.md", VALID_SCHEDULE_1);

    // No PID file exists, so isDaemonRunning returns null
    const { stderr, code } = captureAll(() =>
      cmdSchedule(["run", "daily-tests"], root),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("No daemon running");
    expect(stderr).toContain("nw watch");
  });

  it("errors on invalid schedule ID", () => {
    const root = makeTempProject();
    writeSchedule(root, "ci--daily-tests.md", VALID_SCHEDULE_1);

    const { stderr, code } = captureAll(() =>
      cmdSchedule(["run", "nonexistent"], root),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("Schedule not found: nonexistent");
  });
});
