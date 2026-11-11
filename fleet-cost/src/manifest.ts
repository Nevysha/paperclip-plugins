import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "nevysha.fleet-cost",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Fleet Cost",
  description: "What the fleet's Claude usage would cost at API prices, with token usage, per day, week, month, agent and task.",
  author: "Nevysha",
  categories: ["ui"],
  capabilities: [
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "ui.action.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  // Read-only: the plugin owns no tables and only reads runs, agents and tasks.
  database: {
    migrationsDir: "migrations",
    coreReadTables: ["heartbeat_runs", "agents", "issues"],
  },
  apiRoutes: [
    {
      routeKey: "usage",
      method: "GET",
      path: "/usage",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "fleet-cost-page",
        displayName: "Fleet Cost",
        exportName: "FleetCostPage",
        routePath: "fleet-cost",
      },
      {
        type: "sidebar",
        id: "fleet-cost-sidebar",
        displayName: "Fleet Cost",
        exportName: "FleetCostSidebarLink",
      },
      {
        // The coordinator sidebar doesn't render plugin links, so this is the way in there.
        type: "globalToolbarButton",
        id: "fleet-cost-toolbar-button",
        displayName: "Fleet Cost",
        exportName: "FleetCostToolbarButton",
      },
    ],
  },
};

export default manifest;
