import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { analyse, chainOf, findTask, isQuiet, select, type GraphData, type Relation, type SelectOptions, type Task, type Wait } from "../src/graph.js";

const task = (n: number, status = "todo", over: Partial<Task> = {}): Task => ({
  id: `t${n}`, identifier: `NEV-${n}`, title: `Task ${n}`, status, priority: "medium", parentId: null,
  projectId: "p1", assigneeName: null, assignedToUser: false, updatedAt: "2026-11-11T00:00:00.000Z", ...over,
});
const blocks = (from: number, to: number): Relation => ({ blockerId: `t${from}`, blockedId: `t${to}` });
const data = (tasks: Task[], relations: Relation[]): GraphData => ({ tasks, relations, projects: [], generatedAt: "" });
const opts = (over: Partial<SelectOptions> = {}): SelectOptions => ({
  scope: "open", showClosed: true, parentLinks: false, focusId: null, projectId: null, ...over,
});

describe("manifest", () => {
  it("only reads, and only for the board", () => {
    expect(manifest.apiRoutes?.every((r) => r.auth === "board" && r.method === "GET")).toBe(true);
    expect(manifest.capabilities).not.toContain("database.namespace.write");
    expect(manifest.database?.coreReadTables).toContain("issue_relations");
  });
});

describe("analyse", () => {
  it("links blockers both ways and counts open blockers", () => {
    const a = analyse(data([task(1, "done"), task(2, "in_progress"), task(3, "blocked")], [blocks(1, 3), blocks(2, 3)]));
    expect(a.get("t3")!.blockers.sort()).toEqual(["t1", "t2"]);
    expect(a.get("t3")!.openBlockers).toEqual(["t2"]);
    expect(a.get("t1")!.blocks).toEqual(["t3"]);
    expect(a.get("t3")!.staleWait).toBe(false);
  });

  it("flags a task still blocked after every blocker closed", () => {
    const a = analyse(data([task(1, "done"), task(2, "cancelled"), task(3, "blocked")], [blocks(1, 3), blocks(2, 3)]));
    expect(a.get("t3")!.staleWait).toBe(true);
  });

  it("doesn't flag a blocked task with no blocker links", () => {
    expect(analyse(data([task(1, "blocked")], [])).get("t1")!.staleWait).toBe(false);
  });

  it("counts open work held up downstream and finds the chain head", () => {
    // 1 -> 2 -> 3, 2 -> 4 (done)
    const a = analyse(data([task(1, "in_progress"), task(2, "blocked"), task(3, "blocked"), task(4, "done")],
      [blocks(1, 2), blocks(2, 3), blocks(2, 4)]));
    expect(a.get("t1")!.holdingUp).toBe(2);
    expect(a.get("t1")!.isHead).toBe(true);
    expect(a.get("t2")!.holdingUp).toBe(1);
    expect(a.get("t2")!.isHead).toBe(false);
  });

  it("finds loops", () => {
    const a = analyse(data([task(1), task(2), task(3), task(4)], [blocks(1, 2), blocks(2, 3), blocks(3, 1), blocks(3, 4)]));
    expect(["t1", "t2", "t3"].every((id) => a.get(id)!.inCycle)).toBe(true);
    expect(a.get("t4")!.inCycle).toBe(false);
  });

  it("ignores links to tasks it doesn't have and self links", () => {
    const a = analyse(data([task(1)], [blocks(1, 9), blocks(1, 1)]));
    expect(a.get("t1")!.blocks).toEqual([]);
  });

  it("survives a very long chain", () => {
    const n = 2000;
    const tasks = Array.from({ length: n }, (_, i) => task(i));
    const rels = Array.from({ length: n - 1 }, (_, i) => blocks(i, i + 1));
    expect(analyse(data(tasks, rels)).get("t0")!.holdingUp).toBe(n - 1);
  });
});

