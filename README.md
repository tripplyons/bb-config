# bb config

This repo holds my bb configuration. bb stores its settings in `~/.bb/bb.db`, so the files here are the source of truth and `apply.sh` writes them into bb.

## Files

- `provider-acp/custom-agents.json`: the `customAgents` setting of the ACP providers plugin. Each entry becomes provider `acp-<id>`.
- `theme/tripp/theme.css`: the app theme. It sets an 18px base font and darker colors for both light and dark mode.
- `plugins/plugins.json`: every installed plugin, with its source and whether it is enabled. Run `./scripts/plugins.py export` after you change plugins in bb to update it.
- `scripts/plugins.py`: exports the plugin list from bb, or applies it. Apply installs missing plugins and enables or disables each one to match. It reports plugins that are installed but not in the file, and leaves them alone.
- `settings/`: other bb settings.
  - `general.json`: Settings → General preferences, such as keyboard hints and the default provider.
  - `experiments.json`: experiment toggles.
  - `ui.json`: UI preferences you have changed, such as sidebar layout. Preferences left at their defaults are not listed.
  - `keyboard.json`: keyboard shortcut overrides. An empty list means bb's default shortcuts.
  - `instructions.md`: custom instructions bb adds for every agent.
- `scripts/settings.py`: exports or applies the files in `settings/`.
- `export.sh`: copies the current plugin list and settings from bb into this repo. Run it after you change something in the bb app.
- `apply.sh`: copies the theme into `~/.bb/theme`, runs `bb theme set tripp`, and writes the ACP agents with `bb plugin config`.

## Export and apply

After you change plugins or settings in the bb app, save them here:

```sh
./export.sh
git diff
```

To push this repo's config into bb:

```sh
./apply.sh
bb provider list
```

## Agents

- `acp-antigravity`: Google Antigravity, run as `agy acp`. Install it with `brew install --cask antigravity-cli`, then sign in with `agy acp --login`.
