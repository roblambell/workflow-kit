// Centralized GitHub API request queue with token bucket rate limiting,
// priority-based concurrency control, and audit logging.
//
// Pure infrastructure -- controls timing and ordering of requests but never
// changes what requests are made or how results are interpreted.

import type { LogEntry, Priority } from "./types.ts";

// ── Types ─────────────────────────────────────────────────────────────

export type RequestPriority = "critical" | "high" | "normal" | "low";

const PRIORITY_ORDER: Record<RequestPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface EnqueueOptions<T> {
  category: string;
  priority: RequestPriority;
  itemId?: string;
  execute: () => Promise<T>;
}

export interface CategoryMetrics {
  count: number;
  avgLatencyMs: number;
  failureCount: number;
}

export interface RequestQueueStats {
  totalRequests: number;
  inFlight: number;
  queued: number;
  categories: Record<string, CategoryMetrics>;
  budgetUtilization: number;
}

// ── Token Bucket ──────────────────────────────────────────────────────

/** Target 85% of GitHub's 5000/hr limit = 4250/hr ~= 1.18 tokens/sec. */
const DEFAULT_REFILL_RATE = 4250 / 3600; // ~1.18 tokens/sec
const DEFAULT_BURST_SIZE = 20;
const EXEMPT_CATEGORY = "rate-limit-query";

export class TokenBucket {
  private tokens: number;
  private readonly burstSize: number;
  private readonly refillRate: number; // tokens/sec
  private lastRefillMs: number;
  private budgetRemaining: number | null = null;
  private budgetResetAt: number | null = null; // unix seconds

  constructor(
    refillRate: number = DEFAULT_REFILL_RATE,
    burstSize: number = DEFAULT_BURST_SIZE,
    now: () => number = Date.now,
  ) {
    this.refillRate = refillRate;
    this.burstSize = burstSize;
    this.tokens = burstSize;
    this.lastRefillMs = now();
  }

  /**
   * Sync with actual GitHub rate limit headers.
   * `remaining` is the number of requests left. `resetAt` is unix seconds
   * when the limit resets.
   */
  updateBudget(remaining: number, resetAt: number): void {
    this.budgetRemaining = remaining;
    this.budgetResetAt = resetAt;

    // If GitHub says we have budget left, ensure we have at least some tokens
    if (remaining > 0) {
      this.tokens = Math.max(this.tokens, Math.min(remaining, this.burstSize));
    } else {
      this.tokens = 0;
    }
  }

  /**
   * Acquire a token. Returns immediately if available, otherwise waits.
   * Exempt categories (e.g., rate-limit-query) bypass token consumption.
   */
  async acquire(category?: string, now: () => number = Date.now): Promise<void> {
    if (category === EXEMPT_CATEGORY) return;

    this.refill(now());

    while (this.tokens < 1) {
      const waitMs = this.msUntilNextToken(now());
      await sleep(waitMs);
      this.refill(now());
    }

    this.tokens -= 1;
    if (this.budgetRemaining !== null && this.budgetRemaining > 0) {
      this.budgetRemaining -= 1;
    }
  }

  /** Check if the bucket is throttled (no tokens available). */
  isThrottled(now: () => number = Date.now): boolean {
    this.refill(now());
    return this.tokens < 1;
  }

  /** Current token count (for testing/stats). */
  getTokenCount(now: () => number = Date.now): number {
    this.refill(now());
    return this.tokens;
  }

  /** Budget utilization: fraction of budget consumed (0-1). Returns 0 when no budget info. */
  getBudgetUtilization(): number {
    if (this.budgetRemaining === null || this.budgetResetAt === null) return 0;
    // GitHub gives 5000/hr. Utilization = 1 - (remaining / 5000)
    const total = 5000;
    return Math.max(0, Math.min(1, 1 - this.budgetRemaining / total));
  }

  private refill(nowMs: number): void {
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) return;

    const newTokens = (elapsedMs / 1000) * this.refillRate;
    this.tokens = Math.min(this.burstSize, this.tokens + newTokens);
    this.lastRefillMs = nowMs;
  }

  private msUntilNextToken(nowMs: number): number {
    // If we know the budget reset time and tokens are zero, wait for reset
    if (
      this.budgetRemaining !== null &&
      this.budgetRemaining <= 0 &&
      this.budgetResetAt !== null
    ) {
      const resetMs = this.budgetResetAt * 1000;
      const waitMs = resetMs - nowMs;
      if (waitMs > 0) return Math.min(waitMs, 60_000);
    }

    // Otherwise wait for natural refill
    const deficit = 1 - this.tokens;
    if (deficit <= 0) return 0;
    return Math.ceil((deficit / this.refillRate) * 1000);
  }
}

// ── Priority Semaphore ────────────────────────────────────────────────

interface WaitEntry {
  priority: RequestPriority;
  resolve: () => void;
}

const DEFAULT_CONCURRENCY = 6;

export class PrioritySemaphore {
  private running = 0;
  private readonly maxConcurrency: number;
  private readonly waitQueue: WaitEntry[] = [];

  constructor(maxConcurrency: number = DEFAULT_CONCURRENCY) {
    this.maxConcurrency = maxConcurrency;
  }

