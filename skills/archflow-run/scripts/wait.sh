#!/usr/bin/env bash
# Runs a command in the background and waits on it in slices of about four minutes, so a sub-agent that needs a long
# command's result keeps its prompt cache warm: the cache lasts about five minutes, and each slice that returns gives
# the agent a turn that refreshes it.
#
#   bash wait.sh run '<command>'    start the command in the current directory, then wait one slice
#   bash wait.sh wait <handle>      wait one more slice on a command still running
#
# `run` first prints the handle and its continuation line, so a call cut off early can still be continued. The command
# runs with pipefail, stdin from /dev/null, and output in <handle>/log; the runner's pid is in <handle>/pid (detached
# into its own session where `setsid` exists). A slice that sees the command finish prints `exit=<code>`, the log path
# and the output's tail, and exits with the command's status. If the runner is gone without recording a status, it
# prints `exit=unknown` with the tail and exits 125. Otherwise it prints `running` with the line to run next, and exits
# 0. Give the Bash call a timeout above the slice (300000 ms covers the default).
# ARCHFLOW_WAIT_SLICE overrides the slice in seconds.
set -u
slice=${ARCHFLOW_WAIT_SLICE:-240}
self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")

case "${1:-}" in
  run)
    [ $# -eq 2 ] || { echo "usage: wait.sh run '<command>'"; exit 2; }
    handle=$(mktemp -d "${TMPDIR:-/tmp}/archflow-wait.XXXXXX") || exit 2
    printf '%s\n' "$2" > "$handle/command"
    echo "handle=$handle; continue with: bash '$self' wait '$handle'"
    detach=
    if command -v setsid > /dev/null 2>&1; then detach=setsid; fi
    # The exit file appears only after the command ends, holding the command's own status.
    $detach nohup bash -c 'echo $$ > "$1/pid"
      bash -o pipefail "$1/command" > "$1/log" 2>&1 < /dev/null; echo $? > "$1/exit.tmp"; mv "$1/exit.tmp" "$1/exit"' \
      wait-run "$handle" > /dev/null 2>&1 &
    ;;
  wait)
    [ $# -eq 2 ] && [ -f "$2/command" ] || { echo "usage: wait.sh wait <handle from a run slice>"; exit 2; }
    handle=$2
    ;;
  *) echo "usage: wait.sh run '<command>' | wait.sh wait <handle>"; exit 2 ;;
esac

finished() { [ -f "$handle/exit" ]; }
# A runner that has not written its pid yet has only just started.
alive() { [ ! -f "$handle/pid" ] || kill -0 "$(cat "$handle/pid")" 2> /dev/null; }

end=$((SECONDS + slice))
while ! finished && alive && [ "$SECONDS" -lt "$end" ]; do sleep 2; done

if finished; then
  echo "exit=$(cat "$handle/exit") log=$handle/log"
  tail -n 40 "$handle/log"
  exit "$(cat "$handle/exit")"
elif alive; then
  echo "running after ${slice}s; continue with: bash '$self' wait '$handle'"
  tail -n 5 "$handle/log"
else
  echo "exit=unknown: the runner stopped without recording a status log=$handle/log"
  tail -n 40 "$handle/log"
  exit 125
fi
