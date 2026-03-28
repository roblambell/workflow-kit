// Tests for core/schedule-eval.ts — schedule expression parsing and cron evaluation.

import { describe, it, expect } from "vitest";
import {
  parseScheduleExpression,
  matchesCronField,
  matchesCron,
  isDue,
  nextRunTime,
} from "../core/schedule-eval.ts";

// ── parseScheduleExpression ──────────────────────────────────────────

describe("parseScheduleExpression", () => {
  it("converts 'every Nm' to cron", () => {
    expect(parseScheduleExpression("every 15m")).toBe("*/15 * * * *");
    expect(parseScheduleExpression("every 30m")).toBe("*/30 * * * *");
    expect(parseScheduleExpression("every 1m")).toBe("*/1 * * * *");
  });

  it("converts 'every Nh' to cron", () => {
    expect(parseScheduleExpression("every 2h")).toBe("0 */2 * * *");
    expect(parseScheduleExpression("every 6h")).toBe("0 */6 * * *");
    expect(parseScheduleExpression("every 1h")).toBe("0 */1 * * *");
  });

  it("converts 'every day at HH:MM' to cron", () => {
    expect(parseScheduleExpression("every day at 09:00")).toBe("0 9 * * *");
    expect(parseScheduleExpression("every day at 14:30")).toBe("30 14 * * *");
    expect(parseScheduleExpression("every day at 0:00")).toBe("0 0 * * *");
  });

  it("converts 'every weekday at HH:MM' to cron", () => {
    expect(parseScheduleExpression("every weekday at 09:00")).toBe("0 9 * * 1-5");
    expect(parseScheduleExpression("every weekday at 17:30")).toBe("30 17 * * 1-5");
  });

  it("converts 'every <weekday> at HH:MM' to cron", () => {
    expect(parseScheduleExpression("every monday at 10:00")).toBe("0 10 * * 1");
    expect(parseScheduleExpression("every Friday at 16:00")).toBe("0 16 * * 5");
    expect(parseScheduleExpression("every sunday at 08:00")).toBe("0 8 * * 0");
    expect(parseScheduleExpression("every Wed at 12:30")).toBe("30 12 * * 3");
  });

  it("passes through raw cron expressions", () => {
    expect(parseScheduleExpression("cron: 0 */2 * * *")).toBe("0 */2 * * *");
    expect(parseScheduleExpression("cron: 30 4 * * 1-5")).toBe("30 4 * * 1-5");
    expect(parseScheduleExpression("cron: */15 * * * *")).toBe("*/15 * * * *");
  });

  it("rejects unsupported patterns", () => {
    expect(() => parseScheduleExpression("whenever")).toThrow("Unrecognized schedule expression");
    expect(() => parseScheduleExpression("twice daily")).toThrow("Unrecognized schedule expression");
    expect(() => parseScheduleExpression("")).toThrow("Unrecognized schedule expression");
  });

  it("rejects invalid cron field count", () => {
    expect(() => parseScheduleExpression("cron: * * *")).toThrow("expected 5 fields");
    expect(() => parseScheduleExpression("cron: * * * * * *")).toThrow("expected 5 fields");
  });

  it("rejects invalid intervals", () => {
    expect(() => parseScheduleExpression("every 0m")).toThrow("Invalid minute interval");
    expect(() => parseScheduleExpression("every 60m")).toThrow("Invalid minute interval");
    expect(() => parseScheduleExpression("every 0h")).toThrow("Invalid hour interval");
    expect(() => parseScheduleExpression("every 24h")).toThrow("Invalid hour interval");
  });

  it("rejects unrecognized day names", () => {
    expect(() => parseScheduleExpression("every notaday at 10:00")).toThrow("Unrecognized day of week");
  });

  it("trims whitespace", () => {
    expect(parseScheduleExpression("  every 2h  ")).toBe("0 */2 * * *");
  });
});

// ── matchesCronField ─────────────────────────────────────────────────

