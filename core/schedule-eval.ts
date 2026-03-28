// Schedule expression parsing and cron evaluation.
// No external dependencies — pure functions for cron matching and natural language conversion.

/**
 * Parse a natural language schedule expression into a 5-field cron string.
 *
 * Supported patterns:
 *   - "every Nh"  / "every Nm"   — anchored to midnight (e.g., "every 2h" → "0 *​/2 * * *")
 *   - "every day at HH:MM"       — daily at a specific time
 *   - "every weekday at HH:MM"   — Mon–Fri at a specific time
 *   - "every <weekday> at HH:MM" — specific day of week
 *   - "cron: <5-field>"          — raw cron passthrough
 *
 * Returns the 5-field cron string, or throws on unrecognized input.
 */
export function parseScheduleExpression(expr: string): string {
  const trimmed = expr.trim();

  // Raw cron passthrough: "cron: 0 */2 * * *"
  const cronMatch = trimmed.match(/^cron:\s*(.+)$/i);
  if (cronMatch) {
    const fields = cronMatch[1]!.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length} in "${cronMatch[1]!.trim()}"`);
    }
    return fields.join(" ");
  }

  // "every Nm" — e.g., "every 15m", "every 30m"
  const minuteMatch = trimmed.match(/^every\s+(\d+)\s*m$/i);
  if (minuteMatch) {
    const n = parseInt(minuteMatch[1]!, 10);
    if (n < 1 || n > 59) throw new Error(`Invalid minute interval: ${n}`);
    return `*/${n} * * * *`;
  }

  // "every Nh" — e.g., "every 2h", "every 6h"
  const hourMatch = trimmed.match(/^every\s+(\d+)\s*h$/i);
  if (hourMatch) {
    const n = parseInt(hourMatch[1]!, 10);
    if (n < 1 || n > 23) throw new Error(`Invalid hour interval: ${n}`);
    return `0 */${n} * * *`;
  }

  // "every day at HH:MM"
  const dailyMatch = trimmed.match(/^every\s+day\s+at\s+(\d{1,2}):(\d{2})$/i);
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1]!, 10);
    const minute = parseInt(dailyMatch[2]!, 10);
    validateTime(hour, minute);
    return `${minute} ${hour} * * *`;
  }

  // "every weekday at HH:MM"
  const weekdayMatch = trimmed.match(/^every\s+weekday\s+at\s+(\d{1,2}):(\d{2})$/i);
  if (weekdayMatch) {
    const hour = parseInt(weekdayMatch[1]!, 10);
    const minute = parseInt(weekdayMatch[2]!, 10);
    validateTime(hour, minute);
    return `${minute} ${hour} * * 1-5`;
  }

  // "every <weekday> at HH:MM"
  const dayMatch = trimmed.match(/^every\s+(\w+)\s+at\s+(\d{1,2}):(\d{2})$/i);
  if (dayMatch) {
    const dayName = dayMatch[1]!.toLowerCase();
    const dayNum = WEEKDAY_MAP[dayName];
    if (dayNum === undefined) {
      throw new Error(`Unrecognized day of week: "${dayMatch[1]}"`);
    }
    const hour = parseInt(dayMatch[2]!, 10);
    const minute = parseInt(dayMatch[3]!, 10);
    validateTime(hour, minute);
    return `${minute} ${hour} * * ${dayNum}`;
  }

  throw new Error(`Unrecognized schedule expression: "${trimmed}"`);
}

/** Weekday name → cron day-of-week (0=Sunday). */
const WEEKDAY_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function validateTime(hour: number, minute: number): void {
  if (hour < 0 || hour > 23) throw new Error(`Invalid hour: ${hour}`);
  if (minute < 0 || minute > 59) throw new Error(`Invalid minute: ${minute}`);
}

// ── Cron field matching ──────────────────────────────────────────────

/**
 * Check if a single cron field matches a given value.
 *
 * Supports: wildcard (*), specific number, range (1-5), list (1,3,5), step (*​/15).
 */
export function matchesCronField(field: string, value: number): boolean {
  // Wildcard
  if (field === "*") return true;

  // Step: */N or N-M/S
  if (field.includes("/")) {
    const [rangeStr, stepStr] = field.split("/");
    const step = parseInt(stepStr!, 10);
    if (isNaN(step) || step <= 0) return false;

    if (rangeStr === "*") {
      return value % step === 0;
    }

    // Range with step: N-M/S
    if (rangeStr!.includes("-")) {
      const [startStr, endStr] = rangeStr!.split("-");
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      if (value < start || value > end) return false;
      return (value - start) % step === 0;
    }

    // Specific start with step (uncommon but valid): N/S
    const start = parseInt(rangeStr!, 10);
    if (value < start) return false;
    return (value - start) % step === 0;
  }

  // List: 1,3,5
  if (field.includes(",")) {
    return field.split(",").some((part) => matchesCronField(part.trim(), value));
  }

  // Range: 1-5
  if (field.includes("-")) {
    const [startStr, endStr] = field.split("-");
    const start = parseInt(startStr!, 10);
    const end = parseInt(endStr!, 10);
    return value >= start && value <= end;
  }

  // Specific number
  return parseInt(field, 10) === value;
}

/**
 * Check if all 5 cron fields match a given Date.
 *
 * Day-of-week OR semantics: when both day-of-month (field 3) and day-of-week
 * (field 5) are non-wildcard, the cron spec says they are OR'd — the date
 * matches if EITHER field matches.
 */
export function matchesCron(cronExpr: string, date: Date): boolean {
  const fields = cronExpr.split(/\s+/);
  if (fields.length !== 5) return false;

  const [minuteF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // 1-based
  const dow = date.getDay(); // 0=Sunday

  if (!matchesCronField(minuteF, minute)) return false;
  if (!matchesCronField(hourF, hour)) return false;
  if (!matchesCronField(monthF, month)) return false;

  // Day-of-week OR semantics: when both are non-wildcard, match either
  const domIsWild = domF === "*";
  const dowIsWild = dowF === "*";

  if (domIsWild && dowIsWild) {
    return true; // Both wildcards — always matches
  }
  if (!domIsWild && !dowIsWild) {
    // OR semantics: either day-of-month or day-of-week can match
    return matchesCronField(domF, dom) || matchesCronField(dowF, dow);
  }
  // One is wildcard, the other is not — match the non-wildcard
  if (!domIsWild && !matchesCronField(domF, dom)) return false;
  if (!dowIsWild && !matchesCronField(dowF, dow)) return false;

  return true;
}

// ── isDue / nextRunTime ──────────────────────────────────────────────

/** Truncate a Date to minute precision (zero out seconds and milliseconds). */
function truncateToMinute(d: Date): Date {
  const result = new Date(d);
  result.setSeconds(0, 0);
  return result;
}

/**
 * Determine if a task should fire right now.
 *
 * - Checks if `cronExpr` matches `now` (with 2-minute tolerance window).
 * - Skips if `lastRunAt` is in the current minute (double-fire prevention).
 *
 * @param cronExpr   5-field cron expression
 * @param lastRunAt  when the task last ran (null if never)
 * @param now        current time
 */
export function isDue(
  cronExpr: string,
  lastRunAt: Date | null,
  now: Date,
): boolean {
  const nowMinute = truncateToMinute(now);

  // Double-fire prevention: if lastRunAt falls in the same minute as now, skip
  if (lastRunAt) {
    const lastMinute = truncateToMinute(lastRunAt);
    if (lastMinute.getTime() === nowMinute.getTime()) return false;
  }

  // Check current minute and up to 2 minutes back (tolerance window)
  for (let offset = 0; offset <= 2; offset++) {
    const check = new Date(nowMinute.getTime() - offset * 60_000);
    if (matchesCron(cronExpr, check)) {
      // If lastRunAt already covers this check minute, skip
      if (lastRunAt) {
        const lastMinute = truncateToMinute(lastRunAt);
        if (lastMinute.getTime() >= check.getTime()) continue;
      }
      return true;
    }
  }

  return false;
}

/**
 * Compute the next occurrence of a cron expression after a given time.
 *
 * Scans minute-by-minute from `after` up to 400 days ahead.
 * Returns null if no match is found (e.g., impossible cron like "60 25 32 13 *").
 */
export function nextRunTime(cronExpr: string, after: Date): Date | null {
  // Start from the next minute after `after`
  const start = truncateToMinute(after);
  start.setMinutes(start.getMinutes() + 1);

  // Scan up to 400 days * 24 hours * 60 minutes = 576,000 iterations max
  const maxIterations = 400 * 24 * 60;

  const candidate = new Date(start);
  for (let i = 0; i < maxIterations; i++) {
    if (matchesCron(cronExpr, candidate)) {
      return new Date(candidate);
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}
