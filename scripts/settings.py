#!/usr/bin/env python3
"""Sync bb settings with the files in settings/.

Files:
  settings/general.json      Settings -> General preferences
  settings/experiments.json  experiment toggles
  settings/ui.json           UI preferences changed from their defaults
  settings/keyboard.json     keyboard shortcut overrides
  settings/instructions.md   custom instructions given to every agent

export: write the current bb values to those files.
apply:  change bb to match the files. Only values that differ are written.
"""
import json
import subprocess
import sys
from pathlib import Path

DIR = Path(__file__).resolve().parent.parent / "settings"

# Values that record what happened on this machine rather than a preference.
GENERAL_SKIP = {"onboardingCompletedAt"}


def bb(*args):
    out = subprocess.run(["bb", *args], check=True, capture_output=True, text=True).stdout
    return json.loads(out) if "--json" in args else out


def show():
    return bb("settings", "show", "--json")


def current_ui():
    """UI preferences that have been set at least once (revision > 0)."""
    prefs = bb("settings", "ui", "list", "--json")["preferences"]
    return {k: p["value"] for k, p in prefs.items() if p["revision"] > 0}


def write(name, value):
    (DIR / name).write_text(json.dumps(value, indent=2) + "\n")


def read(name):
    return json.loads((DIR / name).read_text())


def export():
    s = show()
    write("general.json", {k: v for k, v in s["generalSettings"].items() if k not in GENERAL_SKIP})
    write("experiments.json", s["experiments"])
    write("ui.json", current_ui())
    write("keyboard.json", s["keybindingOverrides"])
    (DIR / "instructions.md").write_text(bb("instructions", "get", "--json")["instructions"])
    print(f"Exported settings to {DIR}")


def as_arg(value):
    return value if isinstance(value, str) else json.dumps(value)


def shortcut_arg(shortcut):
    if shortcut is None:
        return "disabled"
    mods = [m for m in ("mod", "control", "meta", "alt", "shift") if shortcut.get(m)]
    return "+".join(mods + [shortcut["key"]])


def apply():
    s = show()

    for key, value in read("general.json").items():
        if s["generalSettings"].get(key) != value:
            print(f"general {key} = {as_arg(value)}")
            bb("settings", "general", key, as_arg(value))

    for key, value in read("experiments.json").items():
        if s["experiments"].get(key) != value:
            print(f"experiment {key} = {as_arg(value)}")
            bb("settings", "experiment", key, as_arg(value))

    wanted_ui, have_ui = read("ui.json"), current_ui()
    for key, value in wanted_ui.items():
        if have_ui.get(key) != value:
            print(f"ui {key} = {as_arg(value)}")
            bb("settings", "ui", "set", key, as_arg(value))
    for key in set(have_ui) - set(wanted_ui):
        print(f"ui {key} reset")
        bb("settings", "ui", "reset", key)

    wanted_keys = read("keyboard.json")
    if s["keybindingOverrides"] != wanted_keys:
        print("keyboard: replacing overrides")
        bb("settings", "keyboard", "reset")
        for o in wanted_keys:
            args = ["settings", "keyboard", "set", o["command"], shortcut_arg(o["shortcut"])]
            if o.get("platform"):
                args += ["--platform", o["platform"]]
            bb(*args)

    wanted_text = (DIR / "instructions.md").read_text()
    if bb("instructions", "get", "--json")["instructions"] != wanted_text:
        print("instructions: updating")
        if wanted_text.strip():
            bb("instructions", "set", wanted_text)
        else:
            bb("instructions", "clear")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "export":
        export()
    elif cmd == "apply":
        apply()
    else:
        sys.exit("usage: settings.py export|apply")
