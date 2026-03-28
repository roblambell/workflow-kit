# Feat: Branding, status check rename, agent links, and footer (M-RX-4)

**Priority:** Medium
**Source:** CEO + Eng review 2026-03-28
**Depends on:** M-RX-3
**Domain:** review-experience

Rename status check context from `ninthwave/review` to `Ninthwave / Review` (orchestrator.ts and gh.ts IGNORED_CHECK_NAMES). Update status descriptions: "Review passed: X blockers, Y nits", "Changes requested: X blockers found". Add agent links in PR comments: `**[Reviewer](agents/reviewer.md)**`. Add unconditional branding footer to review comments and initial orchestrator status comments: "---\n*Powered by [Ninthwave](https://ninthwave.dev)*". Update implementer.md PR comment conventions to include agent link pattern.

**Test plan:**
- Verify IGNORED_CHECK_NAMES matches new context string
- Unit test: executePostReview output includes agent link and footer
- Unit test: status descriptions use new format (no em dashes, improved wording)
- Manual: create a test PR and verify Ninthwave / Review appears in GitHub UI

Acceptance: GitHub status check shows `Ninthwave / Review`. Review comments include agent links and branding footer. `bun test test/` passes.

Key files: `core/orchestrator.ts:2062`, `core/gh.ts:207`, `agents/implementer.md`
