#!/usr/bin/env bash
# Prints how many tokens the calling Claude Code session's context holds, so an orchestrator can hand off by size.
#
#   bash context.sh            ->  context: 182073 tokens
#
# The figure is what the session's last request sent: its input, cached or not. It comes from the session's own
# transcript, found through CLAUDE_CODE_SESSION_ID, which Claude Code sets for the commands a session runs. Neither
# the variable nor the transcript's format is documented, so when either is missing or reads differently the script
# says so and exits 1, and the caller falls back to counting merged tasks. It never guesses a number.
#
# A sub-agent's commands carry the parent session's id, so this reports the orchestrator's context wherever it runs.
#
# Everything runs inside main, called on the last line: bash reads a script as it goes, so a copy still running when an
# install or an edit rewrites this file would otherwise continue at its old position in the new bytes.
set -u

main() {
  id=${CLAUDE_CODE_SESSION_ID:-}
  [ -n "$id" ] || { echo "context: unknown (CLAUDE_CODE_SESSION_ID is not set)"; exit 1; }
  case $id in */* | *..*) echo "context: unknown (unexpected session id)"; exit 1 ;; esac
  root=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects
  transcript=
  for candidate in "$root"/*/"$id".jsonl; do
    [ -f "$candidate" ] && { transcript=$candidate; break; }
  done
  [ -n "$transcript" ] || { echo "context: unknown (no transcript for this session under $root)"; exit 1; }
  # One record per line. A line still being written does not parse and is skipped; sub-agent records are not counted.
  tokens=$(jq -R -r 'fromjson? | select(.type == "assistant" and .isSidechain != true) | .message.usage
      | select(type == "object")
      | (.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)' \
    "$transcript" 2> /dev/null | tail -n 1)
  case $tokens in
    '' | *[!0-9]*) echo "context: unknown (no usage record in the transcript)"; exit 1 ;;
  esac
  echo "context: $tokens tokens"
}

main "$@"
