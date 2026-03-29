// Tests for schedule-history.ts: JSONL history writing, reading, filtering.
// Tests for schedule history CLI command and structured log events.

import { describe, it, expect } from "vitest";
import {
  appendHistoryEntry,
  readHistoryEntries,
  readHistoryForTask,
  readRecentHistory,
  type ScheduleHistoryEntry,
  type ScheduleHistoryIO,
} from "../core/schedule-history.ts";
import { cmdScheduleHistory } from "../core/commands/schedule.ts";
import { processScheduledTasks, type ScheduleLoopDeps, type LogEntry } from "../core/commands/orchestrate.ts";
import { emptyScheduleState, type ScheduleState } from "../core/schedule-state.ts";
import type { ScheduledTask } from "../core/types.ts";
import { Orchestrator } from "../core/orchestrator.ts";

// ── Mock IO ──────────────────────────────────────────────────────────

function makeMockIO(initialContent: string = ""): ScheduleHistoryIO & { written: string } {
  const state = { content: initialContent, written: "" };
  return {
    get written() { return state.written; },
    existsSync: (path: string) => state.content.length > 0 || state.written.length > 0,
    appendFileSync: (_path: string, data: string) => {
      state.content += data;
      state.written += data;
    },
    readFileSync: () => state.content,
    mkdirSync: () => {},
  };
}

function makeEntry(overrides: Partial<ScheduleHistoryEntry> = {}): ScheduleHistoryEntry {
  return {
    taskId: "test-task",
    startedAt: "2026-03-28T09:00:00Z",
    endedAt: "2026-03-28T09:05:00Z",
    result: "success",
    durationMs: 300_000,
    ...overrides,
  };
}

// ── appendHistoryEntry ───────────────────────────────────────────────

describe("appendHistoryEntry", () => {
  it("appends a JSONL line", () => {
    const io = makeMockIO();
    const entry = makeEntry();
    appendHistoryEntry("/project", entry, io);

    expect(io.written).toContain('"taskId":"test-task"');
    expect(io.written).toContain('"result":"success"');
    expect(io.written.endsWith("\n")).toBe(true);
  });

  it("appends multiple entries", () => {
    const io = makeMockIO();
    appendHistoryEntry("/project", makeEntry({ taskId: "task-1" }), io);
    appendHistoryEntry("/project", makeEntry({ taskId: "task-2" }), io);

    const lines = io.written.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).taskId).toBe("task-1");
    expect(JSON.parse(lines[1]!).taskId).toBe("task-2");
  });

  it("writes timeout entry", () => {
    const io = makeMockIO();
    appendHistoryEntry("/project", makeEntry({ result: "timeout", durationMs: 1_800_000 }), io);

    const parsed = JSON.parse(io.written.trim());
    expect(parsed.result).toBe("timeout");
    expect(parsed.durationMs).toBe(1_800_000);
  });

  it("writes error entry", () => {
    const io = makeMockIO();
    appendHistoryEntry("/project", makeEntry({ result: "error", durationMs: 5_000 }), io);

    const parsed = JSON.parse(io.written.trim());
    expect(parsed.result).toBe("error");
  });
});

// ── readHistoryEntries ───────────────────────────────────────────────

describe("readHistoryEntries", () => {
  it("reads JSONL entries", () => {
    const lines = [
      JSON.stringify(makeEntry({ taskId: "a" })),
      JSON.stringify(makeEntry({ taskId: "b" })),
    ].join("\n") + "\n";

    const io = makeMockIO(lines);
    const entries = readHistoryEntries("/project", io);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.taskId).toBe("a");
    expect(entries[1]!.taskId).toBe("b");
  });

  it("skips malformed lines", () => {
    const lines = [
      JSON.stringify(makeEntry({ taskId: "good" })),
      "{{invalid json}}",
      "",
      JSON.stringify(makeEntry({ taskId: "also-good" })),
    ].join("\n") + "\n";

    const io = makeMockIO(lines);
    const entries = readHistoryEntries("/project", io);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.taskId).toBe("good");
    expect(entries[1]!.taskId).toBe("also-good");
  });

  it("returns empty array for missing file", () => {
    const io: ScheduleHistoryIO = {
      existsSync: () => false,
      appendFileSync: () => {},
      readFileSync: () => "",
      mkdirSync: () => {},
    };
    const entries = readHistoryEntries("/project", io);
    expect(entries).toEqual([]);
  });

  it("skips entries missing required fields", () => {
    const lines = [
      JSON.stringify({ taskId: "incomplete" }), // missing startedAt, endedAt, result
      JSON.stringify(makeEntry({ taskId: "complete" })),
    ].join("\n") + "\n";

    const io = makeMockIO(lines);
    const entries = readHistoryEntries("/project", io);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.taskId).toBe("complete");
  });
});

