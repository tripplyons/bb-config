#!/usr/bin/env python3
"""Sync bb plugins with plugins/plugins.json.

export: write the installed plugins and their enabled state to the file.
apply:  install missing plugins, then enable or disable each one to match.
Plugins installed in bb but absent from the file are left alone and reported.
"""
import json
import subprocess
import sys
from pathlib import Path

FILE = Path(__file__).resolve().parent.parent / "plugins" / "plugins.json"


def bb(*args, capture=False):
    if capture:
        return subprocess.run(["bb", *args], check=True, capture_output=True, text=True).stdout
    subprocess.run(["bb", *args], check=True)


def installed():
    data = json.loads(bb("plugin", "list", "--json", capture=True))
    return {p["id"]: p for p in data["plugins"]}


def export():
    plugins = {
        pid: {"source": p["source"], "enabled": p["enabled"]}
        for pid, p in sorted(installed().items())
    }
    FILE.write_text(json.dumps(plugins, indent=2) + "\n")
    print(f"Wrote {len(plugins)} plugins to {FILE}")


def apply():
    wanted = json.loads(FILE.read_text())
    current = installed()
    for pid, spec in wanted.items():
        if pid not in current:
            print(f"Installing {pid} from {spec['source']}")
            bb("plugin", "install", spec["source"])
            current = installed()
            if pid not in current:
                sys.exit(f"{pid} is still missing after install")
        if current[pid]["enabled"] != spec["enabled"]:
            action = "enable" if spec["enabled"] else "disable"
            print(f"{action.capitalize()} {pid}")
            bb("plugin", action, pid)
    for pid in sorted(set(current) - set(wanted)):
        print(f"Not tracked: {pid} (run ./scripts/plugins.py export to add it)")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "export":
        export()
    elif cmd == "apply":
        apply()
    else:
        sys.exit("usage: plugins.py export|apply")
