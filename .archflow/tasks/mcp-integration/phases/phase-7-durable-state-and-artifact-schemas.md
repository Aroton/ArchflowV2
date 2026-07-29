# Phase 7: Durable State and Artifact Schemas

**Status**: COMPLETE
**Implemented**: 2026-07-28
**Task**: mcp-integration
**Goal**: Define every persisted shape as a versioned normative schema with one cross-document semantic authority.
**Depends on**: Phase 6
**Requirements**: REQ-04, REQ-11, REQ-13, REQ-14, REQ-21, REQ-26, REQ-50

**This phase completes no requirement.** It wires no handler, performs no mutation, and reads nothing at runtime; it defines file formats. Each requirement receives an exact slice. REQ-04 gets the `task-initialization` and `legacy-import-initialization` shapes that *carry* the pinned identity, base commit, workflow, constitution, and config digests — nothing records or enforces them until Phase 9. REQ-11 gets the `document` artifact shape that holds review provenance — path, content digest, producing step, declared inputs, and input fingerprint; the review schemas, canonical Markdown rendering, and finding IDs are Phase 2's, the attestation is Phase 12's, and the evidence chain moved to Phase 8 with the checkpoint family. REQ-13 gets the digest-bound fields later freshness comparisons read, not the fixed-point loop. REQ-14 and REQ-21 get the `state.json` schema — the *format* of the truth `archflow-status` will read, with no reader and no writer here. REQ-26 gets the `path_class` constraints that bound what an implementation output may claim, enforced only when a handler calls them. REQ-50 gets the legacy-import manifest; its manual-import-as-checkpoint-chain half moved to Phase 8. **REQ-39 left this phase entirely** — it was carried only by the manual-checkpoint chain format, and it is now Phase 8's. Completion for all seven belongs to the phases that integrate and verify the behaviour.

## Context

Phase 6 landed the first filesystem and Git code in `src/`: canonical JSON with re-render byte authority, in-process Git blob OIDs and tree modes, three path brands, 17 path classes and containment, repository and task identity, whole-file `config.yaml` pinning, the request digest and declared-input fingerprint, divergence and conflict detection, and the secret-scan *result* contract. Six of its decisions bind this phase directly. (1) `src/contracts/**` may never import `src/repository/**`, asserted structurally at `test/contracts/repository-boundary.test.ts:28-38` — so the path-class *template* tables are out of reach here. (2) Digest inputs are `assertPlainJson`-validated and `structuredClone`-materialized once before being inspected twice; this is now a repo-wide rule in `CLAUDE.md`. (3) Zod and JSON Schema edits are one indivisible change, including the inline ID-pattern mirrors that eight schemas already carry. (4) Set-valued collections are sorted and duplicate-checked before hashing, because `canonicalJsonBytes` preserves array order. (5) Parsers throw; orchestrating readers return `ProjectResult<T>`; pure derivations return their value. (6) `npm run check:release` is blocked on a contradiction inside Phase 5's release-integrity model, which this phase inherits and does not fix.

Phase 5 set the precedent for purely internal shapes: `release-manifest.schema.json` and `release-legal-review.schema.json` have JSON Schema authority, are exercised only through Ajv, and have no TypeScript module in `src/contracts/` at all.

This document **replaces an unapproved draft** that was carved out of the combined Phase 6+7 design and written before Phase 6 was implemented. Its field-level material is carried forward; every Phase 6 reference has been re-verified against shipped source, and nine of the draft's assumptions were wrong. Each correction is marked inline with its reason so it is not undone later.

**The manual-checkpoint family left this phase at the design gate.** `ManualCheckpointV1`, `ManualCheckpointImportV1`, and everything that existed only to serve them — `PredecessorLink`, `ProjectionDigestRef`, `EvidenceChainEntry`, `checkpointSelfDigest`, the chain-continuity and import-head invariants — are now **Phase 8 (Manual Checkpoint Chain and Import)**. The two defects that forced the move are recorded in Non-Goals so Phase 8 inherits them. Every later phase shifted by one; every reference below uses the shifted number.

## What We're Building

Seven versioned durable shapes, each with a JSON Schema authority in `src/contracts/schemas/v1/`, plus Zod mirrors for the five shapes reachable from the architecture's `archflow_state.artifact` union (D2), plus one consolidated cross-document semantic validator for the invariants that no single schema can express. Structural authority is pushed as far as it will go: the implementation-output operation × storage × file-type table, the byte caps, the zero-byte rule for git-object accounting entries, the claimable path-class set, the shape of the one-active-gate rule, and intra-document set ordering and uniqueness are all expressed in the schemas and in the TypeScript types, so a contradiction is unrepresentable rather than merely rejected. `validateDurableSemantics` is reserved for what genuinely spans documents or spans shapes **and that its three-slot subject can actually receive**: state ↔ initialization agreement, state ↔ artifact and state ↔ maintenance task identity, the in-flight fingerprint, accounting sums and their correspondence to the outputs they measure, and the output-entry residue. It resolves **no** reference target — no result manifest, decision, approval, waiver, or authority link is in its signature, and it claims no correlation over one (Non-Goals names the owner of each).

The phase implements **no** state mutation, transaction kernel, lock, CAS, intent receipt, atomic write, snapshot materialization, payload restore, gate lifecycle, dispatch, checkpoint chain, or secret-scanning engine, and adds **no runtime dependency**.

## Consumed from Phase 6 and earlier — verified

Every row below was checked against shipped source at `028e628`. The rows that *bite* — where the draft assumed something the code does not provide — are marked.

| Symbol | Location | What Phase 7 uses it for | Constraint that bites |
|---|---|---|---|
| `Sha256Digest`, `sha256DigestV1Schema` | `evidence.ts:13`, `:55` | every digest field | The exported Zod schema is an unbranded `ZodString`; a mirror needing `z.ZodType<Sha256Digest>` casts, as `canonical.ts:18` and `trust.ts:140` do. |
| `SafeId` | `evidence.ts:14`, `:56` | `result_id`, `rule_id` | Admits `:`; never usable as a path segment. |
| `SafeInteger`, `safeIntegerV1Schema` | `evidence.ts:24`, `:61` | every count | **`.min(0)` — admits `0`.** `primitives.schema.json#/$defs/safeInteger` has `"minimum": 0`. Neither can be reused for a `>= 1` field. See D8 below. |
| `SafeCode` | `evidence.ts:22`, `:59` | every `issue_code` the validator emits | Lowercase, `[a-z0-9][a-z0-9_-]{0,63}`. Every literal in the invariant table below is checked against this pattern. |
| `PathSafeId` | `evidence.ts:19`, `:57` + refinements `:50-53` | `gate_id`, `intent_id`, `maintenance_id` | Two `.refine()` rules (reserved Win32 device names, trailing dot/space) are **not** expressible as the bare pattern; only the exact lookahead in `primitives.schema.json#/$defs/pathSafeId` agrees with them. |
| `TaskSlug` | `evidence.ts:21`, `:58` + the same refinements | `task_id` | Lowercase, ≤64, admits `.`, `_`, and a leading digit since Phase 6's vocabulary swap. |
| `TaskPathClaim`, `RepositoryPathClaim` | `path-claims.ts:11`, `:13`; schemas `:44`, `:45` | every persisted path | **Both brands are one runtime validator** (`pathClaimLexicalSchema:31-42`) cast twice. At runtime the two frames are indistinguishable. See D3, and the withdrawn cross-class-rename claim under `OutputEntry`. |
| `RawGitPath`, `rawGitPath` | `path-claims.ts:15`, `:72` | `undeclared_paths` | Total constructor, no lexical rule. **It has no JSON mirror in `schemas/v1/` today**; this phase authors one inline as `{"type":"string"}` where `undeclared_paths` is declared. This is the one field that can carry an unrepresentable name. |
| `PATH_CLASSES` (17), `TASK_PATH_CLASSES` (13), `REPOSITORY_PATH_CLASSES` (4), `READ_ONLY_PATH_CLASSES` (2), `PathClass`, `parsePathClass` | `path-claims.ts:86-105` | the claimable/server-owned partition | Three of the four repository classes live *under* `.archflow/` (`src/repository/paths.ts:144-160` — the template table row at `:144`, the shared-template note at `:147-152`, and `REPOSITORY_CLASS_RULES` at `:154-160`, which carries only the two read-only rules; `task-branch-constitution` has no rule of its own and is reached by caller narrowing at `:433` and `:452`). See D3. `READ_ONLY_PATH_CLASSES` is `["shared-workflow", "shared-constitution"]` (`path-claims.ts:101`) — two of the ten server-owned classes, which `SERVER_OWNED_PATH_CLASSES` re-lists literally rather than spreading, because it is a closed `as const` tuple whose element type must be a literal union and `READ_ONLY_PATH_CLASSES` is typed `readonly PathClass[]`. |
| `GitOid`, `gitOidV1Schema`, `parseGitOid` | `canonical.ts:11`, `:18`, `:21` | commits and blob identities | One brand for blobs **and** commits. **There is no `gitOid` `$def` anywhere in `schemas/v1/`.** See D9. |
| `GIT_TREE_MODES`, `GitTreeMode` | `canonical.ts:13-14` | blob identity | **Admits `040000` and `160000`.** The draft's `// "160000" rejected` was a comment, not a constraint. See D9. |
| `ArchflowTreeMode` | `canonical.ts:16` | documentary only | `"100644"`, type-only, no const, no schema, no parser. |
| `CanonicalDocument<T extends PlainJsonValue>`, `canonicalDocument`, `parseCanonicalDocument` | `canonical.ts:98`, `:104`, `:119` | the validator's subject | **`T` is constrained to `PlainJsonValue`, and TypeScript grants implicit index signatures to type aliases, not interfaces — transitively.** An `interface` nested anywhere inside the root fails the constraint just as the root would. Verified by probe under the project's `tsconfig.json`: `CanonicalDocument<RootAlias>` compiles; a root embedding `DeclaredInputRef` or `SecretFinding` fails `TS2344` with *"Index signature for type 'string' is missing"*. See D1. `bytes` is a `Uint8Array` (`canonical.ts:99`), so `assertPlainJson` applies to a document's `value`, never to a whole `CanonicalDocument`. |
| `canonicalJsonBytes`, `canonicalJsonDigest`, `sha256Bytes`, `gitBlobOid` | `canonical.ts:66`, `:74`, `:70`, `:79` | re-deriving digests | `canonicalJsonBytes` sorts object keys ordinally and **preserves array order** — the reason every set carries a declared sort key, and the reason the invariant table's collection component reuses that same ordinal key order. `gitBlobOid` is never called here; it is Phase 10's hook. |
| `SecretScanResult`, `secretScanResultV1Schema`, `SecretFinding` | `secret-scan.ts:47-50`, `:64`, `:31` | embedded in `implementation-output` | All three variants carry their own `schema_version: "1"`, so the manifest carries a nested one. `$ref` target `urn:archflow:schema:v1:secret-scan-result`. **`SecretFinding` is an `interface` and is reachable from `SecretScanResult`, so it breaks `CanonicalDocument<DurableArtifact>`; chunk 1 converts it to a `type` alias.** See D1. |
| `PhaseInstanceId`, `decodePhaseInstance`, `ITERATED_PHASE` | `phase-instance.ts:5`, `:35`, `:33` | every shape's `phase_instance` | **No parser, no exported Zod schema, no `$def` for the ID string.** `phase-instance.schema.json` describes the `PhaseInstance` *object*. Two literal regex duplicates exist — `trust.ts:141` and `src/repository/paths.ts:67`; `errors.ts:26` and `gates.ts:121` are not duplicates, they delegate to `decodePhaseInstance` through `z.string().refine(…)`. See D6. |
| `ProjectResult<T>`, `createProjectError` | `errors.ts:82`, `:89` | the validator's return channel | **Carries exactly one error, not a list.** A validator that finds several failures must pick one. See D12. |
| `PROJECT_PARAMETER_SCHEMAS` | `errors.ts:34` (body `:35-51`) | what the validator may report | `STATE_INVALID{phase_instance, issue_code}`; `SNAPSHOT_INVALID{snapshot_digest, issue_code}`; `TASK_INVALID{task_id, issue_code}`; `CONTRACT_INVALID{issue_code, tool?, schema_version?}`; `INPUT_FINGERPRINT_MISMATCH{expected_digest, observed_digest}` (`errors.ts:46`). Parameters are `.strict()`; an unknown key throws. **`INPUT_FINGERPRINT_MISMATCH` therefore cannot carry an `issue_code` at all** — `object(digestPair)` is exactly the two digests. `STATE_INVALID`'s `phase_instance` runs `decodePhaseInstance`, so an undecodable value **throws** rather than being reported; that is why rank 2 exists. See D12. |
| `DeclaredInputRef` | `fingerprints.ts:11` | declared inputs | An `interface` with no Zod schema and no JSON `$def` today. It is embedded in two pinned durable roots, so it breaks `CanonicalDocument<DurableArtifact>`; chunk 1 converts it to a `type` alias (D1) and chunk 4 authors the `declaredInputRef` `$def` and its Zod mirror. **`GitIdentityRef` (`fingerprints.ts:16`) is *not* converted** — it is reachable only through `InputFingerprintSubject`, which no durable root embeds. See D1. |
| `verifyPinnedConfig`, `verifyRepositoryIdentity`, `classifyMutationReadiness` | `fingerprints.ts:217`, `identity.ts:297`, `history.ts` | the precedent for the validator's signature | Pure comparators returning `ProjectResult<T>` / `ProjectResult<void>`. See D12. |
| `assertPlainJson`, `PlainJsonValue` | `plain-json.ts:99`, `:1-5` | input discipline | Already rejects accessor properties, non-plain prototypes, symbol keys, cyclic refs, sparse arrays, and `__proto__`/`prototype`/`constructor` keys — **inside** a value. It says nothing about the subject slots or a `CanonicalDocument` shell. See D12. |
| `Object.getOwnPropertyDescriptor` + `"value" in descriptor` | `validators.ts:33-36` (`hasUniqueObjectPropertyValues`) | the shipped own-data-descriptor form | The exact idiom the validator's slot and shell checks reuse, so there is one form of this check in `src/contracts/`. |
| `assertZodAgreement`, `createJsonSchemaValidator` | `validators.ts:264-292`, `:157` (the `new Ajv2020({…})` literal is `:161-169`) | proving each mirror | Ajv 2020, `strict: true` — a new `x-archflow-*` keyword must be registered in `validators.ts` or every schema referencing it fails to compile. |
| `x-archflow-sorted-unique`, `x-archflow-unique-by` | `validators.ts:212` / `:55`, `:173` / `:28` | set rules | **`isOrdinalSortedUnique` (`:55-57`) compares array elements with `<`, so it works on string arrays only**; on an object array any second element compares `"[object Object]" < "[object Object]"` → false, so it returns `false` for every object array of length ≥ 2. No current use site is an object array, so this is a gap rather than a live bug. `x-archflow-unique-by` gives uniqueness but no ordering. See D11. |
| `sortedUniqueBy` | `validators.ts:96`, used at `:103`, `:110`, `:111`, `:125` | the ordering predicate to generalize | Already generic over a key function. `validators.ts` also holds two near-duplicates — `isOrdinalSortedUnique` (`:55`) and a private `sortedUnique` inside the adjudication helper (`:69`). D11 routes all three through this one rather than adding a fourth. |
| `PIPELINE_STEPS`, `PipelineStep` | `vocabulary.ts:2,7`, re-exported by `workflow.ts:7-8` | `step` | `["produce","self_review","counter_review","triage","adjudicate"]`. Reachable through the barrel via `workflow.ts`. |
| `GATE_KINDS`, `GateKind` | `gates.ts:41-42` | gate references | Nine kinds. There is no shipped "waiver-bearing kind" predicate; this phase does not invent one. |
| `SCHEMA_IDS` | `versions.ts:3-29` | registration | **25 keys, 23 `urn:` and 2 legacy `https://archflow.dev/…`.** The draft said 22-of-24. `urn:archflow:schema:v1:<kebab-name>` is the convention. |
| `SCHEMA_FILES` | `test/contracts/schema-registry.test.ts:9-35` | registration | **Lives in the test, not in `src/`.** The bijection at `:51` requires equal key counts, so new keys and new files must be equal in number. The draft's "ten keys, nine files" was arithmetically impossible. |
| 52-code / 56-row error assertions | `test/unit/errors.test.ts:9`; `test/contracts/gate-error-supplemental-exhaustive.test.ts:134,165` | the no-new-code constraint | Both must still pass unchanged. |
| `package.json` script and dependency lists | pinned by `test/contracts/repository-boundary.test.ts:64-106` | — | Any `package.json` edit fails that suite. This phase makes none. |

