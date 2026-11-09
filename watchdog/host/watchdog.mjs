#!/usr/bin/env node
// Paperclip watchdog: does the routine unblocking a person would otherwise do.
// Runs every few minutes from a systemd user timer (paperclip-watchdog.timer).
//
// Each tick, unless paused (~/.paperclip-dev/watchdog/paused exists):
//   1. Quarantine: if new runs fail with native_session_cleanup_quarantined since
//      Paperclip started (a company-wide freeze), restart Paperclip once nothing is live.
//   2. Held tasks: a task whose failed run Paperclip won't replay
//      (executionBlocker set) is recreated as a "(Restarted) ..." copy, its
//      dependants are re-pointed at the copy, and the original is cancelled.
//   3. Nudges: a `blocked` task whose blockers are all done, or whose last run
//      failed, goes back to `todo` with a comment, which wakes its owner.
//   4. Idle todo: a `todo` task with nothing running and no open blockers gets a wakeup.
//   5. CI: when a GitHub Actions run finishes, comment on the open task named in
//      the commit message or branch (or whose recent comments name the commit),
//      which wakes its owner.
// Steps 2-5 start agent runs, so they're skipped while Claude usage is at or
// over the gate in ~/.paperclip-dev/claude-usage.json. Never sends cards, never
// closes tasks as done, never starts Paperclip when it's down.
//
// Files (in ~/.paperclip-dev/watchdog/): status.json (read by the header plugin),
// state.json (memory between ticks), watchdog.log, paused (pause flag).
// Flags: --dry-run (log what it would do, change nothing), --once (same as default).

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const API = "http://localhost:3100/api";
const COMPANY = "f305d1c7-0061-4a97-90b4-73783025f4cc";
const REPOS = ["Nevysha/space-4x", "Nevysha/paperclip-plugins"];
const GH_CONFIG_DIR = join(HOME, ".config/space4x/gh");
const DIR = process.env.PAPERCLIP_WATCHDOG_DIR?.trim() || join(HOME, ".paperclip-dev/watchdog");
const FILES = {
  status: join(DIR, "status.json"),
  state: join(DIR, "state.json"),
  log: join(DIR, "watchdog.log"),
  paused: join(DIR, "paused"),
  usage: join(HOME, ".paperclip-dev/claude-usage.json"),
};
const DRY = process.argv.includes("--dry-run");
const LIVE = new Set(["queued", "scheduled_retry", "running"]);
const CLOSED = new Set(["done", "cancelled"]);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const LIMITS = {
  restartGap: 20 * MIN, restartsPerDay: 6,
  copiesPerDay: 10, maxRestartDepth: 3,
  nudgeGapPerTask: 6 * HOUR, nudgesPerDay: 20,
  wakeGapPerTask: HOUR, quietBeforeWake: 10 * MIN,
  ciLookback: Number(process.env.WATCHDOG_CI_LOOKBACK_MIN ?? 120) * MIN, ciPendingMax: 3 * HOUR,
};

mkdirSync(DIR, { recursive: true, mode: 0o700 });
const now = Date.now();
const actions = [];
const notes = [];

function log(kind, msg, extra) {
  const line = `${new Date().toISOString()} ${DRY ? "[dry-run] " : ""}${kind}: ${msg}${extra ? " " + JSON.stringify(extra) : ""}`;
  if (!existsSync(FILES.log)) { writeFileSync(FILES.log, ""); chmodSync(FILES.log, 0o600); }
  appendFileSync(FILES.log, line + "\n");
  if (kind !== "debug") console.log(line);
}
function act(msg, extra) { actions.push({ at: new Date().toISOString(), msg }); log("action", msg, extra); }
function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } }
function writeJsonAtomic(path, value) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

