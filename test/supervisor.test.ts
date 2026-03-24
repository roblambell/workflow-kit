// Tests for core/supervisor.ts — Supervisor tick, prompt construction,
// response parsing, action application, friction logging, and interval logic.
// Uses dependency injection (no vi.mock) per project conventions.

import { describe, it, expect, vi } from "vitest";
import {
  buildSupervisorPrompt,
  parseSupervisorResponse,
  supervisorTick,
  applySupervisorActions,
  writeFrictionLog,
  shouldActivateSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type SupervisorDeps,
  type SupervisorState,
  type SupervisorObservation,
} from "../core/supervisor.ts";
import {
  orchestrateLoop,
  type LogEntry,
  type OrchestrateLoopDeps,
  type OrchestrateLoopConfig,
} from "../core/commands/orchestrate.ts";
import {
  Orchestrator,
  type PollSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
  type OrchestratorItem,
} from "../core/orchestrator.ts";
import type { TodoItem } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTodo(id: string, deps: string[] = []): TodoItem {
  return {
    id,
    priority: "high",
    title: `TODO ${id}`,
    domain: "test",
    dependencies: deps,
    bundleWith: [],
    status: "open",
    lineNumber: 1,
    lineEndNumber: 5,
    repoAlias: "",
    rawText: `## ${id}\nTest todo`,
    filePaths: [],
  };
}

function makeItem(id: string, state: string, overrides?: Partial<OrchestratorItem>): OrchestratorItem {
  return {
    id,
    todo: makeTodo(id),
    state: state as OrchestratorItem["state"],
    lastTransition: new Date(Date.now() - 600_000).toISOString(), // 10 min ago
    ciFailCount: 0,
    ...overrides,
  };
}

function mockSupervisorDeps(overrides?: Partial<SupervisorDeps>): SupervisorDeps {
  return {
    callLLM: vi.fn(() => JSON.stringify({
      anomalies: [],
      interventions: [],
      frictionObservations: [],
      processImprovements: [],
    })),
    now: () => new Date("2026-03-24T12:00:00Z"),
    log: vi.fn(),
    appendFile: vi.fn(),
    ...overrides,
  };
}

function mockActionDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    launchSingleItem: vi.fn(() => ({
      worktreePath: "/tmp/test/todo-test",
      workspaceRef: "workspace:1",
    })),
    cleanSingleWorktree: vi.fn(() => true),
    cmdMarkDone: vi.fn(),
    prMerge: vi.fn(() => true),
    prComment: vi.fn(() => true),
    sendMessage: vi.fn(() => true),
    closeWorkspace: vi.fn(() => true),
    fetchOrigin: vi.fn(),
    ffMerge: vi.fn(),
    ...overrides,
  };
}

const defaultCtx: ExecutionContext = {
  projectRoot: "/tmp/test-project",
  worktreeDir: "/tmp/test-project/.worktrees",
  todosFile: "/tmp/test-project/TODOS.md",
  aiTool: "claude",
};

// ── buildSupervisorPrompt ────────────────────────────────────────────

describe("buildSupervisorPrompt", () => {
  it("includes item states and elapsed times", () => {
    const items = [
      makeItem("A-1-1", "implementing", { prNumber: 42 }),
      makeItem("A-1-2", "ci-pending"),
    ];

    const elapsed = new Map<string, number>();
    elapsed.set("A-1-1", 600_000); // 10 min
    elapsed.set("A-1-2", 120_000); // 2 min

    const prompt = buildSupervisorPrompt([], items, elapsed);

    expect(prompt).toContain("A-1-1: state=implementing, elapsed=10min");
    expect(prompt).toContain("PR=#42");
    expect(prompt).toContain("A-1-2: state=ci-pending, elapsed=2min");
  });

  it("includes recent log entries", () => {
    const logs: LogEntry[] = [
      { ts: "2026-03-24T12:00:00Z", level: "info", event: "transition", itemId: "A-1-1", from: "launching", to: "implementing" },
    ];

    const prompt = buildSupervisorPrompt(logs, [], new Map());

    expect(prompt).toContain("transition");
    expect(prompt).toContain("A-1-1");
  });

  it("shows placeholder when no logs", () => {
    const prompt = buildSupervisorPrompt([], [], new Map());

    expect(prompt).toContain("(no recent log entries)");
  });

  it("includes all four analysis categories in instructions", () => {
    const prompt = buildSupervisorPrompt([], [], new Map());

    expect(prompt).toContain("anomalies");
    expect(prompt).toContain("interventions");
    expect(prompt).toContain("frictionObservations");
    expect(prompt).toContain("processImprovements");
  });
});

