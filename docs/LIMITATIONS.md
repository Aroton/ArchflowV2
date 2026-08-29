# LIMITATIONS

**Explored:** 2026-08-27 · **Commit:** `1b2602e` · **Covers:** `src/dispatch/`, `src/review/`, `src/init/diagnostics.ts`, `src/mcp/`, `src/state/`, `src/contracts/config.ts`, `src/contracts/dispatch-failure.ts`, `skills/archflow-prd/`, `skills/archflow-design/`, `skills/archflow-phase-design/`, `skills/archflow-phase-impl/`

ArchFlow is a local developer-workflow prototype, not a security sandbox. The controls below reduce accidental context leakage and constrain ordinary operation, but the listed cases are unsupported because the current implementation cannot prove the claimed boundary. A planted canary not appearing in output is evidence about that run; it is not proof that the child could not read the canary.

These limitations assume a trusted developer account and a filesystem not being changed by a malicious local process. They are acceptable for the prototype's current operating envelope because ArchFlow runs locally for that developer, model output is validated before it becomes evidence, and advancement and approval remain subject to the workflow's durable evidence and human gates. They would not be acceptable as claims of isolation from hostile code, another process running as the same user, or a malicious local user.

## Multi-repository writes are coordinated, not atomic

**Not protected:** A phase that changes several writable repositories is installed, restored, and committed as a sequence, not as one transaction. ArchFlow prevalidates every changed member, applies primary then ordinal secondaries, and rolls back in reverse after an ordinary failure, but a process or machine crash can interrupt that sequence and leave some members applied. Commit authorization is likewise one human decision or authenticated settlement but several Git commits, one per repository.

**Existing mitigation:** Every member is validated before any write, and rollback runs in reverse order on ordinary failure. Commit proof is repository-local and race-closed: a successful earlier commit is preserved, and status resumes at the first repository without proof rather than repeating or undoing one that already landed. Every adopted, restored, or committed path stays bound to its `(repository, path)` tuple, so identical relative paths in different members cannot collide.

**Why accepted:** The repositories are ordinary sibling Git checkouts on one developer's machine; there is no shared transaction primitive to build on, and inventing one would be a large subsystem for a rare interruption. A paused sequence is visible in status and recoverable by repairing the named repository and continuing, which is proportional for the prototype.

## Generative review judgment

**Not deterministic:** A review envelope and its attestation are byte-reproducible, but a fresh Claude or Codex invocation is not guaranteed to return the same findings or verdict for those bytes. Model aliases, provider behavior, managed context, and the model's own search path can change which defect it notices.

**Existing mitigation:** Initial rubrics ask only for defects with a concrete material downstream consequence, and every review child receives one fixed framing literal telling it to read everything, trace each stated commitment into the sections that depend on it, recompute derived figures, and verify against the repository view before applying that bar. When prior triage exists, the sealed instruction gives the round two tasks of equal weight — verify accepted revision intents and review the revised and dependent sections as an initial review would — with new issues held to the same materiality bar. Prior-triage now carries the original evidence and suggested resolution together with the producer rationale and revision intent. Non-material suggestions are suppressed rather than deferred to human approval, while the attempt budget and durable human gates remain backstops.

**Why accepted:** The product needs independent semantic judgment, not identical prose from repeated model calls. ArchFlow claims deterministic inputs, provenance, evidence currency, state transitions, and approval authority; it does not claim deterministic model judgment.

## Live-read rubric files can strand an in-flight task

**Not protected:** The counter-review rubrics are read fresh from the installed bundle on every review and status call, like task config. A rubric edit (or a bundle reinstall carrying one) between two steps of an in-flight task changes the rubric digest, which folds into the task's input fingerprints, so the task's next review-cycle step fails closed with `INPUT_FINGERPRINT_MISMATCH` until a fresh intent is composed or the previous bytes are restored.

**Existing mitigation:** A missing or invalid file fails closed with `CONFIG_INVALID` naming the file — there is no silent fallback to a previous rubric. The shipped files' exact digests are pinned by test, so an unintended byte change cannot ship unnoticed. `assets/rubrics/README.md` documents the discipline: edit rubrics between tasks.

