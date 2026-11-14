import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "nevysha.dependency-graph",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Dependency Graph",
  description: "A graph of which tasks block which, and what blocked tasks wait on (jobs, CI, people), with stuck chains highlighted.",
  author: "Nevysha",
  categories: ["ui"],
  capabilities: [
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    // Only for the "Wake it" button: move a blocked task nothing will wake to To do, explain why, and wake its assignee.
    "issue.comments.create",
    "issues.update",
    "issues.wakeup",
    "ui.action.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  // The plugin owns no tables and only reads tasks, their blocker links, agents and projects. Its one write is the
  // board's "Wake it" button (POST /tasks/:id/wake).
  // Outside the database it reads /proc (running background jobs) and the watchdog's waits.json.
  database: {
    migrationsDir: "migrations",
    coreReadTables: ["issues", "issue_relations", "agents", "projects"],
  },
  apiRoutes: [
    {
      routeKey: "graph",
      method: "GET",
      path: "/graph",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "wake",
      method: "POST",
      path: "/tasks/:id/wake",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "dependency-graph-page",
        displayName: "Dependencies",
        exportName: "DependencyGraphPage",
        routePath: "dependencies",
      },
      {
        type: "sidebar",
        id: "dependency-graph-sidebar",
        displayName: "Dependencies",
        exportName: "DependencyGraphSidebarLink",
      },
      {
        // The coordinator sidebar doesn't render plugin links, so this is the way in there.
        type: "globalToolbarButton",
        id: "dependency-graph-toolbar-button",
        displayName: "Dependencies",
        exportName: "DependencyGraphToolbarButton",
      },
    ],
  },
};

export default manifest;
