// orchestrate command: event loop for parallel work item processing.
// Parses args, reconstructs state from disk/GitHub, runs the poll→transition→execute loop,
// emits structured JSON logs, and handles graceful SIGINT/SIGTERM shutdown.
// Supports daemon mode (--daemon) for background operation with state persistence.

import { existsSync, mkdirSync, readdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { totalmem, freemem, hostname } from "os";
import { randomUUID } from "crypto";
import { execSync, spawn } from "node:child_process";
import { getAvailableMemory } from "../memory.ts";
import {
  Orchestrator,
  DEFAULT_CONFIG,
  RESTART_RECOVERY_HOLD_REASON,
  calculateMemorySessionLimit,
  statusDisplayForState,
  TERMINAL_STATES,
  type Action,
  type MergeStrategy,
  type PollSnapshot,
  type ItemSnapshot,
  type ExecutionContext,
  type OrchestratorDeps,
  type OrchestratorItem,
  type OrchestratorItemState,
} from "../orchestrator.ts";
import { parseWorkItems } from "../parser.ts";
import { scanExternalPRs } from "./pr-monitor.ts";
import { launchSingleItem, launchReviewWorker, launchRebaserWorker, launchForwardFixerWorker, validatePickupCandidate } from "./launch.ts";
import { cleanStaleBranchForReuse } from "../branch-cleanup.ts";
import { selectAiTools, detectInstalledAITools, validateAgentFiles } from "../tool-select.ts";
import { cleanSingleWorktree } from "./clean.ts";
import { writeInbox, type InboxSnapshot } from "./inbox.ts";
import { prMerge, prComment, addCommentReaction, checkPrMergeable, isPrBlocked, getRepoOwner, applyGithubToken, fetchTrustedPrCommentsAsync, upsertOrchestratorComment, setCommitStatus as ghSetCommitStatus, prHeadSha, getMergeCommitSha as ghGetMergeCommitSha, checkCommitCI as ghCheckCommitCI, checkCommitCIAsync as ghCheckCommitCIAsync, getDefaultBranch as ghGetDefaultBranch, ensureDomainLabels, listPrComments, updatePrComment, ghFailureKindLabel, getPrBaseBranch as ghGetPrBaseBranch, getPrBaseAndState as ghGetPrBaseAndState, retargetPrBase as ghRetargetPrBase, queryRateLimitAsync as ghQueryRateLimitAsync } from "../gh.ts";
import { fetchOrigin, ffMerge, gitAdd, gitCommit, gitPush, daemonRebase, rebaseOnto, forcePush, resolveRef, autoSaveWorktree } from "../git.ts";
import { run } from "../shell.ts";
import { type Multiplexer, createMux, muxTypeForWorkspaceRef, resolveBackend } from "../mux.ts";
import { resolveSessionName } from "../tmux.ts";
import { reconcile, completeMergedWorkItemCleanup } from "./reconcile.ts";
import { die, warn, info, ALT_SCREEN_ON, ALT_SCREEN_OFF } from "../output.ts";
import {
  confirmPrompt,
  promptRestartRecoveryAction,
  type RestartRecoveryAction,
  type RestartRecoveryPromptFn,
} from "../prompt.ts";
import {
  shouldEnterInteractive,
  runInteractiveFlow,
  buildStartupPersistenceUpdates,
} from "../interactive.ts";
import type { WorkItem, LogEntry } from "../types.ts";
import {
  loadConfig,
  loadUserConfig,
  saveConfig,
  saveUserConfig,
} from "../config.ts";
import type { ProjectConfig, UserConfig } from "../config.ts";
import {
  collaborationIntentFromMode,
  persistedCollaborationModeToRuntime,
  resolveTuiSettingsDefaults,
  type TuiSettingsDefaults,
} from "../tui-settings.ts";
import { preflight } from "../preflight.ts";
import {
  collectRunMetrics,
  parseWorkerTelemetry,
} from "../analytics.ts";
import { getBundleDir } from "../paths.ts";
import {
  writePidFile,
  cleanPidFile,
  cleanStateFile,
  isDaemonRunning,
  serializeOrchestratorState,
  writeStateFile,
  readStateFile,
  readExternalReviews,
  writeExternalReviews,
  forkDaemon,
  logFilePath,
  stateFilePath,
  userStateDir,
  migrateRuntimeState,
  readLayoutPreference,
  writeLayoutPreference,
   type DaemonState,
   type DaemonStateItem,
  type DaemonCrewStatus,
  type ExternalReviewItem,
  type WorkerProgress,
} from "../daemon.ts";
import type { TokenUsage } from "../crew.ts";
import {
  daemonStateToStatusItems,
  getTerminalWidth,
  getTerminalHeight,
  type StatusItem,
  type StartupOverlayState,
  type ViewOptions,
  type PanelMode,
  type LogEntry as PanelLogEntry,
} from "../status-render.ts";
import type { CrewBroker, CrewRemoteItemSnapshot, CrewStatus, SyncItem } from "../crew.ts";
import { resolveOperatorId } from "../crew.ts";
import { loadDiscoveryStartupItems } from "../startup-items.ts";
import { resolveCliRespawnCommand } from "../cli-spawn.ts";
import { RequestQueue } from "../request-queue.ts";
// ── Extracted subsystems ─────────────────────────────────────────────
import {
  buildSnapshot as _buildSnapshot,
  buildSnapshotAsync,
  isWorkerAlive,
  isWorkerAliveWithCache,
  getWorktreeLastCommitTime,
  getWorktreeLastCommitTimeAsync,
} from "../snapshot.ts";
import { reconstructState } from "../reconstruct.ts";
import { parseWatchArgs, validateItemIds, type ParsedWatchArgs } from "./watch-args.ts";
import {
  setupKeyboardShortcuts,
  applyRuntimeSnapshotToTuiState,
  isTuiPaused,
  filterLogsByLevel,
  pushLogBuffer,
  applyLogFollowMode,
  LOG_BUFFER_MAX,
  LOG_LEVEL_CYCLE,
  type TuiState,
  type LogLevelFilter,
} from "../tui-keyboard.ts";
import { processExternalReviews, type ExternalReviewDeps } from "../external-review.ts";
import { syncStackComments as syncStackCommentsForRepo } from "../stack-comments.ts";
import {
  createWatchEngineRunner,
  createDetachedDaemonEngineRunner,
  createInteractiveChildEngineRunner,
  createRuntimeControlHandlers,
  type RuntimeCollaborationActionRequest,
  type RuntimeCollaborationActionResult,
  type WatchEngineControlCommand,
  type WatchEngineSnapshotEvent,
} from "../watch-engine-runner.ts";
import {
  createEventLoopLagSampler,
  createInteractiveWatchTiming,
  elapsedMs,
  finalizeInteractiveWatchTiming,
  type InteractiveWatchTiming,
  type EventLoopLagSampler,
} from "../orchestrate-timing.ts";
import {
  completionSummaryState,
  formatExitSummary,
  formatCompletionBanner,
  waitForCompletionKey,
  waitForEngineRecoveryKey,
  type CompletionSummaryItem,
  type CompletionAction,
  type EngineRecoveryAction,
} from "../orchestrate-completion.ts";
import {
  DEFAULT_CREW_URL,
  resolveConfiguredCrewUrl,
  resolveStartupCollaborationAction,
  resolveCrewSocketUrl,
  createCrewCode,
  createCrewBrokerInstance,
  applyRuntimeCollaborationAction,
  type CollaborationSessionState,
  type CollaborationSessionBrokerInfo,
  type ApplyRuntimeCollaborationActionDeps,
} from "../orchestrate-crew.ts";
import {
  readVersion,
  crewStatusToRemoteItemSnapshots,
  crewStatusToDaemonCrewStatus,
  crewStatusToRemoteOwnedItemIds,
  filterCrewRemoteWriteActions,
  orchestratorItemsToStatusItems,
  muxForWorkspaceRef,
  getVisibleSelectableItemIds,
  normalizeSelectedItemId,
  prepareStatusSelection,
  syncStatusLayout,
  renderEngineRecoveryOverlay,
  resolveActiveTuiOverlay,
  renderTuiPanelFrameFromStatusItems,
  renderTuiFrame,
  renderTuiPanelFrame,
  daemonStateToDetailSnapshots,
  runTUI,
  bootstrapTuiUpdateNotice,
  type RemoteItemRenderState,
  type TuiDetailSnapshot,
  type ActiveTuiOverlay,
  type RunTUIOptions,
  type BootstrapTuiUpdateNoticeDeps,
} from "../orchestrate-tui-render.ts";
// ── Re-exports for backward compatibility ────────────────────────────
// These keep existing importers (tests, other modules) working without changes.
export { buildSnapshotAsync, isWorkerAlive, isWorkerAliveWithCache, getWorktreeLastCommitTime, getWorktreeLastCommitTimeAsync, stateToPollingPriority } from "../snapshot.ts";
export { buildSnapshot } from "../snapshot.ts";
export { reconstructState } from "../reconstruct.ts";
export {
  diffStartupItemIds,
  loadDiscoveryStartupItems,
  loadLocalStartupItems,
  pruneMergedStartupReplayItems,
  pruneMergedStartupReplayItemsAsync,
  refreshRunnableStartupItems,
  type StartupReplayPrune,
  type StartupReplayPruneResult,
  type StartupItemIdDiff,
  type StartupItemsRefreshChange,
  type StartupItemsRefreshResult,
} from "../startup-items.ts";
export { parseWatchArgs, validateItemIds, type ParsedWatchArgs } from "./watch-args.ts";
export { setupKeyboardShortcuts, applyRuntimeSnapshotToTuiState, isTuiPaused, filterLogsByLevel, pushLogBuffer, applyLogFollowMode, LOG_BUFFER_MAX, REVIEW_MODE_CYCLE, COLLABORATION_MODE_CYCLE, type TuiState, type TuiRuntimeSnapshot, type LogLevelFilter, type CollaborationMode, type ReviewMode } from "../tui-keyboard.ts";
export { processExternalReviews, type ExternalReviewDeps } from "../external-review.ts";
export { forkDaemon } from "../daemon.ts";
export {
  createWatchEngineRunner,
  createDetachedDaemonEngineRunner,
  createInteractiveChildEngineRunner,
  createRuntimeControlHandlers,
  type WatchEngineSnapshotEvent,
  type WatchEngineControlCommand,
  type WatchEngineRunner,
} from "../watch-engine-runner.ts";

export { RESTART_RECOVERY_HOLD_REASON } from "../orchestrator-types.ts";
// ── Re-exports: orchestrate-timing ───────────────────────────────────
export {
  INTERACTIVE_WATCH_STAGE_WARN_MS,
  createEventLoopLagSampler,
  createInteractiveWatchTiming,
  elapsedMs,
  finalizeInteractiveWatchTiming,
  type InteractiveWatchStageName,
  type InteractiveWatchTimingsMs,
  type InteractiveWatchTiming,
  type EventLoopLagSnapshot,
  type EventLoopLagSamplerDeps,
  type EventLoopLagSampler,
} from "../orchestrate-timing.ts";
// ── Re-exports: orchestrate-completion ───────────────────────────────
export {
  completionSummaryState,
  formatExitSummary,
  formatCompletionBanner,
  waitForCompletionKey,
  waitForEngineRecoveryKey,
  type CompletionSummaryItem,
  type CompletionAction,
  type EngineRecoveryAction,
} from "../orchestrate-completion.ts";
// ── Re-exports: orchestrate-crew ────────────────────────────────────
export {
  DEFAULT_CREW_URL,
  resolveConfiguredCrewUrl,
  resolveStartupCollaborationAction,
  resolveCrewSocketUrl,
  resolveCrewHttpUrl,
  buildCrewRepoReferencePayload,
  createCrewCode,
  createCrewBrokerInstance,
  applyRuntimeCollaborationAction,
  type CollaborationSessionState,
  type CollaborationSessionBrokerInfo,
  type ApplyRuntimeCollaborationActionDeps,
} from "../orchestrate-crew.ts";
// ── Re-exports: orchestrate-tui-render ──────────────────────────────
export {
  readVersion,
  crewStatusToRemoteItemSnapshots,
  crewStatusToDaemonCrewStatus,
  crewStatusToRemoteOwnedItemIds,
  filterCrewRemoteWriteActions,
  orchestratorItemsToStatusItems,
  muxForWorkspaceRef,
  getVisibleSelectableItemIds,
  normalizeSelectedItemId,
  prepareStatusSelection,
  syncStatusLayout,
  renderEngineRecoveryOverlay,
  resolveActiveTuiOverlay,
  renderTuiPanelFrameFromStatusItems,
  renderTuiFrame,
  renderTuiPanelFrame,
  daemonStateToDetailSnapshots,
  runTUI,
  bootstrapTuiUpdateNotice,
  type RemoteItemRenderState,
  type TuiDetailSnapshot,
  type ActiveTuiOverlay,
  type RunTUIOptions,
  type BootstrapTuiUpdateNoticeDeps,
} from "../orchestrate-tui-render.ts";
import {
  syncWorkerDisplay,
  adaptivePollInterval,
  cleanOrphanedWorktrees,
  interruptibleSleep,
  orchestrateLoop,
  buildSessionEndedMetadata,
  computeDefaultSessionLimit,
  listWorktreeIds,
  listOpenItemIds,
  type CleanOrphanedDeps,
  type OrchestrateLoopDeps,
  type OrchestrateLoopConfig,
  type OrchestrateLoopResult,
} from "../orchestrate-event-loop.ts";
// ── Re-exports: orchestrate-event-loop ──────────────────────────────
export {
  syncWorkerDisplay,
  adaptivePollInterval,
  cleanOrphanedWorktrees,
  interruptibleSleep,
  orchestrateLoop,
  buildSessionEndedMetadata,
  computeDefaultSessionLimit,
  listWorktreeIds,
  listOpenItemIds,
  getAvailableMemory,
  type CleanOrphanedDeps,
  type OrchestrateLoopDeps,
  type OrchestrateLoopConfig,
  type OrchestrateLoopResult,
} from "../orchestrate-event-loop.ts";

interface ResolveRestartRecoveryOptions {
  interactive: boolean;
  log: (entry: LogEntry) => void;
  prompt?: RestartRecoveryPromptFn;
  now?: () => Date;
}

export async function resolveUnresolvedRestartedWorkers(
  orch: Orchestrator,
  unresolvedImplementations: Array<{
    itemId: string;
    worktreePath: string;
    savedWorkspaceRef?: string;
  }>,
  options: ResolveRestartRecoveryOptions,
): Promise<void> {
  const prompt = options.prompt ?? promptRestartRecoveryAction;
  const now = options.now ?? (() => new Date());

  for (const unresolved of unresolvedImplementations) {
    const item = orch.getItem(unresolved.itemId);
    if (!item) continue;

    item.workspaceRef = undefined;
    const timestamp = now().toISOString();

    let action: RestartRecoveryAction = "relaunch";
    if (options.interactive) {
      action = await prompt(unresolved.itemId, unresolved.worktreePath);
    }

    if (action === "relaunch") {
      item.failureReason = undefined;
      item.endedAt = undefined;
      orch.hydrateState(unresolved.itemId, "ready");
      options.log({
        ts: timestamp,
        level: "warn",
        event: "restart_recovery_unresolved_worker",
        itemId: unresolved.itemId,
        worktreePath: unresolved.worktreePath,
        ...(unresolved.savedWorkspaceRef ? { savedWorkspaceRef: unresolved.savedWorkspaceRef } : {}),
        message: `No live workspace found for ${unresolved.itemId}; relaunching from existing worktree`,
      });
      continue;
    }

    item.failureReason = RESTART_RECOVERY_HOLD_REASON;
    item.endedAt = timestamp;
    orch.hydrateState(unresolved.itemId, "blocked");
    options.log({
      ts: timestamp,
      level: "warn",
      event: "restart_recovery_held_worker",
      itemId: unresolved.itemId,
      worktreePath: unresolved.worktreePath,
      interactive: options.interactive,
      ...(unresolved.savedWorkspaceRef ? { savedWorkspaceRef: unresolved.savedWorkspaceRef } : {}),
      message: options.interactive
        ? `No live workspace found for ${unresolved.itemId}; operator chose to hold restart recovery`
        : `No live workspace found for ${unresolved.itemId}; holding for operator relaunch`,
    });
  }
}
export type { LogEntry } from "../types.ts";

// ── Structured logging ─────────────────────────────────────────────

export function structuredLog(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

export interface TmuxStartupInfo {
  sessionName: string;
  outsideTmuxSession: boolean;
  attachHintLines: string[];
}

/** Build startup metadata and attach hints for tmux-backed orchestration. */
export function getTmuxStartupInfo(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
  runner: typeof run = run,
): TmuxStartupInfo {
  const sessionName = resolveSessionName({
    runner,
    env,
    cwd: () => projectRoot,
  });
  const outsideTmuxSession = !env.TMUX;

  if (!outsideTmuxSession) {
    return {
      sessionName,
      outsideTmuxSession,
      attachHintLines: [],
    };
  }

  const attachCommand = `tmux attach -t ${sessionName}`;
  const attachHintLines = env.TERM_PROGRAM === "iTerm.app"
    ? [
        `Tmux session ready: ${sessionName}`,
        `iTerm2: open a new tab or split pane and run: ${attachCommand}`,
      ]
    : [
        `Tmux session ready: ${sessionName}`,
        `Attach with: ${attachCommand}`,
      ];

  return {
    sessionName,
    outsideTmuxSession,
    attachHintLines,
  };
}

export interface InteractiveStartupConfig {
  defaults: TuiSettingsDefaults;
  savedToolIds?: string[];
}

export function resolveInteractiveStartupConfig(
  _projectConfig: ProjectConfig,
  userConfig: UserConfig,
  _projectRoot: string,
  toolOverride?: string,
): InteractiveStartupConfig {
  return {
    defaults: resolveTuiSettingsDefaults(userConfig),
    savedToolIds: userConfig.ai_tools,
  };
}

// Timing types and functions extracted to core/orchestrate-timing.ts
// ── TUI mode helpers ────────────────────────────────────────────────

/**
 * Determine if TUI mode should be active.
 * TUI mode renders a live status table on stdout instead of JSON log lines.
 * Enabled when: stdout is a TTY, not a daemon child process, and --json not set.
 */
export function detectTuiMode(isDaemonChild: boolean, jsonFlag: boolean, isTTY: boolean): boolean {
  return !isDaemonChild && !jsonFlag && isTTY;
}

export interface InteractiveEngineTransportRuntime {
  paused: boolean;
  mergeStrategy: MergeStrategy;
  sessionLimit: number;
  reviewMode: "off" | "on";
  collaborationMode: "local" | "shared" | "joined";
}

export const INTERACTIVE_STARTUP_OVERLAYS = {
  preparingRuntime: {
    phaseLabel: "Preparing runtime",
    detailLines: [
      "Loading work queue and startup settings.",
      "The status shell is live while startup finishes.",
    ],
  },
  preparingQueue: {
    phaseLabel: "Preparing work queue",
    detailLines: [
      "Checking labels.",
      "Execution stays blocked until the queue is safe to run.",
    ],
  },
  restoringState: {
    phaseLabel: "Restoring runtime state",
    detailLines: [
      "Reconnecting workspaces and replaying queued state.",
      "Existing overlays will take over once startup completes.",
    ],
  },
  connectingSession: {
    phaseLabel: "Connecting collaboration",
    detailLines: [
      "Finishing crew session setup before actions unlock.",
    ],
  },
  startingEngine: {
    phaseLabel: "Starting orchestrator",
    detailLines: [
      "Launching the watch engine and waiting for the first live snapshot.",
    ],
  },
} as const satisfies Record<string, StartupOverlayState>;

export interface InteractiveEngineSnapshotRenderState {
  daemonState: DaemonState;
  runtime: InteractiveEngineTransportRuntime;
  pollIntervalMs?: number;
  interactiveTiming?: InteractiveWatchTiming;
}

export type InteractiveEngineTransportMessage =
  | { type: "snapshot"; event: WatchEngineSnapshotEvent }
  | { type: "startup"; overlay: StartupOverlayState }
  | { type: "log"; entry: LogEntry }
  | { type: "result"; result: OrchestrateLoopResult }
  | { type: "control-result"; requestId: string; result: RuntimeCollaborationActionResult }
  | { type: "fatal"; error: string };

export const TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_ENV = "NINTHWAVE_TEST_ENGINE_STARTUP_FAIL";
export const TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_MESSAGE = "Test-only forced interactive engine startup failure.";
export const TEST_ORCH_LAUNCH_TIMEOUT_MS_ENV = "NINTHWAVE_TEST_ORCH_LAUNCH_TIMEOUT_MS";
export const TEST_ORCH_ACTIVITY_TIMEOUT_MS_ENV = "NINTHWAVE_TEST_ORCH_ACTIVITY_TIMEOUT_MS";
export const TEST_ORCH_GRACE_PERIOD_MS_ENV = "NINTHWAVE_TEST_ORCH_GRACE_PERIOD_MS";

function parseTestNonNegativeIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function loadTestOrchestratorConfigOverrides(): {
  launchTimeoutMs?: number;
  activityTimeoutMs?: number;
  gracePeriodMs?: number;
} {
  const launchTimeoutMs = parseTestNonNegativeIntEnv(TEST_ORCH_LAUNCH_TIMEOUT_MS_ENV);
  const activityTimeoutMs = parseTestNonNegativeIntEnv(TEST_ORCH_ACTIVITY_TIMEOUT_MS_ENV);
  const gracePeriodMs = parseTestNonNegativeIntEnv(TEST_ORCH_GRACE_PERIOD_MS_ENV);

  return {
    ...(launchTimeoutMs !== undefined ? { launchTimeoutMs } : {}),
    ...(activityTimeoutMs !== undefined ? { activityTimeoutMs } : {}),
    ...(gracePeriodMs !== undefined ? { gracePeriodMs } : {}),
  };
}

const MAX_ENGINE_DIAGNOSTIC_LINES = 3;

function formatInteractiveEngineFatal(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  const stackLines = error instanceof Error && typeof error.stack === "string"
    ? error.stack
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line !== message)
      .slice(0, MAX_ENGINE_DIAGNOSTIC_LINES - 1)
    : [];
  return ["Engine failed during startup.", ...(message ? [message] : []), ...stackLines].join("\n");
}

function pushEngineDiagnosticLines(buffer: string[], chunk: Buffer | string): void {
  for (const rawLine of chunk.toString().split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    buffer.push(line);
    if (buffer.length > MAX_ENGINE_DIAGNOSTIC_LINES) buffer.shift();
  }
}

function formatEngineDisconnectReason(opts: {
  childError?: Error;
  childCloseSignal: NodeJS.Signals | null;
  childCloseCode: number | null;
  startupDiagnostics: string[];
}): string {
  if (opts.childError?.message) return opts.childError.message;
  if (opts.startupDiagnostics.length > 0) {
    return ["Engine failed during startup.", ...opts.startupDiagnostics].join("\n");
  }
  if (opts.childCloseSignal) return `Engine exited via ${opts.childCloseSignal}.`;
  if (opts.childCloseCode !== null) return `Engine exited with code ${opts.childCloseCode}.`;
  return "The watch engine closed unexpectedly.";
}

function maybeTriggerInteractiveEngineStartupFailureForTest(isInteractiveEngineChild: boolean): void {
  if (!isInteractiveEngineChild) return;
  if (process.env[TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_ENV] !== "1") return;
  throw new Error(TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_MESSAGE);
}

function emitInteractiveEngineStartupOverlay(
  isInteractiveEngineChild: boolean,
  overlay: StartupOverlayState,
): void {
  if (!isInteractiveEngineChild) return;
  process.stdout.write(JSON.stringify({
    type: "startup",
    overlay,
  } satisfies InteractiveEngineTransportMessage) + "\n");
}

export interface InteractiveEngineChildProcess {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export function buildInteractiveEngineChildArgs(
  parsed: ParsedWatchArgs,
  resolved: {
    itemIds: string[];
    mergeStrategy: MergeStrategy;
    sessionLimit: number;
    toolOverride?: string;
    skipReview: boolean;
    reviewMode: "off" | "on";
    watchMode: boolean;
    futureOnlyStartup: boolean;
    crewCode?: string;
    connectMode: boolean;
    crewUrl?: string;
    crewName?: string;
    bypassEnabled: boolean;
  },
): string[] {
  const childArgs: string[] = [
    "--_interactive-engine-child",
    "--skip-preflight",
    "--items",
    ...resolved.itemIds,
    "--merge-strategy",
    resolved.mergeStrategy,
    "--session-limit",
    String(resolved.sessionLimit),
  ];

  if (parsed.pollIntervalOverride !== undefined) {
    childArgs.push("--poll-interval", String(Math.max(1, Math.round(parsed.pollIntervalOverride / 1000))));
  }
  if (parsed.clickupListId) childArgs.push("--clickup-list", parsed.clickupListId);
  if (parsed.reviewAutoFix) childArgs.push("--review-auto-fix", parsed.reviewAutoFix);
  if (parsed.reviewExternal) childArgs.push("--review-external");
  if (parsed.reviewSessionLimit !== undefined) childArgs.push("--review-session-limit", String(parsed.reviewSessionLimit));
  childArgs.push(resolved.skipReview ? "--no-review" : "--review");
  childArgs.push(parsed.fixForward ? "--fix-forward" : "--no-fix-forward");
  if (resolved.watchMode) childArgs.push("--watch");
  if (resolved.futureOnlyStartup) childArgs.push("--future-only-startup");
  if (parsed.noWatch) childArgs.push("--no-watch");
  if (parsed.watchIntervalSecs !== undefined) childArgs.push("--watch-interval", String(parsed.watchIntervalSecs));
  if (resolved.crewCode) childArgs.push("--crew", resolved.crewCode);
  if (resolved.connectMode) childArgs.push("--connect");
  if (parsed.crewPort) childArgs.push("--crew-port", String(parsed.crewPort));
  if (resolved.crewUrl) childArgs.push("--crew-url", resolved.crewUrl);
  if (resolved.crewName) childArgs.push("--crew-name", resolved.crewName);
  if (resolved.bypassEnabled) childArgs.push("--dangerously-bypass");
  if (resolved.toolOverride) childArgs.push("--tool", resolved.toolOverride);
  if (parsed.frictionDir) childArgs.push("--friction-log", parsed.frictionDir);

  return childArgs;
}

export function spawnInteractiveEngineChild(
  childArgs: string[],
  projectRoot: string,
  spawnFn: typeof spawn = spawn,
): InteractiveEngineChildProcess {
  const cliCommand = resolveCliRespawnCommand(childArgs);
  return spawnFn(cliCommand.command, cliCommand.args, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as InteractiveEngineChildProcess;
}

export function writeInteractiveEngineControl(
  stdin: NodeJS.WritableStream | null | undefined,
  command: WatchEngineControlCommand,
): void {
  if (!stdin) return;
  stdin.write(JSON.stringify(command) + "\n");
}

export function terminateInteractiveEngineChild(
  child: InteractiveEngineChildProcess,
  opts: {
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  const timeoutMs = opts.timeoutMs ?? 500;

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeoutFn(timeout);
      resolve();
    };

    child.on("close", () => finish());
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    timeout = setTimeoutFn(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
      finish();
    }, timeoutMs);
  });
}

