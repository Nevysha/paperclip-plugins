import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { ROUTINES } from "./gate.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "nevysha.claude-usage",
  apiVersion: 1,
  version: "0.3.1",
  displayName: "Claude Usage",
  description: "Shows your Claude subscription usage in the header.",
  author: "Nevysha",
  categories: ["ui"],
  capabilities: ["plugin.state.read", "plugin.state.write", "routines.managed", "ui.action.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
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
