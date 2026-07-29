# Phase 8 Implementation Counter-Review — Manual Checkpoint Chain and Import

**Task**: mcp-integration
**Reviewed**: 2026-07-28, against the uncommitted working tree on `feature/mcp-server` (base `3891341`)
**Design under review**: `.archflow/tasks/mcp-integration/phases/phase-8-manual-checkpoint-chain-and-import.md`
**Reviewer stance**: fresh-context counter-review; a different model implemented and self-verified this. No files were changed.

## What was actually checked, and how

So the findings below can be weighed against what was ruled out rather than merely asserted:

| Area the brief flagged | How it was checked | Result |
|---|---|---|
| Schema/Zod agreement | Differential fuzz: every JSON pointer in all three new fixtures × {delete, null, string, number, boolean, array, object, +unknown-key}, plus root +unknown — **1,688 mutations** compared Ajv verdict against Zod verdict | **0 disagreements.** The mirrors agree. |
| Rank ordering | Read `durable.ts:297-458` clause by clause against the pinned invariant table (rows 4a, 5c–5t) and the six-component total order | Order is exactly as pinned: 4a carriers `chain` → `chain.authoritative_results` → `chain.evidence_chain` → `chain.initialization.mapping`; then 5c, 5d, 5e, 5f, 5g/5h, 5i, 5j, 5k, 5l, 5m, 5n, 5o, 5p, 5q, 5r, 5s(×3), 5t. Import block is physically before the implementation-output block. **No defect found.** |
| Sub-rank-dominates-index (no fused loops) | Traced all five fusion witnesses by hand against the code | 5c/5d/5e/5f/5l are five separate consecutive passes; all five witnesses are correctly constructed and genuinely discriminating. **No defect found.** |
| State-to-predecessor digest binding (5s) | Read the clause; traced the three corpus witnesses | Presence → revision → digest, in that order, with absence a failure carrying its own literal. Field-ordinal witness and the D1/D2 witness both bite. **No defect found.** |
| Test non-vacuity | Recomputed every digest in every new fixture | `manual-checkpoint.initialization_digest`, `manual-checkpoint-import.chain[0].initialization_digest`, `chain[1].predecessor.checkpoint_digest`, and the continuation fixture's link are **all genuinely correct** — the positive paths prove something. Five declared sets carry ≥2 members, `open_gate` is present, evidence tuples satisfy Phase 2's family cross-products. |
| Selector semantics | Traced all four algorithm steps, including m5's collision case and the head self-break quantifier | Matches the pinned algorithm exactly. **No defect found** in the algorithm itself (see finding 3 for a design/prose mismatch). |
| Build and suites | `tsc --noEmit`; `npm run test:contracts`; `npm test` | typecheck clean; contracts 442/442; full suite 1106/1109 with **exactly** the three pre-existing `release-offline` failures (assertion text confirmed as the `release-support.mjs:880` stale-bundle invariant, not a tally match) |
| Negative criteria | grep | No `prepared_intent`/`preparedIntentRef`, no `nullable`/`z.null`, no `"null"`, no `secret_scan`, no `path_class`, no self-digest field, no `export interface` in `durable-checkpoint.ts`; `durable-state.ts` still imports no zod |

The implementation is substantially correct. The findings below are one real (currently latent) regression, two undocumented deviations from pinned seams, and four coverage/quality gaps.

---

## Findings

### 1. `hasUniqueObjectPropertyValues` had its semantics changed, not just its visibility — and the change makes a missing key reject the whole array

**Severity: major**
**Where**: `src/contracts/validators.ts:36`

The design's Files table pins chunk 1's edit to this function exactly: *"Adds `export` to `hasUniqueObjectPropertyValues` (`:28`) … **No other change; every existing keyword's behaviour is byte-identical.**"*

The implementation also rewrote the body. The old code read each property and substituted `undefined` when it was absent or accessor-backed; the new code `return false`s the whole array on the first item whose property is absent, non-enumerable, or accessor-backed. Measured against the pre-change body:

