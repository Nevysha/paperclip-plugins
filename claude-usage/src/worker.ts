import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_LIMITS, ROUTINES, decide, isOverLimit, isRoutineKey, parseGateConfig, takeLegacyFlags, toFlags, toRelease,
  type GateConfig, type GateLimits, type RoutineFlags, weekLimit,
} from "./gate.js";
import { parseCredentials, toUsageFile, toWindows, type UsageResult } from "./usage.js";

const CACHE_MS = 2 * 60 * 1000; // The usage endpoint rate-limits, and the header doesn't need to be fresher than this.
const PUBLISH_MS = 5 * 60 * 1000;
const LIMITS_KEY = { scopeKind: "instance" as const, stateKey: "gate-settings" };
const flagsKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: "gate-routines" });
const USAGE_FILE = process.env.CLAUDE_USAGE_FILE?.trim() || join(homedir(), ".paperclip-dev", "claude-usage.json");
const SIGNED_OUT = "Run `claude` on this machine to sign in or refresh your login, then check again.";

let lastGood: Extract<UsageResult, { status: "ok" }> | null = null;
let cached: { expires: number; result: Promise<UsageResult> } | null = null;

async function readToken(): Promise<string | null> {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  try {
    return parseCredentials(await readFile(join(dir, ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

// The token stays in this function: it's only sent to Anthropic, and is never returned or logged.
async function fetchUsage(): Promise<UsageResult> {
  const fallback = (result: UsageResult): UsageResult => (lastGood ? { ...lastGood, stale: true } : result);
  const token = await readToken();
  if (!token) return fallback({ status: "signed_out", message: SIGNED_OUT });
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return fallback({ status: "signed_out", message: SIGNED_OUT });
    if (!res.ok) return fallback({ status: "unavailable", message: `Anthropic returned ${res.status}. It'll retry shortly.` });
    lastGood = { status: "ok", windows: toWindows(await res.json()), fetchedAt: new Date().toISOString(), stale: false };
    return lastGood;
  } catch {
    return fallback({ status: "unavailable", message: "Couldn't reach Anthropic. It'll retry shortly." });
  }
}

function getUsage(): Promise<UsageResult> {
  if (!cached || cached.expires <= Date.now()) {
    cached = { expires: Date.now() + CACHE_MS, result: fetchUsage() };
  }
  return cached.result;
}

async function readLimits(ctx: PluginContext): Promise<GateLimits> {
  const saved = (await ctx.state.get(LIMITS_KEY)) as Partial<GateLimits> | null;
  const limits: GateLimits = { pauseAtPercent: saved?.pauseAtPercent ?? DEFAULT_LIMITS.pauseAtPercent };
  if (saved?.weekPauseAtPercent !== undefined) limits.weekPauseAtPercent = saved.weekPauseAtPercent;
  return limits;
}

async function readFlags(ctx: PluginContext, companyId: string, claimLegacy = false): Promise<RoutineFlags> {
  const saved = await ctx.state.get(flagsKey(companyId));
  if (saved) return toFlags(saved);
  const legacy = takeLegacyFlags(await ctx.state.get(LIMITS_KEY));
  if (!legacy.flags) return toFlags(null);
  if (claimLegacy) {
    await ctx.state.set(flagsKey(companyId), legacy.flags);
    await ctx.state.set(LIMITS_KEY, legacy.rest);
  }
  return legacy.flags;
}

async function readConfig(ctx: PluginContext, companyId: string): Promise<GateConfig> {
  return parseGateConfig(await ctx.config.get(companyId));
}

function requireCompany(params: Record<string, unknown>): string {
  if (typeof params.companyId !== "string" || !params.companyId) throw new Error("Open this from a company");
  return params.companyId;
}

// Lets agents check usage without touching the Claude login or the local API.
async function publishUsage(result: UsageResult, limits: GateLimits) {
  const tmp = `${USAGE_FILE}.tmp`;
  await mkdir(dirname(USAGE_FILE), { recursive: true });
  const gate = { pauseAtPercent: limits.pauseAtPercent, weekPauseAtPercent: weekLimit(limits) };
  await writeFile(tmp, `${JSON.stringify(toUsageFile(result, gate), null, 2)}\n`);
  await rename(tmp, USAGE_FILE);
}

/** Pauses or resumes the company's configured routines. No agent runs, so this costs no Claude usage. */
async function applyGate(ctx: PluginContext, companyId: string, result: UsageResult, limits: GateLimits) {
  let config: GateConfig;
  try {
    config = await readConfig(ctx, companyId);
  } catch (err) {
    ctx.logger.debug("No settings readable for a company, so its routines aren't gated", { companyId, error: String(err) });
    return;
  }
  const flags = config.routines.length ? await readFlags(ctx, companyId, true) : toFlags(await ctx.state.get(flagsKey(companyId)));
  const pausedByGate = { ...flags.pausedByGate };
  const release = toRelease(pausedByGate, config.routines.map((r) => r.key));
  for (const key of release) {
    try {
      const resolved = await ctx.routines.managed.get(key, companyId);
      if (resolved.routine?.status === "paused") await ctx.routines.managed.update(key, companyId, { status: "active" });
      delete pausedByGate[key];
    } catch (err) {
      ctx.logger.warn("Usage gate failed to resume a routine it no longer manages", { companyId, routine: key, error: String(err) });
    }
  }
  if (!config.routines.length) {
    if (release.length) await ctx.state.set(flagsKey(companyId), { ...flags, pausedByGate });
    return;
  }

  const known = result.status === "ok" && !result.stale;
  const windows = known ? result.windows : [];
  const percent = (key: string) => windows.find((w) => w.key === key)?.usedPercent ?? null;
  const over = known && isOverLimit({ session: percent("session"), week: percent("week") }, limits.pauseAtPercent, weekLimit(limits));

  for (const routine of config.routines) {
    try {
      const resolved = await ctx.routines.managed.reconcile(routine.key, companyId, {
        assigneeAgentId: routine.assigneeAgentId,
        projectId: config.projectId,
      });
      const status = resolved.routine?.status;
      if (!status) continue;
      const action = decide({ status, enabled: flags.enabled[routine.key] === true, over, pausedByGate: pausedByGate[routine.key] === true });
      if (action) await ctx.routines.managed.update(routine.key, companyId, { status: action === "pause" ? "paused" : "active" });
      pausedByGate[routine.key] = action === "pause" || (status === "paused" && pausedByGate[routine.key] === true && action !== "resume");
    } catch (err) {
      ctx.logger.warn("Usage gate failed for a routine", { companyId, routine: routine.key, error: String(err) });
    }
  }
  await ctx.state.set(flagsKey(companyId), { ...flags, pausedByGate });
}

async function companyIds(ctx: PluginContext): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await ctx.companies.list({ limit: 100, offset });
    ids.push(...page.map((c) => c.id));
    if (page.length < 100) return ids;
  }
}

interface Change {
  limits?: (limits: GateLimits) => GateLimits;
  flags?: { companyId: string; apply: (flags: RoutineFlags) => RoutineFlags };
}

// Ticks run one at a time, so a settings change can't race a scheduled check.
let queue: Promise<unknown> = Promise.resolve();
function tick(ctx: PluginContext, change: Change = {}) {
  const run = queue.then(async () => {
    let limits = await readLimits(ctx);
    if (change.limits) {
      limits = change.limits(limits);
      const saved = (await ctx.state.get(LIMITS_KEY)) as Record<string, unknown> | null;
      await ctx.state.set(LIMITS_KEY, { ...saved, ...limits });
    }
    if (change.flags) {
      const { companyId, apply } = change.flags;
      await ctx.state.set(flagsKey(companyId), apply(await readFlags(ctx, companyId, true)));
    }
    const result = await getUsage();
    await publishUsage(result, limits).catch((err) => ctx.logger.warn("Writing the usage file failed", { error: String(err) }));
    const companies = change.flags ? [change.flags.companyId] : await companyIds(ctx);
    for (const companyId of companies) {
      await applyGate(ctx, companyId, result, limits).catch((err) =>
        ctx.logger.warn("Usage gate failed for a company", { companyId, error: String(err) }));
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

async function gateView(ctx: PluginContext, companyId: string) {
  const [limits, flags, config] = await Promise.all([readLimits(ctx), readFlags(ctx, companyId), readConfig(ctx, companyId)]);
  const routines = await Promise.all(config.routines.map(async ({ key }) => {
    const resolved = await ctx.routines.managed.get(key, companyId);
    return {
      key,
      title: ROUTINES.find((r) => r.key === key)?.title ?? key,
      enabled: flags.enabled[key] === true,
      status: resolved.routine?.status ?? null,
      pausedByGate: flags.pausedByGate[key] === true,
    };
  }));
  return { pauseAtPercent: limits.pauseAtPercent, weekPauseAtPercent: weekLimit(limits), routines };
}

function validPercent(percent: unknown): number {
  if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new Error("The limit must be a whole number from 1 to 100");
  }
  return percent;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("usage", getUsage);
    ctx.data.register("gate", async (params) => gateView(ctx, requireCompany(params)));

    ctx.actions.register("setRoutineEnabled", async (params) => {
      const companyId = requireCompany(params);
      const { key, enabled } = params;
      const configured = (await readConfig(ctx, companyId)).routines.some((r) => r.key === key);
      if (!isRoutineKey(key) || !configured || typeof enabled !== "boolean") throw new Error("Unknown routine or value");
      await tick(ctx, { flags: { companyId, apply: (f) => ({ ...f, enabled: { ...f.enabled, [key]: enabled } }) } });
      return gateView(ctx, companyId);
    });
    ctx.actions.register("setPauseAtPercent", async (params) => {
      const companyId = requireCompany(params);
      const percent = validPercent(params.percent);
      await tick(ctx, { limits: (l) => ({ ...l, pauseAtPercent: percent }) });
      return gateView(ctx, companyId);
    });
    ctx.actions.register("setWeekPauseAtPercent", async (params) => {
      const companyId = requireCompany(params);
      const percent = validPercent(params.percent);
      await tick(ctx, { limits: (l) => ({ ...l, weekPauseAtPercent: percent }) });
      return gateView(ctx, companyId);
    });

    const check = () => tick(ctx).catch((err) => ctx.logger.warn("Usage check failed", { error: String(err) }));
    void check();
    setInterval(check, PUBLISH_MS).unref();
  },

  async onHealth() {
    return { status: "ok", message: "Claude Usage is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
