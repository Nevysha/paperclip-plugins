# Watchdog

A Paperclip plugin that adds a **Watchdog** button to the header, showing whether the watchdog is keeping work moving.

The watchdog itself isn't part of the plugin. It's a systemd user timer that runs every 3 minutes outside Paperclip (`~/.local/lib/paperclip-watchdog/`), so it keeps working when Paperclip freezes. Each run, it:
- restarts Paperclip when a company-wide quarantine stops every agent run;
- recreates tasks Paperclip won't restart;
- moves stalled `blocked` tasks back to `todo`;
- wakes idle `todo` tasks;
- comments CI results on the tasks waiting for them.

The plugin only reads the watchdog's files in `~/.paperclip-dev/watchdog/` and toggles its pause flag.

![The header in dark mode with a Watchdog button showing a green dot, open on a panel that says All clear, with the last check time, a Pause button, recent actions and the log path](docs/watchdog-panel.png)

The button's dot shows the watchdog's state:

| Dot | Meaning |
|---|---|
| Green | All clear |
| Blue | Acted in the last 15 minutes |
| Red | Quarantine or error |
| Yellow | Paused |
| Grey | Not running: no check in 10 minutes, or no report yet |

The panel shows:
- the last check;
- any notes, such as usage being too high to wake agents;
- CI waits that agents registered with `paperclip-wait`, each with a **Remove** button;
- the last 10 actions;
- a **Pause** / **Resume** button.

## Development

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

Paperclip loads the plugin from this folder, so don't move it. `PAPERCLIP_WATCHDOG_DIR` points the worker at another folder, which the tests use.
