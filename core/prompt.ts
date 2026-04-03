// Simple interactive terminal prompts for CLI commands.
//
// Provides checkbox multi-select and confirmation prompts using
// raw terminal mode for keystroke capture. Falls back to non-interactive
// defaults when stdin is not a TTY.

import { createInterface } from "readline";
import { BOLD, DIM, GREEN, RESET } from "./output.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface CheckboxChoice {
  value: string;
  label: string;
  description?: string;
  checked: boolean;
}

/** Function signature for injectable checkbox prompt. */
export type CheckboxPromptFn = (
  message: string,
  choices: CheckboxChoice[],
) => Promise<string[]>;

/** Function signature for injectable confirm prompt. */
export type ConfirmPromptFn = (
  message: string,
  defaultValue?: boolean,
) => Promise<boolean>;

export type RestartRecoveryAction = "relaunch" | "hold";

/** Prompt signature for unresolved restart-recovery items. */
export type RestartRecoveryPromptFn = (
  itemId: string,
  worktreePath: string,
) => Promise<RestartRecoveryAction>;

// ── Checkbox prompt ──────────────────────────────────────────────────

/**
 * Display an interactive checkbox prompt.
 *
 * Arrow keys (or j/k) navigate, space toggles, 'a' toggles all, enter confirms.
 * Returns the values of selected (checked) items.
 */
export async function checkboxPrompt(
  message: string,
  choices: CheckboxChoice[],
): Promise<string[]> {
  const items = choices.map((c) => ({ ...c }));
  let cursor = 0;

  const renderLine = (i: number): string => {
    const item = items[i]!;
    const pointer = i === cursor ? `${GREEN}>${RESET}` : " ";
    const check = item.checked ? `${GREEN}[x]${RESET}` : "[ ]";
    const desc = item.description
      ? ` ${DIM}-- ${item.description}${RESET}`
      : "";
    return `  ${pointer} ${check} ${BOLD}${item.label}${RESET}${desc}`;
  };

  const hint = `${DIM}  (arrows navigate, space toggle, a toggle all, enter confirm)${RESET}`;

  // Initial render
  console.log(message);
  console.log(hint);
  for (let i = 0; i < items.length; i++) {
    console.log(renderLine(i));
  }

  const totalLines = items.length + 2; // message + hint + items

  const redraw = () => {
    // Move cursor up to start of block and clear each line
    process.stdout.write(`\x1b[${totalLines}A`);
    process.stdout.write(`\x1b[2K${message}\n`);
    process.stdout.write(`\x1b[2K${hint}\n`);
    for (let i = 0; i < items.length; i++) {
      process.stdout.write(`\x1b[2K${renderLine(i)}\n`);
    }
  };

  // Enable raw mode for keystroke capture
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l"); // Hide text cursor

  return new Promise<string[]>((resolve) => {
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h"); // Show text cursor
    };

    const onData = (data: Buffer) => {
      const key = data.toString();

      if (key === "\x1b[A" || key === "k") {
        // Up
        cursor = Math.max(0, cursor - 1);
        redraw();
      } else if (key === "\x1b[B" || key === "j") {
        // Down
        cursor = Math.min(items.length - 1, cursor + 1);
        redraw();
      } else if (key === " ") {
        // Toggle current
        items[cursor]!.checked = !items[cursor]!.checked;
        redraw();
      } else if (key === "a") {
        // Toggle all
        const allChecked = items.every((i) => i.checked);
        for (const item of items) item.checked = !allChecked;
        redraw();
      } else if (key === "\r" || key === "\n") {
        // Confirm
        cleanup();
        resolve(items.filter((i) => i.checked).map((i) => i.value));
      } else if (key === "\x03") {
        // Ctrl+C
        cleanup();
        process.exit(130);
      }
    };

    process.stdin.on("data", onData);
  });
}

// ── Confirm prompt ───────────────────────────────────────────────────

/**
 * Display a Y/n confirmation prompt.
 *
 * Returns true for yes (or empty input when defaultValue is true).
 */
export async function confirmPrompt(
  message: string,
  defaultValue: boolean = true,
): Promise<boolean> {
  const suffix = defaultValue ? "(Y/n)" : "(y/N)";

  return new Promise<boolean>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${message} ${suffix} `, (answer: string) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") resolve(defaultValue);
      else resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * Ask whether an unresolved restarted worker should be relaunched or held.
 */
export async function promptRestartRecoveryAction(
  itemId: string,
  worktreePath: string,
  prompt: ConfirmPromptFn = confirmPrompt,
): Promise<RestartRecoveryAction> {
  const shouldRelaunch = await prompt(
    `No live workspace was found for restarted item ${itemId} (${worktreePath}). Relaunch it now?`,
    true,
  );
  return shouldRelaunch ? "relaunch" : "hold";
}
