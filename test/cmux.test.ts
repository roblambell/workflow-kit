// Tests for cmux sendMessage — paste-then-submit, verification, and retry.
// Imports from core/send-message.ts (not core/cmux.ts) to avoid vi.mock leaks
// from start.test.ts. Uses dependency injection per project conventions.

import { describe, it, expect, vi } from "vitest";
import {
  sendMessageImpl,
  verifyDelivery,
  type SendMessageDeps,
} from "../core/send-message.ts";
import type { RunResult } from "../core/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a successful RunResult. */
function ok(stdout = ""): RunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

/** Build a failed RunResult. */
function fail(stderr = "error"): RunResult {
  return { stdout: "", stderr, exitCode: 1 };
}

/**
 * Create a runner that dispatches on cmux subcommand.
 * Each key maps a subcommand to a result or function.
 */
function dispatchRunner(
  handlers: Record<string, RunResult | (() => RunResult)>,
) {
  const fn = vi.fn((_cmd: string, args: string[]): RunResult => {
    const subcommand = args[0] ?? "";
    const handler = handlers[subcommand];
    if (!handler) return ok();
    return typeof handler === "function" ? handler() : handler;
  });
  return fn;
}

/** Build deps with a dispatch runner and mock sleep. */
function makeDeps(
  handlers: Record<string, RunResult | (() => RunResult)>,
  overrides?: Partial<SendMessageDeps>,
): SendMessageDeps & { runner: ReturnType<typeof dispatchRunner>; sleep: ReturnType<typeof vi.fn> } {
  const runner = dispatchRunner(handlers);
  const sleep = vi.fn();
  return { runner, sleep, ...overrides };
}

// ── sendMessageImpl: paste-then-submit flow ──────────────────────────

