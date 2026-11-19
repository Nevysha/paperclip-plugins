#!/usr/bin/env node
// Paperclip watchdog: does the routine unblocking a person would otherwise do.
// Runs every few minutes from a systemd user timer (paperclip-watchdog.timer).
//
// Each tick, unless paused (~/.paperclip-dev/watchdog/paused exists):
//   1. Quarantine: if new runs fail with native_session_cleanup_quarantined since
//      Paperclip started (a company-wide freeze), restart Paperclip once nothing is live.
//   2. Held tasks: a task whose failed run Paperclip won't replay (executionBlocker set)
//      is reported in the header for a person. It is not copied: the copy would go to the
//      same agent, and when the agent itself can't start, every copy fails the same way.
//   3. Nudges: a `blocked` task whose blockers are all done, or whose last run
//      failed, goes back to `todo` with a comment, which wakes its owner.
//   4. Mirrors: notes when a Forgejo repo's GitHub mirror of main falls behind (report only).
//   5. Sliced label; 6. Wake loops: an agent restarting on the same issue again and again
//      with nothing to do (see wake-loops.mjs) is reported in the header, never acted on.
// It doesn't relay CI results: an agent waiting on CI sets a Paperclip monitor on its task
// (executionPolicy.monitor), and Paperclip wakes it to check.
// Step 3 starts agent runs, so it's skipped while Claude usage is at or over the gate in
// ~/.paperclip-dev/claude-usage.json (written by the claude-usage plugin, if installed; without it
// nothing is gated, and the header says so). Never sends cards, never closes tasks as done, never
// starts Paperclip when it's down, never wakes a task just because it's idle.
//
// Files (in ~/.paperclip-dev/watchdog/): config.json (your company, repos and tokens; see
// config.example.json), status.json (read by the header plugin), state.json (memory between
// ticks), watchdog.log, paused (pause flag).
// Flags: --dry-run (log what it would do, change nothing), --once (same as default).

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { findWakeLoops } from "./wake-loops.mjs";
import { blockersWakeAlreadyDelivered } from "./dedupe.mjs";

const HOME = homedir();
const API = `http://localhost:${process.env.PAPERCLIP_PORT || 3100}/api`;
const DIR = process.env.PAPERCLIP_WATCHDOG_DIR?.trim() || join(HOME, ".paperclip-dev/watchdog");
const home = (p) => (typeof p === "string" && p.trim() ? p.trim().replace(/^~(?=\/|$)/, HOME) : null);
const CONFIG = (() => { try { return JSON.parse(readFileSync(join(DIR, "config.json"), "utf8")); } catch { return {}; } })();
const COMPANY = CONFIG.companyId;
// Repos to check for mirror drift: { name, forgejo: "owner/repo", githubMirror: "owner/repo" }.
const REPO_LIST = Array.isArray(CONFIG.repos) ? CONFIG.repos.filter((r) => typeof r?.name === "string") : [];
// The gh login used to read the GitHub mirrors. Unset: gh's own default.
const GH_CONFIG_DIR = home(CONFIG.ghConfigDir);
const FORGE = {
  url: process.env.FORGE_URL?.trim() || CONFIG.forgejo?.url || "http://localhost:3000",
  tokenFile: home(CONFIG.forgejo?.tokenFile), // a read-only token
  repos: Object.fromEntries(REPO_LIST.filter((r) => r.forgejo).map((r) => [r.name, r.forgejo])),
  mirrors: Object.fromEntries(REPO_LIST.filter((r) => r.forgejo && r.githubMirror).map((r) => [r.name, r.githubMirror])),
};
const FILES = {
  status: join(DIR, "status.json"),
  state: join(DIR, "state.json"),
  log: join(DIR, "watchdog.log"),
  paused: join(DIR, "paused"),
  usage: join(HOME, ".paperclip-dev/claude-usage.json"),
};
// How to restart Paperclip (an argv list), e.g. ["bash", "-lc", "my-stop && my-start"]. Unset: never restarts.
const RESTART = Array.isArray(CONFIG.restartCommand) && CONFIG.restartCommand.length ? CONFIG.restartCommand : null;
const DRY = process.argv.includes("--dry-run");
const LIVE = new Set(["queued", "scheduled_retry", "running"]);
const CLOSED = new Set(["done", "cancelled"]);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const LIMITS = {
  restartGap: 20 * MIN, restartsPerDay: 6,
  nudgeGapPerTask: 6 * HOUR, nudgesPerDay: 20,
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
  { nudged: {}, loopsLogged: {}, restarts: [], nudges: [], recentActions: [] },
  readJson(FILES.state, {}),
);
// Memory of steps that were removed: idle-todo wakes, and the CI relay.
for (const k of ["woke", "ciSeen", "ciPending", "ciDelivered"]) delete state[k];
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
  if (!u) return { open: true, unknown: true, why: "no usage data (the claude-usage plugin writes it)" };
  const limit = u.gate?.pauseAtPercent ?? 80;
  const weekLimit = u.gate?.weekPauseAtPercent ?? limit;
  const stale = !u.fetchedAt || now - Date.parse(u.fetchedAt) > 30 * MIN;
  if (stale) return { open: true, unknown: true, why: "usage data is over 30 min old" };
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
    env: GH_CONFIG_DIR ? { ...process.env, GH_CONFIG_DIR } : process.env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

