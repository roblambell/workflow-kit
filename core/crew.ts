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

// ── Shared message types ────────────────────────────────────────────
// Imported by mock-broker.ts for type-safe server implementation.

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
  crewCode: string;
  todoIds: string[];
}

export interface ClaimMessage {
  type: "claim";
  requestId: string;
  daemonId: string;
}

export interface ClaimResponseMessage {
  type: "claim_response";
  requestId: string;
  todoId: string | null;
}

export interface CompleteMessage {
  type: "complete";
  todoId: string;
  daemonId: string;
}

export interface CompleteAckMessage {
  type: "complete_ack";
  todoId: string;
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
  resumed: string[];    // TODOs still claimed by this daemon -- resume as-is
  released: string[];   // TODOs released but unclaimed -- re-claim
  reclaimed: string[];  // TODOs re-claimed by another daemon -- kill worker
}

export interface ScheduleClaimMessage {
  type: "schedule_claim";
  requestId: string;
  daemonId: string;
  taskId: string;
  scheduleTime: string;
}

export interface ScheduleClaimResponseMessage {
  type: "schedule_claim_response";
  requestId: string;
  taskId: string;
  granted: boolean;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface ReportMessage {
  type: "report";
  daemonId: string;
  event: string;
  todoPath: string;
  metadata: Record<string, unknown>;
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
  | ScheduleClaimMessage
  | ReportMessage;

export type ServerMessage =
  | SyncAckMessage
  | ClaimResponseMessage
  | CompleteAckMessage
  | HeartbeatAckMessage
  | ReconnectStateMessage
  | ScheduleClaimResponseMessage
  | ReportAckMessage
  | ErrorMessage;

// ── Reconnect reconciliation callback ───────────────────────────────

export interface ReconnectState {
  resumed: string[];
  released: string[];
  reclaimed: string[];
}

// ── Crew status (from crew_update messages) ───────────────────────

export interface CrewStatus {
  crewCode: string;
  daemonCount: number;
  availableCount: number;
  claimedCount: number;
  completedCount: number;
  daemonNames: string[];
  /** Item IDs claimed by other daemons (not this one). */
  claimedItems: string[];
}

// ── CrewBroker interface ────────────────────────────────────────────

export interface CrewBroker {
  /** Connect to the crew server. Resolves when the initial sync_ack is received. */
  connect(): Promise<void>;

  /** Send sync message with current active items and their metadata. */
  sync(items: SyncItem[]): void;

  /** Claim the next available TODO. Returns todoId or null (5s timeout). */
  claim(): Promise<string | null>;

  /** Mark a TODO as complete. */
  complete(todoId: string): void;

  /** Claim a schedule slot. Returns true if granted, false if denied or timeout. */
  scheduleClaim(taskId: string, scheduleTime: string): Promise<boolean>;

  /** Send a heartbeat to the server. */
  heartbeat(): void;

  /** Disconnect from the server and stop reconnect timer. */
  disconnect(): void;

  /** Whether the WebSocket is currently connected. */
  isConnected(): boolean;

  /** Get the latest crew status from crew_update messages. Null until first update received. */
  getCrewStatus(): CrewStatus | null;

  /** Send a telemetry report event. Fire-and-forget, no-op if telemetry disabled. */
  report(event: string, todoPath: string, metadata: Record<string, unknown>): void;

  /** Enable or disable telemetry reporting. */
  setTelemetry(enabled: boolean): void;
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

// ── Crew code persistence ──────────────────────────────────────────

/** Path to the crew-code file in the user state directory. */
export function crewCodePath(projectRoot: string): string {
  return join(userStateDir(projectRoot), "crew-code");
}

/** Read a previously saved crew code. Returns null if none saved. */
export function readCrewCode(projectRoot: string): string | null {
  const filePath = crewCodePath(projectRoot);
  if (!existsSync(filePath)) return null;
  const code = readFileSync(filePath, "utf-8").trim();
  return code.length > 0 ? code : null;
}

/** Save a crew code to the user state directory for persistent sessions. */
export function saveCrewCode(projectRoot: string, code: string): void {
  const filePath = crewCodePath(projectRoot);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, code, "utf-8");
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

export class WebSocketCrewBroker implements CrewBroker {
  private ws: WebSocket | null = null;
  private connected = false;
  private daemonId: string;
  private operatorId: string;
  private url: string;
  private repoUrl: string;
  private name: string;
  private deps: CrewBrokerDeps;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingClaims = new Map<string, {
    resolve: (todoId: string | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private pendingScheduleClaims = new Map<string, {
    resolve: (granted: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private connectPromise: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private disconnectedIntentionally = false;
  private crewStatus: CrewStatus | null = null;
  private telemetryEnabled: boolean;

  constructor(
    projectRoot: string,
    url: string,
    crewCode: string,
    repoUrl: string,
    deps: CrewBrokerDeps,
    name?: string,
    telemetryEnabled?: boolean,
  ) {
    this.daemonId = getOrCreateDaemonId(projectRoot);
    this.operatorId = resolveOperatorId(projectRoot);
    this.name = name ?? hostname();
    this.url = `${url}/api/crews/${crewCode}/ws`;
    this.repoUrl = repoUrl;
    this.deps = deps;
    this.telemetryEnabled = telemetryEnabled ?? false;
  }

  /** Expose daemonId for testing. */
  getDaemonId(): string {
    return this.daemonId;
  }

  /** Expose operatorId for testing. */
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
      const wsUrl = `${this.url}?daemonId=${this.daemonId}&name=${encodeURIComponent(this.name)}&operatorId=${encodeURIComponent(this.operatorId)}&repoUrl=${encodeURIComponent(this.repoUrl)}`;
      this.ws = new WebSocket(wsUrl);

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
    this.send({
      type: "sync",
      daemonId: this.daemonId,
      items,
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
        daemonId: this.daemonId,
      });
    });
  }

  async scheduleClaim(taskId: string, scheduleTime: string): Promise<boolean> {
    if (!this.connected || !this.ws) return false;

    const requestId = randomUUID();
    const timeoutMs = this.deps.claimTimeoutMs ?? CLAIM_TIMEOUT_MS;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingScheduleClaims.delete(requestId);
        resolve(false);
      }, timeoutMs);

      this.pendingScheduleClaims.set(requestId, { resolve, timer });

      this.send({
        type: "schedule_claim",
        requestId,
        daemonId: this.daemonId,
        taskId,
        scheduleTime,
      });
    });
  }