// TUI rendering functions extracted to core/orchestrate-tui-render.ts
// Crew status → owned IDs and remote write action filtering also moved there.


export interface InteractiveWatchOperatorSessionOptions {
  projectRoot: string;
  childArgs: string[];
  tuiState: TuiState;
  log: (entry: LogEntry) => void;
  initialSnapshot: InteractiveEngineSnapshotRenderState;
  watchMode: boolean;
  manageTerminal?: boolean;
  manageKeyboard?: boolean;
  abortController?: AbortController;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  spawnChild?: (childArgs: string[], projectRoot: string) => InteractiveEngineChildProcess;
  bindControlSender?: (sender: (command: WatchEngineControlCommand) => void) => void;
  bindCollaborationRequester?: (requester: (request: RuntimeCollaborationActionRequest) => Promise<RuntimeCollaborationActionResult>) => void;
  setupKeyboardShortcutsFn?: typeof setupKeyboardShortcuts;
  waitForCompletionKeyFn?: typeof waitForCompletionKey;
  renderFrame?: typeof renderTuiPanelFrameFromStatusItems;
}

export interface InteractiveWatchOperatorSessionResult {
  completionAction?: CompletionAction;
  lastSnapshot: InteractiveEngineSnapshotRenderState;
}

export interface TuiStartupPreparationOptions<TPrepared, TResult> {
  tuiState: TuiState;
  render: () => void;
  initialOverlay: StartupOverlayState;
  prepare: (updateOverlay: (overlay: StartupOverlayState) => void) => Promise<TPrepared>;
  execute: (prepared: TPrepared) => Promise<TResult> | TResult;
}

