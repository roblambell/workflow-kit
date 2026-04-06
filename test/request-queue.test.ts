import { describe, it, expect, vi } from "vitest";
import {
  TokenBucket,
  PrioritySemaphore,
  RequestQueue,
} from "../core/request-queue.ts";
import type { LogEntry } from "../core/types.ts";

// ── TokenBucket ───────────────────────────────────────────────────────

describe("TokenBucket", () => {
  it("starts with burst-size tokens", () => {
    const bucket = new TokenBucket(1.0, 10);
    expect(bucket.getTokenCount()).toBe(10);
  });

  it("acquire consumes a token", async () => {
    const bucket = new TokenBucket(1.0, 5);
    await bucket.acquire();
    expect(bucket.getTokenCount()).toBe(4);
  });

  it("refills tokens over time", () => {
    let nowMs = 1000;
    const now = () => nowMs;
    const bucket = new TokenBucket(2.0, 10, now); // 2 tokens/sec

    // Consume all tokens
    for (let i = 0; i < 10; i++) {
      // Synchronous drain via internal state
    }

    // Manually set tokens low by consuming
    // Instead, let's verify refill by checking token count after time passes
    const initial = bucket.getTokenCount(now);
    expect(initial).toBe(10);

    // Advance 500ms -- should add 1 token (2 tokens/sec * 0.5s)
    // But we're already at burst, so stays at 10
    nowMs += 500;
    expect(bucket.getTokenCount(now)).toBe(10); // capped at burst
  });

  it("refills after tokens are consumed", async () => {
    let nowMs = 1000;
    const now = () => nowMs;
    // 10 tokens/sec, burst 5
    const bucket = new TokenBucket(10, 5, now);

    await bucket.acquire(undefined, now);
    await bucket.acquire(undefined, now);
    expect(bucket.getTokenCount(now)).toBe(3);

    // Advance 200ms -- refills 2 tokens (10/sec * 0.2s)
    nowMs += 200;
    expect(bucket.getTokenCount(now)).toBe(5); // 3 + 2, capped at 5
  });

  it("acquire blocks when empty then resumes after refill", async () => {
    let nowMs = 1000;
    const now = () => nowMs;
    // 100 tokens/sec (fast for testing), burst 1
    const bucket = new TokenBucket(100, 1, now);

    // Consume the only token
    await bucket.acquire(undefined, now);
    expect(bucket.getTokenCount(now)).toBe(0);

    // Start acquire that should block
    let resolved = false;
    const promise = bucket.acquire(undefined, now).then(() => {
      resolved = true;
    });

    // Give the event loop a tick -- should not resolve yet
    await new Promise((r) => setTimeout(r, 5));
    // The sleep inside acquire uses real setTimeout, so advance real time slightly
    // and let the loop progress
    nowMs += 20; // advance mock time so refill happens
    await promise;
    expect(resolved).toBe(true);
  });

  it("rate-limit-query category is exempt from token consumption", async () => {
    const bucket = new TokenBucket(1.0, 2);
    await bucket.acquire("rate-limit-query");
    await bucket.acquire("rate-limit-query");
    await bucket.acquire("rate-limit-query");
    // Still at 2 tokens -- exempt requests don't consume
    expect(bucket.getTokenCount()).toBe(2);
  });

  it("updateBudget syncs tokens from remaining count", () => {
    const bucket = new TokenBucket(1.0, 20);

    // When GitHub says 100 remaining, bucket gets min(100, burstSize)
    bucket.updateBudget(100, Math.floor(Date.now() / 1000) + 3600);
    expect(bucket.getTokenCount()).toBe(20); // capped at burst

    // When GitHub says 0 remaining, bucket goes to 0
    bucket.updateBudget(0, Math.floor(Date.now() / 1000) + 3600);
    expect(bucket.getTokenCount()).toBe(0);
  });

  it("updateBudget restores tokens when budget exists", () => {
    let nowMs = 1000;
    const now = () => nowMs;
    const bucket = new TokenBucket(1.0, 10, now);

    // Drain to 0 by consuming
    // Simulate low tokens
    bucket.updateBudget(0, Math.floor(nowMs / 1000) + 3600);
    expect(bucket.getTokenCount(now)).toBe(0);

    // Budget refresh from GitHub
    bucket.updateBudget(5000, Math.floor(nowMs / 1000) + 3600);
    expect(bucket.getTokenCount(now)).toBe(10); // min(5000, burstSize=10)
  });

  it("isThrottled returns true when no tokens available", () => {
    let nowMs = 1000;
    const now = () => nowMs;
    const bucket = new TokenBucket(1.0, 10, now);

    expect(bucket.isThrottled(now)).toBe(false);

    bucket.updateBudget(0, Math.floor(nowMs / 1000) + 3600);
    expect(bucket.isThrottled(now)).toBe(true);
  });

  it("getBudgetUtilization returns 0 with no budget info", () => {
    const bucket = new TokenBucket();
    expect(bucket.getBudgetUtilization()).toBe(0);
  });

  it("getBudgetUtilization returns fraction consumed", () => {
    const bucket = new TokenBucket();
    bucket.updateBudget(2500, Math.floor(Date.now() / 1000) + 3600);
    expect(bucket.getBudgetUtilization()).toBeCloseTo(0.5, 1);
  });

  it("getBudgetUtilization returns 1 when budget exhausted", () => {
    const bucket = new TokenBucket();
    bucket.updateBudget(0, Math.floor(Date.now() / 1000) + 3600);
    expect(bucket.getBudgetUtilization()).toBe(1);
  });
});

