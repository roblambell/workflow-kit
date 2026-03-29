// Worker health utilities: screen-parsing for detecting worker state.
// Used by the launch code (ready detection, post-send verification).
//
// All functions are pure or accept their collaborators via arguments
// (dependency injection) -- no vi.mock needed for testing.

import type { Multiplexer } from "./mux.ts";
import { AI_TOOL_PROFILES } from "./ai-tools.ts";

// ── Types ────────────────────────────────────────────────────────────

/** Worker health status derived from screen content inspection. */
export type WorkerHealthStatus =
  | "loading"     // Screen is empty or minimal -- tool is still booting
  | "prompt"      // Input prompt is visible -- ready to receive input
  | "processing"  // Worker is actively processing (spinner, tool output, etc.)
  | "stalled"     // Has content but no recognizable activity indicators
  | "error";      // Error indicators detected on screen

/** Sleep function signature for dependency injection. */
export type Sleeper = (ms: number) => void;

// ── Indicator lists ──────────────────────────────────────────────────

/** Tool-agnostic prompt indicators (apply regardless of which AI tool is in use). */
const DEFAULT_PROMPT_INDICATORS = [
  "> ",  // Generic prompt (trailing space avoids false positives)
];

/** Indicators that the AI tool's input prompt is visible and ready. */
const PROMPT_INDICATORS = [
  ...DEFAULT_PROMPT_INDICATORS,
  ...AI_TOOL_PROFILES.flatMap((p) => p.promptIndicators ?? []),
];

/** Indicators that the worker is actively processing. */
const PROCESSING_INDICATORS = [
  // Braille spinner characters (Claude Code / many TUI tools)
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
  // Activity keywords
  "Thinking",
  "Reading",
  "Writing",
  "Searching",
  "Running",
  "Executing",
  "Fetching",
  "Installing",
  "Herding",
  // Tool usage indicators
  "Agent(",
  "Tool(",
  "Bash(",
  "Read(",
  "Edit(",
  "Grep(",
  "Glob(",
  "Write(",
];

/** Indicators of error state on screen. */
const ERROR_INDICATORS = [
  "Error:",
  "FATAL",
  "panic:",
  "Segmentation fault",
  "Killed",
  "OOMKilled",
  "SIGKILL",
  "spawn Unknown system error",
];

// ── Pure screen-parsing functions ────────────────────────────────────

/**
 * Detect if the AI tool's input prompt is visible on screen.
 * Returns true if any prompt indicator is found in the screen content.
 */
export function isInputPromptVisible(screenContent: string): boolean {
  if (!screenContent.trim()) return false;
  return PROMPT_INDICATORS.some((indicator) =>
    screenContent.includes(indicator),
  );
}

/**
 * Detect if the worker is actively processing (spinner, tool output, etc.).
 */
export function isWorkerProcessing(screenContent: string): boolean {
  if (!screenContent.trim()) return false;
  return PROCESSING_INDICATORS.some((indicator) =>
    screenContent.includes(indicator),
  );
}

/**
 * Detect error state from screen content.
 *
 * Uses line-anchored matching: each line is trimmed and checked for a
 * prefix match against error indicators. This prevents false positives
 * from code content that contains "Error:" mid-line (e.g., Python
 * tracebacks in test output).
 */
export function isWorkerInError(screenContent: string): boolean {
  if (!screenContent.trim()) return false;
  const lines = screenContent.split("\n");
  return lines.some((line) => {
    const trimmed = line.trimStart();
    return ERROR_INDICATORS.some((indicator) => trimmed.startsWith(indicator));
  });
}

/**
 * Get the health status of a worker by inspecting screen content.
 *
 * Priority order: error > processing > prompt > stalled > loading.
 * "processing" beats "prompt" because a worker showing both a prompt
 * and processing indicators (e.g., inline tool output) is actively working.
 */
export function getWorkerHealthStatus(
  screenContent: string,
): WorkerHealthStatus {
  if (!screenContent.trim()) return "loading";

  if (isWorkerInError(screenContent)) return "error";
  if (isWorkerProcessing(screenContent)) return "processing";
  if (isInputPromptVisible(screenContent)) return "prompt";

  // Has content but no recognizable state -- check if it's still loading
  const lines = screenContent
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length < 3) return "loading";

  return "stalled";
}

