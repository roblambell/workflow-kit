// Arg parsing for `nw` / `nw orchestrate`. Pure function, injectable for testability.
// Extracted from core/commands/orchestrate.ts for modularity.

import type { MergeStrategy } from "../orchestrator.ts";
import type { WorkItem } from "../types.ts";
import { warn } from "../output.ts";

export interface ParsedWatchArgs {
  itemIds: string[];
  mergeStrategy: MergeStrategy;
  maxInflightOverride?: number;
  pollIntervalOverride?: number;
  frictionDir?: string;
  daemonMode: boolean;
  isDaemonChild: boolean;
  isInteractiveEngineChild: boolean;
  clickupListId?: string;
  remoteFlag: boolean;
  reviewAutoFix?: "off" | "direct" | "pr";
  reviewMaxInflight?: number;
  fixForward: boolean;
  /**
   * Derived convenience: `true` when reviews should be skipped based on CLI
   * flags alone (defaulting to `true` when neither `--review` nor
   * `--no-review` was passed). Downstream flows still consult
   * `cliReviewFlag` to distinguish "user didn't say" from "user asked for
   * reviews off" so an interactive picker choice of `on` can light them up.
   */
  skipReview: boolean;
  /**
   * Explicit review-mode intent from CLI flags:
   * - `"review"`    -- `--review` was the last flag, force reviews on.
   * - `"no-review"` -- `--no-review` was the last flag, force reviews off.
   * - `undefined`   -- neither flag was passed; startup defaults apply.
   *
   * Last flag wins when both are passed.
   */
  cliReviewFlag: "review" | "no-review" | undefined;
  watchMode: boolean;
  futureOnlyStartup: boolean;
  noWatch: boolean;
  watchIntervalSecs?: number;
  jsonFlag: boolean;
  skipPreflight: boolean;
  /**
   * Explicit user intent for broker connection, from CLI flags.
   * - `"connect"`: `--connect` was the last flag -- force auto-connect regardless of config.
   * - `"local"`:   `--local`   was the last flag -- force local mode regardless of config.
   * - `undefined`: neither flag was passed -- `cmdOrchestrate` falls back to the
   *   config-based default (auto-connect when `broker_secret` is present, local otherwise).
   *
   * Last flag wins when both are passed, matching the `--review` / `--no-review` convention.
   */
  connectFlag: "connect" | "local" | undefined;
  /**
   * When true, read a single line from stdin at startup and use it as this
   * session's broker secret. The value is held in memory only and never
   * written back to disk so ephemeral environments (CI runners, containers)
   * can join a crew without leaving the secret on the filesystem. Overrides
   * any file-based or env-var secret.
   */
  brokerSecretStdin: boolean;
  bypassEnabled: boolean;
  toolOverride?: string;
}

