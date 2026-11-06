export interface UsageWindow {
  key: "session" | "week" | "week_sonnet" | "week_opus" | "extra";
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  note: string | null;
}

export type UsageResult =
  | { status: "ok"; windows: UsageWindow[]; fetchedAt: string; stale: boolean }
  | { status: "signed_out" | "unavailable"; message: string };

type RawWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type RawExtra = { is_enabled?: boolean | null; utilization?: number | null } | null | undefined;

const percent = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : null;

export function toWindows(body: unknown): UsageWindow[] {
  const raw = (body ?? {}) as Record<string, RawWindow>;
  const windows: UsageWindow[] = [];
  const add = (key: UsageWindow["key"], label: string, value: RawWindow) => {
    if (value) windows.push({ key, label, usedPercent: percent(value.utilization), resetsAt: value.resets_at ?? null, note: null });
  };
  add("session", "Current session", raw.five_hour);
  add("week", "Current week (all models)", raw.seven_day);
  add("week_sonnet", "Current week (Sonnet only)", raw.seven_day_sonnet);
  add("week_opus", "Current week (Opus only)", raw.seven_day_opus);
  const extra = (body as { extra_usage?: RawExtra } | null)?.extra_usage;
  if (extra) {
    const enabled = extra.is_enabled !== false;
    windows.push({
      key: "extra",
      label: "Extra usage",
      usedPercent: enabled ? percent(extra.utilization) : null,
      resetsAt: null,
      note: enabled ? null : "Not enabled",
    });
  }
  return windows;
}

/** Returns the access token, or null if there is no usable login. Claude Code refreshes it; this never does. */
export function parseCredentials(raw: string, now = Date.now()): string | null {
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== "string" || !token) return null;
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) return null;
    return token;
  } catch {
    return null;
  }
}

export interface PublishedGate {
  pauseAtPercent: number;
  routines: Record<string, boolean>;
}

/** What other local readers get. Percentages, times and gate settings only, so it's safe to leave readable. */
export function toUsageFile(result: UsageResult, gate?: PublishedGate) {
  if (result.status !== "ok") {
    return { status: result.status, fetchedAt: null, stale: true, sessionPercent: null, sessionResetsAt: null, weekPercent: null, weekResetsAt: null, gate };
  }
  const session = result.windows.find((w) => w.key === "session");
  const week = result.windows.find((w) => w.key === "week");
  return {
    status: "ok" as const,
    fetchedAt: result.fetchedAt,
    stale: result.stale,
    sessionPercent: session?.usedPercent ?? null,
    sessionResetsAt: session?.resetsAt ?? null,
    weekPercent: week?.usedPercent ?? null,
    weekResetsAt: week?.resetsAt ?? null,
    gate,
  };
}
