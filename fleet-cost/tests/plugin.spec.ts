import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { costOf, groupBy, monthsBetween, total, weekKey, weeksBetween, type UsageRow } from "../src/pricing.js";

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  day: "2026-11-11", agentId: "a", agentName: "A", issueId: "i", issueIdentifier: "NEV-1", issueTitle: "T",
  model: "claude-opus-5-5", runs: 1, input: 0, cacheWrite: 0, cached: 0, output: 0, ...over,
});

describe("manifest", () => {
  it("only reads, and only for the board", () => {
    expect(manifest.apiRoutes?.every((r) => r.auth === "board" && r.method === "GET")).toBe(true);
    expect(manifest.capabilities).not.toContain("database.namespace.write");
  });
});

describe("costOf", () => {
  it("prices each token type at the Opus 5.5 list price", () => {
    // 1M each of plain input, cache write, cache read and output
    const c = costOf(row({ input: 2_000_000, cacheWrite: 1_000_000, cached: 1_000_000, output: 1_000_000 }), "1h");
    expect(c.input).toBeCloseTo(4);
    expect(c.cacheWrite).toBeCloseTo(8);
    expect(c.cacheRead).toBeCloseTo(0.2);
    expect(c.output).toBeCloseTo(20);
    expect(c.total).toBeCloseTo(32.2);
  });
  it("uses 1.25x for 5-minute cache writes", () => {
    expect(costOf(row({ input: 1_000_000, cacheWrite: 1_000_000 }), "5m").total).toBeCloseTo(5);
  });
  it("prices Sonnet 5.5 at its own rates", () => {
    expect(costOf(row({ model: "claude-sonnet-5-5", cached: 1_000_000, output: 1_000_000 }), "1h").total).toBeCloseTo(10.1);
  });
  it("falls back to Opus 5.5 for runs without a model", () => {
    expect(costOf(row({ model: "", output: 1_000_000 }), "1h").total).toBeCloseTo(20);
  });
  it("never counts more cache writes than input", () => {
    expect(costOf(row({ input: 100, cacheWrite: 500 }), "1h").input).toBe(0);
  });
});

describe("aggregation", () => {
  it("sums totals and groups by agent", () => {
    const rows = [row({ output: 1_000_000, runs: 2 }), row({ agentId: "b", output: 500_000 })];
    expect(total(rows, "1h").runs).toBe(3);
    const g = groupBy(rows, (r) => r.agentId ?? "", "1h");
    expect(g.get("a")!.cost.total).toBeCloseTo(20);
    expect(g.get("b")!.cost.total).toBeCloseTo(10);
  });
});

describe("calendar", () => {
  it("starts weeks on Monday", () => {
    expect(weekKey("2026-11-11")).toBe("2026-11-09"); // Wednesday
    expect(weekKey("2026-11-09")).toBe("2026-11-09");
    expect(weekKey("2026-11-15")).toBe("2026-11-09"); // Sunday
  });
  it("lists weeks and months across a boundary", () => {
    expect(weeksBetween("2026-11-06", "2026-11-11")).toEqual(["2026-11-02", "2026-11-09"]);
    expect(monthsBetween("2026-11-20", "2027-01-02")).toEqual(["2026-11", "2026-12", "2027-01"]);
  });
});
