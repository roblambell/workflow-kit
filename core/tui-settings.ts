// Shared TUI settings metadata used by startup selection and runtime controls.

import type { MergeStrategy } from "./orchestrator.ts";

export type StartupReviewMode = "off" | "on";
export type ReviewMode = "off" | "on";

export type StartupCollaborationMode = "local" | "connect";
export type CollaborationIntent = StartupCollaborationMode;
export type CollaborationMode = "local" | "connected";

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
  reviewMode: "off",
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
    persistedValue: "connect",
    runtimeValue: "connected",
    startupLabel: "connect",
    startupDescription: "Auto-connect to this project's shared broker session",
    runtimeLabel: "Connected",
    runtimeKey: "2",
    persistable: true,
  },
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
    id: "max_inflight",
    title: "Session Limit",
    kind: "number",
    min: 1,
  },
] as const;

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

export function collaborationIntentToMode(intent: CollaborationIntent): CollaborationMode {
  switch (intent) {
    case "local":
      return "local";
    case "connect":
      return "connected";
  }
}

export function collaborationIntentFromMode(mode: CollaborationMode): CollaborationIntent {
  switch (mode) {
    case "local":
      return "local";
    case "connected":
      return "connect";
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

/**
 * Startup defaults are hardcoded to the safest values so sessions always begin
 * in a predictable, lossless state: manual merges, no AI reviews, local-only
 * collaboration. Any mid-session runtime toggles and CLI overrides remain the
 * way to opt into richer behavior; nothing about these defaults is persisted
 * across sessions.
 */
export function resolveTuiSettingsDefaults(): TuiSettingsDefaults {
  return { ...TUI_SETTINGS_DEFAULTS };
}

export const REVIEW_MODE_CYCLE: ReviewMode[] = REVIEW_MODE_OPTIONS.map((option) => option.runtimeValue);

export const COLLABORATION_MODE_CYCLE: CollaborationMode[] = COLLABORATION_MODE_OPTIONS.map((option) => option.runtimeValue);
