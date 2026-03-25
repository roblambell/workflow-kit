# Docs: Update vision.md and README for remote session access (L-DOC-3)

**Priority:** Low
**Source:** Vision L-VIS-7 — documentation
**Depends on:** H-REM-1, H-REM-2, M-DX-1
**Domain:** docs

Update vision.md and README.md to reflect the remote session access foundation shipped in grind cycle 7.

**vision.md changes:**
- Add "Phase C-alpha: Remote Session Access Foundation" as a completed section after Phase A-sexies.
- Describe what shipped: orchestrator dashboard server (single server, token-auth), `SessionUrlProvider` pattern for cloud integration, BYOT tunnel model, `nw doctor` command.
- Clarify architecture: one dashboard per orchestration run (not per-worker servers). OSS provides the server, user brings their own tunnel. Cloud adds managed tunneling + persistent domains.
- Update the feature-completeness checklist: mark "Remote session links posted on PRs with auth" as partially achieved (auth-secured local dashboard shipped, managed domains deferred to cloud product).
- Update "What's Next" to reflect Phase C-beta (cloud tunnel provider, Cloudflare Access integration, interactive mode) as cloud-track items.

**README.md changes:**
- Add `--remote` flag documentation to the orchestrate command reference (off by default, secure by default).
- Add `doctor` command to the CLI reference table.
- Document the dashboard: how to access it, how to expose it with a tunneling tool of your choice.
- Note: cloudflared is NOT a prerequisite for OSS — it's one of several tunneling options users can bring.

Acceptance: vision.md has a new completed phase section for C-alpha. README.md documents cloudflared, `--remote` flag, and `nw doctor`. Feature-completeness checklist is updated.

Key files: `vision.md`, `README.md`
