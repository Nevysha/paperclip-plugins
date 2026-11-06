import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("pending", async ({ companyId }) => {
      if (typeof companyId !== "string" || !companyId) throw new Error("companyId is required");
      const approvals = await ctx.approvals.list({ companyId, status: "pending" });
      return { count: approvals.length };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Approvals Button is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
