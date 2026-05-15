#!/usr/bin/env bash
# setup.sh — One-shot demo project creation.
# Run this 2 minutes BEFORE the presentation.
# Idempotent: safe to re-run. Wipes prior demo state.

set -euo pipefail

DEMO_DIR="$HOME/taskforge-demo"
PRESENTATION_DIR="/Users/abishaikc/Coodra/presentation"
FEATURE_PACK_SRC="$PRESENTATION_DIR/taskforge-feature-pack"

echo "════════════════════════════════════════════════════════════════"
echo "  Coodra Demo Setup"
echo "════════════════════════════════════════════════════════════════"
echo ""

# 1. Stop any running daemons (in case prior demo left them up)
echo "▸ Stopping any running Coodra daemons..."
coodra stop 2>/dev/null || true
echo ""

# 2. Wipe prior demo state (the project directory only — DB stays)
if [ -d "$DEMO_DIR" ]; then
  echo "▸ Removing prior demo directory at $DEMO_DIR..."
  rm -rf "$DEMO_DIR"
fi

# 3. Create fresh empty project
echo "▸ Creating fresh empty project at $DEMO_DIR..."
mkdir -p "$DEMO_DIR"
cd "$DEMO_DIR"
git init --quiet
echo ""

# 4. Run coodra init
echo "▸ Running coodra init..."
echo "────────────────────────────────────────────────────────────────"
coodra init
echo "────────────────────────────────────────────────────────────────"
echo ""

# 5. Replace the auto-seeded Feature Pack with the rich pre-written one
echo "▸ Installing the pre-written taskforge Feature Pack..."
PACK_DEST="$DEMO_DIR/docs/feature-packs/taskforge-demo"
rm -rf "$PACK_DEST"
mkdir -p "$PACK_DEST"
cp "$FEATURE_PACK_SRC/spec.md" "$PACK_DEST/spec.md"
cp "$FEATURE_PACK_SRC/implementation.md" "$PACK_DEST/implementation.md"
cp "$FEATURE_PACK_SRC/techstack.md" "$PACK_DEST/techstack.md"
cp "$FEATURE_PACK_SRC/meta.json" "$PACK_DEST/meta.json"
echo "  + $PACK_DEST/spec.md"
echo "  + $PACK_DEST/implementation.md"
echo "  + $PACK_DEST/techstack.md"
echo "  + $PACK_DEST/meta.json"
echo ""

# 5b. (REMOVED — Slice 6 / 2026-05-03 audit cleanup.) Pre-Fix-F this block
# patched the default policy via raw SQL because ensureDefaultPolicy seeded
# only Write+Edit rules; MultiEdit/NotebookEdit slipped through. Phase 4
# Fix F (commit a638dca) expanded ensureDefaultPolicy to 25 rules covering
# every file-mutating tool against {.env, **/.env, .git/**, **/.git/**,
# node_modules/**, **/node_modules/**} natively, making this hand-rolled
# block redundant. The block was also non-idempotent (no WHERE NOT EXISTS,
# no UNIQUE constraint on policy_rules at the schema level pre-Slice-7),
# so re-running setup.sh produced 3 duplicate priority-1 rows per re-run.
# After 3 runs the demo DB carried 9 rows where 3 was the intent.
#
# To clean up the existing duplicates on a machine that ran setup.sh
# multiple times pre-Slice-6:
#   sqlite3 ~/.coodra/data.db \
#     "DELETE FROM policy_rules WHERE id NOT IN (
#        SELECT MIN(id) FROM policy_rules
#        GROUP BY policy_id, priority, match_event_type, match_tool_name, match_path_glob
#      );"
# Slice 7 will turn that grouping into a UNIQUE index so future raw-SQL
# adventurism cannot reintroduce duplicates.

# 6. Start daemons
echo "▸ Starting Coodra daemons..."
echo "────────────────────────────────────────────────────────────────"
coodra start
echo "────────────────────────────────────────────────────────────────"
echo ""

# 7. Run doctor to confirm health
echo "▸ Running coodra doctor..."
echo "────────────────────────────────────────────────────────────────"
coodra doctor
echo "────────────────────────────────────────────────────────────────"
echo ""

# 8. Final instructions
echo "════════════════════════════════════════════════════════════════"
echo "  ✅ Demo ready."
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "  Project location:    $DEMO_DIR"
echo "  Feature Pack:        $PACK_DEST"
echo ""
echo "  Next steps:"
echo "    1. Open a SECOND terminal and run:"
echo "         cd $DEMO_DIR && coodra logs hooks --follow"
echo ""
echo "    2. In a THIRD terminal (or your IDE), open Claude Code in:"
echo "         $DEMO_DIR"
echo ""
echo "    3. In Claude Code, run:  /mcp"
echo "       (you should see 'coodra' connected with all 9 tools)"
echo ""
echo "    4. Follow CLAUDE_PROMPTS.md, pasting prompts in order."
echo ""
echo "════════════════════════════════════════════════════════════════"
