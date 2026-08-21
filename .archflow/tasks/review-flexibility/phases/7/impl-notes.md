# Phase 7 Implementation Notes — Maintained documentation truth refresh

**Task:** review-flexibility
**Phase:** 7 of 7
**Base commit:** `869c189e10acdd8202e1e29cf8b6c7828d2c5403`

## Implementation Log: Phase 7 - Maintained documentation truth refresh

### Decisions Made

- **One implementation-entry stamp identifies the audit baseline.** All 14 caps-named maintained pages use `2026-08-21` and short commit `869c189` on line 3. Each page retained or expanded its `Covers` field to identify the source, test, contract, or whole-repository surface actually audited.
- **Config documentation separates live input from durable provenance.** `docs/DEPENDENCIES.md`, `docs/contracts/CONTRACTS.md`, `docs/mcp/SERVER.md`, `docs/mcp/DISPATCH.md`, `docs/state/DURABLE-STATE.md`, and `docs/workflow/LIFECYCLE.md` now agree that the copied task-local config is live and strictly parsed; successful config-observing transactions retain normalized `TaskStateV1.last_seen_config`; status reports informational parsed-leaf `config_change`; current input fingerprints exclude config; creation and settlement config digests retain their separate provenance roles.
- **Compatibility claims are deliberately bounded.** `docs/LIMITATIONS.md`, `docs/contracts/CONTRACTS.md`, `docs/mcp/SERVER.md`, and `docs/DEPENDENCIES.md` describe the exact-expected-digest legacy fingerprint retry as one read-side comparison using the task state's creation digest. It rewrites no authority and is not schema or state migration. Strict config parsing continues to fail closed, with the retired `producer` route accepted only as a narrow read-compatibility field.
- **Reviewer substitution is documented at the public seam.** `docs/mcp/DISPATCH.md`, `docs/review/COUNTER-REVIEW.md`, `docs/contracts/CONTRACTS.md`, and `docs/workflow/SKILLS.md` connect the optional `review-dispatch` submission to its nonempty reason, configured-route validation, request/run binding, evidence provenance, non-persistence, and mandatory-review boundary.
- **Rule settlements remain evidence, never client authority.** The maintained set consistently distinguishes mutable observed config, frozen subject/content conclusions, reconstructed presentation detail, human-required presentations, and fresh server-returned actions. Both commit branches preserve exact Git facts; only `requires_human_confirmation:true` adds the separate client-held confirmation.
- **The cross-cutting audit reflects the current tree.** `docs/PATTERNS.md` records the four-lifetime policy pattern; `docs/COMPLEXITY.md` identifies current authority-assembly hotspots without proposing a speculative framework; `docs/DEPENDENCIES.md` records 32 generated schemas plus the hand-written release-manifest schema (33 committed schemas total) and `approval_rules`; `docs/TESTING.md` and `docs/PATTERNS.md` record 107 unit, 27 contract, 40 integration, 3 crash, and 7 real-host test files.

### Deviations from Plan

- No governing PRD, task-design, or phase-design requirement changed, so those parent documents required no semantic update.
- `docs/cli/COMMANDS.md`, `docs/workflow/LIFECYCLE.md`, and `docs/state/DURABLE-STATE.md` were fully audited but needed only refreshed or evidence-expanded stamps; their behavior descriptions were already truthful.
- Fresh same-side review found that the first draft called all 33 committed schemas generated. The corrected inventory distinguishes the 32 generator-owned schemas from the hand-written release-manifest schema, matching `check:schemas` output and the 33-file committed directory.
- Server counter-review then found the same stale 31-of-32 present-tense inventory in `docs/COMPLEXITY.md`. The accepted significant revision updates it to 32 of 33 and reruns the complete verification transcript against the final documentation bytes.
- Repository-wide `git diff --check` continues to report trailing whitespace in the pre-existing user-owned `vitest.config.ts` change. The phase preserved that unrelated file. `git diff --check -- docs` passes, and the raw transcript records both observations rather than presenting the whole worktree as clean.
- No file below `docs/validation/` changed. The optional aggregate `npm run check` was not used as an acceptance predicate because this documentation phase did not modify the known point-in-time host-selection evidence.

