# Phase 13 Implementation Counter-Review

**Task**: mcp-integration
**Phase**: 13 — Host Identity, Sandbox, and CLI Dispatch
**Reviewed**: 2026-07-30 (uncommitted working tree, `feature/mcp-server`)
**Scope**: the files in the design's Files table, read against the phase design, `architecture.md`, `prd.md`, and `.archflow/context/`.

## What was verified independently

- `npm run typecheck`, `npm run build:temp`, `npm run check:phase4-mcp-boundary` all pass; the release-bundle purity constraint holds with `src/contracts/hosts.ts` added.
- `npm test`: 1420/1423, failing only the three inherited `test/integration/release-offline.test.ts` assertions (same `stale bundle input: src/contracts/adjudication.ts` signature recorded since Phase 6). Assertion set unchanged.
- The nine new/changed Vitest files pass (91 tests).
- The pinned Claude argv was probed against the **real** installed CLI (2.1.220): `claude -p --safe-mode --tools "" --disable-slash-commands --strict-mcp-config --mcp-config … --no-session-persistence --setting-sources "" --output-format json --json-schema … --model … --effort max` is accepted end to end and fails only on the deliberately invalid schema (`--json-schema is not valid JSON`). `--setting-sources ""` is therefore confirmed, not merely fixture-asserted. Every pinned Codex flag exists on 0.146.0.
- Both preflight parsers match reality: `claude auth status` emits `{"loggedIn":true,…}` and `codex login status` emits `Logged in using ChatGPT`; `claude --version` → `2.1.220 (Claude Code)` and `codex --version` → `codex-cli 0.146.0` both match the implemented regexes.
- Doc amendments 1–6, 9, 10 are in `architecture.md`; 7, 8 and the REQ-32/VAL-07 partial-coverage statement are in `prd.md`.

Coverage of the design's Verification Steps is otherwise unusually complete. The findings below are what survived.

---

## Findings

### 1. `deriveHostIdentity` keys identity on the exact client **version**, so the host becomes `unknown` on the next client patch release — **blocker**

`src/contracts/hosts.ts:27-31` matches `handshake.name === name && handshake.version === version` against two literal rows (`claude-code`/`2.1.220`, `codex-mcp-client`/`0.146.0`), and `test/unit/contracts-hosts.test.ts:38-39` pins `{name:"claude-code", version:"2.1.221"} → "unknown"` as intended behavior.

Those two versions are exactly the CLIs installed on this machine today. Claude Code ships patch releases continuously; the first one lands `host: "unknown"` into every `ConnectionContext` (`src/mcp/sdk-adapter.ts:273`), and Phase 15 will then refuse every dispatch with `UNSUPPORTED_HOST` until someone edits a constant in `src/` and cuts a release. The design asked for identity "driven by recorded real handshakes rather than substring guessing" — recording the handshake justifies pinning the *name*, not equality on a field that changes weekly by design.

This also contradicts the phase's own versioning model: CLI versions are gated by a documented **minimum floor** (`CLAUDE_MINIMUM_VERSION`, `CODEX_MINIMUM_VERSION`) for a stated reason (`--json-schema` silent corruption below 2.1.205). No comparable reason exists for the MCP client's version, and nothing downstream reads it. Nothing else in the phase requires exact-version identity, so this is behavior without a requirement behind it.

**Suggested resolution**: derive identity from `clientInfo.name` alone (exact, case-sensitive, no substring matching — the existing negative tests at `contracts-hosts.test.ts:44-49` all still pass on name-only matching). Keep the recorded handshake fixtures as the evidence that those names are the real ones, and keep version policy where it already lives — the preflight floor against the CLI binary. Replace the "unrecorded version" test rows with the same names at a newer version asserting the correct host.

### 2. Effort is validated only on the Claude arm; any `EFFORT_VALUES` member reaches Codex unchecked — **major**

`src/dispatch/routing.ts:40-44` rejects `ultra` for `claude-cli` and validates nothing for `codex-cli`, and `src/dispatch/cli.ts:415` then emits `-c model_reasoning_effort="<effort>"` verbatim. `EFFORT_VALUES` is `low|medium|high|xhigh|max|ultra` — Claude's vocabulary. `max` and `ultra` are not Codex reasoning-effort values.

