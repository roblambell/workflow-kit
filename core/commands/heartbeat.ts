// heartbeat command: workers report progress via a fast file write.
// Usage: nw heartbeat --progress 0.3 --label "Writing tests"

import { die } from "../output.ts";
import { writeHeartbeat, type DaemonIO } from "../daemon.ts";
import { headlessPhaseFilePath, writeHeadlessPhase } from "../headless.ts";
import {
  existsSync,
  renameSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "fs";

// ── Types ────────────────────────────────────────────────────────────

export interface HeartbeatDeps {
  io: DaemonIO;
  getBranch: () => string | null;
}

const defaultDeps: HeartbeatDeps = {
  io: { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, renameSync },
  getBranch: () => {
    try {
      const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "pipe" });
      return result.exitCode === 0 ? result.stdout.toString().trim() : null;
    } catch {
      return null;
    }
  },
};

// ── Branch detection ─────────────────────────────────────────────────

/** Extract item ID from a branch name like "ninthwave/H-FOO-1". Returns null if not an item branch. */
export function extractItemId(branch: string): string | null {
  const match = branch.match(/^ninthwave\/(.+)$/);
  return match ? match[1]! : null;
}

// ── Argument parsing ─────────────────────────────────────────────────

export interface HeartbeatArgs {
  progress: number;
  label: string;
  prNumber?: number;
}

/** Parse --progress, --label, and --pr from CLI args. Throws on invalid input. */
export function parseHeartbeatArgs(args: string[]): HeartbeatArgs {
  let progress: number | undefined;
  let label: string | undefined;
  let prNumber: number | undefined;
  const unsupportedFlags = new Set(["--model", "--tokens-in", "--tokens-out"]);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--progress" && i + 1 < args.length) {
      progress = parseFloat(args[i + 1]!);
      i++;
    } else if (args[i] === "--label" && i + 1 < args.length) {
      label = args[i + 1]!;
      i++;
    } else if (args[i] === "--pr" && i + 1 < args.length) {
      prNumber = parseInt(args[i + 1]!, 10);
      i++;
    } else if (unsupportedFlags.has(args[i]!)) {
      die(`Unsupported flag: ${args[i]}. nw heartbeat only accepts --progress and --label`);
      return { progress: 0, label: "" }; // unreachable
    }
  }

  if (progress === undefined) {
    die("Missing required flag: --progress <0.0-1.0>");
    return { progress: 0, label: "" }; // unreachable
  }
  if (label === undefined) {
    die("Missing required flag: --label <text>");
    return { progress: 0, label: "" }; // unreachable
  }
  if (isNaN(progress) || progress < 0.0 || progress > 1.0) {
    die(`Invalid progress value: ${progress}. Must be between 0.0 and 1.0`);
    return { progress: 0, label: "" }; // unreachable
  }
  if (prNumber !== undefined && (isNaN(prNumber) || prNumber <= 0)) {
    die(`Invalid PR number: ${args[args.indexOf("--pr") + 1]}. Must be a positive integer`);
    return { progress: 0, label: "" }; // unreachable
  }

  return { progress, label, prNumber };
}

// ── Command implementation ───────────────────────────────────────────

/**
 * Write a heartbeat file for the current worker.
 * Auto-detects the item ID from the current git branch (ninthwave/{ID}).
 * Returns a status message.
 */
export function cmdHeartbeat(
  args: string[],
  projectRoot: string,
  deps: HeartbeatDeps = defaultDeps,
): string {
  const { progress, label, prNumber } = parseHeartbeatArgs(args);

  const branch = deps.getBranch();
  if (!branch) {
    die("Could not detect current git branch");
    return ""; // unreachable -- satisfies control flow when die is mocked in tests
  }

  const id = extractItemId(branch);
  if (!id) {
    die(`Not on an item branch (expected "ninthwave/<ID>", got "${branch}")`);
    return ""; // unreachable
  }

  writeHeartbeat(projectRoot, id, progress, label, deps.io, prNumber);

  // Update headless phase if a phase file exists (headless workers only).
  if (progress > 0) {
    try {
      if (deps.io.existsSync(headlessPhaseFilePath(projectRoot, id))) {
        const phase = progress >= 1.0 ? "waiting" as const : "implementing" as const;
        writeHeadlessPhase(projectRoot, id, phase);
      }
    } catch { /* best-effort */ }
  }

  const msg = `Heartbeat: ${id} ${(progress * 100).toFixed(0)}% -- ${label}`;
  console.log(msg);
  return msg;
}
