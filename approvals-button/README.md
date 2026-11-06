# Approvals Button

A Paperclip plugin that adds an **Approvals** button to the header, with a flag showing how many approvals are pending. The app's menus don't link to that page.

It only reads approvals. It can't approve or reject anything.

![The header in dark mode, with an Approvals button showing a red flag with the number 1 next to the usage and Decisions buttons](docs/approvals-button.png)

## Development

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

Paperclip loads the plugin from this folder, so don't move it.
