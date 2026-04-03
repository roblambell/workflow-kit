// Shared TUI settings metadata used by startup selection and runtime controls.

import type { MergeStrategy } from "./orchestrator.ts";

export type StartupReviewMode = "off" | "mine" | "all";
export type ReviewMode = "off" | "ninthwave-prs" | "all-prs";

export type StartupCollaborationMode = "local" | "share" | "join";
export type CollaborationIntent = StartupCollaborationMode;
export type CollaborationMode = "local" | "shared" | "joined";
export type PersistedBackendMode = "auto" | "tmux" | "cmux" | "headless";
export type ScheduleEnabledMode = "off" | "on";

export type PersistedMergeStrategy = Extract<MergeStrategy, "auto" | "manual">;
export type PersistedReviewMode = StartupReviewMode;
export type PersistedCollaborationMode = StartupCollaborationMode;

const PERSISTED_BACKEND_MODES: readonly PersistedBackendMode[] = [
  "auto",
  "tmux",
  "cmux",
  "headless",
] as const;

export interface TuiSettingsDefaults {
  backendMode: PersistedBackendMode;
  mergeStrategy: PersistedMergeStrategy;
  reviewMode: PersistedReviewMode;
  collaborationMode: PersistedCollaborationMode;
  scheduleEnabled: boolean;
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
  backendMode: "auto",
  mergeStrategy: "manual",
  reviewMode: "off",
  collaborationMode: "local",
  scheduleEnabled: false,
};

export const BACKEND_MODE_OPTIONS: readonly ChoiceSettingOption<PersistedBackendMode, PersistedBackendMode>[] = [
  {
    persistedValue: "auto",
    runtimeValue: "auto",
    startupLabel: "Auto",
    startupDescription: "Prefer your current or available mux backend, else headless",
    runtimeLabel: "Auto",
    persistable: true,
  },
  {
    persistedValue: "tmux",
    runtimeValue: "tmux",
    startupLabel: "tmux",
    startupDescription: "Use tmux explicitly, or fall back to headless if unavailable",
    runtimeLabel: "tmux",
    persistable: true,
  },
  {
    persistedValue: "cmux",
    runtimeValue: "cmux",
    startupLabel: "cmux",
    startupDescription: "Use cmux explicitly, or fall back to headless if unavailable",
    runtimeLabel: "cmux",
    persistable: true,
  },
  {
    persistedValue: "headless",
    runtimeValue: "headless",
    startupLabel: "headless",
    startupDescription: "Skip multiplexers and run headless directly in this terminal",
    runtimeLabel: "Headless",
    persistable: true,
  },
] as const;

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
    persistedValue: "mine",
    runtimeValue: "ninthwave-prs",
    startupLabel: "mine",
    startupDescription: "Review only ninthwave-managed PRs",
    runtimeLabel: "Ninthwave PRs",
    runtimeKey: "5",
    persistable: true,
  },
  {
    persistedValue: "all",
    runtimeValue: "all-prs",
    startupLabel: "all",
    startupDescription: "Review all PRs (including external)",
    runtimeLabel: "All PRs",
    runtimeKey: "6",
    persistable: true,
  },
] as const;

export const SCHEDULE_ENABLED_OPTIONS: readonly ChoiceSettingOption<ScheduleEnabledMode, ScheduleEnabledMode>[] = [
  {
    persistedValue: "off",
    runtimeValue: "off",
    startupLabel: "off",
    startupDescription: "Do not run scheduled tasks for this project",
    runtimeLabel: "Off",
    persistable: true,
  },
  {
    persistedValue: "on",
    runtimeValue: "on",
    startupLabel: "on",
    startupDescription: "Allow scheduled tasks for this project to execute",
    runtimeLabel: "On",
    persistable: true,
  },
] as const;

export const STARTUP_REVIEW_MODE_OPTIONS = [
  REVIEW_MODE_OPTIONS[2]!,
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
  {
    id: "schedule_enabled",
    title: "Scheduled tasks",
    kind: "choice",
    options: SCHEDULE_ENABLED_OPTIONS,
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

export function isPersistedBackendMode(value: unknown): value is PersistedBackendMode {
  return PERSISTED_BACKEND_MODES.includes(value as PersistedBackendMode);
}

export function isPersistedReviewMode(value: unknown): value is PersistedReviewMode {
  return hasPersistedValue(REVIEW_MODE_OPTIONS, value);
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

export function scheduleEnabledToMode(enabled: boolean): ScheduleEnabledMode {
  return enabled ? "on" : "off";
}

export function scheduleModeToEnabled(mode: ScheduleEnabledMode): boolean {
  return mode === "on";
}

export function scheduleEnabledLabel(enabled: boolean): string {
  return getByRuntimeValue(
    SCHEDULE_ENABLED_OPTIONS,
    scheduleEnabledToMode(enabled),
  ).runtimeLabel;
}

export function resolveTuiSettingsDefaults(userConfig: {
  backend_mode?: unknown;
  merge_strategy?: unknown;
  review_mode?: unknown;
  collaboration_mode?: unknown;
}, options: {
  scheduleEnabled?: boolean;
} = {}): TuiSettingsDefaults {
  return {
    backendMode: isPersistedBackendMode(userConfig.backend_mode)
      ? userConfig.backend_mode
      : TUI_SETTINGS_DEFAULTS.backendMode,
    mergeStrategy: isPersistedMergeStrategy(userConfig.merge_strategy)
      ? userConfig.merge_strategy
      : TUI_SETTINGS_DEFAULTS.mergeStrategy,
    reviewMode: isPersistedReviewMode(userConfig.review_mode)
      ? userConfig.review_mode
      : TUI_SETTINGS_DEFAULTS.reviewMode,
    collaborationMode: isPersistedCollaborationMode(userConfig.collaboration_mode)
      ? userConfig.collaboration_mode
      : TUI_SETTINGS_DEFAULTS.collaborationMode,
    scheduleEnabled: options.scheduleEnabled ?? TUI_SETTINGS_DEFAULTS.scheduleEnabled,
  };
}

export const REVIEW_MODE_CYCLE: ReviewMode[] = REVIEW_MODE_OPTIONS.map((option) => option.runtimeValue);

export const COLLABORATION_MODE_CYCLE: CollaborationMode[] = COLLABORATION_MODE_OPTIONS.map((option) => option.runtimeValue);
