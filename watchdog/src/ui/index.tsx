import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePluginAction, usePluginData, usePluginToast, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { Level, StatusView } from "../status.js";

const REFRESH_MS = 30 * 1000;

const DOT: Record<Level, string> = {
  ok: "var(--status-task-done, #16a34a)",
  acting: "var(--status-agent-running, #2563eb)",
  alert: "var(--destructive, #dc2626)",
  paused: "var(--status-agent-paused, #ca8a04)",
  stale: "var(--muted-foreground, #888)",
  missing: "var(--muted-foreground, #888)",
};

const trigger: CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  borderRadius: 6,
  cursor: "pointer",
  border: "1px solid var(--border)",
  color: "var(--foreground)",
  background: "transparent",
  whiteSpace: "nowrap",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};
const panel: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  zIndex: 50,
  width: 340,
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "70vh",
  overflowY: "auto",
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
const section: CSSProperties = { display: "grid", gap: 6, paddingTop: 12, borderTop: "1px solid var(--border)" };
const smallButton: CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  borderRadius: 6,
  cursor: "pointer",
  border: "1px solid var(--border)",
  color: "var(--foreground)",
  background: "transparent",
};

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const since = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

function Dot({ level }: { level: Level }) {
  return <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: DOT[level], flexShrink: 0 }} />;
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

export function WatchdogButton(_props: PluginWidgetProps) {
  const { data, error, refresh } = usePluginData<StatusView>("status");
  const setPaused = usePluginAction("setPaused");
  const cancelWait = usePluginAction("cancelWait");
  const toast = usePluginToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();

  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    refresh();
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

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast({ title: label, body: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const level: Level = data?.level ?? (error ? "alert" : "missing");
  const label = data?.label ?? (error ? "Unavailable" : "Watchdog");

  return (
    <div ref={root} style={{ position: "relative" }}>
      <button type="button" aria-expanded={open} aria-label={`Watchdog: ${label}`}
        onClick={() => setOpen((v) => !v)} style={trigger}>
        <Dot level={level} />
        {narrow ? null : <span>Watchdog</span>}
      </button>
      {open ? (
        <div role="dialog" aria-label="Watchdog"
          style={narrow ? { ...panel, position: "fixed", top: 64, left: 16, right: 16, width: "auto", maxWidth: "none" } : panel}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <strong style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Dot level={level} /> {label}
            </strong>
            {data ? (
              <button type="button" disabled={busy} style={smallButton}
                onClick={() => void run(data.paused ? "Couldn't resume" : "Couldn't pause", () => setPaused({ paused: !data.paused }))}>
                {data.paused ? "Resume" : "Pause"}
              </button>
            ) : null}
          </div>
          {error ? <p role="alert" style={{ ...muted, margin: 0 }}>{error.message}</p> : null}
          {data ? <p style={{ fontSize: 13, margin: 0, overflowWrap: "anywhere" }}>{data.detail}</p> : null}
          {data?.lastTickAt ? <div style={muted}>Last check {time(data.lastTickAt)} · runs every 3 minutes</div> : null}

          {data?.notes.length ? (
            <div style={section}>
              <strong style={{ fontSize: 12 }}>Notes</strong>
              {data.notes.map((n, i) => <div key={i} style={{ fontSize: 12, overflowWrap: "anywhere" }}>{n}</div>)}
            </div>
          ) : null}

          {data?.waits.length ? (
            <div style={section}>
              <strong style={{ fontSize: 12 }}>Waiting on CI</strong>
              {data.waits.map((w) => (
                <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <span style={{ flex: 1, overflowWrap: "anywhere" }}>
                    <strong>{w.issue}</strong> waits for <code>{w.ref}</code> <span style={muted}>· {since(w.createdAt)}</span>
                  </span>
                  <button type="button" disabled={busy} style={smallButton} aria-label={`Stop waiting on ${w.ref} for ${w.issue}`}
                    onClick={() => void run("Couldn't remove that wait", () => cancelWait({ id: w.id }))}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div style={section}>
            <strong style={{ fontSize: 12 }}>Recent actions</strong>
            {data?.recentActions.length ? (
              data.recentActions.map((a, i) => (
                <div key={i} style={{ fontSize: 12, display: "grid", gridTemplateColumns: "auto 1fr", gap: 8 }}>
                  <span style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>{time(a.at)}</span>
                  <span style={{ overflowWrap: "anywhere" }}>{a.msg}</span>
                </div>
              ))
            ) : (
              <div style={muted}>None yet.</div>
            )}
          </div>
          <div style={muted}>Full log: ~/.paperclip-dev/watchdog/watchdog.log</div>
        </div>
      ) : null}
    </div>
  );
}