| Input | Old | New |
|---|---|---|
| `[{id:"a"}, {other:1}]` — one item missing the key | `true` | **`false`** |
| `[{other:1}, {other:2}]` — two items missing the key | `false` | `false` |
| `[{id:"a"}, {id:"b"}]` | `true` | `true` |

This function backs the shipped `x-archflow-unique-by` Ajv keyword, which is used at **23 array subschemas** across `release-legal-review`, `release-manifest`, `triage`, `review`, `review-evidence`, `rubric`, `adjudication`, and `adjudication-evidence` — none of which this phase owns.

Two distinct problems:

- **Scope.** A shipped shared validator's behaviour changed under a chunk whose design mandate was "export only." Nothing in the phase document, `architecture.md`, or a code comment records it. The only trace is a new structural-corpus test (`durable-structural-corpus.test.ts`, *"unique object keys are enumerable data properties"*) that pins the new behaviour without noting it is new.
- **Correctness.** Rejecting a non-enumerable *data* property is the `CLAUDE.md` convention and is right. Rejecting an **absent** property is not the same hazard and is a strict regression: it conflates "this item does not carry the key" with "this array has duplicates", and reports the latter. It happens to be unreachable today only because every one of the 23 use sites has the keyed property in its items' `required` — verified individually, including `triage.dispositions`' two-branch `oneOf` and `release-legal-review.supersessions`. The first array declared with an optional key will be rejected outright, with a misleading uniqueness error.

**Suggested resolution.** Keep the enumerable/accessor hardening (it is the `CLAUDE.md` rule and it is correct). Split the absent case back out — `descriptor === undefined` should push `undefined` and continue, as before; only a present-but-accessor-backed or present-but-non-enumerable descriptor should fail the array. Then either extend the corpus test to pin *both* halves separately, or, if the reject-on-absent behaviour is genuinely wanted, raise it at the gate and amend the design's Files row rather than leaving it as a silent widening.

---

### 2. `ContinuationManualCheckpointV1.revision` is a new branded type, not the `SafeInteger` the seam pins — and no document records the change

**Severity: major**
**Where**: `src/contracts/durable-checkpoint.ts:40-44`, `:85`

The seam section is explicit that it is a hard interface — *"Every name below is a hard interface. A chunk that cannot resolve one **stops** rather than inventing a synonym"* — and it pins:

```ts
readonly revision: SafeInteger;                 // schema pins `minimum: 2`; see the narrowing note
```

The implementation instead declares a new exported brand and uses it:

```ts
declare const continuationCheckpointRevisionBrand: unique symbol;
export type ContinuationCheckpointRevision = SafeInteger & { readonly [continuationCheckpointRevisionBrand]: true };
```

The choice is defensible — arguably it is the *right* call, and it resolves an internal contradiction in the design. Verification step 4 requires a compile-time negative fixture (`@ts-expect-error`) proving "the TypeScript union has no inhabitant for a revision-1 checkpoint with a `predecessor`", and confirms `tsconfig.json` includes `test/**/*.ts` so an *unused* `@ts-expect-error` is itself a `tsc` error. Against the design's own pinned types that fixture is unsatisfiable: `1` is a member of `SafeInteger`, so `{...continuationFields, revision: parseSafeInteger(1)}` is a perfectly good `ContinuationManualCheckpointV1` and the directive would go unused. The brand is what makes `test/unit/durable-checkpoint.test.ts`'s fixture compile.

What is wrong is that nothing says so. Three consequences are now undocumented:

- The design's success criterion *"The checkpoint union narrows on presence, never on `revision`"* is **false as shipped**. With `revision: 1` on one branch and a brand on the other, `cp.revision === 1` is now a working discriminant. The `in`-operator discipline still holds everywhere in the code, so no behaviour is wrong — but a reviewer checking that criterion at the gate will find it does not describe the artifact.
- The brand is unconstructible without a cast. `parseSafeInteger` cannot produce one; only `manualCheckpointV1Schema`'s `as unknown as` cast does. Phase 9 and Phase 14 will have to cast every continuation checkpoint they build, and the JSDoc ("proven by the checkpoint parser to be at least 2") describes a runtime guarantee the type system takes on faith. The chain-derivation test already shows the cost — `revision: (previous.revision + 1) as never`, `revision: 3 as never` appear throughout.
- Neither `architecture.md` (which *was* amended for D-M) nor the phase document mentions the new exported type, so the seam table and the `$def`/export inventory no longer match the module.

