// Tests for core/backend-registry.ts
// Uses process.env manipulation for env-var-based detection.

import { describe, it, expect, afterEach } from "vitest";
import { discoverBackends } from "../core/backend-registry.ts";

// Save original env
const originalEnv = { ...process.env };

afterEach(() => {
  // Restore env
  process.env = { ...originalEnv };
});

describe("discoverBackends", () => {
  it("returns empty array when no env vars are set", () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
    delete process.env.PAGERDUTY_API_TOKEN;
    delete process.env.PAGERDUTY_FROM_EMAIL;
    delete process.env.CLICKUP_API_TOKEN;

    const backends = discoverBackends("/fake/project", () => undefined);

    expect(backends).toEqual([]);
  });

  it("discovers sentry when all sentry env vars are set", () => {
    process.env.SENTRY_AUTH_TOKEN = "test-token";
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    delete process.env.PAGERDUTY_API_TOKEN;
    delete process.env.CLICKUP_API_TOKEN;

    const backends = discoverBackends("/fake/project", () => undefined);

    expect(backends).toHaveLength(1);
    expect(backends[0].name).toBe("sentry");
    expect(backends[0].backend).toBeDefined();
    expect(typeof backends[0].backend.list).toBe("function");
  });

  it("discovers pagerduty when all pagerduty env vars are set", () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    process.env.PAGERDUTY_API_TOKEN = "test-token";
    process.env.PAGERDUTY_FROM_EMAIL = "test@example.com";
    delete process.env.CLICKUP_API_TOKEN;

    const backends = discoverBackends("/fake/project", () => undefined);

    expect(backends).toHaveLength(1);
    expect(backends[0].name).toBe("pagerduty");
    expect(backends[0].backend).toBeDefined();
    expect(typeof backends[0].backend.list).toBe("function");
  });

  it("discovers both sentry and pagerduty when both are configured", () => {
    process.env.SENTRY_AUTH_TOKEN = "sentry-token";
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    process.env.PAGERDUTY_API_TOKEN = "pd-token";
    process.env.PAGERDUTY_FROM_EMAIL = "test@example.com";
    delete process.env.CLICKUP_API_TOKEN;

    const backends = discoverBackends("/fake/project", () => undefined);

    expect(backends).toHaveLength(2);
    expect(backends.map((b) => b.name)).toEqual(["sentry", "pagerduty"]);
  });

  it("skips sentry when auth token is set but org/project are missing", () => {
    process.env.SENTRY_AUTH_TOKEN = "test-token";
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
    delete process.env.PAGERDUTY_API_TOKEN;
    delete process.env.CLICKUP_API_TOKEN;

    const backends = discoverBackends("/fake/project", () => undefined);

    expect(backends).toEqual([]);
  });

  it("discovers sentry using config getter for org/project", () => {
    process.env.SENTRY_AUTH_TOKEN = "test-token";
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
    delete process.env.PAGERDUTY_API_TOKEN;
    delete process.env.CLICKUP_API_TOKEN;

    const configGetter = (key: string) => {
      if (key === "sentry_org") return "config-org";
      if (key === "sentry_project") return "config-project";
      return undefined;
    };

    const backends = discoverBackends("/fake/project", configGetter);

    expect(backends).toHaveLength(1);
    expect(backends[0].name).toBe("sentry");
  });

  it("discovers pagerduty using config getter for from_email", () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    process.env.PAGERDUTY_API_TOKEN = "pd-token";
    delete process.env.PAGERDUTY_FROM_EMAIL;
    delete process.env.CLICKUP_API_TOKEN;

    const configGetter = (key: string) => {
      if (key === "pagerduty_from_email") return "config@example.com";
      return undefined;
    };

    const backends = discoverBackends("/fake/project", configGetter);

    expect(backends).toHaveLength(1);
    expect(backends[0].name).toBe("pagerduty");
  });

  it("skips pagerduty when api token is set but from_email is missing", () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    process.env.PAGERDUTY_API_TOKEN = "pd-token";
    delete process.env.PAGERDUTY_FROM_EMAIL;
    delete process.env.CLICKUP_API_TOKEN;

    const backends = discoverBackends("/fake/project", () => undefined);

    expect(backends).toEqual([]);
  });

  it("discovers clickup when env vars and config are set", () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.PAGERDUTY_API_TOKEN;
    process.env.CLICKUP_API_TOKEN = "ck-token";

    const configGetter = (key: string) => {
      if (key === "CLICKUP_LIST_ID") return "list-123";
      return undefined;
    };

    const backends = discoverBackends("/fake/project", configGetter);

    expect(backends).toHaveLength(1);
    expect(backends[0].name).toBe("clickup");
  });

  it("discovers all three backends when all are configured", () => {
    process.env.SENTRY_AUTH_TOKEN = "sentry-token";
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    process.env.PAGERDUTY_API_TOKEN = "pd-token";
    process.env.PAGERDUTY_FROM_EMAIL = "test@example.com";
    process.env.CLICKUP_API_TOKEN = "ck-token";

    const configGetter = (key: string) => {
      if (key === "CLICKUP_LIST_ID") return "list-123";
      return undefined;
    };

    const backends = discoverBackends("/fake/project", configGetter);

    expect(backends).toHaveLength(3);
    expect(backends.map((b) => b.name)).toEqual([
      "sentry",
      "pagerduty",
      "clickup",
    ]);
  });
});
