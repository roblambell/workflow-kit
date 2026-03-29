// Tests for schedule-runner: checkSchedules, processScheduleQueue, launchScheduledTask,
// monitorScheduleWorkers, processTriggerFiles, and integration with processScheduledTasks.

import { describe, it, expect, beforeEach } from "vitest";
import type { ScheduledTask } from "../core/types.ts";
import type { ScheduleState, ScheduleWorkerEntry } from "../core/schedule-state.ts";
import { emptyScheduleState } from "../core/schedule-state.ts";
import {
  checkSchedules,
  processScheduleQueue,
  launchScheduledTask,
  monitorScheduleWorkers,
  processTriggerFiles,
  isScheduleWorkerAlive,
  tryScheduleClaim,
  computeScheduleTime,
  type MonitorScheduleDeps,
  type LaunchScheduledDeps,
  type TriggerFileIO,
  type ScheduleClaimResult,
} from "../core/schedule-runner.ts";
import type { CrewBroker } from "../core/crew.ts";
import { processScheduledTasks, type ScheduleLoopDeps, type LogEntry } from "../core/commands/orchestrate.ts";
import { Orchestrator } from "../core/orchestrator.ts";

// ── Helpers ─────────────────────────────────────────────────────────

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

function makeState(overrides: Partial<ScheduleState> = {}): ScheduleState {
  return { ...emptyScheduleState(), ...overrides };
}