The design's chunk 2 states the rule as "`EFFORT_VALUES` includes `"ultra"` which Claude does not accept, **and unknown Codex effort strings pass through silently**, so effort is validated against the selected adapter" — the Codex clause is the *reason* the check has to exist on that arm, and it is the one that was dropped. Both possible outcomes are bad and neither is classified: under `--strict-config` an unparseable value fails after workspace creation and spawn, surfacing as an opaque `PROCESS_FAILED` instead of a pre-launch `CONFIG_INVALID`; if instead it is silently ignored, the child runs at Codex's default while `ServerAttestedReview.effort` attests the configured value — an attestation that misdescribes the run it exists to bind.

**Suggested resolution**: give `assertSupportedEffort` a per-adapter accepted set (Claude: `low|medium|high|xhigh|max`; Codex: the values `model_reasoning_effort` actually accepts on the gated version), failing `CONFIG_INVALID {issue_code: "effort-unsupported"}` before any workspace or child, and add the Codex-arm rejection case to `test/unit/dispatch-routing.test.ts` beside the existing `ultra` case.

### 3. The observation-capability minter was added to the public durable barrel, and the design's copy in `internal/` is dead — **major**

`createReviewObservationCapability` now exists **twice**: at `src/contracts/trust.ts:62-67` and at `src/contracts/internal/test-capabilities.ts:19-24`. The second copy is imported by nothing (`grep` across `src/` and `test/` finds no consumer) — it is the Files-table version, orphaned.

The first copy is reachable through `src/contracts/index.ts:19` (`export * from "./trust.js"`), so the durable contracts barrel now publicly exports a way to mint an `ObservationCapability<"review">` from a caller-authored binding. Before this phase the brand registry had exactly one minter and it lived behind `internal/`, outside the barrel; the design said in as many words that "the brand registry stays private". The seam still checks the eight echoed fields and opposite-family, but every one of those is compared against the *caller's own* binding, so a caller holding the public minter can produce `ServerAttestedReview` evidence from bytes it authored. No test or contract assertion catches the widening: the barrel assertion at `test/contracts/durable-agreement.test.ts:556` only pins the `export *` line order, not the symbols.

The design is genuinely self-contradictory here (put the minter in `internal/`, but `src/dispatch/` must not import `internal/`), so a boundary had to give. That is a legitimate call — but it was resolved silently in the direction that opens the public surface, the losing alternative was left in the tree as dead code, and neither the phase doc nor `architecture.md` records the decision.

**Suggested resolution**: delete the unused `internal/test-capabilities.ts` copy. Then either (a) keep the minter out of the barrel — e.g. leave it in `internal/` and let `src/dispatch/cli.ts` import it, which breaks the weaker of the two design constraints and keeps the trust seam closed — or (b) keep the current placement and record the deviation explicitly in the phase doc and `architecture.md` as a widening of the public trust surface. Whichever is chosen, the assertion in `test/unit/dispatch-attestation.test.ts:62-66`, which currently *pins* the public-barrel route as the intended design, should be updated to match the recorded decision rather than freeze an unrecorded one.

### 4. The managed-policy preflight result is computed and then dropped — **major**

The design's Preflight row requires the managed-policy `stat` to be "**recorded as an attestation field** and gates nothing". `preflight` (`src/dispatch/cli.ts:213-218`) returns `managed_policy_present` / `managed_policy_paths` on `CliPreflight`, and nothing consumes them: `mintReviewObservation` cannot carry them, because the frozen `ObservationBindingByKind["review"]` (Phase 2) has no such field. The only test coverage is `expect.any(Boolean)`. The observation therefore survives nowhere — not in the attestation, not in any persisted record — so the limitation the check exists to surface is invisible to a human reading the evidence.

Related and smaller: `existingPaths` (`src/dispatch/cli.ts:154-165`) maps *every* `stat` error to "absent", so a managed-settings file that exists but is unreadable (`EACCES` — the realistic case for `/etc/claude-code/`) is reported as no managed policy, which is the inverse of the safe answer for a field whose whole job is disclosure.

**Suggested resolution**: decide and record which it is. Either name the Phase 15 record that will carry `managed_policy_present` (and pin it with a test that a planted policy path is reported), or state in the phase doc and `architecture.md` that the frozen binding cannot carry it and that Phase 13 exposes it on `CliPreflight` only. Distinguish "unreadable" from "absent" in `existingPaths` if the value is going to be published at all.

### 5. No implementation log; the design's only mandated experiment (macOS) is unrecorded — **major**

Every phase from 6 onward has a `phase-N-…-log.md`; phase 13 has none, and the phase doc is still `IN PROGRESS`. Two design-mandated records have nowhere to live yet:

