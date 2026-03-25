# Docs: Update vision.md and README for remote session access (L-DOC-3)

**Priority:** Low
**Source:** Vision L-VIS-7 — documentation
**Depends on:** REM-*, DX-*
**Domain:** docs

Update vision.md and README.md to reflect the remote session access foundation shipped in grind cycle 7.

**vision.md changes:**
- Add "Phase C-alpha: Remote Session Access Foundation" as a completed section after Phase A-sexies.
- Describe what shipped: cloudflared tunnel management, session viewer server, orchestrator integration, `nw doctor` command.
- Update the feature-completeness checklist: mark "Remote session links posted on PRs with auth" as partially achieved (foundation shipped, Cloudflare Access auth deferred to Phase C-beta).
- Update "What's Next" to reflect Phase C-beta (auth layer, interactive mode) as the next step for remote access.

**README.md changes:**
- Add cloudflared as an optional prerequisite in the prerequisites table.
- Add `--remote` flag documentation to the orchestrate command reference.
- Add `doctor` command to the CLI reference table.
- Update the "What You Get" section to mention remote session access capability.

Acceptance: vision.md has a new completed phase section for C-alpha. README.md documents cloudflared, `--remote` flag, and `nw doctor`. Feature-completeness checklist is updated.

Key files: `vision.md`, `README.md`
