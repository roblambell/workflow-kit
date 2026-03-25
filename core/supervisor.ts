// LLM supervisor tick for the orchestrate event loop.
// Periodically pipes recent logs + current state into an LLM prompt for judgment.
// The supervisor is advisory — the daemon continues regardless of supervisor output.

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { run } from "./shell.ts";
import type { LogEntry } from "./commands/orchestrate.ts";
import type { OrchestratorItem } from "./orchestrator.ts";
import type { ScreenHealthStatus } from "./worker-health.ts";

// ── Types ─────────────────────────────────────────────────────────────

/** A suggested action the supervisor wants the daemon to take. */
export interface SupervisorAction {
  type: "send-message" | "adjust-wip" | "escalate";
  /** Target item ID for send-message actions. */
  itemId?: string;
  /** Message content for send-message actions. */
  message?: string;
  /** New WIP limit for adjust-wip actions. */
  wipLimit?: number;
  /** Reason for escalation. */
  reason?: string;
}

/** Structured observation from a supervisor tick. */
export interface SupervisorObservation {
  anomalies: string[];
  interventions: SupervisorAction[];
  frictionObservations: string[];
  processImprovements: string[];
}

/** Configuration for the supervisor. */
export interface SupervisorConfig {
  /** Interval between ticks in milliseconds. Default: 300_000 (5 minutes). */
  intervalMs: number;
  /** Directory to write individual friction files. Optional. */
  frictionDir?: string;
  /** Maximum number of log entries to include in the prompt. */
  maxLogEntries: number;
}

/** Dependencies injected into the supervisor for testability. */
export interface SupervisorDeps {
  /** Call the LLM with a prompt and return the raw response. Throws on failure. */
  callLLM: (prompt: string) => string;
  /** Get the current wall-clock time. */
  now: () => Date;
  /** Log a structured event. */
  log: (entry: LogEntry) => void;
  /** Write a file. */
  writeFile: (path: string, content: string) => void;
  /** Create a directory (recursive). */
  mkdirSync: (path: string, opts: { recursive: boolean }) => void;
}

// ── Default LLM caller ──────────────────────────────────────────────

/**
 * Call the claude CLI with a prompt. Returns the response or throws on failure.
 * Uses --print mode for non-interactive single-shot prompts.
 */
export function callClaudeCLI(prompt: string): string {
  const result = run("claude", [
    "--print",
    "--model", "haiku",
    prompt,
  ]);
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || `exit code ${result.exitCode}`;
    throw new Error(`claude CLI failed: ${detail}`);
  }
  return result.stdout;
}

// ── Prompt construction ─────────────────────────────────────────────

/**
 * Build the supervisor prompt from recent logs and current item states.
 * Exported for testing.
 */
export function buildSupervisorPrompt(
  recentLogs: LogEntry[],
  items: OrchestratorItem[],
  elapsedByItem: Map<string, number>,
  now: Date = new Date(),
  screenHealthByItem?: Map<string, ScreenHealthStatus>,
): string {
  const logSection = recentLogs.length > 0
    ? recentLogs.map((l) => JSON.stringify(l)).join("\n")
    : "(no recent log entries)";

  const itemSection = items.map((item) => {
    const elapsedMs = elapsedByItem.get(item.id) ?? 0;
    const elapsedMin = Math.round(elapsedMs / 60_000);
    let line = `- ${item.id}: state=${item.state}, elapsed=${elapsedMin}min, ciFailCount=${item.ciFailCount}`;
    if (item.prNumber) line += `, PR=#${item.prNumber}`;
    // Include commit freshness for active worker items
    if (item.state === "launching" || item.state === "implementing") {
      if (item.lastCommitTime) {
        const commitAge = now.getTime() - new Date(item.lastCommitTime).getTime();
        const commitAgeMin = Math.round(commitAge / 60_000);
        line += `, lastCommit=${commitAgeMin}min ago`;
      } else {
        line += `, lastCommit=none`;
      }
    }
    // Include screen health when available
    const health = screenHealthByItem?.get(item.id);
    if (health) line += `, screenHealth=${health}`;
    return line;
  }).join("\n");

  // Build screen health distribution summary when data is available
  let healthSummary = "";
  if (screenHealthByItem && screenHealthByItem.size > 0) {
    const counts = new Map<string, number>();
    for (const status of screenHealthByItem.values()) {
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const [status, count] of counts) {
      parts.push(`${count} ${status}`);
    }
    healthSummary = `\n\n## Screen Health Summary\n${parts.join(", ")}`;
  }

  return `You are an engineering supervisor reviewing a parallel AI coding pipeline.

## Current Item States
${itemSection}${healthSummary}

## Recent Log Entries (since last tick)
${logSection}

## Instructions

Analyze the pipeline state and respond with a JSON object (no markdown fencing) containing:

1. "anomalies": string[] — Anything stuck or abnormal. Use commit freshness (lastCommit) to distinguish active workers (recent commits) from stalled ones (no recent commits). A worker in "implementing" for 8 min with commits 2 min ago is healthy; one with no commits for 8 min is likely stuck. Use screenHealth to detect subtler issues: a worker with screenHealth=stalled-empty that was already nudged but hasn't recovered after 5 minutes likely needs escalation. If all workers show stalled screen health, suspect an environment problem rather than individual worker issues. Also flag CI cycling on the same error, a PR open with no activity, etc.

2. "interventions": { type: "send-message" | "adjust-wip" | "escalate", itemId?: string, message?: string, wipLimit?: number, reason?: string }[] — Concrete actions to unstick the pipeline. Only suggest when clearly warranted.

3. "frictionObservations": string[] — Anything surprising about how the pipeline is behaving. Slowdowns, unexpected patterns, things that worked well.

4. "processImprovements": string[] — Patterns across workers that suggest systemic fixes (e.g., "3 workers hit the same import error — add a CLAUDE.md note").

Be concise. Only flag genuine issues. An empty array means "nothing to report" for that category.`;
}

