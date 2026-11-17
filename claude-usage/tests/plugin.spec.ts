import { describe, expect, it, vi } from "vitest";

const testSetup = vi.hoisted(() => {
  const routine = (key: string, assigneeAgentId: string, defaultEnabled: boolean) =>
    ({ key, title: key, description: "d", label: "l", cron: "0 * * * *", assigneeAgentId, defaultEnabled });
  const value: Record<string, unknown> = {
    companyId: "c-setup",
    projectId: "p-setup",
    timezone: "UTC",
    routines: [routine("po-review", "a-po", true), routine("safety-review", "a-safety", false)],
  };
  return { value };
});
vi.mock("../src/setup.generated.js", () => ({ get default() { return testSetup.value; } }));

import { DEFAULT_FLAGS, ROUTINES, claimsLegacyFlags, decide, isOverLimit, parseGateConfig, takeLegacyFlags, toFlags, toRelease } from "../src/gate.js";
import manifest from "../src/manifest.js";
import { parseCredentials, toUsageFile, toWindows } from "../src/usage.js";

describe("manifest", () => {
  it("declares a routine for each configurable key", () => {
    expect(manifest.routines?.map((r: { routineKey: string }) => r.routineKey)).toEqual(ROUTINES.map((r) => r.key));
  });
});

describe("manifest config", () => {
  it("offers only the declared routine keys", () => {
    const schema = manifest.instanceConfigSchema as { properties: { routines: { items: { properties: { key: { enum: string[] } } } } } };
    expect(schema.properties.routines.items.properties.key.enum).toEqual(ROUTINES.map((r) => r.key));
  });
});

describe("without a setup.json company", () => {
  it("offers any key, declares no routines and gives the saved checkboxes to the first company with routines", async () => {
    vi.resetModules();
    const saved = testSetup.value;
    testSetup.value = { companyId: "", projectId: "", timezone: "UTC", routines: [] };
    try {
      const empty = (await import("../src/manifest.js")).default;
      const schema = empty.instanceConfigSchema as { properties: { routines: { items: { properties: { key: Record<string, unknown> } } } } };
      expect(schema.properties.routines.items.properties.key).toEqual({ type: "string" });
      expect(empty.routines).toEqual([]);
      const gate = await import("../src/gate.js");
      expect(gate.claimsLegacyFlags("c-any", true)).toBe(true);
      expect(gate.claimsLegacyFlags("c-any", false)).toBe(false);
    } finally {
      testSetup.value = saved;
      vi.resetModules();
    }
  });
});

describe("parseGateConfig", () => {
  it("manages nothing without config in a company setup.json doesn't name", () => {
    expect(parseGateConfig(undefined, "c-other")).toEqual({ projectId: null, routines: [] });
    expect(parseGateConfig({}, "c-other")).toEqual({ projectId: null, routines: [] });
    expect(parseGateConfig({ routines: "po-review" }, "c-other")).toEqual({ projectId: null, routines: [] });
  });
  it("uses the setup.json project and routines for the setup.json company without a routines list", () => {
    const fromSetup = { projectId: "p-setup", routines: [{ key: "po-review", assigneeAgentId: "a-po" }, { key: "safety-review", assigneeAgentId: "a-safety" }] };
    expect(parseGateConfig(undefined, "c-setup")).toEqual(fromSetup);
    expect(parseGateConfig({}, "c-setup")).toEqual(fromSetup);
    expect(parseGateConfig({ projectId: "p1" }, "c-setup")).toEqual({ ...fromSetup, projectId: "p1" });
  });
  it("lets the setup.json company's settings replace its routines", () => {
    expect(parseGateConfig({ routines: [] }, "c-setup")).toEqual({ projectId: "p-setup", routines: [] });
    expect(parseGateConfig({ routines: [{ key: "safety-review", assigneeAgentId: "a1" }] }, "c-setup"))
      .toEqual({ projectId: "p-setup", routines: [{ key: "safety-review", assigneeAgentId: "a1" }] });
  });
  it("keeps configured routines with an assignee, trimmed", () => {
    expect(parseGateConfig({ projectId: " p1 ", routines: [{ key: "safety-review", assigneeAgentId: " a1 " }] }, "c-other"))
      .toEqual({ projectId: "p1", routines: [{ key: "safety-review", assigneeAgentId: "a1" }] });
  });
  it("drops unknown keys, blank assignees and duplicates", () => {
    const config = parseGateConfig({
      projectId: "  ",
      routines: [
        { key: "nope", assigneeAgentId: "a1" },
        { key: "po-review", assigneeAgentId: "" },
        { key: "po-review" },
        null,
        { key: "safety-review", assigneeAgentId: "a2" },
        { key: "safety-review", assigneeAgentId: "a3" },
      ],
    }, "c-other");
    expect(config).toEqual({ projectId: null, routines: [{ key: "safety-review", assigneeAgentId: "a2" }] });
  });
});

describe("claimsLegacyFlags", () => {
  it("gives the saved checkboxes to the setup.json company only", () => {
    expect(claimsLegacyFlags("c-setup", false)).toBe(true);
    expect(claimsLegacyFlags("c-other", true)).toBe(false);
  });
});

describe("toFlags", () => {
  it("merges saved flags over the defaults", () => {
    const flags = toFlags({ enabled: { "safety-review": true }, pausedByGate: { "po-review": true } });
    expect(flags.enabled).toEqual({ ...DEFAULT_FLAGS.enabled, "safety-review": true });
    expect(flags.pausedByGate).toEqual({ "po-review": true });
  });
  it("starts from the defaults when nothing is saved", () => {
    expect(toFlags(null)).toEqual(DEFAULT_FLAGS);
    expect(toFlags("nope")).toEqual(DEFAULT_FLAGS);
  });
});

