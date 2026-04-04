// Persistent self-hosted broker server runtime.
// Runs a Bun HTTP+WebSocket server on top of the shared broker core
// with file-backed persistence and repo-reference enforcement.

import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { ClientMessage as InboundMessage, ServerMessage as OutboundMessage, SyncItem as SyncItemPayload } from "./crew.ts";
import {
  buildCrewStatusUpdate,
  checkCrewHeartbeats,
  claimNextWorkItem,
  claimScheduleSlot,
  completeWorkItem,
  connectDaemon,
  disconnectDaemon,
  recordHeartbeat,
  syncCrewItems,
  type CrewEvent,
  type CrewStatusUpdate,
  DEFAULT_SCHEDULE_CLAIM_EXPIRY_MS,
} from "./broker-state.ts";
import { FileBrokerStore, type BrokerSocket, type CrewState } from "./broker-store.ts";
import { resolveRepoRef, type RepoRefInput } from "./repo-ref.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface BrokerServerOptions {
  /** Hostname/IP to bind to (default: "0.0.0.0"). */
  hostname?: string;
  /** Port to listen on (0 = random). */
  port?: number;
  /** Directory for crew state persistence files. */
  dataDir: string;
  /** Path to JSONL event log file. Defaults to .ninthwave/crew-events.jsonl */
  eventLogPath?: string;
  /** Heartbeat timeout in ms before marking a daemon as disconnected. Default: 90_000 */
  heartbeatTimeoutMs?: number;
  /** Grace period in ms after disconnect before releasing claimed work items. Default: 60_000 */
  gracePeriodMs?: number;
  /** Interval in ms for the heartbeat checker loop. Default: 1_000 */
  checkIntervalMs?: number;
}

// ── Broker Server ──────────────────────────────────────────────────

