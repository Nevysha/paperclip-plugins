// Duplicate-wake check for the watchdog (pure: no I/O, so it can be tested on its own).
//
// A follow-up wake resumes the task's whole session, so a wake that only repeats what the agent
// already knows can cost as much as real work, for example a nudge after Paperclip had already
// woken the agent because its blockers finished. This check says when the watchdog can stay quiet.
//
// `runs` are Paperclip heartbeat runs ({ issueId, createdAt, startedAt, finishedAt, status,
// contextSnapshot: { wakeReason } }), in any order. When the runs list doesn't cover the task,
// the check answers false, so the watchdog nudges as before.

const time = (s) => (s ? Date.parse(s) : NaN);

function runsOn(runs, issueId) {
  return runs.filter((r) => r.issueId === issueId)
    .sort((a, b) => time(b.createdAt ?? b.startedAt) - time(a.createdAt ?? a.startedAt));
}

// Paperclip wakes the assignee itself when a task's blockers all finish (wake reason
// issue_blockers_resolved). If that run happened and the agent still left the task blocked, it
// chose to (waiting on something else): a nudge would only repeat the news.
export function blockersWakeAlreadyDelivered(runs, issueId) {
  const latest = runsOn(runs, issueId)[0];
  // Only a run that finished normally counts: if it failed, the agent never got the news.
  return latest?.contextSnapshot?.wakeReason === "issue_blockers_resolved" && Number.isFinite(time(latest.finishedAt))
    && (latest.status === undefined || latest.status === "succeeded");
}
