// Shape check for what collector/collect.mjs posts to /ingest. The route is board-only;
// this guards against a malformed post writing junk, not against an attacker.

export type IngestTool = {
  category: string; calls: number; stepTokens: number; resultTokens: number; outputBytes: number; durationMs: number;
};
export type IngestRun = {
  runId: string; toolCalls: number; requests: number; firstContext: number; maxContext: number; startTokens: number;
  tools: IngestTool[];
};
export type IngestCommit = {
  sha: string; repo: string; prNumber: number; prTitle: string; prMergedAt: string | null; authoredAt: string | null;
  subject: string; runId: string | null; matchMethod: "hash" | "subject" | "none";
  codeAdded: number; codeDeleted: number; docAdded: number; docDeleted: number; codeFiles: number; docFiles: number;
};
export type IngestBody = { runs: IngestRun[]; commits: IngestCommit[] };

export const MAX_RUNS = 500;
export const MAX_COMMITS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e15;
const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const date = (v: unknown) => v === null || (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)));

function checkTool(t: unknown): t is IngestTool {
  return isObj(t) && text(t.category, 200) && (t.category as string).length > 0
    && ["calls", "stepTokens", "resultTokens", "outputBytes", "durationMs"].every((k) => count(t[k]));
}

function checkRun(r: unknown): r is IngestRun {
  return isObj(r) && typeof r.runId === "string" && UUID.test(r.runId)
    && ["toolCalls", "requests", "firstContext", "maxContext", "startTokens"].every((k) => count(r[k]))
    && Array.isArray(r.tools) && r.tools.length <= 200 && r.tools.every(checkTool);
}

function checkCommit(c: unknown): c is IngestCommit {
  return isObj(c) && typeof c.sha === "string" && SHA.test(c.sha) && text(c.repo, 200) && count(c.prNumber)
    && text(c.prTitle, 1000) && date(c.prMergedAt) && date(c.authoredAt) && text(c.subject, 1000)
    && (c.runId === null || (typeof c.runId === "string" && UUID.test(c.runId)))
    && (c.matchMethod === "hash" || c.matchMethod === "subject" || c.matchMethod === "none")
    && ["codeAdded", "codeDeleted", "docAdded", "docDeleted", "codeFiles", "docFiles"].every((k) => count(c[k]));
}

/** Returns the body with only the known fields, or an error naming what's wrong. */
export function parseIngest(body: unknown): IngestBody | { error: string } {
  if (!isObj(body)) return { error: "Expected a JSON object with runs and/or commits" };
  const runs = body.runs ?? [];
  const commits = body.commits ?? [];
  if (!Array.isArray(runs) || runs.length > MAX_RUNS) return { error: `runs must be an array of at most ${MAX_RUNS}` };
  if (!Array.isArray(commits) || commits.length > MAX_COMMITS) return { error: `commits must be an array of at most ${MAX_COMMITS}` };
  const badRun = runs.findIndex((r) => !checkRun(r));
  if (badRun >= 0) return { error: `runs[${badRun}] is malformed` };
  const badCommit = commits.findIndex((c) => !checkCommit(c));
  if (badCommit >= 0) return { error: `commits[${badCommit}] is malformed` };
  return {
    runs: (runs as IngestRun[]).map((r) => ({
      runId: r.runId, toolCalls: r.toolCalls, requests: r.requests, firstContext: r.firstContext,
      maxContext: r.maxContext, startTokens: r.startTokens,
      tools: r.tools.map((t) => ({ category: t.category, calls: t.calls, stepTokens: t.stepTokens,
        resultTokens: t.resultTokens, outputBytes: t.outputBytes, durationMs: t.durationMs })),
    })),
    commits: (commits as IngestCommit[]).map((c) => ({
      sha: c.sha, repo: c.repo, prNumber: c.prNumber, prTitle: c.prTitle, prMergedAt: c.prMergedAt, authoredAt: c.authoredAt,
      subject: c.subject, runId: c.runId, matchMethod: c.matchMethod, codeAdded: c.codeAdded, codeDeleted: c.codeDeleted,
      docAdded: c.docAdded, docDeleted: c.docDeleted, codeFiles: c.codeFiles, docFiles: c.docFiles,
    })),
  };
}
