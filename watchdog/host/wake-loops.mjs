// Wake-loop detection for the watchdog (pure: no I/O, so it can be tested on its own).
//
// A wake loop is an agent restarting on the same issue again and again with nothing new
// to do: each run ends quickly and Paperclip starts the next one at once. Seen on
// 2026-11-14 (NEV-588): an agent told to "wait for the board's go" ran 4 times in
// 2 minutes, because each "yielded" run registered a continuation that Paperclip
// re-ran straight away. The watchdog only reports a loop; pausing the agent is a
// person's call (pausing cancels its run).
//
// Rule: at least `minRuns` runs by one agent on one issue created in the last `windowMs`
// that nobody asked for (see IGNORED_WAKES), and every finished one among them lasted at most `maxRunMs`.

export const WAKE_LOOP = { minRuns: 3, windowMs: 10 * 60_000, maxRunMs: 2 * 60_000 };
// Not counted: comment wakes (a back-and-forth with the board), and Paperclip's own
// disposition repair, which it caps at 2 retries by itself.
const IGNORED_WAKES = new Set(["issue_commented", "issue_reopened_via_comment", "issue_disposition_repair"]);

export function findWakeLoops(runs, now, limits = WAKE_LOOP) {
  const groups = new Map();
  for (const r of runs) {
    if (!r.issueId || !r.agentId || IGNORED_WAKES.has(r.contextSnapshot?.wakeReason)) continue;
    const created = Date.parse(r.createdAt ?? r.startedAt);
    if (!Number.isFinite(created) || created > now || now - created > limits.windowMs) continue;
    const key = `${r.agentId}:${r.issueId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const loops = [];
  for (const [key, list] of groups) {
    if (list.length < limits.minRuns) continue;
    const finished = list.filter((r) => r.finishedAt && r.startedAt);
    const long = finished.some((r) => Date.parse(r.finishedAt) - Date.parse(r.startedAt) > limits.maxRunMs);
    if (long || finished.length < limits.minRuns - 1) continue;
    const [agentId, issueId] = key.split(":");
    const reasons = [...new Set(list.map((r) => r.contextSnapshot?.wakeReason).filter(Boolean))];
    loops.push({ agentId, issueId, runs: list.length, reasons });
  }
  return loops;
}
