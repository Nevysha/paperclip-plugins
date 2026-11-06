import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "nevysha.claude-usage",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Claude Usage",
  description: "Shows your Claude subscription usage in the header.",
  author: "Nevysha",
  categories: ["ui"],
  capabilities: ["ui.action.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
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
