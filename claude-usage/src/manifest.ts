import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { ROUTINES } from "./gate.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "nevysha.claude-usage",
  apiVersion: 1,
  version: "0.4.0",
  displayName: "Claude Usage",
  description: "Shows your Claude subscription usage in the header.",
  author: "Nevysha",
  categories: ["ui"],
  capabilities: ["companies.read", "plugin.state.read", "plugin.state.write", "routines.managed", "ui.action.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", title: "Project ID", description: "Project the managed routines file their tasks in." },
      routines: {
        type: "array",
        title: "Managed routines",
        description: "Routines to create in this company and gate on usage. A routine not listed here is never created.",
        items: {
          type: "object",
          properties: {
            key: { type: "string", enum: ROUTINES.map((r) => r.key) },
            assigneeAgentId: { type: "string", title: "Assignee agent ID" },
          },
          required: ["key", "assigneeAgentId"],
        },
      },
    },
  },
  routines: ROUTINES.map((r) => ({
    routineKey: r.key,
    title: r.title,
    description: r.description,
    priority: "medium" as const,
    concurrencyPolicy: "always_enqueue" as const,
    catchUpPolicy: "skip_missed" as const,
    activityGatePolicy: "require_external_activity" as const,
    activityGateScope: "company" as const,
    triggers: [{ kind: "schedule" as const, label: r.label, enabled: true, cronExpression: r.cron, timezone: "Europe/Paris", signingMode: null, replayWindowSec: null }],
  })),
  ui: {
    slots: [
      {
        type: "globalToolbarButton",
        id: "claude-usage-toolbar",
        displayName: "Claude Usage",
        exportName: "ClaudeUsageButton",
      },
    ],
  },
};

export default manifest;
