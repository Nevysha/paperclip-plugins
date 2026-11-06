import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { parseDecisionComment, parseNewDecision, parseReview } from "../src/validate.js";

const valid = { kind: "judgment_call", question: "Q", answer: "A", reasoning: "R" };

describe("manifest", () => {
  it("keeps every route board-only and offers no way to edit or delete", () => {
    const routes: Array<{ routeKey: string; method: string; auth: string }> = manifest.apiRoutes ?? [];
    expect(routes.every((r) => r.auth === "board")).toBe(true);
    expect(routes.map((r) => r.routeKey).sort()).toEqual(["list", "review"]);
  });
});

describe("parseNewDecision", () => {
  it("accepts a valid decision and ignores any author in the body", () => {
    const result = parseNewDecision({ ...valid, authorAgentId: "spoofed" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toHaveProperty("authorAgentId");
  });
  it("requires a reason", () => {
    expect(parseNewDecision({ ...valid, reasoning: " " }).ok).toBe(false);
  });
  it("requires a source for answered_from_source", () => {
    expect(parseNewDecision({ ...valid, kind: "answered_from_source" }).ok).toBe(false);
    expect(parseNewDecision({ ...valid, kind: "answered_from_source", sources: ["docs/design/brief.md"] }).ok).toBe(true);
  });
  it("rejects unknown kinds", () => {
    expect(parseNewDecision({ ...valid, kind: "nope" }).ok).toBe(false);
  });
});

describe("parseReview", () => {
  it("requires a note to overturn", () => {
    expect(parseReview({ status: "overturned" }).ok).toBe(false);
    expect(parseReview({ status: "overturned", note: "Do X" }).ok).toBe(true);
    expect(parseReview({ status: "reviewed" }).ok).toBe(true);
    expect(parseReview({ status: "nope" }).ok).toBe(false);
  });
});

describe("parseDecisionComment", () => {
  const fence = "```";
  it("ignores comments without a block", () => {
    expect(parseDecisionComment("Just a normal comment with ```code```")).toBeNull();
  });
  it("reads a block surrounded by other text", () => {
    const result = parseDecisionComment(`Note\n${fence}decision-log\n${JSON.stringify(valid)}\n${fence}\nMore`);
    expect(result?.ok).toBe(true);
  });
  it("reports bad JSON and invalid fields", () => {
    expect(parseDecisionComment(`${fence}decision-log\n{nope\n${fence}`)?.ok).toBe(false);
    expect(parseDecisionComment(`${fence}decision-log\n{"kind":"x"}\n${fence}`)?.ok).toBe(false);
  });
});
