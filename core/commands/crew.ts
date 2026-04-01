// `nw crew` -- interactive crew management command.
//
// Three entry points:
// 1. Interactive mode (`nw crew`) -- prompt with join (default) and create options
// 2. Direct join shorthand (`nw crew abc-xyz`) -- join immediately
// 3. Explicit subcommands (`nw crew create`, `nw crew join abc-xyz`) -- for scripting/CI
//
// Non-TTY environments get usage help instead of an interactive prompt.

import { createInterface } from "readline";
import { BOLD, CYAN, DIM, GREEN, YELLOW, RESET } from "../output.ts";
import { die } from "../output.ts";

// ── Types ──────────────────────────────────────────────────────────

/** Crew code pattern: 4 groups of 4 alphanumeric chars, optional hyphens (case-insensitive). */
export const CREW_CODE_PATTERN = /^[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}$/i;
export const CREW_CODE_EXAMPLE = "K2F9-AB3X-7YPL-QM4N";
export const CREW_CODE_FORMAT_HINT = `Expected format: XXXX-XXXX-XXXX-XXXX (e.g. ${CREW_CODE_EXAMPLE})`;

export type ConnectionAction =
  | { type: "connect" }
  | { type: "join"; code: string };

export type PromptFn = (question: string) => Promise<string>;

export interface CrewDeps {
  prompt?: PromptFn;
  isTTY?: boolean;
  runWatch?: (args: string[], workDir: string, worktreeDir: string, projectRoot: string) => Promise<void>;
}

// ── Crew code validation ───────────────────────────────────────────

export function isCrewCode(value: string): boolean {
  return parseCrewCode(value) !== null;
}

/** Normalize a crew code to uppercase with hyphens (e.g. "k2f9ab3x7yplqm4n" -> "K2F9-AB3X-7YPL-QM4N"). */
export function normalizeCrewCode(value: string): string {
  const upper = value.trim().toUpperCase().replace(/-/g, "");
  if (upper.length === 16) return `${upper.slice(0, 4)}-${upper.slice(4, 8)}-${upper.slice(8, 12)}-${upper.slice(12)}`;
  return value.trim().toUpperCase();
}

export function parseCrewCode(value: string): string | null {
  const normalized = normalizeCrewCode(value);
  return CREW_CODE_PATTERN.test(normalized) ? normalized : null;
}

export function formatInvalidCrewCodeMessage(value: string): string {
  return `Invalid session code: ${value}. ${CREW_CODE_FORMAT_HINT}`;
}

export function requireCrewCode(value: string): string {
  const normalized = parseCrewCode(value);
  if (!normalized) {
    throw new Error(formatInvalidCrewCodeMessage(value));
  }
  return normalized;
}

// ── Argument parsing ───────────────────────────────────────────────

/**
 * Parse crew command arguments into an action.
 * Returns null for interactive mode (no args).
 * Throws on invalid input (caller converts to die()).
 */
export function parseCrewArgs(args: string[]): ConnectionAction | null {
  if (args.length === 0) return null; // interactive mode

  const first = args[0]!;

  // Explicit subcommands
  if (first === "create") {
    return { type: "connect" };
  }

  if (first === "join") {
    const code = args[1];
    if (!code) {
      throw new Error("Usage: nw crew join <session-code>");
    }
    return { type: "join", code: requireCrewCode(code) };
  }

  // Direct join shorthand: nw crew abc-xyz
  const shorthandCode = parseCrewCode(first);
  if (shorthandCode) {
    return { type: "join", code: shorthandCode };
  }

  throw new Error(`Unknown crew subcommand: ${first}. Use "nw crew --help" for usage.`);
}

// ── Interactive prompt ─────────────────────────────────────────────

const defaultPrompt: PromptFn = (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

/**
 * Interactive crew prompt.
 * Default action: type a crew code to join.
 * Secondary action: type "create" to start a new crew.
 * Returns null if the user cancels (empty input or "q").
 */
export async function promptCrewAction(
  prompt: PromptFn = defaultPrompt,
): Promise<ConnectionAction | null> {
  console.log();
  console.log(`${BOLD}Join session${RESET}`);
  console.log();
  console.log(`  Enter a session code to coordinate with teammates.`);
  console.log();

  while (true) {
    const answer = await prompt(`${BOLD}Session code: ${RESET}`);

    if (answer === "" || answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
      return null;
    }

    const normalizedCode = parseCrewCode(answer);
    if (normalizedCode) {
      return { type: "join", code: normalizedCode };
    }

    console.log(`  ${YELLOW}${formatInvalidCrewCodeMessage(answer)}${RESET}`);
  }
}

// ── Non-TTY usage help ─────────────────────────────────────────────

export function printCrewUsage(): void {
  console.log("Usage: nw crew [<crew-code>|create|join <crew-code>]");
  console.log();
  console.log("  nw crew                  Interactive mode (join or create)");
  console.log("  nw crew <crew-code>      Join a crew directly");
  console.log("  nw crew create           Create a new crew");
  console.log("  nw crew join <crew-code> Join a crew (explicit)");
  console.log();
  console.log("Examples:");
  console.log("  nw crew K2F9-AB3X-7YPL-QM4N");
  console.log("  nw crew create");
  console.log("  nw crew join K2F9-AB3X-7YPL-QM4N");
}

// ── Command handler ────────────────────────────────────────────────

/**
 * Main `nw crew` command handler.
 *
 * Routes to the correct crew action based on arguments:
 * - No args + TTY → interactive prompt
 * - No args + non-TTY → print usage help
 * - Crew code arg → direct join
 * - "create" → create new crew
 * - "join <code>" → explicit join
 */
export async function cmdCrew(
  args: string[],
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
  deps: CrewDeps = {},
): Promise<void> {
  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true);
  const prompt = deps.prompt ?? defaultPrompt;

  // Parse explicit arguments
  let action: ConnectionAction | null;
  try {
    action = parseCrewArgs(args);
  } catch (err) {
    die((err as Error).message);
  }

  if (action) {
    // Explicit action (direct join or explicit subcommand)
    await executeCrewAction(action, workDir, worktreeDir, projectRoot, deps);
    return;
  }

  // No args -- need interactive mode
  if (!isTTY) {
    printCrewUsage();
    return;
  }

  // Interactive prompt
  const chosen = await promptCrewAction(prompt);
  if (!chosen) return; // user cancelled

  await executeCrewAction(chosen, workDir, worktreeDir, projectRoot, deps);
}

// ── Action execution ───────────────────────────────────────────────

async function executeCrewAction(
  action: ConnectionAction,
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
  deps: CrewDeps = {},
): Promise<void> {
  const runWatch = deps.runWatch ?? (async (watchArgs: string[], wd: string, wtd: string, pr: string) => {
    const { cmdWatch } = await import("./orchestrate.ts");
    await cmdWatch(watchArgs, wd, wtd, pr);
  });

  if (action.type === "connect") {
    await runWatch(["--connect"], workDir, worktreeDir, projectRoot);
  } else {
    await runWatch(["--crew", action.code], workDir, worktreeDir, projectRoot);
  }
}
