import { definePlugin, runWorker, type PluginApiRequestInput, type PluginContext } from "@paperclipai/plugin-sdk";
import { userInfo } from "node:os";
import { join } from "node:path";
import { wakeComment, type GraphData, type Unblock, type Wait } from "./graph.js";
import { readRegisteredWaits, scanJobs } from "./waits.js";

// The watchdog's folder, where paperclip-wait registers CI waits.
const WAITS_FILE = join(process.env.PAPERCLIP_WATCHDOG_DIR?.trim() || join(userInfo().homedir, ".paperclip-dev", "watchdog"), "waits.json");

let pluginCtx: PluginContext | null = null;
const fail = (status: number, error: string) => ({ status, body: { error } });

const TASKS_SQL = `
  SELECT i.id, i.identifier, left(i.title, 240) AS title, i.status, i.priority, i.parent_id, i.project_id,
         a.name AS assignee_name, (i.assignee_user_id IS NOT NULL) AS assigned_to_user, i.updated_at,
         CASE WHEN i.status = 'blocked' THEN i.unblock_descriptor END AS unblock, ua.name AS unblock_agent_name
  FROM public.issues i
  LEFT JOIN public.agents a ON a.id = i.assignee_agent_id
  LEFT JOIN public.agents ua ON ua.id::text = i.unblock_descriptor->'owner'->>'agentId' 
  WHERE i.company_id = $1 AND i.hidden_at IS NULL`;

const RELATIONS_SQL = `
  SELECT r.issue_id AS blocker_id, r.related_issue_id AS blocked_id
  FROM public.issue_relations r
  WHERE r.company_id = $1 AND r.type = 'blocks'`;

const PROJECTS_SQL = `SELECT p.id, p.name FROM public.projects p WHERE p.company_id = $1 ORDER BY p.name`;

type RawTask = {
  id: string; identifier: string | null; title: string; status: string; priority: string | null;
  parent_id: string | null; project_id: string | null; assignee_name: string | null;
  assigned_to_user: boolean; updated_at: string | Date;
  unblock: { owner?: unknown; action?: unknown } | null; unblock_agent_name: string | null;
};

function unblockOf(t: RawTask): Unblock | null {
  const u = t.unblock;
  if (!u || typeof u.action !== "string" || !u.action.trim()) return null;
  const agent = !!u.owner && typeof u.owner === "object" && "agentId" in u.owner;
  return { owner: agent ? "agent" : "person", ownerName: agent ? t.unblock_agent_name : null, action: u.action.trim() };
}

/** Running jobs and registered CI waits, as boxes for the open tasks they belong to. */
async function waitsFor(ctx: PluginContext, tasks: RawTask[]): Promise<Wait[]> {
  const byIdent = new Map(tasks.filter((t) => t.identifier && t.status !== "done" && t.status !== "cancelled").map((t) => [t.identifier!, t.id]));
  const [jobs, registered] = await Promise.all([
    scanJobs().catch((err) => { ctx.logger.warn("Couldn't scan background jobs", { error: String(err) }); return []; }),
    readRegisteredWaits(WAITS_FILE),
  ]);
  const out: Wait[] = [];
  for (const j of jobs) {
    const taskId = byIdent.get(j.issue);
    if (!taskId) continue;
    out.push({
      id: `wait:job:${j.pid}`, taskId, kind: "job", title: j.command || "Background job", detail: j.lastLine,
      since: j.startedAt, log: j.log, logUpdatedAt: j.logUpdatedAt, pid: j.pid,
    });
  }
  for (const w of registered) {
    const taskId = byIdent.get(w.issue);
    if (!taskId || w.kind !== "ci") continue;
    const repo = w.repo && w.repo !== "Nevysha/space-4x" ? ` (${w.repo.split("/").pop()})` : "";
    out.push({ id: `wait:ci:${w.id}`, taskId, kind: "ci", title: `CI on ${w.ref ?? "?"}${repo}`, detail: w.note ?? null, since: w.createdAt });
  }
  return out;
}

