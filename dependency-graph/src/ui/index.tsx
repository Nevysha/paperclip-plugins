import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dagre from "@dagrejs/dagre";
import {
  useHostLocation,
  useHostNavigation,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  analyse, chainOf, edgeKey, findTask, isClosed, isQuiet, select,
  type Analysis, type Edge, type GraphData, type NodeInfo, type Scope, type Selection, type Task, type Wait,
} from "../graph.js";

const API = "/api/plugins/nevysha.dependency-graph/api/graph";
const PREFS_KEY = "nevysha.dependency-graph.prefs";
const PAGE = "/dependencies";

// ---------------------------------------------------------------- data

function useGraphData(companyId: string | null, intervalMs: number) {
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  useEffect(() => {
    if (!companyId) return;
    let live = true;
    fetch(`${API}?${new URLSearchParams({ companyId })}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
        return json as GraphData;
      })
      .then((json) => { if (live) { setData(json); setError(null); } })
      .catch((err: Error) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [companyId, tick]);
  return { data, error };
}

type Direction = "LR" | "TB";
/** projectId: "" for all projects. */
type Prefs = { scope: Scope; showClosed: boolean; parentLinks: boolean; dir: Direction; projectId: string };
const DEFAULT_PREFS: Prefs = { scope: "open", showClosed: true, parentLinks: false, dir: "LR", projectId: "" };

function usePrefs(): [Prefs, (p: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") }; } catch { return DEFAULT_PREFS; }
  });
  return [prefs, (p) => setPrefs((old) => {
    const next = { ...old, ...p };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
    return next;
  })];
}

// ---------------------------------------------------------------- labels

const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog", todo: "To do", in_progress: "In progress", in_review: "In review",
  blocked: "Blocked", done: "Done", cancelled: "Cancelled",
};
const STATUS_ORDER = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;
const taskLabel = (t: Task) => t.identifier ?? t.id.slice(0, 8);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** "3 h", "12 min": how long since `iso`, for running things. */
function since(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "under a minute";
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 2160) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} days`;
}
const WAIT_KIND: Record<Wait["kind"], string> = { job: "Job", ci: "CI" };

// ---------------------------------------------------------------- styles

const CSS = `
.dg-root{--dg-backlog:var(--muted-foreground);--dg-todo:#d97706;--dg-in_progress:#2563eb;--dg-in_review:#7c3aed;--dg-blocked:#dc2626;
  --dg-done:#16a34a;--dg-cancelled:#737373;--dg-warn:#b45309;--dg-hi:#2563eb;
  color:var(--foreground);padding:24px 16px 32px;display:flex;flex-direction:column;gap:12px;font-size:14px;min-width:0}
.dark .dg-root{--dg-todo:#fbbf24;--dg-in_progress:#60a5fa;--dg-in_review:#a78bfa;--dg-blocked:#f87171;--dg-done:#4ade80;--dg-warn:#fbbf24;--dg-hi:#60a5fa}
.dg-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px}
.dg-head h1{font-size:20px;font-weight:600;margin:0}
.dg-sub{color:var(--muted-foreground);font-size:13px;margin:4px 0 0;max-width:680px}
.dg-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dg-ctl-label{font-size:12px;color:var(--muted-foreground)}
.dg-seg{display:inline-flex;flex-wrap:wrap;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.dg-seg button{all:unset;cursor:pointer;padding:4px 10px;font-size:12px;white-space:nowrap;color:var(--muted-foreground)}
.dg-seg button[aria-pressed=true]{background:var(--accent);color:var(--foreground);font-weight:600}
.dg-seg button:disabled{cursor:default;opacity:.5}
.dg-seg button:focus-visible,.dg-btn:focus-visible,.dg-node:focus-visible,.dg-item:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.dg-btn{all:unset;cursor:pointer;padding:4px 10px;font-size:12px;border:1px solid var(--border);border-radius:8px;white-space:nowrap;color:var(--foreground)}
.dg-btn:hover{background:var(--accent)}
.dg-search{display:inline-flex;gap:6px;align-items:center}
.dg-search input{font:inherit;font-size:12px;padding:4px 8px;border:1px solid var(--border);border-radius:8px;background:var(--background);color:var(--foreground);width:150px}
.dg-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 4px 3px 10px;border-radius:999px;background:var(--accent);font-size:12px}
.dg-chip button{all:unset;cursor:pointer;padding:0 6px;border-radius:999px;color:var(--muted-foreground)}
.dg-chip button:hover{color:var(--foreground)}
.dg-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--muted-foreground);align-items:center}
.dg-legend span{display:inline-flex;align-items:center;gap:6px}
.dg-sw{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
.dg-main{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:12px;min-height:0}
@media (max-width:900px){.dg-main{grid-template-columns:minmax(0,1fr)}}
.dg-canvas{position:relative;overflow:hidden;background:var(--card);border:1px solid var(--border);border-radius:10px;
  height:max(460px,calc(100vh - 250px));touch-action:none;cursor:grab;user-select:none}
.dg-canvas.panning{cursor:grabbing}
.dg-zoom{position:absolute;right:10px;bottom:10px;display:flex;gap:4px;z-index:3}
.dg-zoom .dg-btn{background:var(--card);padding:4px 9px}
.dg-world{position:absolute;left:0;top:0;transform-origin:0 0}
.dg-world svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.dg-edge{fill:none;stroke:var(--muted-foreground);stroke-width:1.5;stroke-opacity:.75;transition:stroke-opacity .12s}
.dg-edge.resolved{stroke-opacity:.3}
.dg-edge.parent{stroke-dasharray:5 4;stroke-opacity:.45}
.dg-edge.hi{stroke:var(--dg-hi);stroke-opacity:1;stroke-width:2}
.dg-edge.dim{stroke-opacity:.1}
.dg-node{position:absolute;box-sizing:border-box;background:var(--background);border:1px solid var(--border);border-left:4px solid var(--dg-st);
  border-radius:8px;padding:6px 9px;display:flex;flex-direction:column;gap:2px;cursor:pointer;overflow:hidden;transition:opacity .12s,box-shadow .12s}
.dg-node:hover{box-shadow:0 2px 10px rgba(0,0,0,.14)}
.dg-node.closed{opacity:.6}
.dg-node.closed .dg-title{color:var(--muted-foreground)}
.dg-node.cancelled .dg-title{text-decoration:line-through}
.dg-node.dim{opacity:.22}
.dg-node.sel{box-shadow:0 0 0 2px var(--dg-hi)}
.dg-node.focus{border-color:var(--dg-hi)}
.dg-node.stale{background:color-mix(in srgb,var(--dg-warn) 9%,var(--background))}
.dg-top{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted-foreground);white-space:nowrap;min-width:0}
.dg-id{font-weight:600;color:var(--foreground);font-variant-numeric:tabular-nums}
.dg-dot{width:8px;height:8px;border-radius:999px;background:var(--dg-st);flex:none}
.dg-title{font-size:12.5px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dg-badge{font-size:10.5px;font-weight:600;padding:0 5px;border-radius:4px;line-height:16px;white-space:nowrap;flex:none}
.dg-top>span:not(.dg-badge):not(.dg-dot):not(.dg-id):not(.dg-push){overflow:hidden;text-overflow:ellipsis;min-width:0}
.dg-badge.warn{color:var(--dg-warn);background:color-mix(in srgb,var(--dg-warn) 15%,transparent)}
.dg-badge.bad{color:var(--dg-blocked);background:color-mix(in srgb,var(--dg-blocked) 14%,transparent)}
.dg-badge.head{color:var(--dg-hi);background:color-mix(in srgb,var(--dg-hi) 14%,transparent)}
.dg-push{margin-left:auto}
.dg-node.wait{border-style:dashed;border-left-style:solid;background:color-mix(in srgb,var(--dg-st) 6%,var(--background))}
.dg-node.wait .dg-title{-webkit-line-clamp:1;font-family:var(--font-mono,ui-monospace,monospace);font-size:11.5px}
.dg-detail{font-size:11px;color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dg-kind{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--dg-st)}
.dg-why{font-size:12.5px;line-height:1.5;padding:8px 10px;border-radius:8px;background:var(--accent);overflow-wrap:anywhere}
.dg-why b{font-weight:600}
.dg-mono{font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;overflow-wrap:anywhere}
.dg-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:var(--muted-foreground);cursor:default}
.dg-panel{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:12px;
  min-width:0;overflow:auto;max-height:max(460px,calc(100vh - 250px))}
@media (max-width:900px){.dg-panel{max-height:none}}
.dg-panel h2{font-size:15px;font-weight:600;margin:0}
.dg-panel h3{font-size:12px;font-weight:600;color:var(--muted-foreground);margin:0 0 4px;text-transform:none}
.dg-panel p{margin:0;font-size:13px;line-height:1.5}
.dg-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:13px}
.dg-kv dt{color:var(--muted-foreground)}
.dg-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.dg-list{display:flex;flex-direction:column;gap:1px}
.dg-item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:13px;min-width:0}
.dg-item:hover{background:var(--accent)}
.dg-item .dg-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.dg-item .dg-n{font-size:12px;color:var(--muted-foreground);font-variant-numeric:tabular-nums;white-space:nowrap}
.dg-note{font-size:12px;color:var(--muted-foreground);line-height:1.5}
.dg-warnbox{font-size:12.5px;line-height:1.5;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dg-warn) 12%,transparent)}
.dg-link{color:inherit;text-decoration:underline;text-underline-offset:2px}
.dg-row{display:flex;flex-wrap:wrap;gap:6px}
.dg-err{color:var(--destructive)}
.dg-muted{color:var(--muted-foreground)}
`;

const stColor = (status: string) => `var(--dg-${STATUS_LABEL[status] ? status : "backlog"})`;
/** Jobs read as work in progress; CI as review; a quiet job (log not written for a while) as a warning. */
const waitColor = (w: Wait) => (isQuiet(w) ? "var(--dg-warn)" : w.kind === "ci" ? "var(--dg-in_review)" : "var(--dg-in_progress)");

// ---------------------------------------------------------------- layout

const NODE_W = 212;
const NODE_H = 62;

type Point = { x: number; y: number };
type Layout = {
  nodes: Array<{ id: string; x: number; y: number }>;
  edges: Array<{ edge: Edge; key: string; points: Point[] }>;
  width: number;
  height: number;
};

function identifierNumber(t: Task | undefined): number {
  const m = t?.identifier?.match(/(\d+)$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function layoutGraph(sel: Selection, analysis: Analysis, dir: Direction): Layout {
  const waitTask = new Map(sel.edges.filter((e) => e.kind === "wait").map((e) => [e.from, e.to]));
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: dir, nodesep: dir === "LR" ? 14 : 22, ranksep: dir === "LR" ? 52 : 44, edgesep: 10, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = [...sel.nodeIds].sort((a, b) => identifierNumber(analysis.get(a)?.task) - identifierNumber(analysis.get(b)?.task));
  for (const id of ids) g.setNode(id, { width: NODE_W, height: NODE_H });
  // Wait boxes, ordered like their tasks so they sit next to them.
  const waitIds = [...sel.waitIds].sort((a, b) =>
    identifierNumber(analysis.get(waitTask.get(a) ?? "")?.task) - identifierNumber(analysis.get(waitTask.get(b) ?? "")?.task) || a.localeCompare(b));
  for (const id of waitIds) g.setNode(id, { width: NODE_W, height: NODE_H });
  const edges = [...sel.edges].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "parent" ? -1 : 1));
  for (const e of edges) if (!g.hasEdge(e.from, e.to)) g.setEdge(e.from, e.to, { weight: e.kind === "parent" ? 1 : 2, minlen: 1 });
  dagre.layout(g);
  const graph = g.graph() as { width?: number; height?: number };
  return {
    nodes: [...ids, ...waitIds].map((id) => { const n = g.node(id) as { x: number; y: number }; return { id, x: n.x, y: n.y }; }),
    edges: edges.map((e) => ({ edge: e, key: edgeKey(e), points: ((g.edge(e.from, e.to) as { points?: Point[] } | undefined)?.points ?? []) })),
    width: graph.width ?? 0,
    height: graph.height ?? 0,
  };
}

/** A uniform B-spline from the first to the last point: smooth, and it never overshoots the route dagre picked. */
function curve(pts: Point[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0]!.x},${pts[0]!.y}`;
  if (pts.length === 2) return `M${pts[0]!.x},${pts[0]!.y}L${pts[1]!.x},${pts[1]!.y}`;
  const p = [pts[0]!, ...pts, pts[pts.length - 1]!];
  let d = `M${p[0]!.x},${p[0]!.y}L${(5 * p[0]!.x + p[1]!.x) / 6},${(5 * p[0]!.y + p[1]!.y) / 6}`;
  for (let i = 2; i < p.length; i++) {
    const a = p[i - 2]!, b = p[i - 1]!, c = p[i]!;
    d += `C${(2 * a.x + b.x) / 3},${(2 * a.y + b.y) / 3} ${(a.x + 2 * b.x) / 3},${(a.y + 2 * b.y) / 3} ${(a.x + 4 * b.x + c.x) / 6},${(a.y + 4 * b.y + c.y) / 6}`;
  }
  const last = p[p.length - 1]!;
  return `${d}L${last.x},${last.y}`;
}

// ---------------------------------------------------------------- pan and zoom

type View = { x: number; y: number; k: number };
const clampK = (k: number) => Math.min(2.5, Math.max(0.15, k));
const MIN_FIT_K = 0.8;

function usePanZoom(layout: Layout | null, fitKey: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ id: number; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el || !layout || layout.width === 0) return;
    const cw = el.clientWidth, ch = el.clientHeight;
    // Never shrink below a readable size; a bigger graph starts at its top left and you drag to see the rest.
    const k = clampK(Math.max(MIN_FIT_K, Math.min((cw - 32) / layout.width, (ch - 56) / layout.height, 1.1)));
    const gw = layout.width * k, gh = layout.height * k;
    setView({ k, x: gw <= cw ? (cw - gw) / 2 : 8, y: gh <= ch - 48 ? (ch - 48 - gh) / 2 : 8 });
  }, [layout]);

  useLayoutEffect(() => { fit(); }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const el = ref.current;
    if (!el) return;
    const v = viewRef.current;
    const cx = px ?? el.clientWidth / 2, cy = py ?? el.clientHeight / 2;
    const k = clampK(v.k * factor);
    setView({ k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest(".dg-node,.dg-zoom,.dg-empty button")) return;
      drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) { d.moved = true; setPanning(true); }
      setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = drag.current;
      drag.current = null;
      setPanning(false);
      return d?.id === e.pointerId && !d.moved;
    },
  };
  return { ref, view, panning, fit, zoomAt, handlers };
}

// ---------------------------------------------------------------- small pieces

function Seg<T extends string>({ value, options, onChange, label, disabled }: {
  value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string; disabled?: boolean;
}) {
  return (
    <div className="dg-seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={v === value} disabled={disabled} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

function Badges({ info }: { info: NodeInfo }) {
  return (
    <>
      {info.inCycle ? <span className="dg-badge bad" title="This task is part of a loop of tasks blocking each other">Loop</span> : null}
      {info.staleWait ? <span className="dg-badge warn" title="Still blocked, but every blocker is closed">Stale</span> : null}
      {info.needsPerson ? <span className="dg-badge head" title="Blocked until a person acts; nothing else is running for it">Needs you</span> : null}
      {info.unattended ? <span className="dg-badge warn" title="Blocked, but it waits on no open task, no running job, no CI and no person: nothing will wake it">No wake-up</span> : null}
      {info.isHead && !info.inCycle ? <span className="dg-badge head" title={`Open, waiting on no other task, and holding up ${plural(info.holdingUp, "open task")}`}>Holds up {info.holdingUp}</span> : null}
    </>
  );
}

function TaskItem({ info, onPick, note }: { info: NodeInfo; onPick: (id: string) => void; note?: ReactNode }) {
  const t = info.task;
  return (
    <button type="button" className="dg-item" onClick={() => onPick(t.id)} title={`${taskLabel(t)} ${t.title}`}>
      <span className="dg-dot" style={{ ["--dg-st" as string]: stColor(t.status) }} />
      <span className="dg-t"><b>{taskLabel(t)}</b> <span className={isClosed(t.status) ? "dg-muted" : undefined}>{t.title}</span></span>
      {note != null ? <span className="dg-n">{note}</span> : null}
    </button>
  );
}

function WaitDetails({ w }: { w: Wait }) {
  const quiet = isQuiet(w);
  return (
    <dl className="dg-kv" style={{ marginTop: 8 }}>
      <dt>{WAIT_KIND[w.kind]}</dt><dd className="dg-mono">{w.title}</dd>
      {w.since ? <><dt>{w.kind === "job" ? "Running for" : "Waiting for"}</dt><dd>{since(w.since)}</dd></> : null}
      {w.detail ? <><dt>{w.kind === "job" ? "Last line" : "Note"}</dt><dd className="dg-mono">{w.detail}</dd></> : null}
      {w.logUpdatedAt ? <><dt>Last output</dt><dd>{ago(w.logUpdatedAt)}{quiet ? ": quiet for a while, it may be stuck" : ""}</dd></> : null}
      {w.log ? <><dt>Log</dt><dd className="dg-mono">{w.log}</dd></> : null}
      {w.pid ? <><dt>Process</dt><dd>{w.pid}</dd></> : null}
    </dl>
  );
}

/** What a blocked task waits for: its unblock note, running jobs and CI waits, and a warning when nothing is coming. */
function WaitingFor({ info }: { info: NodeInfo }) {
  const t = info.task;
  const u = t.unblock;
  if (t.status !== "blocked" && info.waits.length === 0) return null;
  return (
    <section>
      <h3>Waiting for</h3>
      {u ? <div className="dg-why"><b>{u.owner === "person" ? "You (the board)" : u.ownerName ?? "An agent"}:</b> {u.action}</div> : null}
      {info.waits.map((w) => <WaitDetails key={w.id} w={w} />)}
      {info.needsPerson ? <div className="dg-warnbox" style={{ marginTop: 8 }}>Nothing is running for it: it moves when you act.</div> : null}
      {info.unattended ? (
        <div className="dg-warnbox" style={{ marginTop: 8 }}>
          Nothing will wake it: no open task it waits on, no running job and no CI wait. If its note talks about a job,
          the job ended without reporting back. Check the task, then nudge its assignee.
        </div>
      ) : null}
      {!u && !info.waits.length && !info.unattended && !info.needsPerson ? <p className="dg-note">Only the tasks below.</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------- side panel

function AttentionPanel({ analysis, visible, onPick }: { analysis: Analysis; visible: Set<string>; onPick: (id: string) => void }) {
  const all = [...analysis.values()];
  const stale = all.filter((i) => i.staleWait && !isClosed(i.task.status));
  const heads = all.filter((i) => i.isHead && !i.inCycle).sort((a, b) => b.holdingUp - a.holdingUp).slice(0, 10);
  const loops = all.filter((i) => i.inCycle && !isClosed(i.task.status));
  const waiting = all.filter((i) => !isClosed(i.task.status) && i.openBlockers.length > 0).length;
  const person = all.filter((i) => i.needsPerson);
  const unattended = all.filter((i) => i.unattended);
  const waits = all.filter((i) => !isClosed(i.task.status)).flatMap((i) => i.waits.map((w) => ({ w, info: i })));
  const quiet = waits.filter(({ w }) => isQuiet(w));
  const jobs = waits.filter(({ w }) => w.kind === "job").length;
  const shown = [...visible].filter((id) => !isClosed(analysis.get(id)!.task.status)).length;
  return (
    <>
      <div>
        <h2>Needs attention</h2>
        <p className="dg-note" style={{ marginTop: 4 }}>
          {plural(waiting, "open task")} waiting on another task, {plural(jobs, "background job")} running,{" "}
          {plural(waits.length - jobs, "CI wait")}. {plural(shown, "open task")} in this view.
          Select a task to see what it waits on and what waits on it.
        </p>
      </div>
      {person.length ? (
        <section>
          <h3>Waiting on you</h3>
          <div className="dg-list">{person.map((i) => <TaskItem key={i.task.id} info={i} onPick={onPick} note={ago(i.task.updatedAt)} />)}</div>
          <p className="dg-note">Blocked until you act, by its own note. Select one to read what it asks.</p>
        </section>
      ) : null}
      <section>
        <h3>Blocked, and nothing will wake it</h3>
        {unattended.length === 0 ? <p className="dg-note">None.</p> : (
          <>
            <div className="dg-list">{unattended.map((i) => <TaskItem key={i.task.id} info={i} onPick={onPick} note={ago(i.task.updatedAt)} />)}</div>
            <p className="dg-note">No open task it waits on, no running job, no CI wait, and its note doesn&apos;t name you. Often a background job that died. Check it, then nudge its assignee.</p>
          </>
        )}
      </section>
      {quiet.length ? (
        <section>
          <h3>Jobs that have gone quiet</h3>
          <div className="dg-list">{quiet.map(({ w, info }) => <TaskItem key={w.id} info={info} onPick={onPick} note={`log ${ago(w.logUpdatedAt!)}`} />)}</div>
          <p className="dg-note">Still running, but their log hasn&apos;t changed for 30 minutes or more. They may be stuck.</p>
        </section>
      ) : null}
      <section>
        <h3>Still blocked, but every blocker is closed</h3>
        {stale.length === 0 ? <p className="dg-note">None.</p> : (
          <>
            <div className="dg-list">{stale.map((i) => <TaskItem key={i.task.id} info={i} onPick={onPick} note={ago(i.task.updatedAt)} />)}</div>
            <p className="dg-note">Paperclip should wake these when the last blocker closes. If one stays here, nudge its assignee or set its status by hand.</p>
          </>
        )}
      </section>
      {loops.length ? (
        <section>
          <h3>In a loop of tasks blocking each other</h3>
          <div className="dg-list">{loops.map((i) => <TaskItem key={i.task.id} info={i} onPick={onPick} />)}</div>
          <p className="dg-note">None of these can start until one link in the loop is removed.</p>
        </section>
      ) : null}
      <section>
        <h3>Holding up the most work</h3>
        {heads.length === 0 ? <p className="dg-note">Nothing open is holding up other open tasks.</p> : (
          <>
            <div className="dg-list">{heads.map((i) => <TaskItem key={i.task.id} info={i} onPick={onPick} note={`${i.holdingUp} waiting`} />)}</div>
            <p className="dg-note">Open tasks that wait on no other task, by how many open tasks are downstream of them. One marked Blocked is waiting on something else, like a person or a card.</p>
          </>
        )}
      </section>
    </>
  );
}

function TaskPanel({ info, analysis, focused, onPick, onFocus, onClose }: {
  info: NodeInfo; analysis: Analysis; focused: boolean;
  onPick: (id: string) => void; onFocus: (id: string | null) => void; onClose: () => void;
}) {
  const nav = useHostNavigation();
  const t = info.task;
  const parent = t.parentId ? analysis.get(t.parentId) : undefined;
  const sortOpenFirst = (ids: string[]) => ids.map((id) => analysis.get(id)!).sort((a, b) =>
    Number(isClosed(a.task.status)) - Number(isClosed(b.task.status)) || identifierNumber(a.task) - identifierNumber(b.task));
  const blockers = sortOpenFirst(info.blockers);
  const blocks = sortOpenFirst(info.blocks);
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="dg-top" style={{ fontSize: 12 }}>
            <span className="dg-dot" style={{ ["--dg-st" as string]: stColor(t.status) }} />
            <span className="dg-id">{taskLabel(t)}</span><span>{statusLabel(t.status)}</span>
          </div>
          <h2 style={{ marginTop: 4, overflowWrap: "anywhere" }}>{t.title}</h2>
        </div>
        <button type="button" className="dg-btn" onClick={onClose} aria-label="Close task details">✕</button>
      </div>
      <div className="dg-row">
        {t.identifier ? <a className="dg-btn" {...nav.linkProps(`/issues/${t.identifier}`)}>Open task</a> : null}
        {focused
          ? <button type="button" className="dg-btn" onClick={() => onFocus(null)}>Show all chains</button>
          : <button type="button" className="dg-btn" onClick={() => onFocus(t.id)}>Show only this chain</button>}
      </div>
      {info.staleWait ? <div className="dg-warnbox">Still marked blocked, but every task it waits on is closed. Paperclip should have woken it.</div> : null}
      {info.inCycle ? <div className="dg-warnbox">Part of a loop: it waits, through other tasks, on something that waits on it.</div> : null}
      <WaitingFor info={info} />
      <dl className="dg-kv">
        <dt>Assignee</dt><dd>{t.assigneeName ?? (t.assignedToUser ? "A board user" : <span className="dg-muted">Nobody</span>)}</dd>
        {t.priority ? <><dt>Priority</dt><dd>{t.priority}</dd></> : null}
        <dt>Updated</dt><dd>{ago(t.updatedAt)}</dd>
        {info.holdingUp ? <><dt>Holding up</dt><dd>{plural(info.holdingUp, "open task")}{info.isHead ? ", and waits on no other task" : ""}</dd></> : null}
      </dl>
      <section>
        <h3>Waits on {blockers.length ? `(${info.openBlockers.length} of ${blockers.length} still open)` : ""}</h3>
        {blockers.length === 0 ? <p className="dg-note">Nothing.</p>
          : <div className="dg-list">{blockers.map((i) => <TaskItem key={i.task.id} info={i} onPick={onPick} note={statusLabel(i.task.status)} />)}</div>}
      </section>
      <section>
        <h3>Blocks {blocks.length ? `(${blocks.length})` : ""}</h3>
        {blocks.length === 0 ? <p className="dg-note">Nothing.</p>
          : <div className="dg-list">{blocks.map((i) => <TaskItem key={i.task.id} info={i} onPick={onPick} note={statusLabel(i.task.status)} />)}</div>}
      </section>
      {parent ? (
        <section>
          <h3>Parent task</h3>
          <div className="dg-list"><TaskItem info={parent} onPick={onPick} note={statusLabel(parent.task.status)} /></div>
        </section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- page

export function DependencyGraphPage({ context }: PluginPageProps) {
  const { search } = useHostLocation();
  const nav = useHostNavigation();
  const { data, error } = useGraphData(context.companyId, 30_000);
  const [prefs, setPrefs] = usePrefs();
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [queryError, setQueryError] = useState<string | null>(null);

  // A saved project that's gone (or the only one left) shows all projects; the saved choice stays.
  const projectId = data && data.projects.length > 1 && data.projects.some((p) => p.id === prefs.projectId) ? prefs.projectId : "";
  const focusParam = new URLSearchParams(search).get("focus");
  const analysis = useMemo(() => (data ? analyse(data) : null), [data]);
  const focusTask = useMemo(() => (data && focusParam ? findTask(data, focusParam) : null), [data, focusParam]);

  const setFocus = useCallback((id: string | null) => {
    const t = id ? analysis?.get(id)?.task : null;
    nav.navigate(t ? `${PAGE}?focus=${encodeURIComponent(taskLabel(t))}` : PAGE);
  }, [analysis, nav]);

  const sel = useMemo(() => {
    if (!data || !analysis) return null;
    return select(data, analysis, {
      scope: prefs.scope, showClosed: prefs.showClosed, parentLinks: prefs.parentLinks,
      focusId: focusTask?.id ?? null, projectId: projectId || null,
    });
  }, [data, analysis, prefs.scope, prefs.showClosed, prefs.parentLinks, focusTask, projectId]);

  const structureKey = useMemo(() => (sel
    ? `${prefs.dir}|${[...sel.nodeIds].sort().join(",")}|${sel.edges.map(edgeKey).sort().join(",")}`
    : ""), [sel, prefs.dir]);
  // Re-run the layout only when the drawn structure changes, not on every refresh.
  const layout = useMemo(() => (sel && analysis ? layoutGraph(sel, analysis, prefs.dir) : null), [structureKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const fitKey = `${prefs.dir}|${focusTask?.id ?? ""}|${prefs.scope}|${prefs.showClosed}|${prefs.parentLinks}|${projectId}|${layout ? "ready" : ""}`;
  const pz = usePanZoom(layout, fitKey);

  useEffect(() => { if (focusTask) setSelected(focusTask.id); }, [focusTask?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const active = hovered ?? selected;
  const chain = useMemo(() => (active && sel && (sel.nodeIds.includes(active) || sel.waitIds.includes(active)) ? chainOf(active, sel.edges) : null), [active, sel]);
  const waitById = useMemo(() => new Map((data?.waits ?? []).map((w) => [w.id, w])), [data]);
  const visible = useMemo(() => new Set(sel?.nodeIds ?? []), [sel]);

  const pick = (id: string) => {
    setSelected(id);
    if (!visible.has(id)) setFocus(id);
  };
  const goTo = () => {
    if (!data) return;
    const t = findTask(data, query);
    if (!t) { setQueryError(`No task "${query.trim()}"`); return; }
    setQueryError(null);
    setQuery("");
    setFocus(t.id);
  };

  const selectedInfo = selected ? analysis?.get(selected) : undefined;
  const statusesShown = useMemo(() => {
    const s = new Set((sel?.nodeIds ?? []).map((id) => analysis!.get(id)!.task.status));
    return STATUS_ORDER.filter((x) => s.has(x));
  }, [sel, analysis]);

  return (
    <main className="dg-root">
      <style>{CSS}</style>
      <div className="dg-head">
        <div>
          <h1>Dependencies</h1>
          <p className="dg-sub">
            Which tasks wait on which, and on what outside Paperclip: dashed boxes are running background jobs and CI waits.
            An arrow goes from a blocker to the task it blocks, so work flows {prefs.dir === "LR" ? "left to right" : "top to bottom"}.
            Hover a task to light up its whole chain.
          </p>
        </div>
        <form className="dg-search" onSubmit={(e) => { e.preventDefault(); goTo(); }}>
          <input aria-label="Go to task" placeholder="Task, e.g. NEV-123" value={query}
            onChange={(e) => { setQuery(e.target.value); setQueryError(null); }} />
          <button type="submit" className="dg-btn">Show chain</button>
          {queryError ? <span className="dg-err" style={{ fontSize: 12 }} role="alert">{queryError}</span> : null}
        </form>
      </div>

      <div className="dg-controls" role="group" aria-label="View options">
        {focusTask ? (
          <span className="dg-chip">Chain of <b>{taskLabel(focusTask)}</b>
            <button type="button" aria-label="Show all chains" onClick={() => setFocus(null)}>✕</button>
          </span>
        ) : (
          <Seg label="Which chains" value={prefs.scope} onChange={(scope) => setPrefs({ scope })}
            options={[["open", "Chains with open work"], ["all", "Every chain"]]} />
        )}
        <Seg label="Finished tasks" value={prefs.showClosed ? "show" : "hide"} onChange={(v) => setPrefs({ showClosed: v === "show" })}
          options={[["show", "Show finished"], ["hide", "Hide finished"]]} />
        <Seg label="Links" value={prefs.parentLinks ? "parents" : "blockers"} onChange={(v) => setPrefs({ parentLinks: v === "parents" })}
          options={[["blockers", "Blockers"], ["parents", "Blockers and parents"]]} />
        <Seg label="Direction" value={prefs.dir} onChange={(dir) => setPrefs({ dir })} options={[["LR", "Left to right"], ["TB", "Top to bottom"]]} />
        {data && data.projects.length > 1 ? (
          <select aria-label="Project" className="dg-btn" value={projectId} onChange={(e) => setPrefs({ projectId: e.target.value })}>
            <option value="">All projects</option>
            {data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        ) : null}
        {sel && data ? <span className="dg-ctl-label">{plural(sel.nodeIds.length, "task")} · {plural(sel.edges.length, "link")} · updated {ago(data.generatedAt)}</span> : null}
      </div>

      {error ? <p className="dg-err" role="alert">Couldn&apos;t load dependencies: {error}</p> : null}
      {!data && !error ? <p className="dg-muted">Loading…</p> : null}

      {data && analysis && sel && layout ? (
        <>
          <div className="dg-legend" aria-label="Legend">
            {statusesShown.map((s) => <span key={s}><i className="dg-sw" style={{ background: stColor(s) }} />{statusLabel(s)}</span>)}
            <span><svg width="26" height="8" aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke="var(--muted-foreground)" strokeWidth="1.5" /></svg>Blocks</span>
            <span><svg width="26" height="8" aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke="var(--muted-foreground)" strokeOpacity=".3" strokeWidth="1.5" /></svg>Blocker finished</span>
            <span><i className="dg-sw" style={{ border: "1px dashed var(--muted-foreground)", background: "transparent" }} />Job or CI it waits on</span>
            {prefs.parentLinks ? <span><svg width="26" height="8" aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke="var(--muted-foreground)" strokeOpacity=".6" strokeDasharray="5 4" strokeWidth="1.5" /></svg>Parent of</span> : null}
          </div>
          <div className="dg-main">
            <div ref={pz.ref} className={`dg-canvas${pz.panning ? " panning" : ""}`}
              onPointerDown={pz.handlers.onPointerDown} onPointerMove={pz.handlers.onPointerMove}
              onPointerUp={(e) => { if (pz.handlers.onPointerUp(e) && !(e.target as HTMLElement).closest(".dg-node,.dg-zoom,.dg-empty")) setSelected(null); }}
              onPointerCancel={pz.handlers.onPointerUp}>
              {sel.nodeIds.length === 0 ? (
                <div className="dg-empty">
                  <p style={{ margin: 0 }}>
                    {focusTask ? `${taskLabel(focusTask)} waits on nothing and blocks nothing.`
                      : prefs.scope === "open" ? "No open task waits on another one, and nothing is blocked, right now." : "No task is linked to another yet."}
                  </p>
                  <p style={{ margin: 0, fontSize: 12 }}>Links appear when an agent or you set &ldquo;Blocked by&rdquo; on a task.</p>
                  {!focusTask && prefs.scope === "open" ? <button type="button" className="dg-btn" onClick={() => setPrefs({ scope: "all" })}>Show every chain</button> : null}
                </div>
              ) : (
                <div className="dg-world" style={{ transform: `translate(${pz.view.x}px,${pz.view.y}px) scale(${pz.view.k})`, width: layout.width, height: layout.height }}>
                  <svg width={layout.width} height={layout.height} aria-hidden>
                    <defs>
                      {[["a", "var(--muted-foreground)", 0.75], ["r", "var(--muted-foreground)", 0.3], ["p", "var(--muted-foreground)", 0.45], ["h", "var(--dg-hi)", 1], ["d", "var(--muted-foreground)", 0.1]].map(([id, fill, op]) => (
                        <marker key={id as string} id={`dg-arrow-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                          <path d="M0,1 L9,5 L0,9 z" style={{ fill: fill as string, fillOpacity: op as number }} />
                        </marker>
                      ))}
                    </defs>
                    {layout.edges.map(({ edge, key, points }) => {
                      const hi = chain?.edgeKeys.has(key) ?? false;
                      const dim = !!chain && !hi;
                      const cls = `dg-edge${edge.kind === "parent" ? " parent" : ""}${edge.resolved ? " resolved" : ""}${hi ? " hi" : ""}${dim ? " dim" : ""}`;
                      const m = hi ? "h" : dim ? "d" : edge.kind === "parent" ? "p" : edge.resolved ? "r" : "a";
                      return <path key={key} className={cls} d={curve(points)} markerEnd={`url(#dg-arrow-${m})`} />;
                    })}
                  </svg>
                  {layout.nodes.map(({ id, x, y }) => {
                    const w = waitById.get(id);
                    if (w || !analysis.has(id)) {
                      if (!w) return null; // gone since the last layout; the next one drops it
                      const owner = analysis.get(w.taskId)?.task;
                      const inChain = !chain || chain.up.has(id) || chain.down.has(id);
                      const quiet = isQuiet(w);
                      const cls = ["dg-node", "wait", inChain ? "" : "dim", selected === w.taskId ? "sel" : ""].filter(Boolean).join(" ");
                      const label = `${WAIT_KIND[w.kind]} for ${owner ? taskLabel(owner) : "a task"}: ${w.title}`;
                      return (
                        <div key={id} className={cls} role="button" tabIndex={0} aria-label={label} title={w.detail ? `${w.title}\n${w.detail}` : w.title}
                          style={{ left: x - NODE_W / 2, top: y - NODE_H / 2, width: NODE_W, height: NODE_H, ["--dg-st" as string]: waitColor(w) }}
                          onClick={() => setSelected(w.taskId)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(w.taskId); } }}
                          onMouseEnter={() => setHovered(id)} onMouseLeave={() => setHovered(null)}
                          onFocus={() => setHovered(id)} onBlur={() => setHovered(null)}>
                          <div className="dg-top">
                            <span className="dg-kind">{WAIT_KIND[w.kind]}</span>
                            <span>{w.kind === "job" ? "running" : "waiting"} {since(w.since)}</span>
                            <span className="dg-push" />
                            {quiet ? <span className="dg-badge warn" title="Its log hasn't changed for 30 minutes or more">Quiet</span> : null}
                          </div>
                          <div className="dg-title">{w.title}</div>
                          <div className="dg-detail">{w.detail ?? (w.kind === "ci" ? "Wakes the task when CI finishes" : "Wakes the task when it ends")}</div>
                        </div>
                      );
                    }
                    const info = analysis.get(id)!;
                    const t = info.task;
                    const inChain = !chain || chain.up.has(id) || chain.down.has(id);
                    const cls = ["dg-node", isClosed(t.status) ? "closed" : "", t.status === "cancelled" ? "cancelled" : "",
                      info.staleWait ? "stale" : "", inChain ? "" : "dim", selected === id ? "sel" : "", focusTask?.id === id ? "focus" : ""].filter(Boolean).join(" ");
                    return (
                      <div key={id} className={cls} role="button" tabIndex={0}
                        aria-label={`${taskLabel(t)}, ${statusLabel(t.status)}: ${t.title}`} aria-pressed={selected === id}
                        style={{ left: x - NODE_W / 2, top: y - NODE_H / 2, width: NODE_W, height: NODE_H, ["--dg-st" as string]: stColor(t.status) }}
                        onClick={() => setSelected(id)}
                        onDoubleClick={() => setFocus(id)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(id); } }}
                        onMouseEnter={() => setHovered(id)} onMouseLeave={() => setHovered(null)}
                        onFocus={() => setHovered(id)} onBlur={() => setHovered(null)}>
                        <div className="dg-top">
                          <span className="dg-dot" /><span className="dg-id">{taskLabel(t)}</span><span>{statusLabel(t.status)}</span>
                          <span className="dg-push" /><Badges info={info} />
                        </div>
                        <div className="dg-title" title={t.title}>{t.title}</div>
                      </div>
                    );
                  })}
                </div>
              )}
              {sel.nodeIds.length ? (
                <div className="dg-zoom">
                  <button type="button" className="dg-btn" aria-label="Zoom in" onClick={() => pz.zoomAt(1.25)}>+</button>
                  <button type="button" className="dg-btn" aria-label="Zoom out" onClick={() => pz.zoomAt(0.8)}>−</button>
                  <button type="button" className="dg-btn" onClick={pz.fit}>Fit</button>
                </div>
              ) : null}
            </div>
            <aside className="dg-panel" aria-label={selectedInfo ? "Task details" : "Needs attention"}>
              {selectedInfo
                ? <TaskPanel info={selectedInfo} analysis={analysis} focused={focusTask?.id === selectedInfo.task.id}
                    onPick={pick} onFocus={setFocus} onClose={() => setSelected(null)} />
                : <AttentionPanel analysis={analysis} visible={visible} onPick={pick} />}
            </aside>
          </div>
          <p className="dg-note" style={{ margin: 0 }}>
            Drag to move, scroll to zoom. Click a task for details, double-click to show only its chain. Links come from each task&apos;s
            &ldquo;Blocked by&rdquo; list; a finished or cancelled blocker no longer holds anything up. Jobs are processes that will run
            paperclip-notify for a task; CI waits come from paperclip-wait.
          </p>
        </>
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------- header button and sidebar link

