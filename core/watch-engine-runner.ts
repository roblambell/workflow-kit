import type {
  ExecutionContext,
  MergeStrategy,
  Orchestrator,
  OrchestratorItem,
  PollSnapshot,
} from "./orchestrator.ts";
import type { DaemonState, WorkerProgress } from "./daemon.ts";
import type { LogEntry } from "./types.ts";
import {
  mergeStrategyToPersisted,
  reviewModeToPersisted,
  type CollaborationMode,
  type ReviewMode,
} from "./tui-settings.ts";
import { saveProjectScheduleEnabled, saveUserConfig } from "./config.ts";
import type {
  InteractiveWatchTiming,
  OrchestrateLoopConfig,
  OrchestrateLoopDeps,
  OrchestrateLoopResult,
} from "./commands/orchestrate.ts";

export interface WatchEngineSnapshotEvent {
  state: DaemonState;
  pollSnapshot: PollSnapshot;
  pollIntervalMs?: number;
  interactiveTiming?: InteractiveWatchTiming;
  runtime: {
    paused: boolean;
    mergeStrategy: MergeStrategy;
    sessionLimit: number;
    reviewMode: ReviewMode;
    collaborationMode: CollaborationMode;
    scheduleEnabled: boolean;
  };
}

export type RuntimeCollaborationAction = "share" | "join" | "local";

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
  | { type: "set-session-limit"; limit: number; source?: string }
  | { type: "set-review-mode"; mode: ReviewMode; source?: string }
  | { type: "set-collaboration-mode"; mode: CollaborationMode; code?: string; source?: string }
  | { type: "set-schedule-enabled"; enabled: boolean; source?: string }
  | { type: "runtime-collaboration"; requestId: string; action: RuntimeCollaborationAction; code?: string; source?: string }
  | { type: "extend-timeout"; itemId: string; source?: string }
  | { type: "shutdown"; source?: string };

export interface RuntimeControlHandlers {
  onPauseChange?: (paused: boolean) => void;
  onStrategyChange?: (strategy: MergeStrategy) => void;
  onSessionLimitChange?: (delta: number) => void;
  onReviewChange?: (mode: ReviewMode) => void;
  onCollaborationChange?: (mode: CollaborationMode) => void;
  onScheduleEnabledChange?: (enabled: boolean) => void;
  onCollaborationLocal?: () => void | RuntimeCollaborationActionResult | Promise<void | RuntimeCollaborationActionResult>;
  onCollaborationShare?: () => void | RuntimeCollaborationActionResult | Promise<void | RuntimeCollaborationActionResult>;
  onCollaborationJoinSubmit?: (code: string) => void | RuntimeCollaborationActionResult | Promise<void | RuntimeCollaborationActionResult>;
  onExtendTimeout?: (itemId: string) => boolean;
  onShutdown?: () => void;
}

export interface RuntimeControlHandlerDeps {
  sendControl: (command: WatchEngineControlCommand) => void;
  getSessionLimit: () => number;
  getScheduleEnabled: () => boolean;
  projectRoot: string;
  saveUserConfigFn?: typeof saveUserConfig;
  saveProjectScheduleEnabledFn?: typeof saveProjectScheduleEnabled;
  requestCollaborationAction?: (request: RuntimeCollaborationActionRequest) => void | RuntimeCollaborationActionResult | Promise<void | RuntimeCollaborationActionResult>;
}

