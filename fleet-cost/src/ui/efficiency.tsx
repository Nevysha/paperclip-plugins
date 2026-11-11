import { useMemo, useState } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { daysBetween, weekKey, weeksBetween, type CacheTtl } from "../pricing.js";
import { buildTasks, efficiencyOf, inMode, linesOf, type CommitRow, type DocMode, type IssueUsage, type TaskEfficiency } from "../lens.js";
import { Legend, Seg, Tile, TimeChart, dayLabel, localToday, pct, tok, usd, useChartKind, type Bucket, type Series } from "./common.js";
import { inPeriod, type Period } from "./cost.js";

export type EfficiencyData = { usage: IssueUsage[]; commits: CommitRow[]; timeZone: string; generatedAt: string };

const MODE_LABEL: Record<DocMode, string> = { all: "All lines", code: "Without docs", docs: "Docs only" };
const LINES_NOTE: Record<DocMode, string> = {
  all: "code and .md lines",
  code: "lines outside .md files",
  docs: ".md lines, tasks that changed only docs",
};
type Sort = "perLine" | "cost" | "newest";

const perLine = (t: TaskEfficiency, mode: DocMode) => { const l = linesOf(t, mode); return l ? t.t.tokens.total / l : 0; };
const short = (s: string | null, n = 60) => (s && s.length > n ? s.slice(0, n) + "…" : s ?? "");

