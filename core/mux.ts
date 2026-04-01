// Multiplexer interface: abstracts terminal multiplexer operations.
// Decouples command modules from the concrete cmux/tmux implementation.

import { createInterface } from "readline";
import * as cmux from "./cmux.ts";
import { TmuxAdapter } from "./tmux.ts";
import { die, warn as defaultWarn } from "./output.ts";
import { resolveCmuxBinary } from "./cmux-resolve.ts";
import { run as defaultShellRun } from "./shell.ts";
import type { RunResult } from "./types.ts";

/** Shell runner signature -- injectable for testing. */
export type ShellRunner = (
  cmd: string,
  args: string[],
) => RunResult;

/** Terminal multiplexer abstraction for workspace management. */
export interface Multiplexer {
  /** Identifier for this mux backend. */
  readonly type: MuxType;
  /** Check if the multiplexer backend is available (binary installed + session active). */
  isAvailable(): boolean;
  /** Return a human-readable message explaining why isAvailable() returned false. */
  diagnoseUnavailable(): string;
  /** Launch a new workspace. Returns a ref (e.g., "workspace:1") or null on failure. */
  launchWorkspace(cwd: string, command: string, todoId?: string): string | null;
  /** Split a pane in the current workspace. Returns a ref or null on failure. */
  splitPane(command: string): string | null;
  /** Read screen content from a workspace. Returns raw text or "" on failure. */
  readScreen(ref: string, lines?: number): string;
  /** List all workspaces. Returns raw output string. */
  listWorkspaces(): string;
  /** Close a workspace. Returns true on success. */
  closeWorkspace(ref: string): boolean;
  /** Set status text, icon, and color for a workspace. Best-effort -- returns boolean success. */
  setStatus(ref: string, key: string, text: string, icon: string, color: string): boolean;
  /** Set progress value (0.0–1.0) and optional label for a workspace. Best-effort -- returns boolean success. */
  setProgress(ref: string, value: number, label?: string): boolean;
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
  readScreen(ref: string, lines?: number): string {
    return cmux.readScreen(ref, lines);
  }
  listWorkspaces(): string {
    return cmux.listWorkspaces();
  }
  closeWorkspace(ref: string): boolean {
    return cmux.closeWorkspace(ref);
  }
  setStatus(ref: string, key: string, text: string, icon: string, color: string): boolean {
    return cmux.setStatus(ref, key, text, icon, color);
  }
  setProgress(ref: string, value: number, label?: string): boolean {
    return cmux.setProgress(ref, value, label);
  }
}

/** Supported multiplexer backends. */
export type MuxType = "cmux" | "tmux" | "headless";

/** Valid values for the NINTHWAVE_MUX environment variable. */
const VALID_MUX_VALUES: readonly MuxType[] = ["cmux", "tmux"] as const;

/** Injectable dependencies for multiplexer detection -- enables testing without vi.mock. */
export interface DetectMuxDeps {
  env: Record<string, string | undefined>;
  checkBinary: (name: string) => boolean;
  warn?: (message: string) => void;
}

const defaultDetectDeps: DetectMuxDeps = {
  env: process.env,
  checkBinary: (name: string): boolean => {
    if (name === "cmux") return resolveCmuxBinary() !== null;
    // For tmux and others, check PATH
    return Bun.which(name) !== null;
  },
  warn: defaultWarn,
};

/**
 * Auto-detect the best available multiplexer.
 *
 * Detection chain:
 * 1. NINTHWAVE_MUX env override (validated)
 * 2. CMUX_WORKSPACE_ID -- inside a cmux session
 * 3. $TMUX -- inside a tmux session
 * 4. tmux binary available (preferred over cmux outside session)
 * 5. cmux binary available
 * 6. Error -- no multiplexer found
 */
export function detectMuxType(deps: DetectMuxDeps = defaultDetectDeps): MuxType {
  const { env, checkBinary, warn } = deps;

  // 1. NINTHWAVE_MUX override
  if (env.NINTHWAVE_MUX) {
    const override = env.NINTHWAVE_MUX as string;
    if (VALID_MUX_VALUES.includes(override as MuxType)) {
      return override as MuxType;
    }
    // Invalid value -- warn and fall through to auto-detect
    (warn ?? defaultWarn)(
      `Invalid NINTHWAVE_MUX="${override}". Valid values: ${VALID_MUX_VALUES.join(", ")}. Falling back to auto-detect.`,
    );
  }

  // 2. Inside a cmux session
  if (env.CMUX_WORKSPACE_ID) return "cmux";

  // 3. Inside a tmux session
  if (env.TMUX) return "tmux";

  // 4. tmux binary available (preferred over cmux outside session)
  if (checkBinary("tmux")) return "tmux";

  // 5. cmux binary available
  if (checkBinary("cmux")) return "cmux";

  // 6. No multiplexer found
  throw new Error(
    "No multiplexer available. Install tmux (brew install tmux) or cmux (brew install --cask manaflow-ai/cmux/cmux).",
  );
}

