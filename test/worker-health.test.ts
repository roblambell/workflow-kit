// Tests for core/worker-health.ts — screen-parsing utilities for detecting
// worker state, ready-wait, post-send verification, and health checking.
//
// Uses dependency injection (mock Multiplexer) — no vi.mock needed.

import { describe, it, expect } from "vitest";
import {
  isInputPromptVisible,
  isWorkerProcessing,
  isWorkerInError,
  isPermissionPrompt,
  simpleHash,
  computeScreenHealth,
  getWorkerHealthStatus,
  checkWorkerHealth,
  waitForInputPrompt,
  verifySendProcessing,
  sendWithReadyWait,
  type WorkerHealthStatus,
  type ScreenHealthStatus,
} from "../core/worker-health.ts";
import type { Multiplexer } from "../core/mux.ts";

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a fake Multiplexer that returns canned screen content. */
function fakeMux(
  readScreenFn: (ref: string, lines?: number) => string = () => "",
  sendMessageFn: (ref: string, message: string) => boolean = () => true,
): Multiplexer {
  return {
    type: "cmux",
    isAvailable: () => true,
    diagnoseUnavailable: () => "not available",
    launchWorkspace: () => null,
    splitPane: () => null,
    sendMessage: sendMessageFn,
    readScreen: readScreenFn,
    listWorkspaces: () => "",
    closeWorkspace: () => true,
  };
}

/** No-op sleep for tests. */
const noopSleep = () => {};

/** Tracking sleep — records sleep calls. */
function trackingSleep() {
  const calls: number[] = [];
  const sleep = (ms: number) => calls.push(ms);
  return { sleep, calls };
}

// ── isInputPromptVisible ─────────────────────────────────────────────

describe("isInputPromptVisible", () => {
  it("detects Claude Code ❯ prompt character", () => {
    const screen = "Welcome to Claude Code\nProject: ninthwave\n❯ ";
    expect(isInputPromptVisible(screen)).toBe(true);
  });

  it("detects 'Enter a prompt' text", () => {
    const screen = "Claude Code v1.0\n\nEnter a prompt to get started";
    expect(isInputPromptVisible(screen)).toBe(true);
  });

  it("detects 'bypass permissions' indicator", () => {
    const screen =
      "Starting Claude Code...\nPermission mode: bypass permissions\n❯ ";
    expect(isInputPromptVisible(screen)).toBe(true);
  });

  it("detects 'What can I help' greeting", () => {
    const screen = "What can I help you with today?\n❯ ";
    expect(isInputPromptVisible(screen)).toBe(true);
  });

  it("detects 'How can I help' greeting variant", () => {
    const screen = "How can I help you today?\n❯ ";
    expect(isInputPromptVisible(screen)).toBe(true);
  });

  it("detects generic '> ' prompt", () => {
    const screen = "opencode v2.0\n> ";
    expect(isInputPromptVisible(screen)).toBe(true);
  });

  it("returns false for empty screen", () => {
    expect(isInputPromptVisible("")).toBe(false);
  });

  it("returns false for whitespace-only screen", () => {
    expect(isInputPromptVisible("   \n  \n  ")).toBe(false);
  });

  it("returns false for loading screen without prompt", () => {
    const screen = "Loading project...\nReading config...\nInitializing...";
    expect(isInputPromptVisible(screen)).toBe(false);
  });

  it("does not false-positive on '>' without trailing space", () => {
    // The indicator is "> " with a space — bare ">" in content shouldn't match
    const screen = "git log --oneline >output.txt\nDone.";
    expect(isInputPromptVisible(screen)).toBe(false);
  });
});

// ── isWorkerProcessing ───────────────────────────────────────────────

