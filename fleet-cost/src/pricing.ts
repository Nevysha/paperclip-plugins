// Claude API list prices in USD per million tokens (standard tier, first-party API).
// Cache writes cost 1.25x base input for the 5-minute TTL and 2x for the 1-hour TTL.
// Runs don't record which TTL was used, so the page lets you pick; 1 hour is the
// default because Paperclip's own estimate makes the same conservative choice.
export const PRICES_AS_OF = "2026-11-03";

type Rate = { input: number; cacheRead: number; output: number };
export const RATES: Record<string, Rate> = {
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, output: 20 },
  "claude-sonnet-5-5": { input: 2, cacheRead: 0.1, output: 10 },
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, cacheRead: 0.01, output: 0.5 },
};
// Runs without a model (e.g. stopped before the first reply) are priced as the fleet's default.
export const FALLBACK_MODEL = "claude-opus-5-5";

export type CacheTtl = "1h" | "5m";
export const CACHE_WRITE_MULTIPLIER: Record<CacheTtl, number> = { "1h": 2, "5m": 1.25 };

/** One aggregated row from the worker: runs of one agent on one task with one model on one day. */
export type UsageRow = {
  day: string; // YYYY-MM-DD in the viewer's time zone
  agentId: string | null;
  agentName: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  model: string;
  runs: number;
  input: number; // all uncached input, cache writes included
  cacheWrite: number;
  cached: number;
  output: number;
};

export type Cost = { input: number; cacheWrite: number; cacheRead: number; output: number; total: number };
export const ZERO_COST: Cost = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 };

export type Tokens = { input: number; cacheWrite: number; cacheRead: number; output: number; total: number };
export const ZERO_TOKENS: Tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 };

export function rateFor(model: string): { rate: Rate; known: boolean } {
  if (Object.hasOwn(RATES, model)) return { rate: RATES[model]!, known: true };
  return { rate: RATES[FALLBACK_MODEL]!, known: false };
}

export function tokensOf(row: UsageRow): Tokens {
  const cacheWrite = Math.min(row.cacheWrite, row.input);
  const input = row.input - cacheWrite;
  return { input, cacheWrite, cacheRead: row.cached, output: row.output, total: input + cacheWrite + row.cached + row.output };
}

export function costOf(row: UsageRow, ttl: CacheTtl): Cost {
  const { rate } = rateFor(row.model);
  const t = tokensOf(row);
  const input = (t.input * rate.input) / 1e6;
  const cacheWrite = (t.cacheWrite * rate.input * CACHE_WRITE_MULTIPLIER[ttl]) / 1e6;
  const cacheRead = (t.cacheRead * rate.cacheRead) / 1e6;
  const output = (t.output * rate.output) / 1e6;
  return { input, cacheWrite, cacheRead, output, total: input + cacheWrite + cacheRead + output };
}

export function addCost(a: Cost, b: Cost): Cost {
  return { input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output, total: a.total + b.total };
}
export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output, total: a.total + b.total };
}

export type Totals = { cost: Cost; tokens: Tokens; runs: number };
export const emptyTotals = (): Totals => ({ cost: ZERO_COST, tokens: ZERO_TOKENS, runs: 0 });

export function total(rows: UsageRow[], ttl: CacheTtl): Totals {
  return rows.reduce<Totals>((acc, r) => ({
    cost: addCost(acc.cost, costOf(r, ttl)),
    tokens: addTokens(acc.tokens, tokensOf(r)),
    runs: acc.runs + r.runs,
  }), emptyTotals());
}

export function groupBy<K extends string>(rows: UsageRow[], key: (r: UsageRow) => K, ttl: CacheTtl): Map<K, Totals> {
  const out = new Map<K, Totals>();
  for (const r of rows) {
    const k = key(r);
    const prev = out.get(k) ?? emptyTotals();
    out.set(k, { cost: addCost(prev.cost, costOf(r, ttl)), tokens: addTokens(prev.tokens, tokensOf(r)), runs: prev.runs + r.runs });
  }
  return out;
}

// ---- Calendar helpers on YYYY-MM-DD strings (no time zone involved) ----

const parse = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
};
const fmt = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}
/** The Monday that starts the week containing `day`. */
export function weekKey(day: string): string {
  const d = parse(day);
  const offset = (d.getUTCDay() + 6) % 7;
  return addDays(day, -offset);
}
export const monthKey = (day: string) => day.slice(0, 7);

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
export function weeksBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let w = weekKey(from); w <= to; w = addDays(w, 7)) out.push(w);
  return out;
}
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number) as [number, number];
  const end = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    out.push(key);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}