const state = Object.assign(
  { ciSeen: {}, ciPending: {}, ciDelivered: {}, nudged: {}, woke: {}, restarts: [], copies: [], nudges: [], recentActions: [] },
  readJson(FILES.state, {}),
);
const within = (list, ms) => list.filter((t) => now - t < ms);

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${String(text).slice(0, 300)}`);
  return json;
}
const list = (x, key) => (Array.isArray(x) ? x : x?.[key] ?? x?.items ?? []);
async function mutate(desc, method, path, body) {
  if (DRY) { act(`(would) ${desc}`); return null; }
  const out = await api(method, path, body);
  act(desc);
  return out;
}

function usageGate() {
  const u = readJson(FILES.usage, null);
  if (!u) return { open: true, why: "usage file missing; not gating" };
  const limit = u.gate?.pauseAtPercent ?? 80;
  const weekLimit = u.gate?.weekPauseAtPercent ?? limit;
  const stale = !u.fetchedAt || now - Date.parse(u.fetchedAt) > 30 * MIN;
  if (stale) return { open: true, why: "usage data stale; not gating" };
  const hot = (typeof u.sessionPercent === "number" && u.sessionPercent >= limit) || (typeof u.weekPercent === "number" && u.weekPercent >= weekLimit);
  return hot
    ? { open: false, why: `usage ${u.sessionPercent}% session (limit ${limit}%) / ${u.weekPercent}% week (limit ${weekLimit}%)` }
    : { open: true, why: `usage ${u.sessionPercent}% session / ${u.weekPercent}% week` };
}

function writeStatus(extra) {
  const status = {
    schema: "paperclip-watchdog.status.v1",
    lastTickAt: new Date().toISOString(),
    dryRun: DRY,
    paused: existsSync(FILES.paused),
    ...extra,
    actionsThisTick: actions,
    notes,
    recentActions: state.recentActions.slice(-20),
  };
  if (!DRY) writeJsonAtomic(FILES.status, status);
}

function gh(args) {
  return execFileSync("gh", args, {
    env: { ...process.env, GH_CONFIG_DIR },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function restartPaperclip() {
  if (DRY) { act("(would) restart Paperclip to clear the company-wide quarantine"); return; }
  // zsh -ic loads nvm, which paperclip-start needs. paperclip-stop refuses while
  // runs are live, so this can't cut off work.
  const out = execFileSync("zsh", ["-ic", "paperclip-stop && paperclip-start"], { encoding: "utf8", timeout: 400_000 });
  state.restarts.push(now);
  act("restarted Paperclip to clear the company-wide quarantine", { output: out.trim().split("\n").slice(-2).join(" | ") });
}

async function main() {
  if (existsSync(FILES.paused)) {
    log("debug", "paused; skipping tick");
    writeStatus({ healthy: null, summary: "Paused" });
    return;
  }

  let health;
  try { health = await api("GET", "/health"); } catch (e) {
    log("warn", "Paperclip is not answering; doing nothing (it may have been stopped on purpose)");
    writeStatus({ healthy: false, paperclipUp: false, summary: "Paperclip is not running" });
    return;
  }
  const startedAt = Date.parse(health.serverInfo?.processStartedAt ?? 0);

  const [runsRaw, agentsRaw, issuesRaw] = await Promise.all([
    api("GET", `/companies/${COMPANY}/heartbeat-runs?limit=200`),
    api("GET", `/companies/${COMPANY}/agents`),
    api("GET", `/companies/${COMPANY}/issues?limit=500`),
  ]);
  const runs = list(runsRaw, "runs");
  const agents = list(agentsRaw, "agents");
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const liveRuns = runs.filter((r) => LIVE.has(r.status));
  const liveIssueIds = new Set(liveRuns.map((r) => r.issueId).filter(Boolean));

  // 1. Quarantine
  const quarantined = runs.filter((r) => r.errorCode === "native_session_cleanup_quarantined"
    && Date.parse(r.createdAt) > startedAt);
  if (quarantined.length) {
    const recent = within(state.restarts, DAY);
    if (liveRuns.length) {
      notes.push(`Quarantine detected (${quarantined.length} runs); waiting for ${liveRuns.length} live run(s) before restarting`);
    } else if (state.restarts.length && now - Math.max(...state.restarts) < LIMITS.restartGap) {
      notes.push("Quarantine detected; last restart was under 20 min ago, waiting");
    } else if (recent.length >= LIMITS.restartsPerDay) {
      notes.push(`Quarantine detected but ${recent.length} restarts in 24 h already; needs a person`);
      log("warn", "restart limit reached; not restarting");
    } else {
      restartPaperclip();
    }
    // Everything else waits until the quarantine is gone.
    return finish({ healthy: false, summary: "Company-wide quarantine: agents can't start runs", quarantined: quarantined.length });
  }

  const gate = usageGate();
  if (!gate.open) notes.push(`Not waking agents: ${gate.why}`);

  // After Claude's session limit resets, runs that failed on the limit can start again. Forget the
  // per-task cooldowns once, so stalled tasks get nudged and woken on the first tick after a reset
  // instead of hours later. The daily caps still apply.
  const usage = readJson(FILES.usage, null);
  const resetsAt = usage?.sessionResetsAt ? Date.parse(usage.sessionResetsAt) : NaN;
  if (Number.isFinite(resetsAt)) {
    const prev = state.sessionResetsAt ? Date.parse(state.sessionResetsAt) : NaN;
    if (gate.open && Number.isFinite(prev) && prev <= now && resetsAt > prev) {
      state.nudged = {}; state.woke = {};
      act(`Claude session limit reset (was due ${new Date(prev).toISOString()}); cleared per-task cooldowns`);
    }
    // While the gate is closed, keep the old time, so the sweep happens on the first open tick.
    if (!Number.isFinite(prev) || (resetsAt > prev && gate.open)) state.sessionResetsAt = new Date(resetsAt).toISOString();
  }

  const issues = list(issuesRaw, "issues");
  const open = issues.filter((i) => !CLOSED.has(i.status) && i.status !== "backlog");
  const detailed = new Map();
  for (const i of open) detailed.set(i.id, await api("GET", `/issues/${i.id}`));
  const openDeps = (d) => (d.blockedBy ?? []).filter((b) => !CLOSED.has(b.status));

  if (gate.open) {
    // 2. Held tasks -> restarted copies
    for (const d of detailed.values()) {
      if (!d.executionBlocker || liveIssueIds.has(d.id)) continue;
      const depth = (d.title.match(/^\(Restarted(?: x(\d+))?\)/) ?? [])[1];
      const level = d.title.startsWith("(Restarted") ? Number(depth ?? 1) : 0;
      if (level >= LIMITS.maxRestartDepth) { notes.push(`${d.identifier} has been restarted ${level} times; leaving it for a person`); continue; }
      if (within(state.copies, DAY).length >= LIMITS.copiesPerDay) { notes.push("Daily limit of restarted copies reached"); break; }
      const baseTitle = d.title.replace(/^\(Restarted(?: x\d+)?\) /, "");
      const title = `${level ? `(Restarted x${level + 1})` : "(Restarted)"} ${baseTitle}`.slice(0, 240);
      const note = `_Restarted copy of ${d.identifier}, made by the Paperclip watchdog. Its last run failed on a Paperclip platform error (${d.executionBlocker.cause ?? "held run"}), not on anything in the work, and Paperclip won't restart that task. **Read ${d.identifier}'s comments first**: they hold the context and any progress so far, and some of the work may already be done. ${d.identifier} is cancelled; continue here._\n\n`;
      const deps = (d.blockedBy ?? []).filter((b) => !CLOSED.has(b.status)).map((b) => b.id);
      const copy = await mutate(`recreated held task ${d.identifier} as a restarted copy`, "POST", `/companies/${COMPANY}/issues`, {
        title, description: note + (d.description ?? ""), status: "todo", priority: d.priority,
        assigneeAgentId: d.assigneeAgentId, parentId: d.parentId, projectId: d.projectId,
        ...(deps.length ? { blockedByIssueIds: deps } : {}),
      });
      if (!copy) continue;
      state.copies.push(now);
      for (const other of detailed.values()) {
        if (!(other.blockedBy ?? []).some((b) => b.id === d.id)) continue;
        const ids = other.blockedBy.map((b) => (b.id === d.id ? copy.id : b.id));
        await mutate(`re-pointed ${other.identifier} to wait on ${copy.identifier} instead of ${d.identifier}`, "PATCH", `/issues/${other.id}`, { blockedByIssueIds: ids });
      }
      await mutate(`cancelled ${d.identifier} (replaced by ${copy.identifier})`, "PATCH", `/issues/${d.id}`, {
        status: "cancelled",
        comment: `Watchdog: replaced by ${copy.identifier} after a Paperclip platform error left this task unable to restart. Work continues there.`,
      });
    }

    // 3. Nudge blocked tasks that nothing will wake
    for (const d of detailed.values()) {
      if (d.status !== "blocked" || d.executionBlocker || liveIssueIds.has(d.id) || !d.assigneeAgentId) continue;
      if (state.nudged[d.id] && now - state.nudged[d.id] < LIMITS.nudgeGapPerTask) continue;
      if (within(state.nudges, DAY).length >= LIMITS.nudgesPerDay) { notes.push("Daily nudge limit reached"); break; }
      const deps = d.blockedBy ?? [];
      let why = null;
      if (deps.length && !openDeps(d).length) {
        why = `everything this was waiting on is finished (${deps.map((b) => b.identifier).join(", ")})`;
      } else if (!deps.length) {
        const issueRuns = list(await api("GET", `/issues/${d.id}/runs`), "runs");
        const last = issueRuns.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        if (last?.status === "failed" && now - Date.parse(d.updatedAt) > 5 * MIN) {
          why = `your last run here failed on a Paperclip error (${last.errorCode ?? "unknown"}), so the task was parked as blocked`;
        }
      }
      if (!why) continue;
      await mutate(`moved ${d.identifier} from blocked to todo: ${why}`, "PATCH", `/issues/${d.id}`, {
        status: "todo",
        comment: `Watchdog: ${why}. Please check where this stands and carry on; if the work is already finished, close it.`,
      });
      state.nudged[d.id] = now; state.nudges.push(now);
    }

    // 4. Wake idle todo tasks
    for (const d of detailed.values()) {
      if (d.status !== "todo" || !d.assigneeAgentId || liveIssueIds.has(d.id) || openDeps(d).length) continue;
      const agent = agentById.get(d.assigneeAgentId);
      if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status)) continue;
      if (now - Date.parse(d.updatedAt) < LIMITS.quietBeforeWake) continue;
      if (state.woke[d.id] && now - state.woke[d.id] < LIMITS.wakeGapPerTask) continue;
      state.woke[d.id] = now;
      if (DRY) { act(`(would) wake ${agent.name} on idle todo task ${d.identifier}`); continue; }
      const r = await api("POST", `/agents/${agent.id}/wakeup`, {
        source: "automation", triggerDetail: "system", reason: `Watchdog: ${d.identifier} is todo with nothing running`,
        payload: { issueId: d.id },
      });
      if (r?.status === "skipped") log("debug", `wake for ${d.identifier} skipped: ${r.reason}`);
      else act(`woke ${agent.name} on idle todo task ${d.identifier}`);
    }
  }

  // 5. CI results -> comments on the waiting task
  await checkCi({ gate, detailed, liveIssueIds, issues });

  // 6. Tasks marked "Sized: one run" get the Sliced label (agents' create_task can't set labels).
  // Only the label changes, so this runs even while the usage gate is closed.
  await labelSliced(issues);

  return finish({ healthy: true, summary: actions.length ? `${actions.length} action(s) this tick` : "All clear" });
}

const SLICED_LABEL = "Sliced";
const SLICED_MARKER = /^\s*(?:\*\*)?Sized:\s*one run\b/i;
async function labelSliced(issues) {
  const candidates = issues.filter((i) => !CLOSED.has(i.status) && SLICED_MARKER.test(i.description ?? "")
    && !(i.labels ?? []).some((l) => l.name === SLICED_LABEL));
  if (!candidates.length) return;
  const labels = list(await api("GET", `/companies/${COMPANY}/labels`), "labels");
  const label = labels.find((l) => l.name === SLICED_LABEL);
  if (!label) { notes.push(`No "${SLICED_LABEL}" label in the company; can't mark ${candidates.length} sized task(s)`); return; }
  for (const i of candidates) {
    await mutate(`labelled ${i.identifier} ${SLICED_LABEL}`, "PATCH", `/issues/${i.id}`, { labelIds: [...(i.labelIds ?? []), label.id] });
  }
}

