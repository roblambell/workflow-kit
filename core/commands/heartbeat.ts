// heartbeat command: workers report progress via a fast file write.
// Usage: nw heartbeat --progress 0.3 --label "Writing tests"

import { die } from "../output.ts";
import { writeHeartbeat, type DaemonIO, type HeartbeatCostFields } from "../daemon.ts";
import {
  existsSync,
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
  io: { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync },
  getBranch: () => {
    try {
      const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
      return result.exitCode === 0 ? result.stdout.toString().trim() : null;
    } catch {
      return null;
    }
  },
};

// ── Branch detection ─────────────────────────────────────────────────

/** Extract TODO ID from a branch name like "todo/H-FOO-1". Returns null if not a todo branch. */
export function extractTodoId(branch: string): string | null {
  const match = branch.match(/^todo\/(.+)$/);
  return match ? match[1] : null;
}

// ── Argument parsing ─────────────────────────────────────────────────

export interface HeartbeatArgs {
  progress: number;
  label: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}

/** Parse --progress, --label, --model, --tokens-in, --tokens-out from CLI args. Throws on invalid input. */
export function parseHeartbeatArgs(args: string[]): HeartbeatArgs {
  let progress: number | undefined;
  let label: string | undefined;
  let model: string | undefined;
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--progress" && i + 1 < args.length) {
      progress = parseFloat(args[i + 1]!);
      i++;
    } else if (args[i] === "--label" && i + 1 < args.length) {
      label = args[i + 1];
      i++;
    } else if (args[i] === "--model" && i + 1 < args.length) {
      model = args[i + 1];
      i++;
    } else if (args[i] === "--tokens-in" && i + 1 < args.length) {
      tokensIn = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === "--tokens-out" && i + 1 < args.length) {
      tokensOut = parseInt(args[i + 1]!, 10);
      i++;
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
  if (tokensIn !== undefined && (isNaN(tokensIn) || tokensIn < 0)) {
    die(`Invalid --tokens-in value: must be a non-negative integer`);
    return { progress: 0, label: "" }; // unreachable
  }
  if (tokensOut !== undefined && (isNaN(tokensOut) || tokensOut < 0)) {
    die(`Invalid --tokens-out value: must be a non-negative integer`);
    return { progress: 0, label: "" }; // unreachable
  }

  return {
    progress,
    label,
    ...(model ? { model } : {}),
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
  };
}

// ── Command implementation ───────────────────────────────────────────

/**
 * Write a heartbeat file for the current worker.
 * Auto-detects the TODO ID from the current git branch (todo/{ID}).
 * Returns a status message.
 */
export function cmdHeartbeat(
  args: string[],
  projectRoot: string,
  deps: HeartbeatDeps = defaultDeps,
): string {
  const { progress, label, model, tokensIn, tokensOut } = parseHeartbeatArgs(args);

  const branch = deps.getBranch();
  if (!branch) {
    die("Could not detect current git branch");
    return ""; // unreachable — satisfies control flow when die is mocked in tests
  }

  const id = extractTodoId(branch);
  if (!id) {
    die(`Not on a todo branch (expected "todo/<ID>", got "${branch}")`);
    return ""; // unreachable
  }

  const costFields: HeartbeatCostFields | undefined =
    (model || tokensIn != null || tokensOut != null)
      ? { model, inputTokens: tokensIn, outputTokens: tokensOut }
      : undefined;

  writeHeartbeat(projectRoot, id, progress, label, deps.io, costFields);

  const msg = `Heartbeat: ${id} ${(progress * 100).toFixed(0)}% — ${label}`;
  console.log(msg);
  return msg;
}
