// Tests for core/daemon.ts — PID file management, state serialization,
// stale PID detection, and state file roundtrips.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  writePidFile,
  readPidFile,
  cleanPidFile,
  isDaemonRunning,
  writeStateFile,
  readStateFile,
  cleanStateFile,
  serializeOrchestratorState,
  pidFilePath,
  stateFilePath,
  logFilePath,
  type DaemonIO,
  type DaemonState,
  type ProcessExistsCheck,
} from "../core/daemon.ts";
import type { OrchestratorItem } from "../core/orchestrator.ts";
import type { TodoItem } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTodo(id: string): TodoItem {
  return {
    id,
    priority: "high",
    title: `TODO ${id}`,
    domain: "test",
    dependencies: [],
    bundleWith: [],
    status: "open",
    filePath: "",
    repoAlias: "",
    rawText: `## ${id}\nTest todo`,
    filePaths: [],
  };
}

function makeOrchestratorItem(
  id: string,
  state: string,
  prNumber?: number,
): OrchestratorItem {
  return {
    id,
    todo: makeTodo(id),
    state: state as any,
    prNumber,
    lastTransition: "2026-03-24T10:00:00.000Z",
    ciFailCount: 0,
    retryCount: 0,
  };
}

/** Create a mock DaemonIO backed by an in-memory Map. */
function createMockIO(): DaemonIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    writeFileSync: vi.fn((path: string, content: string) => {
      files.set(path, content);
    }),
    readFileSync: vi.fn((path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    }),
    unlinkSync: vi.fn((path: string) => {
      files.delete(path);
    }),
    existsSync: vi.fn((path: string) => files.has(path)),
    mkdirSync: vi.fn(),
  };
}

// ── Path helpers ─────────────────────────────────────────────────────

describe("path helpers", () => {
  it("pidFilePath returns correct path", () => {
    expect(pidFilePath("/project")).toBe("/project/.ninthwave/orchestrator.pid");
  });

  it("stateFilePath returns correct path", () => {
    expect(stateFilePath("/project")).toBe(
      "/project/.ninthwave/orchestrator.state.json",
    );
  });

  it("logFilePath returns correct path", () => {
    expect(logFilePath("/project")).toBe(
      "/project/.ninthwave/orchestrator.log",
    );
  });
});

// ── PID file management ──────────────────────────────────────────────

describe("PID file management", () => {
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    io = createMockIO();
  });

  it("writePidFile writes PID as string", () => {
    writePidFile("/project", 12345, io);
    expect(io.files.get("/project/.ninthwave/orchestrator.pid")).toBe("12345");
  });

  it("writePidFile creates directory if missing", () => {
    writePidFile("/project", 42, io);
    expect(io.mkdirSync).toHaveBeenCalledWith("/project/.ninthwave", {
      recursive: true,
    });
  });

  it("writePidFile skips mkdir when dir exists", () => {
    io.files.set("/project/.ninthwave", ""); // simulate dir exists
    writePidFile("/project", 42, io);
    // mkdirSync not called since existsSync returns true for the dir
    // Actually our mock checks exact path, and the dir path doesn't have /orchestrator.pid
    // Let me check: existsSync is called with dirname of the pid file path
    // The dirname would be /project/.ninthwave
    // Since we put a key for that, existsSync returns true
    expect(io.mkdirSync).not.toHaveBeenCalled();
  });

  it("readPidFile returns PID number", () => {
    io.files.set("/project/.ninthwave/orchestrator.pid", "12345");
    expect(readPidFile("/project", io)).toBe(12345);
  });

  it("readPidFile returns null when file missing", () => {
    expect(readPidFile("/project", io)).toBeNull();
  });

  it("readPidFile returns null for non-numeric content", () => {
    io.files.set("/project/.ninthwave/orchestrator.pid", "not-a-number");
    expect(readPidFile("/project", io)).toBeNull();
  });

  it("readPidFile trims whitespace", () => {
    io.files.set("/project/.ninthwave/orchestrator.pid", "  99  \n");
    expect(readPidFile("/project", io)).toBe(99);
  });

  it("cleanPidFile removes file when present", () => {
    io.files.set("/project/.ninthwave/orchestrator.pid", "123");
    cleanPidFile("/project", io);
    expect(io.files.has("/project/.ninthwave/orchestrator.pid")).toBe(false);
  });

  it("cleanPidFile does nothing when file missing", () => {
    cleanPidFile("/project", io);
    expect(io.unlinkSync).not.toHaveBeenCalled();
  });
});

