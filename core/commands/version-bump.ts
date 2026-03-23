// version-bump command: semantic version bump + changelog generation.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { die, info, warn, BOLD, YELLOW, GREEN, RESET } from "../output.ts";
import {
  getCurrentBranch,
  logOneline,
  diffStat,
} from "../git.ts";
import { run } from "../shell.ts";
import { loadConfig } from "../config.ts";

export function cmdVersionBump(projectRoot: string): void {
  const versionFile = join(projectRoot, "VERSION");
  const changelogFile = join(projectRoot, "CHANGELOG.md");

  // Guard: must be on main branch
  let currentBranch = "";
  try {
    currentBranch = getCurrentBranch(projectRoot);
  } catch {
    currentBranch = "";
  }
  if (currentBranch !== "main") {
    die(
      `version-bump must be run on the main branch (currently on: ${currentBranch || "unknown"})`,
    );
  }

  if (!existsSync(versionFile)) die(`VERSION file not found at ${versionFile}`);
  if (!existsSync(changelogFile))
    die(`CHANGELOG.md not found at ${changelogFile}`);

  const currentVersion = readFileSync(versionFile, "utf-8").trim();
  info(`Current version: ${currentVersion}`);

  // Find the last commit that modified VERSION
  const lastVersionResult = run("git", [
    "-C",
    projectRoot,
    "log",
    "-1",
    "--format=%H",
    "--",
    "VERSION",
  ]);
  if (lastVersionResult.exitCode !== 0 || !lastVersionResult.stdout) {
    die("Could not find any commit that modified VERSION");
  }
  const lastVersionCommit = lastVersionResult.stdout.trim();

  // Show last VERSION change
  const lastLogResult = run("git", [
    "-C",
    projectRoot,
    "log",
    "-1",
    "--oneline",
    lastVersionCommit,
  ]);
  info(`Last VERSION change: ${lastLogResult.stdout}`);

  // Get commits since last version change
  const commitRange = `${lastVersionCommit}..HEAD`;
  let commits: string;
  try {
    commits = logOneline(projectRoot, commitRange);
  } catch {
    commits = "";
  }

  if (!commits) {
    console.log("No commits since last version bump.");
    return;
  }

  console.log();
  console.log(`${BOLD}Commits since ${currentVersion}:${RESET}`);
  console.log(commits);
  console.log();

  // Categorize by conventional commit prefix
  let added = "";
  let changed = "";
  let fixed = "";

  for (const line of commits.split("\n")) {
    if (!line) continue;
    const msg = line.slice(line.indexOf(" ") + 1);
    if (msg.startsWith("feat:") || msg.startsWith("feat(")) {
      const content = msg.slice(msg.indexOf(":") + 1).trim();
      added += `\n- ${content}`;
    } else if (msg.startsWith("fix:") || msg.startsWith("fix(")) {
      const content = msg.slice(msg.indexOf(":") + 1).trim();
      fixed += `\n- ${content}`;
    } else if (msg.startsWith("refactor:") || msg.startsWith("refactor(")) {
      const content = msg.slice(msg.indexOf(":") + 1).trim();
      changed += `\n- ${content}`;
    }
  }

  // Calculate net LOC changed
  const config = loadConfig(projectRoot);
  const extensions = config.locExtensions.split(/\s+/).filter(Boolean);
  const { insertions, deletions } = diffStat(
    projectRoot,
    commitRange,
    extensions,
  );
  const totalLoc = insertions + deletions;

  console.log(
    `Net LOC changed: ${BOLD}${totalLoc}${RESET} (+${insertions} -${deletions})`,
  );

  // Parse version parts: MAJOR.MINOR.PATCH.MICRO
  const parts = currentVersion.split(".");
  let vMajor = parseInt(parts[0] ?? "0", 10);
  let vMinor = parseInt(parts[1] ?? "0", 10);
  let vPatch = parseInt(parts[2] ?? "0", 10);
  let vMicro = parseInt(parts[3] ?? "0", 10);

  let newVersion = "";
  if (totalLoc < 50) {
    vMicro++;
    newVersion = `${vMajor}.${vMinor}.${vPatch}.${vMicro}`;
    info(
      `Auto-bumping MICRO (< 50 LOC): ${currentVersion} -> ${newVersion}`,
    );
  } else if (totalLoc <= 200) {
    vPatch++;
    vMicro = 0;
    newVersion = `${vMajor}.${vMinor}.${vPatch}.${vMicro}`;
    info(
      `Auto-bumping PATCH (50-200 LOC): ${currentVersion} -> ${newVersion}`,
    );
  } else {
    console.log();
    console.log(
      `${YELLOW}> 200 LOC changed. Choose bump level:${RESET}`,
    );
    console.log(`  1) MINOR (${vMajor}.${vMinor + 1}.0.0)`);
    console.log(`  2) MAJOR (${vMajor + 1}.0.0.0)`);
    console.log(`  3) PATCH (${vMajor}.${vMinor}.${vPatch + 1}.0)`);

    const choice = prompt("Choice [1/2/3]: ");
    switch (choice) {
      case "1":
        newVersion = `${vMajor}.${vMinor + 1}.0.0`;
        break;
      case "2":
        newVersion = `${vMajor + 1}.0.0.0`;
        break;
      case "3":
        newVersion = `${vMajor}.${vMinor}.${vPatch + 1}.0`;
        break;
      default:
        die("Invalid choice");
    }
    info(`Bumping to: ${newVersion}`);
  }

  // Generate CHANGELOG entry
  const date = new Date().toISOString().slice(0, 10);
  let changelogEntry = `## [${newVersion}] - ${date}`;

  if (added) {
    changelogEntry += `\n\n### Added${added}`;
  }
  if (changed) {
    changelogEntry += `\n\n### Changed${changed}`;
  }
  if (fixed) {
    changelogEntry += `\n\n### Fixed${fixed}`;
  }

  console.log();
  console.log(`${BOLD}Changelog entry:${RESET}`);
  console.log(changelogEntry);
  console.log();

  // Write VERSION
  writeFileSync(versionFile, newVersion + "\n");
  info(`Updated VERSION to ${newVersion}`);

  // Prepend to CHANGELOG.md (after the first # header line)
  const changelogContent = readFileSync(changelogFile, "utf-8");
  const changelogLines = changelogContent.split("\n");
  const outputLines: string[] = [];
  let headerDone = false;

  for (const line of changelogLines) {
    outputLines.push(line);
    if (line.startsWith("# ") && !headerDone) {
      outputLines.push("");
      outputLines.push(changelogEntry);
      headerDone = true;
    }
  }

  writeFileSync(changelogFile, outputLines.join("\n"));
  info("Updated CHANGELOG.md");

  // Commit
  run("git", ["-C", projectRoot, "add", versionFile, changelogFile]);
  run("git", [
    "-C",
    projectRoot,
    "commit",
    "-m",
    `chore: bump version and changelog (v${newVersion})`,
  ]);

  console.log();
  console.log(
    `${GREEN}Version bumped to ${newVersion} and committed.${RESET}`,
  );
}
