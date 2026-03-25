// Worker health utilities: screen-parsing for detecting worker state.
// Used by the launch code (ready detection, post-send verification) and
// the orchestrator polling loop (stall detection).
//
// All functions are pure or accept their collaborators via arguments
// (dependency injection) — no vi.mock needed for testing.

import type { Multiplexer } from "./mux.ts";

// ── Types ────────────────────────────────────────────────────────────

/** Worker health status derived from screen content inspection. */
export type WorkerHealthStatus =
  | "loading"     // Screen is empty or minimal — tool is still booting
  | "prompt"      // Input prompt is visible — ready to receive input
  | "processing"  // Worker is actively processing (spinner, tool output, etc.)
  | "stalled"     // Has content but no recognizable activity indicators
  | "error";      // Error indicators detected on screen

/** Stall-detection health status derived from worker screen content. */
export type ScreenHealthStatus =
  | "healthy"             // Worker is actively processing or just started
  | "stalled-empty"       // Prompt visible with no input — worker idle
  | "stalled-permission"  // Permission prompt (Y/n dialog) waiting for approval
  | "stalled-error"       // Error or crash output detected
  | "stalled-unchanged"   // Screen content unchanged across consecutive polls
  | "unknown";            // readScreen unavailable or threw

/** Sleep function signature for dependency injection. */
export type Sleeper = (ms: number) => void;

// ── Indicator lists ──────────────────────────────────────────────────

/** Indicators that the AI tool's input prompt is visible and ready. */
const PROMPT_INDICATORS = [
  "❯",                 // Claude Code prompt character
  "Enter a prompt",    // Claude Code initial prompt state
  "bypass permissions", // Claude Code permission mode indicator
  "What can I help",   // Claude Code greeting
  "How can I help",    // Claude Code greeting variant
  "> ",                // Generic prompt (must include trailing space to avoid false positives)
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

/** Indicators that a permission/approval dialog is waiting. */
const PERMISSION_INDICATORS = [
  "(Y/n)",
  "(y/N)",
  "Allow ",       // "Allow tool_name?" prompts
  "approve",
  "permission",
  "Yes / No",
  "(Y)es / (N)o",
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
 */
export function isWorkerInError(screenContent: string): boolean {
  if (!screenContent.trim()) return false;
  return ERROR_INDICATORS.some((indicator) =>
    screenContent.includes(indicator),
  );
}

/**
 * Detect if a permission/approval dialog is visible on screen.
 */
export function isPermissionPrompt(screenContent: string): boolean {
  if (!screenContent.trim()) return false;
  return PERMISSION_INDICATORS.some((indicator) =>
    screenContent.includes(indicator),
  );
}

/**
 * Simple string hash for comparing screen content across polls.
 * Not cryptographic — just needs to detect changes.
 */
export function simpleHash(str: string): string {
  let hash = 0;
  const trimmed = str.trim();
  for (let i = 0; i < trimmed.length; i++) {
    hash = ((hash << 5) - hash + trimmed.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

/**
 * Compute screen health status for stall detection.
 *
 * Uses the screen content + orchestrator item state to classify the
 * worker's health into actionable categories. Mutates orchItem to track
 * unchanged screen state across polls.
 *
 * @param screenContent - Raw screen content from readScreen
 * @param orchItem - The orchestrator item (mutated: lastScreenHash, unchangedCount)
 * @param unchangedThreshold - Number of consecutive unchanged polls before declaring stalled (default 3)
 */
export function computeScreenHealth(
  screenContent: string,
  orchItem: { lastScreenHash?: string; unchangedCount?: number },
  unchangedThreshold: number = 3,
): ScreenHealthStatus {
  if (!screenContent.trim()) return "unknown";

  // Check error first (highest priority)
  if (isWorkerInError(screenContent)) return "stalled-error";

  // Check permission prompt
  if (isPermissionPrompt(screenContent)) return "stalled-permission";

  // If actively processing, worker is healthy
  if (isWorkerProcessing(screenContent)) {
    orchItem.lastScreenHash = simpleHash(screenContent);
    orchItem.unchangedCount = 0;
    return "healthy";
  }

  // If prompt visible with no processing indicators, worker is idle
  if (isInputPromptVisible(screenContent)) return "stalled-empty";

  // Check for unchanged screen across polls
  const hash = simpleHash(screenContent);
  if (orchItem.lastScreenHash === hash) {
    orchItem.unchangedCount = (orchItem.unchangedCount ?? 0) + 1;
    if (orchItem.unchangedCount >= unchangedThreshold) {
      return "stalled-unchanged";
    }
  } else {
    orchItem.lastScreenHash = hash;
    orchItem.unchangedCount = 0;
  }

  // Has content, not recognizable as stalled — assume healthy
  return "healthy";
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

  // Has content but no recognizable state — check if it's still loading
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
 * More specific than `waitForReady` in mux.ts — looks for actual prompt
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
    // Also accept "processing" — the tool may have auto-started
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
    // If we see an error, bail early — no point retrying
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

    // If prompt was never ready, don't retry — the tool likely isn't running
    if (!promptReady && attempt === 0) {
      return false;
    }
  }

  return false;
}