**Why accepted:** Rubrics are server review policy, deliberately live-editable without a rebuild — the same posture as task config, which reports edits informationally rather than blocking. Fail-closed fingerprint churn is the honest behavior when review policy changes under an open task; an operator who edits mid-task is changing the rules the task is judged by, and the workflow says so loudly instead of quietly mixing policies across rounds.

## Phase sizing is judgment, not calculation

**Not deterministic:** ArchFlow cannot calculate a uniquely correct phase boundary. Whether work forms one coherent repository-ready outcome depends on the product, architecture, predecessor stability, meaningful completion states, and the verification story. File counts, repository layers, work-chunk counts, token estimates, and phase-count targets cannot settle that question.

**Existing mitigation:** Architecture design makes explicit split and merge checks against one default: a phase has one primary outcome, a valid completion state, stable predecessor inputs, and one understandable verification story. Broad, small, and genuinely open-ended plans must explain their concrete exception value. Numbered phase design repeats one bounded fit check, and counter-review raises only materially harmful boundary defects rather than enforcing stylistic or numeric preferences.

**Why accepted:** Coherent outcome checkpoints make review, recovery, verification, and later work easier to reason about, but turning that guidance into a scoring engine would create false precision and invite gaming. Human and reviewer judgment, constrained by material consequences and durable approval, is the honest control for this prototype.

## Adversarial stdio peers at the JSON-RPC layer

**Not protected:** The MCP server's JSON-RPC layer trusts the pinned MCP SDK and the local host process on the other end of stdio. It does not defend against an adversarial stdio peer: duplicate or pathological request IDs are served as the SDK serves them (both responses carry the same ID; there is no duplicate-ID ledger or cap), malformed envelopes — null or fractional IDs, extra top-level members, non-object `_meta` — are dropped silently with no wire response, and wire-schema violations such as non-object `tools/call` arguments are answered with the SDK's own validator prose rather than a canonicalized message. SDK error prose can therefore reach the wire.

**Existing mitigation:** Both SDK packages are pinned to exact version 2.0.0 and every retired defense is replaced by a behavioral pin in `scripts/probe-mcp-sdk-compatibility.mjs`, so an SDK behavior change fails the gate instead of shipping silently. SDK imports are fenced into `src/mcp/sdk-adapter.ts` (`check:mcp-sdk-boundary`). The framer still enforces newline framing, a 10 MiB cap, and the fatal malformed-UTF-8 split; the send queue still bounds and orders all output; the adapter still rejects repeated initialization (`-32004`) and enforces result-xor-error at the single egress point. ArchFlow's own validation begins unweakened at the tool boundary: `assertPlainJson` on every input, schema and digest rechecks, and WeakSet-branded outcomes — a `tools/call` without an authentic branded outcome answers a prose-free `-32603`.

**Why accepted:** The only intended stdio peer is the developer's own host CLI on a trusted machine — the same trusted developer account/machine stance the rest of this page assumes. The retired second JSON-RPC state machine (`session.ts`, 554 lines) validated nearly every message twice to defend against a peer the prototype does not claim to withstand; the pinned-and-probed SDK is the honest authority for that layer, and the human trust boundaries live in durable state and gates, not in wire canonicalization.

## Child repository reads

**Not protected:** A dispatched Claude or Codex process is not prevented by the operating system from locating and reading the repository. Running it from a temporary directory outside the repository and omitting repository content from the review envelope do not revoke the child process's filesystem permissions. Every configured repository is copied into a named, commit-pinned review snapshot with secondary `.archflow/` content removed, and changed writable members are reconstructed at their retained proposed trees; this improves relevance and keeps task state out of the intended view, but it remains best-effort context hygiene, and the child may still read outside its cwd.

**Existing mitigation:** Dispatch uses a non-repository temporary working directory, an explicit environment allowlist, and CLI flags intended to suppress project instructions, user configuration, skills, and tools. Authentication remains in the caller's canonical CLI home and is not treated as an instruction-isolation mechanism. The envelope is versioned, size-bounded, hashed, and structurally limited to the declared review inputs. Planted-canary scans detect values that reach child output or persisted diagnostics, including a leaking negative control that proves the scanner works.

