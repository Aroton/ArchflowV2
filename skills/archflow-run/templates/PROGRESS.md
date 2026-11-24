# <Run title> — progress

**STATUS: PLANNING**

Resume: run `/archflow-run <name>` in a fresh session on the orchestrator's model (`opus` at `high` effort unless the plan's routing says otherwise).

<!-- Every session reads this file whole and carries it on every turn, so it holds only what a session needs in order
     to act next. A record of what already happened (a session's report, a closed finding, the story of a review, a
     check's result) goes to HISTORY.md or the task's review file, not into a new section here. Open deferred findings
     are in DEFERRED.md, read for the task that owns them. -->

## Waiting on the human
<!-- Empty unless the status is AWAITING USER. Written so a fresh session can ask again in full:
- <what must be decided, and why it matters>
  - Choices: <each choice and what it leads to>
  - Recommendation: <choice, and why>
  - Blocked meanwhile: <tasks or none> -->

## Resume here
<!-- Rewritten at each handoff, not added to. The session's report goes to HISTORY.md.
- In flight: <ids, worktrees, or nothing>
- Environment: <what the next session must know to run things: a local stack, a path that changes per session, or nothing>
- Carry-overs: <items the next tasks must take that DEFERRED.md does not already hold, or none>
- Next: <ordered list> -->

## Milestone board
| Milestone | Goal | Status | Gate | STOP |
|---|---|---|---|---|
| M1 | <goal> | — | — | — |

## Approvals
- STOP 0 (plan): <pending | approved <date>: summary of the human's answer>
<!-- one line per later STOP or halt: - <STOP n | halt: topic> — <date>: <the question in a few words> → <the human's answer> -->

## Task log
<!-- Active milestone only: one line per merged task: - <id> — <short sha> — <full | light> — written on <model> — reviews/<id>-r<k>.md (critical/major/minor; structure n) <fix rounds; a run-time hatch if one opened; delta review if one ran; carried ids → owner> -->
<!-- The line points at the review file. What the review found and what was done about it is told there, not here. When a milestone finishes, move its task-log lines to HISTORY.md with a shell command. -->

## Decisions to report
<!-- Calls the orchestrator made on the human's behalf that they have not been told about yet. Reported in full in the
     next message that ends a turn, then moved into that session's report in HISTORY.md.
- <ADR id or review row>: <what was decided, in plain words> — why: <reason> — undo: <how> -->

## Gate log
| Gate | Date | Lenses (c/M/m per lens) | Verdict |
|---|---|---|---|