  /** Acquire a slot. Waits if all slots are in use. Higher priority gets served first. */
  async acquire(priority: RequestPriority): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push({ priority, resolve });
    });
  }

  /** Release a slot, waking the highest-priority waiter. */
  release(): void {
    if (this.waitQueue.length > 0) {
      // Find highest priority entry (lowest number)
      let bestIdx = 0;
      let bestPriority = PRIORITY_ORDER[this.waitQueue[0]!.priority];
      for (let i = 1; i < this.waitQueue.length; i++) {
        const p = PRIORITY_ORDER[this.waitQueue[i]!.priority];
        if (p < bestPriority) {
          bestPriority = p;
          bestIdx = i;
        }
      }

      const entry = this.waitQueue.splice(bestIdx, 1)[0]!;
      // Don't decrement running -- the released slot goes to the waiter
      entry.resolve();
    } else {
      this.running--;
    }
  }

  /** Number of currently running requests. */
  getRunning(): number {
    return this.running;
  }

  /** Number of requests waiting for a slot. */
  getWaiting(): number {
    return this.waitQueue.length;
  }
}

// ── Request Queue (Facade) ────────────────────────────────────────────

interface InFlightEntry {
  category: string;
  itemId?: string;
  startMs: number;
}

interface CategoryAccumulator {
  count: number;
  totalLatencyMs: number;
  failureCount: number;
}

export class RequestQueue {
  private readonly tokenBucket: TokenBucket;
  private readonly semaphore: PrioritySemaphore;
  private readonly log: (entry: LogEntry) => void;
  private readonly inFlight = new Map<symbol, InFlightEntry>();
  private readonly categories = new Map<string, CategoryAccumulator>();
  private totalRequests = 0;
  private drainPromise: Promise<void> | null = null;
  private drainResolve: (() => void) | null = null;

  constructor(opts?: {
    refillRate?: number;
    burstSize?: number;
    maxConcurrency?: number;
    log?: (entry: LogEntry) => void;
    now?: () => number;
  }) {
    this.tokenBucket = new TokenBucket(
      opts?.refillRate,
      opts?.burstSize,
      opts?.now,
    );
    this.semaphore = new PrioritySemaphore(opts?.maxConcurrency);
    this.log = opts?.log ?? (() => {});
  }

  /**
   * Enqueue a request. Waits for both a rate-limit token and a concurrency
   * slot, then executes the closure and returns the result.
   */
  async enqueue<T>(opts: EnqueueOptions<T>): Promise<T> {
    const { category, priority, itemId, execute } = opts;

    // Acquire token (rate limiting) then concurrency slot
    await this.tokenBucket.acquire(category);
    await this.semaphore.acquire(priority);

    const key = Symbol();
    const startMs = Date.now();
    this.inFlight.set(key, { category, itemId, startMs });
    this.totalRequests++;

    try {
      const result = await execute();
      this.recordCompletion(key, category, startMs, false);
      return result;
    } catch (err) {
      this.recordCompletion(key, category, startMs, true);
      throw err;
    } finally {
      this.semaphore.release();
      this.inFlight.delete(key);
      this.checkDrain();
    }
  }

  /** Sync token bucket with GitHub's rate limit headers. */
  updateBudget(remaining: number, resetAt: number): void {
    this.tokenBucket.updateBudget(remaining, resetAt);
  }

  /** Wait for all in-flight requests to complete. */
  async drain(): Promise<void> {
    if (this.inFlight.size === 0) return;

    if (!this.drainPromise) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.drainResolve = resolve;
      });
    }
    return this.drainPromise;
  }

  /** Check if the token bucket is throttled. */
  isThrottled(): boolean {
    return this.tokenBucket.isThrottled();
  }

  /** Get queue statistics. */
  getStats(): RequestQueueStats {
    const categories: Record<string, CategoryMetrics> = {};
    for (const [cat, acc] of this.categories) {
      categories[cat] = {
        count: acc.count,
        avgLatencyMs: acc.count > 0 ? Math.round(acc.totalLatencyMs / acc.count) : 0,
        failureCount: acc.failureCount,
      };
    }

    return {
      totalRequests: this.totalRequests,
      inFlight: this.inFlight.size,
      queued: this.semaphore.getWaiting(),
      categories,
      budgetUtilization: this.tokenBucket.getBudgetUtilization(),
    };
  }

  private recordCompletion(
    key: symbol,
    category: string,
    startMs: number,
    failed: boolean,
  ): void {
    const latencyMs = Date.now() - startMs;
    const entry = this.inFlight.get(key);

    // Update category accumulator
    let acc = this.categories.get(category);
    if (!acc) {
      acc = { count: 0, totalLatencyMs: 0, failureCount: 0 };
      this.categories.set(category, acc);
    }
    acc.count++;
    acc.totalLatencyMs += latencyMs;
    if (failed) acc.failureCount++;

    // Emit audit log
    this.log({
      ts: new Date().toISOString(),
      level: failed ? "warn" : "debug",
      event: "request_complete",
      category,
      ...(entry?.itemId ? { itemId: entry.itemId } : {}),
      latencyMs,
      failed,
    });
  }

  private checkDrain(): void {
    if (this.inFlight.size === 0 && this.drainResolve) {
      this.drainResolve();
      this.drainPromise = null;
      this.drainResolve = null;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}
