#!/usr/bin/env node
// Token Lens collector. Paperclip doesn't let plugins read run events (tool calls) or
// call localhost, so this script runs outside the plugin, on a timer:
//   1. per finished run: tool calls by category, what each cost in input tokens, the
//      run's starting context (from heartbeat_run_events, read straight from Postgres);
//   2. per merged PR commit: code and doc lines changed (a bare mirror of the repo),
//      and the run that made it (matched through the run's `git commit` commands);
// then posts the summaries to the plugin's /ingest route, which stores them.
//
//   node collector/collect.mjs [--dry-run] [--full]
//
// Env: TOKEN_LENS_DB (Postgres URL), TOKEN_LENS_API (Paperclip URL), TOKEN_LENS_REPOS
// (comma-separated owner/name), GH_CONFIG_DIR (gh login used for the repos: the
// agents' limited token, never the founder's).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { attributeRun, commitHashesIn, commitSubjects, matchCommits, summarizeNumstat } from "./lib.mjs";

const DB_URL = process.env.TOKEN_LENS_DB ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const API = process.env.TOKEN_LENS_API ?? "http://localhost:3100";
const REPOS = (process.env.TOKEN_LENS_REPOS ?? "Nevysha/space-4x").split(",").map((s) => s.trim()).filter(Boolean);
const PLUGIN = "nevysha.fleet-cost";
const STATE_DIR = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "token-lens");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const MIRROR_DIR = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "token-lens");
const DRY = process.argv.includes("--dry-run");
const FULL = process.argv.includes("--full");
const RUN_BATCH = 40; // runs per events query and per post
const COMMIT_BATCH = 200;

