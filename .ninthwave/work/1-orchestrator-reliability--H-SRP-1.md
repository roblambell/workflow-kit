# Fix: Add durable work-item lineage tokens (H-SRP-1)

**Priority:** High
**Source:** Manual request 2026-04-01 -- stale replay prevention with reused-ID safety
**Depends on:** None
**Domain:** orchestrator-reliability

Add an explicit lineage token to the work-item model so a reused ID can be distinguished from an older logical item without relying on title matching. The token should be generated once when a new work item is created, stored in the work-item file, parsed into the in-memory model, and propagated into machine-readable PR metadata so later startup and cleanup paths can recover the same identity after restarts. Do not leave token creation to ad hoc shell snippets or model-generated strings: add a dedicated `nw lineage-token` CLI command and route work-item creation paths, including the `/decompose` skill, through that command.

Lineage token generation must be explicit and platform-backed. In Bun/Node, use the platform CSPRNG (`crypto.randomUUID()` by default, with `crypto.randomBytes(...)` as the only acceptable fallback if formatting requirements force it). Do not derive the token from title, ID, timestamp, branch name, or hashes of those values, and do not use `Math.random()` or LLM-generated output as the token source.

**Test plan:**
- Add parser and format coverage for the new lineage field in `core/work-item-files.ts`, including legacy token-less items remaining parseable during rollout
- Verify `nw lineage-token` produces opaque CSPRNG-backed tokens in the chosen wire format, and that new work-item creation paths use that command rather than generating tokens inline or via model output
- Verify new work-item creation paths stamp a lineage token by default and do not regenerate it on re-read
- Verify the implementer PR template carries the lineage token in a machine-readable `Work Item Reference` block so downstream cleanup logic can recover it from GitHub metadata
- Verify the canonical `/decompose` skill instructions point work-item writers at `nw lineage-token` so new decomposed items do not depend on freeform token generation

Acceptance: Work items support a stable lineage token field that is present on newly created items, preserved across reads, and available in machine-readable PR metadata. `nw lineage-token` exists as the canonical token generator and uses platform CSPRNG, not timestamps, titles, `Math.random()`, or model output. `/decompose` and other work-item creation paths use that command for new items. Existing token-less items still parse and behave via an explicit legacy fallback path.

Key files: `core/work-item-files.ts`, `core/types.ts`, `core/docs/work-item-format.md`, `core/cli.ts`, `core/help.ts`, `core/commands/lineage-token.ts`, `skills/decompose/SKILL.md`, `agents/implementer.md`, `test/work-item-files.test.ts`