/**
 * Return the active multiplexer adapter based on auto-detection.
 *
 * When detection fails (no mux available), falls back to CmuxAdapter so that
 * callers using `getMux()` as a default parameter don't crash at import time.
 * The adapter's `isAvailable()` will return false, and the caller can handle
 * the error.
 */
export function getMux(deps?: DetectMuxDeps): Multiplexer {
  try {
    const muxType = detectMuxType(deps);
    if (muxType === "tmux") {
      return new TmuxAdapter({
        runner: defaultShellRun,
        sleep: process.env.NODE_ENV === "test" ? () => {} : (ms) => Bun.sleepSync(ms),
        env: process.env,
        cwd: () => process.cwd(),
      });
    }
    return new CmuxAdapter();
  } catch {
    // No mux available -- fall back to CmuxAdapter (isAvailable() will report false)
    return new CmuxAdapter();
  }
}

// ── Ensure we're inside a mux session ───────────────────────────────

/** Injectable dependencies for mux session detection. */
export interface AutoLaunchDeps {
  env: Record<string, string | undefined>;
  checkBinary: (name: string) => boolean;
  warn?: (message: string) => void;
}

/** Possible outcomes from auto-launch detection. */
export type AutoLaunchResult =
  | { action: "proceed" }
  | { action: "error"; message: string; reason: "cmux-not-in-session" | "nothing-installed" };

/**
 * Pure detection logic: determine whether to proceed or error.
 *
 * Detection chain:
 * 1. NINTHWAVE_MUX override → tmux: proceed, cmux: must be in session, invalid: warn+fallthrough
 * 2. CMUX_WORKSPACE_ID set → proceed (already inside cmux)
 * 3. $TMUX set → proceed (inside tmux session)
 * 4. tmux installed → proceed (adapter creates its own session)
 * 5. cmux installed → error (detected but not in a session)
 * 6. Nothing → error (install prompt)
 */
export function checkAutoLaunch(deps: AutoLaunchDeps): AutoLaunchResult {
  const { env, checkBinary, warn } = deps;

  // 1. NINTHWAVE_MUX override
  if (env.NINTHWAVE_MUX) {
    const override = env.NINTHWAVE_MUX as string;
    if (override === "tmux") return { action: "proceed" };
    if (override === "cmux") {
      // Must be inside a cmux session
      if (env.CMUX_WORKSPACE_ID) return { action: "proceed" };
      return {
        action: "error",
        message: "NINTHWAVE_MUX=cmux but not inside a cmux session. Open cmux and run nw there.",
        reason: "cmux-not-in-session",
      };
    }
    // Invalid value -- warn and fall through to auto-detect
    (warn ?? defaultWarn)(
      `Invalid NINTHWAVE_MUX="${override}". Valid values: cmux, tmux. Falling back to auto-detect.`,
    );
  }

  // 2. Already inside cmux -- proceed normally
  if (env.CMUX_WORKSPACE_ID) return { action: "proceed" };

  // 3. Inside a tmux session -- proceed
  if (env.TMUX) return { action: "proceed" };

  // 4. tmux installed -- proceed (adapter creates its own session)
  if (checkBinary("tmux")) return { action: "proceed" };

  // 5. cmux installed but not in a session
  if (checkBinary("cmux")) {
    return {
      action: "error",
      message: "Not inside a cmux session. Open cmux and run nw there.",
      reason: "cmux-not-in-session",
    };
  }

  // 6. Nothing installed
  return {
    action: "error",
    message:
      "No multiplexer available. Install tmux (brew install tmux) or cmux (brew install --cask manaflow-ai/cmux/cmux).",
    reason: "nothing-installed",
  };
}

const defaultAutoLaunchDeps: AutoLaunchDeps = {
  env: process.env,
  checkBinary: (name: string): boolean => {
    if (name === "cmux") return resolveCmuxBinary() !== null;
    return Bun.which(name) !== null;
  },
  warn: defaultWarn,
};

/**
 * Ensure we're inside a mux session (or can create one), or die with a helpful message.
 *
 * For commands that need a multiplexer (watch, start, <ID>, no-args interactive),
 * call this before proceeding.
 */
export function ensureMuxOrAutoLaunch(
  _originalArgs: string[],
  deps: AutoLaunchDeps = defaultAutoLaunchDeps,
): void {
  const result = checkAutoLaunch(deps);
  if (result.action === "proceed") return;
  die(result.message);
}

// ── Interactive mux install ──────────────────────────────────────────

