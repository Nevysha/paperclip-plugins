import { definePlugin, runWorker, type PluginApiRequestInput, type PluginContext } from "@paperclipai/plugin-sdk";
import { parseIngest } from "./ingest.js";

let pluginCtx: PluginContext | null = null;
const fail = (status: number, error: string) => ({ status, body: { error } });

export function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

const num = (field: string) => `coalesce((r.usage_json->>'${field}')::numeric, 0)`;
const DAY = (col: string) => `to_char(${col} AT TIME ZONE $2, 'YYYY-MM-DD')`;
const RUN_DAY = DAY("coalesce(r.started_at, r.created_at)");

// ---- usage: one row per day, agent, task and model, from each run's usage receipt ----

const USAGE_SQL = `
  SELECT ${RUN_DAY} AS day,
         r.agent_id, a.name AS agent_name,
         r.issue_id, i.identifier AS issue_identifier, i.title AS issue_title,
         coalesce(r.usage_json->>'model', '') AS model,
         count(*)::int AS runs,
         sum(${num("inputTokens")})::text AS input,
         sum(${num("cacheWriteTokens")})::text AS cache_write,
         sum(${num("cachedInputTokens")})::text AS cached,
         sum(${num("outputTokens")})::text AS output
  FROM public.heartbeat_runs r
  LEFT JOIN public.agents a ON a.id = r.agent_id
  LEFT JOIN public.issues i ON i.id = r.issue_id
  WHERE r.company_id = $1 AND r.usage_json IS NOT NULL
  GROUP BY 1, 2, 3, 4, 5, 6, 7
  HAVING sum(${num("inputTokens")} + ${num("cachedInputTokens")} + ${num("outputTokens")}) > 0
  ORDER BY 1`;

type Raw = {
  day: string; agent_id: string | null; agent_name: string | null; issue_id: string | null;
  issue_identifier: string | null; issue_title: string | null; model: string; runs: number;
  input: string; cache_write: string; cached: string; output: string;
};

async function usage(ctx: PluginContext, input: PluginApiRequestInput) {
  const tz = validTimeZone(input.query.tz) ?? "UTC";
  const rows = await ctx.db.query<Raw>(USAGE_SQL, [input.companyId, tz]);
  return {
    body: {
      timeZone: tz,
      generatedAt: new Date().toISOString(),
      rows: rows.map((r) => ({
        day: r.day, agentId: r.agent_id, agentName: r.agent_name, issueId: r.issue_id,
        issueIdentifier: r.issue_identifier, issueTitle: r.issue_title, model: r.model, runs: Number(r.runs),
        input: Number(r.input), cacheWrite: Number(r.cache_write), cached: Number(r.cached), output: Number(r.output),
      })),
    },
  };
}

// ---- tools ---------------------------------------------------------------------

/**
 * Each run's input tokens split across what caused them, in proportion to the step
 * tokens the collector measured: each tool category, and "Run start" (the first
 * request). "Model output" carries the run's output tokens. So a run's rows add up to
 * its whole usage receipt, and the page prices them like any usage row.
 */
const toolRowsSql = (ns: string) => `
  WITH runs AS (
    SELECT r.id, ${RUN_DAY} AS day, r.agent_id, a.name AS agent_name,
           coalesce(r.usage_json->>'model', '') AS model,
           ${num("inputTokens")} AS input, ${num("cacheWriteTokens")} AS cache_write,
           ${num("cachedInputTokens")} AS cached, ${num("outputTokens")} AS output,
           nullif(${num("inputTokens")} + ${num("cachedInputTokens")}, 0) AS recorded
    FROM public.heartbeat_runs r
    JOIN ${ns}.run_stats s ON s.run_id = r.id AND s.company_id = $1
    LEFT JOIN public.agents a ON a.id = r.agent_id
    WHERE r.company_id = $1
  ), parts AS (
    SELECT t.run_id, t.category, t.calls, t.step_tokens, t.result_tokens, t.output_bytes, t.duration_ms
    FROM ${ns}.run_tools t WHERE t.company_id = $1
    UNION ALL
    SELECT s.run_id, 'Run start', 0, s.start_tokens, s.first_context, 0, 0
    FROM ${ns}.run_stats s WHERE s.company_id = $1
  )
  SELECT u.day, u.agent_id, u.agent_name, u.model, p.category,
         sum(p.calls)::text AS calls, sum(p.step_tokens)::text AS step_tokens, sum(p.result_tokens)::text AS result_tokens,
         sum(p.output_bytes)::text AS output_bytes, sum(p.duration_ms)::text AS duration_ms,
         sum(coalesce(p.step_tokens / u.recorded, 0) * u.input)::text AS input,
         sum(coalesce(p.step_tokens / u.recorded, 0) * u.cache_write)::text AS cache_write,
         sum(coalesce(p.step_tokens / u.recorded, 0) * u.cached)::text AS cached,
         '0' AS output
  FROM parts p JOIN runs u ON u.id = p.run_id
  GROUP BY 1, 2, 3, 4, 5
  UNION ALL
  SELECT u.day, u.agent_id, u.agent_name, u.model, 'Model output', '0', '0', '0', '0', '0', '0', '0', '0', sum(u.output)::text
  FROM runs u GROUP BY 1, 2, 3, 4`;

