// Shared TUI settings metadata used by startup selection and runtime controls.

import type { MergeStrategy } from "./orchestrator.ts";

export type StartupReviewMode = "off" | "on";
export type ReviewMode = "off" | "on";

export type StartupCollaborationMode = "local" | "share" | "join";
export type CollaborationIntent = StartupCollaborationMode;
export type CollaborationMode = "local" | "shared" | "joined";

export type PersistedMergeStrategy = Extract<MergeStrategy, "auto" | "manual">;
export type PersistedReviewMode = StartupReviewMode;
export type PersistedCollaborationMode = StartupCollaborationMode;

export interface TuiSettingsDefaults {
  mergeStrategy: PersistedMergeStrategy;
  reviewMode: PersistedReviewMode;
  collaborationMode: PersistedCollaborationMode;
}

export interface ChoiceSettingOption<PersistedValue extends string, RuntimeValue extends string> {
  persistedValue: PersistedValue;
  runtimeValue: RuntimeValue;
  startupLabel: string;
  startupDescription: string;
  runtimeLabel: string;
  runtimeKey?: string;
  persistable: boolean;
}

export type TuiSettingsRow = (typeof TUI_SETTINGS_ROWS)[number];
export type TuiSettingsChoiceRow = Extract<TuiSettingsRow, { kind: "choice" }>;

export const TUI_SETTINGS_DEFAULTS: TuiSettingsDefaults = {
  mergeStrategy: "manual",
  reviewMode: "on",
  collaborationMode: "local",
};

export const COLLABORATION_MODE_OPTIONS: readonly ChoiceSettingOption<PersistedCollaborationMode, CollaborationMode>[] = [
  {
    persistedValue: "local",
    runtimeValue: "local",
    startupLabel: "local",
    startupDescription: "Local by default, no connection",
    runtimeLabel: "Local",
    runtimeKey: "1",
    persistable: true,
  },
  {
    persistedValue: "share",
    runtimeValue: "shared",
    startupLabel: "share",
    startupDescription: "Share this session for collaboration",
    runtimeLabel: "Share",
    runtimeKey: "2",
    persistable: true,
  },
  {
    persistedValue: "join",
    runtimeValue: "joined",
    startupLabel: "join",
    startupDescription: "Join an existing session",
    runtimeLabel: "Join",
    runtimeKey: "3",
    persistable: true,
  },
] as const;

export const STARTUP_COLLABORATION_MODE_OPTIONS = [
  COLLABORATION_MODE_OPTIONS[0]!,
  COLLABORATION_MODE_OPTIONS[1]!,
  COLLABORATION_MODE_OPTIONS[2]!,
] as const;

export const REVIEW_MODE_OPTIONS: readonly ChoiceSettingOption<PersistedReviewMode, ReviewMode>[] = [
  {
    persistedValue: "off",
    runtimeValue: "off",
    startupLabel: "off",
    startupDescription: "No AI reviews",
    runtimeLabel: "Off",
    runtimeKey: "4",
    persistable: true,
  },
  {
    persistedValue: "on",
    runtimeValue: "on",
    startupLabel: "on",
    startupDescription: "AI reviews enabled",
    runtimeLabel: "On",
    runtimeKey: "5",
    persistable: true,
  },
] as const;

export const STARTUP_REVIEW_MODE_OPTIONS = [
  REVIEW_MODE_OPTIONS[1]!,
  REVIEW_MODE_OPTIONS[0]!,
] as const;

export const MERGE_STRATEGY_OPTIONS: readonly ChoiceSettingOption<PersistedMergeStrategy, MergeStrategy>[] = [
  {
    persistedValue: "manual",
    runtimeValue: "manual",
    startupLabel: "manual",
    startupDescription: "CI must pass, then a human merges the PR",
    runtimeLabel: "Manual",
    runtimeKey: "7",
    persistable: true,
  },
  {
    persistedValue: "auto",
    runtimeValue: "auto",
    startupLabel: "auto",
    startupDescription: "CI must pass, then ninthwave auto-merges the PR",
    runtimeLabel: "Auto",
    runtimeKey: "8",
    persistable: true,
  },
  {
    persistedValue: "manual",
    runtimeValue: "bypass",
    startupLabel: "bypass",
    startupDescription: "CI must pass, then ninthwave admin-merges without human approval requirements",
    runtimeLabel: "Bypass",
    runtimeKey: "9",
    persistable: false,
  },
] as const;

export const STARTUP_MERGE_STRATEGY_OPTIONS = [
  MERGE_STRATEGY_OPTIONS[1]!,
  MERGE_STRATEGY_OPTIONS[0]!,
] as const;

export const TUI_SETTINGS_ROWS = [
  {
    id: "collaboration_mode",
    title: "Collaboration",
    kind: "choice",
    options: COLLABORATION_MODE_OPTIONS,
  },
  {
    id: "review_mode",
    title: "Reviews",
    kind: "choice",
    options: REVIEW_MODE_OPTIONS,
  },
  {
    id: "merge_strategy",
    title: "Merge",
    kind: "choice",
    options: MERGE_STRATEGY_OPTIONS,
  },
  {
    id: "session_limit",
    title: "Session Limit",
    kind: "number",
    min: 1,
  },
] as const;