// ── isDaemonRunning ──────────────────────────────────────────────────

describe("isDaemonRunning", () => {
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    io = createMockIO();
  });

  it("returns null when no PID file", () => {
    expect(isDaemonRunning("/project", io)).toBeNull();
  });

  it("returns PID when process is alive", () => {
    io.files.set("/project/.ninthwave/orchestrator.pid", "1234");
    const check: ProcessExistsCheck = () => true;
    expect(isDaemonRunning("/project", io, check)).toBe(1234);
  });

  it("cleans up and returns null for stale PID (process dead)", () => {
    io.files.set("/project/.ninthwave/orchestrator.pid", "9999");
    io.files.set(
      "/project/.ninthwave/orchestrator.state.json",
      '{"pid":9999}',
    );
    const check: ProcessExistsCheck = () => false;

    expect(isDaemonRunning("/project", io, check)).toBeNull();
    // Both PID file and state file should be cleaned up
    expect(io.files.has("/project/.ninthwave/orchestrator.pid")).toBe(false);
    expect(io.files.has("/project/.ninthwave/orchestrator.state.json")).toBe(
      false,
    );
  });
});

// ── State file management ────────────────────────────────────────────

describe("state file management", () => {
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    io = createMockIO();
  });

  it("writeStateFile writes valid JSON", () => {
    const state: DaemonState = {
      pid: 123,
      startedAt: "2026-03-24T10:00:00.000Z",
      updatedAt: "2026-03-24T10:01:00.000Z",
      items: [],
    };
    writeStateFile("/project", state, io);
    const raw = io.files.get("/project/.ninthwave/orchestrator.state.json")!;
    expect(JSON.parse(raw)).toEqual(state);
  });

  it("readStateFile returns parsed state", () => {
    const state: DaemonState = {
      pid: 456,
      startedAt: "2026-03-24T10:00:00.000Z",
      updatedAt: "2026-03-24T10:05:00.000Z",
      items: [
        {
          id: "T-1-1",
          state: "implementing",
          prNumber: null,
          title: "Test",
          lastTransition: "2026-03-24T10:00:00.000Z",
          ciFailCount: 0,
          retryCount: 0,
        },
      ],
    };
    io.files.set(
      "/project/.ninthwave/orchestrator.state.json",
      JSON.stringify(state),
    );
    expect(readStateFile("/project", io)).toEqual(state);
  });

  it("readStateFile returns null when file missing", () => {
    expect(readStateFile("/project", io)).toBeNull();
  });

  it("readStateFile returns null for invalid JSON", () => {
    io.files.set(
      "/project/.ninthwave/orchestrator.state.json",
      "not valid json",
    );
    expect(readStateFile("/project", io)).toBeNull();
  });

  it("cleanStateFile removes file when present", () => {
    io.files.set(
      "/project/.ninthwave/orchestrator.state.json",
      '{"pid":1}',
    );
    cleanStateFile("/project", io);
    expect(
      io.files.has("/project/.ninthwave/orchestrator.state.json"),
    ).toBe(false);
  });

  it("state serialization/deserialization roundtrips correctly", () => {
    const items: OrchestratorItem[] = [
      makeOrchestratorItem("T-1-1", "implementing"),
      makeOrchestratorItem("T-1-2", "ci-pending", 42),
      makeOrchestratorItem("T-1-3", "done", 99),
    ];

    const state = serializeOrchestratorState(
      items,
      1234,
      "2026-03-24T10:00:00.000Z",
    );

    // Write and read back
    writeStateFile("/project", state, io);
    const restored = readStateFile("/project", io);

    expect(restored).not.toBeNull();
    expect(restored!.pid).toBe(1234);
    expect(restored!.startedAt).toBe("2026-03-24T10:00:00.000Z");
    expect(restored!.items).toHaveLength(3);
    expect(restored!.items[0]!.id).toBe("T-1-1");
    expect(restored!.items[0]!.state).toBe("implementing");
    expect(restored!.items[0]!.prNumber).toBeNull();
    expect(restored!.items[1]!.id).toBe("T-1-2");
    expect(restored!.items[1]!.state).toBe("ci-pending");
    expect(restored!.items[1]!.prNumber).toBe(42);
    expect(restored!.items[2]!.id).toBe("T-1-3");
    expect(restored!.items[2]!.state).toBe("done");
    expect(restored!.items[2]!.prNumber).toBe(99);
  });
});

