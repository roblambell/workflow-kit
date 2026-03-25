// Tests for core/commands/retry.ts — retry command for stuck/done items.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cmdRetry, type RetryDeps } from "../core/commands/retry.ts";
import type { DaemonIO, DaemonState } from "../core/daemon.ts";

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

function makeState(items: DaemonState["items"]): DaemonState {
  return {
    pid: 1234,
    startedAt: "2026-03-25T00:00:00Z",
    updatedAt: "2026-03-25T00:00:00Z",
    items,
  };
}

function makeItem(
  id: string,
  state: string,
  overrides: Partial<DaemonState["items"][0]> = {},
): DaemonState["items"][0] {
  return {
    id,
    state,
    prNumber: null,
    title: `Test item ${id}`,
    lastTransition: "2026-03-25T00:00:00Z",
    ciFailCount: 0,
    retryCount: 0,
    ...overrides,
  };
}

function createDeps(
  io: DaemonIO & { files: Map<string, string> },
  daemonAlive: boolean = false,
): RetryDeps & { cleanedIds: string[]; logs: string[]; errors: string[] } {
  const cleanedIds: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    io,
    check: () => daemonAlive,
    cleanWorktree: (id: string) => {
      cleanedIds.push(id);
      return true;
    },
    log: (msg) => logs.push(msg),
    logError: (msg) => errors.push(msg),
    cleanedIds,
    logs,
    errors,
  };
}

function seedState(
  io: ReturnType<typeof createMockIO>,
  state: DaemonState,
): void {
  io.files.set(
    "/project/.ninthwave/orchestrator.state.json",
    JSON.stringify(state, null, 2),
  );
}

// ── Tests ────────────────────────────────────────────────────────────

