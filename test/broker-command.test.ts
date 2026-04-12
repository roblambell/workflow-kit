// Tests for core/commands/broker.ts -- flag parsing, URL formatting,
// command registration, help output, startup delegation, printed connection
// info, and --save-crew-url config writes.

import { describe, it, expect } from "vitest";
import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import {
  parseBrokerFlags,
  formatBrokerUrls,
  cmdBroker,
  type BrokerDeps,
} from "../core/commands/broker.ts";
import { COMMAND_REGISTRY, lookupCommand } from "../core/help.ts";
import { loadConfig, saveConfig } from "../core/config.ts";
import { setupTempRepo, cleanupTempRepos } from "./helpers.ts";
import { afterEach } from "vitest";

afterEach(() => {
  cleanupTempRepos();
});

// ── Helpers ────────────────────────────────────────────────────────

async function captureLog(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return lines;
}

function mockServer(overrides?: { hostname?: string; port?: number }) {
  const hostname = overrides?.hostname ?? "0.0.0.0";
  const port = overrides?.port ?? 4444;
  return {
    start: () => port,
    hostname,
    port,
  };
}

function mockDeps(overrides?: {
  hostname?: string;
  port?: number;
  saveConfig?: BrokerDeps["saveConfig"];
}): BrokerDeps & { resolvedSignal: () => void } {
  let resolveSignal: () => void = () => {};
  return {
    createServer: (opts) => {
      const port = opts.port || overrides?.port || 4444;
      return mockServer({ hostname: opts.hostname, port });
    },
    saveConfig: overrides?.saveConfig ?? (() => {}),
    resolvedSignal: () => resolveSignal(),
  };
}

// ── Command registration ───────────────────────────────────────────

describe("broker command registration", () => {
  it("is registered in COMMAND_REGISTRY", () => {
    const entry = lookupCommand("broker");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("broker");
  });

  it("is in the workflow group", () => {
    const entry = lookupCommand("broker")!;
    expect(entry.group).toBe("workflow");
  });

  it("needs project root but not work dir", () => {
    const entry = lookupCommand("broker")!;
    expect(entry.needsRoot).toBe(true);
    expect(entry.needsWork).toBe(false);
  });

  it("has documented flags", () => {
    const entry = lookupCommand("broker")!;
    expect(entry.flags["--host"]).toBeDefined();
    expect(entry.flags["--port"]).toBeDefined();
    expect(entry.flags["--data-dir"]).toBeDefined();
    expect(entry.flags["--event-log"]).toBeDefined();
    expect(entry.flags["--save-crew-url"]).toBeDefined();
  });

  it("has examples", () => {
    const entry = lookupCommand("broker")!;
    expect(entry.examples.length).toBeGreaterThanOrEqual(1);
    expect(entry.examples.some((e) => e.includes("nw broker"))).toBe(true);
  });

  it("usage starts with command name", () => {
    const entry = lookupCommand("broker")!;
    expect(entry.usage.startsWith("broker")).toBe(true);
  });
});

// ── Flag parsing ───────────────────────────────────────────────────

describe("parseBrokerFlags", () => {
  const projectRoot = "/tmp/test-project";

  it("returns defaults when no flags provided", () => {
    const flags = parseBrokerFlags([], projectRoot);
    expect(flags.host).toBe("0.0.0.0");
    expect(flags.port).toBe(4444);
    expect(flags.dataDir).toBe(join(projectRoot, ".ninthwave", "broker", "crews"));
    expect(flags.eventLog).toBe(join(projectRoot, ".ninthwave", "broker", "crew-events.jsonl"));
    expect(flags.saveCrewUrl).toBe(false);
  });

  it("parses --host flag", () => {
    const flags = parseBrokerFlags(["--host", "127.0.0.1"], projectRoot);
    expect(flags.host).toBe("127.0.0.1");
  });

  it("parses --port flag", () => {
    const flags = parseBrokerFlags(["--port", "8080"], projectRoot);
    expect(flags.port).toBe(8080);
  });

  it("parses --port 0 for random port", () => {
    const flags = parseBrokerFlags(["--port", "0"], projectRoot);
    expect(flags.port).toBe(0);
  });

  it("throws on invalid port", () => {
    expect(() => parseBrokerFlags(["--port", "abc"], projectRoot)).toThrow("Invalid port");
    expect(() => parseBrokerFlags(["--port", "-1"], projectRoot)).toThrow("Invalid port");
    expect(() => parseBrokerFlags(["--port", "99999"], projectRoot)).toThrow("Invalid port");
  });

  it("parses --data-dir flag", () => {
    const flags = parseBrokerFlags(["--data-dir", "/custom/data"], projectRoot);
    expect(flags.dataDir).toBe("/custom/data");
  });

  it("parses --event-log flag", () => {
    const flags = parseBrokerFlags(["--event-log", "/custom/events.jsonl"], projectRoot);
    expect(flags.eventLog).toBe("/custom/events.jsonl");
  });

  it("parses --save-crew-url flag", () => {
    const flags = parseBrokerFlags(["--save-crew-url"], projectRoot);
    expect(flags.saveCrewUrl).toBe(true);
  });

  it("parses multiple flags together", () => {
    const flags = parseBrokerFlags([
      "--host", "192.168.1.1",
      "--port", "9000",
      "--data-dir", "/data",
      "--event-log", "/log.jsonl",
      "--save-crew-url",
    ], projectRoot);

    expect(flags.host).toBe("192.168.1.1");
    expect(flags.port).toBe(9000);
    expect(flags.dataDir).toBe("/data");
    expect(flags.eventLog).toBe("/log.jsonl");
    expect(flags.saveCrewUrl).toBe(true);
  });
});