export async function runTuiStartupPreparation<TPrepared, TResult>(
  opts: TuiStartupPreparationOptions<TPrepared, TResult>,
): Promise<TResult> {
  let currentOverlay = opts.initialOverlay;
  const updateOverlay = (overlay: StartupOverlayState) => {
    currentOverlay = overlay;
    opts.tuiState.startupOverlay = currentOverlay;
    opts.render();
  };

  updateOverlay(currentOverlay);

  try {
    const prepared = await opts.prepare(updateOverlay);
    opts.tuiState.startupOverlay = undefined;
    opts.render();
    return await opts.execute(prepared);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    opts.tuiState.startupOverlay = {
      title: "Startup failed",
      phaseLabel: currentOverlay.phaseLabel,
      detailLines: [message],
      hint: "Startup did not finish",
      tone: "error",
    };
    opts.render();
    throw error;
  }
}

export async function runInteractiveWatchOperatorSession(
  opts: InteractiveWatchOperatorSessionOptions,
): Promise<InteractiveWatchOperatorSessionResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const spawnChild = opts.spawnChild ?? spawnInteractiveEngineChild;
  const bindControlSender = opts.bindControlSender ?? (() => {});
  const bindCollaborationRequester = opts.bindCollaborationRequester ?? (() => {});
  const setupKeyboardShortcutsFn = opts.setupKeyboardShortcutsFn ?? setupKeyboardShortcuts;
  const waitForCompletionKeyFn = opts.waitForCompletionKeyFn ?? waitForCompletionKey;
  const renderFrame = opts.renderFrame ?? renderTuiPanelFrameFromStatusItems;
  const manageTerminal = opts.manageTerminal ?? true;
  const manageKeyboard = opts.manageKeyboard ?? manageTerminal;

  let lastSnapshot = opts.initialSnapshot;

  const write = (chunk: string) => stdout.write(chunk);
  const render = () => {
    renderFrame(
      daemonStateToStatusItems(lastSnapshot.daemonState),
      lastSnapshot.runtime.sessionLimit,
      opts.tuiState,
      write,
      daemonStateToDetailSnapshots(lastSnapshot.daemonState),
    );
  };

  applyRuntimeSnapshotToTuiState(opts.tuiState, lastSnapshot.runtime);

  opts.tuiState.onUpdate = () => {
    try {
      render();
    } catch {
      // Non-fatal.
    }
  };

  const abortController = opts.abortController ?? new AbortController();
  let respawnCountdownTimer: ReturnType<typeof setInterval> | undefined;
  let cleanupKeyboard = () => {};
  let altScreenActive = false;
  let pendingCollaborationRequests = new Map<string, {
    resolve: (result: RuntimeCollaborationActionResult) => void;
    reject: (error: Error) => void;
  }>();

  try {
    if (manageTerminal) {
      write(ALT_SCREEN_ON);
      altScreenActive = true;
    }
    if (manageKeyboard) {
      cleanupKeyboard = setupKeyboardShortcutsFn(abortController, opts.log, stdin, opts.tuiState);
    }
    render();

    while (true) {
      opts.tuiState.engineDisconnected = false;
      opts.tuiState.engineDisconnectReason = undefined;

      let childResult: OrchestrateLoopResult | undefined;
      let childCloseCode: number | null = null;
      let childCloseSignal: NodeJS.Signals | null = null;
      let childError: Error | undefined;
      let stdoutBuffer = "";
      let engineReady = false;
      const startupDiagnostics: string[] = [];

      const child = spawnChild(opts.childArgs, opts.projectRoot);
      bindControlSender((command) => writeInteractiveEngineControl(child.stdin, command));
      bindCollaborationRequester((request) => {
        const requestId = randomUUID();
        return new Promise<RuntimeCollaborationActionResult>((resolve, reject) => {
          pendingCollaborationRequests.set(requestId, { resolve, reject });
          writeInteractiveEngineControl(child.stdin, {
            type: "runtime-collaboration",
            requestId,
            action: request.action,
            ...(request.code ? { code: request.code } : {}),
            ...(request.source ? { source: request.source } : {}),
          });
        });
      });

      const closePromise = new Promise<void>((resolve) => {
        child.on("close", (code, signal) => {
          childCloseCode = code;
          childCloseSignal = signal;
          resolve();
        });
        child.on("error", (error) => {
          childError = error;
          resolve();
        });
      });

      const onChildData = (chunk: Buffer | string) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let message: InteractiveEngineTransportMessage;
          try {
            message = JSON.parse(trimmed) as InteractiveEngineTransportMessage;
          } catch {
            if (!engineReady) pushEngineDiagnosticLines(startupDiagnostics, trimmed);
            continue;
          }
          if (message.type === "startup") {
            opts.tuiState.startupOverlay = message.overlay;
            render();
            continue;
          }
          if (message.type === "snapshot") {
            engineReady = true;
            opts.tuiState.startupOverlay = undefined;
            lastSnapshot = {
              daemonState: message.event.state,
              runtime: message.event.runtime,
              ...(message.event.pollIntervalMs !== undefined ? { pollIntervalMs: message.event.pollIntervalMs } : {}),
              ...(message.event.interactiveTiming ? { interactiveTiming: message.event.interactiveTiming } : {}),
            };
            applyRuntimeSnapshotToTuiState(opts.tuiState, message.event.runtime);

            // Start/stop 1-second ticker for live respawn countdowns.
            // The countdown text is computed at render time from respawnDeadlineMs.
            const hasCountdown = message.event.state.items.some(
              (i: { ciNotifyWallAt?: string; state: string }) =>
                i.ciNotifyWallAt && i.state === "ci-failed",
            );
            if (hasCountdown && !respawnCountdownTimer) {
              respawnCountdownTimer = setInterval(() => {
                try { render(); } catch { /* non-fatal */ }
              }, 1000);
            } else if (!hasCountdown && respawnCountdownTimer) {
              clearInterval(respawnCountdownTimer);
              respawnCountdownTimer = undefined;
            }

            render();
            continue;
          }
          if (message.type === "log") {
            opts.log(message.entry);
            continue;
          }
          if (message.type === "result") {
            engineReady = true;
            childResult = message.result;
            continue;
          }
          if (message.type === "control-result") {
            const pending = pendingCollaborationRequests.get(message.requestId);
            if (!pending) continue;
            pendingCollaborationRequests.delete(message.requestId);
            pending.resolve(message.result);
            continue;
          }
          if (message.type === "fatal") {
            childError = new Error(message.error);
          }
        }
      };

      const onChildStderr = (chunk: Buffer | string) => {
        if (engineReady) return;
        pushEngineDiagnosticLines(startupDiagnostics, chunk);
      };

      if (child.stdout) {
        child.stdout.setEncoding?.("utf8");
        child.stdout.on("data", onChildData);
      }
      if (child.stderr) {
        child.stderr.setEncoding?.("utf8");
        child.stderr.on("data", onChildStderr);
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const onAbort = async () => {
            try {
              await terminateInteractiveEngineChild(child);
              resolve();
            } catch (error) {
              reject(error);
            }
          };

          abortController.signal.addEventListener("abort", () => {
            void onAbort();
          }, { once: true });

          void closePromise.then(resolve, reject);
        });
      } finally {
        bindControlSender(() => {});
        bindCollaborationRequester(async () => ({ error: "Collaboration engine unavailable." }));
        for (const pending of pendingCollaborationRequests.values()) {
          pending.reject(new Error("Collaboration engine unavailable."));
        }
        pendingCollaborationRequests = new Map();
        if (child.stdout) {
          child.stdout.removeListener("data", onChildData);
        }
        if (child.stderr) {
          child.stderr.removeListener("data", onChildStderr);
        }
      }

      if (abortController.signal.aborted) {
        return { completionAction: "quit", lastSnapshot };
      }

      if (!opts.watchMode && childResult) {
        const bannerLines = formatCompletionBanner(lastSnapshot.daemonState.items, lastSnapshot.daemonState.startedAt);
        write("\x1B[H");
        render();
        const termRows = getTerminalHeight();
        const startRow = Math.max(1, termRows - bannerLines.length);
        write(`\x1B[${startRow};1H`);
        for (const line of bannerLines) {
          write(line + "\x1B[K\n");
        }
        return {
          completionAction: await waitForCompletionKeyFn(stdin, abortController.signal),
          lastSnapshot,
        };
      }

      if (childResult) {
        return { completionAction: childResult.completionAction, lastSnapshot };
      }

      opts.tuiState.engineDisconnected = true;
      opts.tuiState.engineDisconnectReason = formatEngineDisconnectReason({
        childError,
        childCloseSignal,
        childCloseCode,
        startupDiagnostics,
      });

      if (!manageKeyboard) {
        render();
        return { lastSnapshot };
      }

      cleanupKeyboard();
      cleanupKeyboard = () => {};
      render();
      const recoveryAction = await waitForEngineRecoveryKey(stdin, abortController.signal);
      if (recoveryAction === "quit") {
        return { completionAction: "quit", lastSnapshot };
      }
      cleanupKeyboard = setupKeyboardShortcutsFn(abortController, opts.log, stdin, opts.tuiState);
      render();
    }
  } finally {
    if (respawnCountdownTimer) clearInterval(respawnCountdownTimer);
    bindControlSender(() => {});
    bindCollaborationRequester(async () => ({ error: "Collaboration engine unavailable." }));
    if (manageKeyboard) cleanupKeyboard();
    if (altScreenActive) {
      write(ALT_SCREEN_OFF);
    }
  }
}

interface InteractiveOperatorParentSessionOptions {
  projectRoot: string;
  parsed: ParsedWatchArgs;
  log: (entry: LogEntry) => void;
  logBuffer: PanelLogEntry[];
  workItemMap: Map<string, WorkItem>;
  itemIds: string[];
  mergeStrategy: MergeStrategy;
  sessionLimit: number;
  toolOverride?: string;
  watchMode: boolean;
  futureOnlyStartup: boolean;
  reviewMode: "off" | "on";
  collaborationMode: "local" | "shared" | "joined";
  bypassEnabled: boolean;
  fixForward: boolean;
  reviewAutoFix?: "off" | "direct" | "pr";
  crewCode?: string;
  connectMode: boolean;
  crewUrl?: string;
  loadRunnableWorkItems: (source: "startup" | "watch-scan" | "run-more") => WorkItem[];
}

