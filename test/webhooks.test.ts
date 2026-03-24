// Tests for core/webhooks.ts — URL resolution, payload formatting, fire-and-forget delivery,
// and integration with the orchestrate loop. Uses dependency injection (no vi.mock).

import { describe, it, expect, vi } from "vitest";
import {
  resolveWebhookUrl,
  formatWebhookText,
  fireWebhook,
  createWebhookNotifier,
  type WebhookPayload,
  type WebhookFetchFn,
  type WebhookNotifyFn,
  type WebhookEvent,
} from "../core/webhooks.ts";
import {
  orchestrateLoop,
  type LogEntry,
  type OrchestrateLoopDeps,
} from "../core/commands/orchestrate.ts";
import {
  Orchestrator,
  type PollSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
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
    testPlan: "",
  };
}

function mockActionDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    launchSingleItem: vi.fn(() => ({
      worktreePath: "/tmp/test/todo-test",
      workspaceRef: "workspace:1",
    })),
    cleanSingleWorktree: vi.fn(() => true),
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

function mockFetch(status = 200): WebhookFetchFn {
  return vi.fn(() => Promise.resolve({ ok: status < 400, status }));
}

// ── resolveWebhookUrl ───────────────────────────────────────────────

describe("resolveWebhookUrl", () => {
  it("returns env var when NINTHWAVE_WEBHOOK_URL is set", () => {
    const url = resolveWebhookUrl(undefined, {
      NINTHWAVE_WEBHOOK_URL: "https://hooks.slack.com/test",
    });
    expect(url).toBe("https://hooks.slack.com/test");
  });

  it("returns null when no URL is configured", () => {
    const url = resolveWebhookUrl(undefined, {});
    expect(url).toBeNull();
  });

  it("reads webhook_url from config file", () => {
    const fakeConfig = vi.fn(() => ({
      locExtensions: "",
      webhook_url: "https://discord.com/webhook",
    }));
    const url = resolveWebhookUrl("/tmp/project", {}, fakeConfig);
    expect(url).toBe("https://discord.com/webhook");
    expect(fakeConfig).toHaveBeenCalledWith("/tmp/project");
  });

  it("env var takes precedence over config file", () => {
    const fakeConfig = vi.fn(() => ({
      locExtensions: "",
      webhook_url: "https://from-config.com",
    }));
    const url = resolveWebhookUrl(
      "/tmp/project",
      { NINTHWAVE_WEBHOOK_URL: "https://from-env.com" },
      fakeConfig,
    );
    expect(url).toBe("https://from-env.com");
    // Config loader should not be called when env var exists
    expect(fakeConfig).not.toHaveBeenCalled();
  });

  it("returns null when config loader throws", () => {
    const fakeConfig = vi.fn(() => {
      throw new Error("file not found");
    });
    const url = resolveWebhookUrl("/tmp/project", {}, fakeConfig);
    expect(url).toBeNull();
  });
});

// ── formatWebhookText ───────────────────────────────────────────────

describe("formatWebhookText", () => {
  it("formats batch_complete with summary and items", () => {
    const text = formatWebhookText("batch_complete", {
      summary: { done: 2, stuck: 0, total: 5 },
      items: [
        { id: "A-1", state: "done" },
        { id: "A-2", state: "done" },
      ],
    });
    expect(text).toContain("Batch complete");
    expect(text).toContain("2 done");
    expect(text).toContain("5 total");
    expect(text).toContain("A-1");
    expect(text).toContain("A-2");
  });

  it("formats pr_merged with item and PR number", () => {
    const text = formatWebhookText("pr_merged", {
      itemId: "T-1-1",
      prNumber: 42,
    });
    expect(text).toContain("PR #42");
    expect(text).toContain("T-1-1");
  });

  it("formats ci_failed with item details", () => {
    const text = formatWebhookText("ci_failed", {
      itemId: "T-2-1",
      prNumber: 99,
    });
    expect(text).toContain("CI failed");
    expect(text).toContain("T-2-1");
    expect(text).toContain("PR #99");
  });

  it("formats orchestrate_complete with full summary", () => {
    const text = formatWebhookText("orchestrate_complete", {
      summary: { done: 3, stuck: 1, total: 4 },
      items: [
        { id: "A-1", state: "done", prNumber: 10 },
        { id: "A-2", state: "done", prNumber: 11 },
        { id: "A-3", state: "done" },
        { id: "A-4", state: "stuck" },
      ],
    });
    expect(text).toContain("Orchestration complete");
    expect(text).toContain("3 done");
    expect(text).toContain("1 stuck");
    expect(text).toContain("4 total");
    expect(text).toContain("A-1");
    expect(text).toContain("PR #10");
  });
});

