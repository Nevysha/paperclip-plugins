import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "nevysha.fleet-cost",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Token Lens",
  description: "Where the fleet's Claude tokens go: cost at API prices, tool calls and what each costs, and tokens per line of merged code.",
  author: "Nevysha",
  categories: ["ui"],
  capabilities: [
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "ui.action.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  // Reads runs, agents and tasks. Its own tables hold what collector/collect.mjs posts to
  // /ingest: tool calls per run and merged commits, which plugins can't read themselves.
  database: {
    migrationsDir: "migrations",
    coreReadTables: ["heartbeat_runs", "agents", "issues"],
  },
  apiRoutes: (
    [
      ["usage", "GET", "/usage"],
      ["tools", "GET", "/tools"],
      ["efficiency", "GET", "/efficiency"],
      ["ingest", "POST", "/ingest"],
    ] as const
  ).map(([routeKey, method, path]) => ({
    routeKey, method, path, auth: "board" as const, capability: "api.routes.register" as const,
    companyResolution: { from: "query" as const, key: "companyId" },
  })),
  ui: {
    slots: [
      {
        type: "page",
        id: "fleet-cost-page",
        displayName: "Token Lens",
        exportName: "FleetCostPage",
        routePath: "fleet-cost",
      },
      {
        type: "sidebar",
        id: "fleet-cost-sidebar",
        displayName: "Token Lens",
        exportName: "FleetCostSidebarLink",
      },
      {
        // The coordinator sidebar doesn't render plugin links, so this is the way in there.
        type: "globalToolbarButton",
        id: "fleet-cost-toolbar-button",
        displayName: "Token Lens",
        exportName: "FleetCostToolbarButton",
      },
    ],
  },
};

export default manifest;
