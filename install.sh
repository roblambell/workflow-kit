#!/usr/bin/env bash
# Install workflow-kit into a project directory.
#
# Usage: ./install.sh [--project-dir /path/to/project]
#
# All artifacts are project-level (committed to git) so every team member
# gets them regardless of which AI tool they use. No per-user setup needed.
#
# Dependencies (per-user, not installed by this script):
#   - An AI coding tool (Claude Code, OpenCode, Copilot CLI, etc.)
#   - gstack (for /review, /qa, /design-review)
#   - cmux (for parallel sessions)
#   - gh (for PR operations)

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
      echo "Installs workflow-kit into the project. All files are project-level"
      echo "(committed to git) so every team member gets them automatically."
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

# --- Core files ---

echo "Core files..."

mkdir -p "$PROJECT_DIR/scripts"
cp "$SCRIPT_DIR/core/batch-todos.sh" "$PROJECT_DIR/scripts/batch-todos.sh"
chmod +x "$PROJECT_DIR/scripts/batch-todos.sh"
echo "  scripts/batch-todos.sh"

mkdir -p "$PROJECT_DIR/docs/guides"
cp "$SCRIPT_DIR/core/docs/todos-format.md" "$PROJECT_DIR/docs/guides/todos-format.md"
echo "  docs/guides/todos-format.md"

if [[ ! -f "$PROJECT_DIR/TODOS.md" ]]; then
  cat > "$PROJECT_DIR/TODOS.md" << 'EOF'
# TODOS

<!-- Format guide: docs/guides/todos-format.md -->
EOF
  echo "  TODOS.md (created)"
else
  echo "  TODOS.md (exists, skipped)"
fi

echo

# --- Project config ---

echo "Config..."

mkdir -p "$PROJECT_DIR/.workflow-kit"

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
  echo "  .workflow-kit/config (exists, skipped)"
fi

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
  echo "  .workflow-kit/domains.conf (exists, skipped)"
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
  echo "  .gitignore (created)"
fi

echo

# --- Skills (cross-tool, one location) ---

echo "Skills (cross-tool, .agents/skills/)..."

for skill in todos decompose todo-preview; do
  mkdir -p "$PROJECT_DIR/.agents/skills/$skill"
  cp "$SCRIPT_DIR/skills/$skill/SKILL.md" "$PROJECT_DIR/.agents/skills/$skill/SKILL.md"
  echo "  .agents/skills/$skill/SKILL.md"
done

echo

# --- Agent (all tool directories, unconditionally) ---
# No detection needed. The agent file is small and installing to all
# directories means any team member works regardless of their AI tool.

echo "Agent (all tool directories)..."

mkdir -p "$PROJECT_DIR/.claude/agents"
cp "$SCRIPT_DIR/agents/todo-worker.md" "$PROJECT_DIR/.claude/agents/todo-worker.md"
echo "  .claude/agents/todo-worker.md"

mkdir -p "$PROJECT_DIR/.opencode/agents"
cp "$SCRIPT_DIR/agents/todo-worker.md" "$PROJECT_DIR/.opencode/agents/todo-worker.md"
echo "  .opencode/agents/todo-worker.md"

mkdir -p "$PROJECT_DIR/.github/agents"
cp "$SCRIPT_DIR/agents/todo-worker.md" "$PROJECT_DIR/.github/agents/todo-worker.agent.md"
echo "  .github/agents/todo-worker.agent.md"

echo

# --- Version tracking ---

local_version="$(cd "$SCRIPT_DIR" && git describe --tags --always 2>/dev/null || echo "unknown")"
echo "$local_version" > "$PROJECT_DIR/.workflow-kit/version"

# --- Summary ---

echo "Done! All files are project-level (commit to git)."
echo
echo "Next steps:"
echo "  1. Review: git diff"
echo "  2. Commit: git add -A && git commit -m 'chore: install workflow-kit'"
echo "  3. Add TODOs to TODOS.md and run /todos"
echo
echo "Per-user dependencies (each team member installs once):"
command -v gh &>/dev/null      && echo "  gh:     installed" || echo "  gh:     https://cli.github.com/"
command -v cmux &>/dev/null    && echo "  cmux:   installed" || echo "  cmux:   https://cmux.com/"
echo
echo "Optional: install gstack for /review, /qa, /design-review skills"
echo "  https://github.com/garrytan/gstack"
echo "  Or bring your own -- any SKILL.md with matching names will work."