describe("isWorkerProcessing", () => {
  it("detects spinner characters (braille)", () => {
    const screen = "⠋ Thinking about your request...";
    expect(isWorkerProcessing(screen)).toBe(true);
  });

  it("detects 'Thinking' keyword", () => {
    const screen = "Claude is Thinking...\n\nPlease wait.";
    expect(isWorkerProcessing(screen)).toBe(true);
  });

  it("detects 'Reading' keyword", () => {
    const screen = "Reading file: core/worker-health.ts\n  Content here...";
    expect(isWorkerProcessing(screen)).toBe(true);
  });

  it("detects 'Writing' keyword", () => {
    const screen = "Writing to: test/worker-health.test.ts";
    expect(isWorkerProcessing(screen)).toBe(true);
  });

  it("detects tool usage indicators like 'Bash('", () => {
    const screen = "Bash(git status)\n  Output here...";
    expect(isWorkerProcessing(screen)).toBe(true);
  });

  it("detects Read( tool usage", () => {
    const screen = "Read(core/mux.ts)\n  Content...";
    expect(isWorkerProcessing(screen)).toBe(true);
  });

  it("detects Edit( tool usage", () => {
    const screen = "Edit(core/mux.ts)\n  old: ...\n  new: ...";
    expect(isWorkerProcessing(screen)).toBe(true);
  });

  it("detects 'Running' keyword", () => {
    const screen = "Running tests...\n  bun test test/";
    expect(isWorkerProcessing(screen)).toBe(true);
  });

  it("detects 'Fetching' keyword", () => {
    const screen = "Fetching latest from origin...";
    expect(isWorkerProcessing(screen)).toBe(true);
  });

  it("returns false for empty screen", () => {
    expect(isWorkerProcessing("")).toBe(false);
  });

  it("returns false for idle prompt screen", () => {
    const screen = "Welcome to Claude Code\n❯ ";
    expect(isWorkerProcessing(screen)).toBe(false);
  });
});

// ── isWorkerInError ──────────────────────────────────────────────────

describe("isWorkerInError", () => {
  it("detects 'Error:' text", () => {
    const screen = "Error: Failed to read file\n  ENOENT: no such file";
    expect(isWorkerInError(screen)).toBe(true);
  });

  it("detects 'FATAL' text", () => {
    const screen = "FATAL: Could not initialize project";
    expect(isWorkerInError(screen)).toBe(true);
  });

  it("detects 'panic:' text", () => {
    const screen = "panic: runtime error: index out of range";
    expect(isWorkerInError(screen)).toBe(true);
  });

  it("detects 'Segmentation fault' text", () => {
    const screen = "Segmentation fault (core dumped)";
    expect(isWorkerInError(screen)).toBe(true);
  });

  it("detects 'Killed' text", () => {
    const screen = "Killed";
    expect(isWorkerInError(screen)).toBe(true);
  });

  it("detects 'OOMKilled' text", () => {
    const screen = "Process OOMKilled by system";
    expect(isWorkerInError(screen)).toBe(true);
  });

  it("detects 'SIGKILL' text", () => {
    const screen = "Process received SIGKILL";
    expect(isWorkerInError(screen)).toBe(true);
  });

  it("returns false for empty screen", () => {
    expect(isWorkerInError("")).toBe(false);
  });

  it("returns false for normal output", () => {
    const screen = "✓ All tests passed\nDone in 2.3s";
    expect(isWorkerInError(screen)).toBe(false);
  });
});

// ── getWorkerHealthStatus ────────────────────────────────────────────

describe("getWorkerHealthStatus", () => {
  it("returns 'loading' for empty screen", () => {
    expect(getWorkerHealthStatus("")).toBe("loading");
  });

  it("returns 'loading' for whitespace-only screen", () => {
    expect(getWorkerHealthStatus("  \n\n  ")).toBe("loading");
  });

  it("returns 'loading' for screen with fewer than 3 lines", () => {
    expect(getWorkerHealthStatus("Loading...\nPlease wait")).toBe("loading");
  });

  it("returns 'prompt' when input prompt is visible", () => {
    const screen =
      "Claude Code v1.0\nProject: ninthwave\nPermission mode: standard\n❯ ";
    expect(getWorkerHealthStatus(screen)).toBe("prompt");
  });

  it("returns 'processing' when worker is actively working", () => {
    const screen =
      "⠋ Reading file: core/mux.ts\n  Content line 1\n  Content line 2\n  More content";
    expect(getWorkerHealthStatus(screen)).toBe("processing");
  });

  it("returns 'error' when error indicators are present", () => {
    const screen =
      "Starting worker...\nError: Could not find file\nStack trace:\n  at ...";
    expect(getWorkerHealthStatus(screen)).toBe("error");
  });

  it("returns 'stalled' for substantial content with no recognized indicators", () => {
    const screen =
      "Some unknown output\nAnother line here\nThird line\nFourth line";
    expect(getWorkerHealthStatus(screen)).toBe("stalled");
  });

  it("error takes priority over processing", () => {
    // If both error and processing indicators are present, error wins
    const screen = "⠋ Reading...\nError: File not found\nAnother line\nFourth";
    expect(getWorkerHealthStatus(screen)).toBe("error");
  });

  it("processing takes priority over prompt", () => {
    // Worker showing both prompt and processing — it's actively working
    const screen = "❯ Start\n⠋ Thinking about the task...\nLine3\nLine4";
    expect(getWorkerHealthStatus(screen)).toBe("processing");
  });
});

