#!/usr/bin/env bash
# teardown.sh — Clean up after the demo.
# Stops daemons, removes the demo project directory.
# Does NOT touch ~/.coodra/ (your other projects' state stays intact).

set -euo pipefail

DEMO_DIR="$HOME/taskforge-demo"

echo "════════════════════════════════════════════════════════════════"
echo "  Coodra Demo Teardown"
echo "════════════════════════════════════════════════════════════════"
echo ""

echo "▸ Stopping Coodra daemons..."
coodra stop 2>/dev/null || true
echo ""

if [ -d "$DEMO_DIR" ]; then
  echo "▸ Removing demo project at $DEMO_DIR..."
  rm -rf "$DEMO_DIR"
fi
echo ""

echo "▸ ~/.coodra/ preserved (your other projects' state untouched)."
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  ✅ Teardown complete."
echo "════════════════════════════════════════════════════════════════"
