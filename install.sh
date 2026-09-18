#!/bin/sh
set -eu

command -v node >/dev/null 2>&1 || { echo "Error: Node.js 22+ is required" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || {
  echo "Error: Node.js 22+ is required" >&2
  exit 1
}

REPO=${CFCTL_REPO:-Xichun123/cfctl}
REF=${CFCTL_REF:-main}
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd || true)
TEMP_DIR=

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/skills/cfctl/SKILL.md" ]; then
  ROOT=$SCRIPT_DIR
else
  command -v curl >/dev/null 2>&1 || { echo "Error: curl is required" >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo "Error: tar is required" >&2; exit 1; }
  TEMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$REF.tar.gz" |
    tar -xz -C "$TEMP_DIR" --strip-components=1
  ROOT=$TEMP_DIR
fi

SKILL_HOME=${CFCTL_SKILL_HOME:-"$HOME/.agents/skills/cfctl"}
BIN_DIR=${CFCTL_BIN_DIR:-"$HOME/.local/bin"}
mkdir -p "$SKILL_HOME" "$BIN_DIR"
cp -R "$ROOT/skills/cfctl/." "$SKILL_HOME/"
chmod +x "$SKILL_HOME/scripts/cfctl.mjs"
ln -sfn "$SKILL_HOME/scripts/cfctl.mjs" "$BIN_DIR/cfctl"

printf 'Installed skill: %s\nInstalled CLI:   %s/cfctl\n' "$SKILL_HOME" "$BIN_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH before running cfctl.\n' "$BIN_DIR" ;;
esac
