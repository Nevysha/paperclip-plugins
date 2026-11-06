import { randomUUID } from "node:crypto";
import { definePlugin, runWorker, type PluginApiRequestInput, type PluginContext, type PluginEvent } from "@paperclipai/plugin-sdk";
import { isUuid, parseDecisionComment, parseReview, REVIEW_STATUSES, type ReviewStatus } from "./validate.js";

let pluginCtx: PluginContext | null = null;

const table = (ctx: PluginContext) => `${ctx.db.namespace}.decisions`;
const fail = (status: number, error: string) => ({ status, body: { error } });

const selectDecisions = (ctx: PluginContext) => `
  SELECT d.id, d.created_at, d.author_type, d.author_agent_id, d.run_id, d.issue_id, d.kind,
         d.question, d.answer, d.reasoning, d.sources, d.review_status, d.review_note, d.reviewed_at,
         a.name AS author_agent_name, i.identifier AS issue_identifier
  FROM ${table(ctx)} d
  LEFT JOIN public.agents a ON a.id = d.author_agent_id
  LEFT JOIN public.issues i ON i.id = d.issue_id`;

async function list(ctx: PluginContext, input: PluginApiRequestInput) {
  const status = typeof input.query.status === "string" ? input.query.status : null;
  if (status && !REVIEW_STATUSES.includes(status as ReviewStatus)) return fail(400, "Unknown status");
  const params: unknown[] = [input.companyId];
  let where = "WHERE d.company_id = $1";
  if (status) {
    params.push(status);
    where += " AND d.review_status = $2";
  }
  const rows = await ctx.db.query(`${selectDecisions(ctx)} ${where} ORDER BY d.created_at DESC LIMIT 200`, params);
  return { body: { decisions: rows } };
}

/**
 * Agents log a decision by posting a comment with a decision-log block through comment_on_task.
 * The author, run and task come from the host's event, so a comment can't claim to be from someone else.
 */
async function captureComment(ctx: PluginContext, event: PluginEvent) {
  const payload = (event.payload ?? {}) as { commentId?: unknown; agentId?: unknown; runId?: unknown };
  const agentId = event.actorType === "agent" && isUuid(event.actorId) ? event.actorId : null;
  const issueId = event.entityId;
  if (!agentId || !isUuid(issueId) || !isUuid(payload.commentId)) return;

  const comments = await ctx.issues.listComments(issueId, event.companyId);
  const comment = comments.find((c) => c.id === payload.commentId);
  if (!comment) return;
  const parsed = parseDecisionComment(comment.body);
  if (!parsed) return;
  if (!parsed.ok) {
    await ctx.issues.createComment(
      issueId,
      `**This decision wasn't logged:** ${parsed.error}. Post a corrected \`decision-log\` comment.`,
      event.companyId,
    );
    return;
  }

  const decision = parsed.value;
  await ctx.db.execute(
    `INSERT INTO ${table(ctx)}
       (id, company_id, author_type, author_agent_id, run_id, issue_id, comment_id, kind, question, answer, reasoning, sources)
     VALUES ($1, $2, 'agent', $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (comment_id) DO NOTHING`,
    [
      randomUUID(),
      event.companyId,
      agentId,
      isUuid(payload.runId) ? payload.runId : null,
      issueId,
      comment.id,
      decision.kind,
      decision.question,
      decision.answer,
      decision.reasoning,
      JSON.stringify(decision.sources),
    ],
  );
}

async function review(ctx: PluginContext, input: PluginApiRequestInput) {
  const id = input.params.id;
  if (!isUuid(id)) return fail(400, "Invalid decision id");
  const parsed = parseReview(input.body);
  if (!parsed.ok) return fail(422, parsed.error);
  const { status, note } = parsed.value;
  const rows = await ctx.db.query<{ issue_id: string | null; question: string; review_status: string }>(
    `SELECT issue_id, question, review_status FROM ${table(ctx)} WHERE id = $1 AND company_id = $2`,
    [id, input.companyId],
  );
  const existing = rows[0];
  if (!existing) return fail(404, "Decision not found");

  await ctx.db.execute(
    `UPDATE ${table(ctx)}
     SET review_status = $1, review_note = $2,
         reviewed_at = CASE WHEN $1 = 'unreviewed' THEN NULL ELSE now() END,
         reviewed_by = $3
     WHERE id = $4 AND company_id = $5`,
    [status, note, input.actor.userId ?? input.actor.actorId, id, input.companyId],
  );

  // An overturned decision is useless if nobody hears about it, so tell the linked task once.
  let notified = false;
  if (status === "overturned" && existing.review_status !== "overturned" && existing.issue_id) {
    await ctx.issues.createComment(
      existing.issue_id,
      `**The founder overturned a decision on this task.**\n\nQuestion: ${existing.question}\n\nInstead: ${note}`,
      input.companyId,
    );
    notified = true;
  }
  return { body: { id, status, notified } };
}

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    ctx.events.on("issue.comment.created", async (event) => {
      try {
        await captureComment(ctx, event);
      } catch (err) {
        ctx.logger.error("Couldn't capture a decision comment", { entityId: event.entityId, error: String(err) });
      }
    });
  },

  async onApiRequest(input) {
    const ctx = pluginCtx;
    if (!ctx) return fail(503, "Decision Log is not ready");
    if (input.routeKey === "list") return list(ctx, input);
    if (input.routeKey === "review") return review(ctx, input);
    return fail(404, "Unknown route");
  },

  async onHealth() {
    return { status: "ok", message: "Decision Log is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