describe("takeLegacyFlags", () => {
  it("splits the old routine flags from the limits", () => {
    const { flags, rest } = takeLegacyFlags({ pauseAtPercent: 80, weekPauseAtPercent: 95, enabled: { "safety-review": true }, pausedByGate: { "po-review": true } });
    expect(flags).toEqual({ enabled: { ...DEFAULT_FLAGS.enabled, "safety-review": true }, pausedByGate: { "po-review": true } });
    expect(rest).toEqual({ pauseAtPercent: 80, weekPauseAtPercent: 95 });
  });
  it("finds nothing to take once the flags are gone", () => {
    expect(takeLegacyFlags({ pauseAtPercent: 80 })).toEqual({ flags: null, rest: { pauseAtPercent: 80 } });
    expect(takeLegacyFlags(null)).toEqual({ flags: null, rest: {} });
  });
});

describe("toRelease", () => {
  it("lets go of routines the gate paused that the company no longer lists", () => {
    expect(toRelease({ "po-review": true, "safety-review": true }, ["safety-review"])).toEqual(["po-review"]);
  });
  it("keeps listed routines and ignores ones the gate didn't pause", () => {
    expect(toRelease({ "po-review": false, "safety-review": true }, ["safety-review"])).toEqual([]);
    expect(toRelease({ "po-review": false }, [])).toEqual([]);
    expect(toRelease({ unknown: true }, [])).toEqual([]);
  });
});

describe("toWindows", () => {
  it("maps the windows the API returns", () => {
    const w = toWindows({
      five_hour: { utilization: 9, resets_at: "2026-11-06T22:29:59Z" },
      seven_day: { utilization: 6.4 },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    });
    expect(w.map((x) => x.key)).toEqual(["session", "week", "extra"]);
    expect(w[0]).toMatchObject({ usedPercent: 9, resetsAt: "2026-11-06T22:29:59Z" });
    expect(w[1].usedPercent).toBe(6);
    expect(w[2]).toMatchObject({ usedPercent: null, note: "Not enabled" });
  });
  it("clamps odd values and tolerates an empty body", () => {
    expect(toWindows({ five_hour: { utilization: 140 } })[0].usedPercent).toBe(100);
    expect(toWindows({ five_hour: {} })[0].usedPercent).toBeNull();
    expect(toWindows(null)).toEqual([]);
  });
});

describe("parseCredentials", () => {
  const file = (o: object) => JSON.stringify({ claudeAiOauth: o });
  it("reads a live token", () => {
    expect(parseCredentials(file({ accessToken: "t", expiresAt: 2000 }), 1000)).toBe("t");
  });
  it("rejects expired, missing and malformed logins", () => {
    expect(parseCredentials(file({ accessToken: "t", expiresAt: 500 }), 1000)).toBeNull();
    expect(parseCredentials(file({}), 1000)).toBeNull();
    expect(parseCredentials("not json", 1000)).toBeNull();
  });
});

describe("toUsageFile", () => {
  it("publishes only percentages and times", () => {
    const windows = toWindows({ five_hour: { utilization: 91, resets_at: "r1" }, seven_day: { utilization: 6, resets_at: "r2" } });
    expect(toUsageFile({ status: "ok", windows, fetchedAt: "t", stale: false })).toEqual({
      status: "ok", fetchedAt: "t", stale: false, sessionPercent: 91, sessionResetsAt: "r1", weekPercent: 6, weekResetsAt: "r2",
    });
  });
  it("marks failures as stale with no numbers", () => {
    expect(toUsageFile({ status: "signed_out", message: "x" })).toMatchObject({ status: "signed_out", stale: true, sessionPercent: null });
  });
});

describe("gate", () => {
  const base = { status: "active", enabled: true, over: false, pausedByGate: false };
  it("pauses a selected routine over the limit", () => {
    expect(decide({ ...base, over: true })).toBe("pause");
  });
  it("leaves unselected routines alone", () => {
    expect(decide({ ...base, enabled: false, over: true })).toBeNull();
  });
  it("resumes what it paused once usage drops or the routine is unselected", () => {
    expect(decide({ ...base, status: "paused", pausedByGate: true })).toBe("resume");
    expect(decide({ ...base, status: "paused", pausedByGate: true, enabled: false, over: true })).toBe("resume");
    expect(decide({ ...base, status: "paused", pausedByGate: true, over: true })).toBeNull();
  });
  it("never resumes a routine paused by hand, or touches an archived one", () => {
    expect(decide({ ...base, status: "paused" })).toBeNull();
    expect(decide({ ...base, status: "archived", over: true })).toBeNull();
  });
  it("counts session or week, and unknown usage isn't over", () => {
    expect(isOverLimit({ session: 90, week: 1 }, 90)).toBe(true);
    expect(isOverLimit({ session: 1, week: 95 }, 90)).toBe(true);
    expect(isOverLimit({ session: 89, week: null }, 90)).toBe(false);
    expect(isOverLimit(null, 90)).toBe(false);
    // Separate weekly limit
    expect(isOverLimit({ session: 50, week: 90 }, 80, 95)).toBe(false);
    expect(isOverLimit({ session: 80, week: 10 }, 80, 95)).toBe(true);
    expect(isOverLimit({ session: 10, week: 95 }, 80, 95)).toBe(true);
  });
});