const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadState() {
  if (FULL) return { runs: {}, prs: {} };
  try { return { runs: {}, prs: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch { return { runs: {}, prs: {} }; }
}
function saveState(state) {
  if (DRY) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state));
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

async function paperclipUp() {
  try { return (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}

async function post(companyId, body) {
  if (DRY) return;
  const res = await fetch(`${API}/api/plugins/${PLUGIN}/api/ingest?companyId=${companyId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ingest failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

// ---- runs and tools ----------------------------------------------------------

async function collectRuns(sql, companyId, state) {
  const since = state.runs[companyId] ? new Date(state.runs[companyId]) : new Date(0);
  // A small overlap catches runs whose events landed after a previous pass read them.
  const from = new Date(since.getTime() - 10 * 60_000);
  const runs = await sql`
    SELECT id, finished_at,
           coalesce((usage_json->>'inputTokens')::numeric, 0) + coalesce((usage_json->>'cachedInputTokens')::numeric, 0) AS recorded
    FROM heartbeat_runs
    WHERE company_id = ${companyId} AND finished_at IS NOT NULL AND finished_at > ${from} AND usage_json IS NOT NULL
    ORDER BY finished_at`;
  let newest = since;
  let done = 0;
  for (let i = 0; i < runs.length; i += RUN_BATCH) {
    const batch = runs.slice(i, i + RUN_BATCH);
    const ids = batch.map((r) => r.id);
    const events = await sql`
      SELECT run_id, event_type,
             payload->'prpEvent'->'payload'->>'name' AS name,
             payload->'prpEvent'->'payload'->>'subject' AS subject,
             payload->'prpEvent'->'payload'->>'outputBytes' AS output_bytes,
             payload->'prpEvent'->'payload'->>'durationMs' AS duration_ms,
             payload->'prpEvent'->'payload'->'usage'->'context'->>'usedTokens' AS context
      FROM heartbeat_run_events
      WHERE company_id = ${companyId} AND run_id = ANY(${ids}::uuid[])
        AND (event_type = 'tool.execution.completed'
             OR (event_type = 'item.completed' AND payload->'prpEvent'->'payload'->>'kind' = 'usage'))
      ORDER BY run_id, id`;
    const byRun = new Map(ids.map((id) => [id, []]));
    for (const e of events) {
      byRun.get(e.run_id)?.push(e.event_type === "tool.execution.completed"
        ? { kind: "tool", name: e.name, subject: e.subject, outputBytes: e.output_bytes, durationMs: e.duration_ms }
        : { kind: "usage", context: e.context });
    }
    const out = [];
    for (const r of batch) {
      const a = attributeRun(byRun.get(r.id) ?? [], Number(r.recorded));
      if (!a.requests && !a.toolCalls) continue; // older runs without per-step events
      out.push({ runId: r.id, toolCalls: a.toolCalls, requests: a.requests, firstContext: a.firstContext,
        maxContext: a.maxContext, startTokens: a.startTokens, tools: a.tools });
      if (r.finished_at > newest) newest = r.finished_at;
    }
    await post(companyId, { runs: out });
    done += out.length;
    if (DRY && i === 0 && out[0]) log("example run", JSON.stringify(out[0]).slice(0, 600));
  }
  state.runs[companyId] = newest.toISOString();
  return done;
}

// ---- commits and lines ------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
}
const ghEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
const credential = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

function syncMirror(repo) {
  const dir = path.join(MIRROR_DIR, `${repo.replace("/", "__")}.git`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(MIRROR_DIR, { recursive: true });
    git([...credential, "clone", "--bare", "--quiet", `https://github.com/${repo}.git`, dir], { env: ghEnv });
  }
  // PR heads keep each PR's own commits after a squash merge.
  git([...credential, "-C", dir, "fetch", "--quiet", "--prune", "origin", "+refs/pull/*/head:refs/pull/*/head"], { env: ghEnv });
  return dir;
}

function numstats(dir, shas) {
  const out = new Map();
  for (let i = 0; i < shas.length; i += 100) {
    const chunk = shas.slice(i, i + 100);
    const text = git(["-C", dir, "show", "--numstat", "--format=@@%H %at", "--no-renames", ...chunk]);
    let cur = null;
    for (const line of text.split("\n")) {
      const head = /^@@([0-9a-f]{40}) (\d+)$/.exec(line);
      if (head) { cur = { sha: head[1], authoredAt: Number(head[2]) * 1000, lines: [] }; out.set(cur.sha, cur); continue; }
      if (cur && line) cur.lines.push(line);
    }
  }
  return out;
}

async function commitEvidence(sql, companyId) {
  const rows = await sql`
    SELECT e.run_id, r.started_at,
           e.payload->'prpEvent'->'payload'->>'subject' AS subject,
           e.payload->'prpEvent'->'payload'->>'output' AS output
    FROM heartbeat_run_events e JOIN heartbeat_runs r ON r.id = e.run_id
    WHERE e.company_id = ${companyId} AND e.event_type = 'tool.execution.completed'
      AND e.payload->'prpEvent'->'payload'->>'name' = 'Bash'
      AND e.payload->'prpEvent'->'payload'->>'subject' ~ 'git[^|;&]*commit'`;
  const byRun = new Map();
  for (const r of rows) {
    const ev = byRun.get(r.run_id) ?? { runId: r.run_id, startedAt: new Date(r.started_at ?? 0).getTime(), hashes: [], subjects: [] };
    ev.hashes.push(...commitHashesIn(r.subject, r.output));
    ev.subjects.push(...commitSubjects(r.subject));
    byRun.set(r.run_id, ev);
  }
  return [...byRun.values()];
}

async function collectCommits(sql, companyId, state) {
  let total = 0;
  let evidence = null;
  for (const repo of REPOS) {
    const prs = JSON.parse(execFileSync("gh", ["pr", "list", "-R", repo, "--state", "merged", "--limit", "1000",
      "--json", "number,title,mergedAt"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    const todo = [];
    const prsDone = [];
    for (const pr of prs) {
      const prKey = `${repo}#${pr.number}`;
      if (state.prs[prKey]) continue;
      // One call per new PR: the list query can't include commits at this size.
      const commits = [];
      for (let page = 1; page <= 3; page++) { // GitHub lists at most 250 commits per PR
        const got = JSON.parse(execFileSync("gh", ["api", `repos/${repo}/pulls/${pr.number}/commits?per_page=100&page=${page}`],
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
        commits.push(...got);
        if (got.length < 100) break;
      }
      for (const c of commits) todo.push({ repo, sha: c.sha, subject: String(c.commit?.message ?? "").split("\n")[0], pr });
      prsDone.push(prKey);
    }
    if (!todo.length) { for (const k of prsDone) state.prs[k] = 1; continue; }
    const dir = syncMirror(repo);
    const stats = numstats(dir, todo.map((t) => t.sha));
    evidence ??= await commitEvidence(sql, companyId);
    const matches = new Map(matchCommits(
      todo.map((t) => ({ sha: t.sha, subject: t.subject, authoredAt: stats.get(t.sha)?.authoredAt ?? 0 })), evidence,
    ).map((m) => [m.sha, m]));
    const rows = todo.map((t) => {
      const s = stats.get(t.sha);
      const lines = summarizeNumstat(s?.lines ?? []);
      const m = matches.get(t.sha);
      return { sha: t.sha, repo, prNumber: t.pr.number, prTitle: t.pr.title, prMergedAt: t.pr.mergedAt,
        authoredAt: s ? new Date(s.authoredAt).toISOString() : null, subject: t.subject,
        runId: m?.runId ?? null, matchMethod: m?.method ?? "none", ...lines };
    });
    for (let i = 0; i < rows.length; i += COMMIT_BATCH) await post(companyId, { commits: rows.slice(i, i + COMMIT_BATCH) });
    const byMethod = rows.reduce((acc, r) => ({ ...acc, [r.matchMethod]: (acc[r.matchMethod] ?? 0) + 1 }), {});
    log(`${repo}: ${rows.length} new commits from ${new Set(rows.map((r) => r.prNumber)).size} PRs, matched to runs by`, JSON.stringify(byMethod));
    if (DRY) for (const r of rows.slice(0, 3)) log("example commit", JSON.stringify(r));
    if (DRY && process.env.TOKEN_LENS_DEBUG) for (const r of rows.filter((x) => x.matchMethod === "none")) log("unmatched", r.prNumber, r.authoredAt, r.sha.slice(0, 9), r.subject.slice(0, 70));
    for (const k of prsDone) state.prs[k] = 1;
    total += rows.length;
  }
  return total;
}

async function main() {
  if (!(await paperclipUp())) { log("Paperclip isn't answering; nothing to do."); return; }
  const sql = postgres(DB_URL, { max: 1, idle_timeout: 5 });
  try {
    const companies = await sql`SELECT id FROM companies`;
    const state = loadState();
    for (const { id } of companies) {
      const runs = await collectRuns(sql, id, state);
      const commits = await collectCommits(sql, id, state);
      log(`company ${id.slice(0, 8)}: ${runs} runs, ${commits} commits${DRY ? " (dry run, nothing sent)" : ""}`);
    }
    saveState(state);
  } finally {
    await sql.end();
  }
}

main().catch((err) => { console.error(new Date().toISOString(), err.stack ?? String(err)); process.exit(1); });
