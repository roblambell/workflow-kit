// Tests for core/daemon.ts — PID file management, state serialization,
// stale PID detection, state file roundtrips, user state directory, and migration.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writePidFile,
  readPidFile,
  cleanPidFile,
  isDaemonRunning,
  writeStateFile,
  readStateFile,
  cleanStateFile,
  archiveStateFile,
  stateArchiveDir,
  serializeOrchestratorState,
  pidFilePath,
  stateFilePath,
  logFilePath,
  userStateDir,
  migrateRuntimeState,
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

// ── userStateDir ────────────────────────────────────────────────────

describe("userStateDir", () => {
  const origHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = origHome;
  });

  it("returns consistent path for same project root", () => {
    process.env.HOME = "/home/testuser";
    const a = userStateDir("/Users/rob/code/myproject");
    const b = userStateDir("/Users/rob/code/myproject");
    expect(a).toBe(b);
  });

  it("returns different paths for different project roots", () => {
    process.env.HOME = "/home/testuser";
    const a = userStateDir("/Users/rob/code/projectA");
    const b = userStateDir("/Users/rob/code/projectB");
    expect(a).not.toBe(b);
  });

  it("uses HOME-based path under ~/.ninthwave/projects/", () => {
    process.env.HOME = "/home/testuser";
    const dir = userStateDir("/Users/rob/code/proj");
    expect(dir).toMatch(/^\/home\/testuser\/\.ninthwave\/projects\//);
  });

  it("encodes project root as slug (slashes replaced with dashes)", () => {
    process.env.HOME = "/home/testuser";
    const dir = userStateDir("/Users/rob/code/proj");
    expect(dir).toContain("-Users-rob-code-proj");
  });

  it("falls back to /tmp when HOME is unset", () => {
    delete process.env.HOME;
    const dir = userStateDir("/project");
    expect(dir).toMatch(/^\/tmp\/\.ninthwave\/projects\//);
  });
});

// ── Path helpers ─────────────────────────────────────────────────────

