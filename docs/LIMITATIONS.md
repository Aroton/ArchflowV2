# LIMITATIONS

**Explored:** 2026-08-12 · **Commit:** `247df34` · **Covers:** `src/dispatch/`, `src/review/`, `src/init/diagnostics.ts`, `src/mcp/`, `src/state/`

ArchFlow is a local developer-workflow prototype, not a security sandbox. The controls below reduce accidental context leakage and constrain ordinary operation, but the listed cases are unsupported because the current implementation cannot prove the claimed boundary. A planted canary not appearing in output is evidence about that run; it is not proof that the child could not read the canary.

These limitations assume a trusted developer account and a filesystem not being changed by a malicious local process. They are acceptable for the prototype's current operating envelope because ArchFlow runs locally for that developer, model output is validated before it becomes evidence, and advancement and approval remain subject to the workflow's durable evidence and human gates. They would not be acceptable as claims of isolation from hostile code, another process running as the same user, or a malicious local user.

## Generative review judgment

**Not deterministic:** A review envelope and its attestation are byte-reproducible, but a fresh Claude or Codex invocation is not guaranteed to return the same findings or verdict for those bytes. Model aliases, provider behavior, managed context, and the model's own search path can change which defect it notices.

**Existing mitigation:** Initial rubrics ask only for defects with a concrete material downstream consequence. When prior triage exists, the sealed instruction makes verification of accepted revision intents the primary task and admits a previously undiscovered issue only when it clears the same materiality bar. Prior-triage now carries the original evidence and suggested resolution together with the producer rationale and revision intent. Non-material suggestions are suppressed rather than deferred to human approval, while the attempt budget and durable human gates remain backstops.

**Why accepted:** The product needs independent semantic judgment, not identical prose from repeated model calls. ArchFlow claims deterministic inputs, provenance, evidence currency, state transitions, and approval authority; it does not claim deterministic model judgment.

## Adversarial stdio peers at the JSON-RPC layer

**Not protected:** The MCP server's JSON-RPC layer trusts the pinned MCP SDK and the local host process on the other end of stdio. It does not defend against an adversarial stdio peer: duplicate or pathological request IDs are served as the SDK serves them (both responses carry the same ID; there is no duplicate-ID ledger or cap), malformed envelopes — null or fractional IDs, extra top-level members, non-object `_meta` — are dropped silently with no wire response, and wire-schema violations such as non-object `tools/call` arguments are answered with the SDK's own validator prose rather than a canonicalized message. SDK error prose can therefore reach the wire.

**Existing mitigation:** Both SDK packages are pinned to exact version 2.0.0 and every retired defense is replaced by a behavioral pin in `scripts/probe-mcp-sdk-compatibility.mjs`, so an SDK behavior change fails the gate instead of shipping silently. SDK imports are fenced into `src/mcp/sdk-adapter.ts` (`check:mcp-sdk-boundary`). The framer still enforces newline framing, a 10 MiB cap, and the fatal malformed-UTF-8 split; the send queue still bounds and orders all output; the adapter still rejects repeated initialization (`-32004`) and enforces result-xor-error at the single egress point. ArchFlow's own validation begins unweakened at the tool boundary: `assertPlainJson` on every input, schema and digest rechecks, and WeakSet-branded outcomes — a `tools/call` without an authentic branded outcome answers a prose-free `-32603`.

**Why accepted:** The only intended stdio peer is the developer's own host CLI on a trusted machine — the same trusted developer account/machine stance the rest of this page assumes. The retired second JSON-RPC state machine (`session.ts`, 554 lines) validated nearly every message twice to defend against a peer the prototype does not claim to withstand; the pinned-and-probed SDK is the honest authority for that layer, and the human trust boundaries live in durable state and gates, not in wire canonicalization.

## Child repository reads

**Not protected:** A dispatched Claude or Codex process is not prevented by the operating system from locating and reading the repository. Running it from a temporary directory outside the repository and omitting repository content from the review envelope do not revoke the child process's filesystem permissions.

**Existing mitigation:** Dispatch uses a non-repository temporary working directory, a generated home, an explicit environment allowlist, and CLI flags intended to suppress project instructions, user configuration, skills, and tools. The envelope is versioned, size-bounded, hashed, and structurally limited to the declared review inputs. Planted-canary scans detect values that reach child output or persisted diagnostics, including a leaking negative control that proves the scanner works.

**Why accepted:** ArchFlow is currently operated by a developer on their own trusted workstation, and the immediate goal is independent review context rather than hostile-code confinement. The product therefore treats repository non-discovery as best-effort hygiene and does not claim that repository canaries are unreadable.

## Real home and other-family credentials

**Not protected:** A child process is not OS-blocked from reading the developer's real home directory or the credential store for the other CLI family if it discovers their paths and the developer account can read them. The generated `$HOME` changes normal discovery; it does not change the process's user identity or filesystem permissions.

**Existing mitigation:** The generated home contains a symlink to only the selected CLI's first-party credential file. ArchFlow does not read or copy that credential value. The child environment drops API keys, provider-routing variables, and unrelated environment values, and dispatches are serialized so the two CLI families do not race shared credential stores. Canary scans check that planted credential and routing values are not emitted or retained in diagnostics.

**Why accepted:** Using the selected first-party CLI's existing subscription session is an explicit feature of this local tool. The prototype assumes the developer controls the account and machine; it does not offer credential isolation against a child running as that same account. Absence from output is the supported assurance, not proof of unreadability.