// ── fireWebhook ─────────────────────────────────────────────────────

describe("fireWebhook", () => {
  it("POSTs JSON payload to URL", async () => {
    const fetchFn = mockFetch();
    const payload: WebhookPayload = {
      text: "test",
      event: "pr_merged",
      timestamp: "2026-03-24T12:00:00Z",
      itemId: "T-1",
      prNumber: 1,
    };
    await fireWebhook("https://hooks.example.com", payload, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith("https://hooks.example.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: expect.any(AbortSignal),
    });
  });

  it("logs error on network failure but does not throw", async () => {
    const fetchFn = vi.fn(() => Promise.reject(new Error("network down")));
    const logError = vi.fn();
    await fireWebhook("https://hooks.example.com", {
      text: "test",
      event: "ci_failed",
      timestamp: "2026-03-24T12:00:00Z",
    }, fetchFn, logError);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("network down"));
  });

  it("logs error on non-OK HTTP status but does not throw", async () => {
    const fetchFn = mockFetch(500);
    const logError = vi.fn();
    await fireWebhook("https://hooks.example.com", {
      text: "test",
      event: "ci_failed",
      timestamp: "2026-03-24T12:00:00Z",
    }, fetchFn, logError);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("500"));
  });

  it("passes an AbortSignal to the fetch function", async () => {
    const fetchFn = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve({ ok: true, status: 200 });
    }) as unknown as WebhookFetchFn;
    await fireWebhook("https://hooks.example.com", {
      text: "test",
      event: "pr_merged",
      timestamp: "2026-03-24T12:00:00Z",
    }, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("aborts fetch that exceeds timeout and logs an error", async () => {
    const logError = vi.fn();
    // Create a fetch that waits until aborted by the signal
    const slowFetch: WebhookFetchFn = (_url, init) => {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new Error("The operation was aborted"));
        });
      });
    };

    // Monkey-patch setTimeout to make the 10_000ms timeout fire instantly for this test
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, _ms: number) => {
      return origSetTimeout(fn, 0); // fire immediately
    }) as typeof globalThis.setTimeout;

    try {
      await fireWebhook("https://hooks.example.com", {
        text: "test",
        event: "ci_failed",
        timestamp: "2026-03-24T12:00:00Z",
      }, slowFetch, logError);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("abort"),
    );
  });

  it("does not abort fast responses and clears timeout", async () => {
    const fetchFn = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      // Verify signal is not aborted for fast responses
      expect(init.signal?.aborted).toBe(false);
      return Promise.resolve({ ok: true, status: 200 });
    }) as unknown as WebhookFetchFn;
    const logError = vi.fn();
    await fireWebhook("https://hooks.example.com", {
      text: "test",
      event: "pr_merged",
      timestamp: "2026-03-24T12:00:00Z",
    }, fetchFn, logError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });
});

// ── createWebhookNotifier ───────────────────────────────────────────

