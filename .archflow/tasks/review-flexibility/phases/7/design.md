# Phase 7 Design — Maintained documentation truth refresh

**Task:** review-flexibility
**Phase:** 7 of 7
**Status:** draft for review
**Design baseline:** `50e4c17` (`ArchFlow: Implement review-flexibility phase 6`)

## Goal

Refresh ArchFlow's complete 14-page caps-named maintained documentation set against the behavior implemented in phases 1–6. Remove the remaining obsolete config-pinning and unconditional-approval descriptions, document the bounded compatibility and trigger limitations honestly, refresh the cross-cutting patterns/dependency/complexity audits, and give every maintained page one truthful exploration stamp.

This is a documentation-only phase. It changes no runtime behavior, contract shape, generated schema, test, workflow/constitution policy, skill, release payload, task config, or point-in-time validation evidence.

## Requirements and approved scope

The work completes parent-design Phase 7 and PRD R9/observable criterion 5:

1. Reconcile the editable-config and semantic route-override behavior across the dispatch, server, contract, dependency, and cross-cutting pages.
2. Finish the limitations audit for config-schema evolution, phase-implementation path-trigger scope, and the bounded in-flight legacy fingerprint composition fallback.
3. Re-audit every page updated for Phase 6 activation so targeted approval, exception-gate precedence, and conditional commit confirmation remain mutually consistent.
4. Refresh `PATTERNS.md`, `COMPLEXITY.md`, `DEPENDENCIES.md`, test inventories, and every maintained exploration stamp from one implementation-entry baseline.
5. Preserve the separate `docs/validation/` evidence set unchanged. Its files are point-in-time, digest-bound evidence and are not maintained exploration pages.

The governing PRD and task design remain accurate. No parent-document update is planned.

## Repository context

The current implementation establishes these facts that the maintained set must state consistently:

- A task receives a task-local config copy, but each config-observing transaction or dispatch strictly parses the live copy. Successful transactions record normalized `last_seen_config`; status reports later parsed leaf changes informationally. A valid edit does not stale open gates or retained review evidence. Invalid or unsupported YAML still fails closed.
- Current `InputFingerprintSubject` excludes config. `config_digest` remains creation-time provenance and is separately retained by rule settlements. A read-side resolver may retry once with the state's recorded creation digest when an expected pre-cutover fingerprint is available; it neither rewrites evidence nor supplies a general migration mechanism.
- A dispatching semantic `review` offer optionally accepts `review-dispatch`. Its nonempty-reason `route_override` is validated like a configured route, request/operation-bound, carried to that review run, and recorded in evidence. It does not alter task config or the subject fingerprint. Runtime proves the route and reason were submitted, not that a human actually chose them.
- Counter-review always runs. A clean fixed point freezes a task-state-owned rule settlement. `wait:true` opens a human presentation; only the exact authenticated v2 policy plus clean safety checks may consume eligible `wait:false` evidence into a returned action. Clients never infer authority from the settlement itself.
- Content rules evaluate changed paths only for `phase-impl`; they do not inspect source semantics. A waiting settlement freezes complete matched paths, and presentation joins those paths to retained outputs for operations and signed byte deltas.
- Both human- and rule-authorized commits use exact server-returned Git facts. Only `requires_human_confirmation:true` requires the additional implementation commit conversation.
- Phase 6 activated the exact v2 constitution and future-task PRD/design/SQL defaults in repository seeds, but did not change this in-flight task config or install a machine-global bundle.

Known concrete documentation drift at the baseline:

- `docs/contracts/CONTRACTS.md` still includes config in the current input fingerprint.
- `docs/DEPENDENCIES.md` calls task routing/config byte-pinned, omits `approval_rules`, and has stale schema/config inventory.
- `docs/mcp/SERVER.md` still names a normal handler config-pin check.
- `docs/mcp/DISPATCH.md` still calls configured routes and task config pinned and does not fully connect the override to the public optional submission seam.
- `docs/OVERVIEW.md` narrows approval rules to document subjects and omits implementation content triggers in its opening model.
- `docs/TESTING.md` and `docs/PATTERNS.md` have stale suite inventories; the current tree contains 107 unit, 27 contract, 40 integration, 3 crash, and 7 real-host test files.
- `docs/COMPLEXITY.md` says the earlier split left an approximately 900-line `gates.ts`; it is now 2,010 lines, with related authority complexity also concentrated in `status.ts`, `implementation-manifest.ts`, and the state handler.

