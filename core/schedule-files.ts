// Schedule file operations: parse and list scheduled task files.
// Mirrors the work-item-files.ts parsing pattern.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { ScheduledTask, Priority } from "./types.ts";
import { PRIORITY_NUM } from "./types.ts";
import { parseScheduleExpression } from "./schedule-eval.ts";

/** Default timeout for scheduled tasks: 30 minutes in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 1_800_000

/**
 * Parse a single schedule file into a ScheduledTask.
 *
 * Expected format:
 * ```
 * # Task Title (task-id)
 *
 * **Schedule:** every 2h
 * **Priority:** High
 * **Domain:** ci
 * **Timeout:** 15m
 * **Enabled:** true
 *
 * Body text is the prompt.
 * ```
 *
 * Returns null if the file is malformed (missing heading/ID or Schedule field).
 */
export function parseScheduleFile(filePath: string): ScheduledTask | null {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  // Extract ID and title from heading: "# Title (id)"
  let id = "";
  let title = "";
  for (const line of lines) {
    if (line.startsWith("# ")) {
      const idMatch = line.match(/\(([a-z0-9][-a-z0-9]*)\)\s*$/);
      if (idMatch) {
        id = idMatch[1]!;
      }
      // Title: everything between "# " and the ID parens
      title = line
        .slice(2)
        .replace(/\s*\([a-z0-9][-a-z0-9]*\)\s*$/, "")
        .trim();
      break;
    }
  }

  if (!id) return null;

  // Extract metadata fields
  let schedule = "";
  let priority: Priority = "medium";
  let domain = "uncategorized";
  let timeout = DEFAULT_TIMEOUT_MS;
  let enabled = true;

  for (const line of lines) {
    const scheduleMatch = line.match(/^\*\*Schedule:\*\*\s+(.+)/);
    if (scheduleMatch) {
      schedule = scheduleMatch[1]!.trim();
    }

    const priorityMatch = line.match(/^\*\*Priority:\*\*\s+(.+)/);
    if (priorityMatch) {
      const p = priorityMatch[1]!.toLowerCase().trim();
      if (p in PRIORITY_NUM) {
        priority = p as Priority;
      }
    }

    const domainMatch = line.match(/^\*\*Domain:\*\*\s+(.+)/);
    if (domainMatch) {
      domain = domainMatch[1]!.trim();
    }

    const timeoutMatch = line.match(/^\*\*Timeout:\*\*\s+(.+)/);
    if (timeoutMatch) {
      timeout = parseTimeout(timeoutMatch[1]!.trim());
    }

    const enabledMatch = line.match(/^\*\*Enabled:\*\*\s+(.+)/);
    if (enabledMatch) {
      enabled = enabledMatch[1]!.trim().toLowerCase() !== "false";
    }
  }

  // Schedule is required
  if (!schedule) return null;

  // Parse the schedule expression into a cron string
  let scheduleCron: string;
  try {
    scheduleCron = parseScheduleExpression(schedule);
  } catch {
    return null; // Malformed schedule expression → skip
  }

  // Extract body text (prompt) — everything after the metadata block
  const prompt = extractPrompt(lines);

  return {
    id,
    title,
    schedule,
    scheduleCron,
    priority,
    domain,
    timeout,
    prompt,
    filePath,
    enabled,
  };
}

/**
 * List all scheduled tasks from a schedules directory.
 *
 * Reads all `.md` files, parses each, and returns valid ScheduledTask[].
 * Invalid/malformed files are silently skipped.
 */
export function listScheduledTasks(scheduleDir: string): ScheduledTask[] {
  if (!existsSync(scheduleDir)) return [];

  const entries = readdirSync(scheduleDir).filter((f) => f.endsWith(".md"));
  const tasks: ScheduledTask[] = [];

  for (const entry of entries) {
    const fp = join(scheduleDir, entry);
    const task = parseScheduleFile(fp);
    if (task) {
      tasks.push(task);
    }
  }

  return tasks;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Metadata line prefixes — used to detect end of metadata block. */
const METADATA_PREFIXES = [
  "**Schedule:**",
  "**Priority:**",
  "**Domain:**",
  "**Timeout:**",
  "**Enabled:**",
  "**Source:**",
];

/**
 * Extract prompt text from schedule file lines.
 * The prompt is everything after the heading and metadata block.
 */
function extractPrompt(lines: string[]): string {
  const promptLines: string[] = [];
  let pastHeader = false;
  let pastMeta = false;

  for (const line of lines) {
    if (!pastHeader) {
      if (line.startsWith("# ")) {
        pastHeader = true;
        continue;
      }
      continue;
    }

    if (!pastMeta) {
      if (
        METADATA_PREFIXES.some((prefix) => line.startsWith(prefix)) ||
        line.trim() === ""
      ) {
        continue;
      }
      pastMeta = true;
    }

    promptLines.push(line);
  }

  // Trim trailing empty lines
  while (promptLines.length > 0 && promptLines[promptLines.length - 1]!.trim() === "") {
    promptLines.pop();
  }

  return promptLines.join("\n");
}

/**
 * Parse a timeout string into milliseconds.
 * Supports: "15m", "30m", "1h", "2h", "90s", plain number (ms).
 */
function parseTimeout(str: string): number {
  const minuteMatch = str.match(/^(\d+)\s*m$/i);
  if (minuteMatch) return parseInt(minuteMatch[1]!, 10) * 60 * 1000;

  const hourMatch = str.match(/^(\d+)\s*h$/i);
  if (hourMatch) return parseInt(hourMatch[1]!, 10) * 60 * 60 * 1000;

  const secondMatch = str.match(/^(\d+)\s*s$/i);
  if (secondMatch) return parseInt(secondMatch[1]!, 10) * 1000;

  const num = parseInt(str, 10);
  if (!isNaN(num)) return num;

  return DEFAULT_TIMEOUT_MS;
}
