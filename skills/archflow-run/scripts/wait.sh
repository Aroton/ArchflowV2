#!/usr/bin/env bash
# Runs a command in the background and waits on it in slices of 100 seconds, so a sub-agent that needs a command's
# result keeps its prompt cache warm: the cache lasts about five minutes, and each slice that returns gives the agent a
# turn that refreshes it. Fast commands return as soon as they finish.
#
#   bash wait.sh run '<command>'         start in one resource-managed slot, then wait one slice
#   bash wait.sh run --full '<command>'  wait for all slots (exclusive) and run with all usable CPUs
#   bash wait.sh wait <handle>           wait one more slice on a command still running
#   bash wait.sh stop <handle>           stop a stuck command, its cgroup scope, and everything it started
#
# `run` first prints the handle and its continuation line, so a call cut off early can still be continued. The command
# runs with pipefail, stdin from /dev/null, and output in <handle>/log; the runner's pid is in <handle>/pid (detached
# into its own session where `setsid` exists). A slice that sees the command finish prints `exit=<code>`, the log path
# and the output's tail, and exits with the command's status. If the runner is gone without recording a status, it
# prints `exit=unknown` with the tail and exits 125. Otherwise it prints `running` with the line to run next, and exits
# 0. `stop` ends the command's systemd scope (when active), the runner, the command and their children; a later `wait`
# then reports `exit=unknown`.
#
# The slice has to end while the call is still in the foreground. Claude Code moves a foreground command to the
# background after 180 seconds, and at its timeout when that is shorter (120 seconds unless the call sets one). The
# agent then gets a notice that it will be told when the command completes, instead of the line to run next. 100
# seconds stays under both, so a call needs no timeout of its own. ARCHFLOW_WAIT_SLICE overrides the slice in seconds.
#
# Several agents in several worktrees run builds, installs, typechecks, lints, and tests at once, and running all of
# them unconstrained can thrash CPU and swap. The runner therefore manages host resources across every worktree:
# - FIFO slot queue using an atomic `mkdir` mutex, monotonic sequence tickets, and per-slot PID holder files with
#   dead-PID recovery across Linux and macOS (auto-sized from available CPUs and RAM unless ARCHFLOW_WAIT_SLOTS is
#   set; 0 turns the slot limit off), with `--full` taking an exclusive lock across all slots for full-suite runs.
# - Overlapping CPU affinity masks built from the caller's actual allowed CPU IDs (reserving host cores for interactive
#   responsiveness) so tools reading `nproc` / `os.availableParallelism()` cap their own worker pools and memory, plus
#   standard concurrency env vars when unset. ARCHFLOW_WAIT_CPUS overrides usable CPU count (0 disables pinning).
# - On Linux with a working user systemd scope manager (unless ARCHFLOW_WAIT_SYSTEMD=0), every job runs in a transient
#   scope under `archflow-jobs.slice` with runtime-only slice limits (`CPUQuota`, `CPUWeight=50`, `IOWeight=20`,
#   `MemoryHigh`/`MemoryMax`) and equal per-job `CPUWeight=100` (plus `OOMPolicy=kill` when supported by systemd >= 253),
#   so the kernel dynamically splits and reclaims CPU across active jobs as they enter and exit. Falls back to `taskset`
#   + `nice` + `ionice` elsewhere.
# - Memory-headroom admission guard (`MemAvailable` vs ARCHFLOW_WAIT_MIN_FREE_MB; 0 disables) holds a 2nd+ concurrent
#   job when free RAM is low, while never blocking when no other job is running.
#
# Handles live in the temp directory and nobody comes back for them, so each `run` also deletes this user's handles
# that were last touched more than a day ago and whose command has finished or whose runner is gone.
#
# Everything runs inside main, called on the last line: bash reads a script as it goes, so a copy still waiting when an
# install or an edit rewrites this file would otherwise continue at its old position in the new bytes.
set -u

