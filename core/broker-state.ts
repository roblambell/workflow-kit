// Shared crew broker state machine and scheduling logic.

import type { ReconnectStateMessage, SyncItem } from "./crew.ts";
import type { BrokerSocket, CrewState, DaemonState, WorkEntry } from "./broker-store.ts";

export interface CrewEvent {
  ts: string;
  crew_id: string;
  daemon_id: string;
  event:
    | "claim"
    | "sync"
    | "complete"
    | "disconnect"
    | "reconnect"
    | "abandon"
    | "reconcile_complete"
    | "schedule_claim"
    | "report";
  work_item_path: string;
  metadata: { affinity: "author" | "pool" } | Record<string, unknown>;
}

export interface RemoteItemSnapshot {
  id: string;
  state: string;
  ownerDaemonId: string | null;
  ownerName: string | null;
}

export interface CrewStatusUpdate {
  type: "crew_update";
  crewCode: string;
  daemonCount: number;
  availableCount: number;
  claimedCount: number;
  completedCount: number;
  daemonNames: string[];
  claimedItems: Array<{ id: string; daemonId: string }>;
  remoteItems: RemoteItemSnapshot[];
}

export interface BrokerStateOptions {
  heartbeatTimeoutMs: number;
  gracePeriodMs: number;
  scheduleClaimExpiryMs?: number;
}

export interface BrokerTransition {
  events: CrewEvent[];
  changed: boolean;
}

export const DEFAULT_SCHEDULE_CLAIM_EXPIRY_MS = 30 * 60 * 1_000;

function createEvent(
  crewId: string,
  daemonId: string,
  event: CrewEvent["event"],
  workItemPath: string,
  metadata: Record<string, unknown>,
): CrewEvent {
  return {
    ts: new Date().toISOString(),
    crew_id: crewId,
    daemon_id: daemonId,
    event,
    work_item_path: workItemPath,
    metadata: metadata as CrewEvent["metadata"],
  };
}

export function isWorkItemAvailable(crew: CrewState, workItem: WorkEntry): boolean {
  return workItem.claimedBy === null
    && workItem.completedBy === null
    && workItem.dependencies.every((depId) => {
      const dep = crew.items.get(depId);
      return !dep || dep.completedBy !== null;
    });
}

export function connectDaemon(
  crew: CrewState,
  daemonId: string,
  name: string,
  ws: BrokerSocket,
  operatorId: string = "",
  now: number = Date.now(),
): BrokerTransition & { reconnectState: ReconnectStateMessage | null } {
  const existing = crew.daemons.get(daemonId);
  if (!existing) {
    crew.daemons.set(daemonId, {
      id: daemonId,
      name,
      operatorId,
      ws,
      lastHeartbeat: now,
      disconnectedAt: null,
      claimedItems: new Set(),
      released: false,
    });
    return { reconnectState: null, events: [], changed: true };
  }

  const wasDisconnected = existing.disconnectedAt !== null || existing.released;
  existing.ws = ws;
  existing.lastHeartbeat = now;
  existing.disconnectedAt = null;
  existing.released = false;
  existing.name = name;
  existing.operatorId = operatorId;

  if (!wasDisconnected) {
    return { reconnectState: null, events: [], changed: true };
  }

  const resumed: string[] = [];
  const released: string[] = [];
  const reclaimed: string[] = [];

  for (const workItemPath of existing.claimedItems) {
    const workItem = crew.items.get(workItemPath);
    if (!workItem) {
      released.push(workItemPath);
      continue;
    }
    if (workItem.claimedBy === daemonId) {
      resumed.push(workItemPath);
    } else if (workItem.claimedBy !== null) {
      reclaimed.push(workItemPath);
    } else {
      released.push(workItemPath);
    }
  }

  for (const path of [...released, ...reclaimed]) {
    existing.claimedItems.delete(path);
  }

  return {
    reconnectState: {
      type: "reconnect_state",
      resumed,
      released,
      reclaimed,
    },
    events: [createEvent(crew.code, daemonId, "reconnect", "", {})],
    changed: true,
  };
}

