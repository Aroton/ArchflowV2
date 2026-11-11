#!/usr/bin/env bash
# Removes one run's working files and commits the removal, so nobody deletes them by hand before a pull request.
#
#   bash cleanup.sh <repository root> <run name> [--dry-run]
#
# Removes .archflow/runs/<name>/ (its gitignored packets/ included), the run's generated agents in .claude/agents/,
# and the scratch review worktrees the run left in the temp directory (<tmp>/archflow-run-<name>.XXXXXX/wt). It then
# makes one local commit holding only those deletions, and never pushes.
#
# It removes only what is provably this run's, and keeps and reports everything else:
#   - an agent file counts only when it is a regular file named <name>-implementer.md, <name>-reviewer.md or
#     <name>-<domain>-<role>.md whose frontmatter `name` equals the file name and whose description carries
#     "Spawned only by the <name> orchestrator". That sentence tells run `foo` domain `bar` from run `foo-bar`;
#   - nothing reached through a symbolic link is touched;
#   - other worktrees (sub-agent task worktrees, anyone else's) and every branch are left alone and listed.
#
# It refuses, removing nothing, while a run or agent file has uncommitted changes: everything it deletes is then in
# git history, and `git revert <commit>` brings it back. --dry-run prints what would happen and changes nothing.
# Exit 0: removed, or nothing to remove. Exit 1: refused, or the commit failed. Exit 2: usage.
set -u
usage() { echo "usage: cleanup.sh <repository root> <run name> [--dry-run]"; exit 2; }
{ [ $# -eq 2 ] || [ $# -eq 3 ]; } || usage
root=$1 name=$2 dry=
if [ $# -eq 3 ]; then [ "$3" = "--dry-run" ] || usage; dry=1; fi
[[ $name =~ ^[a-z0-9][a-z0-9-]*$ ]] \
  || { echo "cleanup: \"$name\" is not a run name (lowercase letters, digits and hyphens)"; exit 2; }
cd "$root" 2> /dev/null || { echo "cleanup: cannot enter $root"; exit 2; }
top=$(git rev-parse --show-toplevel 2> /dev/null) || { echo "cleanup: $root is not in a git work tree"; exit 2; }
[ "$top" = "$(pwd -P)" ] || { echo "cleanup: $root is not the repository root, which is $top"; exit 2; }

run=.archflow/runs/$name
targets=() kept=() scratch=() others=()

if [ -L .archflow ] || [ -L .archflow/runs ] || [ -L "$run" ]; then
  kept+=("$run (reached through a symbolic link)")
elif [ -d "$run" ]; then
  targets+=("$run")
elif [ -e "$run" ]; then
  kept+=("$run (not a directory)")
fi

# Prints the frontmatter: the lines between a first-line `---` and the next one.
frontmatter() { awk 'NR == 1 { if ($0 !~ /^---[ \t\r]*$/) exit; next } /^---[ \t\r]*$/ { exit } { print }' "$1"; }

if [ -L .claude ] || [ -L .claude/agents ]; then
  kept+=(".claude/agents (reached through a symbolic link)")
else
  for file in ".claude/agents/$name-implementer.md" ".claude/agents/$name-reviewer.md" \
              .claude/agents/"$name"-*-implementer.md .claude/agents/"$name"-*-reviewer.md; do
    if [ -L "$file" ]; then kept+=("$file (a symbolic link)"); continue; fi
    [ -e "$file" ] || continue
    if [ ! -f "$file" ]; then kept+=("$file (not a regular file)"); continue; fi
    base=${file##*/} base=${base%.md}
    declared=$(frontmatter "$file" | sed -n 's/^name:[[:space:]]*//p' | head -n 1 | tr -d "\"'\r" | sed 's/[[:space:]]*$//')
    if [ "$declared" != "$base" ]; then
      kept+=("$file (its frontmatter name is not $base)")
    elif ! frontmatter "$file" | grep -qF -- "Spawned only by the $name orchestrator"; then
      kept+=("$file (its description does not say \"Spawned only by the $name orchestrator\")")
    else
      targets+=("$file")
    fi
  done
fi

# Sorts every linked worktree but the main one and this one into the run's scratch review worktrees and the rest.
read_worktrees() {
  local line path='' detached='' first=1 parent
  scratch=() others=()
  while IFS= read -r line; do
    case $line in
      "worktree "*) path=${line#worktree } detached='' ;;
      detached) detached=1 ;;
      "")
        if [ -n "$path" ] && [ -z "$first" ] && [ "$path" != "$top" ]; then
          parent=${path%/*} parent=${parent##*/}
          if [ "${path##*/}" = wt ] && [ -n "$detached" ] && [[ $parent =~ ^archflow-run-$name\.[A-Za-z0-9]{6}$ ]]
          then scratch+=("$path"); else others+=("$path"); fi
        fi
        first='' path=''
        ;;
    esac
  done < <(git worktree list --porcelain; echo)
}

report_rest() {
  local item wt branch
  for item in ${kept[@]+"${kept[@]}"}; do echo "kept: $item"; done
  for wt in ${others[@]+"${others[@]}"}; do
    branch=$(git -C "$wt" branch --show-current 2> /dev/null)
    echo "left alone: worktree $wt [${branch:-detached}], $(git -C "$wt" status --porcelain 2> /dev/null | wc -l | tr -d ' ') uncommitted files"
  done
}

read_worktrees

if [ ${#targets[@]} -gt 0 ]; then
  dirty=$(git status --porcelain --untracked-files=all -- "${targets[@]}") || exit 1
  if [ -n "$dirty" ]; then
    echo "cleanup $name: refused, nothing was removed. These run files have uncommitted changes; commit or discard them first:"
    printf '%s\n' "$dirty"
    exit 1
  fi
fi

if [ ${#targets[@]} -eq 0 ] && [ ${#scratch[@]} -eq 0 ]; then
  echo "cleanup $name: nothing to remove"
  report_rest
  exit 0
fi

if [ -n "$dry" ]; then
  echo "cleanup $name: dry run, nothing was changed"
  for item in ${targets[@]+"${targets[@]}"}; do echo "would remove: $item"; done
  for item in ${scratch[@]+"${scratch[@]}"}; do echo "would remove: scratch worktree $item"; done
  report_rest
  exit 0
fi

summary="nothing was tracked, so there is no commit"
status=0
if [ ${#targets[@]} -gt 0 ]; then
  git rm -r -q --ignore-unmatch -- "${targets[@]}" || { echo "cleanup $name: git rm failed, nothing was committed"; exit 1; }
  # Whatever is left is gitignored (packets/) or an emptied directory.
  [ -d "$run" ] && rm -rf -- "$run"
  rmdir .archflow/runs 2> /dev/null
  if ! git diff --cached --quiet -- "${targets[@]}"; then
    if git commit -q -m "Remove the $name run's working files" -- "${targets[@]}"; then
      sha=$(git rev-parse --short HEAD)
      summary="commit $sha (undo: git revert $sha)"
    else
      summary="THE COMMIT FAILED: the files are deleted and the deletion is staged, so commit it or restore with git restore --staged --worktree"
      status=1
    fi
  fi
fi
for wt in ${scratch[@]+"${scratch[@]}"}; do
  git worktree remove --force "$wt" 2> /dev/null && rmdir "${wt%/*}" 2> /dev/null
done
git worktree prune

echo "cleanup $name: $summary"
for item in ${targets[@]+"${targets[@]}"}; do echo "removed: $item"; done
for item in ${scratch[@]+"${scratch[@]}"}; do
  if [ -e "$item" ]; then kept+=("scratch worktree $item (git could not remove it)"); else echo "removed: scratch worktree $item"; fi
done
read_worktrees
report_rest
exit "$status"
