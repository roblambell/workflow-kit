// Bundle directory resolution for ninthwave resources (skills, agents, docs).
//
// Resolution chain:
// 1. NINTHWAVE_HOME env var -- explicit override
// 2. Binary install prefix -- if process.execPath or process.argv[0] is at
//    <prefix>/bin/ninthwave, check <prefix>/share/ninthwave/
// 3. Development fallback -- walk up from this source file to find repo root
//    containing skills/decompose/SKILL.md
// 4. ~/.ninthwave/ -- user-level install fallback

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * Marker file that identifies a valid ninthwave bundle directory.
 * Must exist at <bundleDir>/skills/decompose/SKILL.md.
 */
const BUNDLE_MARKER = join("skills", "decompose", "SKILL.md");

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
 *
 * Tries process.execPath first (Bun guarantees this is the absolute path to the
 * compiled binary), then process.argv[0] as a fallback.
 */
function resolveFromBinaryPrefix(checkExists: (path: string) => boolean = existsSync): string | null {
  // process.execPath is the absolute path to the binary for compiled Bun executables.
  // process.argv[0] may be just the basename in some shell environments.
  const candidates = [process.execPath, process.argv[0]].filter(
    (candidate): candidate is string => Boolean(candidate),
  );

  for (const candidate of candidates) {
    const binDir = dirname(resolve(candidate));
    // binDir should end with /bin for a standard install prefix
    if (!binDir.endsWith("/bin")) continue;

    const prefix = dirname(binDir);
    const shareDir = join(prefix, "share", "ninthwave");
    if (isBundleDir(shareDir, checkExists)) return shareDir;
  }

  return null;
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
 * Resolve from ~/.ninthwave/ (user-level install fallback).
 */
function resolveFromUserHome(checkExists: (path: string) => boolean = existsSync): string | null {
  const home = process.env.HOME;
  if (!home) return null;
  const userDir = join(home, ".ninthwave");
  return isBundleDir(userDir, checkExists) ? userDir : null;
}

/**
 * Resolve the ninthwave bundle directory containing skills, agents, and docs.
 *
 * Resolution order:
 * 1. `NINTHWAVE_HOME` environment variable
 * 2. Binary install prefix (`<prefix>/share/ninthwave/`)
 * 3. Development fallback (walk up from source file to repo root)
 * 4. `~/.ninthwave/` (user-level install)
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

  const fromUserHome = resolveFromUserHome(checkExists);
  if (fromUserHome) return fromUserHome;

  throw new Error(
    "Could not find ninthwave bundle directory. " +
      "Set NINTHWAVE_HOME or install ninthwave properly.",
  );
}
