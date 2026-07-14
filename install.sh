#!/bin/bash
# Install shared ArchFlow skills for Claude Code and Codex.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SOURCE_DIR="$SCRIPT_DIR/skills"
CLAUDE_TARGET_DIR="$HOME/.claude/skills"
CODEX_TARGET_DIR="$HOME/.agents/skills"

install_claude=true
install_codex=true

case "${1:-}" in
  "") ;;
  --claude) install_codex=false ;;
  --codex) install_claude=false ;;
  --help|-h)
    echo "Usage: ./install.sh [--claude|--codex]"
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    echo "Usage: ./install.sh [--claude|--codex]" >&2
    exit 1
    ;;
esac

if [ "$install_claude" = true ]; then
  mkdir -p "$CLAUDE_TARGET_DIR"
  cp -R "$SKILLS_SOURCE_DIR/." "$CLAUDE_TARGET_DIR/"
  echo "ArchFlow Claude Code skills installed to $CLAUDE_TARGET_DIR/"
fi

if [ "$install_codex" = true ]; then
  mkdir -p "$CODEX_TARGET_DIR"
  cp -R "$SKILLS_SOURCE_DIR/." "$CODEX_TARGET_DIR/"
  echo "ArchFlow Codex skills installed to $CODEX_TARGET_DIR/"
fi

echo ""
if [ "$install_claude" = true ]; then
  echo "Claude Code: /archflow-explore, /archflow-prd, /archflow-design, /archflow-phase, /archflow-status"
fi
if [ "$install_codex" = true ]; then
  echo 'Codex: $archflow-explore, $archflow-prd, $archflow-design, $archflow-phase, $archflow-status'
  echo "Restart Codex if the skills do not appear immediately."
fi
