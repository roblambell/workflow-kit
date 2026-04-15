// Crew WebSocket client with reconnect.
// Daemon-side client module behind a CrewBroker interface.
// Connects to the crew coordination server, manages claim/complete lifecycle,
// and handles reconnection with state reconciliation.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { execSync } from "node:child_process";
import { hostname } from "os";
import { userStateDir } from "./daemon.ts";
import { makeBrokerHasher } from "./broker-hash.ts";

// ── Shared message types ────────────────────────────────────────────
// Imported by mock-broker.ts for type-safe server implementation.
// The websocket protocol uses `workItem*` field names consistently.

export interface SyncItem {
  id: string;
  dependencies: string[];
  priority: number;
  author: string;
}

export interface SyncMessage {
  type: "sync";
  daemonId: string;
  items: SyncItem[];
}

export interface SyncAckMessage {
  type: "sync_ack";
  workItemIds: string[];
  telemetrySettings?: {
    sendTokenUsage?: boolean;
  };
  privacySettings?: Record<string, unknown>;
}

export interface ClaimMessage {
  type: "claim";
  requestId: string;
  daemonId: string;
}

export interface ClaimResponseMessage {
  type: "claim_response";
  requestId: string;
  workItemId: string | null;
}

export interface CompleteMessage {
  type: "complete";
  workItemId: string;
  daemonId: string;
}

export interface CompleteAckMessage {
  type: "complete_ack";
  workItemId: string;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  daemonId: string;
  ts: string;
}

export interface HeartbeatAckMessage {
  type: "heartbeat_ack";
  ts: string;
}

export interface ReconnectStateMessage {
  type: "reconnect_state";
  resumed: string[];    // work items still claimed by this daemon -- resume as-is
  released: string[];   // work items released but unclaimed -- re-claim
  reclaimed: string[];  // work items re-claimed by another daemon -- kill worker
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface CrewUpdateMessage {
  type: "crew_update";
  daemonCount: number;
  availableCount: number;
  claimedCount: number;
  completedCount: number;
  daemonNames: string[];
  claimedItems?: Array<Record<string, unknown>>;
  items?: Array<Record<string, unknown>>;
  remoteItems?: Array<Record<string, unknown>>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
}

export interface ReportMessage {
  type: "report";
  daemonId: string;
  event: string;
  workItemPath: string;
  metadata: Record<string, unknown>;
  repoUrl?: string;
  branch?: string;
  commitAuthor?: string;
  model?: string;
  sessionId?: string;
  tokenUsage?: TokenUsage;
}

export interface ReportAckMessage {
  type: "report_ack";
  event: string;
}

export type ClientMessage =
  | SyncMessage
  | ClaimMessage
  | CompleteMessage
  | HeartbeatMessage
  | ReportMessage;

export type ServerMessage =
  | SyncAckMessage
  | ClaimResponseMessage
  | CompleteAckMessage
  | HeartbeatAckMessage
  | CrewUpdateMessage
  | ReconnectStateMessage
  | ReportAckMessage
  | ErrorMessage;

// ── Reconnect reconciliation callback ───────────────────────────────

export interface ReconnectState {
  resumed: string[];
  released: string[];
  reclaimed: string[];
}

// ── Crew status (from crew_update messages) ───────────────────────

export type CrewRemoteItemState =
  | "merged"
  | "verifying"
  | "done"
  | "blocked"
  | "implementing"
  | "rebasing"
  | "ci-failed"
  | "cd-failed"
  | "ci-pending"
  | "ci-passed"
  | "review"
  | "in-progress"
  | "queued";

export interface CrewRemoteItemSnapshot {
  id: string;
  state: CrewRemoteItemState;
  ownerDaemonId: string | null;
  ownerName: string | null;
  title?: string;
  prNumber?: number | null;
  priorPrNumbers?: number[];
}

export interface CrewStatus {
  daemonCount: number;
  availableCount: number;
  claimedCount: number;
  completedCount: number;
  daemonNames: string[];
  /** Item IDs claimed by other daemons (not this one). */
  claimedItems: string[];
  /** Broker-derived item snapshots for non-local owners and unowned remote state. */
  remoteItems: CrewRemoteItemSnapshot[];
}

const CREW_REMOTE_ITEM_STATES: ReadonlySet<CrewRemoteItemState> = new Set([
  "merged",
  "verifying",
  "done",
  "blocked",
  "implementing",
  "rebasing",
  "ci-failed",
  "cd-failed",
  "ci-pending",
  "ci-passed",
  "review",
  "in-progress",
  "queued",
]);

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberArrayOrUndefined(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
  return numbers.length > 0 ? numbers : undefined;
}

function parseCrewRemoteItemState(value: unknown): CrewRemoteItemState | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim().replace(/_/g, "-").toLowerCase();
  if (!normalized) return null;
  if (CREW_REMOTE_ITEM_STATES.has(normalized as CrewRemoteItemState)) {
    return normalized as CrewRemoteItemState;
  }