  complete(todoId: string): void {
    this.send({
      type: "complete",
      todoId,
      daemonId: this.daemonId,
    });
  }

  report(event: string, todoPath: string, metadata: Record<string, unknown>): void {
    if (!this.telemetryEnabled) return;
    this.send({
      type: "report",
      daemonId: this.daemonId,
      event,
      todoPath,
      metadata,
    });
  }

  heartbeat(): void {
    this.send({
      type: "heartbeat",
      daemonId: this.daemonId,
      ts: new Date().toISOString(),
    });
  }

  disconnect(): void {
    this.disconnectedIntentionally = true;
    this.stopReconnectTimer();
    this.stopHeartbeatTimer();
    this.rejectAllPendingClaims();
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

  setTelemetry(enabled: boolean): void {
    this.telemetryEnabled = enabled;
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
          pending.resolve(data.todoId ?? null);
        }
        break;
      }

      case "schedule_claim_response": {
        const schedulePending = this.pendingScheduleClaims.get(data.requestId);
        if (schedulePending) {
          clearTimeout(schedulePending.timer);
          this.pendingScheduleClaims.delete(data.requestId);
          schedulePending.resolve(data.granted ?? false);
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
        this.crewStatus = {
          crewCode: data.crewCode ?? "",
          daemonCount: data.daemonCount ?? 0,
          availableCount: data.availableCount ?? 0,
          claimedCount: data.claimedCount ?? 0,
          completedCount: data.completedCount ?? 0,
          daemonNames: data.daemonNames ?? [],
          claimedItems: (data.claimedItems ?? [])
            .filter((c: { daemonId?: string }) => c.daemonId !== this.daemonId)
            .map((c: { id: string }) => c.id),
        };
        // Resolve connect promise -- crew_update is the first message for new daemons
        if (this.connectPromise) {
          this.connectPromise.resolve();
          this.connectPromise = null;
        }
        break;

      case "error":
        this.deps.log("error", `Crew server error: ${data.message}`);
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

    for (const [id, pending] of this.pendingScheduleClaims) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingScheduleClaims.clear();
  }
}