## Files

All maintained pages are in scope:

- `docs/OVERVIEW.md`
- `docs/COMPLEXITY.md`
- `docs/PATTERNS.md`
- `docs/DEPENDENCIES.md`
- `docs/TESTING.md`
- `docs/LIMITATIONS.md`
- `docs/workflow/LIFECYCLE.md`
- `docs/workflow/SKILLS.md`
- `docs/mcp/SERVER.md`
- `docs/mcp/DISPATCH.md`
- `docs/cli/COMMANDS.md`
- `docs/review/COUNTER-REVIEW.md`
- `docs/contracts/CONTRACTS.md`
- `docs/state/DURABLE-STATE.md`

Expected substantive edits are concentrated in `DEPENDENCIES`, `LIMITATIONS`, `PATTERNS`, `COMPLEXITY`, `CONTRACTS`, `DISPATCH`, `SERVER`, plus concise model/test corrections in `OVERVIEW` and `TESTING`. `LIFECYCLE`, `SKILLS`, `COUNTER-REVIEW`, `DURABLE-STATE`, and `COMMANDS` are already substantially truthful and should receive only evidence-backed connective corrections, if any, plus their refreshed stamps.

No file below `docs/validation/` is in scope. No source, test, asset, config, constitution, skill, generated-schema, `dist/`, or machine-global installation path is in scope.

## Work chunks

### Chunk 1 — Live config, fingerprint, and dispatch truth

Update `docs/DEPENDENCIES.md`, `docs/contracts/CONTRACTS.md`, `docs/mcp/DISPATCH.md`, and `docs/mcp/SERVER.md`.

- Replace normal-task pinning language with copied-but-live task-local config, strict parsing, transaction snapshots, and informational change reporting.
- Separate creation provenance and settlement config digests from the current input-fingerprint composition; describe the bounded legacy reader without promising migration.
- Describe the optional `review-dispatch` submission and its request-scoped, configured-route-validated, evidence-recorded behavior.
- Refresh schema/dependency inventories, including `approval_rules`, while preserving still-valid workflow, constitution, review-context, and legacy-import pins.

### Chunk 2 — Honest limitations

Update `docs/LIMITATIONS.md` while retaining its existing live-policy-edit and override-authorization disclosures.

- Config editability is not config-schema migration: strict incompatible/unknown shapes fail closed, and the retired `producer` key is only a narrow compatibility allowance.
- Content triggers apply only to phase-implementation paths under the documented slash-segment glob semantics. They neither inspect embedded SQL/semantics nor apply content globs to planning artifacts, so path naming can under- or over-match.
- The legacy fingerprint retry requires an expected exact pre-cutover digest plus this task state's creation provenance, is read-side and bounded, and never rewrites arbitrary in-flight state or evidence.

### Chunk 3 — Patterns, complexity, and verification map

Update `docs/PATTERNS.md`, `docs/COMPLEXITY.md`, and `docs/TESTING.md`; audit `docs/cli/COMMANDS.md`.

- Record the durable conventions separating mutable observed config, frozen rule evidence, reconstructed content-match detail, and server-returned authority.
- Reassess the gate/status/implementation-evidence complexity concentration honestly. Preserve why the trust-boundary machinery exists; identify concrete maintainability hotspots without proposing a speculative framework or implementing a refactor.
- Refresh suite counts and name representative coverage for live config/open-gate survival, old-fingerprint acceptance, override request/evidence binding, settlement persistence, content details, exact-v2 versus legacy authority, and conditional commit projection.
- Keep degraded mode read-only; do not imply the CLI mutates or repairs invalid config.

### Chunk 4 — Whole-model reconciliation and stamps

Audit `docs/OVERVIEW.md`, `docs/workflow/LIFECYCLE.md`, `docs/workflow/SKILLS.md`, `docs/review/COUNTER-REVIEW.md`, and `docs/state/DURABLE-STATE.md`, then reconcile all 14 pages together.

