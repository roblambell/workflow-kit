# Docs: Update documentation for 0.2.0 scope reduction (M-NW-6)

**Priority:** Medium
**Source:** Plan: Focus ninthwave to narrowest wedge (0.2.0)
**Depends on:** M-NW-5
**Domain:** scope-reduction

Update all project documentation to reflect the removal of external backends, sandboxing, remote dashboard, webhooks, and migration commands.

**Modify:**
- `ARCHITECTURE.md` -- Remove: "Sandbox Tiers" section, "TaskBackend" section, "SessionUrlProvider" section, "Adding a New Task Backend" extension point. Update Data Flow diagram to remove sandbox/proxy/backend references
- `README.md` -- Remove: "Remote Dashboard" section, "Work item backends" section, sandbox/cloudflared references, `--backend`/`--remote`/`--no-sandbox` flags from CLI reference, `migrate-todos` and `generate-todos` from command list
- `CLAUDE.md` -- Remove nono/sandbox references, update architecture description to reflect slimmed-down CLI
- `CONTRIBUTING.md` -- Remove backend/sandbox contribution guidelines if present
- `VISION.md` -- Update "What Exists Today" to note features were removed as part of narrowing focus
- `CHANGELOG.md` -- Add 0.2.0 entry documenting the scope reduction with a summary of what was removed and why

**Test plan:**
- Manual review -- verify no references to removed features remain in docs
- Run `grep -r "sandbox\|nono\|proxy\|backend\|webhook\|cloudflared\|--remote\|--no-sandbox\|--backend\|migrate-todos\|generate-todos" *.md` and verify only historical references in CHANGELOG remain

Acceptance: All docs updated, no stale references to removed features (except CHANGELOG history), CHANGELOG has 0.2.0 entry.

Key files: `ARCHITECTURE.md`, `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `VISION.md`, `CHANGELOG.md`
