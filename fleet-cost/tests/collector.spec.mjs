import { describe, expect, it } from "vitest";
import { attributeRun, commitHashesIn, commitSubjects, mainCommand, matchCommits, summarizeNumstat, toolCategory } from "../collector/lib.mjs";

describe("toolCategory", () => {
  it("splits Bash by the command that matters", () => {
    expect(toolCategory("Bash", "cd /x && sed -n 1,80p a.ts")).toBe("Bash: read files");
    expect(toolCategory("Bash", "grep -rn foo src")).toBe("Bash: search");
    expect(toolCategory("Bash", "npm run ci:local > /tmp/x.log 2>&1; tail -30 /tmp/x.log")).toBe("Bash: local CI");
    expect(toolCategory("Bash", "npx vitest run test/a.test.ts")).toBe("Bash: tests");
    expect(toolCategory("Bash", "git commit -qam \"x\"")).toBe("Bash: git");
    expect(toolCategory("Bash", "sed -i 's/a/b/' f.ts")).toBe("Bash: edit files");
    expect(toolCategory("Bash", "until grep -q done log; do sleep 30; done")).toBe("Bash: wait, poll");
    expect(toolCategory("Read", "")).toBe("Read");
    expect(toolCategory("create_task", "")).toBe("Paperclip: create_task");
    expect(mainCommand("cd 'a b' && FOO=1 git status")).toBe("git status");
  });
});

describe("attributeRun", () => {
  it("charges each tool the context of the request after it, scaled to the receipt", () => {
    const events = [
      { kind: "usage", context: 30_000 }, // first request
      { kind: "usage", context: 30_200 }, // model issued a call
      { kind: "tool", name: "Read", outputBytes: 4000 },
      { kind: "usage", context: 31_200 }, // result added
      { kind: "usage", context: 31_400 },
      { kind: "tool", name: "Bash", subject: "sed -n 1,10p a", outputBytes: 100 },
      { kind: "tool", name: "Bash", subject: "grep x a", outputBytes: 300 },
      { kind: "usage", context: 32_400 },
    ];
    const raw = 30_000 + 31_200 + 32_400;
    const a = attributeRun(events, raw * 2);
    expect(a).toMatchObject({ toolCalls: 3, requests: 3, firstContext: 30_000, maxContext: 32_400, startTokens: 60_000 });
    const read = a.tools.find((t) => t.category === "Read");
    expect(read).toMatchObject({ calls: 1, stepTokens: 62_400, resultTokens: 1000 });
    const search = a.tools.find((t) => t.category === "Bash: search");
    expect(search.stepTokens).toBe(32_400); // half of the shared request, doubled by the scale
    expect(search.resultTokens).toBe(750);
    expect(a.tools.reduce((s, t) => s + t.stepTokens, 0) + a.startTokens).toBe(raw * 2);
  });
  it("handles a run with no events", () => {
    expect(attributeRun([], 0)).toMatchObject({ toolCalls: 0, requests: 0, tools: [] });
  });
});

describe("commits", () => {
  it("reads commit subjects from git commit commands", () => {
    expect(commitSubjects('git add -A && git commit -q -m "Fix the drain (NEV-1)\n\nBody" && git log --oneline -1')).toEqual(["Fix the drain (NEV-1)"]);
    expect(commitSubjects("git commit -F - <<'EOF'\nHeredoc subject\n\nbody\nEOF")).toEqual(["Heredoc subject"]);
    expect(commitSubjects("git status")).toEqual([]);
  });
  it("takes hashes only from what the commit printed", () => {
    expect(commitHashesIn('git commit -m "x"', "[feat/a 1a2b3c4] x\n 2 files changed")).toEqual(["1a2b3c4"]);
    expect(commitHashesIn('git commit -qm "x" && git log --oneline -1', "e379279 x\nexit 0")).toEqual(["e379279"]);
    expect(commitHashesIn("git log --oneline -5", "e379279 x\nabcdef0 y")).toEqual([]);
  });
  it("matches by hash, then by subject to the latest run that started before", () => {
    const evidence = [
      { runId: "r1", startedAt: 1000, hashes: ["abc1234"], subjects: ["One"] },
      { runId: "r2", startedAt: 2000, hashes: [], subjects: ["Two"] },
      { runId: "r3", startedAt: 900_000, hashes: [], subjects: ["Two"] },
    ];
    const m = matchCommits([
      { sha: "abc1234ffff", subject: "One", authoredAt: 1500 },
      { sha: "def", subject: "Two", authoredAt: 5000 },
      { sha: "ghi", subject: "Three", authoredAt: 5000 },
    ], evidence);
    expect(m.map((x) => [x.runId, x.method])).toEqual([["r1", "hash"], ["r2", "subject"], [null, "none"]]);
  });
  it("splits numstat into code and docs, skipping lockfiles and binaries", () => {
    expect(summarizeNumstat(["10\t2\tsrc/a.ts", "5\t1\tdocs/b.md", "900\t0\tpackage-lock.json", "-\t-\timg.png", "junk"]))
      .toEqual({ codeAdded: 10, codeDeleted: 2, docAdded: 5, docDeleted: 1, codeFiles: 1, docFiles: 1, skippedFiles: 2 });
  });
});
