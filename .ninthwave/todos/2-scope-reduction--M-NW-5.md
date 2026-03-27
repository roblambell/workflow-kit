# Refactor: Config cleanup, Homebrew formula, and version bump (M-NW-5)

**Priority:** Medium
**Source:** Plan: Focus ninthwave to narrowest wedge (0.2.0)
**Depends on:** H-NW-1, H-NW-2, H-NW-3, H-NW-4
**Domain:** scope-reduction

Final verification pass after all removals. Ensure no dead config keys, imports, or references remain. Update Homebrew formula to remove nono dependency. Bump version to 0.2.0.

**Steps:**
1. `core/config.ts` -- Verify `KNOWN_CONFIG_KEYS` array contains only live keys (14 keys should have been removed by H-NW-1 through H-NW-3)
2. `homebrew/ninthwave.rb` -- Remove `depends_on "nono"` (line 17)
3. Run comprehensive dead-reference scan: `grep -r "backends/\|backend-registry\|sandbox\|proxy-launcher\|session-server\|webhooks\|migrate-todos\|StatusSync\|TaskBackend\|wrapWithSandbox\|startProxy\|startDashboard\|checkNono\|checkCloudflared\|checkWebhookUrl" core/ test/`
4. Fix any remaining references found
5. Run `bun test test/` to verify everything passes
6. Update `VERSION` file to `0.2.0`

**Test plan:**
- Run `bun test test/` -- full test suite must pass with zero failures
- Verify dead-reference grep returns zero results
- Verify `cat VERSION` shows `0.2.0`
- Verify `brew audit homebrew/ninthwave.rb` passes (if brew available)

Acceptance: No dead references in codebase, Homebrew formula updated, VERSION is 0.2.0, full test suite green.

Key files: `core/config.ts`, `homebrew/ninthwave.rb`, `VERSION`