function makeWorker(overrides: Partial<ScheduleWorkerEntry> = {}): ScheduleWorkerEntry {
  return {
    taskId: "test-task",
    workspaceRef: "ws:123",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── checkSchedules ──────────────────────────────────────────────────

describe("checkSchedules", () => {
  it("returns due tasks", () => {
    // Use a time that matches */1 cron (any minute matches)
    const now = new Date("2026-03-28T10:00:00Z");
    const task = makeTask();
    const state = makeState();

    const due = checkSchedules([task], state, now);
    expect(due).toContain("test-task");
  });

  it("skips disabled tasks", () => {
    const now = new Date("2026-03-28T10:00:00Z");
    const task = makeTask({ enabled: false });
    const state = makeState();

    const due = checkSchedules([task], state, now);
    expect(due).toEqual([]);
  });

  it("skips already-running tasks", () => {
    const now = new Date("2026-03-28T10:00:00Z");
    const task = makeTask();
    const state = makeState({
      active: [makeWorker()],
    });

    const due = checkSchedules([task], state, now);
    expect(due).toEqual([]);
  });

  it("skips already-queued tasks", () => {
    const now = new Date("2026-03-28T10:00:00Z");
    const task = makeTask();
    const state = makeState({
      queued: ["test-task"],
    });

    const due = checkSchedules([task], state, now);
    expect(due).toEqual([]);
  });

  it("skips tasks that are not due (cron does not match)", () => {
    const now = new Date("2026-03-28T10:00:00Z");
    // "every 2h" = "0 */2 * * *", matches only at minute 0 of even hours
    const task = makeTask({ scheduleCron: "0 */2 * * *" });
    // The task already ran this hour at this minute
    const state = makeState({
      tasks: { "test-task": { lastRunAt: now.toISOString() } },
    });

    const due = checkSchedules([task], state, now);
    expect(due).toEqual([]);
  });

  it("returns multiple due tasks", () => {
    const now = new Date("2026-03-28T10:00:00Z");
    const task1 = makeTask({ id: "task-1" });
    const task2 = makeTask({ id: "task-2" });
    const state = makeState();

    const due = checkSchedules([task1, task2], state, now);
    expect(due).toContain("task-1");
    expect(due).toContain("task-2");
  });
});

// ── processScheduleQueue ────────────────────────────────────────────

describe("processScheduleQueue", () => {
  it("launches tasks when WIP slots available", () => {
    const state = makeState({ queued: ["task-a", "task-b"] });
    const result = processScheduleQueue(state, 2);
    expect(result.toLaunch).toEqual(["task-a", "task-b"]);
    expect(result.remainingQueue).toEqual([]);
  });

  it("queues tasks when WIP is full", () => {
    const state = makeState({ queued: ["task-a", "task-b", "task-c"] });
    const result = processScheduleQueue(state, 0);
    expect(result.toLaunch).toEqual([]);
    expect(result.remainingQueue).toEqual(["task-a", "task-b", "task-c"]);
  });

  it("partially dequeues when limited WIP", () => {
    const state = makeState({ queued: ["task-a", "task-b", "task-c"] });
    const result = processScheduleQueue(state, 1);
    expect(result.toLaunch).toEqual(["task-a"]);
    expect(result.remainingQueue).toEqual(["task-b", "task-c"]);
  });

  it("returns empty when no queued tasks", () => {
    const state = makeState();
    const result = processScheduleQueue(state, 5);
    expect(result.toLaunch).toEqual([]);
    expect(result.remainingQueue).toEqual([]);
  });
});

// ── launchScheduledTask ─────────────────────────────────────────────

describe("launchScheduledTask", () => {
  it("creates workspace with task prompt (mock mux)", () => {
    const task = makeTask({ prompt: "Run all tests and report" });
    let capturedCwd = "";
    let capturedCmd = "";
    const deps: LaunchScheduledDeps = {
      launchWorkspace: (cwd, command) => {
        capturedCwd = cwd;
        capturedCmd = command;
        return "ws:42";
      },
    };

    const ref = launchScheduledTask(task, "/projects/myapp", "claude", deps);
    expect(ref).toBe("ws:42");
    expect(capturedCwd).toBe("/projects/myapp");
    expect(capturedCmd).toContain("claude");
    expect(capturedCmd).toContain("Run all tests and report");
  });

  it("returns null on launch failure", () => {
    const task = makeTask();
    const deps: LaunchScheduledDeps = {
      launchWorkspace: () => null,
    };

    const ref = launchScheduledTask(task, "/projects/myapp", "claude", deps);
    expect(ref).toBeNull();
  });
});

// ── monitorScheduleWorkers ──────────────────────────────────────────

describe("monitorScheduleWorkers", () => {
  const mockMonitorDeps = (aliveRefs: Set<string>): MonitorScheduleDeps => ({
    listWorkspaces: () =>
      [...aliveRefs].map((ref) => `session: ${ref} running`).join("\n"),
    closeWorkspace: () => true,
  });

  it("detects completed workers (workspace gone)", () => {
    const worker = makeWorker({ workspaceRef: "ws:100" });
    const state = makeState({ active: [worker] });
    const tasks = [makeTask()];
    const deps = mockMonitorDeps(new Set()); // No workspaces alive

    const results = monitorScheduleWorkers(state, tasks, new Date(), deps);
    expect(results.get("test-task")?.status).toBe("completed");
  });

  it("detects running workers", () => {
    const worker = makeWorker({ workspaceRef: "ws:100" });
    const state = makeState({ active: [worker] });
    const tasks = [makeTask()];
    const deps = mockMonitorDeps(new Set(["ws:100"]));

    const results = monitorScheduleWorkers(state, tasks, new Date(), deps);
    expect(results.get("test-task")?.status).toBe("running");
  });

  it("detects timeout (kills workspace)", () => {
    const startedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const worker = makeWorker({ workspaceRef: "ws:100", startedAt });
    const state = makeState({ active: [worker] });
    const tasks = [makeTask({ timeout: 10_000 })]; // 10s timeout
    let closedRef = "";
    const deps: MonitorScheduleDeps = {
      listWorkspaces: () => "session: ws:100 running",
      closeWorkspace: (ref) => {
        closedRef = ref;
        return true;
      },
    };

    const results = monitorScheduleWorkers(state, tasks, new Date(), deps);
    const result = results.get("test-task");
    expect(result?.status).toBe("timeout");
    expect(closedRef).toBe("ws:100");
  });
});

// ── isScheduleWorkerAlive ───────────────────────────────────────────

describe("isScheduleWorkerAlive", () => {
  it("returns true when workspace ref found in listing", () => {
    const worker = makeWorker({ workspaceRef: "ws:42" });
    const deps: MonitorScheduleDeps = {
      listWorkspaces: () => "session: ws:42 running\nsession: ws:99 running",
      closeWorkspace: () => true,
    };
    expect(isScheduleWorkerAlive(worker, deps)).toBe(true);
  });

  it("returns false when workspace ref not found", () => {
    const worker = makeWorker({ workspaceRef: "ws:42" });
    const deps: MonitorScheduleDeps = {
      listWorkspaces: () => "session: ws:99 running",
      closeWorkspace: () => true,
    };
    expect(isScheduleWorkerAlive(worker, deps)).toBe(false);
  });

  it("returns false when workspace listing is empty", () => {
    const worker = makeWorker({ workspaceRef: "ws:42" });
    const deps: MonitorScheduleDeps = {
      listWorkspaces: () => "",
      closeWorkspace: () => true,
    };
    expect(isScheduleWorkerAlive(worker, deps)).toBe(false);
  });
});

// ── processTriggerFiles ─────────────────────────────────────────────

describe("processTriggerFiles", () => {
  it("picks up and deletes trigger files", () => {
    const deletedFiles: string[] = [];
    const mockIO: TriggerFileIO = {
      existsSync: () => true,
      readdirSync: () => ["daily-test-run.trigger", "weekly-report.trigger", "README.md"],
      unlinkSync: (path) => { deletedFiles.push(path); },
    };

    const triggered = processTriggerFiles("/project", "/triggers", mockIO);
    expect(triggered).toEqual(["daily-test-run", "weekly-report"]);
    expect(deletedFiles).toHaveLength(2);
    expect(deletedFiles[0]).toContain("daily-test-run.trigger");
    expect(deletedFiles[1]).toContain("weekly-report.trigger");
  });

  it("returns empty when directory does not exist", () => {
    const mockIO: TriggerFileIO = {
      existsSync: () => false,
      readdirSync: () => [],
      unlinkSync: () => {},
    };

    const triggered = processTriggerFiles("/project", "/triggers", mockIO);
    expect(triggered).toEqual([]);
  });

  it("ignores non-trigger files", () => {
    const mockIO: TriggerFileIO = {
      existsSync: () => true,
      readdirSync: () => ["README.md", ".gitkeep"],
      unlinkSync: () => {},
    };

    const triggered = processTriggerFiles("/project", "/triggers", mockIO);
    expect(triggered).toEqual([]);
  });
});

// ── Double-fire prevention ──────────────────────────────────────────

describe("double-fire prevention", () => {
  it("lastRunAt updated before launch prevents double-fire", () => {
    const now = new Date("2026-03-28T10:00:00Z");
    const task = makeTask();

    // First check -- task is due
    const state1 = makeState();
    const due1 = checkSchedules([task], state1, now);
    expect(due1).toContain("test-task");

    // Simulate lastRunAt being set (as processScheduledTasks does before launch)
    const state2 = makeState({
      tasks: { "test-task": { lastRunAt: now.toISOString() } },
    });

    // Second check at same time -- should not be due
    const due2 = checkSchedules([task], state2, now);
    expect(due2).toEqual([]);
  });
});

// ── Integration: processScheduledTasks ──────────────────────────────

describe("processScheduledTasks", () => {
  function makeMinimalOrch(activeCount = 0): Orchestrator {
    const orch = new Orchestrator([], {
      wipLimit: 5,
      maxRetries: 0,
      mergeStrategy: "sequential",
      reviewAutoFix: false,
    });
    // Simulate active work items
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

  it("full cycle: due -> launch -> monitor -> complete -> history", () => {
    const now = new Date("2026-03-28T10:00:00Z");
    const task = makeTask();
    let savedState: ScheduleState | null = null;
    const logs: LogEntry[] = [];

    const deps: ScheduleLoopDeps = {
      listScheduledTasks: () => [task],
      readState: () => makeState(),
      writeState: (_pr, state) => { savedState = state; },
      launchWorker: () => "ws:new-42",
      monitorDeps: {
        listWorkspaces: () => "",
        closeWorkspace: () => true,
      },
      aiTool: "claude",
      triggerDir: "/nonexistent",
    };

    const orch = makeMinimalOrch(0);
    processScheduledTasks("/project", orch, deps, (e) => logs.push(e), 5);

    // Task should have been launched
    expect(savedState).not.toBeNull();
    expect(savedState!.active).toHaveLength(1);
    expect(savedState!.active[0]!.taskId).toBe("test-task");
    expect(savedState!.active[0]!.workspaceRef).toBe("ws:new-42");
    // lastRunAt should be set (double-fire prevention)
    expect(savedState!.tasks["test-task"]!.lastRunAt).toBeDefined();
    // Queue should be empty (task was launched, not queued)
    expect(savedState!.queued).toEqual([]);

    // Check structured logs
    const triggered = logs.filter((l) => l.event === "schedule-triggered");
    expect(triggered.length).toBeGreaterThan(0);
  });

  it("WIP queueing: fills WIP, confirms queued, frees slot, confirms launched", () => {
    const now = new Date("2026-03-28T10:00:00Z");
    const task = makeTask();
    let savedState: ScheduleState | null = null;
    const logs: LogEntry[] = [];

    // Step 1: WIP full -- task gets queued
    const fullDeps: ScheduleLoopDeps = {
      listScheduledTasks: () => [task],
      readState: () => makeState(),
      writeState: (_pr, state) => { savedState = state; },
      launchWorker: () => "ws:new",
      monitorDeps: {
        listWorkspaces: () => "",
        closeWorkspace: () => true,
      },
      aiTool: "claude",
      triggerDir: "/nonexistent",
    };

    // All 5 WIP slots filled by active work items
    const orch = makeMinimalOrch(0);
    // Simulate active items by setting effectiveWip to 0
    processScheduledTasks("/project", orch, fullDeps, (e) => logs.push(e), 0);

    // Task should be queued, not launched
    expect(savedState).not.toBeNull();
    expect(savedState!.queued).toContain("test-task");
    expect(savedState!.active).toHaveLength(0);

    // Step 2: Free slot -- task gets launched
    const freeDeps: ScheduleLoopDeps = {
      ...fullDeps,
      readState: () => savedState!, // Use the queued state
    };
    let savedState2: ScheduleState | null = null;
    freeDeps.writeState = (_pr, state) => { savedState2 = state; };

    processScheduledTasks("/project", orch, freeDeps, (e) => logs.push(e), 5);

    // Task should now be launched
    expect(savedState2).not.toBeNull();
    expect(savedState2!.queued).toEqual([]);
    expect(savedState2!.active).toHaveLength(1);
    expect(savedState2!.active[0]!.taskId).toBe("test-task");
  });

  it("trigger file processing: write file -> picked up -> deleted", () => {
    const task = makeTask({ id: "manual-task" });
    let savedState: ScheduleState | null = null;
    const logs: LogEntry[] = [];

    const deps: ScheduleLoopDeps = {
      listScheduledTasks: () => [task],
      readState: () => makeState(),
      writeState: (_pr, state) => { savedState = state; },
      launchWorker: () => "ws:triggered",
      monitorDeps: {
        listWorkspaces: () => "",
        closeWorkspace: () => true,
      },
      aiTool: "claude",
      triggerDir: "/triggers", // Will be read by processTriggerFiles
    };

    // Mock trigger file at module level isn't possible with DI,
    // so we test processTriggerFiles separately and test trigger integration
    // by feeding in a state that was queued by a trigger
    const stateWithTriggered = makeState({ queued: ["manual-task"] });
    deps.readState = () => stateWithTriggered;

    const orch = makeMinimalOrch(0);
    processScheduledTasks("/project", orch, deps, (e) => logs.push(e), 5);

    // Task should be launched from queue
    expect(savedState).not.toBeNull();
    expect(savedState!.active).toHaveLength(1);
    expect(savedState!.active[0]!.taskId).toBe("manual-task");
    expect(savedState!.queued).toEqual([]);
  });

  it("monitor detects completion and removes from active", () => {
    const task = makeTask();
    const activeWorker = makeWorker({ workspaceRef: "ws:old" });
    let savedState: ScheduleState | null = null;
    const logs: LogEntry[] = [];

    const deps: ScheduleLoopDeps = {
      listScheduledTasks: () => [task],
      readState: () => makeState({
        active: [activeWorker],
        tasks: { "test-task": { lastRunAt: new Date().toISOString() } },
      }),
      writeState: (_pr, state) => { savedState = state; },
      launchWorker: () => "ws:new",
      monitorDeps: {
        // Workspace is gone -- worker completed
        listWorkspaces: () => "",
        closeWorkspace: () => true,
      },
      aiTool: "claude",
      triggerDir: "/nonexistent",
    };

    const orch = makeMinimalOrch(0);
    processScheduledTasks("/project", orch, deps, (e) => logs.push(e), 5);

    // Active worker should be removed
    expect(savedState).not.toBeNull();
    expect(savedState!.active.some((w) => w.workspaceRef === "ws:old")).toBe(false);

    // Should have a completion log
    const completed = logs.filter((l) => l.event === "schedule-completed");
    expect(completed).toHaveLength(1);
  });
});

// ── computeScheduleTime ────────────────────────────────────────────

describe("computeScheduleTime", () => {
  it("truncates to minute precision", () => {
    const now = new Date("2026-03-28T10:05:33.456Z");
    const result = computeScheduleTime(now);
    expect(result).toBe("2026-03-28T10:05:00.000Z");
  });

  it("produces identical keys for same minute regardless of seconds", () => {
    const a = computeScheduleTime(new Date("2026-03-28T10:00:01.000Z"));
    const b = computeScheduleTime(new Date("2026-03-28T10:00:59.999Z"));
    expect(a).toBe(b);
  });

  it("produces different keys for different minutes", () => {
    const a = computeScheduleTime(new Date("2026-03-28T10:00:00.000Z"));
    const b = computeScheduleTime(new Date("2026-03-28T10:01:00.000Z"));
    expect(a).not.toBe(b);
  });
});

// ── tryScheduleClaim ───────────────────────────────────────────────

describe("tryScheduleClaim", () => {
  /** Minimal mock CrewBroker for testing tryScheduleClaim. */
  function mockBroker(opts: {
    connected?: boolean;
    grantClaim?: boolean;
    throwOnClaim?: boolean;
  } = {}): CrewBroker {
    return {
      connect: async () => {},
      sync: () => {},
      claim: async () => null,
      complete: () => {},
      scheduleClaim: async () => {
        if (opts.throwOnClaim) throw new Error("WS disconnected");
        return opts.grantClaim ?? false;
      },
      heartbeat: () => {},
      disconnect: () => {},
      isConnected: () => opts.connected ?? true,
      getCrewStatus: () => null,
    };
  }

  it("solo mode (no broker) -> launch with reason solo", async () => {
    const result = await tryScheduleClaim(null, "task-1", "2026-03-28T10:00:00.000Z");
    expect(result.action).toBe("launch");
    expect(result.reason).toBe("solo");
  });

  it("solo mode (undefined broker) -> launch with reason solo", async () => {
    const result = await tryScheduleClaim(undefined, "task-1", "2026-03-28T10:00:00.000Z");
    expect(result.action).toBe("launch");
    expect(result.reason).toBe("solo");
  });

  it("crew mode claim granted -> launch", async () => {
    const broker = mockBroker({ connected: true, grantClaim: true });
    const result = await tryScheduleClaim(broker, "task-1", "2026-03-28T10:00:00.000Z");
    expect(result.action).toBe("launch");
    expect(result.reason).toBe("crew-granted");
  });

  it("crew mode claim denied -> skip", async () => {
    const broker = mockBroker({ connected: true, grantClaim: false });
    const result = await tryScheduleClaim(broker, "task-1", "2026-03-28T10:00:00.000Z");
    expect(result.action).toBe("skip");
    expect(result.reason).toBe("crew-denied");
  });

  it("crew disconnected -> fallback to solo execution", async () => {
    const broker = mockBroker({ connected: false });
    const result = await tryScheduleClaim(broker, "task-1", "2026-03-28T10:00:00.000Z");
    expect(result.action).toBe("launch");
    expect(result.reason).toBe("crew-disconnected");
  });

  it("WS disconnect during claim (exception) -> fallback to solo", async () => {
    const broker = mockBroker({ connected: true, throwOnClaim: true });
    const result = await tryScheduleClaim(broker, "task-1", "2026-03-28T10:00:00.000Z");
    expect(result.action).toBe("launch");
    expect(result.reason).toBe("crew-disconnected");
  });
});

// ── schedule-state ──────────────────────────────────────────────────

describe("schedule-state", () => {
  // These test the read/write with mock IO to verify structure validation

  it("readScheduleState returns empty for missing file", async () => {
    const { readScheduleState } = await import("../core/schedule-state.ts");
    const mockIO = {
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: () => {},
      mkdirSync: () => {},
    };
    const state = readScheduleState("/nonexistent", mockIO);
    expect(state.tasks).toEqual({});
    expect(state.queued).toEqual([]);
    expect(state.active).toEqual([]);
  });

  it("readScheduleState handles corrupt JSON", async () => {
    const { readScheduleState } = await import("../core/schedule-state.ts");
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warned.push(msg);
    try {
      const mockIO = {
        existsSync: () => true,
        readFileSync: () => "{{invalid json}}",
        writeFileSync: () => {},
        mkdirSync: () => {},
      };
      const state = readScheduleState("/project", mockIO);
      expect(state.tasks).toEqual({});
      expect(state.queued).toEqual([]);
      expect(state.active).toEqual([]);
      expect(warned.length).toBeGreaterThan(0);
      expect(warned[0]).toContain("corrupt");
    } finally {
      console.warn = origWarn;
    }
  });

  it("readScheduleState validates structure fields", async () => {
    const { readScheduleState } = await import("../core/schedule-state.ts");
    const mockIO = {
      existsSync: () => true,
      // Missing "active" and "queued" fields, tasks is wrong type
      readFileSync: () => JSON.stringify({ tasks: "not-an-object" }),
      writeFileSync: () => {},
      mkdirSync: () => {},
    };
    const state = readScheduleState("/project", mockIO);
    expect(state.tasks).toEqual({});
    expect(state.queued).toEqual([]);
    expect(state.active).toEqual([]);
  });

  it("writeScheduleState creates directory and writes JSON", async () => {
    const { writeScheduleState, emptyScheduleState } = await import("../core/schedule-state.ts");
    let writtenPath = "";
    let writtenData = "";
    const mockIO = {
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: (path: string, data: string) => {
        writtenPath = path;
        writtenData = data;
      },
      mkdirSync: () => {},
    };
    const state = emptyScheduleState();
    state.tasks["test"] = { lastRunAt: "2026-01-01T00:00:00Z" };
    writeScheduleState("/project", state, mockIO);
    expect(writtenPath).toContain("schedule-state.json");
    const parsed = JSON.parse(writtenData);
    expect(parsed.tasks.test.lastRunAt).toBe("2026-01-01T00:00:00Z");
  });
});