- Ensure the overview includes subject triggers and phase-implementation changed-path triggers.
- Ensure every page agrees that review is mandatory, ordinary human approval is triggered, exception gates remain human-required, and clients act only on returned semantic actions.
- Ensure route override, config-change, content-match, and commit-confirmation claims agree across their canonical pages.
- At implementation entry, capture one short `HEAD` and one exploration date before editing. Use that same baseline/date in the line-3 `Explored` stamp of all 14 pages; do not stamp the future implementation commit. Preserve or evidence-expand each page's `Covers` field.
- Manually inspect changed relative references and Mermaid blocks; do not claim nonexistent automated Markdown/link/Mermaid validation.

## Pinned cross-chunk interfaces

These meanings are exact across every page:

1. **Config lifecycle:** task-local, live, strictly parsed, editable; successful config-observing transactions update the normalized snapshot and read-only status reports field-level differences. No fallback silently runs under older live config bytes.
2. **Digest roles:** config is absent from the current input fingerprint. `config_digest` remains creation provenance and settlement evidence. Workflow and constitution pins remain intact.
3. **Override:** `review-dispatch` is optional only on a dispatching review offer; a supplied override requires a reason, lasts for that request/review run, follows configured-route validation, is request-bound and evidence-recorded, and never persists into config.
4. **Authority:** mandatory counter-review precedes the fixed point. A settlement records rule evaluation but never grants caller authority; a presentation requires a human, while an eligible no-wait path advances only through a fresh authenticated server action.
5. **Content triggers:** phase-implementation paths only, not semantic content; the frozen complete match joined with retained output yields operation and signed byte-delta details.
6. **Git:** returned baseline, target ref, paths, staged diff, and message remain exact in both branches; only a returned true confirmation bit adds the separate human commit confirmation.
7. **Stamps:** all 14 maintained pages use one actual implementation-entry date and short baseline commit. `docs/validation/` remains untouched.

## Success criteria

1. All 14 maintained pages have been read against their declared coverage and carry exactly one common, correctly shaped exploration stamp.
2. No maintained page retains the retired normal-task config mismatch/remediation model or claims current input fingerprints include config.
3. The canonical config, server, dispatch, contract, lifecycle, state, and limitation pages agree on live strict config, field-level reporting, digest roles, and the bounded legacy fallback.
4. The semantic reviewer override is discoverable from dispatch/review/contract/skill documentation and is consistently described as optional, request-scoped, reasoned, configured-route-validated, request-bound, and evidence-recorded.
5. Subject/content rules, exact-v2 authority, exception precedence, content presentation, and `requires_human_confirmation` semantics agree across the maintained set.
6. The three required limitations are explicit and do not overclaim schema migration, semantic content detection, or arbitrary legacy-task compatibility.
7. `PATTERNS`, `COMPLEXITY`, `DEPENDENCIES`, and `TESTING` reflect the current source/test/tooling shape without adding speculative implementation work.
8. Only the 14 maintained pages change for implementation content; the required phase implementation log is added by the implementation workflow. Point-in-time validation evidence and unrelated existing worktree changes remain untouched.

## Executable verification

At phase-implementation entry, capture the stamp inputs before documentation edits:

```bash
phase7_stamp_commit=$(git rev-parse --short HEAD)
phase7_stamp_date=$(date +%F)
```

Establish the exact maintained set (caps-named Markdown outside the lowercase validation evidence set):

```bash
mapfile -t maintained < <(find docs -type f -name '*.md' -printf '%p\n' \
  | awk -F/ '$NF ~ /^[A-Z][A-Z0-9-]*\.md$/ { print }' | sort)
printf '%s\n' "${maintained[@]}"
test "${#maintained[@]}" -eq 14
```

Verify one shared stamp after editing:

```bash
for f in "${maintained[@]}"; do
  test "$(rg -c '^\*\*Explored:\*\* ' "$f")" -eq 1 || exit 1
  stamp=$(sed -n '3p' "$f")
  case "$stamp" in
    "**Explored:** $phase7_stamp_date · **Commit:** \`$phase7_stamp_commit\` · **Covers:** "*) ;;
    *) printf 'bad stamp: %s: %s\n' "$f" "$stamp" >&2; exit 1 ;;
  esac
done
```

Prove the positive change-reporting model and fail on only the retired config-pinning vocabulary:

