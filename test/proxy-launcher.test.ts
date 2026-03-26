// Tests for core/proxy-launcher.ts — proxy binary detection, spawn, health check, shutdown.
// All tests use dependency-injected mocks (no real binary needed).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { RunResult } from "../core/types.ts";
import {
  isProxyAvailable,
  warnOnceNoProxy,
  _resetProxyWarnState,
  startProxy,
  type SubprocessHandle,
  type SubprocessSpawner,
  type TcpChecker,
  type ProxyConfig,
  type ProxyDeps,
  type ProxyHandle,
} from "../core/proxy-launcher.ts";

// ── Mock helpers ────────────────────────────────────────────────────

/** ShellRunner where ninthwave-proxy is installed. */
function proxyInstalled() {
  return (cmd: string, args: string[]): RunResult => {
    if (cmd === "which" && args[0] === "ninthwave-proxy") {
      return {
        stdout: "/usr/local/bin/ninthwave-proxy",
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "not found", exitCode: 1 };
  };
}

/** ShellRunner where ninthwave-proxy is NOT installed. */
function proxyMissing() {
  return (_cmd: string, _args: string[]): RunResult => {
    return { stdout: "", stderr: "not found", exitCode: 1 };
  };
}

/** Create a mock subprocess handle. */
function createMockHandle(opts?: { crashed?: boolean }): SubprocessHandle {
  let killed = false;
  const crashed = opts?.crashed ?? false;
  return {
    pid: 12345,
    kill() {
      killed = true;
    },
    get exitCode() {
      if (crashed) return 1;
      return killed ? 0 : null;
    },
  };
}

/** Standard proxy config for tests. */
const testConfig: ProxyConfig = {
  policyFile: "/tmp/policy.cedar",
  credentialsConfig: "/tmp/credentials.json",
  port: 8080,
};

/** Standard deps that make startProxy succeed. */
function happyDeps(overrides: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    runner: proxyInstalled(),
    spawner: () => createMockHandle(),
    tcpCheck: async () => true,
    existsFn: () => true,
    findPort: async () => 8080,
    logFn: () => {},
    ...overrides,
  };
}

// Track proxy handles for cleanup
const activeHandles: ProxyHandle[] = [];

// ── Tests ───────────────────────────────────────────────────────────

describe("isProxyAvailable", () => {
  it("returns true when binary found", () => {
    expect(isProxyAvailable(proxyInstalled())).toBe(true);
  });

  it("returns false when binary missing", () => {
    expect(isProxyAvailable(proxyMissing())).toBe(false);
  });

  it("returns false when runner throws", () => {
    const throwing = () => {
      throw new Error("spawn error");
    };
    expect(isProxyAvailable(throwing as any)).toBe(false);
  });
});