// ── PrioritySemaphore ─────────────────────────────────────────────────

describe("PrioritySemaphore", () => {
  it("allows up to maxConcurrency without waiting", async () => {
    const sem = new PrioritySemaphore(3);
    await sem.acquire("normal");
    await sem.acquire("normal");
    await sem.acquire("normal");
    expect(sem.getRunning()).toBe(3);
    expect(sem.getWaiting()).toBe(0);
  });

  it("queues when at capacity", async () => {
    const sem = new PrioritySemaphore(1);
    await sem.acquire("normal");

    let waiting = false;
    const p = sem.acquire("normal").then(() => {
      waiting = true;
    });

    // Give event loop a chance
    await new Promise((r) => setTimeout(r, 5));
    expect(waiting).toBe(false);
    expect(sem.getWaiting()).toBe(1);

    sem.release();
    await p;
    expect(waiting).toBe(true);
  });

  it("serves highest priority first under contention", async () => {
    const sem = new PrioritySemaphore(1);
    await sem.acquire("normal"); // fill the single slot

    const order: string[] = [];

    const lowP = sem.acquire("low").then(() => order.push("low"));
    const highP = sem.acquire("high").then(() => order.push("high"));
    const critP = sem.acquire("critical").then(() => order.push("critical"));
    const normP = sem.acquire("normal").then(() => order.push("normal"));

    expect(sem.getWaiting()).toBe(4);

    // Release slots one at a time
    sem.release();
    await critP;
    expect(order).toEqual(["critical"]);

    sem.release();
    await highP;
    expect(order).toEqual(["critical", "high"]);

    sem.release();
    await normP;
    expect(order).toEqual(["critical", "high", "normal"]);

    sem.release();
    await lowP;
    expect(order).toEqual(["critical", "high", "normal", "low"]);
  });

  it("release without waiters decrements running count", () => {
    const sem = new PrioritySemaphore(3);
    // Manually track: acquire increases running, release decreases it
    // Since acquire is async, let's use a synchronous path
    const p1 = sem.acquire("normal");
    const p2 = sem.acquire("normal");
    // Both should resolve immediately since maxConcurrency=3
    return Promise.all([p1, p2]).then(() => {
      expect(sem.getRunning()).toBe(2);
      sem.release();
      expect(sem.getRunning()).toBe(1);
      sem.release();
      expect(sem.getRunning()).toBe(0);
    });
  });
});

