# Document-production guidance trial

Observed 2026-09-15. This is a small forward test of phase-design production guidance, not an implementation benchmark or a token-savings claim.

Two independent subagent sessions with inherited model settings received the same raw brief. One received the production/fit-check excerpt from the checkout's original phase-design skill; the other received the revised excerpt. Neither saw the other's output or this comparison. Both wrote only a phase design in temporary storage; no workflow, installed skill, or in-flight task was changed.

The brief described a pure download-retry policy consumed later by two hosts. Existing hosts supply serialized events, monotonic time, ordered effects, and generation-preserving completion. Fixed requirements cover two retries after 1000 ms and 2000 ms, pause without cancellation, resume with elapsed delay preserved, cancel/replacement, stale or duplicate completion, repeated time notifications, and a terminal retry budget. Implementation is outside this trial. The brief supplied API evidence but no actual repository inventory or language/toolchain.

| Observation | Original guidance | Revised guidance |
| --- | --- | --- |
| Whitespace-delimited output words | 2,313 | 1,684 |
| Duplicate completion after a later retry starts | Identified missing attempt correlation | Identified missing attempt correlation |
| Existing host guarantee versus new integration requirement | Explicitly distinguished | Explicitly distinguished |
| Pause/deadline, replacement, and terminal behavior | Explicit rules and traces | Explicit transition table and traces |
| Organization | Separate context, interfaces, approach, chunks, success criteria | Combined contract/mechanism and implementation/verification |

Both designs correctly noticed that `(id, generation, outcome)` cannot distinguish an old attempt's duplicate from the active retry's completion. Both introduced an attempt token in the proposed policy contract and explicitly required future adapters to preserve it, rather than claiming the existing host already supplied that guarantee. Both retained the retry arithmetic and representative failure checks.

The revised output was 629 words shorter (27.2%) in this single sample while retaining those consequential decisions. The original output was already substantive. This observation supports the intended organizational change, not a claim that the old guidance was incapable or that the improvement will repeat on every task.

Limitations: no implementation agent executed either design, no compiler or behavioral oracle verified the proposed module, and no actual model token usage was collected. With no repository inventory, the original output deferred runner discovery while the revised output proposed ECMAScript modules and Node's built-in runner; that choice would need repository validation in real work. This trial therefore does not establish lower-model success, repository-grounded verification quality, or total cost savings. Subsequent calibration should use the isolated paired implementation procedure in `../TESTING.md` and record defects, rework, review rounds, and actual usage where available.