```bash
rg -n 'last_seen_config|config_change|field-level (config )?change|live task-local config' \
  docs/state/DURABLE-STATE.md docs/workflow/LIFECYCLE.md docs/LIMITATIONS.md \
  docs/contracts/CONTRACTS.md docs/DEPENDENCIES.md

if rg -n -i \
  'PINNED_CONFIG_MISMATCH|restore-pinned-config|pinned-config-schema-unsupported|task-pinned YAML configuration|byte-pinned per task|config pin check|configs pinned before|never amends the pinned config' \
  "${maintained[@]}"; then
  echo 'retired config-pinning model remains in maintained docs' >&2
  exit 1
fi

rg -n -i \
  'config.{0,60}(pin|pinned|pinning|mismatch)|(?:pin|pinned|pinning|mismatch).{0,60}config' \
  "${maintained[@]}"
```

The last command is a required contextual audit, not a zero-match assertion: valid hits include immutable workflow/constitution pins, pinned review context, staged legacy-import authentication, and the bounded legacy fingerprint fallback.

Verify cross-page concepts and current suite inventory:

```bash
rg -n 'review-dispatch|route override|route_override' \
  docs/mcp/DISPATCH.md docs/review/COUNTER-REVIEW.md docs/contracts/CONTRACTS.md docs/workflow/SKILLS.md
rg -n 'approval_rules|wait:false|wait:true|content trigger|subject trigger|rule settlement' \
  docs/OVERVIEW.md docs/contracts/CONTRACTS.md docs/review/COUNTER-REVIEW.md \
  docs/state/DURABLE-STATE.md docs/workflow/LIFECYCLE.md docs/workflow/SKILLS.md
rg -n 'requires_human_confirmation|exact.*commit|baseline|target ref|staged diff' \
  docs/contracts/CONTRACTS.md docs/workflow/LIFECYCLE.md docs/workflow/SKILLS.md docs/TESTING.md

test "$(find test/unit -maxdepth 1 -name '*.test.ts' | wc -l)" -eq 107
test "$(find test/contracts -maxdepth 1 -name '*.test.ts' | wc -l)" -eq 27
test "$(find test/integration -maxdepth 1 -name '*.test.ts' | wc -l)" -eq 40
test "$(find test/crash -maxdepth 1 -name '*.test.ts' | wc -l)" -eq 3
test "$(find test/real-host -maxdepth 1 -name '*.test.ts' | wc -l)" -eq 7
```

Verify Markdown fence balance and repository hygiene:

```bash
for f in "${maintained[@]}"; do
  fences=$(rg -c '^```' "$f" || true)
  test $((fences % 2)) -eq 0 || { echo "unbalanced fences: $f" >&2; exit 1; }
done

npm run typecheck
npm run check:schemas
git diff --check
git diff -- "${maintained[@]}"
git status --short
```

Manually inspect every changed relative link and Mermaid block in the final diff. No repository script validates Markdown links, Mermaid syntax, or exploration stamps, so the phase must not claim stronger automation.

`npm run check` is useful as an observation but is not the sole acceptance predicate for this documentation-only phase: Phase 6 recorded one inherited always-on host-selection digest failure because `docs/validation/host-selection.json` authenticates the prior `dist/manifest.json`. If run, require no new failure and record that inherited failure separately. Do not modify or fabricate authenticated `docs/validation/` evidence to make the aggregate command green.

## Risks and controls

- **Over-broad removal of pin language:** workflow, constitution, review-context, and staged legacy-import pins remain valid. Retired-vocabulary checks are narrow, and the broader config/pin search is manually classified.
- **Stamping without exploration:** all pages are explicitly audited against their `Covers` sources before receiving the common stamp; stamp-only pages are still read, not mechanically rebased.
- **Cross-page semantic drift:** the seven pinned interfaces above are checked across canonical pages after chunk edits, not documented independently with slightly different authority claims.
- **Historical evidence corruption:** `docs/validation/` stays untouched even though some entries describe superseded behavior; it remains honest point-in-time evidence.
- **Scope expansion from an observed runtime defect:** if the audit exposes an actual behavior defect, stop and revise the governing plan rather than changing source or tests inside this documentation phase.
- **Unrelated worktree changes:** preserve current `.codex/config.toml`, `vitest.config.ts`, task authority/state, and upload-marker changes; phase implementation stages only server-authorized paths.
