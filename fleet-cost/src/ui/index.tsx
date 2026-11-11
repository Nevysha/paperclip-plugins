import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useHostLocation,
  useHostNavigation,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  PRICES_AS_OF, RATES, CACHE_WRITE_MULTIPLIER, FALLBACK_MODEL,
  addDays, costOf, daysBetween, daysInMonth, groupBy, monthKey, monthsBetween, rateFor, tokensOf, total,
  weekKey, weeksBetween, type CacheTtl, type Totals, type UsageRow,
} from "../pricing.js";

const API = "/api/plugins/nevysha.fleet-cost/api/usage";
const TTL_KEY = "nevysha.fleet-cost.ttl";

// ---------------------------------------------------------------- data

type Usage = { rows: UsageRow[]; timeZone: string; generatedAt: string };

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function useUsage(companyId: string | null, refreshKey: unknown) {
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!companyId) return;
    let live = true;
    const params = new URLSearchParams({ companyId, tz: viewerTimeZone() });
    fetch(`${API}?${params}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
        return json as Usage;
      })
      .then((json) => { if (live) { setData(json); setError(null); } })
      .catch((err: Error) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [companyId, refreshKey, tick]);
  return { data, error };
}

function useTtl(): [CacheTtl, (t: CacheTtl) => void] {
  const [ttl, setTtl] = useState<CacheTtl>(() => {
    try { return localStorage.getItem(TTL_KEY) === "5m" ? "5m" : "1h"; } catch { return "1h"; }
  });
  return [ttl, (t) => { setTtl(t); try { localStorage.setItem(TTL_KEY, t); } catch { /* per-viewer convenience only */ } }];
}

// ---------------------------------------------------------------- formatting

export function usd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}
export function tok(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 1 : 2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return String(Math.round(v));
}
const pct = (v: number) => `${Math.round(v * 100)}%`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

// ---------------------------------------------------------------- styles

const CSS = `
.fc-root{--fc-s1:#2a78d6;--fc-s2:#eb6834;--fc-s3:#1baf7a;--fc-s4:#eda100;--fc-s5:#e87ba4;--fc-s6:#008300;--fc-s7:#6250d6;--fc-other:#a3a29c;
  color:var(--foreground);padding:24px 16px 48px;max-width:1200px;margin:0 auto;display:flex;flex-direction:column;gap:16px;font-size:14px}
.dark .fc-root{--fc-s1:#3987e5;--fc-s2:#d95926;--fc-s3:#199e70;--fc-s4:#c98500;--fc-s5:#d55181;--fc-s6:#008300;--fc-s7:#9085e9;--fc-other:#6b6a65}
.fc-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px}
.fc-head h1{font-size:20px;font-weight:600;margin:0}
.fc-sub{color:var(--muted-foreground);font-size:13px;margin:4px 0 0;max-width:640px}
.fc-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:12px}
.fc-table.wide{min-width:720px}
.fc-tile,.fc-card{background:var(--card);border:1px solid var(--border);border-radius:10px}
.fc-tile{padding:14px 16px;display:flex;flex-direction:column;gap:2px;min-width:0}
.fc-tile-label{font-size:12px;color:var(--muted-foreground)}
.fc-tile-value{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
.fc-tile-value.sm{font-size:20px}
.fc-tile-note{font-size:12px;color:var(--muted-foreground);font-variant-numeric:tabular-nums}
.fc-card{padding:16px;display:flex;flex-direction:column;gap:12px;min-width:0}
.fc-card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.fc-card h2{font-size:15px;font-weight:600;margin:0}
.fc-seg{display:inline-flex;flex-wrap:wrap;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.fc-seg button{all:unset;cursor:pointer;padding:4px 10px;font-size:12px;white-space:nowrap;color:var(--muted-foreground)}
.fc-seg button[aria-pressed=true]{background:var(--accent);color:var(--foreground);font-weight:600}
.fc-seg button:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.fc-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.fc-ctl-label{font-size:12px;color:var(--muted-foreground)}
.fc-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--muted-foreground)}
.fc-legend span{display:inline-flex;align-items:center;gap:6px}
.fc-sw{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
.fc-chart{position:relative}
.fc-chart svg{display:block;overflow:visible}
.fc-axis{fill:var(--muted-foreground);font-size:11px;font-variant-numeric:tabular-nums}
.fc-tip{position:absolute;pointer-events:none;background:var(--popover);color:var(--popover-foreground);border:1px solid var(--border);
  border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.18);min-width:180px;z-index:5}