**Why accepted:** ArchFlow is currently operated by a developer on their own trusted workstation, and the immediate goal is independent review context rather than hostile-code confinement. The product therefore treats repository non-discovery as best-effort hygiene and does not claim that repository canaries are unreadable.

## Canonical home and credentials

**Not protected:** A child receives the developer's canonical `HOME` and is not OS-blocked from reading that home or either CLI family's credential store. ArchFlow runs under the same developer identity and does not claim a credential boundary against the selected first-party client.

**Existing mitigation:** ArchFlow neither reads nor projects credential values. It passes canonical authentication-location variables, drops API keys, provider-routing variables, and unrelated environment values, and pins each CLI's configuration/instruction suppression flags. Canary scans check that planted credential and routing values are not emitted or retained in diagnostics. The process-wide review queue bounds load only; first-party clients own credential refresh and concurrency.

**Why accepted:** Using the selected first-party CLI's existing subscription session is an explicit feature of this local tool. Authentication is mutable: OAuth refresh commonly replaces the credential file atomically. A disposable symlink or copy can capture the replacement in temporary storage and delete the only fresh refresh token, leaving the canonical store logged out. Keeping authentication canonical matches ordinary interactive CLI behavior and avoids ArchFlow becoming a broken credential manager. The prototype assumes the developer controls the account and machine; absence from output is the supported assurance, not proof of unreadability.

## Managed-context containment

**Not protected:** ArchFlow cannot suppress or fully enumerate every system-managed or server-delivered context layer. Managed settings, managed hooks, an `apiKeyHelper`, or an enterprise-managed Codex bundle may affect a child even when repository and user configuration are suppressed. In particular, Claude managed hooks can execute independently of model tools.

**Existing mitigation:** Preflight records discoverable managed-policy paths; when a dispatch fails, that observation is persisted in ignored, current-phase `.archflow/runtime/tasks/<task>/diagnostics/attempts/` (successful dispatches persist no attempt telemetry — their evidence is the authoritative result). Explicit CLI flags suppress the ordinary project, user, MCP, session, rule, and skill sources that the supported versions expose. Initialization reports the best-effort isolation limitation rather than treating a clean preflight as proof.

**Why accepted:** Managed configuration is part of the developer's administratively controlled machine, not an untrusted multi-tenant boundary in the prototype's operating envelope. Its presence remains visible for diagnosis, while validated outputs and durable workflow gates prevent managed context alone from becoming approval authority.

## Codex tool-surface emptiness

**Not protected:** ArchFlow cannot prove that a dispatched Codex process has an empty model-visible tool surface. Codex has no disable-all-tools flag or command that reports the effective `tools[]` for an invocation; its prompt-input debugger shows messages only. The current suppression list is a denylist against a tool and feature registry that can change between CLI versions, and `-s read-only` constrains generated shell commands rather than the Codex parent process's read access.

**Existing mitigation:** ArchFlow requires a minimum tested CLI version, uses strict configuration, disables every known relevant feature, supplies the canonical `CODEX_HOME` for authentication, ignores user configuration and rules, disables project instructions and skill content, skips repository discovery, and requests read-only command behavior. The exact invocation is covered by fixtures, and model output must satisfy the strict result schema before it can become evidence.

**Why accepted:** The prototype prioritizes useful opposite-family review on a trusted developer machine and accepts that suppression can reduce unwanted context without proving an empty capability set. It makes no stronger tool-isolation claim; a future support claim would require an inspectable allowlist or OS containment.

## No `SandboxProvider` or OS containment

**Not protected:** ArchFlow has no `SandboxProvider`, filesystem namespace, credential boundary, network boundary, or OS-enforced process containment around review children. Generated directories, scrubbed environment variables, CLI flags, and output scanning are context-hygiene controls, not a sandbox. Dispatch does not fail closed merely because isolation cannot be proved.

**Existing mitigation:** Children run without a shell, with explicit arguments, bounded input and output, timeout and cancellation, a temporary working directory, canonical authentication paths, and a narrow environment. Process-group termination covers descendants that remain in the adopted group. Candidate sandbox and process-tree packages were evaluated and rejected because they did not provide the needed portable guarantee within the prototype's dependency, platform, and licensing constraints.