// ── serializeOrchestratorState ───────────────────────────────────────

describe("serializeOrchestratorState", () => {
  it("maps orchestrator items to daemon state items", () => {
    const items: OrchestratorItem[] = [
      makeOrchestratorItem("A-1-1", "implementing"),
      makeOrchestratorItem("A-1-2", "merged", 10),
    ];

    const state = serializeOrchestratorState(
      items,
      5678,
      "2026-03-24T09:00:00.000Z",
    );

    expect(state.pid).toBe(5678);
    expect(state.startedAt).toBe("2026-03-24T09:00:00.000Z");
    expect(state.updatedAt).toBeTruthy(); // ISO string
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toEqual({
      id: "A-1-1",
      state: "implementing",
      prNumber: null,
      title: "TODO A-1-1",
      lastTransition: "2026-03-24T10:00:00.000Z",
      ciFailCount: 0,
      retryCount: 0,
    });
    expect(state.items[1]).toEqual({
      id: "A-1-2",
      state: "merged",
      prNumber: 10,
      title: "TODO A-1-2",
      lastTransition: "2026-03-24T10:00:00.000Z",
      ciFailCount: 0,
      retryCount: 0,
    });
  });

  it("handles empty item list", () => {
    const state = serializeOrchestratorState(
      [],
      1,
      "2026-03-24T09:00:00.000Z",
    );
    expect(state.items).toEqual([]);
    expect(state.pid).toBe(1);
  });

  it("includes extras (statusPaneRef) in returned state", () => {
    const state = serializeOrchestratorState(
      [],
      42,
      "2026-03-25T00:00:00.000Z",
      { statusPaneRef: "workspace:7" },
    );
    expect(state.statusPaneRef).toBe("workspace:7");
    expect(state.pid).toBe(42);
  });

  it("omits statusPaneRef when extras not provided", () => {
    const state = serializeOrchestratorState(
      [],
      42,
      "2026-03-25T00:00:00.000Z",
    );
    expect(state.statusPaneRef).toBeUndefined();
  });

  it("spreads null statusPaneRef from extras", () => {
    const state = serializeOrchestratorState(
      [],
      42,
      "2026-03-25T00:00:00.000Z",
      { statusPaneRef: null },
    );
    expect(state.statusPaneRef).toBeNull();
  });

  it("includes reviewWorkspaceRef and reviewCompleted when present", () => {
    const item = makeOrchestratorItem("R-1-1", "reviewing", 55);
    item.reviewWorkspaceRef = "workspace:10";
    item.reviewCompleted = true;

    const state = serializeOrchestratorState(
      [item],
      42,
      "2026-03-25T00:00:00.000Z",
    );

    expect(state.items[0]!.reviewWorkspaceRef).toBe("workspace:10");
    expect(state.items[0]!.reviewCompleted).toBe(true);
  });

  it("omits reviewWorkspaceRef and reviewCompleted when absent", () => {
    const item = makeOrchestratorItem("R-1-2", "implementing");

    const state = serializeOrchestratorState(
      [item],
      42,
      "2026-03-25T00:00:00.000Z",
    );

    expect(state.items[0]!.reviewWorkspaceRef).toBeUndefined();
    expect(state.items[0]!.reviewCompleted).toBeUndefined();
  });

  it("roundtrips reviewWorkspaceRef and reviewCompleted through write/read", () => {
    const io = createMockIO();
    const item = makeOrchestratorItem("R-1-3", "reviewing", 77);
    item.reviewWorkspaceRef = "workspace:5";
    item.reviewCompleted = false;

    const state = serializeOrchestratorState(
      [item],
      99,
      "2026-03-25T00:00:00.000Z",
    );

    writeStateFile("/project", state, io);
    const restored = readStateFile("/project", io);

    expect(restored).not.toBeNull();
    expect(restored!.items[0]!.reviewWorkspaceRef).toBe("workspace:5");
    // reviewCompleted is false, so it's omitted from serialization (only truthy values are spread)
    expect(restored!.items[0]!.reviewCompleted).toBeUndefined();

    // Now test with reviewCompleted = true
    item.reviewCompleted = true;
    const state2 = serializeOrchestratorState(
      [item],
      99,
      "2026-03-25T00:00:00.000Z",
    );
    writeStateFile("/project", state2, io);
    const restored2 = readStateFile("/project", io);
    expect(restored2!.items[0]!.reviewCompleted).toBe(true);
  });
});
