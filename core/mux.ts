// Multiplexer interface: abstracts terminal multiplexer operations.
// Decouples command modules from the concrete cmux/tmux implementation.

import * as cmux from "./cmux.ts";
import { checkDelivery, sendWithRetry } from "./delivery.ts";
import type { Sleeper } from "./delivery.ts";
import { run as defaultRun } from "./shell.ts";
import type { RunResult } from "./types.ts";

/** Shell runner signature — injectable for testing. */
export type ShellRunner = (
  cmd: string,
  args: string[],
) => RunResult;

/** Terminal multiplexer abstraction for workspace management. */
export interface Multiplexer {
  /** Check if the multiplexer backend is available. */
  isAvailable(): boolean;
  /** Launch a new workspace. Returns a ref (e.g., "workspace:1") or null on failure. */
  launchWorkspace(cwd: string, command: string, todoId?: string): string | null;
  /** Split a pane in the current workspace. Returns a ref or null on failure. */
  splitPane(command: string): string | null;
  /** Send a message to a workspace. Returns true on success. */
  sendMessage(ref: string, message: string): boolean;
  /** Read screen content from a workspace. Returns raw text or "" on failure. */
  readScreen(ref: string, lines?: number): string;
  /** List all workspaces. Returns raw output string. */
  listWorkspaces(): string;
  /** Close a workspace. Returns true on success. */
  closeWorkspace(ref: string): boolean;
}

/** Adapter that delegates to the cmux CLI binary. */
export class CmuxAdapter implements Multiplexer {
  isAvailable(): boolean {
    return cmux.isAvailable();
  }
  launchWorkspace(cwd: string, command: string, _todoId?: string): string | null {
    return cmux.launchWorkspace(cwd, command);
  }
  splitPane(command: string): string | null {
    return cmux.splitPane(command);
  }
  sendMessage(ref: string, message: string): boolean {
    return cmux.sendMessage(ref, message);
  }
  readScreen(ref: string, lines?: number): string {
    return cmux.readScreen(ref, lines);
  }
  listWorkspaces(): string {
    return cmux.listWorkspaces();
  }
  closeWorkspace(ref: string): boolean {
    return cmux.closeWorkspace(ref);
  }
}

/** Default sleep — uses Bun.sleepSync in production, no-op in test. */
const defaultSleep: Sleeper =
  process.env.NODE_ENV === "test" ? () => {} : (ms) => Bun.sleepSync(ms);