function hasPersistedValue<PersistedValue extends string, RuntimeValue extends string>(
  options: readonly ChoiceSettingOption<PersistedValue, RuntimeValue>[],
  value: unknown,
): value is PersistedValue {
  return options.some((option) => option.persistable && option.persistedValue === value);
}

function getByRuntimeValue<PersistedValue extends string, RuntimeValue extends string>(
  options: readonly ChoiceSettingOption<PersistedValue, RuntimeValue>[],
  value: RuntimeValue,
): ChoiceSettingOption<PersistedValue, RuntimeValue> {
  const option = options.find((candidate) => candidate.runtimeValue === value);
  if (!option) {
    throw new Error(`Unknown TUI settings runtime value: ${String(value)}`);
  }
  return option;
}

function getByPersistedValue<PersistedValue extends string, RuntimeValue extends string>(
  options: readonly ChoiceSettingOption<PersistedValue, RuntimeValue>[],
  value: PersistedValue,
): ChoiceSettingOption<PersistedValue, RuntimeValue> {
  const option = options.find((candidate) => candidate.persistable && candidate.persistedValue === value);
  if (!option) {
    throw new Error(`Unknown TUI settings persisted value: ${String(value)}`);
  }
  return option;
}

export function isPersistedMergeStrategy(value: unknown): value is PersistedMergeStrategy {
  return hasPersistedValue(MERGE_STRATEGY_OPTIONS, value);
}

export function isPersistedReviewMode(value: unknown): value is PersistedReviewMode {
  return hasPersistedValue(REVIEW_MODE_OPTIONS, value);
}

/**
 * Normalize a persisted review mode value, accepting legacy values ("mine", "all")
 * and mapping them to "on". Returns undefined for unrecognized values.
 */
export function normalizePersistedReviewMode(value: unknown): PersistedReviewMode | undefined {
  if (value === "on" || value === "off") return value;
  if (value === "mine" || value === "all") return "on";
  return undefined;
}

export function isPersistedCollaborationMode(value: unknown): value is PersistedCollaborationMode {
  return hasPersistedValue(COLLABORATION_MODE_OPTIONS, value);
}

export function persistedReviewModeToRuntime(mode: PersistedReviewMode): ReviewMode {
  return getByPersistedValue(REVIEW_MODE_OPTIONS, mode).runtimeValue;
}

export function persistedCollaborationModeToRuntime(mode: PersistedCollaborationMode): CollaborationMode {
  return getByPersistedValue(COLLABORATION_MODE_OPTIONS, mode).runtimeValue;
}

export function mergeStrategyToPersisted(mode: MergeStrategy): PersistedMergeStrategy | undefined {
  const option = getByRuntimeValue(MERGE_STRATEGY_OPTIONS, mode);
  return option.persistable ? option.persistedValue : undefined;
}

export function reviewModeToPersisted(mode: ReviewMode): PersistedReviewMode {
  return getByRuntimeValue(REVIEW_MODE_OPTIONS, mode).persistedValue;
}

export function collaborationModeToPersisted(mode: CollaborationMode): PersistedCollaborationMode {
  return getByRuntimeValue(COLLABORATION_MODE_OPTIONS, mode).persistedValue;
}

export function collaborationIntentToMode(intent: CollaborationIntent): CollaborationMode {
  switch (intent) {
    case "local":
      return "local";
    case "share":
      return "shared";
    case "join":
      return "joined";
  }
}

export function collaborationIntentFromMode(mode: CollaborationMode): CollaborationIntent {
  switch (mode) {
    case "local":
      return "local";
    case "shared":
      return "share";
    case "joined":
      return "join";
  }
}

export function runtimeOptionsForSettingsRow(
  row: TuiSettingsChoiceRow,
  bypassEnabled: boolean,
): readonly ChoiceSettingOption<string, string>[] {
  if (row.id === "merge_strategy" && !bypassEnabled) {
    return row.options.filter((option) => option.runtimeValue !== "bypass");
  }
  return row.options;
}

export function reviewModeLabel(mode: ReviewMode): string {
  return getByRuntimeValue(REVIEW_MODE_OPTIONS, mode).runtimeLabel;
}

export function collaborationLabel(mode: CollaborationMode): string {
  return getByRuntimeValue(COLLABORATION_MODE_OPTIONS, mode).runtimeLabel;
}

export function resolveTuiSettingsDefaults(userConfig: {
  merge_strategy?: unknown;
  review_mode?: unknown;
  collaboration_mode?: unknown;
}): TuiSettingsDefaults {
  return {
    mergeStrategy: isPersistedMergeStrategy(userConfig.merge_strategy)
      ? userConfig.merge_strategy
      : TUI_SETTINGS_DEFAULTS.mergeStrategy,
    reviewMode: normalizePersistedReviewMode(userConfig.review_mode)
      ?? TUI_SETTINGS_DEFAULTS.reviewMode,
    collaborationMode: isPersistedCollaborationMode(userConfig.collaboration_mode)
      ? userConfig.collaboration_mode
      : TUI_SETTINGS_DEFAULTS.collaborationMode,
  };
}

export const REVIEW_MODE_CYCLE: ReviewMode[] = REVIEW_MODE_OPTIONS.map((option) => option.runtimeValue);

export const COLLABORATION_MODE_CYCLE: CollaborationMode[] = COLLABORATION_MODE_OPTIONS.map((option) => option.runtimeValue);
