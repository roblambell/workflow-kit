import type {
  ExecutionContext,
  MergeStrategy,
  Orchestrator,
  OrchestratorItem,
  PollSnapshot,
} from "./orchestrator.ts";
import type { DaemonState, WorkerProgress } from "./daemon.ts";
import type { InboxSnapshot } from "./commands/inbox.ts";
import type { LogEntry } from "./types.ts";
import {
  mergeStrategyToPersisted,
  reviewModeToPersisted,
  collaborationModeToPersisted,
  type CollaborationMode,
  type ReviewMode,
} from "./tui-settings.ts";
import { saveUserConfig, saveLocalConfig } from "./config.ts";
import type { InteractiveWatchTiming } from "./orchestrate-timing.ts";
import type {
  OrchestrateLoopConfig,
  OrchestrateLoopDeps,
  OrchestrateLoopResult,
} from "./orchestrate-event-loop.ts";

export interface WatchEngineSnapshotEvent {
  state: DaemonState;
  pollSnapshot: PollSnapshot;
  pollIntervalMs?: number;
  interactiveTiming?: InteractiveWatchTiming;
  runtime: {
    paused: boolean;
    mergeStrategy: MergeStrategy;
    maxInflight: number;
    reviewMode: ReviewMode;
    collaborationMode: CollaborationMode;
  };
}

export type RuntimeCollaborationAction = "connect" | "local";

export interface RuntimeCollaborationActionRequest {
  action: RuntimeCollaborationAction;
  code?: string;
  source?: string;
}

export interface RuntimeCollaborationActionResult {
  mode?: CollaborationMode;
  code?: string;
  error?: string;
}

export type WatchEngineControlCommand =
  | { type: "set-paused"; paused: boolean; source?: string }
  | { type: "set-merge-strategy"; strategy: MergeStrategy; source?: string }
  | { type: "set-max-inflight"; limit: number; source?: string }
  | { type: "set-review-mode"; mode: ReviewMode; source?: string }
  | { type: "set-collaboration-mode"; mode: CollaborationMode; code?: string; source?: string }
  | { type: "runtime-collaboration"; requestId: string; action: RuntimeCollaborationAction; code?: string; source?: string }
  | { type: "extend-timeout"; itemId: string; source?: string }
  | { type: "shutdown"; source?: string };

export interface RuntimeControlHandlers {
  onPauseChange?: (paused: boolean) => void;
  onStrategyChange?: (strategy: MergeStrategy) => void;
  onMaxInflightChange?: (delta: number) => void;
  onReviewChange?: (mode: ReviewMode) => void;
  onCollaborationChange?: (mode: CollaborationMode) => void;
  onCollaborationLocal?: () => void | RuntimeCollaborationActionResult | Promise<void | RuntimeCollaborationActionResult>;
  onCollaborationConnect?: () => void | RuntimeCollaborationActionResult | Promise<void | RuntimeCollaborationActionResult>;
  onExtendTimeout?: (itemId: string) => boolean;
  onShutdown?: () => void;
}

export interface RuntimeControlHandlerDeps {
  sendControl: (command: WatchEngineControlCommand) => void;
  getMaxInflight: () => number;
  saveUserConfigFn?: typeof saveUserConfig;
  saveLocalConfigFn?: typeof saveLocalConfig;
  projectRoot?: string;
  requestCollaborationAction?: (request: RuntimeCollaborationActionRequest) => void | RuntimeCollaborationActionResult | Promise<void | RuntimeCollaborationActionResult>;
}

