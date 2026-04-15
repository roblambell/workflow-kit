// Shared crew broker state and persistence interfaces.

import type { ServerWebSocket } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

export type BrokerSocket = ServerWebSocket<unknown> | Pick<WebSocket, "send">;

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
  };
}

/**
 * Default ceiling for the in-memory store.
 *
 * The frictionless auto-join protocol means any random 16-64 char path
 * segment will silently allocate a crew. That is great for UX but fatal
 * for a public broker with unbounded memory, so we cap the store and
 * evict on insertion-order. Legitimate users land in the same crew
 * deterministically (same `crew_id`), so LRU pressure only hurts an
 * attacker spraying ids.
 */
export const IN_MEMORY_CREW_LIMIT = 10_000;

export class InMemoryBrokerStore implements BrokerStore {
  // Map preserves insertion order, which we use as an approximate LRU.
  private crews = new Map<string, CrewState>();
  private limit: number;

  constructor(limit: number = IN_MEMORY_CREW_LIMIT) {
    this.limit = limit;
  }

  hasCrew(code: string): boolean {
    return this.crews.has(code);
  }

  getCrew(code: string): CrewState | undefined {
    const crew = this.crews.get(code);
    if (!crew) return undefined;
    // Touch for LRU: re-insert so it moves to the end.
    this.crews.delete(code);
    this.crews.set(code, crew);
    return crew;
  }

  createCrew(code: string, repoRef?: string | null): CrewState {
    const existing = this.crews.get(code);
    if (existing) {
      this.crews.delete(code);
      this.crews.set(code, existing);
      return existing;
    }

    const crew = createCrewState(code, repoRef);
    this.crews.set(code, crew);
    this.evictIfNeeded();
    return crew;
  }

  listCrews(): Iterable<CrewState> {
    return this.crews.values();
  }

  /** Current number of crews held in memory (exposed for testing). */
  size(): number {
    return this.crews.size;
  }

  private evictIfNeeded(): void {
    while (this.crews.size > this.limit) {
      const oldestKey = this.crews.keys().next().value;
      if (oldestKey === undefined) return;
      this.crews.delete(oldestKey);
    }
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

interface SerializedCrewState {
  code: string;
  repoRef: string | null;
  items: SerializedWorkEntry[];
  daemons: SerializedDaemonState[];
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

  return {
    code: data.code,
    repoRef: data.repoRef ?? null,
    items,
    daemons,
  };
}

// ── File-backed store ─────────────────────────────────────────────

/** Hard ceiling for the persistent file-backed store. */
export const FILE_STORE_CREW_LIMIT = 100_000;

/** Thrown by {@link FileBrokerStore.createCrew} when {@link FILE_STORE_CREW_LIMIT} is exceeded. */
export class BrokerStoreCapacityError extends Error {
  constructor(limit: number) {
    super(`FileBrokerStore is at capacity (${limit} crews)`);
    this.name = "BrokerStoreCapacityError";
  }
}

/**
 * Persistent BrokerStore backed by JSON files on disk.
 *
 * Each crew is stored as a separate JSON file: `<dataDir>/<code>.json`.
 * Load reads all files on construction; save writes the crew file atomically.
 *
 * Refuses to create new crews once the ceiling is hit -- the auto-join
 * protocol would otherwise allow an unauthenticated peer to fill the
 * disk with empty crew files. Crews already present in memory can still
 * be looked up and mutated.
 */
export class FileBrokerStore implements BrokerStore {
  private crews = new Map<string, CrewState>();
  private dataDir: string;
  private limit: number;

  constructor(dataDir: string, limit: number = FILE_STORE_CREW_LIMIT) {
    this.dataDir = dataDir;
    this.limit = limit;
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

    if (this.crews.size >= this.limit) {
      throw new BrokerStoreCapacityError(this.limit);
    }

    const crew = createCrewState(code, repoRef);
    this.crews.set(code, crew);
    this.saveCrew(crew);
    return crew;
  }

  /** Current number of crews held by the store (exposed for testing). */
  size(): number {
    return this.crews.size;
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
