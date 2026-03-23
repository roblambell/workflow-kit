#!/usr/bin/env bash
# Install workflow-kit into a project directory.
#
# Usage: ./install.sh [--project-dir /path/to/project]
#
# Auto-detects installed AI tools and places skills + agents in the
# right directories. All tools that support the SKILL.md standard
# (Claude Code, OpenCode, Copilot CLI, Codex, Gemini CLI, Cursor, etc.)
# discover skills from .agents/skills/ -- the cross-tool convention.
#
# Dependencies: gstack (for /review, /qa, /design-review)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Defaults
PROJECT_DIR=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--project-dir /path/to/project]"
      echo
      echo "Auto-detects installed AI tools and places files accordingly."
      echo "Skills use the cross-tool .agents/skills/ convention."
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Default to current directory
PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"

# Verify it's a git repo
if [[ ! -d "$PROJECT_DIR/.git" ]]; then
  echo "Error: $PROJECT_DIR is not a git repository"
  exit 1
fi

echo "Installing workflow-kit into: $PROJECT_DIR"
echo

# --- Detect installed AI tools ---

echo "Detecting AI tools..."
TOOLS_FOUND=()

if command -v claude &>/dev/null; then
  TOOLS_FOUND+=("claude")
  echo "  Claude Code: found"
fi

if command -v opencode &>/dev/null; then
  TOOLS_FOUND+=("opencode")
  echo "  OpenCode: found"
fi

if command -v copilot &>/dev/null; then
  TOOLS_FOUND+=("copilot")
  echo "  Copilot CLI: found"
fi

if command -v codex &>/dev/null; then
  TOOLS_FOUND+=("codex")
  echo "  Codex: found"
fi