export function createRuntimeControlHandlers(
  deps: RuntimeControlHandlerDeps,
): RuntimeControlHandlers {
  const saveUserConfigFn = deps.saveUserConfigFn ?? saveUserConfig;
  const saveLocalConfigFn = deps.saveLocalConfigFn ?? saveLocalConfig;

  const dualWriteLocal = (updates: Record<string, unknown>) => {
    if (deps.projectRoot) {
      try {
        saveLocalConfigFn(deps.projectRoot, updates);
      } catch {
        // Best-effort persistence only.
      }
    }
  };

  return {
    onPauseChange: (paused) => {
      deps.sendControl({ type: "set-paused", paused, source: "keyboard" });
    },
    onStrategyChange: (strategy) => {
      deps.sendControl({ type: "set-merge-strategy", strategy, source: "keyboard" });
      const persisted = mergeStrategyToPersisted(strategy);
      if (persisted) {
        try {
          saveUserConfigFn({ merge_strategy: persisted });
        } catch {
          // Best-effort persistence only.
        }
        dualWriteLocal({ merge_strategy: persisted });
      }
    },
    onMaxInflightChange: (delta) => {
      const currentLimit = deps.getMaxInflight();
      const newLimit = Math.max(1, currentLimit + delta);
      if (newLimit === currentLimit) return;
      deps.sendControl({ type: "set-max-inflight", limit: newLimit, source: "keyboard" });
      try {
        saveUserConfigFn({ max_inflight: newLimit });
      } catch {
        // Best-effort persistence only.
      }
    },
    onReviewChange: (mode) => {
      deps.sendControl({ type: "set-review-mode", mode, source: "keyboard" });
      const persisted = reviewModeToPersisted(mode);
      try {
        saveUserConfigFn({ review_mode: persisted });
      } catch {
        // Best-effort persistence only.
      }
      dualWriteLocal({ review_mode: persisted });
    },
    onCollaborationChange: (mode) => {
      deps.sendControl({ type: "set-collaboration-mode", mode, source: "keyboard" });
      const persisted = collaborationModeToPersisted(mode);
      try {
        saveUserConfigFn({ collaboration_mode: persisted });
      } catch {
        // Best-effort persistence only.
      }
      dualWriteLocal({ collaboration_mode: persisted });
    },
    onCollaborationLocal: () => {
      if (deps.requestCollaborationAction) {
        return deps.requestCollaborationAction({ action: "local", source: "keyboard" });
      }
      deps.sendControl({ type: "set-collaboration-mode", mode: "local", source: "keyboard" });
      return { mode: "local" };
    },
    onCollaborationConnect: () => {
      if (deps.requestCollaborationAction) {
        return deps.requestCollaborationAction({ action: "connect", source: "keyboard" });
      }
      deps.sendControl({ type: "set-collaboration-mode", mode: "connected", source: "keyboard" });
      return { mode: "connected" };
    },
    onExtendTimeout: (itemId) => {
      deps.sendControl({ type: "extend-timeout", itemId, source: "keyboard" });
      return true;
    },
    onShutdown: () => {
      deps.sendControl({ type: "shutdown", source: "keyboard" });
    },
  };
}

export interface WatchEngineRunner {
  run: (signal?: AbortSignal) => Promise<OrchestrateLoopResult>;
  sendControl: (command: WatchEngineControlCommand) => void;
  createRuntimeControlHandlers: (saveUserConfigFn?: typeof saveUserConfig) => RuntimeControlHandlers;
}

export interface WatchEngineRunnerDeps {
  orch: Orchestrator;
  ctx: ExecutionContext;
  loopDeps: Omit<OrchestrateLoopDeps, "log" | "onPollComplete">;
  loopConfig?: OrchestrateLoopConfig;
  runLoop: (
    orch: Orchestrator,
    ctx: ExecutionContext,
    deps: OrchestrateLoopDeps,
    config?: OrchestrateLoopConfig,
    signal?: AbortSignal,
  ) => Promise<OrchestrateLoopResult>;
  emitLog: (entry: LogEntry) => void;
  emitSnapshot: (event: WatchEngineSnapshotEvent) => void;
  buildState: (
    items: OrchestratorItem[],
    heartbeats: ReadonlyMap<string, WorkerProgress>,
    snapshot: PollSnapshot,
    inboxSnapshots: ReadonlyMap<string, InboxSnapshot>,
  ) => DaemonState;
  initialReviewMode: ReviewMode;
  initialCollaborationMode: CollaborationMode;
  getMaxInflight: () => number;
  setMaxInflight: (limit: number) => void;
}

function snapshotToHeartbeatMap(snapshot: PollSnapshot | undefined): Map<string, WorkerProgress> {
  const heartbeats = new Map<string, WorkerProgress>();
  if (!snapshot) return heartbeats;
  for (const item of snapshot.items) {
    if (item.lastHeartbeat) {
      heartbeats.set(item.id, item.lastHeartbeat);
    }
  }
  return heartbeats;
}

function snapshotToInboxMap(snapshot: PollSnapshot | undefined): Map<string, InboxSnapshot> {
  const inboxSnapshots = new Map<string, InboxSnapshot>();
  if (!snapshot) return inboxSnapshots;
  for (const item of snapshot.items) {
    if (item.inboxSnapshot) {
      inboxSnapshots.set(item.id, item.inboxSnapshot);
    }
  }
  return inboxSnapshots;
}

