// Pure logic behind the Tools and Efficiency views (tested in tests/plugin.spec.ts).
import { addCost, addTokens, costOf, emptyTotals, tokensOf, type CacheTtl, type Totals, type UsageRow } from "./pricing.js";

/** Usage-like fields shared by every priced row. */
type Priced = { model: string; input: number; cacheWrite: number; cached: number; output: number };

export function asUsage(r: Priced & { runs?: number }): UsageRow {
  return {
    day: "", agentId: null, agentName: null, issueId: null, issueIdentifier: null, issueTitle: null,
    model: r.model, runs: r.runs ?? 0, input: r.input, cacheWrite: r.cacheWrite, cached: r.cached, output: r.output,
  };
}

export function addTotals(a: Totals, r: Priced & { runs?: number }, ttl: CacheTtl): Totals {
  const u = asUsage(r);
  return { cost: addCost(a.cost, costOf(u, ttl)), tokens: addTokens(a.tokens, tokensOf(u)), runs: a.runs + u.runs };
}

// ---- tools -----------------------------------------------------------------------

export type ToolRow = Priced & {
  day: string; agentId: string | null; agentName: string | null; category: string;
  calls: number; stepTokens: number; resultTokens: number; outputBytes: number; durationMs: number;
};
export type RunStat = Priced & {
  runId: string; day: string; agentId: string | null; agentName: string | null; issueId: string | null;
  issueIdentifier: string | null; issueTitle: string | null;
  toolCalls: number; requests: number; firstContext: number; maxContext: number; startTokens: number;
};

export type ToolGroup = {
  category: string; family: string; calls: number; resultTokens: number; outputBytes: number; durationMs: number; t: Totals;
};

/** "Bash: read files" → "Bash"; "Paperclip: create_task" → "Paperclip"; "Read" → "Read". */
export const familyOf = (category: string) => (category.includes(": ") ? category.split(": ")[0]! : category);

export function groupTools(rows: ToolRow[], ttl: CacheTtl, key: (r: ToolRow) => string = (r) => r.category): ToolGroup[] {
  const out = new Map<string, ToolGroup>();
  for (const r of rows) {
    const k = key(r);
    const g = out.get(k) ?? { category: k, family: familyOf(k), calls: 0, resultTokens: 0, outputBytes: 0, durationMs: 0, t: emptyTotals() };
    g.calls += r.calls;
    g.resultTokens += r.resultTokens;
    g.outputBytes += r.outputBytes;
    g.durationMs += r.durationMs;
    g.t = addTotals(g.t, r, ttl);
    out.set(k, g);
  }
  return [...out.values()].sort((a, b) => b.t.cost.total - a.t.cost.total);
}

/** Share of a set of runs' input that is their starting context, re-sent with every request. */
export function startShare(runs: RunStat[]): number {
  let start = 0, input = 0;
  for (const r of runs) {
    start += r.firstContext * r.requests;
    input += r.input + r.cached;
  }
  return input > 0 ? Math.min(1, start / input) : 0;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ---- efficiency ----------------------------------------------------------------

export type IssueUsage = Priced & {
  issueId: string | null; issueIdentifier: string | null; issueTitle: string | null; runs: number; agents: string; lastDay: string;
};
export type CommitRow = {
  sha: string; prNumber: number; prTitle: string; mergedDay: string | null; matchMethod: string;
  codeAdded: number; codeDeleted: number; docAdded: number; docDeleted: number; codeFiles: number; docFiles: number;
  issueId: string | null;
  /** The run that made the commit; null when none was matched. */
  runId: string | null; agentId: string | null; agentName: string | null;
};
/** The usage of one run that made merged commits. */
export type RunUsage = Priced & { runId: string; issueId: string | null };

/**
 * all: every line; code: lines outside .md; docs: .md lines. A task that changed both has
 * its tokens and cost split between "code" and "docs" (see splitTask), so the two add up
 * to "all" in lines, tokens and cost.
 */
export type DocMode = "all" | "code" | "docs";

export type TaskEfficiency = {
  issueId: string; identifier: string | null; title: string | null; agents: string;
  /** The agent whose runs committed the most lines; null when no commit was matched to a run. */
  author: string | null;
  t: Totals; commits: number; prs: number[]; mergedDay: string; matched: number;
  codeLines: number; docLines: number; codeAdded: number; docAdded: number;
  /** The task's usage that goes with its code lines, and with its doc lines. */
  codeT: Totals; docT: Totals;
};

/** Tasks with merged commits, with all their usage. Commits with no task are counted apart. */
export function buildTasks(usage: IssueUsage[], commits: CommitRow[], ttl: CacheTtl, runs: RunUsage[] = []) {
  const byIssue = new Map<string, TaskEfficiency>();
  const authorLines = new Map<string, Map<string, number>>();
  let unlinkedCommits = 0;
  for (const c of commits) {
    if (!c.issueId) { unlinkedCommits++; continue; }
    const t = byIssue.get(c.issueId) ?? {
      issueId: c.issueId, identifier: null, title: null, agents: "", author: null, t: emptyTotals(), commits: 0, prs: [], mergedDay: "",
      matched: 0, codeLines: 0, docLines: 0, codeAdded: 0, docAdded: 0, codeT: emptyTotals(), docT: emptyTotals(),
    };
    t.commits++;
    if (c.matchMethod !== "none") t.matched++;
    if (!t.prs.includes(c.prNumber)) t.prs.push(c.prNumber);
    if (c.mergedDay && c.mergedDay > t.mergedDay) t.mergedDay = c.mergedDay;
    t.codeLines += c.codeAdded + c.codeDeleted;
    t.docLines += c.docAdded + c.docDeleted;
    t.codeAdded += c.codeAdded;
    t.docAdded += c.docAdded;
    byIssue.set(c.issueId, t);
    if (c.agentName) {
      const m = authorLines.get(c.issueId) ?? new Map<string, number>();
      m.set(c.agentName, (m.get(c.agentName) ?? 0) + c.codeAdded + c.codeDeleted + c.docAdded + c.docDeleted + 1);
      authorLines.set(c.issueId, m);
    }
  }
  for (const [issueId, m] of authorLines) byIssue.get(issueId)!.author = [...m].sort((a, b) => b[1] - a[1])[0]![0];
  let otherTasks = emptyTotals();
  let otherCount = 0;
  for (const u of usage) {
    const t = u.issueId ? byIssue.get(u.issueId) : undefined;
    if (!t) { otherTasks = addTotals(otherTasks, u, ttl); otherCount++; continue; }
    t.identifier = u.issueIdentifier;
    t.title = u.issueTitle;
    t.agents = [...new Set([...t.agents.split(", "), ...u.agents.split(", ")].filter(Boolean))].join(", ");
    t.t = addTotals(t.t, u, ttl);
  }
  for (const t of byIssue.values()) splitTask(t, commits, runs, ttl);
  return { tasks: [...byIssue.values()], otherTasks, otherCount, unlinkedCommits };
}

export function linesOf(t: TaskEfficiency, mode: DocMode): number {
  return mode === "code" ? t.codeLines : mode === "docs" ? t.docLines : t.codeLines + t.docLines;
}

export function inMode(t: TaskEfficiency, mode: DocMode): boolean {
  return linesOf(t, mode) > 0;
}

function scale<T extends Record<string, number>>(x: T, f: number): T {
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v * f])) as T;
}
function combine<T extends Record<string, number>>(a: T, b: T, fb: number): T {
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v + fb * (b[k] ?? 0)])) as T;
}
/** a + f·b, field by field; runs stay a's. */
function plus(a: Totals, b: Totals, f = 1): Totals {
  return { cost: combine(a.cost, b.cost, f), tokens: combine(a.tokens, b.tokens, f), runs: a.runs };
}

