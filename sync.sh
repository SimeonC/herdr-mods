#!/usr/bin/env bash
# Copies the live Herdr config (~/.config/herdr-app) into this repo's item
# folders, per items.conf. Never writes to the config. keys.json and the skills
# are hand-written in the repo and are not synced.
set -euo pipefail
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
REPO="$(cd "$(dirname "$0")" && pwd)"
EXCLUDES=(--exclude gpui-kit.d.ts --exclude jsconfig.json --exclude .DS_Store --exclude '*.error' --exclude node_modules)

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

synced_mods=()
while read -r item kind rest; do
  [[ -z "${item:-}" || "$item" == \#* ]] && continue
  for word in $rest; do
    case "$word" in
      keys) ;;
      layout:*)
        name="${word#layout:}"
        mkdir -p "$REPO/$item/layouts"
        cp "$HOME_DIR/layouts/$name.json" "$REPO/$item/layouts/$name.json"
        [[ -f "$HOME_DIR/layouts/$name.svg" ]] && cp "$HOME_DIR/layouts/$name.svg" "$REPO/$item/layouts/"
        echo "  layout: $name"
        ;;
      *)
        [[ -d "$HOME_DIR/mods/$word" ]] || { echo "missing live mod: $word" >&2; exit 1; }
        owner="$(owner_of "$word")"
        [[ " ${synced_mods[*]} " == *" $word "* ]] && continue
        synced_mods+=("$word")
        mkdir -p "$REPO/$owner/mods/$word"
        rsync -a --delete "${EXCLUDES[@]}" "$HOME_DIR/mods/$word/" "$REPO/$owner/mods/$word/"
        echo "  mod: $word -> $owner/"
        ;;
    esac
  done
done < "$REPO/items.conf"

echo "synced from $HOME_DIR"