/**
 * Start a fresh watch-session snapshot.
 *
 * We always replace any prior restart snapshot before writing the new one so
 * status/recovery views converge on the current session immediately.
 */
export function initializeWatchRuntimeFiles(
  projectRoot: string,
  state: DaemonState,
  pid?: number,
): void {
  cleanStateFile(projectRoot);
  writeStateFile(projectRoot, state);
  if (pid != null) {
    writePidFile(projectRoot, pid);
  }
}

/**
 * Release the active-session lock while preserving the last restart snapshot.
 *
 * Keeping the state file around lets a later `nw` session restore inflight
 * work instead of reconstructing from scratch.
 */
export function cleanupWatchRuntimeFiles(
  projectRoot: string,
  options: { cleanPid?: boolean } = {},
): void {
  const { cleanPid = true } = options;
  if (cleanPid) {
    cleanPidFile(projectRoot);
  }
}

async function runInteractiveOperatorParentSession(
  opts: InteractiveOperatorParentSessionOptions,
): Promise<void> {
  const daemonStartedAt = new Date().toISOString();
  let currentItemIds = [...opts.itemIds];
  let currentToolOverride = opts.toolOverride;

  const buildQueuedState = (
    itemIds: string[],
    runtime: InteractiveEngineTransportRuntime,
  ): InteractiveEngineSnapshotRenderState => {
    const orch = new Orchestrator({
      sessionLimit: runtime.sessionLimit,
      mergeStrategy: runtime.mergeStrategy,
      bypassEnabled: opts.bypassEnabled,
      fixForward: opts.fixForward,
      skipReview: runtime.reviewMode === "off",
      gracePeriodMs: 0,
      ...(opts.reviewAutoFix !== undefined ? { reviewAutoFix: opts.reviewAutoFix } : {}),
    });
    for (const id of itemIds) {
      const workItem = opts.workItemMap.get(id);
      if (workItem) orch.addItem(workItem);
    }
    return {
      daemonState: serializeOrchestratorState(orch.getAllItems(), process.pid, daemonStartedAt, {
        sessionLimit: runtime.sessionLimit,
        ...(opts.futureOnlyStartup ? { emptyState: "watch-armed" as const } : {}),
      }),
      runtime,
    };
  };

  let operatorLastSnapshot = buildQueuedState(currentItemIds, {
    paused: false,
    mergeStrategy: opts.mergeStrategy,
    sessionLimit: opts.sessionLimit,
    reviewMode: opts.reviewMode,
    collaborationMode: opts.collaborationMode,
  });

  let sendRuntimeControl = (_command: WatchEngineControlCommand) => {};
  let requestCollaborationFromEngine = async (
    _request: RuntimeCollaborationActionRequest,
  ): Promise<RuntimeCollaborationActionResult> => ({
    error: "Collaboration engine unavailable.",
  });

  const tuiState: TuiState = {
    scrollOffset: 0,
    viewOptions: {
      showBlockerDetail: true,
      sessionStartedAt: daemonStartedAt,
      mergeStrategy: operatorLastSnapshot.runtime.mergeStrategy,
      collaborationMode: operatorLastSnapshot.runtime.collaborationMode,
      collaborationIntent: collaborationIntentFromMode(operatorLastSnapshot.runtime.collaborationMode),
      collaborationJoinInputActive: false,
      collaborationJoinInputValue: "",
      collaborationBusy: false,
      reviewMode: operatorLastSnapshot.runtime.reviewMode,
      ...(opts.futureOnlyStartup ? { emptyState: "watch-armed" as const } : {}),
    },
    paused: false,
    pendingPaused: undefined,
    sessionLimit: operatorLastSnapshot.runtime.sessionLimit,
    pendingSessionLimit: undefined,
    mergeStrategy: operatorLastSnapshot.runtime.mergeStrategy,
    pendingStrategy: undefined,
    pendingStrategyDeadlineMs: undefined,
    pendingStrategyTimer: undefined,
    pendingStrategyCountdownTimer: undefined,
    bypassEnabled: opts.bypassEnabled,
    ctrlCPending: false,
    ctrlCTimestamp: 0,
    showHelp: false,
    showControls: false,
    controlsRowIndex: 0,
    collaborationMode: operatorLastSnapshot.runtime.collaborationMode,
    pendingCollaborationMode: undefined,
    collaborationIntent: collaborationIntentFromMode(operatorLastSnapshot.runtime.collaborationMode),
    collaborationJoinInputActive: false,
    collaborationJoinInputValue: "",
    collaborationBusy: false,
    reviewMode: operatorLastSnapshot.runtime.reviewMode,
    pendingReviewMode: undefined,
    panelMode: readLayoutPreference(opts.projectRoot),
    logBuffer: opts.logBuffer,
    logScrollOffset: 0,
    logFollowMode: true,
    logLevelFilter: "all",
    selectedItemId: undefined,
    visibleItemIds: [],
    detailItemId: null,
    detailScrollOffset: 0,
    detailContentLines: 0,
    savedLogScrollOffset: 0,
    statusLayout: null,
    sessionCode: opts.crewCode,
    engineDisconnected: false,
    startupOverlay: INTERACTIVE_STARTUP_OVERLAYS.preparingRuntime,
  };

  const runtimeControlHandlers = createRuntimeControlHandlers({
    sendControl: (command) => {
      sendRuntimeControl(command);
    },
    getSessionLimit: () => tuiState.pendingSessionLimit ?? tuiState.sessionLimit ?? operatorLastSnapshot.runtime.sessionLimit,
    requestCollaborationAction: async (request) => {
      const result = await requestCollaborationFromEngine(request);
      if (!result.error && result.code) {
        tuiState.sessionCode = result.code;
      }
      return result;
    },
  });
  Object.assign(tuiState, runtimeControlHandlers, {
    onPanelModeChange: (mode: PanelMode) => writeLayoutPreference(opts.projectRoot, mode),
  });

  void bootstrapTuiUpdateNotice(tuiState.viewOptions, {
    onUpdate: () => tuiState.onUpdate?.(),
  });

  initializeWatchRuntimeFiles(opts.projectRoot, operatorLastSnapshot.daemonState, process.pid);

  try {
    while (true) {
      const childArgs = buildInteractiveEngineChildArgs(opts.parsed, {
        itemIds: currentItemIds,
        mergeStrategy: operatorLastSnapshot.runtime.mergeStrategy,
        sessionLimit: operatorLastSnapshot.runtime.sessionLimit,
        toolOverride: currentToolOverride,
        skipReview: operatorLastSnapshot.runtime.reviewMode === "off",
        reviewMode: operatorLastSnapshot.runtime.reviewMode,
        watchMode: opts.watchMode,
        futureOnlyStartup: opts.futureOnlyStartup,
        crewCode: tuiState.sessionCode,
        connectMode: operatorLastSnapshot.runtime.collaborationMode === "shared",
        crewUrl: opts.crewUrl,
        bypassEnabled: opts.bypassEnabled,
      });

      const operatorResult = await runInteractiveWatchOperatorSession({
        projectRoot: opts.projectRoot,
        childArgs,
        tuiState,
        log: opts.log,
        initialSnapshot: operatorLastSnapshot,
        watchMode: opts.watchMode,
        bindControlSender: (sender) => {
          sendRuntimeControl = sender;
        },
        bindCollaborationRequester: (requester) => {
          requestCollaborationFromEngine = requester;
        },
      });
      operatorLastSnapshot = operatorResult.lastSnapshot;

      if (operatorResult.completionAction === "run-more") {
        const freshItems = opts.loadRunnableWorkItems("run-more");
        const interactiveResult = await runInteractiveFlow(freshItems, operatorLastSnapshot.runtime.sessionLimit, {
          showConnectionStep: false,
        });
        if (!interactiveResult) {
          break;
        }

        const freshMap = new Map<string, WorkItem>();
        for (const item of freshItems) {
          freshMap.set(item.id, item);
          opts.workItemMap.set(item.id, item);
        }
        currentItemIds = interactiveResult.itemIds.filter((id) => freshMap.has(id));
        if (currentItemIds.length === 0) {
          break;
        }
        if (interactiveResult.aiTools && interactiveResult.aiTools.length > 0) {
          currentToolOverride = interactiveResult.aiTools.join(",");
        } else if (interactiveResult.aiTool) {
          currentToolOverride = interactiveResult.aiTool;
        }
        operatorLastSnapshot = buildQueuedState(currentItemIds, operatorLastSnapshot.runtime);
        tuiState.startupOverlay = INTERACTIVE_STARTUP_OVERLAYS.preparingRuntime;
        opts.log({
          ts: new Date().toISOString(),
          level: "info",
          event: "run_more_restart",
          newItems: currentItemIds,
        });
        continue;
      }

      if (operatorResult.completionAction === "clean") {
        for (const item of operatorLastSnapshot.daemonState.items) {
          if (item.state !== "done") continue;
          try {
            if (item.workspaceRef) {
              createMux(muxTypeForWorkspaceRef(item.workspaceRef), opts.projectRoot).closeWorkspace(item.workspaceRef, item.id);
            }
            cleanSingleWorktree(item.id, join(opts.projectRoot, ".ninthwave", ".worktrees"), opts.projectRoot);
          } catch {
            // Best-effort cleanup only.
          }
        }
      }

      break;
    }
  } finally {
    cleanupWatchRuntimeFiles(opts.projectRoot);
    if (operatorLastSnapshot.daemonState.items.length > 0) {
      console.log(formatExitSummary(operatorLastSnapshot.daemonState.items, operatorLastSnapshot.daemonState.startedAt));
    }
  }
}


// ── CLI command ─────────────────────────────────────────────────────

/** Renamed entry point: `nw` dispatches here. */
export const cmdWatch = cmdOrchestrate;

