// Tests for StateDataMap and getStateData() typed accessor.

import { describe, it, expect } from "vitest";
import {
  type OrchestratorItem,
  type ImplementingStateData,
  type CiPendingStateData,
  type CiFailedStateData,
  type RebasingStateData,
  getStateData,
} from "../core/orchestrator-types.ts";

function makeItem(overrides: Partial<OrchestratorItem> = {}): OrchestratorItem {
  return {
    id: "T-1",
    workItem: {
      id: "T-1",
      title: "test",
      priority: "medium" as const,
      source: "test",
      domain: "test",
      lineage: "test-lineage",
    },
    state: "queued",
    lastTransition: new Date().toISOString(),
    ciFailCount: 0,
    retryCount: 0,
    ...overrides,
  };
}

// ── getStateData runtime guard ──────────────────────────────────────

describe("getStateData", () => {
  it("returns undefined when item.state does not match requested state", () => {
    const item = makeItem({ state: "queued" });
    expect(getStateData(item, "implementing")).toBeUndefined();
    expect(getStateData(item, "ci-pending")).toBeUndefined();
    expect(getStateData(item, "ci-failed")).toBeUndefined();
    expect(getStateData(item, "rebasing")).toBeUndefined();
  });

  it("returns undefined for each state when another state is active", () => {
    const item = makeItem({ state: "ci-pending" });
    expect(getStateData(item, "implementing")).toBeUndefined();
    expect(getStateData(item, "ci-failed")).toBeUndefined();
    expect(getStateData(item, "rebasing")).toBeUndefined();
    // But the matching state returns data
    expect(getStateData(item, "ci-pending")).toBeDefined();
  });

  // ── implementing ──────────────────────────────────────────────────

  describe("implementing", () => {
    it("returns typed data when state matches", () => {
      const item = makeItem({
        state: "implementing",
        workspaceRef: "workspace:1",
        worktreePath: "/tmp/wt",
        startedAt: "2026-01-01T00:00:00Z",
        lastAliveAt: "2026-01-01T00:01:00Z",
        notAliveCount: 2,
      });
      const sd = getStateData(item, "implementing");
      expect(sd).toBeDefined();
      const data = sd as ImplementingStateData;
      expect(data.workspaceRef).toBe("workspace:1");
      expect(data.worktreePath).toBe("/tmp/wt");
      expect(data.startedAt).toBe("2026-01-01T00:00:00Z");
      expect(data.lastAliveAt).toBe("2026-01-01T00:01:00Z");
      expect(data.notAliveCount).toBe(2);
    });

    it("defaults notAliveCount to 0 when undefined", () => {
      const item = makeItem({
        state: "implementing",
        workspaceRef: "ws",
        worktreePath: "/wt",
        startedAt: "2026-01-01T00:00:00Z",
      });
      const sd = getStateData(item, "implementing");
      expect(sd).toBeDefined();
      expect(sd!.notAliveCount).toBe(0);
    });

    it("allows lastAliveAt to be undefined", () => {
      const item = makeItem({
        state: "implementing",
        workspaceRef: "ws",
        worktreePath: "/wt",
        startedAt: "2026-01-01T00:00:00Z",
      });
      const sd = getStateData(item, "implementing");
      expect(sd).toBeDefined();
      expect(sd!.lastAliveAt).toBeUndefined();
    });
  });

  // ── ci-pending ────────────────────────────────────────────────────

  describe("ci-pending", () => {
    it("returns typed data when state matches", () => {
      const item = makeItem({
        state: "ci-pending",
        ciPendingSince: "2026-01-01T00:00:00Z",
        workspaceRef: "workspace:2",
        worktreePath: "/tmp/wt2",
      });
      const sd = getStateData(item, "ci-pending");
      expect(sd).toBeDefined();
      const data = sd as CiPendingStateData;
      expect(data.ciPendingSince).toBe("2026-01-01T00:00:00Z");
      expect(data.workspaceRef).toBe("workspace:2");
      expect(data.worktreePath).toBe("/tmp/wt2");
    });

    it("allows all fields to be undefined", () => {
      const item = makeItem({ state: "ci-pending" });
      const sd = getStateData(item, "ci-pending");
      expect(sd).toBeDefined();
      expect(sd!.ciPendingSince).toBeUndefined();
      expect(sd!.workspaceRef).toBeUndefined();
      expect(sd!.worktreePath).toBeUndefined();
    });
  });

  // ── ci-failed ─────────────────────────────────────────────────────

  describe("ci-failed", () => {
    it("returns typed data when state matches", () => {
      const item = makeItem({
        state: "ci-failed",
        ciFailureNotified: true,
        ciFailureNotifiedAt: "2026-01-01T00:00:00Z",
        ciNotifyWallAt: "2026-01-01T00:01:00Z",
        failureReason: "ci-failed: test timeout",
        needsCiFix: true,
      });
      const sd = getStateData(item, "ci-failed");
      expect(sd).toBeDefined();
      const data = sd as CiFailedStateData;
      expect(data.ciFailureNotified).toBe(true);
      expect(data.ciFailureNotifiedAt).toBe("2026-01-01T00:00:00Z");
      expect(data.ciNotifyWallAt).toBe("2026-01-01T00:01:00Z");
      expect(data.failureReason).toBe("ci-failed: test timeout");
      expect(data.needsCiFix).toBe(true);
    });

    it("defaults ciFailureNotified to false and ciFailureNotifiedAt to null", () => {
      const item = makeItem({ state: "ci-failed" });
      const sd = getStateData(item, "ci-failed");
      expect(sd).toBeDefined();
      expect(sd!.ciFailureNotified).toBe(false);
      expect(sd!.ciFailureNotifiedAt).toBeNull();
    });

    it("defaults failureReason to empty string when undefined", () => {
      const item = makeItem({ state: "ci-failed" });
      const sd = getStateData(item, "ci-failed");
      expect(sd).toBeDefined();
      expect(sd!.failureReason).toBe("");
    });

    it("preserves ciFailureNotifiedAt as null when explicitly set", () => {
      const item = makeItem({
        state: "ci-failed",
        ciFailureNotifiedAt: null,
      });
      const sd = getStateData(item, "ci-failed");
      expect(sd).toBeDefined();
      expect(sd!.ciFailureNotifiedAt).toBeNull();
    });
  });

  // ── rebasing ──────────────────────────────────────────────────────

  describe("rebasing", () => {
    it("returns typed data when state matches", () => {
      const item = makeItem({
        state: "rebasing",
        rebaserWorkspaceRef: "workspace:rebaser",
        rebaseAttemptCount: 2,
        rebaseRequested: true,
      });
      const sd = getStateData(item, "rebasing");
      expect(sd).toBeDefined();
      const data = sd as RebasingStateData;
      expect(data.rebaserWorkspaceRef).toBe("workspace:rebaser");
      expect(data.rebaseAttemptCount).toBe(2);
      expect(data.rebaseRequested).toBe(true);
    });

    it("defaults rebaseAttemptCount to 0 and rebaseRequested to false", () => {
      const item = makeItem({ state: "rebasing" });
      const sd = getStateData(item, "rebasing");
      expect(sd).toBeDefined();
      expect(sd!.rebaseAttemptCount).toBe(0);
      expect(sd!.rebaseRequested).toBe(false);
    });

    it("allows rebaserWorkspaceRef to be undefined", () => {
      const item = makeItem({ state: "rebasing" });
      const sd = getStateData(item, "rebasing");
      expect(sd).toBeDefined();
      expect(sd!.rebaserWorkspaceRef).toBeUndefined();
    });
  });

  // ── field alignment with OrchestratorItem ─────────────────────────

  describe("field alignment", () => {
    it("implementing fields match OrchestratorItem shape", () => {
      const item = makeItem({
        state: "implementing",
        workspaceRef: "ws",
        worktreePath: "/wt",
        startedAt: "2026-01-01T00:00:00Z",
        lastAliveAt: "2026-01-01T00:01:00Z",
        notAliveCount: 3,
      });
      const sd = getStateData(item, "implementing")!;
      expect(sd.workspaceRef).toBe(item.workspaceRef);
      expect(sd.worktreePath).toBe(item.worktreePath);
      expect(sd.startedAt).toBe(item.startedAt);
      expect(sd.lastAliveAt).toBe(item.lastAliveAt);
      expect(sd.notAliveCount).toBe(item.notAliveCount);
    });

    it("ci-pending fields match OrchestratorItem shape", () => {
      const item = makeItem({
        state: "ci-pending",
        ciPendingSince: "2026-01-01T00:00:00Z",
        workspaceRef: "ws",
        worktreePath: "/wt",
      });
      const sd = getStateData(item, "ci-pending")!;
      expect(sd.ciPendingSince).toBe(item.ciPendingSince);
      expect(sd.workspaceRef).toBe(item.workspaceRef);
      expect(sd.worktreePath).toBe(item.worktreePath);
    });

    it("ci-failed fields match OrchestratorItem shape", () => {
      const item = makeItem({
        state: "ci-failed",
        ciFailureNotified: true,
        ciFailureNotifiedAt: "2026-01-01T00:00:00Z",
        ciNotifyWallAt: "2026-01-01T00:01:00Z",
        failureReason: "ci-failed: test",
        needsCiFix: false,
      });
      const sd = getStateData(item, "ci-failed")!;
      expect(sd.ciFailureNotified).toBe(item.ciFailureNotified);
      expect(sd.ciFailureNotifiedAt).toBe(item.ciFailureNotifiedAt);
      expect(sd.ciNotifyWallAt).toBe(item.ciNotifyWallAt);
      expect(sd.failureReason).toBe(item.failureReason);
      expect(sd.needsCiFix).toBe(item.needsCiFix);
    });

    it("rebasing fields match OrchestratorItem shape", () => {
      const item = makeItem({
        state: "rebasing",
        rebaserWorkspaceRef: "ws:rebaser",
        rebaseAttemptCount: 1,
        rebaseRequested: true,
      });
      const sd = getStateData(item, "rebasing")!;
      expect(sd.rebaserWorkspaceRef).toBe(item.rebaserWorkspaceRef);
      expect(sd.rebaseAttemptCount).toBe(item.rebaseAttemptCount);
      expect(sd.rebaseRequested).toBe(item.rebaseRequested);
    });
  });
});