  switch (normalized) {
    case "forward-fix-pending":
    case "fixing-forward":
      return "verifying";
    case "launching":
      return "implementing";
    case "stuck":
      return "ci-failed";
    case "fix-forward-failed":
      return "cd-failed";
    case "merging":
      return "ci-pending";
    case "ci-passed":
      return "ci-passed";
    case "review-pending":
    case "reviewing":
      return "review";
    case "ready":
      return "queued";
    default:
      return "in-progress";
  }
}

function parseCrewRemoteItemSnapshot(value: unknown): CrewRemoteItemSnapshot | null {
  const item = recordOrNull(value);
  if (!item) return null;

  const nestedItem = recordOrNull(item.item) ?? recordOrNull(item.workItem) ?? recordOrNull(item.snapshot);
  const nestedOwner = recordOrNull(item.owner) ?? recordOrNull(item.claimedBy);
  const nestedStatus = recordOrNull(item.status) ?? recordOrNull(nestedItem?.status);
  const nestedPr = recordOrNull(item.pr) ?? recordOrNull(nestedItem?.pr);
  const id = stringOrNull(item.id)
    ?? stringOrNull(item.workItemId)
    ?? stringOrNull(nestedItem?.id)
    ?? stringOrNull(nestedItem?.workItemId);
  const state = parseCrewRemoteItemState(item.state ?? item.workItemState ?? nestedItem?.state ?? nestedStatus?.state);
  if (!id || !state) return null;

  const ownerDaemonId =
    stringOrNull(item.ownerDaemonId)
    ?? stringOrNull(item.daemonId)
    ?? stringOrNull(nestedOwner?.daemonId)
    ?? stringOrNull(nestedOwner?.id)
    ?? null;
  const ownerName =
    stringOrNull(item.ownerName)
    ?? stringOrNull(item.daemonName)
    ?? stringOrNull(nestedOwner?.name)
    ?? stringOrNull(nestedOwner?.displayName)
    ?? null;
  const title = stringOrNull(item.title)
    ?? stringOrNull(item.workItemTitle)
    ?? stringOrNull(nestedItem?.title)
    ?? stringOrNull(nestedItem?.workItemTitle)
    ?? undefined;
  const rawPrNumber = item.prNumber
    ?? item.pullRequestNumber
    ?? nestedItem?.prNumber
    ?? nestedItem?.pullRequestNumber
    ?? nestedPr?.number;
  const prNumber = numberOrNull(rawPrNumber);
  const priorPrNumbers = numberArrayOrUndefined(
    item.priorPrNumbers
    ?? item.previousPrNumbers
    ?? nestedItem?.priorPrNumbers
    ?? nestedItem?.previousPrNumbers
    ?? nestedPr?.priorNumbers
    ?? nestedPr?.numbers,
  );

  return {
    id,
    state,
    ownerDaemonId,
    ownerName,
    ...(title ? { title } : {}),
    ...(prNumber !== null || rawPrNumber === null
      ? { prNumber }
      : {}),
    ...(priorPrNumbers ? { priorPrNumbers } : {}),
  };
}