// ── checkWorkerHealth (mux-aware) ────────────────────────────────────

describe("checkWorkerHealth", () => {
  it("reads screen from mux and returns health status", () => {
    const mux = fakeMux(() => "⠋ Thinking...\nLine 2\nLine 3\nLine 4");
    expect(checkWorkerHealth(mux, "workspace:1")).toBe("processing");
  });

  it("returns 'loading' when readScreen returns empty", () => {
    const mux = fakeMux(() => "");
    expect(checkWorkerHealth(mux, "workspace:1")).toBe("loading");
  });

  it("returns 'prompt' when screen shows input prompt", () => {
    const mux = fakeMux(
      () => "Claude Code\nProject: test\nReady\n❯ ",
    );
    expect(checkWorkerHealth(mux, "workspace:1")).toBe("prompt");
  });

  it("passes correct ref and lines to readScreen", () => {
    const readCalls: Array<{ ref: string; lines?: number }> = [];
    const mux = fakeMux((ref, lines) => {
      readCalls.push({ ref, lines });
      return "";
    });
    checkWorkerHealth(mux, "workspace:42", 50);
    expect(readCalls).toEqual([{ ref: "workspace:42", lines: 50 }]);
  });

  it("uses default 30 lines when not specified", () => {
    const readCalls: Array<{ ref: string; lines?: number }> = [];
    const mux = fakeMux((ref, lines) => {
      readCalls.push({ ref, lines });
      return "";
    });
    checkWorkerHealth(mux, "workspace:1");
    expect(readCalls[0].lines).toBe(30);
  });
});

// ── waitForInputPrompt ───────────────────────────────────────────────

describe("waitForInputPrompt", () => {
  it("returns true when prompt appears immediately", () => {
    const mux = fakeMux(() => "Claude Code\nReady\n❯ ");
    const { sleep, calls } = trackingSleep();
    const result = waitForInputPrompt(mux, "ws:1", sleep, 5, 100);
    expect(result).toBe(true);
    expect(calls).toEqual([100]); // Just one poll
  });

  it("returns true when prompt appears after loading phase", () => {
    let callCount = 0;
    const mux = fakeMux(() => {
      callCount++;
      if (callCount <= 3) return "Loading...\nPlease wait";
      return "Claude Code\nReady\n❯ ";
    });
    const { sleep } = trackingSleep();
    const result = waitForInputPrompt(mux, "ws:1", sleep, 10, 100);
    expect(result).toBe(true);
  });

  it("returns true when worker starts processing before prompt shows", () => {
    // Tool might auto-start processing without showing a prompt first
    const mux = fakeMux(() => "⠋ Thinking about the task...\nLine2\nLine3");
    const { sleep } = trackingSleep();
    const result = waitForInputPrompt(mux, "ws:1", sleep, 5, 100);
    expect(result).toBe(true);
  });

  it("returns false when timeout is reached without prompt", () => {
    const mux = fakeMux(() => "Loading...\nPlease wait");
    const { sleep, calls } = trackingSleep();
    const result = waitForInputPrompt(mux, "ws:1", sleep, 3, 200);
    expect(result).toBe(false);
    expect(calls).toEqual([200, 200, 200]); // All 3 attempts
  });

  it("respects maxAttempts parameter", () => {
    const mux = fakeMux(() => "");
    const { sleep, calls } = trackingSleep();
    waitForInputPrompt(mux, "ws:1", sleep, 5, 50);
    expect(calls).toHaveLength(5);
  });

  it("respects pollMs parameter", () => {
    const mux = fakeMux(() => "");
    const { sleep, calls } = trackingSleep();
    waitForInputPrompt(mux, "ws:1", sleep, 2, 750);
    expect(calls).toEqual([750, 750]);
  });
});