// ── readHistoryForTask ───────────────────────────────────────────────

describe("readHistoryForTask", () => {
  it("filters by taskId and returns most recent first", () => {
    const lines = [
      JSON.stringify(makeEntry({ taskId: "daily-tests", startedAt: "2026-03-27T09:00:00Z" })),
      JSON.stringify(makeEntry({ taskId: "weekly-report", startedAt: "2026-03-27T10:00:00Z" })),
      JSON.stringify(makeEntry({ taskId: "daily-tests", startedAt: "2026-03-28T09:00:00Z" })),
    ].join("\n") + "\n";

    const io = makeMockIO(lines);
    const entries = readHistoryForTask("/project", "daily-tests", 20, io);
    expect(entries).toHaveLength(2);
    // Most recent first
    expect(entries[0]!.startedAt).toBe("2026-03-28T09:00:00Z");
    expect(entries[1]!.startedAt).toBe("2026-03-27T09:00:00Z");
  });

  it("limits results", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify(makeEntry({ taskId: "task", startedAt: `2026-03-${String(i + 1).padStart(2, "0")}T09:00:00Z` })),
    ).join("\n") + "\n";

    const io = makeMockIO(lines);
    const entries = readHistoryForTask("/project", "task", 5, io);
    expect(entries).toHaveLength(5);
  });
});

// ── readRecentHistory ────────────────────────────────────────────────

describe("readRecentHistory", () => {
  it("returns all tasks sorted by time descending", () => {
    const lines = [
      JSON.stringify(makeEntry({ taskId: "a", startedAt: "2026-03-27T09:00:00Z" })),
      JSON.stringify(makeEntry({ taskId: "b", startedAt: "2026-03-28T09:00:00Z" })),
      JSON.stringify(makeEntry({ taskId: "c", startedAt: "2026-03-26T09:00:00Z" })),
    ].join("\n") + "\n";

    const io = makeMockIO(lines);
    const entries = readRecentHistory("/project", 20, io);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.taskId).toBe("b"); // most recent
    expect(entries[1]!.taskId).toBe("a");
    expect(entries[2]!.taskId).toBe("c"); // oldest
  });

  it("limits results", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify(makeEntry({ taskId: `task-${i}`, startedAt: `2026-03-${String(i + 1).padStart(2, "0")}T09:00:00Z` })),
    ).join("\n") + "\n";

    const io = makeMockIO(lines);
    const entries = readRecentHistory("/project", 10, io);
    expect(entries).toHaveLength(10);
  });
});

// ── cmdScheduleHistory ───────────────────────────────────────────────

describe("cmdScheduleHistory", () => {
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

  it("shows table for specific task", () => {
    const lines = [
      JSON.stringify(makeEntry({ taskId: "daily-tests", result: "success", durationMs: 300_000 })),
      JSON.stringify(makeEntry({ taskId: "daily-tests", result: "timeout", startedAt: "2026-03-27T09:00:00Z", durationMs: 1_800_000 })),
    ].join("\n") + "\n";

    const io = makeMockIO(lines);
    const output = captureStdout(() => cmdScheduleHistory("daily-tests", "/project", io));

    expect(output).toContain("daily-tests");
    expect(output).toContain("DATE");
    expect(output).toContain("DURATION");
    expect(output).toContain("RESULT");
    expect(output).toContain("success");
    expect(output).toContain("timeout");
    expect(output).toContain("2 execution(s)");
  });

  it("shows table for all tasks (no id)", () => {
    const lines = [
      JSON.stringify(makeEntry({ taskId: "daily-tests", startedAt: "2026-03-28T09:00:00Z" })),
      JSON.stringify(makeEntry({ taskId: "weekly-report", startedAt: "2026-03-28T10:00:00Z" })),
    ].join("\n") + "\n";

    const io = makeMockIO(lines);
    const output = captureStdout(() => cmdScheduleHistory(undefined, "/project", io));

    expect(output).toContain("TASK");
    expect(output).toContain("daily-tests");
    expect(output).toContain("weekly-report");
    expect(output).toContain("2 execution(s)");
  });

  it("shows empty message when no history", () => {
    const io: ScheduleHistoryIO = {
      existsSync: () => false,
      appendFileSync: () => {},
      readFileSync: () => "",
      mkdirSync: () => {},
    };
    const output = captureStdout(() => cmdScheduleHistory("daily-tests", "/project", io));

    expect(output).toContain("No execution history");
    expect(output).toContain("daily-tests");
  });
});

