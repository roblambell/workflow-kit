// orchestrate command: event loop for parallel work item processing.
// Parses args, reconstructs state from disk/GitHub, runs the poll→transition→execute loop,
// emits structured JSON logs, and handles graceful SIGINT/SIGTERM shutdown.
// Supports daemon mode (--daemon) for background operation with state persistence.

import { existsSync, mkdirSync, readdirSync, appendFileSync } from "fs";
import { join, basename, dirname } from "path";
import { totalmem, freemem, hostname } from "os";
import { randomUUID } from "crypto";
import { execSync, spawn } from "node:child_process";
import { getAvailableMemory } from "../memory.ts";
import {
  Orchestrator,
  DEFAULT_CONFIG,
  calculateMemoryWipLimit,
  statusDisplayForState,
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
import { resolveRepo, bootstrapRepo } from "../cross-repo.ts";
import { scanExternalPRs, checkPrStatusDetailed, type PrStatusPollResult } from "./pr-monitor.ts";
import type { ConnectionAction } from "./crew.ts";
import { launchSingleItem, launchReviewWorker, launchRebaserWorker, launchForwardFixerWorker } from "./launch.ts";
import { cleanStaleBranchForReuse } from "../branch-cleanup.ts";
import { selectAiTools, detectInstalledAITools } from "../tool-select.ts";
import { cleanSingleWorktree } from "./clean.ts";
import { writeInbox } from "./inbox.ts";
import { prMerge, prComment, checkPrMergeable, getRepoOwner, applyGithubToken, fetchTrustedPrCommentsAsync, upsertOrchestratorComment, setCommitStatus as ghSetCommitStatus, prHeadSha, getMergeCommitSha as ghGetMergeCommitSha, checkCommitCI as ghCheckCommitCI, checkCommitCIAsync as ghCheckCommitCIAsync, getDefaultBranch as ghGetDefaultBranch, ensureDomainLabels, listPrComments, updatePrComment, ghFailureKindLabel } from "../gh.ts";
import { fetchOrigin, ffMerge, gitAdd, gitCommit, gitPush, daemonRebase } from "../git.ts";
import { run } from "../shell.ts";
import { type Multiplexer, createMux, muxTypeForWorkspaceRef, resolveBackend } from "../mux.ts";
import { resolveCmuxBinary } from "../cmux-resolve.ts";
import { resolveSessionName } from "../tmux.ts";
import { reconcile } from "./reconcile.ts";
import { die, warn, info, ALT_SCREEN_ON, ALT_SCREEN_OFF, BOLD, RED, RESET } from "../output.ts";
import { confirmPrompt } from "../prompt.ts";
import { shouldEnterInteractive, runInteractiveFlow } from "../interactive.ts";
import type { WorkItem, LogEntry } from "../types.ts";
import { ID_IN_FILENAME, PRIORITY_NUM } from "../types.ts";
import { loadConfig, saveConfig, loadUserConfig, saveUserConfig } from "../config.ts";
import type { ProjectConfig, UserConfig } from "../config.ts";
import {
  persistedCollaborationModeToRuntime,
  resolveTuiSettingsDefaults,
  type TuiSettingsDefaults,
} from "../tui-settings.ts";
import { preflight } from "../preflight.ts";
import {
  collectRunMetrics,
  parseWorkerTelemetry,
} from "../analytics.ts";
import { parseAgentModel, readAgentFileContent } from "../agent-files.ts";
import { readLatestTokenUsage } from "../token-usage.ts";
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
  buildDisplayPrContext,
  buildVisibleStatusLayoutMetadata,
  daemonStateToStatusItems,
  formatStatusTable,
  mapDaemonItemState,
  normalizeRemoteItemState,
  getTerminalWidth,
  getTerminalHeight,
  buildStatusLayout,
  renderFullScreenFrame,
  renderHelpOverlay,
  renderControlsOverlay,
  renderDetailOverlay,
  clampScrollOffset,
  scrollStatusItemIntoView,
  buildPanelLayout,
  renderPanelFrame,
  MIN_FULLSCREEN_ROWS,
  type StatusItem,
  type ViewOptions,
  type CrewStatusInfo,
  type PanelMode,
  type LogEntry as PanelLogEntry,
} from "../status-render.ts";
import type { CrewBroker, CrewRemoteItemSnapshot, CrewStatus, SyncItem } from "../crew.ts";
import { WebSocketCrewBroker, resolveOperatorId, saveCrewCode } from "../crew.ts";
import { AuthorCache } from "../git-author.ts";
import {
  readScheduleState,
  writeScheduleState,
} from "../schedule-state.ts";
import {
  launchScheduledTask,
  scheduleTriggerDir,
} from "../schedule-runner.ts";
import { listScheduledTasks as listScheduledTasksFromDir } from "../schedule-files.ts";
import { classifyPrMetadataMatch, type PrMetadataMatchMode } from "../work-item-files.ts";
import {
  getPassiveUpdateState,
  getPassiveUpdateStartupState,
  type PassiveUpdateState,
  type PassiveUpdateStartupState,
} from "../update-check.ts";
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
  filterLogsByLevel,
  pushLogBuffer,
  LOG_BUFFER_MAX,
  LOG_LEVEL_CYCLE,
  type TuiState,
  type LogLevelFilter,
} from "../tui-keyboard.ts";
import { processExternalReviews, type ExternalReviewDeps } from "../external-review.ts";
import { processScheduledTasks, type ScheduleLoopDeps } from "../schedule-processing.ts";
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
// ── Re-exports for backward compatibility ────────────────────────────
// These keep existing importers (tests, other modules) working without changes.
export { buildSnapshotAsync, isWorkerAlive, isWorkerAliveWithCache, getWorktreeLastCommitTime, getWorktreeLastCommitTimeAsync } from "../snapshot.ts";
export { buildSnapshot } from "../snapshot.ts";
export { reconstructState } from "../reconstruct.ts";
export { parseWatchArgs, validateItemIds, type ParsedWatchArgs } from "./watch-args.ts";
export { setupKeyboardShortcuts, applyRuntimeSnapshotToTuiState, filterLogsByLevel, pushLogBuffer, LOG_BUFFER_MAX, REVIEW_MODE_CYCLE, COLLABORATION_MODE_CYCLE, type TuiState, type TuiRuntimeSnapshot, type LogLevelFilter, type CollaborationMode, type ReviewMode } from "../tui-keyboard.ts";
export { processExternalReviews, type ExternalReviewDeps } from "../external-review.ts";
export { processScheduledTasks, type ScheduleLoopDeps } from "../schedule-processing.ts";
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
export type { LogEntry } from "../types.ts";

// ── Structured logging ─────────────────────────────────────────────

export function structuredLog(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

export interface StartupReplayPrune {
  id: string;
  prNumber?: number;
  matchMode: PrMetadataMatchMode;
}

export interface StartupReplayPruneResult {
  activeItems: WorkItem[];
  prunedItems: StartupReplayPrune[];
}

function normalizePrPollResult(result: string | null | PrStatusPollResult): PrStatusPollResult {
  if (typeof result === "string" || result == null) {
    return { statusLine: result ?? "" };
  }
  return result;
}

export function pruneMergedStartupReplayItems(
  workItems: WorkItem[],
  projectRoot: string,
  checkPr: (id: string, projectRoot: string) => string | null | PrStatusPollResult = checkPrStatusDetailed,
): StartupReplayPruneResult {
  const activeItems: WorkItem[] = [];
  const prunedItems: StartupReplayPrune[] = [];

  for (const item of workItems) {
    const statusLine = normalizePrPollResult(checkPr(item.id, projectRoot)).statusLine;
    if (!statusLine) {
      activeItems.push(item);
      continue;
    }

    const parts = statusLine.split("\t");
    const status = parts[2];
    if (status !== "merged") {
      activeItems.push(item);
      continue;
    }

    const prNumber = parts[1] ? parseInt(parts[1]!, 10) : undefined;
    const match = classifyPrMetadataMatch(
      {
        title: parts[5] ?? "",
        lineageToken: parts[6] ?? "",
      },
      item,
    );

    if (!match.matches) {
      activeItems.push(item);
      continue;
    }

    prunedItems.push({
      id: item.id,
      ...(prNumber != null ? { prNumber } : {}),
      matchMode: match.mode,
    });
  }

  return { activeItems, prunedItems };
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
  skipToolStep: boolean;
}

export function resolveInteractiveStartupConfig(
  _projectConfig: ProjectConfig,
  userConfig: UserConfig,
  toolOverride?: string,
): InteractiveStartupConfig {
  return {
    defaults: resolveTuiSettingsDefaults(userConfig),
    savedToolIds: userConfig.ai_tools,
    skipToolStep: !!toolOverride || (userConfig.ai_tools?.length ?? 0) > 0,
  };
}

export const INTERACTIVE_WATCH_STAGE_WARN_MS = {
  eventLoopLag: 150,
  poll: 250,
  actionExecution: 250,
  mainRefresh: 250,
  displaySync: 100,
  render: 100,
} as const;

export type InteractiveWatchStageName = keyof typeof INTERACTIVE_WATCH_STAGE_WARN_MS;

export interface InteractiveWatchTimingsMs {
  eventLoopLag: number;
  poll: number;
  actionExecution: number;
  mainRefresh: number;
  displaySync: number;
  render: number;
  totalBlocking: number;
}

export interface InteractiveWatchTiming {
  iteration: number;
  actionCount: number;
  actionTypes: Action["type"][];
  timingsMs: InteractiveWatchTimingsMs;
}

export interface EventLoopLagSnapshot {
  maxLagMs: number;
  sampleCount: number;
  lastSampleAtMs?: number;
}

export interface EventLoopLagSamplerDeps {
  sampleIntervalMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface EventLoopLagSampler {
  start: () => void;
  stop: () => void;
  drain: () => EventLoopLagSnapshot;
}

const INTERACTIVE_WATCH_LAG_SAMPLE_INTERVAL_MS = 50;
const INTERACTIVE_WATCH_STAGE_LOG_NAMES: Record<InteractiveWatchStageName, string> = {
  eventLoopLag: "event_loop_lag",
  poll: "poll",
  actionExecution: "action_execution",
  mainRefresh: "main_refresh",
  displaySync: "display_sync",
  render: "render",
};

function createInteractiveWatchTiming(iteration: number, actionTypes: Action["type"][]): InteractiveWatchTiming {
  return {
    iteration,
    actionCount: actionTypes.length,
    actionTypes,
    timingsMs: {
      eventLoopLag: 0,
      poll: 0,
      actionExecution: 0,
      mainRefresh: 0,
      displaySync: 0,
      render: 0,
      totalBlocking: 0,
    },
  };
}

function elapsedMs(nowMs: () => number, startMs: number): number {
  return Math.max(0, nowMs() - startMs);
}

function finalizeInteractiveWatchTiming(
  log: (entry: LogEntry) => void,
  timing: InteractiveWatchTiming,
  eventLoopLagMs: number,
): void {
  timing.timingsMs.eventLoopLag = eventLoopLagMs;
  timing.timingsMs.totalBlocking = timing.timingsMs.poll
    + timing.timingsMs.actionExecution
    + timing.timingsMs.mainRefresh
    + timing.timingsMs.displaySync
    + timing.timingsMs.render;

  log({
    ts: new Date().toISOString(),
    level: "info",
    event: "interactive_watch_timing",
    iteration: timing.iteration,
    actionCount: timing.actionCount,
    actionTypes: timing.actionTypes,
    timingsMs: timing.timingsMs,
  });

  for (const stage of Object.keys(INTERACTIVE_WATCH_STAGE_WARN_MS) as InteractiveWatchStageName[]) {
    const durationMs = timing.timingsMs[stage];
    const thresholdMs = INTERACTIVE_WATCH_STAGE_WARN_MS[stage];
    if (durationMs < thresholdMs) continue;
    log({
      ts: new Date().toISOString(),
      level: "warn",
      event: "interactive_watch_stall",
      iteration: timing.iteration,
      stage: INTERACTIVE_WATCH_STAGE_LOG_NAMES[stage],
      durationMs,
      thresholdMs,
      actionCount: timing.actionCount,
      actionTypes: timing.actionTypes,
      timingsMs: timing.timingsMs,
      message: `Interactive watch ${INTERACTIVE_WATCH_STAGE_LOG_NAMES[stage]} took ${durationMs}ms`,
    });
  }
}

export function createEventLoopLagSampler(
  deps: EventLoopLagSamplerDeps = {},
): EventLoopLagSampler {
  const now = deps.now ?? Date.now;
  const sampleIntervalMs = deps.sampleIntervalMs ?? INTERACTIVE_WATCH_LAG_SAMPLE_INTERVAL_MS;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let expectedAtMs = 0;
  let running = false;
  let maxLagMs = 0;
  let sampleCount = 0;
  let lastSampleAtMs: number | undefined;

  const schedule = () => {
    expectedAtMs = now() + sampleIntervalMs;
    timer = setTimeoutFn(() => {
      const sampledAtMs = now();
      const lagMs = Math.max(0, sampledAtMs - expectedAtMs);
      maxLagMs = Math.max(maxLagMs, lagMs);
      sampleCount += 1;
      lastSampleAtMs = sampledAtMs;
      if (running) schedule();
    }, sampleIntervalMs);
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      schedule();
    },
    stop: () => {
      running = false;
      if (timer) {
        clearTimeoutFn(timer);
        timer = undefined;
      }
    },
    drain: () => {
      const snapshot = { maxLagMs, sampleCount, lastSampleAtMs };
      maxLagMs = 0;
      sampleCount = 0;
      lastSampleAtMs = undefined;
      return snapshot;
    },
  };
}
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
  mergeStrategy: MergeStrategy;
  wipLimit: number;
  reviewMode: "off" | "ninthwave-prs" | "all-prs";
  collaborationMode: "local" | "shared" | "joined";
}

export interface InteractiveEngineSnapshotRenderState {
  daemonState: DaemonState;
  runtime: InteractiveEngineTransportRuntime;
  pollIntervalMs?: number;
  interactiveTiming?: InteractiveWatchTiming;
}

export type InteractiveEngineTransportMessage =
  | { type: "snapshot"; event: WatchEngineSnapshotEvent }
  | { type: "log"; entry: LogEntry }
  | { type: "result"; result: OrchestrateLoopResult }
  | { type: "control-result"; requestId: string; result: RuntimeCollaborationActionResult }
  | { type: "fatal"; error: string };

