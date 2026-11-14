import { mkdtemp, mkdir, writeFile, symlink, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jobCommand, parseStat, readRegisteredWaits, scanJobs } from "../src/waits.js";

const dirs: string[] = [];
const temp = async () => { const d = await mkdtemp(join(tmpdir(), "dg-waits-")); dirs.push(d); return d; };
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

/** A fake /proc entry: argv, parent pid, start ticks, and optionally stdout pointing at a file. */
async function proc(root: string, pid: number, argv: string[], ppid: number, startTicks: number, stdout?: string) {
  const dir = join(root, String(pid));
  await mkdir(join(dir, "fd"), { recursive: true });
  await writeFile(join(dir, "cmdline"), `${argv.join("\0")}\0`);
  const rest = ["S", String(ppid), ...Array.from({ length: 17 }, () => "0"), String(startTicks), "0"];
  await writeFile(join(dir, "stat"), `${pid} (bash (x)) ${rest.join(" ")}`);
  if (stdout) await symlink(stdout, join(dir, "fd", "1"));
}

describe("jobCommand", () => {
  it("keeps the job's command and drops the paperclip-notify call", () => {
    expect(jobCommand(["/usr/bin/bash", "-c", 'node scenarios/s15-war.ts --out x; /home/paperclip/.local/bin/paperclip-notify NEV-568 "done $?"']))
      .toBe("node scenarios/s15-war.ts --out x");
    expect(jobCommand(["bash", "-c", "pnpm ci:local && paperclip-notify NEV-1 ok"])).toBe("pnpm ci:local");
  });
});

describe("parseStat", () => {
  it("reads the parent pid and start time even with spaces and parens in the name", () => {
    const rest = ["S", "42", ...Array.from({ length: 17 }, () => "0"), "12345", "0"];
    expect(parseStat(`7 (a (b) c) ${rest.join(" ")}`)).toEqual({ ppid: 42, startTicks: 12345 });
    expect(parseStat("garbage")).toBeNull();
  });
});

describe("scanJobs", () => {
  it("finds jobs that will notify a task, with their log, and keeps the innermost process", async () => {
    const root = await temp();
    await writeFile(join(root, "stat"), "cpu 1 2 3\nbtime 1794569797\n");
    const log = join(root, "NEV-568-full.log");
    await writeFile(log, "hour 345/360\r\nhour 346/360: tick 1\n");
    const script = 'node run.ts; /home/paperclip/.local/bin/paperclip-notify NEV-568 "finished $?"';
    await proc(root, 100, ["sh", "-c", `setsid nohup bash -c '${script}'`], 1, 500);
    await proc(root, 101, ["/usr/bin/bash", "-c", script], 100, 600, log);
    await proc(root, 200, ["/usr/bin/bash", "-c", "sleep 9; paperclip-notify NEV-7 hi"], 1, 1000, "/dev/null");
    await proc(root, 300, ["vim", "notes.md"], 1, 1000);
    await proc(root, 400, ["grep", "paperclip-notify"], 1, 1000);
    const jobs = await scanJobs(root);
    expect(jobs.map((j) => [j.issue, j.pid])).toEqual([["NEV-568", 101], ["NEV-7", 200]]);
    expect(jobs[0]!.startedAt).toBe(new Date(1794569797_000 + 6_000).toISOString());
    expect(jobs[0]).toMatchObject({ command: "node run.ts", log, lastLine: "hour 346/360: tick 1" });
    expect(jobs[1]!.log).toBeNull();
  });

  it("reads the log's last line and when it changed", async () => {
    const root = await temp();
    await writeFile(join(root, "stat"), "btime 1794569797\n");
    const log = join(root, "job.log");
    await writeFile(log, "start\nhour 1/360\rhour 2/360\n\n");
    await utimes(log, new Date("2026-11-14T08:00:00Z"), new Date("2026-11-14T08:00:00Z"));
    await proc(root, 5, ["bash", "-c", "x; paperclip-notify NEV-9 done"], 1, 0, log);
    const [j] = await scanJobs(root);
    expect(j).toMatchObject({ issue: "NEV-9", command: "x", log, lastLine: "hour 2/360", logUpdatedAt: "2026-11-14T08:00:00.000Z" });
  });

  it("returns nothing when /proc can't be read", async () => {
    expect(await scanJobs("/no/such/proc")).toEqual([]);
  });
});

describe("readRegisteredWaits", () => {
  it("reads valid waits and ignores a missing or broken file", async () => {
    const root = await temp();
    const file = join(root, "waits.json");
    expect(await readRegisteredWaits(file)).toEqual([]);
    await writeFile(file, JSON.stringify({ waits: [{ id: "a", issue: "NEV-1", kind: "ci", ref: "main", createdAt: "x" }, { id: 3 }] }));
    expect(await readRegisteredWaits(file)).toHaveLength(1);
    await writeFile(file, "{not json");
    expect(await readRegisteredWaits(file)).toEqual([]);
  });
});
