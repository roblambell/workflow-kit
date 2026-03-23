#!/usr/bin/env bash
# Remote installer for ninthwave.
# Clones ninthwave and runs setup in the current project.
#
# Global install (recommended):
#   bash <(curl -fsSL https://raw.githubusercontent.com/ninthwave-sh/ninthwave/main/remote-install.sh)
#
# Per-project install:
#   bash <(curl -fsSL https://raw.githubusercontent.com/ninthwave-sh/ninthwave/main/remote-install.sh) --local

set -euo pipefail

REPO="https://github.com/ninthwave-sh/ninthwave.git"
INSTALL_TYPE="global"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) INSTALL_TYPE="local"; shift ;;
    -h|--help)
      echo "Usage: $0 [--local]"
      echo
      echo "  (default)  Global install to ~/.claude/skills/ninthwave"
      echo "  --local    Per-project install to .claude/skills/ninthwave"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

PROJECT_DIR="$(pwd)"

# Verify we're in a git repo
if [[ ! -d "$PROJECT_DIR/.git" ]]; then
  echo "Error: not a git repository. Run this from your project root."
  exit 1
fi

echo "ninthwave install"
echo "Project: $PROJECT_DIR"
echo "Type: $INSTALL_TYPE"
echo

if [[ "$INSTALL_TYPE" == "global" ]]; then
  INSTALL_DIR="$HOME/.claude/skills/ninthwave"
  if [[ -d "$INSTALL_DIR" ]]; then
    echo "Updating existing global install..."
    git -C "$INSTALL_DIR" pull --ff-only origin main
  else
    echo "Cloning ninthwave..."
    git clone "$REPO" "$INSTALL_DIR"
  fi
else
  INSTALL_DIR="$PROJECT_DIR/.claude/skills/ninthwave"
  if [[ -d "$INSTALL_DIR" ]]; then
    echo "Updating existing local install..."
    # Vendored -- re-download
    TMPDIR="$(mktemp -d)"
    trap 'rm -rf "$TMPDIR"' EXIT
    if command -v gh &>/dev/null; then
      gh api "repos/ninthwave-sh/ninthwave/tarball/main" > "$TMPDIR/archive.tar.gz" 2>/dev/null
    else
      curl -fsSL "https://api.github.com/repos/ninthwave-sh/ninthwave/tarball/main" \
        -H "Accept: application/vnd.github+json" \
        -o "$TMPDIR/archive.tar.gz"
    fi
    mkdir -p "$INSTALL_DIR"
    tar xzf "$TMPDIR/archive.tar.gz" -C "$INSTALL_DIR" --strip-components=1
  else
    echo "Downloading ninthwave..."
    TMPDIR="$(mktemp -d)"
    trap 'rm -rf "$TMPDIR"' EXIT
    if command -v gh &>/dev/null; then
      gh api "repos/ninthwave-sh/ninthwave/tarball/main" > "$TMPDIR/archive.tar.gz" 2>/dev/null
    else
      curl -fsSL "https://api.github.com/repos/ninthwave-sh/ninthwave/tarball/main" \
        -H "Accept: application/vnd.github+json" \
        -o "$TMPDIR/archive.tar.gz"
    fi
    mkdir -p "$INSTALL_DIR"
    tar xzf "$TMPDIR/archive.tar.gz" -C "$INSTALL_DIR" --strip-components=1
  fi
fi

echo
echo "Running setup..."
echo

"$INSTALL_DIR/setup" --project-dir "$PROJECT_DIR"
