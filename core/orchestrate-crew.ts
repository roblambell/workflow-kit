// Crew/collaboration session lifecycle: URL resolution, session creation, broker management.
// Manages transitions between local, shared, and joined collaboration modes.

import { hostname } from "os";
import type { LogEntry } from "./types.ts";
import type {
  CrewBroker,
  CrewRemoteItemSnapshot,
  CrewStatus,
  ConnectionAction,
} from "./crew.ts";
import { WebSocketCrewBroker, saveCrewCode } from "./crew.ts";
import { makeBrokerHasher } from "./broker-hash.ts";
import { loadMergedProjectConfig, type ProjectConfig } from "./config.ts";
import { resolveRepoRef } from "./repo-ref.ts";
import type {
  RuntimeCollaborationActionRequest,
  RuntimeCollaborationActionResult,
} from "./watch-engine-runner.ts";

// ── Constants ───────────────────────────────────────────────────────

export const DEFAULT_CREW_URL = "wss://ninthwave.sh";

// ── Types ───────────────────────────────────────────────────────────

export interface CollaborationSessionState {
  mode: "local" | "shared" | "joined";
  crewCode?: string;
  crewUrl?: string;
  crewBroker?: CrewBroker;
  connectMode: boolean;
}

export interface CollaborationSessionBrokerInfo {
  mode: CollaborationSessionState["mode"];
  crewCode?: string;
}

export interface ApplyRuntimeCollaborationActionDeps {
  projectRoot: string;
  /**
   * @deprecated Kept for the dead-but-present pre-H-BAJ-3 code paths while
   * the UI strings still surface it. The new protocol does not send repo
   * references to the broker.
   */
  crewRepoUrl: string;
  crewName?: string;
  log: (entry: LogEntry) => void;
  fetchFn?: typeof fetch;
  saveCrewCodeFn?: typeof saveCrewCode;
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
    crewCode?: string;
    crewUrl?: string;
  },
  connectionAction: ConnectionAction | null | undefined,
): {
  connectMode: boolean;
  crewCode?: string;
  crewUrl?: string;
} {
  if (!connectionAction) return current;
  if (connectionAction.type === "connect") {
    return {
      connectMode: true,
      crewCode: undefined,
      crewUrl: current.crewUrl,
    };
  }
  return {
    connectMode: false,
    crewCode: connectionAction.code,
    crewUrl: current.crewUrl ?? DEFAULT_CREW_URL,
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

export function buildCrewRepoReferencePayload(crewRepoUrl: string): Record<string, string> {
  const trimmedRepoUrl = crewRepoUrl.trim();
  if (!trimmedRepoUrl) return {};

  try {
    const resolved = resolveRepoRef({ repoUrl: trimmedRepoUrl });
    return {
      repoUrl: trimmedRepoUrl,
      repoHash: resolved.repoHash,
      repoRef: resolved.repoRef,
    };
  } catch {
    return { repoUrl: trimmedRepoUrl };
  }
}

export async function createCrewCode(
  crewUrl: string | undefined,
  crewRepoUrl: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const response = await fetchFn(`${resolveCrewHttpUrl(crewUrl)}/api/crews`, {
    method: "POST",
    body: JSON.stringify(buildCrewRepoReferencePayload(crewRepoUrl)),
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create session: ${response.status}${body ? ` ${body}` : ""}`);
  }

  const payload = await response.json() as { code?: string };
  if (!payload.code) {
    throw new Error("Failed to create session: missing crew code");
  }
  return payload.code;
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
  const fetchFn = deps.fetchFn ?? fetch;
  const saveCrewCodeFn = deps.saveCrewCodeFn ?? saveCrewCode;

  if (request.action === "local") {
    state.crewBroker?.disconnect();
    state.crewBroker = undefined;
    state.crewCode = undefined;
    state.connectMode = false;
    state.mode = "local";
    deps.onBrokerChanged?.(undefined, { mode: "local" });
    deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_local_selected" });
    return { mode: "local" };
  }

  if (request.action === "share"
    && state.mode === "shared"
    && state.crewCode
    && state.crewBroker?.isConnected()) {
    deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_share_reused", crewCode: state.crewCode });
    return { mode: "shared", code: state.crewCode };
  }

  const nextCrewUrl = resolveCrewSocketUrl(state.crewUrl);
  // Auto-join: both "share" and "join" now resolve to the same crew id
  // derived from the project config. The distinction between the two paths
  // survives in the UI (share vs join) but the protocol is identical.
  let nextCrewCode: string;
  let effectiveConfig: ProjectConfig;
  try {
    effectiveConfig = deps.config ?? loadMergedProjectConfig(deps.projectRoot);
    nextCrewCode = resolveCrewId(effectiveConfig);
  } catch (error) {
    deps.log({
      ts: new Date().toISOString(),
      level: "warn",
      event: request.action === "share" ? "runtime_share_failed" : "runtime_join_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (request.action === "share") {
    deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_share_created", crewCode: nextCrewCode });
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
      crewCode: nextCrewCode,
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: error instanceof Error ? error.message : String(error) };
  }

  state.crewBroker?.disconnect();
  state.crewBroker = nextBroker;
  state.crewCode = nextCrewCode;
  state.crewUrl = nextCrewUrl;
  state.connectMode = request.action === "share";
  state.mode = nextMode;
  deps.onBrokerChanged?.(nextBroker, { mode: nextMode, crewCode: nextCrewCode });
  saveCrewCodeFn(deps.projectRoot, nextCrewCode);
  deps.log({ ts: new Date().toISOString(), level: "info", event: "runtime_crew_connected", crewCode: nextCrewCode, mode: nextMode });
  return { mode: nextMode, code: nextCrewCode };
}
