# Docs: Update vision and README for production signal pipeline (L-DOC-2)

**Priority:** Low
**Source:** Vision L-VIS-6 — production signal pipeline
**Depends on:** M-OBS-1
**Domain:** docs

Update project documentation to reflect the completed A-quinquies phase and the new production signal pipeline capabilities.

**vision.md changes:**

1. Mark Phase A-quinquies (Surface Area & Onboarding) as complete — all items shipped:
   - CLI polish (CLI-2), nono sandboxing (SBX-1, SBX-2, SBX-3, SBX-4), interactive onboarding (ONB-1, ONB-2), zellij adapter (ZLJ-1), ClickUp adapter (CKU-1), GitHub Action (GHA-1), stacked branches (STK-1 through STK-6), status UI (STA-1 through STA-3)

2. Add Phase A-sexies (Production Signal Pipeline) documenting the Sentry and PagerDuty adapters and CLI integration.

3. Update "What Exists Today" section to include grind cycles 5-6 shipped features.

4. Update Feature-Completeness checklist:
   - Mark "2+ observability/alerting backends" as achieved (Sentry, PagerDuty)
   - Note remaining gap: "Remote session links on PRs with auth"

5. Update Phase E (Expand Surface Area) to reflect shipped items vs remaining.

**README.md changes:**

1. Add Sentry and PagerDuty to the "Work item backends" table under a new "Observability" category
2. Update any feature counts if mentioned (e.g., "N task backends")

Acceptance: vision.md reflects current state accurately. A-quinquies marked complete. A-sexies phase documented. Feature-completeness checklist updated. README includes observability backends. No inaccurate claims about unshipped features.

**Test plan:**
- Review vision.md diff for accuracy against merged PRs
- Verify feature-completeness checklist matches reality
- Verify no stale "in progress" markers for completed phases
- Run `bun test test/` to confirm no regressions

Key files: `vision.md`, `README.md`
