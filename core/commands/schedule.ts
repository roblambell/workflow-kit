// schedule command: list, show, validate, and trigger scheduled tasks.

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { die, BOLD, DIM, RESET, YELLOW, GREEN, RED } from "../output.ts";
import { listScheduledTasks, parseScheduleFile } from "../schedule-files.ts";
import { nextRunTime, parseScheduleExpression } from "../schedule-eval.ts";
import { isDaemonRunning } from "../daemon.ts";
import { userStateDir } from "../daemon.ts";

/**
 * Format a duration in milliseconds as a human-readable relative string.
 * e.g., "in 14h", "in 2h 30m", "in 45m", "in 5m"
 */
function formatRelative(ms: number): string {
  if (ms < 0) return "overdue";
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return "in <1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `in ${hours}h ${minutes}m`;
  if (hours > 0) return `in ${hours}h`;
  return `in ${minutes}m`;
}

/**
 * Format a Date as a concise human-readable string.
 * e.g., "tomorrow 09:00", "Mon 14:30", "2026-04-01 09:00"
 */
function formatNextRun(date: Date, now: Date): string {
  const diffMs = date.getTime() - now.getTime();
  const relative = formatRelative(diffMs);

  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const time = `${hh}:${mm}`;

  // Check if it's today
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  // Check if it's tomorrow
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate();

  if (isToday) return `today ${time} (${relative})`;
  if (isTomorrow) return `tomorrow ${time} (${relative})`;

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayName = days[date.getDay()]!;

  // If within 7 days, show day name
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  if (diffMs < oneWeekMs) {
    return `${dayName} ${time} (${relative})`;
  }

  // Otherwise show full date
  const yyyy = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mo}-${dd} ${time} (${relative})`;
}

/**
 * Format a timeout in milliseconds as human-readable.
 */
function formatTimeout(ms: number): string {
  if (ms >= 60 * 60 * 1000) {
    const hours = ms / (60 * 60 * 1000);
    return `${hours}h`;
  }
  if (ms >= 60 * 1000) {
    const minutes = ms / (60 * 1000);
    return `${minutes}m`;
  }
  return `${ms}ms`;
}

// ── Helpers ─────────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

// ── Subcommands ─────────────────────────────────────────────────────

function cmdScheduleList(projectRoot: string): void {
  const scheduleDir = join(projectRoot, ".ninthwave", "schedules");
  const tasks = listScheduledTasks(scheduleDir);

  if (tasks.length === 0) {
    console.log("No scheduled tasks found.");
    console.log(`${DIM}Add schedule files to .ninthwave/schedules/ to get started.${RESET}`);
    return;
  }

  const now = new Date();

  console.log(
    `${BOLD}${pad("ID", 24)} ${pad("SCHEDULE", 28)} ${pad("DOMAIN", 14)} ${pad("NEXT RUN", 36)}${RESET}`,
  );
  console.log("-".repeat(102));

  for (const task of tasks) {
    const enabledTag = task.enabled ? "" : ` ${YELLOW}[disabled]${RESET}`;
    const next = task.enabled ? nextRunTime(task.scheduleCron, now) : null;
    const nextStr = next ? formatNextRun(next, now) : (task.enabled ? "-" : "");

    console.log(
      `${pad(task.id, 24)} ${pad(task.schedule, 28)} ${pad(task.domain, 14)} ${nextStr}${enabledTag}`,
    );
  }

  console.log();
  console.log(`${DIM}${tasks.length} schedule(s)${RESET}`);
}

function cmdScheduleShow(id: string, projectRoot: string): void {
  const scheduleDir = join(projectRoot, ".ninthwave", "schedules");
  const tasks = listScheduledTasks(scheduleDir);
  const task = tasks.find((t) => t.id === id);

  if (!task) {
    die(`Schedule not found: ${id}`);
  }

  const now = new Date();
  const next = task.enabled ? nextRunTime(task.scheduleCron, now) : null;

  console.log(`${BOLD}${task.title}${RESET} (${task.id})`);
  console.log();
  console.log(`  Schedule:   ${task.schedule} (cron: ${task.scheduleCron})`);
  console.log(`  Priority:   ${task.priority}`);
  console.log(`  Domain:     ${task.domain}`);
  console.log(`  Timeout:    ${formatTimeout(task.timeout)}`);
  console.log(`  Enabled:    ${task.enabled ? `${GREEN}true${RESET}` : `${YELLOW}false${RESET}`}`);
  console.log(`  Next run:   ${next ? formatNextRun(next, now) : "-"}`);

  // Try to read last-run from state file
  const stateDir = userStateDir(projectRoot);
  const lastRunFile = join(stateDir, "schedule-state", `${id}.json`);
  if (existsSync(lastRunFile)) {
    try {
      const state = JSON.parse(readFileSync(lastRunFile, "utf-8"));
      if (state.lastRunAt) {
        console.log(`  Last run:   ${state.lastRunAt}`);
      }
    } catch {
      // ignore malformed state
    }
  } else {
    console.log(`  Last run:   never`);
  }

  console.log();
  if (task.prompt) {
    console.log(`${BOLD}Prompt:${RESET}`);
    // Truncate to first 10 lines
    const promptLines = task.prompt.split("\n");
    const truncated = promptLines.length > 10;
    const display = truncated ? promptLines.slice(0, 10) : promptLines;
    for (const line of display) {
      console.log(`  ${line}`);
    }
    if (truncated) {
      console.log(`  ${DIM}... (${promptLines.length - 10} more lines)${RESET}`);
    }
  }
}

function cmdScheduleValidate(projectRoot: string): void {
  const scheduleDir = join(projectRoot, ".ninthwave", "schedules");

  if (!existsSync(scheduleDir)) {
    console.log("No schedules directory found.");
    process.exit(0);
  }

  const entries = readdirSync(scheduleDir).filter((f) => f.endsWith(".md"));

  if (entries.length === 0) {
    console.log("No schedule files found.");
    process.exit(0);
  }

  let hasErrors = false;

  for (const entry of entries) {
    const filePath = join(scheduleDir, entry);
    const content = readFileSync(filePath, "utf-8");
    const errors: string[] = [];

    // Check heading with ID
    const headingMatch = content.match(/^# .+\(([a-z0-9][-a-z0-9]*)\)\s*$/m);
    if (!headingMatch) {
      errors.push("missing or malformed heading with ID (expected: # Title (id))");
    }

    // Check Schedule field
    const scheduleMatch = content.match(/^\*\*Schedule:\*\*\s+(.+)/m);
    if (!scheduleMatch) {
      errors.push("missing Schedule field");
    } else {
      // Validate the expression is parseable
      try {
        parseScheduleExpression(scheduleMatch[1]!.trim());
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`invalid schedule expression: ${msg}`);
      }
    }

    if (errors.length > 0) {
      hasErrors = true;
      for (const err of errors) {
        console.log(`${RED}ERROR:${RESET} ${entry}: ${err}`);
      }
    } else {
      console.log(`${GREEN}OK:${RESET} ${entry}`);
    }
  }

  if (hasErrors) {
    process.exit(1);
  }
}

function cmdScheduleRun(id: string, projectRoot: string): void {
  // Verify the schedule ID exists
  const scheduleDir = join(projectRoot, ".ninthwave", "schedules");
  const tasks = listScheduledTasks(scheduleDir);
  const task = tasks.find((t) => t.id === id);

  if (!task) {
    die(`Schedule not found: ${id}`);
  }

  // Check if daemon is running
  const daemonPid = isDaemonRunning(projectRoot);
  if (daemonPid === null) {
    die("No daemon running. Start one with `nw watch`.");
  }

  // Write trigger file
  const stateDir = userStateDir(projectRoot);
  const triggerDir = join(stateDir, "schedule-triggers");
  mkdirSync(triggerDir, { recursive: true });

  const triggerPath = join(triggerDir, id);
  writeFileSync(triggerPath, new Date().toISOString(), "utf-8");

  console.log(`Trigger written for ${BOLD}${id}${RESET}.`);
  console.log(`Daemon (PID ${daemonPid}) will pick it up next cycle (~30s).`);
}

// ── Main handler ────────────────────────────────────────────────────

export function cmdSchedule(args: string[], projectRoot: string): void {
  const subcommand = args[0] ?? "list";

  switch (subcommand) {
    case "list":
      cmdScheduleList(projectRoot);
      break;
    case "show": {
      const id = args[1];
      if (!id) die("Usage: nw schedule show <id>");
      cmdScheduleShow(id, projectRoot);
      break;
    }
    case "validate":
      cmdScheduleValidate(projectRoot);
      break;
    case "run": {
      const id = args[1];
      if (!id) die("Usage: nw schedule run <id>");
      cmdScheduleRun(id, projectRoot);
      break;
    }
    default:
      // If it doesn't match a subcommand, treat it as an alias or error
      die(`Unknown subcommand: ${subcommand}. Use list, show, validate, or run.`);
  }
}