describe("matchesCronField", () => {
  it("matches wildcard", () => {
    expect(matchesCronField("*", 0)).toBe(true);
    expect(matchesCronField("*", 59)).toBe(true);
  });

  it("matches specific value", () => {
    expect(matchesCronField("5", 5)).toBe(true);
    expect(matchesCronField("5", 4)).toBe(false);
    expect(matchesCronField("0", 0)).toBe(true);
  });

  it("matches range", () => {
    expect(matchesCronField("1-5", 1)).toBe(true);
    expect(matchesCronField("1-5", 3)).toBe(true);
    expect(matchesCronField("1-5", 5)).toBe(true);
    expect(matchesCronField("1-5", 0)).toBe(false);
    expect(matchesCronField("1-5", 6)).toBe(false);
  });

  it("matches list", () => {
    expect(matchesCronField("1,3,5", 1)).toBe(true);
    expect(matchesCronField("1,3,5", 3)).toBe(true);
    expect(matchesCronField("1,3,5", 5)).toBe(true);
    expect(matchesCronField("1,3,5", 2)).toBe(false);
    expect(matchesCronField("1,3,5", 4)).toBe(false);
  });

  it("matches step", () => {
    expect(matchesCronField("*/15", 0)).toBe(true);
    expect(matchesCronField("*/15", 15)).toBe(true);
    expect(matchesCronField("*/15", 30)).toBe(true);
    expect(matchesCronField("*/15", 45)).toBe(true);
    expect(matchesCronField("*/15", 7)).toBe(false);
  });

  it("matches range with step", () => {
    // 0-30/10 should match 0, 10, 20, 30
    expect(matchesCronField("0-30/10", 0)).toBe(true);
    expect(matchesCronField("0-30/10", 10)).toBe(true);
    expect(matchesCronField("0-30/10", 20)).toBe(true);
    expect(matchesCronField("0-30/10", 30)).toBe(true);
    expect(matchesCronField("0-30/10", 5)).toBe(false);
    expect(matchesCronField("0-30/10", 40)).toBe(false);
  });
});

// ── matchesCron (day-of-week OR semantics) ───────────────────────────

describe("matchesCron day-of-week OR semantics", () => {
  it("matches when both dom and dow are wildcard", () => {
    // "0 9 * * *" — 9:00 AM every day
    const date = new Date(2026, 2, 28, 9, 0); // Saturday March 28, 2026
    expect(matchesCron("0 9 * * *", date)).toBe(true);
  });

  it("matches when only dom is non-wildcard", () => {
    // "0 9 15 * *" — 9:00 AM on the 15th of every month
    const date15 = new Date(2026, 2, 15, 9, 0);
    const date16 = new Date(2026, 2, 16, 9, 0);
    expect(matchesCron("0 9 15 * *", date15)).toBe(true);
    expect(matchesCron("0 9 15 * *", date16)).toBe(false);
  });

  it("matches when only dow is non-wildcard", () => {
    // "0 9 * * 1" — 9:00 AM every Monday
    const monday = new Date(2026, 2, 23, 9, 0); // Monday March 23, 2026
    const tuesday = new Date(2026, 2, 24, 9, 0);
    expect(matchesCron("0 9 * * 1", monday)).toBe(true);
    expect(matchesCron("0 9 * * 1", tuesday)).toBe(false);
  });

  it("OR semantics when both dom and dow are non-wildcard", () => {
    // "0 9 15 * 1" — 9:00 AM on the 15th OR any Monday
    // March 15, 2026 is a Sunday — matches dom
    const march15 = new Date(2026, 2, 15, 9, 0);
    expect(matchesCron("0 9 15 * 1", march15)).toBe(true);

    // March 23, 2026 is a Monday — matches dow
    const march23 = new Date(2026, 2, 23, 9, 0);
    expect(matchesCron("0 9 15 * 1", march23)).toBe(true);

    // March 24, 2026 is a Tuesday, not the 15th — matches neither
    const march24 = new Date(2026, 2, 24, 9, 0);
    expect(matchesCron("0 9 15 * 1", march24)).toBe(false);
  });
});

// ── isDue ────────────────────────────────────────────────────────────