// Waits registered with paperclip-wait, in ~/.paperclip-dev/watchdog/waits.json.
const WAITS_FILE = join(DIR, "waits.json");
const WAIT_MAX_AGE = DAY;
const readWaits = () => readJson(WAITS_FILE, { waits: [] }).waits ?? [];
function removeWaits(ids) {
  if (!ids.size || DRY) return;
  // Re-read right before writing so a wait added meanwhile isn't lost.
  writeJsonAtomic(WAITS_FILE, { waits: readWaits().filter((w) => !ids.has(w.id)) });
}

async function deliverCi(d, run, why) {
  const key = `${d.id}|${run.databaseId}`;
  if (state.ciDelivered[key]) return true;
  const sha7 = run.headSha.slice(0, 7);
  const verdict = run.conclusion === "success" ? "passed" : run.conclusion || "finished";
  const body = {
    comment: `Watchdog: CI ${verdict} for \`${run.headBranch}\` at ${sha7} (${run.workflowName ?? "CI"}, ${run.event}): ${run.url}${why ? `\n\n${why}` : ""}`,
    ...(d.status === "blocked" && !(d.blockedBy ?? []).some((b) => !CLOSED.has(b.status)) && !d.executionBlocker ? { status: "todo" } : {}),
  };
  await mutate(`told ${d.identifier} that CI ${verdict} on ${run.headBranch} (${sha7})`, "PATCH", `/issues/${d.id}`, body);
  if (!DRY) state.ciDelivered[key] = now;
  return true;
}

