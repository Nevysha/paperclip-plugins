# Claude Usage

A Paperclip plugin that shows your Claude subscription usage in the header, like `/usage` in Claude Code.
Click it for all windows and reset times.

The plugin reads the login in `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`), sends the token only to
`api.anthropic.com/api/oauth/usage`, and never returns or logs it. Results are cached for 2 minutes. It doesn't
refresh the login: when the token expires, running `claude` on this machine renews it.

The usage shown is for the account logged in to Claude Code on this machine.

## Development

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

Paperclip loads the plugin from this folder, so don't move it.