// ── Mux-aware functions (take Multiplexer as argument) ───────────────

/**
 * Check worker health by reading its screen.
 * Returns the health status derived from the current screen content.
 */
export function checkWorkerHealth(
  mux: Multiplexer,
  workspaceRef: string,
  lines: number = 30,
): WorkerHealthStatus {
  const screen = mux.readScreen(workspaceRef, lines);
  return getWorkerHealthStatus(screen);
}

/**
 * Wait for the AI tool's input prompt to appear on screen.
 *
 * More specific than `waitForReady` in mux.ts -- looks for actual prompt
 * indicators (❯, "Enter a prompt", etc.) rather than just stable content.
 * This prevents the race condition where Claude Code's loading screen has
 * stable content but the input handler isn't ready yet.
 *
 * @returns true if the prompt was detected within the timeout
 */
export function waitForInputPrompt(
  mux: Multiplexer,
  ref: string,
  sleep: Sleeper,
  maxAttempts: number = 60,
  pollMs: number = 500,
): boolean {
  for (let i = 0; i < maxAttempts; i++) {
    sleep(pollMs);
    const screen = mux.readScreen(ref, 30);
    if (isInputPromptVisible(screen)) {
      return true;
    }
    // Also accept "processing" -- the tool may have auto-started
    if (isWorkerProcessing(screen)) {
      return true;
    }
  }
  return false;
}

/**
 * After sending a message, verify the worker started processing.
 *
 * Reads the screen repeatedly and checks that the worker transitioned
 * from the prompt state to actively processing. This catches the case
 * where `sendMessage` reported success but the message wasn't actually
 * received by the AI tool's input handler.
 *
 * @returns true if processing was detected, false on timeout
 */
export function verifySendProcessing(
  mux: Multiplexer,
  ref: string,
  sleep: Sleeper,
  maxAttempts: number = 10,
  pollMs: number = 500,
): boolean {
  for (let i = 0; i < maxAttempts; i++) {
    sleep(pollMs);
    const screen = mux.readScreen(ref, 30);
    const status = getWorkerHealthStatus(screen);
    if (status === "processing") {
      return true;
    }
    // If we see an error, bail early -- no point retrying
    if (status === "error") {
      return false;
    }
  }
  return false;
}

/**
 * Full launch-and-verify sequence: wait for prompt, send message, verify processing.
 *
 * Combines the three phases of reliable message delivery:
 * 1. Wait for the input prompt to appear
 * 2. Send the message
 * 3. Verify the worker started processing
 *
 * Retries the send+verify cycle up to `maxSendRetries` times if the worker
 * doesn't start processing after a send.
 *
 * @returns true if the message was successfully delivered and processing started
 */
export function sendWithReadyWait(
  mux: Multiplexer,
  ref: string,
  message: string,
  sleep: Sleeper,
  options: {
    promptMaxAttempts?: number;
    promptPollMs?: number;
    verifyMaxAttempts?: number;
    verifyPollMs?: number;
    maxSendRetries?: number;
  } = {},
): boolean {
  const {
    promptMaxAttempts = 60,
    promptPollMs = 500,
    verifyMaxAttempts = 10,
    verifyPollMs = 500,
    maxSendRetries = 3,
  } = options;

  // Phase 1: Wait for input prompt
  const promptReady = waitForInputPrompt(
    mux,
    ref,
    sleep,
    promptMaxAttempts,
    promptPollMs,
  );
  // If prompt never appeared, still try sending (the worker might be in
  // an unexpected state that sendMessage can handle)

  // Phase 2+3: Send with post-send verification and retry
  for (let attempt = 0; attempt < maxSendRetries; attempt++) {
    const sent = mux.sendMessage(ref, message);
    if (!sent) continue;

    // Phase 3: Verify processing started
    if (verifySendProcessing(mux, ref, sleep, verifyMaxAttempts, verifyPollMs)) {
      return true;
    }

    // If prompt was never ready, don't retry -- the tool likely isn't running
    if (!promptReady && attempt === 0) {
      return false;
    }
  }

  return false;
}