async function checkWaits({ gate, detailed, liveIssueIds, byIdent, runsByRepo }) {
  const done = new Set();
  for (const w of readWaits()) {
    const issue = byIdent.get(w.issue);
    const d = issue && detailed.get(issue.id);
    if (!d) { log("info", `dropped wait ${w.id}: ${w.issue} is closed or missing`); done.add(w.id); continue; }
    if (now - Date.parse(w.createdAt) > WAIT_MAX_AGE) {
      notes.push(`Dropped a 24 h old CI wait for ${w.issue} on ${w.ref}`); done.add(w.id); continue;
    }
    const isSha = /^[0-9a-f]{7,40}$/i.test(w.ref);
    // CI can finish just before the agent registers the wait; allow 10 minutes of slack.
    const match = (runsByRepo.get(w.repo) ?? [])
      .filter((r) => r.status === "completed" && (isSha ? r.headSha.startsWith(w.ref.toLowerCase()) : r.headBranch === w.ref)
        && Date.parse(r.updatedAt) >= Date.parse(w.createdAt) - 10 * MIN)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    if (!match) continue;
    if (!gate.open || liveIssueIds.has(d.id)) continue; // try again next tick
    await deliverCi(d, match, `(${w.issue} registered this wait with paperclip-wait${w.note ? `: ${w.note}` : ""}.)`);
    if (!DRY) done.add(w.id);
  }
  removeWaits(done);
}

