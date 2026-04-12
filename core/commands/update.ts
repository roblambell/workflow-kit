// update command: run the resolved install-specific update command for
// ninthwave and stream its output to the terminal. Reuses the shared install
// detection from update-check.ts so both the passive prompt and this manual
// entry point agree on how the current install was managed.

import { die } from "../output.ts";
import {
  resolveCurrentInstall,
  type UpdateInstallMetadata,
  type UpdateInstallSource,
} from "../update-check.ts";

/** Display string for the direct-install fallback (kept in sync with update-check.ts). */
const DIRECT_INSTALL_DISPLAY = "curl -fsSL https://ninthwave.sh/install | bash";

/** Outcome codes returned by runUpdate -- tests assert against these. */
export type UpdateRunOutcome =
  | "updated"
  | "update-failed"
  | "unknown-install"
  | "no-command";

export interface UpdateRunResult {
  installSource: UpdateInstallSource;
  exitCode: number;
  outcome: UpdateRunOutcome;
}

export interface UpdateSpawnResult {
  exitCode: number;
}

export interface RunUpdateDeps {
  /** Resolves the current install metadata. Defaults to production detection. */
  resolveInstall?: () => UpdateInstallMetadata;
  /** Runs the updater command. Defaults to inherited-stdio Bun.spawnSync. */
  spawn?: (executable: string, args: string[]) => UpdateSpawnResult;
  /** Writes a line to stdout. Defaults to console.log. */
  log?: (line: string) => void;
  /** Writes a line to stderr. Defaults to console.error. */
  err?: (line: string) => void;
}

function defaultSpawn(cmd: string, args: string[]): UpdateSpawnResult {
  const result = Bun.spawnSync([cmd, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return { exitCode: result.exitCode ?? 1 };
}

/**
 * Print the manual-update instructions that users should run when ninthwave
 * cannot determine how the current install was managed. Kept deterministic so
 * the CLI test suite can assert against concrete strings.
 */
function printManualGuidance(err: (line: string) => void): void {
  err("Could not detect how this ninthwave install was managed.");
  err("");
  err("Update manually using one of the following:");
  err("  * Homebrew:      brew upgrade ninthwave");
  err(`  * Direct script: ${DIRECT_INSTALL_DISPLAY}`);
  err("  * From source:   git pull && task install   (if installed from a clone)");
  err("");
  err("Restart any running `nw` sessions after updating.");
}

/**
 * Execute the resolved install-specific update command. Returns a structured
 * result -- the CLI wrapper translates this into a process exit code, tests
 * assert against the returned fields directly.
 */
export function runUpdate(deps: RunUpdateDeps = {}): UpdateRunResult {
  const resolveInstall = deps.resolveInstall ?? (() => resolveCurrentInstall());
  const spawnFn = deps.spawn ?? defaultSpawn;
  const log = deps.log ?? ((line: string) => { console.log(line); });
  const err = deps.err ?? ((line: string) => { console.error(line); });

  const install = resolveInstall();

  if (install.source === "unknown" || install.command === null) {
    printManualGuidance(err);
    return {
      installSource: install.source,
      exitCode: 1,
      outcome: install.source === "unknown" ? "unknown-install" : "no-command",
    };
  }

  log(`Updating ninthwave via: ${install.command.display}`);
  log("");

  const { exitCode } = spawnFn(install.command.executable, install.command.args);

  if (exitCode === 0) {
    log("");
    log("Update complete. Restart any running `nw` sessions to use the new version.");
    return {
      installSource: install.source,
      exitCode: 0,
      outcome: "updated",
    };
  }

  err("");
  err(`Update command exited with code ${exitCode}.`);
  err(`Try running it directly: ${install.command.display}`);
  return {
    installSource: install.source,
    exitCode,
    outcome: "update-failed",
  };
}

/**
 * CLI entry point for `nw update`. Performs minimal argument validation, then
 * delegates to runUpdate and propagates its exit code via process.exit when
 * the update fails. Success returns normally so the top-level CLI dispatcher
 * can exit(0) as it does for every other command.
 */
export function cmdUpdate(args: string[], deps: RunUpdateDeps = {}): UpdateRunResult {
  if (args.length > 0) {
    die(`nw update does not accept positional arguments (got: ${args.join(" ")})`);
  }

  const result = runUpdate(deps);

  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }

  return result;
}
