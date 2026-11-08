import { readFile, rm, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { parseStatus, parseWaits, summarize } from "./status.js";

// The watchdog runs outside Paperclip (a systemd user timer), so it keeps working
// when Paperclip freezes. This plugin only reads its files and toggles its pause flag.
const DIR = process.env.PAPERCLIP_WATCHDOG_DIR?.trim() || join(homedir(), ".paperclip-dev", "watchdog");
const FILES = {
  status: join(DIR, "status.json"),
  waits: join(DIR, "waits.json"),
  paused: join(DIR, "paused"),
};

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function view() {
  const [status, waits, paused] = await Promise.all([readText(FILES.status), readText(FILES.waits), readText(FILES.paused)]);
  return summarize({ status: parseStatus(status), waits: parseWaits(waits), paused: paused !== null, now: Date.now() });
}

async function setPaused(paused: boolean) {
  if (paused) {
    const tmp = `${FILES.paused}.tmp`;
    await writeFile(tmp, `Paused from the Paperclip header at ${new Date().toISOString()}\n`, { mode: 0o600 });
    await rename(tmp, FILES.paused);
  } else {
    await rm(FILES.paused, { force: true });
  }
}

async function cancelWait(id: string) {
  const text = await readText(FILES.waits);
  const waits = parseWaits(text);
  if (!waits.some((w) => w.id === id)) throw new Error("That wait is already gone");
  const tmp = `${FILES.waits}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ waits: waits.filter((w) => w.id !== id) }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, FILES.waits);
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("status", view);
    ctx.actions.register("setPaused", async ({ paused }) => {
      if (typeof paused !== "boolean") throw new Error("paused must be true or false");
      await setPaused(paused);
      return view();
    });
    ctx.actions.register("cancelWait", async ({ id }) => {
      if (typeof id !== "string" || !id) throw new Error("A wait id is required");
      await cancelWait(id);
      return view();
    });
  },

  async onHealth() {
    return { status: "ok", message: "Watchdog button is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