export const TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_ENV = "NINTHWAVE_TEST_ENGINE_STARTUP_FAIL";
export const TEST_INTERACTIVE_ENGINE_STARTUP_FAIL_MESSAGE = "Test-only forced interactive engine startup failure.";

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
    wipLimit: number;
    toolOverride?: string;
    skipReview: boolean;
    reviewMode: "off" | "ninthwave-prs" | "all-prs";
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
    "--wip-limit",
    String(resolved.wipLimit),
  ];

  if (parsed.pollIntervalOverride !== undefined) {
    childArgs.push("--poll-interval", String(Math.max(1, Math.round(parsed.pollIntervalOverride / 1000))));
  }
  if (parsed.clickupListId) childArgs.push("--clickup-list", parsed.clickupListId);
  if (parsed.reviewAutoFix) childArgs.push("--review-auto-fix", parsed.reviewAutoFix);
  if (parsed.reviewExternal || resolved.reviewMode === "all-prs") childArgs.push("--review-external");
  if (parsed.reviewWipLimit !== undefined) childArgs.push("--review-wip-limit", String(parsed.reviewWipLimit));
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

const DEFAULT_CREW_URL = "wss://ninthwave.sh";

export function resolveStartupCollaborationAction(
  current: {
    connectMode: boolean;
    crewCode?: string;
    crewUrl?: string;
  },
  connectionAction: ConnectionAction | null | undefined,
): {
  connectMode: boolean;
  crewCode?: string;
  crewUrl?: string;
} {
  if (!connectionAction) return current;
  if (connectionAction.type === "connect") {
    return {
      connectMode: true,
      crewCode: undefined,
      crewUrl: current.crewUrl,
    };
  }
  return {
    connectMode: false,
    crewCode: connectionAction.code,
    crewUrl: current.crewUrl ?? DEFAULT_CREW_URL,
  };
}

export interface CollaborationSessionState {
  mode: "local" | "shared" | "joined";
  crewCode?: string;
  crewUrl?: string;
  crewBroker?: CrewBroker;
  connectMode: boolean;
}

export interface CollaborationSessionBrokerInfo {
  mode: CollaborationSessionState["mode"];
  crewCode?: string;
}

export interface ApplyRuntimeCollaborationActionDeps {
  projectRoot: string;
  crewRepoUrl: string;
  crewName?: string;
  log: (entry: LogEntry) => void;
  fetchFn?: typeof fetch;
  saveCrewCodeFn?: typeof saveCrewCode;
  createBroker?: (
    projectRoot: string,
    crewUrl: string,
    crewCode: string,
    crewRepoUrl: string,
    deps: ConstructorParameters<typeof WebSocketCrewBroker>[4],
    crewName?: string,
  ) => CrewBroker;
  onBrokerChanged?: (broker: CrewBroker | undefined, info: CollaborationSessionBrokerInfo) => void;
}

function resolveCrewSocketUrl(crewUrl?: string): string {
  return crewUrl ?? DEFAULT_CREW_URL;
}

