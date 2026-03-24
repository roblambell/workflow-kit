# TODOS

## Cloud Infrastructure

### Feat: Upgrade CI runners (M-CI-1)

**Priority:** Medium
**Source:** Manual request 2026-03-22
**Depends on:** None

Upgrade test CI runners from 2 to 4 vCPUs for faster execution.

**Test plan:**
- Verify updated workflow YAML specifies 4 vCPU runner labels
- Check deploy workflows still reference 2 vCPU runners
- Edge case: ensure ARM vs x86 platform is unchanged

Acceptance: Test workflows use 4 vCPU runners. Deploy workflows remain on 2 vCPU.

Key files: `.github/workflows/test-api.yml`, `.github/workflows/ci.yml`

---

### Fix: Flaky connection pool timeout (H-CI-2)

**Priority:** High
**Source:** Eng review 2026-03-22
**Depends on:** M-CI-1

Fix intermittent connection pool timeout errors in test suite by increasing pool size.

**Test plan:**
- Add unit test for pool size env var override
- Run full test suite to confirm no more timeout errors

Acceptance: No more timeout errors in CI. Pool size configurable via env var.

Key files: `config/test.exs`

---

## User Onboarding

### Feat: Add welcome email (C-UO-1)

**Priority:** Critical
**Source:** Product review 2026-03-20
**Depends on:** None

Send a welcome email when a new user completes onboarding.

Acceptance: Email sent within 30s of onboarding completion. Email contains user name.

Key files: `lib/onboarding/email.ex`, `lib/mailer.ex`

---

### Feat: Add onboarding checklist (H-UO-2)

**Priority:** High
**Source:** Product review 2026-03-20
**Depends on:** C-UO-1, M-CI-1
**Bundle with:** H-CI-2

Display an onboarding checklist on the dashboard after signup.

Acceptance: Checklist shows on first login. Items check off as completed.

Key files: `lib/onboarding/checklist.ex`, `assets/js/checklist.tsx`

---
