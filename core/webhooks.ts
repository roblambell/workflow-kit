// Webhook support for orchestrator lifecycle events.
// Fire-and-forget JSON POST to a configured URL on key events.
// Supports Slack and Discord incoming webhook formats.

import { loadConfig } from "./config.ts";

// ── Types ──────────────────────────────────────────────────────────────

export type WebhookEvent =
  | "batch_complete"
  | "pr_merged"
  | "ci_failed"
  | "orchestrate_complete";

export interface WebhookItemSummary {
  id: string;
  state: string;
  prNumber?: number;
}

export interface WebhookPayload {
  /** Human-readable message (Slack `text` / Discord-compatible). */
  text: string;
  /** Machine-readable event type. */
  event: WebhookEvent;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Items involved in this event. */
  items?: WebhookItemSummary[];
  /** Aggregate stats. */
  summary?: { done: number; stuck: number; total: number };
  /** Specific item this event relates to (ci_failed, pr_merged). */
  itemId?: string;
  /** PR number (ci_failed, pr_merged). */
  prNumber?: number;
  /** Error details (ci_failed). */
  error?: string;
  /** When multiple events are coalesced via debounce, contains all individual payloads. */
  batched?: WebhookPayload[];
}

/** Injectable fetch signature matching globalThis.fetch. */
export type WebhookFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

/** Callback signature for the notifier returned by createWebhookNotifier. */
export type WebhookNotifyFn = ((
  event: WebhookEvent,
  data: Omit<WebhookPayload, "text" | "event" | "timestamp">,
) => void) & {
  /** Flush any debounce-buffered events immediately. Present only when debounce is active. */
  flush?: () => void;
};

// ── URL resolution ──────────────────────────────────────────────────────

/**
 * Resolve webhook URL from environment variable or project config.
 * Precedence: NINTHWAVE_WEBHOOK_URL env var > .ninthwave/config webhook_url field.
 *
 * @param projectRoot - Project root for config file lookup (optional).
 * @param env - Environment variables (injectable for testing).
 * @param configLoader - Config loader function (injectable for testing).
 */
export function resolveWebhookUrl(
  projectRoot?: string,
  env: Record<string, string | undefined> = process.env,
  configLoader: (root: string) => Record<string, string> = loadConfig,
): string | null {
  const envUrl = env.NINTHWAVE_WEBHOOK_URL;
  if (envUrl) return envUrl;

  if (projectRoot) {
    try {
      const config = configLoader(projectRoot);
      if (config.webhook_url) return config.webhook_url;
    } catch {
      // Config load failure is non-fatal
    }
  }

  return null;
}

// ── Text formatting ─────────────────────────────────────────────────────

/** Format a human-readable message for Slack/Discord display. */
export function formatWebhookText(
  event: WebhookEvent,
  data: Partial<WebhookPayload>,
): string {
  switch (event) {
    case "batch_complete": {
      const s = data.summary;
      const itemIds = data.items?.map((i) => i.id).join(", ") ?? "";
      return `✅ *Batch complete* — ${s?.done ?? 0} done, ${s?.stuck ?? 0} stuck of ${s?.total ?? 0} total\nItems: ${itemIds}`;
    }
    case "pr_merged":
      return `🔀 *PR #${data.prNumber ?? "?"}* merged for \`${data.itemId ?? "?"}\``;
    case "ci_failed":
      return `❌ *CI failed* for \`${data.itemId ?? "?"}\` (PR #${data.prNumber ?? "?"})`;
    case "orchestrate_complete": {
      const s = data.summary;
      const itemList =
        data.items
          ?.map(
            (i) => `• \`${i.id}\`: ${i.state}${i.prNumber ? ` (PR #${i.prNumber})` : ""}`,
          )
          .join("\n") ?? "";
      return `🏁 *Orchestration complete* — ${s?.done ?? 0} done, ${s?.stuck ?? 0} stuck of ${s?.total ?? 0} total\n${itemList}`;
    }
  }
}

// ── Fire webhook ────────────────────────────────────────────────────────

/**
 * POST a JSON payload to the webhook URL. Fire-and-forget.
 * Logs errors but never throws — webhook failures must not block orchestration.
 *
 * @param url - Webhook endpoint URL.
 * @param payload - JSON payload to send.
 * @param fetchFn - Injectable fetch function (defaults to globalThis.fetch).
 * @param logError - Optional error logger.
 */
export async function fireWebhook(
  url: string,
  payload: WebhookPayload,
  fetchFn: WebhookFetchFn = globalThis.fetch,
  logError?: (msg: string) => void,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      logError?.(`Webhook returned HTTP ${response.status}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logError?.(`Webhook delivery failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ── Notifier factory ────────────────────────────────────────────────────

/** Options for createWebhookNotifier. */
export interface WebhookNotifierOptions {
  /**
   * Debounce window in milliseconds. When > 0, rapid events within this
   * window are coalesced into a single batched webhook payload.
   * Default: 0 (no debounce — fire immediately).
   */
  debounceMs?: number;
}

/**
 * Create a fire-and-forget webhook notifier.
 * Returns a no-op function when URL is null (webhook not configured).
 *
 * When `debounceMs` is set, events are buffered and flushed after the
 * debounce window. If multiple events arrive within the window, they are
 * coalesced into a single payload with a `batched` array containing all
 * individual payloads. The returned function has a `flush()` method to
 * force immediate delivery of buffered events.
 *
 * @param url - Webhook URL (null = disabled).
 * @param fetchFn - Injectable fetch function.
 * @param logError - Optional error logger.
 * @param options - Optional notifier options (e.g., debounceMs).
 */
export function createWebhookNotifier(
  url: string | null,
  fetchFn: WebhookFetchFn = globalThis.fetch,
  logError?: (msg: string) => void,
  options?: WebhookNotifierOptions,
): WebhookNotifyFn {
  if (!url) return () => {};

  const debounceMs = options?.debounceMs ?? 0;

  if (debounceMs <= 0) {
    // No debounce — fire immediately (existing behavior)
    return (event, data) => {
      const payload: WebhookPayload = {
        ...data,
        event,
        timestamp: new Date().toISOString(),
        text: formatWebhookText(event, data),
      };
      // Fire-and-forget — intentionally not awaited
      fireWebhook(url, payload, fetchFn, logError).catch(() => {});
    };
  }

  // Debounced mode — buffer events and flush after window
  let buffer: WebhookPayload[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;

    const events = buffer;
    buffer = [];

    if (events.length === 1) {
      // Single event — send as-is (no batched wrapper)
      fireWebhook(url, events[0], fetchFn, logError).catch(() => {});
    } else {
      // Multiple events — coalesce into batched payload
      const combinedText = events.map((e) => e.text).join("\n");
      const payload: WebhookPayload = {
        text: `📦 *${events.length} events coalesced*\n${combinedText}`,
        event: events[0].event,
        timestamp: new Date().toISOString(),
        batched: events,
      };
      fireWebhook(url, payload, fetchFn, logError).catch(() => {});
    }
  };

  const notify: WebhookNotifyFn = (event, data) => {
    const payload: WebhookPayload = {
      ...data,
      event,
      timestamp: new Date().toISOString(),
      text: formatWebhookText(event, data),
    };
    buffer.push(payload);

    // Reset the debounce timer on each new event
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  notify.flush = flush;
  return notify;
}