const runRowsSql = (ns: string) => `
  SELECT s.run_id, ${RUN_DAY} AS day, r.agent_id, a.name AS agent_name,
         r.issue_id, i.identifier AS issue_identifier, i.title AS issue_title, coalesce(r.usage_json->>'model', '') AS model,
         s.tool_calls, s.requests, s.first_context, s.max_context, s.start_tokens::text AS start_tokens,
         ${num("inputTokens")}::text AS input, ${num("cacheWriteTokens")}::text AS cache_write,
         ${num("cachedInputTokens")}::text AS cached, ${num("outputTokens")}::text AS output
  FROM ${ns}.run_stats s
  JOIN public.heartbeat_runs r ON r.id = s.run_id AND r.company_id = $1
  LEFT JOIN public.agents a ON a.id = r.agent_id
  LEFT JOIN public.issues i ON i.id = r.issue_id
  WHERE s.company_id = $1
  ORDER BY 2`;

type ToolRaw = {
  day: string; agent_id: string | null; agent_name: string | null; model: string; category: string;
  calls: string; step_tokens: string; result_tokens: string; output_bytes: string; duration_ms: string;
  input: string; cache_write: string; cached: string; output: string;
};
type RunRaw = {
  run_id: string; day: string; agent_id: string | null; agent_name: string | null; issue_id: string | null;
  issue_identifier: string | null; issue_title: string | null; model: string; tool_calls: number; requests: number;
  first_context: number; max_context: number; start_tokens: string;
  input: string; cache_write: string; cached: string; output: string;
};

async function tools(ctx: PluginContext, input: PluginApiRequestInput) {
  const tz = validTimeZone(input.query.tz) ?? "UTC";
  const ns = ctx.db.namespace;
  const [toolRows, runRows] = await Promise.all([
    ctx.db.query<ToolRaw>(toolRowsSql(ns), [input.companyId, tz]),
    ctx.db.query<RunRaw>(runRowsSql(ns), [input.companyId, tz]),
  ]);
  return {
    body: {
      timeZone: tz,
      generatedAt: new Date().toISOString(),
      tools: toolRows.map((r) => ({
        day: r.day, agentId: r.agent_id, agentName: r.agent_name, model: r.model, category: r.category,
        calls: Number(r.calls), stepTokens: Number(r.step_tokens), resultTokens: Number(r.result_tokens),
        outputBytes: Number(r.output_bytes), durationMs: Number(r.duration_ms),
        input: Number(r.input), cacheWrite: Number(r.cache_write), cached: Number(r.cached), output: Number(r.output),
      })),
      runs: runRows.map((r) => ({
        runId: r.run_id, day: r.day, agentId: r.agent_id, agentName: r.agent_name, issueId: r.issue_id,
        issueIdentifier: r.issue_identifier, issueTitle: r.issue_title, model: r.model,
        toolCalls: Number(r.tool_calls), requests: Number(r.requests), firstContext: Number(r.first_context),
        maxContext: Number(r.max_context), startTokens: Number(r.start_tokens),
        input: Number(r.input), cacheWrite: Number(r.cache_write), cached: Number(r.cached), output: Number(r.output),
      })),
    },
  };
}

// ---- efficiency ------------------------------------------------------------------