describe("createWebhookNotifier", () => {
  it("returns no-op when URL is null", () => {
    const notify = createWebhookNotifier(null);
    // Should not throw
    notify("pr_merged", { itemId: "T-1", prNumber: 1 });
  });

  it("fires webhook with formatted payload when URL is set", async () => {
    const fetchFn = mockFetch();
    const notify = createWebhookNotifier("https://hooks.example.com", fetchFn);
    notify("pr_merged", { itemId: "T-1", prNumber: 42 });
    // Wait for fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.event).toBe("pr_merged");
    expect(body.itemId).toBe("T-1");
    expect(body.prNumber).toBe(42);
    expect(body.text).toContain("PR #42");
    expect(body.text).toContain("T-1");
    expect(body.timestamp).toBeTruthy();
  });

  it("includes event type, item IDs, and summary stats in payload", async () => {
    const fetchFn = mockFetch();
    const notify = createWebhookNotifier("https://hooks.example.com", fetchFn);
    notify("batch_complete", {
      items: [
        { id: "A-1", state: "done" },
        { id: "A-2", state: "implementing" },
      ],
      summary: { done: 1, stuck: 0, total: 2 },
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.event).toBe("batch_complete");
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toBe("A-1");
    expect(body.summary.done).toBe(1);
    expect(body.summary.total).toBe(2);
  });
});

// ── createWebhookNotifier debounce ──────────────────────────────────

describe("createWebhookNotifier debounce", () => {
  it("coalesces rapid events within the debounce window into one webhook call", async () => {
    const fetchFn = mockFetch();
    const notify = createWebhookNotifier("https://hooks.example.com", fetchFn, undefined, {
      debounceMs: 100,
    });

    // Fire 3 events rapidly (within the 100ms window)
    notify("pr_merged", { itemId: "T-1", prNumber: 1 });
    notify("ci_failed", { itemId: "T-2", prNumber: 2 });
    notify("pr_merged", { itemId: "T-3", prNumber: 3 });

    // Flush immediately instead of waiting for timer
    notify.flush!();

    // Wait for fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 10));

    // Should have made exactly one fetch call (coalesced)
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.batched).toHaveLength(3);
    expect(body.text).toContain("3 events coalesced");
  });

  it("preserves all event data in coalesced payload", async () => {
    const fetchFn = mockFetch();
    const notify = createWebhookNotifier("https://hooks.example.com", fetchFn, undefined, {
      debounceMs: 100,
    });

    notify("pr_merged", { itemId: "T-1", prNumber: 10 });
    notify("ci_failed", { itemId: "T-2", prNumber: 20, error: "build failed" });
    notify("batch_complete", {
      items: [{ id: "A-1", state: "done" }],
      summary: { done: 1, stuck: 0, total: 1 },
    });

    notify.flush!();
    await new Promise((r) => setTimeout(r, 10));

    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.batched).toHaveLength(3);

    // Verify each individual payload preserves its data
    const [first, second, third] = body.batched;

    expect(first.event).toBe("pr_merged");
    expect(first.itemId).toBe("T-1");
    expect(first.prNumber).toBe(10);
    expect(first.timestamp).toBeTruthy();
    expect(first.text).toContain("PR #10");

    expect(second.event).toBe("ci_failed");
    expect(second.itemId).toBe("T-2");
    expect(second.prNumber).toBe(20);
    expect(second.error).toBe("build failed");
    expect(second.text).toContain("CI failed");

    expect(third.event).toBe("batch_complete");
    expect(third.items).toHaveLength(1);
    expect(third.items[0].id).toBe("A-1");
    expect(third.summary.done).toBe(1);
    expect(third.text).toContain("Batch complete");
  });

  it("sends single events individually after the debounce window", async () => {
    const fetchFn = mockFetch();
    const notify = createWebhookNotifier("https://hooks.example.com", fetchFn, undefined, {
      debounceMs: 50,
    });

    // Fire a single event
    notify("pr_merged", { itemId: "T-1", prNumber: 42 });

    // Wait for the debounce window to expire
    await new Promise((r) => setTimeout(r, 100));

    // Should have fired exactly one fetch call
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    // Single event should NOT have a batched wrapper
    expect(body.batched).toBeUndefined();
    expect(body.event).toBe("pr_merged");
    expect(body.itemId).toBe("T-1");
    expect(body.prNumber).toBe(42);
    expect(body.text).toContain("PR #42");
  });

  it("events separated by more than the debounce window are sent individually", async () => {
    const fetchFn = mockFetch();
    const notify = createWebhookNotifier("https://hooks.example.com", fetchFn, undefined, {
      debounceMs: 30,
    });

    // Fire first event
    notify("pr_merged", { itemId: "T-1", prNumber: 1 });

    // Wait for debounce window to expire
    await new Promise((r) => setTimeout(r, 60));

    // Fire second event after the first has been flushed
    notify("ci_failed", { itemId: "T-2", prNumber: 2 });

    // Wait for second debounce window to expire
    await new Promise((r) => setTimeout(r, 60));

    // Should have made two separate fetch calls
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const body1 = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body1.event).toBe("pr_merged");
    expect(body1.itemId).toBe("T-1");
    expect(body1.batched).toBeUndefined();

    const body2 = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(body2.event).toBe("ci_failed");
    expect(body2.itemId).toBe("T-2");
    expect(body2.batched).toBeUndefined();
  });

  it("flush() is a no-op when buffer is empty", () => {
    const fetchFn = mockFetch();
    const notify = createWebhookNotifier("https://hooks.example.com", fetchFn, undefined, {
      debounceMs: 100,
    });

    // Flush with nothing buffered — should not call fetch
    notify.flush!();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("no-debounce mode fires immediately without flush", async () => {
    const fetchFn = mockFetch();
    // No debounce option — should work exactly as before
    const notify = createWebhookNotifier("https://hooks.example.com", fetchFn);

    notify("pr_merged", { itemId: "T-1", prNumber: 1 });
    notify("ci_failed", { itemId: "T-2", prNumber: 2 });

    await new Promise((r) => setTimeout(r, 10));

    // Each event fires its own webhook immediately
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // flush should not be present
    expect(notify.flush).toBeUndefined();
  });

  it("flush() is not present on no-op notifier", () => {
    const notify = createWebhookNotifier(null);
    expect(notify.flush).toBeUndefined();
  });
});