describe("sendMessageImpl", () => {
  it("sends message via set-buffer, paste-buffer, send-key, and verifies", () => {
    const deps = makeDeps({
      "set-buffer": ok(),
      "paste-buffer": ok(),
      "send-key": ok(),
      "read-screen": ok(""),
    });

    const result = sendMessageImpl("workspace:1", "Hello worker", deps);

    expect(result).toBe(true);

    // Verify the exact cmux calls in order
    const calls = deps.runner.mock.calls;
    expect(calls[0]).toEqual(["cmux", ["set-buffer", "--name", "_nw_send", "Hello worker"]]);
    expect(calls[1]).toEqual([
      "cmux",
      ["paste-buffer", "--name", "_nw_send", "--workspace", "workspace:1"],
    ]);
    expect(calls[2]).toEqual(["cmux", ["send-key", "--workspace", "workspace:1", "Return"]]);
    expect(calls[3]).toEqual([
      "cmux",
      ["read-screen", "--workspace", "workspace:1", "--lines", "3"],
    ]);
  });

  it("waits between paste and Return, and after Return before verify", () => {
    const deps = makeDeps({
      "set-buffer": ok(),
      "paste-buffer": ok(),
      "send-key": ok(),
      "read-screen": ok(""),
    });

    sendMessageImpl("workspace:1", "test message", deps);

    // sleep(50) after paste, sleep(100) after send-key before verify
    expect(deps.sleep).toHaveBeenCalledWith(50);
    expect(deps.sleep).toHaveBeenCalledWith(100);
  });

  it("returns true on first attempt when delivery succeeds", () => {
    const deps = makeDeps({
      "set-buffer": ok(),
      "paste-buffer": ok(),
      "send-key": ok(),
      "read-screen": ok("claude> "),
    });

    const result = sendMessageImpl("workspace:1", "check status", deps);

    expect(result).toBe(true);
    // 4 cmux calls = one attempt (set-buffer, paste-buffer, send-key, read-screen)
    expect(deps.runner).toHaveBeenCalledTimes(4);
  });

  // ── Retry behavior ──────────────────────────────────────────────────

  it("retries with exponential backoff when set-buffer fails", () => {
    let setBufCalls = 0;
    const runner = vi.fn((_cmd: string, args: string[]): RunResult => {
      const sub = args[0];
      if (sub === "set-buffer") {
        setBufCalls++;
        return setBufCalls <= 2 ? fail() : ok();
      }
      return ok();
    });
    const sleep = vi.fn();

    const result = sendMessageImpl("workspace:1", "retry test", {
      runner,
      sleep,
      maxRetries: 3,
      baseDelayMs: 100,
    });

    expect(result).toBe(true);
    // Backoff sleeps before retry attempts
    expect(sleep).toHaveBeenCalledWith(100); // attempt 2: 100 * 2^0
    expect(sleep).toHaveBeenCalledWith(200); // attempt 3: 100 * 2^1
  });

  it("retries when verification detects stuck message", () => {
    let readScreenCalls = 0;
    const runner = vi.fn((_cmd: string, args: string[]): RunResult => {
      const sub = args[0];
      if (sub === "read-screen") {
        readScreenCalls++;
        // First verify: message stuck in input; second: submitted
        return readScreenCalls === 1
          ? ok("user@host $ \nRebase onto main please")
          : ok("claude> ");
      }
      return ok();
    });
    const sleep = vi.fn();

    const result = sendMessageImpl("workspace:1", "Rebase onto main please", {
      runner,
      sleep,
      maxRetries: 3,
      baseDelayMs: 50,
    });

    expect(result).toBe(true);
    // Two full send attempts (first failed verify, second succeeded)
    expect(readScreenCalls).toBe(2);
  });

  it("returns false after exhausting all retries", () => {
    // Every set-buffer call fails
    const runner = vi.fn((): RunResult => fail("socket error"));
    const sleep = vi.fn();

    const result = sendMessageImpl("workspace:1", "doomed", {
      runner,
      sleep,
      maxRetries: 2,
      baseDelayMs: 50,
    });

    expect(result).toBe(false);
    // 3 total attempts (initial + 2 retries), each calls set-buffer once
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("returns false when paste-buffer fails on every attempt", () => {
    const runner = vi.fn((_cmd: string, args: string[]): RunResult => {
      if (args[0] === "paste-buffer") return fail("paste failed");
      return ok();
    });
    const sleep = vi.fn();

    const result = sendMessageImpl("workspace:1", "msg", {
      runner,
      sleep,
      maxRetries: 1,
      baseDelayMs: 50,
    });

    expect(result).toBe(false);
  });

  it("returns false when send-key fails on every attempt", () => {
    const runner = vi.fn((_cmd: string, args: string[]): RunResult => {
      if (args[0] === "send-key") return fail("key failed");
      return ok();
    });
    const sleep = vi.fn();

    const result = sendMessageImpl("workspace:1", "msg", {
      runner,
      sleep,
      maxRetries: 1,
      baseDelayMs: 50,
    });

    expect(result).toBe(false);
  });

  it("uses default retries (3) and delay (100ms) when not specified", () => {
    const runner = vi.fn((): RunResult => fail());
    const sleep = vi.fn();

    sendMessageImpl("workspace:1", "msg", { runner, sleep });

    // 4 total attempts (initial + 3 retries)
    expect(runner).toHaveBeenCalledTimes(4);
    // Backoff delays: 100, 200, 400
    expect(sleep).toHaveBeenCalledWith(100);
    expect(sleep).toHaveBeenCalledWith(200);
    expect(sleep).toHaveBeenCalledWith(400);
  });

  it("handles empty message", () => {
    const deps = makeDeps({
      "set-buffer": ok(),
      "paste-buffer": ok(),
      "send-key": ok(),
      "read-screen": ok(""),
    });

    const result = sendMessageImpl("workspace:1", "", deps);
    expect(result).toBe(true);
  });
});

// ── verifyDelivery ───────────────────────────────────────────────────

describe("verifyDelivery", () => {
  it("returns true when screen shows no trace of message", () => {
    const runner = vi.fn(() => ok("Thinking...\nclaude> "));
    expect(verifyDelivery("workspace:1", "hello", runner)).toBe(true);
  });

  it("returns false when message is stuck on the last line", () => {
    const runner = vi.fn(() => ok("Previous output\nhello"));
    expect(verifyDelivery("workspace:1", "hello", runner)).toBe(false);
  });

  it("returns true when read-screen fails (assume success)", () => {
    const runner = vi.fn(() => fail("not connected"));
    expect(verifyDelivery("workspace:1", "hello", runner)).toBe(true);
  });

  it("returns true when screen is empty", () => {
    const runner = vi.fn(() => ok(""));
    expect(verifyDelivery("workspace:1", "hello", runner)).toBe(true);
  });

  it("uses first 60 chars as probe for long messages", () => {
    const longMsg = "A".repeat(100);
    const probe = "A".repeat(60);

    // Last line has the probe → stuck
    const runner = vi.fn(() => ok(`prompt\n${probe}BBBB`));
    expect(verifyDelivery("workspace:1", longMsg, runner)).toBe(false);

    // Last line does NOT have the probe → submitted
    const runner2 = vi.fn(() => ok("prompt\nclaude thinking..."));
    expect(verifyDelivery("workspace:1", longMsg, runner2)).toBe(true);
  });

  it("ignores blank lines when finding the last line", () => {
    const runner = vi.fn(() => ok("claude>\n\n\n"));
    expect(verifyDelivery("workspace:1", "hello", runner)).toBe(true);
  });
});