export function disconnectDaemon(
  crew: CrewState,
  daemonId: string,
  now: number = Date.now(),
): BrokerTransition {
  const daemon = crew.daemons.get(daemonId);
  if (!daemon || daemon.ws === null) {
    return { events: [], changed: false };
  }

  daemon.ws = null;
  daemon.disconnectedAt = now;
  return {
    events: [createEvent(crew.code, daemonId, "disconnect", "", {})],
    changed: true,
  };
}

export function syncCrewItems(
  crew: CrewState,
  daemonId: string,
  items: SyncItem[],
  now: number = Date.now(),
): { workItemIds: string[]; events: CrewEvent[]; changed: boolean } {
  const syncedIds = new Set(items.map((item) => item.id));
  const events: CrewEvent[] = [];
  let changed = false;

  for (const item of items) {
    const existing = crew.items.get(item.id);
    if (existing) {
      existing.priority = item.priority;
      existing.dependencies = item.dependencies;
      existing.author = item.author;
      changed = true;
      continue;
    }

    crew.items.set(item.id, {
      path: item.id,
      priority: item.priority,
      dependencies: item.dependencies,
      author: item.author,
      syncedAt: now,
      creatorDaemonId: daemonId,
      claimedBy: null,
      completedBy: null,
    });
    events.push(createEvent(crew.code, daemonId, "sync", item.id, { affinity: "author" }));
    changed = true;
  }

  for (const [id, entry] of crew.items) {
    if (
      entry.creatorDaemonId === daemonId
      && !syncedIds.has(id)
      && entry.completedBy === null
    ) {
      entry.completedBy = daemonId;
      entry.claimedBy = null;
      events.push(createEvent(crew.code, daemonId, "reconcile_complete", id, {}));
      changed = true;
    }
  }

  return {
    workItemIds: Array.from(crew.items.keys()),
    events,
    changed,
  };
}

export function claimNextWorkItem(
  crew: CrewState,
  daemonId: string,
): { workItemId: string | null; affinity: "author" | "pool" | null; events: CrewEvent[]; changed: boolean } {
  const daemon = crew.daemons.get(daemonId);
  if (!daemon) {
    return { workItemId: null, affinity: null, events: [], changed: false };
  }

  const available = Array.from(crew.items.values()).filter((workItem) => isWorkItemAvailable(crew, workItem));
  if (available.length === 0) {
    return { workItemId: null, affinity: null, events: [], changed: false };
  }

  const operatorId = daemon.operatorId;
  available.sort((a, b) => {
    const aAuthor = operatorId !== "" && a.author === operatorId ? 0 : 1;
    const bAuthor = operatorId !== "" && b.author === operatorId ? 0 : 1;
    if (aAuthor !== bAuthor) return aAuthor - bAuthor;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.syncedAt - b.syncedAt;
  });

  const workItem = available[0]!;
  workItem.claimedBy = daemonId;
  daemon.claimedItems.add(workItem.path);

  const affinity: "author" | "pool" =
    operatorId !== "" && workItem.author === operatorId ? "author" : "pool";

  return {
    workItemId: workItem.path,
    affinity,
    events: [createEvent(crew.code, daemonId, "claim", workItem.path, { affinity })],
    changed: true,
  };
}

export function completeWorkItem(
  crew: CrewState,
  daemonId: string,
  workItemId: string,
): { ok: boolean; error?: string; events: CrewEvent[]; changed: boolean } {
  const workItem = crew.items.get(workItemId);
  if (!workItem || workItem.claimedBy !== daemonId) {
    return {
      ok: false,
      error: `Cannot complete: ${workItemId}`,
      events: [],
      changed: false,
    };
  }

  const daemon = crew.daemons.get(daemonId);
  daemon?.claimedItems.delete(workItemId);

  workItem.completedBy = daemonId;
  workItem.claimedBy = null;

  return {
    ok: true,
    events: [createEvent(crew.code, daemonId, "complete", workItemId, {})],
    changed: true,
  };
}

export function recordHeartbeat(crew: CrewState, daemonId: string, now: number = Date.now()): boolean {
  const daemon = crew.daemons.get(daemonId);
  if (!daemon) return false;

  daemon.lastHeartbeat = now;
  return true;
}

