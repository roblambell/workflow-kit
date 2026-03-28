#!/usr/bin/env bash
# ninthwave installer — curl -fsSL https://ninthwave.sh/install | bash
#
# Installs the latest ninthwave release to ~/.ninthwave/
# Supports: macOS (arm64, x64), Linux (x64)

set -euo pipefail

INSTALL_DIR="${HOME}/.ninthwave"
BIN_DIR="${INSTALL_DIR}/bin"
REPO="ninthwave-sh/ninthwave"
GITHUB_API="https://api.github.com"

# --- Helpers ---

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
error() { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# --- Detect OS and architecture ---

detect_platform() {
  local os arch

  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin) os="darwin" ;;
    linux)  os="linux" ;;
    *)      error "Unsupported OS: $os. ninthwave supports macOS and Linux." ;;
  esac

  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *)             error "Unsupported architecture: $arch. ninthwave supports arm64 and x64." ;;
  esac

  # linux-arm64 is not currently built
  if [ "$os" = "linux" ] && [ "$arch" = "arm64" ]; then
    error "Linux arm64 is not yet supported. ninthwave supports darwin-arm64, darwin-x64, and linux-x64."
  fi

  PLATFORM="${os}-${arch}"
}

# --- Fetch latest release version ---

fetch_latest_version() {
  local url="${GITHUB_API}/repos/${REPO}/releases/latest"
  local response

  if command -v curl &>/dev/null; then
    response="$(curl -fsSL "$url" 2>/dev/null)" || error "Failed to fetch latest release from GitHub. Check your internet connection."
  elif command -v wget &>/dev/null; then
    response="$(wget -qO- "$url" 2>/dev/null)" || error "Failed to fetch latest release from GitHub. Check your internet connection."
  else
    error "Neither curl nor wget found. Install one and retry."
  fi

  # Extract tag_name without jq dependency
  VERSION="$(echo "$response" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/' | sed 's/^v//')"

  if [ -z "$VERSION" ]; then
    error "Could not determine latest version. GitHub API response may have changed."
  fi
}

# --- Download and extract ---

download_and_extract() {
  local tarball="ninthwave-${VERSION}-${PLATFORM}.tar.gz"
  local url="https://github.com/${REPO}/releases/download/v${VERSION}/${tarball}"
  local tmp_dir

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  info "Downloading ninthwave v${VERSION} for ${PLATFORM}..."

  if command -v curl &>/dev/null; then
    curl -fsSL "$url" -o "${tmp_dir}/${tarball}" || error "Failed to download ${url}"
  elif command -v wget &>/dev/null; then
    wget -q "$url" -O "${tmp_dir}/${tarball}" || error "Failed to download ${url}"
  fi

  info "Extracting to ${INSTALL_DIR}..."

  # Extract tarball — contents are in ninthwave-VERSION-PLATFORM/ directory
  tar -xzf "${tmp_dir}/${tarball}" -C "$tmp_dir"

  local extracted_dir="${tmp_dir}/ninthwave-${VERSION}-${PLATFORM}"
  if [ ! -d "$extracted_dir" ]; then
    error "Unexpected tarball structure: expected ${extracted_dir}"
  fi

  # Create install directory structure
  mkdir -p "$BIN_DIR"

  # Copy binary to bin/
  cp "$extracted_dir/ninthwave" "$BIN_DIR/ninthwave"
  chmod +x "$BIN_DIR/ninthwave"

  # Create nw symlink
  ln -sf ninthwave "$BIN_DIR/nw"

  # Copy resource files alongside bin/
  for resource in VERSION skills agents templates; do
    if [ -e "$extracted_dir/$resource" ]; then
      rm -rf "${INSTALL_DIR:?}/$resource"
      cp -r "$extracted_dir/$resource" "$INSTALL_DIR/$resource"
    fi
  done
}

# --- Configure PATH ---

configure_path() {
  local path_line='export PATH="${HOME}/.ninthwave/bin:${PATH}"'
  local profiles=()
  local shell_name

  # Detect user's shell
  shell_name="$(basename "${SHELL:-/bin/bash}")"

  case "$shell_name" in
    zsh)  profiles=("$HOME/.zshrc") ;;
    bash)
      # On macOS, bash reads .bash_profile for login shells
      if [ "$(uname -s)" = "Darwin" ] && [ -f "$HOME/.bash_profile" ]; then
        profiles=("$HOME/.bash_profile")
      elif [ -f "$HOME/.bashrc" ]; then
        profiles=("$HOME/.bashrc")
      else
        profiles=("$HOME/.bashrc")
      fi
      ;;
    *)    profiles=("$HOME/.profile") ;;
  esac

  for profile in "${profiles[@]}"; do
    # Don't duplicate the PATH entry
    if [ -f "$profile" ] && grep -qF '.ninthwave/bin' "$profile"; then
      return 0
    fi

    info "Adding ~/.ninthwave/bin to PATH in ${profile}..."
    printf '\n# ninthwave\n%s\n' "$path_line" >> "$profile"
    return 0
  done
}

# --- Main ---

main() {
  info "ninthwave installer"

  detect_platform
  fetch_latest_version
  download_and_extract
  configure_path

  info "ninthwave v${VERSION} installed successfully!"
  echo ""
  echo "  Binary:  ${BIN_DIR}/ninthwave"
  echo "  Symlink: ${BIN_DIR}/nw"
  echo ""

  # Try to run nw version (may not be in PATH yet for this shell session)
  if "${BIN_DIR}/nw" version &>/dev/null; then
    echo "  Version: $("${BIN_DIR}/nw" version)"
    echo ""
  fi

  # Check if PATH is already configured for this session
  if ! command -v nw &>/dev/null; then
    echo "  Restart your shell or run:"
    echo "    export PATH=\"\${HOME}/.ninthwave/bin:\${PATH}\""
    echo ""
  fi
}

main "$@"
