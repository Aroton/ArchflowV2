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

## Editing rules

- **Edits take effect on install.** Run the installer to refresh the bundle and
  the next review uses the new bytes — no rebuild needed; the server never
  caches the files.
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