## Interfaces and Contracts

Pinned decisions carried through the whole document, each stated once here with its reason. The labels run D1–D21 with **D17 retired** (withdrawn during design review) and **D5 and D20 moved to Phase 8** with the checkpoint family. None of the three labels is reused, so citations in the review record stay resolvable rather than silently re-pointing at a different decision.

**D1 — every type *transitively reachable* from a durable root is a `type` alias, never an `interface`.** `CanonicalDocument<T extends PlainJsonValue>` (`canonical.ts:98`) cannot accept an interface: TypeScript grants implicit index signatures only to type aliases, and the constraint is checked through the whole reachable graph, not just at the root. Probed at design time under the project's `tsconfig.json`, and re-probed at counter-review under TypeScript 7.0.2 with `exactOptionalPropertyTypes` — a type alias carrying branded fields, optional properties, and `readonly` arrays satisfies the constraint; an `interface` anywhere inside it fails with `TS2344: Index signature for type 'string' is missing`.

**Exactly two** shipped Phase 6 shapes break the rule and are converted here, because both are embedded in pinned Phase 7 roots (`DocumentArtifactV1.declared_inputs`, `ImplementationOutputV1.declared_inputs` and `.secret_scan`) and `CanonicalDocument<DurableArtifact>` does not compile while they are interfaces:

- `src/contracts/fingerprints.ts:11` — `DeclaredInputRef`.
- `src/contracts/secret-scan.ts:31` — `SecretFinding`, reachable from `SecretScanResult`.

**`GitIdentityRef` (`fingerprints.ts:16`) stays an `interface`, and this corrects the earlier draft.** It is reachable only through `InputFingerprintSubject` (`fingerprints.ts:28`, `:30`, `:138`) and `test/unit/fingerprints.test.ts`, none of which is a durable root; the criterion already excludes `InputFingerprintSubject`. Converting it "so the module has one declaration form" was cosmetic churn on a shipped module for no compile benefit. The counter-review's TypeScript 7.0.2 probe confirmed the closure compiles with only the two conversions above.

**The two conversions are runtime-neutral and neutral for every current repository consumer — not behaviour-neutral in general.** `interface X {…}` becomes `type X = {…}`, with no property, no modifier, no runtime value, and no JSON Schema touched, and the repository has no declaration merge, no `extends`, and no `implements` on either name. What the change *does* remove is the ability to declaration-merge either name later. **That closure is intentional**: a durable root's shape must be exactly what its JSON Schema says, and an ambient merge would silently widen it past the schema. Phase 6 escaped the constraint through an unconstrained generic `materialize<T>` (`fingerprints.ts:111`), which `CanonicalDocument` does not offer. The comment at `fingerprints.ts:107-109` blames "interfaces carrying branded strings"; the branded half is a red herring — a type alias with branded fields compiles fine, and the interface *form* is the whole cause. Correcting that comment is part of the conversion so the diagnosis is not re-derived wrongly later.

**D8 — every `>= 1` field declares its own minimum in both authorities.** `SafeInteger` admits `0`, so `revision`, `attempt`, `ApprovalRef.resolved_at_revision`, and every other positive count pins `"minimum": 1` in JSON Schema and `.min(1)` in Zod at the field, and does not `$ref` `primitives#/$defs/safeInteger`. Fields that genuinely admit `0` — `payload_bytes`, `stored_bytes`, `byte_count`, `unrepresentable_count`, `size_bytes` — do `$ref` it, because a zero-byte declared output is legal.

**D7 — new schemas `$ref` `primitives#/$defs/*` rather than inlining ID patterns.** Eight schemas inline them today and Phase 6's log records four rounds of retightening caused by that duplication. Seven of 25 already `$ref` primitives — `gate-contract`, `gate-decision`, `mcp-tools`, `phase-instance`, `result-expectation`, `secret-scan-result`, `supplemental-review` — so this follows a precedent. The consequence to keep in view: `pathSafeId` and `taskSlug` carry Zod `.refine()` rules that are expressible in JSON Schema only as the exact lookahead pattern already in `primitives.schema.json`; `$ref`ing it is what keeps the two authorities in agreement.

### Chunk 1 — shared-authority edits only, no new module

Chunk 1 is the **sole editor** of five shared files and creates nothing: `primitives.schema.json`, `phase-instance.ts`, `validators.ts`, `fingerprints.ts`, and `secret-scan.ts`. Chunks 2 and 4 own the new `durable-primitives` module, schema, and test. The split exists because the combined chunk carried a 14-branch `if/then/else` ladder plus every other shared shape plus the class sets *and* edited shipped shared files, while every other chunk blocked on all of it; separating the edits from the new module lets the new module be reviewed as a schema and lets chunk 1 be reviewed as a diff against shipped code. Every later chunk consumes it by name and must not rename anything it declares.

`trust.ts` is **not** edited. The earlier design exported its three module-private evidence-slot Zod schemas (D5) purely so the `EvidenceChainEntry` mirror could compose them; the evidence chain left with the checkpoint family, so the export has no consumer here and Phase 8 makes that edit when it needs it.

**D6 — one shared `phaseInstanceId` authority is added; the one remaining literal copy is left alone.** Most Phase 7 shapes carry `phase_instance`, and there is no reusable authority for the ID *string*. Chunk 1 adds one `$def` to `primitives.schema.json` and one exported Zod schema to `phase-instance.ts`. **Four** of the seven new schemas carry a `phase_instance` field and `$ref` / import it — `task-state` (root and through `authoritativeResultRef`), `legacy-import-initialization` (through `LegacyMappingEntry`), `document-artifact`, and `implementation-output`. `durable-primitives`, `task-initialization`, and `maintenance-record` declare no `phase_instance` field and consume neither; the `$def` inventory's consumer column reflects that. Four consumers is still three more than the shape that would otherwise own the pattern, which is the whole point of the `$def`.

The Zod side **delegates to the decoder rather than copying the pattern**, so no fourth literal copy is created: `z.string().refine(value => { try { decodePhaseInstance(value); return true; } catch { return false; } })`, exactly the form `errors.ts:26` and `gates.ts:121` already use, cast to `z.ZodType<PhaseInstanceId>`. The JSON Schema `$def` necessarily stays a `pattern`, and the two therefore diverge on exactly one class of value: `decodePhaseInstance` runs `parsePositiveSafePhaseNumber` (`phase-instance.ts:35-41`), so `phase-impl-99999999999999999999` matches the pattern and is rejected by the decoder. **That divergence is the one accepted gap**, recorded at the `$def` the way `src/repository/paths.ts:62-63` already records that its `REVISION` fragment permits `0`, and it is why ranks 2 and 4 keep phase-instance checks after schema validation (D12).

There are exactly **two** literal regex duplicates, not four: `trust.ts:141` (`phaseSchema`, a `z.string().regex(…)` cast to `PhaseInstanceId`) and `src/repository/paths.ts:67` (`PHASE_INSTANCE`). `errors.ts:26` and `gates.ts:121` are already correct — both are `z.string().refine((value) => { try { decodePhaseInstance(value); … } })`, delegating to the shared decoder rather than copying its pattern, so there is nothing to migrate there. Of the two real copies only `trust.ts:141` is migratable, and migrating it is **explicitly out of scope** here — unrelated churn in another phase's module, recorded as a one-line note. `src/repository/paths.ts:67` is excluded permanently and for a different reason: its copy is a regex *source fragment* interpolated into the 17 class templates, not a validator, and the new authority is a compiled Zod schema plus a JSON Schema `$def` — neither is interpolable. Exporting a bare pattern string from `src/contracts/` purely to feed repository-layer template construction would invert the layering that `test/contracts/repository-boundary.test.ts:28-38` exists to protect.

**D9 — blob identity narrows the tree mode; both new primitives get `$defs`.** `GitTreeMode` admits `040000` (a tree) and `160000` (a gitlink); neither can be a declared output blob. Chunk 1 adds the 40-hex `gitOid` `$def`; chunk 2 authors the narrowed enum in `durable-primitives`, so the rejection is structural instead of a comment.

**D11 — intra-document set ordering and uniqueness are structural, on one predicate.** `x-archflow-sorted-unique` works on string arrays only; `x-archflow-unique-by` gives uniqueness without ordering. Chunk 1 therefore adds one keyword, `x-archflow-sorted-unique-by`, registered in `validators.ts` alongside the eleven existing ones. It does **not** add a fourth ordering implementation: `validators.ts` already carries three near-identical ones — `isOrdinalSortedUnique` (`:55`), the private `sortedUnique` inside `hasConsistentAdjudicationSemantics` (`:69`), and `sortedUniqueBy` (`:96`). Chunk 1 generalizes and exports `sortedUniqueBy`, routes the other two through it, and deletes them, so the module ends with exactly one ordering predicate that both Ajv keywords and every Zod refinement call. This is the minimum addition that makes set ordering structural; the alternative — re-implementing set rules inside `validateDurableSemantics` — would leave ordering unenforced for any consumer that only validates against the schema.

**The tuple key is pinned, because Phases 9–10 must reproduce it.** A multi-key sort such as `authoritative_results` by `(phase_instance, step)` compares the property values coerced with `String()` and **joined with `"\u0000"`**, ordinally, with `<`. `U+0000` appears in no `SafeId`, `SafeCode`, `PhaseInstanceId`, `PipelineStep`, or path claim — `path-claim.schema.json:8` and `pathClaimLexicalSchema` (`path-claims.ts:18`, `:37`) both reject the whole `U+0000`–`U+001F` range — so the join is injective, and because `U+0000` sorts below every admitted character the joined comparison is exactly componentwise ordinal comparison. A producer may therefore implement either and get the same order. The existing `ruleKey` at `validators.ts:95` joins with `":"`, which `SafeId` admits, so a joined key could collide across a component boundary; that is why the new keyword does not reuse it.

Additions to shared files, exact:

```ts
// src/contracts/phase-instance.ts — added
export const phaseInstanceIdV1Schema: z.ZodType<PhaseInstanceId>;
//   z.string().refine(v => { try { decodePhaseInstance(v); return true; } catch { return false; } })
//   cast to z.ZodType<PhaseInstanceId>. DELEGATION, not a fourth literal copy of the pattern — the same
//   form errors.ts:26 and gates.ts:121 already use (D6). It is therefore strictly stronger than the
//   JSON $def, which can only be a pattern.
export function parsePhaseInstanceId(value: unknown): PhaseInstanceId;  // assertPlainJson, then parse; throws

// src/contracts/validators.ts — the module's ONE ordering predicate, generalized from :96 and exported
export function isSortedUniqueBy(items: unknown, key?: (value: unknown) => string): boolean;
//   key defaults to String; returns false unless `items` is an array that is strictly increasing under `key`.
//   Strict increase implies uniqueness, so it subsumes x-archflow-unique-by for these shapes.
export function tupleKey(properties: string | readonly string[]): (value: unknown) => string;
//   Each property is read with Object.getOwnPropertyDescriptor and `"value" in descriptor`, exactly as
//   hasUniqueObjectPropertyValues (validators.ts:33-36) already does, so an accessor property yields
//   `undefined` instead of invoking a getter. A naive `item[property]` would call the getter — the precise
//   defect CLAUDE.md's digest rule and Phase 6's log record, now reachable from a sort predicate that a
//   Zod .refine() also calls. Values are String()-coerced and joined with "\u0000". Exported so a Zod .refine() builds the
//   identical key function the Ajv keyword uses — this is what makes "the same function" literally true.

// The two Ajv keyword validators are thin adapters over the predicate, matching Ajv's (schemaValue, data):
//   x-archflow-sorted-unique     (existing, schemaType "boolean") -> (_enabled, data) => isSortedUniqueBy(data)
//   x-archflow-sorted-unique-by  (added,    schemaType ["string","array"], type "array", errors: false)
//                                                                 -> (properties, data) =>
//                                                                      isSortedUniqueBy(data, tupleKey(properties))
// `isOrdinalSortedUnique` (:55) and the private `sortedUnique` (:69) are deleted; their call sites move
// to `isSortedUniqueBy`. The consolidation is behaviour-preserving and nothing more: the existing
// keyword's adapter passes no key, so `key` defaults to String and an object array still compares
// "[object Object]" < "[object Object]" -> false. The object-array gap is closed only for schemas that
// use the NEW keyword, which supplies a tupleKey.

// src/contracts/schemas/v1/primitives.schema.json — three added $defs
// phaseInstanceId is a pattern by necessity and is therefore weaker than phaseInstanceIdV1Schema; the
// accepted divergence — values above Number.MAX_SAFE_INTEGER — is recorded next to it (D6).
"phaseInstanceId": { "type": "string", "pattern": "^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$" }
"gitOid": { "type": "string", "pattern": "^[0-9a-f]{40}$" }
"taskPathClaim": { "$ref": "urn:archflow:schema:v1:path-claim" }

// src/contracts/fingerprints.ts — DeclaredInputRef (:11): `interface` -> `type` (D1), and the misleading
//   "interfaces carrying branded strings" clause at :107-109 corrected. GitIdentityRef (:16) is NOT touched:
//   it is reachable only through InputFingerprintSubject, which no durable root embeds.
// src/contracts/secret-scan.ts — SecretFinding (:31): `interface` -> `type` (D1).
//   Both files: declaration form only. No property, no modifier, no runtime value, no schema changes.
```

**Why `taskPathClaim` is a one-line `$ref` alias.** Every `TaskPathClaim`-typed field in this phase (`DocumentArtifactV1.document_path`, `ParentDocumentRef.document_path`) needs a `$ref` target, and `primitives.schema.json` today has `repositoryPathClaim` (`:31`) and no task-frame counterpart. The two brands are one runtime validator cast twice (D3), so the alias is literally `{"$ref": "urn:archflow:schema:v1:path-claim"}` — the same one line as `repositoryPathClaim`. It is added rather than reusing `repositoryPathClaim` because it costs one line and names the frame at every reference site, where reusing the repository `$def` would put the frame distinction in prose only and invite exactly the mis-pairing D3 warns about. It adds no runtime frame check, and there cannot be one.

### Chunks 2 and 4 — the durable-primitives module and schema, in two sequenced halves

Together they own `src/contracts/durable-primitives.ts`, `durable-primitives.schema.json`, and `test/unit/durable-primitives.test.ts`, and edit no shared file. **They are sequenced, not parallel: both write all three files, so 4 starts only after 2 lands.** Chunk 3 sits between them and writes only its own test file, so it runs beside 4. The split exists because a single chunk holding the 14-branch ladder, the class sets, and the remaining shared shapes re-derives well past a Phase 6 per-chunk average near 780 lines; `gate-contract.schema.json` is 544 lines for nine branches, and `wc -l src/contracts/schemas/v1/*.json` averages ~229, so the ladder alone is not small.

- **2 — the output authority**: the output vocabularies, the narrowed blob modes, `BlobIdentity`, the exact 14-branch `OutputEntry`, and the claimable / server-owned class sets, with a focused unit test that each authority accepts one valid sample per operation.
- **3 — the output matrix**: the adversarial acceptance/rejection matrix over all 14 branches, in its own test file, written by a different agent from the pinned branch table (see Work Breakdown).
- **4 — everything else shared**: `declaredInputRef`, `CanonicalTaskPaths`, and `SnapshotAccounting*`.

