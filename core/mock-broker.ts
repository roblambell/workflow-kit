// Mock localhost WebSocket broker for crew coordination.
// Runs in-process via Bun.serve(). Implements the full crew protocol:
// crew creation, WebSocket messaging, claim/sync/complete/heartbeat,
// creator affinity scheduling, disconnect/reconnect, and JSONL event logging.

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

export interface CrewState {
  code: string;
  todos: Map<string, TodoEntry>;
  daemons: Map<string, DaemonState>;
}

export interface TodoEntry {
  path: string;
  priority: number; // lower = higher priority
  syncedAt: number;
  creatorDaemonId: string;
  claimedBy: string | null;
  completedBy: string | null;
}

export interface DaemonState {
  id: string;
  name: string;
  ws: WebSocket | null;
  lastHeartbeat: number;
  disconnectedAt: number | null;
  claimedTodos: Set<string>;
  /** True after grace period expired and TODOs were released. Prevents double-release. */
  released: boolean;
}

export interface CrewEvent {
  ts: string;
  crew_id: string;
  daemon_id: string;
  event: "claim" | "sync" | "complete" | "disconnect" | "reconnect" | "abandon";
  todo_path: string;
  metadata: { affinity: "creator" | "pool" } | Record<string, unknown>;
}

// ── Message types ───────────────────────────────────────────────────

type InboundMessage =
  | { type: "sync"; todos: { path: string; priority: number }[] }
  | { type: "claim_request" }
  | { type: "complete"; todoPath: string }
  | { type: "heartbeat" };

