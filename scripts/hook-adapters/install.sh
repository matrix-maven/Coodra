#!/usr/bin/env bash
# Coodra hook-adapter installer.
#
# Copies the per-agent shell adapters into the IDE's hooks directory:
#   - Windsurf: ~/.windsurf/hooks/coodra.sh
#   - Cursor:   .cursor/hooks/coodra.sh (in the repo root)
#
# Module 03 ships these as static files; Module 08a CLI will provide
# a richer `coodra init` UX that does the same thing + writes
# `.coodra.json` + sets up `.env`.
#
# Run from the repo root: `bash scripts/hook-adapters/install.sh`.

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WINDSURF_TARGET="$HOME/.windsurf/hooks/coodra.sh"
CURSOR_TARGET="$REPO_ROOT/.cursor/hooks/coodra.sh"

# --- Windsurf ---------------------------------------------------------
if [ -d "$HOME/.windsurf" ]; then
  mkdir -p "$(dirname "$WINDSURF_TARGET")"
  cp "$SCRIPT_DIR/windsurf-coodra.sh" "$WINDSURF_TARGET"
  chmod +x "$WINDSURF_TARGET"
  printf '✓ installed Windsurf adapter → %s\n' "$WINDSURF_TARGET"
else
  printf '⊘ skipped Windsurf adapter (~/.windsurf not present; install Windsurf first)\n'
fi

# --- Cursor -----------------------------------------------------------
mkdir -p "$(dirname "$CURSOR_TARGET")"
cp "$SCRIPT_DIR/cursor-coodra.sh" "$CURSOR_TARGET"
chmod +x "$CURSOR_TARGET"
printf '✓ installed Cursor adapter → %s\n' "$CURSOR_TARGET"

printf '\n'
printf 'NEXT STEPS\n'
printf '  1. Set LOCAL_HOOK_SECRET in your shell or .env (openssl rand -hex 24)\n'
printf '  2. Start the hooks bridge: pnpm --filter @coodra/hooks-bridge dev\n'
printf '  3. Trigger a hook from your IDE — tail the bridge log to confirm.\n'
