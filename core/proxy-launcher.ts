// Proxy launcher: detects, spawns, health-checks, and stops the policy proxy binary.
// Follows the sandbox.ts binary-detection pattern with full dependency injection.
//
// The proxy runs as a subprocess managed by this module. It:
// 1. Detects the ninthwave-proxy binary via `which` (same as nono detection)
// 2. Validates config (policy file, credentials) before spawning
// 3. Spawns on an ephemeral port and verifies startup via TCP
// 4. Health-checks every 30s and auto-restarts on failure
// 5. Shuts down cleanly via stop()
//
// Graceful degradation: if the proxy binary is not installed, a one-time warning
// is logged and workers continue without proxy (same pattern as nono).

import { existsSync } from "fs";
import { createConnection, createServer } from "net";
import { run as defaultRun } from "./shell.ts";
import type { RunResult } from "./types.ts";

/** Shell runner signature — injectable for testing (same as sandbox.ts). */
type ShellRunner = (cmd: string, args: string[]) => RunResult;

/** A running subprocess handle — injectable for testing. */
export interface SubprocessHandle {
  /** Process ID. */
  readonly pid: number;
  /** Send a signal to the process (default: SIGTERM). */
  kill(signal?: number): void;
  /** Exit code, or null if the process is still running. */
  readonly exitCode: number | null;
}

/** Factory for spawning a long-running subprocess — injectable for testing. */
export type SubprocessSpawner = (cmd: string, args: string[]) => SubprocessHandle;

/** TCP connectivity checker — injectable for testing. */
export type TcpChecker = (port: number) => Promise<boolean>;

/** Configuration for starting the proxy. */
export interface ProxyConfig {
  /** Path to the Cedar policy file. */
  policyFile: string;
  /** Path to the credentials config file. */
  credentialsConfig: string;
  /** Port to listen on. 0 or omitted = ephemeral (auto-selected). */
  port?: number;
}

/** Handle for a running proxy instance. */
export interface ProxyHandle {
  /** Port the proxy is listening on. */
  port: number;
  /** Stop the proxy and clean up all resources. Idempotent. */
  stop(): void;
  /** Run a single health check cycle (exposed for testing). Returns true if healthy. */
  runHealthCheck(): Promise<boolean>;
}

/** Injectable dependencies for all proxy operations. */
export interface ProxyDeps {
  runner?: ShellRunner;
  spawner?: SubprocessSpawner;
  tcpCheck?: TcpChecker;
  warnFn?: (msg: string) => void;
  logFn?: (msg: string) => void;
  existsFn?: (path: string) => boolean;
  findPort?: () => Promise<number>;
}

/** The proxy binary name. */
const PROXY_BINARY = "ninthwave-proxy";

/** Health check interval (30 seconds). */
const HEALTH_CHECK_INTERVAL_MS = 30_000;

/** Brief wait after spawning for process to initialize. */
const STARTUP_WAIT_MS = 100;

// ── Default implementations (production) ────────────────────────────

/** Check TCP connectivity to a port (2s timeout). */
async function defaultTcpCheck(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Spawn a subprocess using Bun.spawn (production default). */
function defaultSpawner(cmd: string, args: string[]): SubprocessHandle {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    get pid() {
      return proc.pid;
    },
    kill(signal?: number) {
      proc.kill(signal);
    },
    get exitCode() {
      return proc.exitCode;
    },
  };
}

/** Find an available ephemeral port by binding to port 0. */
async function defaultFindPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// ── Binary detection ────────────────────────────────────────────────

/** Track whether we've already warned about missing proxy binary. */
let _warnedNoProxy = false;

/**
 * Check if the proxy binary is installed and available.
 * Uses dependency injection for testability (same pattern as isNonoAvailable).
 */
