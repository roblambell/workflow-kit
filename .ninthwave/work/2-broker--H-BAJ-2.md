# Feat: Add broker-hash HMAC helper (H-BAJ-2)

**Priority:** High
**Source:** Plan: frictionless broker auto-join + anonymized identifiers
**Depends on:** H-BAJ-1
**Domain:** broker
**Lineage:** ffdb143a-292e-4ec5-af3e-473653a06d25

Create `core/broker-hash.ts` exporting `makeBrokerHasher(secret: string)`, a factory that returns a `(value: string) => string` function using HMAC-SHA256 keyed on the base64-decoded `broker_secret`, output encoded as base64url and truncated to 22 characters (132 bits, collision-resistant). Pure module with no call sites in this PR -- callers land in H-BAJ-3. This PR is non-breaking.

**Test plan:**
- New `test/broker-hash.test.ts`: same input + same secret -> same output (stability across calls).
- Different secrets -> different outputs for the same input.
- Empty string input is handled (returns a deterministic non-empty hash).
- Non-Latin / Unicode input hashes stably (same input always produces same output).
- Output length is exactly 22 characters and matches `[A-Za-z0-9_-]+` (base64url charset).
- Verify that an invalid base64 secret throws at factory time (or falls back predictably -- document the chosen behaviour in the test).

Acceptance: `core/broker-hash.ts` exists, exports `makeBrokerHasher`. Unit tests cover all five bullets above. No other files modified. `bun run test` passes.

Key files: `core/broker-hash.ts`, `test/broker-hash.test.ts`
