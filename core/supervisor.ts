// LLM supervisor tick for the orchestrate event loop.
// Periodically pipes recent logs + current state into an LLM prompt for judgment.
// The supervisor is advisory — the daemon continues regardless of supervisor output.

import { existsSync } from "fs";
import { appendFileSync } from "fs";
import { join } from "path";
import { run } from "./shell.ts";
import type { LogEntry } from "./commands/orchestrate.ts";
import type { OrchestratorItem } from "./orchestrator.ts";

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
  /** Path to append friction observations. Optional. */
  frictionLogPath?: string;
  /** Maximum number of log entries to include in the prompt. */
  maxLogEntries: number;
}

/** Dependencies injected into the supervisor for testability. */
export interface SupervisorDeps {
  /** Call the LLM with a prompt and return the raw response. */
  callLLM: (prompt: string) => string | null;
  /** Get the current wall-clock time. */
  now: () => Date;
  /** Log a structured event. */
  log: (entry: LogEntry) => void;
  /** Append to a file. */
  appendFile: (path: string, content: string) => void;
}

// ── Default LLM caller ──────────────────────────────────────────────

/**
 * Call the claude CLI with a prompt. Returns the response or null on failure.
 * Uses --print mode for non-interactive single-shot prompts.
 */
export function callClaudeCLI(prompt: string): string | null {
  const result = run("claude", [
    "--print",
    "--model", "haiku",
    prompt,
  ]);
  if (result.exitCode !== 0) return null;
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
): string {
  const logSection = recentLogs.length > 0
    ? recentLogs.map((l) => JSON.stringify(l)).join("\n")
    : "(no recent log entries)";

  const itemSection = items.map((item) => {
    const elapsedMs = elapsedByItem.get(item.id) ?? 0;
    const elapsedMin = Math.round(elapsedMs / 60_000);
    return `- ${item.id}: state=${item.state}, elapsed=${elapsedMin}min, ciFailCount=${item.ciFailCount}${item.prNumber ? `, PR=#${item.prNumber}` : ""}`;
  }).join("\n");

  return `You are an engineering supervisor reviewing a parallel AI coding pipeline.

## Current Item States
${itemSection}

## Recent Log Entries (since last tick)
${logSection}

## Instructions

Analyze the pipeline state and respond with a JSON object (no markdown fencing) containing:

1. "anomalies": string[] — Anything stuck or abnormal. A worker idle in "implementing" for >10 minutes, CI cycling on the same error, a PR open with no commits for 10+ minutes.

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
): SupervisorObservation {
  const now = deps.now();

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
  );

  const response = deps.callLLM(prompt);

  if (!response) {
    deps.log({
      ts: now.toISOString(),
      level: "warn",
      event: "supervisor_tick",
      status: "llm_call_failed",
    });
    // Return empty observation — daemon continues
    return {
      anomalies: [],
      interventions: [],
      frictionObservations: [],
      processImprovements: [],
    };
  }

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
 * Append friction observations to the friction log file.
 */
export function writeFrictionLog(
  observation: SupervisorObservation,
  frictionLogPath: string,
  appendFile: (path: string, content: string) => void,
): void {
  const entries = [
    ...observation.frictionObservations.map((f) => `- [friction] ${f}`),
    ...observation.processImprovements.map((p) => `- [improvement] ${p}`),
  ];

  if (entries.length === 0) return;

  const header = `\n## Supervisor tick ${new Date().toISOString()}\n`;
  appendFile(frictionLogPath, header + entries.join("\n") + "\n");
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
    appendFile: (path, content) => appendFileSync(path, content, "utf-8"),
  };
}
