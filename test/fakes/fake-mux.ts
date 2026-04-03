// In-memory Multiplexer implementation for scenario tests.
// Implements the Multiplexer interface from core/mux.ts with controllable state.

import type { Multiplexer } from "../../core/mux.ts";

interface FakeWorkspace {
  ref: string;
  cwd: string;
  command: string;
  alive: boolean;
  screenContent: string;
  workItemId?: string;
  /** Messages sent to this workspace (for assertions). */
  messages: string[];
  status: { key: string; text: string; icon: string; color: string } | null;
  progress: { value: number; label?: string } | null;
}

/**
 * In-memory multiplexer for scenario tests.
 *
 * Test code drives state via:
 * - `setScreen(ref, content)` -- simulate worker terminal output
 * - `setAlive(ref, alive)` -- simulate worker crash/recovery
 * - `getMessages(ref)` -- inspect messages sent to a workspace
 */
export class FakeMux implements Multiplexer {
  readonly type = "cmux" as const;
  private workspaces = new Map<string, FakeWorkspace>();
  private nextId = 1;

  // ── Multiplexer interface ──────────────────────────────────────

  isAvailable(): boolean {
    return true;
  }

  diagnoseUnavailable(): string {
    return "FakeMux is always available";
  }

  launchWorkspace(cwd: string, command: string, workItemId?: string): string | null {
    const ref = `workspace:${this.nextId++}`;
    this.workspaces.set(ref, {
      ref,
      cwd,
      command,
      alive: true,
      screenContent: "❯ ",
      workItemId,
      messages: [],
      status: null,
      progress: null,
    });
    return ref;
  }

  splitPane(_command: string): string | null {
    return null;
  }

  sendMessage(ref: string, message: string): boolean {
    const ws = this.workspaces.get(ref);
    if (!ws || !ws.alive) return false;
    ws.messages.push(message);
    return true;
  }

  readScreen(ref: string, _lines?: number): string {
    const ws = this.workspaces.get(ref);
    if (!ws) return "";
    return ws.screenContent;
  }

  listWorkspaces(): string {
    const lines: string[] = [];
    for (const ws of this.workspaces.values()) {
      if (ws.alive) {
        lines.push(`${ws.ref}\t${ws.workItemId ?? ""}\t${ws.cwd}`);
      }
    }
    return lines.join("\n");
  }

  closeWorkspace(ref: string): boolean {
    const ws = this.workspaces.get(ref);
    if (!ws) return false;
    ws.alive = false;
    return true;
  }

  setStatus(ref: string, key: string, text: string, icon: string, color: string): boolean {
    const ws = this.workspaces.get(ref);
    if (!ws) return false;
    ws.status = { key, text, icon, color };
    return true;
  }

  setProgress(ref: string, value: number, label?: string): boolean {
    const ws = this.workspaces.get(ref);
    if (!ws) return false;
    ws.progress = { value, label };
    return true;
  }

  // ── Test control methods ───────────────────────────────────────

  /** Set the screen content for a workspace (simulates terminal output). */
  setScreen(ref: string, content: string): void {
    const ws = this.workspaces.get(ref);
    if (!ws) throw new Error(`FakeMux: no workspace ${ref}`);
    ws.screenContent = content;
  }

  /** Set alive status for a workspace (simulates worker crash/recovery). */
  setAlive(ref: string, alive: boolean): void {
    const ws = this.workspaces.get(ref);
    if (!ws) throw new Error(`FakeMux: no workspace ${ref}`);
    ws.alive = alive;
  }

  /** Get messages sent to a workspace (for assertions). */
  getMessages(ref: string): string[] {
    return this.workspaces.get(ref)?.messages ?? [];
  }

  /** Get a workspace by ref (for assertions). */
  getWorkspace(ref: string): FakeWorkspace | undefined {
    return this.workspaces.get(ref);
  }

  /** Get all workspace refs. */
  getAllRefs(): string[] {
    return Array.from(this.workspaces.keys());
  }
}
