#!/usr/bin/env bash
# Runs ArchFlow's cross-model counter-review on one directory: every changed and untracked file there is the subject.
#
#   bash counter-review.sh <directory> <out-dir> <producer> <plan|implementation>
#
# <out-dir> must hold ask.txt and plan.txt, plus verification.txt for an implementation review. The script writes
# payload.json, result.json (the full review), summary.json (what a reviewer reads), and exit. It prints one line.
# ARCHFLOW_LOCAL overrides the command, e.g. ARCHFLOW_LOCAL="node /path/to/dist/archflow-local.mjs".
set -u
dir=$1 out=$2 producer=$3 stage=$4
cd "$dir" || { echo "counter-review: cannot enter $dir"; exit 2; }
git rev-parse HEAD > "$out/base" || exit 2
# NUL-separated so unusual file names survive; a trailing slash is a nested repository, never this one's bytes.
{ git diff HEAD --name-only -z; git ls-files --others --exclude-standard -z; } \
  | jq -Rs 'split("\u0000") | map(select(length > 0 and (endswith("/") | not))) | unique' > "$out/paths.json"
[ -f "$out/verification.txt" ] || : > "$out/verification.txt"
jq -n --arg stage "$stage" --rawfile ask "$out/ask.txt" --rawfile plan "$out/plan.txt" \
  --rawfile verification "$out/verification.txt" --rawfile base "$out/base" --slurpfile paths "$out/paths.json" \
  '{schema_version:"1", stage:$stage, ask:$ask, plan:$plan, base_commit:($base|rtrimstr("\n")), paths:$paths[0]}
   + (if $verification == "" then {} else {verification:$verification} end)' > "$out/payload.json" || exit 2
# shellcheck disable=SC2086 # ARCHFLOW_LOCAL may be a command with arguments
${ARCHFLOW_LOCAL:-archflow-local} review --producer "$producer" --input "$out/payload.json" > "$out/result.json"
code=$?
jq '{ok, error, failures: .value.failures, human_review_reasons: .value.human_review_reasons,
     reports: [.value.reports[]? | {role, model: .route.model, effort: .route.effort, outcome, feedback, report}]}' \
  "$out/result.json" > "$out/summary.json" 2>/dev/null
echo "$code" > "$out/exit"
echo "counter-review $stage: exit $code, ok=$(jq -r '.ok' "$out/summary.json" 2>/dev/null), $(jq -r '[.failures[]?.role] | length' "$out/summary.json" 2>/dev/null) failed roles, $(jq -r '.human_review_reasons | length? // 0' "$out/summary.json" 2>/dev/null) human-review reasons"
exit "$code"