## Managed-context containment

**Not protected:** ArchFlow cannot suppress or fully enumerate every system-managed or server-delivered context layer. Managed settings, managed hooks, an `apiKeyHelper`, or an enterprise-managed Codex bundle may affect a child even when repository and user configuration are suppressed. In particular, Claude managed hooks can execute independently of model tools.

**Existing mitigation:** Preflight records discoverable managed-policy paths; when a dispatch fails, that observation is persisted in ignored, current-phase `.archflow/runtime/tasks/<task>/diagnostics/attempts/` (successful dispatches persist no attempt telemetry — their evidence is the authoritative result). Explicit CLI flags suppress the ordinary project, user, MCP, session, rule, and skill sources that the supported versions expose. Initialization reports the best-effort isolation limitation rather than treating a clean preflight as proof.

**Why accepted:** Managed configuration is part of the developer's administratively controlled machine, not an untrusted multi-tenant boundary in the prototype's operating envelope. Its presence remains visible for diagnosis, while validated outputs and durable workflow gates prevent managed context alone from becoming approval authority.

## Codex tool-surface emptiness

**Not protected:** ArchFlow cannot prove that a dispatched Codex process has an empty model-visible tool surface. Codex has no disable-all-tools flag or command that reports the effective `tools[]` for an invocation; its prompt-input debugger shows messages only. The current suppression list is a denylist against a tool and feature registry that can change between CLI versions, and `-s read-only` constrains generated shell commands rather than the Codex parent process's read access.

**Existing mitigation:** ArchFlow requires a minimum tested CLI version, uses strict configuration, disables every known relevant feature, supplies a generated `CODEX_HOME`, ignores user configuration and rules, disables project instructions and skill content, skips repository discovery, and requests read-only command behavior. The exact invocation is covered by fixtures, and model output must satisfy the strict result schema before it can become evidence.

**Why accepted:** The prototype prioritizes useful opposite-family review on a trusted developer machine and accepts that suppression can reduce unwanted context without proving an empty capability set. It makes no stronger tool-isolation claim; a future support claim would require an inspectable allowlist or OS containment.

## No `SandboxProvider` or OS containment

**Not protected:** ArchFlow has no `SandboxProvider`, filesystem namespace, credential boundary, network boundary, or OS-enforced process containment around review children. Generated directories, scrubbed environment variables, CLI flags, and output scanning are context-hygiene controls, not a sandbox. Dispatch does not fail closed merely because isolation cannot be proved.

**Existing mitigation:** Children run without a shell, with explicit arguments, bounded input and output, timeout and cancellation, a temporary working directory, a generated home, and a narrow environment. Process-group termination covers descendants that remain in the adopted group. Candidate sandbox and process-tree packages were evaluated and rejected because they did not provide the needed portable guarantee within the prototype's dependency, platform, and licensing constraints.

**Why accepted:** Adding a partially effective sandbox would create a misleading security claim and substantial platform machinery without meeting the approved requirement. The local prototype instead states the trusted-machine assumption plainly. This acceptance does not satisfy the architecture's future release criterion for a currently proven and acceptably licensed sandbox/OS combination.

## `openResolved` check-to-use window

**Not protected:** Repository path containment is checked before the eventual filesystem open. A path component can change between `realpath` validation and use, and the branded resolved path records the earlier check rather than a standing containment guarantee. Node.js 24 does not expose the directory-relative `openat`/`RESOLVE_BENEATH`-style primitive needed to make resolution and open one contained operation. `O_NOFOLLOW` protects the final symlink where available, but does not close every intermediate-component race and is unavailable on Windows.

**Existing mitigation:** Inputs reject absolute, drive/UNC, traversal, cross-task, and symlink-escape paths; containment is checked on normalized real paths and every sanctioned open adds `O_NOFOLLOW` where the platform provides it. Tests preserve the window as an explicit limitation and verify that the final-leaf symlink defense works on the supported Linux test environment.

**Why accepted:** The prototype assumes its task filesystem is not being adversarially rewritten by another same-user process during an operation. The checks reliably reject ordinary malformed and pre-existing escape paths. Closing the race would require a different native/runtime filesystem capability and is outside the current local-developer scope.

## Descendants that escape the process group

**Not protected:** On non-Windows systems ArchFlow terminates the detached child's process group, but a descendant that calls `setsid()` leaves that group. Cancellation, timeout, or server shutdown therefore cannot guarantee termination of that escaped descendant. The bounded Phase 20 observation confirmed the operating-system behavior; it is recorded here instead of kept as a permanent test that could not be fixed by an ArchFlow code change.

**Existing mitigation:** Children are launched without a shell and with an adopted process group. Cancellation and server shutdown have lifecycle tests proving that the direct child and a grandchild that remains in the group are reaped. Server shutdown currently resolves before that reaping completes, so callers cannot treat `close()` completion as proof that the process group is already gone. These tests exercise ordinary SIGTERM termination, not the later SIGKILL escalation. A cancelled or failed dispatch cannot produce pass evidence or approval.

**Why accepted:** Supported first-party CLI processes are expected to keep their ordinary descendants in the adopted group, and the prototype runs under the developer's account on a trusted machine. ArchFlow claims best-effort termination for that ordinary tree, not containment of deliberately detached processes. Stronger coverage requires an OS process namespace, cgroup/job-object equivalent, or another proven containment provider.
