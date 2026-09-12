# Review rubrics

Server-owned counter-review rubrics, one file per durable phase kind. The MCP
server selects the file for the phase under review, reads it fresh from the
installed bundle on every review and status call, and strictly validates it
before use.

| File | Phase kinds | `rubric_id` |
| --- | --- | --- |
| `prd.yaml` | `prd` | `prd-v1` |
| `design.yaml` | `design`, `phase-design` | `design-v3` |
| `implementation.yaml` | `phase-impl` | `implementation-v1` |

## Review intent

These criteria are focus guidance for consequential, evidence-backed review. Use
plans as context for intent and constraints, not as a checklist or a whitelist
of possible defects. Inspect existing code and tests before claiming behavior
or verification is missing. Extra coverage needs an identified undetected
failure; equivalent behavioral evidence is sufficient. Free-form reports need
no finding taxonomy, special IDs, or agreement on every suggestion. The producer
resolves supported material concerns and finishes when none remain.

The shared reviewer prompt carries this standard to every assigned role. The
criterion IDs and `blocking` fields remain part of the existing rubric format;
Review V4 does not turn them into finding-level verdicts or completion authority.

## Editing rules

- **Edits take effect on an explicitly requested install.** Refresh the tracked
  release payload and its asset manifest before installing; rubric text itself
  is read at runtime and is not cached. Never update shared installations
  without the user’s per-action request.
- `rubric_id` must match the table above (the server refuses a file whose id
  does not match its phase kind) and is excluded from the rubric digest.
- Criterion order is significant. The rubric digest and the review contract
  both depend on it; keep `schema_version` quoted (`"1"`) so YAML parses it as
  a string.
- Phase design and implementation partition their ordered criteria between
  general reviewers and a dedicated `test-reviewer`. The specialist owns
  `test-strategy` for phase design and `verification-evidence` plus
  `test-quality` for implementation. Older configurations with no explicit
  route use the shipped Luna/xhigh default; general review never inherits the
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
