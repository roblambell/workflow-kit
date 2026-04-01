// Tests for core/daemon.ts -- PID file management, state serialization,
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
  serializeOrchestratorState,
  pidFilePath,
  stateFilePath,
  logFilePath,
  userStateDir,
  migrateRuntimeState,
  rotateLogs,
  type DaemonIO,
  type DaemonState,
  type LogRotateIO,
  type ProcessExistsCheck,
} from "../core/daemon.ts";
import type { OrchestratorItem } from "../core/orchestrator.ts";
import type { WorkItem } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeWorkItem(id: string): WorkItem {
  return {
    id,
    priority: "high",
    title: `Item ${id}`,
    domain: "test",
    dependencies: [],
    bundleWith: [],
    status: "open",
    filePath: "",
    repoAlias: "",
    rawText: `## ${id}\nTest item`,
    filePaths: [],
    testPlan: "",
    bootstrap: false,
  };
}

function makeOrchestratorItem(
  id: string,
  state: string,
  prNumber?: number,
): OrchestratorItem {
  return {
    id,
    workItem: makeWorkItem(id),
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
    writeFileSync: vi.fn((path: any, content: string, optionsOrEncoding?: any) => {
      const key = String(path);
      // Simulate exclusive create (flag: 'wx') -- throws EEXIST if file exists
      if (typeof optionsOrEncoding === "object" && optionsOrEncoding?.flag === "wx") {
        if (files.has(key)) {
          const err = new Error(`EEXIST: file already exists, open '${key}'`) as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        }
      }
      files.set(key, content);
    }) as any,
    readFileSync: vi.fn((path: any) => {
      const key = String(path);
      const content = files.get(key);
      if (content === undefined) throw new Error(`ENOENT: ${key}`);
      return content;
    }) as any,
    unlinkSync: vi.fn((path: any) => {
      files.delete(String(path));
    }),
    existsSync: vi.fn((path: any) => files.has(String(path))),
    mkdirSync: vi.fn(),
    renameSync: vi.fn((from: any, to: any) => {
      const fromKey = String(from);
      const toKey = String(to);
      const content = files.get(fromKey);
      if (content === undefined) throw new Error(`ENOENT: ${fromKey}`);
      files.set(toKey, content);
      files.delete(fromKey);
    }),
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
      title: "Item A-1-1",
      priority: "high",
      descriptionBody: "## A-1-1\nTest item",
      lastTransition: "2026-03-24T10:00:00.000Z",
      ciFailCount: 0,
      retryCount: 0,
    });
    expect(state.items[1]).toEqual({
      id: "A-1-2",
      state: "merged",
      prNumber: 10,
      title: "Item A-1-2",
      priority: "high",
      descriptionBody: "## A-1-2\nTest item",
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

  it("includes descriptionSnippet when present and omits it otherwise", () => {
    const withSnippet = makeOrchestratorItem("D-1-1", "implementing");
    withSnippet.workItem.descriptionSnippet = "Show a compact work item summary in the detail pane.";

    const withoutSnippet = makeOrchestratorItem("D-1-2", "implementing");

    const state = serializeOrchestratorState(
      [withSnippet, withoutSnippet],
      42,
      "2026-03-27T00:00:00.000Z",
    );

    expect(state.items[0]!.descriptionSnippet).toBe(
      "Show a compact work item summary in the detail pane.",
    );
    expect(state.items[1]!.descriptionSnippet).toBeUndefined();
  });

  it("serializes latest heartbeat progress when provided", () => {
    const item = makeOrchestratorItem("P-1-1", "implementing");
    const heartbeats = new Map([
      ["P-1-1", {
        id: "P-1-1",
        progress: 0.6,
        label: "Updating tests",
        ts: "2026-04-01T12:00:00.000Z",
      }],
    ]);

    const state = serializeOrchestratorState(
      [item],
      42,
      "2026-03-27T00:00:00.000Z",
      { heartbeats },
    );

    expect(state.items[0]!.progress).toBe(0.6);
    expect(state.items[0]!.progressLabel).toBe("Updating tests");
    expect(state.items[0]!.progressTs).toBe("2026-04-01T12:00:00.000Z");
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
    writeFileSync(join(oldDir, "version"), "v1.0.0\n");
    writeFileSync(join(oldDir, "external-reviews.json"), "[]");

    migrateRuntimeState(projectRoot);

    const newDir = userStateDir(projectRoot);
    // Files should exist in new location
    expect(existsSync(join(newDir, "orchestrator.pid"))).toBe(true);
    expect(readFileSync(join(newDir, "orchestrator.pid"), "utf-8")).toBe("12345");
    expect(existsSync(join(newDir, "orchestrator.state.json"))).toBe(true);
    expect(existsSync(join(newDir, "orchestrator.log"))).toBe(true);
    expect(existsSync(join(newDir, "version"))).toBe(true);
    expect(existsSync(join(newDir, "external-reviews.json"))).toBe(true);

    // Files should be removed from old location
    expect(existsSync(join(oldDir, "orchestrator.pid"))).toBe(false);
    expect(existsSync(join(oldDir, "orchestrator.state.json"))).toBe(false);
    expect(existsSync(join(oldDir, "orchestrator.log"))).toBe(false);
    expect(existsSync(join(oldDir, "version"))).toBe(false);
    expect(existsSync(join(oldDir, "external-reviews.json"))).toBe(false);
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

  it("is idempotent -- safe to call multiple times", () => {
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
    writeFileSync(join(oldDir, "orchestrator.pid"), "999");

    migrateRuntimeState(projectRoot);

    // Non-runtime files should remain in .ninthwave/
    expect(existsSync(join(oldDir, "config"))).toBe(true);
    // Runtime file should be migrated
    expect(existsSync(join(oldDir, "orchestrator.pid"))).toBe(false);
  });
});

// ── rotateLogs ──────────────────────────────────────────────────────

describe("rotateLogs", () => {
  let tempDir: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nw-rotate-test-"));
    process.env.HOME = join(tempDir, "home");
    mkdirSync(join(tempDir, "home"), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* cleanup best-effort */ }
  });

  it("returns false and does nothing when log file does not exist", () => {
    const logPath = join(tempDir, "orchestrator.log");
    const result = rotateLogs(logPath, 100, 3);
    expect(result).toBe(false);
    expect(existsSync(logPath)).toBe(false);
  });

  it("returns false when file size is below maxBytes threshold", () => {
    const logPath = join(tempDir, "orchestrator.log");
    writeFileSync(logPath, "small content");
    const result = rotateLogs(logPath, 1024 * 1024, 3); // 1MB threshold
    expect(result).toBe(false);
    // File should still be in place
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toBe("small content");
  });

  it("rotates when file exceeds maxBytes -- renames base to .1", () => {
    const logPath = join(tempDir, "orchestrator.log");
    const bigContent = "x".repeat(200);
    writeFileSync(logPath, bigContent);

    const result = rotateLogs(logPath, 100, 3); // 100 byte threshold
    expect(result).toBe(true);
    // Base file should be gone (renamed to .1)
    expect(existsSync(logPath)).toBe(false);
    // .1 should contain the old content
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(readFileSync(`${logPath}.1`, "utf-8")).toBe(bigContent);
  });

  it("shifts existing .1 to .2 when rotating", () => {
    const logPath = join(tempDir, "orchestrator.log");
    writeFileSync(logPath, "x".repeat(200));
    writeFileSync(`${logPath}.1`, "old-rotation-1");

    rotateLogs(logPath, 100, 3);

    expect(existsSync(logPath)).toBe(false);
    expect(readFileSync(`${logPath}.1`, "utf-8")).toBe("x".repeat(200));
    expect(readFileSync(`${logPath}.2`, "utf-8")).toBe("old-rotation-1");
  });

  it("shifts .1→.2 and .2→.3 when rotating", () => {
    const logPath = join(tempDir, "orchestrator.log");
    writeFileSync(logPath, "x".repeat(200));
    writeFileSync(`${logPath}.1`, "rotation-1");
    writeFileSync(`${logPath}.2`, "rotation-2");

    rotateLogs(logPath, 100, 3);

    expect(existsSync(logPath)).toBe(false);
    expect(readFileSync(`${logPath}.1`, "utf-8")).toBe("x".repeat(200));
    expect(readFileSync(`${logPath}.2`, "utf-8")).toBe("rotation-1");
    expect(readFileSync(`${logPath}.3`, "utf-8")).toBe("rotation-2");
  });

  it("deletes oldest rotation (.3) when at maxFiles limit", () => {
    const logPath = join(tempDir, "orchestrator.log");
    writeFileSync(logPath, "x".repeat(200));
    writeFileSync(`${logPath}.1`, "rotation-1");
    writeFileSync(`${logPath}.2`, "rotation-2");
    writeFileSync(`${logPath}.3`, "rotation-3-should-be-deleted");

    rotateLogs(logPath, 100, 3);

    expect(existsSync(logPath)).toBe(false);
    expect(readFileSync(`${logPath}.1`, "utf-8")).toBe("x".repeat(200));
    expect(readFileSync(`${logPath}.2`, "utf-8")).toBe("rotation-1");
    expect(readFileSync(`${logPath}.3`, "utf-8")).toBe("rotation-2");
    // Only 3 rotated files kept -- no .4
    expect(existsSync(`${logPath}.4`)).toBe(false);
  });

  it("keeps at most maxFiles rotated files", () => {
    const logPath = join(tempDir, "orchestrator.log");
    writeFileSync(logPath, "x".repeat(200));
    writeFileSync(`${logPath}.1`, "r1");
    writeFileSync(`${logPath}.2`, "r2");
    writeFileSync(`${logPath}.3`, "r3");

    rotateLogs(logPath, 100, 3);

    // Count rotated files
    const rotated = [1, 2, 3, 4].filter(n => existsSync(`${logPath}.${n}`));
    expect(rotated).toHaveLength(3);
    expect(rotated).toEqual([1, 2, 3]);
  });

  it("works with maxFiles=1 (only one backup)", () => {
    const logPath = join(tempDir, "orchestrator.log");
    writeFileSync(logPath, "x".repeat(200));
    writeFileSync(`${logPath}.1`, "old-backup");

    rotateLogs(logPath, 100, 1);

    expect(existsSync(logPath)).toBe(false);
    expect(readFileSync(`${logPath}.1`, "utf-8")).toBe("x".repeat(200));
    expect(existsSync(`${logPath}.2`)).toBe(false);
  });

  it("uses injectable IO for testability", () => {
    const files = new Map<string, string>();
    files.set("/log", "x".repeat(200));

    const io: LogRotateIO = {
      existsSync: (p: any) => files.has(String(p)),
      statSync: (p: any) => ({ size: files.get(String(p))?.length ?? 0 }) as any,
      renameSync: (from: any, to: any) => {
        const content = files.get(String(from));
        if (content !== undefined) {
          files.set(String(to), content);
          files.delete(String(from));
        }
      },
      unlinkSync: (p: any) => { files.delete(String(p)); },
    };

    const result = rotateLogs("/log", 100, 3, io);
    expect(result).toBe(true);
    expect(files.has("/log")).toBe(false);
    expect(files.get("/log.1")).toBe("x".repeat(200));
  });
});