**Suggested resolution.** Keep the brand. Amend the phase document's seam block and the "checkpoint union narrows on presence" criterion to describe it, note in `durable-checkpoint.ts` that the brand exists to make verification step 4's negative fixture reachable, and record in the phase's implementation log that the design's `SafeInteger` seam could not satisfy its own verification step. Add a construction helper or exported cast so Phases 9/14 do not each invent `as never`.

---

### 3. The selector does not re-express 5j/5k, though the design says it does — a chain whose head embeds another task's initialization is "greatest valid"

**Severity: minor**
**Where**: `src/contracts/durable-checkpoint.ts:377-428`

The design claims, at the "What the selector does *not* borrow" paragraph:

> Identity (5c/5d), **the embedded-initialization binding (5j/5k)**, and chain-wide initialization consistency (5l) are re-expressed inside the selector as whole-set stops…

`selectGreatestValidChain` re-expresses 5c/5d (step 1, `candidate.task_id` / `candidate.repository_identity_digest`) and 5l (step 3, `next.initialization_digest !== initializationDigest`). It never reads `candidate.initialization.task_id` or `.repository_identity_digest`, and it never re-derives `canonicalJsonDigest(head.initialization)` (5i). A revision-1 candidate that carries the anchor's own `task_id` while embedding a fully valid initialization for another task is accepted as the head and returned as the greatest valid chain.

The implementation is not at fault here — the design's own **pinned** four-step algorithm checks only the candidate's own two identity fields, and verification step 10 asks for exactly three `foreign-candidate` cases, none of which is 5j/5k. The code follows the algorithm and the tests. The design's prose is what overstates it.

This matters because Phase 14 consumes the selector to decide *which* chain is authority; if it does not also route the result through `validateDurableSemantics`, REQ-26's embedded-initialization half — the counter-review blocker this phase exists to close — is not enforced on that path.

**Suggested resolution.** Pick one and record it: either add the two comparisons to the selector (three lines in step 2, reported as `foreign-candidate`) plus two matrix cases, or correct the design paragraph to say 5i/5j/5k are deliberately validator-only and add an explicit Non-Goals row making it Phase 14's obligation to run the validator over any chain the selector returns.

---

### 4. Two verification-step assertions the design names explicitly are absent from the suites

**Severity: minor**
**Where**: `test/contracts/durable-structural-corpus.test.ts`, `test/contracts/durable-semantics-corpus.test.ts`

- **Verification step 5, the D-F finding.** *"Assert `isSortedUniqueBy([{revision:9},{revision:10}], tupleKey("revision"))` is `false` — this is the finding, asserted directly so the substitution is not re-litigated later. Then assert a chain running 9 → 10 is **accepted** by both schema authorities and by `validateDurableSemantics`."* Neither assertion exists — grep finds no numeric-key `isSortedUniqueBy` case and no 9→10 chain anywhere. The whole point of D-F is that `String(9) < String(10)` is `false`, and the next phase that reaches for `x-archflow-sorted-unique-by` on `revision` has nothing stopping it. (The behaviour itself is correct — I confirmed a 9→10 chain passes 5f — only the pin is missing.)
- **Verification step 7(d), rank 4a's ties.** *"a subject with an undecodable `phase_instance` at `chain[0]` and another at `chain[1].evidence_chain[0]` produces an error byte-identical to one with only the first."* The corpus has Phase 7's equivalent for `state.authoritative_results` (`durable-semantics-corpus.test.ts:1071`) but no import version, so the design's headline observation — that Phase 8 creates the first real collection-path ties and they stay unobservable — is asserted nowhere.

