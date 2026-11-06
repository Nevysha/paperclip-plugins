# Paperclip plugins

Private plugins for my local Paperclip instance.

- [`decision-log`](decision-log/README.md): an in-app log of decisions agents made without asking, with founder review.
- [`claude-usage`](claude-usage/README.md): Claude subscription usage in the header.

Each plugin is its own package. Paperclip loads it from its folder, so after a fresh clone, run this in the folder and then install it:

```sh
pnpm install && pnpm build
curl -X POST http://localhost:3100/api/plugins/install -H 'content-type: application/json' \
  -d "{\"packageName\":\"$PWD\",\"isLocalPath\":true}"
```

`.paperclip-sdk/` holds the SDK snapshots each plugin builds against, so a clone builds without a Paperclip checkout.
