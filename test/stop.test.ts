// Tests for core/commands/stop.ts — stop command for daemon termination.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cmdStop, type StopDeps } from "../core/commands/stop.ts";
import { pidFilePath, stateFilePath, type DaemonIO, type ProcessExistsCheck } from "../core/daemon.ts";

// ── Helpers ──────────────────────────────────────────────────────────

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

function createDeps(
  io: DaemonIO & { files: Map<string, string> },
  processAlive: boolean = true,
): StopDeps & { killCalls: Array<{ pid: number; signal: string }> } {
  const killCalls: Array<{ pid: number; signal: string }> = [];
  return {
    io,
    check: () => processAlive,
    kill: (pid, signal) => {
      killCalls.push({ pid, signal: signal as string });
    },
    killCalls,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("cmdStop", () => {
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    io = createMockIO();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("reports no daemon running when no PID file", () => {
    const deps = createDeps(io);
    const msg = cmdStop("/project", deps);
    expect(msg).toContain("No watch daemon is running");
  });

  it("sends SIGTERM to running daemon", () => {
    io.files.set(pidFilePath("/project"), "1234");
    const deps = createDeps(io, true);
    const msg = cmdStop("/project", deps);
    expect(msg).toContain("SIGTERM");
    expect(msg).toContain("1234");
    expect(deps.killCalls).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
  });

  it("cleans up stale PID file when process is dead", () => {
    io.files.set(pidFilePath("/project"), "9999");
    io.files.set(stateFilePath("/project"), '{"pid":9999}');
    const deps = createDeps(io, false);
    const msg = cmdStop("/project", deps);
    expect(msg).toContain("stale PID file");
    expect(msg).toContain("9999");
    // Files should be cleaned up
    expect(io.files.has(pidFilePath("/project"))).toBe(false);
    expect(io.files.has(stateFilePath("/project"))).toBe(false);
    // No kill should have been sent
    expect(deps.killCalls).toEqual([]);
  });
});