function parseLegacyClaimedItemIds(value: unknown, localDaemonId: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = recordOrNull(entry);
    const id = stringOrNull(item?.id);
    const daemonId = stringOrNull(item?.daemonId);
    if (!id || daemonId === localDaemonId) return [];
    return [id];
  });
}

export function parseCrewStatusUpdate(data: Record<string, unknown>, localDaemonId: string): CrewStatus {
  const rawSnapshots = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.remoteItems)
      ? data.remoteItems
      : Array.isArray(data.claimedItems)
        ? data.claimedItems
        : [];

  const remoteItems = rawSnapshots
    .map(parseCrewRemoteItemSnapshot)
    .filter((item): item is CrewRemoteItemSnapshot => item !== null)
    .filter((item) => item.ownerDaemonId !== localDaemonId);

  const claimedItems = remoteItems.some((item) => item.ownerDaemonId !== null)
    ? remoteItems.filter((item) => item.ownerDaemonId !== null).map((item) => item.id)
    : parseLegacyClaimedItemIds(data.claimedItems, localDaemonId);

  return {
    daemonCount: typeof data.daemonCount === "number" ? data.daemonCount : 0,
    availableCount: typeof data.availableCount === "number" ? data.availableCount : 0,
    claimedCount: typeof data.claimedCount === "number" ? data.claimedCount : 0,
    completedCount: typeof data.completedCount === "number" ? data.completedCount : 0,
    daemonNames: Array.isArray(data.daemonNames)
      ? data.daemonNames.filter((name): name is string => typeof name === "string")
      : [],
    claimedItems,
    remoteItems,
  };
}

// ── CrewBroker interface ────────────────────────────────────────────

export interface CrewBroker {
  /** Connect to the crew server. Resolves when the initial sync_ack is received. */
  connect(): Promise<void>;

  /** Send sync message with current active items and their metadata. */
  sync(items: SyncItem[]): void;

  /** Claim the next available work item. Returns workItemId or null (5s timeout). */
  claim(): Promise<string | null>;

  /** Mark a work item as complete. */
  complete(workItemId: string): void;

  /** Send a heartbeat to the server. */
  heartbeat(): void;

  /** Disconnect from the server and stop reconnect timer. */
  disconnect(): void;

  /** Whether the WebSocket is currently connected. */
  isConnected(): boolean;

  /** Get the latest crew status from crew_update messages. Null until first update received. */
  getCrewStatus(): CrewStatus | null;

  /** Send a report event for an active shared session. */
  report(
    event: string,
    workItemPath: string,
    metadata: Record<string, unknown>,
    opts?: { model?: string; tokenUsage?: TokenUsage },
  ): void;
}

// ── DaemonId persistence ────────────────────────────────────────────

/** Path to the daemon-id file in the user state directory. */
export function daemonIdPath(projectRoot: string): string {
  return join(userStateDir(projectRoot), "daemon-id");
}

/**
 * Read or generate a persistent daemon ID.
 * Generates a UUID on first call, reuses it on subsequent calls.
 */
export function getOrCreateDaemonId(projectRoot: string): string {
  const filePath = daemonIdPath(projectRoot);
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8").trim();
    if (existing.length > 0) return existing;
  }
  const id = randomUUID();
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, id, "utf-8");
  return id;
}

// ── Operator identity persistence ──────────────────────────────────

/** Injectable deps for operator identity (enables testing without git). */
export interface OperatorIdDeps {
  exec: (cmd: string) => string;
  existsSync: typeof existsSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  mkdirSync: typeof mkdirSync;
}

const defaultOperatorIdDeps: OperatorIdDeps = {
  exec: (cmd) => execSync(cmd, { encoding: "utf-8", timeout: 5_000 }).trim(),
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
};

/** Path to the operator-id file in the user state directory. */
export function operatorIdPath(projectRoot: string): string {
  return join(userStateDir(projectRoot), "operator-id");
}

/**
 * Resolve the operator identity from `git config user.email`.
 * On first call, the result is persisted to the state directory.
 * On subsequent calls (e.g., daemon restart), the persisted value is returned.
 *
 * Falls back to empty string if `git config user.email` is not set.
 */
