# Claude Usage

A Paperclip plugin that shows your Claude subscription usage in the header, like `/usage` in Claude Code.
Click it for all windows and reset times, and to set which routines pause at a usage limit.

![The usage button in the header, open on a panel showing session and weekly usage with reset times, the pause limit and the routine checkboxes](docs/usage-panel.png)

The plugin reads the login in `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`), sends the token only to
`api.anthropic.com/api/oauth/usage`, and never returns or logs it. Results are cached for 2 minutes.

The token lasts about 8 hours. When it has less than 15 minutes left, the plugin renews it by running
`claude auth status` (`CLAUDE_BIN`, else `~/.local/bin/claude`, else `claude` on the `PATH`), which swaps it for a new
one with the stored refresh token. That makes no model call and uses no usage. If renewing fails, it tries again
5 minutes later and the panel says to sign in; running `claude` on this machine fixes it.

The usage shown is for the account logged in to Claude Code on this machine.

Every 5 minutes it also writes `~/.paperclip-dev/claude-usage.json` (or `CLAUDE_USAGE_FILE`), with percentages, reset times and the settings below, so agents can check usage without touching the login or the local API.

## Pausing routines

The panel has two usage limits, one for the 5-hour session and one for the week, and a list of routines. Every 5 minutes, checked routines pause when either window reaches its limit, and resume when it drops. The weekly limit defaults to the session one until you set it. Both are published in `~/.paperclip-dev/claude-usage.json` (`gate.pauseAtPercent`, `gate.weekPauseAtPercent`), for other local tools to use. This runs in the plugin, so it uses no Claude usage.

- A plugin can only pause routines it owns, so the routines are declared in the plugin itself, from `setup.json` (see below). New routines are created on the next check after a rebuild.
- A routine you paused by hand stays paused. If you resume one while usage is over the limit, the next check pauses it again.
- If usage can't be read, routines the plugin paused resume, so a broken login can't silently stop them.
- It only stops new scheduled runs, not work already running.
- If you uninstall the plugin, its routines stay as they are, including any that are paused.
- Unattended checks need a config row for the company, or Paperclip denies them with "company context is required". After a reinstall, set it with `POST /api/plugins/nevysha.claude-usage/config` and `{"companyId":"...","configJson":{}}`.

## Setup

The routines, and the company, project and agents they belong to, come from `setup.json` in this folder. It isn't committed: copy `setup.example.json` and fill it in. Without it the plugin still shows usage, with no routines to pause. The build turns it into `src/setup.generated.ts`, so rebuild after a change.

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

## Development

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

Paperclip loads the plugin from this folder, so don't move it.