// ── URL formatting ─────────────────────────────────────────────────

describe("formatBrokerUrls", () => {
  it("replaces 0.0.0.0 with localhost for display", () => {
    const { httpUrl, wsUrl } = formatBrokerUrls("0.0.0.0", 4444);
    expect(httpUrl).toBe("http://localhost:4444");
    expect(wsUrl).toBe("ws://localhost:4444");
  });

  it("uses the provided hostname when not 0.0.0.0", () => {
    const { httpUrl, wsUrl } = formatBrokerUrls("192.168.1.1", 9000);
    expect(httpUrl).toBe("http://192.168.1.1:9000");
    expect(wsUrl).toBe("ws://192.168.1.1:9000");
  });

  it("handles 127.0.0.1", () => {
    const { httpUrl, wsUrl } = formatBrokerUrls("127.0.0.1", 8080);
    expect(httpUrl).toBe("http://127.0.0.1:8080");
    expect(wsUrl).toBe("ws://127.0.0.1:8080");
  });
});

// ── Startup delegation & printed output ────────────────────────────

describe("cmdBroker", () => {
  it("creates server with parsed flags", async () => {
    const capturedOpts: Record<string, unknown>[] = [];
    const deps: BrokerDeps = {
      createServer: (opts) => {
        capturedOpts.push(opts);
        return mockServer();
      },
      log: () => {},
    };

    const brokerPromise = cmdBroker(["--host", "127.0.0.1", "--port", "9000"], "/tmp/test", deps);
    // Let it run briefly then send SIGINT
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT", "SIGINT");
    await brokerPromise;

    expect(capturedOpts.length).toBe(1);
    expect(capturedOpts[0]!.hostname).toBe("127.0.0.1");
    expect(capturedOpts[0]!.port).toBe(9000);
  });

  it("prints HTTP and WS URLs", async () => {
    const lines: string[] = [];
    const deps: BrokerDeps = {
      createServer: () => mockServer({ port: 4444 }),
      log: (...args: unknown[]) => { lines.push(args.map(String).join(" ")); },
    };

    const brokerPromise = cmdBroker([], "/tmp/test", deps);
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT", "SIGINT");
    await brokerPromise;

    const text = lines.join("\n");
    expect(text).toContain("http://localhost:4444");
    expect(text).toContain("ws://localhost:4444");
    expect(text).toContain("Ninthwave Broker");
  });

  it("prints custom host in URLs", async () => {
    const lines: string[] = [];
    const deps: BrokerDeps = {
      createServer: (opts) => mockServer({ hostname: opts.hostname, port: opts.port }),
      log: (...args: unknown[]) => { lines.push(args.map(String).join(" ")); },
    };

    const brokerPromise = cmdBroker(["--host", "192.168.1.50", "--port", "8080"], "/tmp/test", deps);
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT", "SIGINT");
    await brokerPromise;

    const text = lines.join("\n");
    expect(text).toContain("http://192.168.1.50:8080");
    expect(text).toContain("ws://192.168.1.50:8080");
  });

  it("prints data dir and event log paths", async () => {
    const lines: string[] = [];
    const deps: BrokerDeps = {
      createServer: () => mockServer(),
      log: (...args: unknown[]) => { lines.push(args.map(String).join(" ")); },
    };

    const brokerPromise = cmdBroker(
      ["--data-dir", "/custom/data", "--event-log", "/custom/log.jsonl"],
      "/tmp/test",
      deps,
    );
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT", "SIGINT");
    await brokerPromise;

    const text = lines.join("\n");
    expect(text).toContain("/custom/data");
    expect(text).toContain("/custom/log.jsonl");
  });

  it("prints Ctrl+C hint", async () => {
    const lines: string[] = [];
    const deps: BrokerDeps = {
      createServer: () => mockServer(),
      log: (...args: unknown[]) => { lines.push(args.map(String).join(" ")); },
    };

    const brokerPromise = cmdBroker([], "/tmp/test", deps);
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT", "SIGINT");
    await brokerPromise;

    const text = lines.join("\n");
    expect(text).toContain("Ctrl+C");
  });
});

