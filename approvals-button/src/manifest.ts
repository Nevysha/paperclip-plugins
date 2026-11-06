import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "nevysha.approvals-button",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Approvals Button",
  description: "Shows pending approvals in the header.",
  author: "Nevysha",
  categories: ["ui"],
  capabilities: ["approvals.read", "ui.action.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "globalToolbarButton",
        id: "approvals-button",
        displayName: "Approvals",
        exportName: "ApprovalsButton",
      },
    ],
  },
};

export default manifest;
