import { describe, it, expect, afterEach } from "vitest";
import { setupTempRepo, useFixtureDir, cleanupTempRepos } from "./helpers.ts";
import { join } from "path";
import { cmdList } from "../core/commands/list.ts";
import type { TodoItem, TaskBackend } from "../core/types.ts";
import type { DiscoveredBackend } from "../core/backend-registry.ts";

describe("list", () => {
  afterEach(() => cleanupTempRepos());

  function captureOutput(fn: () => void): string {
    const lines: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    console.error = (...args: unknown[]) => lines.push(args.join(" "));

    const origExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never;

    try {
      fn();
    } catch (e: unknown) {
      if (e instanceof Error && !e.message.startsWith("EXIT:")) throw e;
    } finally {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
    }

    return lines.join("\n");
  }

  it("lists all items with no filters", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() => cmdList([], todosDir, worktreeDir));

    expect(output).toContain("M-CI-1");
    expect(output).toContain("H-CI-2");
    expect(output).toContain("C-UO-1");
    expect(output).toContain("H-UO-2");
    expect(output).toContain("4 items");
  });

  it("filters by priority", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--priority", "high"], todosDir, worktreeDir),
    );

    expect(output).toContain("H-CI-2");
    expect(output).toContain("H-UO-2");
    // M-CI-1 may appear in DEPENDS ON column, but should not appear as a row ID
    const lines = output.split("\n").filter((l) => l.startsWith("M-CI-1"));
    expect(lines).toHaveLength(0);
    const cLines = output.split("\n").filter((l) => l.startsWith("C-UO-1"));
    expect(cLines).toHaveLength(0);
    expect(output).toContain("2 items");
  });

  it("filters by domain", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--domain", "cloud-infrastructure"], todosDir, worktreeDir),
    );

    expect(output).toContain("M-CI-1");
    expect(output).toContain("H-CI-2");
    expect(output).not.toContain("C-UO-1");
    expect(output).not.toContain("H-UO-2");
    expect(output).toContain("2 items");
  });

  it("filters by feature code", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--feature", "UO"], todosDir, worktreeDir),
    );

    expect(output).toContain("C-UO-1");
    expect(output).toContain("H-UO-2");
    // M-CI-1 may appear in DEPENDS ON column, but should not appear as a row ID
    const mLines = output.split("\n").filter((l) => l.startsWith("M-CI-1"));
    expect(mLines).toHaveLength(0);
    const hLines = output.split("\n").filter((l) => l.startsWith("H-CI-2"));
    expect(hLines).toHaveLength(0);
    expect(output).toContain("2 items");
  });

  it("filters by ready (deps all satisfied)", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--ready"], todosDir, worktreeDir),
    );

    // M-CI-1 has no deps -> ready
    // C-UO-1 has no deps -> ready
    // H-CI-2 depends on M-CI-1 (still in todo files) -> not ready
    // H-UO-2 depends on C-UO-1 and M-CI-1 (both in todo files) -> not ready
    expect(output).toContain("M-CI-1");
    expect(output).toContain("C-UO-1");
    expect(output).not.toContain("H-CI-2");
    expect(output).not.toContain("H-UO-2");
    expect(output).toContain("2 items");
  });

  it("--depth 1 is equivalent to --ready", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--depth", "1"], todosDir, worktreeDir),
    );

    expect(output).toContain("M-CI-1");
    expect(output).toContain("C-UO-1");
    expect(output).not.toContain("H-CI-2");
    expect(output).not.toContain("H-UO-2");
    expect(output).toContain("2 items");
  });

  it("--depth 2 includes items one hop from ready roots", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--depth", "2"], todosDir, worktreeDir),
    );

    // Depth 1: M-CI-1, C-UO-1 (no deps)
    // Depth 2: H-CI-2 (dep: M-CI-1), H-UO-2 (deps: C-UO-1, M-CI-1)
    expect(output).toContain("M-CI-1");
    expect(output).toContain("C-UO-1");
    expect(output).toContain("H-CI-2");
    expect(output).toContain("H-UO-2");
    expect(output).toContain("4 items");
  });

  it("--depth implies --ready", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    // --depth without --ready should still filter
    const output = captureOutput(() =>
      cmdList(["--depth", "1"], todosDir, worktreeDir),
    );

    expect(output).toContain("2 items");
  });

  it("--depth with invalid value exits with error", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() =>
      cmdList(["--depth", "0"], todosDir, worktreeDir),
    );

    expect(output).toContain("--depth requires a positive integer");
  });

  it("shows repo label for cross-repo items", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "cross_repo.md");
    const worktreeDir = join(repo, ".worktrees");

    const output = captureOutput(() => cmdList([], todosDir, worktreeDir));

    expect(output).toContain("target-repo-a");
    expect(output).toContain("H-API-1");
  });
});

// --- Backend integration tests ---

/** Create a mock TaskBackend that returns fixed items. */
function mockBackend(items: TodoItem[]): TaskBackend {
  return {
    list: () => items,
    read: (id: string) => items.find((i) => i.id === id),
    markDone: () => true,
  };
}

/** Create a minimal TodoItem for testing. */
function makeTodoItem(overrides: Partial<TodoItem>): TodoItem {
  return {
    id: "TEST-1",
    priority: "medium",
    title: "Test item",
    domain: "test",
    dependencies: [],
    bundleWith: [],
    status: "open",
    filePath: "",
    repoAlias: "",
    rawText: "",
    filePaths: [],
    testPlan: "",
    ...overrides,
  };
}

