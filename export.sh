#!/bin/sh
# Copy the current bb plugin list and settings into this repo.
# The theme and ACP agents are edited here by hand, so they are not exported.
set -eu
cd "$(dirname "$0")"
./scripts/plugins.py export
./scripts/settings.py export
