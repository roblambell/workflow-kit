// CLI commands for launching work items: `nw <ID>...` and `nw start <ID>...`.

import { mkdirSync } from "fs";
import { join } from "path";
import { parseWorkItems } from "../parser.ts";
import { die, warn, info, GREEN, BOLD, DIM, RESET } from "../output.ts";
import { splitIds } from "../work-item-files.ts";
import { computeBatches, CircularDependencyError } from "./batch-order.ts";
import { computeDefaultMaxInflight } from "./orchestrate.ts";
import { loadUserConfig } from "../config.ts";
import { type Multiplexer, getMux } from "../mux.ts";
import { cleanupStalePartitions } from "../partitions.ts";
import { cmdConflicts } from "./conflicts.ts";
import { applyGithubToken } from "../gh.ts";
import { launchSingleItem, validatePickupCandidate } from "./launch.ts";
import type { WorkItem } from "../types.ts";
import { selectAiTool } from "../tool-select.ts";

/**
 * CLI-level regex for detecting work item IDs as positional arguments.
 * Matches uppercase IDs like H-RR-1, M-SF-1, L-VIS-15, H-CP-7a.
 * Does NOT match lowercase variants or regular command names.
 */
export const WORK_ITEM_ID_CLI_PATTERN = /^[A-Z]+-[A-Z0-9]+-\d+[a-z]*$/;

/**
 * Launch work items by ID with topological dependency ordering.
 *
 * This is the handler for `nw <ID> [ID2...]` -- the primary way to launch items.
 * It validates IDs, checks dependencies, computes batch order, and launches
 * items layer by layer.
 */