/** Configuration options for TmuxAdapter delivery behaviour. */
export interface TmuxAdapterOptions {
  sleep?: Sleeper;
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * Adapter that delegates to the tmux CLI.
 *
 * Session names use the `nw-` prefix to avoid collisions with user sessions.
 * All operations gracefully return null/false/"" when tmux is not running or
 * the target session does not exist.
 *
 * `sendMessage` uses tmux's `set-buffer` + `paste-buffer` for atomic paste
 * (analogous to cmux's approach), with delivery verification via `readScreen`
 * and exponential-backoff retry. Falls back to `send-keys -l` when the buffer
 * approach fails.
 */
export class TmuxAdapter implements Multiplexer {
  private run: ShellRunner;
  private sleep: Sleeper;
  private maxRetries: number;
  private baseDelayMs: number;
  private counter = 0;

  constructor(run?: ShellRunner, options?: TmuxAdapterOptions) {
    this.run = run ?? defaultRun;
    this.sleep = options?.sleep ?? defaultSleep;
    this.maxRetries = options?.maxRetries ?? 3;
    this.baseDelayMs = options?.baseDelayMs ?? 100;
  }

  isAvailable(): boolean {
    const result = this.run("tmux", ["-V"]);
    return result.exitCode === 0;
  }

  launchWorkspace(cwd: string, command: string, todoId?: string): string | null {
    const counter = ++this.counter;
    const name = todoId ? `nw-${todoId}-${counter}` : `nw-${counter}`;
    const result = this.run("tmux", [
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      cwd,
      command,
    ]);
    if (result.exitCode !== 0) return null;
    return name;
  }

  splitPane(command: string): string | null {
    // Use -P -F to print the new pane's ID directly from split-window.
    // Without -P, display-message returns the *active* pane which may differ.
    const result = this.run("tmux", [
      "split-window",
      "-P",
      "-F",
      "#{pane_id}",
      command,
    ]);
    if (result.exitCode !== 0) return null;
    return result.stdout?.trim() || `nw-pane-${this.counter}`;
  }

  /**
   * Send a message to a tmux session with delivery verification and retry.
   *
   * Attempts atomic paste via `set-buffer` + `paste-buffer`, falling back to
   * `send-keys -l` when the buffer approach fails. Verifies delivery by reading
   * the screen and retries with exponential backoff on failure.
   */
  sendMessage(ref: string, message: string): boolean {
    return sendWithRetry(
      () => this.attemptSend(ref, message),
      {
        sleep: this.sleep,
        maxRetries: this.maxRetries,
        baseDelayMs: this.baseDelayMs,
      },
    );
  }

  readScreen(ref: string, lines?: number): string {
    const args = ["capture-pane", "-t", ref, "-p"];
    if (lines !== undefined) {
      args.push("-S", String(-lines));
    }
    const result = this.run("tmux", args);
    if (result.exitCode !== 0) return "";
    return result.stdout;
  }

  listWorkspaces(): string {
    const result = this.run("tmux", [
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    if (result.exitCode !== 0) return "";
    // Filter to only nw- prefixed sessions to avoid exposing user sessions
    return result.stdout
      .split("\n")
      .filter((s) => s.startsWith("nw-"))
      .join("\n");
  }

  closeWorkspace(ref: string): boolean {
    const result = this.run("tmux", ["kill-session", "-t", ref]);
    return result.exitCode === 0;
  }

  // ── Private delivery helpers ─────────────────────────────────────────

  /** Single delivery attempt: try atomic paste, fall back to send-keys. */
  private attemptSend(ref: string, message: string): boolean {
    // Try atomic paste via tmux buffers (avoids keystroke race)
    const setBuf = this.run("tmux", [
      "set-buffer",
      "-b",
      "nw_send",
      "--",
      message,
    ]);
    if (setBuf.exitCode === 0) {
      const paste = this.run("tmux", [
        "paste-buffer",
        "-b",
        "nw_send",
        "-t",
        ref,
      ]);
      if (paste.exitCode === 0) {
        this.sleep(50);
        const enter = this.run("tmux", ["send-keys", "-t", ref, "Enter"]);
        if (enter.exitCode !== 0) return false;
        this.sleep(100);
        return this.verifyDelivery(ref, message);
      }
    }

    // Fallback: send-keys -l for literal text, then Enter
    const textResult = this.run("tmux", [
      "send-keys",
      "-t",
      ref,
      "-l",
      message,
    ]);
    if (textResult.exitCode !== 0) return false;

    const enterResult = this.run("tmux", ["send-keys", "-t", ref, "Enter"]);
    if (enterResult.exitCode !== 0) return false;

    this.sleep(100);
    return this.verifyDelivery(ref, message);
  }

  /**
   * Verify that the message was submitted (not stuck in the input field).
   * Reads the last 3 screen lines and delegates to shared checkDelivery logic.
   * When the screen can't be read, assumes success.
   */
  private verifyDelivery(ref: string, message: string): boolean {
    const screen = this.readScreen(ref, 3);
    if (screen === "") {
      // Can't read screen — assume success (paste-submit is inherently reliable)
      return true;
    }
    return checkDelivery(screen, message);
  }
}

/** Supported multiplexer backends. */
export type MuxType = "cmux" | "tmux";

/** Injectable dependencies for multiplexer detection — enables testing without vi.mock. */
export interface DetectMuxDeps {
  env: Record<string, string | undefined>;
  checkBinary: (name: string) => boolean;
}

const defaultDetectDeps: DetectMuxDeps = {
  env: process.env,
  checkBinary: (name: string): boolean => {
    try {
      const flag = name === "tmux" ? "-V" : "--version";
      const result = defaultRun(name, [flag]);
      return result.exitCode === 0;
    } catch {
      // Shell runner may not be available (e.g., vitest on Node.js without Bun)
      return false;
    }
  },
};

/**
 * Auto-detect the best available multiplexer.
 *
 * Detection chain:
 * 1. NINTHWAVE_MUX env var — explicit override (set by --mux flag)
 * 2. CMUX_WORKSPACE_ID — inside a cmux session
 * 3. TMUX env var — inside a tmux session
 * 4. cmux binary available
 * 5. tmux binary available
 * 6. Error — no multiplexer found
 */
export function detectMuxType(deps: DetectMuxDeps = defaultDetectDeps): MuxType {
  const { env, checkBinary } = deps;

  // 1. Explicit override via env var (set by --mux CLI flag)
  const override = env.NINTHWAVE_MUX;
  if (override) {
    if (override !== "cmux" && override !== "tmux") {
      throw new Error(
        `Invalid NINTHWAVE_MUX value: "${override}". Must be "cmux" or "tmux".`,
      );
    }
    return override;
  }

  // 2. Inside a cmux session
  if (env.CMUX_WORKSPACE_ID) return "cmux";

  // 3. Inside a tmux session
  if (env.TMUX) return "tmux";

  // 4. cmux binary available
  if (checkBinary("cmux")) return "cmux";

  // 5. tmux binary available
  if (checkBinary("tmux")) return "tmux";

  // 6. No multiplexer found
  throw new Error(
    "No multiplexer available. Install cmux or tmux, or set NINTHWAVE_MUX=cmux|tmux.",
  );
}

/**
 * Return the active multiplexer adapter based on auto-detection.
 *
 * When detection fails (no mux available), falls back to CmuxAdapter so that
 * callers using `getMux()` as a default parameter don't crash at import time.
 * The adapter's `isAvailable()` will return false, and the caller can handle
 * the error. Validation errors (invalid NINTHWAVE_MUX) still throw immediately.
 */
export function getMux(deps?: DetectMuxDeps): Multiplexer {
  try {
    const muxType = detectMuxType(deps);
    switch (muxType) {
      case "cmux":
        return new CmuxAdapter();
      case "tmux":
        return new TmuxAdapter();
    }
  } catch (e) {
    // Validation errors (invalid NINTHWAVE_MUX) propagate immediately
    if (e instanceof Error && e.message.includes("Invalid NINTHWAVE_MUX")) {
      throw e;
    }
    // No mux available — fall back to CmuxAdapter (isAvailable() will report false)
    return new CmuxAdapter();
  }
}

/**
 * Poll a workspace until it shows stable, substantial content (agent is ready).
 *
 * Checks `readScreen` every `pollMs` milliseconds. Returns true once the screen
 * has >= 3 non-empty lines and the content is the same for two consecutive polls
 * (indicating the agent has finished loading and the UI is stable).
 *
 * @param sleep — injectable for testing; defaults to Bun.sleepSync
 */
export function waitForReady(
  mux: Multiplexer,
  ref: string,
  sleep: (ms: number) => void = process.env.NODE_ENV === "test"
    ? () => {}
    : (ms) => Bun.sleepSync(ms),
  maxAttempts: number = 30,
  pollMs: number = 500,
): boolean {
  let lastScreen = "";

  for (let i = 0; i < maxAttempts; i++) {
    sleep(pollMs);
    const screen = mux.readScreen(ref, 10);
    const lines = screen.split("\n").filter((l) => l.trim().length > 0);

    // Stable, substantial content = ready
    if (lines.length >= 3 && screen === lastScreen) {
      return true;
    }
    lastScreen = screen;
  }

  return false;
}
