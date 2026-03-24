// deps command: show dependency chain for a TODO item.

import { parseTodos } from "../parser.ts";
import { die, BOLD, DIM, RESET } from "../output.ts";
import { ID_PATTERN_GLOBAL } from "../types.ts";
import type { TodoItem } from "../types.ts";

export function cmdDeps(
  args: string[],
  todosDir: string,
  worktreeDir: string,
): void {
  const targetId = args[0];
  if (!targetId) die("Usage: ninthwave deps <ID>");

  const items = parseTodos(todosDir, worktreeDir);
  const itemMap = new Map<string, TodoItem>();
  for (const item of items) {
    itemMap.set(item.id, item);
  }

  const target = itemMap.get(targetId);
  if (!target) die(`Item ${targetId} not found`);

  console.log(`${BOLD}Dependency chain for ${targetId}:${RESET} ${target.title}`);
  console.log(`${DIM}Status: ${target.status}${RESET}`);
  console.log();

  // Items this depends on
  console.log(`${BOLD}Must complete before ${targetId}:${RESET}`);
  if (target.dependencies.length === 0) {
    console.log("  (none)");
  } else {
    for (const depId of target.dependencies) {
      const dep = itemMap.get(depId);
      if (dep) {
        const icon = dep.status === "in-progress" ? "[~]" : "[ ]";
        console.log(`  ${icon} ${depId}: ${dep.title} (${dep.status})`);
      } else {
        console.log(`  [x] ${depId}: (completed)`);
      }
    }
  }
  console.log();

  // Items that depend on this
  console.log(`${BOLD}Items that depend on ${targetId}:${RESET}`);
  let foundDependents = false;
  for (const item of items) {
    if (item.dependencies.includes(targetId)) {
      console.log(`  ${item.id}: ${item.title} (${item.status})`);
      foundDependents = true;
    }
  }
  if (!foundDependents) {
    console.log("  (none)");
  }
  console.log();

  // Bundle relationships
  console.log(`${BOLD}Bundle with:${RESET}`);
  if (target.bundleWith.length === 0) {
    // Check if any other item bundles with this one
    let foundBundles = false;
    for (const item of items) {
      if (item.bundleWith.includes(targetId)) {
        console.log(`  ${item.id}: ${item.title}`);
        foundBundles = true;
      }
    }
    if (!foundBundles) {
      console.log("  (none)");
    }
  } else {
    for (const bid of target.bundleWith) {
      const bundleItem = itemMap.get(bid);
      if (bundleItem) {
        console.log(`  ${bid}: ${bundleItem.title}`);
      } else {
        console.log(`  ${bid}: (not found)`);
      }
    }
  }
}