main() {
  local slice=${ARCHFLOW_WAIT_SLICE:-100}
  local tmp_root=${TMPDIR:-/tmp}
  tmp_root=${tmp_root%/}
  [ -n "$tmp_root" ] || tmp_root=/
  local self handle detach pid sig p end full_mode=0 cmd=""
  local uid total_cpus usable_cpus pin_cpus=1 total_ram_mb slots min_free_mb slot_dir
  local use_systemd=0 sd_oom_policy=0 sd_xdg="" sd_dbus="" unit="" sweep_pid=""
  local slice_quota_pct slice_mem_high slice_mem_max allowed_list="" usable_cpu_ids=""
  local -a slice_props=() all_cpu_arr=()

  self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  uid=$(id -u)

  read_meminfo_mb() {
    [ -r /proc/meminfo ] || return 1
    awk -v key="$1:" '$1 == key { printf "%d\n", int($2 / 1024); exit }' /proc/meminfo 2>/dev/null
  }

  detect_total_cpus() {
    local n=""
    if command -v nproc >/dev/null 2>&1; then
      n=$(nproc 2>/dev/null || true)
    elif command -v getconf >/dev/null 2>&1; then
      n=$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)
    elif command -v sysctl >/dev/null 2>&1; then
      n=$(sysctl -n hw.ncpu 2>/dev/null || true)
    fi
    case "${n:-}" in
      ''|*[!0-9]*|0) echo 2 ;;
      *) echo "$n" ;;
    esac
  }

  detect_allowed_cpulist() {
    local list=""
    if [ -r /proc/self/status ]; then
      list=$(awk '$1 == "Cpus_allowed_list:" { print $2; exit }' /proc/self/status 2>/dev/null || true)
    fi
    if [ -z "$list" ] && command -v taskset >/dev/null 2>&1; then
      list=$(taskset -pc $$ 2>/dev/null | awk -F': ' '{ print $2 }' || true)
    fi
    case "${list:-}" in
      *[!0-9,-]*|'') return 1 ;;
      *) printf '%s\n' "$list" ;;
    esac
  }

  expand_cpulist() {
    local list=$1 part a b i out=""
    local IFS=,
    for part in $list; do
      case "$part" in
        *-*)
          a=${part%-*}
          b=${part#*-}
          for ((i = a; i <= b; i++)); do out="${out:+$out }$i"; done
          ;;
        *)
          [ -n "$part" ] && out="${out:+$out }$part"
          ;;
      esac
    done
    printf '%s\n' "$out"
  }

  probe_systemd_bus() {
    [ "${ARCHFLOW_WAIT_SYSTEMD:-auto}" != "0" ] || return 1
    command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 || return 1
    sd_xdg=${XDG_RUNTIME_DIR:-}
    if [ -z "$sd_xdg" ] && [ -d "/run/user/$uid" ]; then
      sd_xdg="/run/user/$uid"
    fi
    sd_dbus=${DBUS_SESSION_BUS_ADDRESS:-}
    if [ -z "$sd_dbus" ] && [ -n "$sd_xdg" ] && [ -S "$sd_xdg/bus" ]; then
      sd_dbus="unix:path=$sd_xdg/bus"
    fi
    XDG_RUNTIME_DIR="$sd_xdg" DBUS_SESSION_BUS_ADDRESS="$sd_dbus" \
      systemctl --user show-environment >/dev/null 2>&1
  }

  probe_systemd_scope() {
    probe_systemd_bus || return 1
    if XDG_RUNTIME_DIR="$sd_xdg" DBUS_SESSION_BUS_ADDRESS="$sd_dbus" \
      systemd-run --user --scope --quiet --slice=archflow-jobs.slice \
      -p CPUWeight=100 -p IOWeight=20 -p OOMPolicy=kill -- true >/dev/null 2>&1; then
      use_systemd=1
      sd_oom_policy=1
      return 0
    fi
    if XDG_RUNTIME_DIR="$sd_xdg" DBUS_SESSION_BUS_ADDRESS="$sd_dbus" \
      systemd-run --user --scope --quiet --slice=archflow-jobs.slice \
      -p CPUWeight=100 -p IOWeight=20 -- true >/dev/null 2>&1; then
      use_systemd=1
      sd_oom_policy=0
      return 0
    fi
    return 1
  }

  case "${1:-}" in
    run)
      shift
      if [ "${1:-}" = "--full" ]; then
        full_mode=1
        shift
      fi
      [ $# -eq 1 ] || { echo "usage: wait.sh run [--full] '<command>'"; exit 2; }
      cmd=$1

      # Build the usable CPU list from the caller's actual allowed CPU IDs so inherited taskset/cpuset masks are
      # respected rather than assuming CPUs start at 0.
      if allowed_list=$(detect_allowed_cpulist); then
        read -r -a all_cpu_arr <<< "$(expand_cpulist "$allowed_list")"
      fi
      if [ -n "${all_cpu_arr[0]+x}" ]; then
        total_cpus=${#all_cpu_arr[@]}
      else
        total_cpus=$(detect_total_cpus)
        all_cpu_arr=()
        for ((p = 0; p < total_cpus; p++)); do all_cpu_arr+=("$p"); done
      fi

      if [ -n "${ARCHFLOW_WAIT_CPUS:-}" ]; then
        case "$ARCHFLOW_WAIT_CPUS" in
          0)
            pin_cpus=0
            if [ "$total_cpus" -ge 6 ]; then usable_cpus=$((total_cpus - 2))
            elif [ "$total_cpus" -ge 3 ]; then usable_cpus=$((total_cpus - 1))
            else usable_cpus=$total_cpus; fi
            ;;
          *[!0-9]*|'')
            usable_cpus=$total_cpus
            ;;
          *)
            usable_cpus=$ARCHFLOW_WAIT_CPUS
            [ "$usable_cpus" -gt "$total_cpus" ] && usable_cpus=$total_cpus
            ;;
        esac
      else
        if [ "$total_cpus" -ge 6 ]; then usable_cpus=$((total_cpus - 2))
        elif [ "$total_cpus" -ge 3 ]; then usable_cpus=$((total_cpus - 1))
        else usable_cpus=$total_cpus; fi
      fi
      [ "$usable_cpus" -lt 1 ] && usable_cpus=1
      usable_cpu_ids="${all_cpu_arr[*]:0:usable_cpus}"

      total_ram_mb=$(read_meminfo_mb MemTotal || echo 0)
      case "${total_ram_mb:-}" in ''|*[!0-9]*) total_ram_mb=0 ;; esac

      if [ -n "${ARCHFLOW_WAIT_SLOTS:-}" ]; then
        slots=$ARCHFLOW_WAIT_SLOTS
      else
        if [ "$usable_cpus" -ge 16 ]; then slots=3
        elif [ "$usable_cpus" -ge 4 ]; then slots=2
        else slots=1; fi
        if [ "$total_ram_mb" -gt 0 ]; then
          if [ "$total_ram_mb" -lt 6144 ] && [ "$slots" -gt 1 ]; then slots=1
          elif [ "$total_ram_mb" -lt 12288 ] && [ "$slots" -gt 2 ]; then slots=2; fi
        fi
      fi

      if [ -n "${ARCHFLOW_WAIT_MIN_FREE_MB:-}" ]; then
        min_free_mb=$ARCHFLOW_WAIT_MIN_FREE_MB
      elif [ "$total_ram_mb" -gt 0 ]; then
        min_free_mb=$((total_ram_mb / 5))
        [ "$min_free_mb" -gt 4096 ] && min_free_mb=4096
        [ "$min_free_mb" -lt 1024 ] && min_free_mb=1024
      else
        min_free_mb=0
      fi

      slot_dir=${ARCHFLOW_WAIT_SLOT_DIR:-}
      if [ -z "$slot_dir" ]; then
        if [ -n "${TMPDIR:-}" ]; then
          slot_dir="${tmp_root}/archflow-wait-slots.${uid}"
        elif [ -d "/run/user/$uid" ] && [ -w "/run/user/$uid" ]; then
          slot_dir="/run/user/${uid}/archflow-wait-slots"
        else
          slot_dir="/tmp/archflow-wait-slots.${uid}"
        fi
      fi

      if probe_systemd_scope; then
        slice_quota_pct=$((usable_cpus * 100))
        slice_props=("CPUQuota=${slice_quota_pct}%" "CPUWeight=50" "IOWeight=20")
        if [ "$total_ram_mb" -gt 0 ]; then
          slice_mem_high=$((total_ram_mb * 75 / 100))
          slice_mem_max=$((total_ram_mb * 85 / 100))
          [ "$slice_mem_high" -ge 1024 ] && slice_props+=("MemoryHigh=${slice_mem_high}M")
          [ "$slice_mem_max" -ge 1536 ] && slice_props+=("MemoryMax=${slice_mem_max}M")
        fi
        XDG_RUNTIME_DIR="$sd_xdg" DBUS_SESSION_BUS_ADDRESS="$sd_dbus" \
          systemctl --user set-property --runtime archflow-jobs.slice ${slice_props[@]+"${slice_props[@]}"} >/dev/null 2>&1 || true
      fi

      handle=$(mktemp -d "${tmp_root}/archflow-wait.XXXXXX") || exit 2
      printf '%s\n' "$cmd" > "$handle/command"
      echo "handle=$handle; continue with: bash '$self' wait '$handle'"
      detach=
      if command -v setsid > /dev/null 2>&1; then detach=setsid; fi
      # The exit file appears only after the command ends, holding the command's own status.
      # The pid file is moved into place whole: a reader never sees it empty and mistakes a starting runner for a dead
      # one.
      [ -n "$detach" ] && : > "$handle/detached"
      # Holder files track the runner PID, so background processes left behind by a command cannot keep a slot.
      $detach nohup bash -c '
        set -u
        handle=$1 slots=$2 slot_dir=$3 full_mode=$4 usable_cpu_ids=$5 pin_cpus=$6
        min_free_mb=$7 use_systemd=$8 sd_oom_policy=$9 sd_xdg=${10} sd_dbus=${11}

        echo $$ > "$handle/pid.tmp" && mv "$handle/pid.tmp" "$handle/pid"

        sleep_short() {
          sleep "$1" 2>/dev/null || sleep 1
        }

        format_cpulist() {
          local cpu start="" prev="" out=""
          for cpu in ${1+"$@"}; do
            if [ -z "$start" ]; then
              start=$cpu; prev=$cpu
            elif [ "$cpu" -eq $((prev + 1)) ]; then
              prev=$cpu
            else
              if [ "$start" -eq "$prev" ]; then out="${out:+$out,}$start"
              else out="${out:+$out,}${start}-${prev}"; fi
              start=$cpu; prev=$cpu
            fi
          done
          if [ -n "$start" ]; then
            if [ "$start" -eq "$prev" ]; then out="${out:+$out,}$start"
            else out="${out:+$out,}${start}-${prev}"; fi
          fi
          printf "%s\n" "$out"
        }

        assigned_slot=0
        ticket=""
        lock_dir="$slot_dir/lock.d"
        holds_lockdir=0
        slot_lock_file=""

        release_lockdir() {
          if [ "$holds_lockdir" -eq 1 ]; then
            rm -f "$lock_dir/owner.$$" 2>/dev/null || true
            rmdir "$lock_dir" 2>/dev/null || true
            holds_lockdir=0
          fi
        }

        acquire_lockdir() {
          local tries=0 f="" owner=""
          while :; do
            if mkdir "$lock_dir" 2>/dev/null; then
              holds_lockdir=1
              if : > "$lock_dir/owner.$$" 2>/dev/null; then
                return 0
              fi
              release_lockdir
              return 1
            fi
            tries=$((tries + 1))
            if [ "$tries" -ge 4 ]; then
              owner=""
              for f in "$lock_dir"/owner.*; do
                [ -e "$f" ] || continue
                owner=${f##*.}
                if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
                  rm -f "$f" 2>/dev/null || true
                  rmdir "$lock_dir" 2>/dev/null || true
                  tries=0
                fi
                break
              done
              if [ -z "$owner" ] && [ "$tries" -ge 40 ]; then
                rmdir "$lock_dir" 2>/dev/null || true
                tries=0
              fi
            fi
            sleep_short 0.05
          done
        }

        prune_dead_holders() {
          local hf="" hpid=""
          for hf in "$slot_dir"/full.pid "$slot_dir"/slot-*.pid; do
            [ -f "$hf" ] || continue
            hpid=$(cat "$hf" 2>/dev/null || true)
            case "$hpid" in
              ""|*[!0-9]*) rm -f "$hf" 2>/dev/null || true ;;
              *) kill -0 "$hpid" 2>/dev/null || rm -f "$hf" 2>/dev/null || true ;;
            esac
          done
        }

        enqueue_ticket() {
          local seq_file="$slot_dir/queue.seq" seq=0 next=1 formatted=""
          if acquire_lockdir; then
            if [ -f "$seq_file" ]; then
              seq=$(cat "$seq_file" 2>/dev/null || echo 0)
              case "$seq" in
                ""|*[!0-9]*) seq=0 ;;
              esac
            fi
            next=$((seq + 1))
            if printf "%s\n" "$next" > "${seq_file}.tmp.$$" 2>/dev/null \
              && mv "${seq_file}.tmp.$$" "$seq_file" 2>/dev/null; then
              formatted=$(printf "%012d" "$next")
              if : > "$slot_dir/queue/${formatted}-$$" 2>/dev/null; then
                ticket="$slot_dir/queue/${formatted}-$$"
              fi
            else
              rm -f "${seq_file}.tmp.$$" 2>/dev/null || true
            fi
            release_lockdir
          fi
        }

        cleanup_ticket() {
          [ -n "$ticket" ] && rm -f "$ticket" 2>/dev/null || true
          ticket=""
        }

        release_slot_lock() {
          if [ -n "$slot_lock_file" ]; then
            rm -f "$slot_lock_file" 2>/dev/null || true
            slot_lock_file=""
          fi
        }

        cleanup_all() {
          cleanup_ticket
          release_slot_lock
          release_lockdir
        }

        trap cleanup_all EXIT
        trap "cleanup_all; exit 130" INT
        trap "cleanup_all; exit 143" TERM

        if [ "$slots" -gt 0 ] 2>/dev/null \
          && mkdir -p -m 700 "$slot_dir" 2>/dev/null && [ -O "$slot_dir" ] && [ ! -L "$slot_dir" ] \
          && mkdir -p -m 700 "$slot_dir/queue" 2>/dev/null && [ -O "$slot_dir/queue" ] && [ ! -L "$slot_dir/queue" ]; then

          enqueue_ticket

          while [ -n "$ticket" ]; do
            # Determine our FIFO position, pruning tickets left by dead runners.
            pos=0
            for entry in "$slot_dir/queue/"*; do
              [ -e "$entry" ] || continue
              tpid=${entry##*-}
              if [ "$entry" != "$ticket" ] && ! kill -0 "$tpid" 2>/dev/null; then
                rm -f "$entry" 2>/dev/null || true
                continue
              fi
              pos=$((pos + 1))
              [ "$entry" = "$ticket" ] && break
            done

            if [ "$pos" -le 1 ]; then
              acquired=0
              ram_ok=1
              avail=""
              if acquire_lockdir; then
                prune_dead_holders
                if [ "$full_mode" -eq 1 ]; then
                  busy=0
                  for hf in "$slot_dir"/full.pid "$slot_dir"/slot-*.pid; do
                    [ -f "$hf" ] && { busy=1; break; }
                  done
                  if [ "$busy" -eq 0 ]; then
                    if printf "%s\n" "$$" > "$slot_dir/full.pid.tmp.$$" 2>/dev/null \
                      && mv "$slot_dir/full.pid.tmp.$$" "$slot_dir/full.pid" 2>/dev/null; then
                      slot_lock_file="$slot_dir/full.pid"
                      assigned_slot=0
                      acquired=1
                    else
                      rm -f "$slot_dir/full.pid.tmp.$$" 2>/dev/null || true
                    fi
                  fi
                else
                  # Only enforce the RAM floor when at least one other job is already running.
                  other_running=0
                  for hf in "$slot_dir"/full.pid "$slot_dir"/slot-*.pid; do
                    [ -f "$hf" ] && { other_running=1; break; }
                  done
                  if [ "$other_running" -eq 1 ] && [ "$min_free_mb" -gt 0 ] 2>/dev/null && [ -r /proc/meminfo ]; then
                    avail=$(awk '\''$1 == "MemAvailable:" { printf "%d\n", int($2 / 1024); exit }'\'' /proc/meminfo 2>/dev/null || echo "")
                    case "$avail" in
                      ""|*[!0-9]*) ;;
                      *)
                        if [ "$avail" -lt "$min_free_mb" ]; then
                          ram_ok=0
                        fi
                        ;;
                    esac
                  fi
                  if [ "$ram_ok" -eq 1 ] && [ ! -f "$slot_dir/full.pid" ]; then
                    for s in $(seq "$slots"); do
                      if [ ! -f "$slot_dir/slot-$s.pid" ]; then
                        if printf "%s\n" "$$" > "$slot_dir/slot-$s.pid.tmp.$$" 2>/dev/null \
                          && mv "$slot_dir/slot-$s.pid.tmp.$$" "$slot_dir/slot-$s.pid" 2>/dev/null; then
                          slot_lock_file="$slot_dir/slot-$s.pid"
                          assigned_slot=$s
                          acquired=1
                          break
                        else
                          rm -f "$slot_dir/slot-$s.pid.tmp.$$" 2>/dev/null || true
                        fi
                      fi
                    done
                  fi
                fi
                release_lockdir
              fi

              if [ "$acquired" -eq 1 ]; then
                break
              fi
              if [ "$full_mode" -eq 1 ]; then
                printf "queued: waiting for all %s slots (exclusive); other commands are running\n" "$slots" > "$handle/log"
              elif [ "$ram_ok" -eq 0 ]; then
                printf "queued: waiting for free RAM (%s MiB available, need %s MiB); other commands are running\n" "$avail" "$min_free_mb" > "$handle/log"
              else
                printf "queued: waiting for one of %s slots (position %s); other commands are running\n" "$slots" "$pos" > "$handle/log"
              fi
            else
              if [ "$full_mode" -eq 1 ]; then
                printf "queued: waiting for all %s slots (position %s); other commands are running\n" "$slots" "$pos" > "$handle/log"
              else
                printf "queued: waiting for one of %s slots (position %s); other commands are running\n" "$slots" "$pos" > "$handle/log"
              fi
            fi

            sleep_short 0.25
          done

          cleanup_ticket
        fi

        # Slice the actual allowed CPU IDs for the assigned slot so inherited affinity masks are always respected.
        read -r -a cpu_arr <<< "$usable_cpu_ids"
        usable_cpus=${#cpu_arr[@]}
        if [ "$full_mode" -eq 1 ] || [ "$slots" -le 1 ] 2>/dev/null || [ "$usable_cpus" -le 2 ] || [ "$assigned_slot" -le 0 ]; then
          width=$usable_cpus
          start_idx=0
        else
          half=$(( (usable_cpus + 1) / 2 ))
          share=$(( (usable_cpus + slots - 1) / slots ))
          cap=$half
          [ "$cap" -gt 12 ] && cap=12
          width=$cap
          [ "$share" -gt "$width" ] && width=$share
          [ "$width" -gt "$usable_cpus" ] && width=$usable_cpus
          span=$((usable_cpus - width))
          if [ "$assigned_slot" -eq 1 ]; then
            start_idx=0
          elif [ "$assigned_slot" -eq 2 ]; then
            start_idx=$span
          else
            start_idx=$(( ((assigned_slot - 2) * span) / (slots - 1) ))
          fi
        fi
        cpuset=$(format_cpulist "${cpu_arr[@]:start_idx:width}")

        # Export common concurrency hints when the caller has not set them.
        : "${CARGO_BUILD_JOBS:=$width}"
        : "${CMAKE_BUILD_PARALLEL_LEVEL:=$width}"
        : "${RAYON_NUM_THREADS:=$width}"
        : "${GOMAXPROCS:=$width}"
        : "${OMP_NUM_THREADS:=$width}"
        export CARGO_BUILD_JOBS CMAKE_BUILD_PARALLEL_LEVEL RAYON_NUM_THREADS GOMAXPROCS OMP_NUM_THREADS

        printf "slot=%s full=%s cpuset=%s width=%s systemd=%s oom_policy=%s\n" \
          "$assigned_slot" "$full_mode" "$cpuset" "$width" "$use_systemd" "$sd_oom_policy" > "$handle/meta"

        prio=()
        if command -v nice >/dev/null 2>&1 && nice -n 10 true 2>/dev/null; then
          prio+=(nice -n 10)
        fi
        if command -v ionice >/dev/null 2>&1 && ionice -c 2 -n 7 true 2>/dev/null; then
          prio+=(ionice -c 2 -n 7)
        fi

        rc=0
        if [ "$use_systemd" -eq 1 ]; then
          suffix=$(basename "$handle" | tr -c "A-Za-z0-9_-" "-")
          unit="archflow-wait-${suffix}-$$.scope"
          printf "%s\n" "$unit" > "$handle/unit.tmp" && mv "$handle/unit.tmp" "$handle/unit"
          sd_props=(-p CPUWeight=100 -p IOWeight=20)
          if [ "$sd_oom_policy" -eq 1 ]; then
            sd_props+=(-p OOMPolicy=kill)
          fi
          if [ "$pin_cpus" -eq 1 ]; then
            sd_props+=(-p "AllowedCPUs=$cpuset")
          fi
          XDG_RUNTIME_DIR="$sd_xdg" DBUS_SESSION_BUS_ADDRESS="$sd_dbus" \
            systemd-run --user --scope --quiet --unit="$unit" --slice=archflow-jobs.slice \
            ${sd_props[@]+"${sd_props[@]}"} -- ${prio[@]+"${prio[@]}"} \
            bash -o pipefail "$handle/command" > "$handle/log" 2>&1 < /dev/null
          rc=$?
        else
          affinity=()
          if [ "$pin_cpus" -eq 1 ] && command -v taskset >/dev/null 2>&1 && taskset -c "$cpuset" true 2>/dev/null; then
            affinity=(taskset -c "$cpuset")
          fi
          ${affinity[@]+"${affinity[@]}"} ${prio[@]+"${prio[@]}"} \
            bash -o pipefail "$handle/command" > "$handle/log" 2>&1 < /dev/null
          rc=$?
        fi

        release_slot_lock
        echo "$rc" > "$handle/exit.tmp" && mv "$handle/exit.tmp" "$handle/exit"
      ' wait-run "$handle" "$slots" "$slot_dir" "$full_mode" "$usable_cpu_ids" "$pin_cpus" \
          "$min_free_mb" "$use_systemd" "$sd_oom_policy" "$sd_xdg" "$sd_dbus" > /dev/null 2>&1 &

      # Sweep old handles concurrently so startup is never delayed, then join before returning.
      (
        find "$tmp_root" -maxdepth 1 -type d -name 'archflow-wait.*' -user "$uid" -mmin +1440 2> /dev/null \
          | while IFS= read -r old; do
              [ -f "$old/command" ] || continue
              if [ ! -f "$old/exit" ] && [ -f "$old/pid" ] && kill -0 "$(cat "$old/pid")" 2> /dev/null; then continue; fi
              rm -rf -- "$old"
            done
      ) &
      sweep_pid=$!
      ;;
    wait)
      [ $# -eq 2 ] && [ -f "$2/command" ] || { echo "usage: wait.sh wait <handle from a run slice>"; exit 2; }
      handle=$2
      ;;
    stop)
      [ $# -eq 2 ] && [ -f "$2/command" ] || { echo "usage: wait.sh stop <handle from a run slice>"; exit 2; }
      handle=$2
      [ -f "$handle/exit" ] && { echo "already finished: exit=$(cat "$handle/exit") log=$handle/log"; exit 0; }
      if [ -f "$handle/unit" ] && probe_systemd_bus; then
        unit=$(cat "$handle/unit")
        XDG_RUNTIME_DIR="$sd_xdg" DBUS_SESSION_BUS_ADDRESS="$sd_dbus" \
          systemctl --user stop "$unit" >/dev/null 2>&1 || true
      fi
      [ -f "$handle/pid" ] || { echo "nothing to stop: the runner never started log=$handle/log"; exit 0; }
      pid=$(cat "$handle/pid")
      # A detached runner leads its own process group, so one signal reaches the command and its children. Without
      # setsid, walk the tree instead.
      tree() { local c; for c in $(pgrep -P "$1" 2> /dev/null); do tree "$c"; done; echo "$1"; }
      for sig in TERM KILL; do
        if [ -f "$handle/detached" ]; then kill -s "$sig" -- "-$pid" 2> /dev/null
        else for p in $(tree "$pid"); do kill -s "$sig" "$p" 2> /dev/null; done; fi
        for _ in 1 2 3 4 5; do kill -0 "$pid" 2> /dev/null || break; sleep 0.2 2>/dev/null || sleep 1; done
        kill -0 "$pid" 2> /dev/null || break
      done
      echo "stopped log=$handle/log"
      [ -f "$handle/log" ] && tail -n 20 "$handle/log"
      exit 0
      ;;
    *) echo "usage: wait.sh run [--full] '<command>' | wait.sh wait <handle> | wait.sh stop <handle>"; exit 2 ;;
  esac

  finished() { [ -f "$handle/exit" ]; }
  # A runner that has not written its pid yet has only just started.
  alive() { [ ! -f "$handle/pid" ] || kill -0 "$(cat "$handle/pid")" 2> /dev/null; }

  # Short backoff polling keeps fast commands responsive while avoiding busy-spinning during long waits.
  local step_idx=0 delay
  local -a delays=(0.05 0.1 0.2 0.5 1)
  [ "$slice" -le 1 ] 2>/dev/null && delays=(0.05 0.1 0.2 0.2 0.2)

  end=$((SECONDS + slice))
  while ! finished && alive && [ "$SECONDS" -lt "$end" ]; do
    delay=${delays[$step_idx]}
    [ "$step_idx" -lt 4 ] && step_idx=$((step_idx + 1))
    sleep "$delay" 2>/dev/null || sleep 1
  done

  [ -n "$sweep_pid" ] && wait "$sweep_pid" 2>/dev/null || true

  if finished; then
    echo "exit=$(cat "$handle/exit") log=$handle/log"
    tail -n 40 "$handle/log"
    exit "$(cat "$handle/exit")"
  elif alive; then
    echo "running after ${slice}s; continue with: bash '$self' wait '$handle'"
    [ -f "$handle/log" ] && tail -n 5 "$handle/log"
  else
    echo "exit=unknown: the runner stopped without recording a status log=$handle/log"
    [ -f "$handle/log" ] && tail -n 40 "$handle/log"
    exit 125
  fi
}

main ${1+"$@"}; exit
