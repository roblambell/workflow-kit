// Shared crew broker state and persistence interfaces.

import type { ServerWebSocket } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

export type BrokerSocket = ServerWebSocket<unknown> | Pick<WebSocket, "send">;

export interface ScheduleClaimEntry {
  daemonId: string;
  expiresAt: number;
}

export interface WorkEntry {
  path: string;
  priority: number;
  dependencies: string[];
  author: string;
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
  ws: BrokerSocket | null;
  lastHeartbeat: number;
  disconnectedAt: number | null;
  claimedItems: Set<string>;
  /** True after grace period expired and work items were released. Prevents double-release. */
  released: boolean;
}

export interface CrewState {
  code: string;
  /** Repo-reference hash that all daemons in this crew must match. */
  repoRef: string | null;
  items: Map<string, WorkEntry>;
  daemons: Map<string, DaemonState>;
  /** Schedule claim deduplication: key = "taskId:scheduleTime" -> claim entry. */
  scheduleClaims: Map<string, ScheduleClaimEntry>;
}

export interface BrokerStore {
  hasCrew(code: string): boolean;
  getCrew(code: string): CrewState | undefined;
  createCrew(code: string, repoRef?: string | null): CrewState;
  listCrews(): Iterable<CrewState>;
}

export function createCrewState(code: string, repoRef?: string | null): CrewState {
  return {
    code,
    repoRef: repoRef ?? null,
    items: new Map(),
    daemons: new Map(),
    scheduleClaims: new Map(),
  };
}

export class InMemoryBrokerStore implements BrokerStore {
  private crews = new Map<string, CrewState>();

  hasCrew(code: string): boolean {
    return this.crews.has(code);
  }

  getCrew(code: string): CrewState | undefined {
    return this.crews.get(code);
  }

  createCrew(code: string, repoRef?: string | null): CrewState {
    const existing = this.crews.get(code);
    if (existing) return existing;

    const crew = createCrewState(code, repoRef);
    this.crews.set(code, crew);
    return crew;
  }

  listCrews(): Iterable<CrewState> {
    return this.crews.values();
  }
}

// ── Serialization helpers ─────────────────────────────────────────

interface SerializedWorkEntry {
  path: string;
  priority: number;
  dependencies: string[];
  author: string;
  syncedAt: number;
  creatorDaemonId: string;
  claimedBy: string | null;
  completedBy: string | null;
}

interface SerializedDaemonState {
  id: string;
  name: string;
  operatorId: string;
  lastHeartbeat: number;
  disconnectedAt: number | null;
  claimedItems: string[];
  released: boolean;
}

interface SerializedScheduleClaim {
  key: string;
  daemonId: string;
  expiresAt: number;
}

interface SerializedCrewState {
  code: string;
  repoRef: string | null;
  items: SerializedWorkEntry[];
  daemons: SerializedDaemonState[];
  scheduleClaims: SerializedScheduleClaim[];
}

function serializeCrewState(crew: CrewState): SerializedCrewState {
  return {
    code: crew.code,
    repoRef: crew.repoRef,
    items: Array.from(crew.items.values()),
    daemons: Array.from(crew.daemons.values()).map((d) => ({
      id: d.id,
      name: d.name,
      operatorId: d.operatorId,
      lastHeartbeat: d.lastHeartbeat,
      disconnectedAt: d.disconnectedAt,
      claimedItems: Array.from(d.claimedItems),
      released: d.released,
    })),
    scheduleClaims: Array.from(crew.scheduleClaims.entries()).map(([key, entry]) => ({
      key,
      ...entry,
    })),
  };
}

function deserializeCrewState(data: SerializedCrewState): CrewState {
  const items = new Map<string, WorkEntry>();
  for (const item of data.items) {
    items.set(item.path, item);
  }

  const daemons = new Map<string, DaemonState>();
  for (const d of data.daemons) {
    daemons.set(d.id, {
      id: d.id,
      name: d.name,
      operatorId: d.operatorId,
      ws: null,
      lastHeartbeat: d.lastHeartbeat,
      disconnectedAt: d.disconnectedAt,
      claimedItems: new Set(d.claimedItems),
      released: d.released,
    });
  }

  const scheduleClaims = new Map<string, ScheduleClaimEntry>();
  for (const claim of data.scheduleClaims) {
    scheduleClaims.set(claim.key, {
      daemonId: claim.daemonId,
      expiresAt: claim.expiresAt,
    });
  }

  return {
    code: data.code,
    repoRef: data.repoRef ?? null,
    items,
    daemons,
    scheduleClaims,
  };
}

// ── File-backed store ─────────────────────────────────────────────

/**
 * Persistent BrokerStore backed by JSON files on disk.
 *
 * Each crew is stored as a separate JSON file: `<dataDir>/<code>.json`.
 * Load reads all files on construction; save writes the crew file atomically.
 */
export class FileBrokerStore implements BrokerStore {
  private crews = new Map<string, CrewState>();
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.loadAll();
  }

  hasCrew(code: string): boolean {
    return this.crews.has(code);
  }

  getCrew(code: string): CrewState | undefined {
    return this.crews.get(code);
  }

  createCrew(code: string, repoRef?: string | null): CrewState {
    const existing = this.crews.get(code);
    if (existing) return existing;

    const crew = createCrewState(code, repoRef);
    this.crews.set(code, crew);
    this.saveCrew(crew);
    return crew;
  }

  listCrews(): Iterable<CrewState> {
    return this.crews.values();
  }

  /** Persist crew state to disk. Call after state mutations. */
  saveCrew(crew: CrewState): void {
    const filePath = join(this.dataDir, `${crew.code}.json`);
    const data = serializeCrewState(crew);
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  /** Save all crews to disk. */
  saveAll(): void {
    for (const crew of this.crews.values()) {
      this.saveCrew(crew);
    }
  }

  /** Remove a crew from memory and disk. */
  removeCrew(code: string): void {
    this.crews.delete(code);
    const filePath = join(this.dataDir, `${code}.json`);
    if (existsSync(filePath)) {
      rmSync(filePath);
    }
  }

  /** Load all crew files from disk into memory. */
  private loadAll(): void {
    if (!existsSync(this.dataDir)) return;

    const files = readdirSync(this.dataDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.dataDir, file), "utf-8");
        const data = JSON.parse(raw) as SerializedCrewState;
        const crew = deserializeCrewState(data);
        this.crews.set(crew.code, crew);
      } catch {
        // Skip corrupt files -- they'll be overwritten on next save
      }
    }
  }
}
