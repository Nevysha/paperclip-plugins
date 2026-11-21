# Claude Usage

A Paperclip plugin that shows your Claude subscription usage in the header, like `/usage` in Claude Code.
Click it for all windows and reset times, and to set which routines pause at a usage limit.

![The usage button in the header, open on a panel showing session and weekly usage with reset times, the pause limit and the routine checkboxes](docs/usage-panel.png)

The plugin reads the login in `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`), sends the token only to
`api.anthropic.com/api/oauth/usage`, and never returns or logs it. Results are cached for 2 minutes. It doesn't
refresh the login: when the token expires, running `claude` on this machine renews it.

The usage shown is for the account logged in to Claude Code on this machine.

Every 5 minutes it also writes `~/.paperclip-dev/claude-usage.json` (or `CLAUDE_USAGE_FILE`), with percentages, reset times and the settings below, so agents can check usage without touching the login or the local API.

## Pausing routines

The panel has two usage limits, one for the 5-hour session and one for the week, and a list of routines. Every 5 minutes, checked routines pause when either window reaches its limit, and resume when it drops. The weekly limit defaults to the session one until you set it. Both are published in `~/.paperclip-dev/claude-usage.json` (`gate.pauseAtPercent`, `gate.weekPauseAtPercent`), and the watchdog uses them too. This runs in the plugin, so it uses no Claude usage.

- A plugin can only pause routines it owns, so the routines are declared in the plugin itself, from `setup.json` (see below). New routines are created on the next check after a rebuild.
- Each company picks which of these routines it runs, with which assignee and project, in the plugin settings (see below). The plugin re-applies the assignee and project on every check.
- The limits are shared by the whole instance, and the panel shows them on every page. Which routines are checked is saved per company, so the routines show only on a company's pages.
- A routine you paused by hand stays paused. If you resume one while usage is over the limit, the next check pauses it again.
- If usage can't be read, routines the plugin paused resume, so a broken login can't silently stop them.
- It only stops new scheduled runs, not work already running.
- If you uninstall the plugin, its routines stay as they are, including any that are paused.

## Setup

The routines come from `setup.json` in this folder. It isn't committed: copy `setup.example.json` and fill it in. Without it the plugin still shows usage, with no routines to pause. The build turns it into `src/setup.generated.ts`, so rebuild after a change.

```json
{
  "companyId": "<company ID>",
  "projectId": "<project the routine tasks go in>",
  "timezone": "Europe/Paris",
  "routines": [
    {
      "key": "weekly-review",
      "title": "Weekly review",
      "description": "The instructions the agent gets at each run.",
      "label": "Every Monday",
      "cron": "0 9 * * 1",
      "assigneeAgentId": "<agent ID>",
      "defaultEnabled": true
    }
  ]
}
```

`key` is how Paperclip tracks a routine: changing it creates a new one. `defaultEnabled` is whether the limit pauses it until someone changes its checkbox.

`companyId`, `projectId` and each `assigneeAgentId` are the defaults for that one company. Leave them empty (`""`) if every company sets its own in the plugin settings.

`warnForMissingCompanySetting` is optional and `false` by default. See [Settings](#settings).

## Settings

Set them per company in the plugin settings, or with `POST /api/plugins/nevysha.claude-usage/config` and `{"companyId":"...","configJson":{...}}`. A change takes effect on the next check, without a rebuild.

| Setting | Default | Use |
| --- | --- | --- |
| `projectId` | `projectId` from `setup.json` for the `setup.json` company, else none | The project the managed routines file their tasks in. Without it, the company manages no routines, and the plugin logs a warning |
| `routines` | every routine with its `assigneeAgentId` for the `setup.json` company, else `[]` | A list of `{"key": "...", "assigneeAgentId": "..."}`; `key` is one of the keys in `setup.json` |

For example:

```json
{
  "projectId": "<project id>",
  "routines": [
    { "key": "weekly-review", "assigneeAgentId": "<agent id>" }
  ]
}
```

Set `"routines": []` to stop the `setup.json` company's routines through the settings.

The plugin runs its checks for every company, so it needs the `companies.read` capability.
Unattended checks need a config row for the company, or Paperclip denies them with "company context is required". A company without one is skipped. For the `setup.json` company, the plugin logs a warning once. Set `"warnForMissingCompanySetting": true` in `setup.json` to get the warning for every company. After a reinstall, set it with `POST /api/plugins/nevysha.claude-usage/config` and `{"companyId":"...","configJson":{}}`.

When a company's settings stop listing a routine that the plugin paused, the next check resumes it and stops managing it.

## Upgrading

### From 0.3

Version 0.4.0 adds the `companies.read` capability. Paperclip does not upgrade a plugin in place when it asks for a new capability, so the upgrade fails. Uninstall the plugin without a purge, then install it again:

```sh
paperclipai plugin uninstall nevysha.claude-usage
paperclipai plugin install ./claude-usage
```

Do not purge: do not use `paperclipai plugin uninstall --force` or `?purge=true` on the API. A purge deletes the plugin's state, its config and its managed routines. Routines the gate had paused then stay paused, and the next install creates duplicates of them.

Before 0.4.0 the checkboxes were saved for the whole instance. On the first check on 0.4.0, the `setup.json` company takes them over, so routines the gate had paused resume when usage drops. It needs no new settings. Keep `companyId` in `setup.json` until that first check has run. Without a `setup.json` company, no company takes the old checkboxes.

## Development

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

Paperclip loads the plugin from this folder, so don't move it.
