import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  useHostLocation,
  useHostNavigation,
  usePluginToast,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

const API = "/api/plugins/nevysha.decision-log/api/decisions";

type Status = "unreviewed" | "reviewed" | "overturned";
type Decision = {
  id: string;
  created_at: string;
  author_type: "agent" | "user";
  author_agent_name: string | null;
  issue_identifier: string | null;
  kind: "answered_from_source" | "judgment_call" | "auto_approved_task";
  question: string;
  answer: string;
  reasoning: string;
  sources: string[];
  review_status: Status;
  review_note: string | null;
};

const KIND_LABELS: Record<Decision["kind"], string> = {
  answered_from_source: "Answered from a source",
  judgment_call: "Judgment call",
  auto_approved_task: "Auto-approved task",
};
const FILTERS: Array<{ key: Status | "all"; label: string }> = [
  { key: "unreviewed", label: "To review" },
  { key: "overturned", label: "Overturned" },
  { key: "reviewed", label: "Reviewed" },
  { key: "all", label: "All" },
];

const button = (primary = false): CSSProperties => ({
  padding: "6px 12px",
  fontSize: 13,
  borderRadius: 6,
  cursor: "pointer",
  border: "1px solid var(--border)",
  color: primary ? "var(--primary-foreground)" : "var(--foreground)",
  background: primary ? "var(--primary)" : "transparent",
});
const label: CSSProperties = { fontSize: 12, color: "var(--muted-foreground)", marginBottom: 2 };
const body: CSSProperties = { fontSize: 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 };

async function readJson(res: Response) {
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json;
}

function DecisionCard({
  decision,
  companyPrefix,
  onReview,
}: {
  decision: Decision;
  companyPrefix: string | null;
  onReview: (id: string, status: Status, note: string | null) => Promise<void>;
}) {
  const nav = useHostNavigation();
  const [overturning, setOverturning] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const author = decision.author_agent_name ?? (decision.author_type === "user" ? "Board" : "Removed agent");

  const submit = async (status: Status, reviewNote: string | null) => {
    setBusy(true);
    try {
      await onReview(decision.id, status, reviewNote);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 16, display: "grid", gap: 12, background: "var(--card)" }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12, color: "var(--muted-foreground)" }}>
        <strong style={{ color: "var(--foreground)" }}>{KIND_LABELS[decision.kind]}</strong>
        <span>{author}</span>
        <span>{new Date(decision.created_at).toLocaleString()}</span>
        {decision.issue_identifier && companyPrefix ? (
          <a {...nav.linkProps(`/issues/${decision.issue_identifier}`)} style={{ color: "inherit", textDecoration: "underline" }}>
            {decision.issue_identifier}
          </a>
        ) : null}
        {decision.review_status !== "unreviewed" ? <span>{decision.review_status === "overturned" ? "Overturned" : "Reviewed"}</span> : null}
      </header>
      <div><div style={label}>Question</div><p style={body}>{decision.question}</p></div>
      <div><div style={label}>Answer</div><p style={body}>{decision.answer}</p></div>
      <div><div style={label}>Why</div><p style={body}>{decision.reasoning}</p></div>
      {decision.sources.length > 0 ? (
        <div>
          <div style={label}>Sources</div>
          <ul style={{ ...body, paddingLeft: 18 }}>{decision.sources.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
      ) : null}
      {decision.review_note ? <div><div style={label}>Your note</div><p style={body}>{decision.review_note}</p></div> : null}
      {overturning ? (
        <div style={{ display: "grid", gap: 8 }}>
          <label style={label} htmlFor={`note-${decision.id}`}>What should happen instead? This is posted on the linked task, if there is one.</label>
          <textarea id={`note-${decision.id}`} value={note} onChange={(e) => setNote(e.target.value)} rows={3}
            style={{ ...body, width: "100%", boxSizing: "border-box", padding: 8, borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--foreground)" }} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={button()} disabled={busy} onClick={() => setOverturning(false)}>Cancel</button>
            <button style={button(true)} disabled={busy || !note.trim()} onClick={() => void submit("overturned", note.trim())}>Overturn decision</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {decision.review_status === "unreviewed" ? (
            <button style={button(true)} disabled={busy} onClick={() => void submit("reviewed", null)}>Mark reviewed</button>
          ) : (
            <button style={button()} disabled={busy} onClick={() => void submit("unreviewed", null)}>Move back to review</button>
          )}
          {decision.review_status !== "overturned" ? (
            <button style={button()} disabled={busy} onClick={() => setOverturning(true)}>Overturn…</button>
          ) : null}
        </div>
      )}
    </article>
  );
}

