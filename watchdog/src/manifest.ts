import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "nevysha.watchdog",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Watchdog",
  description: "Shows the Paperclip watchdog's state in the header, with pause and resume.",
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
        id: "watchdog-button",
        displayName: "Watchdog",
        exportName: "WatchdogButton",
      },
    ],
  },
};

export default manifest;
