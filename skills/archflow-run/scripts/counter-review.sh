#!/usr/bin/env bash
# Runs ArchFlow's cross-model counter-review on one directory: every changed and untracked file there is the subject.
# An implementation review leaves the run's own files (.archflow/runs/) out of the subject: the ledger and the agents'
# notes are context for the reviewers, not work under review. A plan review keeps them, because they are the plan.
#
#   bash counter-review.sh <directory> <out-dir> <producer> <plan|implementation> [roles]
#
# [roles] is a comma-separated subset of counter-reviewer,test-reviewer,adjudicator. Omit it for the first review of a
# change, which runs every applicable role. Name roles for a follow-up pass, so a concern that already ran is not
# repeated: counter-reviewer alone for a review of a fix, or one failed role for a retry.
#
# <out-dir> must hold ask.txt and plan.txt, plus verification.txt for an implementation review. The script writes
# payload.json, result.json (the full review), summary.json (what a reviewer reads), and exit. It prints one line.
# ARCHFLOW_LOCAL overrides the command, e.g. ARCHFLOW_LOCAL="node /path/to/dist/archflow-local.mjs".
#
# Everything runs inside main, called on the last line: bash reads a script as it goes, so a copy still running when an
# install or an edit rewrites this file would otherwise continue at its old position in the new bytes.
set -u

main() {
  dir=$1 out=$2 producer=$3 stage=$4 roles=${5:-}
  # Resolved before the cd below, so a relative <out-dir> still names the caller's directory.
  out=$(cd "$out" 2> /dev/null && pwd) || { echo "counter-review: cannot enter out-dir $2"; exit 2; }
  cd "$dir" || { echo "counter-review: cannot enter $dir"; exit 2; }
  git rev-parse HEAD > "$out/base" || exit 2
  # NUL-separated so unusual file names survive; a trailing slash is a nested repository, never this one's bytes.
  { git diff HEAD --name-only -z; git ls-files --others --exclude-standard -z; } \
    | jq -Rs --arg stage "$stage" 'split("\u0000") | map(select(length > 0 and (endswith("/") | not)
        and ($stage != "implementation" or (startswith(".archflow/runs/") | not)))) | unique' > "$out/paths.json"
  [ -f "$out/verification.txt" ] || : > "$out/verification.txt"
  jq -n --arg stage "$stage" --rawfile ask "$out/ask.txt" --rawfile plan "$out/plan.txt" \
    --rawfile verification "$out/verification.txt" --rawfile base "$out/base" --slurpfile paths "$out/paths.json" \
    --arg roles "$roles" \
    '{schema_version:"1", stage:$stage, ask:$ask, plan:$plan, base_commit:($base|rtrimstr("\n")), paths:$paths[0]}
     + (if $verification == "" then {} else {verification:$verification} end)
     + (if $roles == "" then {} else {roles:($roles|split(","))} end)' > "$out/payload.json" || exit 2
  # shellcheck disable=SC2086 # ARCHFLOW_LOCAL may be a command with arguments
  ${ARCHFLOW_LOCAL:-archflow-local} review --producer "$producer" --input "$out/payload.json" > "$out/result.json"
  code=$?
  jq '{ok, error, failures: .value.failures, human_review_reasons: .value.human_review_reasons,
       reports: [.value.reports[]? | {role, model: .route.model, effort: .route.effort, outcome, feedback, report}]}' \
    "$out/result.json" > "$out/summary.json" 2>/dev/null
  echo "$code" > "$out/exit"
  echo "counter-review $stage${roles:+ ($roles)}: exit $code, ok=$(jq -r '.ok' "$out/summary.json" 2>/dev/null), $(jq -r '[.failures[]?.role] | length' "$out/summary.json" 2>/dev/null) failed roles, $(jq -r '.human_review_reasons | length? // 0' "$out/summary.json" 2>/dev/null) human-review reasons"
  exit "$code"
}

main "$@"; exit
