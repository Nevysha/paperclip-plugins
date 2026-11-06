import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("approvals button", () => {
  it("only asks to read approvals and add the button", () => {
    expect(manifest.capabilities).toEqual(["approvals.read", "ui.action.register"]);
  });

  it("requires a company", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    await plugin.definition.setup(harness.ctx);
    await expect(harness.getData("pending")).rejects.toThrow("companyId is required");
  });
});
