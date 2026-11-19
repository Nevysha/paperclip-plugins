import { readFile, rm, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { parseStatus, summarize } from "./status.js";

// The watchdog runs outside Paperclip (a systemd user timer), so it keeps working
// when Paperclip freezes. This plugin only reads its files and toggles its pause flag.
const DIR = process.env.PAPERCLIP_WATCHDOG_DIR?.trim() || join(homedir(), ".paperclip-dev", "watchdog");
const FILES = {
  status: join(DIR, "status.json"),
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
  const [status, paused] = await Promise.all([readText(FILES.status), readText(FILES.paused)]);
  return summarize({ status: parseStatus(status), paused: paused !== null, now: Date.now() });
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

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("status", view);
    ctx.actions.register("setPaused", async ({ paused }) => {
      if (typeof paused !== "boolean") throw new Error("paused must be true or false");
      await setPaused(paused);
      return view();
    });
  },

  async onHealth() {
    return { status: "ok", message: "Watchdog button is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