// ── verifySendProcessing ─────────────────────────────────────────────

describe("verifySendProcessing", () => {
  it("returns true when processing is detected immediately", () => {
    const mux = fakeMux(
      () => "⠋ Thinking about the task...\nLine2\nLine3\nLine4",
    );
    const { sleep } = trackingSleep();
    const result = verifySendProcessing(mux, "ws:1", sleep, 5, 100);
    expect(result).toBe(true);
  });

  it("returns true when processing starts after a delay", () => {
    let callCount = 0;
    const mux = fakeMux(() => {
      callCount++;
      if (callCount <= 2) return "Claude Code\nReady\n❯ Start\n"; // Still showing prompt with input
      return "⠋ Reading project files...\nLine2\nLine3\nLine4";
    });
    const { sleep } = trackingSleep();
    const result = verifySendProcessing(mux, "ws:1", sleep, 5, 100);
    expect(result).toBe(true);
  });

  it("returns false on timeout when worker stays at prompt", () => {
    const mux = fakeMux(() => "Claude Code\nReady\nProject: test\n❯ ");
    const { sleep, calls } = trackingSleep();
    const result = verifySendProcessing(mux, "ws:1", sleep, 3, 100);
    expect(result).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("returns false immediately when error is detected", () => {
    const mux = fakeMux(
      () => "Error: Could not start\nFATAL crash\nLine3\nLine4",
    );
    const { sleep, calls } = trackingSleep();
    const result = verifySendProcessing(mux, "ws:1", sleep, 5, 100);
    expect(result).toBe(false);
    expect(calls).toHaveLength(1); // Bails after first check
  });

  it("returns false on timeout when screen is empty", () => {
    const mux = fakeMux(() => "");
    const { sleep } = trackingSleep();
    const result = verifySendProcessing(mux, "ws:1", sleep, 2, 100);
    expect(result).toBe(false);
  });
});

// ── sendWithReadyWait ────────────────────────────────────────────────

describe("sendWithReadyWait", () => {
  it("succeeds on happy path: prompt appears, send works, processing starts", () => {
    let readCallCount = 0;
    const mux = fakeMux(
      () => {
        readCallCount++;
        // First reads: prompt appears (during waitForInputPrompt)
        if (readCallCount <= 2) return "Claude Code\nReady\n❯ ";
        // After send: processing starts (during verifySendProcessing)
        return "⠋ Thinking...\nLine2\nLine3\nLine4";
      },
      () => true, // sendMessage succeeds
    );
    const { sleep } = trackingSleep();

    const result = sendWithReadyWait(mux, "ws:1", "Start\n", sleep, {
      promptMaxAttempts: 3,
      verifyMaxAttempts: 3,
      maxSendRetries: 2,
    });
    expect(result).toBe(true);
  });

  it("retries send when first verification fails but second succeeds", () => {
    let readCallCount = 0;
    let sendCallCount = 0;
    const mux = fakeMux(
      () => {
        readCallCount++;
        // Read 1: prompt appears (during waitForInputPrompt)
        if (readCallCount === 1) return "Claude Code\nReady\n❯ ";
        // Read 2: still at prompt after first send (verification fails)
        if (readCallCount === 2) return "Claude Code\nReady\n❯ ";
        // Read 3+: processing starts after second send
        return "⠋ Working...\nLine2\nLine3\nLine4";
      },
      () => {
        sendCallCount++;
        return true;
      },
    );
    const { sleep } = trackingSleep();

    const result = sendWithReadyWait(mux, "ws:1", "Start\n", sleep, {
      promptMaxAttempts: 1,
      verifyMaxAttempts: 1,
      maxSendRetries: 3,
    });
    expect(result).toBe(true);
    expect(sendCallCount).toBe(2); // Needed 2 sends
  });

  it("returns false when sendMessage always fails", () => {
    const mux = fakeMux(
      () => "Claude Code\nReady\n❯ ",
      () => false, // sendMessage always fails
    );
    const { sleep } = trackingSleep();

    const result = sendWithReadyWait(mux, "ws:1", "Start\n", sleep, {
      promptMaxAttempts: 1,
      verifyMaxAttempts: 1,
      maxSendRetries: 3,
    });
    expect(result).toBe(false);
  });

  it("returns false when prompt never appears and first send doesn't lead to processing", () => {
    const mux = fakeMux(
      () => "Loading...", // Never shows prompt or processing
      () => true,
    );
    const { sleep } = trackingSleep();

    const result = sendWithReadyWait(mux, "ws:1", "Start\n", sleep, {
      promptMaxAttempts: 2,
      verifyMaxAttempts: 2,
      maxSendRetries: 2,
    });
    expect(result).toBe(false);
  });

  it("still tries sending even when prompt detection times out", () => {
    let readCallCount = 0;
    let sendCalled = false;
    const mux = fakeMux(
      () => {
        readCallCount++;
        // Prompt never appears during wait phase
        if (readCallCount <= 2) return "Loading...";
        // But after send, processing starts
        return "⠋ Thinking...\nLine2\nLine3\nLine4";
      },
      () => {
        sendCalled = true;
        return true;
      },
    );
    const { sleep } = trackingSleep();

    const result = sendWithReadyWait(mux, "ws:1", "Start\n", sleep, {
      promptMaxAttempts: 2,
      verifyMaxAttempts: 1,
      maxSendRetries: 1,
    });
    expect(sendCalled).toBe(true);
    // The send worked and processing was detected
    expect(result).toBe(true);
  });

  it("uses default options when none specified", () => {
    // This test just verifies the function runs with defaults without crashing.
    // Using a quick-resolving mock to avoid huge timeouts.
    const mux = fakeMux(
      () => "⠋ Processing...\nLine2\nLine3\nLine4",
      () => true,
    );
    const { sleep } = trackingSleep();

    // Override only the timing to keep test fast
    const result = sendWithReadyWait(mux, "ws:1", "Start\n", sleep, {
      promptMaxAttempts: 1,
      verifyMaxAttempts: 1,
    });
    expect(result).toBe(true);
  });
});

// ── isPermissionPrompt (H-HLT-1) ────────────────────────────────────

describe("isPermissionPrompt", () => {
  it("detects (Y/n) dialog", () => {
    const screen = "Allow tool_name? (Y/n)";
    expect(isPermissionPrompt(screen)).toBe(true);
  });

  it("detects (y/N) dialog", () => {
    const screen = "Continue? (y/N)";
    expect(isPermissionPrompt(screen)).toBe(true);
  });

  it("detects 'Allow ' prefix", () => {
    const screen = "Allow Bash(git status)?";
    expect(isPermissionPrompt(screen)).toBe(true);
  });

  it("detects 'Yes / No' pattern", () => {
    const screen = "Do you want to proceed? Yes / No";
    expect(isPermissionPrompt(screen)).toBe(true);
  });

  it("detects '(Y)es / (N)o' pattern", () => {
    const screen = "Apply changes? (Y)es / (N)o";
    expect(isPermissionPrompt(screen)).toBe(true);
  });

  it("returns false for empty screen", () => {
    expect(isPermissionPrompt("")).toBe(false);
  });

  it("returns false for whitespace-only screen", () => {
    expect(isPermissionPrompt("  \n  ")).toBe(false);
  });

  it("returns false for normal processing output", () => {
    const screen = "⠋ Thinking...\nReading file\nDone";
    expect(isPermissionPrompt(screen)).toBe(false);
  });
});

// ── simpleHash ───────────────────────────────────────────────────────

describe("simpleHash", () => {
  it("returns same hash for identical strings", () => {
    expect(simpleHash("hello world")).toBe(simpleHash("hello world"));
  });

  it("returns different hashes for different strings", () => {
    expect(simpleHash("hello")).not.toBe(simpleHash("world"));
  });

  it("trims whitespace before hashing", () => {
    expect(simpleHash("  hello  ")).toBe(simpleHash("hello"));
  });

  it("returns consistent hash for empty trimmed content", () => {
    expect(simpleHash("")).toBe(simpleHash("   "));
  });
});

// ── computeScreenHealth (H-HLT-1) ───────────────────────────────────

describe("computeScreenHealth", () => {
  it("returns 'unknown' for empty screen", () => {
    const item = {};
    expect(computeScreenHealth("", item)).toBe("unknown");
  });

  it("returns 'unknown' for whitespace-only screen", () => {
    const item = {};
    expect(computeScreenHealth("  \n  ", item)).toBe("unknown");
  });

  it("returns 'stalled-error' for error output", () => {
    const item = {};
    expect(computeScreenHealth("Error: something broke\nStack trace\nLine3", item)).toBe("stalled-error");
  });

  it("returns 'stalled-permission' for permission prompt", () => {
    const item = {};
    expect(computeScreenHealth("Allow Bash(rm -rf)? (Y/n)\nLine2\nLine3", item)).toBe("stalled-permission");
  });

  it("returns 'healthy' for processing output", () => {
    const item = {};
    expect(computeScreenHealth("⠋ Thinking about the request\nLine2\nLine3", item)).toBe("healthy");
  });

  it("returns 'stalled-empty' for idle prompt", () => {
    const item = {};
    expect(computeScreenHealth("Welcome to Claude\nProject: test\n❯ ", item)).toBe("stalled-empty");
  });

  it("returns 'stalled-unchanged' after threshold unchanged polls", () => {
    const item: { lastScreenHash?: string; unchangedCount?: number } = {};
    const staticScreen = "Some static content\nLine 2\nLine 3\nLine 4";

    // First poll — records hash, returns healthy
    const result1 = computeScreenHealth(staticScreen, item);
    expect(result1).toBe("healthy");
    expect(item.lastScreenHash).toBeDefined();

    // Second poll — same content, count=1
    const result2 = computeScreenHealth(staticScreen, item);
    expect(result2).toBe("healthy");
    expect(item.unchangedCount).toBe(1);

    // Third poll — same content, count=2
    const result3 = computeScreenHealth(staticScreen, item);
    expect(result3).toBe("healthy");
    expect(item.unchangedCount).toBe(2);

    // Fourth poll — count hits threshold (3), returns stalled-unchanged
    const result4 = computeScreenHealth(staticScreen, item);
    expect(result4).toBe("stalled-unchanged");
    expect(item.unchangedCount).toBe(3);
  });

  it("resets unchanged count when screen content changes", () => {
    const item: { lastScreenHash?: string; unchangedCount?: number } = {};

    computeScreenHealth("Content A\nLine2\nLine3\nLine4", item);
    computeScreenHealth("Content A\nLine2\nLine3\nLine4", item);
    expect(item.unchangedCount).toBe(1);

    // Screen changes — reset
    computeScreenHealth("Content B\nLine2\nLine3\nLine4", item);
    expect(item.unchangedCount).toBe(0);
  });

  it("resets unchanged count when processing starts", () => {
    const item: { lastScreenHash?: string; unchangedCount?: number } = {};

    // Build up some unchanged count
    computeScreenHealth("Static content\nLine2\nLine3\nLine4", item);
    computeScreenHealth("Static content\nLine2\nLine3\nLine4", item);
    expect(item.unchangedCount).toBe(1);

    // Processing starts — resets count
    computeScreenHealth("⠋ Thinking...\nLine2\nLine3", item);
    expect(item.unchangedCount).toBe(0);
  });

  it("error takes priority over permission", () => {
    const item = {};
    // Screen with both error and permission indicators
    const screen = "Error: something broke\nAllow tool? (Y/n)";
    expect(computeScreenHealth(screen, item)).toBe("stalled-error");
  });

  it("permission takes priority over processing", () => {
    const item = {};
    // Screen with permission and processing indicators
    const screen = "⠋ Thinking\nAllow Bash(test)? (Y/n)";
    expect(computeScreenHealth(screen, item)).toBe("stalled-permission");
  });

  it("respects custom unchanged threshold", () => {
    const item: { lastScreenHash?: string; unchangedCount?: number } = {};
    const staticScreen = "Static\nLine2\nLine3\nLine4";

    computeScreenHealth(staticScreen, item, 2);
    computeScreenHealth(staticScreen, item, 2);
    // At threshold=2, the second unchanged poll should trigger stalled-unchanged
    const result = computeScreenHealth(staticScreen, item, 2);
    expect(result).toBe("stalled-unchanged");
  });
});
