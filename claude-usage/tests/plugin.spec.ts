import { describe, expect, it } from "vitest";
import { ROUTINES, decide, isOverLimit } from "../src/gate.js";
import manifest from "../src/manifest.js";
import { parseCredentials, toUsageFile, toWindows } from "../src/usage.js";

describe("manifest", () => {
  it("declares a routine for each configurable key", () => {
    expect(manifest.routines?.map((r: { routineKey: string }) => r.routineKey)).toEqual(ROUTINES.map((r) => r.key));
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
