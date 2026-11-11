// Pure logic of the Token Lens collector: no database, git or network here, so it's
// unit-tested in tests/collector.spec.mjs. collect.mjs does the I/O.

/** Paperclip's own tools (coordination), as opposed to the provider's built-in ones. */
const BUILTIN_TOOLS = new Set([
  "Bash", "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch",
  "ToolSearch", "Monitor", "Agent", "Task", "TodoWrite", "KillShell", "BashOutput", "Skill",
  "EnterPlanMode", "ExitPlanMode", "AskUserQuestion",
]);

// Ordered: the first match wins. Tested on the command after leading `cd …`/env prefixes.
const BASH_RULES = [
  ["Bash: local CI", /\b(npm run|pnpm|yarn) ci(:local)?\b|\bci:local\b/],
  ["Bash: tests", /\b(vitest|jest|playwright|node --test)\b|\b(npm|pnpm|yarn)( run)? (test|e2e)\b|\bnpx (vitest|playwright)\b/],
  ["Bash: typecheck, lint, format", /\b(tsc|eslint|prettier|typecheck|lint)\b/],
  ["Bash: build, run", /\b(npm|pnpm|yarn)( run)? (build|dev|start|headless|scenario)\b|\bnode (dist|packages|scripts)\//],
  ["Bash: git", /^git\b/],
  ["Bash: GitHub (gh)", /^gh\b/],
  ["Bash: Paperclip API", /\bcurl\b.*(\/api\/|localhost:3100)|paperclip/i],
  ["Bash: edit files", /\bsed -i\b|\bperl -p?i\b|^cat\s*>|<<\s*['"]?EOF|\btee\b|\bapply_patch\b|\bpython3? - <</],
  ["Bash: read files", /^(sed -n|cat|head|tail|nl|wc|less|awk)\b/],
  ["Bash: search", /^(grep|rg|find|ls|tree|fd|git grep)\b/],
  ["Bash: scripts", /^(python3?|node|npx|tsx|bash|sh)\b/],
  ["Bash: wait, poll", /^(sleep|timeout|until|while)\b/],
  ["Bash: loops", /^for\b/],
  ["Bash: system checks", /^(ps|uptime|free|df|du|systemctl|date|echo|printf|env|which)\b/],
  ["Bash: move files", /^(mkdir|rm|cp|mv|ln|touch|chmod)\b/],
];

/** Strips leading `cd dir &&`, `cd dir;` and `VAR=value` prefixes so the real command decides. */
export function mainCommand(command) {
  let c = String(command ?? "").trim();
  for (let i = 0; i < 5; i++) {
    const next = c
      .replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, "")
      .replace(/^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/, "")
      .trim();
    if (next === c) break;
    c = next;
  }
  return c;
}

/** The bucket a tool call is counted in: "Read", "Bash: read files", "Paperclip: create_task", … */
export function toolCategory(name, subject) {
  const tool = String(name ?? "unknown");
  if (tool === "Bash") {
    const cmd = mainCommand(subject);
    for (const [label, re] of BASH_RULES) if (re.test(cmd)) return label;
    return "Bash: other";
  }
  if (BUILTIN_TOOLS.has(tool)) return tool;
  if (tool.startsWith("mcp__")) return `MCP: ${tool.split("__")[1] ?? tool}`;
  return `Paperclip: ${tool}`;
}

/**
 * Splits one run's input tokens across what caused them.
 *
 * `events` are the run's tool-completed and usage events in order:
 *   { kind: "tool", name, subject, outputBytes, durationMs }
 *   { kind: "usage", context }            // context tokens after an item
 * Usage events are context snapshots: one after the model issues a call, one after
 * the result is added. The model request that follows a tool result re-sends the
 * whole context, so that context is the result's "step cost". The first snapshot is
 * the run's starting context, sent with the first request.
 *
 * `recordedInput` is the run's recorded input + cached input tokens. Step costs are
 * scaled to add up to it exactly (they match within a few percent unscaled).
 */
export function attributeRun(events, recordedInput) {
  let first = 0;
  let maxContext = 0;
  let lastContext = 0;
  let pending = []; // tools completed since the last snapshot
  const steps = []; // { category, cost, resultTokens, outputBytes, durationMs }
  let toolCalls = 0;
  let flushes = 0;
  for (const e of events) {
    if (e.kind === "tool") {
      toolCalls++;
      pending.push(e);
      continue;
    }
    const c = Number(e.context) || 0;
    if (c <= 0) continue;
    if (!first) first = c;
    if (pending.length) {
      // Parallel calls share the request that follows them: split it evenly, and
      // split the context growth in proportion to their output size.
      const growth = Math.max(0, c - lastContext);
      const bytes = pending.reduce((s, t) => s + (Number(t.outputBytes) || 0), 0);
      for (const t of pending) {
        const share = bytes > 0 ? (Number(t.outputBytes) || 0) / bytes : 1 / pending.length;
        steps.push({
          category: toolCategory(t.name, t.subject),
          cost: c / pending.length,
          resultTokens: growth * share,
          outputBytes: Number(t.outputBytes) || 0,
          durationMs: Number(t.durationMs) || 0,
        });
      }
      pending = [];
      flushes++;
    }
    lastContext = c;
    if (c > maxContext) maxContext = c;
  }
  const rawTotal = first + steps.reduce((s, x) => s + x.cost, 0);
  const scale = rawTotal > 0 && recordedInput > 0 ? recordedInput / rawTotal : 1;
  const byCategory = new Map();
  for (const s of steps) {
    const b = byCategory.get(s.category) ?? { category: s.category, calls: 0, stepTokens: 0, resultTokens: 0, outputBytes: 0, durationMs: 0 };
    b.calls++;
    b.stepTokens += s.cost * scale;
    b.resultTokens += s.resultTokens;
    b.outputBytes += s.outputBytes;
    b.durationMs += s.durationMs;
    byCategory.set(s.category, b);
  }
  const tools = [...byCategory.values()].map((b) => ({ ...b, stepTokens: Math.round(b.stepTokens), resultTokens: Math.round(b.resultTokens) }));
  return {
    toolCalls,
    requests: first ? flushes + 1 : 0, // model requests: the first, then one after each batch of results
    firstContext: first,
    maxContext,
    startTokens: Math.round(first * scale),
    scale,
    tools,
  };
}

const DOC_RE = /\.(md|mdx|markdown)$/i;
const LOCK_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/;

/** Sums `git show --numstat` lines into code and doc line counts; lockfiles and binaries are left out. */
export function summarizeNumstat(lines) {
  const out = { codeAdded: 0, codeDeleted: 0, docAdded: 0, docDeleted: 0, codeFiles: 0, docFiles: 0, skippedFiles: 0 };
  for (const line of lines) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const [, a, d, rawPath] = m;
    // Renames look like "dir/{old => new}.ts" or "old => new".
    const path = rawPath.replace(/\{[^}]*=> ([^}]*)\}/, "$1").replace(/^.* => /, "");
    if (a === "-" || LOCK_RE.test(path)) { out.skippedFiles++; continue; }
    if (DOC_RE.test(path)) { out.docAdded += Number(a); out.docDeleted += Number(d); out.docFiles++; }
    else { out.codeAdded += Number(a); out.codeDeleted += Number(d); out.codeFiles++; }
  }
  return out;
}

