import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { parseCredentials, toWindows, type UsageResult } from "./usage.js";

const CACHE_MS = 2 * 60 * 1000; // The usage endpoint rate-limits, and the header doesn't need to be fresher than this.
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

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("usage", async () => {
      if (!cached || cached.expires <= Date.now()) {
        cached = { expires: Date.now() + CACHE_MS, result: fetchUsage() };
      }
      return cached.result;
    });
  },

  async onHealth() {
    return { status: "ok", message: "Claude Usage is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