// ── parseSupervisorResponse ──────────────────────────────────────────

describe("parseSupervisorResponse", () => {
  it("parses valid JSON response", () => {
    const response = JSON.stringify({
      anomalies: ["Worker A-1-1 stuck in implementing for 15 minutes"],
      interventions: [{ type: "send-message", itemId: "A-1-1", message: "Are you stuck?" }],
      frictionObservations: ["CI takes 3 minutes on average"],
      processImprovements: ["Add TypeScript strict mode to CLAUDE.md"],
    });

    const result = parseSupervisorResponse(response);

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toContain("stuck");
    expect(result.interventions).toHaveLength(1);
    expect(result.interventions[0]!.type).toBe("send-message");
    expect(result.frictionObservations).toHaveLength(1);
    expect(result.processImprovements).toHaveLength(1);
  });

  it("handles markdown-fenced JSON", () => {
    const response = '```json\n{"anomalies": ["test"], "interventions": [], "frictionObservations": [], "processImprovements": []}\n```';

    const result = parseSupervisorResponse(response);

    expect(result.anomalies).toEqual(["test"]);
  });

  it("returns empty observation for malformed JSON", () => {
    const result = parseSupervisorResponse("this is not json at all");

    expect(result.anomalies).toEqual([]);
    expect(result.interventions).toEqual([]);
    expect(result.frictionObservations).toEqual([]);
    expect(result.processImprovements).toEqual([]);
  });

  it("handles partial fields gracefully", () => {
    const response = JSON.stringify({ anomalies: ["stuck"] });

    const result = parseSupervisorResponse(response);

    expect(result.anomalies).toEqual(["stuck"]);
    expect(result.interventions).toEqual([]);
    expect(result.frictionObservations).toEqual([]);
    expect(result.processImprovements).toEqual([]);
  });

  it("handles empty string response", () => {
    const result = parseSupervisorResponse("");

    expect(result.anomalies).toEqual([]);
  });
});

// ── supervisorTick ───────────────────────────────────────────────────

describe("supervisorTick", () => {
  it("calls LLM with constructed prompt and returns observation", () => {
    const callLLM = vi.fn(() => JSON.stringify({
      anomalies: ["Worker X stuck"],
      interventions: [],
      frictionObservations: ["slow CI"],
      processImprovements: [],
    }));

    const deps = mockSupervisorDeps({ callLLM });
    const state: SupervisorState = {
      lastTickTime: new Date("2026-03-24T11:55:00Z"),
      logsSinceLastTick: [
        { ts: "2026-03-24T11:56:00Z", level: "info", event: "transition" },
      ],
    };

    const items = [makeItem("X-1-1", "implementing")];
    const result = supervisorTick(state, items, deps);

    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(result.anomalies).toEqual(["Worker X stuck"]);
    expect(result.frictionObservations).toEqual(["slow CI"]);
  });

  it("logs supervisor_tick event on success", () => {
    const log = vi.fn();
    const deps = mockSupervisorDeps({ log });
    const state: SupervisorState = {
      lastTickTime: new Date("2026-03-24T11:55:00Z"),
      logsSinceLastTick: [],
    };

    supervisorTick(state, [], deps);

    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "supervisor_tick",
      status: "ok",
    }));
  });

  it("clears logsSinceLastTick after successful tick", () => {
    const deps = mockSupervisorDeps();
    const state: SupervisorState = {
      lastTickTime: new Date("2026-03-24T11:55:00Z"),
      logsSinceLastTick: [
        { ts: "2026-03-24T11:56:00Z", level: "info", event: "test" },
      ],
    };

    supervisorTick(state, [], deps);

    expect(state.logsSinceLastTick).toHaveLength(0);
  });

  it("updates lastTickTime after successful tick", () => {
    const fixedNow = new Date("2026-03-24T12:00:00Z");
    const deps = mockSupervisorDeps({ now: () => fixedNow });
    const state: SupervisorState = {
      lastTickTime: new Date("2026-03-24T11:55:00Z"),
      logsSinceLastTick: [],
    };

    supervisorTick(state, [], deps);

    expect(state.lastTickTime).toBe(fixedNow);
  });

  it("returns empty observation when LLM call fails", () => {
    const callLLM = vi.fn(() => null);
    const log = vi.fn();
    const deps = mockSupervisorDeps({ callLLM, log });
    const state: SupervisorState = {
      lastTickTime: new Date("2026-03-24T11:55:00Z"),
      logsSinceLastTick: [],
    };

    const result = supervisorTick(state, [], deps);

    expect(result.anomalies).toEqual([]);
    expect(result.interventions).toEqual([]);
    // Should still log the failure
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "supervisor_tick",
      status: "llm_call_failed",
    }));
  });

  it("computes elapsed time per item from lastTransition", () => {
    const fixedNow = new Date("2026-03-24T12:00:00Z");
    let capturedPrompt = "";
    const callLLM = vi.fn((prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        anomalies: [],
        interventions: [],
        frictionObservations: [],
        processImprovements: [],
      });
    });

    const deps = mockSupervisorDeps({ callLLM, now: () => fixedNow });
    const state: SupervisorState = {
      lastTickTime: new Date("2026-03-24T11:55:00Z"),
      logsSinceLastTick: [],
    };

    // Item with lastTransition 15 minutes ago
    const item = makeItem("T-1-1", "implementing", {
      lastTransition: new Date("2026-03-24T11:45:00Z").toISOString(),
    });

    supervisorTick(state, [item], deps);

    expect(capturedPrompt).toContain("elapsed=15min");
  });
});