export function resolveOperatorId(
  projectRoot: string,
  deps: OperatorIdDeps = defaultOperatorIdDeps,
): string {
  const filePath = operatorIdPath(projectRoot);

  // Check persisted file first (survives daemon restarts)
  if (deps.existsSync(filePath)) {
    const existing = deps.readFileSync(filePath, "utf-8").trim();
    if (existing.length > 0) return existing;
  }

  // Resolve from git config
  let email = "";
  try {
    email = deps.exec("git config user.email");
  } catch {
    // git config user.email not set -- fall back to empty string
  }

  // Persist for future restarts
  const dir = dirname(filePath);
  if (!deps.existsSync(dir)) {
    deps.mkdirSync(dir, { recursive: true });
  }
  deps.writeFileSync(filePath, email, "utf-8");

  return email;
}

// ── Injectable dependencies ─────────────────────────────────────────

export interface CrewBrokerDeps {
  /** Logger for warnings/errors. */
  log: (level: "info" | "warn" | "error", msg: string) => void;
  /** Called on reconnect with reconciliation state. */
  onReconnect?: (state: ReconnectState) => void;
  /** Claim timeout in ms (default: 5000). */
  claimTimeoutMs?: number;
  /** Reconnect interval in ms (default: 30000). */
  reconnectIntervalMs?: number;
  /** Heartbeat interval in ms (default: 30000). */
  heartbeatIntervalMs?: number;
}

// ── WebSocketCrewBroker ─────────────────────────────────────────────

const CLAIM_TIMEOUT_MS = 5_000;
const RECONNECT_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Allowlist of metadata event-name strings that may be sent to the broker in
 * cleartext. Anything outside the allowlist (other than booleans and numbers)
 * is hashed before leaving the daemon so an operator name, repo slug, or
 * similar identifier cannot leak through a report payload.
 *
 * The list covers the event-name vocabulary used by the daemon today; add to
 * it rather than widening the allowlist when new telemetry is introduced.
 */
const METADATA_CLEARTEXT_STRING_ALLOWLIST: ReadonlySet<string> = new Set([
  "pr_opened",
  "pr_updated",
  "pr_merged",
  "pr_closed",
  "ci_passed",
  "ci_failed",
  "session_start",
  "session_started",
  "session_end",
  "session_ended",
  "claim",
  "complete",
  "complete_ack",
  "heartbeat",
  "report",
  "review",
  "rebase",
  "queued",
  "implementing",
  "merging",
  "done",
  "blocked",
]);