// ── Response parsing ────────────────────────────────────────────────

/**
 * Parse the LLM response into a structured observation.
 * Handles malformed responses gracefully — returns empty observation on failure.
 */
export function parseSupervisorResponse(raw: string): SupervisorObservation {
  const empty: SupervisorObservation = {
    anomalies: [],
    interventions: [],
    frictionObservations: [],
    processImprovements: [],
  };

  try {
    // Try to extract JSON from the response (handle markdown code fences)
    let jsonStr = raw.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1]!.trim();
    }

    const parsed = JSON.parse(jsonStr);

    return {
      anomalies: Array.isArray(parsed.anomalies) ? parsed.anomalies : [],
      interventions: Array.isArray(parsed.interventions) ? parsed.interventions : [],
      frictionObservations: Array.isArray(parsed.frictionObservations) ? parsed.frictionObservations : [],
      processImprovements: Array.isArray(parsed.processImprovements) ? parsed.processImprovements : [],
    };
  } catch {
    return empty;
  }
}

// ── Supervisor tick ─────────────────────────────────────────────────

/** State tracked between supervisor ticks. */
export interface SupervisorState {
  lastTickTime: Date;
  logsSinceLastTick: LogEntry[];
  /** Number of consecutive LLM call failures (for backoff). */
  consecutiveFailures: number;
  /** Whether the supervisor has been disabled due to too many failures. */
  disabled: boolean;
}

// ── Backoff constants ─────────────────────────────────────────────

/** Number of consecutive failures before backoff kicks in. */
export const BACKOFF_THRESHOLD = 3;

/** Number of consecutive failures before the supervisor is disabled. */
export const DISABLE_THRESHOLD = 10;

/** Maximum supervisor interval after backoff (30 minutes). */
export const MAX_BACKOFF_INTERVAL_MS = 1_800_000;

/**
 * Compute the effective supervisor interval with exponential backoff.
 * After BACKOFF_THRESHOLD consecutive failures, the interval doubles
 * for each additional failure, capped at MAX_BACKOFF_INTERVAL_MS.
 */
export function getEffectiveInterval(
  baseIntervalMs: number,
  consecutiveFailures: number,
): number {
  if (consecutiveFailures < BACKOFF_THRESHOLD) return baseIntervalMs;
  const doublings = consecutiveFailures - BACKOFF_THRESHOLD + 1;
  const multiplier = Math.pow(2, doublings);
  return Math.min(baseIntervalMs * multiplier, MAX_BACKOFF_INTERVAL_MS);
}

/**
 * Execute a single supervisor tick.
 * Collects recent logs, builds a prompt, calls the LLM, processes observations.
 * Returns the observation and any suggested actions.
 *
 * This function is the main entry point called by the orchestrate loop.
 */