describe("path helpers", () => {
  const origHome = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = "/home/testuser";
  });
  afterEach(() => {
    process.env.HOME = origHome;
  });

  it("pidFilePath returns path under user state dir", () => {
    const path = pidFilePath("/project");
    expect(path).toBe(join(userStateDir("/project"), "orchestrator.pid"));
    expect(path).toMatch(/\.ninthwave\/projects\//);
    expect(path).toContain("orchestrator.pid");
  });

  it("stateFilePath returns path under user state dir", () => {
    const path = stateFilePath("/project");
    expect(path).toBe(join(userStateDir("/project"), "orchestrator.state.json"));
    expect(path).toMatch(/\.ninthwave\/projects\//);
  });

  it("logFilePath returns path under user state dir", () => {
    const path = logFilePath("/project");
    expect(path).toBe(join(userStateDir("/project"), "orchestrator.log"));
    expect(path).toMatch(/\.ninthwave\/projects\//);
  });

  it("stateArchiveDir returns path under user state dir", () => {
    const path = stateArchiveDir("/project");
    expect(path).toBe(join(userStateDir("/project"), "state-archive"));
  });

  it("path functions return paths outside the project directory", () => {
    const projRoot = "/Users/rob/code/myproject";
    expect(pidFilePath(projRoot)).not.toContain(projRoot);
    expect(stateFilePath(projRoot)).not.toContain(projRoot);
    expect(logFilePath(projRoot)).not.toContain(projRoot);
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
    expect(io.files.get(pidFilePath("/project"))).toBe("12345");
  });

  it("writePidFile creates directory if missing", () => {
    writePidFile("/project", 42, io);
    expect(io.mkdirSync).toHaveBeenCalled();
  });

  it("writePidFile skips mkdir when dir exists", () => {
    // Simulate dir exists by adding the dirname of pidFilePath to mock
    const { dirname } = require("path");
    io.files.set(dirname(pidFilePath("/project")), "");
    writePidFile("/project", 42, io);
    expect(io.mkdirSync).not.toHaveBeenCalled();
  });

  it("readPidFile returns PID number", () => {
    io.files.set(pidFilePath("/project"), "12345");
    expect(readPidFile("/project", io)).toBe(12345);
  });

  it("readPidFile returns null when file missing", () => {
    expect(readPidFile("/project", io)).toBeNull();
  });

  it("readPidFile returns null for non-numeric content", () => {
    io.files.set(pidFilePath("/project"), "not-a-number");
    expect(readPidFile("/project", io)).toBeNull();
  });

  it("readPidFile trims whitespace", () => {
    io.files.set(pidFilePath("/project"), "  99  \n");
    expect(readPidFile("/project", io)).toBe(99);
  });

  it("cleanPidFile removes file when present", () => {
    io.files.set(pidFilePath("/project"), "123");
    cleanPidFile("/project", io);
    expect(io.files.has(pidFilePath("/project"))).toBe(false);
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
    io.files.set(pidFilePath("/project"), "1234");
    const check: ProcessExistsCheck = () => true;
    expect(isDaemonRunning("/project", io, check)).toBe(1234);
  });

  it("cleans up and returns null for stale PID (process dead)", () => {
    io.files.set(pidFilePath("/project"), "9999");
    io.files.set(stateFilePath("/project"), '{"pid":9999}');
    const check: ProcessExistsCheck = () => false;

    expect(isDaemonRunning("/project", io, check)).toBeNull();
    // Both PID file and state file should be cleaned up
    expect(io.files.has(pidFilePath("/project"))).toBe(false);
    expect(io.files.has(stateFilePath("/project"))).toBe(false);
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
    const raw = io.files.get(stateFilePath("/project"))!;
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
    io.files.set(stateFilePath("/project"), JSON.stringify(state));
    expect(readStateFile("/project", io)).toEqual(state);
  });

  it("readStateFile returns null when file missing", () => {
    expect(readStateFile("/project", io)).toBeNull();
  });

  it("readStateFile returns null for invalid JSON", () => {
    io.files.set(stateFilePath("/project"), "not valid json");
    expect(readStateFile("/project", io)).toBeNull();
  });

  it("cleanStateFile removes file when present", () => {
    io.files.set(stateFilePath("/project"), '{"pid":1}');
    cleanStateFile("/project", io);
    expect(io.files.has(stateFilePath("/project"))).toBe(false);
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

  it("includes ciFailureNotified and ciFailureNotifiedAt when present", () => {
    const item = makeOrchestratorItem("N-1-1", "ci-failed", 33);
    item.ciFailureNotified = true;
    item.ciFailureNotifiedAt = "2026-03-27T14:00:00.000Z";

    const state = serializeOrchestratorState(
      [item],
      42,
      "2026-03-27T00:00:00.000Z",
    );

    expect(state.items[0]!.ciFailureNotified).toBe(true);
    expect(state.items[0]!.ciFailureNotifiedAt).toBe("2026-03-27T14:00:00.000Z");
  });

  it("omits ciFailureNotified and ciFailureNotifiedAt when absent", () => {
    const item = makeOrchestratorItem("N-1-2", "implementing");

    const state = serializeOrchestratorState(
      [item],
      42,
      "2026-03-27T00:00:00.000Z",
    );

    expect(state.items[0]!.ciFailureNotified).toBeUndefined();
    expect(state.items[0]!.ciFailureNotifiedAt).toBeUndefined();
  });

  it("roundtrips ciFailureNotified and ciFailureNotifiedAt through write/read", () => {
    const io = createMockIO();
    const item = makeOrchestratorItem("N-1-3", "ci-failed", 55);
    item.ciFailureNotified = true;
    item.ciFailureNotifiedAt = "2026-03-27T14:30:00.000Z";

    const state = serializeOrchestratorState(
      [item],
      99,
      "2026-03-27T00:00:00.000Z",
    );

    writeStateFile("/project", state, io);
    const restored = readStateFile("/project", io);

    expect(restored).not.toBeNull();
    expect(restored!.items[0]!.ciFailureNotified).toBe(true);
    expect(restored!.items[0]!.ciFailureNotifiedAt).toBe("2026-03-27T14:30:00.000Z");
  });
});

// ── archiveStateFile ─────────────────────────────────────────────────

describe("archiveStateFile", () => {
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    io = createMockIO();
  });

  it("returns null when no state file exists", () => {
    expect(archiveStateFile("/project", io)).toBeNull();
  });

  it("moves existing state file to state-archive with startedAt timestamp", () => {
    const oldState: DaemonState = {
      pid: 111,
      startedAt: "2026-03-24T09:00:00.000Z",
      updatedAt: "2026-03-24T09:30:00.000Z",
      items: [
        {
          id: "OLD-1-1",
          state: "implementing",
          prNumber: null,
          title: "Old item",
          lastTransition: "2026-03-24T09:00:00.000Z",
          ciFailCount: 0,
          retryCount: 0,
        },
      ],
    };
    writeStateFile("/project", oldState, io);

    const archivePath = archiveStateFile("/project", io);

    // State file should be removed
    expect(io.existsSync(stateFilePath("/project"))).toBe(false);
    // Archive should exist
    expect(archivePath).not.toBeNull();
    expect(archivePath).toContain("state-archive");
    expect(archivePath).toContain("2026-03-24T09-00-00-000Z");
    // Archived content should be readable and match the old state
    const archivedContent = io.readFileSync(archivePath!, "utf-8");
    const parsed = JSON.parse(archivedContent) as DaemonState;
    expect(parsed.pid).toBe(111);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]!.id).toBe("OLD-1-1");
  });

  it("creates archive directory if missing", () => {
    const oldState: DaemonState = {
      pid: 222,
      startedAt: "2026-03-24T10:00:00.000Z",
      updatedAt: "2026-03-24T10:01:00.000Z",
      items: [],
    };
    writeStateFile("/project", oldState, io);

    archiveStateFile("/project", io);

    expect(io.mkdirSync).toHaveBeenCalledWith(
      stateArchiveDir("/project"),
      { recursive: true },
    );
  });

  it("handles invalid JSON in state file gracefully", () => {
    io.files.set(stateFilePath("/project"), "not valid json {{{");

    const archivePath = archiveStateFile("/project", io);

    // Should still archive (with fallback timestamp) and not throw
    expect(archivePath).not.toBeNull();
    expect(archivePath).toContain("state-archive");
    // State file should be removed
    expect(io.existsSync(stateFilePath("/project"))).toBe(false);
  });

  it("fresh state only contains new items after archive + rewrite", () => {
    // Simulate old daemon's state with old items
    const oldState: DaemonState = {
      pid: 100,
      startedAt: "2026-03-24T08:00:00.000Z",
      updatedAt: "2026-03-24T08:30:00.000Z",
      items: [
        {
          id: "OLD-1-1",
          state: "implementing",
          prNumber: 10,
          title: "Old item 1",
          lastTransition: "2026-03-24T08:00:00.000Z",
          ciFailCount: 0,
          retryCount: 0,
        },
        {
          id: "OLD-1-2",
          state: "merged",
          prNumber: 11,
          title: "Old item 2",
          lastTransition: "2026-03-24T08:10:00.000Z",
          ciFailCount: 0,
          retryCount: 0,
        },
      ],
    };
    writeStateFile("/project", oldState, io);

    // New daemon starts: archive old state
    archiveStateFile("/project", io);

    // Write fresh state with new items only
    const newItems: OrchestratorItem[] = [
      makeOrchestratorItem("NEW-1-1", "queued"),
      makeOrchestratorItem("NEW-1-2", "queued"),
    ];
    const freshState = serializeOrchestratorState(
      newItems,
      200,
      "2026-03-25T10:00:00.000Z",
    );
    writeStateFile("/project", freshState, io);

    // Verify the state file only contains new items
    const currentState = readStateFile("/project", io);
    expect(currentState).not.toBeNull();
    expect(currentState!.pid).toBe(200);
    expect(currentState!.items).toHaveLength(2);
    expect(currentState!.items[0]!.id).toBe("NEW-1-1");
    expect(currentState!.items[1]!.id).toBe("NEW-1-2");
    // Old items should NOT be present
    const ids = currentState!.items.map((i) => i.id);
    expect(ids).not.toContain("OLD-1-1");
    expect(ids).not.toContain("OLD-1-2");
  });

  it("handles daemon crash gracefully — missing state file on next start", () => {
    // Simulate: daemon crashed without writing state (no state file)
    // archiveStateFile should be a no-op
    expect(archiveStateFile("/project", io)).toBeNull();

    // readStateFile should also return null
    expect(readStateFile("/project", io)).toBeNull();

    // A new daemon can still write fresh state successfully
    const freshState = serializeOrchestratorState(
      [makeOrchestratorItem("FRESH-1-1", "queued")],
      300,
      "2026-03-25T12:00:00.000Z",
    );
    writeStateFile("/project", freshState, io);
    const current = readStateFile("/project", io);
    expect(current).not.toBeNull();
    expect(current!.items).toHaveLength(1);
    expect(current!.items[0]!.id).toBe("FRESH-1-1");
  });
});