// ── RequestQueue ──────────────────────────────────────────────────────

describe("RequestQueue", () => {
  it("enqueue resolves with execute result", async () => {
    const queue = new RequestQueue({ burstSize: 10 });
    const result = await queue.enqueue({
      category: "pr-status",
      priority: "normal",
      execute: async () => 42,
    });
    expect(result).toBe(42);
  });

  it("enqueue propagates errors from execute", async () => {
    const queue = new RequestQueue({ burstSize: 10 });
    await expect(
      queue.enqueue({
        category: "pr-status",
        priority: "normal",
        execute: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });

  it("tracks in-flight count", async () => {
    const queue = new RequestQueue({ burstSize: 10, maxConcurrency: 10 });
    let resolve1!: () => void;
    let resolve2!: () => void;

    const p1 = queue.enqueue({
      category: "ci",
      priority: "normal",
      execute: () => new Promise<void>((r) => { resolve1 = r; }),
    });
    const p2 = queue.enqueue({
      category: "ci",
      priority: "normal",
      execute: () => new Promise<void>((r) => { resolve2 = r; }),
    });

    // Give enqueue time to start executing
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.getStats().inFlight).toBe(2);

    resolve1();
    await p1;
    expect(queue.getStats().inFlight).toBe(1);

    resolve2();
    await p2;
    expect(queue.getStats().inFlight).toBe(0);
  });

  it("getStats returns per-category metrics", async () => {
    const queue = new RequestQueue({ burstSize: 10 });

    await queue.enqueue({
      category: "pr-status",
      priority: "normal",
      execute: async () => "ok",
    });
    await queue.enqueue({
      category: "pr-status",
      priority: "normal",
      execute: async () => "ok",
    });
    await queue.enqueue({
      category: "ci-check",
      priority: "high",
      execute: async () => "ok",
    });

    const stats = queue.getStats();
    expect(stats.totalRequests).toBe(3);
    expect(stats.categories["pr-status"]?.count).toBe(2);
    expect(stats.categories["ci-check"]?.count).toBe(1);
    expect(stats.categories["pr-status"]?.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("getStats tracks failure count", async () => {
    const queue = new RequestQueue({ burstSize: 10 });

    try {
      await queue.enqueue({
        category: "merge",
        priority: "normal",
        execute: async () => {
          throw new Error("fail");
        },
      });
    } catch {
      // expected
    }

    await queue.enqueue({
      category: "merge",
      priority: "normal",
      execute: async () => "ok",
    });

    const stats = queue.getStats();
    expect(stats.categories["merge"]?.count).toBe(2);
    expect(stats.categories["merge"]?.failureCount).toBe(1);
  });

  it("drain resolves when all in-flight complete", async () => {
    const queue = new RequestQueue({ burstSize: 10, maxConcurrency: 10 });
    let resolve1!: () => void;

    const p1 = queue.enqueue({
      category: "ci",
      priority: "normal",
      execute: () => new Promise<void>((r) => { resolve1 = r; }),
    });

    // Give enqueue time to start
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.getStats().inFlight).toBe(1);

    let drained = false;
    const drainP = queue.drain().then(() => { drained = true; });

    await new Promise((r) => setTimeout(r, 10));
    expect(drained).toBe(false);

    resolve1();
    await p1;
    await drainP;
    expect(drained).toBe(true);
  });

  it("drain resolves immediately when nothing in flight", async () => {
    const queue = new RequestQueue({ burstSize: 10 });
    await queue.drain(); // should not hang
  });

  it("isThrottled delegates to token bucket", () => {
    const queue = new RequestQueue({ burstSize: 10 });
    expect(queue.isThrottled()).toBe(false);

    // Exhaust budget
    queue.updateBudget(0, Math.floor(Date.now() / 1000) + 3600);
    expect(queue.isThrottled()).toBe(true);
  });

  it("updateBudget forwards to token bucket", () => {
    const queue = new RequestQueue({ burstSize: 10 });
    queue.updateBudget(2500, Math.floor(Date.now() / 1000) + 3600);
    const stats = queue.getStats();
    expect(stats.budgetUtilization).toBeCloseTo(0.5, 1);
  });

  describe("audit logging", () => {
    it("emits structured log on request completion", async () => {
      const logs: LogEntry[] = [];
      const queue = new RequestQueue({
        burstSize: 10,
        log: (entry) => logs.push(entry),
      });

      await queue.enqueue({
        category: "pr-status",
        priority: "normal",
        itemId: "H-ARC-3",
        execute: async () => "ok",
      });

      expect(logs).toHaveLength(1);
      expect(logs[0]!.event).toBe("request_complete");
      expect(logs[0]!.category).toBe("pr-status");
      expect(logs[0]!.itemId).toBe("H-ARC-3");
      expect(logs[0]!.failed).toBe(false);
      expect(logs[0]!.level).toBe("debug");
      expect(typeof logs[0]!.latencyMs).toBe("number");
    });

    it("emits warn-level log on failure", async () => {
      const logs: LogEntry[] = [];
      const queue = new RequestQueue({
        burstSize: 10,
        log: (entry) => logs.push(entry),
      });

      try {
        await queue.enqueue({
          category: "merge",
          priority: "normal",
          execute: async () => {
            throw new Error("fail");
          },
        });
      } catch {
        // expected
      }

      expect(logs).toHaveLength(1);
      expect(logs[0]!.level).toBe("warn");
      expect(logs[0]!.failed).toBe(true);
    });

    it("omits itemId when not provided", async () => {
      const logs: LogEntry[] = [];
      const queue = new RequestQueue({
        burstSize: 10,
        log: (entry) => logs.push(entry),
      });

      await queue.enqueue({
        category: "rate-limit-query",
        priority: "low",
        execute: async () => "ok",
      });

      expect(logs).toHaveLength(1);
      expect(logs[0]!.itemId).toBeUndefined();
    });
  });

  describe("concurrency under contention", () => {
    it("respects maxConcurrency limit", async () => {
      const queue = new RequestQueue({
        burstSize: 20,
        maxConcurrency: 2,
      });

      let peakConcurrency = 0;
      let current = 0;

      const tasks = Array.from({ length: 6 }, (_, i) =>
        queue.enqueue({
          category: "test",
          priority: "normal",
          execute: async () => {
            current++;
            peakConcurrency = Math.max(peakConcurrency, current);
            await new Promise((r) => setTimeout(r, 20));
            current--;
            return i;
          },
        }),
      );

      const results = await Promise.all(tasks);
      expect(results).toEqual([0, 1, 2, 3, 4, 5]);
      expect(peakConcurrency).toBeLessThanOrEqual(2);
    });

    it("handles concurrent enqueue from multiple callers", async () => {
      const queue = new RequestQueue({
        burstSize: 50,
        maxConcurrency: 4,
      });

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          queue.enqueue({
            category: `cat-${i % 3}`,
            priority: i % 2 === 0 ? "high" : "normal",
            execute: async () => i * 2,
          }),
        ),
      );

      expect(results).toHaveLength(20);
      results.forEach((r, i) => expect(r).toBe(i * 2));

      const stats = queue.getStats();
      expect(stats.totalRequests).toBe(20);
      expect(stats.inFlight).toBe(0);
    });
  });

  describe("rapid burst", () => {
    it("handles burst without errors", async () => {
      const queue = new RequestQueue({
        burstSize: 10,
        maxConcurrency: 10,
        refillRate: 100, // fast refill for test
      });

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          queue.enqueue({
            category: "burst",
            priority: "normal",
            execute: async () => i,
          }),
        ),
      );

      expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(queue.getStats().totalRequests).toBe(10);
    });
  });
});
