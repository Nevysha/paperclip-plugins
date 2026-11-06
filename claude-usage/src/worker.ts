import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_SETTINGS, ROUTINES, decide, isOverLimit, isRoutineKey, type GateSettings } from "./gate.js";
import { parseCredentials, toUsageFile, toWindows, type UsageResult } from "./usage.js";

const CACHE_MS = 2 * 60 * 1000; // The usage endpoint rate-limits, and the header doesn't need to be fresher than this.
const PUBLISH_MS = 5 * 60 * 1000;
const COMPANY_ID = "f305d1c7-0061-4a97-90b4-73783025f4cc";
const PROJECT_ID = "ee5c6459-1d20-4dcf-b92b-f7d8b0bfe7c4";
const ASSIGNEES: Record<string, string> = {
  "po-review": "54511d0a-2ede-4a78-ba2b-ab0e8dfc07e6",
  "safety-review": "b9860e4a-e2a5-4837-a1b2-155a72b7957e",
};
const SETTINGS_KEY = { scopeKind: "instance" as const, stateKey: "gate-settings" };
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

async function readSettings(ctx: PluginContext): Promise<GateSettings> {
  const saved = (await ctx.state.get(SETTINGS_KEY)) as Partial<GateSettings> | null;
  return { ...DEFAULT_SETTINGS, ...saved, enabled: { ...DEFAULT_SETTINGS.enabled, ...saved?.enabled } };
}

// Lets agents check usage without touching the Claude login or the local API.
async function publishUsage(result: UsageResult, settings: GateSettings) {
  const tmp = `${USAGE_FILE}.tmp`;
  await mkdir(dirname(USAGE_FILE), { recursive: true });
  const gate = { pauseAtPercent: settings.pauseAtPercent, routines: settings.enabled };
  await writeFile(tmp, `${JSON.stringify(toUsageFile(result, gate), null, 2)}\n`);
  await rename(tmp, USAGE_FILE);
}

/** Pauses or resumes the selected routines. No agent runs, so this costs no Claude usage. */
async function applyGate(ctx: PluginContext, result: UsageResult, settings: GateSettings) {
  const known = result.status === "ok" && !result.stale;
  const windows = known ? result.windows : [];
  const percent = (key: string) => windows.find((w) => w.key === key)?.usedPercent ?? null;
  const over = known && isOverLimit({ session: percent("session"), week: percent("week") }, settings.pauseAtPercent);
  const pausedByGate = { ...settings.pausedByGate };

  for (const routine of ROUTINES) {
    const resolved = await ctx.routines.managed.reconcile(routine.key, COMPANY_ID, {
      assigneeAgentId: ASSIGNEES[routine.key],
      projectId: PROJECT_ID,
    });
    const status = resolved.routine?.status;
    if (!status) continue;
    const action = decide({ status, enabled: settings.enabled[routine.key] === true, over, pausedByGate: pausedByGate[routine.key] === true });
    if (action) await ctx.routines.managed.update(routine.key, COMPANY_ID, { status: action === "pause" ? "paused" : "active" });
    pausedByGate[routine.key] = action === "pause" || (status === "paused" && pausedByGate[routine.key] === true && action !== "resume");
  }
  return { ...settings, pausedByGate };
}

// Ticks run one at a time, so a settings change can't race a scheduled check.
let queue: Promise<unknown> = Promise.resolve();
function tick(ctx: PluginContext, change?: (settings: GateSettings) => GateSettings) {
  const run = queue.then(async () => {
    const before = await readSettings(ctx);
    const changed = change ? change(before) : before;
    const result = await getUsage();
    const after = await applyGate(ctx, result, changed);
    await ctx.state.set(SETTINGS_KEY, after);
    await publishUsage(result, after);
  });
  queue = run.catch(() => undefined);
  return run;
}

async function gateView(ctx: PluginContext) {
  const settings = await readSettings(ctx);
  const routines = await Promise.all(ROUTINES.map(async (r) => {
    const resolved = await ctx.routines.managed.get(r.key, COMPANY_ID);
    return {
      key: r.key,
      title: r.title,
      enabled: settings.enabled[r.key] === true,
      status: resolved.routine?.status ?? null,
      pausedByGate: settings.pausedByGate[r.key] === true,
    };
  }));
  return { pauseAtPercent: settings.pauseAtPercent, routines };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("usage", getUsage);
    ctx.data.register("gate", () => gateView(ctx));

    ctx.actions.register("setRoutineEnabled", async ({ key, enabled }) => {
      if (!isRoutineKey(key) || typeof enabled !== "boolean") throw new Error("Unknown routine or value");
      await tick(ctx, (s) => ({ ...s, enabled: { ...s.enabled, [key]: enabled } }));
      return gateView(ctx);
    });
    ctx.actions.register("setPauseAtPercent", async ({ percent }) => {
      if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 1 || percent > 100) {
        throw new Error("The limit must be a whole number from 1 to 100");
      }
      await tick(ctx, (s) => ({ ...s, pauseAtPercent: percent }));
      return gateView(ctx);
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
