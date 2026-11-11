import { definePlugin, runWorker, type PluginApiRequestInput, type PluginContext } from "@paperclipai/plugin-sdk";
import type { GraphData } from "./graph.js";

let pluginCtx: PluginContext | null = null;
const fail = (status: number, error: string) => ({ status, body: { error } });

const TASKS_SQL = `
  SELECT i.id, i.identifier, left(i.title, 240) AS title, i.status, i.priority, i.parent_id, i.project_id,
         a.name AS assignee_name, (i.assignee_user_id IS NOT NULL) AS assigned_to_user, i.updated_at
  FROM public.issues i
  LEFT JOIN public.agents a ON a.id = i.assignee_agent_id
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
};

async function graph(ctx: PluginContext, input: PluginApiRequestInput): Promise<{ body: GraphData }> {
  const [tasks, relations, projects] = await Promise.all([
    ctx.db.query<RawTask>(TASKS_SQL, [input.companyId]),
    ctx.db.query<{ blocker_id: string; blocked_id: string }>(RELATIONS_SQL, [input.companyId]),
    ctx.db.query<{ id: string; name: string }>(PROJECTS_SQL, [input.companyId]),
  ]);
  return {
    body: {
      generatedAt: new Date().toISOString(),
      tasks: tasks.map((t) => ({
        id: t.id, identifier: t.identifier, title: t.title, status: t.status, priority: t.priority,
        parentId: t.parent_id, projectId: t.project_id, assigneeName: t.assignee_name,
        assignedToUser: Boolean(t.assigned_to_user), updatedAt: new Date(t.updated_at).toISOString(),
      })),
      relations: relations.map((r) => ({ blockerId: r.blocker_id, blockedId: r.blocked_id })),
      projects,
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
