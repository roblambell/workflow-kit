# SUPERSEDED — Consolidated into H-REM-2

This item was originally "Wire tunnels and session viewer into orchestrator workflow." Per CEO review (2026-03-25), the architecture changed:

- One dashboard server instead of per-worker servers
- One tunnel (BYOT) instead of per-worker cloudflared tunnels
- Server + orchestrator wiring consolidated into H-REM-2

This file can be deleted. Dependencies that pointed to M-REM-3 should point to H-REM-2 instead.
