# Security Policy

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting:
https://github.com/ninthwave-sh/ninthwave/security/advisories/new

Alternatively, email security@ninthwave.sh.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Impact assessment (if known)

### What to expect

- Acknowledgement within 48 hours
- Status update within 7 days
- Coordinated disclosure after a fix is available

## Scope

ninthwave is an orchestration tool -- it launches AI coding sessions but does not proxy AI tool calls, intercept responses, or manage API keys. Security concerns specific to the underlying AI tool (Claude Code, OpenCode, Copilot CLI) should be reported to those projects directly.

### In scope

- The ninthwave CLI and daemon (`core/`)
- The orchestrator state machine and event loop
- Git worktree and branch management
- PR creation and merge automation
- The install script
- GitHub Actions workflows (`.github/workflows/`)

### Out of scope

- Vulnerabilities in AI coding tools launched by ninthwave
- Issues in user project code being orchestrated
