import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CacheTtl, Totals } from "../pricing.js";

export const API_BASE = "/api/plugins/nevysha.fleet-cost/api";
const TTL_KEY = "nevysha.fleet-cost.ttl";

// ---------------------------------------------------------------- data

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** GETs a plugin route with the company and the viewer's time zone; refreshes every minute. */
export function useApi<T>(route: string, companyId: string | null, refreshKey: unknown) {
  const [data, setData] = useState<T | null>(null);
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
    fetch(`${API_BASE}/${route}?${params}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
        return json as T;
      })
      .then((json) => { if (live) { setData(json); setError(null); } })
      .catch((err: Error) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [route, companyId, refreshKey, tick]);
  return { data, error };
}

export type ChartKind = "bars" | "lines";
export function useChartKind(key: string, fallback: ChartKind): [ChartKind, (k: ChartKind) => void] {
  const storageKey = `nevysha.fleet-cost.chart.${key}`;
  const [kind, setKind] = useState<ChartKind>(() => {
    try { const v = localStorage.getItem(storageKey); return v === "bars" || v === "lines" ? v : fallback; } catch { return fallback; }
  });
  return [kind, (k) => { setKind(k); try { localStorage.setItem(storageKey, k); } catch { /* per-viewer convenience only */ } }];
}

export function useTtl(): [CacheTtl, (t: CacheTtl) => void] {
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
const trim = (s: string) => s.replace(/\.0+$/, "");
export function tok(v: number): string {
  if (v >= 1e9) return `${trim((v / 1e9).toFixed(v >= 1e10 ? 1 : 2))}B`;
  if (v >= 1e6) return `${trim((v / 1e6).toFixed(v >= 1e8 ? 0 : 1))}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return String(Math.round(v));
}
export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

// ---------------------------------------------------------------- styles

export const CSS = `
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
.fc-tabs .fc-seg button{padding:6px 16px;font-size:13px}
`;

// ---------------------------------------------------------------- small pieces

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="fc-seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

export function Tile({ label, value, note, small }: { label: string; value: string; note?: ReactNode; small?: boolean }) {
  return (
    <div className="fc-tile">
      <span className="fc-tile-label">{label}</span>
      <span className={`fc-tile-value${small ? " sm" : ""}`}>{value}</span>
      {note ? <span className="fc-tile-note">{note}</span> : null}
    </div>
  );
}

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
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

export function niceMax(v: number): { max: number; step: number } {
  if (v <= 0) return { max: 1, step: 0.25 };
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { max: Math.ceil(v / step) * step, step };
}

/** Rect with only the top two corners rounded: the data end, anchored to the baseline. */
export function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

// ---------------------------------------------------------------- stacked bar chart

export type Series = { id: string; label: string; color: string };
export type Bucket = { key: string; label: string; values: Record<string, number>; tokenValues: Record<string, number>; totals: Totals };
export type Metric = "cost" | "tokens";

export function StackedBars({ buckets, series, metric }: { buckets: Bucket[]; series: Series[]; metric: Metric; showTotal?: boolean }) {
  const fmt = metric === "cost" ? usd : tok;
  const valuesOf = (b: Bucket) => (metric === "cost" ? b.values : b.tokenValues);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 260, padL = 52, padB = 24, padT = 8;
  const innerW = Math.max(0, width - padL - 4);
  const innerH = H - padB - padT;
  const sums = buckets.map((b) => series.reduce((s, x) => s + (valuesOf(b)[x.id] ?? 0), 0));
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
        <svg width={width} height={H} role="img" aria-label={metric === "cost" ? "Cost at API prices over time" : "Tokens over time"}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - 4} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
              <text className="fc-axis" x={padL - 8} y={y(t) + 4} textAnchor="end">{fmt(t)}</text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const cx = padL + slot * i + slot / 2;
            let acc = 0;
            const segs = series.map((s) => ({ s, v: valuesOf(b)[s.id] ?? 0 })).filter((x) => x.v > 0);
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
                  aria-label={`${b.label}: ${fmt(sums[i]!)}`} />
              </g>
            );
          })}
        </svg>
      ) : <div style={{ height: H }} />}
      {hb ? (
        <div className="fc-tip" style={{ left: tipLeft, top: 0 }}>
          <div className="fc-tip-row" style={{ marginBottom: 4 }}><b>{hb.label}</b><b>{fmt(sums[hover!]!)}</b></div>
          {[...series].reverse().filter((s) => (valuesOf(hb)[s.id] ?? 0) > 0).map((s) => (
            <div key={s.id} className="fc-tip-row">
              <span className="k"><i className="fc-sw" style={{ background: s.color }} />{s.label}</span>
              <span>{fmt(valuesOf(hb)[s.id]!)}</span>
            </div>
          ))}
          <div className="fc-tip-row fc-muted" style={{ marginTop: 4 }}><span>{metric === "cost" ? `${tok(hb.totals.tokens.total)} tokens` : usd(hb.totals.cost.total)}</span><span>{hb.totals.runs} runs</span></div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- line chart

/** One line per series from a shared zero baseline; points sit at the same x as the bars. */
export function LineChart({ buckets, series, metric, showTotal }: { buckets: Bucket[]; series: Series[]; metric: Metric; showTotal?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const fmt = metric === "cost" ? usd : tok;
  const valuesOf = (b: Bucket) => (metric === "cost" ? b.values : b.tokenValues);
  const totals = buckets.map((b) => series.reduce((sum, x) => sum + (valuesOf(b)[x.id] ?? 0), 0));
  const H = 260, padL = 52, padB = 24, padT = 8;
  const innerW = Math.max(0, width - padL - 4);
  const innerH = H - padB - padT;
  const peak = showTotal ? Math.max(0, ...totals) : Math.max(0, ...buckets.flatMap((b) => series.map((s) => valuesOf(b)[s.id] ?? 0)));
  const { max, step } = niceMax(peak);
  const slot = buckets.length ? innerW / buckets.length : 0;
  const x = (i: number) => padL + slot * i + slot / 2;
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const every = Math.max(1, Math.ceil((buckets.length * 52) / Math.max(1, innerW)));
  const markers = buckets.length <= 31;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);

  const hb = hover != null ? buckets[hover] : null;
  const tipLeft = hover != null ? Math.min(Math.max(0, x(hover) - 100), Math.max(0, width - 210)) : 0;

  return (
    <div className="fc-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {width > 0 ? (
        <svg width={width} height={H} role="img" aria-label={metric === "cost" ? "Cost at API prices over time" : "Tokens over time"}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - 4} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
              <text className="fc-axis" x={padL - 8} y={y(t) + 4} textAnchor="end">{fmt(t)}</text>
            </g>
          ))}
          {buckets.map((b, i) => (i % every === 0
            ? <text key={b.key} className="fc-axis" x={x(i)} y={H - 6} textAnchor="middle">{b.label}</text>
            : null))}
          {hover != null ? <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} stroke="var(--muted-foreground)" strokeWidth={1} strokeDasharray="3 3" /> : null}
          {showTotal ? (
            <g>
              <path d={`M${totals.map((v, i) => `${x(i)},${y(v)}`).join("L")}`} fill="none" stroke="var(--foreground)" strokeOpacity={0.7}
                strokeWidth={2} strokeDasharray="6 4" strokeLinejoin="round" strokeLinecap="round" />
              {totals.map((v, i) => (markers || hover === i
                ? <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 4} fill="var(--foreground)" stroke="var(--card)" strokeWidth={2} />
                : null))}
            </g>
          ) : null}
          {series.map((s) => {
            const pts = buckets.map((b, i) => `${x(i)},${y(valuesOf(b)[s.id] ?? 0)}`);
            return (
              <g key={s.id}>
                <path d={`M${pts.join("L")}`} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {buckets.map((b, i) => (markers || hover === i
                  ? <circle key={b.key} cx={x(i)} cy={y(valuesOf(b)[s.id] ?? 0)} r={hover === i ? 5 : 4} fill={s.color} stroke="var(--card)" strokeWidth={2} />
                  : null))}
              </g>
            );
          })}
          {buckets.map((b, i) => (
            <rect key={b.key} x={padL + slot * i} y={padT} width={slot} height={innerH} fill="transparent"
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}
              aria-label={`${b.label}: ${fmt(totals[i]!)}; ${series.map((s) => `${s.label} ${fmt(valuesOf(b)[s.id] ?? 0)}`).join(", ")}`} />
          ))}
        </svg>
      ) : <div style={{ height: H }} />}
      {hb ? (
        <div className="fc-tip" style={{ left: tipLeft, top: 0 }}>
          <div className="fc-tip-row" style={{ marginBottom: 4 }}><b>{hb.label}</b><b>{fmt(totals[hover!]!)}</b></div>
          {[...series].sort((a, b) => (valuesOf(hb)[b.id] ?? 0) - (valuesOf(hb)[a.id] ?? 0)).map((s) => (
            <div key={s.id} className="fc-tip-row">
              <span className="k"><i className="fc-sw" style={{ background: s.color }} />{s.label}</span>
              <span>{fmt(valuesOf(hb)[s.id] ?? 0)}</span>
            </div>
          ))}
          <div className="fc-tip-row fc-muted" style={{ marginTop: 4 }}><span>{metric === "cost" ? `${tok(hb.totals.tokens.total)} tokens` : usd(hb.totals.cost.total)}</span><span>{hb.totals.runs} runs</span></div>
        </div>
      ) : null}
    </div>
  );
}

export function TimeChart({ kind, ...props }: { kind: ChartKind; buckets: Bucket[]; series: Series[]; metric: Metric; showTotal?: boolean }) {
  return kind === "bars" ? <StackedBars {...props} /> : <LineChart {...props} />;
}

export function Legend({ series, total }: { series: Series[]; total?: boolean }) {
  return (
    <div className="fc-legend">
      {series.map((s) => <span key={s.id}><i className="fc-sw" style={{ background: s.color }} />{s.label}</span>)}
      {total ? <span><i style={{ width: 14, borderTop: "2px dashed var(--foreground)", opacity: 0.7 }} />Total</span> : null}
    </div>
  );
}
