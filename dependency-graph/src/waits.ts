// Worker side only (reads files): what blocked tasks are waiting on outside Paperclip.
//  - Background jobs: running processes whose command ends with `paperclip-notify NEV-123 ...`,
//    the pattern agents use for long jobs (`setsid nohup ... bash -c '<cmd>; paperclip-notify ...'`
//    or a `job-NEV-123-<name>` systemd user unit). Found by scanning /proc, so nothing has to be
//    registered and a job that dies simply disappears.
//  - CI waits that agents registered with `paperclip-wait` (the watchdog's waits.json).
import { readdir, readFile, readlink, stat, open } from "node:fs/promises";
import { join } from "node:path";

export type JobProcess = {
  issue: string;
  pid: number;
  /** The job's own command, without the paperclip-notify part. */
  command: string;
  startedAt: string | null;
  /** The file the job writes its output to, when it's a regular file. */
  log: string | null;
  logUpdatedAt: string | null;
  lastLine: string | null;
};

export type RegisteredWait = { id: string; issue: string; kind: string; repo?: string; ref?: string; createdAt: string; note?: string };

const NOTIFY = /paperclip-notify["']?\s+["']?([A-Z][A-Z0-9]*-\d+)\b/;

/** The command a job runs, from its argv: the `-c` script up to the paperclip-notify call. */
export function jobCommand(argv: string[]): string {
  const c = argv.indexOf("-c");
  const script = c >= 0 && argv[c + 1] ? argv[c + 1]! : argv.join(" ");
  const cut = script.search(/[;&|\n]\s*(?:\S*\/)?paperclip-notify\b/);
  return (cut >= 0 ? script.slice(0, cut) : script).replace(/[\s;&|]+$/, "").trim().replace(/\s+/g, " ");
}

/** pid, parent pid and start time (clock ticks after boot) from /proc/<pid>/stat. The name can hold spaces and parens. */
export function parseStat(text: string): { ppid: number; startTicks: number } | null {
  const end = text.lastIndexOf(")");
  if (end < 0) return null;
  const f = text.slice(end + 2).split(" ");
  // After the name: state(0) ppid(1) ... starttime is field 22 overall, so index 19 here.
  const ppid = Number(f[1]);
  const startTicks = Number(f[19]);
  return Number.isFinite(ppid) && Number.isFinite(startTicks) ? { ppid, startTicks } : null;
}

async function lastLine(path: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    const len = Math.min(size, 4096);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    // Progress bars rewrite the line with \r: keep what's after the last one.
    const lines = buf.toString("utf8").split(/\r?\n/).map((l) => l.split("\r").pop()!.trim()).filter(Boolean);
    const line = lines.pop() ?? null;
    return line && line.length > 200 ? `${line.slice(0, 199)}…` : line;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export async function scanJobs(proc = "/proc"): Promise<JobProcess[]> {
  let bootMs: number | null = null;
  try {
    const m = (await readFile(join(proc, "stat"), "utf8")).match(/^btime (\d+)$/m);
    if (m) bootMs = Number(m[1]) * 1000;
  } catch { /* no start times then */ }
  const TICKS = 100; // CLK_TCK on Linux x86_64

  const found = new Map<number, JobProcess & { ppid: number }>();
  let entries: string[] = [];
  try { entries = await readdir(proc); } catch { return []; }
  await Promise.all(entries.filter((e) => /^\d+$/.test(e)).map(async (e) => {
    const pid = Number(e);
    try {
      const argv = (await readFile(join(proc, e, "cmdline"), "utf8")).split("\0").filter(Boolean);
      const m = argv.join(" ").match(NOTIFY);
      if (!m) return;
      const st = parseStat(await readFile(join(proc, e, "stat"), "utf8"));
      let log: string | null = null, logUpdatedAt: string | null = null;
      try {
        const target = await readlink(join(proc, e, "fd", "1"));
        if (target.startsWith("/") && !target.startsWith("/dev/")) {
          const s = await stat(target);
          if (s.isFile()) { log = target; logUpdatedAt = s.mtime.toISOString(); }
        }
      } catch { /* not ours to read, or gone */ }
      found.set(pid, {
        issue: m[1]!, pid, ppid: st?.ppid ?? 0, command: jobCommand(argv),
        startedAt: st && bootMs != null ? new Date(bootMs + (st.startTicks / TICKS) * 1000).toISOString() : null,
        log, logUpdatedAt, lastLine: log ? await lastLine(log) : null,
      });
    } catch { /* the process ended while we looked */ }
  }));
  // A wrapper (sh -c "setsid nohup bash -c '...'") matches too while it lives: keep the innermost process,
  // which is the job itself and holds its log.
  const parents = new Set([...found.values()].filter((j) => found.get(j.ppid)?.issue === j.issue).map((j) => j.ppid));
  return [...found.values()]
    .filter((j) => !parents.has(j.pid))
    .map(({ ppid: _ppid, ...j }) => j)
    .sort((a, b) => a.issue.localeCompare(b.issue) || a.pid - b.pid);
}

export async function readRegisteredWaits(file: string): Promise<RegisteredWait[]> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { waits?: unknown };
    if (!Array.isArray(value?.waits)) return [];
    return value.waits.filter((w): w is RegisteredWait =>
      !!w && typeof w === "object" && typeof (w as RegisteredWait).id === "string"
      && typeof (w as RegisteredWait).issue === "string" && typeof (w as RegisteredWait).createdAt === "string");
  } catch {
    return [];
  }
}