export function parseWatchArgs(args: string[]): ParsedWatchArgs {
  const itemIds: string[] = [];
  let mergeStrategy: MergeStrategy = "manual";
  let maxInflightOverride: number | undefined;
  let pollIntervalOverride: number | undefined;
  let frictionDir: string | undefined;
  let daemonMode = false;
  let isDaemonChild = false;
  let isInteractiveEngineChild = false;
  let clickupListId: string | undefined;
  let remoteFlag = false;
  let reviewAutoFix: "off" | "direct" | "pr" | undefined;
  let reviewMaxInflight: number | undefined;
  let fixForward = true;
  let cliReviewFlag: "review" | "no-review" | undefined;
  let watchMode = false;
  let futureOnlyStartup = false;
  let noWatch = false;
  let watchIntervalSecs: number | undefined;
  let jsonFlag = false;
  let skipPreflight = false;
  let connectFlag: "connect" | "local" | undefined;
  let brokerSecretStdin = false;
  let bypassEnabled = false;
  let toolOverride: string | undefined;

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--items":
        // Support both comma-separated (--items A,B,C) and space-separated (--items A B C)
        i += 1;
        while (i < args.length && !args[i]!.startsWith("--")) {
          itemIds.push(...args[i]!.split(",").filter(Boolean));
          i += 1;
        }
        break;
      case "--merge-strategy": {
        const raw = args[i + 1] ?? "auto";
        // Map skill aliases to actual strategies
        const strategyMap: Record<string, MergeStrategy> = {
          auto: "auto", manual: "manual", bypass: "bypass",
          asap: "auto", approved: "auto", ask: "manual",
        };
        mergeStrategy = strategyMap[raw] ?? "auto";
        if (!strategyMap[raw]) {
          warn(`Unknown merge strategy "${raw}", defaulting to "auto"`);
        }
        i += 2;
        break;
      }
      case "--max-inflight":
      case "--session-limit": // deprecated alias -- accepted silently for backward compat
        maxInflightOverride = parseInt(args[i + 1] ?? "4", 10);
        i += 2;
        break;
      case "--poll-interval":
        pollIntervalOverride = parseInt(args[i + 1] ?? "30", 10) * 1000;
        i += 2;
        break;
      case "--orchestrator-ws":
        // Reserved for future use -- workspace ref for the orchestrator itself
        i += 2;
        break;
      case "--friction-log":
        frictionDir = args[i + 1];
        i += 2;
        break;
      case "--daemon":
        daemonMode = true;
        i += 1;
        break;
      case "--_daemon-child":
        isDaemonChild = true;
        i += 1;
        break;
      case "--_interactive-engine-child":
        isInteractiveEngineChild = true;
        i += 1;
        break;
      case "--clickup-list":
        clickupListId = args[i + 1];
        i += 2;
        break;
      case "--review-auto-fix": {
        const autoFixVal = args[i + 1] ?? "off";
        if (autoFixVal !== "off" && autoFixVal !== "direct" && autoFixVal !== "pr") {
          throw new Error(`Invalid --review-auto-fix value: "${autoFixVal}". Must be "off", "direct", or "pr".`);
        }
        reviewAutoFix = autoFixVal;
        i += 2;
        break;
      }
      case "--review-external":
        // Deprecated: external PR review has been removed. Accepted silently
        // for backward compatibility with forked daemon args and user scripts.
        i += 1;
        break;
      case "--review-max-inflight":
      case "--review-session-limit": // deprecated alias -- accepted silently for backward compat
        reviewMaxInflight = parseInt(args[i + 1] ?? "0", 10);
        i += 2;
        break;
      case "--no-fix-forward":
      case "--no-verify-main": // backward compat
        fixForward = false;
        i += 1;
        break;
      case "--fix-forward":
      case "--verify-main": // backward compat
        fixForward = true;
        i += 1;
        break;
      case "--no-review":
        cliReviewFlag = "no-review";
        i += 1;
        break;
      case "--review":
        cliReviewFlag = "review";
        i += 1;
        break;
      case "--watch":
        // Accepted silently for backwards compat (watch is now default for daemon)
        watchMode = true;
        i += 1;
        break;
      case "--future-only-startup":
        futureOnlyStartup = true;
        watchMode = true;
        i += 1;
        break;
      case "--no-watch":
        noWatch = true;
        i += 1;
        break;
      case "--watch-interval":
        watchIntervalSecs = parseInt(args[i + 1] ?? "30", 10);
        i += 2;
        break;
      case "--json":
        jsonFlag = true;
        i += 1;
        break;
      case "--skip-preflight":
        skipPreflight = true;
        i += 1;
        break;
      case "--connect":
        connectFlag = "connect";
        i += 1;
        break;
      case "--local":
        connectFlag = "local";
        i += 1;
        break;
      case "--broker-secret-stdin":
        brokerSecretStdin = true;
        i += 1;
        break;
      case "--dangerously-bypass":
        bypassEnabled = true;
        mergeStrategy = "bypass";
        i += 1;
        break;
      case "--tool":
        toolOverride = args[i + 1];
        i += 2;
        break;
      default:
        throw new Error(`Unknown option: ${args[i]}`);
    }
  }

  // --daemon implies --watch unless --no-watch is explicitly set
  if (daemonMode && !noWatch) {
    watchMode = true;
  }

  // Default is to skip reviews unless the user said `--review`. This matches
  // the startup picker's default of reviews-off -- flipping reviews on
  // mid-session safely picks up anything already at `ready for human review`.
  const skipReview = cliReviewFlag === "review" ? false : true;

  return {
    itemIds, mergeStrategy, maxInflightOverride, pollIntervalOverride, frictionDir,
    daemonMode, isDaemonChild, isInteractiveEngineChild, clickupListId, remoteFlag,
    reviewAutoFix, reviewMaxInflight,
    fixForward, skipReview, cliReviewFlag, watchMode, futureOnlyStartup, noWatch, watchIntervalSecs,
    jsonFlag, skipPreflight, connectFlag, brokerSecretStdin,
    bypassEnabled, toolOverride,
  };
}

/**
 * Validate that all item IDs exist in the work item map.
 * Returns array of unknown IDs (empty = all valid).
 */
export function validateItemIds(itemIds: string[], workItemMap: Map<string, WorkItem>): string[] {
  return itemIds.filter(id => !workItemMap.has(id));
}

/**
 * Resolve the effective broker `connectMode` from the parsed CLI flag and the
 * merged project config.
 *
 * Precedence (highest → lowest):
 *   1. `--connect`   → `true`  (explicit opt-in, regardless of config)
 *   2. `--local`     → `false` (explicit opt-out, regardless of config)
 *   3. config-based default: `true` when `broker_secret` is configured,
 *      `false` otherwise.
 *
 * This is the "auto-connect when crew is configured" policy that replaces the
 * old "local-first: never auto-connect" default.
 */
export function resolveConnectMode(
  connectFlag: "connect" | "local" | undefined,
  brokerSecret: string | undefined,
): boolean {
  if (connectFlag === "connect") return true;
  if (connectFlag === "local") return false;
  return typeof brokerSecret === "string" && brokerSecret.length > 0;
}