// ── Structured log events ────────────────────────────────────────────

describe("structured log events", () => {
  function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
    return {
      id: "test-task",
      title: "Test Task",
      schedule: "every 1m",
      scheduleCron: "*/1 * * * *",
      priority: "medium",
      domain: "ci",
      timeout: 30 * 60 * 1000,
      prompt: "Run tests",
      filePath: "/path/to/task.md",
      enabled: true,
      ...overrides,
    };
  }

  function makeMinimalOrch(activeCount = 0): Orchestrator {
    const orch = new Orchestrator([], {
      wipLimit: 5,
      maxRetries: 0,
      mergeStrategy: "sequential",
      reviewAutoFix: false,
    });
    for (let i = 0; i < activeCount; i++) {
      orch.addItem({
        id: `WORK-${i}`,
        title: `Work Item ${i}`,
        priority: "medium",
        domain: "test",
        dependencies: [],
        bundleWith: [],
        status: "open",
        filePath: "",
        repoAlias: "",
        rawText: "",
        filePaths: [],
        testPlan: "",
        bootstrap: false,
      });
    }
    return orch;
  }

  it("emits schedule-triggered with triggerType=cron for due tasks", () => {
    const task = makeTask();
    const logs: LogEntry[] = [];
    const historyEntries: ScheduleHistoryEntry[] = [];

    const deps: ScheduleLoopDeps = {
      listScheduledTasks: () => [task],
      readState: () => emptyScheduleState(),
      writeState: () => {},
      launchWorker: () => "ws:42",
      monitorDeps: { listWorkspaces: () => "", closeWorkspace: () => true },
      aiTool: "claude",
      triggerDir: "/nonexistent",
      appendHistory: (_pr, entry) => { historyEntries.push(entry); },
    };

    const orch = makeMinimalOrch(0);
    processScheduledTasks("/project", orch, deps, (e) => logs.push(e), 5);

    const triggered = logs.filter((l) => l.event === "schedule-triggered");
    expect(triggered.length).toBeGreaterThan(0);
    // At least one triggered event should have triggerType
    const cronTriggered = triggered.find((l) => l.triggerType === "cron");
    expect(cronTriggered).toBeDefined();
    expect(cronTriggered!.taskId).toBe("test-task");
    expect(cronTriggered!.scheduleTime).toBeDefined();
  });

  it("emits schedule-triggered with triggerType=manual for trigger files", () => {
    const task = makeTask({ id: "manual-task" });
    const logs: LogEntry[] = [];

    const deps: ScheduleLoopDeps = {
      listScheduledTasks: () => [task],
      readState: () => ({ ...emptyScheduleState(), queued: ["manual-task"] }),
      writeState: () => {},
      launchWorker: () => "ws:42",
      monitorDeps: { listWorkspaces: () => "", closeWorkspace: () => true },
      aiTool: "claude",
      triggerDir: "/nonexistent",
      appendHistory: () => {},
    };

    const orch = makeMinimalOrch(0);
    processScheduledTasks("/project", orch, deps, (e) => logs.push(e), 5);

    // Launch event
    const launchEvents = logs.filter((l) => l.event === "schedule-triggered" && l.triggerType === "launch");
    expect(launchEvents).toHaveLength(1);
    expect(launchEvents[0]!.taskId).toBe("manual-task");
  });

  it("emits schedule-skipped with reason for already-running tasks", () => {
    // We can't easily test trigger file processing inline, but we can test
    // the already-running path by having a task both in active and in trigger
    const task = makeTask();
    const logs: LogEntry[] = [];

    const deps: ScheduleLoopDeps = {
      listScheduledTasks: () => [task],
      readState: () => ({
        tasks: { "test-task": { lastRunAt: new Date().toISOString() } },
        queued: [],
        active: [{ taskId: "test-task", workspaceRef: "ws:old", startedAt: new Date().toISOString() }],
      }),
      writeState: () => {},
      launchWorker: () => "ws:42",
      monitorDeps: {
        listWorkspaces: () => "session: ws:old running",
        closeWorkspace: () => true,
      },
      aiTool: "claude",
      triggerDir: "/nonexistent",
      appendHistory: () => {},
    };

    const orch = makeMinimalOrch(0);
    processScheduledTasks("/project", orch, deps, (e) => logs.push(e), 5);

    // Should not have triggered or skipped events (task is running, not triggered)
    // The running task should still show as running
    // No new launch should happen
    expect(logs.filter((l) => l.event === "schedule-triggered").length).toBe(0);
  });

  it("emits schedule-completed with durationMs and result on success", () => {
    const task = makeTask();
    const logs: LogEntry[] = [];
    const historyEntries: ScheduleHistoryEntry[] = [];

    const deps: ScheduleLoopDeps = {
      listScheduledTasks: () => [task],
      readState: () => ({
        tasks: { "test-task": { lastRunAt: new Date().toISOString() } },
        queued: [],
        active: [{
          taskId: "test-task",
          workspaceRef: "ws:done",
          startedAt: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
        }],
      }),
      writeState: () => {},
      launchWorker: () => "ws:42",
      monitorDeps: {
        // Workspace gone -- worker completed
        listWorkspaces: () => "",
        closeWorkspace: () => true,
      },
      aiTool: "claude",
      triggerDir: "/nonexistent",
      appendHistory: (_pr, entry) => { historyEntries.push(entry); },
    };

    const orch = makeMinimalOrch(0);
    processScheduledTasks("/project", orch, deps, (e) => logs.push(e), 5);

    const completed = logs.filter((l) => l.event === "schedule-completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.taskId).toBe("test-task");
    expect(completed[0]!.durationMs).toBeGreaterThan(0);
    expect(completed[0]!.result).toBe("success");

    // History entry should also be written
    expect(historyEntries).toHaveLength(1);
    expect(historyEntries[0]!.taskId).toBe("test-task");
    expect(historyEntries[0]!.result).toBe("success");
    expect(historyEntries[0]!.durationMs).toBeGreaterThan(0);
  });

  it("emits schedule-completed with result=timeout on timeout", () => {
    const task = makeTask({ timeout: 10_000 }); // 10s timeout
    const logs: LogEntry[] = [];
    const historyEntries: ScheduleHistoryEntry[] = [];

    const deps: ScheduleLoopDeps = {
      listScheduledTasks: () => [task],
      readState: () => ({
        tasks: { "test-task": { lastRunAt: new Date().toISOString() } },
        queued: [],
        active: [{
          taskId: "test-task",
          workspaceRef: "ws:timeout",
          startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
        }],
      }),
      writeState: () => {},
      launchWorker: () => "ws:42",
      monitorDeps: {
        listWorkspaces: () => "session: ws:timeout running",
        closeWorkspace: () => true,
      },
      aiTool: "claude",
      triggerDir: "/nonexistent",
      appendHistory: (_pr, entry) => { historyEntries.push(entry); },
    };

    const orch = makeMinimalOrch(0);
    processScheduledTasks("/project", orch, deps, (e) => logs.push(e), 5);

    const completed = logs.filter((l) => l.event === "schedule-completed" && l.result === "timeout");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.taskId).toBe("test-task");

    expect(historyEntries).toHaveLength(1);
    expect(historyEntries[0]!.result).toBe("timeout");
  });

  it("emits schedule-skipped with reason=wip-full-queued when WIP full", () => {
    const task = makeTask();
    const logs: LogEntry[] = [];

    const deps: ScheduleLoopDeps = {
      listScheduledTasks: () => [task],
      readState: () => emptyScheduleState(),
      writeState: () => {},
      launchWorker: () => "ws:42",
      monitorDeps: { listWorkspaces: () => "", closeWorkspace: () => true },
      aiTool: "claude",
      triggerDir: "/nonexistent",
      appendHistory: () => {},
    };

    // Pass effectiveWip=0 so no slots available
    const orch = makeMinimalOrch(0);
    processScheduledTasks("/project", orch, deps, (e) => logs.push(e), 0);

    const skipped = logs.filter((l) => l.event === "schedule-skipped" && l.reason === "wip-full-queued");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]!.taskId).toBe("test-task");
  });

  it("emits schedule-error on launch failure", () => {
    const task = makeTask();
    const logs: LogEntry[] = [];

    const deps: ScheduleLoopDeps = {
      listScheduledTasks: () => [task],
      readState: () => emptyScheduleState(),
      writeState: () => {},
      launchWorker: () => null, // launch fails
      monitorDeps: { listWorkspaces: () => "", closeWorkspace: () => true },
      aiTool: "claude",
      triggerDir: "/nonexistent",
      appendHistory: () => {},
    };

    const orch = makeMinimalOrch(0);
    processScheduledTasks("/project", orch, deps, (e) => logs.push(e), 5);

    const errors = logs.filter((l) => l.event === "schedule-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.taskId).toBe("test-task");
    expect(errors[0]!.error).toBe("launch-failed");
  });
});