// All usage per task: every run on it, whatever it did.
const issueUsageSql = `
  SELECT r.issue_id, i.identifier AS issue_identifier, i.title AS issue_title,
         coalesce(r.usage_json->>'model', '') AS model, count(*)::int AS runs,
         string_agg(DISTINCT a.name, ', ') AS agents, max(${RUN_DAY}) AS last_day,
         sum(${num("inputTokens")})::text AS input, sum(${num("cacheWriteTokens")})::text AS cache_write,
         sum(${num("cachedInputTokens")})::text AS cached, sum(${num("outputTokens")})::text AS output
  FROM public.heartbeat_runs r
  LEFT JOIN public.issues i ON i.id = r.issue_id
  LEFT JOIN public.agents a ON a.id = r.agent_id
  WHERE r.company_id = $1 AND r.usage_json IS NOT NULL
  GROUP BY 1, 2, 3, 4`;

// A commit belongs to the task of the run that made it; failing that, to the task named
// in its PR's title (commits from before runs recorded tool calls, merge commits).
const commitsSql = (ns: string) => `
  SELECT c.sha, c.pr_number, c.pr_title, ${DAY("c.pr_merged_at")} AS merged_day, c.match_method,
         c.code_added, c.code_deleted, c.doc_added, c.doc_deleted, c.code_files, c.doc_files,
         coalesce(r.issue_id, t.id) AS issue_id, r.agent_id, a.name AS agent_name
  FROM ${ns}.commits c
  LEFT JOIN public.heartbeat_runs r ON r.id = c.run_id AND r.company_id = $1
  LEFT JOIN public.agents a ON a.id = r.agent_id
  LEFT JOIN public.issues t ON t.company_id = $1 AND t.identifier = substring(c.pr_title, '([A-Z][A-Z0-9]*-[0-9]+)')
  WHERE c.company_id = $1`;

type IssueRaw = {
  issue_id: string | null; issue_identifier: string | null; issue_title: string | null; model: string; runs: number;
  agents: string | null; last_day: string; input: string; cache_write: string; cached: string; output: string;
};
type CommitRaw = {
  sha: string; pr_number: number; pr_title: string; merged_day: string | null; match_method: string;
  code_added: number; code_deleted: number; doc_added: number; doc_deleted: number; code_files: number; doc_files: number;
  issue_id: string | null; agent_id: string | null; agent_name: string | null;
};

async function efficiency(ctx: PluginContext, input: PluginApiRequestInput) {
  const tz = validTimeZone(input.query.tz) ?? "UTC";
  const [issues, commits] = await Promise.all([
    ctx.db.query<IssueRaw>(issueUsageSql, [input.companyId, tz]),
    ctx.db.query<CommitRaw>(commitsSql(ctx.db.namespace), [input.companyId, tz]),
  ]);
  return {
    body: {
      timeZone: tz,
      generatedAt: new Date().toISOString(),
      usage: issues.map((r) => ({
        issueId: r.issue_id, issueIdentifier: r.issue_identifier, issueTitle: r.issue_title, model: r.model,
        runs: Number(r.runs), agents: r.agents ?? "", lastDay: r.last_day,
        input: Number(r.input), cacheWrite: Number(r.cache_write), cached: Number(r.cached), output: Number(r.output),
      })),
      commits: commits.map((c) => ({
        sha: c.sha, prNumber: Number(c.pr_number), prTitle: c.pr_title, mergedDay: c.merged_day, matchMethod: c.match_method,
        codeAdded: Number(c.code_added), codeDeleted: Number(c.code_deleted), docAdded: Number(c.doc_added),
        docDeleted: Number(c.doc_deleted), codeFiles: Number(c.code_files), docFiles: Number(c.doc_files),
        issueId: c.issue_id, agentId: c.agent_id, agentName: c.agent_name,
      })),
    },
  };
}

// ---- ingest: summaries from collector/collect.mjs ------------------------------