**D21 — the four cross-shape reference shapes live in `durable-state.ts`, with `task-state`.** `AuthoritativeResultRef`, `ApprovalRef`, `WaiverRef`, and `OpenGateRef` were moved into the shared `durable-primitives` module when they were consumed by both `TaskStateV1` and the **mirrored** `ManualCheckpointV1`, so the checkpoint mirror would have a pinned Zod name to compose. **The Phase 8 split removes that second consumer**, so each is now consumed by exactly one unmirrored root — precisely the condition under which this design already leaves `PreparedIntentRef` and `MaintenanceDeletion` where they are. They return to chunk 5, take no Zod mirror (D2), and `task-state.schema.json` owns their `$defs` along with `stepStatus` and `gateKind`. Phase 8 reaches them by `$ref` if it needs them, and authors its own mirrors then. The reason is recorded so the shapes are not moved back on the strength of the retired rationale.

`durable-primitives.ts` exports, **exact and complete** — chunk 2's half first, then chunk 4's. A consuming chunk imports these names verbatim; a chunk that locally re-declares any of them has drifted and its own tests will not notice.

```ts
// ---- chunk 2 ----
export const OUTPUT_OPERATIONS = ["add", "modify", "delete", "rename"] as const;
export type OutputOperation = (typeof OUTPUT_OPERATIONS)[number];
export const OUTPUT_FILE_TYPES = ["regular", "symlink"] as const;
export type OutputFileType = (typeof OUTPUT_FILE_TYPES)[number];
export const OUTPUT_STORAGE = ["git-object", "raw-payload"] as const;
export type OutputStorage = (typeof OUTPUT_STORAGE)[number];
export const BLOB_TREE_MODES = ["100644", "100755", "120000"] as const;   // D9: narrows GitTreeMode
export type BlobTreeMode = (typeof BLOB_TREE_MODES)[number];

export type RegularBlobIdentity = { readonly oid: GitOid; readonly mode: "100644" | "100755"; readonly size_bytes: SafeInteger };
export type SymlinkBlobIdentity = { readonly oid: GitOid; readonly mode: "120000"; readonly size_bytes: SafeInteger };
export type BlobIdentity = RegularBlobIdentity | SymlinkBlobIdentity;

export const CLAIMABLE_OUTPUT_PATH_CLASSES = [
  "document", "import", "manual-checkpoint", "repository-source",
  "result-payload", "review", "task-branch-constitution",
] as const;                                                     // 7
export type ClaimableOutputPathClass = (typeof CLAIMABLE_OUTPUT_PATH_CLASSES)[number];
export const SERVER_OWNED_PATH_CLASSES = [
  "attempt", "decision", "gate-interface", "intent", "maintenance-record", "result-manifest",
  "shared-constitution", "shared-workflow", "task-config", "task-state",
] as const;                                                     // 10; supersets READ_ONLY_PATH_CLASSES

export type OutputEntry = /* the 14 leaf aliases below, unioned in the pinned order */;
export const outputEntryV1Schema: z.ZodType<OutputEntry>;

// ---- chunk 4 ----
export type CanonicalTaskPaths = {
  readonly task_root: RepositoryPathClaim;         // .archflow/tasks/<task_id>
  readonly config: RepositoryPathClaim;
  readonly state: RepositoryPathClaim;
  readonly workflow: RepositoryPathClaim;          // .archflow/workflow.yaml
  readonly constitution_root: RepositoryPathClaim; // .archflow/constitution
};
export const canonicalTaskPathsV1Schema: z.ZodType<CanonicalTaskPaths>;

export const declaredInputRefV1Schema: z.ZodType<DeclaredInputRef>;   // DeclaredInputRef is fingerprints.ts:11 (D1)

// D16: two-branch discriminated union on `storage`, so `stored_bytes === 0` for a git-object entry is
// structural — one `if/then` in JSON Schema — instead of a comment the validator has to enforce.
export type SnapshotAccountingEntry =
  | { readonly path: RepositoryPathClaim; readonly storage: "git-object"; readonly stored_bytes: 0 }
  | { readonly path: RepositoryPathClaim; readonly storage: "raw-payload"; readonly stored_bytes: SafeInteger };
export type SnapshotAccountingV1 = {
  readonly schema_version: "1";
  readonly result_bytes: SafeInteger;              // <= result_byte_cap, structural maximum
  readonly task_bytes: SafeInteger;                // <= task_byte_cap, structural maximum
  readonly result_byte_cap: 26214400;              // 25 × 1048576, const
  readonly task_byte_cap: 262144000;               // 250 × 1048576, const
  readonly counted_entries: readonly SnapshotAccountingEntry[];   // SET, sorted by path
  readonly measured_at_revision: SafeInteger;      // >= 1
};
export const snapshotAccountingV1Schema: z.ZodType<SnapshotAccountingV1>;
export function parseSnapshotAccounting(value: unknown): SnapshotAccountingV1;
```

That block is the module's **entire** export surface. `snapshotAccountingEntryV1Schema` and the two blob-identity mirrors are module-private — nothing outside `durable-primitives` declares a field of those types, and chunk 3 exercises them through `outputEntryV1Schema` and `snapshotAccountingV1Schema`. The earlier `DeclaredInputRefList` alias is dropped: no field used it.

**D16 — the `git-object ⇒ stored_bytes === 0` rule is structural, applying this document's own rule to itself.** It was previously a comment enforced inside the validator, which contradicts "structural where possible". As a two-branch discriminated union on `storage` it is one `if/then` in JSON Schema, one `z.discriminatedUnion` branch in Zod, and one fewer clause in `validateDurableSemantics`. What stays semantic is only the genuinely cross-shape half: `stored_bytes === payload_bytes` for a `raw-payload` entry, which needs the matching `OutputEntry`.

`snapshot-accounting` is a `$def` of `durable-primitives.schema.json`, not its own file, because it is never a standalone document — it exists only inside `implementation-output.accounting`. It is `$ref`able as `urn:archflow:schema:v1:durable-primitives#/$defs/snapshotAccounting` and it does get a Zod mirror, so its place in the mirror set (D2) is unaffected — it simply does not earn a registry row of its own.

#### `OutputEntry`: structurally total, 14 leaf branches, spelled out

**D10 — the operation × storage × file-type table is enforced structurally, not semantically.** The architecture's Success Criterion demands implementation-output contradictions be *structurally unrepresentable*; a rule inside `validateDurableSemantics` only makes them semantically rejected. The TypeScript type is a union that makes them uninhabitable, the JSON Schema is an `if/then/else` ladder plus `dependentRequired`, and the Zod mirror is a **nested discriminated union**. That construction is pinned exactly, because two obvious alternatives do not compile under the repo's pinned `zod@4.4.3` and were probed live:

```ts
// WRONG: four options all carrying operation: "add" -> throws `Duplicate discriminator value "add"`.
// WRONG: z.union([...the four "add" objects]) as one option of the outer discriminatedUnion
//        -> throws `Invalid discriminated union option at index "0"`.
// RIGHT: each outer option is itself a discriminatedUnion on "storage".
export const outputEntryV1Schema: z.ZodType<OutputEntry> = z.discriminatedUnion("operation", [
  z.discriminatedUnion("storage", [/* add x {git-object, raw-payload} x {regular, symlink} */]),
  z.discriminatedUnion("storage", [/* modify … */]),
  z.discriminatedUnion("storage", [/* rename … */]),
  z.discriminatedUnion("storage", [/* delete — git-object only */]),
]);
```

Both failures surface at parse time rather than at construction, so a chunk that only builds the schema sees nothing wrong. A plain `z.union` over all fourteen objects also works and is the fallback if the nested form fights `z.ZodType<OutputEntry>`; the nested form is preferred because it keeps discriminator-indexed dispatch.

**The 14 leaves are declared flat, not as intersections.** Three property groups recur, and they are named here as *documentation of the grouping only* — they are not declarations in the module, because an intersection type is not guaranteed the implicit index signature `CanonicalDocument<T extends PlainJsonValue>` requires (D1), and a leaf that fails that constraint fails it silently at the root:

| Group | Exact properties |
|---|---|
| *common* | `path: RepositoryPathClaim` ($ref `primitives#/$defs/repositoryPathClaim`); `path_class: ClaimableOutputPathClass` (structural `enum`, 7 members) |
| *git-object storage* | `storage: "git-object"` |
| *raw-payload storage* | `storage: "raw-payload"`; `payload_bytes: SafeInteger` (**>= 0**, `$ref primitives#/$defs/safeInteger` — a zero-byte declared output is legal, so D8 does not apply); `payload_digest: Sha256Digest` ($ref `primitives#/$defs/sha256Digest`) |

Every leaf carries *common*, its storage group, `operation`, `file_type`, and the branch properties in the table below. `additionalProperties: false` in JSON Schema and `.strict()` in Zod forbid every property not listed for that leaf, so the "forbidden" column is enforced by the schema rather than by a separate rule.

| # | Leaf alias | `operation` | `storage` | `file_type` | Also required | Forbidden |
|---|---|---|---|---|---|---|
| 1 | `AddGitRegular` | `"add"` | `"git-object"` | `"regular"` | `after: RegularBlobIdentity` | `before`, `previous_path`, `payload_bytes`, `payload_digest` |
| 2 | `AddGitSymlink` | `"add"` | `"git-object"` | `"symlink"` | `after: SymlinkBlobIdentity` | same as 1 |
| 3 | `AddRawRegular` | `"add"` | `"raw-payload"` | `"regular"` | `after: RegularBlobIdentity` | `before`, `previous_path` |
| 4 | `AddRawSymlink` | `"add"` | `"raw-payload"` | `"symlink"` | `after: SymlinkBlobIdentity` | `before`, `previous_path` |
| 5 | `ModifyGitRegular` | `"modify"` | `"git-object"` | `"regular"` | `before: BlobIdentity`, `after: RegularBlobIdentity` | `previous_path`, `payload_bytes`, `payload_digest` |
| 6 | `ModifyGitSymlink` | `"modify"` | `"git-object"` | `"symlink"` | `before: BlobIdentity`, `after: SymlinkBlobIdentity` | same as 5 |
| 7 | `ModifyRawRegular` | `"modify"` | `"raw-payload"` | `"regular"` | `before: BlobIdentity`, `after: RegularBlobIdentity` | `previous_path` |
| 8 | `ModifyRawSymlink` | `"modify"` | `"raw-payload"` | `"symlink"` | `before: BlobIdentity`, `after: SymlinkBlobIdentity` | `previous_path` |
| 9 | `RenameGitRegular` | `"rename"` | `"git-object"` | `"regular"` | `before: BlobIdentity`, `after: RegularBlobIdentity`, `previous_path: RepositoryPathClaim` | `payload_bytes`, `payload_digest` |
| 10 | `RenameGitSymlink` | `"rename"` | `"git-object"` | `"symlink"` | `before: BlobIdentity`, `after: SymlinkBlobIdentity`, `previous_path: RepositoryPathClaim` | same as 9 |
| 11 | `RenameRawRegular` | `"rename"` | `"raw-payload"` | `"regular"` | `before: BlobIdentity`, `after: RegularBlobIdentity`, `previous_path: RepositoryPathClaim` | — |
| 12 | `RenameRawSymlink` | `"rename"` | `"raw-payload"` | `"symlink"` | `before: BlobIdentity`, `after: SymlinkBlobIdentity`, `previous_path: RepositoryPathClaim` | — |
| 13 | `DeleteGitRegular` | `"delete"` | `"git-object"` | `"regular"` | `before: RegularBlobIdentity` | `after`, `previous_path`, `payload_bytes`, `payload_digest` |
| 14 | `DeleteGitSymlink` | `"delete"` | `"git-object"` | `"symlink"` | `before: SymlinkBlobIdentity` | same as 13 |

`previous_path` is a `RepositoryPathClaim` (`$ref primitives#/$defs/repositoryPathClaim`), the same brand and frame as `path`; there is no separate previous-path `$def`. The union is written in leaf order 1–14 above, and the Zod outer options are ordered `add`, `modify`, `rename`, `delete` to match the JSON `if/then/else` ladder, so a reviewer can read the two authorities side by side.

The two literal declarations below are the exact template; the other twelve are written the same way:

```ts
type AddGitRegular = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "add"; readonly storage: "git-object";
  readonly file_type: "regular"; readonly after: RegularBlobIdentity;
};
type RenameRawSymlink = {
  readonly path: RepositoryPathClaim; readonly path_class: ClaimableOutputPathClass;
  readonly operation: "rename"; readonly storage: "raw-payload";
  readonly payload_bytes: SafeInteger; readonly payload_digest: Sha256Digest;
  readonly file_type: "symlink"; readonly before: BlobIdentity;
  readonly after: SymlinkBlobIdentity; readonly previous_path: RepositoryPathClaim;
};
```

`delete` forces `git-object` because there is no post-state content to store; a `raw-payload` delete would demand bytes for a file that no longer exists.

**`before` and `after` are deliberately asymmetric, and the asymmetry is stated rather than implied.** Only the surviving blob is mode-locked to `file_type`. On `modify` and `rename`, `before` is an unconstrained `BlobIdentity` — either variant, independent of `file_type` — because a regular file may be replaced by a symlink or the reverse, and `file_type` describes the post-state. On `delete`, `before` *is* the surviving blob and is mode-locked instead; `after` is absent. A verification case exercises this in both directions so the freedom is not later mistaken for an omission.

**A cross-class rename is *not* structurally unrepresentable, and this withdraws an earlier claim.** The design previously argued that carrying exactly one `path_class` makes a class-changing rename unwritable. It does not. `path` and `previous_path` are both `RepositoryPathClaim` strings that are runtime-indistinguishable, Phase 6's sole lexical validator cannot derive a class from either (`src/contracts/path-claims.ts:31-45`), and this design defers template-based classification entirely (D4). A rename may therefore carry endpoints that in fact belong to two different classes while declaring one claimable class, and nothing in this phase can see it. What Phase 7 does provide is the shape the check needs — both endpoints present, typed, and required — and the one clause it can actually evaluate, `previous_path !== path` (rank 5a). **Phase 10 (Snapshots, Implementation Manifests, and Restore) classifies and verifies *both* endpoints against the template tables** and rejects a rename whose endpoints disagree; that pin is in Non-Goals. Expressing a genuinely cross-class move as a `delete` plus an `add` remains the honest encoding, but it is a convention here, not an enforced one.

#### The table is structurally total but not integrity-total, and the gap is attributed

Nothing above requires `payload_bytes` to equal the length of bytes actually retained, `payload_digest` to equal SHA-256 of those bytes, or `after.oid` to equal `gitBlobOid(bytes)`. The accounting invariants only equate `stored_bytes` with the *asserted* `payload_bytes`, so a manifest can be fully internally consistent and still describe bytes that exist nowhere.

> **In Phase 7 these three fields are assertions. In Phase 10 they become verified facts.** Phase 10 (Snapshots, Implementation Manifests, and Restore) retains the bytes, and it is the layer that must verify at materialization time that the retained payload's length equals `payload_bytes`, that `sha256Bytes(payload)` equals `payload_digest`, and that `gitBlobOid(payload)` equals `after.oid` for a tracked output. Phase 7 cannot check any of this, because it never sees a byte.

Phase 7's contribution is to make the assertions *checkable later* — every field the Phase 10 comparison needs is present, typed, and required — and to say plainly that a passing Phase 7 validation is not evidence that the bytes exist.

### Chunk 5 — the two server-internal roots, no Zod mirror

Owns `src/contracts/durable-state.ts`, `task-state.schema.json`, `src/contracts/durable-maintenance.ts`, and `maintenance-record.schema.json`. The two roots share a chunk because they are the phase's only shapes with exactly one authority each, neither consumes the other, nothing outside the chunk consumes anything either declares, and together they are smaller than any other authoring chunk. This chunk also owns the four cross-shape reference shapes returned here by D21, plus `stepStatus` and `gateKind`.