type Counts = { stale: number; unattended: number; person: number };
function useCounts(companyId: string | null): Counts {
  const { data } = useGraphData(companyId, 120_000);
  return useMemo(() => {
    const all = data ? [...analyse(data).values()].filter((i) => !isClosed(i.task.status)) : [];
    return { stale: all.filter((i) => i.staleWait).length, unattended: all.filter((i) => i.unattended).length, person: all.filter((i) => i.needsPerson).length };
  }, [data]);
}

export function DependencyGraphSidebarLink(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  return (
    <a {...nav.linkProps(PAGE)}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80"
      style={{ textDecoration: "none" }}>
      <span className="flex-1 truncate">Dependencies</span>
    </a>
  );
}

export function DependencyGraphToolbarButton({ context }: PluginWidgetProps) {
  const nav = useHostNavigation();
  const c = useCounts(context.companyId);
  const stale = c.stale + c.unattended + c.person;
  const hint = stale ? [
    c.person ? `${plural(c.person, "task")} waiting on you` : "",
    c.unattended ? `${plural(c.unattended, "blocked task")} nothing will wake` : "",
    c.stale ? `${plural(c.stale, "task")} still blocked though every blocker is closed` : "",
  ].filter(Boolean).join("; ") : "Which tasks wait on which";
  return (
    <a {...nav.linkProps(PAGE)} aria-label={`Dependencies. ${hint}`} title={hint}
      style={{
        padding: "6px 12px", fontSize: 13, borderRadius: 6, border: "1px solid var(--border)", color: "var(--foreground)",
        display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", whiteSpace: "nowrap",
      }}>
      Dependencies
      {stale ? (
        <span style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, background: "#d97706", color: "#fff",
          fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}>{stale}</span>
      ) : null}
    </a>
  );
}
