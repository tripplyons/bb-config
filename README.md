# bb config

This repo holds my bb configuration. bb stores its settings in `~/.bb/bb.db`, so the files here are the source of truth and `apply.sh` writes them into bb.

## Files

- `provider-acp/custom-agents.json`: the `customAgents` setting of the ACP providers plugin. Each entry becomes provider `acp-<id>`.
- `theme/tripp/theme.css`: the app theme. It sets an 18px base font and darker colors for both light and dark mode.
- `apply.sh`: copies the theme into `~/.bb/theme`, runs `bb theme set tripp`, and writes the ACP agents with `bb plugin config`.

## Apply

```sh
./apply.sh
bb provider list
```

## Agents

- `acp-antigravity`: Google Antigravity, run as `agy acp`. Install it with `brew install --cask antigravity-cli`, then sign in with `agy acp --login`.
