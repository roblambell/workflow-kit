// Crew/collaboration session lifecycle: URL resolution, session creation, broker management.
// Manages transitions between local, shared, and joined collaboration modes.

import { hostname } from "os";
import type { LogEntry } from "./types.ts";
import type {
  CrewBroker,
  CrewRemoteItemSnapshot,
  CrewStatus,
} from "./crew.ts";
import { WebSocketCrewBroker } from "./crew.ts";
import { makeBrokerHasher } from "./broker-hash.ts";
import { loadMergedProjectConfig, type ProjectConfig } from "./config.ts";
import type {
  RuntimeCollaborationActionRequest,
  RuntimeCollaborationActionResult,
} from "./watch-engine-runner.ts";

// ── Constants ───────────────────────────────────────────────────────

export const DEFAULT_CREW_URL = "wss://ninthwave.sh";

// ── Types ───────────────────────────────────────────────────────────

export interface CollaborationSessionState {
  mode: "local" | "shared" | "joined";
  /** First 8 chars of the derived crew id; debug-only display hint. */
  crewIdPrefix?: string;
  crewUrl?: string;
  crewBroker?: CrewBroker;
  connectMode: boolean;
}

export interface CollaborationSessionBrokerInfo {
  mode: CollaborationSessionState["mode"];
  crewIdPrefix?: string;
}

export interface ApplyRuntimeCollaborationActionDeps {
  projectRoot: string;
  crewName?: string;
  log: (entry: LogEntry) => void;
  /** Inject a project config override (defaults to reading from disk). */
  config?: ProjectConfig;
  createBroker?: (
    projectRoot: string,
    crewUrl: string,
    crewId: string,
    brokerSecret: string,
    deps: ConstructorParameters<typeof WebSocketCrewBroker>[4],
    crewName?: string,
  ) => CrewBroker;
  onBrokerChanged?: (broker: CrewBroker | undefined, info: CollaborationSessionBrokerInfo) => void;
}

// ── Functions ───────────────────────────────────────────────────────

export function resolveConfiguredCrewUrl(
  crewUrl?: string,
  projectCrewUrl?: string,
): string | undefined {
  return crewUrl ?? projectCrewUrl;
}

export function resolveStartupCollaborationAction(
  current: {
    connectMode: boolean;
    crewUrl?: string;
  },
  connectionAction: { type: "connect" } | null | undefined,
): {
  connectMode: boolean;
  crewUrl?: string;
} {
  if (!connectionAction) return current;
  return {
    connectMode: true,
    crewUrl: current.crewUrl,
  };
}

export function resolveCrewSocketUrl(crewUrl?: string): string {
  return crewUrl ?? DEFAULT_CREW_URL;
}

/**
 * Derive the per-project `crew_id` that daemons use as the WebSocket path
 * token.
 *
 * The crew id is `HMAC-SHA256(broker_secret, project_id)` truncated to 22
 * base64url characters via {@link makeBrokerHasher}. Two daemons configured
 * with the same `project_id` and `broker_secret` land on the same crew with
 * no user input -- the brokerside auto-create handler treats unknown ids as
 * fresh crews, so nothing needs to happen out-of-band.
 *
 * Throws a `TypeError` when the config is missing either field or when
 * `broker_secret` is not a canonical base64-encoded 32 bytes; callers can
 * surface that as "run `nw init` / `nw onboard`" friction.
 */
export function resolveCrewId(config: ProjectConfig): string {
  const projectId = config.project_id;
  const brokerSecret = config.broker_secret;
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new TypeError("resolveCrewId: project_id is missing from project config");
  }
  if (typeof brokerSecret !== "string" || brokerSecret.length === 0) {
    throw new TypeError("resolveCrewId: broker_secret is missing from project config");
  }
  return makeBrokerHasher(brokerSecret)(projectId);
}

