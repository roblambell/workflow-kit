// Bundle directory resolution for ninthwave resources (skills, agents, docs).
//
// Resolution chain:
// 1. NINTHWAVE_HOME env var — explicit override
// 2. Binary install prefix — if process.argv[0] is at <prefix>/bin/ninthwave,
//    check <prefix>/share/ninthwave/
// 3. Development fallback — walk up from this source file to find repo root
//    containing skills/work/SKILL.md

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * Marker file that identifies a valid ninthwave bundle directory.
 * Must exist at <bundleDir>/skills/work/SKILL.md.
 */
const BUNDLE_MARKER = join("skills", "work", "SKILL.md");

/**
 * Check whether a directory looks like a valid ninthwave bundle.
 */
function isBundleDir(dir: string, checkExists: (path: string) => boolean = existsSync): boolean {
  return checkExists(join(dir, BUNDLE_MARKER));
}

/**
 * Resolve from NINTHWAVE_HOME env var.
 */
function resolveFromEnv(checkExists: (path: string) => boolean = existsSync): string | null {
  const home = process.env.NINTHWAVE_HOME;
  if (!home) return null;
  const resolved = resolve(home);
  return isBundleDir(resolved, checkExists) ? resolved : null;
}

/**
 * Resolve from binary install prefix.
 * If the binary is at <prefix>/bin/ninthwave, look for <prefix>/share/ninthwave/.
 */
function resolveFromBinaryPrefix(checkExists: (path: string) => boolean = existsSync): string | null {
  const argv0 = process.argv[0];
  if (!argv0) return null;

  const binDir = dirname(resolve(argv0));
  // binDir should end with /bin for a standard install prefix
  if (!binDir.endsWith("/bin")) return null;

  const prefix = dirname(binDir);
  const shareDir = join(prefix, "share", "ninthwave");
  return isBundleDir(shareDir, checkExists) ? shareDir : null;
}

/**
 * Resolve by walking up from this source file to find the repo root.
 * Looks for the bundle marker at each ancestor directory.
 */
function resolveFromDevSource(checkExists: (path: string) => boolean = existsSync): string | null {
  let dir = dirname(resolve(__filename));
  const root = "/";

  while (dir !== root) {
    if (isBundleDir(dir, checkExists)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * Resolve the ninthwave bundle directory containing skills, agents, and docs.
 *
 * Resolution order:
 * 1. `NINTHWAVE_HOME` environment variable
 * 2. Binary install prefix (`<prefix>/share/ninthwave/`)
 * 3. Development fallback (walk up from source file to repo root)
 *
 * @throws {Error} if no valid bundle directory can be found
 */
export function getBundleDir(
  checkExists: (path: string) => boolean = existsSync,
): string {
  const fromEnv = resolveFromEnv(checkExists);
  if (fromEnv) return fromEnv;

  const fromPrefix = resolveFromBinaryPrefix(checkExists);
  if (fromPrefix) return fromPrefix;

  const fromDev = resolveFromDevSource(checkExists);
  if (fromDev) return fromDev;

  throw new Error(
    "Could not find ninthwave bundle directory. " +
      "Set NINTHWAVE_HOME or install ninthwave properly.",
  );
}