// GET on Forgejo's API. The token goes to curl on stdin, never on its command line.
function forge(path) {
  if (!FORGE.tokenFile) throw new Error("forgejo.tokenFile isn't set in config.json");
  const token = readFileSync(FORGE.tokenFile, "utf8").trim();
  try {
    return JSON.parse(execFileSync("curl", ["-fsS", "-H", "@-", `${FORGE.url}/api/v1${path}`], {
      input: `Authorization: token ${token}\n`, encoding: "utf8", timeout: 30_000,
    }));
  } catch (e) {
    throw new Error(`Forgejo GET ${path}: ${String(e.stderr || e.message).trim().split("\n")[0]}`);
  }
}

// Forgejo pushes main to GitHub on every merge. If they differ for a while, say so: the
// mirror's token may have expired, or someone pushed to GitHub. Not a reason to wake anyone.
function checkMirrors() {
  for (const [repo, ghRepo] of Object.entries(FORGE.mirrors)) {
    try {
      const fsha = forge(`/repos/${FORGE.repos[repo]}/branches/main`).commit?.id;
      const gsha = gh(["api", `repos/${ghRepo}/branches/main`, "--jq", ".commit.sha"]).trim();
      state.mirrorDiff ??= {};
      if (fsha && fsha === gsha) { delete state.mirrorDiff[repo]; continue; }
      state.mirrorDiff[repo] ??= now;
      if (now - state.mirrorDiff[repo] > 15 * MIN) {
        notes.push(`GitHub mirror of ${repo} differs from Forgejo's main for ${Math.round((now - state.mirrorDiff[repo]) / MIN)} min (Forgejo ${fsha?.slice(0, 7)}, GitHub ${gsha.slice(0, 7)}): check the push mirror in Forgejo's repo settings`);
      }
    } catch (e) { notes.push(`Couldn't compare ${repo} with its GitHub mirror: ${String(e.message).slice(0, 120)}`); }
  }
}