### Patterns Established

- Maintained documentation stamps name the implementation-entry baseline that was actually explored, not the future documentation commit.
- Live mutable configuration, normalized observation snapshots, frozen policy conclusions, reconstructed human-facing detail, and returned semantic authority are distinct lifetimes; documentation should not collapse one into another.
- Compatibility behavior is described by its exact proof inputs and mutation limits. A bounded reader is not a migration system.
- Complexity audits preserve the reason for trust-boundary machinery and recommend simplification only around demonstrated duplicate joins or guards.
- No additional task-independent convention is proposed for `CLAUDE.md`; the repository guidance already requires maintained behavior documentation to change with the implementation it describes.

### Gotchas

- Config pin language is still correct for immutable workflow/constitution inputs, CLI flags, and staged legacy-import authentication. Searches for retired task-config pinning must be narrow, with broader hits classified in context.
- Content rules inspect repository-relative slash-segment paths only for phase implementations. They do not inspect bytes or semantics, do not detect embedded SQL, and do not apply content globs to planning artifacts.
- An override's evidence proves the route and reason submitted to the server and used for that run; it does not prove a human personally selected them.
- A rule settlement freezes what was evaluated but supplies no caller action. Clients follow only the fresh semantic action returned after the server authenticates the settlement and all safety conditions.
- `docs/validation/` is digest-bound point-in-time evidence, not part of the caps-named maintained set.

### Key Interfaces

- `InputFingerprintSubject` / `computeInputFingerprint(...)` — `src/contracts/fingerprints.ts` and `src/state/fingerprint.ts`; current composition excludes config and the resolver owns the bounded legacy retry.
- `TaskStateV1.last_seen_config` and `WorkflowViewV1.config_change` — `src/contracts/durable-state.ts`, `src/state/config-change.ts`, and `src/state/semantic-view.ts`; normalized observation and informational leaf-diff projection.
- The `review-dispatch` semantic submission / `route_override` — `src/contracts/semantic-workflow.ts`, `src/state/semantic-actions.ts`, and `src/dispatch/routing.ts`; optional request-scoped reviewer substitution with configured-route validation and evidence binding.
- `ApprovalRuleV1`, rule settlements, and content-detail reconstruction — `src/contracts/config.ts`, `src/state/approval-rules.ts`, `src/state/gates.ts`, and `src/state/implementation-manifest.ts`; phase-implementation path matching and frozen evaluation evidence.
- `WorkflowNextActionV1.commit.requires_human_confirmation` — `src/state/semantic-view.ts`; the client-visible discriminator layered over exact returned baseline, target ref, paths, staged diff, and message.
- Maintained documentation set — the 14 caps-named Markdown pages under `docs/`, excluding lowercase `docs/validation/` evidence.

### Verification Evidence

Raw command output is stored in `.archflow/runtime/tasks/review-flexibility/cache/phases/7/verification.txt` and is submitted for server-derived digest binding.

- The maintained-set discovery found exactly 14 caps-named pages, each with exactly one line-3 stamp using `2026-08-21` and `869c189`.
- Positive config/change-reporting, route-override, approval-rule, content/subject-trigger, and exact conditional-commit searches found the intended cross-page coverage. The narrow retired config-pinning vocabulary search found no matches; broader pin/config hits were manually classified as valid immutable or compatibility pins.
- Filesystem inventories matched 107 unit, 27 contract, 40 integration, 3 crash, and 7 real-host test files.
- Every maintained page has balanced Markdown fences. No relative link was added by the phase; existing relevant relative links resolve. No Mermaid block changed, and the affected-page blocks were manually inspected in the final diff.
- `npm run typecheck` passed.
- `npm run check:schemas` reported all 32 generated schemas current and left the hand-written release-manifest schema untouched; the committed schema directory contains 33 files in total.
- `git diff --check -- docs` passed. Repository-wide `git diff --check` reported only the preserved out-of-scope trailing whitespace in `vitest.config.ts`.
- The final maintained-documentation diff and full short status were captured in the raw transcript.