// ── --save-crew-url config writes ──────────────────────────────────

describe("cmdBroker --save-crew-url", () => {
  it("saves crew_url to config when flag is set", async () => {
    const savedConfigs: Array<{ projectRoot: string; updates: { crew_url?: string } }> = [];
    const deps: BrokerDeps = {
      createServer: () => mockServer({ port: 4444 }),
      saveConfig: (projectRoot, updates) => { savedConfigs.push({ projectRoot, updates }); },
      log: () => {},
    };

    const brokerPromise = cmdBroker(["--save-crew-url"], "/tmp/test", deps);
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT", "SIGINT");
    await brokerPromise;

    expect(savedConfigs.length).toBe(1);
    expect(savedConfigs[0]!.projectRoot).toBe("/tmp/test");
    expect(savedConfigs[0]!.updates.crew_url).toBe("ws://localhost:4444");
  });

  it("does not save crew_url without the flag", async () => {
    const savedConfigs: Array<{ projectRoot: string; updates: { crew_url?: string } }> = [];
    const deps: BrokerDeps = {
      createServer: () => mockServer({ port: 4444 }),
      saveConfig: (projectRoot, updates) => { savedConfigs.push({ projectRoot, updates }); },
      log: () => {},
    };

    const brokerPromise = cmdBroker([], "/tmp/test", deps);
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT", "SIGINT");
    await brokerPromise;

    expect(savedConfigs.length).toBe(0);
  });

  it("saves correct URL with custom host and port", async () => {
    const savedConfigs: Array<{ projectRoot: string; updates: { crew_url?: string } }> = [];
    const deps: BrokerDeps = {
      createServer: (opts) => mockServer({ hostname: opts.hostname, port: opts.port }),
      saveConfig: (projectRoot, updates) => { savedConfigs.push({ projectRoot, updates }); },
      log: () => {},
    };

    const brokerPromise = cmdBroker(
      ["--host", "192.168.1.50", "--port", "9000", "--save-crew-url"],
      "/tmp/test",
      deps,
    );
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT", "SIGINT");
    await brokerPromise;

    expect(savedConfigs[0]!.updates.crew_url).toBe("ws://192.168.1.50:9000");
  });

  it("writes crew_url to real config file on disk", async () => {
    const repo = setupTempRepo();
    mkdirSync(join(repo, ".ninthwave"), { recursive: true });

    const deps: BrokerDeps = {
      createServer: () => mockServer({ port: 5555 }),
      log: () => {},
    };

    const brokerPromise = cmdBroker(["--save-crew-url"], repo, deps);
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT", "SIGINT");
    await brokerPromise;

    const config = loadConfig(repo);
    expect(config.crew_url).toBe("ws://localhost:5555");
  });

  it("crew_url is the only project config setting touched", async () => {
    const repo = setupTempRepo();
    const configDir = join(repo, ".ninthwave");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        review_external: true,
        custom_key: "preserved",
      }),
    );

    const deps: BrokerDeps = {
      createServer: () => mockServer({ port: 5555 }),
      log: () => {},
    };

    const brokerPromise = cmdBroker(["--save-crew-url"], repo, deps);
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT", "SIGINT");
    await brokerPromise;

    const raw = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(raw.review_external).toBe(true);
    expect(raw.custom_key).toBe("preserved");
    expect(raw.crew_url).toBe("ws://localhost:5555");
  });
});