// ── migrateRuntimeState ─────────────────────────────────────────────

describe("migrateRuntimeState", () => {
  let tempDir: string;
  let projectRoot: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nw-migrate-test-"));
    projectRoot = join(tempDir, "project");
    mkdirSync(join(projectRoot, ".ninthwave"), { recursive: true });
    // Point HOME to temp so userStateDir resolves inside temp
    process.env.HOME = join(tempDir, "home");
    mkdirSync(join(tempDir, "home"), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  });

  it("migrates runtime files from old location to user state dir", () => {
    const oldDir = join(projectRoot, ".ninthwave");
    writeFileSync(join(oldDir, "orchestrator.pid"), "12345");
    writeFileSync(join(oldDir, "orchestrator.state.json"), '{"pid":12345}');
    writeFileSync(join(oldDir, "orchestrator.log"), "log content");
    writeFileSync(join(oldDir, "health-samples.jsonl"), '{"t":"now"}');
    writeFileSync(join(oldDir, "version"), "v1.0.0\n");
    writeFileSync(join(oldDir, "external-reviews.json"), "[]");

    migrateRuntimeState(projectRoot);

    const newDir = userStateDir(projectRoot);
    // Files should exist in new location
    expect(existsSync(join(newDir, "orchestrator.pid"))).toBe(true);
    expect(readFileSync(join(newDir, "orchestrator.pid"), "utf-8")).toBe("12345");
    expect(existsSync(join(newDir, "orchestrator.state.json"))).toBe(true);
    expect(existsSync(join(newDir, "orchestrator.log"))).toBe(true);
    expect(existsSync(join(newDir, "health-samples.jsonl"))).toBe(true);
    expect(existsSync(join(newDir, "version"))).toBe(true);
    expect(existsSync(join(newDir, "external-reviews.json"))).toBe(true);

    // Files should be removed from old location
    expect(existsSync(join(oldDir, "orchestrator.pid"))).toBe(false);
    expect(existsSync(join(oldDir, "orchestrator.state.json"))).toBe(false);
    expect(existsSync(join(oldDir, "orchestrator.log"))).toBe(false);
    expect(existsSync(join(oldDir, "health-samples.jsonl"))).toBe(false);
    expect(existsSync(join(oldDir, "version"))).toBe(false);
    expect(existsSync(join(oldDir, "external-reviews.json"))).toBe(false);
  });

  it("migrates state-archive directory", () => {
    const oldArchive = join(projectRoot, ".ninthwave", "state-archive");
    mkdirSync(oldArchive, { recursive: true });
    writeFileSync(join(oldArchive, "state-2026.json"), '{"pid":1}');
    writeFileSync(join(oldArchive, "state-2025.json"), '{"pid":2}');

    migrateRuntimeState(projectRoot);

    const newArchive = join(userStateDir(projectRoot), "state-archive");
    expect(existsSync(join(newArchive, "state-2026.json"))).toBe(true);
    expect(existsSync(join(newArchive, "state-2025.json"))).toBe(true);
    expect(readFileSync(join(newArchive, "state-2026.json"), "utf-8")).toBe('{"pid":1}');

    // Old archive files should be cleaned up
    expect(existsSync(join(oldArchive, "state-2026.json"))).toBe(false);
    expect(existsSync(join(oldArchive, "state-2025.json"))).toBe(false);
  });

  it("does not overwrite existing files in new location", () => {
    const oldDir = join(projectRoot, ".ninthwave");
    writeFileSync(join(oldDir, "orchestrator.pid"), "old-pid");

    const newDir = userStateDir(projectRoot);
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "orchestrator.pid"), "new-pid");

    migrateRuntimeState(projectRoot);

    // New location should retain its value
    expect(readFileSync(join(newDir, "orchestrator.pid"), "utf-8")).toBe("new-pid");
    // Old file should be cleaned up even when new exists
    expect(existsSync(join(oldDir, "orchestrator.pid"))).toBe(false);
  });

  it("is idempotent — safe to call multiple times", () => {
    const oldDir = join(projectRoot, ".ninthwave");
    writeFileSync(join(oldDir, "orchestrator.pid"), "12345");

    migrateRuntimeState(projectRoot);
    migrateRuntimeState(projectRoot); // second call should be a no-op

    const newDir = userStateDir(projectRoot);
    expect(readFileSync(join(newDir, "orchestrator.pid"), "utf-8")).toBe("12345");
  });

  it("no-ops when .ninthwave directory does not exist", () => {
    const emptyProject = join(tempDir, "empty-project");
    mkdirSync(emptyProject, { recursive: true });

    // Should not throw
    migrateRuntimeState(emptyProject);
  });

  it("preserves non-runtime files in .ninthwave/", () => {
    const oldDir = join(projectRoot, ".ninthwave");
    writeFileSync(join(oldDir, "config"), "# config content");
    writeFileSync(join(oldDir, "domains.conf"), "# domains");
    writeFileSync(join(oldDir, "orchestrator.pid"), "999");

    migrateRuntimeState(projectRoot);

    // Non-runtime files should remain in .ninthwave/
    expect(existsSync(join(oldDir, "config"))).toBe(true);
    expect(existsSync(join(oldDir, "domains.conf"))).toBe(true);
    // Runtime file should be migrated
    expect(existsSync(join(oldDir, "orchestrator.pid"))).toBe(false);
  });
});