type OutboundMessage =
  | { type: "claimed"; todoPath: string; affinity: "creator" | "pool" }
  | { type: "no_work" }
  | { type: "complete_ack"; todoPath: string }
  | { type: "reconnect_state"; claimed: string[]; released: string[]; reClaimed: string[] }
  | { type: "error"; message: string };

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
          POST: (_req: Request) => {
            const code = broker.createCrew();
            return Response.json({ code }, { status: 201 });
          },
        },
      },

      fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket upgrade: /api/crews/:code/ws?daemonId=...&name=...
        const wsMatch = url.pathname.match(/^\/api\/crews\/([A-Za-z0-9]{3}-[A-Za-z0-9]{3})\/ws$/);
        if (wsMatch) {
          const code = wsMatch[1]!;
          const daemonId = url.searchParams.get("daemonId");
          const name = url.searchParams.get("name");

          if (!daemonId || !name) {
            return new Response("Missing daemonId or name query params", { status: 400 });
          }

          const crew = broker.crews.get(code);
          if (!crew) {
            return new Response("Crew not found", { status: 404 });
          }

          const upgraded = server.upgrade(req, {
            data: { crewCode: code, daemonId, name },
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
          const { crewCode, daemonId, name } = ws.data as {
            crewCode: string;
            daemonId: string;
            name: string;
          };

          broker.wsMap.set(ws, { crewCode, daemonId });
          broker.handleDaemonConnect(crewCode, daemonId, name, ws);
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

  private createCrew(): string {
    const code = this.generateCode();
    this.crews.set(code, {
      code,
      todos: new Map(),
      daemons: new Map(),
    });
    return code;
  }

  private generateCode(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let code: string;
    do {
      const part1 = Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
      const part2 = Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
      code = `${part1}-${part2}`;
    } while (this.crews.has(code));
    return code;
  }

  // ── Daemon lifecycle ──────────────────────────────────────────────

  private handleDaemonConnect(crewCode: string, daemonId: string, name: string, ws: WebSocket): void {
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

      if (wasDisconnected) {
        // Determine which TODOs are still claimed vs released/re-claimed
        const stillClaimed: string[] = [];
        const released: string[] = [];
        const reClaimed: string[] = [];

        for (const todoPath of existing.claimedTodos) {
          const todo = crew.todos.get(todoPath);
          if (!todo) {
            released.push(todoPath);
            continue;
          }
          if (todo.claimedBy === daemonId) {
            stillClaimed.push(todoPath);
          } else if (todo.claimedBy !== null) {
            reClaimed.push(todoPath);
          } else {
            released.push(todoPath);
          }
        }

        // Remove re-claimed and released from this daemon's claimed set
        for (const p of [...released, ...reClaimed]) {
          existing.claimedTodos.delete(p);
        }

        this.logEvent(crewCode, daemonId, "reconnect", "", {});
        this.send(ws, {
          type: "reconnect_state",
          claimed: stillClaimed,
          released,
          reClaimed,
        });
      }
    } else {
      // New daemon
      crew.daemons.set(daemonId, {
        id: daemonId,
        name,
        ws,
        lastHeartbeat: Date.now(),
        disconnectedAt: null,
        claimedTodos: new Set(),
        released: false,
      });
    }
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
        this.handleSync(crew, daemonId, msg.todos);
        break;
      case "claim_request":
        this.handleClaimRequest(crew, daemonId, ws);
        break;
      case "complete":
        this.handleComplete(crew, daemonId, msg.todoPath, ws);
        break;
      case "heartbeat":
        daemon.lastHeartbeat = Date.now();
        break;
    }
  }

  private handleSync(crew: CrewState, daemonId: string, todos: { path: string; priority: number }[]): void {
    for (const t of todos) {
      if (!crew.todos.has(t.path)) {
        crew.todos.set(t.path, {
          path: t.path,
          priority: t.priority,
          syncedAt: Date.now(),
          creatorDaemonId: daemonId,
          claimedBy: null,
          completedBy: null,
        });
        this.logEvent(crew.code, daemonId, "sync", t.path, { affinity: "creator" });
      }
    }
  }

  private handleClaimRequest(crew: CrewState, daemonId: string, ws: WebSocket): void {
    const daemon = crew.daemons.get(daemonId);
    if (!daemon) return;

    // Find the best available TODO for this daemon using creator affinity scheduling
    const available = Array.from(crew.todos.values()).filter(
      (t) => t.claimedBy === null && t.completedBy === null,
    );

    if (available.length === 0) {
      this.send(ws, { type: "no_work" });
      return;
    }

    // Sort: creator affinity first, then priority (lower = higher), then oldest first
    available.sort((a, b) => {
      const aCreator = a.creatorDaemonId === daemonId ? 0 : 1;
      const bCreator = b.creatorDaemonId === daemonId ? 0 : 1;
      if (aCreator !== bCreator) return aCreator - bCreator;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.syncedAt - b.syncedAt;
    });

    const todo = available[0]!;
    todo.claimedBy = daemonId;
    daemon.claimedTodos.add(todo.path);

    const affinity: "creator" | "pool" = todo.creatorDaemonId === daemonId ? "creator" : "pool";
    this.logEvent(crew.code, daemonId, "claim", todo.path, { affinity });
    this.send(ws, { type: "claimed", todoPath: todo.path, affinity });
  }

  private handleComplete(crew: CrewState, daemonId: string, todoPath: string, ws: WebSocket): void {
    const todo = crew.todos.get(todoPath);
    if (!todo || todo.claimedBy !== daemonId) {
      this.send(ws, { type: "error", message: `Cannot complete: ${todoPath}` });
      return;
    }

    const daemon = crew.daemons.get(daemonId);
    if (daemon) {
      daemon.claimedTodos.delete(todoPath);
    }

    todo.completedBy = daemonId;
    todo.claimedBy = null;
    this.logEvent(crew.code, daemonId, "complete", todoPath, {});
    this.send(ws, { type: "complete_ack", todoPath });
  }

  // ── Heartbeat monitoring ──────────────────────────────────────────

  private checkHeartbeats(): void {
    const now = Date.now();

    for (const crew of this.crews.values()) {
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
    for (const todoPath of daemon.claimedTodos) {
      const todo = crew.todos.get(todoPath);
      if (todo && todo.claimedBy === daemon.id) {
        todo.claimedBy = null;
        this.logEvent(crew.code, daemon.id, "abandon", todoPath, {});
      }
    }
    // Don't clear claimedTodos here — the reconnect handler needs it
    // to build the reconnect_state message. It will clean up the set.
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
      // Swallow write errors in mock broker — tests can check the log if needed
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private send(ws: WebSocket, msg: OutboundMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Swallow send errors — client may have disconnected
    }
  }
}
