---
id: human-approval-for-material-plan-changes
version: 3
status: active
review_trigger: The change materially alters human-approved requirements, scope, architecture, externally consumed interfaces, trust boundaries, or verification commitments recorded in the plan. Report not-matched for meaning-preserving wording, formatting, and implementation-detail updates, and for work that carries out the plan as approved, including progress and status bookkeeping. Evaluate the change against the last human-approved plan, not only the last incremental edit. Report not-matched when no human-approved plan exists yet, since a new plan under its first review is not a change to one. When the change edits or departs from a plan and the reviewer cannot tell what the human-approved baseline was, or the supplied evidence cannot settle materiality, report uncertain with the missing evidence; never infer approval from the producer's classification.
---
The approved plan remains truthful as implementation proceeds. Maintenance that preserves approved decisions needs no new human decision. A material change to what a human approved requires a human decision, made in conversation or at a run's STOP; review rationale must describe the changed decisions or why they remain unchanged. SQL/database and repository-configured approval rules still apply, regardless of the change's size.