export function supervisorTick(
  state: SupervisorState,
  items: OrchestratorItem[],
  deps: SupervisorDeps,
  screenHealthByItem?: Map<string, ScreenHealthStatus>,
): SupervisorObservation {
  const now = deps.now();
  const empty: SupervisorObservation = {
    anomalies: [],
    interventions: [],
    frictionObservations: [],
    processImprovements: [],
  };

  // Compute elapsed time per item in current state
  const elapsedByItem = new Map<string, number>();
  for (const item of items) {
    const lastTransition = new Date(item.lastTransition);
    elapsedByItem.set(item.id, now.getTime() - lastTransition.getTime());
  }

  // Build and execute prompt
  const prompt = buildSupervisorPrompt(
    state.logsSinceLastTick,
    items,
    elapsedByItem,
    now,
    screenHealthByItem,
  );

  let response: string;
  try {
    response = deps.callLLM(prompt);
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    state.consecutiveFailures++;

    deps.log({
      ts: now.toISOString(),
      level: "warn",
      event: "supervisor_tick",
      status: "llm_call_failed",
      error: errorMsg,
      consecutiveFailures: state.consecutiveFailures,
    });

    // Check if we should disable the supervisor
    if (state.consecutiveFailures >= DISABLE_THRESHOLD) {
      state.disabled = true;
      deps.log({
        ts: now.toISOString(),
        level: "warn",
        event: "supervisor_disabled",
        reason: `${state.consecutiveFailures} consecutive LLM failures`,
      });
    }

    // Update tick time so backoff interval applies from this point
    state.lastTickTime = now;
    return empty;
  }

  // Success — reset backoff counter
  state.consecutiveFailures = 0;

  const observation = parseSupervisorResponse(response);

  // Log the observation as a structured event
  deps.log({
    ts: now.toISOString(),
    level: "info",
    event: "supervisor_tick",
    status: "ok",
    anomalies: observation.anomalies,
    interventions: observation.interventions.map((a) => ({
      type: a.type,
      itemId: a.itemId,
      reason: a.reason,
    })),
    frictionObservations: observation.frictionObservations,
    processImprovements: observation.processImprovements,
  });

  // Clear logs since last tick
  state.logsSinceLastTick = [];
  state.lastTickTime = now;

  return observation;
}

/**
 * Apply supervisor-suggested actions.
 * Executes send-message actions via cmux.
 * Returns the number of actions executed.
 */
export function applySupervisorActions(
  observation: SupervisorObservation,
  items: OrchestratorItem[],
  sendMessage: (workspaceRef: string, message: string) => boolean,
  log: (entry: LogEntry) => void,
): number {
  let executed = 0;

  for (const action of observation.interventions) {
    if (action.type === "send-message" && action.itemId && action.message) {
      const item = items.find((i) => i.id === action.itemId);
      if (item?.workspaceRef) {
        const sent = sendMessage(item.workspaceRef, action.message);
        if (sent) {
          log({
            ts: new Date().toISOString(),
            level: "info",
            event: "supervisor_action",
            actionType: "send-message",
            itemId: action.itemId,
            message: action.message,
          });
          executed++;
        }
      }
    } else if (action.type === "escalate") {
      log({
        ts: new Date().toISOString(),
        level: "warn",
        event: "supervisor_action",
        actionType: "escalate",
        reason: action.reason,
      });
      executed++;
    }
  }

  return executed;
}

/**
 * Write friction observations as an individual file in the friction directory.
 * Skips writing entirely when there are no observations or improvements.
 */
export function writeFrictionLog(
  observation: SupervisorObservation,
  frictionDir: string,
  deps: { writeFile: (path: string, content: string) => void; mkdirSync: (path: string, opts: { recursive: boolean }) => void; now?: () => Date },
): void {
  if (
    observation.frictionObservations.length === 0 &&
    observation.processImprovements.length === 0
  ) {
    return;
  }

  const now = (deps.now ?? (() => new Date()))();
  // Drop milliseconds from ISO string for cleaner output
  const isoDate = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  // Filesystem-safe timestamp: replace colons with hyphens
  const safeTimestamp = isoDate.replace(/:/g, "-");
  const filename = `${safeTimestamp}--supervisor.md`;

  const entries = [
    ...observation.frictionObservations.map((f) => `- [friction] ${f}`),
    ...observation.processImprovements.map((p) => `- [improvement] ${p}`),
  ];

  const content = `source: supervisor\ndate: ${isoDate}\n---\n${entries.join("\n")}\n`;

  deps.mkdirSync(frictionDir, { recursive: true });
  deps.writeFile(join(frictionDir, filename), content);
}

/**
 * Check if we're in dogfooding mode (ninthwave developing itself).
 * Detected by the presence of skills/work/SKILL.md in the project root.
 */
export function isDogfoodingMode(projectRoot: string): boolean {
  return existsSync(join(projectRoot, "skills", "work", "SKILL.md"));
}

/**
 * Determine whether the supervisor should be active based on flags and environment.
 */
export function shouldActivateSupervisor(
  supervisorFlag: boolean,
  projectRoot: string,
): boolean {
  // Explicit flag takes priority
  if (supervisorFlag) return true;
  // Auto-activate in dogfooding mode
  return isDogfoodingMode(projectRoot);
}

/** Default supervisor configuration. */
export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  intervalMs: 300_000, // 5 minutes
  maxLogEntries: 100,
};

/** Create real supervisor dependencies. */
export function createSupervisorDeps(
  log: (entry: LogEntry) => void,
): SupervisorDeps {
  return {
    callLLM: callClaudeCLI,
    now: () => new Date(),
    log,
    writeFile: (path, content) => writeFileSync(path, content, "utf-8"),
    mkdirSync: (path, opts) => mkdirSync(path, opts),
  };
}
