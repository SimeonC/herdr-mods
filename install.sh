#!/usr/bin/env bash
# Installs every item in this repo into ~/.config/herdr-app, then the skills into
# ~/.claude/skills. Mods and layouts are copied (not linked); anything replaced
# is backed up under ~/.config/herdr-app/backups/. Keys are merged: a binding you
# already have is never replaced. Herdr hot-reloads; afterwards run
#   herdr-app check ~/.config/herdr-app/mods/<name>
set -euo pipefail
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
REPO="$(cd "$(dirname "$0")" && pwd)"
BK="$HOME_DIR/backups/install-$(date +%Y%m%d%H%M%S)"
EXCLUDES=(--exclude gpui-kit.d.ts --exclude jsconfig.json --exclude .DS_Store --exclude '*.error' --exclude node_modules)

mkdir -p "$HOME_DIR/mods" "$HOME_DIR/layouts"

backup() { # backup <src> <path under BK>
  [[ -e "$1" ]] || return 0
  mkdir -p "$BK/$(dirname "$2")"
  cp -R "$1" "$BK/$2"
}

# The item folder that owns a mod: the one named after it, else the first with mods/<mod>.
owner_of() {
  local mod="$1" item
  [[ -d "$REPO/$mod/mods/$mod" ]] && { echo "$mod"; return; }
  for item in "$REPO"/*/; do
    [[ -d "${item}mods/$mod" ]] && { basename "$item"; return; }
  done
  echo "missing mod: $mod" >&2
  exit 1
}

installed_mods=()
while read -r item kind rest; do
  [[ -z "${item:-}" || "$item" == \#* ]] && continue
  for word in $rest; do
    case "$word" in
      keys)
        [[ -f "$REPO/$item/keys.json" ]] || continue
        backup "$HOME_DIR/keys.json" keys.json
        python3 - "$HOME_DIR/keys.json" "$REPO/$item/keys.json" "$item" <<'PY'
import json, sys
live_path, item_path, item = sys.argv[1], sys.argv[2], sys.argv[3]

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}

live = load(live_path)
for section, binds in load(item_path).items():
    target = live.setdefault(section, {})
    for key, action in binds.items():
        if key not in target:
            target[key] = action
            print(f"  keys: added {section}.{key} -> {action}")
        elif target[key] != action:
            print(f"  keys: kept yours, {item} wants {section}.{key} -> {action} (yours: {target[key]})")
with open(live_path, "w") as f:
    json.dump(live, f, indent=2)
    f.write("\n")
PY
        ;;
      layout:*)
        name="${word#layout:}"
        [[ -f "$REPO/$item/layouts/$name.json" ]] || { echo "missing layout: $item/layouts/$name.json" >&2; exit 1; }
        backup "$HOME_DIR/layouts/$name.json" "layouts/$name.json"
        cp "$REPO/$item/layouts/$name.json" "$HOME_DIR/layouts/$name.json"
        [[ -f "$REPO/$item/layouts/$name.svg" ]] && cp "$REPO/$item/layouts/$name.svg" "$HOME_DIR/layouts/$name.svg"
        echo "  layout: $name"
        ;;
      *)
        owner="$(owner_of "$word")"
        [[ " ${installed_mods[*]} " == *" $word "* ]] && continue
        installed_mods+=("$word")
        backup "$HOME_DIR/mods/$word" "mods/$word"
        mkdir -p "$HOME_DIR/mods/$word"
        rsync -a --delete "${EXCLUDES[@]}" "$REPO/$owner/mods/$word/" "$HOME_DIR/mods/$word/"
        echo "  mod: $word (from $owner/)"
        ;;
    esac
  done
done < "$REPO/items.conf"

if [[ -d "$REPO/skills" ]]; then
  for skill in "$REPO"/skills/*/; do
    name="$(basename "$skill")"
    mkdir -p "$SKILLS_DIR/$name"
    rsync -a --delete "$skill" "$SKILLS_DIR/$name/"
    echo "  skill: $name -> $SKILLS_DIR/$name"
  done
fi

[[ -d "$BK" ]] && echo "backups: $BK"
echo "installed into $HOME_DIR"
echo "check each mod with: herdr-app check ~/.config/herdr-app/mods/<name>"