describe("cmdRetry", () => {
  let io: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    io = createMockIO();
    // Mock process.exit for die() calls
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("dies with usage when no IDs provided", () => {
    const deps = createDeps(io);
    expect(() => cmdRetry([], "/worktrees", "/project", deps)).toThrow(
      "process.exit",
    );
  });

  it("dies when no state file exists", () => {
    const deps = createDeps(io);
    expect(() => cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps)).toThrow(
      "process.exit",
    );
  });

  it("resets a stuck item to queued", () => {
    const state = makeState([
      makeItem("H-PRX-4", "stuck", { retryCount: 3, ciFailCount: 2, prNumber: 42 }),
    ]);
    seedState(io, state);
    const deps = createDeps(io);

    const result = cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps);

    expect(result).toContain("H-PRX-4: reset to queued");
    expect(deps.cleanedIds).toContain("H-PRX-4");

    // Verify state was written back
    const updated = JSON.parse(
      io.files.get("/project/.ninthwave/orchestrator.state.json")!,
    ) as DaemonState;
    const item = updated.items.find((i) => i.id === "H-PRX-4")!;
    expect(item.state).toBe("queued");
    expect(item.retryCount).toBe(0);
    expect(item.ciFailCount).toBe(0);
    expect(item.prNumber).toBeNull();
  });

  it("resets a done item to queued", () => {
    const state = makeState([makeItem("H-PRX-4", "done")]);
    seedState(io, state);
    const deps = createDeps(io);

    const result = cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps);

    expect(result).toContain("H-PRX-4: reset to queued");
  });

  it("resets multiple items", () => {
    const state = makeState([
      makeItem("H-PRX-4", "stuck"),
      makeItem("H-PRX-5", "stuck"),
    ]);
    seedState(io, state);
    const deps = createDeps(io);

    const result = cmdRetry(
      ["H-PRX-4", "H-PRX-5"],
      "/worktrees",
      "/project",
      deps,
    );

    expect(result).toContain("H-PRX-4: reset to queued");
    expect(result).toContain("H-PRX-5: reset to queued");
    expect(deps.cleanedIds).toEqual(["H-PRX-4", "H-PRX-5"]);
  });

  it("rejects retrying an implementing item", () => {
    const state = makeState([makeItem("H-PRX-4", "implementing")]);
    seedState(io, state);
    const deps = createDeps(io);

    const result = cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps);

    expect(result).toContain("H-PRX-4: skipped (active: implementing)");
    expect(deps.errors[0]).toContain('currently in "implementing" state');
    expect(deps.cleanedIds).toEqual([]);
  });

  it("rejects retrying a ci-pending item", () => {
    const state = makeState([makeItem("H-PRX-4", "ci-pending")]);
    seedState(io, state);
    const deps = createDeps(io);

    const result = cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps);

    expect(result).toContain("H-PRX-4: skipped (active: ci-pending)");
  });

  it("rejects retrying a queued item", () => {
    const state = makeState([makeItem("H-PRX-4", "queued")]);
    seedState(io, state);
    const deps = createDeps(io);

    const result = cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps);

    expect(result).toContain("H-PRX-4: skipped (active: queued)");
  });

  it("produces clear error for non-existent ID", () => {
    const state = makeState([makeItem("H-PRX-4", "stuck")]);
    seedState(io, state);
    const deps = createDeps(io);

    const result = cmdRetry(["H-NOPE-1"], "/worktrees", "/project", deps);

    expect(result).toContain("H-NOPE-1: not found");
    expect(deps.errors[0]).toContain("not found in orchestrator state");
  });

  it("handles mixed valid and invalid IDs", () => {
    const state = makeState([
      makeItem("H-PRX-4", "stuck"),
      makeItem("H-PRX-5", "implementing"),
    ]);
    seedState(io, state);
    const deps = createDeps(io);

    const result = cmdRetry(
      ["H-PRX-4", "H-PRX-5", "H-NOPE-1"],
      "/worktrees",
      "/project",
      deps,
    );

    expect(result).toContain("H-PRX-4: reset to queued");
    expect(result).toContain("H-PRX-5: skipped (active: implementing)");
    expect(result).toContain("H-NOPE-1: not found");
    // Only H-PRX-4 should have been cleaned
    expect(deps.cleanedIds).toEqual(["H-PRX-4"]);
  });

  it("resets retry count to 0", () => {
    const state = makeState([
      makeItem("H-PRX-4", "stuck", { retryCount: 5 }),
    ]);
    seedState(io, state);
    const deps = createDeps(io);

    cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps);

    const updated = JSON.parse(
      io.files.get("/project/.ninthwave/orchestrator.state.json")!,
    ) as DaemonState;
    expect(updated.items[0]!.retryCount).toBe(0);
  });

  it("does not write state file when no items were reset", () => {
    const state = makeState([makeItem("H-PRX-4", "implementing")]);
    seedState(io, state);
    const writeCount = (io.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.length;
    const deps = createDeps(io);

    cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps);

    // writeFileSync should not have been called again (state already seeded it once)
    expect((io.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      writeCount,
    );
  });

  it("suggests starting orchestrator when daemon not running", () => {
    const state = makeState([makeItem("H-PRX-4", "stuck")]);
    seedState(io, state);
    const deps = createDeps(io, false);

    cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps);

    const daemonMsg = deps.logs.find((l) => l.includes("Daemon is not running"));
    expect(daemonMsg).toBeDefined();
    expect(daemonMsg).toContain("ninthwave orchestrate");
  });

  it("notifies running daemon via SIGUSR1", () => {
    const state = makeState([makeItem("H-PRX-4", "stuck")]);
    seedState(io, state);
    // Also seed PID file so isDaemonRunning finds it
    io.files.set("/project/.ninthwave/orchestrator.pid", "5678");
    const deps = createDeps(io, true);

    // Spy on process.kill to capture the SIGUSR1 signal
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps);

    // process.kill should have been called with SIGUSR1
    const sigusr1Call = killSpy.mock.calls.find(
      (c) => c[1] === "SIGUSR1",
    );
    expect(sigusr1Call).toBeDefined();
    expect(sigusr1Call![0]).toBe(5678);

    killSpy.mockRestore();
  });

  it("updates lastTransition timestamp on reset", () => {
    const oldTime = "2026-03-24T00:00:00Z";
    const state = makeState([
      makeItem("H-PRX-4", "stuck", { lastTransition: oldTime }),
    ]);
    seedState(io, state);
    const deps = createDeps(io);

    cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps);

    const updated = JSON.parse(
      io.files.get("/project/.ninthwave/orchestrator.state.json")!,
    ) as DaemonState;
    expect(updated.items[0]!.lastTransition).not.toBe(oldTime);
  });

  it("filters out flags from IDs", () => {
    const state = makeState([makeItem("H-PRX-4", "stuck")]);
    seedState(io, state);
    const deps = createDeps(io);

    const result = cmdRetry(
      ["--force", "H-PRX-4"],
      "/worktrees",
      "/project",
      deps,
    );

    expect(result).toContain("H-PRX-4: reset to queued");
  });

  it("handles worktree cleanup failure gracefully", () => {
    const state = makeState([makeItem("H-PRX-4", "stuck")]);
    seedState(io, state);
    const deps = createDeps(io);
    // Override cleanWorktree to return false (no worktree found)
    deps.cleanWorktree = (id: string) => {
      deps.cleanedIds.push(id);
      return false;
    };

    const result = cmdRetry(["H-PRX-4"], "/worktrees", "/project", deps);

    // Should still reset even if no worktree to clean
    expect(result).toContain("H-PRX-4: reset to queued");
  });
});