// A result nobody can act on wakes an agent for nothing: the commit is no longer the head of
// its branch (a newer push replaced it), the branch is gone, or its pull request is merged or
// closed. Returns why it's stale, or null. On a GitHub error, deliver rather than drop it.
function staleReason(repo, run) {
  if (!run.headBranch || run.headBranch === "main") return null;
  try {
    if (run.event === "pull_request") {
      const prs = JSON.parse(gh(["api", `repos/${repo}/commits/${run.headSha}/pulls`]));
      const open = prs.filter((p) => p.state === "open");
      if (!open.length) return prs.length ? `its pull request #${prs[0].number} is ${prs[0].merged_at ? "merged" : "closed"}` : "no open pull request has this commit";
      if (!open.some((p) => p.head?.sha === run.headSha)) return `a newer commit replaced it in pull request #${open[0].number}`;
      return null;
    }
    const tip = gh(["api", `repos/${repo}/branches/${encodeURIComponent(run.headBranch)}`, "--jq", ".commit.sha"]).trim();
    return tip === run.headSha ? null : "a newer commit replaced it on the branch";
  } catch (e) {
    if (/HTTP 404|Branch not found/i.test(String(e.message) + String(e.stderr ?? ""))) return "the branch is gone";
    return null;
  }
}

async function checkCi({ gate, detailed, liveIssueIds, issues }) {
  const byIdent = new Map(issues.map((i) => [i.identifier, i]));
  const runsByRepo = new Map();
  for (const repo of REPOS) {
    try {
      runsByRepo.set(repo, JSON.parse(gh(["run", "list", "-R", repo, "-L", "30", "--json",
        "databaseId,displayTitle,headBranch,headSha,conclusion,status,updatedAt,url,event,workflowName"])));
    } catch (e) { notes.push(`Couldn't read CI for ${repo}: ${String(e.message).slice(0, 120)}`); }
  }
  await checkWaits({ gate, detailed, liveIssueIds, byIdent, runsByRepo });
  for (const [repo, runs] of runsByRepo) {
    for (const run of runs) {
      const key = `${repo}#${run.databaseId}`;
      if (run.status !== "completed" || state.ciSeen[key]) continue;
      if (now - Date.parse(run.updatedAt) > LIMITS.ciLookback && !state.ciPending[key]) { state.ciSeen[key] = now; continue; }
      if (state.ciPending[key] && now - state.ciPending[key] > LIMITS.ciPendingMax) {
        log("warn", `gave up delivering CI result ${key}`); state.ciSeen[key] = now; delete state.ciPending[key]; continue;
      }
      const stale = staleReason(repo, run);
      if (stale) { log("debug", `CI ${key} ${run.headBranch}@${run.headSha.slice(0, 7)} skipped: ${stale}`); state.ciSeen[key] = now; delete state.ciPending[key]; continue; }
      let message = run.displayTitle ?? "";
      try { message = gh(["api", `repos/${repo}/commits/${run.headSha}`, "--jq", ".commit.message"]); } catch { /* keep title */ }
      const idents = new Set([...`${message} ${run.headBranch}`.matchAll(/\bNEV-\d+\b/g)].map((m) => m[0]));
      const targets = new Set();
      for (const ident of idents) {
        const i = byIdent.get(ident);
        if (i && detailed.has(i.id)) targets.add(i.id);
      }
      // Fallback: an open task whose recent comments name this commit or branch.
      const sha7 = run.headSha.slice(0, 7);
      for (const d of detailed.values()) {
        if (targets.has(d.id) || !["blocked", "in_progress", "todo"].includes(d.status)) continue;
        const comments = list(await api("GET", `/issues/${d.id}/comments?limit=20`), "comments")
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 3);
        const text = comments.map((c) => c.body ?? "").join("\n");
        if (text.includes(sha7) || (run.headBranch !== "main" && text.includes(run.headBranch))) targets.add(d.id);
      }
      log("debug", `CI ${key} ${run.conclusion} ${run.headBranch}@${sha7} names [${[...idents].join(",")}] -> open targets [${[...targets].map((id) => detailed.get(id).identifier).join(",")}]`);
      if (!targets.size) { state.ciSeen[key] = now; continue; }
      if (!gate.open) { state.ciPending[key] ??= now; continue; }
      let delivered = true;
      for (const id of targets) {
        if (liveIssueIds.has(id)) { delivered = false; continue; } // a live run would swallow the wake; retry next tick
        await deliverCi(detailed.get(id), run);
      }
      if (delivered) { state.ciSeen[key] = now; delete state.ciPending[key]; } else state.ciPending[key] ??= now;
    }
  }
  // Keep the memory small.
  for (const m of [state.ciSeen, state.ciDelivered]) for (const k of Object.keys(m)) if (now - m[k] > 3 * DAY) delete m[k];
}

function finish(extra) {
  state.recentActions.push(...actions);
  state.recentActions = state.recentActions.slice(-50);
  state.restarts = within(state.restarts, 7 * DAY);
  state.copies = within(state.copies, 7 * DAY);
  state.nudges = within(state.nudges, 7 * DAY);
  for (const m of [state.nudged, state.woke]) for (const k of Object.keys(m)) if (now - m[k] > 7 * DAY) delete m[k];
  if (!DRY) writeJsonAtomic(FILES.state, state);
  writeStatus(extra);
}

main().catch((e) => {
  log("error", e.stack ?? String(e));
  notes.push(`Tick failed: ${String(e.message).slice(0, 200)}`);
  try { finish({ healthy: null, summary: "Watchdog error (see watchdog.log)" }); } catch { /* ignore */ }
  process.exitCode = 1;
});