export async function cmdRunItems(
  ids: string[],
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
  muxOverride?: Multiplexer,
  maxInflightOverride?: number,
  toolOverride?: string,
): Promise<void> {
  // Pre-flight: fail fast if the mux backend is not usable (binary missing
  // or no active session). Without this, workers create worktrees first and
  // then fail with misleading errors.
  const muxEarly = muxOverride ?? getMux();
  if (!muxEarly.isAvailable()) {
    die(muxEarly.diagnoseUnavailable());
  }

  const items = parseWorkItems(workDir, worktreeDir);
  const itemMap = new Map<string, WorkItem>();
  for (const item of items) {
    itemMap.set(item.id, item);
  }

  // Validate all IDs exist
  for (const id of ids) {
    if (!itemMap.has(id)) {
      die(`Work item ${id} not found. Run 'nw list' to see available items.`);
    }
  }

  const selectedSet = new Set(ids);

  // Check dependencies: each dep must be either in the selected set or already completed
  for (const id of ids) {
    const item = itemMap.get(id)!;
    for (const depId of item.dependencies) {
      if (selectedSet.has(depId)) continue; // will be launched in correct order
      if (!itemMap.has(depId)) continue; // already completed (work item file removed)
      // Dep exists in work item list but not in selected set -- not ready
      die(
        `Cannot launch ${id}: depends on ${depId} which is neither completed nor included.\n` +
        `  Either include ${depId} in the launch: nw ${[...ids, depId].join(" ")}\n` +
        `  Or complete ${depId} first.`,
      );
    }
  }

  // Compute topological batch order
  let batchAssignments: Map<string, number>;
  let batchCount: number;
  try {
    const result = computeBatches(items, ids);
    batchAssignments = result.assignments;
    batchCount = result.batchCount;
  } catch (e) {
    if (e instanceof CircularDependencyError) {
      die(
        `Circular dependency detected among: ${e.circularItems.join(", ")}.\n` +
        `  Resolve the dependency cycle before launching.`,
      );
    }
    throw e;
  }

  // Log the computed batch plan
  console.log(`${BOLD}Launch plan:${RESET} ${ids.length} item(s) in ${batchCount} batch(es)`);
  for (let b = 1; b <= batchCount; b++) {
    const batchItems = ids.filter((id) => batchAssignments.get(id) === b);
    const labels = batchItems.map((id) => {
      const item = itemMap.get(id)!;
      const titleSnippet = item.title.length > 40
        ? item.title.slice(0, 37) + "..."
        : item.title;
      return `${id} ${DIM}(${titleSnippet})${RESET}`;
    });
    console.log(`  Batch ${b}: ${labels.join(", ")}`);
  }
  // Compute session limit: explicit override honored directly, otherwise use config/default
  // Precedence: CLI --max-inflight > persisted user preference > computed default
  let maxInflight: number;
  if (maxInflightOverride !== undefined) {
    maxInflight = maxInflightOverride;
    info(`Session limit: ${maxInflight} concurrent session(s) (explicit override)`);
  } else {
    maxInflight = loadUserConfig().max_inflight ?? computeDefaultMaxInflight();
    info(`Session limit: ${maxInflight} concurrent session(s)`);
  }
  console.log();

  info("Only items pushed to origin/main will be processed.");

  // Apply custom GitHub token so workers inherit it via environment
  applyGithubToken(projectRoot);

  // Select AI tool (interactive prompt when multiple tools installed)
  const isInteractive = process.stdin.isTTY === true;
  const aiTool = await selectAiTool({ toolOverride, projectRoot, isInteractive });

  // Ensure worktree directory exists
  mkdirSync(worktreeDir, { recursive: true });

  // Clean stale partition locks before allocating
  const partitionDir = join(worktreeDir, ".partitions");
  cleanupStalePartitions(partitionDir, worktreeDir);

  const mux = muxEarly;
  const launched: string[] = [];
  const skipped: string[] = [];
  let maxInflightReached = false;

  // Launch batch by batch, respecting session limit
  for (let b = 1; b <= batchCount && !maxInflightReached; b++) {
    const batchItems = ids.filter((id) => batchAssignments.get(id) === b);

    for (const id of batchItems) {
      if (launched.length >= maxInflight) {
        maxInflightReached = true;
        // Collect all remaining items as skipped
        const remainingInBatch = batchItems.slice(batchItems.indexOf(id));
        skipped.push(...remainingInBatch);
        for (let rb = b + 1; rb <= batchCount; rb++) {
          skipped.push(...ids.filter((sid) => batchAssignments.get(sid) === rb));
        }
        break;
      }

      const item = itemMap.get(id)!;
      const validation = validatePickupCandidate(item, projectRoot);
      if (validation.status === "blocked") {
        warn(`Blocking ${id}: ${validation.failureReason}`);
        continue;
      }
      if (validation.status === "skip-with-pr") {
        warn(`Skipping ${id}: existing PR #${validation.existingPrNumber} already matches this item.`);
        continue;
      }
      const result = launchSingleItem(item, workDir, worktreeDir, projectRoot, aiTool, mux);
      if (!result) {
        die(`Failed to launch ${id}. Aborting remaining items.`);
      }
      launched.push(id);
    }
  }

  console.log();
  console.log(
    `${GREEN}Launched ${launched.length} session(s) via ${aiTool}:${RESET}`,
  );
  for (const id of launched) {
    const item = itemMap.get(id)!;
    console.log(`  - ${id}: ${item.title}`);
  }

  if (skipped.length > 0) {
    console.log();
    warn(
      `Session limit reached (${maxInflight}). ${skipped.length} item(s) skipped:`,
    );
    for (const id of skipped) {
      const item = itemMap.get(id)!;
      console.log(`  ${DIM}- ${id}: ${item.title}${RESET}`);
    }
    console.log();
    info(`Use 'nw' to process all items with automatic queue management.`);
  }
}