function restartPaperclip() {
  if (!RESTART) { notes.push("A company-wide quarantine needs a Paperclip restart, and restartCommand isn't set in config.json"); return; }
  if (DRY) { act("(would) restart Paperclip to clear the company-wide quarantine"); return; }
  // The stop command should refuse while runs are live, so this can't cut off work.
  // Under the systemd timer, anything this run starts is in the service's cgroup, and systemd
  // kills that cgroup when the oneshot finishes, so a restarted Paperclip would die minutes
  // later. A transient scope gives Paperclip its own cgroup.
  const restart = RESTART;
  const [cmd, ...args] = process.env.INVOCATION_ID
    ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=paperclip-${Date.now()}`, ...restart]
    : restart;
  const out = execFileSync(cmd, args, { encoding: "utf8", timeout: 400_000 });
  state.restarts.push(now);
  act("restarted Paperclip to clear the company-wide quarantine", { output: out.trim().split("\n").slice(-2).join(" | ") });
}

async function main() {
  if (existsSync(FILES.paused)) {
    log("debug", "paused; skipping tick");
    writeStatus({ healthy: null, summary: "Paused" });
    return;
  }

  if (!COMPANY) {
    log("warn", `no companyId in ${join(DIR, "config.json")}; doing nothing`);
    notes.push("Set companyId in the watchdog's config.json (see host/config.example.json)");
    writeStatus({ healthy: false, summary: "Not configured" });
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
  else if (gate.unknown) notes.push(`Usage limits not applied: ${gate.why}`);

  // After Claude's session limit resets, runs that failed on the limit can start again. Forget the
  // per-task cooldowns once, so stalled tasks get nudged on the first tick after a reset
  // instead of hours later. The daily caps still apply.
  const usage = readJson(FILES.usage, null);
  const resetsAt = usage?.sessionResetsAt ? Date.parse(usage.sessionResetsAt) : NaN;
  const prevResetsAt = state.sessionResetsAt ? Date.parse(state.sessionResetsAt) : NaN;
  // Right after a reset there's no session window yet, so the usage file has no reset time at all.
  if (!Number.isFinite(resetsAt) && usage?.status === "ok" && !usage.stale && gate.open
    && Number.isFinite(prevResetsAt) && prevResetsAt <= now) {
    state.nudged = {}; state.sessionResetsAt = null;
    act(`Claude session limit reset (was due ${new Date(prevResetsAt).toISOString()}); cleared per-task cooldowns`);
  }
  if (Number.isFinite(resetsAt)) {
    const prev = prevResetsAt;
    if (gate.open && Number.isFinite(prev) && prev <= now && resetsAt > prev) {
      state.nudged = {};
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

  // 2. Held tasks: reported, never copied. A copy goes to the same agent, so when the agent itself
  // can't start (a broken setup, oversized instructions...) every copy fails the same way.
  for (const d of detailed.values()) {
    if (!d.executionBlocker || liveIssueIds.has(d.id)) continue;
    notes.push(`${d.identifier} is held by a Paperclip platform error (${d.executionBlocker.cause ?? "held run"}); needs a person`);
  }

  if (gate.open) {
    // 3. Nudge blocked tasks that nothing will wake
    for (const d of detailed.values()) {
      if (d.status !== "blocked" || d.executionBlocker || liveIssueIds.has(d.id) || !d.assigneeAgentId) continue;
      if (state.nudged[d.id] && now - state.nudged[d.id] < LIMITS.nudgeGapPerTask) continue;
      if (within(state.nudges, DAY).length >= LIMITS.nudgesPerDay) { notes.push("Daily nudge limit reached"); break; }
      const deps = d.blockedBy ?? [];
      let why = null;
      if (deps.length && !openDeps(d).length) {
        // Paperclip already woke the agent for this and it chose to stay blocked: don't repeat it.
        if (blockersWakeAlreadyDelivered(runs, d.id)) continue;
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
  }

  // 4. GitHub mirrors of Forgejo repos: report only.
  checkMirrors();

  // 5. Tasks marked "Sized: one run" get the Sliced label (agents' create_task can't set labels).
  // Only the label changes, so this runs even while the usage gate is closed.
  await labelSliced(issues);

  // 6. Wake loops: report only. Pausing the agent is a person's call (it cancels its run).
  const identById = new Map(issues.map((i) => [i.id, i.identifier]));
  const loops = findWakeLoops(runs, now).map((l) => ({
    ...l, agent: agentById.get(l.agentId)?.name ?? l.agentId, issue: identById.get(l.issueId) ?? l.issueId,
  }));
  for (const l of loops) {
    const msg = `Wake loop: ${l.agent} restarted ${l.runs} times on ${l.issue} in 10 min with short runs (${l.reasons.join(", ") || "no wake reason"}). Pause the agent if it has nothing to do.`;
    notes.push(msg);
    const key = `${l.agentId}:${l.issueId}`;
    if (!state.loopsLogged[key] || now - state.loopsLogged[key] > 30 * MIN) { log("warn", msg); state.loopsLogged[key] = now; }
  }
  if (loops.length) {
    return finish({ healthy: false, summary: `Wake loop: ${loops.map((l) => `${l.agent} on ${l.issue}`).join(", ")}`, wakeLoops: loops });
  }

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

function finish(extra) {
  state.recentActions.push(...actions);
  state.recentActions = state.recentActions.slice(-50);
  state.restarts = within(state.restarts, 7 * DAY);
  state.nudges = within(state.nudges, 7 * DAY);
  for (const m of [state.nudged, state.loopsLogged]) for (const k of Object.keys(m)) if (now - m[k] > 7 * DAY) delete m[k];
  if (!DRY) writeJsonAtomic(FILES.state, state);
  writeStatus(extra);
}

main().catch((e) => {
  log("error", e.stack ?? String(e));
  notes.push(`Tick failed: ${String(e.message).slice(0, 200)}`);
  try { finish({ healthy: null, summary: "Watchdog error (see watchdog.log)" }); } catch { /* ignore */ }
  process.exitCode = 1;
});