export class WebSocketCrewBroker implements CrewBroker {
  private ws: WebSocket | null = null;
  private connected = false;
  /** Local (cleartext) daemon id -- never sent on the wire. */
  private daemonId: string;
  /** Local (cleartext) operator id -- never sent on the wire. */
  private operatorId: string;
  private url: string;
  private name: string;
  /** Hashed (wire) version of daemonId -- always sent instead of daemonId. */
  private hashedDaemonId: string;
  /** Hashed (wire) version of operatorId -- always sent instead of operatorId. */
  private hashedOperatorId: string;
  /** Hashed (wire) version of `name` (the machine hostname). */
  private hashedName: string;
  /** HMAC-SHA256 hasher bound to the project's `broker_secret`. */
  private hasher: (value: string) => string;
  /** Reverse map of hash → local work item id, populated on sync(). */
  private hashToLocal = new Map<string, string>();
  /** Forward map of local work item id → hash, populated on sync(). */
  private localToHash = new Map<string, string>();
  private deps: CrewBrokerDeps;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingClaims = new Map<string, {
    resolve: (workItemId: string | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private connectPromise: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private disconnectedIntentionally = false;
  private crewStatus: CrewStatus | null = null;
  private sessionId: string | null = null;
  private currentModel: string | undefined;
  private sendTokenUsage = false;

  /**
   * Create a crew broker bound to the given project identity.
   *
   * @param projectRoot  Local project root; used to persist daemon/operator ids.
   * @param url          Base WebSocket URL, e.g. `ws://host:port`.
   * @param crewId       Already-hashed path token (22+ char base64url).
   * @param brokerSecret Canonical base64 `broker_secret`; used to build the
   *                     per-wire hasher. The same secret on two daemons is
   *                     what makes their anonymized ids correlate.
   * @param deps         Injected deps (logger, optional timings, hooks).
   * @param name         Display name (defaults to `os.hostname()`). Hashed
   *                     before leaving the daemon.
   */
  constructor(
    projectRoot: string,
    url: string,
    crewId: string,
    brokerSecret: string,
    deps: CrewBrokerDeps,
    name?: string,
  ) {
    this.daemonId = getOrCreateDaemonId(projectRoot);
    this.operatorId = resolveOperatorId(projectRoot);
    this.name = name ?? hostname();
    this.hasher = makeBrokerHasher(brokerSecret);
    this.hashedDaemonId = this.hasher(this.daemonId);
    this.hashedOperatorId = this.operatorId === "" ? "" : this.hasher(this.operatorId);
    this.hashedName = this.hasher(this.name);
    this.url = `${url}/api/crews/${crewId}/ws`;
    this.deps = deps;
  }

  /** Expose the local (cleartext) daemonId for testing. */
  getDaemonId(): string {
    return this.daemonId;
  }

  /** Expose the hashed daemonId that goes on the wire (for testing / diagnostics). */
  getHashedDaemonId(): string {
    return this.hashedDaemonId;
  }

  /** Expose the local (cleartext) operatorId for testing. */
  getOperatorId(): string {
    return this.operatorId;
  }

  async connect(): Promise<void> {
    this.disconnectedIntentionally = false;
    return this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectPromise = { resolve, reject };
      this.sessionId ??= randomUUID();
      const wsUrl = new URL(this.url);
      // Every identifier on the wire is hashed. repoUrl / repoHash are
      // intentionally omitted -- possession of the broker secret is the
      // only authorization signal now.
      wsUrl.searchParams.set("daemonId", this.hashedDaemonId);
      wsUrl.searchParams.set("name", this.hashedName);
      wsUrl.searchParams.set("operatorId", this.hashedOperatorId);
      this.ws = new WebSocket(wsUrl.toString());

      this.ws.onopen = () => {
        this.connected = true;
        this.startHeartbeatTimer();
        this.deps.log("info", `Connected to crew server at ${this.url}`);
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event);
      };

      this.ws.onerror = (event: Event) => {
        this.deps.log("warn", `WebSocket error`);
        if (this.connectPromise) {
          this.connectPromise.reject(new Error("WebSocket connection failed"));
          this.connectPromise = null;
        }
      };

      this.ws.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.stopHeartbeatTimer();
        this.rejectAllPendingClaims();

        if (this.connectPromise) {
          this.connectPromise.reject(new Error("Crew connection closed before the broker handshake completed"));
          this.connectPromise = null;
        }

        if (wasConnected) {
          this.deps.log("warn", "WebSocket disconnected");
        }

        // Start reconnect timer unless intentionally disconnected
        if (!this.disconnectedIntentionally) {
          this.startReconnectTimer();
        }
      };
    });
  }

  sync(items: SyncItem[]): void {
    const hashedItems: SyncItem[] = items.map((item) => {
      const hashedId = this.rememberWorkItemId(item.id);
      const hashedDeps = item.dependencies.map((dep) => this.rememberWorkItemId(dep));
      const hashedAuthor = item.author === "" ? "" : this.hasher(item.author);
      return {
        id: hashedId,
        dependencies: hashedDeps,
        priority: item.priority,
        author: hashedAuthor,
      };
    });
    this.send({
      type: "sync",
      daemonId: this.hashedDaemonId,
      items: hashedItems,
    });
  }

  async claim(): Promise<string | null> {
    if (!this.connected || !this.ws) return null;

    const requestId = randomUUID();
    const timeoutMs = this.deps.claimTimeoutMs ?? CLAIM_TIMEOUT_MS;

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingClaims.delete(requestId);
        resolve(null);
      }, timeoutMs);

      this.pendingClaims.set(requestId, { resolve, timer });

      this.send({
        type: "claim",
        requestId,
        daemonId: this.hashedDaemonId,
      });
    });
  }

  complete(workItemId: string): void {
    const hashedId = this.rememberWorkItemId(workItemId);
    this.send({
      type: "complete",
      workItemId: hashedId,
      daemonId: this.hashedDaemonId,
    });
  }

  report(
    event: string,
    workItemPath: string,
    metadata: Record<string, unknown>,
    opts?: { model?: string; tokenUsage?: TokenUsage },
  ): void {
    const model = opts?.model ?? this.extractModelFromMetadata(metadata) ?? this.currentModel;
    if (model) {
      this.currentModel = model;
    }

    const hashedWorkItemPath = workItemPath === ""
      ? ""
      : this.rememberWorkItemId(workItemPath);
    const sanitizedMetadata = this.sanitizeReportMetadata(metadata);

    this.send({
      type: "report",
      daemonId: this.hashedDaemonId,
      event,
      workItemPath: hashedWorkItemPath,
      metadata: sanitizedMetadata,
      ...(model ? { model } : {}),
      ...(this.sessionId ? { sessionId: this.hasher(this.sessionId) } : {}),
      ...(this.sendTokenUsage && opts?.tokenUsage ? { tokenUsage: opts.tokenUsage } : {}),
    });
  }

  heartbeat(): void {
    this.send({
      type: "heartbeat",
      daemonId: this.hashedDaemonId,
      ts: new Date().toISOString(),
    });
  }

  disconnect(): void {
    this.disconnectedIntentionally = true;
    this.stopReconnectTimer();
    this.stopHeartbeatTimer();
    this.rejectAllPendingClaims();
    if (this.ws && this.connected) {
      this.report("session_end", "", {}, { model: this.currentModel });
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getCrewStatus(): CrewStatus | null {
    return this.crewStatus;
  }

  // ── Internal helpers ────────────────────────────────────────────

  private send(msg: ClientMessage): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(event: MessageEvent): void {
    let data: any;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      this.deps.log("warn", `Malformed JSON from crew server: ${String(event.data)}`);
      return;
    }

    switch (data.type) {
      case "sync_ack":
        this.sendTokenUsage = data.telemetrySettings?.sendTokenUsage === true;
        // Initial connection handshake complete
        if (this.connectPromise) {
          this.connectPromise.resolve();
          this.connectPromise = null;
        }
        break;

      case "claim_response": {
        const pending = this.pendingClaims.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingClaims.delete(data.requestId);
          // The broker returns the hashed work item id; translate back.
          const localId = typeof data.workItemId === "string" && data.workItemId.length > 0
            ? this.hashToLocal.get(data.workItemId) ?? null
            : null;
          pending.resolve(localId);
        }
        break;
      }

      case "complete_ack":
        // No-op -- fire-and-forget
        break;

      case "report_ack":
        // No-op -- fire-and-forget
        break;

      case "heartbeat_ack":
        // No-op -- confirms server is alive
        break;

      case "reconnect_state":
        if (this.deps.onReconnect) {
          this.deps.onReconnect({
            resumed: data.resumed ?? [],
            released: data.released ?? [],
            reclaimed: data.reclaimed ?? [],
          });
        }
        // Also resolve connect promise for reconnect
        if (this.connectPromise) {
          this.connectPromise.resolve();
          this.connectPromise = null;
        }
        break;

      case "crew_update":
        // Translate hashed work item ids back to local ids before exposing the
        // status to the rest of the daemon. Hashes that don't match any local
        // sync (i.e. peer-owned items) become `peer-<prefix>` so the UI can
        // still label them without leaking upstream identifiers.
        this.crewStatus = parseCrewStatusUpdate(
          this.translateCrewUpdatePayload(data),
          this.hashedDaemonId,
        );
        if (this.connectPromise) {
          this.connectPromise.resolve();
          this.connectPromise = null;
        }
        break;

      case "error":
        this.deps.log("error", `Crew server error: ${data.message}`);
        if (this.connectPromise) {
          const pendingConnect = this.connectPromise;
          this.connectPromise = null;
          pendingConnect.reject(new Error(typeof data.message === "string" && data.message.length > 0
            ? data.message
            : "Crew server rejected the connection"));
          this.disconnect();
        }
        break;

      default:
        this.deps.log("warn", `Unknown message type from crew server: ${data.type}`);
        break;
    }
  }

  private startReconnectTimer(): void {
    this.stopReconnectTimer();
    const intervalMs = this.deps.reconnectIntervalMs ?? RECONNECT_INTERVAL_MS;
    this.reconnectTimer = setInterval(() => {
      if (!this.connected && !this.disconnectedIntentionally) {
        this.deps.log("info", "Attempting reconnect to crew server...");
        this.doConnect().catch(() => {
          // doConnect rejection is handled by onclose → will retry
        });
      }
    }, intervalMs);
  }

  private extractModelFromMetadata(metadata: Record<string, unknown>): string | undefined {
    const model = metadata.model;
    return typeof model === "string" && model.length > 0 ? model : undefined;
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeatTimer(): void {
    this.stopHeartbeatTimer();
    const intervalMs = this.deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer = setInterval(() => {
      if (this.connected) {
        this.heartbeat();
      }
    }, intervalMs);
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private rejectAllPendingClaims(): void {
    for (const [id, pending] of this.pendingClaims) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingClaims.clear();

  }

  /**
   * Hash `id` and cache the forward / reverse mapping so callers can feed
   * cleartext work item ids in and get cleartext back on claim responses
   * and crew updates. Idempotent: repeat calls return the cached hash.
   */
  private rememberWorkItemId(id: string): string {
    const cached = this.localToHash.get(id);
    if (cached) return cached;
    const hashed = this.hasher(id);
    this.localToHash.set(id, hashed);
    this.hashToLocal.set(hashed, id);
    return hashed;
  }

  /**
   * Sanitize a report `metadata` object before it leaves the daemon.
   *
   * Structural fields the broker actually needs -- booleans, numbers, and a
   * small allowlist of enum-shaped strings -- pass through. Any other string
   * is replaced with its hash so that the broker gets a stable-but-opaque
   * token in place of things like file paths, git emails, or repo slugs.
   * Nested objects are sanitized recursively; arrays are mapped.
   */
  private sanitizeReportMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      out[key] = this.sanitizeMetadataValue(value);
    }
    return out;
  }

  private sanitizeMetadataValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      if (value === "") return value;
      if (METADATA_CLEARTEXT_STRING_ALLOWLIST.has(value)) return value;
      return this.hasher(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.sanitizeMetadataValue(entry));
    }
    if (typeof value === "object") {
      const nested: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        nested[k] = this.sanitizeMetadataValue(v);
      }
      return nested;
    }
    // Fallback: drop non-serializable shapes (functions, symbols, etc.).
    return null;
  }

  /**
   * Walk a `crew_update` payload and rewrite every hashed work item id back
   * into the local cleartext id. Hashes that the daemon never synced locally
   * get a synthetic `peer-<prefix>` id so the TUI can label them without
   * pulling cleartext strings out of thin air.
   */
  private translateCrewUpdatePayload(data: Record<string, unknown>): Record<string, unknown> {
    const mapId = (value: unknown): unknown => {
      if (typeof value !== "string" || value.length === 0) return value;
      const local = this.hashToLocal.get(value);
      return local ?? `peer-${value.slice(0, 8)}`;
    };

    const mapRecord = (value: unknown): unknown => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = { ...record };
      for (const field of ["id", "workItemId"] as const) {
        if (typeof record[field] === "string") {
          out[field] = mapId(record[field]);
        }
      }
      for (const nestedKey of ["item", "workItem", "snapshot"] as const) {
        const nested = record[nestedKey];
        if (nested !== undefined) {
          out[nestedKey] = mapRecord(nested);
        }
      }
      return out;
    };

    const cloned: Record<string, unknown> = { ...data };
    for (const listKey of ["items", "remoteItems", "claimedItems"] as const) {
      const list = cloned[listKey];
      if (Array.isArray(list)) {
        cloned[listKey] = list.map((entry) => mapRecord(entry));
      }
    }
    return cloned;
  }
}
