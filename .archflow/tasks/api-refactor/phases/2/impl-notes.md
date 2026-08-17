## Implementation Log: Phase 2 - Client-Driven Document Workflows and Nonblocking Decisions

### Decisions Made

- Kept `TOOL_NAMES` and `ToolName` in `src/contracts/tool-names.ts` closed to the four durable low-level tools. Added separate semantic and advertised vocabularies so `archflow_status` and `archflow_apply` expand only the public catalogue.
- Added strict semantic result parsing and generated input/result schemas in `src/contracts/semantic-workflow.ts` and `src/contracts/schemas/v1/semantic-workflow.schema.json`; public inputs keep plain object roots and the apply submission union remains nested.
- Added live handlers in `src/mcp/handlers/semantic.ts`. `handleSemanticStatus` is read-only; `handleSemanticApply` executes one authenticated document-workflow offer through bounded in-process capabilities and returns the freshly projected view.
- Reused the existing gate state machine through `archiveDirectSemanticGateDecision`, `settleDirectSemanticGateDecision`, and `enterDirectSemanticRevisionCheckpoint` in `src/state/gates.ts`. Human decisions are archived immutably, settlement is independently replayable, and re-entry decisions stop at a close-only checkpoint until a separate revise action.
- Kept semantic review under one outer dispatch FIFO while calling the direct inner counter-review seam, avoiding nested queue acquisition.
- Migrated only `skills/archflow-prd/SKILL.md`, `skills/archflow-design/SKILL.md`, and `skills/archflow-phase-design/SKILL.md`. `archflow-phase-impl` and `archflow-status` remain on the legacy surface for later phases.
- Regenerated the tracked `dist/` payload after source, schemas, skills, maintained documentation, and review remediation stabilized. Final MCP bundle digest: `113f7657499d4c8fc20d7e94f4b7e58e5c788fecd952d6037d7302a7262a54e8`.

### Deviations from Plan

- The approved design originally named terminal triage as a single semantic substep. Live journeys proved the durable state machine requires `triage/running` before terminal triage. `.archflow/tasks/api-refactor/design.md` and `.archflow/tasks/api-refactor/phases/2/design.md` now record the implemented `triage-enter` -> terminal `triage` / `review-empty-triage` sequence. Each transition has its own authenticated intent and replay boundary; public behavior and phase scope are unchanged.
- Registering the live semantic handler graph exposed an esbuild evaluation-order failure in the MCP SDK's module-scope recursive Zod schema (`ZodLazy is not a constructor`). `src/mcp/sdk-zod-initialization.ts`, imported first by `src/main.ts`, establishes a retained runtime initialization dependency. A bare side-effect import was insufficient because Zod declares `sideEffects: false`.

### Patterns Established

- Public advertised tool identity and persisted low-level tool identity are separate types; expanding a catalogue must not silently widen durable transition or receipt contracts.
- A compound semantic action refreshes both `ProductionServices` and the authenticated status snapshot after every durable substep, and classifies lower-level failure before any continuation.
- Every durable transition inside a compound semantic action needs its own closed substep name and deterministic intent. This is a candidate task-independent convention for the repository `CLAUDE.md`.
- Exact retry recognizes both legitimate `revise-enter` authorities: the ordinary `archflow_state / record-state-boundary` used after accepted triage and the direct `archflow_gate / semantic-revision-enter` used after a close-only human checkpoint. Tool, operation, fingerprint, and operation digest must all authenticate before returning the current view.
- A pre-facade `archflow-local` re-entry archive receives a domain-separated settlement operation digest over its canonical gate request and decision digests. That lets semantic status offer one exact continuation without weakening the connected-host `afdecision-<operation_digest>` binding.
- A predecessor may report exact successor skill facts, but only the newly invoked enabled successor receives and consumes a handoff offer.
- Apply-result parity with a fresh status call is the primary integration assertion at every successful and refused semantic boundary.