export function EfficiencyView({ data, ttl }: { data: EfficiencyData; ttl: CacheTtl }) {
  const nav = useHostNavigation();
  const [mode, setMode] = useState<DocMode>("code");
  const [period, setPeriod] = useState<Period>("all");
  const [grain, setGrain] = useState<"day" | "week">("week");
  const [sort, setSort] = useState<Sort>("cost");
  const [chartKind, setChartKind] = useChartKind("efficiency", "bars");
  const today = localToday();

  const built = useMemo(() => buildTasks(data.usage, data.commits, ttl), [data, ttl]);

  const view = useMemo(() => {
    const keep = inPeriod(period, today);
    const tasks = built.tasks.filter((t) => t.mergedDay && keep(t.mergedDay));
    const shown = tasks.filter((t) => inMode(t, mode));
    const eff = efficiencyOf(tasks, mode);
    const allModes = { all: efficiencyOf(tasks, "all"), code: efficiencyOf(tasks, "code"), docs: efficiencyOf(tasks, "docs") };
    // Tasks that merged nothing (reviews, planning, questions, work not merged yet), by the day of their last run.
    const otherUsage = data.usage.filter((u) => keep(u.lastDay) && !built.tasks.some((t) => t.issueId === u.issueId));
    const otherTokens = otherUsage.reduce((s, u) => s + u.input + u.cached + u.output, 0);
    const taskTokens = tasks.reduce((s, t) => s + t.t.tokens.total, 0);

    // Over time: tokens per line of the tasks merged in each bucket, one series per filter.
    const first = built.tasks.reduce((m, t) => (t.mergedDay && t.mergedDay < m ? t.mergedDay : m), today);
    const keyOf = grain === "day" ? (d: string) => d : weekKey;
    let keys = grain === "day" ? daysBetween(first, today) : weeksBetween(first, today);
    if (grain === "day" && keys.length > 60) keys = keys.slice(-60);
    const byKey = new Map<string, TaskEfficiency[]>();
    for (const t of built.tasks) { if (!t.mergedDay) continue; const k = keyOf(t.mergedDay); (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(t); }
    const series: Series[] = [{ id: mode, label: `Tokens per line, ${MODE_LABEL[mode].toLowerCase()}`, color: "var(--fc-s1)" }];
    const buckets: Bucket[] = keys.map((k) => {
      const e = efficiencyOf(byKey.get(k) ?? [], mode);
      const values = { [mode]: e.tokensPerLine };
      return { key: k, label: grain === "day" ? dayLabel(k) : `wk ${dayLabel(k)}`, values, tokenValues: values, totals: e.t };
    });

    // By agent (the agent whose runs committed most of the task's lines)
    const agents = new Map<string, TaskEfficiency[]>();
    for (const t of shown) { const k = t.author ?? "Not matched to a run"; (agents.get(k) ?? agents.set(k, []).get(k)!).push(t); }
    const agentRows = [...agents].map(([name, ts]) => ({ name, ...efficiencyOf(ts, mode) })).sort((a, b) => b.t.cost.total - a.t.cost.total);

    const sorted = [...shown].sort((a, b) =>
      sort === "perLine" ? perLine(b, mode) - perLine(a, mode) : sort === "cost" ? b.t.cost.total - a.t.cost.total : (a.mergedDay < b.mergedDay ? 1 : -1));
    const commits = data.commits.filter((c) => c.mergedDay && keep(c.mergedDay));
    const matched = commits.filter((c) => c.matchMethod !== "none").length;
    return { eff, allModes, shown, sorted, buckets, series, agentRows, otherTokens, taskTokens, otherCount: otherUsage.length, commits: commits.length, matched, first };
  }, [built, data, mode, period, grain, sort, today]);

  return (
    <>
      <div className="fc-controls" role="group" aria-label="Filters">
        <span className="fc-ctl-label">Count</span>
        <Seg label="Lines counted" value={mode} onChange={setMode} options={[["all", MODE_LABEL.all], ["code", MODE_LABEL.code], ["docs", MODE_LABEL.docs]]} />
        <span className="fc-ctl-label">merged in</span>
        <Seg label="Period" value={period} onChange={setPeriod}
          options={[["7d", "7 days"], ["30d", "30 days"], ["week", "This week"], ["month", "This month"], ["all", "All time"]]} />
      </div>

      <section className="fc-tiles" aria-label="Efficiency">
        <Tile label="Tokens per line" value={tok(view.eff.tokensPerLine)} note={`${MODE_LABEL[mode]}: ${LINES_NOTE[mode]}`} />
        <Tile label="Cost per 100 lines" value={usd(view.eff.costPerLine * 100)} note={`at API prices, ${usd(view.eff.costPerLine * 1000)} per 1,000 lines`} />
        <Tile label="Lines changed" value={view.eff.lines.toLocaleString("en-US")} note={`added + deleted, ${view.eff.tasks} tasks`} />
        <Tile label="Tasks that merged nothing" value={pct(view.otherTokens + view.taskTokens ? view.otherTokens / (view.otherTokens + view.taskTokens) : 0)} small
          note={`of tokens: ${view.otherCount} tasks (reviews, plans, questions, unmerged work)`} />
      </section>

      <section className="fc-card" aria-label="Compare the filters">
        <h2>The three counts side by side</h2>
        <div className="fc-scroll">
          <table className="fc-table">
            <thead><tr><th>Lines counted</th><th className="fc-num">Tasks</th><th className="fc-num">Lines</th><th className="fc-num">Tokens</th><th className="fc-num">Cost</th><th className="fc-num">Tokens per line</th><th className="fc-num">Cost per 100 lines</th></tr></thead>
            <tbody>
              {(["all", "code", "docs"] as DocMode[]).map((m) => {
                const e = view.allModes[m];
                return (
                  <tr key={m} style={m === mode ? { fontWeight: 600 } : undefined}>
                    <td>{MODE_LABEL[m]} <span className="fc-muted" style={{ fontWeight: 400 }}>{LINES_NOTE[m]}</span></td>
                    <td className="fc-num">{e.tasks}</td><td className="fc-num">{e.lines.toLocaleString("en-US")}</td>
                    <td className="fc-num">{tok(e.t.tokens.total)}</td><td className="fc-num">{usd(e.t.cost.total)}</td>
                    <td className="fc-num">{tok(e.tokensPerLine)}</td><td className="fc-num">{usd(e.costPerLine * 100)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="fc-foot" style={{ margin: 0 }}>
          A task that changed code and docs counts in &quot;All&quot; with every line and in &quot;Without docs&quot; with its code lines only, keeping all its tokens both times.
        </p>
      </section>

      <section className="fc-card" aria-label="Tokens per line over time">
        <div className="fc-card-head">
          <h2>Tokens per line over time</h2>
          <div className="fc-controls">
            <Seg label="Group by" value={grain} onChange={setGrain} options={[["day", "Day"], ["week", "Week"]]} />
            <Seg label="Chart type" value={chartKind} onChange={setChartKind} options={[["bars", "Bars"], ["lines", "Lines"]]} />
          </div>
        </div>
        <Legend series={view.series} />
        <TimeChart kind={chartKind} buckets={view.buckets} series={view.series} metric="tokens" />
        <p className="fc-foot" style={{ margin: 0 }}>Tasks are placed on the day their last PR merged.</p>
      </section>

      <section className="fc-card" aria-label="By agent">
        <h2>By agent</h2>
        <div className="fc-scroll">
          <table className="fc-table">
            <thead><tr><th>Agent</th><th className="fc-num">Tasks</th><th className="fc-num">Lines</th><th className="fc-num">Tokens</th><th className="fc-num">Tokens per line</th><th className="fc-num">Cost per 100 lines</th></tr></thead>
            <tbody>
              {view.agentRows.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td><td className="fc-num">{a.tasks}</td><td className="fc-num">{a.lines.toLocaleString("en-US")}</td>
                  <td className="fc-num fc-muted">{tok(a.t.tokens.total)}</td><td className="fc-num">{tok(a.tokensPerLine)}</td><td className="fc-num">{usd(a.costPerLine * 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fc-foot" style={{ margin: 0 }}>
          Different work has different line counts: a spec answer or a tricky fix is few lines for many tokens. Compare an agent with itself over time rather than with the others.
        </p>
      </section>

      <section className="fc-card" aria-label="Tasks">
        <div className="fc-card-head">
          <h2>Tasks</h2>
          <Seg label="Sort" value={sort} onChange={setSort} options={[["cost", "Most cost"], ["perLine", "Most tokens per line"], ["newest", "Newest"]]} />
        </div>
        <div className="fc-scroll" style={{ maxHeight: 560 }}>
          <table className="fc-table wide">
            <thead><tr><th>Task</th><th>Agent</th><th>PRs</th><th className="fc-num">Lines</th><th className="fc-num">Tokens</th><th className="fc-num">Cost</th><th className="fc-num">Tokens per line</th></tr></thead>
            <tbody>
              {view.sorted.slice(0, 100).map((t) => (
                <tr key={t.issueId}>
                  <td>
                    {t.identifier ? <a className="fc-link" {...nav.linkProps(`/issues/${t.identifier}`)}>{t.identifier}</a> : <span className="fc-muted">Unknown task</span>}
                    <span className="fc-muted"> {short(t.title)}</span>
                  </td>
                  <td className="fc-muted">{t.author ?? t.agents}</td>
                  <td className="fc-muted">{t.prs.map((n) => `#${n}`).join(" ")}</td>
                  <td className="fc-num" title={`${t.codeLines} code, ${t.docLines} doc lines; ${t.commits} commits`}>{linesOf(t, mode).toLocaleString("en-US")}</td>
                  <td className="fc-num fc-muted">{tok(t.t.tokens.total)}</td>
                  <td className="fc-num">{usd(t.t.cost.total)}</td>
                  <td className="fc-num">{tok(perLine(t, mode))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="fc-foot">
        Lines are the additions and deletions of each merged PR&apos;s own commits (before the squash), read from the repository by the Token Lens collector.
        Lockfiles and binary files aren&apos;t counted; .md and .mdx files count as docs. A commit belongs to the task of the run that made it:
        {" "}{view.matched} of {view.commits} commits in this period were matched to their run through the run&apos;s git commands, the rest to the task named
        in their PR&apos;s title{built.unlinkedCommits ? ` (${built.unlinkedCommits} commits matched no task and aren't counted)` : ""}.
        A task&apos;s tokens are every run on it, including reviews and retries on that task. Data starts {dayLabel(view.first)}; days are in {data.timeZone}.
      </p>
    </>
  );
}
