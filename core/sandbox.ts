// Sandbox integration: wraps worker AI tool commands with nono for kernel-level sandboxing.
// nono provides Seatbelt (macOS) and Landlock (Linux) sandboxing with zero startup latency.
// The sandbox wraps the AI tool process, not the orchestrator.

import { homedir, platform } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { run as defaultRun } from "./shell.ts";
import type { RunResult } from "./types.ts";

/** Shell runner signature — injectable for testing. */
type ShellRunner = (cmd: string, args: string[]) => RunResult;

/** Sandbox filesystem path policy. */
export interface SandboxPathPolicy {
  /** Directories with read-write access. */
  readWrite: string[];
  /** Directories with read-only access. */
  readOnly: string[];
}

/** Sandbox network policy. */
export interface SandboxNetworkPolicy {
  /** Allowed network hosts/domains. */
  allowHosts: string[];
}

/** Full sandbox configuration. */
export interface SandboxConfig {
  /** Whether sandboxing is enabled (default: true when nono is available). */
  enabled: boolean;
  /** Filesystem path policies. */
  paths: SandboxPathPolicy;
  /** Network policies. */
  network: SandboxNetworkPolicy;
}

/** Default allowed network hosts for worker operations. */
const DEFAULT_ALLOWED_HOSTS = [
  "api.github.com",
  "github.com",
  "registry.npmjs.org",
  "bun.sh",
];

/** Default read-only paths for worker operations. */
function defaultReadOnlyPaths(projectRoot: string): string[] {
  const home = homedir();
  const paths = [
    projectRoot,
    join(home, ".claude"),
    join(home, ".config"),
    join(home, ".bun"),
    join(home, ".npm"),
    join(home, ".node"),
  ];

  // Add platform-specific system paths
  if (platform() === "darwin") {
    paths.push("/usr/lib", "/usr/local", "/opt/homebrew");
  } else {
    paths.push("/usr/lib", "/usr/local/lib", "/usr/share");
  }

  return paths.filter((p) => existsSync(p));
}

/**
 * Check if nono is installed and available.
 * Uses dependency injection for testability.
 */
