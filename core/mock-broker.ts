// Mock localhost WebSocket broker for crew coordination.
// Runs in-process via Bun.serve(). Implements the full crew protocol:
// crew creation, WebSocket messaging, claim/sync/complete/heartbeat,
// author-based affinity scheduling, dependency filtering,
// disconnect/reconnect, and JSONL event logging.
//
// Author affinity rationale: AI agents do NOT carry persistent context between
// work items -- each session starts fresh. The benefit of author-based affinity
// is human steering: the person who authored work items can intervene, steer, and
// review more easily when those items run on their own machine. Affinity matches
// each item's author field against the requesting daemon's operatorId (the git
// email of the human running the daemon). This is a preference within session limits,
// not a hard rule. When no author-matched items are available, items overflow to
// any daemon (pool scheduling). Items with unresolved dependencies are filtered
// out before claim scheduling. Review jobs are local-only and do not participate
// in crew claim scheduling.

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
import { InMemoryBrokerStore, type BrokerSocket, type CrewState } from "./broker-store.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface BrokerOptions {
  /** Port to listen on (0 = random). */
  port?: number;
  /** Path to JSONL event log file. Defaults to .ninthwave/crew-events.jsonl */
  eventLogPath?: string;
  /** Heartbeat timeout in ms before marking a daemon as disconnected. Default: 90_000 */
  heartbeatTimeoutMs?: number;
  /** Grace period in ms after disconnect before releasing claimed work items. Default: 60_000 */
  gracePeriodMs?: number;
  /** Interval in ms for the heartbeat checker loop. Default: 1_000 */
  checkIntervalMs?: number;
}

export type { ScheduleClaimEntry, WorkEntry, DaemonState } from "./broker-store.ts";
export type { CrewEvent, CrewStatusUpdate } from "./broker-state.ts";

// ── Broker ──────────────────────────────────────────────────────────

export class MockBroker {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private store = new InMemoryBrokerStore();
  private eventLogPath: string;
  private heartbeatTimeoutMs: number;
  private gracePeriodMs: number;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /** Mapping from WebSocket to { crewCode, daemonId } for routing. */
  private wsMap = new Map<BrokerSocket, { crewCode: string; daemonId: string }>();

  constructor(private opts: BrokerOptions = {}) {
    this.eventLogPath = opts.eventLogPath ?? ".ninthwave/crew-events.jsonl";
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 90_000;
    this.gracePeriodMs = opts.gracePeriodMs ?? 60_000;
  }

  /** Start the broker. Returns the port it's listening on. */
  start(): number {
    const broker = this;

    this.server = Bun.serve({
      port: this.opts.port ?? 0,

      routes: {
        "/api/crews": {
          POST: async (req: Request) => {
            let requestedCode: string | undefined;
            try {
              const body = await req.json() as { code?: unknown };
              if (body && typeof body.code === "string" && body.code.length > 0) {
                requestedCode = body.code;
              }
            } catch { /* no body or malformed */ }
            const code = requestedCode && broker.store.hasCrew(requestedCode)
              ? requestedCode
              : broker.createCrew(requestedCode);
            return Response.json({ code }, { status: 201 });
          },
        },
      },

      fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket upgrade: /api/crews/:code/ws?daemonId=...&name=...
        const wsMatch = url.pathname.match(/^\/api\/crews\/([A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})\/ws$/);
        if (wsMatch) {
          const code = wsMatch[1]!;
          const daemonId = url.searchParams.get("daemonId");
          const name = url.searchParams.get("name");
          const operatorId = url.searchParams.get("operatorId") ?? "";

          if (!daemonId) {
            return new Response("Missing daemonId query param", { status: 400 });
          }

          const crew = broker.store.getCrew(code);
          if (!crew) {
            return new Response("Crew not found", { status: 404 });
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

  /** Stop the broker and clean up. */
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
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

  /** Get a crew by code. */
  getCrew(code: string): CrewState | undefined {
    return this.store.getCrew(code);
  }

  // ── Crew management ───────────────────────────────────────────────

  private createCrew(requestedCode?: string): string {
    const code = requestedCode ?? this.generateCode();
    this.store.createCrew(code);
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
  }

  private handleDaemonDisconnect(crewCode: string, daemonId: string): void {
    const crew = this.store.getCrew(crewCode);
    if (!crew) return;

    const result = disconnectDaemon(crew, daemonId);
    this.writeEvents(result.events);
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
  }

  private handleClaimRequest(crew: CrewState, daemonId: string, requestId: string, ws: BrokerSocket): void {
    const result = claimNextWorkItem(crew, daemonId);
    this.writeEvents(result.events);
    this.send(ws, { type: "claim_response", requestId, workItemId: result.workItemId });
    if (result.changed) {
      this.broadcastCrewUpdate(crew);
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
      // Swallow write errors in mock broker -- tests can check the log if needed
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
