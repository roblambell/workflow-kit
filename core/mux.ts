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
  /** Identifier for this mux backend (e.g., "cmux", "tmux", "zellij"). */
  readonly type: MuxType;
  /** Check if the multiplexer backend is available (binary installed + session active). */
  isAvailable(): boolean;
  /** Return a human-readable message explaining why isAvailable() returned false. */
  diagnoseUnavailable(): string;
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
  readonly type: MuxType = "cmux";

  isAvailable(): boolean {
    return cmux.isAvailable();
  }

  diagnoseUnavailable(): string {
    return "cmux is not available. Ensure cmux is installed and running.";
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
  /** Env vars for session detection — injectable for testing. Defaults to process.env. */
  env?: Record<string, string | undefined>;
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
  readonly type: MuxType = "tmux";
  private run: ShellRunner;
  private sleep: Sleeper;
  private maxRetries: number;
  private baseDelayMs: number;
  private env: Record<string, string | undefined>;
  private counter = 0;

  constructor(run?: ShellRunner, options?: TmuxAdapterOptions) {
    this.run = run ?? defaultRun;
    this.sleep = options?.sleep ?? defaultSleep;
    this.maxRetries = options?.maxRetries ?? 3;
    this.baseDelayMs = options?.baseDelayMs ?? 100;
    this.env = options?.env ?? process.env;
  }

  isAvailable(): boolean {
    const result = this.run("tmux", ["-V"]);
    if (result.exitCode !== 0) return false;
    // Binary exists — also verify we're inside a tmux session
    return this.env.TMUX !== undefined;
  }

  diagnoseUnavailable(): string {
    const result = this.run("tmux", ["-V"]);
    if (result.exitCode !== 0) {
      return "tmux binary not found. Install tmux or use a different multiplexer (--mux zellij).";
    }
    return "No active tmux session found. Run ninthwave orchestrate from inside a tmux session.";
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

/** Configuration options for ZellijAdapter delivery behaviour. */
export interface ZellijAdapterOptions {
  sleep?: Sleeper;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Env vars for session detection — injectable for testing. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Adapter that delegates to the zellij CLI.
 *
 * Workspaces are zellij tabs within the current session. Tab names use the
 * `nw-` prefix to avoid collisions with user tabs. The adapter assumes it
 * is running inside an active zellij session (ZELLIJ_SESSION_NAME is set).
 *
 * `sendMessage` uses `write-chars` + `write 10` (Enter byte) with delivery
 * verification and exponential-backoff retry. `readScreen` dumps the screen
 * to a temp file via `dump-screen` and reads it back with `cat`.
 */
export class ZellijAdapter implements Multiplexer {
  readonly type: MuxType = "zellij";
  private run: ShellRunner;
  private sleep: Sleeper;
  private maxRetries: number;
  private baseDelayMs: number;
  private env: Record<string, string | undefined>;
  private counter = 0;

  constructor(run?: ShellRunner, options?: ZellijAdapterOptions) {
    this.run = run ?? defaultRun;
    this.sleep = options?.sleep ?? defaultSleep;
    this.maxRetries = options?.maxRetries ?? 3;
    this.baseDelayMs = options?.baseDelayMs ?? 100;
    this.env = options?.env ?? process.env;
  }

  isAvailable(): boolean {
    const result = this.run("zellij", ["--version"]);
    if (result.exitCode !== 0) return false;
    // Binary exists — also verify we're inside a zellij session
    return this.env.ZELLIJ_SESSION_NAME !== undefined;
  }

  diagnoseUnavailable(): string {
    const result = this.run("zellij", ["--version"]);
    if (result.exitCode !== 0) {
      return "zellij binary not found. Install zellij or use a different multiplexer (--mux tmux).";
    }
    return "No active zellij session found. Run ninthwave orchestrate from inside a zellij session.";
  }

  launchWorkspace(cwd: string, command: string, todoId?: string): string | null {
    const counter = ++this.counter;
    const name = todoId ? `nw-${todoId}-${counter}` : `nw-${counter}`;

    const result = this.run("zellij", [
      "action",
      "new-tab",
      "--name",
      name,
      "--cwd",
      cwd,
    ]);
    if (result.exitCode !== 0) return null;

    // Type the command into the new tab (which is now focused)
    this.run("zellij", ["action", "write-chars", `${command}\n`]);

    return name;
  }

  splitPane(command: string): string | null {
    const result = this.run("zellij", ["action", "new-pane"]);
    if (result.exitCode !== 0) return null;

    const ref = `nw-pane-${++this.counter}`;

    // Type the command into the new pane (which is now focused)
    this.run("zellij", ["action", "write-chars", `${command}\n`]);

    return ref;
  }

  /**
   * Send a message to a zellij tab with delivery verification and retry.
   *
   * Focuses the target tab by name, writes characters via `write-chars`,
   * then sends Enter via `write 10`. Verifies delivery by reading the
   * screen and retries with exponential backoff on failure.
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
    // Focus the target tab
    this.run("zellij", ["action", "go-to-tab-name", ref]);

    // Dump screen to a temp file
    const tmpFile = `/tmp/nw-zellij-screen-${Date.now()}`;
    const dumpResult = this.run("zellij", [
      "action",
      "dump-screen",
      tmpFile,
    ]);
    if (dumpResult.exitCode !== 0) return "";

    // Read the temp file
    const readResult = this.run("cat", [tmpFile]);
    // Clean up
    this.run("rm", ["-f", tmpFile]);

    if (readResult.exitCode !== 0) return "";

    const content = readResult.stdout;
    if (lines !== undefined) {
      const allLines = content.split("\n");
      return allLines.slice(-lines).join("\n");
    }
    return content;
  }

  listWorkspaces(): string {
    const result = this.run("zellij", ["list-sessions"]);
    if (result.exitCode !== 0) return "";
    // Filter to only nw- prefixed sessions to avoid exposing user sessions
    return result.stdout
      .split("\n")
      .filter((s) => s.startsWith("nw-"))
      .join("\n");
  }

  closeWorkspace(ref: string): boolean {
    // Focus the tab and close it.
    // If the tab isn't found, return false — never fall back to
    // delete-session, which would destroy the user's entire session.
    const focusResult = this.run("zellij", [
      "action",
      "go-to-tab-name",
      ref,
    ]);
    if (focusResult.exitCode !== 0) {
      // Tab not found — nothing to close (never delete the session)
      return false;
    }
    const closeResult = this.run("zellij", ["action", "close-tab"]);
    return closeResult.exitCode === 0;
  }

  // ── Private delivery helpers ─────────────────────────────────────────

  /** Single delivery attempt: focus tab, write-chars, Enter, verify. */
  private attemptSend(ref: string, message: string): boolean {
    // Focus the target tab
    const focusResult = this.run("zellij", [
      "action",
      "go-to-tab-name",
      ref,
    ]);
    if (focusResult.exitCode !== 0) return false;

    // Write the message characters
    const writeResult = this.run("zellij", [
      "action",
      "write-chars",
      message,
    ]);
    if (writeResult.exitCode !== 0) return false;

    // Send Enter key (byte 10 = newline)
    const enterResult = this.run("zellij", ["action", "write", "10"]);
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
      // Can't read screen — assume success
      return true;
    }
    return checkDelivery(screen, message);
  }
}

/** Supported multiplexer backends. */
export type MuxType = "cmux" | "zellij" | "tmux";

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
 * 3. ZELLIJ_SESSION_NAME — inside a zellij session
 * 4. TMUX env var — inside a tmux session
 * 5. cmux binary available
 * 6. zellij binary available
 * 7. tmux binary available
 * 8. Error — no multiplexer found
 */
export function detectMuxType(deps: DetectMuxDeps = defaultDetectDeps): MuxType {
  const { env, checkBinary } = deps;

  // 1. Explicit override via env var (set by --mux CLI flag)
  const override = env.NINTHWAVE_MUX;
  if (override) {
    if (override !== "cmux" && override !== "zellij" && override !== "tmux") {
      throw new Error(
        `Invalid NINTHWAVE_MUX value: "${override}". Must be "cmux", "zellij", or "tmux".`,
      );
    }
    return override;
  }

  // 2. Inside a cmux session
  if (env.CMUX_WORKSPACE_ID) return "cmux";

  // 3. Inside a zellij session
  if (env.ZELLIJ_SESSION_NAME) return "zellij";

  // 4. Inside a tmux session
  if (env.TMUX) return "tmux";

  // 5. cmux binary available
  if (checkBinary("cmux")) return "cmux";

  // 6. zellij binary available
  if (checkBinary("zellij")) return "zellij";

  // 7. tmux binary available
  if (checkBinary("tmux")) return "tmux";

  // 8. No multiplexer found
  throw new Error(
    "No multiplexer available. Install cmux, zellij, or tmux, or set NINTHWAVE_MUX=cmux|zellij|tmux.",
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
      case "zellij":
        return new ZellijAdapter();
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
