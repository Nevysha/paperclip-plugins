import { useMemo } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { daysBetween, emptyTotals, weekKey, weeksBetween, type CacheTtl, type Totals } from "../pricing.js";
import { addTotals, familyOf, groupTools, median, startShare, type RunStat, type ToolGroup, type ToolRow } from "../lens.js";
import { Legend, Seg, Tile, TimeChart, dayLabel, localToday, pct, tok, usd, useChartKind, useFilter, type Bucket, type Series } from "./common.js";
import { PERIODS, inPeriod, type Period } from "./cost.js";

export type ToolsData = { tools: ToolRow[]; runs: RunStat[]; timeZone: string; generatedAt: string };

const MANY_CALLS = 100;
const FIXED = new Set(["Run start", "Model output"]);

const ms = (v: number) => (v >= 3_600_000 ? `${(v / 3_600_000).toFixed(1)} h` : v >= 60_000 ? `${Math.round(v / 60_000)} min` : `${Math.round(v / 1000)} s`);
const short = (s: string | null, n = 60) => (s && s.length > n ? s.slice(0, n) + "…" : s ?? "");

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

export function ToolsView({ data, ttl }: { data: ToolsData; ttl: CacheTtl }) {
  const nav = useHostNavigation();
  const [period, setPeriod] = useFilter<Period>("tools", "period", PERIODS, "7d");
  const [by, setBy] = useFilter("tools", "by", ["category", "family"], "category");
  const [grain, setGrain] = useFilter("tools", "grain", ["day", "week"], "day");
  const [callsKind, setCallsKind] = useChartKind("calls", "lines");
  const today = localToday();

  const view = useMemo(() => {
    const keep = inPeriod(period, today);
    const tools = data.tools.filter((r) => keep(r.day));
    const runs = data.runs.filter((r) => keep(r.day));
    const groups = groupTools(tools, ttl, by === "family" ? (r) => familyOf(r.category) : undefined);
    const all = groups.reduce<Totals>((t, g) => ({ cost: { ...t.cost, total: t.cost.total + g.t.cost.total }, tokens: { ...t.tokens, total: t.tokens.total + g.t.tokens.total }, runs: 0 }), emptyTotals());
    const toolCalls = runs.reduce((s, r) => s + r.toolCalls, 0);
    const many = runs.filter((r) => r.toolCalls > MANY_CALLS).sort((a, b) => b.toolCalls - a.toolCalls);
    const runCost = new Map(runs.map((r) => [r.runId, addTotals(emptyTotals(), r, ttl)]));
    const manyCost = many.reduce((s, r) => s + runCost.get(r.runId)!.cost.total, 0);
    const runsCost = runs.reduce((s, r) => s + runCost.get(r.runId)!.cost.total, 0);

    // Calls per run over time: median and 90th percentile.
    const first = data.runs[0]?.day ?? today;
    const keyOf = grain === "day" ? (d: string) => d : weekKey;
    let keys = grain === "day" ? daysBetween(first, today) : weeksBetween(first, today);
    if (grain === "day" && keys.length > 60) keys = keys.slice(-60);
    const byKey = new Map<string, RunStat[]>();
    for (const r of data.runs) { const k = keyOf(r.day); (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r); }
    const series: Series[] = [
      { id: "median", label: "Median run", color: "var(--fc-s1)" },
      { id: "p90", label: "90th percentile", color: "var(--fc-s2)" },
      { id: "many", label: `Runs over ${MANY_CALLS} calls`, color: "var(--fc-s4)" },
    ];
    const buckets: Bucket[] = keys.map((k) => {
      const rs = byKey.get(k) ?? [];
      const calls = rs.map((r) => r.toolCalls);
      const values = { median: median(calls), p90: percentile(calls, 0.9), many: rs.filter((r) => r.toolCalls > MANY_CALLS).length };
      return { key: k, label: grain === "day" ? dayLabel(k) : `wk ${dayLabel(k)}`, values, tokenValues: values,
        totals: rs.reduce((t, r) => addTotals(t, { ...r, runs: 1 }, ttl), emptyTotals()) };
    });

    // Per agent
    const agents = new Map<string, RunStat[]>();
    for (const r of runs) { const k = r.agentName ?? "Unknown agent"; (agents.get(k) ?? agents.set(k, []).get(k)!).push(r); }
    const agentRows = [...agents].map(([name, rs]) => ({
      name, runs: rs.length,
      medianCalls: median(rs.map((r) => r.toolCalls)),
      many: rs.filter((r) => r.toolCalls > MANY_CALLS).length,
      medianStart: median(rs.map((r) => r.firstContext)),
      maxContext: Math.max(0, ...rs.map((r) => r.maxContext)),
      cost: rs.reduce((s, r) => s + runCost.get(r.runId)!.cost.total, 0),
    })).sort((a, b) => b.cost - a.cost);

    return {
      groups, all, runs, toolCalls, many, manyCost, runsCost, runCost, buckets, series, agentRows,
      medianCalls: median(runs.map((r) => r.toolCalls)),
      medianStart: median(runs.map((r) => r.firstContext)),
      startShare: startShare(runs),
      first,
    };
  }, [data, ttl, period, by, grain, today]);

  const top = view.groups[0]?.t.cost.total ?? 0;
  return (
    <>
      <div className="fc-controls" role="group" aria-label="Period">
        <span className="fc-ctl-label">Period</span>
        <Seg label="Period" value={period} onChange={setPeriod}
          options={[["7d", "7 days"], ["30d", "30 days"], ["week", "This week"], ["month", "This month"], ["all", "All time"]]} />
        <span className="fc-ctl-label">{view.runs.length} runs · {usd(view.runsCost)}</span>
      </div>

      <section className="fc-tiles" aria-label="Tool use">
        <Tile label="Tool calls" value={view.toolCalls.toLocaleString("en-US")} note={`median run ${Math.round(view.medianCalls)} calls`} />
        <Tile label={`Runs over ${MANY_CALLS} calls`} value={String(view.many.length)}
          note={`${pct(view.runs.length ? view.many.length / view.runs.length : 0)} of runs, ${pct(view.runsCost ? view.manyCost / view.runsCost : 0)} of their cost`} />
        <Tile label="Starting context" value={tok(view.medianStart)}
          note={`tokens before the first step (median); re-sent every step, ${pct(view.startShare)} of input`} />
        <Tile label="Most expensive" value={view.groups.find((g) => !FIXED.has(g.category))?.category ?? "–"} small
          note={(() => { const g = view.groups.find((x) => !FIXED.has(x.category)); return g ? `${usd(g.t.cost.total)}, ${pct(view.all.cost.total ? g.t.cost.total / view.all.cost.total : 0)} of cost` : ""; })()} />
      </section>

      <section className="fc-card" aria-label="Where the tokens go">
        <div className="fc-card-head">
          <h2>Where the tokens go</h2>
          <Seg label="Group tools" value={by} onChange={setBy} options={[["category", "Bash split by command"], ["family", "By tool"]]} />
        </div>
        <div className="fc-scroll">
          <table className="fc-table wide">
            <thead>
              <tr>
                <th>What</th><th className="fc-num">Calls</th><th className="fc-num">Cost</th><th style={{ width: "22%" }} aria-label="Share of cost" />
                <th className="fc-num">Tokens</th><th className="fc-num">Per call</th><th className="fc-num">Context added</th><th className="fc-num">Time</th>
              </tr>
            </thead>
            <tbody>
              {view.groups.map((g) => <ToolLine key={g.category} g={g} top={top} all={view.all.cost.total} />)}
            </tbody>
          </table>
        </div>
        <p className="fc-foot" style={{ margin: 0 }}>
          A call&apos;s <b>tokens</b> are the context the model re-reads on the step after it: that&apos;s what the call costs, even when it prints one line.
          <b> Context added</b> is what its result adds, which every later step reads again. <b>Run start</b> is each run&apos;s first request
          (instructions, tools, task); <b>Model output</b> is what the model wrote. Together they add up to the runs&apos; whole usage.
        </p>
      </section>

      <section className="fc-card" aria-label="Calls per run over time">
        <div className="fc-card-head">
          <h2>Calls per run</h2>
          <div className="fc-controls">
            <Seg label="Group by" value={grain} onChange={setGrain} options={[["day", "Day"], ["week", "Week"]]} />
            <Seg label="Chart type" value={callsKind} onChange={setCallsKind} options={[["bars", "Bars"], ["lines", "Lines"]]} />
          </div>
        </div>
        <Legend series={view.series} />
        <TimeChart kind={callsKind} buckets={view.buckets} series={view.series} metric="tokens" />
      </section>

      <div className="fc-grid2">
        <section className="fc-card" aria-label="By agent">
          <h2>By agent</h2>
          <div className="fc-scroll">
            <table className="fc-table">
              <thead><tr><th>Agent</th><th className="fc-num">Runs</th><th className="fc-num">Median calls</th><th className="fc-num">Over {MANY_CALLS}</th><th className="fc-num">Start</th><th className="fc-num">Peak context</th></tr></thead>
              <tbody>
                {view.agentRows.map((a) => (
                  <tr key={a.name}>
                    <td>{a.name}</td><td className="fc-num">{a.runs}</td><td className="fc-num">{Math.round(a.medianCalls)}</td>
                    <td className="fc-num">{a.many}</td><td className="fc-num fc-muted">{tok(a.medianStart)}</td><td className="fc-num fc-muted">{tok(a.maxContext)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="fc-card" aria-label={`Runs over ${MANY_CALLS} calls`}>
          <h2>Runs over {MANY_CALLS} calls</h2>
          {view.many.length === 0 ? <p className="fc-muted">None in this period.</p> : (
            <div className="fc-scroll" style={{ maxHeight: 420 }}>
              <table className="fc-table">
                <thead><tr><th>Task</th><th>Agent</th><th className="fc-num">Calls</th><th className="fc-num">Peak</th><th className="fc-num">Cost</th></tr></thead>
                <tbody>
                  {view.many.slice(0, 50).map((r) => (
                    <tr key={r.runId}>
                      <td>
                        {r.issueIdentifier ? <a className="fc-link" {...nav.linkProps(`/issues/${r.issueIdentifier}`)}>{r.issueIdentifier}</a> : <span className="fc-muted">No task</span>}
                        <span className="fc-muted"> {dayLabel(r.day)} {short(r.issueTitle, 40)}</span>
                      </td>
                      <td className="fc-muted">{r.agentName}</td>
                      <td className="fc-num">{r.toolCalls}</td>
                      <td className="fc-num fc-muted">{tok(r.maxContext)}</td>
                      <td className="fc-num">{usd(view.runCost.get(r.runId)!.cost.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <p className="fc-foot">
        Tool calls come from each run&apos;s event log, read by the Token Lens collector every 15 minutes, so the latest runs can be missing.
        Runs before {dayLabel(view.first)} recorded no tool calls. Each run&apos;s measured step costs are scaled to its usage receipt
        (they match it within a few percent), and priced like the Cost tab. Days are in {data.timeZone}.
      </p>
    </>
  );
}

function ToolLine({ g, top, all }: { g: ToolGroup; top: number; all: number }) {
  const fixed = FIXED.has(g.category);
  return (
    <tr>
      <td className={fixed ? "fc-muted" : undefined}>{g.category}</td>
      <td className="fc-num">{fixed ? "" : g.calls.toLocaleString("en-US")}</td>
      <td className="fc-num">{usd(g.t.cost.total)}<small className="fc-muted" style={{ marginLeft: 6 }}>{pct(all ? g.t.cost.total / all : 0)}</small></td>
      <td><span className="fc-bar-track"><span className="fc-bar-fill" style={{ width: `${top ? (g.t.cost.total / top) * 100 : 0}%`, background: fixed ? "var(--fc-other)" : "var(--fc-s1)" }} /></span></td>
      <td className="fc-num fc-muted">{tok(g.t.tokens.total)}</td>
      <td className="fc-num fc-muted">{!fixed && g.calls ? tok(g.t.tokens.total / g.calls) : ""}</td>
      <td className="fc-num fc-muted">{g.category === "Model output" ? "" : tok(g.resultTokens)}</td>
      <td className="fc-num fc-muted">{fixed ? "" : ms(g.durationMs)}</td>
    </tr>
  );
}