export async function cmdOrchestrate(
  args: string[],
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
): Promise<void> {
  const parsed = parseWatchArgs(args);
  let {
    itemIds,
    mergeStrategy,
  } = parsed;
  const {
    sessionLimitOverride, pollIntervalOverride, frictionDir,
    daemonMode, isDaemonChild, isInteractiveEngineChild, clickupListId, remoteFlag,
    reviewAutoFix, reviewExternal: parsedReviewExternal, reviewSessionLimit,
    fixForward, skipReview: cliSkipReview, noWatch, watchIntervalSecs,
    jsonFlag, skipPreflight, crewName,
    bypassEnabled, toolOverride: parsedToolOverride,
  } = parsed;
  let toolOverride = parsedToolOverride;
  let watchMode = parsed.watchMode;
  let futureOnlyStartup = parsed.futureOnlyStartup;
  let crewCode = parsed.crewCode;
  let crewUrl = parsed.crewUrl;
  let connectMode = parsed.connectMode;
  let usedInteractiveOperatorParentSession = false;

  try {

  // ── Pre-flight environment validation ────────────────────────────────
  if (!skipPreflight) {
    const pf = preflight(undefined, projectRoot);
    if (!pf.passed) {
      // Check if the only failure is uncommitted work items -- handle with auto-commit
      const itemCheck = pf.checks.find(
        (c) => c.status === "fail" && c.message.includes("uncommitted work item file"),
      );
      const otherErrors = pf.errors.filter(
        (e) => !e.includes("uncommitted work item file"),
      );

      if (itemCheck && otherErrors.length === 0) {
        // Only uncommitted work items failed -- try auto-commit
        const isInteractive = !isDaemonChild && !daemonMode && process.stdout.isTTY === true;
        let shouldCommit = false;

        if (isInteractive) {
          warn(itemCheck.message);
          shouldCommit = await confirmPrompt(
            "Commit and push work item files before launching workers?",
            true,
          );
          if (!shouldCommit) {
            die("Uncommitted work item files detected. Commit them before launching workers.");
          }
        } else {
          // Daemon/non-interactive mode: auto-commit
          info(`Auto-committing: ${itemCheck.message}`);
          shouldCommit = true;
        }

        if (shouldCommit) {
          try {
            gitAdd(projectRoot, [".ninthwave/work/"]);
            gitCommit(projectRoot, "chore: commit work item files before orchestration");
            gitPush(projectRoot);
            info("Work item files committed and pushed.");
          } catch (err) {
            die(`Failed to auto-commit work item files: ${(err as Error).message}`);
          }
        }
      } else {
        for (const err of pf.errors) {
          console.error(`Pre-flight failed: ${err}`);
        }
        die("Environment checks failed. Fix the issues above or use --skip-preflight to bypass.");
      }
    }
  }

  // ── Daemon fork: spawn detached child and return immediately ──
  if (daemonMode) {
    // Check if daemon is already running
    const existingPid = isDaemonRunning(projectRoot);
    if (existingPid !== null) {
      die(`Watch daemon is already running (PID ${existingPid}). Use 'ninthwave stop' first.`);
    }

    // Build child args: replace --daemon with --_daemon-child
    const childArgs = args.filter((a) => a !== "--daemon");
    childArgs.push("--_daemon-child");

    const { pid, logPath } = forkDaemon(childArgs, projectRoot);

    console.log(`Watch daemon started (PID ${pid})`);
    console.log(`  Log:   ${logPath}`);
    console.log(`  State: ${stateFilePath(projectRoot)}`);
    console.log(`  Stop:  ninthwave stop`);
    return;
  }

  // ── TUI mode setup ─────────────────────────────────────────────────
  // TUI mode: render live status table to stdout; redirect JSON logs to log file.
  // Enabled when stdout is a TTY and neither --json nor --_daemon-child is set.
  const tuiMode = detectTuiMode(isDaemonChild || isInteractiveEngineChild, jsonFlag, process.stdout.isTTY === true);

  // Shared log ring buffer for the TUI log panel.
  // Created here so the log closure can push entries before tuiState is constructed.
  const logBuffer: PanelLogEntry[] = [];

  // In TUI mode, redirect structured logs to the log file instead of stdout.
  // Also push each entry to the ring buffer for the live log panel.
  let log: (entry: LogEntry) => void = structuredLog;
  if (tuiMode) {
    const stateDir = userStateDir(projectRoot);
    mkdirSync(stateDir, { recursive: true });
    const tuiLogPath = logFilePath(projectRoot);
    log = (entry: LogEntry) => {
      appendFileSync(tuiLogPath, JSON.stringify(entry) + "\n");
      // Push to ring buffer for live TUI log panel
      const levelTag = entry.level !== "info" ? `[${entry.level}] ` : "";
      pushLogBuffer(logBuffer, {
        timestamp: entry.ts,
        itemId: (entry.itemId as string) ?? (entry.id as string) ?? "",
        message: `${levelTag}${entry.event}${entry.message ? ": " + entry.message : ""}`,
      });
    };
  } else if (isInteractiveEngineChild) {
    log = (entry: LogEntry) => {
      process.stdout.write(JSON.stringify({ type: "log", entry } satisfies InteractiveEngineTransportMessage) + "\n");
    };
  }

  // Migrate runtime state from old .ninthwave/ to ~/.ninthwave/projects/<slug>/
  migrateRuntimeState(projectRoot);

  // Prevent duplicate orchestrator instances (foreground or daemon-child)
  const existingPid = isDaemonRunning(projectRoot);
  if (!isInteractiveEngineChild && existingPid !== null && existingPid !== process.pid) {
    die(`Another watch daemon is already running (PID ${existingPid}). Use 'ninthwave stop' first, or kill the stale process.`);
  }

  // Compute memory-aware session default, allow --session-limit to override
  // Precedence: CLI --session-limit > persisted user preference > computed default
  const computedSessionLimit = computeDefaultSessionLimit();
  let persistedUserCfg = loadUserConfig();
  const sessionLimitFromCli = sessionLimitOverride !== undefined;
  let sessionLimit = sessionLimitOverride ?? persistedUserCfg.session_limit ?? computedSessionLimit;
  // Apply the GitHub token before recovery and later polling paths use it.
  emitInteractiveEngineStartupOverlay(isInteractiveEngineChild, INTERACTIVE_STARTUP_OVERLAYS.preparingRuntime);
  applyGithubToken(projectRoot);

  const loadDiscoveryWorkItems = (_source: "startup" | "watch-scan" | "run-more"): WorkItem[] => {
    return loadDiscoveryStartupItems(workDir, worktreeDir, projectRoot);
  };

  // Parse work items (needed for both interactive and flag-based modes)
  // Pass projectRoot to filter to only items pushed to origin/main
  const workItems = loadDiscoveryWorkItems("startup");
  const preConfig = loadConfig(projectRoot);
  crewUrl = resolveConfiguredCrewUrl(crewUrl, preConfig.crew_url);
  const interactiveStartupConfig = resolveInteractiveStartupConfig(preConfig, persistedUserCfg, projectRoot, toolOverride);

  // Interactive mode: no --items and stdin is a TTY
  let interactiveSkipReview = false;
  let interactiveReviewMode: "on" | "off" | null = null;
  if (shouldEnterInteractive(itemIds.length > 0)) {
    // Pre-detect tools and config for TUI flow
    const installedTools = detectInstalledAITools();

    const startupDefaultSessionLimit = sessionLimit;
    const result = await runInteractiveFlow(workItems, startupDefaultSessionLimit, {
      defaultReviewMode: interactiveStartupConfig.defaults.reviewMode,
      defaultSettings: interactiveStartupConfig.defaults,
      installedTools,
      savedToolIds: interactiveStartupConfig.savedToolIds,
      projectRoot,
    });
    if (!result) {
      process.exit(0);
    }
    itemIds = result.itemIds;
    watchMode = watchMode || result.allSelected || result.futureOnly === true;
    futureOnlyStartup = futureOnlyStartup || result.futureOnly === true;
    mergeStrategy = result.mergeStrategy;
    sessionLimit = result.sessionLimit;
    interactiveReviewMode = result.reviewMode;
    interactiveSkipReview = result.reviewMode === "off";
    try {
      saveUserConfig({
        ...buildStartupPersistenceUpdates(result, {
          savedToolIds: interactiveStartupConfig.savedToolIds,
          defaults: interactiveStartupConfig.defaults,
          defaultSessionLimit: startupDefaultSessionLimit,
        }),
      });
      persistedUserCfg = loadUserConfig();
    } catch {
      // best-effort persistence only
    }
    ({ connectMode, crewCode, crewUrl } = resolveStartupCollaborationAction(
      { connectMode, crewCode, crewUrl },
      result.connectionAction,
    ));
    // Capture AI tool choice from TUI -- flows to selectAiTools via toolOverride
    if (result.aiTools && result.aiTools.length > 0) {
      toolOverride = result.aiTools.join(",");
    } else if (result.aiTool) {
      toolOverride = result.aiTool;
    }
  }

  log({
    ts: new Date().toISOString(),
    level: "info",
    event: "session_limit_resolved",
    computedDefault: computedSessionLimit,
    persistedUserSessionLimit: persistedUserCfg.session_limit,
    effectiveLimit: sessionLimit,
    overridden: sessionLimitFromCli,
    totalMemoryGB: Math.round(totalmem() / (1024 ** 3)),
  });

  if (itemIds.length === 0 && !watchMode && !daemonMode) {
    die(
      "Usage: nw --items ID1 ID2 ... [--merge-strategy auto|manual] [--session-limit N] [--poll-interval SECS] [--daemon] [--no-watch] [--watch-interval SECS]",
    );
  }

  const workItemMap = new Map<string, WorkItem>();
  for (const item of workItems) {
    workItemMap.set(item.id, item);
  }

  // Validate all items exist
  const unknownIds = validateItemIds(itemIds, workItemMap);
  if (unknownIds.length > 0) {
    die(`Item ${unknownIds[0]} not found in work item files`);
  }

  const startupReviewMode = interactiveReviewMode === "off"
    ? "off" as const
    : "on" as const;
  const startupCollaborationMode = crewCode
    ? (connectMode ? "shared" as const : "joined" as const)
    : persistedCollaborationModeToRuntime(interactiveStartupConfig.defaults.collaborationMode);

  if (tuiMode && !isInteractiveEngineChild) {
    usedInteractiveOperatorParentSession = true;
    await runInteractiveOperatorParentSession({
      projectRoot,
      parsed,
      log,
      logBuffer,
      workItemMap,
      itemIds,
      mergeStrategy,
      sessionLimit,
      toolOverride,
      watchMode,
      futureOnlyStartup,
      reviewMode: startupReviewMode,
      collaborationMode: startupCollaborationMode,
      bypassEnabled,
      fixForward,
      ...(reviewAutoFix !== undefined ? { reviewAutoFix } : {}),
      ...(crewCode ? { crewCode } : {}),
      connectMode,
      ...(crewUrl ? { crewUrl } : {}),
      loadRunnableWorkItems: loadDiscoveryWorkItems,
    });
    return;
  }

  // Create orchestrator
  // skipReview: CLI --no-review, interactive "off" mode, or --review-session-limit 0 disables AI review gate
  const skipReview = cliSkipReview || interactiveSkipReview || reviewSessionLimit === 0;
  const testOrchestratorConfigOverrides = loadTestOrchestratorConfigOverrides();
  let orch = new Orchestrator({
    sessionLimit,
    mergeStrategy,
    bypassEnabled,
    fixForward,
    skipReview,
    ...((tuiMode || isInteractiveEngineChild) ? {} : { gracePeriodMs: 0 }),
    ...testOrchestratorConfigOverrides,
    ...(reviewAutoFix !== undefined ? { reviewAutoFix } : {}),
  });
  for (const id of itemIds) {
    orch.addItem(workItemMap.get(id)!);
  }

  // Pre-create domain labels so workers don't need to (one API call per unique domain)
  emitInteractiveEngineStartupOverlay(isInteractiveEngineChild, INTERACTIVE_STARTUP_OVERLAYS.preparingQueue);
  const domainSet = new Set(itemIds.map(id => workItemMap.get(id)!.domain));
  if (fixForward) domainSet.add("verify");
  ensureDomainLabels(projectRoot, [...domainSet]);

  // Real action dependencies -- create mux before state reconstruction so
  // workspace refs can be recovered from live workspaces.
  emitInteractiveEngineStartupOverlay(isInteractiveEngineChild, INTERACTIVE_STARTUP_OVERLAYS.restoringState);
  const resolvedBackend = resolveBackend({ env: process.env });
  const mux = createMux(resolvedBackend.effective, projectRoot);

  if (resolvedBackend.fallback && resolvedBackend.requested !== "auto" && resolvedBackend.requested !== "headless") {
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "startup_backend_fallback",
      requested: resolvedBackend.requested,
      effective: resolvedBackend.effective,
      source: resolvedBackend.source,
      reason: resolvedBackend.fallback.reason,
      message: resolvedBackend.fallback.reason,
    });
    if (!jsonFlag) {
      info(`Tip: ${resolvedBackend.fallback.reason}`);
    }
  }
  const muxForWorkspaceRef = (workspaceRef: string): Multiplexer =>
    createMux(muxTypeForWorkspaceRef(workspaceRef), projectRoot);
  const resolveLaunchMux = (): Multiplexer => {
    const runtimeResolvedBackend = resolveBackend({ env: process.env });
    return createMux(runtimeResolvedBackend.effective, projectRoot);
  };

  // Pre-flight: fail fast if the mux backend is not usable (binary missing
  // or no active session). Without this, workers launch and immediately fail
  // with misleading errors, wasting 10+ minutes in retry/stuck cycles.
  if (!mux.isAvailable()) {
    die(mux.diagnoseUnavailable());
  }

  let tmuxSessionName: string | undefined;
  let tmuxOutsideSession = false;
  if (mux.type === "tmux") {
    const tmuxInfo = getTmuxStartupInfo(projectRoot);
    tmuxSessionName = tmuxInfo.sessionName;
    tmuxOutsideSession = tmuxInfo.outsideTmuxSession;
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "tmux_session_resolved",
      sessionName: tmuxInfo.sessionName,
      outsideTmuxSession: tmuxInfo.outsideTmuxSession,
      termProgram: process.env.TERM_PROGRAM ?? null,
    });
    if (!jsonFlag && tmuxInfo.outsideTmuxSession) {
      for (const line of tmuxInfo.attachHintLines) {
        info(line);
      }
    }
  }

  // Prune stale git worktree registry entries (e.g., from copied repos or
  // crashed sessions). Safe no-op when nothing is stale.
  try {
    run("git", ["-C", projectRoot, "worktree", "prune"]);
  } catch { /* best-effort */ }

  // Clean orphaned worktrees before state reconstruction so stale worktrees
  // from previous runs don't confuse reconstructState or count toward the session limit.
  cleanOrphanedWorktrees(workDir, worktreeDir, projectRoot, {
    getWorktreeIds: listWorktreeIds,
    getOpenItemIds: listOpenItemIds,
    cleanWorktree: (id, wtDir, root) => cleanSingleWorktree(id, wtDir, root),
    closeWorkspaceForItem: (itemId) => {
      const list = mux.listWorkspaces();
      if (!list) return;
      for (const line of list.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes(itemId)) continue;
        mux.closeWorkspace(trimmed.split(/\s+/, 1)[0] ?? trimmed, itemId);
        return;
      }
    },
    log,
  });

  // Reconstruct state from disk + GitHub (crash recovery)
  // Pass saved daemon state so counters (ciFailCount, retryCount) survive restarts
  const savedDaemonState = readStateFile(projectRoot);
  const reconstruction = reconstructState(orch, projectRoot, worktreeDir, mux, undefined, savedDaemonState);
  const isInteractive = !isDaemonChild && !daemonMode && process.stdin.isTTY === true;
  await resolveUnresolvedRestartedWorkers(orch, reconstruction.unresolvedImplementations, {
    interactive: isInteractive,
    log,
  });

  // Select AI tool(s) (interactive prompt when multiple tools installed)
  const aiTools = await selectAiTools({ toolOverride, projectRoot, isInteractive });
  validateAgentFiles(aiTools, projectRoot);
  const aiTool = aiTools[0]!;

  // Compute hub repo NWO once at startup for absolute agent-link URLs in PR comments
  let hubRepoNwo = "";
  try {
    hubRepoNwo = getRepoOwner(projectRoot);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`Could not determine hub repo NWO: ${msg}`);
  }

  const ctx: ExecutionContext = { projectRoot, worktreeDir, workDir, aiTool, aiTools, nextToolIndex: 0, hubRepoNwo };
  const actionDeps: OrchestratorDeps = {
    git: {
      fetchOrigin,
      ffMerge,
      resolveRef,
      rebaseOnto,
      forcePush,
      daemonRebase,
      autoSaveWorktree,
    },
    gh: {
      prMerge: (repoRoot, prNumber, options) => prMerge(repoRoot, prNumber, options),
      prComment: (repoRoot, prNumber, body) => prComment(repoRoot, prNumber, body),
      addCommentReaction: (repoRoot, commentId, commentType, reaction) =>
        addCommentReaction(repoRoot, commentId, commentType, reaction),
      setCommitStatus: (repoRoot, prNumber, state, context, description) => {
        const sha = prHeadSha(repoRoot, prNumber);
        if (!sha) return false;
        return ghSetCommitStatus(repoRoot, sha, state, context, description);
      },
      getPrBaseBranch: (repoRoot, prNumber) => ghGetPrBaseBranch(repoRoot, prNumber),
      getPrBaseAndState: (repoRoot, prNumber) => ghGetPrBaseAndState(repoRoot, prNumber),
      retargetPrBase: (repoRoot, prNumber, baseBranch) => ghRetargetPrBase(repoRoot, prNumber, baseBranch),
      checkPrMergeable,
      isPrBlocked,
      getMergeCommitSha: (repoRoot, prNumber) => ghGetMergeCommitSha(repoRoot, prNumber),
      checkCommitCI: (repoRoot, sha) => ghCheckCommitCI(repoRoot, sha),
      getDefaultBranch: (repoRoot) => ghGetDefaultBranch(repoRoot),
      upsertOrchestratorComment: (repoRoot, prNumber, itemId, eventLine) =>
        upsertOrchestratorComment(repoRoot, prNumber, itemId, eventLine),
    },
    mux: {
      closeWorkspace: (ref, workItemId) => muxForWorkspaceRef(ref).closeWorkspace(ref, workItemId),
      readScreen: (ref, lines) => muxForWorkspaceRef(ref).readScreen(ref, lines),
    },
    workers: {
      validatePickupCandidate: (item, projRoot) => validatePickupCandidate(item, projRoot),
      launchSingleItem: (item, workDir, worktreeDir, projectRoot, aiTool, baseBranch, forceWorkerLaunch) =>
        launchSingleItem(item, workDir, worktreeDir, projectRoot, aiTool, mux, {
          baseBranch,
          forceWorkerLaunch,
          hubRepoNwo,
          resolveMux: resolveLaunchMux,
          throwOnLaunchFailure: true,
        }),
      launchReview: (itemId, prNumber, repoRoot, implementerWorktreePath, itemAiTool) => {
        const autoFix = orch.config.reviewAutoFix;
        const result = launchReviewWorker(prNumber, itemId, autoFix, repoRoot, itemAiTool ?? aiTool, mux, {
          implementerWorktreePath,
          hubRepoNwo,
          projectRoot,
          resolveMux: resolveLaunchMux,
        });
        if (!result) return null;
        return { workspaceRef: result.workspaceRef, verdictPath: result.verdictPath };
      },
      launchRebaser: (itemId, prNumber, repoRoot, itemAiTool) => {
        const result = launchRebaserWorker(prNumber, itemId, repoRoot, itemAiTool ?? aiTool, mux, {
          hubRepoNwo,
          projectRoot,
          resolveMux: resolveLaunchMux,
        });
        if (!result) return null;
        return { workspaceRef: result.workspaceRef };
      },
      launchForwardFixer: (itemId, mergeCommitSha, repoRoot, itemAiTool, defaultBranch) => {
        const result = launchForwardFixerWorker(itemId, mergeCommitSha, repoRoot, itemAiTool ?? aiTool, mux, {
          hubRepoNwo,
          defaultBranch,
          projectRoot,
          resolveMux: resolveLaunchMux,
        });
        if (!result) return null;
        return { worktreePath: result.worktreePath, workspaceRef: result.workspaceRef };
      },
    },
    cleanup: {
      cleanSingleWorktree,
      cleanReview: (itemId, reviewWorkspaceRef) => {
        try { muxForWorkspaceRef(reviewWorkspaceRef).closeWorkspace(reviewWorkspaceRef); } catch { /* best-effort */ }
        try {
          cleanSingleWorktree(`review-${itemId}`, join(projectRoot, ".ninthwave", ".worktrees"), projectRoot);
        } catch { /* best-effort -- review worktree may not exist for off mode */ }
        return true;
      },
      cleanRebaser: (itemId, rebaserWorkspaceRef) => {
        try { muxForWorkspaceRef(rebaserWorkspaceRef).closeWorkspace(rebaserWorkspaceRef); } catch { /* best-effort */ }
        return true;
      },
      cleanForwardFixer: (itemId, fixForwardWorkspaceRef) => {
        try { muxForWorkspaceRef(fixForwardWorkspaceRef).closeWorkspace(fixForwardWorkspaceRef); } catch { /* best-effort */ }
        try {
          cleanSingleWorktree(`ninthwave-fix-forward-${itemId}`, join(projectRoot, ".ninthwave", ".worktrees"), projectRoot);
        } catch { /* best-effort -- forward-fixer worktree may already be cleaned */ }
        return true;
      },
      cleanStaleBranch: (item, projRoot) => {
        cleanStaleBranchForReuse(item.id, item.title, projRoot, undefined, item.lineageToken);
      },
      completeMergedWorkItem: (item, workDir, root) => completeMergedWorkItemCleanup(item, workDir, root),
    },
    io: {
      writeInbox: (targetRoot, itemId, msg) => writeInbox(targetRoot, itemId, msg),
      warn: (message) =>
        log({ ts: new Date().toISOString(), level: "warn", event: "orchestrator_warning", message }),
      syncStackComments: (baseBranch, stack) => {
        syncStackCommentsForRepo(baseBranch, stack, {
          listComments: (prNumber) => listPrComments(projectRoot, prNumber),
          createComment: (prNumber, body) => prComment(projectRoot, prNumber, body),
          updateComment: (commentId, body) => updatePrComment(projectRoot, commentId, body),
        });
      },
    },
  };

  // ── Crew mode setup ──────────────────────────────────────────────
  let crewBroker: CrewBroker | undefined;

  // Resolve git remote URL for crew repo verification
  let crewRepoUrl = "";
  try {
    const { execSync } = await import("child_process");
    crewRepoUrl = execSync("git remote get-url origin", { cwd: projectRoot, encoding: "utf-8" }).trim();
  } catch {
    // No git remote available
  }

  // Local-first: never re-activate saved crew codes on plain startup.
  // Previous collaboration state does not carry into a new run.
  // Explicit --crew or --connect is required to enter collaboration mode.

  const collaborationState: CollaborationSessionState = {
    mode: crewCode ? (connectMode ? "shared" : "joined") : "local",
    ...(crewCode ? { crewCode } : {}),
    ...(crewUrl ? { crewUrl } : {}),
    connectMode,
  };

  let updateRuntimeCollaborationBindings = () => {};

  const syncCollaborationLocals = () => {
    crewBroker = collaborationState.crewBroker;
    crewCode = collaborationState.crewCode;
    crewUrl = collaborationState.crewUrl;
    connectMode = collaborationState.connectMode;
    updateRuntimeCollaborationBindings();
  };

  if (connectMode && !crewCode) {
    emitInteractiveEngineStartupOverlay(isInteractiveEngineChild, INTERACTIVE_STARTUP_OVERLAYS.connectingSession);
    info("Sharing session via ninthwave.sh...");
    const result = await applyRuntimeCollaborationAction(collaborationState, { action: "share", source: "startup" }, {
      projectRoot,
      crewRepoUrl,
      crewName,
      log,
    });
    if (result.error || !result.code) {
      die(result.error ?? "Failed to create session");
    }
    syncCollaborationLocals();
    info(`Session created: ${crewCode}`);
    info(`  Join: nw --crew ${crewCode}`);
  }

  if (crewCode) {
    emitInteractiveEngineStartupOverlay(isInteractiveEngineChild, INTERACTIVE_STARTUP_OVERLAYS.connectingSession);
    if (!collaborationState.crewBroker) {
      info(`Joining session via ninthwave.sh (${crewCode})...`);
      const result = await applyRuntimeCollaborationAction(collaborationState, {
        action: "join",
        code: crewCode,
        source: "startup",
      }, {
        projectRoot,
        crewRepoUrl,
        crewName,
        log,
      });
      if (result.error) {
        die(`Failed to connect to crew server: ${result.error}`);
      }
      syncCollaborationLocals();
    }
    info(`Session active on ninthwave.sh as "${crewName ?? hostname()}"`);
  }

  /** Get broker-fed remote item snapshots for live TUI rendering. */
  function getRemoteItemSnapshots(): Map<string, CrewRemoteItemSnapshot> | undefined {
    if (!crewBroker) return undefined;
    return crewStatusToRemoteItemSnapshots(crewBroker.getCrewStatus());
  }

  // Graceful SIGINT handling
  const abortController = new AbortController();
  const sigintHandler = () => {
    log({ ts: new Date().toISOString(), level: "info", event: "sigint_received" });
    crewBroker?.disconnect();
    abortController.abort();
  };
  process.on("SIGINT", sigintHandler);

  // Graceful SIGTERM handling (used by daemon mode for clean shutdown)
  const sigtermHandler = () => {
    log({ ts: new Date().toISOString(), level: "info", event: "sigterm_received" });
    crewBroker?.disconnect();
    abortController.abort();
  };
  process.on("SIGTERM", sigtermHandler);

  // Resolve config-file flags
  const projectConfig = loadConfig(projectRoot);
  // --review-session-limit 0 explicitly disables reviews, overriding config
  const reviewExternalEnabled = reviewSessionLimit === 0
    ? false
    : interactiveReviewMode === "off"
      ? false
      : (parsedReviewExternal || projectConfig.review_external);

  // State persistence: serialize state each poll cycle so the status pane can display all items.
  // Written in both daemon and interactive mode -- the status pane reads this file to show
  // the full queue including queued items that don't have worktrees yet.
  // statusPaneRef is captured by reference so the closure always persists the current value.
  const daemonStartedAt = new Date().toISOString();

  // Resolve operator identity (git email) for this daemon session.
  // Persisted to state dir so it survives restarts.
  const operatorId = resolveOperatorId(projectRoot);

  // Clean stale state from previous run and write a fresh initial state.
  // This ensures `ninthwave status` never shows items from a previous run mixed
  // with the current run -- even before the first poll cycle completes.
  const initialCrewStatus = crewBroker?.getCrewStatus();
  const initialState = serializeOrchestratorState(orch.getAllItems(), process.pid, daemonStartedAt, {
    sessionLimit,
    operatorId,
    remoteItemSnapshots: crewStatusToRemoteItemSnapshots(initialCrewStatus),
    crewStatus: crewStatusToDaemonCrewStatus(initialCrewStatus, crewCode, crewBroker?.isConnected() ?? false),
    ...(futureOnlyStartup ? { emptyState: "watch-armed" as const } : {}),
  });
  initializeWatchRuntimeFiles(projectRoot, initialState);

  // TUI state: scroll offset and view option toggles (shared with keyboard handler)
  // Read persisted layout preference (defaults to "status-only" if missing/corrupt)
  const savedPanelMode = tuiMode ? readLayoutPreference(projectRoot) : "status-only";
  const initialCollaborationMode = collaborationState.mode === "local"
    ? persistedCollaborationModeToRuntime(interactiveStartupConfig.defaults.collaborationMode)
    : collaborationState.mode;
  const initialReviewMode = orch.config.skipReview
    ? "off" as const
    : "on" as const;
  let operatorLastSnapshot: InteractiveEngineSnapshotRenderState = {
    daemonState: initialState,
    runtime: {
      paused: false,
      mergeStrategy: orch.config.mergeStrategy,
      sessionLimit,
      reviewMode: initialReviewMode,
      collaborationMode: initialCollaborationMode,
    },
  };

  let lastTuiItems: OrchestratorItem[] = orch.getAllItems();
  let lastTuiHeartbeats = new Map<string, WorkerProgress>();
  let sendRuntimeControl = (_command: WatchEngineControlCommand) => {};
  let requestCollaborationFromEngine = async (_request: RuntimeCollaborationActionRequest): Promise<RuntimeCollaborationActionResult> => ({
    error: "Collaboration engine unavailable.",
  });
  const applyLocalRuntimeCollaborationAction = async (
    request: RuntimeCollaborationActionRequest,
  ): Promise<RuntimeCollaborationActionResult> => {
    const result = await applyRuntimeCollaborationAction(collaborationState, request, {
      projectRoot,
      crewRepoUrl,
      crewName,
      log,
    });
    syncCollaborationLocals();
    return result;
  };
  const requestRuntimeCollaborationAction = async (
    request: RuntimeCollaborationActionRequest,
  ): Promise<RuntimeCollaborationActionResult> => {
    if (isInteractiveEngineChild || !tuiMode) {
      return applyLocalRuntimeCollaborationAction(request);
    }

    const result = await requestCollaborationFromEngine(request);
    if (result.error) return result;

    if (request.action === "local") {
      return applyLocalRuntimeCollaborationAction(request);
    }

    if (
      request.action === "share"
      && collaborationState.mode === "shared"
      && collaborationState.crewCode === result.code
      && collaborationState.crewBroker?.isConnected()
    ) {
      return result;
    }

    const mirrorResult = await applyLocalRuntimeCollaborationAction({
      action: "join",
      code: result.code ?? request.code,
      source: request.source,
    });
    if (mirrorResult.error) return mirrorResult;

    if (request.action === "share") {
      collaborationState.mode = "shared";
      collaborationState.connectMode = true;
      syncCollaborationLocals();
      return { mode: "shared", code: result.code };
    }

    return { mode: "joined", code: result.code ?? request.code };
  };
  const runtimeControlHandlers = createRuntimeControlHandlers({
    sendControl: (command) => {
      sendRuntimeControl(command);
    },
    getSessionLimit: () => tuiState.pendingSessionLimit ?? sessionLimit,
    requestCollaborationAction: (request) => requestRuntimeCollaborationAction(request),
  });
  const tuiState: TuiState = {
    scrollOffset: 0,
    viewOptions: {
      showBlockerDetail: true,
      sessionStartedAt: daemonStartedAt,
      mergeStrategy: orch.config.mergeStrategy,
      collaborationMode: initialCollaborationMode,
      collaborationIntent: "local",
      collaborationJoinInputActive: false,
      collaborationJoinInputValue: "",
      collaborationBusy: false,
      shutdownInProgress: false,
      reviewMode: initialReviewMode,
      ...(futureOnlyStartup ? { emptyState: "watch-armed" as const } : {}),
    },
    paused: false,
    pendingPaused: undefined,
    sessionLimit,
    pendingSessionLimit: undefined,
    mergeStrategy: orch.config.mergeStrategy,
    pendingStrategy: undefined,
    pendingStrategyTimer: undefined,
    bypassEnabled: orch.config.bypassEnabled,
    ctrlCPending: false,
    shutdownInProgress: false,
    ctrlCTimestamp: 0,
    showHelp: false,
    showControls: false,
    controlsRowIndex: 0,
    collaborationMode: initialCollaborationMode,
    pendingCollaborationMode: undefined,
    collaborationIntent: "local",
    collaborationJoinInputActive: false,
    collaborationJoinInputValue: "",
    collaborationBusy: false,
    reviewMode: initialReviewMode,
    pendingReviewMode: undefined,
    panelMode: savedPanelMode,
    logBuffer,
    logScrollOffset: 0,
    logFollowMode: true,
    logLevelFilter: "all",
    selectedItemId: undefined,
    visibleItemIds: [],
    detailItemId: null,
    detailScrollOffset: 0,
    detailContentLines: 0,
    savedLogScrollOffset: 0,
    statusLayout: null,
    ...runtimeControlHandlers,
    onPanelModeChange: (mode) => {
      writeLayoutPreference(projectRoot, mode);
    },
    // Immediate re-render on keypress (doesn't wait for poll cycle)
    onUpdate: () => {
      if (tuiMode) {
        try {
          renderTuiPanelFrame(lastTuiItems, sessionLimit, tuiState, undefined, getRemoteItemSnapshots(), orch.config.maxTimeoutExtensions, lastTuiHeartbeats);
        } catch {
          // Non-fatal
        }
      }
    },
    sessionCode: crewCode ?? undefined,
    tmuxSessionName: tmuxOutsideSession ? tmuxSessionName : undefined,
    engineDisconnected: false,
  };

  if (tuiMode) {
    void bootstrapTuiUpdateNotice(tuiState.viewOptions, {
      onUpdate: () => {
        try {
          renderTuiPanelFrame(lastTuiItems, sessionLimit, tuiState, undefined, getRemoteItemSnapshots(), orch.config.maxTimeoutExtensions, lastTuiHeartbeats);
        } catch {
          // Non-fatal.
        }
      },
    });
  }

  const handleEngineSnapshot = ({ state, pollSnapshot: snapshot, runtime, pollIntervalMs, interactiveTiming }: WatchEngineSnapshotEvent) => {
    if (isInteractiveEngineChild) {
      try {
        writeStateFile(projectRoot, state);
      } catch {
        // Non-fatal.
      }
      process.stdout.write(JSON.stringify({
        type: "snapshot",
        event: {
          state,
          pollSnapshot: snapshot,
          runtime,
          ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
          ...(interactiveTiming ? { interactiveTiming } : {}),
        },
      } satisfies InteractiveEngineTransportMessage) + "\n");
      return;
    }
    lastTuiItems = orch.getAllItems();
    lastTuiHeartbeats = new Map(
      state.items
        .filter((item) => item.progress != null && item.progressLabel && item.progressTs)
        .map((item) => [
          item.id,
          {
            id: item.id,
            progress: item.progress!,
            label: item.progressLabel!,
            ts: item.progressTs!,
            ...(item.prNumber != null ? { prNumber: item.prNumber } : {}),
          },
        ]),
    );
    applyRuntimeSnapshotToTuiState(tuiState, runtime);
    updateRuntimeCollaborationBindings();
    try {
      writeStateFile(projectRoot, state);
    } catch {
      // Non-fatal -- state persistence failure shouldn't block the orchestrator
    }
    // TUI mode: render panel frame to stdout after each poll cycle
    if (tuiMode) {
      const renderStartMs = interactiveTiming ? Date.now() : 0;
      try {
        renderTuiPanelFrame(lastTuiItems, sessionLimit, tuiState, undefined, getRemoteItemSnapshots(), orch.config.maxTimeoutExtensions, lastTuiHeartbeats);
      } catch {
        // Non-fatal -- TUI render failure shouldn't block the orchestrator
      }
      if (interactiveTiming) {
        interactiveTiming.timingsMs.render = Math.max(0, Date.now() - renderStartMs);
      }
    }
  };

  if (isDaemonChild) {
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "daemon_child_started",
      pid: process.pid,
    });
  }

  // Build external review deps when review_external is enabled
  const externalReviewDeps: ExternalReviewDeps | undefined = reviewExternalEnabled
    ? {
        scanExternalPRs: (root) => scanExternalPRs(root),
        launchReview: (prNumber, repoRoot) => {
          const autoFix = orch.config.reviewAutoFix;
          const extItemId = `ext-${prNumber}`;
          const result = launchReviewWorker(prNumber, extItemId, autoFix, repoRoot, aiTool, mux, {
            reviewType: "external",
            hubRepoNwo,
            projectRoot,
            resolveMux: resolveLaunchMux,
          });
          if (!result) return null;
          return { workspaceRef: result.workspaceRef };
        },
        cleanReview: (reviewWorkspaceRef) => {
          try { muxForWorkspaceRef(reviewWorkspaceRef).closeWorkspace(reviewWorkspaceRef); } catch { /* best-effort */ }
          return true;
        },
        log,
      }
    : undefined;

  if (reviewExternalEnabled) {
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "review_external_enabled",
    });
  }

  const requestQueue = new RequestQueue({ log });

  const loopDeps: OrchestrateLoopDeps = {
    buildSnapshot: (o, pr, wd) => buildSnapshotAsync(o, pr, wd, mux, undefined, undefined, fetchTrustedPrCommentsAsync, ghCheckCommitCIAsync, undefined, undefined, requestQueue),
    sleep: (ms) => interruptibleSleep(ms, abortController.signal),
    log,
    actionDeps,
    getFreeMem: getAvailableMemory,
    reconcile,
    readScreen: (ref, lines) => muxForWorkspaceRef(ref).readScreen(ref, lines),
    syncDisplay: (o, snap) => {
      syncWorkerDisplay(o, snap, mux, projectRoot);
      tuiState.viewOptions.apiErrorCount = snap.apiErrorCount ?? 0;
      tuiState.viewOptions.apiErrorSummary = snap.apiErrorSummary;
      tuiState.viewOptions.rateLimitBackoffDescription = snap.rateLimitBackoffDescription;
    },
    externalReviewDeps,
    ...(watchMode ? { scanWorkItems: () => {
      return loadDiscoveryWorkItems("watch-scan");
    } } : {}),
    ...(crewBroker ? { crewBroker } : {}),
    requestQueue,
    // Completion prompt for TUI mode: render banner + wait for keypress
    ...(tuiMode ? {
      completionPrompt: async (allItems, runStartTime) => {
        // Remove the orchestrate keyboard handler so keys are routed to the prompt
        cleanupKeyboard();
        // Render the completion banner on screen
        const bannerLines = formatCompletionBanner(allItems, runStartTime);
        const write = (s: string) => process.stdout.write(s);
        write("\x1B[H"); // cursor home
        // Re-render the current TUI frame first (to show final state)
        renderTuiPanelFrame(allItems, sessionLimit, tuiState, write, getRemoteItemSnapshots(), orch.config.maxTimeoutExtensions, lastTuiHeartbeats);
        // Overlay the banner at the bottom
        const termRows = getTerminalHeight();
        const startRow = Math.max(1, termRows - bannerLines.length);
        write(`\x1B[${startRow};1H`);
        for (const line of bannerLines) {
          write(line + "\x1B[K\n");
        }
        // Wait for completion key
        const action = await waitForCompletionKey(process.stdin, abortController.signal);
        // Restore the keyboard handler if we're continuing (run-more)
        if (action === "run-more") {
          cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);
        }
        return action;
      },
    } : {}),
  };

  updateRuntimeCollaborationBindings = () => {
    loopDeps.crewBroker = crewBroker;
    tuiState.sessionCode = crewCode ?? undefined;
    if (crewBroker && crewCode) {
      const crewStatus = crewBroker.getCrewStatus();
      tuiState.viewOptions.crewStatus = {
        crewCode: crewStatus?.crewCode ?? crewCode,
        daemonCount: crewStatus?.daemonCount ?? 0,
        availableCount: crewStatus?.availableCount ?? 0,
        claimedCount: crewStatus?.claimedCount ?? 0,
        completedCount: crewStatus?.completedCount ?? 0,
        connected: crewBroker.isConnected(),
      };
      return;
    }
    tuiState.viewOptions.crewStatus = undefined;
  };
  updateRuntimeCollaborationBindings();

  // Resolve repo URL for PR URL construction in completion event
  let repoUrl: string | undefined;
  try {
    const ownerRepo = getRepoOwner(projectRoot);
    repoUrl = `https://github.com/${ownerRepo}`;
  } catch {
    // Non-fatal -- PR URLs will be null in completion event
  }

  const loopConfig: OrchestrateLoopConfig = {
    ...(pollIntervalOverride ? { pollIntervalMs: pollIntervalOverride } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    aiTool,
    ...(reviewExternalEnabled ? { reviewExternal: true } : {}),
    ...(watchMode ? { watch: true } : {}),
    ...(watchIntervalSecs !== undefined ? { watchIntervalMs: watchIntervalSecs * 1000 } : {}),
    ...(tuiMode ? { tuiMode: true } : {}),
  };

  const buildEngineState = (
    items: OrchestratorItem[],
    heartbeats: ReadonlyMap<string, WorkerProgress>,
    _snapshot: PollSnapshot,
    inboxSnapshots: ReadonlyMap<string, InboxSnapshot>,
  ) => {
    const crewStatus = crewBroker?.getCrewStatus();
    return serializeOrchestratorState(items, process.pid, daemonStartedAt, {
      statusPaneRef: null,
      sessionLimit,
      operatorId,
      remoteItemSnapshots: crewStatusToRemoteItemSnapshots(crewStatus),
      heartbeats,
      inboxSnapshots,
      crewStatus: crewStatusToDaemonCrewStatus(crewStatus, crewCode, crewBroker?.isConnected() ?? false),
      ...(tuiState.viewOptions.emptyState ? { emptyState: tuiState.viewOptions.emptyState } : {}),
    });
  };

  const engineRunner = (isInteractiveEngineChild
    ? createInteractiveChildEngineRunner
    : isDaemonChild
      ? createDetachedDaemonEngineRunner
      : createWatchEngineRunner)({
    orch,
    ctx,
    loopDeps,
    loopConfig,
    runLoop: orchestrateLoop,
    emitLog: log,
    emitSnapshot: handleEngineSnapshot,
    buildState: buildEngineState,
    initialReviewMode,
    initialCollaborationMode,
    getSessionLimit: () => sessionLimit,
    setSessionLimit: (limit) => {
      sessionLimit = limit;
    },
  });
  emitInteractiveEngineStartupOverlay(isInteractiveEngineChild, INTERACTIVE_STARTUP_OVERLAYS.startingEngine);
  sendRuntimeControl = engineRunner.sendControl;

  if (isInteractiveEngineChild) {
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    let controlBuffer = "";
    const handleInteractiveEngineControl = async (command: WatchEngineControlCommand) => {
      if (command.type !== "runtime-collaboration") {
        sendRuntimeControl(command);
        return;
      }

      const result = await applyLocalRuntimeCollaborationAction({
        action: command.action,
        ...(command.code ? { code: command.code } : {}),
        ...(command.source ? { source: command.source } : {}),
      });

      if (!result.error && result.mode) {
        sendRuntimeControl({
          type: "set-collaboration-mode",
          mode: result.mode,
          ...(result.code ? { code: result.code } : {}),
          ...(command.source ? { source: command.source } : {}),
        });
      }

      process.stdout.write(JSON.stringify({
        type: "control-result",
        requestId: command.requestId,
        result,
      } satisfies InteractiveEngineTransportMessage) + "\n");
    };
    process.stdin.on("data", (chunk: string | Buffer) => {
      controlBuffer += chunk.toString();
      const lines = controlBuffer.split("\n");
      controlBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const command = JSON.parse(trimmed) as WatchEngineControlCommand;
          void handleInteractiveEngineControl(command);
        } catch {
          // Ignore malformed control commands.
        }
      }
    });
  }

  // Set up keyboard shortcuts in TUI mode (q, Ctrl-C, m, d, ?, ↑/↓)
  let cleanupKeyboard = () => {};
  if (tuiMode) {
    cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);
  }

  // Enter alternate screen buffer so TUI renders don't pollute terminal scrollback.
  // The matching ALT_SCREEN_OFF is in the finally block below + a process.on('exit') safety net.
  if (tuiMode) {
    process.stdout.write(ALT_SCREEN_ON);
  }
  const exitAltScreen = () => {
    if (tuiMode) process.stdout.write(ALT_SCREEN_OFF);
  };
  process.on("exit", exitAltScreen);

  // Show session splash screen on startup (auto-dismisses after 3s or any keypress)
  if (tuiMode && crewCode) {
    const termWidth = getTerminalWidth();
    const termRows = getTerminalHeight();
    const BRAND_ANSI = "\x1B[38;2;212;160;48m"; // #D4A030
    const lines: string[] = [];
    const centerLine = (text: string, plainLen: number) => {
      const pad = Math.max(0, Math.floor((termWidth - plainLen) / 2));
      return " ".repeat(pad) + text;
    };
    const midRow = Math.floor(termRows / 2) - 3;
    for (let i = 0; i < midRow; i++) lines.push("");
    lines.push(centerLine(`\x1B[1m${BRAND_ANSI}${crewCode}\x1B[0m`, crewCode.length));
    lines.push("");
    const dashboardUrl = `ninthwave.sh/stats/${crewCode}`;
    lines.push(centerLine(`\x1B[2m${dashboardUrl}\x1B[0m`, dashboardUrl.length));
    const inviteCmd = `Join: nw --crew ${crewCode}`;
    lines.push(centerLine(`\x1B[2m${inviteCmd}\x1B[0m`, inviteCmd.length));
    lines.push("");
    lines.push(centerLine("\x1B[2mPress ? for help\x1B[0m", 16));
    process.stdout.write("\x1B[H" + lines.join("\x1B[K\n") + "\x1B[J");

    // Auto-dismiss after 3s or any keypress (whichever first)
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      new Promise<void>((resolve) => {
        const onData = () => {
          process.stdin.removeListener("data", onData);
          resolve();
        };
        process.stdin.on("data", onData);
      }),
    ]);
  }

  // Show tmux attach splash screen on startup (dismissed by any keypress)
  if (tuiMode && tmuxOutsideSession && tmuxSessionName) {
    const termWidth = getTerminalWidth();
    const termRows = getTerminalHeight();
    const lines: string[] = [];
    const centerLine = (text: string, plainLen: number) => {
      const pad = Math.max(0, Math.floor((termWidth - plainLen) / 2));
      return " ".repeat(pad) + text;
    };
    const attachCmd = `tmux attach -t ${tmuxSessionName}`;
    const midRow = Math.floor(termRows / 2) - 2;
    for (let i = 0; i < midRow; i++) lines.push("");
    lines.push(centerLine(`\x1B[1m\x1B[36m${attachCmd}\x1B[0m`, attachCmd.length));
    lines.push("");
    lines.push(centerLine("\x1B[2mPress ? for help  |  Press any key to continue\x1B[0m", 47));
    process.stdout.write("\x1B[H" + lines.join("\x1B[K\n") + "\x1B[J");

    await new Promise<void>((resolve) => {
      const onData = () => {
        process.stdin.removeListener("data", onData);
        resolve();
      };
      process.stdin.on("data", onData);
    });
  }

  // Write PID file for foreground mode too (prevents duplicate instances)
  if (!isDaemonChild && !isInteractiveEngineChild) {
    writePidFile(projectRoot, process.pid);
  }

  try {
    // Run-more loop: re-enter interactive flow when the user picks [r] at the completion prompt
    let keepRunning = true;
    while (keepRunning) {
      if (tuiMode) {
        cleanupKeyboard();
        cleanupKeyboard = () => {};
        const childArgs = buildInteractiveEngineChildArgs(parsed, {
          itemIds: orch.getAllItems().map((item) => item.id),
          mergeStrategy: operatorLastSnapshot.runtime.mergeStrategy,
          sessionLimit: operatorLastSnapshot.runtime.sessionLimit,
          toolOverride,
          skipReview: operatorLastSnapshot.runtime.reviewMode === "off",
          reviewMode: operatorLastSnapshot.runtime.reviewMode,
          watchMode,
          futureOnlyStartup,
          crewCode,
          connectMode,
          crewUrl,
          crewName,
          bypassEnabled,
        });
        const operatorResult = await runInteractiveWatchOperatorSession({
          projectRoot,
          childArgs,
          tuiState,
          log,
          initialSnapshot: operatorLastSnapshot,
          watchMode,
          manageTerminal: false,
          manageKeyboard: true,
          abortController,
          bindControlSender: (sender) => {
            sendRuntimeControl = sender;
          },
          bindCollaborationRequester: (requester) => {
            requestCollaborationFromEngine = requester;
          },
        });
        operatorLastSnapshot = operatorResult.lastSnapshot;

        if (operatorResult.completionAction === "run-more") {
          cleanupKeyboard();
          const freshItems = loadDiscoveryWorkItems("run-more");
          const interactiveResult = await runInteractiveFlow(freshItems, operatorLastSnapshot.runtime.sessionLimit, {
            showConnectionStep: false,
          });
          if (!interactiveResult) {
            cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);
            break;
          }

          const freshMap = new Map<string, WorkItem>();
          for (const item of freshItems) freshMap.set(item.id, item);
          const nextIds: string[] = [];
          const nextItems: WorkItem[] = [];
          const newDomains = new Set<string>();
          for (const id of interactiveResult.itemIds) {
            const wi = freshMap.get(id);
            if (!wi) continue;
            nextIds.push(id);
            nextItems.push(wi);
            newDomains.add(wi.domain);
          }
          if (newDomains.size > 0) ensureDomainLabels(projectRoot, [...newDomains]);
          if (nextItems.length === 0) {
            cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);
            break;
          }
          const nextOrch = new Orchestrator({
            sessionLimit: operatorLastSnapshot.runtime.sessionLimit,
            mergeStrategy: operatorLastSnapshot.runtime.mergeStrategy,
            bypassEnabled,
            fixForward,
            skipReview: operatorLastSnapshot.runtime.reviewMode === "off",
            ...(reviewAutoFix !== undefined ? { reviewAutoFix } : {}),
          });
          for (const item of nextItems) nextOrch.addItem(item);
          const nextState = serializeOrchestratorState(nextOrch.getAllItems(), process.pid, daemonStartedAt, {
            sessionLimit: operatorLastSnapshot.runtime.sessionLimit,
            operatorId,
            ...(futureOnlyStartup ? { emptyState: "watch-armed" as const } : {}),
          });
          operatorLastSnapshot = {
            daemonState: nextState,
            runtime: operatorLastSnapshot.runtime,
          };
          orch = nextOrch;
          cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);
          log({
            ts: new Date().toISOString(),
            level: "info",
            event: "run_more_restart",
            newItems: nextIds,
          });
          continue;
        }

        if (operatorResult.completionAction === "clean") {
          for (const item of operatorLastSnapshot.daemonState.items) {
            if (item.state !== "done") continue;
            try {
              if (item.workspaceRef) muxForWorkspaceRef(item.workspaceRef).closeWorkspace(item.workspaceRef, item.id);
              cleanSingleWorktree(item.id, ctx.worktreeDir, ctx.projectRoot);
            } catch {
              // Best-effort cleanup.
            }
          }
        }

        keepRunning = false;
        continue;
      }

      maybeTriggerInteractiveEngineStartupFailureForTest(isInteractiveEngineChild);
      const result = await engineRunner.run(abortController.signal);

      if (isInteractiveEngineChild) {
        process.stdout.write(JSON.stringify({ type: "result", result } satisfies InteractiveEngineTransportMessage) + "\n");
      }

      if (result.completionAction === "run-more" && tuiMode) {
        // Release keyboard shortcuts so TUI widgets can handle raw keys
        cleanupKeyboard();

        // Re-parse work items and re-enter interactive selection
        // Widgets render in the same alt-screen buffer -- no screen switch needed
        // showConnectionStep: false because session is already established
        const freshItems = loadDiscoveryWorkItems("run-more");
        const interactiveResult = await runInteractiveFlow(freshItems, sessionLimit, {
          showConnectionStep: false,
        });
        if (!interactiveResult) {
          // User cancelled selection -- restore keyboard and exit loop
          cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);
          break;
        }

        // Add newly selected items to the orchestrator
        const freshMap = new Map<string, WorkItem>();
        for (const item of freshItems) freshMap.set(item.id, item);
        const newDomains = new Set<string>();
        for (const id of interactiveResult.itemIds) {
          const wi = freshMap.get(id);
          if (wi && !orch.getItem(id)) {
            orch.addItem(wi);
            newDomains.add(wi.domain);
          }
        }
        if (newDomains.size > 0) ensureDomainLabels(projectRoot, [...newDomains]);
        // Local-first: keep current session's merge/review/session-limit policy.
        // The interactive flow only selects items and AI tools.

        // Restore keyboard shortcuts for the main TUI
        cleanupKeyboard = setupKeyboardShortcuts(abortController, log, process.stdin, tuiState);

        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "run_more_restart",
          newItems: interactiveResult.itemIds,
        });
        continue; // Restart the orchestrate loop
      }

      keepRunning = false;
    }
  } finally {
    if (!usedInteractiveOperatorParentSession) {
      // Close workspaces for terminal items only (done, stuck, merged).
      // In-flight workers (implementing, ci-pending, etc.) may still be actively
      // running -- leave their workspaces open so they survive orchestrator restarts.
      // On restart, reconstructState recovers their workspace refs.
      const terminalStates = new Set(["done", "blocked", "stuck", "merged"]);
      const closedWorkspaces: string[] = [];
      for (const item of orch.getAllItems()) {
        if (terminalStates.has(item.state) && item.workspaceRef) {
          try {
            muxForWorkspaceRef(item.workspaceRef).closeWorkspace(item.workspaceRef, item.id);
            closedWorkspaces.push(item.id);
          } catch {
            // Non-fatal -- best-effort cleanup
          }
        }
      }
      if (closedWorkspaces.length > 0) {
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "shutdown_workspaces_closed",
          itemIds: closedWorkspaces,
          count: closedWorkspaces.length,
        });
      }

      // Leave alternate screen buffer before restoring terminal state
      exitAltScreen();
      process.removeListener("exit", exitAltScreen);

      // Print exit summary to stdout (persists in terminal scrollback)
      if (tuiMode) {
        const allItems = operatorLastSnapshot.daemonState.items;
        if (allItems.length > 0) {
          const summary = formatExitSummary(allItems, operatorLastSnapshot.daemonState.startedAt);
          console.log(summary);
        }
      }

      // Restore terminal state (disable raw mode)
      cleanupKeyboard();

      // Clean up crew broker
      if (crewBroker) {
        try { crewBroker.disconnect(); } catch { /* best-effort */ }
      }

      // Release the session lock but preserve the restart snapshot for the next run.
      cleanupWatchRuntimeFiles(projectRoot, { cleanPid: !isInteractiveEngineChild });
      if (isDaemonChild) {
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "daemon_child_exiting",
          pid: process.pid,
        });
      }

      process.removeListener("SIGINT", sigintHandler);
      process.removeListener("SIGTERM", sigtermHandler);
    }
  }
  } catch (error) {
    if (!parsed.isInteractiveEngineChild) throw error;
    try {
      process.stdout.write(JSON.stringify({
        type: "fatal",
        error: formatInteractiveEngineFatal(error),
      } satisfies InteractiveEngineTransportMessage) + "\n");
    } catch {
      // Last-ditch reporting only.
    }
    process.exit(1);
  }
}