```ts
export const STEP_STATUSES = ["running", "succeeded", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export const TERMINAL_STATES = ["complete", "abandoned"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

// D21: consumed by TaskStateV1 alone. No Zod mirror (D2); `task-state.schema.json` owns each $def.
export type AuthoritativeResultRef = {
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly result_digest: Sha256Digest;
  readonly result_id: SafeId;
  readonly input_fingerprint: Sha256Digest;
  readonly manifest_path: RepositoryPathClaim;
};
export type ApprovalRef = {
  readonly gate_id: PathSafeId; readonly gate_kind: GateKind;
  readonly subject_digest: Sha256Digest; readonly decision_digest: Sha256Digest;
  readonly resolved_at_revision: SafeInteger;      // >= 1
};
export type OpenGateRef = {
  readonly gate_id: PathSafeId; readonly gate_kind: GateKind;
  readonly subject_digest: Sha256Digest; readonly context_digest: Sha256Digest;
  readonly opened_at_revision: SafeInteger;        // >= 1
};
export type WaiverRef = {
  readonly gate_id: PathSafeId; readonly rule_id: SafeId; readonly rule_version: SafeInteger;  // >= 1
  readonly subject_digest: Sha256Digest; readonly granted: boolean;
  readonly expires: "task-complete"; readonly granted_at_revision: SafeInteger;                // >= 1
};
// `gate_kind` is `z.enum(GATE_KINDS)` (gates.ts:41) wherever a mirror ever needs it. No `gateKind` $def
// ships anywhere in schemas/v1/, so this chunk authors one — `{"enum": [...the nine kinds]}` — rather
// than inlining the nine values twice inside approvalRef and openGateRef.

export type PreparedIntentRef = {
  readonly intent_id: PathSafeId; readonly request_digest: Sha256Digest; readonly prior_revision: SafeInteger;
};

export type TaskStateV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly revision: SafeInteger;                  // >= 1, strictly monotonic in Phase 9
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly status: StepStatus;
  readonly attempt: SafeInteger;                   // >= 1
  readonly input_fingerprint: Sha256Digest;        // the IN-FLIGHT step's declared-input fingerprint (D13)
  readonly initialization_digest: Sha256Digest;    // the adopted task- or legacy-import-initialization
  readonly config_digest: Sha256Digest;
  readonly workflow_digest: Sha256Digest;
  readonly constitution_digest: Sha256Digest;
  readonly policy_base_commit: GitOid;
  readonly authoritative_results: readonly AuthoritativeResultRef[];  // SET, sorted by (phase_instance, step)
  readonly approvals: readonly ApprovalRef[];                         // SET, sorted by gate_id
  readonly waivers: readonly WaiverRef[];                             // SET, sorted by gate_id
  readonly open_gate?: OpenGateRef;                // at most one; a single optional object, never an array
  readonly prepared_intent?: PreparedIntentRef;
  readonly terminal?: TerminalState;
};

export const MAINTENANCE_DELETION_CATEGORIES = ["unreferenced-attempt", "superseded-payload"] as const;
export type MaintenanceDeletionCategory = (typeof MAINTENANCE_DELETION_CATEGORIES)[number];
export type MaintenanceDeletion = {
  readonly digest: Sha256Digest; readonly path: RepositoryPathClaim;
  readonly byte_count: SafeInteger; readonly category: MaintenanceDeletionCategory;
};
export type MaintenanceRecordV1 = {
  readonly schema_version: "1";
  readonly maintenance_id: PathSafeId;
  readonly task_id: TaskSlug;
  readonly performed_at_revision: SafeInteger;      // >= 1
  readonly human_reason: string;                    // minLength 1, x-archflow-max-utf8-bytes 4096
  readonly reachability_proof_digest: Sha256Digest;
  readonly deletions: readonly MaintenanceDeletion[];  // SET, sorted by digest, non-empty
  readonly total_bytes_deleted: SafeInteger;          // equals Σ deletions[].byte_count (rank 9a)
};
```

`STEP_STATUSES`, `TERMINAL_STATES`, and `MAINTENANCE_DELETION_CATEGORIES` are the two modules' runtime exports. Neither module has a Zod mirror (D2), so without a closed-vocabulary `const` their pinned exports would be types only and `export *` would be ambiguous under `verbatimModuleSyntax`. Each vocabulary wants the tuple anyway — the JSON Schema `enum` and the TypeScript union are then derived from one list rather than written twice.

**The five duplicated pinned-input fields are deliberate and are now compared.** `repository_identity_digest`, `config_digest`, `workflow_digest`, `constitution_digest`, and `policy_base_commit` also live in whichever initialization document `initialization_digest` names. The duplication stays because `archflow-status` reads `state.json` alone, without loading the initialization document (REQ-14, REQ-21). What was missing is the agreement check: a state could name the right initialization digest and assert entirely different pinned inputs, leaving two disagreeing authorities and defeating this phase's REQ-04 and REQ-21 slices. Rank 7 now pins one ordered clause per duplicated field (7d–7h), and the rejection corpus mutates each field one at a time.

`WaiverRef.expires` is the const `"task-complete"` and `open_gate` is a single optional object rather than an array. Both are **format** decisions and stay: one const is the narrowest representation of the only expiry this project has, and a single optional field makes a nested gate unrepresentable instead of merely rejected. Neither is a rule Phase 7 *enforces* — waiver scope and expiry, and the one-active-gate lifecycle that decides when `open_gate` may be set, cleared, or superseded, are **Phase 11 (Durable Gates, Waivers, and Manual Decisions)**, the same attribution D14 gives the REQ-16 crossing. Phase 7 makes the wrong shape unwritable; it does not police the transitions.

**D13 — two REQ gaps closed here.** REQ-21 names "declared-input fingerprint" as state-of-truth content; the draft carried it only per authoritative result, leaving the in-flight step's fingerprint unrepresentable and Phase 9 unable to raise `INPUT_FINGERPRINT_MISMATCH` *before* a transition. `input_fingerprint` at the root closes that. REQ-14's "blocking reason" is deliberately **derived, not recorded**: it is a function of `open_gate`, `terminal`, `prepared_intent`, and attempt exhaustion, and recording it would create a second source of truth that can disagree with the first. **Phase 16 (Normal-Mode Thin Phase Skills and Truthful Status)** owns deriving and reporting it.

**What `state.json` references but this phase does not resolve.** `authoritative_results[*].result_digest` names a result manifest, `approvals[*].gate_id` and `open_gate.gate_id` name decision records, `waivers[*].gate_id` names an approval. **`validateDurableSemantics` resolves none of them**, because `DurableSemanticSubject` has no slot that can carry a manifest, decision, approval, or waiver document — there is no discriminant to resolve against and no target to compare with. Each pointer's resolution is assigned to the phase that materializes its target, in Non-Goals. Phase 7 guarantees only that the pointer is present, typed, and digest-shaped.

### Chunks 6 and 7 — the two initialization authorities, Zod mirrors

```ts
// chunk 6 — src/contracts/durable-task-initialization.ts
export type TaskInitializationV1 = {
  readonly schema_version: "1";
  readonly artifact_kind: "task-initialization";        // discriminant
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly code_baseline_commit: GitOid;
  readonly policy_base_commit: GitOid;                  // explicitly approved, human-committed
  readonly constitution_digest: Sha256Digest;
  readonly workflow_digest: Sha256Digest;
  readonly config_digest: Sha256Digest;                 // exact whole-file config.yaml bytes
  readonly canonical_paths: CanonicalTaskPaths;
};
export const taskInitializationV1Schema: z.ZodType<TaskInitializationV1>;
export function parseTaskInitialization(value: unknown): TaskInitializationV1;

// chunk 7 — src/contracts/durable-legacy-import.ts
export type LegacyMappingEntry = {
  readonly legacy_path: RepositoryPathClaim; readonly destination_path: RepositoryPathClaim;
  readonly phase_instance: PhaseInstanceId; readonly disposition: "draft" | "historical";   // never "approved"
};
export type StagedPayloadRef = {
  readonly legacy_path: RepositoryPathClaim; readonly digest: Sha256Digest; readonly byte_count: SafeInteger;
};
export type LegacyImportInitializationV1 = {
  readonly schema_version: "1";
  readonly artifact_kind: "legacy-import-initialization";
  readonly task_id: TaskSlug;                           // the destination task
  readonly repository_identity_digest: Sha256Digest;
  readonly source_identity_digest: Sha256Digest;        // the selected legacy source, never mutated
  readonly import_digest: Sha256Digest;                 // immutable staged import
  readonly import_baseline_commit: GitOid;
  readonly code_baseline_commit: GitOid;
  readonly policy_base_commit: GitOid;
  readonly constitution_digest: Sha256Digest;
  readonly workflow_digest: Sha256Digest;
  readonly config_digest: Sha256Digest;                 // the DESTINATION's config bytes
  readonly canonical_paths: CanonicalTaskPaths;
  readonly mapping: readonly LegacyMappingEntry[];             // SET, sorted by destination_path
  readonly staged_payload_refs: readonly StagedPayloadRef[];   // SET, sorted by legacy_path
};
export const legacyImportInitializationV1Schema: z.ZodType<LegacyImportInitializationV1>;
export function parseLegacyImportInitialization(value: unknown): LegacyImportInitializationV1;
```

Both variants carry all five fields `TaskStateV1` duplicates, plus `task_id`, which is what makes rank 7's per-field comparison uniform across the two: one clause list, two artifact kinds, no branch.

**D15 — no re-pin schema, no amendment schema, and the absence is asserted rather than assumed.** Neither initialization shape has a re-pin field, an amendment field, an upgrade field, or a second config digest, and no schema, `SCHEMA_IDS` key, or module in this phase names one. The architecture's Phase 7 criterion states this as a requirement, so the phase proves it negatively — a grep over `SCHEMA_IDS`, `src/contracts/schemas/v1/`, and both initialization modules must find nothing. A missing feature is otherwise indistinguishable from an overlooked one at the gate.

### Chunk 8 — `document-artifact`, Zod mirror

```ts
export type DocumentArtifactV1 = {
  readonly schema_version: "1";
  readonly artifact_kind: "document";
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;                          // D19: the step that produced it
  readonly document_path: TaskPathClaim;                // task-relative frame, $ref primitives#/$defs/taskPathClaim
  readonly path_class: "document";                      // const
  readonly byte_count: SafeInteger;
  readonly content_digest: Sha256Digest;
  readonly declared_inputs: readonly DeclaredInputRef[];  // SET, sorted by input_id
  readonly input_fingerprint: Sha256Digest;
  readonly snapshot_digest: Sha256Digest;                // the retained result this projects
  readonly projection_target: RepositoryPathClaim;       // repository frame
};
export const documentArtifactV1Schema: z.ZodType<DocumentArtifactV1>;
export function parseDocumentArtifact(value: unknown): DocumentArtifactV1;
```

**D19 — both artifact roots carry `step`, because the fingerprint correlation has no data without it.** `PIPELINE_STEPS` is `["produce","self_review","counter_review","triage","adjudicate"]` (`vocabulary.ts:2`), re-exported by `workflow.ts:7-8` and so reachable through the barrel. Before this, only `AuthoritativeResultRef` declared a `step`, and the fingerprint invariant was written as if `DocumentArtifactV1` and `ImplementationOutputV1` had one — it compared against nothing. The field is added in all three authorities: the TypeScript alias, the JSON Schema (`enum` over the five steps), and the Zod mirror. `state.input_fingerprint` is the *in-flight* step's (D13), so the correlation is only meaningful when the artifact is the in-flight step's own artifact; rank 8 states that guard explicitly.

**The guard is self-declared, and that limitation is attributed.** Every input to it — `artifact.phase_instance`, `artifact.step` — comes from the same subject the invariant polices, and no other invariant in this phase requires a supplied artifact to correspond to the state's in-flight step. A producer can therefore skip the only fingerprint check in the phase by declaring a different `step`. That is acceptable for a format phase, which never sees a transition. **Phase 9 (Transaction Kernel, Intent/CAS, and Crash Recovery)** owns the missing half — "the supplied artifact must be the in-flight step's" — because only the transaction kernel knows which step a request is transitioning.

### Chunk 9 — `implementation-output`, Zod mirror, the largest shape

Authored entirely by `$ref` and import into the files chunks 1, 2, and 4 own; it edits nothing they own. Every cross-chunk `$ref` target it uses is pinned in the `$def` inventory below. **It does not depend on chunk 5** — walking its fields, every one resolves to a shipped `$def`, a chunk 1 `$def`, `outputEntry` (2), `snapshotAccounting` / `declaredInputRef` (4), or a shape declared locally; nothing comes from `task-state.schema.json`. The earlier claim that it did was a stale edge left over from renumbering, and it needlessly serialized a chunk this plan wants running in parallel.

```ts
export type ParentDocumentRef = {
  readonly document_path: TaskPathClaim;                 // $ref primitives#/$defs/taskPathClaim
  readonly content_digest: Sha256Digest;
  readonly role: "prd" | "design" | "phase-design" | "impl-notes";
};
export type UndeclaredChangeReport = {
  readonly scanned: boolean;
  readonly undeclared_paths: readonly RawGitPath[];   // SET, sorted; raw, because a dirty file may be unrepresentable
  readonly unrepresentable_count: SafeInteger;
};
export type ImplementationOutputV1 = {
  readonly schema_version: "1";
  readonly artifact_kind: "implementation-output";
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;              // validator restricts to phase-impl-<n> (rank 4b)
  readonly step: PipelineStep;                           // D19: the step that produced it
  readonly base_commit: GitOid;                          // immutable; the tree the diff is against
  readonly index_identity_digest: Sha256Digest;
  readonly worktree_identity_digest: Sha256Digest;
  readonly outputs: readonly OutputEntry[];              // SET, sorted by path, non-empty
  readonly parent_documents: readonly ParentDocumentRef[];   // SET, sorted by document_path
  readonly diff_digest: Sha256Digest;                    // the exact review / commit-authorization subject
  readonly snapshot_digest: Sha256Digest;
  readonly restore_targets: readonly RepositoryPathClaim[];  // SET, sorted; subset of outputs[].path
  readonly accounting: SnapshotAccountingV1;
  readonly secret_scan: SecretScanResult;
  readonly undeclared_changes: UndeclaredChangeReport;
  readonly declared_inputs: readonly DeclaredInputRef[];  // SET, sorted by input_id
  readonly input_fingerprint: Sha256Digest;
  readonly constitution_edit_gate_id?: PathSafeId;       // structural hook only — see D14
};
export const implementationOutputV1Schema: z.ZodType<ImplementationOutputV1>;
export function parseImplementationOutput(value: unknown): ImplementationOutputV1;
```

**D14 — the REQ-16 crossing is removed.** The draft made `task-branch-constitution` claimable only when `constitution_edit_gate_id` was present. That is constitution-edit *gate policy*, which is REQ-16 and is not in this phase's requirement list. The field stays as the structural hook; the conditional-requirement rule and its success criterion are dropped and attributed to **Phase 11 (Durable Gates, Waivers, and Manual Decisions)** — the same treatment the byte-verification gap gets from Phase 10.

`undeclared_paths` is `RawGitPath[]`, not `RepositoryPathClaim[]`, for the reason Phase 6 established: a valid repository may contain a dirty file whose name has a colon, trailing dot, non-NFC text, or newline, and reporting undeclared changes must not throw when it meets one.

**Every collection in this phase is a set.** The two sequences the earlier design carried — a checkpoint's `evidence_chain` and an import's `chain` — left with the checkpoint family, so after the split there is no shape whose array order is semantic. Every declared array has an ordinal sort key and rejects duplicates structurally, because `canonicalJsonBytes` preserves array order and an unsorted set lets two callers digest identical logical content differently. Phase 8 reintroduces the sequence case.

### Chunks 10, 11, and 12 — `validateDurableSemantics` and its two rejection corpora

```ts
// src/contracts/durable.ts — chunk 10
export type DurableArtifact =
  | TaskInitializationV1 | LegacyImportInitializationV1 | DocumentArtifactV1 | ImplementationOutputV1;

export type DurableSemanticSubject = {
  readonly state?: CanonicalDocument<TaskStateV1>;
  readonly artifact?: CanonicalDocument<DurableArtifact>;
  readonly maintenance?: CanonicalDocument<MaintenanceRecordV1>;
};

export function validateDurableSemantics(subject: DurableSemanticSubject): ProjectResult<void>;
```

Typing the subject against the pinned roots rather than `PlainJsonObject` is what makes the correlations compile-time checkable: renaming `initialization_digest` in chunk 5 breaks chunk 10's build instead of silently disabling the check that uses it. This is the reason D1 is non-negotiable — the signature above does not compile if any root, or any type reachable from one, is an `interface`. `DurableArtifact` is discriminated on `artifact_kind` and holds **four** of the architecture's five union members; **Phase 8 widens it with `manual-checkpoint-import`** (D2).

