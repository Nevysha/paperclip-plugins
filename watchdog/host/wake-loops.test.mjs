// Run with: node --test watchdog/host/wake-loops.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { findWakeLoops } from "./wake-loops.mjs";

const T = Date.parse("2026-11-14T12:06:00Z");
const run = (agentId, issueId, startS, durS, wakeReason = "issue_status_changed") => {
  const s = new Date(T + startS * 1000).toISOString();
  return { agentId, issueId, createdAt: s, startedAt: s,
    finishedAt: durS == null ? null : new Date(T + (startS + durS) * 1000).toISOString(),
    contextSnapshot: { wakeReason } };
};

test("flags the NEV-588 pattern: 4 short runs in 2 minutes", () => {
  const runs = [run("a", "i", -163, 43, "issue_commented"), run("a", "i", -120, 20), run("a", "i", -99, 19), run("a", "i", -80, 24)];
  assert.deepEqual(findWakeLoops(runs, T), [{ agentId: "a", issueId: "i", runs: 3, reasons: ["issue_status_changed"] }]);
});

test("counts a run still going", () => {
  const runs = [run("a", "i", -90, 20), run("a", "i", -60, 20), run("a", "i", -30, 20), run("a", "i", -5, null)];
  assert.equal(findWakeLoops(runs, T).length, 1);
});

test("ignores real work: one long run among them", () => {
  const runs = [run("a", "i", -500, 300), run("a", "i", -150, 20), run("a", "i", -100, 20), run("a", "i", -60, 20)];
  assert.deepEqual(findWakeLoops(runs, T), []);
});

test("ignores too few runs, old runs, other issues and runs without an issue", () => {
  const runs = [run("a", "i", -60, 20), run("a", "i", -30, 20),
    run("a", "i", -900, 20), run("a", "j", -20, 10), { ...run("a", null, -10, 5), issueId: null }];
  assert.deepEqual(findWakeLoops(runs, T), []);
});

test("ignores runs created after `now` (replaying history)", () => {
  const runs = [run("a", "i", -120, 20), run("a", "i", -99, 19), run("a", "i", -80, 24), run("a", "i", -60, 20), run("a", "i", 200, 400)];
  assert.equal(findWakeLoops(runs, T).length, 1);
});

test("ignores a quick back-and-forth with the board (comment wakes)", () => {
  const runs = [1, 2, 3, 4, 5].map((k) => run("a", "i", -k * 60, 20, k % 2 ? "issue_commented" : "issue_reopened_via_comment"));
  assert.deepEqual(findWakeLoops(runs, T), []);
});
