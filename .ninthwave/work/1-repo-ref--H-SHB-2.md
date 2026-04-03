# Feat: Add repo reference normalization and join verification primitives (H-SHB-2)

**Priority:** High
**Source:** Spec `.opencode/plans/1775207598126-tidy-cactus.md`
**Depends on:** None
**Domain:** repo-ref
**Lineage:** a51d5cda-3545-4dff-ab4f-4dcc49f1870b

Add a shared repo-reference utility that normalizes SSH and HTTPS git URLs, hashes the normalized value, and gives the broker one stable repo identity to persist and compare. This item should define the core rules and tests for `repoUrl`, `repoHash`, and stored `repoRef` handling so later client and runtime work can reject cross-repo joins without duplicating normalization logic.

**Test plan:**
- Add `test/repo-ref.test.ts` covering HTTPS and SSH normalization parity, hash stability, invalid inputs, and equivalent URLs mapping to the same repo reference.
- Verify the utility can accept both raw `repoUrl` and precomputed `repoHash` inputs and produces one canonical comparison value.
- Add targeted assertions for mismatch detection inputs that the runtime and client wiring will rely on later.

Acceptance: `core/repo-ref.ts` exposes the normalization and hashing helpers needed by both client and broker code. Equivalent SSH and HTTPS references normalize consistently, invalid or missing repo identity inputs are handled explicitly, and the new repo-ref test suite passes.

Key files: `core/repo-ref.ts`, `test/repo-ref.test.ts`, `ARCHITECTURE.md`