**Why accepted:** Adding a partially effective sandbox would create a misleading security claim and substantial platform machinery without meeting the approved requirement. The local prototype instead states the trusted-machine assumption plainly. This acceptance does not satisfy the architecture's future release criterion for a currently proven and acceptably licensed sandbox/OS combination.

## `openResolved` check-to-use window

**Not protected:** Repository path containment is checked before the eventual filesystem open. A path component can change between `realpath` validation and use, and the branded resolved path records the earlier check rather than a standing containment guarantee. Node.js 24 does not expose the directory-relative `openat`/`RESOLVE_BENEATH`-style primitive needed to make resolution and open one contained operation. `O_NOFOLLOW` protects the final symlink where available, but does not close every intermediate-component race and is unavailable on Windows.

**Existing mitigation:** Inputs reject absolute, drive/UNC, traversal, cross-task, and symlink-escape paths; containment is checked on normalized real paths and every sanctioned open adds `O_NOFOLLOW` where the platform provides it. Tests preserve the window as an explicit limitation and verify that the final-leaf symlink defense works on the supported Linux test environment.

**Why accepted:** The prototype assumes its task filesystem is not being adversarially rewritten by another same-user process during an operation. The checks reliably reject ordinary malformed and pre-existing escape paths. Closing the race would require a different native/runtime filesystem capability and is outside the current local-developer scope.

## Descendants that escape the process group

**Not protected:** On non-Windows systems ArchFlow terminates the detached child's process group, but a descendant that calls `setsid()` leaves that group. Cancellation, timeout, or server shutdown therefore cannot guarantee termination of that escaped descendant. The bounded Phase 20 observation confirmed the operating-system behavior; it is recorded here instead of kept as a permanent test that could not be fixed by an ArchFlow code change.

**Existing mitigation:** Children are launched without a shell and with an adopted process group. Cancellation and server shutdown have lifecycle tests proving that the direct child and a grandchild that remains in the group are reaped. Server shutdown currently resolves before that reaping completes, so callers cannot treat `close()` completion as proof that the process group is already gone. These tests exercise ordinary SIGTERM termination, not the later SIGKILL escalation. A cancelled or failed dispatch cannot produce pass evidence or approval.

**Why accepted:** Supported first-party CLI processes are expected to keep their ordinary descendants in the adopted group, and the prototype runs under the developer's account on a trusted machine. ArchFlow claims best-effort termination for that ordinary tree, not containment of deliberately detached processes. Stronger coverage requires an OS process namespace, cgroup/job-object equivalent, or another proven containment provider.

## Reviewer route declarations are provenance, not independent authorization

**Not provided:** A route carried through a producer skill invocation is not independently authenticated as coming from an external controller or human. The connected model constructs the semantic invocation, so `invocation-declared` says exactly how the server received the route, not who originated the prompt or CLI argument that led to it.

**Existing mitigation:** Fresh evidence attests the actual adapter, family, model, effort, optional provider, and route source, plus any raw configured route displaced by invocation selection. A controller that needs assurance compares those retained facts with the route it supplied. Invalid or unavailable invocation routing fails visibly and never falls back silently. Invocation route bytes bind every semantic offer/operation and counter-review request in the run, so drift between status and apply is rejected.

**Why accepted:** ArchFlow has no server-observable authenticated controller channel in this phase. Honest provenance supports automation without claiming an authority boundary that does not exist; adding controller authentication would be a separate product and trust design.

## Same-family and low-effort reviewer routes are legal, and only visible

**Not enforced:** Nothing stops a repository from routing a general or test reviewer to the producer's own model family, or to a low effort. The shipped template routes general reviewers across families and selects Luna/max for test review, but an older or edited task can choose otherwise; "opposite-family by default" describes the template rather than a check. Merged evidence retains legacy primary provenance for compatibility and also records every fresh contributor, assignment, route, effort, and owned finding. `review_strength` exposes both the primary scalar and the complete contributor list; archived evidence without that list is explicitly synthesized as one legacy general reviewer.

**Existing mitigation:** Every fresh review records the actual producer and every reviewer family, model, effort, focus, assignment, and finding count. The semantic view projects per-contributor `same_family` flags, the attempt number, remediation status, and per-round finding and acceptance counts. Skills present those facts at every human gate with the same prominence as an exceptional reason. A same-family or low-effort contribution is therefore visible when a human relies on it.