if [[ ${#TOOLS_FOUND[@]} -eq 0 ]]; then
  echo "  No AI tools detected (will install files anyway)"
fi
echo

# --- Check gstack dependency ---

echo "Checking dependencies..."
GSTACK_FOUND=false
if [[ -d "$HOME/.claude/skills/gstack" ]] || [[ -d "$HOME/.agents/skills/gstack" ]] || [[ -d "$HOME/.codex/skills/gstack" ]]; then
  GSTACK_FOUND=true
  echo "  gstack: found"
else
  echo "  gstack: NOT FOUND"
  echo
  echo "  workflow-kit depends on gstack for /review, /qa, and /design-review."
  echo "  Install gstack: https://garryslist.org"
  echo "  Continuing without gstack -- core TODO workflow will work,"
  echo "  but workers won't have code review capabilities."
fi
echo

# --- Core files ---

echo "Installing core files..."

# batch-todos.sh
mkdir -p "$PROJECT_DIR/scripts"
cp "$SCRIPT_DIR/core/batch-todos.sh" "$PROJECT_DIR/scripts/batch-todos.sh"
chmod +x "$PROJECT_DIR/scripts/batch-todos.sh"
echo "  scripts/batch-todos.sh"

# TODOS format guide
mkdir -p "$PROJECT_DIR/docs/guides"
cp "$SCRIPT_DIR/core/docs/todos-format.md" "$PROJECT_DIR/docs/guides/todos-format.md"
echo "  docs/guides/todos-format.md"

# TODOS.md (only if it doesn't exist)
if [[ ! -f "$PROJECT_DIR/TODOS.md" ]]; then
  cat > "$PROJECT_DIR/TODOS.md" << 'EOF'
# TODOS

<!-- Format guide: docs/guides/todos-format.md -->
EOF
  echo "  TODOS.md (created)"
else
  echo "  TODOS.md (already exists, skipped)"
fi

# .workflow-kit directory
mkdir -p "$PROJECT_DIR/.workflow-kit"

# Sample config (only if it doesn't exist)
if [[ ! -f "$PROJECT_DIR/.workflow-kit/config" ]]; then
  cat > "$PROJECT_DIR/.workflow-kit/config" << 'CONF'
# workflow-kit project configuration
# All settings are optional -- sensible defaults are used.

# File extensions for LOC counting in version-bump (space-separated glob patterns)
# LOC_EXTENSIONS="*.ts *.tsx *.js *.jsx *.py *.go"

# Path to domain mapping file (optional)
# DOMAINS_FILE=.workflow-kit/domains.conf
CONF
  echo "  .workflow-kit/config (created)"
else
  echo "  .workflow-kit/config (already exists, skipped)"
fi

# Sample domains.conf (only if it doesn't exist)
if [[ ! -f "$PROJECT_DIR/.workflow-kit/domains.conf" ]]; then
  cat > "$PROJECT_DIR/.workflow-kit/domains.conf" << 'DOMAINS'
# Domain mappings for batch-todos.sh
# Format: pattern=domain_key
# Patterns are matched case-insensitively against section headers in TODOS.md.
# Lines starting with # are comments.
#
# Examples:
# auth=auth
# infrastructure=infra
# frontend=frontend
# database=db
DOMAINS
  echo "  .workflow-kit/domains.conf (created)"
else
  echo "  .workflow-kit/domains.conf (already exists, skipped)"
fi

# Ensure .gitignore has worktree entries
if [[ -f "$PROJECT_DIR/.gitignore" ]]; then
  if ! grep -q "^\.worktrees/" "$PROJECT_DIR/.gitignore" 2>/dev/null; then
    echo "" >> "$PROJECT_DIR/.gitignore"
    echo "# workflow-kit worktrees" >> "$PROJECT_DIR/.gitignore"
    echo ".worktrees/" >> "$PROJECT_DIR/.gitignore"
    echo "  .gitignore (added .worktrees/)"
  fi
else
  cat > "$PROJECT_DIR/.gitignore" << 'GITIGNORE'
# workflow-kit worktrees
.worktrees/
GITIGNORE
  echo "  .gitignore (created with .worktrees/)"
fi

echo

# --- Skills (cross-tool via .agents/skills/) ---

echo "Installing skills..."

# .agents/skills/ is the cross-tool convention discovered by:
# Claude Code, OpenCode, Copilot CLI, Codex, Gemini CLI, Cursor, Kiro, and others
for skill in todos decompose todo-preview; do
  mkdir -p "$PROJECT_DIR/.agents/skills/$skill"
  cp "$SCRIPT_DIR/skills/$skill/SKILL.md" "$PROJECT_DIR/.agents/skills/$skill/SKILL.md"
  echo "  .agents/skills/$skill/SKILL.md"
done

echo

# --- Agent (tool-specific directories) ---

echo "Installing todo-worker agent..."

# Place agent in each detected tool's agent directory.
# The content is identical -- only the path differs.
AGENT_INSTALLED=false

# Claude Code
if [[ " ${TOOLS_FOUND[*]:-} " == *" claude "* ]] || [[ -d "$PROJECT_DIR/.claude" ]]; then
  mkdir -p "$PROJECT_DIR/.claude/agents"
  cp "$SCRIPT_DIR/agents/todo-worker.md" "$PROJECT_DIR/.claude/agents/todo-worker.md"
  echo "  .claude/agents/todo-worker.md"
  AGENT_INSTALLED=true
fi

# OpenCode
if [[ " ${TOOLS_FOUND[*]:-} " == *" opencode "* ]] || [[ -d "$PROJECT_DIR/.opencode" ]]; then
  mkdir -p "$PROJECT_DIR/.opencode/agents"
  cp "$SCRIPT_DIR/agents/todo-worker.md" "$PROJECT_DIR/.opencode/agents/todo-worker.md"
  echo "  .opencode/agents/todo-worker.md"
  AGENT_INSTALLED=true
fi

# Copilot CLI
if [[ " ${TOOLS_FOUND[*]:-} " == *" copilot "* ]] || [[ -d "$PROJECT_DIR/.github/agents" ]]; then
  mkdir -p "$PROJECT_DIR/.github/agents"
  # Copilot uses .agent.md suffix
  cp "$SCRIPT_DIR/agents/todo-worker.md" "$PROJECT_DIR/.github/agents/todo-worker.agent.md"
  echo "  .github/agents/todo-worker.agent.md"
  AGENT_INSTALLED=true
fi

# Fallback: if no tools detected, install to .agents/ (cross-tool) and .claude/ (most common)
if ! $AGENT_INSTALLED; then
  mkdir -p "$PROJECT_DIR/.claude/agents"
  cp "$SCRIPT_DIR/agents/todo-worker.md" "$PROJECT_DIR/.claude/agents/todo-worker.md"
  echo "  .claude/agents/todo-worker.md (default)"
fi

echo

# --- Version tracking ---

local_version="$(cd "$SCRIPT_DIR" && git describe --tags --always 2>/dev/null || echo "unknown")"
echo "$local_version" > "$PROJECT_DIR/.workflow-kit/version"
echo "  .workflow-kit/version ($local_version)"

echo
echo "Done! Next steps:"
echo "  1. Review the installed files: git diff"
echo "  2. Commit: git add -A && git commit -m 'chore: install workflow-kit'"
echo "  3. Add TODOs to TODOS.md and run /todos to start processing"
if ! $GSTACK_FOUND; then
  echo
  echo "  Install gstack for /review, /qa, /design-review: https://garryslist.org"
fi
echo
echo "To update later, re-run this install script and review the diff."
