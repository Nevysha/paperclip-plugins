export type Task = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string | null;
  parentId: string | null;
  projectId: string | null;
  assigneeName: string | null;
  assignedToUser: boolean;
  updatedAt: string;
};

/** `blockerId` blocks `blockedId`: the blocked task waits until the blocker is done or cancelled. */
export type Relation = { blockerId: string; blockedId: string };

export type GraphData = {
  tasks: Task[];
  relations: Relation[];
  projects: Array<{ id: string; name: string }>;
  generatedAt: string;
};

export const isClosed = (status: string) => status === "done" || status === "cancelled";

export type NodeInfo = {
  task: Task;
  blockers: string[];
  blocks: string[];
  openBlockers: string[];
  /** Status is `blocked` and it has blockers, but every one of them is closed. */
  staleWait: boolean;
  inCycle: boolean;
  /** Open tasks downstream of this one, directly or through other tasks. */
  holdingUp: number;
  /** Open, holds up open work, and waits on no open blocker: the place the chain has to move. */
  isHead: boolean;
};

export type Analysis = Map<string, NodeInfo>;

export function analyse(data: GraphData): Analysis {
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const out: Analysis = new Map();
  for (const task of data.tasks) {
    out.set(task.id, { task, blockers: [], blocks: [], openBlockers: [], staleWait: false, inCycle: false, holdingUp: 0, isHead: false });
  }
  for (const r of data.relations) {
    const blocker = out.get(r.blockerId);
    const blocked = out.get(r.blockedId);
    if (!blocker || !blocked || r.blockerId === r.blockedId) continue;
    if (!blocker.blocks.includes(r.blockedId)) blocker.blocks.push(r.blockedId);
    if (!blocked.blockers.includes(r.blockerId)) blocked.blockers.push(r.blockerId);
  }
  for (const info of out.values()) {
    info.openBlockers = info.blockers.filter((id) => !isClosed(byId.get(id)!.status));
    info.staleWait = info.task.status === "blocked" && info.blockers.length > 0 && info.openBlockers.length === 0;
  }
  for (const scc of stronglyConnected([...out.keys()], (id) => out.get(id)!.blocks)) {
    if (scc.length > 1) for (const id of scc) out.get(id)!.inCycle = true;
  }
  for (const info of out.values()) {
    if (isClosed(info.task.status) || info.blocks.length === 0) continue;
    const seen = reach(info.task.id, (id) => out.get(id)!.blocks);
    seen.delete(info.task.id);
    info.holdingUp = [...seen].filter((id) => !isClosed(out.get(id)!.task.status)).length;
    info.isHead = info.holdingUp > 0 && info.openBlockers.length === 0;
  }
  return out;
}

export type Edge = { from: string; to: string; kind: "blocks" | "parent"; resolved: boolean };

export type Scope = "open" | "all";

export type SelectOptions = {
  scope: Scope;
  showClosed: boolean;
  parentLinks: boolean;
  focusId: string | null;
  projectId: string | null;
};

export type Selection = { nodeIds: string[]; edges: Edge[] };