describe("warnOnceNoProxy", () => {
  beforeEach(() => _resetProxyWarnState());

  it("emits warning on first call", () => {
    const warnings: string[] = [];
    const result = warnOnceNoProxy((msg) => warnings.push(msg));
    expect(result).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ninthwave-proxy not found");
  });

  it("does not emit warning on second call", () => {
    const warnings: string[] = [];
    warnOnceNoProxy((msg) => warnings.push(msg));
    const result = warnOnceNoProxy((msg) => warnings.push(msg));
    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});

describe("startProxy", () => {
  afterEach(() => {
    for (const h of activeHandles) h.stop();
    activeHandles.length = 0;
  });

  it("happy path: spawns subprocess, returns port and stop function", async () => {
    const spawnCalls: string[][] = [];
    const spawner: SubprocessSpawner = (cmd, args) => {
      spawnCalls.push([cmd, ...args]);
      return createMockHandle();
    };

    const handle = await startProxy(testConfig, happyDeps({ spawner }));
    activeHandles.push(handle);

    expect(handle.port).toBe(8080);
    expect(typeof handle.stop).toBe("function");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toContain("ninthwave-proxy");
    expect(spawnCalls[0]).toContain("--policy");
    expect(spawnCalls[0]).toContain("/tmp/policy.cedar");
    expect(spawnCalls[0]).toContain("--credentials");
    expect(spawnCalls[0]).toContain("/tmp/credentials.json");
    expect(spawnCalls[0]).toContain("--port");
    expect(spawnCalls[0]).toContain("8080");
  });

  it("uses ephemeral port when port is 0", async () => {
    const handle = await startProxy(
      { ...testConfig, port: 0 },
      happyDeps({ findPort: async () => 9999 }),
    );
    activeHandles.push(handle);
    expect(handle.port).toBe(9999);
  });

  it("throws when policy file is missing", async () => {
    const existsFn = (path: string) => path !== "/tmp/policy.cedar";
    await expect(
      startProxy(testConfig, happyDeps({ existsFn })),
    ).rejects.toThrow("Proxy policy file not found");
  });

  it("throws when credentials config is missing", async () => {
    const existsFn = (path: string) => path !== "/tmp/credentials.json";
    await expect(
      startProxy(testConfig, happyDeps({ existsFn })),
    ).rejects.toThrow("Proxy credentials config not found");
  });

  it("throws when binary crashes on startup", async () => {
    const spawner: SubprocessSpawner = () =>
      createMockHandle({ crashed: true });
    await expect(
      startProxy(testConfig, happyDeps({ spawner })),
    ).rejects.toThrow("crashed on startup");
  });
});

describe("healthCheck", () => {
  afterEach(() => {
    for (const h of activeHandles) h.stop();
    activeHandles.length = 0;
  });

  it("proxy responsive: no restart", async () => {
    let spawnCount = 0;
    const spawner: SubprocessSpawner = () => {
      spawnCount++;
      return createMockHandle();
    };

    const handle = await startProxy(testConfig, happyDeps({ spawner }));
    activeHandles.push(handle);

    // Health check with proxy still responsive — should not restart
    const healthy = await handle.runHealthCheck();
    expect(healthy).toBe(true);
    expect(spawnCount).toBe(1); // Only the initial spawn, no restart
  });

  it("proxy unresponsive: triggers restart", async () => {
    let spawnCount = 0;
    const spawner: SubprocessSpawner = () => {
      spawnCount++;
      return createMockHandle();
    };

    let tcpCallCount = 0;
    const tcpCheck: TcpChecker = async () => {
      tcpCallCount++;
      // Call 1: startup verification (true)
      // Call 2: health check detects failure (false)
      // Call 3: restart verification (true)
      return tcpCallCount !== 2;
    };

    const handle = await startProxy(
      testConfig,
      happyDeps({ spawner, tcpCheck }),
    );
    activeHandles.push(handle);
    expect(spawnCount).toBe(1);

    // Run health check — should detect failure and restart
    const result = await handle.runHealthCheck();
    expect(result).toBe(true); // Restart succeeded
    expect(spawnCount).toBe(2); // Original + restart
  });
});

describe("stopProxy", () => {
  afterEach(() => {
    for (const h of activeHandles) h.stop();
    activeHandles.length = 0;
  });

  it("clean shutdown: kills process", async () => {
    let killCalled = false;
    const mockHandle: SubprocessHandle = {
      pid: 12345,
      kill() {
        killCalled = true;
      },
      get exitCode() {
        return killCalled ? 0 : null;
      },
    };

    const handle = await startProxy(
      testConfig,
      happyDeps({ spawner: () => mockHandle }),
    );

    handle.stop();
    expect(killCalled).toBe(true);
  });

  it("process already exited: no-op, no throw", async () => {
    let exited = false;
    let killCallCount = 0;
    const mockHandle: SubprocessHandle = {
      pid: 12345,
      kill() {
        killCallCount++;
      },
      get exitCode() {
        return exited ? 1 : null;
      },
    };

    const handle = await startProxy(
      testConfig,
      happyDeps({ spawner: () => mockHandle }),
    );

    // Simulate process exiting on its own
    exited = true;
    killCallCount = 0; // Reset counter

    // stop() should not throw and should not call kill()
    expect(() => handle.stop()).not.toThrow();
    expect(killCallCount).toBe(0);
  });

  it("calling stop() twice is a no-op", async () => {
    let killCount = 0;
    const mockHandle: SubprocessHandle = {
      pid: 12345,
      kill() {
        killCount++;
      },
      get exitCode() {
        return killCount > 0 ? 0 : null;
      },
    };

    const handle = await startProxy(
      testConfig,
      happyDeps({ spawner: () => mockHandle }),
    );

    handle.stop();
    handle.stop(); // Second call should be no-op
    expect(killCount).toBe(1); // kill() called only once
  });
});