export function DecisionLogPage({ context }: PluginPageProps) {
  const toast = usePluginToast();
  const companyId = context.companyId;
  const [filter, setFilter] = useState<Status | "all">("unreviewed");
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    const params = new URLSearchParams({ companyId });
    if (filter !== "all") params.set("status", filter);
    try {
      const json = await readJson(await fetch(`${API}?${params}`));
      setDecisions(json.decisions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [companyId, filter]);

  useEffect(() => {
    setDecisions(null);
    void load();
  }, [load]);

  const review = async (id: string, status: Status, note: string | null) => {
    try {
      const res = await fetch(`${API}/${id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyId, status, note }),
      });
      await readJson(res);
      await load();
    } catch (err) {
      toast({ title: "Couldn't save your review", body: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  };

  return (
    <main style={{ padding: 24, maxWidth: 860, margin: "0 auto", display: "grid", gap: 16, color: "var(--foreground)" }}>
      <header>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Decision Log</h1>
        <p style={{ fontSize: 14, color: "var(--muted-foreground)", margin: "4px 0 0" }}>
          Decisions agents made without asking you. Agents can add entries but can't edit or delete them.
        </p>
      </header>
      <nav aria-label="Filter decisions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button key={f.key} style={button(filter === f.key)} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>
        ))}
      </nav>
      {error ? <p role="alert" style={{ ...body, color: "var(--destructive)" }}>Couldn't load decisions: {error}</p> : null}
      {!error && decisions === null ? <p style={body}>Loading…</p> : null}
      {!error && decisions?.length === 0 ? (
        <p style={{ ...body, color: "var(--muted-foreground)" }}>{filter === "unreviewed" ? "Nothing to review." : "No decisions here yet."}</p>
      ) : null}
      {decisions?.map((d) => <DecisionCard key={d.id} decision={d} companyPrefix={context.companyPrefix} onReview={review} />)}
    </main>
  );
}

function useUnreviewedCount(companyId: string | null) {
  const { pathname } = useHostLocation();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!companyId) return;
    const params = new URLSearchParams({ companyId, status: "unreviewed" });
    fetch(`${API}?${params}`)
      .then(readJson)
      .then((json) => setCount(json.decisions.length))
      .catch(() => setCount(0));
  }, [companyId, pathname]);
  return count;
}

export function DecisionLogSidebarLink({ context }: PluginSidebarProps) {
  const nav = useHostNavigation();
  const count = useUnreviewedCount(context.companyId);
  return (
    <a {...nav.linkProps("/decision-log")}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80"
      style={{ textDecoration: "none" }}>
      <span className="flex-1 truncate">Decision Log</span>
      {count > 0 ? <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{count}</span> : null}
    </a>
  );
}

export function DecisionLogToolbarButton({ context }: PluginWidgetProps) {
  const nav = useHostNavigation();
  const count = useUnreviewedCount(context.companyId);
  return (
    <a {...nav.linkProps("/decision-log")}
      aria-label={count > 0 ? `Decision Log, ${count} to review` : "Decision Log"}
      style={{ ...button(), display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", whiteSpace: "nowrap" }}>
      Decisions
      {count > 0 ? <strong>{count}</strong> : null}
    </a>
  );
}
