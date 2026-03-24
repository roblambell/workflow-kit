// Pure send-message logic, separated from cmux.ts so it can be tested
// without vi.mock leaks from other test files (bun test doesn't isolate mocks).

import type { RunResult } from "./types.ts";

export type Runner = (cmd: string, args: string[]) => RunResult;
export type Sleeper = (ms: number) => void;

/** Injectable dependencies for sendMessage (testing seam). */
export interface SendMessageDeps {
  runner: Runner;
  sleep: Sleeper;
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * Send a message to a cmux workspace. Returns true on success.
 *
 * Uses paste-then-submit to avoid the race condition where `cmux send`
 * types text character-by-character and fires Return before the text is
 * fully entered. Verifies delivery and retries with exponential backoff.
 */
export function sendMessageImpl(
  workspaceRef: string,
  message: string,
  deps: SendMessageDeps,
): boolean {
  const { runner, sleep, maxRetries = 3, baseDelayMs = 100 } = deps;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }

    if (attemptSend(workspaceRef, message, runner, sleep)) {
      return true;
    }
  }

  return false;
}

/** Single delivery attempt: paste text, send Return, verify. */
function attemptSend(
  workspaceRef: string,
  message: string,
  runner: Runner,
  sleep: Sleeper,
): boolean {
  // 1. Load message into a paste buffer (atomic — avoids keystroke race)
  const buf = runner("cmux", ["set-buffer", "--name", "_nw_send", message]);
  if (buf.exitCode !== 0) return false;

  // 2. Paste buffer into the workspace's active surface
  const paste = runner("cmux", [
    "paste-buffer",
    "--name",
    "_nw_send",
    "--workspace",
    workspaceRef,
  ]);
  if (paste.exitCode !== 0) return false;

  // 3. Let the terminal process the pasted text
  sleep(50);

  // 4. Press Return to submit
  const key = runner("cmux", [
    "send-key",
    "--workspace",
    workspaceRef,
    "Return",
  ]);
  if (key.exitCode !== 0) return false;

  // 5. Verify delivery
  sleep(100);
  return verifyDelivery(workspaceRef, message, runner);
}

/**
 * Check that the message was submitted (not stuck in the input field).
 *
 * Reads the last few screen lines and checks whether the message text
 * still appears on the final line — if it does, the Return key likely
 * fired before the paste completed and the message is still in the
 * input field.
 */
export function verifyDelivery(
  workspaceRef: string,
  message: string,
  runner: Runner,
): boolean {
  const screen = runner("cmux", [
    "read-screen",
    "--workspace",
    workspaceRef,
    "--lines",
    "3",
  ]);

  if (screen.exitCode !== 0) {
    // Can't verify — assume success (paste-submit is inherently reliable)
    return true;
  }

  const lines = screen.stdout
    .split("\n")
    .filter((l) => l.trim() !== "");

  if (lines.length === 0) return true;

  // If the last line contains a significant prefix of our message,
  // it's likely still sitting in the input field (not yet submitted).
  const lastLine = lines[lines.length - 1]!;
  const probe =
    message.length > 60 ? message.slice(0, 60) : message;

  return !lastLine.includes(probe);
}
