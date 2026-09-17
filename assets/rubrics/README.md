# Review rubrics

Server-owned counter-review rubrics for workflow artifacts and standalone work. The MCP
server selects the file for the phase or standalone stage under review, reads it fresh from the
installed bundle on every review and status call, and strictly validates it
before use.

| File | Review subject | `rubric_id` |
| --- | --- | --- |
| `prd.yaml` | `prd` | `prd-v1` |
| `design.yaml` | `design` | `design-v3` |
| `phase-design.yaml` | `phase-design` | `phase-design-v1` |
| `simple-plan.yaml` | standalone plan | `simple-plan-v1` |
| `implementation.yaml` | `phase-impl`, standalone implementation | `implementation-v1` |

## Review intent

These criteria are focus guidance for consequential, evidence-backed review. Use
plans as context for intent and constraints, not as a checklist or a whitelist
of possible defects. Inspect existing code and tests before claiming behavior
or verification is missing. Extra coverage needs an identified undetected
failure; equivalent behavioral evidence is sufficient. Free-form reports need
no finding taxonomy, special IDs, or agreement on every suggestion. The producer
resolves supported material concerns and finishes when none remain.

Each artifact has a distinct review purpose. PRD review assesses user outcomes,
scope, product choices, and observable acceptance. Overall-design review assesses
architecture, ownership, shared contracts, and useful phase boundaries.
Phase-design review assesses the concrete implementation handoff: remaining
consequential decisions, mechanisms, current interfaces, and available predecessor
guarantees. Its test reviewer assesses whether verification exposes important
failures. A finding names the missing decision or failure and its consequence;
document length, a preferred representation, or a model recommendation alone is
not a defect. Repeated contracts matter when they obscure decisions, conflict, or
cause avoidable delivery cost.

Standalone plan review uses its own rubric for a good plan: fidelity to the ask,
feasibility in current code, consequential decisions, proportional scope, and
useful verification. It requires no parent documents, phase structure, manifests,
or implementation-effort recommendations. Standalone and workflow implementation
reviews share criteria for actual behavior and supplied verification evidence;
implementation notes and raw logs are supporting evidence when provided.

The shared reviewer prompt carries this standard to every assigned role. The
criterion IDs and `blocking` fields remain part of the existing rubric format;
Review V5 records an explicit outcome and concise feedback without turning rubric fields into finding-level verdicts or completion authority. Archived V4 reports retain their original meaning.

## Editing rules

- **Edits take effect on an explicitly requested install.** Refresh the tracked
  release payload and its asset manifest before installing; rubric text itself
  is read at runtime and is not cached. Never update shared installations
  without the user’s per-action request.
- `rubric_id` must match the table above (the server refuses a file whose id
  does not match its selected review subject) and is excluded from the rubric digest.
- Criterion order is significant. The rubric digest and the review contract
  both depend on it; keep `schema_version` quoted (`"1"`) so YAML parses it as
  a string.
- Phase design, standalone plans, and implementation partition their ordered criteria between
  general reviewers and a dedicated `test-reviewer`. The specialist owns
  `test-strategy` for phase design and standalone plans, and `verification-evidence` plus
  `test-quality` for implementation. Older configurations with no explicit
  route use the shipped test-reviewer default; general review never inherits the
  test-owned criteria.
- Changing any digested byte changes the rubric digest, which folds into
  in-flight tasks' input fingerprints: a mid-task edit fails those tasks closed
  with `INPUT_FINGERPRINT_MISMATCH` on their next review-cycle step. Edit
  rubrics between tasks.
- A missing or invalid file fails the review closed with `CONFIG_INVALID`,
  naming the file — there is no silent fallback to a previous rubric.
- These files ship in the install bundle and are never scaffolded into target
  repositories. Producers receive the active rubric read-only through
  `review_context.rubric` and cannot substitute their own.