describe("select", () => {
  const d = data(
    [task(1, "done"), task(2, "done"), task(3, "in_progress"), task(4, "blocked"), task(5), task(6, "todo", { parentId: "t3" })],
    [blocks(1, 2), blocks(3, 4)],
  );
  const a = analyse(d);

  it("keeps only chains with open work by default", () => {
    expect(select(d, a, opts()).nodeIds.sort()).toEqual(["t3", "t4"]);
    expect(select(d, a, opts({ scope: "all" })).nodeIds.sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("can hide finished tasks", () => {
    expect(select(d, a, opts({ scope: "all", showClosed: false })).nodeIds.sort()).toEqual(["t3", "t4"]);
  });

  it("adds parent links when asked", () => {
    const s = select(d, a, opts({ parentLinks: true }));
    expect(s.nodeIds.sort()).toEqual(["t3", "t4", "t6"]);
    expect(s.edges.find((e) => e.kind === "parent")).toMatchObject({ from: "t3", to: "t6" });
  });

  it("focuses on one task's chain, upstream and downstream", () => {
    const chain = data([task(1), task(2), task(3), task(4), task(5)], [blocks(1, 2), blocks(2, 3), blocks(4, 3), blocks(4, 5)]);
    const s = select(chain, analyse(chain), opts({ focusId: "t2" }));
    expect(s.nodeIds.sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("keeps the focused task even when it is finished and finished tasks are hidden", () => {
    expect(select(d, a, opts({ focusId: "t1", showClosed: false })).nodeIds).toEqual(["t1"]);
  });

  it("marks links from finished blockers as resolved", () => {
    const s = select(d, a, opts({ scope: "all" }));
    expect(s.edges.find((e) => e.from === "t1")!.resolved).toBe(true);
    expect(s.edges.find((e) => e.from === "t3")!.resolved).toBe(false);
  });

  it("filters by project", () => {
    const p = data([task(1), task(2, "todo", { projectId: "p2" }), task(3)], [blocks(1, 2), blocks(1, 3)]);
    expect(select(p, analyse(p), opts({ projectId: "p1" })).nodeIds.sort()).toEqual(["t1", "t3"]);
  });
});

describe("chainOf", () => {
  it("collects everything up and down the chain", () => {
    const d = data([task(1), task(2), task(3), task(4)], [blocks(1, 2), blocks(2, 3), blocks(4, 3)]);
    const s = select(d, analyse(d), opts());
    const c = chainOf("t2", s.edges);
    expect([...c.up].sort()).toEqual(["t1", "t2"]);
    expect([...c.down].sort()).toEqual(["t2", "t3"]);
    expect(c.edgeKeys.size).toBe(2);
  });
});

describe("findTask", () => {
  const d = data([task(12), task(120)], []);
  it("matches identifiers case-insensitively and bare numbers", () => {
    expect(findTask(d, "nev-12")?.id).toBe("t12");
    expect(findTask(d, "120")?.id).toBe("t120");
    expect(findTask(d, "NEV-7")).toBeNull();
    expect(findTask(d, "  ")).toBeNull();
  });
});

describe("waits", () => {
  const job = (taskN: number, over: Partial<Wait> = {}): Wait => ({
    id: `wait:job:${taskN}`, taskId: `t${taskN}`, kind: "job", title: "node run.ts", detail: "hour 5/360",
    since: "2026-11-14T07:00:00.000Z", logUpdatedAt: new Date().toISOString(), ...over,
  });
  const withWaits = (tasks: Task[], relations: Relation[], waits: Wait[]): GraphData => ({ ...data(tasks, relations), waits });
  const person = { owner: "person" as const, ownerName: null, action: "Tell me to continue" };
  const agent = { owner: "agent" as const, ownerName: "DevOps", action: "The run finishes and paperclip-notify comments" };

  it("a blocked task with a running job is neither unattended nor waiting on a person", () => {
    const i = analyse(withWaits([task(1, "blocked", { unblock: person })], [], [job(1)])).get("t1")!;
    expect(i.waits).toHaveLength(1);
    expect(i.unattended).toBe(false);
    expect(i.needsPerson).toBe(false);
  });

  it("flags a blocked task that nothing will wake, and one that waits on a person", () => {
    const a = analyse(data([task(1, "blocked", { unblock: agent }), task(2, "blocked", { unblock: person }), task(3, "blocked")], []));
    expect(a.get("t1")!.unattended).toBe(true);
    expect(a.get("t2")!.needsPerson).toBe(true);
    expect(a.get("t2")!.unattended).toBe(false);
    expect(a.get("t3")!.unattended).toBe(true);
  });

  it("doesn't flag a task waiting on an open blocker, or a stale one twice", () => {
    const a = analyse(data([task(1), task(2, "blocked"), task(3, "done"), task(4, "blocked")], [blocks(1, 2), blocks(3, 4)]));
    expect(a.get("t2")!.unattended).toBe(false);
    expect(a.get("t4")!.staleWait).toBe(true);
    expect(a.get("t4")!.unattended).toBe(false);
  });

  it("draws wait boxes linked to their task, and lone blocked tasks", () => {
    const d = withWaits([task(1, "blocked"), task(2, "blocked"), task(3, "todo")], [], [job(1)]);
    const s = select(d, analyse(d), opts());
    expect(s.waitIds).toEqual(["wait:job:1"]);
    expect(s.nodeIds.sort()).toEqual(["t1", "t2"]);
    expect(s.edges).toContainEqual({ from: "wait:job:1", to: "t1", kind: "wait", resolved: false });
  });

  it("keeps waits in a focused chain and drops those of other projects", () => {
    const d = withWaits([task(1), task(2, "blocked"), task(5, "blocked", { projectId: "p2" })], [blocks(1, 2)], [job(2), job(5)]);
    const a = analyse(d);
    expect(select(d, a, opts({ focusId: "t1" })).waitIds).toEqual(["wait:job:2"]);
    expect(select(d, a, opts({ projectId: "p1" })).waitIds).toEqual(["wait:job:2"]);
  });

  it("marks a job whose log has been quiet for 30 minutes", () => {
    const now = Date.parse("2026-11-14T10:00:00Z");
    expect(isQuiet(job(1, { logUpdatedAt: "2026-11-14T09:45:00Z" }), now)).toBe(false);
    expect(isQuiet(job(1, { logUpdatedAt: "2026-11-14T09:00:00Z" }), now)).toBe(true);
    expect(isQuiet(job(1, { logUpdatedAt: null }), now)).toBe(false);
  });
});