- The macOS credential question. The design was explicit that chunk 4 "settles it by a recorded run rather than pre-deciding a fallback" — whether Claude authenticates from a generated `HOME` when its store is the login Keychain. The implementation ships the Linux-only shape (`~/.claude/.credentials.json` symlink) with no record of whether macOS was tested, and this machine is WSL2, so the honest outcome is "not testable here" — which still has to be written down, because the code silently assumes the answer.
- `view_image` is omitted from `CODEX_DISABLED_FEATURES` and `test/unit/dispatch-cli.test.ts:130` pins the omission. The design conditioned it on "if it proves flag-addressable"; nothing records what was found.

**Suggested resolution**: write the implementation log before the commit gate and record both outcomes, plus the deviations in findings 3 and 4, per the project's "parent docs are updated when implementation deviates" rule.

### 6. `AGENTS.md` is an unrequested new root file that duplicates `CLAUDE.md` byte for byte — **major**

`AGENTS.md` is untracked, byte-identical to `CLAUDE.md` (verified with `diff`), and is not in the design's Files table or anywhere in its scope statement. Committed with the phase it becomes a second copy of the project instructions that will drift from the first, in a repository whose own design work treats `AGENTS.md` as a context-contamination surface.

**Suggested resolution**: leave it out of this phase's commit. If a Codex-readable pointer is actually wanted, that is its own decision and belongs in a doc-owning change, ideally as a one-line pointer to `CLAUDE.md` rather than a copy.

### 7. `cliAdapterForId` is a second, weaker adapter-selection door added for tests only — **major**

The design pinned "the `CliAdapter` shape, **two-arm selection**, and both adapters". `selectCliAdapter` (`src/dispatch/cli.ts:439-449`) is that: host in, *opposite* family out, `UNSUPPORTED_HOST` on an unknown host. `cliAdapterForId` (`:451-457`) is an additional export that selects by adapter id with no host and no opposite-family reasoning; its only callers are `test/unit/dispatch-cli.test.ts` and `test/integration/dispatch-cli.test.ts`. It duplicates the `allow_claude_dispatch` gate — so that release-disabling rule now has two implementations to keep in agreement — and gives Phase 15 a route to an adapter that never consulted the host identity this phase exists to derive.

**Suggested resolution**: delete it and have the tests drive `selectCliAdapter("codex", {allow_claude_dispatch: true})` / `selectCliAdapter("claude")`, which yield the same two adapters. If Phase 15 genuinely needs id-based lookup for a route resolved from config, add it there with the host cross-check that makes it safe.

### 8. The generated home gets a `.codex` directory even on a Claude dispatch — **major** (small)

`src/dispatch/workspace.ts:63-70` always creates `<home>/.codex`, and `test/unit/dispatch-workspace.test.ts:72-74` pins the Claude-arm home as `[".claude", ".codex"]`. The design's constraint is emphatic: the generated home holds "generated defaults plus a symlink to the single credential file — **nothing else**", and an empty `.codex` under a Claude child is neither. No behavioral consequence today, but it is an explicit pinned constraint and the current test cements the deviation rather than the rule.

**Suggested resolution**: create the credential directory for the selected adapter only (`CODEX_HOME` stays in the environment map exactly as pinned; it may point at a directory the Claude child never creates), and update the workspace test to assert `[".claude"]` / `[".codex"]`.

---

## Checked and found sound (not findings)

Recorded so the next reader does not re-derive them:

- **Isolation posture.** Nothing gates on isolation, no `SandboxProvider`, no probe, `SANDBOX_UNAVAILABLE`/`SANDBOX_PROBE_FAILED` unused, no environment declared unsupported, no dependency added, no new error code, registry count unchanged. The best-effort framing is carried in code comments, `architecture.md`, and `prd.md` without overclaiming.
- **Argv/output-channel asymmetry.** Claude: inline schema in argv, wrapper extraction of `structured_output` re-encoded canonically, non-empty stderr not treated as failure, no `--bare`, no `--permission-mode`. Codex: schema as a file, `-o` read as an independently stat'd and bounded channel, semantic classification only from `turn.failed` / top-level `error` with message-level dedup, nonzero exit with only a stderr warning → `PROCESS_FAILED`, `forced_login_method` absent.
- **Error-parameter safety.** Every constructor path was checked against `PROJECT_PARAMETER_SCHEMAS`, including the two easy traps: `exactVersion`'s `"unrecognized"` sentinel satisfies `safeVersionV1Schema`, and non-`SafeId` models are diverted to `CONFIG_INVALID {model-not-safe-id}` in both routing and `assertRoute` before any `UNSUPPORTED_MODEL`/`CONFIG_MODEL_UNSUPPORTED` construction.
- **Envelope.** `schema_version` is first in the child-visible bytes with the reason documented, `assertPlainJson`-then-`structuredClone` runs before any second read, the closed `exactFields` shells make contamination fields unrepresentable at both type and runtime level, the 1 MiB cap fires before spawn as `CONTRACT_INVALID`, and `dispatch-envelope` is domain-separated against all ten existing digest kinds.
- **Process lifecycle.** Per-channel byte caps, group-scoped SIGTERM→SIGKILL under `detached`, `EPIPE` on stdin ignored, spawn errors mapped locally rather than reaching for `git.ts`'s private classifier, `attempt: 1` everywhere.
- **FIFO.** `serializeDispatch` chains correctly, survives a rejection without poisoning the queue, and preserves rejection identity; leaving it uncalled is Phase 15's inheritance as designed.
- **Mint.** Opposite-family assertion fires, no path mints on failure, and the added `["step","counter_review"]` row in the `observeReview` loop is harmless — `rawReviewSchema`'s refinement already forces `step === "counter_review"` for every non-`self-review` role, so it is redundant rather than wrong. It is still an unsanctioned edit to a frozen contract and should be mentioned in the log alongside finding 3.

