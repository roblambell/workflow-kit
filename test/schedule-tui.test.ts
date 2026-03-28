// Tests for schedule worker TUI display in status-render.ts.

import { describe, it, expect } from "vitest";
import {
  formatScheduleWorkerLine,
  buildStatusLayout,
  type ScheduleWorkerInfo,
  type StatusItem,
} from "../core/status-render.ts";

// ── formatScheduleWorkerLine ─────────────────────────────────────────

describe("formatScheduleWorkerLine", () => {
  it("shows task id and running duration", () => {
    const now = new Date("2026-03-28T10:02:14Z");
    const worker: ScheduleWorkerInfo = {
      taskId: "daily-tests",
      startedAt: "2026-03-28T10:00:00Z",
    };

    const line = formatScheduleWorkerLine(worker, now);

    expect(line).toContain("[sched]");
    expect(line).toContain("daily-tests");
    expect(line).toContain("running");
    expect(line).toContain("2m");
  });

  it("shows <1m for very recent workers", () => {
    const now = new Date("2026-03-28T10:00:30Z");
    const worker: ScheduleWorkerInfo = {
      taskId: "quick-task",
      startedAt: "2026-03-28T10:00:15Z",
    };

    const line = formatScheduleWorkerLine(worker, now);
    expect(line).toContain("<1m");
  });
});

// ── buildStatusLayout with schedule workers ──────────────────────────

describe("buildStatusLayout with scheduleWorkers", () => {
  function makeItem(overrides: Partial<StatusItem> = {}): StatusItem {
    return {
      id: "H-TEST-1",
      title: "Test Item",
      state: "implementing",
      prNumber: null,
      ageMs: 60_000,
      repoLabel: "",
      ...overrides,
    };
  }

  it("includes schedule worker lines when scheduleWorkers present", () => {
    const items = [makeItem()];
    const layout = buildStatusLayout(items, 80, undefined, false, {
      scheduleWorkers: [
        { taskId: "daily-tests", startedAt: new Date(Date.now() - 134_000).toISOString() },
      ],
    });

    // Check that schedule worker line appears in item lines
    const allText = layout.itemLines.join("\n");
    expect(allText).toContain("[sched]");
    expect(allText).toContain("daily-tests");
    expect(allText).toContain("running");
  });

  it("does not include schedule lines when no workers active", () => {
    const items = [makeItem()];
    const layout = buildStatusLayout(items, 80, undefined, false, {
      scheduleWorkers: [],
    });

    const allText = layout.itemLines.join("\n");
    expect(allText).not.toContain("[sched]");
  });

  it("shows multiple schedule workers", () => {
    const items = [makeItem()];
    const layout = buildStatusLayout(items, 80, undefined, false, {
      scheduleWorkers: [
        { taskId: "daily-tests", startedAt: new Date(Date.now() - 60_000).toISOString() },
        { taskId: "weekly-report", startedAt: new Date(Date.now() - 300_000).toISOString() },
      ],
    });

    const allText = layout.itemLines.join("\n");
    expect(allText).toContain("daily-tests");
    expect(allText).toContain("weekly-report");
  });
});
