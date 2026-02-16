#!/bin/bash
# Install ArchFlow commands to ~/.claude/commands/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/claude/commands"
TARGET_DIR="$HOME/.claude/commands"

# Create target directory
mkdir -p "$TARGET_DIR/arch"

# Copy command files
cp "$SOURCE_DIR/arch/"*.md "$TARGET_DIR/arch/"

echo "ArchFlow installed to $TARGET_DIR/arch/"
echo ""
echo "Commands:"
echo "  /arch:explore       Explore codebase, produce context references"
echo "  /arch:prd <task>    Create Product Requirements Document"
echo "  /arch:design <task> Design technical architecture + phases"
echo "  /arch:phase <t> N   Design and implement phase N"
echo "  /arch:status [task] Check project status"
