import { definePlugin, runWorker, type PluginApiRequestInput, type PluginContext } from "@paperclipai/plugin-sdk";

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

// One row per day, agent, task and model. Token counts come from each run's usage receipt.
const USAGE_SQL = `
  SELECT to_char(coalesce(r.started_at, r.created_at) AT TIME ZONE $2, 'YYYY-MM-DD') AS day,
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

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
  },

  async onApiRequest(input) {
    const ctx = pluginCtx;
    if (!ctx) return fail(503, "Fleet Cost is not ready");
    if (input.routeKey === "usage") {
      try {
        return await usage(ctx, input);
      } catch (err) {
        ctx.logger.error("Couldn't read run usage", { error: String(err) });
        return fail(500, "Couldn't read run usage");
      }
    }
    return fail(404, "Unknown route");
  },

  async onHealth() {
    return { status: "ok", message: "Fleet Cost is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