**The subject has exactly three slots, and the validator claims nothing beyond them.** Every invariant below reads only `state`, one `artifact`, and `maintenance`. There is no result-manifest, decision, approval, waiver, authority-link, or evidence slot, so there is no reference-target correlation here and the document asserts none — the earlier overview and task-state claims to the contrary are withdrawn, and each pointer's resolution is assigned to a named later phase in Non-Goals.

**D12 — the validator's contract.**

*Return channel.* `ProjectResult<void>`, following the live precedent of pure comparators that must report *which* comparison failed — `verifyPinnedConfig` (`fingerprints.ts:217`), `verifyRepositoryIdentity` (`identity.ts:297`), `classifyMutationReadiness` (`history.ts`, already `ProjectResult<void>`). This corrects the draft, which called the function an "orchestrating reader"; Phase 6's convention reserves that term for code that runs git or touches the filesystem, and this function does neither.

*One public failure contract, with the structural boundary named.* The function has exactly two exits, and every criterion and verification step below is written against this split:

- **Semantic disagreement returns** `ProjectResult{ok:false}` with one of the five pinned error codes, chosen by the invariant table.
- **Input-discipline violation throws** a `TypeError`, exactly as `assertPlainJson` (`plain-json.ts:99`) already does. A getter-backed slot, a getter-backed `.value` or `.digest`, or a non-plain `value` is a defect in the *calling server code*, not agent-supplied data, and the repository convention for that is a throw (Phase 6 decision 5).
- **Structural failure never reaches this function.** Unknown fields, missing required properties, closed-enum violations, and pattern failures are rejected by the normative JSON Schema or the Zod mirror at the caller's parse boundary, which reports them with the pinned existing codes. `validateDurableSemantics` re-checks no structure — with two deliberate residues, ranks 2 and 4, which exist precisely because one JSON `pattern` is weaker than its Zod counterpart (D6).

*Input discipline, exact.* Before reading any slot, and before reading any document's `.value` or `.digest`:

1. For each of `state`, `artifact`, `maintenance`, take `Object.getOwnPropertyDescriptor(subject, slot)`. If the slot is present and the descriptor is not an own **data** descriptor (`"value" in descriptor` is false), throw. This is the shipped idiom at `validators.ts:33-36`, reused rather than reinvented.
2. For each present document, apply the same descriptor check to its `value` and its `digest`, then read both into locals. Reading once prevents split observation; the descriptor check is what actually *rejects* a getter, which reading alone does not.
3. `assertPlainJson` the `value` local, `structuredClone` it, and validate only the clone. `assertPlainJson` guards the *inside* of a value and cannot be applied to a whole `CanonicalDocument` — `bytes` is a `Uint8Array` (`canonical.ts:99`).
4. Never re-read the caller's object afterwards.

A caller can build a `CanonicalDocument` as an object literal rather than obtaining it from `parseCanonicalDocument`, so **a caller-supplied `CanonicalDocument` is not authority for its own digest**: any digest the validator compares, it re-derives with `canonicalJsonDigest`. The validator does not inspect `bytes` at all — Phase 10 owns byte-level checks.

*Precondition.* **The validator's caller has already validated the subject against its normative JSON Schema.** Every document it receives is structurally valid. The validator therefore never re-checks structure, per the boundary above.

*One error, deterministic order.* `ProjectResult` carries exactly one error, so the evaluation order is normative and the **first** failing clause is the one reported.

#### The invariant table — one row per clause, exact

Nine ranks. Rank 1 is the input discipline above and throws rather than returning, so it has no row. Every other clause is a row: its literal `issue_code`, its error code, the exact parameter construction, and its position in the candidate order. `issue_code` values are `SafeCode` (`[a-z0-9][a-z0-9_-]{0,63}`, `evidence.ts:22`) and are pinned literally — "names the sub-rank" was not enough for two chunks to agree.

