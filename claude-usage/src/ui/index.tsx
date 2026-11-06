import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { UsageResult, UsageWindow } from "../usage.js";

const REFRESH_MS = 60 * 1000;
const WARN_PERCENT = 90;

const trigger: CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  borderRadius: 6,
  cursor: "pointer",
  border: "1px solid var(--border)",
  color: "var(--foreground)",
  background: "transparent",
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
};
const panel: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  zIndex: 50,
  width: 280,
  maxWidth: "calc(100vw - 32px)",
  padding: 12,
  display: "grid",
  gap: 12,
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--foreground)",
  boxShadow: "0 4px 16px rgb(0 0 0 / 0.15)",
};
const muted: CSSProperties = { fontSize: 12, color: "var(--muted-foreground)" };

const colorFor = (used: number | null) => (used !== null && used >= WARN_PERCENT ? "var(--destructive)" : "var(--primary)");
const formatReset = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

function Meter({ window: w }: { window: UsageWindow }) {
  const used = w.usedPercent;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
        <span>{w.label}</span>
        <strong style={{ fontVariantNumeric: "tabular-nums" }}>{used === null ? w.note ?? "—" : `${used}%`}</strong>
      </div>
      {used !== null ? (
        <div role="progressbar" aria-label={w.label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={100}
          style={{ height: 4, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
          <div style={{ width: `${used}%`, height: "100%", background: colorFor(used) }} />
        </div>
      ) : null}
      {w.resetsAt ? <div style={muted}>Resets {formatReset(w.resetsAt)}</div> : null}
    </div>
  );
}

function useNarrow() {
  const query = "(max-width: 640px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function ClaudeUsageButton(_props: PluginWidgetProps) {
  const { data, error, refresh } = usePluginData<UsageResult>("usage");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();

  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const windows = data?.status === "ok" ? data.windows : [];
  const session = windows.find((w) => w.key === "session")?.usedPercent ?? null;
  const week = windows.find((w) => w.key === "week")?.usedPercent ?? null;
  const warn = Math.max(session ?? 0, week ?? 0) >= WARN_PERCENT;
  const problem = error ? error.message : data && data.status !== "ok" ? data.message : null;

  let text = "Claude usage";
  if (data?.status === "ok") {
    text = narrow
      ? `${session ?? "—"}% · ${week ?? "—"}%`
      : `Session ${session ?? "—"}% · Week ${week ?? "—"}%`;
  } else if (problem) {
    text = "Claude usage unavailable";
  }

  return (
    <div ref={root} style={{ position: "relative" }}>
      <button type="button" aria-expanded={open} aria-label={`Claude subscription usage: ${text}`}
        onClick={() => setOpen((v) => !v)}
        style={{ ...trigger, color: warn ? "var(--destructive)" : "var(--foreground)" }}>
        {text}
      </button>
      {open ? (
        <div role="dialog" aria-label="Claude subscription usage" style={panel}>
          <strong style={{ fontSize: 13 }}>Claude subscription</strong>
          {problem ? <p role="alert" style={{ ...muted, margin: 0, overflowWrap: "anywhere" }}>{problem}</p> : null}
          {windows.map((w) => <Meter key={w.key} window={w} />)}
          {data?.status === "ok" ? (
            <div style={muted}>
              {data.stale ? "Couldn't refresh. Last updated " : "Updated "}
              {new Date(data.fetchedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
