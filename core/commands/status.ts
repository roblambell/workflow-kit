// status and partitions commands: show active worktree status and partition allocation.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import {
  BOLD,
  BLUE,
  GREEN,
  YELLOW,
  CYAN,
  DIM,
  RESET,
} from "../output.ts";
import { run } from "../shell.ts";

export function cmdStatus(worktreeDir: string, projectRoot: string): void {
  console.log(`${BOLD}Active TODO worktrees:${RESET}`);
  console.log();

  if (!existsSync(worktreeDir)) {
    console.log(`  No worktrees found at ${worktreeDir}`);
    return;
  }

  let found = false;

  // Hub-local worktrees
  try {
    const entries = readdirSync(worktreeDir);
    for (const entry of entries) {
      if (!entry.startsWith("todo-")) continue;
      const wtDir = join(worktreeDir, entry);
      if (!existsSync(wtDir)) continue;
      found = true;
      const id = entry.slice(5); // strip "todo-"
      printStatusItem(id, projectRoot, wtDir, "", worktreeDir);
    }
  } catch {
    // worktreeDir might not be readable
  }

  // Cross-repo worktrees
  const crossRepoIndex = join(worktreeDir, ".cross-repo-index");
  if (existsSync(crossRepoIndex)) {
    const content = readFileSync(crossRepoIndex, "utf-8");
    for (const line of content.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("\t");
      const idxId = parts[0];
      const idxRepo = parts[1];
      const idxPath = parts[2];
      if (!idxId || !idxRepo || !idxPath) continue;
      if (!existsSync(idxPath)) continue;
      found = true;
      printStatusItem(idxId, idxRepo, idxPath, basename(idxRepo), worktreeDir);
    }
  }

  if (!found) {
    console.log("  No active worktrees");
  }
}

function printStatusItem(
  id: string,
  repoRoot: string,
  wtDir: string,
  repoLabel: string,
  worktreeDir: string,
): void {
  const branch = `todo/${id}`;

  // Check remote branch
  const hasRemote =
    run("git", ["-C", repoRoot, "rev-parse", "--verify", `origin/${branch}`])
      .exitCode === 0;

  // Commits ahead
  const baseResult = run("git", [
    "-C",
    repoRoot,
    "merge-base",
    "HEAD",
    branch,
  ]);
  let ahead = 0;
  if (baseResult.exitCode === 0 && baseResult.stdout) {
    const aheadResult = run("git", [
      "-C",
      repoRoot,
      "rev-list",
      "--count",
      `${baseResult.stdout}..${branch}`,
    ]);
    ahead =
      aheadResult.exitCode === 0 ? parseInt(aheadResult.stdout, 10) || 0 : 0;
  }

  // PR status via gh
  let prInfo = "(gh not available)";
  let prStateVal = "none";
  const ghCheck = run("which", ["gh"]);
  if (ghCheck.exitCode === 0) {
    const merged = run("gh", [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "merged",
      "--json",
      "number",
      "--jq",
      ".[0].number",
      "--limit",
      "1",
    ], { cwd: repoRoot });
    if (merged.exitCode === 0 && merged.stdout) {
      prInfo = `PR #${merged.stdout} (MERGED)`;
      prStateVal = "merged";
    } else {
      const open = run("gh", [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number",
        "--jq",
        ".[0].number",
        "--limit",
        "1",
      ], { cwd: repoRoot });
      if (open.exitCode === 0 && open.stdout) {
        prInfo = `PR #${open.stdout} (Open)`;
        prStateVal = "open";
      } else {
        const closed = run("gh", [
          "pr",
          "list",
          "--head",
          branch,
          "--state",
          "closed",
          "--json",
          "number",
          "--jq",
          ".[0].number",
          "--limit",
          "1",
        ], { cwd: repoRoot });
        if (closed.exitCode === 0 && closed.stdout) {
          prInfo = `PR #${closed.stdout} (Closed)`;
          prStateVal = "closed";
        } else {
          prInfo = "No PR";
        }
      }
    }
  }

  // Check if branch is merged into main
  let branchMerged = false;
  const aheadCountResult = run("git", [
    "-C",
    repoRoot,
    "rev-list",
    "--count",
    `main..${branch}`,
  ]);
  const aheadCount =
    aheadCountResult.exitCode === 0
      ? parseInt(aheadCountResult.stdout, 10) || 0
      : 0;
  if (aheadCount > 0) {
    const mergedBranches = run("git", [
      "-C",
      repoRoot,
      "branch",
      "--merged",
      "main",
    ]);
    if (
      mergedBranches.exitCode === 0 &&
      mergedBranches.stdout.includes(branch)
    ) {
      branchMerged = true;
    }
  }

  // Determine display status
  let itemStatus: string;
  if (prStateVal === "merged" || branchMerged) {
    itemStatus = `${GREEN}MERGED${RESET}`;
  } else if (prStateVal === "open") {
    itemStatus = `${BLUE}PR Open${RESET}`;
  } else if (prStateVal === "closed") {
    itemStatus = `${YELLOW}PR Closed${RESET}`;
  } else if (hasRemote) {
    itemStatus = `${YELLOW}Pushed, no PR${RESET}`;
  } else {
    itemStatus = `${DIM}In progress${RESET}`;
  }

  // Partition
  const partitionDir = join(worktreeDir, ".partitions");
  let partitionNum = "";
  if (existsSync(partitionDir)) {
    try {
      for (const f of readdirSync(partitionDir)) {
        const content = readFileSync(join(partitionDir, f), "utf-8").trim();
        if (content === id) {
          partitionNum = f;
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  const labelSuffix = repoLabel
    ? `  ${CYAN}[${repoLabel}]${RESET}`
    : "";

  console.log(`  ${BOLD}${id}${RESET}${labelSuffix}  [${itemStatus}]`);
  console.log(`    Branch:    ${branch} (${ahead} commits ahead)`);
  console.log(
    `    Remote:    ${hasRemote ? `${GREEN}pushed${RESET}` : `${DIM}local only${RESET}`}`,
  );
  console.log(`    PR:        ${prInfo}`);
  if (partitionNum) console.log(`    Partition:  ${partitionNum}`);
  console.log(`    Path:      ${wtDir}`);
  console.log();
}

export function cmdPartitions(partitionDir: string): void {
  console.log(`${BOLD}Partition allocation:${RESET}`);
  console.log();

  if (!existsSync(partitionDir)) {
    console.log("  No partitions allocated");
    return;
  }

  try {
    const entries = readdirSync(partitionDir);
    for (const entry of entries) {
      const filePath = join(partitionDir, entry);
      try {
        const todoId = readFileSync(filePath, "utf-8").trim();
        console.log(`  Partition ${entry}: ${todoId}`);
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    console.log("  No partitions allocated");
  }
}
