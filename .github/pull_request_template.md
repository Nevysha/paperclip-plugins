<!--
Title: type(plugin): what the change does, e.g. "fix(watchdog): report held tasks instead of recreating them as copies".
Pull requests are squash-merged, so the title becomes the commit on main.
Delete any section that doesn't apply. See CONTRIBUTING.md for details.
-->

## Why

<!-- The problem this solves, as a user would see it. Link the issue if there is one (Fixes #123). -->

## What changed

<!-- What is different now. Mention new settings and their defaults, new capabilities, and anything removed. -->

-

## Upgrading

<!--
Steps needed on an existing instance, in order. Delete this section if there are none.
A new capability: uninstall without a purge, then install again.
-->

## How to test

<!-- The commands you ran and their results. Then how to check it on an instance. Say plainly what you didn't test. -->

```sh
cd <plugin>
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

Results:

## Considered, not done

<!-- Known gaps, edge cases left for later, alternatives you rejected. Delete this section if there are none. -->

## Checklist

- [ ] One topic, rebased on `main`
- [ ] `pnpm typecheck`, `pnpm test` and `pnpm build` pass in each plugin I changed
- [ ] Version bumped in `package.json` and `src/manifest.ts` (if the plugin's behaviour changed)
- [ ] README updated, and the screenshot if the UI changed visibly
- [ ] No instance-specific IDs, hostnames, paths or secrets
- [ ] AI assistance, if any, is disclosed below and I reviewed every line

<!-- e.g. "Most of this change was written with AI assistance (Claude Code), then reviewed and tested." -->
