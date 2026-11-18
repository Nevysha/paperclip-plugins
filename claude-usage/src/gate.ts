import setup from "./setup.generated.js";

/** The routines the usage limit can pause, from setup.json (see setup.example.json). */
export const ROUTINES = setup.routines;

export interface GateSettings {
  /** Session (5-hour) limit, and the weekly one unless weekPauseAtPercent is set. */
  pauseAtPercent: number;
  /** Separate weekly limit; when unset the weekly window uses pauseAtPercent. */
  weekPauseAtPercent?: number;
  enabled: Record<string, boolean>;
  pausedByGate: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: GateSettings = {
  pauseAtPercent: 90,
  enabled: Object.fromEntries(ROUTINES.map((r) => [r.key, r.defaultEnabled])),
  pausedByGate: {},
};

export const isRoutineKey = (value: unknown): value is string => ROUTINES.some((r) => r.key === value);

export const weekLimit = (settings: Pick<GateSettings, "pauseAtPercent" | "weekPauseAtPercent">) =>
  settings.weekPauseAtPercent ?? settings.pauseAtPercent;

export const isOverLimit = (usage: { session: number | null; week: number | null } | null, sessionLimit: number, weekLimitPercent = sessionLimit) =>
  usage !== null && ((usage.session ?? 0) >= sessionLimit || (usage.week ?? 0) >= weekLimitPercent);

/**
 * Only resumes routines the gate paused itself, so one you paused by hand stays paused.
 * Unknown usage counts as not over the limit, so a broken login can't silently stop reviews.
 */
export function decide(input: { status: string; enabled: boolean; over: boolean; pausedByGate: boolean }): "pause" | "resume" | null {
  const shouldPause = input.enabled && input.over;
  if (input.status === "active" && shouldPause) return "pause";
  if (input.status === "paused" && input.pausedByGate && !shouldPause) return "resume";
  return null;
}
