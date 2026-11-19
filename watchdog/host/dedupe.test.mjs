// Run with: node --test watchdog/host/dedupe.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockersWakeAlreadyDelivered } from "./dedupe.mjs";

const at = (m) => new Date(Date.parse("2026-11-16T12:00:00Z") + m * 60_000).toISOString();
const run = (issueId, startM, endM, wakeReason = "issue_assigned") =>
  ({ issueId, createdAt: at(startM), startedAt: at(startM), finishedAt: endM == null ? null : at(endM), contextSnapshot: { wakeReason } });

test("Paperclip's blockers-finished wake ran and the agent re-blocked: no nudge", () => {
  assert.equal(blockersWakeAlreadyDelivered([run("A", 0, 5), run("A", 30, 35, "issue_blockers_resolved")], "A"), true);
});

test("latest run was something else: nudge as before", () => {
  assert.equal(blockersWakeAlreadyDelivered([run("A", 0, 5, "issue_blockers_resolved"), run("A", 30, 35, "issue_commented")], "A"), false);
  assert.equal(blockersWakeAlreadyDelivered([], "A"), false);
});

test("blockers-finished wake still running: nudge logic waits (not delivered yet)", () => {
  assert.equal(blockersWakeAlreadyDelivered([run("A", 30, null, "issue_blockers_resolved")], "A"), false);
});

test("blockers-finished wake failed: nudge as before", () => {
  const failed = { ...run("A", 30, 35, "issue_blockers_resolved"), status: "failed" };
  assert.equal(blockersWakeAlreadyDelivered([failed], "A"), false);
  assert.equal(blockersWakeAlreadyDelivered([{ ...failed, status: "succeeded" }], "A"), true);
});
