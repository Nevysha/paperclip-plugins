// Duplicate-wake checks for the watchdog (pure: no I/O, so they can be tested on their own).
//
// A follow-up wake resumes the task's whole session, so a wake that only repeats what the agent
// already knows can cost as much as real work (for example a "CI passed" comment after the
// agent had waited for that CI in its own run, and a nudge after Paperclip had already woken the
// agent because its blockers finished). These checks say when the watchdog can stay quiet.
//
// `runs` are Paperclip heartbeat runs ({ issueId, createdAt, startedAt, finishedAt,
// contextSnapshot: { wakeReason } }), newest first or in any order. When the runs list doesn't
// cover the task, the checks answer false, so the watchdog delivers as before.

const time = (s) => (s ? Date.parse(s) : NaN);

function runsOn(runs, issueId) {
  return runs.filter((r) => r.issueId === issueId)
    .sort((a, b) => time(b.createdAt ?? b.startedAt) - time(a.createdAt ?? a.startedAt));
}

// The agent already saw a CI result if a run on the task finished at or after the moment CI
// completed: it was running then (for example waiting with `scripts/forge ci wait`) or ran since,
// and could read it. Only a task whose last run ended before CI finished is still waiting to hear.
export function ciResultAlreadySeen(runs, issueId, ciCompletedAt) {
  const done = time(ciCompletedAt);
  if (!Number.isFinite(done)) return false;
  return runsOn(runs, issueId).some((r) => Number.isFinite(time(r.finishedAt)) && time(r.finishedAt) >= done);
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
