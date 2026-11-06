# Paperclip plugins

Private plugins for my local Paperclip instance.

## [`decision-log`](decision-log/README.md)

An in-app log of decisions agents made without asking, with founder review.

![The Decision Log page, showing an entry by the Product Owner with its question, answer, reasoning and sources](decision-log/docs/decision-log.png)

## [`claude-usage`](claude-usage/README.md)

Claude subscription usage in the header, plus a limit that pauses the routines you choose without using any Claude usage.

![The usage button in the header, open on a panel showing session and weekly usage with reset times, the pause limit and the routine checkboxes](claude-usage/docs/usage-panel.png)

## Setup

Each plugin is its own package. Paperclip loads it from its folder, so after a fresh clone, run this in the folder and then install it:

```sh
pnpm install && pnpm build
curl -X POST http://localhost:3100/api/plugins/install -H 'content-type: application/json' \
  -d "{\"packageName\":\"$PWD\",\"isLocalPath\":true}"
```

`.paperclip-sdk/` holds the SDK snapshots each plugin builds against, so a clone builds without a Paperclip checkout.
