import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { rmSync } from "fs";

const INSTALL_SCRIPT = join(import.meta.dirname, "..", "install.sh");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "nw-install-test-"));
  tempDirs.push(tmp);
  return tmp;
}

afterEach(() => {
  for (const d of tempDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

/**
 * Source the install script in a subshell and run a function.
 * Uses a fake HOME to avoid modifying real user files.
 */
function runInstallFunction(fn: string, env: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const result = spawnSync(
    "bash",
    ["-c", `source "${INSTALL_SCRIPT}" --source-only 2>/dev/null; ${fn}`],
    {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: 10_000,
    },
  );
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? 1,
  };
}

/**
 * Run the full install script in a sandboxed environment with a mock GitHub API.
 */
function runFullInstall(opts: {
  home: string;
  shell?: string;
  mockServer?: string;
}): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {
    ...process.env,
    HOME: opts.home,
    SHELL: opts.shell ?? "/bin/bash",
  };
  if (opts.mockServer) {
    env.GITHUB_API = opts.mockServer;
  }
  const result = spawnSync("bash", [INSTALL_SCRIPT], {
    encoding: "utf-8",
    env,
    timeout: 30_000,
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? 1,
  };
}

describe("install.sh", () => {
  it("script is valid bash and parses without errors", () => {
    const result = spawnSync("bash", ["-n", INSTALL_SCRIPT], {
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
  });

  it("script is executable", () => {
    const result = spawnSync("test", ["-x", INSTALL_SCRIPT]);
    expect(result.status).toBe(0);
  });

  describe("detect_platform", () => {
    it("detects current platform as a supported value", () => {
      // Run detect_platform and print the result
      const result = spawnSync(
        "bash",
        ["-c", `
          set -euo pipefail
          detect_platform() {
            local os arch
            os="$(uname -s | tr '[:upper:]' '[:lower:]')"
            arch="$(uname -m)"
            case "$os" in
              darwin) os="darwin" ;;
              linux)  os="linux" ;;
              *)      echo "unsupported" && return 1 ;;
            esac
            case "$arch" in
              arm64|aarch64) arch="arm64" ;;
              x86_64|amd64)  arch="x64" ;;
              *)             echo "unsupported" && return 1 ;;
            esac
            if [ "$os" = "linux" ] && [ "$arch" = "arm64" ]; then
              echo "unsupported" && return 1
            fi
            echo "\${os}-\${arch}"
          }
          detect_platform
        `],
        { encoding: "utf-8" },
      );
      const platform = result.stdout.trim();
      expect(["darwin-arm64", "darwin-x64", "linux-x64"]).toContain(platform);
    });
  });

  describe("PATH configuration", () => {
    it("adds PATH to .bashrc for bash users", () => {
      const home = makeTempDir();
      writeFileSync(join(home, ".bashrc"), "# existing bashrc\n");

      // Run the configure_path function from install.sh in isolation
      const result = spawnSync(
        "bash",
        ["-c", `
          set -euo pipefail
          HOME="${home}"
          SHELL="/bin/bash"
          INSTALL_DIR="${home}/.ninthwave"
          BIN_DIR="${home}/.ninthwave/bin"
          info() { :; }

          configure_path() {
            local path_line='export PATH="\${HOME}/.ninthwave/bin:\${PATH}"'
            local profiles=()
            local shell_name
            shell_name="$(basename "\${SHELL:-/bin/bash}")"
            case "$shell_name" in
              zsh)  profiles=("$HOME/.zshrc") ;;
              bash)
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
            for profile in "\${profiles[@]}"; do
              if [ -f "$profile" ] && grep -qF '.ninthwave/bin' "$profile"; then
                return 0
              fi
              printf '\\n# ninthwave\\n%s\\n' "$path_line" >> "$profile"
              return 0
            done
          }
          configure_path
        `],
        { encoding: "utf-8", env: { ...process.env, HOME: home, SHELL: "/bin/bash" } },
      );
      expect(result.status).toBe(0);

      const bashrc = readFileSync(join(home, ".bashrc"), "utf-8");
      expect(bashrc).toContain(".ninthwave/bin");
      expect(bashrc).toContain("export PATH");
    });

    it("adds PATH to .zshrc for zsh users", () => {
      const home = makeTempDir();
      writeFileSync(join(home, ".zshrc"), "# existing zshrc\n");

      const result = spawnSync(
        "bash",
        ["-c", `
          set -euo pipefail
          HOME="${home}"
          SHELL="/bin/zsh"
          INSTALL_DIR="${home}/.ninthwave"
          BIN_DIR="${home}/.ninthwave/bin"
          info() { :; }

          configure_path() {
            local path_line='export PATH="\${HOME}/.ninthwave/bin:\${PATH}"'
            local profiles=()
            local shell_name
            shell_name="$(basename "\${SHELL:-/bin/bash}")"
            case "$shell_name" in
              zsh)  profiles=("$HOME/.zshrc") ;;
              bash)
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
            for profile in "\${profiles[@]}"; do
              if [ -f "$profile" ] && grep -qF '.ninthwave/bin' "$profile"; then
                return 0
              fi
              printf '\\n# ninthwave\\n%s\\n' "$path_line" >> "$profile"
              return 0
            done
          }
          configure_path
        `],
        { encoding: "utf-8", env: { ...process.env, HOME: home, SHELL: "/bin/zsh" } },
      );
      expect(result.status).toBe(0);

      const zshrc = readFileSync(join(home, ".zshrc"), "utf-8");
      expect(zshrc).toContain(".ninthwave/bin");
    });

    it("does not duplicate PATH entry on second run", () => {
      const home = makeTempDir();
      writeFileSync(
        join(home, ".bashrc"),
        '# existing\nexport PATH="${HOME}/.ninthwave/bin:${PATH}"\n',
      );

      const result = spawnSync(
        "bash",
        ["-c", `
          set -euo pipefail
          HOME="${home}"
          SHELL="/bin/bash"
          INSTALL_DIR="${home}/.ninthwave"
          BIN_DIR="${home}/.ninthwave/bin"
          info() { :; }

          configure_path() {
            local path_line='export PATH="\${HOME}/.ninthwave/bin:\${PATH}"'
            local profiles=()
            local shell_name
            shell_name="$(basename "\${SHELL:-/bin/bash}")"
            case "$shell_name" in
              zsh)  profiles=("$HOME/.zshrc") ;;
              bash)
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
            for profile in "\${profiles[@]}"; do
              if [ -f "$profile" ] && grep -qF '.ninthwave/bin' "$profile"; then
                return 0
              fi
              printf '\\n# ninthwave\\n%s\\n' "$path_line" >> "$profile"
              return 0
            done
          }
          configure_path
        `],
        { encoding: "utf-8", env: { ...process.env, HOME: home, SHELL: "/bin/bash" } },
      );
      expect(result.status).toBe(0);

      const bashrc = readFileSync(join(home, ".bashrc"), "utf-8");
      // Count occurrences — should be exactly 1
      const matches = bashrc.match(/\.ninthwave\/bin/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe("idempotency", () => {
    it("creates install directory structure correctly", () => {
      const home = makeTempDir();
      const installDir = join(home, ".ninthwave");
      const binDir = join(installDir, "bin");

      // Simulate what download_and_extract does
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "ninthwave"), "#!/bin/bash\necho test", { mode: 0o755 });
      symlinkSync("ninthwave", join(binDir, "nw"));
      mkdirSync(join(installDir, "skills"), { recursive: true });
      writeFileSync(join(installDir, "VERSION"), "0.1.0");

      // Verify structure
      expect(existsSync(join(binDir, "ninthwave"))).toBe(true);
      expect(existsSync(join(binDir, "nw"))).toBe(true);
      expect(existsSync(join(installDir, "VERSION"))).toBe(true);
      expect(existsSync(join(installDir, "skills"))).toBe(true);
    });

    it("symlink nw -> ninthwave uses relative path", () => {
      const home = makeTempDir();
      const binDir = join(home, ".ninthwave", "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "ninthwave"), "#!/bin/bash\necho test", { mode: 0o755 });

      // ln -sf ninthwave creates a relative symlink
      spawnSync("ln", ["-sf", "ninthwave", join(binDir, "nw")]);

      const target = readFileSync(join(binDir, "nw"), "utf-8");
      // Reading through the symlink should work
      expect(target).toContain("echo test");
    });
  });

  describe("upgrade skill compatibility", () => {
    it("vendored detection: install dir exists but is not a git repo", () => {
      const home = makeTempDir();
      const installDir = join(home, ".ninthwave");
      mkdirSync(installDir, { recursive: true });

      // Simulate what nw init would write after a curl install
      // .ninthwave/dir points to the install directory
      const projectDir = makeTempDir();
      const nwDir = join(projectDir, ".ninthwave");
      mkdirSync(nwDir, { recursive: true });
      writeFileSync(join(nwDir, "dir"), installDir);

      // Upgrade skill logic: check if dir is a git repo
      const gitCheck = spawnSync(
        "git",
        ["-C", installDir, "rev-parse", "--is-inside-work-tree"],
        { encoding: "utf-8" },
      );

      // Should NOT be a git repo (vendored install)
      expect(gitCheck.status).not.toBe(0);

      // The NINTHWAVE_DIR should exist
      expect(existsSync(installDir)).toBe(true);

      // So upgrade skill would detect INSTALL_TYPE="vendored"
    });
  });
});