export function isProxyAvailable(
  runner: ShellRunner = defaultRun,
): boolean {
  try {
    const result = runner("which", [PROXY_BINARY]);
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Emit a one-time warning that the proxy binary is not installed.
 * Returns true if the warning was emitted (first call), false if already warned.
 */
export function warnOnceNoProxy(
  warnFn: (msg: string) => void = console.warn,
): boolean {
  if (_warnedNoProxy) return false;
  _warnedNoProxy = true;
  warnFn(
    `[ninthwave] ${PROXY_BINARY} not found — workers will run without policy proxy. Install for MITM policy enforcement.`,
  );
  return true;
}

/** Reset the one-time warning state (for testing). */
export function _resetProxyWarnState(): void {
  _warnedNoProxy = false;
}

// ── Proxy lifecycle ─────────────────────────────────────────────────

/**
 * Start the proxy binary as a managed subprocess.
 *
 * 1. Validates config (policy file + credentials must exist)
 * 2. Picks an ephemeral port if none specified
 * 3. Spawns the proxy binary
 * 4. Verifies it came up via TCP check
 * 5. Starts a 30s health check interval with auto-restart
 *
 * @throws if config files are missing, binary crashes on startup, or fails to respond
 */
export async function startProxy(
  config: ProxyConfig,
  deps: ProxyDeps = {},
): Promise<ProxyHandle> {
  const {
    runner = defaultRun,
    spawner = defaultSpawner,
    tcpCheck = defaultTcpCheck,
    logFn = console.log,
    existsFn = existsSync,
    findPort = defaultFindPort,
  } = deps;

  // Validate config
  if (!existsFn(config.policyFile)) {
    throw new Error(`Proxy policy file not found: ${config.policyFile}`);
  }
  if (!existsFn(config.credentialsConfig)) {
    throw new Error(`Proxy credentials config not found: ${config.credentialsConfig}`);
  }

  // Pick ephemeral port if not specified
  const port = config.port || (await findPort());

  const spawnArgs = [
    "--policy",
    config.policyFile,
    "--credentials",
    config.credentialsConfig,
    "--port",
    String(port),
  ];

  // Spawn the proxy binary
  let subprocess = spawner(PROXY_BINARY, spawnArgs);

  // Brief wait for process to initialize
  await new Promise((resolve) => setTimeout(resolve, STARTUP_WAIT_MS));

  // Check if process crashed on startup
  if (subprocess.exitCode !== null) {
    throw new Error(
      `Proxy binary crashed on startup (exit code ${subprocess.exitCode})`,
    );
  }

  // Verify TCP connectivity
  const ok = await tcpCheck(port);
  if (!ok) {
    subprocess.kill();
    throw new Error(`Proxy failed to start — not responding on port ${port}`);
  }

  logFn(`[ninthwave] proxy started on port ${port} (pid ${subprocess.pid})`);

  // ── State ──
  let stopped = false;
  let healthCheckRunning = false;

  // ── Health check with auto-restart ──
  const doHealthCheck = async (): Promise<boolean> => {
    if (stopped || healthCheckRunning) return true;
    healthCheckRunning = true;
    try {
      const healthy = await tcpCheck(port);
      if (healthy || stopped) return healthy;

      logFn(`[ninthwave] proxy unresponsive on port ${port}, restarting...`);

      // Kill old process if still alive
      if (subprocess.exitCode === null) {
        subprocess.kill();
      }

      // Respawn on the same port
      subprocess = spawner(PROXY_BINARY, spawnArgs);
      await new Promise((resolve) => setTimeout(resolve, STARTUP_WAIT_MS));

      const restarted = await tcpCheck(port);
      if (restarted) {
        logFn(
          `[ninthwave] proxy restarted on port ${port} (pid ${subprocess.pid})`,
        );
      }
      return restarted;
    } finally {
      healthCheckRunning = false;
    }
  };

  const healthInterval = setInterval(doHealthCheck, HEALTH_CHECK_INTERVAL_MS);
  healthInterval.unref(); // Don't keep the process alive for health checks

  return {
    port,
    stop() {
      if (stopped) return; // Idempotent — already stopped is a no-op
      stopped = true;
      clearInterval(healthInterval);
      if (subprocess.exitCode === null) {
        subprocess.kill();
      }
    },
    runHealthCheck: doHealthCheck,
  };
}
