// Arg parsing for `nw watch` / `nw orchestrate`. Pure function, injectable for testability.
// Extracted from core/commands/orchestrate.ts for modularity.

import type { MergeStrategy } from "../orchestrator.ts";
import type { WorkItem } from "../types.ts";
import { warn } from "../output.ts";

export interface ParsedWatchArgs {
  itemIds: string[];
  mergeStrategy: MergeStrategy;
  wipLimitOverride?: number;
  pollIntervalOverride?: number;
  frictionDir?: string;
  daemonMode: boolean;
  isDaemonChild: boolean;
  isInteractiveEngineChild: boolean;
  clickupListId?: string;
  remoteFlag: boolean;
  reviewAutoFix?: "off" | "direct" | "pr";
  reviewExternal: boolean;
  reviewWipLimit?: number;
  fixForward: boolean;
  skipReview: boolean;
  watchMode: boolean;
  futureOnlyStartup: boolean;
  noWatch: boolean;
  watchIntervalSecs?: number;
  jsonFlag: boolean;
  skipPreflight: boolean;
  crewCode?: string;
  connectMode: boolean;
  crewPort: number;
  crewUrl?: string;
  crewName?: string;
  bypassEnabled: boolean;
  toolOverride?: string;
}

export function parseWatchArgs(args: string[]): ParsedWatchArgs {
  const itemIds: string[] = [];
  let mergeStrategy: MergeStrategy = "manual";
  let wipLimitOverride: number | undefined;
  let pollIntervalOverride: number | undefined;
  let frictionDir: string | undefined;
  let daemonMode = false;
  let isDaemonChild = false;
  let isInteractiveEngineChild = false;
  let clickupListId: string | undefined;
  let remoteFlag = false;
  let reviewAutoFix: "off" | "direct" | "pr" | undefined;
  let reviewExternal = false;
  let reviewWipLimit: number | undefined;
  let fixForward = true;
  let skipReview = false;
  let watchMode = false;
  let futureOnlyStartup = false;
  let noWatch = false;
  let watchIntervalSecs: number | undefined;
  let jsonFlag = false;
  let skipPreflight = false;
  let crewCode: string | undefined;
  let connectMode = false;
  let crewPort = 0;
  let crewUrl: string | undefined;
  let crewName: string | undefined;
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
      case "--wip-limit":
        wipLimitOverride = parseInt(args[i + 1] ?? "4", 10);
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
        reviewExternal = true;
        i += 1;
        break;
      case "--review-wip-limit":
        reviewWipLimit = parseInt(args[i + 1] ?? "0", 10);
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
        skipReview = true;
        i += 1;
        break;
      case "--review":
        skipReview = false;
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
      case "--crew":
        crewCode = args[i + 1];
        i += 2;
        break;
      case "--connect":
        connectMode = true;
        i += 1;
        break;
      case "--crew-port":
        crewPort = parseInt(args[i + 1] ?? "0", 10);
        i += 2;
        break;
      case "--crew-url":
        crewUrl = args[i + 1];
        i += 2;
        break;
      case "--crew-name":
        crewName = args[i + 1];
        i += 2;
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

  return {
    itemIds, mergeStrategy, wipLimitOverride, pollIntervalOverride, frictionDir,
    daemonMode, isDaemonChild, isInteractiveEngineChild, clickupListId, remoteFlag,
    reviewAutoFix, reviewExternal, reviewWipLimit,
    fixForward, skipReview, watchMode, futureOnlyStartup, noWatch, watchIntervalSecs,
    jsonFlag, skipPreflight, crewCode, connectMode, crewPort, crewUrl, crewName,
    bypassEnabled, toolOverride,
  };
}

/**
 * Validate that all item IDs exist in the todo map.
 * Returns array of unknown IDs (empty = all valid).
 */
export function validateItemIds(itemIds: string[], todoMap: Map<string, WorkItem>): string[] {
  return itemIds.filter(id => !todoMap.has(id));
}
