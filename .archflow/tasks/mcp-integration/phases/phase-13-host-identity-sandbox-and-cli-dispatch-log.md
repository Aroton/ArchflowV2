## Implementation Log: Phase 13 - Host Identity, Sandbox, and CLI Dispatch

### Decisions Made

- `src/contracts/hosts.ts` exports `deriveHostIdentity(client): "claude" | "codex" | "unknown"`. Exact recorded client names establish family; patch-version compatibility is enforced separately by CLI preflight floors (`claude >= 2.1.205`, `codex >= 0.122.0`).
- `src/dispatch/routing.ts` derives adapter/family from configured full model slugs and validates adapter-specific effort vocabularies before workspace creation. Claude accepts `low|medium|high|xhigh|max`; gated Codex 0.146.0 recognizes all six durable `EFFORT_VALUES`, including `max|ultra`.
- `src/dispatch/cli.ts` keeps exactly one host-derived selector, `selectCliAdapter(host, options)`, and one process-wide FIFO, `serializeDispatch(operation)`. Claude reviewer dispatch remains disabled unless `allow_claude_dispatch: true`.
- The review observation-capability minter remains solely in `src/contracts/internal/test-capabilities.ts`; it is intentionally absent from `src/contracts/index.ts`. Preserving server-attestation authenticity takes precedence over the weaker convention that dispatch never imports an internal contract module.
- Managed-policy discovery is non-gating `CliPreflight` telemetry. Only `ENOENT` means absent; Phase 15 must persist the returned telemetry with its dispatch attempt because the Phase 2-frozen review attestation has no field for it.
- `src/dispatch/workspace.ts` creates a generated home containing only the selected credential-file symlink and its parent directory. The child environment is an explicit allowlist and the temporary cwd must resolve outside the repository.

### Deviations from Plan

- The architecture's original enforced-sandbox requirement is not implemented. Per the approved Phase 13 scope decision, suppression flags, a clean home, scrubbed environment, and temp cwd are best-effort context hygiene; REQ-32 and VAL-07 remain partially unmet and the future release containment criterion remains open.
- `node:child_process` replaced the planned `execa` dependency. Execa does not contain `setsid()` descendants and would add 16 transitive packages without satisfying the required guarantee.
- `src/dispatch/cli.ts` directly imports the sole internal review-capability minter. The alternative implemented during the first pass exposed minting through the public durable barrel and was removed after counter-review.
- Managed-policy presence is returned on `CliPreflight`, not embedded in `ServerAttestedReview`; widening the frozen durable evidence contract solely for telemetry was rejected. Phase 15 owns the attempt record that persists it.
- macOS Keychain authentication from a generated `HOME` was not testable on this WSL2/Linux host. No real-`HOME` fallback was added; macOS behavior remains unresolved. `codex features list` 0.146.0 exposes no `view_image` feature/disable target, so the conditional `--disable view_image` flag was not added.

### Patterns Established

- Stable identity names and behavioral version gates are separate: exact handshake names select a family, while the executable version floor guards features that have a documented compatibility reason.
- Capability minters that confer server-attested authority stay outside public contract barrels. Privileged production code may use a narrow internal import rather than making the minter generally reachable.
- Dispatch requests are serialized through one rejection-safe FIFO because both CLI arms share first-party credential stores.
- Child-visible envelope ordering and digest canonicalization are distinct: `schema_version` is literally first in the bytes sent to the child, while `envelope_input_digest` uses a domain-separated canonical digest preimage.
- Stdout/stderr and Codex's `-o` file are independent bounded channels; the file is statted and bounded-read because child-process buffer limits do not cover it.

### Gotchas

- Claude `--json-schema` requires inline JSON; a file path fails before model invocation. Claude output is a CLI wrapper, and only canonical re-encoded `structured_output` bytes reach observation.
- Codex semantic failures come only from valid top-level `error` or `turn.failed` JSONL events. Stderr is diagnostic/canary input and cannot classify rate/auth/model errors.
- Codex `--ephemeral` does not suppress global state discovery by itself, and `-s read-only` is not a read boundary. The generated `CODEX_HOME` and explicit suppression flags are hygiene measures, not containment proof.
- The final serialized suite passes 1,420/1,423 tests. The three inherited `test/integration/release-offline.test.ts` failures remain: stale tracked bundle inputs and the residual `__require` loader. Phase 15 owns rebuilding the tracked release payload.

### Key Interfaces

- `src/contracts/hosts.ts`: `deriveHostIdentity(client: { readonly name: string; readonly version: string }): HostIdentity`.
- `src/dispatch/routing.ts`: `resolveDispatchRoute(config: ConfigV1, phaseKind: RoutingPhaseKind, role: RoutingRole, producer_family: ModelFamily): DispatchRoute`.
- `src/review/envelopes.ts`: `buildReviewEnvelope(value: ReviewEnvelopeInput): DispatchEnvelope`, with `{ bytes, digest, byte_count }` and a 1 MiB child-byte cap.
- `src/dispatch/workspace.ts`: `createDispatchWorkspace(adapter: AdapterId, repositoryRoot?: string): Promise<DispatchWorkspace>`; callers must invoke idempotent `dispose()` on every exit path.
- `src/dispatch/process.ts`: `runDispatchChild(spec: DispatchChildSpec): Promise<DispatchChildResult>` and `scanDispatchOutput(output, plantedValues)`; timeout defaults to 300,000 ms and each output channel to 8 MiB.
- `src/dispatch/cli.ts`: `selectCliAdapter(host: HostIdentity, options?: CliDispatchOptions): CliAdapter`, `serializeDispatch<T>(operation: () => Promise<T>): Promise<T>`, and `mintReviewObservation(input: ReviewObservationMint)`.
- `CliAdapter.preflight(workspace)` returns `{ cli_version, managed_policy_present, managed_policy_paths }`; Phase 15 must retain the policy fields with its attempt record.