export function isNonoAvailable(
  runner: ShellRunner = defaultRun,
): boolean {
  try {
    const result = runner("which", ["nono"]);
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Track whether we've already warned about missing nono. */
let _warnedNoSandbox = false;

/**
 * Emit a one-time warning that nono is not installed.
 * Returns true if the warning was emitted (first call), false if already warned.
 */
export function warnOnceNoSandbox(
  warnFn: (msg: string) => void = console.warn,
): boolean {
  if (_warnedNoSandbox) return false;
  _warnedNoSandbox = true;
  warnFn(
    "[ninthwave] nono not found — workers will run without sandbox. Install nono for kernel-level isolation: https://github.com/always-further/nono",
  );
  return true;
}

/** Reset the one-time warning state (for testing). */
export function _resetWarnState(): void {
  _warnedNoSandbox = false;
}

/**
 * Build default sandbox configuration for a worker.
 *
 * @param worktreePath - The worker's isolated worktree (read-write)
 * @param projectRoot - The main project root (read-only)
 */
export function buildDefaultConfig(
  worktreePath: string,
  projectRoot: string,
): SandboxConfig {
  return {
    enabled: true,
    paths: {
      readWrite: [worktreePath],
      readOnly: defaultReadOnlyPaths(projectRoot),
    },
    network: {
      allowHosts: [...DEFAULT_ALLOWED_HOSTS],
    },
  };
}

/**
 * Load sandbox overrides from .ninthwave/config.
 *
 * Recognized keys:
 *   sandbox_extra_rw_paths   — comma-separated additional read-write paths
 *   sandbox_extra_ro_paths   — comma-separated additional read-only paths
 *   sandbox_extra_hosts      — comma-separated additional allowed network hosts
 *
 * @param projectRoot - The project root containing .ninthwave/config
 * @param baseConfig - The default config to augment
 * @returns The augmented config
 */
export function applySandboxOverrides(
  projectRoot: string,
  baseConfig: SandboxConfig,
): SandboxConfig {
  const configPath = join(projectRoot, ".ninthwave", "config");
  if (!existsSync(configPath)) return baseConfig;

  const content = readFileSync(configPath, "utf-8");
  const config = { ...baseConfig };
  config.paths = {
    readWrite: [...baseConfig.paths.readWrite],
    readOnly: [...baseConfig.paths.readOnly],
  };
  config.network = {
    allowHosts: [...baseConfig.network.allowHosts],
  };

  for (const rawLine of content.split("\n")) {
    const eqIdx = rawLine.indexOf("=");
    if (eqIdx === -1) continue;

    const key = rawLine.slice(0, eqIdx).trim();
    if (!key || key.startsWith("#")) continue;

    let value = rawLine.slice(eqIdx + 1).trim();
    value = value.replace(/^["']/, "").replace(/["']$/, "");

    switch (key) {
      case "sandbox_extra_rw_paths":
        config.paths.readWrite.push(
          ...value.split(",").map((p) => p.trim()).filter(Boolean),
        );
        break;
      case "sandbox_extra_ro_paths":
        config.paths.readOnly.push(
          ...value.split(",").map((p) => p.trim()).filter(Boolean),
        );
        break;
      case "sandbox_extra_hosts":
        config.network.allowHosts.push(
          ...value.split(",").map((h) => h.trim()).filter(Boolean),
        );
        break;
    }
  }

  return config;
}

/**
 * Build the nono command prefix for sandboxing a worker command.
 *
 * Produces a command string like:
 *   nono run --allow /path/to/worktree --read /path/to/project --allow-domain api.github.com -- <original-command>
 *
 * @param config - The sandbox configuration
 * @param command - The original command to wrap
 * @returns The sandboxed command string
 */
export function buildSandboxCommand(
  config: SandboxConfig,
  command: string,
): string {
  const parts: string[] = ["nono", "run"];

  for (const rw of config.paths.readWrite) {
    parts.push("--allow", rw);
  }
  for (const ro of config.paths.readOnly) {
    parts.push("--read", ro);
  }
  for (const host of config.network.allowHosts) {
    parts.push("--allow-domain", host);
  }

  parts.push("--", command);

  return parts.join(" ");
}

/**
 * Wrap a worker command with nono sandboxing if available and enabled.
 *
 * This is the main entry point for sandbox integration. It:
 * 1. Checks if sandboxing is disabled (--no-sandbox)
 * 2. Checks if nono is installed
 * 3. Builds the sandbox config with defaults + overrides
 * 4. Wraps the command
 *
 * @param command - The original worker command
 * @param worktreePath - The worker's isolated worktree
 * @param projectRoot - The main project root
 * @param options - Options controlling sandbox behavior
 * @returns The (possibly sandboxed) command string
 */
export function wrapWithSandbox(
  command: string,
  worktreePath: string,
  projectRoot: string,
  options: {
    disabled?: boolean;
    runner?: ShellRunner;
    warnFn?: (msg: string) => void;
  } = {},
): string {
  const { disabled = false, runner, warnFn } = options;

  // 1. Opt-out: --no-sandbox
  if (disabled) return command;

  // 2. Check nono availability
  if (!isNonoAvailable(runner)) {
    warnOnceNoSandbox(warnFn);
    return command;
  }

  // 3. Build config
  const config = buildDefaultConfig(worktreePath, projectRoot);
  const finalConfig = applySandboxOverrides(projectRoot, config);

  // 4. Wrap
  return buildSandboxCommand(finalConfig, command);
}

/** Sandbox config keys for use in config.ts KNOWN_CONFIG_KEYS. */
export const SANDBOX_CONFIG_KEYS = [
  "sandbox_extra_rw_paths",
  "sandbox_extra_ro_paths",
  "sandbox_extra_hosts",
];