**Reporting code by subject.** `state` → `STATE_INVALID{phase_instance: state.phase_instance, issue_code}`; `implementation-output` artifact → `SNAPSHOT_INVALID{snapshot_digest: artifact.snapshot_digest, issue_code}`; initialization or document artifact, and `maintenance` → `TASK_INVALID{task_id: <that document's own task_id>, issue_code}`; ranks 2 and 4 in every slot → `CONTRACT_INVALID{issue_code}`; rank 8 → `INPUT_FINGERPRINT_MISMATCH` and **no `issue_code`** (that code's parameters are exactly `digestPair` under `.strict()`, `errors.ts:46`, so `createProjectError` throws if given one). **A clause that spans two slots reports against the slot its rank is named for** — rank 7 is "state ↔ artifact" and reports against `state`; rank 9 is "maintenance" and reports against `maintenance`. **No new error code is added.**

| Rank.sub | Clause | `issue_code` | Code | Slot | Collection path | Index |
|---|---|---|---|---|---|---|
| 2 | `state.phase_instance` survives `decodePhaseInstance` | `state-phase-instance-undecodable` | `CONTRACT_INVALID` | state | `""` | 0 |
| 3 | `canonicalJsonDigest(value) === document.digest`, per supplied document | `document-digest-mismatch` | by subject | each | `""` | 0 |
| 4a | every other `phase_instance` survives `decodePhaseInstance` | `phase-instance-undecodable` | `CONTRACT_INVALID` | each | `""`, `authoritative_results`, `mapping` | array index |
| 4b | an `implementation-output`'s `phase_instance` decodes to `kind: "phase-impl"` | `implementation-output-phase-kind` | `CONTRACT_INVALID` | artifact | `""` | 0 |
| 5a | for every `rename`, `previous_path !== path` | `rename-previous-path-equals-path` | `SNAPSHOT_INVALID` | artifact | `outputs` | array index |
| 5b | `restore_targets ⊆ outputs[].path` | `restore-target-not-declared` | `SNAPSHOT_INVALID` | artifact | `restore_targets` | array index |
| 6a | `result_bytes === Σ counted_entries[].stored_bytes` | `accounting-result-bytes-sum` | `SNAPSHOT_INVALID` | artifact | `accounting` | 0 |
| 6b | `task_bytes >= result_bytes` | `accounting-task-bytes-below-result` | `SNAPSHOT_INVALID` | artifact | `accounting` | 0 |
| 6c | every `counted_entries[].path` matches exactly one `outputs[].path` | `accounting-entry-unmatched` | `SNAPSHOT_INVALID` | artifact | `accounting.counted_entries` | array index |
| 6d | every `outputs[].path` matches exactly one `counted_entries[].path` | `accounting-output-unmatched` | `SNAPSHOT_INVALID` | artifact | `outputs` | array index |
| 6e | the matched pair's `storage` agrees | `accounting-storage-mismatch` | `SNAPSHOT_INVALID` | artifact | `accounting.counted_entries` | array index |
| 6f | `stored_bytes === payload_bytes` for a `raw-payload` pair | `accounting-stored-bytes-mismatch` | `SNAPSHOT_INVALID` | artifact | `accounting.counted_entries` | array index |
| 7a | `state.initialization_digest` equals the re-derived digest of a supplied initialization artifact | `initialization-digest-mismatch` | `STATE_INVALID` | state | `""` | 0 |
| 7b | `state.task_id === artifact.task_id` | `artifact-task-id-mismatch` | `STATE_INVALID` | state | `""` | 0 |
| 7c | `state.task_id === maintenance.task_id` | `maintenance-task-id-mismatch` | `STATE_INVALID` | state | `""` | 0 |
| 7d | `state.repository_identity_digest === initialization.repository_identity_digest` | `repository-identity-digest-mismatch` | `STATE_INVALID` | state | `""` | 0 |
| 7e | `state.config_digest === initialization.config_digest` | `config-digest-mismatch` | `STATE_INVALID` | state | `""` | 0 |
| 7f | `state.workflow_digest === initialization.workflow_digest` | `workflow-digest-mismatch` | `STATE_INVALID` | state | `""` | 0 |
| 7g | `state.constitution_digest === initialization.constitution_digest` | `constitution-digest-mismatch` | `STATE_INVALID` | state | `""` | 0 |
| 7h | `state.policy_base_commit === initialization.policy_base_commit` | `policy-base-commit-mismatch` | `STATE_INVALID` | state | `""` | 0 |
| 8 | `artifact.input_fingerprint === state.input_fingerprint` under the D19 guard | *(none — the code names the invariant)* | `INPUT_FINGERPRINT_MISMATCH` | state | `""` | 0 |
| 9a | `total_bytes_deleted === Σ deletions[].byte_count` | `maintenance-total-bytes-mismatch` | `TASK_INVALID` | maintenance | `""` | 0 |
| 9b | `performed_at_revision <= state.revision`, when state is supplied | `maintenance-revision-after-state` | `TASK_INVALID` | maintenance | `""` | 0 |

Guards and orderings the table compresses:

- **Rank 2 exists so that no later rank can throw.** `STATE_INVALID`'s `phase_instance` parameter runs `decodePhaseInstance` under `.strict()` (`errors.ts:26`, `:45`, `:86`), and the `phaseInstanceId` JSON `pattern` admits `phase-impl-99999999999999999999`, which the decoder rejects (D6). Ranks 3 and 5–9 may all report `STATE_INVALID`, so an undecodable `state.phase_instance` must be *established* before any of them runs — otherwise `createProjectError` throws a `ZodError` instead of returning `ProjectResult{ok:false}`. Rank 2 is that precondition: it selects `CONTRACT_INVALID` for the whole subject and no later rank runs. Routing rank 4 to `CONTRACT_INVALID` does not protect rank 3, which is why the earlier ordering was wrong.
- **Rank 4 is the residue**, covering every `phase_instance` rank 2 did not: an artifact root, `state.authoritative_results[*].phase_instance`, and `legacy-import-initialization.mapping[*].phase_instance`. It reports `CONTRACT_INVALID` in every slot, uniformly, because a phase-instance value is the one thing this error family cannot carry.
- **Rank 6's clauses are ordered by dependency.** 6e and 6f presuppose 6c/6d's pairing, so they follow it. The `git-object ⇒ stored_bytes === 0` half is **not** here: D16 makes it structural.
- **Rank 7's per-field clauses presuppose 7a.** 7d–7h run only when the supplied artifact is a `task-initialization` or `legacy-import-initialization` *and* 7a has passed — comparing pinned inputs against a document the state does not actually adopt would report a mismatch that is not one. 7b applies to any supplied artifact; 7c only when `maintenance` is supplied.
- **Rank 8's guard is a correctness condition, not an optimization.** It runs only when `state` and `artifact` are both supplied, the artifact is a `document` or an `implementation-output`, `artifact.phase_instance === state.phase_instance`, and `artifact.step === state.step`. `state.input_fingerprint` is the *in-flight* step's (D13), so comparing a completed artifact from a different `(phase_instance, step)` would be wrong. Artifacts with no `step` never enter it. **Orientation is pinned: `expected_digest` is `state.input_fingerprint` and `observed_digest` is `artifact.input_fingerprint`** — the state of truth is what the artifact is measured against, and the reverse assignment would invert every diagnostic the phase ever emits. Phase 9 owns the half this guard cannot supply (D19).

*The candidate order is total.* The reported error is the minimum under ***(rank, sub-rank, slot, collection path, index)***, compared lexicographically:

- **slot** is `state` = 0, `artifact` = 1, `maintenance` = 2.
- **collection path** is the walked collection's dotted property path as a string — `""` for a clause that reads only the document root, `"accounting.counted_entries"` for a nested one — compared ordinally. `""` sorts below every property name, so a root clause precedes a collection clause at the same rank, sub-rank, and slot. The ordering needs no lookup table because it reuses the ordinal key order `canonicalJsonBytes` already imposes.
- **index** is the ascending array index within that collection, `0` for a root clause.

No further component is required: every sub-rank in the table names exactly one field of one element, so two candidates can never tie on all five. That is stated rather than left implicit so a later phase that *does* bundle two fields into one sub-rank knows it must add a field ordinal rather than assume one exists.

Chunks 11 and 12 own the adversarial corpora as separate chunks because one agent authoring both a validator and its own rejection matrix is marking its own homework. They split along the authority line: chunk 11 exercises what the **schemas** must reject, chunk 12 what the **validator** must reject. Each is roughly half the combined matrix, and neither depends on the other.

### The pinned `$def` inventory — every cross-chunk `$ref` target

Chunk 9 is told to build entirely by `$ref` and import into `$defs` earlier chunks own, so every one of those pointers is pinned here rather than guessed. **The table covers every cross-chunk `$ref` target the phase uses — the ones it creates and the shipped ones it reaches for** — so the success criterion about inventory coverage is literally true rather than approximately true. A consuming chunk uses the **exact** name in this table; an owning chunk must declare exactly these names. All `urn:` prefixes below are `urn:archflow:schema:v1:`.

| `$def` name | Owner file (chunk) | Full pointer | Consumed by chunks |
|---|---|---|---|
| `sha256Digest`, `safeInteger`, `safeId`, `pathSafeId`, `taskSlug` | `primitives.schema.json` (shipped) | `urn:…:primitives#/$defs/<name>` | every new schema (D7); `safeInteger` only for `>= 0` fields, never for a `>= 1` field (D8) |
| `repositoryPathClaim` | `primitives.schema.json` (shipped, `:31`) | `urn:…:primitives#/$defs/repositoryPathClaim` | 2, 4, 5, 7, 8, 9 |
| `phaseInstanceId` | `primitives.schema.json` (1) | `urn:…:primitives#/$defs/phaseInstanceId` | 5, 7, 8, 9 |
| `gitOid` | `primitives.schema.json` (1) | `urn:…:primitives#/$defs/gitOid` | 2, 5, 6, 7, 9 |
| `taskPathClaim` | `primitives.schema.json` (1) | `urn:…:primitives#/$defs/taskPathClaim` | 8, 9 |
| `blobTreeMode` | `durable-primitives.schema.json` (2) | `urn:…:durable-primitives#/$defs/blobTreeMode` | — (the vocabulary's single declaration; both `blobIdentity` variants pin their own mode literal, so nothing `$ref`s it) |
| `blobIdentity` | `durable-primitives.schema.json` (2) | `urn:…:durable-primitives#/$defs/blobIdentity` | 2 (internal to `outputEntry`; no root outside 2 has a blob-identity-typed field) |
| `outputEntry` | `durable-primitives.schema.json` (2) | `urn:…:durable-primitives#/$defs/outputEntry` | 9 |
| `declaredInputRef` | `durable-primitives.schema.json` (4) | `urn:…:durable-primitives#/$defs/declaredInputRef` | 8, 9 |
| `canonicalTaskPaths` | `durable-primitives.schema.json` (4) | `urn:…:durable-primitives#/$defs/canonicalTaskPaths` | 6, 7 |
| `snapshotAccounting` | `durable-primitives.schema.json` (4) | `urn:…:durable-primitives#/$defs/snapshotAccounting` | 9 (`accounting` `$ref`s the **root**, not the entry) |
| `snapshotAccountingEntry` | `durable-primitives.schema.json` (4) | `urn:…:durable-primitives#/$defs/snapshotAccountingEntry` | 4 (internal to `snapshotAccounting`) |
| `stepStatus`, `gateKind`, `authoritativeResultRef`, `approvalRef`, `waiverRef`, `openGateRef`, `preparedIntentRef` | `task-state.schema.json` (5, D21) | `urn:…:task-state#/$defs/<name>` | — (all root-internal; listed so no other chunk re-declares them, and so Phase 8 knows where to `$ref` them from) |
| `maintenanceDeletion` | `maintenance-record.schema.json` (5) | `urn:…:maintenance-record#/$defs/maintenanceDeletion` | — (root-internal) |
| `secretScanResult` (whole root) | `secret-scan-result.schema.json` (shipped) | `urn:…:secret-scan-result` | 9 |

`task-state.schema.json` owns seven `$defs` and `maintenance-record.schema.json` one, and nothing outside chunk 5 consumes any of them. Every other name a chunk needs is owned by chunk 1, 2, or 4, or ships today. **A chunk that cannot resolve a name from this table must stop rather than invent a synonym** — a private re-declaration of `declaredInputRef`, `canonicalTaskPaths`, `snapshotAccounting`, or `outputEntry` is the exact drift the table exists to prevent, and it will pass that chunk's own tests.

### Chunk 13 — registry, barrel, and cross-shape agreement

Leaf chunks 1–12 author only their own modules, schemas, fixtures, and tests. **Chunk 13 is the sole writer of `versions.ts`, `schema-registry.test.ts`, and `index.ts`**, because independent agents editing one object literal and one export list produce patch conflicts, duplicate export lines, and — worst — one agent regenerating a file from its own view and silently dropping another's row. The `satisfies Record<keyof typeof SCHEMA_IDS, string>` constraint catches a *missing* pair, not a dropped one. Every row is pinned here, so the work is transcription:

| Chunk | `SCHEMA_IDS` key | `SCHEMA_FILES` value / filename stem | Barrel line |
|---|---|---|---|
| 1 | — | — | *(edits shared files only; no new module, no new schema)* |
| 2, 4 | `durablePrimitives` | `durable-primitives` | `export * from "./durable-primitives.js";` *(one row and one line; 2 creates the module and schema, 4 extends them)* |
| 5 | `taskState` | `task-state` | `export * from "./durable-state.js";` |
| 5 | `maintenanceRecord` | `maintenance-record` | `export * from "./durable-maintenance.js";` |
| 6 | `taskInitialization` | `task-initialization` | `export * from "./durable-task-initialization.js";` |
| 7 | `legacyImportInitialization` | `legacy-import-initialization` | `export * from "./durable-legacy-import.js";` |
| 8 | `documentArtifact` | `document-artifact` | `export * from "./durable-document.js";` |
| 9 | `implementationOutput` | `implementation-output` | `export * from "./durable-implementation-output.js";` |
| 10 | — | — | `export * from "./durable.js";` |

**Seven new keys, seven new schema files, eight new barrel lines** — the registry goes from 25 to 32. The barrel carries one line more than the key count because `durable.js` holds the validator and registers no schema. Neither split changes a registry row: chunk 1 creates no file, chunks 2 and 4 share one, chunk 3 writes only a test, and chunk 5's two modules are two rows. All new `$id` values are `urn:archflow:schema:v1:<kebab-name>`, matching the 23-of-25 majority; the two `https://archflow.dev/…` IDs are legacy and not a precedent. Barrel placement is dependency-ordered after `errors.js`, following the file's existing convention. Every module carries at least one runtime export, so `export *` is unambiguous under `verbatimModuleSyntax`: the mirrored modules have their schema consts and parsers, `durable.js` has `validateDurableSemantics`, and the two server-internal modules have closed-vocabulary tuples — `STEP_STATUSES` and `TERMINAL_STATES` in `durable-state.js`, `MAINTENANCE_DELETION_CATEGORIES` in `durable-maintenance.js`.

## Files

| Action | File | Purpose |
|--------|------|---------|
| Modify | `src/contracts/schemas/v1/primitives.schema.json` | **Chunk 1 only.** Adds the `phaseInstanceId`, `gitOid`, and `taskPathClaim` `$defs` (D6, D9). |
| Modify | `src/contracts/phase-instance.ts` | **Chunk 1 only.** Adds `phaseInstanceIdV1Schema` and `parsePhaseInstanceId` (D6). |
| Modify | `src/contracts/validators.ts` | **Chunk 1 only.** Generalizes and exports `sortedUniqueBy` as `isSortedUniqueBy`, exports `tupleKey`, deletes `isOrdinalSortedUnique` and the private `sortedUnique` in favour of it, and registers `x-archflow-sorted-unique-by` (D11). |
| Modify | `src/contracts/fingerprints.ts` | **Chunk 1 only.** `DeclaredInputRef` (`:11`): `interface` → `type`, plus the corrected comment at `:107-109` (D1). `GitIdentityRef` (`:16`) is **not** touched. Declaration form only — no runtime or schema effect. |
| Modify | `src/contracts/secret-scan.ts` | **Chunk 1 only.** `SecretFinding` (`:31`): `interface` → `type` (D1). Declaration form only — no runtime or schema effect. |
| Create | `src/contracts/durable-primitives.ts`, `src/contracts/schemas/v1/durable-primitives.schema.json`, `test/unit/durable-primitives.test.ts` | **Chunks 2 then 4 — sequenced; both write all three files, so they cannot run in parallel.** 2: output vocabularies, narrowed blob modes, `BlobIdentity`, the exact 14-branch `OutputEntry`, the claimable/server-owned class sets. 4: `declaredInputRef`, `CanonicalTaskPaths`, `SnapshotAccounting*` with its mirror. |
| Create | `test/unit/durable-output-entry-matrix.test.ts` | **Chunk 3.** The full acceptance/rejection matrix over the 14 pinned branches, in both authorities, plus the compile-time negative fixture. Its own file so chunk 4 can run beside it. |
| Create | `src/contracts/durable-state.ts`, `schemas/v1/task-state.schema.json`, `test/unit/durable-state.test.ts`, `src/contracts/durable-maintenance.ts`, `schemas/v1/maintenance-record.schema.json`, `test/unit/durable-maintenance.test.ts` | **Chunk 5.** The two unmirrored roots plus `PreparedIntentRef`, `MaintenanceDeletion`, `stepStatus`, `gateKind`, and the four D21 reference shapes; JSON Schema authority only. |
| Create | `src/contracts/durable-task-initialization.ts`, `schemas/v1/task-initialization.schema.json`, `test/unit/durable-task-initialization.test.ts` | **Chunk 6.** With Zod mirror. |
| Create | `src/contracts/durable-legacy-import.ts`, `schemas/v1/legacy-import-initialization.schema.json`, `test/unit/durable-legacy-import.test.ts` | **Chunk 7.** With Zod mirror. |
| Create | `src/contracts/durable-document.ts`, `schemas/v1/document-artifact.schema.json`, `test/unit/durable-document.test.ts` | **Chunk 8.** With Zod mirror; carries `step` (D19). |
| Create | `src/contracts/durable-implementation-output.ts`, `schemas/v1/implementation-output.schema.json`, `test/unit/durable-implementation-output.test.ts` | **Chunk 9.** With Zod mirror; carries `step` (D19); built entirely by `$ref`/import into chunks 1, 2, and 4 against the pinned `$def` inventory. |
| Create | `src/contracts/durable.ts`, `test/unit/durable-semantics.test.ts` | **Chunk 10.** The sole semantic authority and its positive-path unit test. |
| Create | `test/contracts/durable-structural-corpus.test.ts` | **Chunk 11.** What the schemas must reject: set ordering and duplicates, byte caps, `git-object` non-zero bytes, unknown fields, absent `step`, `null`, and every permutation fixture. |
| Create | `test/contracts/durable-semantics-corpus.test.ts` | **Chunk 12.** What the validator must reject: every row of the invariant table, the four-way total-order discriminators, the descriptor/throw matrix, and the one-field-at-a-time initialization mismatches. |
| Create | `test/fixtures/contracts/durable/<shape>.valid.json` (7) | **Chunks 2–9.** One canonical valid sample per shape, written by its authoring chunk, mutated by chunks 11 and 12 and read by chunk 13. Rejection cases stay inline in the tests, per the repository's dominant precedent. |
| Create | `test/contracts/durable-agreement.test.ts` | **Chunk 13.** Cross-shape Ajv/Zod agreement and the class-partition bijection. |
| Modify | `src/contracts/versions.ts`, `test/contracts/schema-registry.test.ts`, `src/contracts/index.ts` | **Chunk 13 only.** Seven keys, seven filenames, eight barrel lines, transcribed from the pinned table. |

`package.json` and `.github/workflows/ci.yml` are not modified — `vitest.config.ts` already includes `test/**/*.test.ts`, and `test/contracts/repository-boundary.test.ts:64-106` pins both lists. No runtime dependency is added.

**Estimated size: ~5,300–6,100 lines across 42 files**, against Phase 6's actual 7,776 insertions across 75 files. This supersedes the pre-split figure of ~6,250–7,050 across ~47; the delta is itemized rather than absorbed.

*Removed by the Phase 8 split (about 1,300 lines, 6 files):* `durable-checkpoint.ts`, `manual-checkpoint.schema.json`, `manual-checkpoint-import.schema.json`, `test/unit/durable-checkpoint.test.ts` and the two checkpoint fixtures; `checkpointSelfDigest`; `PredecessorLink`, `ProjectionDigestRef`, and `EvidenceChainEntry` with its `evidence-slots` composition, its `$def`, and its mirror; the `trust.ts` export edit (D5); the chain-continuity and import-head invariants and their whole rejection matrix; two registry rows and one barrel line.

*Added by the accepted findings (about 400 lines, 0 files):* rank 7's five per-field comparisons and their one-field-at-a-time fixtures; rank 2's carriability precondition and the combined invalid-phase-plus-digest-mismatch fixture; the four own-data-descriptor checks and their throw fixtures; the pinned `issue_code` constants. The exact `OutputEntry` union and the invariant table pin work the earlier estimate already carried — they cost document lines, not code lines.

*Added by the chunk splits (2 files, no new work):* `test/unit/durable-output-entry-matrix.test.ts` and the second corpus file. The same lines are written by more agents.

The phase must not grow beyond this.

## Work Breakdown

Thirteen chunks. Each is independently implementable by a fresh sub-agent given only this document, because every seam it crosses is pinned above.

The budget holds. A delegated chunk costs the orchestrator roughly 2–5k tokens of brief and returned conclusion; end-of-phase verification costs 10–30k; the session must finish inside ~200k without compaction. Thirteen chunks at the high end is ~65k plus verification, which leaves headroom for the gate conversation. Two chunks the counter-review judged individually oversized are split rather than left: the 14-branch output authority is separated from its matrix tests (2 / 3), and the single rejection corpus is separated along the schema-versus-validator authority line (11 / 12). No work is added by any split — the same lines are written by more agents — and only chunk 1 is on the critical path for all the others.

1. **Shared-authority edits** — the five shared-file edits and nothing else: `primitives.schema.json` (three `$defs`), `phase-instance.ts`, `validators.ts` (one ordering predicate, two exports, one keyword), `fingerprints.ts` and `secret-scan.ts` (two `interface` → `type` conversions). Creates no file and authors no registry row. *No dependencies; lands first.*
2. **Durable primitives, output authority** — creates `durable-primitives.ts`, its schema, and its unit test: the output vocabularies, the narrowed blob modes, `BlobIdentity`, the 14 pinned leaves with the nested discriminated union, and the claimable/server-owned class sets, with one valid sample per operation. *Depends on 1.*
3. **Output-entry matrix** — the adversarial matrix over all 14 branches in both authorities plus the compile-time negative fixture, in its own test file, written from the pinned branch table by an agent that did not author the ladder. *Depends on 2.*
4. **Durable primitives, shared side** — extends the same three files chunk 2 created: `declaredInputRef`, `CanonicalTaskPaths`, and `SnapshotAccounting*` with its mirror. *Depends on 1, 2 — and cannot run beside 2, because both write the same three files. Runs beside 3.*
5. **The two server-internal roots** — `TaskStateV1` and `MaintenanceRecordV1`, their vocabularies, `PreparedIntentRef`, `MaintenanceDeletion`, `stepStatus`, `gateKind`, and the four D21 reference shapes. JSON Schema authority only. *Depends on 1, 2, 4.*
6. **`task-initialization`** — with Zod mirror, consuming `CanonicalTaskPaths`. *Depends on 1, 2, 4.*
7. **`legacy-import-initialization`** — with Zod mirror, plus the mapping and staged-payload refs and the `draft`/`historical` disposition. *Depends on 1, 2, 4.*
8. **`document-artifact`** — with Zod mirror; `step` and `taskPathClaim`. *Depends on 1, 2, 4.*
9. **`implementation-output`** — the largest shape, built entirely by `$ref` and import; `ParentDocumentRef`, `UndeclaredChangeReport`, the embedded accounting and secret-scan result, `step`, and the structural `constitution_edit_gate_id` hook. *Depends on 1, 2, 4.*
10. **`validateDurableSemantics`** — the module, typed against the pinned roots, implementing the input discipline and every row of the invariant table under the pinned *(rank, sub-rank, slot, collection path, index)* total order and the per-subject reporting codes. *Depends on 1–9.*
11. **Structural rejection corpus** — what the schemas must reject, over every shape's fixture. *Depends on 5–9.*
12. **Semantic rejection corpus** — what the validator must reject: every invariant row, the total-order discriminators, the descriptor/throw matrix, and the per-field initialization mismatches. *Depends on 10.*
13. **Registry, barrel, and cross-shape agreement** — seven keys, seven filenames, eight barrel lines; the cross-shape agreement suite; the class-partition bijection; the full verification run. *Depends on 1–12.*

Chunks 5–9 are mutually independent and can all run in parallel once chunk 4 lands: nothing outside chunk 5 consumes anything chunk 5 declares, so chunks 8 and 9 do not wait on it. The only serialization inside the phase is 1 → 2 → 4 → {5…9} → 10 → 12 → 13, with 3 running beside 4 and 11 running beside 10 once 9 lands. Chunks 1 and 13 must stay isolated: chunk 1 is the seam every other chunk builds on and the only writer of shipped shared files, and chunk 13's whole value is being the only writer of the registry, the bijection test, and the barrel.

## Contract and Semantic Rules

- **D2 — the Zod-mirror set, derived from the architecture's rule rather than replacing it.** The architecture defines the union the rule keys off: `architecture.md` declares `archflow_state.artifact` a closed, versioned tagged union with exactly five members — `task-initialization`, `document`, `implementation-output`, `legacy-import-initialization`, `manual-checkpoint-import`. **Phase 7 defines four of the five**; `manual-checkpoint-import` and its `manual-checkpoint` edge are Phase 8's, which widens `DurableArtifact` when it lands. Phase 3 deliberately deferred *coding* the field, recording that `archflow_state.artifact` is "rejected until its durable union exists"; `mcp-tools.ts:33-34` accordingly has `StateInput{phase_instance, step, status}` and `StateSuccess{path, revision, status}` and no `artifact` field. That is evidence the field is not yet **wired**, not that the union is undefined. **Phase 14 (Five-Tool MCP Assembly and Offline Local CLI)** wires it. So "reachable from the union" resolves cleanly: the four members defined here, plus `snapshot-accounting` through `implementation-output.accounting` — **five shapes** mirrored in this phase, two more in Phase 8. Three further `durable-primitives` `$defs` carry mirrors because a mirrored root embeds them: `outputEntry`, `declaredInputRef`, and `canonicalTaskPaths`. `task-state` and `maintenance-record` are on neither edge; they are exactly the two purely server-internal shapes, and the four D21 reference shapes are internal to `task-state` (D21). The operational restatement — *a durable shape gets a Zod mirror iff an agent supplies it across the MCP tool boundary and it must therefore be validated from untrusted input* — selects the same set, and is a paraphrase for implementers, not a substitute criterion. The no-mirror half follows Phase 5's precedent: `release-manifest.schema.json` and `release-legal-review.schema.json` have JSON Schema authority and no TypeScript module in `src/contracts/` at all.
- **D3 — frame agreement is about the claim brand, not a directory prefix.** The draft's rule ("`path_class ∈ REPOSITORY_PATH_CLASSES` iff the path is not under `.archflow/`") is false: `shared-workflow` is `.archflow/workflow.yaml` and both constitution classes are `.archflow/constitution/<name>.md` (`src/repository/paths.ts:154-160`). The rule is restated as a *declaration* rule: a field typed `TaskPathClaim` is task-relative and may only be paired with a class in `TASK_PATH_CLASSES`; a field typed `RepositoryPathClaim` is worktree-root-relative and is the universal frame. Which brand each path field uses is pinned per field above. There is no runtime frame check, and there cannot be: `taskPathClaimV1Schema` and `repositoryPathClaimV1Schema` are the same object (`path-claims.ts:31-45`) cast to two brands, so the frames are runtime-indistinguishable. The `.archflow/` clause is deleted everywhere it appeared.
- **D4 — `validateDurableSemantics` does no template-based path classification, by design.** The class→template tables live in `src/repository/paths.ts` and `test/contracts/repository-boundary.test.ts:28-38` structurally forbids `src/contracts/**` from importing `src/repository/**`. The validator enforces only what is pure and available in `src/contracts/path-claims.ts`: class-set membership over the 17 classes, the claimable-vs-server-owned partition, frame agreement per D3, and the `previous_path !== path` residue. **Verifying that a path actually matches its declared class's template — including both endpoints of a rename — is repository-layer work owned by Phase 10**, the phase that enforces outputs. This is a stated limitation, not a defect: no Phase 6 module is refactored to work around it and the template tables are not duplicated into `src/contracts/`. A second reason the validator does not attempt it: `classifyRepositoryPath` always returns `shared-constitution` for `.archflow/constitution/<name>.md`, and the caller narrows to `task-branch-constitution` by passing an expected class — the two are not distinguishable from a path alone.
- **The claimable and server-owned sets partition all 17 classes.** Claimable by an implementation output (7): `document`, `import`, `manual-checkpoint`, `repository-source`, `result-payload`, `review`, `task-branch-constitution`. Server-owned and never claimable (10): `attempt`, `decision`, `gate-interface`, `intent`, `maintenance-record`, `result-manifest`, `shared-constitution`, `shared-workflow`, `task-config`, `task-state` — **two** of which `READ_ONLY_PATH_CLASSES` already names (`path-claims.ts:101` is `["shared-workflow", "shared-constitution"]`), and which `SERVER_OWNED_PATH_CLASSES` re-lists literally rather than spreading, because it must stay a closed `as const` tuple. The claimable set is a structural `enum` on `OutputEntry.path_class`, so a server-owned claim is unrepresentable rather than rejected. `manual-checkpoint` stays claimable here even though the checkpoint *shape* moved: the class governs where a checkpoint file may be written, which is a path-class question, and removing it would make Phase 8's own output unrepresentable. A test asserts the two sets are disjoint and their union is exactly `PATH_CLASSES`, so a future class added to `path-claims.ts` cannot land in neither.
- **Structural where possible, semantic only where necessary (D10, D11, D16).** Structural: the `OutputEntry` operation × storage × file-type table across its 14 pinned leaves; the `file_type` ↔ surviving-mode equivalence, with `before` on `modify`/`rename` deliberately unconstrained; the byte caps as `maximum`; `stored_bytes === 0` for a `git-object` accounting entry, as a discriminated union on `storage` (D16); the claimable class enum; the shape of the one-active-gate rule (`open_gate` is a single optional object, so nesting is unrepresentable — the *lifecycle* is Phase 11's); intra-document set ordering and uniqueness via `x-archflow-sorted-unique` and the new `x-archflow-sorted-unique-by`. Semantic: only the rows of the invariant table. **Not covered by either**: a cross-class rename, whose endpoints this phase cannot classify (D4) — pinned to Phase 10. The Zod mirrors must carry `.refine()` rules matching the set keywords or `assertZodAgreement` fails — `release-manifest` has no mirror and so provides no template, which is why chunk 1 exports `isSortedUniqueBy` and `tupleKey` for the mirrors to reuse.
- **`z.toJSONSchema()` was evaluated and rejected; no later phase may "simplify" into it.** Zod 4.4.3 — the exact pinned version — ships a first-party `z.toJSONSchema()` targeting draft 2020-12, and `zod-to-json-schema` is archived, so generating one authority from the other looks like it would delete the two-authority drift risk outright. Executed live against the repo's pinned `zod@4.4.3`, it does not: `.brand()` is transparent and `.strict()` emits `additionalProperties: false` correctly, but **`.refine()` produces no output and no error** — a string `.refine()` emitted `{"type":"string","minLength":1}` and an array `.refine()` emitted `{"type":"array","items":{"type":"string"}}`, both silently dropping the constraint, and `z.custom()` threw *"Custom types cannot be represented in JSON Schema"*. The constraints that would vanish are exactly the load-bearing ones: the `pathSafeId` / `taskSlug` reserved-device-name and trailing-dot/space refinements (`evidence.ts:50-53`), NFC (`validators.ts:51`, whose own comment records that NFC is not expressible as a `pattern`), and every set-ordering rule this phase adds. Generation would produce a strictly weaker JSON Schema and `assertZodAgreement` would still pass, because both sides would be equally weak. **Exporting the predicates so the Ajv keyword and the Zod refinement call the same function (D11) is the correct mitigation for the drift generation was supposed to address** — it removes the duplicated logic without removing the constraint.
- **The "no new runtime dependency" position is verified, not assumed.** Every pinned runtime dependency is at npm `dist-tags.latest` with no advisory at the pinned version — `ajv 8.20.0` (2026-04-24; there is no v9 and no successor project), `ajv-formats 3.0.1`, `zod 4.4.3`, `yaml 2.9.0`, `@modelcontextprotocol/server 2.0.0` — and JSON Schema 2020-12 remains the current draft, so nothing here is pinned to something superseded. The one candidate addition, `ajv-keywords`, offers `uniqueItemProperties`: uniqueness without ordering, which is strictly less than `x-archflow-unique-by` already delivers, and the package has been effectively dormant since 2022. No maintained library covers cross-document *semantic* invariants at all; hand-written is the normal answer there. The phase adds nothing.
- **JSON Schema is the structural authority for every shape.** Where a Zod mirror exists it is a mirror, never a second model, and `assertZodAgreement` proves it over a shared corpus. Where no mirror exists — `task-state`, `maintenance-record` — there is exactly one shape model plus the semantic validator.
- **Unknown fields come free** from Zod `.strict()` and JSON Schema `additionalProperties: false`, and are rejected at the caller's parse boundary, never inside `validateDurableSemantics` (D12). The semantic validator runs on a subject that has already passed its normative JSON Schema and never re-checks structure — with two named residues, ranks 2 and 4, which exist because the `phaseInstanceId` `$def` can only be a `pattern` and the pattern is weaker than the decoder (D6, D12).
- **Digest fields are references, not authority.** A digest-shaped string never establishes that its target exists; the validator resolves what the subject supplies and claims nothing about what it does not receive. Phase 5 established this for release evidence.
- **Absence is `.optional()` plus omission from `required`, never `null`.** Across `src/contracts/schemas/v1/` there are zero occurrences of `"null"` and across `src/contracts/*.ts` zero `z.null`/`.nullable()` uses; the convention is `gates.ts:95` and `mcp-tools.ts:59`. Branded integers cannot be widened to admit `null` anyway.
- **No new error code.** Every failure uses `STATE_INVALID`, `SNAPSHOT_INVALID`, `TASK_INVALID`, `CONTRACT_INVALID`, or `INPUT_FINGERPRINT_MISMATCH`. The 52-code and 56-row assertions must still pass unchanged.
- **`evidence-slots.schema.json` is not edited, and neither is `trust.ts`.** Phase 2 owns the slots; the shape that composed them moved to Phase 8.

## Architecture amendment — applied 2026-07-28

An earlier revision of this document proposed three amendments on the premise that `architecture.md`'s Phase 7 statements keyed off an `archflow_state.artifact` union nothing had defined. **That premise was wrong and the two amendments built on it are withdrawn.** The union is defined as a closed, versioned tagged union with exactly five members, and the architecture records that Phase 3 deferred the field "until its durable union exists". The Scope's mirror clause and Success Criterion 3 are satisfiable as written once the split below is reflected, and are otherwise left alone.

**The phase split is itself the amendment, and it has been applied.** The human approved the split at the design gate on 2026-07-28, and `architecture.md` now carries it: **Phase 8: Manual Checkpoint Chain and Import** is inserted, the old Phases 8–20 are renumbered 9–21, and the Phase 7 Scope, requirement line, every downstream "Depends on", the Progress table, and the requirement-coverage table are updated. A note under `## Phases` records that completed phase designs and past counter-reviews were **not** rewritten, so a phase number in any document dated before 2026-07-28 refers to the old numbering. **This phase's implementation does not edit `architecture.md`**, and nothing in the Files table touches it. What the amended Scope says:

- Phase 7 ships exactly **seven** schemas: `task-state` (`state.json`), `task-initialization`, `document`, `implementation-output`, `legacy-import-initialization`, `maintenance-record`, and one shared `durable-primitives`.
- `manual-checkpoint` and `checkpoint-import` are **Phase 8's**, together with REQ-39 and the manual-import half of REQ-50.
- Snapshot accounting is a `$def` of the `durable-primitives` schema rather than a registry entry, because it is never a standalone document: it exists only inside `implementation-output.accounting`. It still carries a Zod mirror like any shape reachable from the union.

No other architecture section changes on account of this design.

## Non-Goals and Deferred Ownership

| Not done here | Owner |
|---|---|
| **The manual-checkpoint chain, the import wrapper, and their chain invariants.** `ManualCheckpointV1`, `ManualCheckpointImportV1`, `PredecessorLink`, `ProjectionDigestRef`, `EvidenceChainEntry`, `checkpointSelfDigest`, chain continuity, import-head agreement, and the `expected_state_revision` correlation. **Phase 8 extends *this* validator module — `src/contracts/durable.ts` — rather than creating a second semantic authority**; it adds ranks, widens `DurableArtifact` with `manual-checkpoint-import`, and reaches `task-state.schema.json`'s reference `$defs` by `$ref` (D21). It also makes the `trust.ts` evidence-slot export this design withdrew, and reintroduces the phase's only *sequences*. **Two defects caused the split and Phase 8 inherits them, unfixed.** (1) *The format could not prove initialization.* A checkpoint carried only an `initialization_digest`, and `DurableSemanticSubject` admits exactly one artifact document, so an import could not also supply the initialization artifact its checkpoint 1 names — which the architecture requires when state is absent. The continuation mode was equally incomplete: a gapless chain could legally begin above revision 1, and the head comparison used only a revision number rather than the predecessor's digest. (2) *A digest-valid chain could cross task boundaries*, because nothing required every checkpoint's `task_id` to equal the wrapper's. | **Phase 8** |
| State mutation, transaction kernel, locks, revision CAS, intent receipts, atomic writes, config-pin enforcement before transition | **Phase 9** |
| The request-digest denylist replacement. Phase 6 left a KNOWN LIMITATION in `src/contracts/fingerprints.ts` whose stated owner is "the phase that defines per-operation request field sets". Phase 7 defines no operations; its only request-shaped item is the opaque `PreparedIntentRef.request_digest`. Naming the owner here keeps the limitation from being silently re-orphaned at this gate. | **Phase 9** |
| Requiring a supplied artifact to *be* the in-flight step's. Rank 8's guard reads `phase_instance` and `step` from the same artifact it polices, so a producer can skip the phase's only fingerprint check by declaring a different `step`. Only the transaction kernel knows which step a request is transitioning (D19). | **Phase 9** |
| Snapshot materialization, payload restore, and byte verification of `payload_bytes` / `payload_digest` / `after.oid` | **Phase 10** |
| Path-template verification of a declared `path_class` (D4), **including classifying both endpoints of a `rename` and rejecting one whose endpoints belong to different classes**. This phase cannot do it — both endpoints are runtime-indistinguishable `RepositoryPathClaim` strings and the template tables are across the import boundary — and the earlier claim that one `path_class` made a cross-class rename unrepresentable is withdrawn. | **Phase 10** |
| Resolving `authoritative_results[*].result_digest` to a result manifest and proving the two agree. `DurableSemanticSubject` cannot receive a manifest, so no invariant here can check it; the phase that materializes manifests can. | **Phase 10** |
| Resolving `approvals[*].gate_id`, `open_gate.gate_id`, and `waivers[*].gate_id` to decision, gate, and waiver records, and proving `subject_digest` / `decision_digest` agreement with them. Same reason: no slot, no target. | **Phase 11** |
| Gate lifecycle, waiver lifecycle, and constitution-edit gate policy — including the REQ-16 rule the draft placed in this validator (D14) | **Phase 11** |
| Enforcing the one-active-gate lifecycle. Phase 7 fixes the *shape* — `open_gate` is a single optional object, so a nested or concurrent gate is unrepresentable — but nothing here decides when it may be set, cleared, superseded, or resumed. | **Phase 11** |
| Waiver scope and expiry policy. Phase 7 fixes the *shape* — `WaiverRef.expires` is the const `"task-complete"` — but scoping a waiver to a rule, granting it, and expiring it are lifecycle. | **Phase 11** |
| Correlating evidence and authority links to the artifact digests they attest, and the REQ-13 freshness comparisons that read this phase's digest-bound fields. Phase 7 supplies the fields; it receives no evidence document and asserts no correlation over one. | **Phase 13** |
| Wiring the `archflow_state.artifact` field into `mcp-tools.ts` and the Zod mirrors into tool input schemas. Phase 3 defined the union in the architecture and deferred the field "until its durable union exists"; this phase supplies four of its five members, Phase 8 the fifth, and Phase 14 the field. | **Phase 14** |
| Deriving and reporting the REQ-14 blocking reason from `open_gate` / `terminal` / `prepared_intent` / attempt exhaustion (D13) | **Phase 16** |
| Migrating the **one** migratable literal `phaseInstanceId` regex copy, `trust.ts:141`, onto the new shared authority (D6). `errors.ts:26` and `gates.ts:121` need no migration — they already delegate to `decodePhaseInstance`. `src/repository/paths.ts:67` is excluded permanently: it is a regex *source fragment* composed into path templates, not a validator, and it sits on the repository side of the boundary `src/contracts/**` may not depend on. | a future phase; recorded, not done |
| Regenerating the tracked `dist/` release payload (D18) | the Phase 6 follow-up on Phase 5's integrity model |
| Secret-scanning engine, dispatch, canonical Markdown rendering, finding IDs, attestation | Phases 10, 12, 2, 12 respectively |

## Success Criteria

- [ ] Every root shape — `TaskStateV1`, `MaintenanceRecordV1`, and the four artifact roots — is declared as a `type` alias with pinned properties, required fields, its `artifact_kind` discriminant where applicable, and named cross-document keys in both TypeScript and JSON Schema. No root is specified only in prose, and **no type transitively reachable from a root is an `interface`** — including `DeclaredInputRef` (`fingerprints.ts:11`) and `SecretFinding` (`secret-scan.ts:31`), which this phase converts. A grep for `^export interface` across the eight new `durable-*` modules returns nothing, and the two converted declarations are `type` in the diff. The criterion is scoped to declarations, not whole files: `fingerprints.ts` and `secret-scan.ts` keep `GitIdentityRef`, `InputFingerprintSubject`, `RequestDigestSubject`, `SecretScanCandidate`, and `SecretScanner` as interfaces, none of which is reachable from `DurableArtifact`. The two conversions are runtime- and current-consumer-neutral; they intentionally close declaration merging on those two names, which is the point rather than a side effect.
- [ ] `validateDurableSemantics` is typed against those roots, returns `ProjectResult<void>`, and compiles: `CanonicalDocument<TaskStateV1>` and both other subject slots satisfy `T extends PlainJsonValue`. Renaming a correlated field in any leaf chunk fails `npm run typecheck`.
- [ ] `DocumentArtifactV1` and `ImplementationOutputV1` each declare `step: PipelineStep` in all three authorities — the `type` alias, the JSON Schema `enum` over `PIPELINE_STEPS`, and the Zod mirror — so the fingerprint correlation has both halves of its key (D19).
- [ ] Task-initialization and legacy-import-initialization bind the exact whole-file config digest, and **no re-pin or amendment schema exists**: no `SCHEMA_IDS` key, no file under `src/contracts/schemas/v1/`, and no field in either shape names a re-pin, amendment, upgrade, or second config digest.
- [ ] All seven shapes round-trip valid samples through their normative JSON Schemas. Every mirrored shape — `task-initialization`, `legacy-import-initialization`, `document-artifact`, `implementation-output`, `snapshot-accounting` — passes `assertZodAgreement`, as do the three shared `$defs` that carry mirrors: `outputEntry`, `declaredInputRef`, `canonicalTaskPaths`. `task-state` and `maintenance-record` have exactly one shape model each: neither `durable-state.ts` nor `durable-maintenance.ts` declares a Zod schema, and no Zod schema anywhere names a `TaskStateV1`, `MaintenanceRecordV1`, `AuthoritativeResultRef`, `ApprovalRef`, `WaiverRef`, `OpenGateRef`, or `PreparedIntentRef` field.
- [ ] **The failure contract is one contract and the tests agree with it.** Semantic disagreement returns `ProjectResult{ok:false}` with a pinned existing code; unknown fields, missing required properties, and every other structural failure are rejected by the normative schema at the caller's parse boundary and never reach `validateDurableSemantics`; input-discipline violations throw a `TypeError`. No new error code is added and the 52-code / 56-row assertions still pass.
- [ ] Every `OutputEntry` combination outside the 14 pinned leaves is **structurally** unrepresentable: Ajv rejects it, the Zod discriminated union rejects it, and the TypeScript union has no inhabitant for it. `file_type === "symlink"` holds iff the surviving blob mode is `120000`, and `040000` / `160000` are rejected by the narrowed enum rather than by a comment. Each of the 14 leaves is declared flat, with exactly the required properties and none of the forbidden ones from the pinned branch table.
- [ ] `path_class` on an implementation output is a structural enum over exactly the 7 claimable classes; the claimable and server-owned sets are disjoint and their union is exactly `PATH_CLASSES` (17). **No criterion claims a cross-class rename is unrepresentable** — it is representable, this phase checks only `previous_path !== path`, and Phase 10 is pinned to classify and verify both endpoints.
- [ ] Byte accounting is bound to the 25 MiB per-result and 250 MiB per-task caps structurally; `stored_bytes === 0` for a `git-object` entry is **structural too**, as a discriminated union on `storage` (D16), not a validator rule; and the one-to-one correspondence with the declared outputs it measures — matching `path`, matching `storage`, `stored_bytes === payload_bytes` for `raw-payload` — goes through `validateDurableSemantics`, which is the only part of it that spans two shapes.
- [ ] The `before`/`after` asymmetry is stated and tested: on `modify` and `rename`, `before` accepts either blob mode independently of `file_type`; on `delete`, `before` is the surviving blob and is mode-locked to `file_type`.
- [ ] The document states plainly that `payload_bytes`, `payload_digest`, and `after.oid` are assertions here and names **Phase 10** as the layer that verifies them; no success criterion in this phase claims byte existence.
- [ ] `validateDurableSemantics` **descriptor-checks before it reads**: each present subject slot, and each present document's `value` and `digest`, must be an own enumerable data descriptor (`Object.getOwnPropertyDescriptor` plus `"value" in descriptor`, the shipped form at `validators.ts:33-36`) or the call throws a `TypeError`. It then destructures each into a local, `assertPlainJson`s and `structuredClone`s each `value`, never re-reads the caller's object, and re-derives every digest it compares.
- [ ] **The validator claims no correlation its subject cannot receive.** `DurableSemanticSubject` has exactly three slots — `state`, `artifact`, `maintenance` — every invariant reads only those, and no text in this document assigns it reference-target resolution. Each unresolved pointer has a named later owner in Non-Goals.
- [ ] **`state.json` cannot contradict the initialization it adopts.** For both initialization variants, rank 7 compares every field `TaskStateV1` duplicates — `task_id`, `repository_identity_digest`, `config_digest`, `workflow_digest`, `constitution_digest`, `policy_base_commit` — in the pinned sub-rank order, and the corpus mutates each one at a time. The duplication itself stays, because `archflow-status` reads `state.json` without loading the initialization document.
- [ ] **No rank can throw where it is required to return.** `state.phase_instance` carriability is established at rank 2, ahead of every rank that may report under a code carrying `phase_instance`, and the corpus includes the *combined* case — an undecodable `phase_instance` together with a self-digest mismatch — not only the isolated one.
- [ ] The reported error is a **total function** of the subject under the full tuple *(rank, sub-rank, slot, collection path, index)*, with the exact `issue_code` literal, error code, and parameter construction taken from the invariant table. `INPUT_FINGERPRINT_MISMATCH` carries `expected_digest = state.input_fingerprint` and `observed_digest = artifact.input_fingerprint` and **no `issue_code`** (`errors.ts:46` is `.strict()` over exactly the two digests). Ranks 2 and 4 report `CONTRACT_INVALID{issue_code}` in every slot.
- [ ] Every declared set is sorted by its declared ordinal key with duplicates rejected structurally, and permutation fixtures prove a shuffled set is rejected by both authorities. **There is no sequence in this phase**; the two that existed left with the checkpoint family.
- [ ] Every cross-chunk `$ref` in the phase resolves to a `$def` named in the pinned inventory — which lists both the `$defs` this phase creates and the shipped ones chunks reach for — and every `$def` in that inventory exists in its named owner file. No chunk invents a synonym for a target another chunk owns; in particular no chunk re-declares `declaredInputRef`, `canonicalTaskPaths`, `snapshotAccounting`, or `outputEntry` locally.
- [ ] Chunk 1 is the sole writer of `primitives.schema.json`, `phase-instance.ts`, `validators.ts`, `fingerprints.ts`, and `secret-scan.ts`, and creates no file; `trust.ts` is byte-unchanged; its `fingerprints.ts` and `secret-scan.ts` edits change declaration form only, leaving both modules' runtime behaviour and every existing schema byte-identical. `validators.ts` ends with exactly one ordering predicate. Chunk 13 is the sole writer of `versions.ts`, `schema-registry.test.ts`, and `index.ts`, transcribing seven keys, seven filenames, and eight barrel lines; the bijection test and the `satisfies Record<keyof typeof SCHEMA_IDS, string>` constraint both hold at 32 entries.
- [ ] `package.json` is byte-identical in `dependencies` and `scripts`; no code in this phase writes a file, acquires a lock, runs a Git command, or materializes a payload.
- [ ] Every `check` step other than `check:release` passes under Node `24.15.0` and `24.18.0`, and the test suite shows **no failure beyond the three pre-existing `test/integration/release-offline.test.ts` cases**.

## Verification Steps

**D18 — release-payload reality, pre-declared.** Two facts the implementing session must know before it starts.

*Creating schema files invalidates the tracked release payload.* `collectDeclaredPaths` (`scripts/release-support.mjs:376-380`) enumerates every `*.schema.json` under `src/contracts/schemas/v1/` and verification asserts exact set equality against the tracked manifest (`:896`). The payload is **already** invalid this way: `dist/manifest.json` declares 24 schemas and is missing Phase 6's `secret-scan-result.schema.json`. Modifying `src/contracts/versions.ts` and `test/contracts/schema-registry.test.ts` additionally touches `REQUIRED_CONTROLS` (`release-support.mjs:94-117`).

*Regeneration is blocked and this phase does not attempt it.* Phase 6 diagnosed a contradiction among three invariants in Phase 5's release-integrity model (`release-support.mjs:1380`, `:803`, `:676-677`) that cannot co-exist across a bundle change, and recorded it as its top follow-up. Phase 7 inherits that follow-up and makes no attempt at re-promotion.

*Consequence.* `npm run check` terminates at `check:release` and is **unsatisfiable as an aggregate**. The measured baseline at Phase 6 close is **635 of 638 tests passing; the 3 failures are all `test/integration/release-offline.test.ts`, failing through `validateReleaseSemantics` at `scripts/release-support.mjs:880`**. Run the individual `check` steps rather than the aggregate, and prove no new failure beyond those three. Note that after Phase 7 the *reason* for the red deepens — the declared-schema set mismatch at `:896` now also holds — so the failure count alone is no longer a sufficient fingerprint; check the failing assertion, not just the tally.

1. Run each `check` step individually under the exact `24.15.0` and `24.18.0` binaries (the ambient developer Node is `24.11.1`, below the `>=24.15.0` engines floor, and both Phase 5 and Phase 6 hit this trap): `probe:phase4-mcp-compatibility`, `typecheck`, `test:mcp-runtime`, `test`, `test:contracts`, `build:temp`, `check:dependencies`, `check:notices`, `test:notices-policy`, `check:phase4-mcp-boundary`, `test:phase4-mcp-boundary-policy`. Confirm the failure set is exactly the three known `release-offline` cases.
2. Round-trip one valid sample per shape through its JSON Schema, and through `assertZodAgreement` for each of the five mirrored shapes plus the three shared `$defs` that carry mirrors (`outputEntry`, `declaredInputRef`, `canonicalTaskPaths`) — each mirror is anchored on its pinned export name. Grep for any Zod schema naming a `TaskStateV1`, `MaintenanceRecordV1`, or D21 reference-shape field and confirm none exists.
3. Run the `OutputEntry` matrix (chunk 3) and assert **structural** rejection by both authorities: `delete` with `storage: "raw-payload"`; `git-object` carrying `payload_digest`; `raw-payload` without `payload_digest`; `raw-payload` without `payload_bytes`; `delete` carrying `after`; `add` carrying `before`; `rename` without `previous_path`; `add` or `modify` carrying `previous_path`; `file_type: "regular"` with `after.mode: "120000"`; `file_type: "symlink"` with `after.mode: "100644"`; `mode: "160000"`; `mode: "040000"`; `delete` with `before.mode: "120000"` and `file_type: "regular"`; a server-owned `path_class`. Then assert **acceptance** of one sample per pinned leaf (14) and of the two cases that exercise `before`'s deliberate freedom: `modify` with `before.mode: "120000"`, `after.mode: "100644"`, `file_type: "regular"`, and the same pair reversed. Assert the TypeScript union rejects the rejected shapes by adding a compile-time negative fixture.
4. Run the `path_class` partition test: an implementation output claiming each of the ten server-owned classes is rejected; the two sets are disjoint and their union is exactly `PATH_CLASSES`, with sizes 7 and 10 against 17. Assert the rename residue separately: `previous_path === path` returns `rename-previous-path-equals-path`, and a rename whose endpoints belong to two actual classes is **accepted** here — the test records the deferral to Phase 10 rather than pretending the check exists.
5. Run the accounting matrix: `result_bytes` disagreeing with the sum of `counted_entries`; `result_bytes` above `26214400`; `task_bytes` above `262144000`; `task_bytes` below `result_bytes`; a `git-object` entry with non-zero `stored_bytes`; a `counted_entries` path with no matching `OutputEntry`; an `OutputEntry` with no matching `counted_entries` row; `storage` disagreeing across a matched pair; `stored_bytes` disagreeing with `payload_bytes`. Confirm the two cap cases **and** the non-zero `git-object` case are rejected by the schema, not the validator (D16), and that each of the others returns its exact `issue_code` from the invariant table.
6. Run the ordering matrix: shuffle each declared set and assert rejection by **both** the Ajv keyword and the Zod refinement, confirming both call `isSortedUniqueBy` with the same `tupleKey`; duplicate a key in each and assert rejection; assert a multi-key set is ordered by the pinned `U+0000`-joined tuple, including a pair whose components would order differently under a `":"` join. Assert there is no array in this phase that is exempt from set ordering.
7. Run the input-discipline matrix and assert it **throws**, not returns: a subject whose `state`, `artifact`, or `maintenance` slot is an accessor property; a document whose `value` is an accessor property; a document whose `digest` is an accessor property; a `value` that is not plain JSON. Then assert the semantic case returns: a `CanonicalDocument` whose `digest` disagrees with `canonicalJsonDigest(value)` returns `ok: false` with `document-digest-mismatch` under the pinned code for its subject. There is no `bytes` case: the validator never inspects `bytes` (Phase 10 does).
8. Assert the phase-instance carriability path. Feed a subject whose `state.phase_instance` matches the JSON `pattern` but fails the decoder — `phase-impl-99999999999999999999` — and confirm `validateDurableSemantics` returns `ProjectResult{ok:false}` carrying `CONTRACT_INVALID{issue_code: "state-phase-instance-undecodable"}`. **Then feed the combined case** — the same undecodable `phase_instance` *and* a `state` whose digest disagrees with its value — and confirm it still returns rather than throwing, and still reports rank 2, proving rank 2 precedes rank 3. Separately assert the reason directly: `createProjectError("STATE_INVALID", {phase_instance: "phase-impl-0", issue_code: "…"})` **throws** a `ZodError`, so `STATE_INVALID` is not an admissible carrier for this failure. Finally assert rank 4 for an undecodable `authoritative_results[*].phase_instance` and for an `implementation-output` whose `phase_instance` decodes to a non-`phase-impl` kind.
9. Assert the state ↔ initialization comparison one field at a time. Starting from a valid `state` + `task-initialization` pair, mutate exactly one of `repository_identity_digest`, `config_digest`, `workflow_digest`, `constitution_digest`, `policy_base_commit`, and `task_id` in the state and confirm the exact `issue_code` from rank 7 is returned each time. Repeat the whole set against `legacy-import-initialization`. Then mutate `initialization_digest` as well as one pinned field and confirm 7a is reported, not the later clause.
10. Assert the reported error is a total function of the subject under every tuple component. Construct one subject violating two clauses at **different ranks** and confirm the lower rank is reported; a second violating the **same rank in two slots** — a `state` and an `implementation-output` whose digests both disagree with their values — and confirm `STATE_INVALID` is reported, never `SNAPSHOT_INVALID`; a third violating **one rank at two array indices** and confirm the lower index is reported; a fourth violating **two sub-ranks at the same rank and slot with no index to separate them** — 7a and 7b together — and confirm 7a's `issue_code` is reported and 7b's never is; and a fifth violating **the same rank and sub-rank in a root clause and a nested collection** — 4a at the artifact root and at `mapping[0]` — and confirm the root clause (collection path `""`) is reported. Repeat each across runs.
11. Assert `step` in all three authorities for both `DocumentArtifactV1` and `ImplementationOutputV1` (D19): the `type` alias declares `step: PipelineStep`; the JSON Schema declares an `enum` whose members are exactly `PIPELINE_STEPS`; the Zod mirror declares the matching `z.enum`. Omit `step` from a valid fixture of each and confirm **both** authorities reject it; supply a sixth step value and confirm both reject that too. Then assert the fingerprint orientation: with the guard satisfied and the two fingerprints disagreeing, `expected_digest` equals `state.input_fingerprint` and `observed_digest` equals `artifact.input_fingerprint`, and the error carries no `issue_code`.
12. Assert the correlated-field typecheck criterion negatively. Temporarily rename `TaskStateV1.initialization_digest` in `durable-state.ts` and confirm `npm run typecheck` fails inside `durable.ts` at rank 7a's comparison; repeat for `ImplementationOutputV1.accounting` against rank 6. Revert both. A correlation that survives the rename is not compile-time checked and the invariant must be re-typed until it is.
13. Assert the declaration-form criterion by grep: `^export interface` over the eight new `durable-*` modules returns nothing; `DeclaredInputRef` (`fingerprints.ts:11`) and `SecretFinding` (`secret-scan.ts:31`) are `type` declarations in the diff; and `GitIdentityRef` (`fingerprints.ts:16`) is still `export interface`, unchanged.
14. Assert the negative config criterion: grep `SCHEMA_IDS`, the schema directory, and both initialization modules for any re-pin, amendment, upgrade, or second-config-digest field or file, and assert none exists.
15. Assert the registry invariants after chunk 13: `SCHEMA_IDS` and `SCHEMA_FILES` in exact bijection at 32 entries, every new `$id` matching its file, every schema compiling with every other as a reference, seven new keys / seven new files / eight new barrel lines, no duplicate export line, and no leaf chunk's diff touching `versions.ts`, `schema-registry.test.ts`, or `index.ts`.
16. Assert every `$def` in the pinned inventory exists in its named owner file with that exact name, and that every `$ref` in the seven new schemas resolves — compile each new schema with the full reference set and confirm Ajv raises no `can't resolve reference`.
17. Confirm chunk 1's shipped-file edits are behaviour-neutral for current consumers: `git diff` on `fingerprints.ts` and `secret-scan.ts` shows only `interface` → `type` (and the corrected comment), `trust.ts` and `evidence-slots.schema.json` are byte-unchanged, `test/unit/errors.test.ts` and `test/contracts/gate-error-supplemental-exhaustive.test.ts` still pass unchanged, and the `validators.ts` predicate consolidation leaves every existing keyword's behaviour identical on the shipped corpora.
18. Confirm the exclusions: no `"null"` in any schema, no `.nullable()` in any new module, no new error code, `package.json` byte-identical, and no new call to `node:fs`, `node:child_process`, or anything in `src/repository/` from `src/contracts/` — the boundary suite must still pass.

---
*Designed: 2026-07-28*