function resolveCrewHttpUrl(crewUrl?: string): string {
  return resolveCrewSocketUrl(crewUrl).replace(/^wss?:\/\//, "https://");
}

async function createCrewCode(
  crewUrl: string | undefined,
  crewRepoUrl: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const response = await fetchFn(`${resolveCrewHttpUrl(crewUrl)}/api/crews`, {
    method: "POST",
    body: JSON.stringify({ repoUrl: crewRepoUrl }),
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create session: ${response.status}${body ? ` ${body}` : ""}`);
  }

  const payload = await response.json() as { code?: string };
  if (!payload.code) {
    throw new Error("Failed to create session: missing crew code");
  }
  return payload.code;
}

function createCrewBrokerInstance(
  projectRoot: string,
  crewUrl: string,
  crewCode: string,
  crewRepoUrl: string,
  log: (entry: LogEntry) => void,
  crewName?: string,
  createBroker?: ApplyRuntimeCollaborationActionDeps["createBroker"],
): CrewBroker {
  const resolvedName = crewName ?? hostname();
  if (createBroker) {
    return createBroker(
      projectRoot,
      crewUrl,
      crewCode,
      crewRepoUrl,
      { log: (level, msg) => log({ ts: new Date().toISOString(), level, event: "crew_client", message: msg }) },
      resolvedName,
    );
  }
  return new WebSocketCrewBroker(
    projectRoot,
    crewUrl,
    crewCode,
    crewRepoUrl,
    { log: (level, msg) => log({ ts: new Date().toISOString(), level, event: "crew_client", message: msg }) },
    resolvedName,
  );
}

export async function applyRuntimeCollaborationAction(
  state: CollaborationSessionState,
  request: RuntimeCollaborationActionRequest,
  deps: ApplyRuntimeCollaborationActionDeps,
): Promise<RuntimeCollaborationActionResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const saveCrewCodeFn = deps.saveCrewCodeFn ?? saveCrewCode;

  if (request.action === "local") {
    state.crewBroker?.disconnect();
    state.crewBroker = undefined;
    state.crewCode = undefined;
    state.connectMode = false;
    state.mode = "local";
    deps.onBrokerChanged?.(undefined, { mode: "local" });
    deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_local_selected" });
    return { mode: "local" };
  }

  if (request.action === "share"
    && state.mode === "shared"
    && state.crewCode
    && state.crewBroker?.isConnected()) {
    deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_share_reused", crewCode: state.crewCode });
    return { mode: "shared", code: state.crewCode };
  }

  const nextCrewUrl = resolveCrewSocketUrl(state.crewUrl);
  let nextCrewCode: string;
  try {
    nextCrewCode = request.action === "share"
      ? await createCrewCode(state.crewUrl, deps.crewRepoUrl, fetchFn)
      : (request.code ?? "").trim().toUpperCase();
  } catch (error) {
    deps.log({
      ts: new Date().toISOString(),
      level: "warn",
      event: request.action === "share" ? "runtime_share_failed" : "runtime_join_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (!nextCrewCode) {
    return { error: "Enter a session code to join." };
  }

  if (request.action === "share") {
    deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_share_created", crewCode: nextCrewCode });
  }

  const nextMode = request.action === "share" ? "shared" : "joined";
  const nextBroker = createCrewBrokerInstance(
    deps.projectRoot,
    nextCrewUrl,
    nextCrewCode,
    deps.crewRepoUrl,
    deps.log,
    deps.crewName,
    deps.createBroker,
  );

  try {
    await nextBroker.connect();
  } catch (error) {
    deps.log({
      ts: new Date().toISOString(),
      level: "warn",
      event: request.action === "share" ? "runtime_share_connect_failed" : "runtime_join_failed",
      crewCode: nextCrewCode,
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: error instanceof Error ? error.message : String(error) };
  }

  state.crewBroker?.disconnect();
  state.crewBroker = nextBroker;
  state.crewCode = nextCrewCode;
  state.crewUrl = nextCrewUrl;
  state.connectMode = request.action === "share";
  state.mode = nextMode;
  deps.onBrokerChanged?.(nextBroker, { mode: nextMode, crewCode: nextCrewCode });
  saveCrewCodeFn(deps.projectRoot, nextCrewCode);
  deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_crew_connected", crewCode: nextCrewCode, mode: nextMode });
  return { mode: nextMode, code: nextCrewCode };
}

export function spawnInteractiveEngineChild(
  childArgs: string[],
  projectRoot: string,
  spawnFn: typeof spawn = spawn,
): InteractiveEngineChildProcess {
  return spawnFn(process.argv[0]!, [process.argv[1]!, ...childArgs], {
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

/**
 * Convert OrchestratorItem[] to StatusItem[] for TUI rendering.
 * When broker-fed remote snapshots are provided, use them as the source of truth
 * for live crew rows instead of local inferred state.
 */
export type RemoteItemRenderState = ReadonlySet<string> | ReadonlyMap<string, CrewRemoteItemSnapshot>;

export function crewStatusToRemoteItemSnapshots(
  crewStatus: CrewStatus | null | undefined,
): Map<string, CrewRemoteItemSnapshot> | undefined {
  if (!crewStatus?.remoteItems?.length) return undefined;
  return new Map(crewStatus.remoteItems.map((item) => [item.id, item]));
}

function crewStatusToDaemonCrewStatus(
  crewStatus: CrewStatus | null | undefined,
  crewCode: string | null | undefined,
  connected: boolean,
): DaemonCrewStatus | undefined {
  if (!crewStatus && !crewCode) return undefined;
  return {
    crewCode: crewStatus?.crewCode ?? crewCode ?? "",
    daemonCount: crewStatus?.daemonCount ?? 0,
    availableCount: crewStatus?.availableCount ?? 0,
    claimedCount: crewStatus?.claimedCount ?? 0,
    completedCount: crewStatus?.completedCount ?? 0,
    connected,
  };
}

export function crewStatusToRemoteOwnedItemIds(
  crewStatus: CrewStatus | null | undefined,
): Set<string> | undefined {
  if (crewStatus?.remoteItems?.length) {
    const ownedIds = crewStatus.remoteItems
      .filter((item) => item.ownerDaemonId !== null)
      .map((item) => item.id);
    return ownedIds.length > 0 ? new Set(ownedIds) : undefined;
  }
  if (!crewStatus?.claimedItems?.length) return undefined;
  return new Set(crewStatus.claimedItems);
}

export function filterCrewRemoteWriteActions(
  actions: Action[],
  crewStatus: CrewStatus | null | undefined,
): Action[] {
  const remoteIds = crewStatusToRemoteOwnedItemIds(crewStatus);
  if (!remoteIds || remoteIds.size === 0) return actions;

  const WRITE_ACTIONS: ReadonlySet<string> = new Set([
    "merge", "clean", "retry", "rebase", "daemon-rebase",
    "launch-repair", "clean-repair", "launch-review", "clean-review",
    "launch-verifier", "clean-verifier", "workspace-close",
  ]);
  return actions.filter((action) => !(WRITE_ACTIONS.has(action.type) && remoteIds.has(action.itemId)));
}

export function orchestratorItemsToStatusItems(
  items: OrchestratorItem[],
  remoteItems?: RemoteItemRenderState,
  maxTimeoutExtensions: number = DEFAULT_CONFIG.maxTimeoutExtensions,
  heartbeats?: ReadonlyMap<string, WorkerProgress>,
): StatusItem[] {
  const now = Date.now();
  const remoteSnapshots = remoteItems instanceof Map ? remoteItems : undefined;
  const remoteIds = remoteItems instanceof Set ? remoteItems : undefined;
  return items.map((item) => {
    const remoteSnapshot = remoteSnapshots?.get(item.id);
    const heartbeat = remoteSnapshot ? undefined : heartbeats?.get(item.id);
    const mappedState = mapDaemonItemState(item.state, { rebaseRequested: item.rebaseRequested });
    const state = remoteSnapshot ? normalizeRemoteItemState(remoteSnapshot.state) : mappedState;
    const remote = remoteSnapshot
      ? remoteSnapshot.ownerDaemonId !== null
      : (remoteIds?.has(item.id) ?? false);
    const prContext = buildDisplayPrContext(
      item.prNumber,
      item.priorPrNumbers,
      remoteSnapshot ? (remoteSnapshot.prNumber ?? null) : undefined,
      remoteSnapshot?.priorPrNumbers,
    );

    return {
      id: item.id,
      title: remoteSnapshot?.title ?? item.workItem.title,
      ...(item.workItem.descriptionSnippet
        ? { descriptionSnippet: item.workItem.descriptionSnippet }
        : {}),
      state,
      prNumber: prContext.prNumber,
      ...(prContext.priorPrNumbers ? { priorPrNumbers: prContext.priorPrNumbers } : {}),
      ageMs: now - new Date(item.lastTransition).getTime(),
      timeoutRemainingMs: item.timeoutDeadline
        ? Math.max(0, new Date(item.timeoutDeadline).getTime() - now)
        : undefined,
      timeoutExtensions: item.timeoutDeadline
        ? `${item.timeoutExtensionCount ?? 0}/${maxTimeoutExtensions}`
        : undefined,
      repoLabel: item.resolvedRepoRoot ? basename(item.resolvedRepoRoot) : "",
      failureReason: item.failureReason,
      dependencies: item.workItem.dependencies ?? [],
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      exitCode: item.exitCode,
      stderrTail: item.stderrTail,
      remote,
      workspaceRef: item.workspaceRef,
      progress: heartbeat?.progress,
      progressLabel: heartbeat?.label,
      progressTs: heartbeat?.ts,
    };
  });
}

function muxForWorkspaceRef(workspaceRef: string, projectRoot: string): Multiplexer {
  return createMux(muxTypeForWorkspaceRef(workspaceRef), projectRoot);
}

export function getVisibleSelectableItemIds(items: StatusItem[]): string[] {
  return buildVisibleStatusLayoutMetadata(items).selectableItemIds;
}

export function normalizeSelectedItemId(
  nextVisibleItemIds: string[],
  selectedItemId?: string,
  previousVisibleItemIds: string[] = [],
): string | undefined {
  if (nextVisibleItemIds.length === 0) return undefined;
  if (!selectedItemId) return nextVisibleItemIds[0];
  if (nextVisibleItemIds.includes(selectedItemId)) return selectedItemId;

  const previousIndex = previousVisibleItemIds.indexOf(selectedItemId);
  if (previousIndex < 0) return nextVisibleItemIds[0];

  const nextVisibleItemIdSet = new Set(nextVisibleItemIds);
  for (let distance = 1; distance <= previousVisibleItemIds.length; distance++) {
    const nextId = previousVisibleItemIds[previousIndex + distance];
    if (nextId && nextVisibleItemIdSet.has(nextId)) return nextId;

    const previousId = previousVisibleItemIds[previousIndex - distance];
    if (previousId && nextVisibleItemIdSet.has(previousId)) return previousId;
  }

  return nextVisibleItemIds[Math.min(previousIndex, nextVisibleItemIds.length - 1)] ?? nextVisibleItemIds[0];
}

function prepareStatusSelection(tuiState: TuiState, items: StatusItem[]): void {
  const previousVisibleItemIds = tuiState.statusLayout?.visibleLayout?.selectableItemIds
    ?? tuiState.visibleItemIds
    ?? [];
  const nextVisibleItemIds = getVisibleSelectableItemIds(items);
  tuiState.selectedItemId = normalizeSelectedItemId(
    nextVisibleItemIds,
    tuiState.selectedItemId,
    previousVisibleItemIds,
  );
  tuiState.visibleItemIds = nextVisibleItemIds;
  if (nextVisibleItemIds.length === 0) {
    tuiState.scrollOffset = 0;
  }
}

function syncStatusLayout(tuiState: TuiState, panelLayout: ReturnType<typeof buildPanelLayout>, termRows: number): void {
  tuiState.statusLayout = panelLayout.statusPanel;
  tuiState.visibleItemIds = panelLayout.statusPanel?.visibleLayout?.selectableItemIds ?? tuiState.visibleItemIds ?? [];

  if (!panelLayout.statusPanel) return;

  if (tuiState.selectedItemId) {
    tuiState.scrollOffset = scrollStatusItemIntoView(
      panelLayout.statusPanel,
      termRows,
      tuiState.scrollOffset,
      tuiState.selectedItemId,
      1,
    );
    return;
  }

  const viewportHeight = Math.max(
    1,
    termRows - panelLayout.statusPanel.headerLines.length - panelLayout.footerLines.length,
  );
  tuiState.scrollOffset = clampScrollOffset(
    tuiState.scrollOffset,
    panelLayout.statusPanel.itemLines.length,
    viewportHeight,
  );
}

export interface TuiDetailSnapshot {
  priority?: string;
  dependencies?: string[];
  ciFailCount?: number;
  retryCount?: number;
  descriptionBody?: string;
}

function renderEngineRecoveryOverlay(
  termWidth: number,
  termRows: number,
  reason?: string,
): string[] {
  const title = "Engine disconnected";
  const detailLines = (reason?.split("\n") ?? ["The watch engine exited before acknowledging all controls."])
    .map((line) => line.trim())
    .filter(Boolean);
  const hint = "Press r to restart or q to quit";
  const contentLines = [
    "",
    ...detailLines.map((line) => `  ${line}`),
    "",
    `  ${hint}`,
    "",
  ];
  const maxContentWidth = Math.max(title.length, ...contentLines.map((line) => line.length));
  const innerWidth = Math.min(maxContentWidth + 4, termWidth - 4);
  const boxWidth = innerWidth + 2;
  const leftMargin = Math.max(0, Math.floor((termWidth - boxWidth) / 2));
  const marginPad = " ".repeat(leftMargin);
  const boxLines: string[] = [];

  boxLines.push(`${marginPad}┌${"─".repeat(innerWidth)}┐`);
  const titlePad = Math.max(0, Math.floor((innerWidth - title.length) / 2));
  boxLines.push(`${marginPad}│${" ".repeat(titlePad)}${BOLD}${RED}${title}${RESET}${" ".repeat(Math.max(0, innerWidth - titlePad - title.length))}│`);
  boxLines.push(`${marginPad}│${" ".repeat(innerWidth)}│`);
  for (const line of contentLines) {
    const visible = line.length > innerWidth - 2 ? `${line.slice(0, Math.max(0, innerWidth - 5))}...` : line;
    const rightPad = Math.max(0, innerWidth - 2 - visible.length);
    boxLines.push(`${marginPad}│  ${visible}${" ".repeat(rightPad)}│`);
  }
  boxLines.push(`${marginPad}└${"─".repeat(innerWidth)}┘`);

  const topPad = Math.max(0, Math.floor((termRows - boxLines.length) / 2));
  const output: string[] = [];
  for (let i = 0; i < topPad; i++) output.push("");
  output.push(...boxLines);
  while (output.length < termRows) output.push("");
  return output.slice(0, termRows);
}

export function renderTuiPanelFrameFromStatusItems(
  statusItems: StatusItem[],
  wipLimit: number | undefined,
  tuiState: TuiState,
  write: (s: string) => void = (s) => process.stdout.write(s),
  detailSnapshots?: ReadonlyMap<string, TuiDetailSnapshot>,
): void {
  const termWidth = getTerminalWidth();
  const termRows = getTerminalHeight();
  const fullScreenViewOptions = termRows >= MIN_FULLSCREEN_ROWS
    ? { ...(tuiState.viewOptions ?? {}), inlineModeIndicatorOnTitle: true }
    : tuiState.viewOptions;

  write("\x1B[H");

  if (tuiState.engineDisconnected) {
    const overlayLines = renderEngineRecoveryOverlay(termWidth, termRows, tuiState.engineDisconnectReason);
    const content = overlayLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  } else if (tuiState.viewOptions.showHelp) {
    const helpLines = renderHelpOverlay(termWidth, termRows, tuiState.sessionCode, tuiState.tmuxSessionName);
    const content = helpLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  } else if (tuiState.showControls) {
    const controlsLines = renderControlsOverlay(termWidth, termRows, {
      collaborationMode: tuiState.collaborationMode,
      pendingCollaborationMode: tuiState.pendingCollaborationMode,
      collaborationIntent: tuiState.collaborationIntent,
      sessionCode: tuiState.sessionCode,
      collaborationJoinInputActive: tuiState.collaborationJoinInputActive,
      collaborationJoinInputValue: tuiState.collaborationJoinInputValue,
      collaborationBusy: tuiState.collaborationBusy,
      collaborationError: tuiState.collaborationError,
      reviewMode: tuiState.reviewMode,
      pendingReviewMode: tuiState.pendingReviewMode,
      mergeStrategy: tuiState.mergeStrategy,
      pendingMergeStrategy: tuiState.pendingStrategy,
      bypassEnabled: tuiState.bypassEnabled,
      wipLimit,
      pendingWipLimit: tuiState.pendingWipLimit,
      activeRowIndex: tuiState.controlsRowIndex,
    });
    const content = controlsLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  } else if (tuiState.detailItemId) {
    const detailStatusItem = statusItems.find((item) => item.id === tuiState.detailItemId);
    if (detailStatusItem) {
      const detailSnapshot = detailSnapshots?.get(tuiState.detailItemId);
      const overlayLines = renderDetailOverlay(detailStatusItem, termWidth, termRows, {
        repoUrl: tuiState.viewOptions.repoUrl,
        priority: detailSnapshot?.priority,
        dependencies: detailSnapshot?.dependencies,
        ciFailCount: detailSnapshot?.ciFailCount,
        retryCount: detailSnapshot?.retryCount,
        scrollOffset: tuiState.detailScrollOffset ?? 0,
        descriptionBody: detailSnapshot?.descriptionBody,
      });
      const content = overlayLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    } else {
      tuiState.detailItemId = null;
      const filteredLogs = filterLogsByLevel(tuiState.logBuffer, tuiState.logLevelFilter);
      prepareStatusSelection(tuiState, statusItems);
      const panelLayout = buildPanelLayout(
        tuiState.panelMode,
        statusItems,
        filteredLogs,
        termWidth,
        termRows,
        {
          wipLimit,
          viewOptions: fullScreenViewOptions,
          logScrollOffset: tuiState.logScrollOffset,
          statusScrollOffset: tuiState.scrollOffset,
          selectedItemId: tuiState.selectedItemId,
        },
      );
      syncStatusLayout(tuiState, panelLayout, termRows);
      const frameLines = renderPanelFrame(panelLayout, termRows, termWidth, tuiState.scrollOffset);
      const content = frameLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    }
  } else {
    const filteredLogs = filterLogsByLevel(tuiState.logBuffer, tuiState.logLevelFilter);
    prepareStatusSelection(tuiState, statusItems);
    const panelLayout = buildPanelLayout(
      tuiState.panelMode,
      statusItems,
      filteredLogs,
      termWidth,
      termRows,
      {
        wipLimit,
        viewOptions: fullScreenViewOptions,
        logScrollOffset: tuiState.logScrollOffset,
        statusScrollOffset: tuiState.scrollOffset,
        selectedItemId: tuiState.selectedItemId,
      },
    );
    syncStatusLayout(tuiState, panelLayout, termRows);
    const frameLines = renderPanelFrame(panelLayout, termRows, termWidth, tuiState.scrollOffset);
    const content = frameLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  }

  write("\x1B[J");
}

/**
 * Render the status table to stdout using ANSI cursor control for flicker-free updates.
 * Uses cursor-home + clear-line + clear-to-end to replace content in-place.
 * Injectable write function for testability.
 *
 * In full-screen mode (>= MIN_FULLSCREEN_ROWS), uses buildStatusLayout + renderFullScreenFrame
 * with pinned header/footer and scrollable item area. Falls back to legacy rendering for
 * very small terminals.
 */
export function renderTuiFrame(
  items: OrchestratorItem[],
  wipLimit: number | undefined,
  write: (s: string) => void = (s) => process.stdout.write(s),
  viewOptions?: ViewOptions,
  scrollOffset: number = 0,
  remoteItems?: RemoteItemRenderState,
  sessionCode?: string,
  maxTimeoutExtensions: number = DEFAULT_CONFIG.maxTimeoutExtensions,
  heartbeats?: ReadonlyMap<string, WorkerProgress>,
): void {
  const statusItems = orchestratorItemsToStatusItems(items, remoteItems, maxTimeoutExtensions, heartbeats);
  const termWidth = getTerminalWidth();
  const termRows = getTerminalHeight();
  const fullScreenViewOptions = termRows >= MIN_FULLSCREEN_ROWS
    ? { ...(viewOptions ?? {}), inlineModeIndicatorOnTitle: true }
    : viewOptions;

  write("\x1B[H");

  if (viewOptions?.showHelp) {
    // Render help overlay instead of the normal frame
    const helpLines = renderHelpOverlay(termWidth, termRows, sessionCode, undefined);
    const content = helpLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  } else if (termRows >= MIN_FULLSCREEN_ROWS) {
    const layout = buildStatusLayout(statusItems, termWidth, wipLimit, false, fullScreenViewOptions);
    const clamped = clampScrollOffset(scrollOffset, layout.itemLines.length, Math.max(1, termRows - layout.headerLines.length - layout.footerLines.length));
    const frameLines = renderFullScreenFrame(layout, termRows, termWidth, clamped);
    const content = frameLines.join("\n");
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  } else {
    const content = formatStatusTable(statusItems, termWidth, wipLimit, false, viewOptions);
    write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
  }

  write("\x1B[J");
}

/**
 * Render a panel-aware TUI frame with status/log full-screen pages.
 * Uses buildPanelLayout + renderPanelFrame from status-render.ts.
 * Falls back to renderTuiFrame when the help overlay is active.
 */
export function renderTuiPanelFrame(
  items: OrchestratorItem[],
  wipLimit: number | undefined,
  tuiState: TuiState,
  write: (s: string) => void = (s) => process.stdout.write(s),
  remoteItems?: RemoteItemRenderState,
  maxTimeoutExtensions: number = DEFAULT_CONFIG.maxTimeoutExtensions,
  heartbeats?: ReadonlyMap<string, WorkerProgress>,
): void {
  const statusItems = orchestratorItemsToStatusItems(items, remoteItems, maxTimeoutExtensions, heartbeats);
  const detailSnapshots = new Map<string, TuiDetailSnapshot>(
    items.map((item) => [item.id, {
      priority: item.workItem.priority,
      dependencies: item.workItem.dependencies,
      ciFailCount: item.ciFailCount,
      retryCount: item.retryCount,
      descriptionBody: item.workItem.rawText,
    }]),
  );
  renderTuiPanelFrameFromStatusItems(statusItems, wipLimit, tuiState, write, detailSnapshots);
}

function daemonStateToDetailSnapshots(state: DaemonState): Map<string, TuiDetailSnapshot> {
  return new Map<string, TuiDetailSnapshot>(
    state.items.map((item) => [item.id, {
      priority: item.priority,
      dependencies: item.dependencies,
      ciFailCount: item.ciFailCount,
      retryCount: item.retryCount,
      descriptionBody: item.descriptionBody,
    }]),
  );
}

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
      lastSnapshot.runtime.wipLimit,
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
          if (message.type === "snapshot") {
            engineReady = true;
            lastSnapshot = {
              daemonState: message.event.state,
              runtime: message.event.runtime,
              ...(message.event.pollIntervalMs !== undefined ? { pollIntervalMs: message.event.pollIntervalMs } : {}),
              ...(message.event.interactiveTiming ? { interactiveTiming: message.event.interactiveTiming } : {}),
            };
            applyRuntimeSnapshotToTuiState(opts.tuiState, message.event.runtime);
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
    bindControlSender(() => {});
    bindCollaborationRequester(async () => ({ error: "Collaboration engine unavailable." }));
    if (manageKeyboard) cleanupKeyboard();
    if (altScreenActive) {
      write(ALT_SCREEN_OFF);
    }
  }
}

// ── Reusable TUI runner ─────────────────────────────────────────────

/** Options for runTUI -- the reusable TUI lifecycle runner. */
export interface RunTUIOptions {
  /** Provide status items and optional wip limit for each render cycle. */
  getItems: () => { items: StatusItem[]; wipLimit?: number; sessionStartedAt?: string; viewOptions?: ViewOptions };
  /** Provide log entries for the log panel. If omitted, logBuffer is empty. */
  getLogEntries?: () => PanelLogEntry[];
  /** Poll interval in ms (default: 2000). */
  intervalMs?: number;
  /** External abort signal to stop the TUI loop. */
  signal?: AbortSignal;
  /** Starting panel mode (default: status-only). */
  panelMode?: PanelMode;
}

/**
 * Run a panel-aware TUI loop.
 *
 * Sets up the alternate screen buffer, keyboard shortcuts (Tab, j/k, l, G, q, d, ?, ↑/↓),
 * and a poll-render loop. Returns when the user presses `q` or the signal is aborted.
 *
 * Designed for read-only mode: status.ts can call this to get the full panel TUI
 * without needing the orchestrate event loop.
 */
export async function runTUI(opts: RunTUIOptions): Promise<void> {
  const { getItems, getLogEntries, intervalMs = 2000, signal, panelMode = "status-only" } = opts;
  const isTTY = process.stdin.isTTY === true;
  if (!isTTY) return;

  const abortController = new AbortController();
  const combinedSignal = signal
    ? (() => { signal.addEventListener("abort", () => abortController.abort()); return abortController.signal; })()
    : abortController.signal;

  const logBuffer: PanelLogEntry[] = [];
  const tuiState: TuiState = {
    scrollOffset: 0,
    viewOptions: { showBlockerDetail: true },
    wipLimit: 1,
    pendingWipLimit: undefined,
    mergeStrategy: "auto",
    bypassEnabled: false,
    ctrlCPending: false,
    ctrlCTimestamp: 0,
    showHelp: false,
    showControls: false,
    collaborationMode: "local",
    pendingCollaborationMode: undefined,
    collaborationIntent: "local",
    collaborationJoinInputActive: false,
    collaborationJoinInputValue: "",
    collaborationBusy: false,
    reviewMode: "ninthwave-prs",
    pendingReviewMode: undefined,
    panelMode,
    logBuffer,
    logScrollOffset: 0,
    logLevelFilter: "all",
    selectedItemId: undefined,
    visibleItemIds: [],
    detailItemId: null,
    detailScrollOffset: 0,
    detailContentLines: 0,
    savedLogScrollOffset: 0,
    statusLayout: null,
    onUpdate: () => {
      try { render(); } catch { /* non-fatal */ }
    },
    engineDisconnected: false,
  };

  // Noop log for keyboard shortcuts (read-only mode has no orchestrator log)
  const noopLog = (_entry: LogEntry) => {};

  function render() {
    const data = getItems();
    if (data.sessionStartedAt) {
      tuiState.viewOptions.sessionStartedAt = data.sessionStartedAt;
    }
    tuiState.wipLimit = data.wipLimit ?? tuiState.wipLimit;
    tuiState.viewOptions.emptyState = data.viewOptions?.emptyState;
    // Refresh log entries from provider
    if (getLogEntries) {
      const entries = getLogEntries();
      logBuffer.length = 0;
      logBuffer.push(...entries);
    }
    // Build a minimal set of OrchestratorItem-like objects for rendering
    // Since we have StatusItem[], we render directly via panel layout
    const termWidth = getTerminalWidth();
    const termRows = getTerminalHeight();
    const write = (s: string) => process.stdout.write(s);

    write("\x1B[H");

    if (tuiState.viewOptions.showHelp) {
      const helpLines = renderHelpOverlay(termWidth, termRows, tuiState.sessionCode, tuiState.tmuxSessionName);
      const content = helpLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    } else if (tuiState.showControls) {
      const controlsLines = renderControlsOverlay(termWidth, termRows, {
        collaborationMode: tuiState.collaborationMode,
        pendingCollaborationMode: tuiState.pendingCollaborationMode,
        collaborationIntent: tuiState.collaborationIntent,
        sessionCode: tuiState.sessionCode,
        collaborationJoinInputActive: tuiState.collaborationJoinInputActive,
        collaborationJoinInputValue: tuiState.collaborationJoinInputValue,
        collaborationBusy: tuiState.collaborationBusy,
        collaborationError: tuiState.collaborationError,
        reviewMode: tuiState.reviewMode,
        pendingReviewMode: tuiState.pendingReviewMode,
        mergeStrategy: tuiState.mergeStrategy,
        pendingMergeStrategy: tuiState.pendingStrategy,
        bypassEnabled: tuiState.bypassEnabled,
        wipLimit: data.wipLimit,
        pendingWipLimit: tuiState.pendingWipLimit,
      });
      const content = controlsLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    } else if (tuiState.detailItemId) {
      const detailItem = data.items.find((i) => i.id === tuiState.detailItemId);
      if (detailItem) {
        const overlayLines = renderDetailOverlay(detailItem, termWidth, termRows, {
          repoUrl: tuiState.viewOptions.repoUrl,
          scrollOffset: tuiState.detailScrollOffset ?? 0,
        });
        const content = overlayLines.join("\n");
        write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
      } else {
        tuiState.detailItemId = null;
      }
    } else {
      const filteredLogs = filterLogsByLevel(logBuffer, tuiState.logLevelFilter);

      prepareStatusSelection(tuiState, data.items);
      const panelLayout = buildPanelLayout(
        tuiState.panelMode,
        data.items,
        filteredLogs,
        termWidth,
        termRows,
        {
          wipLimit: data.wipLimit,
          viewOptions: tuiState.viewOptions,
          logScrollOffset: tuiState.logScrollOffset,
          statusScrollOffset: tuiState.scrollOffset,
          selectedItemId: tuiState.selectedItemId,
        },
      );
      syncStatusLayout(tuiState, panelLayout, termRows);
      const frameLines = renderPanelFrame(panelLayout, termRows, termWidth, tuiState.scrollOffset);
      const content = frameLines.join("\n");
      write(content.replace(/\n/g, "\x1B[K\n") + "\x1B[K");
    }

    write("\x1B[J");
  }

  process.stdout.write(ALT_SCREEN_ON);
  const exitAltScreen = () => process.stdout.write(ALT_SCREEN_OFF);
  process.on("exit", exitAltScreen);

  const cleanupKeyboard = setupKeyboardShortcuts(abortController, noopLog, process.stdin, tuiState);

  try {
    while (!combinedSignal.aborted) {
      render();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        combinedSignal.addEventListener("abort", onAbort, { once: true });
      });
    }
  } finally {
    cleanupKeyboard();
    exitAltScreen();
    process.removeListener("exit", exitAltScreen);
  }
}

export interface BootstrapTuiUpdateNoticeDeps {
  getStartupState?: () => PassiveUpdateStartupState;
  refreshUpdateState?: () => Promise<PassiveUpdateState | null>;
  onUpdate?: () => void;
}

export function bootstrapTuiUpdateNotice(
  viewOptions: ViewOptions,
  deps: BootstrapTuiUpdateNoticeDeps = {},
): Promise<void> | null {
  const startupState = (deps.getStartupState ?? getPassiveUpdateStartupState)();
  viewOptions.updateState = startupState.cachedState ?? undefined;
  if (!startupState.shouldRefresh) {
    return null;
  }

  return (deps.refreshUpdateState ?? getPassiveUpdateState)()
    .then((refreshedState) => {
      if (!refreshedState) return;
      viewOptions.updateState = refreshedState;
      deps.onUpdate?.();
    })
    .catch(() => {
      // Best-effort only. Keep any cached notice already shown.
    });
}

// ── Sidebar display sync ──────────────────────────────────────────

/**
 * Sync cmux sidebar display for all active workers.
 * Sets status pill (text, icon, color) and progress bar from heartbeat data.
 *
 * Ownership split:
 * - Status pill (orchestrator-owned): lifecycle state text/icon/color
 * - Progress bar (worker-primary, orchestrator-fallback):
 *   - Worker-active states (implementing, launching, ci-failed): heartbeat pass-through, default 0%
 *   - Worker-idle states (ci-pending, ci-passed, review-pending, merging): 100%, no label
 */
export function syncWorkerDisplay(
  orch: Orchestrator,
  snapshot: PollSnapshot,
  mux: Multiplexer,
  projectRoot: string,
): void {
  const heartbeatMap = new Map<string, ItemSnapshot>();
  for (const snap of snapshot.items) {
    heartbeatMap.set(snap.id, snap);
  }

  const activeStates = new Set<OrchestratorItemState>([
    "launching", "implementing", "ci-pending",
    "ci-passed", "ci-failed", "review-pending", "merging",
  ]);

  // Worker-active states: heartbeat pass-through, default to 0% when no heartbeat
  const workerActiveStates = new Set<OrchestratorItemState>([
    "implementing", "launching", "ci-failed",
  ]);

  for (const item of orch.getAllItems()) {
    // Only sync display for items with a workspace ref and active state
    if (!item.workspaceRef) continue;
    if (!activeStates.has(item.state)) continue;

    const display = statusDisplayForState(item.state, { rebaseRequested: item.rebaseRequested, reviewRound: item.reviewRound });
    const statusKey = `ninthwave-${item.id}`;
    const workspaceMux = muxTypeForWorkspaceRef(item.workspaceRef) === mux.type
      ? mux
      : muxForWorkspaceRef(item.workspaceRef, projectRoot);

    // Set status pill (best-effort)
    try {
      workspaceMux.setStatus(item.workspaceRef, statusKey, display.text, display.icon, display.color);
    } catch { /* best-effort */ }

    // Set progress bar
    const snap = heartbeatMap.get(item.id);
    const heartbeat = snap?.lastHeartbeat;

    try {
      if (workerActiveStates.has(item.state)) {
        // Worker is active: use heartbeat progress/label, default to 0 with no label
        if (heartbeat) {
          workspaceMux.setProgress(item.workspaceRef, heartbeat.progress, heartbeat.label);
        } else {
          workspaceMux.setProgress(item.workspaceRef, 0);
        }
      } else {
        // Worker is idle: 1.0 (complete), no label -- status pill carries the message
        workspaceMux.setProgress(item.workspaceRef, 1);
      }
    } catch { /* best-effort */ }
  }
}

// ── Adaptive poll interval ─────────────────────────────────────────

/** Flat 2s poll interval -- fast enough that users never need to think about refresh timing. */
export function adaptivePollInterval(_orch: Orchestrator): number {
  return 2_000;
}

// ── Orphaned worktree cleanup ──────────────────────────────────────

/**
 * Dependencies for cleanOrphanedWorktrees, injectable for testing.
 */
export interface CleanOrphanedDeps {
  /** List ninthwave-* directory names in the worktree dir. */
  getWorktreeIds(worktreeDir: string): string[];
  /** List open item IDs from work item files on disk. */
  getOpenItemIds(workDir: string): string[];
  /** Clean a single worktree by ID. Returns true if cleaned. */
  cleanWorktree(id: string, worktreeDir: string, projectRoot: string): boolean;
  /** Close a multiplexer workspace by item ID (best-effort). */
  closeWorkspaceForItem?(itemId: string): void;
  /** Structured logger. */
  log(entry: LogEntry): void;
}

/** List ninthwave-* worktree IDs in the worktree directory. */
function listWorktreeIds(worktreeDir: string): string[] {
  if (!existsSync(worktreeDir)) return [];
  try {
    return readdirSync(worktreeDir)
      .filter((e) => e.startsWith("ninthwave-"))
      .map((e) => e.slice(10));
  } catch {
    return [];
  }
}

/** List open item IDs from work item files on disk. */
function listOpenItemIds(workDir: string): string[] {
  if (!existsSync(workDir)) return [];
  try {
    const entries = readdirSync(workDir).filter((f) => f.endsWith(".md"));
    const ids: string[] = [];
    for (const entry of entries) {
      const match = entry.match(ID_IN_FILENAME);
      if (match) ids.push(match[1]!);
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * Clean orphaned ninthwave-* worktrees that have no matching work item file.
 * A worktree is orphaned if no `*--{ID}.md` file exists
 * in the work items directory. Non-ninthwave worktrees are left alone.
 *
 * Returns the list of IDs that were cleaned.
 */
export function cleanOrphanedWorktrees(
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
  deps: CleanOrphanedDeps,
): string[] {
  const worktreeIds = deps.getWorktreeIds(worktreeDir);
  if (worktreeIds.length === 0) return [];

  const openItemIds = new Set(deps.getOpenItemIds(workDir));
  const cleanedIds: string[] = [];

  for (const wtId of worktreeIds) {
    if (!openItemIds.has(wtId)) {
      // Close workspace before removing worktree to prevent orphaned windows
      if (deps.closeWorkspaceForItem) {
        try { deps.closeWorkspaceForItem(wtId); } catch { /* best-effort */ }
      }
      if (deps.cleanWorktree(wtId, worktreeDir, projectRoot)) {
        cleanedIds.push(wtId);
      }
    }
  }

  if (cleanedIds.length > 0) {
    deps.log({
      ts: new Date().toISOString(),
      level: "info",
      event: "orphaned_worktrees_cleaned",
      cleanedIds,
      count: cleanedIds.length,
    });
  }

  return cleanedIds;
}

// ── Interruptible sleep ────────────────────────────────────────────

/** Sleep that resolves immediately if the abort signal fires. */
export function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// ── Memory detection ──────────────────────────────────────────────

// getAvailableMemory is imported from ../memory.ts and re-exported for backward compatibility.
export { getAvailableMemory } from "../memory.ts";

// ── Run-complete and action-execution helpers ─────────────────────

/**
 * Handle post-completion processing: cleanup sweep, logging, analytics.
 * Extracted from orchestrateLoop for readability.
 */
function handleRunComplete(
  allItems: OrchestratorItem[],
  orch: Orchestrator,
  ctx: ExecutionContext,
  deps: OrchestrateLoopDeps,
  config: OrchestrateLoopConfig,
  log: (entry: LogEntry) => void,
  runStartTime: string,
): void {
  // Final cleanup sweep: close workspaces and remove worktrees for managed items.
  // Stuck items preserve their worktree so users can inspect partial work.
  const cleanedIds: string[] = [];
  for (const item of allItems) {
    try {
      // Close workspace before worktree cleanup (prevents orphaned workspaces)
      if (item.workspaceRef) {
        deps.actionDeps.closeWorkspace(item.workspaceRef);
      }
      // Preserve worktrees for stuck items -- users can inspect partial work
      // and clean manually with `nw clean <ID>` when done.
      if (item.state === "stuck") continue;
      const cleaned = deps.actionDeps.cleanSingleWorktree(
        item.id,
        ctx.worktreeDir,
        ctx.projectRoot,
      );
      if (cleaned) {
        cleanedIds.push(item.id);
      }
    } catch {
      // Non-fatal -- best-effort cleanup
    }
  }

  if (cleanedIds.length > 0) {
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "worktree_cleanup_sweep",
      cleanedIds,
      count: cleanedIds.length,
    });
  }

  const doneCount = allItems.filter((i) => i.state === "done").length;
  const stuckCount = allItems.filter((i) => i.state === "stuck").length;
  const itemSummaries = allItems.map((i) => ({
    id: i.id,
    state: i.state,
    prUrl: i.prNumber && config.repoUrl
      ? `${config.repoUrl}/pull/${i.prNumber}`
      : null,
  }));
  log({
    ts: new Date().toISOString(),
    level: "info",
    event: "orchestrate_complete",
    done: doneCount,
    stuck: stuckCount,
    total: allItems.length,
    items: itemSummaries,
  });

  // Analytics: emit run_metrics as a structured log event (replaces JSON file writing)
  try {
    const endTime = new Date().toISOString();
    const metrics = collectRunMetrics(
      allItems,
      orch.config,
      runStartTime,
      endTime,
      config.aiTool ?? "unknown",
    );
    log({
      ts: endTime,
      level: "info",
      event: "run_metrics",
      ...metrics,
    } as unknown as LogEntry);
  } catch (e: unknown) {
    // Non-fatal -- analytics failure shouldn't block the orchestrator
    const msg = e instanceof Error ? e.message : String(e);
    log({
      ts: new Date().toISOString(),
      level: "warn",
      event: "analytics_error",
      error: msg,
    });
  }
}

// ── Exit summary ────────────────────────────────────────────────────

/**
 * Format the compact end-of-run summary that prints to stdout after TUI exit.
 * Persists in terminal scrollback since it's written after exitAltScreen().
 *
 * Format: "ninthwave: N merged, M stuck, K queued (Xm Ys) | Lead time: p50 Xm, p95 Ym"
 */
export interface CompletionSummaryItem {
  state: string;
  startedAt?: string;
  endedAt?: string;
  remoteSnapshot?: { state: string };
}

function completionSummaryState(item: CompletionSummaryItem): "done" | "stuck" | "queued" | "active" {
  const state = item.remoteSnapshot?.state ?? item.state;

  if (state === "done") return "done";
  if (state === "stuck") return "stuck";
  if (state === "queued" || state === "ready") return "queued";
  return "active";
}

export function formatExitSummary(
  allItems: CompletionSummaryItem[],
  runStartTime: string,
): string {
  const merged = allItems.filter((i) => completionSummaryState(i) === "done").length;
  const stuck = allItems.filter((i) => completionSummaryState(i) === "stuck").length;
  const queued = allItems.filter((i) => completionSummaryState(i) === "queued").length;
  const active = allItems.filter((i) => completionSummaryState(i) === "active").length;

  // Duration
  const elapsed = Math.max(0, Date.now() - new Date(runStartTime).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1000);
  const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  let line = active > 0
    ? `ninthwave: ${merged} done, ${active} active, ${stuck} stuck, ${queued} queued (${durationStr})`
    : `ninthwave: ${merged} merged, ${stuck} stuck, ${queued} queued (${durationStr})`;

  // Lead time (time from start to done for each completed item)
  const leadTimes = allItems
    .filter((i) => completionSummaryState(i) === "done" && i.startedAt && i.endedAt)
    .map((i) => new Date(i.endedAt!).getTime() - new Date(i.startedAt!).getTime())
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);

  if (leadTimes.length > 0) {
    const p50Idx = Math.max(0, Math.ceil(0.5 * leadTimes.length) - 1);
    const p95Idx = Math.max(0, Math.ceil(0.95 * leadTimes.length) - 1);
    const p50m = Math.round(leadTimes[p50Idx]! / 60_000);
    const p95m = Math.round(leadTimes[p95Idx]! / 60_000);
    line += ` | Lead time: p50 ${p50m}m, p95 ${p95m}m`;
  }

  return line;
}

// ── Completion prompt ───────────────────────────────────────────────

/**
 * Action chosen at the post-completion prompt.
 * - "run-more": re-enter interactive selection flow
 * - "clean": clean up worktrees for done items
 * - "quit": exit the TUI
 */
export type CompletionAction = "run-more" | "clean" | "quit";

/**
 * Format the completion banner shown when all items reach terminal state.
 * Returns the banner text as an array of lines.
 */
export function formatCompletionBanner(
  allItems: CompletionSummaryItem[],
  runStartTime: string,
): string[] {
  const merged = allItems.filter((i) => completionSummaryState(i) === "done").length;
  const stuck = allItems.filter((i) => completionSummaryState(i) === "stuck").length;
  const active = allItems.filter((i) => completionSummaryState(i) === "active").length;
  const total = allItems.length;

  const elapsed = Math.max(0, Date.now() - new Date(runStartTime).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1000);
  const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  const lines: string[] = [];
  lines.push("");
  lines.push(
    active > 0
      ? `  Work still in progress. ${merged} done, ${active} active, ${stuck} stuck. (${durationStr})`
      : `  All ${total} items complete. ${merged} merged, ${stuck} stuck. (${durationStr})`,
  );

  const leadTimes = allItems
    .filter((i) => completionSummaryState(i) === "done" && i.startedAt && i.endedAt)
    .map((i) => new Date(i.endedAt!).getTime() - new Date(i.startedAt!).getTime())
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  if (leadTimes.length > 0) {
    const p50Idx = Math.max(0, Math.ceil(0.5 * leadTimes.length) - 1);
    const p95Idx = Math.max(0, Math.ceil(0.95 * leadTimes.length) - 1);
    const p50m = Math.round(leadTimes[p50Idx]! / 60_000);
    const p95m = Math.round(leadTimes[p95Idx]! / 60_000);
    lines.push(`  Lead time: p50 ${p50m}m, p95 ${p95m}m`);
  }

  lines.push("");
  lines.push("  [r] Run more  [c] Clean up  [q] Quit");
  lines.push("");
  return lines;
}

/**
 * Wait for a completion prompt keypress (r, c, q, or Ctrl-C).
 * Returns the chosen action. Resolves when a valid key is pressed.
 *
 * @param stdin - Readable stream (must already be in raw mode)
 * @param signal - Optional abort signal (e.g., from Ctrl-C handler)
 */
export function waitForCompletionKey(
  stdin: NodeJS.ReadStream,
  signal?: AbortSignal,
): Promise<CompletionAction> {
  return new Promise<CompletionAction>((resolve) => {
    if (signal?.aborted) {
      resolve("quit");
      return;
    }

    const onAbort = () => {
      cleanup();
      resolve("quit");
    };

    const onData = (key: string) => {
      switch (key) {
        case "r":
          cleanup();
          resolve("run-more");
          break;
        case "c":
          cleanup();
          resolve("clean");
          break;
        case "q":
        case "\x03": // Ctrl-C
          cleanup();
          resolve("quit");
          break;
        // Ignore other keys
      }
    };

    function cleanup() {
      stdin.removeListener("data", onData);
      signal?.removeEventListener("abort", onAbort);
    }

    stdin.on("data", onData);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type EngineRecoveryAction = "restart" | "quit";

export function waitForEngineRecoveryKey(
  stdin: NodeJS.ReadStream,
  signal?: AbortSignal,
): Promise<EngineRecoveryAction> {
  return new Promise<EngineRecoveryAction>((resolve) => {
    if (signal?.aborted) {
      resolve("quit");
      return;
    }

    const onAbort = () => {
      cleanup();
      resolve("quit");
    };

    const onData = (key: string) => {
      switch (key.toLowerCase()) {
        case "r":
          cleanup();
          resolve("restart");
          break;
        case "q":
        case "\x03":
          cleanup();
          resolve("quit");
          break;
      }
    };

    function cleanup() {
      stdin.removeListener("data", onData);
      signal?.removeEventListener("abort", onAbort);
    }

    stdin.on("data", onData);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Execute a single orchestrator action with logging, telemetry capture, and reconcile.
 * Extracted from orchestrateLoop for readability.
 */
function handleActionExecution(
  action: Action,
  orch: Orchestrator,
  ctx: ExecutionContext,
  deps: OrchestrateLoopDeps,
  log: (entry: LogEntry) => void,
): void {
  const sessionEndedMetadata = deps.crewBroker
    ? (() => {
      const orchItem = orch.getItem(action.itemId);
      return orchItem ? buildSessionEndedMetadata(orchItem, ctx, action.type) : null;
    })()
    : null;

  // Before clean/retry action: capture worker screen for telemetry
  if ((action.type === "clean" || action.type === "retry" || action.type === "workspace-close") && deps.readScreen) {
    const orchItem = orch.getItem(action.itemId);
    if (orchItem?.workspaceRef) {
      try {
        const screenText = deps.readScreen(orchItem.workspaceRef, 50);
        // Capture worker telemetry (exit code, stderr tail) for diagnostics
        const telemetry = parseWorkerTelemetry(screenText);
        if (telemetry.exitCode != null) {
          orchItem.exitCode = telemetry.exitCode;
        }
        if (telemetry.stderrTail && (orchItem.state === "stuck" || orchItem.state === "ci-failed")) {
          orchItem.stderrTail = telemetry.stderrTail;
        }
        if (telemetry.exitCode != null || telemetry.stderrTail) {
          log({
            ts: new Date().toISOString(),
            level: "info",
            event: "telemetry_captured",
            itemId: action.itemId,
            exitCode: telemetry.exitCode,
            stderrLines: telemetry.stderrTail ? telemetry.stderrTail.split("\n").length : 0,
          });
        }
      } catch {
        // Non-fatal -- telemetry capture failure doesn't block cleanup
      }
    }
  }

  log({
    ts: new Date().toISOString(),
    level: "info",
    event: "action_execute",
    action: action.type,
    itemId: action.itemId,
    prNumber: action.prNumber,
    ...(action.type === "launch" && action.baseBranch ? { stacked: true, baseBranch: action.baseBranch } : {}),
  });

  const result = orch.executeAction(action, ctx, deps.actionDeps);

  log({
    ts: new Date().toISOString(),
    level: result.success ? "info" : "warn",
    event: "action_result",
    action: action.type,
    itemId: action.itemId,
    success: result.success,
    error: result.error,
  });

  // Report session_started for successful launches
  if (result.success && deps.crewBroker) {
    if (sessionEndedMetadata) {
      deps.crewBroker.report("session_ended", action.itemId, sessionEndedMetadata, {
        model: sessionEndedMetadata.model,
      });
    }

    const launchTelemetry = getLaunchTelemetry(action.type);
    const orchItem = orch.getItem(action.itemId);
    if (launchTelemetry && orchItem) {
      const model = readLaunchModel(ctx, launchTelemetry.filename) ?? undefined;
      orchItem[launchTelemetry.modelField] = model;
      deps.crewBroker.report("session_started", action.itemId, {
        agent: orchItem.aiTool ?? ctx.aiTool ?? "unknown",
        model: model ?? "unknown",
        role: launchTelemetry.role,
      }, {
        model,
      });
    }
  }

  // Bootstrap success: immediately follow up with a launch action
  if (action.type === "bootstrap" && result.success) {
    const orchItem = orch.getItem(action.itemId);
    if (orchItem && orchItem.state === "launching") {
      const launchAction: Action = { type: "launch", itemId: action.itemId };
      if (orchItem.baseBranch) {
        launchAction.baseBranch = orchItem.baseBranch;
      }
      handleActionExecution(launchAction, orch, ctx, deps, log);
    }
  }

  // Structured log for retry events
  if (action.type === "retry" && result.success) {
    const orchItem = orch.getItem(action.itemId);
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "worker_retry",
      itemId: action.itemId,
      retryCount: orchItem?.retryCount ?? 0,
      maxRetries: orch.config.maxRetries,
    });
  }

  // After a successful merge, reconcile work item files with GitHub state
  // so list --ready reflects reality for the rest of the run.
  if (action.type === "merge" && result.success && deps.reconcile) {
    try {
      deps.reconcile(ctx.workDir, ctx.worktreeDir, ctx.projectRoot);
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "post_merge_reconcile",
        itemId: action.itemId,
      });
    } catch (e: unknown) {
      // Non-fatal -- reconcile failure shouldn't block the orchestrator
      const msg = e instanceof Error ? e.message : String(e);
      log({
        ts: new Date().toISOString(),
        level: "warn",
        event: "post_merge_reconcile_error",
        itemId: action.itemId,
        error: msg,
      });
    }
  }
}

export function buildSessionEndedMetadata(
  item: OrchestratorItem,
  ctx: ExecutionContext,
  actionType: Action["type"],
): { agent: string; model: string; role: LaunchTelemetryRole; durationMs?: number } | null {
  const telemetry = getSessionEndTelemetry(actionType);
  if (!telemetry) return null;

  const workspaceRef = item[telemetry.workspaceField];
  if (!workspaceRef) return null;

  return {
    agent: item.aiTool ?? ctx.aiTool ?? "unknown",
    model: item[telemetry.modelField] ?? readLaunchModel(ctx, telemetry.filename) ?? "unknown",
    role: telemetry.role,
    durationMs: item.startedAt ? Date.now() - new Date(item.startedAt).getTime() : undefined,
  };
}

type LaunchTelemetryRole = "implementer" | "reviewer" | "rebaser" | "verifier";

type LaunchTelemetryConfig = {
  role: LaunchTelemetryRole;
  filename: string;
  modelField: "implementerModel" | "reviewerModel" | "rebaserModel" | "forwardFixerModel";
};

type SessionEndTelemetryConfig = LaunchTelemetryConfig & {
  workspaceField: "workspaceRef" | "reviewWorkspaceRef" | "rebaserWorkspaceRef" | "fixForwardWorkspaceRef";
};

const LAUNCH_TELEMETRY_BY_ACTION: Partial<Record<Action["type"], LaunchTelemetryConfig>> = {
  "launch": { role: "implementer", filename: "implementer.md", modelField: "implementerModel" },
  "launch-review": { role: "reviewer", filename: "reviewer.md", modelField: "reviewerModel" },
  "launch-rebaser": { role: "rebaser", filename: "rebaser.md", modelField: "rebaserModel" },
  "launch-forward-fixer": { role: "verifier", filename: "forward-fixer.md", modelField: "forwardFixerModel" },
};

const SESSION_END_TELEMETRY_BY_ACTION: Partial<Record<Action["type"], SessionEndTelemetryConfig>> = {
  "clean": {
    role: "implementer",
    filename: "implementer.md",
    modelField: "implementerModel",
    workspaceField: "workspaceRef",
  },
  "retry": {
    role: "implementer",
    filename: "implementer.md",
    modelField: "implementerModel",
    workspaceField: "workspaceRef",
  },
  "workspace-close": {
    role: "implementer",
    filename: "implementer.md",
    modelField: "implementerModel",
    workspaceField: "workspaceRef",
  },
  "clean-review": {
    role: "reviewer",
    filename: "reviewer.md",
    modelField: "reviewerModel",
    workspaceField: "reviewWorkspaceRef",
  },
  "clean-rebaser": {
    role: "rebaser",
    filename: "rebaser.md",
    modelField: "rebaserModel",
    workspaceField: "rebaserWorkspaceRef",
  },
  "clean-forward-fixer": {
    role: "verifier",
    filename: "forward-fixer.md",
    modelField: "forwardFixerModel",
    workspaceField: "fixForwardWorkspaceRef",
  },
};

function getLaunchTelemetry(actionType: Action["type"]): LaunchTelemetryConfig | undefined {
  return LAUNCH_TELEMETRY_BY_ACTION[actionType];
}

function getSessionEndTelemetry(actionType: Action["type"]): SessionEndTelemetryConfig | undefined {
  return SESSION_END_TELEMETRY_BY_ACTION[actionType];
}

function getHubRootFromWorkDir(workDir: string): string {
  return dirname(dirname(workDir));
}

function readLaunchModel(ctx: ExecutionContext, filename: string): string | null {
  const content = readAgentFileContent(getHubRootFromWorkDir(ctx.workDir), filename);
  return content ? parseAgentModel(content) : null;
}

function resolveCompletionModel(item: OrchestratorItem, ctx: ExecutionContext): string | undefined {
  return item.implementerModel ?? readLaunchModel(ctx, "implementer.md") ?? undefined;
}

function buildCompletionReportMetadata(item: OrchestratorItem): Record<string, unknown> {
  return {
    state: item.state,
    ...(item.prNumber ? { prNumber: item.prNumber } : {}),
    ...(item.startedAt ? { durationMs: Date.now() - new Date(item.startedAt).getTime() } : {}),
  };
}

function isCrewCompletionState(item: OrchestratorItem, fixForwardEnabled: boolean): boolean {
  return item.state === "done" || (item.state === "merged" && !fixForwardEnabled);
}

// ── Event loop ─────────────────────────────────────────────────────

/** Dependencies injected into orchestrateLoop for testability. */
export interface OrchestrateLoopDeps {
  buildSnapshot: (orch: Orchestrator, projectRoot: string, worktreeDir: string) => PollSnapshot | Promise<PollSnapshot>;
  sleep: (ms: number) => Promise<void>;
  log: (entry: LogEntry) => void;
  actionDeps: OrchestratorDeps;
  /** Get available free memory in bytes. Defaults to os.freemem(). Injectable for testing. */
  getFreeMem?: () => number;
  /** Reconcile work item files with GitHub state after merge actions. */
  reconcile?: (workDir: string, worktreeDir: string, projectRoot: string) => void;
  /** Read screen content from a worker workspace for telemetry capture. */
  readScreen?: (ref: string, lines?: number) => string;
  /** Called after each poll cycle with current items. Used for daemon state persistence, TUI countdown, and render timing. */
  onPollComplete?: (items: OrchestratorItem[], snapshot: PollSnapshot, pollIntervalMs?: number, interactiveTiming?: InteractiveWatchTiming) => void;
  /** Sync cmux sidebar display for active workers after each poll cycle. */
  syncDisplay?: (orch: Orchestrator, snapshot: PollSnapshot) => void;
  /** Dependencies for external PR review processing. When present and reviewExternal is enabled, external PRs are scanned and reviewed. */
  externalReviewDeps?: ExternalReviewDeps;
  /** Scan for work item files. Required for watch mode -- re-scans the work directory to discover new items. */
  scanWorkItems?: () => WorkItem[];
  /** Crew coordination broker. When present, crew mode is active -- claim before launch, complete after merge. */
  crewBroker?: CrewBroker;
  /** Override token usage resolution for telemetry tests. */
  readTokenUsage?: (item: OrchestratorItem, action: Action, ctx: ExecutionContext) => TokenUsage | undefined;
  /** Schedule dependencies. When present, scheduled task processing is active. */
  scheduleDeps?: ScheduleLoopDeps;
  /** Injectable clock for interactive watch timing tests. Defaults to Date.now. */
  nowMs?: () => number;
  /** Injectable timer hooks for event-loop lag sampling tests. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /**
   * Show the post-completion prompt and wait for user choice.
   * Returns the chosen action (run-more, clean, quit).
   * Only called when tuiMode is true and watch mode is false.
   */
  completionPrompt?: (allItems: OrchestratorItem[], runStartTime: string) => Promise<CompletionAction>;
}

export interface OrchestrateLoopConfig {
  /** Override adaptive poll interval (milliseconds). */
  pollIntervalMs?: number;
  /** GitHub repo URL (e.g., "https://github.com/owner/repo") for constructing PR URLs. */
  repoUrl?: string;
  /** AI tool identifier for per-item metrics (e.g., "claude", "cursor"). */
  aiTool?: string;
  /**
   * Max loop iterations before forced exit. Guards against event-loop starvation:
   * when tests use `sleep: () => Promise.resolve()`, a stuck loop monopolizes the
   * microtask queue and macrotask-based safety timers (setTimeout/setInterval) never
   * fire -- not even SIGKILL guards. This synchronous check is the only reliable defense.
   * Undefined = no limit (production). Tests should always set a finite cap.
   */
  maxIterations?: number;
  /** When true, scan for non-ninthwave PRs and spawn review workers for them. */
  reviewExternal?: boolean;
  /** When true, daemon stays running after all items reach terminal state, watching for new work items. */
  watch?: boolean;
  /** Polling interval (milliseconds) for watch mode. Default: 30000 (30 seconds). */
  watchIntervalMs?: number;
  /** When true, TUI is active -- enables the post-completion prompt. */
  tuiMode?: boolean;
  /**
   * Duration (ms) to gate claims at the start of the loop. During this window,
   * launch actions are suppressed (items reverted to ready) so the daemon runs
   * but does not start work.
   * 0 or undefined = no gating.
   */
  claimsGatedMs?: number;
}

/** Result from the orchestrate loop indicating why it exited. */
export interface OrchestrateLoopResult {
  /** The completion action chosen by the user, if any. Only set when tuiMode is true. */
  completionAction?: CompletionAction;
}

/**
 * Main event loop. Polls, detects transitions, executes actions, sleeps.
 * Exits when all items reach terminal state or signal is aborted.
 */
export async function orchestrateLoop(
  orch: Orchestrator,
  ctx: ExecutionContext,
  deps: OrchestrateLoopDeps,
  config: OrchestrateLoopConfig = {},
  signal?: AbortSignal,
): Promise<OrchestrateLoopResult> {
  const { log } = deps;
  const nowMs = deps.nowMs ?? Date.now;
  const lagSampler = config.tuiMode
    ? createEventLoopLagSampler({
        now: nowMs,
        setTimeoutFn: deps.setTimeoutFn,
        clearTimeoutFn: deps.clearTimeoutFn,
      })
    : undefined;
  lagSampler?.start();
  let pendingInteractiveTiming: InteractiveWatchTiming | undefined;

  // Wire onTransition callback for structured transition logging.
  // This fires from inside Orchestrator.transition() on every state change,
  // replacing the manual prevStates diff that previously lived in the poll loop.
  if (!orch.config.onTransition) {
    orch.config.onTransition = (itemId, from, to, timestamp, latencyMs) => {
      const entry: Record<string, unknown> = {
        ts: timestamp,
        level: "info",
        event: "transition",
        itemId,
        from,
        to,
        latencyMs,
      };
      // Enrich with stacking info when promoted from queued → ready with a base branch
      const item = orch.getItem(itemId);
      if (item && from === "queued" && to === "ready" && item.baseBranch) {
        entry.stacked = true;
        entry.baseBranch = item.baseBranch;
      }
      log(entry as LogEntry);

      // Telemetry report on state transitions
      if (deps.crewBroker) {
        const orchItem = orch.getItem(itemId);
        if (orchItem) {
          if (from === "implementing" && to === "ci-pending" && orchItem.prNumber) {
            deps.crewBroker.report("pr_opened", itemId, {
              prNumber: orchItem.prNumber,
              branch: `ninthwave/${itemId}`,
            });
          }
          if (from === "ci-pending" && (to === "ci-passed" || to === "ci-failed")) {
            deps.crewBroker.report("ci_result", itemId, {
              passed: to === "ci-passed",
              checkName: "github-actions",
              prNumber: orchItem.prNumber,
            });
          }
          if (from === "reviewing" && (to === "ci-passed" || to === "review-pending")) {
            deps.crewBroker.report("review_submitted", itemId, {
              reviewer: "ai",
              verdict: to === "ci-passed" ? "approved" : "changes_requested",
              prNumber: orchItem.prNumber,
            });
          }
          if (from === "review-pending" && to === "ci-pending") {
            deps.crewBroker.report("review_addressed", itemId, {
              round: orchItem.reviewRound ?? 1,
              prNumber: orchItem.prNumber,
            });
          }
          if (to === "rebasing") {
            deps.crewBroker.report("rebase", itemId, { reason: "conflicts" });
          }
          if (to === "merged" && orchItem.prNumber) {
            deps.crewBroker.report("pr_merged", itemId, { prNumber: orchItem.prNumber });
          }
          if (from === "forward-fix-pending" && (to === "done" || to === "fix-forward-failed")) {
            deps.crewBroker.report("post_merge_ci", itemId, {
              passed: to === "done",
              checkName: "github-actions",
              prNumber: orchItem.prNumber,
            });
          }
          if (from === "fix-forward-failed" && to === "fixing-forward") {
            deps.crewBroker.report("fix_forward_started", itemId, {
              triggerPr: orchItem.prNumber,
              fixBranch: `ninthwave/${itemId}-fix`,
            });
          }
          if (from === "fixing-forward" && (to === "done" || to === "stuck")) {
            deps.crewBroker.report("fix_forward_result", itemId, {
              succeeded: to === "done",
            });
          }
        }
      }
    };
  }

  // Wire onEvent callback for structured event logging (non-transition events).
  if (!orch.config.onEvent) {
    orch.config.onEvent = (itemId, event, data) => {
      log({
        ts: new Date().toISOString(),
        level: "info",
        event,
        itemId,
        ...data,
      } as LogEntry);
    };
  }

  // Initialize external review state from persisted file
  let externalReviews: ExternalReviewItem[] = [];
  if (config.reviewExternal && deps.externalReviewDeps) {
    externalReviews = readExternalReviews(ctx.projectRoot);
    if (externalReviews.length > 0) {
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "external_reviews_restored",
        count: externalReviews.length,
      });
    }
  }

  // Author cache for resolving git author of TODO files during sync.
  // Cleared each poll cycle to avoid stale data.
  const authorCache = new AuthorCache();

  const runStartTime = new Date().toISOString();

  log({
    ts: runStartTime,
    level: "info",
    event: "orchestrate_start",
    items: orch.getAllItems().map((i) => i.id),
    wipLimit: orch.config.wipLimit,
    mergeStrategy: orch.config.mergeStrategy,
  });

  let __iterations = 0;
  let __lastSnapshot: PollSnapshot | undefined;
  let __lastActions: import("../orchestrator.ts").Action[] = [];
  let __lastTransitionIter = 0;
  let lastScheduleCheckMs = 0; // Force first check immediately
  let lastMainRefreshMs = 0; // Force first refresh immediately
  const watchIntervalMs = config.watchIntervalMs ?? 30_000;
  let lastWatchScanMs = Date.now();
  const loopStartMs = Date.now();

  const scanForNewWatchItems = (): WorkItem[] => {
    if (!config.watch || !deps.scanWorkItems) return [];

    const freshItems = deps.scanWorkItems();
    const existingIds = new Set(orch.getAllItems().map((i) => i.id));
    const newItems = freshItems.filter((item) => !existingIds.has(item.id));
    if (newItems.length === 0) return [];

    for (const item of newItems) {
      orch.addItem(item);
    }

    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "watch_new_items",
      newIds: newItems.map((item) => item.id),
      count: newItems.length,
    });

    return newItems;
  };

  try {
    while (true) {
      __iterations++;

      if (pendingInteractiveTiming) {
        finalizeInteractiveWatchTiming(log, pendingInteractiveTiming, lagSampler?.drain().maxLagMs ?? 0);
        pendingInteractiveTiming = undefined;
      }

      if (config.maxIterations != null && __iterations > config.maxIterations) {
        const items = orch.getAllItems();
        log({
          ts: new Date().toISOString(),
          level: "error",
          event: "max_iterations_exceeded",
          iterations: __iterations,
          limit: config.maxIterations,
          staleFor: __iterations - __lastTransitionIter,
          itemDetails: items.map((i) => ({
            id: i.id,
            state: i.state,
            lastTransition: i.lastTransition,
            prNumber: i.prNumber,
            ciFailCount: i.ciFailCount,
            retryCount: i.retryCount,
            workspaceRef: i.workspaceRef,
          })),
          lastSnapshot: __lastSnapshot,
          lastActions: __lastActions.map((a) => ({ type: a.type, itemId: a.itemId })),
          rssMB: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
        });
        break;
      }

      if (signal?.aborted) {
        log({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "SIGINT" });
        break;
      }

    // Check if all items are in terminal state
    const allItems = orch.getAllItems();
    const allTerminal = allItems.every((i) => i.state === "done" || i.state === "stuck");
    if (allTerminal) {
      handleRunComplete(allItems, orch, ctx, deps, config, log, runStartTime);

      // Watch mode: instead of exiting, poll for new work items
      if (config.watch && deps.scanWorkItems) {
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "watch_mode_waiting",
          message: "All items complete. Watching for new work items...",
          watchIntervalMs,
        });

        // Poll for new work items until we find some or get aborted
        let foundNew = false;
        while (!foundNew) {
          __iterations++;
          if (config.maxIterations != null && __iterations > config.maxIterations) {
            break;
          }
          if (signal?.aborted) {
            log({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "watch_aborted" });
            return {};
          }
          await deps.sleep(watchIntervalMs);
          if (signal?.aborted) {
            log({ ts: new Date().toISOString(), level: "info", event: "shutdown", reason: "watch_aborted" });
            return {};
          }

          lastWatchScanMs = Date.now();
          if (scanForNewWatchItems().length > 0) {
            foundNew = true;
          }
        }
        if (foundNew) {
          // Continue the main loop with newly added items
          continue;
        }
        // maxIterations exceeded in watch loop -- fall through to break
        break;
      }

      // TUI mode (non-watch): show completion prompt
      if (config.tuiMode && deps.completionPrompt) {
        const action = await deps.completionPrompt(allItems, runStartTime);
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "completion_prompt",
          action,
        });

        if (action === "run-more") {
          return { completionAction: "run-more" };
        }
        if (action === "clean") {
          // Clean worktrees for done items
          for (const item of allItems) {
            if (item.state !== "done") continue;
            try {
              if (item.workspaceRef) deps.actionDeps.closeWorkspace(item.workspaceRef);
              deps.actionDeps.cleanSingleWorktree(item.id, ctx.worktreeDir, ctx.projectRoot);
            } catch { /* best-effort */ }
          }
          log({
            ts: new Date().toISOString(),
            level: "info",
            event: "completion_cleanup",
            cleanedIds: allItems.filter((i) => i.state === "done").map((i) => i.id),
          });
          return { completionAction: "clean" };
        }
        // action === "quit"
        return { completionAction: "quit" };
      }

      break;
    }

      if (config.watch && deps.scanWorkItems) {
        const nowWatchScanMs = Date.now();
        if (nowWatchScanMs - lastWatchScanMs >= watchIntervalMs) {
          lastWatchScanMs = nowWatchScanMs;
          scanForNewWatchItems();
        }
      }

    // Capture pre-transition states for logging
    const prevStates = new Map<string, OrchestratorItemState>();
    for (const item of allItems) {
      prevStates.set(item.id, item.state);
    }

    // Memory-aware WIP: adjust effective limit based on available free memory
      const freeMemBytes = (deps.getFreeMem ?? freemem)();
      const memoryWip = calculateMemoryWipLimit(orch.config.wipLimit, freeMemBytes);
      orch.setEffectiveWipLimit(memoryWip);

      if (memoryWip < orch.config.wipLimit) {
        log({
          ts: new Date().toISOString(),
          level: "info",
          event: "wip_reduced_memory",
          configuredWip: orch.config.wipLimit,
          effectiveWip: memoryWip,
          freeMemMB: Math.round(freeMemBytes / (1024 * 1024)),
        });
      }

    // Crew mode: sync active items to broker (fire-and-forget, before snapshot)
    // Clear author cache each cycle to avoid stale data across syncs.
    authorCache.clear();
    if (deps.crewBroker) {
      try {
        const activeItems = orch.getAllItems()
          .filter((i) => i.state !== "done" && i.state !== "stuck");
        // Build enriched sync items with priority, dependencies, and author.
        // Filter dependencies to only include items tracked in the orchestrator.
        // Untracked deps (removed from work dir = already delivered) are omitted
        // so the hub doesn't block claims on stale items from previous syncs.
        const trackedIds = new Set(orch.getAllItems().map((i) => i.id));
        const syncItems: SyncItem[] = activeItems.map((item) => ({
          id: item.id,
          dependencies: (item.workItem.dependencies ?? []).filter((depId) => trackedIds.has(depId)),
          priority: PRIORITY_NUM[item.workItem.priority] ?? 2,
          author: item.workItem.filePath
            ? authorCache.resolve(item.workItem.filePath, ctx.projectRoot)
            : "",
        }));
        deps.crewBroker.sync(syncItems);
      } catch { /* best-effort -- sync failure doesn't block the orchestrator */ }
    }

    // ── Scheduled task processing ─────────────────────────────────
    // Gated by 30s interval check to avoid excessive filesystem reads.
      if (deps.scheduleDeps) {
      const SCHEDULE_CHECK_INTERVAL_MS = 30_000;
      const nowMs = Date.now();
      if (nowMs - lastScheduleCheckMs >= SCHEDULE_CHECK_INTERVAL_MS) {
        lastScheduleCheckMs = nowMs;
        try {
          processScheduledTasks(
            ctx.projectRoot,
            orch,
            deps.scheduleDeps,
            log,
            memoryWip,
          );
        } catch (e: unknown) {
          // Non-fatal -- schedule processing failure shouldn't block the orchestrator
          const msg = e instanceof Error ? e.message : String(e);
          log({
            ts: new Date().toISOString(),
            level: "warn",
            event: "schedule_error",
            error: msg,
          });
        }
      }
    }

    // ── Periodic main branch refresh ──────────────────────────────
    // Keeps origin/main fresh and fast-forwards local main when clean.
    // ff-only is atomic: succeeds or changes nothing (never leaves partial state).
      const interactiveTiming = config.tuiMode
        ? createInteractiveWatchTiming(__iterations, [])
        : undefined;

      const MAIN_REFRESH_INTERVAL_MS = 60_000;
      const nowRefreshMs = Date.now();
      if (nowRefreshMs - lastMainRefreshMs >= MAIN_REFRESH_INTERVAL_MS) {
        const mainRefreshStartMs = interactiveTiming ? nowMs() : 0;
        lastMainRefreshMs = nowRefreshMs;
        const reposToRefresh = new Set<string>([ctx.projectRoot]);
        for (const item of orch.getAllItems()) {
          if (item.resolvedRepoRoot && item.state !== "done" && item.state !== "stuck") {
            reposToRefresh.add(item.resolvedRepoRoot);
          }
        }
        for (const repoRoot of reposToRefresh) {
          try { deps.actionDeps.fetchOrigin(repoRoot, "main"); } catch { /* non-fatal */ }
          try { deps.actionDeps.ffMerge(repoRoot, "main"); } catch { /* non-fatal -- dirty tree or diverged */ }
        }
        if (interactiveTiming) {
          interactiveTiming.timingsMs.mainRefresh = elapsedMs(nowMs, mainRefreshStartMs);
        }
      }

      // Build snapshot from external state
      const pollStartMs = interactiveTiming ? nowMs() : 0;
      const snapshot = await deps.buildSnapshot(orch, ctx.projectRoot, ctx.worktreeDir);
      if (interactiveTiming) {
        interactiveTiming.timingsMs.poll = elapsedMs(nowMs, pollStartMs);
      }
      __lastSnapshot = snapshot;

    // Log warning when GitHub API is unreachable for all polled items
    if (snapshot.apiErrorCount && snapshot.apiErrorCount > 0) {
      const primaryKind = snapshot.apiErrorSummary?.primaryKind;
      log({
        ts: new Date().toISOString(),
        level: "warn",
        event: "github_api_errors",
        apiErrorCount: snapshot.apiErrorCount,
        apiErrorSummary: snapshot.apiErrorSummary,
        message: primaryKind
          ? `GitHub ${ghFailureKindLabel(primaryKind)} errors, holding state`
          : "GitHub API unreachable, holding state",
      });
    }


    // Process transitions (pure state machine)
      let actions = orch.processTransitions(snapshot);
      __lastActions = actions;

    // Arming window: suppress launch actions during the claims-gated period
    if (config.claimsGatedMs && config.claimsGatedMs > 0) {
      const elapsedMs = Date.now() - loopStartMs;
      if (elapsedMs < config.claimsGatedMs) {
        const launchActions = actions.filter((a) => a.type === "launch");
        if (launchActions.length > 0) {
          for (const action of launchActions) {
            orch.hydrateState(action.itemId, "ready");
          }
          actions = actions.filter((a) => a.type !== "launch");
          log({
            ts: new Date().toISOString(),
            level: "info",
            event: "claims_gated",
            elapsedMs,
            gatedMs: config.claimsGatedMs,
            suppressedCount: launchActions.length,
          });
        }
      }
    }

    // Crew mode: claim/filter launch actions through the broker
      if (deps.crewBroker) {
      const launchActions = actions.filter((a) => a.type === "launch");

      // Diagnostic: log when broker is connected but no items ready to launch
      if (launchActions.length === 0) {
        const queuedCount = orch.getAllItems().filter(i => i.state === "queued").length;
        const readyCount = orch.getAllItems().filter(i => i.state === "ready").length;
        if (queuedCount > 0 || readyCount > 0) {
          log({
            ts: new Date().toISOString(),
            level: "debug",
            event: "crew_no_launches",
            readyIds: snapshot.readyIds,
            queuedCount,
            readyCount,
            wipSlots: orch.wipSlots,
            connected: deps.crewBroker.isConnected(),
          });
        }
      }

      if (launchActions.length > 0) {
        if (!deps.crewBroker.isConnected()) {
          // Block ALL launches when disconnected -- prevents stall detection
          for (const action of launchActions) {
            orch.hydrateState(action.itemId, "ready");
          }
          actions = actions.filter((a) => a.type !== "launch");
          log({
            ts: new Date().toISOString(),
            level: "warn",
            event: "crew_launches_blocked",
            reason: "disconnected",
            blockedCount: launchActions.length,
          });
        } else {
          // Crew mode: let the broker decide what to work on.
          // Claim once per available launch slot, then replace the
          // processTransitions launch actions with broker-assigned items.
          const claimedIds = new Set<string>();
          let nullCount = 0;
          let errorCount = 0;
          for (const _action of launchActions) {
            try {
              const claimed = await deps.crewBroker.claim();
              if (claimed) claimedIds.add(claimed);
              else nullCount++;
            } catch { errorCount++; }
          }

          // Put all original launch actions back to ready
          for (const action of launchActions) {
            orch.hydrateState(action.itemId, "ready");
          }
          // Remove original launch actions
          actions = actions.filter((a) => a.type !== "launch");

          // Add launch actions for broker-claimed items that are still launchable
          const LAUNCHABLE: ReadonlySet<string> = new Set(["queued", "ready", "launching"]);
          for (const claimedId of claimedIds) {
            const orchItem = orch.getItem(claimedId);
            if (orchItem && LAUNCHABLE.has(orchItem.state)) {
              orch.hydrateState(claimedId, "launching");
              actions.push({ type: "launch", itemId: claimedId });
            }
          }

          if (claimedIds.size > 0 || launchActions.length > 0) {
            log({
              ts: new Date().toISOString(),
              level: "info",
              event: "crew_launches_resolved",
              requestedCount: launchActions.length,
              claimedCount: claimedIds.size,
              claimedIds: Array.from(claimedIds),
              nullCount,
              errorCount,
            });
          }
        }
      }
    }

    // Detect whether any transition occurred this cycle (for stale-detection bookkeeping).
    // Transition logging is handled by the Orchestrator's onTransition callback.
    let __hadTransition = false;
    for (const item of orch.getAllItems()) {
      const prev = prevStates.get(item.id);
      if (prev && prev !== item.state) {
        __hadTransition = true;
        break;
      }
    }

    if (__hadTransition) __lastTransitionIter = __iterations;

    // Crew mode: suppress write actions for items claimed by other daemons.
    // Remote items are tracked via GitHub polling but only the owning daemon acts.
      if (deps.crewBroker) {
        actions = filterCrewRemoteWriteActions(actions, deps.crewBroker.getCrewStatus());
      }

      if (interactiveTiming) {
        interactiveTiming.actionCount = actions.length;
        interactiveTiming.actionTypes = actions.map((action) => action.type);
      }

      // Execute actions
      const actionExecutionStartMs = interactiveTiming ? nowMs() : 0;
      for (const action of actions) {
        handleActionExecution(action, orch, ctx, deps, log);
      }
      if (interactiveTiming) {
        interactiveTiming.timingsMs.actionExecution = elapsedMs(nowMs, actionExecutionStartMs);
      }

      if (deps.crewBroker) {
        for (const orchItem of orch.getAllItems()) {
          const prevState = prevStates.get(orchItem.id);
          if (!prevState || prevState === orchItem.state || !isCrewCompletionState(orchItem, orch.config.fixForward)) {
            continue;
          }

          try {
            const model = resolveCompletionModel(orchItem, ctx);
            const completionAction = actions.find((action) => action.itemId === orchItem.id)
              ?? { type: "clean", itemId: orchItem.id };
            const tokenUsage = deps.readTokenUsage?.(orchItem, completionAction, ctx)
              ?? readLatestTokenUsage(ctx.projectRoot, orchItem.aiTool ?? ctx.aiTool ?? "unknown", {
                since: orchItem.startedAt,
              });
            deps.crewBroker.report("complete", orchItem.id, buildCompletionReportMetadata(orchItem), {
              model,
              tokenUsage,
            });
          } catch { /* best-effort */ }

          try {
            deps.crewBroker.complete(orchItem.id);
          } catch { /* best-effort */ }
        }
      }

    // Sync cmux sidebar display for active workers
      const displaySyncStartMs = interactiveTiming ? nowMs() : 0;
      try {
        deps.syncDisplay?.(orch, snapshot);
      } catch { /* best-effort -- display sync failure shouldn't block the orchestrator */ }
      if (interactiveTiming) {
        interactiveTiming.timingsMs.displaySync = elapsedMs(nowMs, displaySyncStartMs);
      }

    // Log state summary
    const states: Record<string, string[]> = {};
    for (const item of orch.getAllItems()) {
      if (!states[item.state]) states[item.state] = [];
      states[item.state]!.push(item.id);
    }
    log({ ts: new Date().toISOString(), level: "debug", event: "state_summary", states });

    // ── External PR review processing ───────────────────────────
      if (config.reviewExternal && deps.externalReviewDeps) {
      try {
        externalReviews = processExternalReviews(
          ctx.projectRoot,
          externalReviews,
          orch.wipSlots,
          deps.externalReviewDeps,
        );
        // Persist external review state
        writeExternalReviews(ctx.projectRoot, externalReviews);
      } catch (e: unknown) {
        // Non-fatal -- external review failure shouldn't block work item processing
        const msg = e instanceof Error ? e.message : String(e);
        log({
          ts: new Date().toISOString(),
          level: "warn",
          event: "external_review_error",
          error: msg,
        });
      }
    }

    // Sleep -- adaptive or fixed override
      const interval = config.pollIntervalMs ?? adaptivePollInterval(orch);

      // Persist state for daemon mode (or any caller that wants snapshots)
      // Pass interval so TUI can set countdown target and capture render timing.
      deps.onPollComplete?.(orch.getAllItems(), snapshot, interval, interactiveTiming);
      if (interactiveTiming) {
        pendingInteractiveTiming = interactiveTiming;
      }

      await deps.sleep(interval);
    }
  } finally {
    lagSampler?.stop();
  }

  return {};
}

// ── Memory-aware WIP default ────────────────────────────────────────

/**
 * Compute a sensible default WIP limit based on available system memory.
 * Each parallel worker consumes ~2-3GB RAM (Claude Code + language server + git worktree),
 * so we allocate one slot per 3GB of total RAM, with a minimum of 2.
 *
 * @param getTotalMemory - Injectable for testing; defaults to os.totalmem()
 */
export function computeDefaultWipLimit(getTotalMemory: () => number = totalmem): number {
  const totalBytes = getTotalMemory();
  const totalGB = totalBytes / (1024 ** 3);
  return Math.max(2, Math.floor(totalGB / 3));
}

// ── CLI command ─────────────────────────────────────────────────────

/** Renamed entry point: `nw watch` dispatches here. */
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
    backendModeOverride,
    wipLimitOverride, pollIntervalOverride, frictionDir,
    daemonMode, isDaemonChild, isInteractiveEngineChild, clickupListId, remoteFlag,
    reviewAutoFix, reviewExternal: parsedReviewExternal, reviewWipLimit,
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

  // Compute memory-aware WIP default, allow --wip-limit to override
  // Precedence: CLI --wip-limit > persisted user preference > computed default
  const computedWipLimit = computeDefaultWipLimit();
  const persistedUserCfg = loadUserConfig();
  const wipLimitFromCli = wipLimitOverride !== undefined;
  let wipLimit = wipLimitOverride ?? persistedUserCfg.wip_limit ?? computedWipLimit;
  let startupBackendMode = backendModeOverride ?? persistedUserCfg.backend_mode ?? "auto";

  // Apply custom GitHub token before any startup PR polling so replay pruning,
  // selection, and watch scans all see the same authenticated view.
  applyGithubToken(projectRoot);

  const loadRunnableWorkItems = (source: "startup" | "watch-scan" | "run-more"): WorkItem[] => {
    const parsedItems = parseWorkItems(workDir, worktreeDir, projectRoot);
    const { activeItems, prunedItems } = pruneMergedStartupReplayItems(parsedItems, projectRoot);
    if (prunedItems.length > 0) {
      log({
        ts: new Date().toISOString(),
        level: "info",
        event: "startup_replay_pruned",
        source,
        count: prunedItems.length,
        items: prunedItems,
      });
    }
    return activeItems;
  };

  // Parse work items (needed for both interactive and flag-based modes)
  // Pass projectRoot to filter to only items pushed to origin/main
  const workItems = loadRunnableWorkItems("startup");
  const preConfig = loadConfig(projectRoot);
  const interactiveStartupConfig = resolveInteractiveStartupConfig(preConfig, persistedUserCfg, toolOverride);

  // Interactive mode: no --items and stdin is a TTY
  let interactiveSkipReview = false;
  let interactiveReviewMode: "all" | "mine" | "off" | null = null;
  if (shouldEnterInteractive(itemIds.length > 0)) {
    // Pre-detect tools and config for TUI flow
    const installedTools = detectInstalledAITools();

    const result = await runInteractiveFlow(workItems, wipLimit, {
      defaultReviewMode: interactiveStartupConfig.defaults.reviewMode,
      defaultSettings: interactiveStartupConfig.defaults,
      installedTools,
      savedToolIds: interactiveStartupConfig.savedToolIds,
      skipToolStep: interactiveStartupConfig.skipToolStep,
    });
    if (!result) {
      process.exit(0);
    }
    itemIds = result.itemIds;
    watchMode = watchMode || result.allSelected || result.futureOnly === true;
    futureOnlyStartup = futureOnlyStartup || result.futureOnly === true;
    mergeStrategy = result.mergeStrategy;
    wipLimit = result.wipLimit;
    startupBackendMode = result.backendMode ?? startupBackendMode;
    interactiveReviewMode = result.reviewMode;
    interactiveSkipReview = result.reviewMode === "off";
    try {
      saveUserConfig({
        backend_mode: startupBackendMode,
        merge_strategy: result.mergeStrategy === "auto" ? "auto" : "manual",
        review_mode: result.reviewMode,
        wip_limit: result.wipLimit,
      });
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
    event: "wip_limit_resolved",
    computedDefault: computedWipLimit,
    persistedUserWip: persistedUserCfg.wip_limit,
    effectiveLimit: wipLimit,
    overridden: wipLimitFromCli,
    totalMemoryGB: Math.round(totalmem() / (1024 ** 3)),
  });

  if (itemIds.length === 0 && !watchMode && !daemonMode) {
    die(
      "Usage: nw --items ID1 ID2 ... [--merge-strategy auto|manual] [--wip-limit N] [--poll-interval SECS] [--daemon] [--no-watch] [--watch-interval SECS]",
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

  // Create orchestrator
  // skipReview: CLI --no-review, interactive "off" mode, or --review-wip-limit 0 disables AI review gate
  const skipReview = cliSkipReview || interactiveSkipReview || reviewWipLimit === 0;
  let orch = new Orchestrator({
    wipLimit,
    mergeStrategy,
    bypassEnabled,
    fixForward,
    skipReview,
    ...((tuiMode || isInteractiveEngineChild) ? {} : { gracePeriodMs: 0 }),
    ...(reviewAutoFix !== undefined ? { reviewAutoFix } : {}),
  });
  for (const id of itemIds) {
    orch.addItem(workItemMap.get(id)!);
  }

  // Pre-create domain labels so workers don't need to (one API call per unique domain)
  const domainSet = new Set(itemIds.map(id => workItemMap.get(id)!.domain));
  if (fixForward) domainSet.add("verify");
  ensureDomainLabels(projectRoot, [...domainSet]);

  // Populate resolvedRepoRoot for cross-repo items
  for (const item of orch.getAllItems()) {
    const alias = item.workItem.repoAlias;
    if (alias && alias !== "self" && alias !== "hub") {
      try {
        item.resolvedRepoRoot = resolveRepo(alias, projectRoot);
      } catch {
        // Resolution failed -- if item has bootstrap: true, the orchestrator will
        // bootstrap the repo before launch (via the bootstrap action). Log the
        // deferred resolution. Non-bootstrap items stay hub-local as fallback.
        if (item.workItem.bootstrap) {
          log({
            ts: new Date().toISOString(),
            level: "info",
            event: "cross_repo_bootstrap_deferred",
            itemId: item.id,
            alias,
          });
        } else {
          log({
            ts: new Date().toISOString(),
            level: "warn",
            event: "cross_repo_resolve_failed",
            itemId: item.id,
            alias,
          });
        }
      }
    }
  }

  // Real action dependencies -- create mux before state reconstruction so
  // workspace refs can be recovered from live workspaces.
  const resolvedBackend = resolveBackend({
    env: process.env,
    checkBinary: (name: string): boolean => {
      if (name === "cmux") return resolveCmuxBinary() !== null;
      return Bun.which(name) !== null;
    },
    savedBackendMode: startupBackendMode,
  });
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
    const runtimeResolvedBackend = resolveBackend({
      env: process.env,
      checkBinary: (name: string): boolean => {
        if (name === "cmux") return resolveCmuxBinary() !== null;
        return Bun.which(name) !== null;
      },
      savedBackendMode: startupBackendMode,
    });
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
  // from previous runs don't confuse reconstructState or count toward WIP.
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
        const match = trimmed.match(/workspace:\d+/);
        mux.closeWorkspace(match?.[0] ?? trimmed);
        return;
      }
    },
    log,
  });

  // Reconstruct state from disk + GitHub (crash recovery)
  // Pass saved daemon state so counters (ciFailCount, retryCount) survive restarts
  const savedDaemonState = readStateFile(projectRoot);
  reconstructState(orch, projectRoot, worktreeDir, mux, undefined, savedDaemonState);

  // Select AI tool(s) (interactive prompt when multiple tools installed)
  const isInteractive = !isDaemonChild && !daemonMode && process.stdin.isTTY === true;
  const aiTools = await selectAiTools({ toolOverride, projectRoot, isInteractive });
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
    launchSingleItem: (item, workDir, worktreeDir, projectRoot, aiTool, baseBranch, forceWorkerLaunch) =>
      launchSingleItem(item, workDir, worktreeDir, projectRoot, aiTool, mux, { baseBranch, forceWorkerLaunch, hubRepoNwo }),
    cleanStaleBranch: (item, projRoot) => {
      let targetRepo: string;
      try {
        targetRepo = resolveRepo(item.repoAlias, projRoot);
      } catch {
        return; // Can't resolve repo -- launchSingleItem will handle the error
      }
      cleanStaleBranchForReuse(item.id, item.title, targetRepo, undefined, item.lineageToken);
    },
    cleanSingleWorktree,
    prMerge: (repoRoot, prNumber, options) => prMerge(repoRoot, prNumber, options),
    prComment: (repoRoot, prNumber, body) => prComment(repoRoot, prNumber, body),
    syncStackComments: (baseBranch, stack) => {
      syncStackCommentsForRepo(baseBranch, stack, {
        listComments: (prNumber) => listPrComments(projectRoot, prNumber),
        createComment: (prNumber, body) => prComment(projectRoot, prNumber, body),
        updateComment: (commentId, body) => updatePrComment(projectRoot, commentId, body),
      });
    },
    upsertOrchestratorComment: (repoRoot, prNumber, itemId, eventLine) =>
      upsertOrchestratorComment(repoRoot, prNumber, itemId, eventLine),
    writeInbox: (targetRoot, itemId, msg) => writeInbox(targetRoot, itemId, msg),
    closeWorkspace: (ref) => muxForWorkspaceRef(ref).closeWorkspace(ref),
    readScreen: (ref, lines) => muxForWorkspaceRef(ref).readScreen(ref, lines),
    fetchOrigin,
    ffMerge,
    checkPrMergeable,
    daemonRebase,
    warn: (message) =>
      log({ ts: new Date().toISOString(), level: "warn", event: "orchestrator_warning", message }),
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
    bootstrapRepo: (alias, projRoot) => bootstrapRepo(alias, projRoot),
    cleanReview: (itemId, reviewWorkspaceRef) => {
      // Close the review workspace
      try { muxForWorkspaceRef(reviewWorkspaceRef).closeWorkspace(reviewWorkspaceRef); } catch { /* best-effort */ }
      // Clean the review worktree if it exists (only for direct/pr modes)
      try {
        cleanSingleWorktree(`review-${itemId}`, join(projectRoot, ".ninthwave", ".worktrees"), projectRoot);
      } catch { /* best-effort -- review worktree may not exist for off mode */ }
      return true;
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
    cleanRebaser: (itemId, rebaserWorkspaceRef) => {
      try { muxForWorkspaceRef(rebaserWorkspaceRef).closeWorkspace(rebaserWorkspaceRef); } catch { /* best-effort */ }
      return true;
    },
    setCommitStatus: (repoRoot, prNumber, state, context, description) => {
      const sha = prHeadSha(repoRoot, prNumber);
      if (!sha) return false;
      return ghSetCommitStatus(repoRoot, sha, state, context, description);
    },
    getMergeCommitSha: (repoRoot, prNumber) => ghGetMergeCommitSha(repoRoot, prNumber),
    checkCommitCI: (repoRoot, sha) => ghCheckCommitCI(repoRoot, sha),
    getDefaultBranch: (repoRoot) => ghGetDefaultBranch(repoRoot),
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
    cleanForwardFixer: (itemId, fixForwardWorkspaceRef) => {
      try { muxForWorkspaceRef(fixForwardWorkspaceRef).closeWorkspace(fixForwardWorkspaceRef); } catch { /* best-effort */ }
      try {
        cleanSingleWorktree(`ninthwave-fix-forward-${itemId}`, join(projectRoot, ".ninthwave", ".worktrees"), projectRoot);
      } catch { /* best-effort -- forward-fixer worktree may already be cleaned */ }
      return true;
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
    info(`  Join: nw watch --crew ${crewCode}`);
  }

  if (crewCode) {
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
  // --review-wip-limit 0 explicitly disables reviews, overriding config
  const reviewExternalEnabled = reviewWipLimit === 0
    ? false
    : interactiveReviewMode === "all"
      ? true
      : interactiveReviewMode === "mine" || interactiveReviewMode === "off"
        ? false
        : (parsedReviewExternal || projectConfig.review_external);
  const scheduleEnabled = projectConfig.schedule_enabled;

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
  cleanStateFile(projectRoot);
  const initialCrewStatus = crewBroker?.getCrewStatus();
  const initialState = serializeOrchestratorState(orch.getAllItems(), process.pid, daemonStartedAt, {
    wipLimit,
    operatorId,
    remoteItemSnapshots: crewStatusToRemoteItemSnapshots(initialCrewStatus),
    crewStatus: crewStatusToDaemonCrewStatus(initialCrewStatus, crewCode, crewBroker?.isConnected() ?? false),
    ...(futureOnlyStartup ? { emptyState: "watch-armed" as const } : {}),
  });
  writeStateFile(projectRoot, initialState);

  // TUI state: scroll offset and view option toggles (shared with keyboard handler)
  // Read persisted layout preference (defaults to "status-only" if missing/corrupt)
  const savedPanelMode = tuiMode ? readLayoutPreference(projectRoot) : "status-only";
  const initialCollaborationMode = collaborationState.mode === "local"
    ? persistedCollaborationModeToRuntime(interactiveStartupConfig.defaults.collaborationMode)
    : collaborationState.mode;
  const initialReviewMode = orch.config.skipReview
    ? "off" as const
    : reviewExternalEnabled ? "all-prs" as const : "ninthwave-prs" as const;
  let operatorLastSnapshot: InteractiveEngineSnapshotRenderState = {
    daemonState: initialState,
    runtime: {
      mergeStrategy: orch.config.mergeStrategy,
      wipLimit,
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
    getWipLimit: () => tuiState.pendingWipLimit ?? wipLimit,
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
        reviewMode: initialReviewMode,
        ...(futureOnlyStartup ? { emptyState: "watch-armed" as const } : {}),
    },
    wipLimit,
    pendingWipLimit: undefined,
    mergeStrategy: orch.config.mergeStrategy,
    pendingStrategy: undefined,
    pendingStrategyTimer: undefined,
    bypassEnabled: orch.config.bypassEnabled,
    ctrlCPending: false,
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
          renderTuiPanelFrame(lastTuiItems, wipLimit, tuiState, undefined, getRemoteItemSnapshots(), orch.config.maxTimeoutExtensions, lastTuiHeartbeats);
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
          renderTuiPanelFrame(lastTuiItems, wipLimit, tuiState, undefined, getRemoteItemSnapshots(), orch.config.maxTimeoutExtensions, lastTuiHeartbeats);
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
      // Populate schedule worker status for TUI display
      if (scheduleLoopDeps) {
        try {
          const schedState = readScheduleState(projectRoot);
          tuiState.viewOptions.scheduleWorkers = schedState.active.map((w) => ({
            taskId: w.taskId,
            startedAt: w.startedAt,
          }));
        } catch {
          tuiState.viewOptions.scheduleWorkers = [];
        }
      }
      const renderStartMs = interactiveTiming ? Date.now() : 0;
      try {
        renderTuiPanelFrame(lastTuiItems, wipLimit, tuiState, undefined, getRemoteItemSnapshots(), orch.config.maxTimeoutExtensions, lastTuiHeartbeats);
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

  // Build schedule deps when schedule_enabled and no crew broker (solo mode only)
  const schedulesDir = join(projectRoot, ".ninthwave", "schedules");
  const scheduleLoopDeps: ScheduleLoopDeps | undefined = (scheduleEnabled && !crewBroker)
    ? {
        listScheduledTasks: () => listScheduledTasksFromDir(schedulesDir),
        readState: readScheduleState,
        writeState: writeScheduleState,
        launchWorker: (task, pr, ai) => launchScheduledTask(task, pr, ai, {
          launchWorkspace: (cwd, cmd, todoId) => mux.launchWorkspace(cwd, cmd, todoId),
        }),
        monitorDeps: {
          listWorkspaces: () => mux.listWorkspaces(),
          closeWorkspace: (ref) => muxForWorkspaceRef(ref).closeWorkspace(ref),
        },
        aiTool,
        triggerDir: scheduleTriggerDir(projectRoot),
      }
    : undefined;

  if (scheduleLoopDeps) {
    log({
      ts: new Date().toISOString(),
      level: "info",
      event: "schedule_enabled",
      schedulesDir,
    });
  }

  const loopDeps: OrchestrateLoopDeps = {
    buildSnapshot: (o, pr, wd) => buildSnapshotAsync(o, pr, wd, mux, undefined, undefined, fetchTrustedPrCommentsAsync, ghCheckCommitCIAsync),
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
    },
    externalReviewDeps,
    ...(watchMode ? { scanWorkItems: () => {
      try { fetchOrigin(projectRoot, "main"); } catch { /* non-fatal */ }
      try { ffMerge(projectRoot, "main"); } catch { /* non-fatal -- dirty tree or diverged */ }
      return loadRunnableWorkItems("watch-scan");
    } } : {}),
    ...(crewBroker ? { crewBroker } : {}),
    ...(scheduleLoopDeps ? { scheduleDeps: scheduleLoopDeps } : {}),
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
        renderTuiPanelFrame(allItems, wipLimit, tuiState, write, getRemoteItemSnapshots(), orch.config.maxTimeoutExtensions, lastTuiHeartbeats);
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
  ) => {
    const crewStatus = crewBroker?.getCrewStatus();
    return serializeOrchestratorState(items, process.pid, daemonStartedAt, {
      statusPaneRef: null,
      wipLimit,
      operatorId,
      remoteItemSnapshots: crewStatusToRemoteItemSnapshots(crewStatus),
      heartbeats,
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
    getWipLimit: () => wipLimit,
    setWipLimit: (limit) => {
      wipLimit = limit;
    },
  });
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
    const inviteCmd = `Join: nw watch --crew ${crewCode}`;
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
          wipLimit: operatorLastSnapshot.runtime.wipLimit,
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
          const freshItems = loadRunnableWorkItems("run-more");
          const interactiveResult = await runInteractiveFlow(freshItems, operatorLastSnapshot.runtime.wipLimit, {
            showConnectionStep: false,
            skipToolStep: true,
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
            wipLimit: operatorLastSnapshot.runtime.wipLimit,
            mergeStrategy: operatorLastSnapshot.runtime.mergeStrategy,
            bypassEnabled,
            fixForward,
            skipReview: operatorLastSnapshot.runtime.reviewMode === "off",
            ...(reviewAutoFix !== undefined ? { reviewAutoFix } : {}),
          });
          for (const item of nextItems) nextOrch.addItem(item);
          const nextState = serializeOrchestratorState(nextOrch.getAllItems(), process.pid, daemonStartedAt, {
            wipLimit: operatorLastSnapshot.runtime.wipLimit,
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
              if (item.workspaceRef) muxForWorkspaceRef(item.workspaceRef).closeWorkspace(item.workspaceRef);
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
        const freshItems = loadRunnableWorkItems("run-more");
        const interactiveResult = await runInteractiveFlow(freshItems, wipLimit, {
          showConnectionStep: false,
          skipToolStep: true,
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
        // Local-first: keep current session's merge/review/WIP policy.
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
    // Close workspaces for terminal items only (done, stuck, merged).
    // In-flight workers (implementing, ci-pending, etc.) may still be actively
    // running -- leave their workspaces open so they survive orchestrator restarts.
    // On restart, reconstructState recovers their workspace refs.
    const terminalStates = new Set(["done", "stuck", "merged"]);
    const closedWorkspaces: string[] = [];
    for (const item of orch.getAllItems()) {
      if (terminalStates.has(item.state) && item.workspaceRef) {
        try {
          muxForWorkspaceRef(item.workspaceRef).closeWorkspace(item.workspaceRef);
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

    // Always clean up state file on exit (written in both daemon and interactive mode)
    cleanStateFile(projectRoot);

    // Clean up PID file on exit (both foreground and daemon child)
    if (!isInteractiveEngineChild) {
      cleanPidFile(projectRoot);
    }
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
