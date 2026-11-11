import { describe, expect, it } from "vitest";
import { buildTasks, efficiencyOf, groupTools, median, startShare, type CommitRow, type IssueUsage, type RunStat, type ToolRow } from "../src/lens.js";
import { parseIngest } from "../src/ingest.js";

const tool = (over: Partial<ToolRow>): ToolRow => ({
  day: "2026-11-11", agentId: "a", agentName: "A", category: "Read", model: "claude-opus-5-5",
  calls: 1, stepTokens: 0, resultTokens: 0, outputBytes: 0, durationMs: 0, input: 0, cacheWrite: 0, cached: 0, output: 0, ...over,
});
const usage = (over: Partial<IssueUsage>): IssueUsage => ({
  issueId: "i1", issueIdentifier: "NEV-1", issueTitle: "T", model: "claude-opus-5-5", runs: 1, agents: "A", lastDay: "2026-11-11",
  input: 0, cacheWrite: 0, cached: 0, output: 0, ...over,
});
const commit = (over: Partial<CommitRow>): CommitRow => ({
  sha: "x", prNumber: 1, prTitle: "P (NEV-1)", mergedDay: "2026-11-11", matchMethod: "hash",
  codeAdded: 0, codeDeleted: 0, docAdded: 0, docDeleted: 0, codeFiles: 0, docFiles: 0, issueId: "i1", agentId: "a", agentName: "A", ...over,
});

describe("tools", () => {
  it("groups by category or family and prices the allocated tokens", () => {
    const rows = [
      tool({ category: "Bash: read files", calls: 3, cached: 1_000_000 }),
      tool({ category: "Bash: tests", calls: 1, cached: 1_000_000 }),
      tool({ category: "Read", calls: 2, cached: 500_000 }),
    ];
    const byCat = groupTools(rows, "1h");
    expect(byCat.map((g) => g.category)).toEqual(["Bash: read files", "Bash: tests", "Read"]);
    expect(byCat[0]!.t.cost.total).toBeCloseTo(0.2);
    const byFamily = groupTools(rows, "1h", (r) => r.category.split(": ")[0]!);
    expect(byFamily[0]).toMatchObject({ category: "Bash", calls: 4 });
  });
  it("measures the starting context's share of input", () => {
    const run = { firstContext: 30_000, requests: 10, input: 0, cached: 1_000_000 } as RunStat;
    expect(startShare([run])).toBeCloseTo(0.3);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("efficiency", () => {
  const data = () => buildTasks(
    [usage({ cached: 10_000_000 }), usage({ issueId: "i2", issueIdentifier: "NEV-2", cached: 4_000_000 }), usage({ issueId: "i3", cached: 1_000_000 })],
    [
      commit({ codeAdded: 80, codeDeleted: 20, docAdded: 100 }),
      commit({ sha: "y", issueId: "i2", docAdded: 40 }),
      commit({ sha: "z", issueId: null }),
    ],
    "1h",
  );
  it("joins each task's usage to the lines its commits changed", () => {
    const { tasks, otherCount, unlinkedCommits } = data();
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.issueId === "i1")).toMatchObject({ codeLines: 100, docLines: 100, author: "A" });
    expect(otherCount).toBe(1); // i3 merged nothing
    expect(unlinkedCommits).toBe(1);
  });
  it("counts lines three ways", () => {
    const { tasks } = data();
    expect(efficiencyOf(tasks, "all")).toMatchObject({ tasks: 2, lines: 240 });
    const code = efficiencyOf(tasks, "code");
    expect(code).toMatchObject({ tasks: 1, lines: 100 });
    expect(code.tokensPerLine).toBe(100_000); // all of i1's 10M tokens over its 100 code lines
    expect(efficiencyOf(tasks, "docs")).toMatchObject({ tasks: 1, lines: 40, tokensPerLine: 100_000 });
  });
});

describe("ingest", () => {
  const run = { runId: "686ae970-d1bf-4d51-9481-239ed01b294f", toolCalls: 2, requests: 3, firstContext: 30000, maxContext: 40000, startTokens: 30000,
    tools: [{ category: "Read", calls: 2, stepTokens: 70000, resultTokens: 5000, outputBytes: 2000, durationMs: 10 }] };
  it("accepts the collector's shape and drops unknown fields", () => {
    const parsed = parseIngest({ runs: [{ ...run, extra: 1 }] });
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) expect(parsed.runs[0]).not.toHaveProperty("extra");
  });
  it("rejects malformed rows", () => {
    expect(parseIngest({ runs: [{ ...run, runId: "nope" }] })).toEqual({ error: "runs[0] is malformed" });
    expect(parseIngest({ commits: [{ sha: "abc" }] })).toEqual({ error: "commits[0] is malformed" });
    expect(parseIngest([])).toHaveProperty("error");
  });
});
