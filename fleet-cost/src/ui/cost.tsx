import { useMemo, useState } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import {
  PRICES_AS_OF, RATES, CACHE_WRITE_MULTIPLIER, FALLBACK_MODEL,
  addDays, costOf, daysBetween, daysInMonth, groupBy, monthKey, monthsBetween, rateFor, tokensOf, total,
  weekKey, weeksBetween, type CacheTtl, type Totals, type UsageRow,
} from "../pricing.js";
import { Legend, Seg, Tile, TimeChart, dayLabel, localToday, monthLabel, pct, tok, usd, useChartKind, useFilter, type Bucket, type Series } from "./common.js";

// The original Fleet Cost view: cost at API prices over time, by agent, day and task.

// ---------------------------------------------------------------- page

export type Grain = "day" | "week" | "month";
type Split = "kind" | "agent";
export const PERIODS = ["7d", "30d", "week", "month", "all"] as const;
export type Period = (typeof PERIODS)[number];

export const KIND_SERIES: Series[] = [
  { id: "cacheRead", label: "Cache reads", color: "var(--fc-s1)" },
  { id: "cacheWrite", label: "Cache writes", color: "var(--fc-s2)" },
  { id: "output", label: "Output", color: "var(--fc-s3)" },
  { id: "input", label: "Input", color: "var(--fc-s4)" },
];
export const AGENT_COLORS = ["--fc-s1", "--fc-s2", "--fc-s3", "--fc-s4", "--fc-s5", "--fc-s6", "--fc-s7"].map((v) => `var(${v})`);

export function inPeriod(period: Period, today: string): (day: string) => boolean {
  switch (period) {
    case "7d": { const from = addDays(today, -6); return (d) => d >= from; }
    case "30d": { const from = addDays(today, -29); return (d) => d >= from; }
    case "week": { const from = weekKey(today); return (d) => d >= from; }
    case "month": { const m = monthKey(today); return (d) => monthKey(d) === m; }
    default: return () => true;
  }
}

export type Usage = { rows: UsageRow[]; timeZone: string; generatedAt: string };

export function CostView({ data, ttl }: { data: Usage; ttl: CacheTtl }) {
  const nav = useHostNavigation();
  const [grain, setGrain] = useFilter<Grain>("cost", "grain", ["day", "week", "month"], "day");
  const [split, setSplit] = useFilter<Split>("cost", "split", ["kind", "agent"], "kind");
  const [period, setPeriod] = useFilter<Period>("cost", "period", PERIODS, "all");
  const [readsMode, setReadsMode] = useFilter("cost", "reads", ["with", "without"], "with");
  const [costKind, setCostKind] = useChartKind("cost", "bars");
  const [tokenKind, setTokenKind] = useChartKind("tokens", "lines");
  const today = localToday();

  const view = useMemo(() => {
    const showReads = readsMode === "with";
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
      const tokenValues: Record<string, number> = {};
      for (const r of rs) {
        const c = costOf(r, ttl);
        const t = tokensOf(r);
        if (split === "kind") {
          for (const s of KIND_SERIES) {
            values[s.id] = (values[s.id] ?? 0) + c[s.id as "input"];
            tokenValues[s.id] = (tokenValues[s.id] ?? 0) + t[s.id as "input"];
          }
        } else {
          const id = colourOf.has(r.agentId ?? "none") ? (r.agentId ?? "none") : "other";
          values[id] = (values[id] ?? 0) + c.total;
          tokenValues[id] = (tokenValues[id] ?? 0) + t.total - (showReads ? 0 : t.cacheRead);
        }
      }
      return { key: k, label: label(k), values, tokenValues, totals: total(rs, ttl) };
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

    const tokenSeries = split === "kind" && !showReads ? series.filter((x) => x.id !== "cacheRead") : series;
    return { tokenSeries, all, todayT, weekT, monthT, last7, days7, projection, monthDays, unknownModels, series, buckets, pTotal, agents, tasks, days, firstDay };
  }, [data, ttl, grain, split, period, today, readsMode]);

  if (!view) return null;
  return (
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

          <div className="fc-controls" role="group" aria-label="Chart options">
            <span className="fc-ctl-label">Charts by</span>
            <Seg label="Group by" value={grain} onChange={setGrain} options={[["day", "Day"], ["week", "Week"], ["month", "Month"]]} />
            <span className="fc-ctl-label">split by</span>
            <Seg label="Split by" value={split} onChange={setSplit} options={[["kind", "Token type"], ["agent", "Agent"]]} />
          </div>

          <section className="fc-card" aria-label="Cost over time">
            <div className="fc-card-head">
              <h2>Cost over time</h2>
              <Seg label="Cost chart type" value={costKind} onChange={setCostKind} options={[["bars", "Bars"], ["lines", "Lines"]]} />
            </div>
            <Legend series={view.series} total={costKind === "lines"} />
            <TimeChart kind={costKind} buckets={view.buckets} series={view.series} metric="cost" showTotal />
          </section>

          <section className="fc-card" aria-label="Tokens over time">
            <div className="fc-card-head">
              <h2>Tokens over time</h2>
              <div className="fc-controls">
                <span className="fc-ctl-label">Cache reads</span>
                <Seg label="Cache reads" value={readsMode} onChange={setReadsMode} options={[["with", "Include"], ["without", "Leave out"]]} />
                <Seg label="Token chart type" value={tokenKind} onChange={setTokenKind} options={[["bars", "Bars"], ["lines", "Lines"]]} />
              </div>
            </div>
            <Legend series={view.tokenSeries} />
            <TimeChart kind={tokenKind} buckets={view.buckets} series={view.tokenSeries} metric="tokens" />
            {readsMode === "with" ? (
              <p className="fc-foot" style={{ margin: 0 }}>
                Cache reads are {pct(view.all.tokens.total ? view.all.tokens.cacheRead / view.all.tokens.total : 0)} of all tokens, so the other types barely show. Leave them out to compare those.
              </p>
            ) : null}
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
            {" "}Days are in {data.timeZone}. Token counts come from each run&apos;s usage receipt; runs without one aren&apos;t counted.
          </p>
        </>
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
