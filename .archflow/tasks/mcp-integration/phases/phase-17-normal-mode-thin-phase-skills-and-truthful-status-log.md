## Implementation Log: Phase 17 - Normal-Mode Thin Phase Skills and Truthful Status

### Decisions Made

- Non-produce calls use one canonical fingerprint shape: `{ rubricDigest, artifactPaths, upstreamPaths }`. `src/state/fingerprint.ts` hashes that shape, while `src/state/fingerprint-readers.ts` separately re-observes filesystem freshness so mutable projections cannot silently become call identity.
- A produced artifact's durable identity is the retained produce manifest `artifact_digest`. `src/state/produce-subject.ts` uses that digest consistently for gate subjects, authenticated upstream approvals, adjudication evidence, and status currency; projected document bytes are dispatch material only.
- `phase-design` now opens an `artifact-approval` gate. Its retained design artifact is therefore an authenticated upstream of `phase-impl`, preserving the no-code-before-approved-design boundary.
- Status is derived by `computeTaskStatus` in `src/state/status.ts` and next action by `deriveNextAction` in `src/state/next-action.ts`. Active gate binding comes from the archived request through `activeGateHead`, preserving `supersedes` and every other authenticated request field.
- Commit authorization and commit proof are distinct. `buildCommitAuthorizationInput` describes the action the user may approve; `implementationOutputCommittedAtCurrentTarget` requires the recorded target commit to be reachable and its committed tree entries to match the retained implementation manifest before status advances or completes.
- `buildGateDecisionTemplates` and `writeGateDecisionInterface` in `src/state/gates.ts` are the sole renderer/writer for disposable human gate interfaces. Templates enumerate every accepted decision shape, including waivers, cancellation, and pre-bound adjudication failures.
- `computeCallEnvelope` in `src/local/envelope.ts` is shared by the local CLI commands so status, templates, counter-review prompts, and call metadata are projected from durable authority without stdin reads for input-free commands.

### Deviations from Plan

- The Files table was expanded during implementation to include the durable subject-domain helpers, local envelope, Git proof helpers, release evidence, and additional integration/contract tests actually required by the design. The phase document and `architecture.md` record those amendments.
- The approved design initially treated `phases/<n>/design.md` as an implementation upstream without opening an approval gate for it. Implementation adds the missing `phase-design` artifact-approval gate; otherwise every implementation adjudication would remain unsatisfiable.
- The original implementation briefly compared upstream approvals against projected file-content digests. Counter-review exposed the split domain; all upstream identity now uses the retained produce artifact digest.
- Adjudication post-dispatch re-observation was removed because the approved design requires that check only for counter-review dispatch.
- Implementation-output projections may name worktree-contained paths because they attest the implementation diff. Other document artifacts remain task-root-contained.
- Adjudication preserves canonical upstream path order at the request boundary, then digest-sorts the derived upstream facts for the fixed-point envelope required by durable semantic validation.

### Patterns Established

- Retained produce manifests establish durable artifact identity; filesystem bytes establish current projection/freshness. Never substitute one digest domain for the other.
- Any artifact declared as an adjudication upstream must have an artifact-approval authority in the producing phase.
- Rebuild active-gate views from `activeGateHead(active, archivedRequest)` rather than constructing partial request-shaped objects.
- Authorization to perform a Git action is not evidence that the action occurred. Completion requires immutable commit OID, ancestry, and committed-tree verification.
- Disposable gate interfaces are projections: status can reconstruct them from archived durable requests and active authority, and corruption or loss cannot block resolution.
- A no-input local command parses its command first and must not wait for stdin.

### Gotchas

- `artifact_digest` is not the SHA-256 of the artifact file bytes. It is the digest retained by the produce manifest and is the only approval/adjudication subject identity.
- `supersedes` is part of the authenticated gate request. Omitting it while rebuilding a status projection produces `active-gate-mismatch` and suppresses both templates and the required counter-review prompt.
- Canonical upstream path order and fixed-point evidence order are different constraints: validate paths first, then sort derived evidence by digest.
- The tracked release must be restaged whenever bundle inputs change. Phase 17 required rebinding `release/legal-review.json`, focused reachability evidence, and explicit user risk acceptance to MCP bundle `bd36e2fdcfd2dc2609f75cd74166842ddfffcc8c7a170182e417e112bb4a8ab1`.
- `CLAUDE.md` and `AGENTS.md` are intentionally byte-identical; keep them synchronized.

### Key Interfaces

- `src/state/document-artifact.ts`: `buildDocumentArtifact(input: DocumentArtifactInput)` builds non-implementation produced artifacts.
- `src/state/implementation-manifest.ts`: `buildImplementationOutput(input: ImplementationOutputInput)`, `verifyImplementationManifest(...)`, and `implementationOutputCommittedAtCurrentTarget(...)` build, verify, and prove implementation outputs.
- `src/state/produce-subject.ts`: `expectedProduceUpstreamBindings(state)`, `loadProduceUpstreamSubject(...)`, `loadCurrentProduceSubject(...)`, `readProduceProjection(...)`, and `renderProduceReviewMaterial(...)` define produced-subject and upstream identity.
- `src/state/next-action.ts`: `deriveNextAction(input: NextActionInput): NextAction` is the exhaustive normal/degraded next-action reducer.
- `src/state/status.ts`: `computeTaskStatus(...)`, `computeDegradedStatus(...)`, and `buildCommitAuthorizationInput(...)` produce truthful status and commit authorization.
- `src/state/gates.ts`: `buildGateDecisionTemplates(active)`, `writeGateDecisionInterface(...)`, `openDurableGate(...)`, and `resolveDurableGate(...)` own gate projection and lifecycle.
- `src/state/reconciliation-discovery.ts`: `discoverReconciliationInput(...)` discovers an unambiguous prepared successor without changing durable state.
- `src/local/envelope.ts`: `computeCallEnvelope(...)` and `renderGateCounterPrompt(...)` produce the local command envelope and ready-to-run cross-client prompt.
- `src/repository/git.ts`: `resolveCommit(...)`, `readHeadCommit(...)`, `isCommitAncestor(...)`, `readCommitTreeBlob(...)`, and `readCommitTreeEntries(...)` provide immutable Git proof primitives.

### Verification

- `npm run check` passed on 2026-08-03: 13 MCP runtime files / 117 tests, 140 files / 1,607 tests, 19 contract files / 467 tests, TypeScript, temporary bundles, dependency policy, notices policy, phase-4 boundary policy, release integrity mutations, smoke tests, and release reproduction.
- Real Phase 17 flows cover two successive implementation-output produces with accounting and secret scanning, adjudication with non-empty upstreams reaching `advance`, status over a server-opened superseding gate, non-final committed advancement, and final terminal completion using an actual Git commit.
- The tracked release was staged, written, and reproduced with MCP digest `bd36e2fdcfd2dc2609f75cd74166842ddfffcc8c7a170182e417e112bb4a8ab1`, local CLI digest `570840fe559e85b8c5d6dfee9f0e6a954eeccc1881f0e0726029f6fdb0702bb8`, and dependency inventory digest `a5a828821d2fb59a678a8c3b64c186aab0d3dbb5c3423873044fe71d280be36f`.