## Triage

**Triaged by**: Codex
**Date**: 2026-07-30
**Status**: six findings accepted and resolved; two rejected with workflow/scope reasons. Renewed human verification is required before the implementation log and commit gates.

1. **Finding 1 — accepted and resolved.** `deriveHostIdentity` now matches the exact, case-sensitive recorded client name only. Recorded versions remain fixture evidence; newer versions of `claude-code` and `codex-mcp-client` resolve to their families, while casing, substring, and unknown-name cases remain `unknown`. CLI binary compatibility remains independently guarded by the adapter minimum-version preflight.
2. **Finding 2 — partially accepted and resolved.** The missing explicit per-adapter check was accepted. `resolveDispatchRoute` now validates through a closed adapter-specific effort set and returns `CONFIG_INVALID {issue_code:"effort-unsupported"}` before workspace creation for anything outside it. The review's factual claim that Codex 0.146.0 rejects `max` and `ultra` was rejected after checking the gated source: its reasoning-effort parser explicitly recognizes `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, so all six durable `EFFORT_VALUES` remain valid on the Codex arm. Tests cover every accepted Codex value and an out-of-vocabulary runtime input.
3. **Finding 3 — accepted and resolved.** The public minter was removed from `src/contracts/trust.ts` and therefore from the `src/contracts/index.ts` barrel. Exactly one `createReviewObservationCapability` remains under `src/contracts/internal/test-capabilities.ts`; `src/dispatch/cli.ts` imports that sole internal minter. The phase design and architecture now record that preserving the non-public trust boundary deliberately overrides the weaker “dispatch never imports internal” convention. A test proves the public barrel cannot mint while production dispatch still can.
4. **Finding 4 — accepted and resolved within the frozen contract.** Only `ENOENT` now means a managed-policy path is absent; `EACCES` and every other stat failure disclose the configured path as present. The Phase 2-frozen observation binding and server-attested review have no managed-policy field, so the phase design and architecture now state the actual seam: `CliPreflight` returns conservative telemetry for Phase 15 to persist with the dispatch attempt. Phase 13 does not silently widen the durable review contract or falsely claim the telemetry is already inside it.
5. **Finding 5 — rejected as premature at this review gate.** `archflow-phase-impl` requires the implementation log only after the human accepts verification; the phase is intentionally still `IN PROGRESS`. Before any commit gate, the required log will record that macOS Keychain/generated-`HOME` behavior was not testable on this WSL2/Linux host and remains unresolved, and that `codex features list` 0.146.0 exposes no `view_image` feature/disable target, so the conditional flag was not added. Creating the completion log before renewed human approval would violate the workflow ordering rather than fix it.
6. **Finding 6 — rejected as unrelated user-owned state.** `AGENTS.md` was supplied by the user and was already untracked before Phase 13 implementation began. It was never created or modified by this phase and remains excluded from the phase's staging set. Whether the repository later adopts it is a separate user decision.
7. **Finding 7 — accepted and resolved.** `cliAdapterForId` was deleted. Tests and production-facing code now reach the two adapters only through `selectCliAdapter(host, options)`, preserving immutable host identity, opposite-family selection, and the single `allow_claude_dispatch` gate.
8. **Finding 8 — accepted and resolved.** Workspace creation now creates only the selected credential directory/link. A Claude generated home begins with only `.claude`; a Codex generated home begins with only `.codex`. The exact environment allowlist still includes `CODEX_HOME` for both, with the Claude path left nonexistent unless the child itself creates it.
