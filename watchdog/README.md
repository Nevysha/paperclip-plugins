# Watchdog

A Paperclip plugin that adds a **Watchdog** button to the header, showing whether the watchdog is keeping work moving.

The watchdog itself isn't part of the plugin. It's a systemd user timer that runs every 3 minutes outside Paperclip, so it keeps working when Paperclip freezes. It doesn't start at boot: start the timer with Paperclip and stop it after. Its source is in [`host/`](host/). Each run, it:
- renews the Claude login of the user Paperclip runs as (`~/.claude/.credentials.json`) with `claude auth status` when it has less than 15 minutes left. The claude-usage plugin reads that login but never renews it, and the usage limits below need fresh usage data. Agents don't use this login: each run gets its own token;
- restarts Paperclip when a company-wide quarantine stops every agent run, with the `restartCommand` from its config (without one, it only reports it);
- recreates tasks Paperclip won't restart;
- moves stalled `blocked` tasks back to `todo`, except when Paperclip already woke the agent because the task's blockers finished and the agent chose to stay blocked;
- wakes idle `todo` tasks;
- adds the **Sliced** label to open tasks whose description starts with `Sized: one run`, since agents can't set labels themselves;
- comments CI results on the tasks waiting for them. It skips results nobody can act on: a commit a newer push replaced, a deleted branch, or a pull request that's already merged or closed. Waits registered with `paperclip-wait` are always delivered. Other results aren't posted when the task's agent already saw them: it was running when CI finished (for example waiting with `scripts/forge ci wait`) or has run since, because each comment wakes a run that resumes the task's whole session. CI is read from GitHub Actions with `gh`, or from a Forgejo for the repos configured that way;
- notes when a Forgejo repo's GitHub mirror of `main` has differed from Forgejo for over 15 minutes.

The steps that start agent runs pause while Claude usage is at or over the limits in `~/.paperclip-dev/claude-usage.json`: `gate.pauseAtPercent` for the 5-hour session and `gate.weekPauseAtPercent` for the week. When the session limit resets, the watchdog forgets its per-task cooldowns once, so tasks that stalled on the limit are picked up on the next run instead of hours later.

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

## The host side

`host/` holds everything that runs outside Paperclip:

| File | What it is |
|---|---|
| `watchdog.mjs` | The watchdog. `--dry-run` logs what it would do without changing anything. |
| `paperclip-wait` | Agents run `paperclip-wait ABC-123 --ci <branch or commit>` to register a CI wait. The watchdog comments on the task when CI finishes, which wakes its owner. It writes to the account's real home, not `$HOME`: agent runs set `HOME` to a per-run sandbox folder, and waits written there would never reach the watchdog. The Dependencies page shows the waits too. |
| `paperclip-notify` | Agents end a detached background job with `paperclip-notify ABC-123 "<result>"`. It posts a board comment that wakes the task's owner. |
| `paperclip-watchdog.service`, `.timer` | The systemd user units. |
| `config.example.json` | What goes in `~/.paperclip-dev/watchdog/config.json` (see below). |
| `install.sh` | Symlinks the scripts into `~/.local`, installs the units, and leaves the timer off at boot. |

The symlinks make this folder the live copy, so pulling changes updates the watchdog. Run `install.sh` again after changing the unit files. For the timer to run when nobody is logged in, turn on lingering: `sudo loginctl enable-linger $USER`.

### Config

The watchdog and `paperclip-wait` read `~/.paperclip-dev/watchdog/config.json`. Without a `companyId` the watchdog does nothing.

| Key | What it is |
|---|---|
| `companyId` | The Paperclip company to watch. |
| `repos` | Repos whose CI results go to tasks. `name` alone: GitHub Actions, read with `gh`. Add `forgejo: "owner/name"` when CI runs on a Forgejo, and `githubMirror` to check that its `main` is mirrored to GitHub. The first repo is `paperclip-wait`'s default. |
| `ghConfigDir` | The `gh` login to use, ideally one with a limited token. Default: `gh`'s own. |
| `forgejo` | `url` and `tokenFile`, a file holding a read-only token. `FORGE_URL` overrides the URL. |
| `claudeBin` | The `claude` CLI, used to renew the login. Default: `~/.local/bin/claude`. |
| `restartCommand` | How to restart Paperclip, as a list, e.g. `["bash", "-lc", "paperclip-stop && paperclip-start"]`. It should refuse to stop Paperclip while runs are live. Without it the watchdog never restarts Paperclip. |

Task identifiers like `ABC-123` in commit messages and branch names say which task a CI result is for.

The watchdog's own files are in `~/.paperclip-dev/watchdog/`:
- `watchdog.log`: every action.
- `status.json`: what the button reads.
- `state.json`: its memory between runs.
- `waits.json`: registered CI waits.
- `paused`: create this file to pause the watchdog.

## Development

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

Paperclip loads the plugin from this folder, so don't move it. `PAPERCLIP_WATCHDOG_DIR` points the worker at another folder, which the tests use.
