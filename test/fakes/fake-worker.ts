// Script-driven worker simulator for scenario tests.
// Given a sequence of timed events, drives FakeMux screen content and
// FakeGitHub PR state changes on a per-cycle schedule by hooking into
// the orchestrateLoop sleep function.

import type { FakeGitHub, FakePR } from "./fake-github.ts";
import type { FakeMux } from "./fake-mux.ts";
import type { Orchestrator } from "../../core/orchestrator.ts";

// ── Event types ────────────────────────────────────────────────────

export interface SetScreenEvent {
  type: "setScreen";
  ref: string;
  content: string;
}

export interface CreatePREvent {
  type: "createPR";
  branch: string;
  title: string;
}

export interface SetCIStatusEvent {
  type: "setCIStatus";
  branch: string;
  status: FakePR["ciStatus"];
}

export interface SetReviewDecisionEvent {
  type: "setReviewDecision";
  branch: string;
  decision: FakePR["reviewDecision"];
}

export interface SetMergeableEvent {
  type: "setMergeable";
  branch: string;
  mergeable: FakePR["mergeable"];
}

export interface MarkReviewCompletedEvent {
  type: "markReviewCompleted";
  itemId: string;
}

export type WorkerEvent =
  | SetScreenEvent
  | CreatePREvent
  | SetCIStatusEvent
  | SetReviewDecisionEvent
  | SetMergeableEvent
  | MarkReviewCompletedEvent;

/** A script entry: fire one or more events at a specific cycle. */
export interface ScriptEntry {
  cycle: number;
  events: WorkerEvent[];
}

// ── FakeWorker ─────────────────────────────────────────────────────

/**
 * Script-driven worker simulator.
 *
 * Usage:
 *   const worker = new FakeWorker(fakeGh, fakeMux, orch, script);
 *   loopDeps.sleep = worker.sleep;
 *
 * The worker increments an internal cycle counter each time sleep() is
 * called and executes any events scheduled for that cycle.
 */
export class FakeWorker {
  private cycle = 0;
  /** Events grouped by cycle for O(1) lookup. */
  private readonly schedule: Map<number, WorkerEvent[]>;
  /** Cycles at which events were actually fired (for test assertions). */
  readonly firedAt: number[] = [];

  constructor(
    private readonly github: FakeGitHub,
    private readonly mux: FakeMux,
    private readonly orch: Orchestrator | null,
    script: ScriptEntry[],
  ) {
    this.schedule = new Map();
    for (const entry of script) {
      const existing = this.schedule.get(entry.cycle);
      if (existing) {
        existing.push(...entry.events);
      } else {
        this.schedule.set(entry.cycle, [...entry.events]);
      }
    }
  }

  /** Drop-in replacement for OrchestrateLoopDeps.sleep. */
  sleep = async (_ms?: number): Promise<void> => {
    this.cycle++;
    const events = this.schedule.get(this.cycle);
    if (!events) return;
    this.firedAt.push(this.cycle);
    for (const event of events) {
      this.executeEvent(event);
    }
  };

  /** Current cycle count (for test assertions). */
  get currentCycle(): number {
    return this.cycle;
  }

  private executeEvent(event: WorkerEvent): void {
    switch (event.type) {
      case "setScreen":
        this.mux.setScreen(event.ref, event.content);
        break;
      case "createPR":
        this.github.createPR(event.branch, event.title);
        break;
      case "setCIStatus":
        this.github.setCIStatus(event.branch, event.status);
        break;
      case "setReviewDecision":
        this.github.setReviewDecision(event.branch, event.decision);
        break;
      case "setMergeable":
        this.github.setMergeable(event.branch, event.mergeable);
        break;
      case "markReviewCompleted": {
        const orchItem = this.orch?.getItem(event.itemId);
        if (orchItem) orchItem.reviewCompleted = true;
        break;
      }
    }
  }
}
