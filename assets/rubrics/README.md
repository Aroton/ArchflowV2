# Review rubrics

Counter-review rubrics for standalone work. `archflow-local review` selects the file
for the stage under review, reads it fresh from the installed bundle on every
review, and strictly validates it before use.

| File | Review subject | `rubric_id` |
| --- | --- | --- |
| `simple-plan.yaml` | plan stage | `simple-plan-v1` |
| `implementation.yaml` | implementation stage | `implementation-v1` |

## Review intent

These criteria are focus guidance for consequential, evidence-backed review. Use
plans as context for intent and constraints, not as a checklist or a whitelist
of possible defects. Inspect existing code and tests before claiming behavior
or verification is missing. Extra coverage needs an identified undetected
failure; equivalent behavioral evidence is sufficient. A test's cost is judged
with its coverage: a test slower than what it proves requires, or one that
repeats another's protection, is worth naming with its cheaper equivalent.
Free-form reports need
no finding taxonomy, special IDs, or agreement on every suggestion. The producer
resolves supported material concerns and finishes when none remain.

Plan review judges what makes a good plan: fidelity to the ask, feasibility in
current code, consequential decisions, proportional scope, and useful
verification. A finding names the missing decision or failure and its
consequence; plan length, a preferred representation, or a model recommendation
alone is not a defect. Its test reviewer assesses whether the planned
verification would expose important failures. Implementation review judges
actual behavior and the supplied verification evidence; implementation notes and
raw logs are supporting evidence when provided.

The shared reviewer prompt carries this standard to every assigned role. The
criterion IDs and `blocking` fields remain part of the existing rubric format;
the review records an explicit outcome and concise feedback without turning
rubric fields into finding-level verdicts or completion authority.

## Editing rules

- **Edits take effect on an explicitly requested install.** Refresh the tracked
  release payload and its asset manifest before installing; rubric text itself
  is read at runtime and is not cached. Never update shared installations
  without the user’s per-action request.
- `rubric_id` must match the table above (the review refuses a file whose id
  does not match its selected stage) and is excluded from the rubric digest.
- Criterion order is significant. The rubric digest and the review contract
  both depend on it; keep `schema_version` quoted (`"1"`) so YAML parses it as
  a string.
- Plan and implementation review partition their ordered criteria between
  general reviewers and a dedicated `test-reviewer`. The specialist owns
  `test-strategy` for plans, and `verification-evidence` plus `test-quality` for
  implementation. Older configurations with no explicit route use the shipped
  test-reviewer default; general review never inherits the test-owned criteria.
- A missing or invalid file fails the review closed with `CONFIG_INVALID`,
  naming the file — there is no silent fallback to a previous rubric.
- These files ship in the install bundle and are never scaffolded into target
  repositories. The active rubric is read-only to the producer, who cannot
  substitute their own.