// ── Atomic state file writes ────────────────────────────────────────

describe("writeStateFile atomic write", () => {
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    io = createMockIO();
  });

  it("writes to .tmp file then renames to target path", () => {
    const state: DaemonState = {
      pid: 123,
      startedAt: "2026-03-24T10:00:00.000Z",
      updatedAt: "2026-03-24T10:01:00.000Z",
      items: [],
    };
    writeStateFile("/project", state, io);

    // renameSync should have been called with the tmp path and the target path
    const targetPath = stateFilePath("/project");
    const tmpPath = targetPath + ".tmp";
    expect(io.renameSync).toHaveBeenCalledWith(tmpPath, targetPath);

    // writeFileSync should have written to the tmp path (not the target)
    expect(io.writeFileSync).toHaveBeenCalledWith(
      tmpPath,
      expect.any(String),
      "utf-8",
    );

    // The final file should contain valid JSON at the target path
    const raw = io.files.get(targetPath)!;
    expect(JSON.parse(raw)).toEqual(state);

    // The tmp file should be cleaned up (renamed away)
    expect(io.files.has(tmpPath)).toBe(false);
  });
});

// ── Crash recovery field serialization ──────────────────────────────

describe("crash recovery fields serialization", () => {
  it("includes workspaceRef, partition, and resolvedRepoRoot when present", () => {
    const item = makeOrchestratorItem("CR-1-1", "implementing", 10);
    item.workspaceRef = "workspace:3";
    item.partition = 5;
    item.resolvedRepoRoot = "/Users/rob/code/target-repo";

    const state = serializeOrchestratorState(
      [item],
      42,
      "2026-03-29T00:00:00.000Z",
    );

    expect(state.items[0]!.workspaceRef).toBe("workspace:3");
    expect(state.items[0]!.partition).toBe(5);
    expect(state.items[0]!.resolvedRepoRoot).toBe("/Users/rob/code/target-repo");
  });

  it("omits workspaceRef, partition, and resolvedRepoRoot when absent", () => {
    const item = makeOrchestratorItem("CR-1-2", "queued");

    const state = serializeOrchestratorState(
      [item],
      42,
      "2026-03-29T00:00:00.000Z",
    );

    expect(state.items[0]!.workspaceRef).toBeUndefined();
    expect(state.items[0]!.partition).toBeUndefined();
    expect(state.items[0]!.resolvedRepoRoot).toBeUndefined();
  });

  it("roundtrips workspaceRef, partition, and resolvedRepoRoot through write/read", () => {
    const io = createMockIO();
    const item = makeOrchestratorItem("CR-1-3", "implementing", 55);
    item.workspaceRef = "workspace:7";
    item.partition = 3;
    item.resolvedRepoRoot = "/home/user/repos/target";

    const state = serializeOrchestratorState(
      [item],
      99,
      "2026-03-29T00:00:00.000Z",
    );

    writeStateFile("/project", state, io);
    const restored = readStateFile("/project", io);

    expect(restored).not.toBeNull();
    expect(restored!.items[0]!.workspaceRef).toBe("workspace:7");
    expect(restored!.items[0]!.partition).toBe(3);
    expect(restored!.items[0]!.resolvedRepoRoot).toBe("/home/user/repos/target");
  });

  it("serializes partition=0 (falsy but valid)", () => {
    const item = makeOrchestratorItem("CR-1-4", "implementing");
    item.partition = 0;

    const state = serializeOrchestratorState(
      [item],
      42,
      "2026-03-29T00:00:00.000Z",
    );

    // partition=0 should be included since we use `!= null` check
    expect(state.items[0]!.partition).toBe(0);
  });
});

