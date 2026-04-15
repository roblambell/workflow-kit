# Refactor: Switch broker protocol to auto-join and hashed identifiers (H-BAJ-3)

**Priority:** High
**Source:** Plan: frictionless broker auto-join + anonymized identifiers
**Depends on:** H-BAJ-2
**Domain:** broker

**Lineage:** fe44c39e-112b-4107-a86f-90dc360e0a79

Replace the manual `nw crew create` / `nw crew join <CODE>` handshake with zero-friction auto-join keyed on `HMAC-SHA256(broker_secret, project_id)` -- call this `crew_id`. Every identifier that leaves the client is hashed via `makeBrokerHasher(broker_secret)` so the broker sees only opaque tokens. This is the breaking commit: old-format dashed crew codes stop working and the `/api/crews` POST endpoint is removed. Decisions baked in: `crew_id` goes in the WS path as a 22-char base64url token; the broker's repo-ref 403 check is dropped (secret possession is the auth); `report.metadata` is sanitized via allowlist-plus-hash-fallback; both `BrokerServer` and `MockBroker` gain a bounded LRU cap (10k in-memory, 100k on disk) to block crew-id DoS on the public broker. Author-affinity scheduling must keep working because both sides (`SyncItem.author` and daemon `operatorId`) are hashed with the same secret.

Client-side hashing (in `core/crew.ts`, `WebSocketCrewBroker`):
- WS query string: `daemonId`, `operatorId`, `name` (hostname) -- all hashed. Drop `repoUrl` / `repoHash` entirely.
- Message bodies: every `daemonId`, `sync.items[].id`, `sync.items[].dependencies[]`, `sync.items[].author`, `complete.workItemId`, `report.workItemPath`, `report.branch`, `report.commitAuthor`, `report.sessionId`.
- Keep cleartext: structural counts, timestamps, protocol type literals, event names, priority integers, `report.model`, `report.tokenUsage`, `claim.requestId`.
- `report.metadata` sanitizer: allowlist (booleans, numbers, enum event-name strings from a known set). Any other string value -> hashed. Apply in `sendReport`.
- Maintain an in-memory `Map<string, string>` of local `id -> hash` so status UI can label peer items from broadcasts; unknown hashes render as `peer-<hash-prefix>`.

Broker-side (`core/broker-server.ts` + `core/mock-broker.ts`):
- Replace the dashed-code WS path regex with `/^\/api\/crews\/([A-Za-z0-9_-]{16,64})\/ws$/` in both files.
- Auto-create a crew entry on unknown `crew_id` instead of returning 404.
- Remove the `/api/crews` POST handler entirely.
- Remove the repoRef 403 check in the WS upgrade path.
- Add bounded LRU cap to `InMemoryBrokerStore` (10,000 crews) and a crew-count ceiling to `FileBrokerStore` (100,000 files).

Supporting code:
- Add `resolveCrewId(config: ProjectConfig): string` in `core/orchestrate-crew.ts`. Keep `resolveCrewSocketUrl` signature unchanged.
- Update `createCrewBrokerInstance` to accept `ProjectConfig` and pass both the resolved URL and the derived `crew_id` + hasher to `WebSocketCrewBroker`.
- Update the `connectWs` test helper in `test/broker-runtime.test.ts` to build URLs with base64url tokens.

Do NOT in this PR: delete `core/commands/crew.ts`, `test/crew-command.test.ts`, or the `crewCode` UI strings -- that is H-BAJ-4's scope. Leave the old code paths dead-but-present; CI on this PR proves the new protocol works and still green-builds with the old files dormant.

**Test plan:**
- New `test/broker-auto-join.test.ts`: two `WebSocketCrewBroker` clients sharing `project_id`+`broker_secret` land in the same crew via in-process `BrokerServer`; a `claim` by one is visible in the other's `crew_update`. Assert the broker never receives cleartext by grepping received messages for a known work item id / git email string and expecting zero matches.
- New `test/broker-author-affinity.test.ts`: work item with `author: "alice@x.com"` + daemon with git email `alice@x.com`, both hashed via the same project secret, still routes the item to that daemon via `claimNextWorkItem`.
- New `test/broker-rate-limit.test.ts`: bulk-connect more than 10k distinct `crew_id`s against an in-process broker; verify the oldest entries evict, memory stays bounded, and normal clients still function.
- Rewrite `test/broker-runtime.test.ts`: drop all `repoRef` / 403 assertions (current lines around 163, 212, 230, 241, 296, 309, 497); update `connectWs` helper (around lines 52-72) to build base64url URLs; assert auto-create on unknown `crew_id`.
- Rewrite `test/crew.test.ts` and `test/crew-connect.test.ts`: replace create/join expectations with auto-join + hashed-identifier assertions.
- Update `test/mock-broker.test.ts`: new regex, auto-create parity with `BrokerServer`.
- Update `test/scenario/crew-coordination.test.ts`: end-to-end with auto-join, no crew code input.
- Regression: `test/config.test.ts`, `test/init.test.ts` (added in H-BAJ-1) still pass unchanged.

Acceptance: Running two daemons against a shared broker with matching `project_id`+`broker_secret` auto-join the same crew with zero user input. Broker receives only hashed identifiers for every field listed above; a grep of broker logs for a known work item id or git email finds zero matches. `nw crew create` no longer talks to the broker (POST endpoint removed). Dashed-code URLs return 404. In-memory broker holds at most 10k crews; file-store refuses a 100,001st crew. Author affinity test passes. `bun run test` passes.

Key files: `core/crew.ts`, `core/broker-server.ts`, `core/mock-broker.ts`, `core/broker-state.ts`, `core/broker-store.ts`, `core/orchestrate-crew.ts`, `test/broker-runtime.test.ts`, `test/broker-auto-join.test.ts`, `test/broker-author-affinity.test.ts`, `test/broker-rate-limit.test.ts`, `test/crew.test.ts`, `test/crew-connect.test.ts`, `test/mock-broker.test.ts`, `test/scenario/crew-coordination.test.ts`