/** Injectable deps for interactive mux install. */
export interface InteractiveMuxDeps {
  env?: Record<string, string | undefined>;
  checkBinary?: (name: string) => boolean;
  warn?: (message: string) => void;
  isTTY?: boolean;
  platform?: string;
  prompt?: (question: string) => Promise<string>;
  runInstall?: (cmd: string, args: string[]) => { exitCode: number };
  relaunch?: (args: string[]) => void;
  openApp?: (app: string) => void;
}

function defaultPromptFn(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function defaultRunInstall(cmd: string, args: string[]): { exitCode: number } {
  const result = Bun.spawnSync([cmd, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return { exitCode: result.exitCode ?? 1 };
}

function defaultRelaunch(args: string[]): void {
  Bun.spawnSync(["nw", ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(0);
}

function defaultOpenApp(app: string): void {
  Bun.spawnSync(["open", "-a", app], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
}

/**
 * Ensure we're inside a mux session, or offer an interactive install flow (TTY only).
 *
 * On TTY: prompts the user to install a multiplexer when none is available, or to
 * open cmux when installed but not in a session. On non-TTY: falls back to die().
 *
 * Use this in place of ensureMuxOrAutoLaunch for all CLI entry points.
 */
export async function ensureMuxInteractiveOrDie(
  originalArgs: string[],
  deps: InteractiveMuxDeps = {},
): Promise<void> {
  const autoLaunchDeps: AutoLaunchDeps = {
    env: deps.env ?? process.env,
    checkBinary: deps.checkBinary ?? defaultAutoLaunchDeps.checkBinary,
    warn: deps.warn ?? defaultAutoLaunchDeps.warn,
  };
  const result = checkAutoLaunch(autoLaunchDeps);
  if (result.action === "proceed") return;

  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true);
  if (!isTTY) {
    die(result.message);
    return;
  }

  const platform = deps.platform ?? process.platform;
  const prompt = deps.prompt ?? defaultPromptFn;
  const runInstall = deps.runInstall ?? defaultRunInstall;
  const relaunch = deps.relaunch ?? defaultRelaunch;
  const openApp = deps.openApp ?? defaultOpenApp;
  const isMac = platform === "darwin";

  if (result.reason === "cmux-not-in-session") {
    process.stdout.write("\ncmux is installed but you're not inside a session.\n\n");
    const answer = await prompt("Open cmux now? [Y/n]: ");
    if (answer.toLowerCase() !== "n") {
      if (isMac) {
        openApp("cmux");
        process.stdout.write("\ncmux is open. Run `nw` in a new workspace.\n\n");
      } else {
        process.stdout.write("\nOpen cmux and run `nw` in a new workspace.\n\n");
      }
      process.exit(0);
    } else {
      die(result.message);
    }
    return;
  }

  // nothing-installed
  process.stdout.write("\nA terminal multiplexer is required to run ninthwave.\n\n");

  const options: Array<{ name: string; description: string; installCmd: string; installArgs: string[] }> = [
    {
      name: "tmux",
      description: "battle-hardened, runs in your existing terminal",
      installCmd: "brew",
      installArgs: ["install", "tmux"],
    },
  ];
  if (isMac) {
    options.push({
      name: "cmux",
      description: "visual macOS sidebar",
      installCmd: "brew",
      installArgs: ["install", "--cask", "manaflow-ai/cmux/cmux"],
    });
  }

  for (let i = 0; i < options.length; i++) {
    const o = options[i]!;
    process.stdout.write(`  ${i + 1}. ${o.name}  -- ${o.description}\n`);
  }
  process.stdout.write("\n");

  if (!isMac) {
    process.stdout.write("On Linux, install tmux via your package manager:\n");
    process.stdout.write("  sudo apt install tmux   # Debian/Ubuntu\n");
    process.stdout.write("  brew install tmux        # Homebrew\n\n");
    process.stdout.write("Then re-run `nw`.\n\n");
    process.exit(1);
    return;
  }

  const rangeLabel = options.length > 1 ? `1-${options.length}` : "1";
  const raw = await prompt(`Install [${rangeLabel}]: `);
  const idx = parseInt(raw, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= options.length) {
    die("No valid selection. Install a multiplexer and re-run nw.");
    return;
  }

  const chosen = options[idx]!;
  process.stdout.write(`\nInstalling ${chosen.name}...\n\n`);
  const installResult = runInstall(chosen.installCmd, chosen.installArgs);
  if (installResult.exitCode !== 0) {
    die(`Installation failed (exit ${installResult.exitCode}). Install manually and re-run nw.`);
    return;
  }

  if (chosen.name === "tmux") {
    process.stdout.write("\ntmux installed. Relaunching nw...\n\n");
    relaunch(originalArgs);
    process.exit(0);
  } else {
    process.stdout.write("\ncmux installed. Opening cmux...\n");
    openApp("cmux");
    process.stdout.write("Run `nw` in a new cmux workspace.\n\n");
    process.exit(0);
  }
}
