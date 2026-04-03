import { createHash } from "crypto";

const REPO_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const SCP_REPO_URL_PATTERN = /^(?<user>[^@/\s]+)@(?<host>[^:/\s]+):(?<path>.+)$/;
const SUPPORTED_REPO_URL_PROTOCOLS = new Set(["https:", "http:", "ssh:", "git:"]);

export type RepoRefErrorCode =
  | "missing_repo_identity"
  | "invalid_repo_url"
  | "invalid_repo_hash"
  | "invalid_repo_ref"
  | "repo_identity_mismatch";

export class RepoRefError extends Error {
  readonly code: RepoRefErrorCode;

  constructor(code: RepoRefErrorCode, message: string) {
    super(message);
    this.name = "RepoRefError";
    this.code = code;
  }
}

export interface RepoRefInput {
  repoUrl?: string | null;
  repoHash?: string | null;
  repoRef?: string | null;
}

export interface ResolvedRepoRef {
  repoRef: string;
  repoHash: string;
  normalizedRepoUrl?: string;
}

export interface RepoRefComparison {
  matches: boolean;
  left: ResolvedRepoRef;
  right: ResolvedRepoRef;
}

function normalizeRepoLocation(
  host: string,
  rawPath: string,
  errorCode: Extract<RepoRefErrorCode, "invalid_repo_url" | "invalid_repo_ref">,
): string {
  const normalizedHost = host.trim().toLowerCase();
  const normalizedPath = rawPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const pathSegments = normalizedPath.split("/").filter(Boolean);

  if (!normalizedHost || pathSegments.length === 0) {
    throw new RepoRefError(errorCode, `Invalid repo identity: ${host}/${rawPath}`);
  }

  return `${normalizedHost}/${pathSegments.join("/")}`;
}

function normalizeRepoUrlLikeValue(
  value: string,
  errorCode: Extract<RepoRefErrorCode, "invalid_repo_url" | "invalid_repo_ref">,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RepoRefError(errorCode, "Repo identity cannot be empty.");
  }

  const scpMatch = trimmed.match(SCP_REPO_URL_PATTERN);
  if (scpMatch?.groups) {
    const { host, path } = scpMatch.groups as { host: string; path: string };
    return normalizeRepoLocation(
      host,
      path,
      errorCode,
    );
  }

  try {
    const parsed = new URL(trimmed);
    if (!SUPPORTED_REPO_URL_PROTOCOLS.has(parsed.protocol)) {
      throw new RepoRefError(errorCode, `Unsupported repo URL protocol: ${parsed.protocol}`);
    }

    const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    return normalizeRepoLocation(host, parsed.pathname, errorCode);
  } catch (error) {
    if (error instanceof RepoRefError) {
      throw error;
    }
    throw new RepoRefError(errorCode, `Invalid repo URL: ${trimmed}`);
  }
}

function normalizeStoredRepoRef(repoRef: string): string {
  const trimmed = repoRef.trim();
  if (!trimmed) {
    throw new RepoRefError("invalid_repo_ref", "Stored repoRef cannot be empty.");
  }

  if (REPO_HASH_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (trimmed.includes("://") || SCP_REPO_URL_PATTERN.test(trimmed)) {
    return hashNormalizedRepoUrl(normalizeRepoUrlLikeValue(trimmed, "invalid_repo_ref"));
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    throw new RepoRefError("invalid_repo_ref", `Invalid stored repoRef: ${trimmed}`);
  }

  const host = trimmed.slice(0, slashIndex);
  const path = trimmed.slice(slashIndex + 1);
  return hashNormalizedRepoUrl(normalizeRepoLocation(host, path, "invalid_repo_ref"));
}

export function normalizeRepoUrl(repoUrl: string): string {
  return normalizeRepoUrlLikeValue(repoUrl, "invalid_repo_url");
}

export function normalizeRepoHash(repoHash: string): string {
  const normalized = repoHash.trim().toLowerCase();
  if (!REPO_HASH_PATTERN.test(normalized)) {
    throw new RepoRefError("invalid_repo_hash", `Invalid repoHash: ${repoHash}`);
  }
  return normalized;
}

export function hashNormalizedRepoUrl(normalizedRepoUrl: string): string {
  return createHash("sha256").update(normalizedRepoUrl).digest("hex");
}

export function hashRepoUrl(repoUrl: string): string {
  return hashNormalizedRepoUrl(normalizeRepoUrl(repoUrl));
}

export function resolveRepoRef(input: RepoRefInput): ResolvedRepoRef {
  const normalizedRepoUrl = input.repoUrl?.trim()
    ? normalizeRepoUrl(input.repoUrl)
    : undefined;
  const resolvedCandidates = [
    normalizedRepoUrl ? hashNormalizedRepoUrl(normalizedRepoUrl) : null,
    input.repoHash?.trim() ? normalizeRepoHash(input.repoHash) : null,
    input.repoRef?.trim() ? normalizeStoredRepoRef(input.repoRef) : null,
  ].filter((candidate): candidate is string => candidate !== null);

  if (resolvedCandidates.length === 0) {
    throw new RepoRefError(
      "missing_repo_identity",
      "Expected at least one of repoUrl, repoHash, or repoRef.",
    );
  }

  const canonicalRepoRef = resolvedCandidates[0]!;
  const hasMismatch = resolvedCandidates.some((candidate) => candidate !== canonicalRepoRef);
  if (hasMismatch) {
    throw new RepoRefError(
      "repo_identity_mismatch",
      "repoUrl, repoHash, and repoRef must resolve to the same repo identity.",
    );
  }

  return {
    repoRef: canonicalRepoRef,
    repoHash: canonicalRepoRef,
    ...(normalizedRepoUrl ? { normalizedRepoUrl } : {}),
  };
}

export function compareRepoRefs(
  left: RepoRefInput,
  right: RepoRefInput,
): RepoRefComparison {
  const leftResolved = resolveRepoRef(left);
  const rightResolved = resolveRepoRef(right);

  return {
    matches: leftResolved.repoRef === rightResolved.repoRef,
    left: leftResolved,
    right: rightResolved,
  };
}