export function createWatchEngineRunner(
  deps: WatchEngineRunnerDeps,
): WatchEngineRunner {
  let paused = false;
  let reviewMode = deps.initialReviewMode;
  let collaborationMode = deps.initialCollaborationMode;
  let activeAbortController: AbortController | undefined;
  let lastPollSnapshot: PollSnapshot = { items: [], readyIds: [] };
  let lastHeartbeats = new Map<string, WorkerProgress>();
  let lastInboxSnapshots = new Map<string, InboxSnapshot>();

  const emitLog = (entry: LogEntry) => {
    deps.emitLog(entry);
  };

  const emitSnapshot = (
    pollIntervalMs?: number,
    interactiveTiming?: InteractiveWatchTiming,
  ) => {
    deps.emitSnapshot({
      state: deps.buildState(deps.orch.getAllItems(), lastHeartbeats, lastPollSnapshot, lastInboxSnapshots),
      pollSnapshot: lastPollSnapshot,
      ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      ...(interactiveTiming ? { interactiveTiming } : {}),
      runtime: {
        paused,
        mergeStrategy: deps.orch.config.mergeStrategy,
        maxInflight: deps.getMaxInflight(),
        reviewMode,
        collaborationMode,
      },
    });
  };

  const sendControl = (command: WatchEngineControlCommand) => {
    switch (command.type) {
      case "set-paused": {
        if (paused === command.paused) return;
        paused = command.paused;
        emitLog({
          ts: new Date().toISOString(),
          level: "info",
          event: "pause_state_changed",
          paused,
          source: command.source ?? "runtime-control",
        });
        return;
      }
      case "set-merge-strategy": {
        deps.orch.setMergeStrategy(command.strategy);
        return;
      }
      case "set-max-inflight": {
        const currentLimit = deps.getMaxInflight();
        const newLimit = Math.max(1, command.limit);
        if (newLimit === currentLimit) return;
        deps.orch.setMaxInflight(newLimit);
        deps.setMaxInflight(newLimit);
        emitLog({
          ts: new Date().toISOString(),
          level: "info",
          event: "max_inflight_changed",
          oldLimit: currentLimit,
          newLimit,
          source: command.source ?? "runtime-control",
        });
        emitSnapshot();
        return;
      }
      case "set-review-mode": {
        reviewMode = command.mode;
        const skip = reviewMode === "off";
        deps.orch.setSkipReview(skip);
        emitLog({
          ts: new Date().toISOString(),
          level: "info",
          event: "review_mode_changed",
          mode: reviewMode,
          skipReview: skip,
          source: command.source ?? "runtime-control",
        });
        return;
      }
      case "set-collaboration-mode": {
        collaborationMode = command.mode;
        emitLog({
          ts: new Date().toISOString(),
          level: "info",
          event: "collaboration_mode_changed",
          mode: collaborationMode,
          ...(command.code ? { code: command.code } : {}),
          source: command.source ?? "runtime-control",
        });
        return;
      }
      case "runtime-collaboration": {
        return;
      }
      case "extend-timeout": {
        const extended = deps.orch.extendTimeout(command.itemId);
        emitLog({
          ts: new Date().toISOString(),
          level: extended ? "info" : "warn",
          event: extended ? "timeout_extended" : "timeout_extend_rejected",
          itemId: command.itemId,
          source: command.source ?? "runtime-control",
        });
        if (extended) {
          emitSnapshot();
        }
        return;
      }
      case "shutdown": {
        emitLog({
          ts: new Date().toISOString(),
          level: "info",
          event: "shutdown_requested",
          source: command.source ?? "runtime-control",
        });
        activeAbortController?.abort();
        return;
      }
    }
  };

  return {
    run: async (signal) => {
      const runAbortController = new AbortController();
      activeAbortController = runAbortController;
      const forwardAbort = () => runAbortController.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });
      try {
        return await deps.runLoop(
          deps.orch,
          deps.ctx,
          {
            ...deps.loopDeps,
            log: emitLog,
            onPollComplete: (items, snapshot, pollIntervalMs, interactiveTiming) => {
              lastPollSnapshot = snapshot;
              lastHeartbeats = snapshotToHeartbeatMap(snapshot);
              lastInboxSnapshots = snapshotToInboxMap(snapshot);
              emitSnapshot(pollIntervalMs, interactiveTiming);
            },
          },
          deps.loopConfig,
          runAbortController.signal,
        );
      } finally {
        signal?.removeEventListener("abort", forwardAbort);
        if (activeAbortController === runAbortController) {
          activeAbortController = undefined;
        }
      }
    },
    sendControl,
    createRuntimeControlHandlers: (saveUserConfigFn) => createRuntimeControlHandlers({
      sendControl,
      getMaxInflight: deps.getMaxInflight,
      ...(saveUserConfigFn ? { saveUserConfigFn } : {}),
    }),
  };
}

export function createDetachedDaemonEngineRunner(
  deps: WatchEngineRunnerDeps,
  createRunner: (deps: WatchEngineRunnerDeps) => WatchEngineRunner = createWatchEngineRunner,
): WatchEngineRunner {
  return createRunner(deps);
}

export function createInteractiveChildEngineRunner(
  deps: WatchEngineRunnerDeps,
  createRunner: (deps: WatchEngineRunnerDeps) => WatchEngineRunner = createWatchEngineRunner,
): WatchEngineRunner {
  return createRunner(deps);
}
