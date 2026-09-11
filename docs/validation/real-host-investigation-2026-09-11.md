# Real-host failure investigation — 2026-09-11

This is point-in-time investigation evidence for the automation-audit checkout, not a replacement for the recorded full-suite run. No global installation was performed. Temporary transcript instrumentation was removed after the probes.

## Original run

The full suite reported 28 passed, 2 failed and 3 skipped. The failures were a stale recorded bundle digest and Gemini missing the seeded consumer break. Codex initialization was skipped after a capability probe failed. The full log is `/tmp/archflow-automation-audit-real-host.log`.

The evidence writer runs after the digest assertion, so a newly rebuilt bundle can fail that assertion before the same run refreshes the evidence. The digest assertion passed after the refresh. This is evidence lifecycle ordering, not a workflow runtime failure.

## Gemini: concrete workspace and evidence problem

The focused Gemini scope test subsequently passed all its general-review, test-review and constitution-review assertions. However, the captured general-review transcript makes that pass unsuitable as clean validation:

1. The process init event advertised `/tmp/archflow-dispatch-GDGS3w/repo` as cwd.
2. The tool command `pwd` returned the machine-global `~/.gemini/antigravity-cli/scratch` directory.
3. The reviewer searched other checkouts and `/tmp`, found the original task fixture outside the snapshot, and read its task state.
4. It executed the broken consumer, observed the expected TypeError, and also read the real-host test source in another checkout.
5. It returned the expected consumer-break finding. The test and constitution reviews also detected the break.

The attempted termination of an out-of-scope grep found that the process had already exited. No cancellation changed the recorded general-review result. The original empty-findings run did not retain a successful child transcript, so this experiment cannot establish its exact cause. It does establish that the current adapter's process cwd is insufficient to bind Antigravity tool execution to the supplied snapshot.

Raw diagnostic transcript: `/tmp/archflow-probe-b82e5329-48dd-46bf-995c-8c7d51446bab.json`. Focused log: `/tmp/archflow-investigation.log` (one test passed, ten skipped by selection). Raw transcripts are local scratch evidence and may disappear; they are not committed because they contain unrelated machine context.

## Codex: failure did not reproduce

The isolated Codex capability probe and initialize-task journey succeeded with unchanged request logic: status returned an initialization offer, apply accepted the task ask, and durable state reached PRD produce/running with submit-work next. JSONL MCP arguments were objects, including the nested invocation; no argument-decoding defect was observed.

The initial investigation selection did not run the Codex journey. The subsequent explicit selection `reaches submit-work in Codex` passed (one test passed, seven skipped by selection); log: `/tmp/archflow-codex-investigation.log`. Its successful journey transcript is `/tmp/archflow-host-probe-1789167181758.json`. This does not retroactively change the earlier full-suite observation or prove why its capability probe failed.

## Recommended follow-up

- Bind Antigravity's actual tool workspace explicitly and verify it with a small real-host sentinel before rerunning repository reviews. Check supported host project/directory controls; do not assume process cwd changes the tool workspace. Keep unrelated host context out of this review route.
- Retain bounded diagnostic evidence for failed semantic real-host assertions, including successful child processes whose review content failed the test. A schema-valid answer is not evidence of correct repository access.
- Report capability-probe misses as observed request/host errors with their actual response; do not infer an account-wide serialization limitation from one miss.
- Validate refreshed host-selection evidence after its writer during opt-in runs, while retaining offline integrity validation of existing evidence.

No retry policy, rubric, approval boundary, or defect assertion was weakened.
