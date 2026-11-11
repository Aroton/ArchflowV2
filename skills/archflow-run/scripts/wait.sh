#!/usr/bin/env bash
# Runs a command in the background and waits on it in slices of about four minutes, so a sub-agent that needs a long
# command's result keeps its prompt cache warm: the cache lasts about five minutes, and each slice that returns gives
# the agent a turn that refreshes it.
#
#   bash wait.sh run '<command>'    start the command in the current directory, then wait one slice
#   bash wait.sh wait <handle>      wait one more slice on a command still running
#   bash wait.sh stop <handle>      stop a stuck command and everything it started
#
# `run` first prints the handle and its continuation line, so a call cut off early can still be continued. The command
# runs with pipefail, stdin from /dev/null, and output in <handle>/log; the runner's pid is in <handle>/pid (detached
# into its own session where `setsid` exists). A slice that sees the command finish prints `exit=<code>`, the log path
# and the output's tail, and exits with the command's status. If the runner is gone without recording a status, it
# prints `exit=unknown` with the tail and exits 125. Otherwise it prints `running` with the line to run next, and exits
# 0. `stop` ends the runner, the command and their children; a later `wait` then reports `exit=unknown`. Give the Bash
# call a timeout above the slice (300000 ms covers the default).
# ARCHFLOW_WAIT_SLICE overrides the slice in seconds.
#
# Handles live in the temp directory and nobody comes back for them, so each `run` also deletes this user's handles
# that were last touched more than a day ago and whose command has finished or whose runner is gone.
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
    # The pid file is moved into place whole: a reader never sees it empty and mistakes a starting runner for a dead one.
    [ -n "$detach" ] && : > "$handle/detached"
    $detach nohup bash -c 'echo $$ > "$1/pid.tmp"; mv "$1/pid.tmp" "$1/pid"
      bash -o pipefail "$1/command" > "$1/log" 2>&1 < /dev/null; echo $? > "$1/exit.tmp"; mv "$1/exit.tmp" "$1/exit"' \
      wait-run "$handle" > /dev/null 2>&1 &
    # Sweep old handles after the command has started, so the sweep never delays it. Only a real directory with a
    # handle's shape is removed; one whose runner is still alive is kept however old it is.
    find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'archflow-wait.*' -user "$(id -u)" -mmin +1440 2> /dev/null \
      | while IFS= read -r old; do
          [ -f "$old/command" ] || continue
          if [ ! -f "$old/exit" ] && [ -f "$old/pid" ] && kill -0 "$(cat "$old/pid")" 2> /dev/null; then continue; fi
          rm -rf -- "$old"
        done
    ;;
  wait)
    [ $# -eq 2 ] && [ -f "$2/command" ] || { echo "usage: wait.sh wait <handle from a run slice>"; exit 2; }
    handle=$2
    ;;
  stop)
    [ $# -eq 2 ] && [ -f "$2/command" ] || { echo "usage: wait.sh stop <handle from a run slice>"; exit 2; }
    handle=$2
    [ -f "$handle/exit" ] && { echo "already finished: exit=$(cat "$handle/exit") log=$handle/log"; exit 0; }
    [ -f "$handle/pid" ] || { echo "nothing to stop: the runner never started log=$handle/log"; exit 0; }
    pid=$(cat "$handle/pid")
    # A detached runner leads its own process group, so one signal reaches the command and its children. Without
    # setsid, walk the tree instead.
    tree() { local c; for c in $(pgrep -P "$1" 2> /dev/null); do tree "$c"; done; echo "$1"; }
    for sig in TERM KILL; do
      if [ -f "$handle/detached" ]; then kill -s "$sig" -- "-$pid" 2> /dev/null
      else for p in $(tree "$pid"); do kill -s "$sig" "$p" 2> /dev/null; done; fi
      for _ in 1 2 3 4 5; do kill -0 "$pid" 2> /dev/null || break; sleep 1; done
      kill -0 "$pid" 2> /dev/null || break
    done
    echo "stopped log=$handle/log"
    tail -n 20 "$handle/log"
    exit 0
    ;;
  *) echo "usage: wait.sh run '<command>' | wait.sh wait <handle> | wait.sh stop <handle>"; exit 2 ;;
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