export class BrokerServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private store: FileBrokerStore;
  private eventLogPath: string;
  private heartbeatTimeoutMs: number;
  private gracePeriodMs: number;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /** Mapping from WebSocket to { crewCode, daemonId } for routing. */
  private wsMap = new Map<BrokerSocket, { crewCode: string; daemonId: string }>();

  constructor(private opts: BrokerServerOptions) {
    this.store = new FileBrokerStore(opts.dataDir);
    this.eventLogPath = opts.eventLogPath ?? ".ninthwave/crew-events.jsonl";
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 90_000;
    this.gracePeriodMs = opts.gracePeriodMs ?? 60_000;
  }

  /** Start the broker server. Returns the port it's listening on. */
  start(): number {
    const broker = this;

    this.server = Bun.serve({
      hostname: this.opts.hostname ?? "0.0.0.0",
      port: this.opts.port ?? 0,

      routes: {
        "/api/crews": {
          POST: async (req: Request) => {
            let requestedCode: string | undefined;
            let repoRefInput: RepoRefInput | undefined;
            try {
              const body = await req.json() as Record<string, unknown>;
              if (body && typeof body.code === "string" && body.code.length > 0) {
                requestedCode = body.code;
              }
              if (body) {
                const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : undefined;
                const repoHash = typeof body.repoHash === "string" ? body.repoHash : undefined;
                const repoRef = typeof body.repoRef === "string" ? body.repoRef : undefined;
                if (repoUrl || repoHash || repoRef) {
                  repoRefInput = { repoUrl, repoHash, repoRef };
                }
              }
            } catch { /* no body or malformed */ }

            let resolvedRepoRef: string | null = null;
            if (repoRefInput) {
              try {
                resolvedRepoRef = resolveRepoRef(repoRefInput).repoRef;
              } catch {
                return Response.json(
                  { error: "Invalid repo reference" },
                  { status: 400 },
                );
              }
            }

            const code = requestedCode && broker.store.hasCrew(requestedCode)
              ? requestedCode
              : broker.createCrew(requestedCode, resolvedRepoRef);
            return Response.json({ code }, { status: 201 });
          },
        },
      },

      fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket upgrade: /api/crews/:code/ws?daemonId=...&name=...&operatorId=...
        const wsMatch = url.pathname.match(/^\/api\/crews\/([A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})\/ws$/);
        if (wsMatch) {
          const code = wsMatch[1]!;
          const daemonId = url.searchParams.get("daemonId");
          const name = url.searchParams.get("name");
          const operatorId = url.searchParams.get("operatorId") ?? "";
          const repoUrl = url.searchParams.get("repoUrl") ?? "";
          const repoHash = url.searchParams.get("repoHash") ?? "";

          if (!daemonId) {
            return new Response("Missing daemonId query param", { status: 400 });
          }

          const crew = broker.store.getCrew(code);
          if (!crew) {
            return new Response("Crew not found", { status: 404 });
          }

          // Enforce repo-reference matching
          if (crew.repoRef && (repoUrl || repoHash)) {
            try {
              const input: RepoRefInput = {};
              if (repoUrl) input.repoUrl = repoUrl;
              if (repoHash) input.repoHash = repoHash;
              const daemonRef = resolveRepoRef(input).repoRef;
              if (daemonRef !== crew.repoRef) {
                return new Response("Repo mismatch: daemon repo does not match crew", { status: 403 });
              }
            } catch {
              return new Response("Invalid repo reference on join", { status: 400 });
            }
          }

          const upgraded = server.upgrade(req, {
            data: { crewCode: code, daemonId, name: name ?? daemonId, operatorId },
          });

          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 500 });
          }

          return undefined;
        }

        return new Response("Not found", { status: 404 });
      },

      websocket: {
        open(ws) {
          const { crewCode, daemonId, name, operatorId } = ws.data as {
            crewCode: string;
            daemonId: string;
            name: string;
            operatorId: string;
          };

          broker.wsMap.set(ws, { crewCode, daemonId });
          broker.handleDaemonConnect(crewCode, daemonId, name, ws, operatorId);
        },

        message(ws, message) {
          const info = broker.wsMap.get(ws);
          if (!info) return;

          try {
            const msg = JSON.parse(String(message)) as InboundMessage;
            broker.handleMessage(info.crewCode, info.daemonId, msg, ws);
          } catch {
            broker.send(ws, { type: "error", message: "Invalid JSON" });
          }
        },

        close(ws) {
          const info = broker.wsMap.get(ws);
          if (info) {
            broker.handleDaemonDisconnect(info.crewCode, info.daemonId);
            broker.wsMap.delete(ws);
          }
        },
      },
    });

    // Start periodic heartbeat checker
    this.heartbeatInterval = setInterval(() => {
      this.checkHeartbeats();
    }, this.opts.checkIntervalMs ?? 1_000);

    return this.server?.port ?? 0;
  }

  /** Stop the broker server and persist state. */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.store.saveAll();
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
    this.wsMap.clear();
  }

  /** Get the port the server is listening on. */
  get port(): number {
    return this.server?.port ?? 0;
  }

  /** Get the hostname the server is bound to. */
  get hostname(): string {
    return this.server?.hostname ?? this.opts.hostname ?? "0.0.0.0";
  }

  /** Get a crew by code (for testing). */
  getCrew(code: string): CrewState | undefined {
    return this.store.getCrew(code);
  }

  /** Get the underlying store (for testing). */
  getStore(): FileBrokerStore {
    return this.store;
  }

  // ── Crew management ───────────────────────────────────────────────

  private createCrew(requestedCode?: string, repoRef?: string | null): string {
    const code = requestedCode ?? this.generateCode();
    this.store.createCrew(code, repoRef);
    return code;
  }

  private generateCode(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code: string;
    do {
      const parts = Array.from({ length: 4 }, () =>
        Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""),
      );
      code = parts.join("-");
    } while (this.store.hasCrew(code));
    return code;
  }

  // ── Daemon lifecycle ──────────────────────────────────────────────

  private handleDaemonConnect(crewCode: string, daemonId: string, name: string, ws: BrokerSocket, operatorId: string = ""): void {
    const crew = this.store.getCrew(crewCode);
    if (!crew) return;

    const result = connectDaemon(crew, daemonId, name, ws, operatorId);
    this.writeEvents(result.events);
    if (result.reconnectState) {
      this.send(ws, result.reconnectState);
    }
    this.broadcastCrewUpdate(crew);
    this.persistCrew(crew);
  }

  private handleDaemonDisconnect(crewCode: string, daemonId: string): void {
    const crew = this.store.getCrew(crewCode);
    if (!crew) return;

    const result = disconnectDaemon(crew, daemonId);
    this.writeEvents(result.events);
    if (result.changed) {
      this.persistCrew(crew);
    }
  }

  // ── Message handling ──────────────────────────────────────────────

  private handleMessage(crewCode: string, daemonId: string, msg: InboundMessage, ws: BrokerSocket): void {
    const crew = this.store.getCrew(crewCode);
    if (!crew) return;

    const daemon = crew.daemons.get(daemonId);
    if (!daemon) return;

    switch (msg.type) {
      case "sync":
        this.handleSync(crew, daemonId, msg.items, ws);
        break;
      case "claim":
        this.handleClaimRequest(crew, daemonId, msg.requestId, ws);
        break;
      case "complete":
        this.handleComplete(crew, daemonId, msg.workItemId, ws);
        break;
      case "schedule_claim":
        this.handleScheduleClaim(crew, daemonId, msg.requestId, msg.taskId, msg.scheduleTime, ws);
        break;
      case "heartbeat":
        recordHeartbeat(crew, daemonId);
        this.send(ws, { type: "heartbeat_ack", ts: msg.ts });
        break;
      case "report":
        this.logEvent(crew.code, daemonId, "report", msg.workItemPath ?? "", msg.metadata ?? {});
        this.send(ws, { type: "report_ack", event: msg.event });
        break;
    }
  }

  private handleSync(crew: CrewState, daemonId: string, items: SyncItemPayload[], ws: BrokerSocket): void {
    const result = syncCrewItems(crew, daemonId, items);
    this.writeEvents(result.events);
    this.send(ws, { type: "sync_ack", crewCode: crew.code, workItemIds: result.workItemIds });
    this.broadcastCrewUpdate(crew);
    this.persistCrew(crew);
  }

  private handleClaimRequest(crew: CrewState, daemonId: string, requestId: string, ws: BrokerSocket): void {
    const result = claimNextWorkItem(crew, daemonId);
    this.writeEvents(result.events);
    this.send(ws, { type: "claim_response", requestId, workItemId: result.workItemId });
    if (result.changed) {
      this.broadcastCrewUpdate(crew);
      this.persistCrew(crew);
    }
  }

  private handleComplete(crew: CrewState, daemonId: string, workItemId: string, ws: BrokerSocket): void {
    const result = completeWorkItem(crew, daemonId, workItemId);
    if (!result.ok) {
      this.send(ws, { type: "error", message: result.error ?? `Cannot complete: ${workItemId}` });
      return;
    }

    this.writeEvents(result.events);
    this.send(ws, { type: "complete_ack", workItemId });
    this.broadcastCrewUpdate(crew);
    this.persistCrew(crew);
  }

  // ── Schedule claim handling ───────────────────────────────────────

  private handleScheduleClaim(
    crew: CrewState,
    daemonId: string,
    requestId: string,
    taskId: string,
    scheduleTime: string,
    ws: BrokerSocket,
  ): void {
    const result = claimScheduleSlot(crew, daemonId, taskId, scheduleTime, Date.now(), DEFAULT_SCHEDULE_CLAIM_EXPIRY_MS);
    this.writeEvents(result.events);
    this.send(ws, { type: "schedule_claim_response", requestId, taskId, granted: result.granted });
    if (result.changed) {
      this.persistCrew(crew);
    }
  }

  // ── Heartbeat monitoring ──────────────────────────────────────────

  private checkHeartbeats(): void {
    const now = Date.now();

    for (const crew of this.store.listCrews()) {
      const result = checkCrewHeartbeats(crew, {
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
        gracePeriodMs: this.gracePeriodMs,
      }, now);
      this.writeEvents(result.events);
      if (result.changed) {
        this.broadcastCrewUpdate(crew);
        this.persistCrew(crew);
      }
    }
  }

  // ── Crew status broadcast ─────────────────────────────────────────

  /** Broadcast crew status update to all connected daemons in the crew. */
  private broadcastCrewUpdate(crew: CrewState): void {
    const update: CrewStatusUpdate = buildCrewStatusUpdate(crew);
    for (const daemon of crew.daemons.values()) {
      if (daemon.ws) {
        this.send(daemon.ws, update);
      }
    }
  }

  // ── Persistence ───────────────────────────────────────────────────

  private persistCrew(crew: CrewState): void {
    this.store.saveCrew(crew);
  }

  // ── Event logging ─────────────────────────────────────────────────

  private logEvent(
    crewId: string,
    daemonId: string,
    event: CrewEvent["event"],
    workItemPath: string,
    metadata: Record<string, unknown>,
  ): void {
    const entry: CrewEvent = {
      ts: new Date().toISOString(),
      crew_id: crewId,
      daemon_id: daemonId,
      event,
      work_item_path: workItemPath,
      metadata: metadata as CrewEvent["metadata"],
    };

    try {
      mkdirSync(dirname(this.eventLogPath), { recursive: true });
      appendFileSync(this.eventLogPath, JSON.stringify(entry) + "\n");
    } catch {
      // Swallow write errors -- logging is best-effort
    }
  }

  private writeEvents(events: CrewEvent[]): void {
    for (const event of events) {
      this.logEvent(event.crew_id, event.daemon_id, event.event, event.work_item_path, event.metadata);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private send(ws: BrokerSocket, msg: OutboundMessage | CrewStatusUpdate): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Swallow send errors -- client may have disconnected
    }
  }
}