async function graph(ctx: PluginContext, input: PluginApiRequestInput): Promise<{ body: GraphData }> {
  const [tasks, relations, projects] = await Promise.all([
    ctx.db.query<RawTask>(TASKS_SQL, [input.companyId]),
    ctx.db.query<{ blocker_id: string; blocked_id: string }>(RELATIONS_SQL, [input.companyId]),
    ctx.db.query<{ id: string; name: string }>(PROJECTS_SQL, [input.companyId]),
  ]);
  const waits = await waitsFor(ctx, tasks);
  return {
    body: {
      generatedAt: new Date().toISOString(),
      tasks: tasks.map((t) => ({
        id: t.id, identifier: t.identifier, title: t.title, status: t.status, priority: t.priority,
        parentId: t.parent_id, projectId: t.project_id, assigneeName: t.assignee_name,
        assignedToUser: Boolean(t.assigned_to_user), updatedAt: new Date(t.updated_at).toISOString(),
        unblock: unblockOf(t),
      })),
      relations: relations.map((r) => ({ blockerId: r.blocker_id, blockedId: r.blocked_id })),
      projects,
      waits,
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WAKE_TASK_SQL = `
  SELECT i.identifier, i.status, i.assignee_agent_id, i.unblock_descriptor->>'action' AS unblock_action,
         (SELECT count(*) FROM public.issue_relations r JOIN public.issues b ON b.id = r.issue_id
           WHERE r.related_issue_id = i.id AND r.type = 'blocks' AND b.status NOT IN ('done', 'cancelled'))::int AS open_blockers,
         (SELECT count(*) FROM public.issue_relations r WHERE r.related_issue_id = i.id AND r.type = 'blocks')::int AS blockers
  FROM public.issues i
  WHERE i.id = $1 AND i.company_id = $2 AND i.hidden_at IS NULL`;

/** The board's "Wake it" button: only for a blocked task with no open blocker and nothing running for it. */
async function wake(ctx: PluginContext, input: PluginApiRequestInput) {
  const id = input.params.id;
  if (!id || !UUID.test(id)) return fail(400, "Unknown task");
  const [t] = await ctx.db.query<{
    identifier: string | null; status: string; assignee_agent_id: string | null; unblock_action: string | null;
    open_blockers: number; blockers: number;
  }>(WAKE_TASK_SQL, [id, input.companyId]);
  if (!t) return fail(404, "Unknown task");
  if (t.status !== "blocked") return fail(409, "It isn't blocked any more");
  if (t.open_blockers > 0) return fail(409, "It still waits on an open task");
  if (!t.assignee_agent_id) return fail(409, "No agent is assigned to it, so there's nobody to wake");
  const [jobs, registered] = await Promise.all([scanJobs().catch(() => []), readRegisteredWaits(WAITS_FILE)]);
  if (t.identifier && (jobs.some((j) => j.issue === t.identifier) || registered.some((w) => w.issue === t.identifier && w.kind === "ci"))) {
    return fail(409, "A background job or CI wait is still running for it, and will wake it");
  }
  const actor = { actorUserId: input.actor.userId ?? null };
  await ctx.issues.update(id, { status: "todo" }, input.companyId, actor);
  await ctx.issues.createComment(id, wakeComment({ unblockAction: t.unblock_action, stale: t.blockers > 0 }), input.companyId);
  const woke = await ctx.issues.requestWakeup(id, input.companyId, {
    ...actor, reason: "Woken from the Dependencies page", contextSource: "dependency-graph",
    idempotencyKey: `dependency-graph-wake:${id}:${Math.floor(Date.now() / 60_000)}`,
  });
  ctx.logger.info("Woke a blocked task", { issue: t.identifier, queued: woke.queued });
  return { status: 200, body: { identifier: t.identifier, queued: woke.queued, runId: woke.runId } };
}

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
  },

  async onApiRequest(input) {
    const ctx = pluginCtx;
    if (!ctx) return fail(503, "Dependency Graph is not ready");
    if (input.routeKey === "graph") {
      try {
        return await graph(ctx, input);
      } catch (err) {
        ctx.logger.error("Couldn't read task dependencies", { error: String(err) });
        return fail(500, "Couldn't read task dependencies");
      }
    }
    if (input.routeKey === "wake") {
      try {
        return await wake(ctx, input);
      } catch (err) {
        ctx.logger.error("Couldn't wake a task", { error: String(err) });
        return fail(500, `Couldn't wake it: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
      }
    }
    return fail(404, "Unknown route");
  },

  async onHealth() {
    return { status: "ok", message: "Dependency Graph is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