describe("list with backend discovery", () => {
  afterEach(() => cleanupTempRepos());

  function captureOutput(fn: () => void): string {
    const lines: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    console.error = (...args: unknown[]) => lines.push(args.join(" "));

    const origExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never;

    try {
      fn();
    } catch (e: unknown) {
      if (e instanceof Error && !e.message.startsWith("EXIT:")) throw e;
    } finally {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
    }

    return lines.join("\n");
  }

  it("shows source labels when external backends are discovered", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const sentryItem = makeTodoItem({
      id: "SNT-100",
      priority: "high",
      title: "Sentry error",
      domain: "backend",
    });

    const mockDiscover = (): DiscoveredBackend[] => [
      { name: "sentry", backend: mockBackend([sentryItem]) },
    ];

    const output = captureOutput(() =>
      cmdList([], todosDir, worktreeDir, repo, {
        discoverBackends: mockDiscover,
      }),
    );

    // Should show SOURCE column
    expect(output).toContain("SOURCE");
    // Local items should have [local] label
    expect(output).toContain("[local]");
    // Sentry item should have [sentry] label
    expect(output).toContain("[sentry]");
    // Should include both local and sentry items
    expect(output).toContain("M-CI-1");
    expect(output).toContain("SNT-100");
    expect(output).toContain("5 items"); // 4 local + 1 sentry
  });

  it("does not show source labels when no external backends found", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const mockDiscover = (): DiscoveredBackend[] => [];

    const output = captureOutput(() =>
      cmdList([], todosDir, worktreeDir, repo, {
        discoverBackends: mockDiscover,
      }),
    );

    // Should NOT show SOURCE column
    expect(output).not.toContain("SOURCE");
    expect(output).not.toContain("[local]");
    // Local items still shown
    expect(output).toContain("M-CI-1");
    expect(output).toContain("4 items");
  });

  it("shows items from multiple external backends with correct labels", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const sentryItem = makeTodoItem({
      id: "SNT-200",
      title: "Sentry issue",
      domain: "api",
    });
    const pdItem = makeTodoItem({
      id: "PGD-300",
      title: "PagerDuty incident",
      domain: "infra",
    });

    const mockDiscover = (): DiscoveredBackend[] => [
      { name: "sentry", backend: mockBackend([sentryItem]) },
      { name: "pagerduty", backend: mockBackend([pdItem]) },
    ];

    const output = captureOutput(() =>
      cmdList([], todosDir, worktreeDir, repo, {
        discoverBackends: mockDiscover,
      }),
    );

    expect(output).toContain("[local]");
    expect(output).toContain("[sentry]");
    expect(output).toContain("[pagerduty]");
    expect(output).toContain("SNT-200");
    expect(output).toContain("PGD-300");
    expect(output).toContain("6 items"); // 4 local + 1 sentry + 1 pagerduty
  });

  it("local items always appear regardless of external backends", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const mockDiscover = (): DiscoveredBackend[] => [
      { name: "sentry", backend: mockBackend([]) },
    ];

    const output = captureOutput(() =>
      cmdList([], todosDir, worktreeDir, repo, {
        discoverBackends: mockDiscover,
      }),
    );

    // All 4 local items still present
    expect(output).toContain("M-CI-1");
    expect(output).toContain("H-CI-2");
    expect(output).toContain("C-UO-1");
    expect(output).toContain("H-UO-2");
    expect(output).toContain("4 items");
  });

  it("gracefully handles backend that throws during list()", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const failingBackend: TaskBackend = {
      list: () => {
        throw new Error("Network error");
      },
      read: () => undefined,
      markDone: () => false,
    };

    const mockDiscover = (): DiscoveredBackend[] => [
      { name: "sentry", backend: failingBackend },
    ];

    const output = captureOutput(() =>
      cmdList([], todosDir, worktreeDir, repo, {
        discoverBackends: mockDiscover,
      }),
    );

    // Should still show local items
    expect(output).toContain("M-CI-1");
    // Should show warning about unavailable backend
    expect(output).toContain("unavailable");
    // Should have 4 local items (sentry failed)
    expect(output).toContain("4 items");
  });

  it("filters apply to both local and external items", () => {
    const repo = setupTempRepo();
    const todosDir = useFixtureDir(repo, "valid.md");
    const worktreeDir = join(repo, ".worktrees");

    const sentryItemHigh = makeTodoItem({
      id: "SNT-400",
      priority: "high",
      title: "High priority sentry",
      domain: "api",
    });
    const sentryItemLow = makeTodoItem({
      id: "SNT-401",
      priority: "low",
      title: "Low priority sentry",
      domain: "api",
    });

    const mockDiscover = (): DiscoveredBackend[] => [
      {
        name: "sentry",
        backend: mockBackend([sentryItemHigh, sentryItemLow]),
      },
    ];

    const output = captureOutput(() =>
      cmdList(["--priority", "high"], todosDir, worktreeDir, repo, {
        discoverBackends: mockDiscover,
      }),
    );

    // Should include high-priority items from both sources
    expect(output).toContain("H-CI-2"); // local high
    expect(output).toContain("H-UO-2"); // local high
    expect(output).toContain("SNT-400"); // sentry high
    // Should NOT include low-priority sentry item
    expect(output).not.toContain("SNT-401");
    expect(output).toContain("3 items"); // 2 local high + 1 sentry high
  });
});