/**
 * Splits a task's usage between its code and doc lines, run by run. A run that made merged
 * commits gives its own tokens to the code and doc lines of those commits. The rest of the
 * task's usage (runs that committed nothing: reviews, plans, retries; and runs whose commits
 * changed no counted line) is split by the task's line counts. With no run matched, that's
 * the whole task, as before.
 */
export function splitTask(t: TaskEfficiency, commits: CommitRow[], runs: RunUsage[], ttl: CacheTtl): void {
  const lines = new Map<string, { code: number; docs: number }>();
  for (const c of commits) {
    if (c.issueId !== t.issueId || !c.runId) continue;
    const l = lines.get(c.runId) ?? { code: 0, docs: 0 };
    l.code += c.codeAdded + c.codeDeleted;
    l.docs += c.docAdded + c.docDeleted;
    lines.set(c.runId, l);
  }
  let code = emptyTotals(), docs = emptyTotals(), direct = emptyTotals();
  for (const r of runs) {
    const l = lines.get(r.runId);
    if (r.issueId !== t.issueId || !l || l.code + l.docs === 0) continue;
    const own = addTotals(emptyTotals(), r, ttl);
    const f = l.code / (l.code + l.docs);
    code = plus(code, own, f);
    docs = plus(docs, own, 1 - f);
    direct = plus(direct, own);
  }
  const rest = plus(t.t, direct, -1);
  const all = t.codeLines + t.docLines;
  const f = all > 0 ? t.codeLines / all : 0;
  // Runs aren't split: a run that changed both counts in both.
  t.codeT = { ...plus(code, rest, f), runs: t.t.runs };
  t.docT = { ...plus(docs, rest, 1 - f), runs: t.t.runs };
}

/** A task's tokens and cost for the lines counted. */
export function totalsIn(t: TaskEfficiency, mode: DocMode): Totals {
  return mode === "code" ? t.codeT : mode === "docs" ? t.docT : t.t;
}

export type Efficiency = { tasks: number; lines: number; t: Totals; tokensPerLine: number; costPerLine: number };

export function efficiencyOf(tasks: TaskEfficiency[], mode: DocMode): Efficiency {
  let lines = 0;
  let t = emptyTotals();
  let n = 0;
  for (const x of tasks) {
    if (!inMode(x, mode)) continue;
    n++;
    lines += linesOf(x, mode);
    const part = totalsIn(x, mode);
    t = { cost: addCost(t.cost, part.cost), tokens: addTokens(t.tokens, part.tokens), runs: t.runs + part.runs };
  }
  return { tasks: n, lines, t, tokensPerLine: lines ? t.tokens.total / lines : 0, costPerLine: lines ? t.cost.total / lines : 0 };
}