export function resolveCrewHttpUrl(crewUrl?: string): string {
  return resolveCrewSocketUrl(crewUrl).replace(/^wss?:\/\//, "https://");
}

/**
 * Construct a {@link WebSocketCrewBroker} from a {@link ProjectConfig}.
 *
 * The crew id and broker hasher both derive from `project_id` +
 * `broker_secret`, so callers pass the config straight through and the
 * factory handles the hashing. A `createBroker` override is supported for
 * tests that want to inject a mock broker.
 */
export function createCrewBrokerInstance(
  projectRoot: string,
  crewUrl: string,
  config: ProjectConfig,
  log: (entry: LogEntry) => void,
  crewName?: string,
  createBroker?: ApplyRuntimeCollaborationActionDeps["createBroker"],
): CrewBroker {
  const resolvedName = crewName ?? hostname();
  const crewId = resolveCrewId(config);
  const brokerSecret = config.broker_secret!;
  const deps = { log: (level: "info" | "warn" | "error", msg: string) => log({ ts: new Date().toISOString(), level, event: "crew_client", message: msg }) };
  if (createBroker) {
    return createBroker(
      projectRoot,
      crewUrl,
      crewId,
      brokerSecret,
      deps,
      resolvedName,
    );
  }
  return new WebSocketCrewBroker(
    projectRoot,
    crewUrl,
    crewId,
    brokerSecret,
    deps,
    resolvedName,
  );
}

export async function applyRuntimeCollaborationAction(
  state: CollaborationSessionState,
  request: RuntimeCollaborationActionRequest,
  deps: ApplyRuntimeCollaborationActionDeps,
): Promise<RuntimeCollaborationActionResult> {
  if (request.action === "local") {
    state.crewBroker?.disconnect();
    state.crewBroker = undefined;
    state.crewIdPrefix = undefined;
    state.connectMode = false;
    state.mode = "local";
    deps.onBrokerChanged?.(undefined, { mode: "local" });
    deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_local_selected" });
    return { mode: "local" };
  }

  if (request.action === "share"
    && state.mode === "shared"
    && state.crewBroker?.isConnected()) {
    deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_share_reused" });
    return { mode: "shared" };
  }

  const nextCrewUrl = resolveCrewSocketUrl(state.crewUrl);
  // Auto-join: both "share" and "join" now resolve to the same crew id
  // derived from the project config. The distinction between the two paths
  // survives in the UI (share vs join) but the protocol is identical.
  let nextCrewId: string;
  let effectiveConfig: ProjectConfig;
  try {
    effectiveConfig = deps.config ?? loadMergedProjectConfig(deps.projectRoot);
    nextCrewId = resolveCrewId(effectiveConfig);
  } catch (error) {
    deps.log({
      ts: new Date().toISOString(),
      level: "warn",
      event: request.action === "share" ? "runtime_share_failed" : "runtime_join_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const nextCrewIdPrefix = nextCrewId.slice(0, 8);
  if (request.action === "share") {
    deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_share_created" });
  }

  const nextMode = request.action === "share" ? "shared" : "joined";
  const nextBroker = createCrewBrokerInstance(
    deps.projectRoot,
    nextCrewUrl,
    effectiveConfig,
    deps.log,
    deps.crewName,
    deps.createBroker,
  );

  try {
    await nextBroker.connect();
  } catch (error) {
    try {
      nextBroker.disconnect();
    } catch {
      // best effort -- failed startup brokers should not leak reconnect timers
    }
    deps.log({
      ts: new Date().toISOString(),
      level: "warn",
      event: request.action === "share" ? "runtime_share_connect_failed" : "runtime_join_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: error instanceof Error ? error.message : String(error) };
  }

  state.crewBroker?.disconnect();
  state.crewBroker = nextBroker;
  state.crewIdPrefix = nextCrewIdPrefix;
  state.crewUrl = nextCrewUrl;
  state.connectMode = request.action === "share";
  state.mode = nextMode;
  deps.onBrokerChanged?.(nextBroker, { mode: nextMode, crewIdPrefix: nextCrewIdPrefix });
  deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_crew_connected", mode: nextMode });
  return { mode: nextMode };
}