describe("isDue", () => {
  it("fires when never-run and cron matches now", () => {
    // Cron: 0 9 * * * (9:00 AM daily)
    const now = new Date(2026, 2, 28, 9, 0, 30); // 9:00:30 AM
    expect(isDue("0 9 * * *", null, now)).toBe(true);
  });

  it("fires when due (last run was before the cron minute)", () => {
    const lastRun = new Date(2026, 2, 27, 9, 0, 0); // Yesterday 9:00
    const now = new Date(2026, 2, 28, 9, 0, 30); // Today 9:00
    expect(isDue("0 9 * * *", lastRun, now)).toBe(true);
  });

  it("does not fire when cron does not match now", () => {
    const now = new Date(2026, 2, 28, 10, 0, 0); // 10:00 AM
    expect(isDue("0 9 * * *", null, now)).toBe(false);
  });

  it("does not fire when already ran this minute (double-fire prevention)", () => {
    const now = new Date(2026, 2, 28, 9, 0, 30); // 9:00:30
    const lastRun = new Date(2026, 2, 28, 9, 0, 10); // Same minute: 9:00:10
    expect(isDue("0 9 * * *", lastRun, now)).toBe(false);
  });

  it("2-minute window: fires if cron matched 1 minute ago", () => {
    // Cron matches at :00, but now is :01
    const now = new Date(2026, 2, 28, 9, 1, 30);
    expect(isDue("0 9 * * *", null, now)).toBe(true);
  });

  it("2-minute window: fires if cron matched 2 minutes ago", () => {
    const now = new Date(2026, 2, 28, 9, 2, 30);
    expect(isDue("0 9 * * *", null, now)).toBe(true);
  });

  it("2-minute window: does NOT fire 3 minutes after cron", () => {
    const now = new Date(2026, 2, 28, 9, 3, 0);
    expect(isDue("0 9 * * *", null, now)).toBe(false);
  });

  it("2-minute window: does not fire if lastRunAt covers the window", () => {
    // Cron at 9:00, now is 9:02, but lastRun was at 9:00 (already caught it)
    const now = new Date(2026, 2, 28, 9, 2, 0);
    const lastRun = new Date(2026, 2, 28, 9, 0, 30);
    expect(isDue("0 9 * * *", lastRun, now)).toBe(false);
  });

  it("DST spring-forward: 2:30 schedule skipped when clock jumps 2→3", () => {
    // Simulate spring forward: clock goes from 1:59 to 3:00
    // A task scheduled for 2:30 should NOT fire at 3:00
    const now = new Date(2026, 2, 8, 3, 0, 0); // 3:00 AM after spring forward
    expect(isDue("30 2 * * *", null, now)).toBe(false);
  });

  it("DST fall-back: 1:30 fires once via lastRunAt dedup", () => {
    // During fall-back, 1:30 occurs twice. First occurrence fires:
    const firstOccurrence = new Date(2026, 10, 1, 1, 30, 0); // Nov 1, 2026 1:30 AM
    expect(isDue("30 1 * * *", null, firstOccurrence)).toBe(true);

    // Second occurrence with lastRunAt set to first — should not fire
    const lastRun = new Date(2026, 10, 1, 1, 30, 10);
    const secondOccurrence = new Date(2026, 10, 1, 1, 30, 50);
    expect(isDue("30 1 * * *", lastRun, secondOccurrence)).toBe(false);
  });
});

// ── nextRunTime ──────────────────────────────────────────────────────

describe("nextRunTime", () => {
  it("finds the next minute match", () => {
    // Every 15 minutes: */15 * * * *
    const after = new Date(2026, 2, 28, 9, 1, 0); // 9:01
    const next = nextRunTime("*/15 * * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(15);
  });

  it("rolls over to next hour", () => {
    // Every hour at :00: 0 * * * *
    const after = new Date(2026, 2, 28, 9, 30, 0); // 9:30
    const next = nextRunTime("0 * * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(10);
    expect(next!.getMinutes()).toBe(0);
  });

  it("rolls over to next day", () => {
    // Daily at 9:00: 0 9 * * *
    const after = new Date(2026, 2, 28, 10, 0, 0); // 10:00 (past today's 9:00)
    const next = nextRunTime("0 9 * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(29);
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(0);
  });

  it("finds next weekday occurrence", () => {
    // Every Monday at 10:00: 0 10 * * 1
    // March 28, 2026 is Saturday
    const after = new Date(2026, 2, 28, 12, 0, 0);
    const next = nextRunTime("0 10 * * 1", after);
    expect(next).not.toBeNull();
    // Next Monday is March 30
    expect(next!.getDate()).toBe(30);
    expect(next!.getHours()).toBe(10);
    expect(next!.getMinutes()).toBe(0);
  });

  it("starts from the next minute, not the current one", () => {
    // "0 9 * * *" — at exactly 9:00, next should be tomorrow 9:00
    const after = new Date(2026, 2, 28, 9, 0, 0);
    const next = nextRunTime("0 9 * * *", after);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(29);
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(0);
  });
});
