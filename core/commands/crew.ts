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

/** Crew code pattern: exactly 3 alphanumeric chars, hyphen, 3 alphanumeric chars (e.g. xK2-9fB). */
export const CREW_CODE_PATTERN = /^[A-Za-z0-9]{3}-[A-Za-z0-9]{3}$/;

export type CrewAction =
  | { type: "join"; code: string }
  | { type: "create" };

export type PromptFn = (question: string) => Promise<string>;

export interface CrewDeps {
  prompt?: PromptFn;
  isTTY?: boolean;
  runWatch?: (args: string[], workDir: string, worktreeDir: string, projectRoot: string) => Promise<void>;
}

// ── Crew code validation ───────────────────────────────────────────

export function isCrewCode(value: string): boolean {
  return CREW_CODE_PATTERN.test(value);
}

// ── Argument parsing ───────────────────────────────────────────────

/**
 * Parse crew command arguments into an action.
 * Returns null for interactive mode (no args).
 * Throws on invalid input (caller converts to die()).
 */
export function parseCrewArgs(args: string[]): CrewAction | null {
  if (args.length === 0) return null; // interactive mode

  const first = args[0]!;

  // Explicit subcommands
  if (first === "create") {
    return { type: "create" };
  }

  if (first === "join") {
    const code = args[1];
    if (!code) {
      throw new Error("Usage: nw crew join <crew-code>");
    }
    if (!isCrewCode(code)) {
      throw new Error(`Invalid crew code: ${code}. Expected format: XXX-XXX (e.g. xK2-9fB)`);
    }
    return { type: "join", code };
  }

  // Direct join shorthand: nw crew abc-xyz
  if (isCrewCode(first)) {
    return { type: "join", code: first };
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
): Promise<CrewAction | null> {
  console.log();
  console.log(`${BOLD}Crew mode${RESET}`);
  console.log();
  console.log(`  Enter a crew code to join, or type ${CYAN}create${RESET} to start a new crew.`);
  console.log();

  while (true) {
    const answer = await prompt(`${BOLD}Crew code ${DIM}(or "create")${RESET}${BOLD}: ${RESET}`);

    if (answer === "" || answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
      return null;
    }

    if (answer.toLowerCase() === "create") {
      return { type: "create" };
    }

    if (isCrewCode(answer)) {
      return { type: "join", code: answer };
    }

    console.log(`  ${YELLOW}Invalid crew code.${RESET} Expected format: ${BOLD}XXX-XXX${RESET} (e.g. xK2-9fB), or type ${CYAN}create${RESET}.`);
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
  console.log("  nw crew xK2-9fB");
  console.log("  nw crew create");
  console.log("  nw crew join xK2-9fB");
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
  let action: CrewAction | null;
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
  action: CrewAction,
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
  deps: CrewDeps = {},
): Promise<void> {
  const runWatch = deps.runWatch ?? (async (watchArgs: string[], wd: string, wtd: string, pr: string) => {
    const { cmdWatch } = await import("./orchestrate.ts");
    await cmdWatch(watchArgs, wd, wtd, pr);
  });

  if (action.type === "create") {
    await runWatch(["--crew-create"], workDir, worktreeDir, projectRoot);
  } else {
    await runWatch(["--crew", action.code], workDir, worktreeDir, projectRoot);
  }
}
