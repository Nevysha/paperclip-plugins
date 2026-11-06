import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "nevysha.decision-log",
  apiVersion: 1,
  version: "0.3.0",
  displayName: "Decision Log",
  description: "Append-only log of decisions made by agents, with founder review.",
  author: "Nevysha",
  categories: ["ui"],
  capabilities: [
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "events.subscribe",
    "issue.comments.create",
    "issue.comments.read",
    "ui.action.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    migrationsDir: "migrations",
    coreReadTables: ["companies", "agents", "issues"],
  },
  // Both routes are board-only. Agents add entries by posting a decision-log comment (see worker.ts),
  // and no route edits or deletes an entry.
  apiRoutes: [
    {
      routeKey: "list",
      method: "GET",
      path: "/decisions",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "review",
      method: "POST",
      path: "/decisions/:id/review",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "decision-log-page",
        displayName: "Decision Log",
        exportName: "DecisionLogPage",
        routePath: "decision-log",
      },
      {
        type: "sidebar",
        id: "decision-log-sidebar",
        displayName: "Decision Log",
        exportName: "DecisionLogSidebarLink",
      },
      {
        // The coordinator sidebar doesn't render plugin links, so this is the way in there.
        type: "globalToolbarButton",
        id: "decision-log-toolbar-button",
        displayName: "Decision Log",
        exportName: "DecisionLogToolbarButton",
      },
    ],
  },
};

export default manifest;
