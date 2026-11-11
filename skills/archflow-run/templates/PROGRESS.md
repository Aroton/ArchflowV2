# <Run title> — progress

**STATUS: PLANNING**

Resume: run `/archflow-run <name>` in a fresh session on the orchestrator's model (`opus` at `high` effort unless the plan's routing says otherwise).

## Waiting on the human
<!-- Empty unless the status is AWAITING USER. Written so a fresh session can ask again in full:
- <what must be decided, and why it matters>
  - Choices: <each choice and what it leads to>
  - Recommendation: <choice, and why>
  - Blocked meanwhile: <tasks or none> -->

## Milestone board
| Milestone | Goal | Status | Gate | STOP |
|---|---|---|---|---|
| M1 | <goal> | — | — | — |

## Approvals
- STOP 0 (plan): <pending | approved <date>: summary of the human's answer>
<!-- one line per later STOP or halt: - <STOP n | halt: topic> — <date>: <the question in a few words> → <the human's answer> -->

## Task log
<!-- one line per merged task: - <id> — <short sha> — <full | light> — reviews/<id>-r<k>.md (critical/major/minor) <fix rounds; delta review if one ran; carried ids → owner> -->

## Decisions to report
<!-- Calls the orchestrator made on the human's behalf that they have not been told about yet. Reported in full in the
     next message that ends a turn, then moved into that session's handoff.
- <ADR id or review row>: <what was decided, in plain words> — why: <reason> — undo: <how> -->

## Deferred findings
<!-- open:   - [ ] <review id>-<finding id> (<severity>): <claim> → <owning task> — deferred because <reason>
     closed: - [x] ... — fixed <short sha> | closed: <already fixed | obsolete | won't fix: reason> -->
<!-- A deferral pass after each milestone gate re-decides every open entry; none stay open past the final STOP. -->

## Gate log
| Gate | Date | Lenses (c/M/m per lens) | Verdict |
|---|---|---|---|

## Session handoffs
<!-- ### Session N handoff (<date>)
- Merged: <ids> (<done>/<total>)
- Checks / full suite: <result>
- In flight: <ids, worktrees>
- Decisions: <each call the orchestrator made, with how to undo it, or none>
- Carry-overs: <items next tasks must take>
- Next: <ordered list> -->