**Suggested resolution.** Add the two `isSortedUniqueBy`/9→10 assertions to the structural corpus (chunk 6's file, since the accept half is schema-only) with the validator half in the semantic corpus, and one `expect(reject(both)).toEqual(reject(lowerOnly))` case for the rank-4a tie, mirroring `durable-semantics-corpus.test.ts:1071-1093`.

---

### 5. The selector re-derives the tail's self-digest once per candidate, giving O(n²) canonical hashes over whole checkpoint documents

**Severity: minor**
**Where**: `src/contracts/durable-checkpoint.ts:406-411`

```ts
const linked = candidates.filter(
  (candidate) => !consumed.has(candidate) && checkpointSelfBreak(candidate) === undefined
    && checkpointLinkBreak(tail, candidate) === undefined
);
```

`checkpointLinkBreak(previous, next)` computes `checkpointSelfDigest(previous)`, so `tail` is canonicalised and SHA-256'd once for **every** remaining candidate, on every step of the walk. A revision-1 checkpoint embeds a whole `task-initialization`; Phase 14 will feed this the contents of a `manual/checkpoints/` directory. For *n* candidates that is Θ(n²) full-document hashes where Θ(n) suffices. The validator's 5f loop does not have this shape (one hash per adjacent pair).

**Suggested resolution.** Hoist `const tailDigest = checkpointSelfDigest(tail)` above the filter and compare `candidate.predecessor.checkpoint_digest === tailDigest` after the revision and presence tests, or memoise `checkpointSelfDigest` per candidate object. Either keeps the single-sourcing discipline (the predicate stays the shared one for the validator; only the walk's inner loop short-circuits) — but if you take the first option, note that it stops the walk from calling `checkpointLinkBreak`, which weakens verification step 11's single-sourcing probe; memoisation is the safer of the two.

---

### 6. Eight verification steps are manual probes with no recorded evidence, and the phase document carries no implementation log

**Severity: minor**
**Where**: `.archflow/tasks/mcp-integration/phases/phase-8-manual-checkpoint-chain-and-import.md`

The document ends at `*Designed: 2026-07-28*`; **Status** is still `IN PROGRESS`, all Success Criteria checkboxes are unchecked, and there is no implementation-log section. That is normal before the gate, but it means eight verification steps that are mutation probes rather than committed tests have **no evidence at all** at the point this review runs:

- step 2 (the D-I minimality probe: revert `AuthorityLinkBase`, confirm green)
- step 5's Ajv-keyword-removal probe
- step 11 (single-sourcing: inject a defect into `checkpointLinkBreak` and `checkpointSelfDigest`, confirm both suites fail, revert)
- step 12 (nine non-vacuity probes, including the three for the counter-review's blockers — drop 5j/5k, drop 5s, weaken 5s's presence check)
- steps 14, 16, 18's greps and `git diff` assertions

Several of these are exactly the checks that distinguish a live invariant from a decorative one. I re-ran what is cheap and repeatable (the negative-criteria greps of step 14 and step 16's `grep -c` on `durable-checkpoint.ts` — all clean; the fixture-digest half of test non-vacuity — all clean), but the drop-a-clause probes cannot be run without editing files.

**Suggested resolution.** Before the gate, run steps 2, 5, 11, 12, 16 and 18 and record each probe's observed before/after in the phase document's implementation log, then check the Success Criteria boxes against evidence. Findings 1 and 2 should be recorded there too, since both are deviations the parent documents do not yet reflect.

---

### 7. Two smaller pinned-transcription deviations, both harmless

**Severity: minor**

- **`task-state.schema.json:80`.** The design pins two different treatments of the `terminal` `$comment`: the Consumed table says rewrite it because both of its grounds are stale, while the D-M "three shipped assertions" paragraph says *"chunk 1 corrects it to eight in the same diff that adds the eighth."* The implementation rewrote it and dropped the count entirely (`"…because copying its two enum members is cheaper than promoting another shared reference shape."`). That is the better of the two — a count in a `$comment` is a stale-invariant generator — but a reviewer running verification step 18 will be looking for "eight" and will not find it. Reconcile the design's two sentences to match what shipped.
- **`durable-agreement.test.ts` `MIRRORED` rows (3)–(10).** The design pins each `defValidator` row's reference set narrowly (`primitives`, `path-claim`, owner, plus `evidence-slots` only where the pointer reaches it). The implementation passes the owner's full transitive set to every row. This is a superset, so every pointer still resolves and the "owner is always in its own reference set" rule is honoured; it just no longer demonstrates the narrower claim the design's reference-set paragraph makes. No action needed beyond noting it if the paragraph is meant to be normative.

---

## Nothing substantive found in these areas

Stated explicitly so they are not re-reviewed: the two `oneOf` constructions (both branches verified exhaustive and mutually exclusive, including the per-field `allOf` form the design pins as normative and the collapsed form it names as a defect); the twenty-two `issue_code` literals and both pinned corpus blocks at 44; `CHECKPOINT_BREAK_CODES ⊆ DURABLE_ISSUE_CODES` with `CHAIN_SELECTION_OUTCOMES` disjoint; the registry/barrel/`DEF_INVENTORY` transcription at 34/9/9/8/18; the narrowed sentinel sweep and its three surviving names; `SHAPES` at 11, `POSITIVE_FIELDS` at 14 with both continuation-routed rows genuinely executing, the array sweep at 19, and `DECLARED_SETS` at `length - 1` with `chain` named as the exception; the `chain[0]`-empty guards; and the mutual-exclusivity and D-B vacuity proofs.

## Triage

Triaged 2026-07-28 against the uncommitted implementation. Every finding was independently checked. Findings 1, 3, and 4 were accepted and fixed; finding 2 was accepted as a necessary implementation deviation and kept; finding 5 was rejected for Phase 8 as premature optimization; finding 6 was accepted for missing durable probe evidence but rejected insofar as it expected the implementation log before the human verification gate; finding 7 was accepted as harmless documentation/transcription deviation for the implementation log.

### 1. Shared uniqueness helper changed absent-key semantics — ACCEPTED AND FIXED

The review correctly separated the required descriptor hardening from an unrelated absent-key change. `hasUniqueObjectPropertyValues` now preserves the shipped behavior for absence: a missing descriptor contributes `undefined`, so one missing key among otherwise distinct keys remains unique and two missing keys collide. A *present* accessor or non-enumerable data property fails before its value is read, satisfying the repository's durable descriptor convention. The structural corpus now pins all five cases: ordinary enumerable keys, one missing key, two missing keys, a throwing accessor that is never evaluated, and a non-enumerable data property. Structural corpus, full contracts, typecheck, and diff checks pass.

### 2. Continuation revision brand deviates from the pinned `SafeInteger` seam — ACCEPTED AS A NECESSARY DEVIATION

The finding is correct that the exported interface differs from the design's exact seam. The design is internally contradictory: `SafeInteger` includes branded value `1`, while verification step 4 requires a non-vacuous `@ts-expect-error` proving a predecessor-bearing revision-1 checkpoint has no TypeScript inhabitant. Keeping `SafeInteger` makes that directive unused and typecheck fail. The implementation therefore keeps `ContinuationCheckpointRevision`, a `SafeInteger` subtype whose proof-producing boundary is `parseManualCheckpoint`; the compile-time test uses `parseSafeInteger(1)`, not a raw number, so it genuinely catches any regression back to `SafeInteger`.

The review is also correct that the design's statement that `revision === 1` never narrows is no longer literally true in TypeScript. Production consumers still use presence (`"initialization" in checkpoint` / `"predecessor" in checkpoint`) because it matches the durable union's actual structural discriminator and works uniformly on parsed documents. No standalone construction helper is added speculatively: Phase 8 has no writer, and later writers should parse the complete checkpoint or introduce a checked helper when they have a concrete construction path. The type-seam deviation and narrowing correction must be recorded in the Phase 8 implementation log before completion.

### 3. Selector omitted the embedded-initialization identity checks — ACCEPTED AND FIXED

`selectGreatestValidChain` now re-expresses 5j/5k for an initial head. If the embedded initialization's `task_id` or `repository_identity_digest` differs from the anchor, selection stops with `foreign-candidate`; it never returns a chain and adds no outcome or validator dependency. Separate shuffled-input tests cover foreign embedded task and repository identities, each with a linked successor so the stop cannot pass through an otherwise empty walk. The checkpoint, selector, unit-semantics, semantic-corpus, and typecheck suites pass.

### 4. D-F and rank-4a tie assertions were absent — ACCEPTED AND FIXED

The structural corpus now proves directly that `isSortedUniqueBy([{revision:9},{revision:10}], tupleKey("revision"))` is false and that both schema authorities nevertheless accept a structurally valid continuation import whose chain runs 9 to 10. The semantic corpus proves the correctly linked 9-to-10 chain is accepted by `validateDurableSemantics`. It also adds the import-specific rank-4a tie: a lower `chain[0].phase_instance` violation produces an error byte-identical to the same subject with an additional `chain[1].evidence_chain[0].phase_instance` violation, while the higher-only subject remains independently observable. The contract suite passes with 445 tests.

### 5. Selector performs quadratic full-document hashing — REJECTED FOR PHASE 8

The complexity observation is accurate, but it is not a correctness failure and the selector has no production caller until Phase 14. Memoization would add state and identity assumptions now, while hoisting the digest comparison would weaken the shared-predicate discipline that the mutation probes verify. Under the repository's prototype priorities, the simplest verified algorithm stays. Phase 14, which owns candidate enumeration and therefore knows the actual collection bound and call pattern, may memoize if a measured or demonstrated cost warrants it.

### 6. Probe evidence and implementation log were absent — PARTIALLY ACCEPTED

The implementation log is intentionally absent at this point: `archflow-phase-impl` requires verification evidence and the optional other-client counter-review to be resolved before the human verdict; logging, parent updates, and the commit gate follow that verdict. Success criteria likewise remain unchecked while the phase is `IN PROGRESS`. That part of the finding is rejected as stage-inappropriate, not omitted work.

The lack of durable mutation-probe evidence at review time is accepted. Exact observed evidence follows; every mutation was reverted before the clean runs:

| Probe | Observed failure |
|---|---|
| Convert `CurrentEvidenceSetRef` back to an interface | Typecheck failed with `TS2344` (missing string index signature); the alias form and `RequiredReviewSlots` probe compiled. |
| Remove chain `x-archflow-unique-by` | The duplicate-chain structural case flipped to Ajv acceptance. |
| Remove the initial branch's `required: ["initialization"]` | The missing-initialization structural case flipped to Ajv acceptance. |
| Invert `checkpointLinkBreak`'s revision comparison | 23 tests failed across the semantic and selector suites. |
| Make `checkpointSelfDigest` hash a mutated copy | 15 tests failed across both suites after adding an independent `canonicalJsonDigest` selector witness. |
| Drop 5c | 5 semantic-corpus cases failed. |
| Drop 5q | 1 wrong-state-bytes case flipped to acceptance. |
| Drop 5t | 1 foreign-initialization continuation case flipped to acceptance. |
| Drop 5m | 2 cases failed, separately proving the state-present and no-state paths. |
| Drop 5j and 5k | 4 cases failed: normal/legacy initialization crossed with task/repository substitution. |
| Drop 5s | 3 cases failed: missing adopted checkpoint, revision mismatch, and D1-versus-D2 digest mismatch. |
| Change 5s absence to skip | 1 omitted-`adopted_checkpoint` case flipped to acceptance. |
| Add a temporary Zod occurrence of `prepared_intent` | The narrowed no-mirror sentinel failed; the occurrence was removed and the clean grep count in `durable-checkpoint.ts` is zero. |

The final implementation log must carry the consequential probe results and the two accepted deviations from findings 2 and 7.

### 7. Terminal comment and MIRRORED reference-set transcription — ACCEPTED AS HARMLESS DEVIATIONS

The shipped terminal `$comment` deliberately removes the brittle numeric inventory rather than replacing seven with eight; this reconciles the design's two conflicting instructions in favor of the stated rationale (copying two enum members is cheaper than promoting another shared reference shape). The implementation log will record it.

The broader `MIRRORED` reference sets are required by the actual Ajv compilation boundary: resolving a `$def` through the `manual-checkpoint` owner compiles the full owner document, so pointer-local references are insufficient. The owner remains present in every row, all transitive references are registered, and all 18 agreement rows pass. This is a verification-fixture deviation only and does not alter a durable contract.