async function ingest(ctx: PluginContext, input: PluginApiRequestInput) {
  const body = parseIngest(input.body);
  if ("error" in body) return fail(422, body.error);
  const ns = ctx.db.namespace;
  const company = input.companyId;
  if (body.runs.length) {
    // A run is always re-posted whole: replace its tool rows.
    // Arrays are passed as JSON text: the host expands a JS array into a tuple.
    await ctx.db.execute(
      `DELETE FROM ${ns}.run_tools WHERE company_id = $1
         AND run_id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid)`,
      [company, JSON.stringify(body.runs.map((r) => r.runId))]);
    await ctx.db.execute(
      `INSERT INTO ${ns}.run_stats (run_id, company_id, tool_calls, requests, first_context, max_context, start_tokens)
       SELECT x."runId", $1, x."toolCalls", x.requests, x."firstContext", x."maxContext", x."startTokens"
       FROM jsonb_to_recordset($2::jsonb) AS x("runId" uuid, "toolCalls" int, requests int, "firstContext" int, "maxContext" int, "startTokens" bigint)
       ON CONFLICT (run_id) DO UPDATE SET tool_calls = excluded.tool_calls, requests = excluded.requests,
         first_context = excluded.first_context, max_context = excluded.max_context, start_tokens = excluded.start_tokens,
         collected_at = now()`,
      [company, JSON.stringify(body.runs.map(({ tools: _tools, ...r }) => r))],
    );
    const toolRows = body.runs.flatMap((r) => r.tools.map((t) => ({ runId: r.runId, ...t })));
    if (toolRows.length) {
      await ctx.db.execute(
        `INSERT INTO ${ns}.run_tools (run_id, company_id, category, calls, step_tokens, result_tokens, output_bytes, duration_ms)
         SELECT x."runId", $1, x.category, x.calls, x."stepTokens", x."resultTokens", x."outputBytes", x."durationMs"
         FROM jsonb_to_recordset($2::jsonb) AS x("runId" uuid, category text, calls int, "stepTokens" bigint, "resultTokens" bigint, "outputBytes" bigint, "durationMs" bigint)`,
        [company, JSON.stringify(toolRows)],
      );
    }
  }
  if (body.commits.length) {
    await ctx.db.execute(
      `INSERT INTO ${ns}.commits (sha, company_id, repo, pr_number, pr_title, pr_merged_at, authored_at, subject, run_id,
         match_method, code_added, code_deleted, doc_added, doc_deleted, code_files, doc_files)
       SELECT x.sha, $1, x.repo, x."prNumber", x."prTitle", x."prMergedAt", x."authoredAt", x.subject, x."runId",
         x."matchMethod", x."codeAdded", x."codeDeleted", x."docAdded", x."docDeleted", x."codeFiles", x."docFiles"
       FROM jsonb_to_recordset($2::jsonb) AS x(sha text, repo text, "prNumber" int, "prTitle" text, "prMergedAt" timestamptz,
         "authoredAt" timestamptz, subject text, "runId" uuid, "matchMethod" text, "codeAdded" int, "codeDeleted" int,
         "docAdded" int, "docDeleted" int, "codeFiles" int, "docFiles" int)
       ON CONFLICT (sha) DO UPDATE SET pr_number = excluded.pr_number, pr_title = excluded.pr_title,
         pr_merged_at = excluded.pr_merged_at, run_id = excluded.run_id, match_method = excluded.match_method,
         code_added = excluded.code_added, code_deleted = excluded.code_deleted, doc_added = excluded.doc_added,
         doc_deleted = excluded.doc_deleted, code_files = excluded.code_files, doc_files = excluded.doc_files,
         collected_at = now()`,
      [company, JSON.stringify(body.commits)],
    );
  }
  return { body: { runs: body.runs.length, commits: body.commits.length } };
}

const ROUTES: Record<string, (ctx: PluginContext, input: PluginApiRequestInput) => Promise<{ status?: number; body?: unknown }>> = {
  usage, tools, efficiency, ingest,
};

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
  },

  async onApiRequest(input) {
    const ctx = pluginCtx;
    if (!ctx) return fail(503, "Token Lens is not ready");
    const handler = ROUTES[input.routeKey];
    if (!handler) return fail(404, "Unknown route");
    try {
      return await handler(ctx, input);
    } catch (err) {
      ctx.logger.error(`Token Lens ${input.routeKey} failed`, { error: String(err) });
      return fail(500, input.routeKey === "ingest" ? "Couldn't store the collector's data" : "Couldn't read usage");
    }
  },

  async onHealth() {
    return { status: "ok", message: "Token Lens is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
