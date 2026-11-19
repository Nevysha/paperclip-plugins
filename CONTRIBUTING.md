# Contributing

Thanks for helping. This repo holds several independent [Paperclip](https://github.com/paperclipai/paperclip) plugins, one per folder. Most changes touch one plugin. Keep them that way when you can.

## Before you start

- For a bug, open an issue with what you did, what you expected and what happened. Include the plugin, its version (in its `package.json`) and your Paperclip version.
- For a new plugin or a large change, open an issue first so we can agree on the approach before you write it.
- Small fixes (typos, docs, an obvious bug) can go straight to a pull request.

## Setup

Each plugin is its own pnpm package, with its own lockfile and its own SDK snapshot in `.paperclip-sdk/`. There is no workspace at the root: run commands inside the plugin's folder.

You need Node.js (current LTS) and pnpm.

```sh
cd <plugin>
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

To try it on a Paperclip instance, install it from its folder (see the [README](README.md#setup)). Paperclip loads the plugin from that folder, so don't move it after installing.

Some plugins have parts that run outside Paperclip. They have their own checks:

| Folder | Check |
| --- | --- |
| `watchdog/host/` | `node --test watchdog/host/*.test.mjs` |
| `fleet-cost/collector/` | `node --check fleet-cost/collector/collect.mjs` |

## Making a change

### Branches and pull requests

- Work on a branch, never on `main`. Every change reaches `main` through a pull request.
- Fork the repo if you don't have write access.
- Keep one topic per pull request. Two unrelated fixes are two pull requests.
- Rebase on `main` before asking for a review, and again if `main` moved and there's a conflict.
- A pull request needs one approving review before it can merge. Pushing new commits dismisses earlier approvals, so the last version is the one reviewed. `main` can't be pushed to directly or force-pushed.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), with the plugin folder as the scope:

```
fix(watchdog): report held tasks instead of recreating them as copies
feat(fleet-cost): let the collector send an API key and read an env file
refactor(plugins): read setup-specific values from config
```

- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.
- Scope: the plugin's folder name. For a change across several plugins, list them (`feat(decision-log,dependency-graph): ...`) or use `plugins`.
- The subject says what the change does for the user, in plain words, in the present tense, without a final period.
- The body says why. Wrap it at about 80 characters.
- The pull request title follows the same format. Pull requests are squash-merged, so the title becomes the commit on `main`.

### Versions

Each plugin has its own version, in two places that must match: `package.json` and `src/manifest.ts`.

- Bump it in any pull request that changes what the plugin does.
- Patch (`0.3.1` → `0.3.2`) for a fix, minor (`0.3.1` → `0.4.0`) for a new feature or anything that needs a step on upgrade. The plugins are pre-1.0, so a breaking change is a minor bump too.
- Docs, tests and refactors that change nothing for the user need no bump.

### Capabilities and upgrades

A plugin that asks for a new capability (in `capabilities` in `src/manifest.ts`) may fail to upgrade in place. When your change adds one:

- Say so in the pull request, under **Upgrading**.
- Add or update the plugin README's upgrade notes: uninstall without a purge, then install again. A purge deletes the plugin's state and settings.

Database migrations (`migrations/*.sql`) are append-only: add a new numbered file, never edit one that has been merged.

## No instance-specific values

The repo is public and serves any Paperclip instance. Don't commit:

- Company, project, agent or routine IDs, hostnames, repo names or local paths from your own instance.
- Tokens, API keys or anything read from a credentials file.

Values that differ between instances go in plugin settings (`instanceConfigSchema`) or in an uncommitted config file with a committed `*.example.json` beside it, as `claude-usage/setup.example.json` and `watchdog/host/config.example.json` do. Add the real file to the plugin's `.gitignore`.

## Code

- TypeScript, strict. `pnpm typecheck` must be clean.
- Add or update tests for the logic you change. Pure helpers are the easiest to test: keep the logic there and the Paperclip calls thin.
- Follow the style of the plugin you're in. Don't reformat code you aren't changing.
- Don't add a dependency for something a few lines can do. If you add one, say why in the pull request.

## Docs

Each plugin's README says what it does, what it needs to be set up, and how to develop it. Update it when your change affects any of that.

- Write for someone who uses Paperclip but hasn't read the code: short sentences, plain words, what they will see.
- When the UI changes visibly, update the screenshot in the plugin's `docs/` folder. Use the dark theme and a demo company, with no real names or IDs.
- If you add a plugin, add it to the list in the root [README](README.md) with a one-line description and a screenshot.

## Pull request description

The [template](.github/pull_request_template.md) fills in when you open a pull request. In short:

- **Why**: the problem, as a user would see it.
- **What changed**: what is different now, including defaults, settings and capabilities.
- **Upgrading**: any step needed on an existing instance, in order. Leave it out if there is none.
- **How to test**: the commands you ran and their results, and how to check it on an instance. Say plainly what you did not test.
- **Considered, not done**: known gaps and things left for later.

## AI-assisted contributions

AI-assisted changes are welcome. You are responsible for them as if you wrote them yourself:

- Read and understand every line before you open the pull request.
- Run the checks yourself and report the real results.
- Say in the pull request that AI was used, and keep the co-author trailer if your tool adds one.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