export async function cmdStart(
  args: string[],
  workDir: string,
  worktreeDir: string,
  projectRoot: string,
  muxOverride?: Multiplexer,
): Promise<void> {
  // Pre-flight: fail fast if the mux backend is not usable (binary missing
  // or no active session). Without this, workers create worktrees first and
  // then fail with misleading errors.
  const muxEarly = muxOverride ?? getMux();
  if (!muxEarly.isAvailable()) {
    die(muxEarly.diagnoseUnavailable());
  }

  // Parse --tool flag from args
  let toolOverride: string | undefined;
  const toolIdx = args.indexOf("--tool");
  if (toolIdx !== -1) {
    toolOverride = args[toolIdx + 1];
    args = [...args.slice(0, toolIdx), ...args.slice(toolIdx + 2)];
  }

  const ids = splitIds(args);

  if (ids.length < 1) die("Usage: ninthwave start <ID1> [ID2...]");
  const items = parseWorkItems(workDir, worktreeDir);
  const itemMap = new Map<string, WorkItem>();
  for (const item of items) {
    itemMap.set(item.id, item);
  }
  const allIds = new Set(items.map((it) => it.id));

  info("Only items pushed to origin/main will be processed.");

  // Apply custom GitHub token so workers inherit it via environment
  applyGithubToken(projectRoot);

  // Select AI tool (interactive prompt when multiple tools installed)
  const isInteractive = process.stdin.isTTY === true;
  const aiTool = await selectAiTool({ toolOverride, projectRoot, isInteractive });

  // Validate all items exist and check dependencies
  for (const id of ids) {
    const item = itemMap.get(id);
    if (!item) die(`Item ${id} not found`);

    for (const depId of item.dependencies) {
      if (allIds.has(depId)) {
        die(`Item ${id} depends on ${depId} which is not completed`);
      }
    }
  }

  // Check for file-level conflicts between selected items (warn only)
  if (ids.length > 1) {
    info("Checking for file-level conflicts...");
    // Reuse the conflicts command logic inline -- just check, don't die
    const conflictItems = ids.map((id) => itemMap.get(id)!);
    let hasConflicts = false;
    for (let i = 0; i < conflictItems.length; i++) {
      for (let j = i + 1; j < conflictItems.length; j++) {
        const a = conflictItems[i]!;
        const b = conflictItems[j]!;
        const filesA = new Set(a.filePaths);
        const common = b.filePaths.filter((f) => filesA.has(f));
        if (common.length > 0 || a.domain === b.domain) {
          hasConflicts = true;
        }
      }
    }
    if (hasConflicts) {
      cmdConflicts(ids, workDir, worktreeDir);
      console.log();
      warn("Conflicts detected between selected items. Proceeding anyway.");
      console.log();
    }
  }

  // Ensure worktree directory exists
  mkdirSync(worktreeDir, { recursive: true });

  // Clean stale partition locks before allocating
  const partitionDir = join(worktreeDir, ".partitions");
  cleanupStalePartitions(partitionDir, worktreeDir);

  // Compute session limit: persisted user preference > computed default
  const maxInflight = loadUserConfig().max_inflight ?? computeDefaultMaxInflight();
  info(`Session limit: ${maxInflight} concurrent session(s)`);

  const mux = muxEarly;
  const launched: string[] = [];
  const skipped: string[] = [];

  for (const id of ids) {
    if (launched.length >= maxInflight) {
      skipped.push(...ids.slice(ids.indexOf(id)));
      break;
    }
    const item = itemMap.get(id)!;
    const validation = validatePickupCandidate(item, projectRoot);
    if (validation.status === "blocked") {
      warn(`Blocking ${id}: ${validation.failureReason}`);
      continue;
    }
    if (validation.status === "skip-with-pr") {
      warn(`Skipping ${id}: existing PR #${validation.existingPrNumber} already matches this item.`);
      continue;
    }
    launchSingleItem(item, workDir, worktreeDir, projectRoot, aiTool, mux);
    launched.push(id);
  }

  console.log();
  console.log(
    `${GREEN}Launched ${launched.length} session(s) via ${aiTool}:${RESET}`,
  );
  for (const id of launched) {
    const item = itemMap.get(id)!;
    console.log(`  - ${id}: ${item.title}`);
  }

  if (skipped.length > 0) {
    console.log();
    warn(
      `Session limit reached (${maxInflight}). ${skipped.length} item(s) skipped:`,
    );
    for (const id of skipped) {
      const item = itemMap.get(id)!;
      console.log(`  ${DIM}- ${id}: ${item.title}${RESET}`);
    }
    console.log();
    info(`Use 'nw' to process all items with automatic queue management.`);
  }
}
