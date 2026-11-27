#!/bin/sh
# Apply the config in this repo to the local bb install.
set -eu
cd "$(dirname "$0")"

# Plugins: install missing ones and match enabled state
./scripts/plugins.py apply

# General, experiment, UI, keyboard and custom-instruction settings
./scripts/settings.py apply

# ACP custom agents
agents=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), separators=(",", ":")))' provider-acp/custom-agents.json)
bb plugin config provider-acp set customAgents "$agents"

# App theme
theme_dir=$(bb theme dir)
for t in theme/*/; do
  name=$(basename "$t")
  mkdir -p "$theme_dir/$name"
  cp "$t"* "$theme_dir/$name/"
done
bb theme set tripp

# User skills
skills_dir="$(dirname "$theme_dir")/skills"
mkdir -p "$skills_dir"
for s in skills/*/; do
  [ -d "$s" ] || continue
  name=$(basename "$s")
  rm -rf "$skills_dir/$name"
  cp -R "${s%/}" "$skills_dir/$name"
done