/** The tasks and links to draw for the chosen scope. */
export function select(data: GraphData, analysis: Analysis, opts: SelectOptions): Selection {
  const inProject = (id: string) => {
    const t = analysis.get(id)?.task;
    return !!t && (!opts.projectId || t.projectId === opts.projectId);
  };
  let edges: Edge[] = [];
  for (const info of analysis.values()) {
    for (const to of info.blocks) {
      if (inProject(info.task.id) && inProject(to)) {
        edges.push({ from: info.task.id, to, kind: "blocks", resolved: isClosed(info.task.status) });
      }
    }
  }
  if (opts.parentLinks) {
    for (const t of data.tasks) {
      if (t.parentId && inProject(t.id) && inProject(t.parentId)) {
        edges.push({ from: t.parentId, to: t.id, kind: "parent", resolved: false });
      }
    }
  }

  let keep: Set<string>;
  if (opts.focusId && analysis.has(opts.focusId)) {
    const fwd = adjacency(edges, "from");
    const back = adjacency(edges, "to");
    keep = new Set([...reach(opts.focusId, (id) => fwd.get(id) ?? []), ...reach(opts.focusId, (id) => back.get(id) ?? [])]);
  } else {
    const touched = new Set(edges.flatMap((e) => [e.from, e.to]));
    keep = new Set();
    for (const component of components([...touched], edges)) {
      if (opts.scope === "all" || component.some((id) => !isClosed(analysis.get(id)!.task.status))) {
        for (const id of component) keep.add(id);
      }
    }
  }
  if (!opts.showClosed) {
    keep = new Set([...keep].filter((id) => id === opts.focusId || !isClosed(analysis.get(id)!.task.status)));
  }
  edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return { nodeIds: [...keep], edges };
}

/** Everything upstream and downstream of `id` along the drawn links, including `id`. */
export function chainOf(id: string, edges: Edge[]): { up: Set<string>; down: Set<string>; edgeKeys: Set<string> } {
  const fwd = adjacency(edges, "from");
  const back = adjacency(edges, "to");
  const down = reach(id, (n) => fwd.get(n) ?? []);
  const up = reach(id, (n) => back.get(n) ?? []);
  const edgeKeys = new Set<string>();
  for (const e of edges) {
    if ((down.has(e.from) && down.has(e.to)) || (up.has(e.from) && up.has(e.to))) edgeKeys.add(edgeKey(e));
  }
  return { up, down, edgeKeys };
}

export const edgeKey = (e: Edge) => `${e.kind}:${e.from}>${e.to}`;

/** Finds a task by identifier (case-insensitive, "123" means "<PREFIX>-123") or id. */
export function findTask(data: GraphData, query: string): Task | null {
  const q = query.trim().toUpperCase();
  if (!q) return null;
  return (
    data.tasks.find((t) => t.identifier?.toUpperCase() === q)
    ?? (/^\d+$/.test(q) ? data.tasks.find((t) => t.identifier?.toUpperCase().endsWith(`-${q}`)) : undefined)
    ?? data.tasks.find((t) => t.id === query.trim())
    ?? null
  );
}

function adjacency(edges: Edge[], side: "from" | "to"): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of edges) {
    const a = side === "from" ? e.from : e.to;
    const b = side === "from" ? e.to : e.from;
    (m.get(a) ?? m.set(a, []).get(a)!).push(b);
  }
  return m;
}

function reach(start: string, next: (id: string) => string[]): Set<string> {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    for (const n of next(stack.pop()!)) {
      if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
  }
  return seen;
}

function components(ids: string[], edges: Edge[]): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; }
    return x;
  };
  for (const e of edges) {
    if (parent.has(e.from) && parent.has(e.to)) parent.set(find(e.from), find(e.to));
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) { const r = find(id); (groups.get(r) ?? groups.set(r, []).get(r)!).push(id); }
  return [...groups.values()];
}

/** Tarjan's algorithm, iterative so a long chain can't overflow the stack. */
function stronglyConnected(ids: string[], next: (id: string) => string[]): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: Array<{ id: string; i: number }> = [{ id: root, i: 0 }];
    index.set(root, counter); low.set(root, counter); counter++;
    stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const succ = next(frame.id);
      if (frame.i < succ.length) {
        const w = succ[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter++;
          stack.push(w); onStack.add(w);
          work.push({ id: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parentId = work[work.length - 1]!.id;
        low.set(parentId, Math.min(low.get(parentId)!, low.get(frame.id)!));
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const scc: string[] = [];
        let w: string;
        do { w = stack.pop()!; onStack.delete(w); scc.push(w); } while (w !== frame.id);
        out.push(scc);
      }
    }
  }
  return out;
}