export function claimScheduleSlot(
  crew: CrewState,
  daemonId: string,
  taskId: string,
  scheduleTime: string,
  now: number = Date.now(),
  expiryMs: number = DEFAULT_SCHEDULE_CLAIM_EXPIRY_MS,
): { granted: boolean; events: CrewEvent[]; changed: boolean } {
  const key = `${taskId}:${scheduleTime}`;
  const existing = crew.scheduleClaims.get(key);

  if (existing && existing.expiresAt > now) {
    return {
      granted: false,
      events: [createEvent(crew.code, daemonId, "schedule_claim", taskId, { granted: false, key })],
      changed: false,
    };
  }

  crew.scheduleClaims.set(key, {
    daemonId,
    expiresAt: now + expiryMs,
  });

  return {
    granted: true,
    events: [createEvent(crew.code, daemonId, "schedule_claim", taskId, { granted: true, key })],
    changed: true,
  };
}

function releaseDaemonWorkItems(crew: CrewState, daemon: DaemonState): CrewEvent[] {
  const events: CrewEvent[] = [];

  for (const workItemPath of daemon.claimedItems) {
    const workItem = crew.items.get(workItemPath);
    if (workItem && workItem.claimedBy === daemon.id) {
      workItem.claimedBy = null;
      events.push(createEvent(crew.code, daemon.id, "abandon", workItemPath, {}));
    }
  }

  return events;
}

export function checkCrewHeartbeats(
  crew: CrewState,
  options: BrokerStateOptions,
  now: number = Date.now(),
): BrokerTransition {
  const events: CrewEvent[] = [];
  let changed = false;

  for (const [key, entry] of crew.scheduleClaims) {
    if (now >= entry.expiresAt) {
      crew.scheduleClaims.delete(key);
    }
  }

  for (const daemon of crew.daemons.values()) {
    if (daemon.ws !== null && now - daemon.lastHeartbeat > options.heartbeatTimeoutMs) {
      daemon.ws = null;
      daemon.disconnectedAt = now;
      events.push(createEvent(crew.code, daemon.id, "disconnect", "", {}));
      changed = true;
    }

    if (
      daemon.disconnectedAt !== null
      && daemon.ws === null
      && !daemon.released
      && now - daemon.disconnectedAt > options.gracePeriodMs
    ) {
      events.push(...releaseDaemonWorkItems(crew, daemon));
      daemon.released = true;
      changed = true;
    }
  }

  return { events, changed };
}

function resolveItemState(workItem: WorkEntry, crew: CrewState): string {
  if (workItem.completedBy !== null) return "done";
  if (workItem.claimedBy !== null) return "in-progress";
  if (isWorkItemAvailable(crew, workItem)) return "queued";
  return "blocked";
}

export function buildCrewStatusUpdate(crew: CrewState): CrewStatusUpdate {
  const workItems = Array.from(crew.items.values());
  const availableCount = workItems.filter((workItem) => isWorkItemAvailable(crew, workItem)).length;
  const claimedCount = workItems.filter((workItem) => workItem.claimedBy !== null).length;
  const completedCount = workItems.filter((workItem) => workItem.completedBy !== null).length;
  const connectedDaemons = Array.from(crew.daemons.values()).filter((daemon) => daemon.ws !== null);

  const remoteItems: RemoteItemSnapshot[] = workItems.map((workItem) => {
    const ownerDaemonId = workItem.claimedBy;
    const ownerDaemon = ownerDaemonId ? crew.daemons.get(ownerDaemonId) : undefined;
    return {
      id: workItem.path,
      state: resolveItemState(workItem, crew),
      ownerDaemonId,
      ownerName: ownerDaemon?.name ?? null,
    };
  });

  return {
    type: "crew_update",
    crewCode: crew.code,
    daemonCount: connectedDaemons.length,
    availableCount,
    claimedCount,
    completedCount,
    daemonNames: connectedDaemons.map((daemon) => daemon.name),
    claimedItems: workItems
      .filter((workItem) => workItem.claimedBy !== null && workItem.completedBy === null)
      .map((workItem) => ({ id: workItem.path, daemonId: workItem.claimedBy! })),
    remoteItems,
  };
}