// ── PID file locking ────────────────────────────────────────────────

describe("PID file exclusive locking", () => {
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    io = createMockIO();
  });

  it("writes PID file with exclusive flag when file does not exist", () => {
    writePidFile("/project", 12345, io);
    expect(io.files.get(pidFilePath("/project"))).toBe("12345");
    // Verify 'wx' flag was used
    expect(io.writeFileSync).toHaveBeenCalledWith(
      pidFilePath("/project"),
      "12345",
      { flag: "wx" },
    );
  });

  it("throws EEXIST when PID file already exists", () => {
    // First write succeeds
    writePidFile("/project", 111, io);

    // Second write should throw EEXIST
    expect(() => writePidFile("/project", 222, io)).toThrow(/EEXIST/);

    // Original PID should be preserved
    expect(io.files.get(pidFilePath("/project"))).toBe("111");
  });

  it("EEXIST error has code property", () => {
    writePidFile("/project", 111, io);

    try {
      writePidFile("/project", 222, io);
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.code).toBe("EEXIST");
    }
  });
});

// ── State file validation ───────────────────────────────────────────

describe("readStateFile validation", () => {
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    io = createMockIO();
  });

  it("returns null for JSON without items array", () => {
    io.files.set(stateFilePath("/project"), JSON.stringify({ pid: 1 }));
    expect(readStateFile("/project", io)).toBeNull();
  });

  it("returns null for JSON where items is not an array", () => {
    io.files.set(stateFilePath("/project"), JSON.stringify({ items: "not-array" }));
    expect(readStateFile("/project", io)).toBeNull();
  });

  it("returns null for items with missing id field", () => {
    io.files.set(
      stateFilePath("/project"),
      JSON.stringify({ pid: 1, items: [{ state: "queued" }] }),
    );
    expect(readStateFile("/project", io)).toBeNull();
  });

  it("returns null for items with missing state field", () => {
    io.files.set(
      stateFilePath("/project"),
      JSON.stringify({ pid: 1, items: [{ id: "T-1" }] }),
    );
    expect(readStateFile("/project", io)).toBeNull();
  });

  it("returns null for items with non-string id", () => {
    io.files.set(
      stateFilePath("/project"),
      JSON.stringify({ pid: 1, items: [{ id: 123, state: "queued" }] }),
    );
    expect(readStateFile("/project", io)).toBeNull();
  });

  it("returns null for items with non-string state", () => {
    io.files.set(
      stateFilePath("/project"),
      JSON.stringify({ pid: 1, items: [{ id: "T-1", state: 42 }] }),
    );
    expect(readStateFile("/project", io)).toBeNull();
  });

  it("returns null for null item in items array", () => {
    io.files.set(
      stateFilePath("/project"),
      JSON.stringify({ pid: 1, items: [null] }),
    );
    expect(readStateFile("/project", io)).toBeNull();
  });

  it("accepts valid state with empty items array", () => {
    const state = { pid: 1, startedAt: "now", updatedAt: "now", items: [] };
    io.files.set(stateFilePath("/project"), JSON.stringify(state));
    expect(readStateFile("/project", io)).toEqual(state);
  });

  it("accepts valid state with well-formed items", () => {
    const state = {
      pid: 1,
      startedAt: "now",
      updatedAt: "now",
      items: [{ id: "T-1", state: "implementing", prNumber: null, title: "Test", lastTransition: "now", ciFailCount: 0, retryCount: 0 }],
    };
    io.files.set(stateFilePath("/project"), JSON.stringify(state));
    const result = readStateFile("/project", io);
    expect(result).not.toBeNull();
    expect(result!.items[0]!.id).toBe("T-1");
  });

  it("still returns null for invalid JSON (parse error)", () => {
    io.files.set(stateFilePath("/project"), "not valid json");
    expect(readStateFile("/project", io)).toBeNull();
  });
});