// ── Integration with orchestrateLoop ────────────────────────────────

describe("orchestrateLoop webhook integration", () => {
  it("fires webhook on batch_complete event with correct payload", async () => {
    // Two items: T-1 has no deps, T-2 depends on T-1
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1"));
    orch.addItem(makeTodo("T-2", ["T-1"]));

    let cycle = 0;
    const notifyCalls: Array<{ event: WebhookEvent; data: Record<string, unknown> }> = [];
    const notify: WebhookNotifyFn = (event, data) => {
      notifyCalls.push({ event, data: data as Record<string, unknown> });
    };

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1: // T-1 deps met → ready
          return { items: [], readyIds: ["T-1"] };
        case 2: // T-1 worker alive
          return { items: [{ id: "T-1", workerAlive: true }], readyIds: [] };
        case 3: // T-1 PR + CI pass → merge
          return { items: [{ id: "T-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
        case 4: // T-1 merged, T-2 deps met → ready
          return { items: [], readyIds: ["T-2"] };
        case 5: // T-2 worker alive
          return { items: [{ id: "T-2", workerAlive: true }], readyIds: [] };
        case 6: // T-2 PR + CI pass → merge
          return { items: [{ id: "T-2", prNumber: 2, prState: "open", ciStatus: "pass" }], readyIds: [] };
        case 7: // T-2 merged
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      notify,
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    // Should have batch_complete when T-1 finishes (T-2 is still queued)
    const batchEvents = notifyCalls.filter((c) => c.event === "batch_complete");
    expect(batchEvents.length).toBeGreaterThanOrEqual(1);
    // First batch_complete should have T-1 as done
    const first = batchEvents[0];
    const items = first.data.items as Array<{ id: string; state: string }>;
    const doneItem = items.find((i) => i.id === "T-1");
    expect(doneItem?.state).toBe("done");
    const summary = first.data.summary as { done: number; stuck: number; total: number };
    expect(summary.done).toBeGreaterThanOrEqual(1);
    expect(summary.total).toBe(2);
  });

  it("fires webhook on ci_failed with item details", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1"));

    let cycle = 0;
    const notifyCalls: Array<{ event: WebhookEvent; data: Record<string, unknown> }> = [];
    const notify: WebhookNotifyFn = (event, data) => {
      notifyCalls.push({ event, data: data as Record<string, unknown> });
    };

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1"] };
        case 2:
          return { items: [{ id: "T-1", workerAlive: true }], readyIds: [] };
        case 3: // PR with CI failure
          return { items: [{ id: "T-1", prNumber: 5, prState: "open", ciStatus: "fail" }], readyIds: [] };
        case 4: // CI recovers
          return { items: [{ id: "T-1", prNumber: 5, prState: "open", ciStatus: "pass" }], readyIds: [] };
        case 5: // merged
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      notify,
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    const ciEvents = notifyCalls.filter((c) => c.event === "ci_failed");
    expect(ciEvents.length).toBe(1);
    expect(ciEvents[0].data.itemId).toBe("T-1");
    expect(ciEvents[0].data.prNumber).toBe(5);
  });

  it("no webhook fires when notify is not provided", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1"));

    let cycle = 0;
    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1"] };
        case 2:
          return { items: [{ id: "T-1", workerAlive: true }], readyIds: [] };
        case 3:
          return { items: [{ id: "T-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
        case 4:
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    // No notify provided — should not crash
    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      // notify is intentionally omitted
    };

    // Should complete without error
    await orchestrateLoop(orch, defaultCtx, deps);
    expect(orch.getItem("T-1")?.state).toBe("done");
  });

  it("webhook failure is logged but does not block orchestration", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1"));

    let cycle = 0;
    // Create a notifier that throws internally (simulating fetch failure)
    const failingFetch: WebhookFetchFn = () => Promise.reject(new Error("connection refused"));
    const logError = vi.fn();
    const notify = createWebhookNotifier("https://hooks.example.com", failingFetch, logError);

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1"] };
        case 2:
          return { items: [{ id: "T-1", workerAlive: true }], readyIds: [] };
        case 3:
          return { items: [{ id: "T-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
        case 4:
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      notify,
    };

    // Should complete without error even though webhooks fail
    await orchestrateLoop(orch, defaultCtx, deps);
    expect(orch.getItem("T-1")?.state).toBe("done");

    // Wait for fire-and-forget promises to settle
    await new Promise((r) => setTimeout(r, 50));
    // logError should have been called for webhook failures
    expect(logError).toHaveBeenCalled();
    expect(logError.mock.calls[0][0]).toContain("connection refused");
  });

  it("fires orchestrate_complete with summary stats", async () => {
    const orch = new Orchestrator({ wipLimit: 2, mergeStrategy: "asap" });
    orch.addItem(makeTodo("T-1"));

    let cycle = 0;
    const notifyCalls: Array<{ event: WebhookEvent; data: Record<string, unknown> }> = [];
    const notify: WebhookNotifyFn = (event, data) => {
      notifyCalls.push({ event, data: data as Record<string, unknown> });
    };

    const buildSnapshot = (): PollSnapshot => {
      cycle++;
      switch (cycle) {
        case 1:
          return { items: [], readyIds: ["T-1"] };
        case 2:
          return { items: [{ id: "T-1", workerAlive: true }], readyIds: [] };
        case 3:
          return { items: [{ id: "T-1", prNumber: 1, prState: "open", ciStatus: "pass" }], readyIds: [] };
        case 4:
          return { items: [], readyIds: [] };
        default:
          return { items: [], readyIds: [] };
      }
    };

    const deps: OrchestrateLoopDeps = {
      buildSnapshot,
      sleep: () => Promise.resolve(),
      log: () => {},
      actionDeps: mockActionDeps(),
      notify,
    };

    await orchestrateLoop(orch, defaultCtx, deps);

    const completeEvents = notifyCalls.filter((c) => c.event === "orchestrate_complete");
    expect(completeEvents.length).toBe(1);
    const data = completeEvents[0].data;
    const summary = data.summary as { done: number; stuck: number; total: number };
    expect(summary.done).toBe(1);
    expect(summary.stuck).toBe(0);
    expect(summary.total).toBe(1);
    const items = data.items as Array<{ id: string; state: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("T-1");
    expect(items[0].state).toBe("done");
  });
});