export function createRuntimeControlHandlers(
  deps: RuntimeControlHandlerDeps,
): RuntimeControlHandlers {
  const saveUserConfigFn = deps.saveUserConfigFn ?? saveUserConfig;
  const saveProjectScheduleEnabledFn = deps.saveProjectScheduleEnabledFn ?? saveProjectScheduleEnabled;

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
      }
    },
    onSessionLimitChange: (delta) => {
      const currentLimit = deps.getSessionLimit();
      const newLimit = Math.max(1, currentLimit + delta);
      if (newLimit === currentLimit) return;
      deps.sendControl({ type: "set-session-limit", limit: newLimit, source: "keyboard" });
      try {
        saveUserConfigFn({ session_limit: newLimit });
      } catch {
        // Best-effort persistence only.
      }
    },
    onReviewChange: (mode) => {
      deps.sendControl({ type: "set-review-mode", mode, source: "keyboard" });
      try {
        saveUserConfigFn({ review_mode: reviewModeToPersisted(mode) });
      } catch {
        // Best-effort persistence only.
      }
    },
    onCollaborationChange: (mode) => {
      deps.sendControl({ type: "set-collaboration-mode", mode, source: "keyboard" });
    },
    onScheduleEnabledChange: (enabled) => {
      if (enabled === deps.getScheduleEnabled()) return;
      deps.sendControl({ type: "set-schedule-enabled", enabled, source: "keyboard" });
      try {
        saveProjectScheduleEnabledFn(deps.projectRoot, enabled);
      } catch {
        // Best-effort persistence only.
      }
    },
    onCollaborationLocal: () => {
      if (deps.requestCollaborationAction) {
        return deps.requestCollaborationAction({ action: "local", source: "keyboard" });
      }
      deps.sendControl({ type: "set-collaboration-mode", mode: "local", source: "keyboard" });
      return { mode: "local" };
    },
    onCollaborationShare: () => {
      if (deps.requestCollaborationAction) {
        return deps.requestCollaborationAction({ action: "share", source: "keyboard" });
      }
      deps.sendControl({ type: "set-collaboration-mode", mode: "shared", source: "keyboard" });
      return { mode: "shared" };
    },
    onCollaborationJoinSubmit: (code) => {
      if (deps.requestCollaborationAction) {
        return deps.requestCollaborationAction({ action: "join", code, source: "keyboard" });
      }
      deps.sendControl({ type: "set-collaboration-mode", mode: "joined", code, source: "keyboard" });
      return { mode: "joined" };
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
  ) => DaemonState;
  initialReviewMode: ReviewMode;
  initialCollaborationMode: CollaborationMode;
  initialScheduleEnabled: boolean;
  getSessionLimit: () => number;
  setSessionLimit: (limit: number) => void;
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

export function createWatchEngineRunner(
  deps: WatchEngineRunnerDeps,
): WatchEngineRunner {
  let paused = false;
  let reviewMode = deps.initialReviewMode;
  let collaborationMode = deps.initialCollaborationMode;
  let scheduleEnabled = deps.initialScheduleEnabled;
  let activeAbortController: AbortController | undefined;
  let lastPollSnapshot: PollSnapshot = { items: [], readyIds: [] };
  let lastHeartbeats = new Map<string, WorkerProgress>();

  const emitLog = (entry: LogEntry) => {
    deps.emitLog(entry);
  };

  const emitSnapshot = (
    pollIntervalMs?: number,
    interactiveTiming?: InteractiveWatchTiming,
  ) => {
    deps.emitSnapshot({
      state: deps.buildState(deps.orch.getAllItems(), lastHeartbeats, lastPollSnapshot),
      pollSnapshot: lastPollSnapshot,
      ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      ...(interactiveTiming ? { interactiveTiming } : {}),
      runtime: {
        paused,
        mergeStrategy: deps.orch.config.mergeStrategy,
        sessionLimit: deps.getSessionLimit(),
        reviewMode,
        collaborationMode,
        scheduleEnabled,
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
      case "set-session-limit": {
        const currentLimit = deps.getSessionLimit();
        const newLimit = Math.max(1, command.limit);
        if (newLimit === currentLimit) return;
        deps.orch.setSessionLimit(newLimit);
        deps.setSessionLimit(newLimit);
        emitLog({
          ts: new Date().toISOString(),
          level: "info",
          event: "session_limit_changed",
          oldLimit: currentLimit,
          newLimit,
          source: command.source ?? "runtime-control",
        });
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
      case "set-schedule-enabled": {
        if (scheduleEnabled === command.enabled) return;
        scheduleEnabled = command.enabled;
        emitLog({
          ts: new Date().toISOString(),
          level: "info",
          event: "schedule_enabled_changed",
          enabled: scheduleEnabled,
          source: command.source ?? "runtime-control",
        });
        emitSnapshot();
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
      getSessionLimit: deps.getSessionLimit,
      getScheduleEnabled: () => scheduleEnabled,
      projectRoot: deps.ctx.projectRoot,
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
