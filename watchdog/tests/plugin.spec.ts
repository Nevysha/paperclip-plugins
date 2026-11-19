import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { ACTING_MS, STALE_MS, summarize, type WatchdogStatusFile } from "../src/status.js";

const NOW = Date.parse("2026-11-08T20:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const base: WatchdogStatusFile = { lastTickAt: at(60_000), healthy: true, summary: "All clear", recentActions: [] };

describe("summarize", () => {
  it("is all clear after a recent healthy tick", () => {
    expect(summarize({ status: base, paused: false, now: NOW }).level).toBe("ok");
  });
  it("puts paused ahead of everything", () => {
    expect(summarize({ status: { ...base, healthy: false }, paused: true, now: NOW }).level).toBe("paused");
  });
  it("says not running when there's no status or it's stale", () => {
    expect(summarize({ status: null, paused: false, now: NOW }).level).toBe("missing");
    expect(summarize({ status: { ...base, lastTickAt: at(STALE_MS + 1000) }, paused: false, now: NOW }).level).toBe("stale");
  });
  it("raises an alert on a quarantine or an error", () => {
    expect(summarize({ status: { ...base, healthy: false }, paused: false, now: NOW }).level).toBe("alert");
    expect(summarize({ status: { ...base, healthy: null }, paused: false, now: NOW }).level).toBe("alert");
  });
  it("says acting after a recent action, newest first", () => {
    const status = { ...base, recentActions: [{ at: at(ACTING_MS * 2), msg: "old" }, { at: at(60_000), msg: "new" }] };
    const v = summarize({ status, paused: false, now: NOW });
    expect(v.level).toBe("acting");
    expect(v.detail).toBe("new");
    expect(v.recentActions.map((a) => a.msg)).toEqual(["new", "old"]);
  });
});

describe("worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-plugin-"));
  let harness: ReturnType<typeof createTestHarness>;

  beforeAll(async () => {
    process.env.PAPERCLIP_WATCHDOG_DIR = dir;
    writeFileSync(join(dir, "status.json"), JSON.stringify({ ...base, lastTickAt: new Date().toISOString() }));
    const { default: plugin } = await import("../src/worker.js");
    harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    await plugin.definition.setup(harness.ctx);
  });

  it("only asks to add the button", () => {
    expect(manifest.capabilities).toEqual(["ui.action.register"]);
  });

  it("reports status", async () => {
    const v = (await harness.getData("status")) as { level: string };
    expect(v.level).toBe("ok");
  });

  it("pauses and resumes through the flag file", async () => {
    expect(((await harness.performAction("setPaused", { paused: true })) as { level: string }).level).toBe("paused");
    expect(existsSync(join(dir, "paused"))).toBe(true);
    expect(((await harness.performAction("setPaused", { paused: false })) as { level: string }).level).toBe("ok");
    expect(existsSync(join(dir, "paused"))).toBe(false);
  });

  it("no longer offers to remove CI waits", async () => {
    await expect(harness.performAction("cancelWait", { id: "w1" })).rejects.toThrow();
  });
});
