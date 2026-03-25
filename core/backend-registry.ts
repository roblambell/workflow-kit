// Backend discovery: auto-detect configured external task backends from env vars and config.

import type { TaskBackend } from "./types.ts";
import { loadConfig } from "./config.ts";
import { SentryBackend, resolveSentryConfig } from "./backends/sentry.ts";
import {
  PagerDutyBackend,
  resolvePagerDutyConfig,
} from "./backends/pagerduty.ts";
import { ClickUpBackend, resolveClickUpConfig } from "./backends/clickup.ts";

export interface DiscoveredBackend {
  name: string;
  backend: TaskBackend;
}

/**
 * Discover all configured external task backends.
 * Checks environment variables and .ninthwave/config for known backends.
 * Returns an array of { name, backend } for each configured backend.
 *
 * Convention over configuration: if env vars are set, the backend is active.
 */
export function discoverBackends(
  projectRoot: string,
  configGetter?: (key: string) => string | undefined,
): DiscoveredBackend[] {
  const getter =
    configGetter ??
    (() => {
      const config = loadConfig(projectRoot);
      return (key: string) => config[key];
    })();

  const backends: DiscoveredBackend[] = [];

  // Sentry
  const sentryConfig = resolveSentryConfig(getter);
  if (sentryConfig) {
    backends.push({
      name: "sentry",
      backend: new SentryBackend(
        sentryConfig.org,
        sentryConfig.project,
        sentryConfig.authToken,
      ),
    });
  }

  // PagerDuty
  const pdConfig = resolvePagerDutyConfig(getter);
  if (pdConfig) {
    backends.push({
      name: "pagerduty",
      backend: new PagerDutyBackend(
        pdConfig.apiToken,
        pdConfig.fromEmail,
        undefined,
        pdConfig.serviceId,
      ),
    });
  }

  // ClickUp
  const ckConfig = resolveClickUpConfig(undefined, getter);
  if (ckConfig) {
    backends.push({
      name: "clickup",
      backend: new ClickUpBackend(ckConfig.listId, ckConfig.apiToken),
    });
  }

  return backends;
}
