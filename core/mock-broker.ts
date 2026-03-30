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
// email of the human running the daemon). This is a preference within WIP limits,
// not a hard rule. When no author-matched items are available, items overflow to
// any daemon (pool scheduling). Items with unresolved dependencies are filtered
// out before claim scheduling. Review jobs are local-only and do not participate
// in crew claim scheduling.

import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// ── Types ───────────────────────────────────────────────────────────

export interface BrokerOptions {
  /** Port to listen on (0 = random). */
  port?: number;
  /** Path to JSONL event log file. Defaults to .ninthwave/crew-events.jsonl */
  eventLogPath?: string;
  /** Heartbeat timeout in ms before marking a daemon as disconnected. Default: 90_000 */
  heartbeatTimeoutMs?: number;
  /** Grace period in ms after disconnect before releasing claimed TODOs. Default: 60_000 */
  gracePeriodMs?: number;
  /** Interval in ms for the heartbeat checker loop. Default: 1_000 */
  checkIntervalMs?: number;
}

export interface ScheduleClaimEntry {
  daemonId: string;
  expiresAt: number;
}

export interface CrewState {
  code: string;
  items: Map<string, WorkEntry>;
  daemons: Map<string, DaemonState>;
  /** Schedule claim deduplication: key = "taskId:scheduleTime" -> claim entry. */
  scheduleClaims: Map<string, ScheduleClaimEntry>;
}

export interface WorkEntry {
  path: string;
  priority: number; // lower = higher priority
  dependencies: string[]; // dependency IDs (from sync metadata)
  author: string; // git author email (from sync metadata)
  syncedAt: number;
  creatorDaemonId: string;
  claimedBy: string | null;
  completedBy: string | null;
}

export interface DaemonState {
  id: string;
  name: string;
  /** Operator identity (git email of the human running this daemon). */
  operatorId: string;
  ws: WebSocket | null;
  lastHeartbeat: number;
  disconnectedAt: number | null;
  claimedItems: Set<string>;
  /** True after grace period expired and TODOs were released. Prevents double-release. */
  released: boolean;
}

export interface CrewEvent {
  ts: string;
  crew_id: string;
  daemon_id: string;
  event: "claim" | "sync" | "complete" | "disconnect" | "reconnect" | "abandon" | "schedule_claim" | "report";
  todo_path: string;
  metadata: { affinity: "author" | "pool" } | Record<string, unknown>;
}

// ── Crew status type (shared with TUI) ─────────────────────────────

export interface CrewStatusUpdate {
  type: "crew_update";
  crewCode: string;
  daemonCount: number;
  availableCount: number;
  claimedCount: number;
  completedCount: number;
  daemonNames: string[];
  claimedItems: Array<{ id: string; daemonId: string }>;
}

// ── Message types ───────────────────────────────────────────────────
// Aligned with crew.ts ClientMessage / ServerMessage protocol.

type SyncItemPayload = {
  id: string;
  dependencies: string[];
  priority: number;
  author: string;
};

type InboundMessage =
  | { type: "sync"; daemonId: string; items: SyncItemPayload[] }
  | { type: "claim"; requestId: string; daemonId: string }
  | { type: "complete"; todoId: string; daemonId: string }
  | { type: "heartbeat"; daemonId: string; ts: string }
  | { type: "schedule_claim"; requestId: string; daemonId: string; taskId: string; scheduleTime: string };

type OutboundMessage =
  | { type: "sync_ack"; crewCode: string; todoIds: string[] }
  | { type: "claim_response"; requestId: string; todoId: string | null }
  | { type: "complete_ack"; todoId: string }
  | { type: "heartbeat_ack"; ts: string }
  | { type: "reconnect_state"; resumed: string[]; released: string[]; reclaimed: string[] }
  | { type: "schedule_claim_response"; requestId: string; taskId: string; granted: boolean }
  | CrewStatusUpdate
  | { type: "error"; message: string };

/** Default expiry for schedule claims: 30 minutes. */
const SCHEDULE_CLAIM_EXPIRY_MS = 30 * 60 * 1_000;

// ── Broker ──────────────────────────────────────────────────────────

