// `nw broker` -- start the self-hosted broker runtime in the foreground.
//
// Parses --host, --port, --data-dir, --event-log, and --save-crew-url flags,
// starts the BrokerServer, prints connection URLs, and optionally persists the
// broker WebSocket URL into project config via the crew_url setting.

import { join } from "path";
import { BOLD, CYAN, DIM, GREEN, RESET } from "../output.ts";
import { BrokerServer } from "../broker-server.ts";
import { saveConfig } from "../config.ts";

// ── Types ──────────────────────────────────────────────────────────

export interface BrokerFlags {
  host: string;
  port: number;
  dataDir: string;
  eventLog: string;
  saveCrewUrl: boolean;
}

export interface BrokerDeps {
  createServer?: (opts: { hostname: string; port: number; dataDir: string; eventLogPath: string }) => { start: () => number; hostname: string; port: number };
  saveConfig?: (projectRoot: string, updates: { crew_url?: string }) => void;
  log?: (...args: unknown[]) => void;
}

// ── Flag parsing ───────────────────────────────────────────────────

export function parseBrokerFlags(args: string[], projectRoot: string): BrokerFlags {
  let host = "0.0.0.0";
  let port = 4444;
  let dataDir = join(projectRoot, ".ninthwave", "broker", "crews");
  let eventLog = join(projectRoot, ".ninthwave", "broker", "crew-events.jsonl");
  let saveCrewUrl = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];

    if (arg === "--host" && next !== undefined) {
      host = next;
      i++;
    } else if (arg === "--port" && next !== undefined) {
      const parsed = parseInt(next, 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`Invalid port: ${next}. Must be 0-65535.`);
      }
      port = parsed;
      i++;
    } else if (arg === "--data-dir" && next !== undefined) {
      dataDir = next;
      i++;
    } else if (arg === "--event-log" && next !== undefined) {
      eventLog = next;
      i++;
    } else if (arg === "--save-crew-url") {
      saveCrewUrl = true;
    }
  }

  return { host, port, dataDir, eventLog, saveCrewUrl };
}

// ── URL formatting ─────────────────────────────────────────────────

export function formatBrokerUrls(hostname: string, port: number): { httpUrl: string; wsUrl: string } {
  const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
  return {
    httpUrl: `http://${displayHost}:${port}`,
    wsUrl: `ws://${displayHost}:${port}`,
  };
}

// ── Command handler ────────────────────────────────────────────────

export async function cmdBroker(
  args: string[],
  projectRoot: string,
  deps: BrokerDeps = {},
): Promise<void> {
  const log = deps.log ?? console.log;
  const flags = parseBrokerFlags(args, projectRoot);

  const createServer = deps.createServer ?? ((opts) => {
    const server = new BrokerServer({
      hostname: opts.hostname,
      port: opts.port,
      dataDir: opts.dataDir,
      eventLogPath: opts.eventLogPath,
    });
    const actualPort = server.start();
    return { start: () => actualPort, hostname: server.hostname, port: server.port };
  });

  const server = createServer({
    hostname: flags.host,
    port: flags.port,
    dataDir: flags.dataDir,
    eventLogPath: flags.eventLog,
  });

  const actualPort = server.port;
  const actualHost = server.hostname;
  const { httpUrl, wsUrl } = formatBrokerUrls(actualHost, actualPort);

  log();
  log(`${BOLD}Ninthwave Broker${RESET}`);
  log();
  log(`  ${DIM}HTTP${RESET}  ${GREEN}${httpUrl}${RESET}`);
  log(`  ${DIM}WS${RESET}    ${CYAN}${wsUrl}${RESET}`);
  log();
  log(`  ${DIM}Data${RESET}  ${flags.dataDir}`);
  log(`  ${DIM}Log${RESET}   ${flags.eventLog}`);
  log();

  if (flags.saveCrewUrl) {
    const configSave = deps.saveConfig ?? saveConfig;
    configSave(projectRoot, { crew_url: wsUrl });
    log(`  ${DIM}Saved crew_url to .ninthwave/config.json${RESET}`);
    log();
  }

  log(`${DIM}Press Ctrl+C to stop.${RESET}`);

  // Block the foreground process until interrupted
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
}