// ── applySupervisorActions ───────────────────────────────────────────

describe("applySupervisorActions", () => {
  it("sends messages for send-message interventions", () => {
    const sendMessage = vi.fn(() => true);
    const log = vi.fn();

    const observation: SupervisorObservation = {
      anomalies: [],
      interventions: [
        { type: "send-message", itemId: "A-1-1", message: "Are you stuck?" },
      ],
      frictionObservations: [],
      processImprovements: [],
    };

    const items = [makeItem("A-1-1", "implementing", { workspaceRef: "workspace:1" })];

    const count = applySupervisorActions(observation, items, sendMessage, log);

    expect(sendMessage).toHaveBeenCalledWith("workspace:1", "Are you stuck?");
    expect(count).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "supervisor_action",
      actionType: "send-message",
    }));
  });

  it("skips send-message when item has no workspaceRef", () => {
    const sendMessage = vi.fn(() => true);
    const log = vi.fn();

    const observation: SupervisorObservation = {
      anomalies: [],
      interventions: [
        { type: "send-message", itemId: "A-1-1", message: "test" },
      ],
      frictionObservations: [],
      processImprovements: [],
    };

    const items = [makeItem("A-1-1", "implementing")]; // no workspaceRef

    const count = applySupervisorActions(observation, items, sendMessage, log);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it("logs escalate actions", () => {
    const sendMessage = vi.fn(() => true);
    const log = vi.fn();

    const observation: SupervisorObservation = {
      anomalies: [],
      interventions: [
        { type: "escalate", reason: "Worker stuck for 30 minutes" },
      ],
      frictionObservations: [],
      processImprovements: [],
    };

    const count = applySupervisorActions(observation, [], sendMessage, log);

    expect(count).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "supervisor_action",
      actionType: "escalate",
      reason: "Worker stuck for 30 minutes",
    }));
  });

  it("handles empty interventions", () => {
    const sendMessage = vi.fn(() => true);
    const log = vi.fn();

    const observation: SupervisorObservation = {
      anomalies: ["something noted"],
      interventions: [],
      frictionObservations: [],
      processImprovements: [],
    };

    const count = applySupervisorActions(observation, [], sendMessage, log);

    expect(count).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// ── writeFrictionLog ─────────────────────────────────────────────────

describe("writeFrictionLog", () => {
  it("appends friction observations and process improvements", () => {
    const appendFile = vi.fn();
    const observation: SupervisorObservation = {
      anomalies: [],
      interventions: [],
      frictionObservations: ["CI takes too long"],
      processImprovements: ["Add lint step to CLAUDE.md"],
    };

    writeFrictionLog(observation, "/tmp/friction.md", appendFile);

    expect(appendFile).toHaveBeenCalledTimes(1);
    const written = appendFile.mock.calls[0]![1] as string;
    expect(written).toContain("[friction] CI takes too long");
    expect(written).toContain("[improvement] Add lint step to CLAUDE.md");
  });

  it("does nothing when no friction or improvements", () => {
    const appendFile = vi.fn();
    const observation: SupervisorObservation = {
      anomalies: ["something"],
      interventions: [],
      frictionObservations: [],
      processImprovements: [],
    };

    writeFrictionLog(observation, "/tmp/friction.md", appendFile);

    expect(appendFile).not.toHaveBeenCalled();
  });
});

// ── shouldActivateSupervisor ─────────────────────────────────────────

describe("shouldActivateSupervisor", () => {
  it("returns true when flag is set", () => {
    expect(shouldActivateSupervisor(true, "/nonexistent")).toBe(true);
  });

  it("returns false when flag is not set and not in dogfooding mode", () => {
    expect(shouldActivateSupervisor(false, "/nonexistent")).toBe(false);
  });
});

// ── Tick interval logic in orchestrateLoop ───────────────────────────

describe("orchestrateLoop with supervisor", () => {
  it("invokes supervisor tick at configured interval", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    let currentTime = new Date("2026-03-24T12:00:00Z");

    const callLLM = vi.fn(() => JSON.stringify({
      anomalies: ["test anomaly"],
      interventions: [],
      frictionObservations: [],
      processImprovements: [],
    }));

    const supervisorDeps: SupervisorDeps = {
      callLLM,
      now: () => currentTime,
      log: (entry) => logs.push(entry),
      appendFile: vi.fn(),
    };

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      if (cycle <= 3) {
        // Advance time by 2 minutes each cycle
        currentTime = new Date(currentTime.getTime() + 120_000);
        return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: ["T-1-1"] };
      }
      // Cycle 4+: advance time past the 5-min interval and show PR merged
      currentTime = new Date(currentTime.getTime() + 120_000);
      return { items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      supervisorDeps,
    };

    const config: OrchestrateLoopConfig = {
      supervisor: {
        intervalMs: 300_000, // 5 minutes
        maxLogEntries: 50,
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Supervisor should have been called at least once (after 5+ min elapsed)
    expect(callLLM).toHaveBeenCalled();

    // Should have supervisor_tick events in logs
    expect(logs.some((l) => l.event === "supervisor_tick")).toBe(true);
  });

  it("does not invoke supervisor when not configured", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      if (cycle === 1) return { items: [], readyIds: ["T-1-1"] };
      if (cycle === 2) return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
      if (cycle === 3) return { items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
      return { items: [], readyIds: [] };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      // no supervisorDeps
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    // No supervisor events
    expect(logs.some((l) => l.event === "supervisor_tick")).toBe(false);
  });

  it("continues running when supervisor call fails", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    let currentTime = new Date("2026-03-24T12:00:00Z");

    const callLLM = vi.fn(() => {
      throw new Error("LLM service unavailable");
    });

    const supervisorDeps: SupervisorDeps = {
      callLLM,
      now: () => currentTime,
      log: (entry) => logs.push(entry),
      appendFile: vi.fn(),
    };

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      // Advance time past supervisor interval each cycle
      currentTime = new Date(currentTime.getTime() + 400_000);
      if (cycle === 1) return { items: [], readyIds: ["T-1-1"] };
      if (cycle === 2) return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
      if (cycle === 3) return { items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
      return { items: [], readyIds: [] };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      supervisorDeps,
    };

    const config: OrchestrateLoopConfig = {
      supervisor: {
        intervalMs: 60_000, // 1 minute (so it triggers)
        maxLogEntries: 50,
      },
    };

    // Should not throw — daemon continues
    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Item should still complete
    expect(orch.getItem("T-1-1")!.state).toBe("done");

    // Supervisor error was logged
    expect(logs.some((l) => l.event === "supervisor_error")).toBe(true);
  });

  it("sends worker messages when supervisor suggests intervention", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    let currentTime = new Date("2026-03-24T12:00:00Z");
    const sendMessage = vi.fn(() => true);

    const callLLM = vi.fn(() => JSON.stringify({
      anomalies: ["Worker stuck"],
      interventions: [
        { type: "send-message", itemId: "T-1-1", message: "Check if you're blocked" },
      ],
      frictionObservations: [],
      processImprovements: [],
    }));

    const supervisorDeps: SupervisorDeps = {
      callLLM,
      now: () => currentTime,
      log: (entry) => logs.push(entry),
      appendFile: vi.fn(),
    };

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      // Advance time past supervisor interval
      currentTime = new Date(currentTime.getTime() + 400_000);
      if (cycle <= 2) {
        return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: ["T-1-1"] };
      }
      return { items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
    };

    const actionDeps = mockActionDeps({ sendMessage });

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps,
      supervisorDeps,
    };

    const config: OrchestrateLoopConfig = {
      supervisor: {
        intervalMs: 60_000,
        maxLogEntries: 50,
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Supervisor action should have been logged
    expect(logs.some((l) => l.event === "supervisor_action" && l.actionType === "send-message")).toBe(true);
  });

  it("writes to friction log when path is configured", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    let currentTime = new Date("2026-03-24T12:00:00Z");
    const appendFile = vi.fn();

    const callLLM = vi.fn(() => JSON.stringify({
      anomalies: [],
      interventions: [],
      frictionObservations: ["CI is slow"],
      processImprovements: ["Cache node_modules"],
    }));

    const supervisorDeps: SupervisorDeps = {
      callLLM,
      now: () => currentTime,
      log: (entry) => logs.push(entry),
      appendFile,
    };

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      currentTime = new Date(currentTime.getTime() + 400_000);
      if (cycle === 1) return { items: [], readyIds: ["T-1-1"] };
      if (cycle === 2) return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
      if (cycle === 3) return { items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
      return { items: [], readyIds: [] };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      supervisorDeps,
    };

    const config: OrchestrateLoopConfig = {
      supervisor: {
        intervalMs: 60_000,
        maxLogEntries: 50,
        frictionLogPath: "/tmp/friction.md",
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    // Friction log should have been written
    expect(appendFile).toHaveBeenCalled();
    const written = appendFile.mock.calls.some(
      (call: [string, string]) => call[1].includes("[friction]") || call[1].includes("[improvement]"),
    );
    expect(written).toBe(true);
  });

  it("logs supervisorActive in orchestrate_start event", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    const logs: LogEntry[] = [];
    let cycle = 0;

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      if (cycle === 1) return { items: [], readyIds: ["T-1-1"] };
      if (cycle === 2) return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
      if (cycle === 3) return { items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
      return { items: [], readyIds: [] };
    };

    const supervisorDeps = mockSupervisorDeps();

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      supervisorDeps,
    };

    const config: OrchestrateLoopConfig = {
      supervisor: { intervalMs: 999_999, maxLogEntries: 50 },
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    const startEvent = logs.find((l) => l.event === "orchestrate_start");
    expect(startEvent).toBeDefined();
    expect(startEvent!.supervisorActive).toBe(true);
  });

  it("supervisor does not tick before interval elapses", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1-1"));

    let cycle = 0;
    const logs: LogEntry[] = [];
    // Time advances slowly — never reaches the 10-minute interval
    let currentTime = new Date("2026-03-24T12:00:00Z");

    const callLLM = vi.fn(() => JSON.stringify({
      anomalies: [],
      interventions: [],
      frictionObservations: [],
      processImprovements: [],
    }));

    const supervisorDeps: SupervisorDeps = {
      callLLM,
      now: () => currentTime,
      log: (entry) => logs.push(entry),
      appendFile: vi.fn(),
    };

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      // Advance by only 30s each cycle — never reaches 10-min threshold
      currentTime = new Date(currentTime.getTime() + 30_000);
      if (cycle === 1) return { items: [], readyIds: ["T-1-1"] };
      if (cycle === 2) return { items: [{ id: "T-1-1", workerAlive: true }], readyIds: [] };
      if (cycle === 3) return { items: [{ id: "T-1-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
      return { items: [], readyIds: [] };
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: (entry) => logs.push(entry),
      actionDeps: mockActionDeps(),
      supervisorDeps,
    };

    const config: OrchestrateLoopConfig = {
      supervisor: {
        intervalMs: 600_000, // 10 minutes
        maxLogEntries: 50,
      },
    };

    await orchestrateLoop(orch, defaultCtx, deps, config);

    // LLM should NOT have been called (time never reached 10 min)
    expect(callLLM).not.toHaveBeenCalled();
  });
});

// ── DEFAULT_SUPERVISOR_CONFIG ────────────────────────────────────────

describe("DEFAULT_SUPERVISOR_CONFIG", () => {
  it("has 5-minute default interval", () => {
    expect(DEFAULT_SUPERVISOR_CONFIG.intervalMs).toBe(300_000);
  });

  it("has 100 max log entries", () => {
    expect(DEFAULT_SUPERVISOR_CONFIG.maxLogEntries).toBe(100);
  });
});
