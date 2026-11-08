// Turns the watchdog's files into what the header button shows. Pure, so it's testable.

export type WatchdogAction = { at: string; msg: string };
export type WatchdogStatusFile = {
  schema?: string;
  lastTickAt?: string;
  dryRun?: boolean;
  paused?: boolean;
  healthy?: boolean | null;
  summary?: string;
  quarantined?: number;
  actionsThisTick?: WatchdogAction[];
  notes?: string[];
  recentActions?: WatchdogAction[];
};
export type Wait = { id: string; issue: string; kind: "ci"; repo: string; ref: string; createdAt: string; note?: string };
export type Level = "ok" | "acting" | "alert" | "paused" | "stale" | "missing";
export type StatusView = {
  level: Level;
  label: string;
  detail: string;
  lastTickAt: string | null;
  paused: boolean;
  notes: string[];
  recentActions: WatchdogAction[];
  waits: Wait[];
};

/** The timer runs every 3 minutes; past this, it has stopped. */
export const STALE_MS = 10 * 60 * 1000;
/** An action this recent makes the button say the watchdog is acting. */
export const ACTING_MS = 15 * 60 * 1000;

export function parseStatus(text: string | null): WatchdogStatusFile | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? (value as WatchdogStatusFile) : null;
  } catch {
    return null;
  }
}

export function parseWaits(text: string | null): Wait[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as { waits?: unknown };
    return Array.isArray(value?.waits)
      ? value.waits.filter((w): w is Wait =>
          !!w && typeof w === "object" && typeof (w as Wait).id === "string" && typeof (w as Wait).issue === "string"
          && typeof (w as Wait).ref === "string" && typeof (w as Wait).createdAt === "string")
      : [];
  } catch {
    return [];
  }
}

export function summarize(input: { status: WatchdogStatusFile | null; paused: boolean; waits: Wait[]; now: number }): StatusView {
  const { status, paused, waits, now } = input;
  const recentActions = (status?.recentActions ?? []).slice(-10).reverse();
  const base = {
    lastTickAt: status?.lastTickAt ?? null,
    paused,
    notes: status?.notes ?? [],
    recentActions,
    waits,
  };
  if (paused) {
    return { ...base, level: "paused", label: "Paused", detail: "The watchdog is paused. Stalled work won't be restarted until you resume it." };
  }
  if (!status?.lastTickAt) {
    return { ...base, level: "missing", label: "Not running", detail: "The watchdog hasn't reported yet. Check that its timer is enabled: systemctl --user status paperclip-watchdog.timer" };
  }
  const age = now - Date.parse(status.lastTickAt);
  if (!Number.isFinite(age) || age > STALE_MS) {
    return { ...base, level: "stale", label: "Not running", detail: `No check since ${new Date(status.lastTickAt).toLocaleString()}. Check its timer: systemctl --user status paperclip-watchdog.timer` };
  }
  if (status.healthy === false || status.healthy === null) {
    return { ...base, level: "alert", label: "Attention", detail: status.summary ?? "The watchdog reported a problem." };
  }
  const lastAction = recentActions[0];
  if (lastAction && now - Date.parse(lastAction.at) < ACTING_MS) {
    return { ...base, level: "acting", label: "Acting", detail: lastAction.msg };
  }
  return { ...base, level: "ok", label: "All clear", detail: "Nothing is stalled. The watchdog steps in when work gets stuck." };
}