**Why accepted:** A same-family or low-effort reviewer is a legitimate operator choice — outages, cost, or a family that is simply better at the domain — and the research this design rests on says the generation–verification gap narrows when the same family writes and reviews, not that it closes. Making the choice visible at the gate preserves the human's judgment; enforcing a family rule would recreate the outage dead end the route override exists to avoid.

## Third-party interface claims are unverifiable outside the snapshot

**Not provided:** A document reviewer sees the repository at HEAD without dependency sources: `git archive` carries no `node_modules/`, `target/`, or cargo registry, the child has no shell or network, and a crate or package the design proposes to *adopt* is not in the lockfile yet. A claim about a third-party API's signature or semantics can be checked only against what the artifact itself states.

**Existing mitigation:** The rubric routes such gaps to the non-blocking `unverifiable-claims` criterion, which triage must reject with an `envelope-gap:` rationale so the gap is recorded rather than guessed at. Design skills instruct the producer to cite version-pinned documentation or source lines for load-bearing third-party claims, which lets the reviewer at least check the design against its own citation, and the framing literal directs it to trace the stated signature through the inputs the system will meet — a decoder declared to take valid text is still reviewable for what it does with invalid bytes.

**Why accepted:** Materializing dependency sources into the sealed view is a transport and provenance problem of its own, and the claim most often at stake is the design's, not the library's. Recording the gap honestly is proportional for a prototype; a later change can pin vendored sources when a task actually needs them.

## The dispatch timeout is fixed, and a high-effort review of a large design can exceed it