### Gotchas

- The legacy state machine rejects terminal triage directly from `counter_review/succeeded`; weakening that transition would break replay authority. Enter `triage/running` with `triage-enter`, refresh, then record terminal triage.
- After a successful planning reopen, document skills must query again with their exact `resume` invocation. Continuing with `reopen` cannot own the new production window.
- A `start-next-skill` view without an offer belongs to the predecessor for reporting only; applying it would violate successor ownership.
- The bundled MCP SDK evaluates a recursive `z.lazy` schema at module scope. Preserve the `src/mcp/sdk-zod-initialization.ts` dependency fence unless the upstream bundle no longer has that ordering hazard.
- Cancellation and hostile-shape tests intentionally emit `INTERNAL_ERROR` diagnostics while passing; judge their terminal Vitest summaries, not the expected stderr lines in isolation.
- Legacy archive-before-state recovery must derive the same settlement operation in status and execution. Treating every re-entry archive as connected-host provenance strands an otherwise valid local decision after a crash cut.

### Key Interfaces

- `handleSemanticStatus(input: ArchFlowStatusInputV1, context: InvocationContext): Promise<SemanticResultV1>` in `src/mcp/handlers/semantic.ts`.
- `handleSemanticApply(input: ArchFlowApplyInputV1, context: InvocationContext): Promise<SemanticResultV1>` in `src/mcp/handlers/semantic.ts`.
- `executeSemanticAction(services, snapshot, value, capabilities): Promise<WorkflowViewV1>` in `src/state/semantic-actions.ts`; decision, review, and triage compound paths refresh services and snapshot between authenticated substeps.
- `archiveDirectSemanticGateDecision`, `settleDirectSemanticGateDecision`, and `enterDirectSemanticRevisionCheckpoint` in `src/state/gates.ts` share legacy archive, closure, restart, receipt, and re-entry authority.
- `semanticInvocationEnabled` and `projectSemanticStatus` in `src/state/semantic-view.ts` enforce the Phase 2 document-only activation fence and exact handoff ownership.
- `SEMANTIC_TOOL_NAMES`, `AdvertisedToolName`, and the unchanged durable `ToolName` in `src/contracts/tool-names.ts` define the transitional six-public/four-durable split.
- `test/integration/semantic-document-journeys.test.ts` proves PRD and design journeys, remediation, client-owned Git, successor ownership, parity, hostile offers, and the phase-implementation fence.
- The same journey completes phase-design compound parent updates, review, nonblocking approval, exact client commit, predecessor no-offer projection, and handoff to the still-legacy phase-implementation workflow.

### Verification Evidence

- Raw transcript: `.archflow/runtime/tasks/api-refactor/cache/phases/2/verification.txt`.
- `npm run typecheck`, `npm run generate:schemas`, and `npm run check:schemas` passed; 32 generated schemas match committed bytes.
- The initial focused Phase 2 matrix passed 16 files and 159 tests; post-review remediation matrices passed, including 56 attempt-aware replay tests and all three complete semantic document journeys.
- `npm run test:mcp-runtime` passed: 10 files and 114 tests.
- `npm run test:contracts` passed: 26 files and 457 tests.
- Final `npm test` passed: 171 files and 1,794 tests; 4 files and 24 tests were skipped by their normal guards.
- `npm run build:temp` built and exercised the temporary contract and inert runtime bundles.
- `npm run check` passed the SDK compatibility probe, typecheck, schema drift, MCP runtime, full Vitest, contracts, temporary bundles, notices and policy mutations, SDK boundary and policy mutations, and tracked release check/smoke/mutation/reproduction gates.
- Release reproduction matched bundle digest `113f7657499d4c8fc20d7e94f4b7e58e5c788fecd952d6037d7302a7262a54e8` and manifest digest `951ee67da52e8bf08c2c020b7bb0c4c4248f229de6e6406cef317ab4daf1df6b`.
