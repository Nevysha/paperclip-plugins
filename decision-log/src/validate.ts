export const DECISION_KINDS = ["answered_from_source", "judgment_call", "auto_approved_task"] as const;
export const REVIEW_STATUSES = ["unreviewed", "reviewed", "overturned"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

export interface NewDecision {
  kind: DecisionKind;
  question: string;
  answer: string;
  reasoning: string;
  sources: string[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function text(body: Record<string, unknown>, key: string, max: number): string | { error: string } {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) return { error: `${key} is required` };
  if (value.length > max) return { error: `${key} must be at most ${max} characters` };
  return value.trim();
}

export function parseNewDecision(input: unknown): Parsed<NewDecision> {
  const body = (input ?? {}) as Record<string, unknown>;
  const kind = body.kind;
  if (!DECISION_KINDS.includes(kind as DecisionKind)) {
    return { ok: false, error: `kind must be one of: ${DECISION_KINDS.join(", ")}` };
  }
  const question = text(body, "question", 2000);
  if (typeof question !== "string") return { ok: false, ...question };
  const answer = text(body, "answer", 4000);
  if (typeof answer !== "string") return { ok: false, ...answer };
  const reasoning = text(body, "reasoning", 4000);
  if (typeof reasoning !== "string") return { ok: false, ...reasoning };

  const rawSources = body.sources ?? [];
  if (
    !Array.isArray(rawSources) ||
    rawSources.length > 10 ||
    rawSources.some((s) => typeof s !== "string" || !s.trim() || s.length > 500)
  ) {
    return { ok: false, error: "sources must be a list of at most 10 non-empty strings of at most 500 characters" };
  }
  const sources = (rawSources as string[]).map((s) => s.trim());
  if (kind === "answered_from_source" && sources.length === 0) {
    return { ok: false, error: "answered_from_source needs at least one source" };
  }

  return { ok: true, value: { kind: kind as DecisionKind, question, answer, reasoning, sources } };
}

export function parseReview(input: unknown): Parsed<{ status: ReviewStatus; note: string | null }> {
  const body = (input ?? {}) as Record<string, unknown>;
  if (!REVIEW_STATUSES.includes(body.status as ReviewStatus)) {
    return { ok: false, error: `status must be one of: ${REVIEW_STATUSES.join(", ")}` };
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  if (note && note.length > 4000) return { ok: false, error: "note must be at most 4000 characters" };
  if (body.status === "overturned" && !note) {
    return { ok: false, error: "Overturning needs a note saying what should happen instead" };
  }
  return { ok: true, value: { status: body.status as ReviewStatus, note } };
}

const BLOCK_RE = /^```decision-log[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m;

/** Returns null when the comment has no decision-log block, so ordinary comments are ignored. */
export function parseDecisionComment(comment: string): Parsed<NewDecision> | null {
  const match = BLOCK_RE.exec(comment);
  if (!match) return null;
  let body: unknown;
  try {
    body = JSON.parse(match[1]);
  } catch {
    return { ok: false, error: "the decision-log block is not valid JSON" };
  }
  return parseNewDecision(body);
}