.fc-tip-row{display:flex;align-items:center;gap:6px;justify-content:space-between;font-variant-numeric:tabular-nums}
.fc-tip-row .k{display:inline-flex;align-items:center;gap:6px;color:var(--muted-foreground)}
.fc-tip b{font-weight:600}
.fc-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:16px}
.fc-bars{display:flex;flex-direction:column;gap:2px}
.fc-bar-row{position:relative;display:grid;grid-template-columns:minmax(90px,150px) 1fr auto;gap:10px;align-items:center;padding:5px 6px;border-radius:6px}
.fc-bar-row:hover{background:var(--accent)}
.fc-bar-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.fc-bar-track{height:12px;display:flex;align-items:center}
.fc-bar-fill{height:12px;border-radius:0 4px 4px 0;min-width:2px}
.fc-bar-val{font-size:12px;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.fc-bar-val small{color:var(--muted-foreground);margin-left:6px}
.fc-table{width:100%;border-collapse:collapse;font-size:13px}
.fc-table th{text-align:left;font-weight:500;color:var(--muted-foreground);font-size:12px;padding:6px 8px;border-bottom:1px solid var(--border)}
.fc-table td{padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
.fc-table tr:last-child td{border-bottom:0}
.fc-num{text-align:right!important;font-variant-numeric:tabular-nums;white-space:nowrap}
.fc-muted{color:var(--muted-foreground)}
.fc-scroll{overflow-x:auto}
.fc-foot{font-size:12px;color:var(--muted-foreground);line-height:1.6}
.fc-link{color:inherit;text-decoration:underline;text-underline-offset:2px}
.fc-err{color:var(--destructive)}
`;

// ---------------------------------------------------------------- small pieces

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="fc-seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

function Tile({ label, value, note, small }: { label: string; value: string; note?: ReactNode; small?: boolean }) {
  return (
    <div className="fc-tile">
      <span className="fc-tile-label">{label}</span>
      <span className={`fc-tile-value${small ? " sm" : ""}`}>{value}</span>
      {note ? <span className="fc-tile-note">{note}</span> : null}
    </div>
  );
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number): { max: number; step: number } {
  if (v <= 0) return { max: 1, step: 0.25 };
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { max: Math.ceil(v / step) * step, step };
}

/** Rect with only the top two corners rounded: the data end, anchored to the baseline. */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

// ---------------------------------------------------------------- stacked bar chart

type Series = { id: string; label: string; color: string };
type Bucket = { key: string; label: string; values: Record<string, number>; totals: Totals };

function StackedBars({ buckets, series }: { buckets: Bucket[]; series: Series[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 260, padL = 52, padB = 24, padT = 8;
  const innerW = Math.max(0, width - padL - 4);
  const innerH = H - padB - padT;
  const sums = buckets.map((b) => series.reduce((s, x) => s + (b.values[x.id] ?? 0), 0));
  const { max, step } = niceMax(Math.max(0, ...sums));
  const slot = buckets.length ? innerW / buckets.length : 0;
  const barW = Math.max(2, Math.min(48, slot * 0.7));
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const every = Math.max(1, Math.ceil((buckets.length * 52) / Math.max(1, innerW)));
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);

  const hb = hover != null ? buckets[hover] : null;
  const tipLeft = hover != null ? Math.min(Math.max(0, padL + slot * hover + slot / 2 - 100), Math.max(0, width - 210)) : 0;

  return (
    <div className="fc-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {width > 0 ? (
        <svg width={width} height={H} role="img" aria-label="Cost at API prices over time">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - 4} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
              <text className="fc-axis" x={padL - 8} y={y(t) + 4} textAnchor="end">{usd(t)}</text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const cx = padL + slot * i + slot / 2;
            let acc = 0;
            const segs = series.map((s) => ({ s, v: b.values[s.id] ?? 0 })).filter((x) => x.v > 0);
            return (
              <g key={b.key} opacity={hover == null || hover === i ? 1 : 0.45}>
                {segs.map(({ s, v }, j) => {
                  const y0 = y(acc), y1 = y(acc + v);
                  acc += v;
                  const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0)); // 2px surface gap between segments
                  if (h <= 0) return null;
                  const top = j === segs.length - 1;
                  return top
                    ? <path key={s.id} d={topRounded(cx - barW / 2, y1, barW, h, 4)} fill={s.color} />
                    : <rect key={s.id} x={cx - barW / 2} y={y1} width={barW} height={h} fill={s.color} />;
                })}
                {i % every === 0 ? <text className="fc-axis" x={cx} y={H - 6} textAnchor="middle">{b.label}</text> : null}
                <rect x={padL + slot * i} y={padT} width={slot} height={innerH} fill="transparent"
                  onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}
                  aria-label={`${b.label}: ${usd(sums[i]!)}`} />
              </g>
            );
          })}
        </svg>
      ) : <div style={{ height: H }} />}
      {hb ? (
        <div className="fc-tip" style={{ left: tipLeft, top: 0 }}>
          <div className="fc-tip-row" style={{ marginBottom: 4 }}><b>{hb.label}</b><b>{usd(sums[hover!]!)}</b></div>
          {[...series].reverse().filter((s) => (hb.values[s.id] ?? 0) > 0).map((s) => (
            <div key={s.id} className="fc-tip-row">
              <span className="k"><i className="fc-sw" style={{ background: s.color }} />{s.label}</span>
              <span>{usd(hb.values[s.id]!)}</span>
            </div>
          ))}
          <div className="fc-tip-row fc-muted" style={{ marginTop: 4 }}><span>{tok(hb.totals.tokens.total)} tokens</span><span>{hb.totals.runs} runs</span></div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- page

type Grain = "day" | "week" | "month";
type Split = "kind" | "agent";
type Period = "7d" | "30d" | "week" | "month" | "all";

const KIND_SERIES: Series[] = [
  { id: "cacheRead", label: "Cache reads", color: "var(--fc-s1)" },
  { id: "cacheWrite", label: "Cache writes", color: "var(--fc-s2)" },
  { id: "output", label: "Output", color: "var(--fc-s3)" },
  { id: "input", label: "Input", color: "var(--fc-s4)" },
];
const AGENT_COLORS = ["--fc-s1", "--fc-s2", "--fc-s3", "--fc-s4", "--fc-s5", "--fc-s6", "--fc-s7"].map((v) => `var(${v})`);

function inPeriod(period: Period, today: string): (day: string) => boolean {
  switch (period) {
    case "7d": { const from = addDays(today, -6); return (d) => d >= from; }
    case "30d": { const from = addDays(today, -29); return (d) => d >= from; }
    case "week": { const from = weekKey(today); return (d) => d >= from; }
    case "month": { const m = monthKey(today); return (d) => monthKey(d) === m; }
    default: return () => true;
  }
}

export function FleetCostPage({ context }: PluginPageProps) {
  const { pathname } = useHostLocation();
  const nav = useHostNavigation();
  const { data, error } = useUsage(context.companyId, pathname);
  const [ttl, setTtl] = useTtl();
  const [grain, setGrain] = useState<Grain>("day");
  const [split, setSplit] = useState<Split>("kind");
  const [period, setPeriod] = useState<Period>("all");
  const today = localToday();

  const view = useMemo(() => {
    if (!data) return null;
    const rows = data.rows;
    const sel = (f: (d: string) => boolean) => rows.filter((r) => f(r.day));
    const all = total(rows, ttl);
    const todayT = total(sel((d) => d === today), ttl);
    const weekT = total(sel(inPeriod("week", today)), ttl);
    const monthT = total(sel(inPeriod("month", today)), ttl);
    const last7 = total(sel(inPeriod("7d", today)), ttl);
    const firstDay = rows.length ? rows[0]!.day : today;
    const days7 = Math.min(7, daysBetween(firstDay, today).length);
    const monthDays = daysBetween(monthKey(today) + "-01" < firstDay ? firstDay : monthKey(today) + "-01", today).length;
    const projection = monthDays > 0 ? (monthT.cost.total / monthDays) * daysInMonth(monthKey(today)) : 0;
    const unknownModels = [...new Set(rows.filter((r) => !rateFor(r.model).known).map((r) => r.model || "(none)"))];

    // Stable agent colours: rank by all-time cost, so a period filter never repaints an agent.
    const byAgentAll = [...groupBy(rows, (r) => r.agentId ?? "none", ttl)].sort((a, b) => b[1].cost.total - a[1].cost.total);
    const agentName = new Map(rows.map((r) => [r.agentId ?? "none", r.agentName ?? "Unknown agent"]));
    const colourOf = new Map(byAgentAll.slice(0, AGENT_COLORS.length).map(([id], i) => [id, AGENT_COLORS[i]!]));

    // Time series
    const keyOf = grain === "day" ? (d: string) => d : grain === "week" ? weekKey : monthKey;
    let keys = grain === "day" ? daysBetween(firstDay, today) : grain === "week" ? weeksBetween(firstDay, today) : monthsBetween(firstDay, today);
    if (grain === "day" && keys.length > 60) keys = keys.slice(-60);
    const label = grain === "month" ? monthLabel : grain === "week" ? (k: string) => `wk ${dayLabel(k)}` : dayLabel;
    const series: Series[] = split === "kind"
      ? KIND_SERIES
      : [
          ...byAgentAll.slice(0, AGENT_COLORS.length).map(([id]) => ({ id, label: agentName.get(id)!, color: colourOf.get(id)! })),
          ...(byAgentAll.length > AGENT_COLORS.length ? [{ id: "other", label: "Other agents", color: "var(--fc-other)" }] : []),
        ];
    const bucketMap = new Map<string, UsageRow[]>();
    for (const r of rows) { const k = keyOf(r.day); (bucketMap.get(k) ?? bucketMap.set(k, []).get(k)!).push(r); }
    const buckets: Bucket[] = keys.map((k) => {
      const rs = bucketMap.get(k) ?? [];
      const values: Record<string, number> = {};
      for (const r of rs) {
        const c = costOf(r, ttl);
        if (split === "kind") {
          for (const s of KIND_SERIES) values[s.id] = (values[s.id] ?? 0) + c[s.id as "input"];
        } else {
          const id = colourOf.has(r.agentId ?? "none") ? (r.agentId ?? "none") : "other";
          values[id] = (values[id] ?? 0) + c.total;
        }
      }
      return { key: k, label: label(k), values, totals: total(rs, ttl) };
    });

    // Period breakdowns
    const pRows = sel(inPeriod(period, today));
    const pTotal = total(pRows, ttl);
    const agents = [...groupBy(pRows, (r) => r.agentId ?? "none", ttl)]
      .map(([id, t]) => ({ id, name: agentName.get(id)!, t, colour: colourOf.get(id) ?? "var(--fc-other)" }))
      .sort((a, b) => b.t.cost.total - a.t.cost.total);
    const taskInfo = new Map(pRows.map((r) => [r.issueId ?? "none", r]));
    const taskAgents = new Map<string, Set<string>>();
    for (const r of pRows) { const k = r.issueId ?? "none"; (taskAgents.get(k) ?? taskAgents.set(k, new Set()).get(k)!).add(r.agentName ?? "Unknown"); }
    const tasks = [...groupBy(pRows, (r) => r.issueId ?? "none", ttl)]
      .map(([id, t]) => ({ id, info: taskInfo.get(id)!, agents: [...taskAgents.get(id)!], t }))
      .sort((a, b) => b.t.cost.total - a.t.cost.total);
    const days = [...groupBy(pRows, (r) => r.day as string, ttl)].sort((a, b) => (a[0] < b[0] ? 1 : -1));

    return { all, todayT, weekT, monthT, last7, days7, projection, monthDays, unknownModels, series, buckets, pTotal, agents, tasks, days, firstDay };
  }, [data, ttl, grain, split, period, today]);

  return (
    <main className="fc-root">
      <style>{CSS}</style>
      <div className="fc-head">
        <div>
          <h1>Fleet cost</h1>
          <p className="fc-sub">
            What the fleet&apos;s Claude usage would cost at API prices. You pay a flat subscription, so this is an estimate of the value used, not a bill.
          </p>
        </div>
        <div className="fc-controls">
          <span className="fc-ctl-label">Price cache writes at</span>
          <Seg label="Cache write price" value={ttl} onChange={setTtl} options={[["1h", "1-hour rate"], ["5m", "5-minute rate"]]} />
        </div>
      </div>

      {error ? <p className="fc-err" role="alert">Couldn&apos;t load usage: {error}</p> : null}
      {!view && !error ? <p className="fc-muted">Loading…</p> : null}

      {view ? (
        <>
          <section className="fc-tiles" aria-label="Totals">
            <Tile label="Today" value={usd(view.todayT.cost.total)} note={`${tok(view.todayT.tokens.total)} tokens · ${view.todayT.runs} runs`} />
            <Tile label="This week" value={usd(view.weekT.cost.total)} note={`${tok(view.weekT.tokens.total)} tokens · ${view.weekT.runs} runs`} />
            <Tile label="This month" value={usd(view.monthT.cost.total)} note={`${tok(view.monthT.tokens.total)} tokens · ${view.monthT.runs} runs`} />
            <Tile label="All time, whole fleet" value={usd(view.all.cost.total)} note={`${tok(view.all.tokens.total)} tokens · ${view.all.runs} runs since ${dayLabel(view.firstDay)}`} />
          </section>
          <section className="fc-tiles" aria-label="Rates">
            <Tile small label="Average day (last 7 days)" value={usd(view.days7 ? view.last7.cost.total / view.days7 : 0)} note={`${tok(view.days7 ? view.last7.tokens.total / view.days7 : 0)} tokens a day`} />
            <Tile small label="Month at this pace" value={usd(view.projection)} note={`from ${view.monthDays} day${view.monthDays === 1 ? "" : "s"} of data this month`} />
            <Tile small label="Average run" value={usd(view.all.runs ? view.all.cost.total / view.all.runs : 0)} note={`${tok(view.all.runs ? view.all.tokens.total / view.all.runs : 0)} tokens a run`} />
            <Tile small label="Cache reads" value={pct(view.all.tokens.total ? view.all.tokens.cacheRead / view.all.tokens.total : 0)}
              note={`of tokens, ${pct(view.all.cost.total ? view.all.cost.cacheRead / view.all.cost.total : 0)} of cost`} />
          </section>

          <section className="fc-card" aria-label="Cost over time">
            <div className="fc-card-head">
              <h2>Cost over time</h2>
              <div className="fc-controls">
                <Seg label="Group by" value={grain} onChange={setGrain} options={[["day", "Day"], ["week", "Week"], ["month", "Month"]]} />
                <Seg label="Split by" value={split} onChange={setSplit} options={[["kind", "Token type"], ["agent", "Agent"]]} />
              </div>
            </div>
            <div className="fc-legend">
              {view.series.map((s) => <span key={s.id}><i className="fc-sw" style={{ background: s.color }} />{s.label}</span>)}
            </div>
            <StackedBars buckets={view.buckets} series={view.series} />
          </section>

          <div className="fc-controls" role="group" aria-label="Period for the breakdowns below">
            <span className="fc-ctl-label">Breakdowns for</span>
            <Seg label="Period" value={period} onChange={setPeriod}
              options={[["7d", "7 days"], ["30d", "30 days"], ["week", "This week"], ["month", "This month"], ["all", "All time"]]} />
            <span className="fc-ctl-label">{usd(view.pTotal.cost.total)} · {tok(view.pTotal.tokens.total)} tokens · {view.pTotal.runs} runs</span>
          </div>

          <div className="fc-grid2">
            <section className="fc-card" aria-label="By agent">
              <h2>By agent</h2>
              {view.agents.length === 0 ? <p className="fc-muted">No runs in this period.</p> : (
                <div className="fc-bars">
                  {view.agents.map((a) => (
                    <AgentBar key={a.id} name={a.name} t={a.t} colour={a.colour}
                      max={view.agents[0]!.t.cost.total} share={view.pTotal.cost.total ? a.t.cost.total / view.pTotal.cost.total : 0} />
                  ))}
                </div>
              )}
            </section>
            <section className="fc-card" aria-label="By day">
              <h2>By day</h2>
              <div className="fc-scroll" style={{ maxHeight: 420 }}>
                <table className="fc-table">
                  <thead><tr><th>Day</th><th className="fc-num">Cost</th><th className="fc-num">Tokens</th><th className="fc-num">Output</th><th className="fc-num">Runs</th></tr></thead>
                  <tbody>
                    {view.days.map(([d, t]) => (
                      <tr key={d}><td>{dayLabel(d)}</td><td className="fc-num">{usd(t.cost.total)}</td><td className="fc-num">{tok(t.tokens.total)}</td>
                        <td className="fc-num fc-muted">{tok(t.tokens.output)}</td><td className="fc-num fc-muted">{t.runs}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="fc-card" aria-label="Most expensive tasks">
            <h2>Most expensive tasks</h2>
            <div className="fc-scroll">
              <table className="fc-table wide">
                <thead><tr><th>Task</th><th>Agents</th><th className="fc-num">Cost</th><th className="fc-num">Tokens</th><th className="fc-num">Runs</th><th className="fc-num">Per run</th></tr></thead>
                <tbody>
                  {view.tasks.slice(0, 20).map(({ id, info, agents, t }) => (
                    <tr key={id}>
                      <td>
                        {info.issueIdentifier
                          ? <a className="fc-link" {...nav.linkProps(`/issues/${info.issueIdentifier}`)}>{info.issueIdentifier}</a>
                          : <span className="fc-muted">No task</span>}
                        {info.issueTitle ? <span className="fc-muted"> {info.issueTitle.length > 70 ? info.issueTitle.slice(0, 70) + "…" : info.issueTitle}</span> : null}
                      </td>
                      <td className="fc-muted">{agents.join(", ")}</td>
                      <td className="fc-num">{usd(t.cost.total)}</td>
                      <td className="fc-num">{tok(t.tokens.total)}</td>
                      <td className="fc-num fc-muted">{t.runs}</td>
                      <td className="fc-num fc-muted">{usd(t.runs ? t.cost.total / t.runs : 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="fc-foot">
            Prices per million tokens (Claude API list prices as of {PRICES_AS_OF}):{" "}
            {Object.entries(RATES).map(([m, r]) => `${m} $${r.input} input, $${r.cacheRead} cache read, $${r.input * CACHE_WRITE_MULTIPLIER[ttl]} cache write, $${r.output} output`).join("; ")}.
            {" "}Cache writes use the {ttl === "1h" ? "1-hour (2×)" : "5-minute (1.25×)"} rate because runs don&apos;t record which one applied.
            {view.unknownModels.length ? ` Runs with no or an unknown model (${view.unknownModels.join(", ")}) are priced as ${FALLBACK_MODEL}.` : ""}
            {" "}Days are in {data!.timeZone}. Token counts come from each run&apos;s usage receipt; runs without one aren&apos;t counted.
          </p>
        </>
      ) : null}
    </main>
  );
}

function AgentBar({ name, t, colour, max, share }: { name: string; t: Totals; colour: string; max: number; share: number }) {
  const [hover, setHover] = useState(false);
  return (
    <div className="fc-bar-row" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} tabIndex={0}
      onFocus={() => setHover(true)} onBlur={() => setHover(false)}>
      <span className="fc-bar-name" title={name}>{name}</span>
      <span className="fc-bar-track"><span className="fc-bar-fill" style={{ width: `${max ? (t.cost.total / max) * 100 : 0}%`, background: colour }} /></span>
      <span className="fc-bar-val">{usd(t.cost.total)}<small>{pct(share)}</small></span>
      {hover ? (
        <div className="fc-tip" style={{ right: 0, top: "100%" }}>
          <div className="fc-tip-row" style={{ marginBottom: 4 }}><b>{name}</b><b>{usd(t.cost.total)}</b></div>
          {[...KIND_SERIES].reverse().map((s) => (
            <div key={s.id} className="fc-tip-row">
              <span className="k"><i className="fc-sw" style={{ background: s.color }} />{s.label}</span>
              <span>{usd(t.cost[s.id as "input"])} · {tok(t.tokens[s.id as "input"])}</span>
            </div>
          ))}
          <div className="fc-tip-row fc-muted" style={{ marginTop: 4 }}><span>{t.runs} runs</span><span>{usd(t.runs ? t.cost.total / t.runs : 0)} a run</span></div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- header button and sidebar link

function useTodayCost(companyId: string | null): number | null {
  const { pathname } = useHostLocation();
  const { data } = useUsage(companyId, pathname);
  const [ttl] = useTtl();
  return useMemo(() => {
    if (!data) return null;
    const today = localToday();
    return total(data.rows.filter((r) => r.day === today), ttl).cost.total;
  }, [data, ttl]);
}

export function FleetCostSidebarLink({ context }: PluginSidebarProps) {
  const nav = useHostNavigation();
  const today = useTodayCost(context.companyId);
  return (
    <a {...nav.linkProps("/fleet-cost")}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/80"
      style={{ textDecoration: "none" }}>
      <span className="flex-1 truncate">Fleet Cost</span>
      {today != null ? <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{usd(today)}</span> : null}
    </a>
  );
}

export function FleetCostToolbarButton({ context }: PluginWidgetProps) {
  const nav = useHostNavigation();
  const today = useTodayCost(context.companyId);
  return (
    <a {...nav.linkProps("/fleet-cost")}
      aria-label={today != null ? `Fleet Cost, ${usd(today)} at API prices today` : "Fleet Cost"}
      title="What today's usage would cost at Claude API prices"
      style={{
        padding: "6px 12px", fontSize: 13, borderRadius: 6, border: "1px solid var(--border)", color: "var(--foreground)",
        display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", whiteSpace: "nowrap",
      }}>
      Cost
      {today != null ? <strong style={{ fontVariantNumeric: "tabular-nums" }}>{usd(today)}</strong> : null}
    </a>
  );
}
