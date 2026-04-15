# Feat: Add project_id and broker_secret to project config (H-BAJ-1)

**Priority:** High
**Source:** Plan: frictionless broker auto-join + anonymized identifiers
**Depends on:** None
**Domain:** broker
**Lineage:** 6e69471f-c44f-4f64-8d11-de6ace2ebc9d

Add two new optional fields to `ProjectConfig` -- `project_id` (UUID v4) and `broker_secret` (32 random bytes, base64). Extend `loadProjectConfigFile` and `loadMergedProjectConfig` so both fields parse and respect the committed-vs-local override pattern already used for `crew_url`. Add a `loadOrGenerateProjectIdentity(projectRoot)` helper in `core/config.ts` that generates missing values via `crypto.randomUUID()` / `crypto.getRandomValues`, merges them into `.ninthwave/config.json` without clobbering other fields, and returns the resolved pair. Wire it into `initProject` (via `generateConfig`) and into the CLI entrypoint alongside `loadMergedProjectConfig` so repos that predate this change auto-populate on first run post-upgrade. This PR is non-breaking -- no broker protocol changes, existing `nw crew` flow still works.

**Test plan:**
- Extend `test/config.test.ts`: assert `project_id` and `broker_secret` parse from `config.json` and from `config.local.json`, and that local-over-committed precedence works for both.
- New `test/config-local-secret.test.ts`: `broker_secret` in `config.local.json` overrides the value in `config.json`.
- Extend `test/init.test.ts`: `initProject` writes both fields when absent; re-running `initProject` on a config that already has them leaves values untouched (idempotent).
- New test for `loadOrGenerateProjectIdentity`: missing both -> generates + persists; partial (only one present) -> generates the missing one only; present both -> no write; `broker_secret` is valid base64 of 32 bytes; `project_id` is a UUID v4.

Acceptance: `ProjectConfig` type has optional `project_id: string` and `broker_secret: string` fields. `loadMergedProjectConfig` merges both with local override. `loadOrGenerateProjectIdentity` is exported and covered by tests. Running `nw init` on a fresh repo writes both fields to `.ninthwave/config.json`. Running `nw` on an existing repo whose `.ninthwave/config.json` lacks the fields adds them without damaging other config. `bun run test` passes. No changes to `core/crew.ts`, `core/broker-server.ts`, or any outbound protocol.

Key files: `core/config.ts`, `core/commands/init.ts`, `core/cli.ts`, `test/config.test.ts`, `test/init.test.ts`, `test/config-local-secret.test.ts`
