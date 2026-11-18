# <Run title> — history

<!-- The record of what the run has already done, in the order it happened. Added to at the end, never rewritten, and
     not read at resume: search it (`grep -n`) when a question needs the past. Append with a shell command
     (`cat >> HISTORY.md <<'EOF'`), so the file is not read in order to write to it.

A deferred finding that closes is one line, added when it closes:
- closed <review id>-<finding id> (<severity>): <claim> — fixed <short sha> | already fixed | obsolete | won't fix: <reason>

A session's report is one block, added at its handoff. The closed lines above it belong to that session:
## Session N (<date>)
- Merged: <ids> (<done>/<total>)
- Merge checks / full validation: <result; how long the full suite took>
- Routing: <per writing model: tasks, findings by severity (structure n), fix rounds; run-time hatches with their task>
- Decisions reported: <each call the orchestrator made, with how to undo it, or none> -->