**Not adaptive:** Every reviewer child gets the same 15-minute `DISPATCH_TIMEOUT_MS` regardless of artifact size, effort, or whether a repository view was materialized. On 2026-08-28 a replay of a 74 KB design with its 26 KB PRD pinned and a repository view, routed to `gpt-5.6-sol` at `xhigh`, was killed at the timeout with no output; the same envelope at `gpt-5.6-sol`/`high` (the template's route for a Claude producer) returned eight blockers in seven minutes, and `claude-opus-5`/`medium` returned in six and a half. The template now routes `gpt-5.6-sol` at `medium` for exactly that reason: at `high` the reviewer kept finding real-but-endless issues on every remediation round of a large design, and the loop never converged.

**Existing mitigation:** The timeout surfaces as a classified `TIMEOUT` dispatch failure with the role and route, the review attempt stays pending rather than being consumed, and the skill offers repair or a one-dispatch human `route_override` (for example the same model at `high`). Nothing is silently downgraded.

**Why accepted:** A per-size or per-effort budget would be a guess dressed as policy, and an unbounded child is worse than a visible failure. The honest control for now is the visible failure plus the human's substitute route; the design skills' guidance to keep artifacts to what a reviewer can recompute also keeps them inside the budget.

## A reviewer route override is not proof a human chose it

**Not provided:** Nothing in the request pipeline distinguishes a substitute reviewer the human asked for from one the agent picked to get past a failed dispatch. `route_override` carries a free-text `reason`, and the server validates the *route* it names exactly as it validates a pinned one — but it never validates the *authorization*. The skills instruct the agent to report an outage and ask rather than substitute on its own, and that instruction is the only thing enforcing it.

**Existing mitigation:** The override is covered by the request digest, so it cannot be added to a composed request without invalidating it, and it is recorded separately from normal route source with the human-supplied reason, actual provider when present, configured-route facts, and normally selected invocation/config route it displaced. That provenance remains auditable and is shown in plain language whenever a later human presentation opens. Under targeted approval rules an eligible `wait:false` path may have no later human gate, so the override can remain evidence-only rather than being surfaced to a person during that run.

**Why accepted:** Reviewer routing is policy, not a trust boundary — families are recorded rather than enforced, and a same-family reviewer is already a legal config choice, so a substitute is the same kind of decision made later. Enforcing authorization would mean a human gate in front of the review, which costs more than the risk for this prototype. The current guarantee is authenticated provenance, not proof of human selection or eventual human visibility.

## Dispatch-failure observations are disposable

**Not provided:** The compact failure projected by status is not durable authority and is not proof that an outage remains current after it was observed. It is an ignored latest-failure runtime interface; a fresh clone or cleanup may lose it, and the same revision can retain it after an operator repairs credentials until review is retried.

**Existing mitigation:** The record is strict and safe: supported classified codes, bounded server-authored prose, role, and optional route/source only. Status reads exactly the deterministic current-attempt path and projects it only when task, phase instance, running step, attempt, and state revision match. No raw exception, path, credential, stdout/stderr tail, transition, attempt consumption, evidence, or authority enters the observation. The original failure remains the operation result.

**Why accepted:** Its purpose is to help the owning interactive skill explain a reviewer outage without parsing forensic files. Durable state already preserves the pending review and safe retry boundary, so making this convenience record authoritative would add complexity and make runtime loss capable of stranding workflow progress.

## Retained review-round outputs are an ignored cache

**Not provided:** When one child of a review round fails, the validated outputs of its siblings are kept as ignored runtime files so the retry re-dispatches only what failed. Those files are not durable authority: a fresh clone, a cleanup, or a server restart on another machine loses them, and the retry then simply runs every child again.

**Existing mitigation:** A record is reused only for the exact envelope digest the server just recomputed from durable authority, the same role, route, and route provenance, and only when its bytes still hash to the recorded digest and pass the same output validation and binding checks a fresh dispatch must pass. Reuse then goes through the ordinary currency re-check and atomic commit. Records are deleted when the round commits and swept with the phase otherwise.

**Contributor record:** Fresh merged evidence records every rubric contributor's stable reviewer ID, focus, routing role, ordered criterion IDs, rubric and envelope digests, model/effort/adapter/CLI provenance, route source or override, and exact owned finding IDs. The top-level findings must be partitioned by those runs. Archived evidence predating this shape remains readable and is presented as one legacy general reviewer; its missing sibling detail cannot be reconstructed retroactively.

**Why accepted:** The cache lives under the same same-user filesystem assumption as every other runtime file (see "Task filesystem races are not adversarially hardened" above): a process that can rewrite it can equally replace the reviewer CLI on `PATH`. Making retained outputs authoritative would add durable-state machinery to save one re-dispatch, and the records never change state, consume an attempt, or authorize anything on their own.

## Trusted live config edits can weaken policy

**Not protected:** Task-local config is mutable throughout a task. A developer or agent with write access can lower review effort, change routes, or remove an approval rule before a later settlement. The server reports field-level changes and records dispatch provenance and settlement config digests, but it does not require a separate authorization for the edit or interpret whether the new policy is weaker.

**Existing mitigation:** Every config-observing transaction parses the complete strict shape, records it in `last_seen_config`, and status reports later changes without invalidating already-authenticated review evidence or retroactively changing a settled conclusion. Unknown fields fail closed instead of silently disappearing. Per-dispatch provenance records what actually ran, and settlements bind the exact config digest they evaluated.

**Why accepted:** ArchFlow's prototype operating model already trusts the developer account and repository writers. Making config edits visible and binding each resulting action is proportional; a full policy-amendment authorization system would recreate the lock-in this feature removes.

## Editable config is not schema migration

**Not provided:** Making the task-local config live and editable does not make older or future config shapes migratable. Every config-observing transaction and dispatch still parses the complete current strict schema; unknown fields, unsupported values, malformed YAML, and otherwise incompatible shapes fail closed. The retired `roles.producer` key is one narrow read-compatibility allowance for configs created before the connected host became the producer. Nothing consumes that key, and its acceptance is not a general unknown-field or version fallback.

**Existing mitigation:** A valid edit becomes the normalized `last_seen_config` snapshot and later field-level changes are informational. An invalid edit cannot dispatch review or advance state, and status reports repair guidance without pretending that read-only degraded mode can repair the bytes.

**Why accepted:** Automatic schema migration would need explicit version transforms, ownership of rewritten bytes, and review of policy-changing defaults. The prototype instead keeps one current strict authority and fails visibly when a human must update an incompatible config.

## Content approval triggers are path heuristics

**Not provided:** Content triggers do not inspect file bytes, language semantics, embedded SQL, generated effects, or dependency impact. They examine only the paths a result changed: those declared by a `phase-impl` implementation output, and the task's governing documents (`design.md`, `prd.md`) a phase design or implementation rewrote, judged against the newest earlier retained projection of that document. Matching is case-sensitive over the whole repository-relative slash-separated path: `*` and `?` stay inside one segment, while `**` is recursive only as a complete segment. Path naming can therefore under-match semantically relevant work or over-match unrelated work.

**Existing mitigation:** Subject triggers can require approval for the whole `phase-impl` subject independently of content paths. When a content rule does match, the settlement freezes the complete sorted path set; a later presentation reconstructs operations and signed byte deltas from those paths and retained outputs without re-evaluating mutable config.

**Known edge:** "rewrote" is measured against retained authority, not the worktree. After a human `baseline-adoption` of `design.md` bytes, the newest retained projection is still the pre-adoption one, so the next phase design reports the document as changed and the shipped governing-document rule gates it once more.

**Why accepted:** Path globs are understandable repository policy and sufficient for representative triggers such as migration-file locations. Semantic inspection would introduce a language-specific policy engine whose complexity is disproportionate to this prototype.

## Legacy fingerprint compatibility is one bounded read retry

**Not provided:** The compatibility reader does not migrate arbitrary in-flight state or accept approximately matching evidence. It runs only when a caller supplies an exact expected pre-cutover fingerprint that the current composition does not reproduce, and it can succeed only by recomputing the retired composition with that same task state's creation-time `config_digest` provenance.

**Existing mitigation:** The resolver computes the current fingerprint first, then makes one read-side legacy comparison. A mismatch under both compositions remains a mismatch. Success returns the already expected legacy digest for that read; it rewrites no state, evidence, subject, config, or retained result.

**Why accepted:** This preserves narrowly identifiable work created before config left the fingerprint without turning compatibility into a migration subsystem or weakening exact digest authentication.

## Memoized repository binding in a long-lived server

**Not protected:** The MCP server memoizes worktree discovery and Git preflight per working directory for its process lifetime. If a repository is deleted and re-created at the same path while the server is running, later calls keep the stale worktree binding: a different repository surfaces as `REPOSITORY_MISMATCH` and a removed one as `IO_ERROR` rather than `REPOSITORY_NOT_FOUND`, until the server restarts.

**Existing mitigation:** Only successful discovery is memoized; repository identity (root commits) is still observed live on every call and compared against `state.json`; the pinned constitution memo is keyed by an immutable commit, so it can never serve stale policy bytes.

**Why accepted:** Re-probing the repository on every handler call and every substep refresh cost more child processes than the work itself, in tests and in ordinary use. Replacing a repository underneath a running server is not a supported workflow, and the failure it produces is loud rather than silent.

## Process-lifetime dispatch preflight memo

**Not protected:** A successful CLI version/auth preflight is memoized per adapter for the server process lifetime. A CLI upgraded underneath a running server keeps dispatching on the memoized version until the server restarts, and the memo does not re-prove authentication on later dispatches.

**Existing mitigation:** Only successful preflights are memoized — a failed or cancelled probe re-runs on the next dispatch — and auth that breaks after a memo hit still fails visibly at child launch, where the failure classifier names it (`AUTH_UNAVAILABLE`, rate limits, unsupported model).

**Why accepted:** The memo removes two child spawns from every dispatch of a review, and the honest failure modes surface at the launch that actually fails rather than silently degrading evidence.

## Legacy adjudication evidence fails the round binding closed

**Not provided:** Adjudication evidence from tasks created before the constitution subject bound the review envelope's digest (previously the retained review set's digest) does not parse or stay current under the new strict checks. There is no shim, translation, or dual read.

**Existing mitigation:** The fixed point treats an unreadable or non-current constitution slot like any other stale slot: the next action is a fresh review round, whose new adjudication carries the new binding. Retained review evidence is unaffected — its `envelope_input_digest` predates and outlives this change.

**Why accepted:** Consistent with the repository's fail-closed version posture; `.archflow/` task state is removed before PR, so the affected population is in-flight local tasks across one upgrade, and the recovery is the ordinary restart-the-round path.
