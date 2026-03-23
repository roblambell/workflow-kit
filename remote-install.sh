#!/usr/bin/env bash
# Remote installer for ninthwave.
# Downloads the latest files and runs the install without cloning the repo.
#
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/roblambell/ninthwave/main/remote-install.sh)

set -euo pipefail

REPO="roblambell/ninthwave"
BRANCH="main"
BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"
PROJECT_DIR="$(pwd)"

# Verify we're in a git repo
if [[ ! -d "$PROJECT_DIR/.git" ]]; then
  echo "Error: not a git repository. Run this from your project root."
  exit 1
fi

echo "ninthwave remote install"
echo "Project: $PROJECT_DIR"
echo

# Create a temp directory for downloaded files
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "Downloading ninthwave..."

# Download the full repo as a tarball (much faster than individual files)
if command -v gh &>/dev/null; then
  # Prefer gh for private repos
  gh api "repos/$REPO/tarball/$BRANCH" > "$TMPDIR/archive.tar.gz" 2>/dev/null
else
  curl -fsSL "https://api.github.com/repos/$REPO/tarball/$BRANCH" \
    -H "Accept: application/vnd.github+json" \
    -o "$TMPDIR/archive.tar.gz"
fi

# Extract
mkdir -p "$TMPDIR/extracted"
tar xzf "$TMPDIR/archive.tar.gz" -C "$TMPDIR/extracted" --strip-components=1

echo "Running installer..."
echo

# Run the install script from the extracted copy
bash "$TMPDIR/extracted/install.sh" --project-dir "$PROJECT_DIR"