export class MockBroker {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private crews = new Map<string, CrewState>();
  private eventLogPath: string;
  private heartbeatTimeoutMs: number;
  private gracePeriodMs: number;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /** Mapping from WebSocket to { crewCode, daemonId } for routing. */
  private wsMap = new Map<WebSocket, { crewCode: string; daemonId: string }>();

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
              const body = await req.json();
              if (body && typeof body.code === "string" && body.code.length > 0) {
                requestedCode = body.code;
              }
            } catch { /* no body or malformed */ }
            const code = requestedCode && broker.crews.has(requestedCode)
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

          const crew = broker.crews.get(code);
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

    return this.server.port;
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
    return this.crews.get(code);
  }

  // ── Crew management ───────────────────────────────────────────────

  private createCrew(requestedCode?: string): string {
    const code = requestedCode ?? this.generateCode();
    this.crews.set(code, {
      code,
      items: new Map(),
      daemons: new Map(),
      scheduleClaims: new Map(),
    });
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
    } while (this.crews.has(code));
    return code;
  }

  // ── Daemon lifecycle ──────────────────────────────────────────────

  private handleDaemonConnect(crewCode: string, daemonId: string, name: string, ws: WebSocket, operatorId: string = ""): void {
    const crew = this.crews.get(crewCode);
    if (!crew) return;

    const existing = crew.daemons.get(daemonId);
    if (existing) {
      // Reconnecting daemon
      const wasDisconnected = existing.disconnectedAt !== null || existing.released;
      existing.ws = ws;
      existing.lastHeartbeat = Date.now();
      existing.disconnectedAt = null;
      existing.released = false;
      existing.name = name;
      existing.operatorId = operatorId;

      if (wasDisconnected) {
        // Determine which TODOs are still claimed vs released/re-claimed
        const resumed: string[] = [];
        const released: string[] = [];
        const reclaimed: string[] = [];

        for (const todoPath of existing.claimedItems) {
          const todo = crew.items.get(todoPath);
          if (!todo) {
            released.push(todoPath);
            continue;
          }
          if (todo.claimedBy === daemonId) {
            resumed.push(todoPath);
          } else if (todo.claimedBy !== null) {
            reclaimed.push(todoPath);
          } else {
            released.push(todoPath);
          }
        }

        // Remove reclaimed and released from this daemon's claimed set
        for (const p of [...released, ...reclaimed]) {
          existing.claimedItems.delete(p);
        }

        this.logEvent(crewCode, daemonId, "reconnect", "", {});
        this.send(ws, {
          type: "reconnect_state",
          resumed,
          released,
          reclaimed,
        });
      }
    } else {
      // New daemon
      crew.daemons.set(daemonId, {
        id: daemonId,
        name,
        operatorId,
        ws,
        lastHeartbeat: Date.now(),
        disconnectedAt: null,
        claimedItems: new Set(),
        released: false,
      });
    }

    // Broadcast crew status to all connected daemons (including the new one)
    this.broadcastCrewUpdate(crew);
  }

  private handleDaemonDisconnect(crewCode: string, daemonId: string): void {
    const crew = this.crews.get(crewCode);
    if (!crew) return;

    const daemon = crew.daemons.get(daemonId);
    if (!daemon) return;

    daemon.ws = null;
    daemon.disconnectedAt = Date.now();
    this.logEvent(crewCode, daemonId, "disconnect", "", {});
  }

  // ── Message handling ──────────────────────────────────────────────

  private handleMessage(crewCode: string, daemonId: string, msg: InboundMessage, ws: WebSocket): void {
    const crew = this.crews.get(crewCode);
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
        this.handleComplete(crew, daemonId, msg.todoId, ws);
        break;
      case "schedule_claim":
        this.handleScheduleClaim(crew, daemonId, msg.requestId, msg.taskId, msg.scheduleTime, ws);
        break;
      case "heartbeat":
        daemon.lastHeartbeat = Date.now();
        this.send(ws, { type: "heartbeat_ack", ts: msg.ts });
        break;
      case "report":
        this.logEvent(crew.code, daemonId, "report", msg.todoPath ?? "", msg.metadata ?? {});
        this.send(ws, { type: "report_ack", event: msg.event });
        break;
    }
  }

  private handleSync(crew: CrewState, daemonId: string, items: SyncItemPayload[], ws: WebSocket): void {
    for (const item of items) {
      const existing = crew.items.get(item.id);
      if (existing) {
        // Idempotent upsert: update priority, dependencies, and author from latest sync
        existing.priority = item.priority;
        existing.dependencies = item.dependencies;
        existing.author = item.author;
      } else {
        crew.items.set(item.id, {
          path: item.id,
          priority: item.priority,
          dependencies: item.dependencies,
          author: item.author,
          syncedAt: Date.now(),
          creatorDaemonId: daemonId,
          claimedBy: null,
          completedBy: null,
        });
        this.logEvent(crew.code, daemonId, "sync", item.id, { affinity: "author" });
      }
    }
    // Respond with sync_ack containing all known todo IDs
    const allTodoIds = Array.from(crew.items.keys());
    this.send(ws, { type: "sync_ack", crewCode: crew.code, todoIds: allTodoIds });
    // Broadcast crew status after sync
    this.broadcastCrewUpdate(crew);
  }

  private handleClaimRequest(crew: CrewState, daemonId: string, requestId: string, ws: WebSocket): void {
    const daemon = crew.daemons.get(daemonId);
    if (!daemon) return;

    // Find available items: unclaimed, uncompleted, and all dependencies resolved.
    // A dependency is resolved when it either doesn't exist in the crew's items
    // map (external/previously completed) or exists with completedBy !== null.
    // This matches the orchestrator's semantics: untracked deps = satisfied.
    const available = Array.from(crew.items.values()).filter(
      (t) =>
        t.claimedBy === null &&
        t.completedBy === null &&
        t.dependencies.every((depId) => {
          const dep = crew.items.get(depId);
          return !dep || dep.completedBy !== null;
        }),
    );

    if (available.length === 0) {
      this.send(ws, { type: "claim_response", requestId, todoId: null });
      return;
    }

    // Sort: author affinity first (human steering preference), then priority
    // (lower = higher), then oldest first. Author affinity matches the requesting
    // daemon's operatorId against each item's author field.
    const operatorId = daemon.operatorId;
    available.sort((a, b) => {
      const aAuthor = operatorId !== "" && a.author === operatorId ? 0 : 1;
      const bAuthor = operatorId !== "" && b.author === operatorId ? 0 : 1;
      if (aAuthor !== bAuthor) return aAuthor - bAuthor;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.syncedAt - b.syncedAt;
    });

    const todo = available[0]!;
    todo.claimedBy = daemonId;
    daemon.claimedItems.add(todo.path);

    const affinity: "author" | "pool" =
      operatorId !== "" && todo.author === operatorId ? "author" : "pool";
    this.logEvent(crew.code, daemonId, "claim", todo.path, { affinity });
    this.send(ws, { type: "claim_response", requestId, todoId: todo.path });
    // Broadcast crew status after claim
    this.broadcastCrewUpdate(crew);
  }

  private handleComplete(crew: CrewState, daemonId: string, todoId: string, ws: WebSocket): void {
    const todo = crew.items.get(todoId);
    if (!todo || todo.claimedBy !== daemonId) {
      this.send(ws, { type: "error", message: `Cannot complete: ${todoId}` });
      return;
    }

    const daemon = crew.daemons.get(daemonId);
    if (daemon) {
      daemon.claimedItems.delete(todoId);
    }

    todo.completedBy = daemonId;
    todo.claimedBy = null;
    this.logEvent(crew.code, daemonId, "complete", todoId, {});
    this.send(ws, { type: "complete_ack", todoId });
    // Broadcast crew status after completion
    this.broadcastCrewUpdate(crew);
  }

  // ── Schedule claim handling ───────────────────────────────────────

  private handleScheduleClaim(
    crew: CrewState,
    daemonId: string,
    requestId: string,
    taskId: string,
    scheduleTime: string,
    ws: WebSocket,
  ): void {
    const key = `${taskId}:${scheduleTime}`;
    const now = Date.now();
    const existing = crew.scheduleClaims.get(key);

    if (existing && existing.expiresAt > now) {
      // Already claimed and not expired -- deny
      this.logEvent(crew.code, daemonId, "schedule_claim", taskId, { granted: false, key });
      this.send(ws, { type: "schedule_claim_response", requestId, taskId, granted: false });
      return;
    }

    // Grant the claim: first-to-arrive wins (sequential message processing).
    crew.scheduleClaims.set(key, {
      daemonId,
      expiresAt: now + SCHEDULE_CLAIM_EXPIRY_MS,
    });
    this.logEvent(crew.code, daemonId, "schedule_claim", taskId, { granted: true, key });
    this.send(ws, { type: "schedule_claim_response", requestId, taskId, granted: true });
  }

  // ── Heartbeat monitoring ──────────────────────────────────────────

  private checkHeartbeats(): void {
    const now = Date.now();

    for (const crew of this.crews.values()) {
      // Cleanup expired schedule claims
      for (const [key, entry] of crew.scheduleClaims) {
        if (now >= entry.expiresAt) {
          crew.scheduleClaims.delete(key);
        }
      }

      for (const daemon of crew.daemons.values()) {
        // Check for heartbeat timeout on connected daemons
        if (daemon.ws !== null && now - daemon.lastHeartbeat > this.heartbeatTimeoutMs) {
          daemon.ws = null;
          daemon.disconnectedAt = now;
          this.logEvent(crew.code, daemon.id, "disconnect", "", {});
        }

        // Check for grace period expiry on disconnected daemons (only release once)
        if (
          daemon.disconnectedAt !== null &&
          daemon.ws === null &&
          !daemon.released &&
          now - daemon.disconnectedAt > this.gracePeriodMs
        ) {
          this.releaseDaemonTodos(crew, daemon);
          daemon.released = true;
        }
      }
    }
  }

  private releaseDaemonTodos(crew: CrewState, daemon: DaemonState): void {
    for (const todoPath of daemon.claimedItems) {
      const todo = crew.items.get(todoPath);
      if (todo && todo.claimedBy === daemon.id) {
        todo.claimedBy = null;
        this.logEvent(crew.code, daemon.id, "abandon", todoPath, {});
      }
    }
    // Don't clear claimedItems here -- the reconnect handler needs it
    // to build the reconnect_state message. It will clean up the set.
  }

  // ── Crew status broadcast ─────────────────────────────────────────

  /** Broadcast crew status update to all connected daemons in the crew. */
  private broadcastCrewUpdate(crew: CrewState): void {
    const todos = Array.from(crew.items.values());
    const availableCount = todos.filter(
      (t) =>
        t.claimedBy === null &&
        t.completedBy === null &&
        t.dependencies.every((depId) => {
          const dep = crew.items.get(depId);
          return !dep || dep.completedBy !== null;
        }),
    ).length;
    const claimedCount = todos.filter((t) => t.claimedBy !== null).length;
    const completedCount = todos.filter((t) => t.completedBy !== null).length;
    const connectedDaemons = Array.from(crew.daemons.values()).filter((d) => d.ws !== null);
    const daemonNames = connectedDaemons.map((d) => d.name);

    // Build claimed items list for cross-daemon visibility
    const claimedItems = todos
      .filter((t) => t.claimedBy !== null && t.completedBy === null)
      .map((t) => ({ id: t.path, daemonId: t.claimedBy! }));

    const update: CrewStatusUpdate = {
      type: "crew_update",
      crewCode: crew.code,
      daemonCount: connectedDaemons.length,
      availableCount,
      claimedCount,
      completedCount,
      daemonNames,
      claimedItems,
    };

    for (const daemon of connectedDaemons) {
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
    todoPath: string,
    metadata: Record<string, unknown>,
  ): void {
    const entry: CrewEvent = {
      ts: new Date().toISOString(),
      crew_id: crewId,
      daemon_id: daemonId,
      event,
      todo_path: todoPath,
      metadata: metadata as CrewEvent["metadata"],
    };

    try {
      mkdirSync(dirname(this.eventLogPath), { recursive: true });
      appendFileSync(this.eventLogPath, JSON.stringify(entry) + "\n");
    } catch {
      // Swallow write errors in mock broker -- tests can check the log if needed
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private send(ws: WebSocket, msg: OutboundMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Swallow send errors -- client may have disconnected
    }
  }
}
