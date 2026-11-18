# <Run title> — open deferred findings

<!-- Open entries only, one line each, with the owner on the line so a search finds it:
- [ ] <review id>-<finding id> (<severity>): <claim> → <owner> — deferred because <reason>

The owner is the task that must pick the finding up, a milestone whose rows are not written yet, or a STOP report.
`grep -n '→ <task id>' DEFERRED.md` gives a task's entries when its packet is written. The file is read whole at each
milestone's deferral pass, which re-decides every entry, and by the planner that details a milestone.

An entry that closes leaves this file and becomes a `- closed` line in HISTORY.md. None stay open past the final STOP. -->
