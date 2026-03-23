// repos command: list discovered repos (repos.conf + sibling directories).

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, dirname, basename, resolve } from "path";
import { BOLD, CYAN, GREEN, RED, RESET } from "../output.ts";
import { run } from "../shell.ts";

export function cmdRepos(projectRoot: string): void {
  console.log(`${BOLD}Discovered repos:${RESET}`);
  console.log();

  const parentDir = dirname(projectRoot);
  let found = 0;

  // repos.conf overrides
  const reposConf = join(projectRoot, ".ninthwave", "repos.conf");
  if (existsSync(reposConf)) {
    console.log(`${CYAN}From repos.conf:${RESET}`);
    const content = readFileSync(reposConf, "utf-8");
    for (const rawLine of content.split("\n")) {
      const eqIdx = rawLine.indexOf("=");
      if (eqIdx === -1) continue;
      const key = rawLine.slice(0, eqIdx).trim();
      if (!key || key.startsWith("#")) continue;
      const value = rawLine.slice(eqIdx + 1).trim();

      let status = `${GREEN}OK${RESET}`;
      if (
        !existsSync(join(value, ".git"))
      ) {
        status = `${RED}NOT FOUND${RESET}`;
      }

      console.log(`  ${pad(key, 20)} ${value}  [${status}]`);
      found++;
    }
    console.log();
  }

  // Sibling directories
  console.log(
    `${CYAN}Sibling directories (${basename(parentDir)}/):${RESET}`,
  );

  try {
    const entries = readdirSync(parentDir);
    for (const entry of entries) {
      const dirPath = join(parentDir, entry);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }

      // Skip self
      const resolvedDir = resolve(dirPath);
      if (resolvedDir === resolve(projectRoot)) continue;

      // Check if it's a git repo
      if (existsSync(join(dirPath, ".git"))) {
        const repoName = basename(dirPath);
        const result = run("git", ["-C", dirPath, "remote", "get-url", "origin"]);
        const remoteUrl =
          result.exitCode === 0 ? result.stdout : "no remote";
        console.log(`  ${pad(repoName, 20)} ${remoteUrl}`);
        found++;
      }
    }
  } catch {
    // parentDir might not be readable
  }

  if (found === 0) {
    console.log("  No repos found");
  }
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}
