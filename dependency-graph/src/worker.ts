import { definePlugin, runWorker, type PluginApiRequestInput, type PluginContext } from "@paperclipai/plugin-sdk";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { GraphData, Unblock, Wait } from "./graph.js";
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
    return fail(404, "Unknown route");
  },

  async onHealth() {
    return { status: "ok", message: "Dependency Graph is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