/** First line of the message in a `git commit -m "…"` command (or the first -m when there are several). */
export function commitSubjects(command) {
  const subjects = [];
  const re = /\bgit\b[^\n]*?\bcommit\b[^"']*?(?:-[a-zA-Z]*m|--message[= ])\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|\$'((?:[^'\\]|\\.)*)')/g;
  for (const m of String(command ?? "").matchAll(re)) {
    const msg = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\n/g, "\n").replace(/\\(.)/g, "$1");
    const first = msg.split("\n")[0].trim();
    if (first) subjects.push(first);
  }
  // Heredoc form: git commit -F - <<'EOF' … EOF, or -m "$(cat <<'EOF' … EOF)"
  for (const m of String(command ?? "").matchAll(/\bcommit\b[^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*\n([^\n]+)/g)) {
    const first = m[2].trim();
    if (first) subjects.push(first);
  }
  return subjects;
}

/**
 * Hashes of commits a `git commit` command made, from its output: git's own
 * "[branch abc1234] subject" line, or the first line of a `git log --oneline -1` /
 * `git rev-parse HEAD` chained after it. Other `git log` listings name older commits
 * and are ignored.
 */
export function commitHashesIn(command, output) {
  const cmd = String(command ?? "");
  const text = String(output ?? "");
  if (!/\bcommit\b/.test(cmd)) return [];
  const found = new Set();
  for (const m of text.matchAll(/^\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\]/gm)) found.add(m[1]);
  if (/git\s+(log\b[^|;&]*(-1\b|-n\s*1\b|--max-count=1)|rev-parse\s+(--short\s+)?HEAD)/.test(cmd)) {
    const m = /^([0-9a-f]{7,40})\b/m.exec(text);
    if (m) found.add(m[1]);
  }
  return [...found];
}

/**
 * Finds the run that made each commit.
 *   commits: [{ sha, subject, authoredAt (ms) }]
 *   runEvidence: [{ runId, startedAt (ms), hashes: string[], subjects: string[] }]
 * A hash printed in a run's git output wins. Otherwise the commit's subject is matched
 * against the messages of `git commit` commands, taking the latest run that started
 * before the commit was authored.
 */
export function matchCommits(commits, runEvidence) {
  const byHash = [];
  const bySubject = new Map();
  for (const r of runEvidence) {
    for (const h of r.hashes) byHash.push([h, r.runId]);
    for (const s of r.subjects) {
      const key = s.toLowerCase();
      const list = bySubject.get(key) ?? [];
      list.push(r);
      bySubject.set(key, list);
    }
  }
  return commits.map((c) => {
    const hit = byHash.find(([h]) => c.sha.startsWith(h));
    if (hit) return { sha: c.sha, runId: hit[1], method: "hash" };
    const candidates = (bySubject.get(String(c.subject).toLowerCase()) ?? [])
      .filter((r) => !c.authoredAt || r.startedAt <= c.authoredAt + 60_000)
      .sort((a, b) => b.startedAt - a.startedAt);
    if (candidates.length) return { sha: c.sha, runId: candidates[0].runId, method: "subject" };
    return { sha: c.sha, runId: null, method: "none" };
  });
}
