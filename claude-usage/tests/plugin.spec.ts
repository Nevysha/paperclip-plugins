import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { parseCredentials, toWindows } from "../src/usage.js";

describe("manifest", () => {
  it("only asks for the header slot", () => {
    expect(manifest.capabilities).toEqual(["ui.action.register"]);
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
