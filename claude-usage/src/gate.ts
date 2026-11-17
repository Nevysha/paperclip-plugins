import setup from "./setup.generated.js";

/** The routines the usage limit can pause, from setup.json (see setup.example.json). */
export const ROUTINES = setup.routines;

export type RoutineKey = string;

export interface GateLimits {
  /** Session (5-hour) limit, and the weekly one unless weekPauseAtPercent is set. */
  pauseAtPercent: number;
  /** Separate weekly limit; when unset the weekly window uses pauseAtPercent. */
  weekPauseAtPercent?: number;
}

export interface RoutineFlags {
  enabled: Record<string, boolean>;
  pausedByGate: Record<string, boolean>;
}

export const DEFAULT_LIMITS: GateLimits = { pauseAtPercent: 90 };

export const DEFAULT_FLAGS: RoutineFlags = {
  enabled: Object.fromEntries(ROUTINES.map((r) => [r.key, r.defaultEnabled])),
  pausedByGate: {},
};

const asFlags = (raw: unknown) => (raw && typeof raw === "object" ? (raw as Partial<RoutineFlags>) : null);

export function toFlags(saved: unknown): RoutineFlags {
  const flags = asFlags(saved);
  return { enabled: { ...DEFAULT_FLAGS.enabled, ...flags?.enabled }, pausedByGate: { ...flags?.pausedByGate } };
}

/** Splits the routine flags that versions before 0.4.0 kept in the instance settings from the limits saved there. */
export function takeLegacyFlags(instance: unknown): { flags: RoutineFlags | null; rest: Record<string, unknown> } {
  const { enabled, pausedByGate, ...rest } = (asFlags(instance) ?? {}) as Partial<RoutineFlags> & Record<string, unknown>;
  const flags = enabled || pausedByGate ? toFlags({ enabled, pausedByGate }) : null;
  return { flags, rest };
}

/** The setup.json company takes over the checkboxes saved before 0.4.0; without one, the first company with routines does. */
export const claimsLegacyFlags = (companyId: string, hasRoutines: boolean) =>
  setup.companyId ? setup.companyId === companyId : hasRoutines;

/** Routines the gate paused that the company no longer lists, so the gate resumes them and lets go. */
export function toRelease(pausedByGate: Record<string, boolean>, configured: readonly string[]): RoutineKey[] {
  return ROUTINES.map((r) => r.key).filter((key) => pausedByGate[key] === true && !configured.includes(key));
}

export interface GateConfig {
  projectId: string | null;
  routines: Array<{ key: RoutineKey; assigneeAgentId: string }>;
}

const nonBlank = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The setup.json values, which apply only to the setup.json company. */
function setupDefaults(companyId: string): GateConfig | null {
  if (!setup.companyId || setup.companyId !== companyId) return null;
  const routines = setup.routines.flatMap((r) => {
    const assigneeAgentId = nonBlank(r.assigneeAgentId);
    return isRoutineKey(r.key) && assigneeAgentId ? [{ key: r.key, assigneeAgentId }] : [];
  });
  return { projectId: nonBlank(setup.projectId), routines };
}

/** A routine without an assignee is left out; the setup.json company falls back to its setup.json values. */
export function parseGateConfig(raw: unknown, companyId: string): GateConfig {
  const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const defaults = setupDefaults(companyId);
  const projectId = nonBlank(config.projectId) ?? defaults?.projectId ?? null;
  if (!Array.isArray(config.routines) && defaults) return { projectId, routines: defaults.routines };
  const routines: GateConfig["routines"] = [];
  for (const entry of Array.isArray(config.routines) ? config.routines : []) {
    const key = entry?.key;
    const assigneeAgentId = nonBlank(entry?.assigneeAgentId);
    if (!isRoutineKey(key) || !assigneeAgentId || routines.some((r) => r.key === key)) continue;
    routines.push({ key, assigneeAgentId });
  }
  return { projectId, routines };
}

export const isRoutineKey = (value: unknown): value is RoutineKey => ROUTINES.some((r) => r.key === value);

export const weekLimit = (settings: GateLimits) =>
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
